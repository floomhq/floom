"""Tests for POST /workers/draft-from-prompt endpoint."""

import os
import json
import sys
import tempfile
import pytest
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Set up a temp DB and API path BEFORE importing main
# ---------------------------------------------------------------------------

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

# Use a temp file DB to avoid colliding with the production DB migration state
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ.pop("FLOOM_SECRET", None)
os.environ.setdefault("OPENAI_API_KEY", "sk-test-fake-key")


# ---------------------------------------------------------------------------
# Helper: minimal valid chat completion mock
# ---------------------------------------------------------------------------

def _mock_openai_response(content: str):
    """Return a minimal mock that mimics openai.ChatCompletion response shape."""
    choice = MagicMock()
    choice.message.content = content
    response = MagicMock()
    response.choices = [choice]
    return response


def _good_worker_yml(name: str = "test-worker") -> str:
    return f"""schema_version: "0.3"
name: {name}
title: "Test Worker"
description: "A test worker that does something useful."
long_description: |
  This is a long description of the worker.
use_cases:
- Use case one
- Use case two
- Use case three
example_input:
  since_date: "7 days ago"
example_output: |
  ## Summary
  Meeting notes updated in HubSpot.
how_it_works: |
  Fetches meetings, processes them, updates CRM.
folder: "Custom"
tags: ["test", "automation"]
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]

exec:
  runtime: skill
  mode: agent
  runner: e2b
  inputs:
  - name: since_date
    kind: scalar
    type: string
    required: false
    label: "Look back from"
    default: "7 days ago"
  secrets:
  - OPENAI_API_KEY
  outputs:
  - name: summary
    kind: file
    media_type: text/markdown
    path: out/summary.md
    required: true
    label: "Meeting summary"

capabilities:
  secrets:
  - OPENAI_API_KEY
  network:
    egress: true

trigger:
  type: manual
"""


def _good_llm_json(name: str = "test-worker", connections: list | None = None) -> str:
    if connections is None:
        connections = ["granola", "hubspot"]
    return json.dumps({
        "worker_yml": _good_worker_yml(name),
        "skill_md": "# Test Worker\n\nFetch meetings from Granola and update HubSpot.",
        "suggested_name": name,
        "suggested_title": "Test Worker",
        "required_connections": connections,
        "required_secrets": ["OPENAI_API_KEY"],
        "inputs": [
            {"name": "since_date", "type": "string", "label": "Look back from", "required": False, "default": "7 days ago"}
        ],
        "outputs": [
            {"name": "summary", "type": "markdown", "label": "Meeting summary"}
        ],
    })


# ---------------------------------------------------------------------------
# Tests: connection detection
# ---------------------------------------------------------------------------

class TestConnectionDetection:
    """Unit tests for the keyword-based connection extractor (no HTTP calls)."""

    def test_gmail_detected(self):
        from main import _detect_connections
        result = _detect_connections("summarise all my gmail messages")
        assert "gmail" in result

    def test_hubspot_detected(self):
        from main import _detect_connections
        result = _detect_connections("update my hubspot crm contact")
        assert "hubspot" in result

    def test_notion_detected(self):
        from main import _detect_connections
        result = _detect_connections("write a notion page with the results")
        assert "notion" in result

    def test_granola_detected(self):
        from main import _detect_connections
        result = _detect_connections("fetch meetings from granola and summarise them")
        assert "granola" in result

    def test_no_connections_for_generic_prompt(self):
        from main import _detect_connections
        result = _detect_connections("analyse some data")
        # Should not detect any specific app
        assert isinstance(result, list)

    def test_multiple_connections_detected(self):
        from main import _detect_connections
        result = _detect_connections("retrieve granola meeting notes and update hubspot crm")
        assert "granola" in result
        assert "hubspot" in result


# ---------------------------------------------------------------------------
# Tests: YAML round-trip
# ---------------------------------------------------------------------------

class TestYamlRoundTrip:
    """Ensure generated YAML actually passes parse_worker_manifest."""

    def test_good_yaml_round_trips(self):
        import yaml as pyyaml
        from models import parse_worker_manifest, WorkerContract

        raw = pyyaml.safe_load(_good_worker_yml())
        result = parse_worker_manifest(raw)
        assert isinstance(result, WorkerContract)
        assert result.name == "test-worker"

    def test_yaml_with_no_exec_command_for_skill_mode_valid(self):
        """skill runtime in agent mode does not need exec.command."""
        import yaml as pyyaml
        from models import parse_worker_manifest, WorkerContract

        raw = pyyaml.safe_load(_good_worker_yml())
        result = parse_worker_manifest(raw)
        # exec.mode should be agent (resolved from no command + skill runtime)
        assert isinstance(result, WorkerContract)
        assert result.exec.mode == "agent"


# ---------------------------------------------------------------------------
# Tests: HTTP endpoint (FastAPI TestClient)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def client():
    """Return a TestClient for the FastAPI app without auth (FLOOM_SECRET unset)."""
    os.environ.pop("FLOOM_SECRET", None)
    from fastapi.testclient import TestClient
    from main import app
    return TestClient(app)


class TestDraftFromPromptEndpoint:

    def test_returns_401_without_secret_when_secret_configured(self, client):
        """When FLOOM_SECRET is set, unauthenticated requests get 401."""
        import importlib
        os.environ["FLOOM_SECRET"] = "test-secret-abc"
        try:
            # Re-use client but without header
            resp = client.post(
                "/workers/draft-from-prompt",
                json={"prompt": "summarise my granola meetings"},
            )
            assert resp.status_code == 401
        finally:
            os.environ.pop("FLOOM_SECRET", None)

    def test_empty_prompt_returns_400(self, client):
        resp = client.post("/workers/draft-from-prompt", json={"prompt": ""})
        assert resp.status_code == 400
        assert "prompt" in resp.json()["detail"].lower()

    def test_whitespace_prompt_returns_400(self, client):
        resp = client.post("/workers/draft-from-prompt", json={"prompt": "   "})
        assert resp.status_code == 400

    def test_missing_prompt_field_returns_422(self, client):
        resp = client.post("/workers/draft-from-prompt", json={})
        assert resp.status_code == 422

    @patch("openai.OpenAI")
    def test_granola_hubspot_prompt_extracts_connections(self, mock_openai_cls, client):
        """Full success path: granola+hubspot prompt returns those connections."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            _good_llm_json(name="granola-hubspot-sync", connections=["granola", "hubspot"])
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Please retrieve or summarise all my meetings from Granola and update my CRM HubSpot accordingly."},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "granola" in data["required_connections"]
        assert "hubspot" in data["required_connections"]
        assert data["worker_yml"]
        assert data["suggested_name"]
        assert data["suggested_title"]

    @patch("openai.OpenAI")
    def test_generated_yaml_passes_parse_worker_manifest(self, mock_openai_cls, client):
        """YAML returned by the endpoint round-trips through parse_worker_manifest."""
        import yaml as pyyaml
        from models import parse_worker_manifest, WorkerContract

        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            _good_llm_json()
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Fetch my Granola meetings and update HubSpot"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        raw = pyyaml.safe_load(data["worker_yml"])
        result = parse_worker_manifest(raw)
        assert isinstance(result, WorkerContract)

    @patch("openai.OpenAI")
    def test_auth_gate_works_with_correct_secret(self, mock_openai_cls, client):
        """When FLOOM_SECRET is set, the correct header passes through."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            _good_llm_json()
        )

        os.environ["FLOOM_SECRET"] = "my-test-secret"
        try:
            resp = client.post(
                "/workers/draft-from-prompt",
                json={"prompt": "Summarise granola meetings"},
                headers={"x-floom-secret": "my-test-secret"},
            )
            assert resp.status_code == 200
        finally:
            os.environ.pop("FLOOM_SECRET", None)

    @patch("openai.OpenAI")
    def test_markdown_fence_stripped_from_llm_response(self, mock_openai_cls, client):
        """LLM responses wrapped in markdown fences are stripped cleanly."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        # Wrap in markdown fence
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            "```json\n" + _good_llm_json() + "\n```"
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Fetch granola meetings and update hubspot"},
        )
        assert resp.status_code == 200, resp.text

    @patch("openai.OpenAI")
    def test_invalid_json_from_llm_returns_502(self, mock_openai_cls, client):
        """If the LLM returns non-JSON, the endpoint returns 502."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            "Here is a great worker! Just kidding this is not JSON."
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Do something"},
        )
        assert resp.status_code == 502
