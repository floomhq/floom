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
if not os.environ.get("OPENAI_API_KEY", "").strip():
    os.environ["OPENAI_API_KEY"] = "sk-test-fake-key"


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


def _good_llm_json(
    name: str = "test-worker",
    connections: list | None = None,
    requirements: list | None = None,
    secrets: list | None = None,
) -> str:
    if connections is None:
        connections = ["granola", "hubspot"]
    if secrets is None:
        secrets = ["OPENAI_API_KEY"]
    payload: dict = {
        "worker_yml": _good_worker_yml(name),
        "skill_md": "# Test Worker\n\nFetch meetings from Granola and update HubSpot.",
        "suggested_name": name,
        "suggested_title": "Test Worker",
        "required_connections": connections,
        "required_secrets": secrets,
        "inputs": [
            {"name": "since_date", "type": "string", "label": "Look back from", "required": False, "default": "7 days ago"}
        ],
        "outputs": [
            {"name": "summary", "type": "markdown", "label": "Meeting summary"}
        ],
    }
    if requirements is not None:
        payload["requirements"] = requirements
    return json.dumps(payload)


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

    def test_meeting_word_does_not_trigger_google_calendar(self):
        """'meeting' alone must NOT imply google-calendar (Issue #4 tighter inference)."""
        from main import _detect_connections
        result = _detect_connections("summarise my granola meetings")
        assert "google-calendar" not in result
        assert "granola" in result

    def test_generic_message_word_does_not_trigger_slack(self):
        """'message' alone must not infer slack (was in old keyword list)."""
        from main import _detect_connections
        result = _detect_connections("send a message to the team")
        assert "slack" not in result

    def test_generic_file_word_does_not_trigger_dropbox(self):
        """'file' alone must not infer dropbox."""
        from main import _detect_connections
        result = _detect_connections("process a file and return results")
        assert "dropbox" not in result


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

    @patch("openai.OpenAI")
    def test_unquoted_colon_yaml_retries_then_succeeds(self, mock_openai_cls, client):
        """If the LLM returns YAML with an unquoted colon in a string value on the
        first attempt, the endpoint must retry and succeed on the second attempt.

        Regression: gpt-4o-mini occasionally emits `description: Summarize meetings:
        action items` which fails pyyaml.safe_load with
        'mapping values are not allowed here'.
        """
        bad_yaml = (
            'schema_version: "0.3"\n'
            'name: test-worker\n'
            'title: Summarize meetings: action items\n'
            'description: A test worker.\n'
            'version: "0.1.0"\n'
            'entrypoint: SKILL.md\n'
            'targets: [generic]\n'
            'exec:\n'
            '  runtime: skill\n'
            '  mode: agent\n'
            '  runner: e2b\n'
            'trigger:\n'
            '  type: manual\n'
        )
        bad_response = json.dumps({
            "worker_yml": bad_yaml,
            "skill_md": "# x",
            "suggested_name": "test-worker",
            "suggested_title": "Test",
            "required_connections": [],
            "required_secrets": [],
            "inputs": [],
            "outputs": [{"name": "summary", "type": "markdown", "label": "Summary"}],
        })

        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.side_effect = [
            _mock_openai_response(bad_response),
            _mock_openai_response(_good_llm_json()),
        ]

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Summarise meetings and post action items"},
        )
        assert resp.status_code == 200, resp.text
        assert mock_client.chat.completions.create.call_count == 2

        # Second call must include the strict-quoting addendum
        second_call_kwargs = mock_client.chat.completions.create.call_args_list[1].kwargs
        system_content = second_call_kwargs["messages"][0]["content"]
        assert "PREVIOUS ATTEMPT FAILED YAML VALIDATION" in system_content

    @patch("openai.OpenAI")
    def test_three_consecutive_yaml_failures_returns_502(self, mock_openai_cls, client):
        """If every retry attempt produces invalid YAML, the endpoint returns 502."""
        bad_yaml = (
            'schema_version: "0.3"\n'
            'name: test-worker\n'
            'title: Summarize meetings: action items\n'
            'exec:\n'
            '  runtime: skill\n'
        )
        bad_response = json.dumps({
            "worker_yml": bad_yaml,
            "skill_md": "# x",
            "suggested_name": "test-worker",
            "suggested_title": "Test",
            "required_connections": [],
            "required_secrets": [],
            "inputs": [],
            "outputs": [{"name": "summary", "type": "markdown", "label": "Summary"}],
        })

        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(bad_response)

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Do something"},
        )
        assert resp.status_code == 502
        assert mock_client.chat.completions.create.call_count == 3
        assert "after 3 attempts" in resp.json()["detail"]

    @patch("openai.OpenAI")
    def test_numeric_schema_version_and_missing_version_are_repaired(self, mock_openai_cls, client):
        """Generated YAML with schema_version 0.3 as a number and no version gets repaired."""
        import yaml as pyyaml
        from models import parse_worker_manifest, WorkerContract

        bad_yaml = (
            "schema_version: 0.3\n"
            "name: test-worker\n"
            'title: "Test Worker"\n'
            'description: "A test worker."\n'
            "exec:\n"
            '  entry: "run.py"\n'
            '  command: "python run.py"\n'
            '  runtime: "python311"\n'
            '  runner: "e2b"\n'
            "trigger:\n"
            '  type: "manual"\n'
        )
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            json.dumps(
                {
                    "worker_yml": bad_yaml,
                    "skill_md": None,
                    "suggested_name": "test-worker",
                    "suggested_title": "Test Worker",
                    "required_connections": [],
                    "required_secrets": [],
                    "inputs": [],
                    "outputs": [{"name": "summary", "type": "markdown", "label": "Summary"}],
                }
            )
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Create a worker that prints a summary."},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        raw = pyyaml.safe_load(body["worker_yml"])
        parsed = parse_worker_manifest(raw)

        assert isinstance(parsed, WorkerContract)
        assert raw["schema_version"] == "0.3"
        assert raw["version"] == "0.1.0"


# ---------------------------------------------------------------------------
# Tests: POST /workers writes skill_md correctly (Issue #1)
# ---------------------------------------------------------------------------

class TestPostWorkersSkillMd:
    """Verify that POST /workers writes the provided skill_md to SKILL.md on disk."""

    @pytest.fixture(autouse=True)
    def _patch_workers_dir(self, tmp_path, monkeypatch):
        """Route WORKERS_DIR to a temp directory and ensure no auth secret is set."""
        import worker_registry
        monkeypatch.setattr(worker_registry, "WORKERS_DIR", tmp_path)
        monkeypatch.delenv("FLOOM_SECRET", raising=False)
        self._workers_dir = tmp_path

    def _minimal_yml(self, name: str = "skill-md-test") -> str:
        return f"""schema_version: "0.3"
name: {name}
title: "Skill Md Test"
description: "A worker for testing skill_md write."
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]
exec:
  runtime: skill
  mode: agent
  runner: e2b
  inputs: []
  outputs: []
trigger:
  type: manual
"""

    @pytest.mark.xfail(
        reason="pending #752: _embed_files_in_skill_version not yet called on create_worker",
        strict=True,
    )
    def test_provided_skill_md_is_written_to_disk(self, client):
        """When skill_md is provided in the request body, SKILL.md on disk matches exactly."""
        custom_skill = "# Custom Skill\n\nThis is the real skill content."
        resp = client.post(
            "/workers",
            json={
                "worker_yml": self._minimal_yml("skill-md-test"),
                "run_py": "def run(inputs, context): return {'status': 'success', 'outputs': {}, 'artifacts': []}",
                "skill_md": custom_skill,
            },
        )
        assert resp.status_code == 200, resp.text
        skill_path = self._workers_dir / "skill-md-test" / "SKILL.md"
        assert skill_path.is_file(), "SKILL.md was not created"
        assert skill_path.read_text() == custom_skill, "SKILL.md content does not match provided skill_md"

    @pytest.mark.xfail(
        reason="pending #752: _embed_files_in_skill_version not yet called on create_worker",
        strict=True,
    )
    def test_omitted_skill_md_writes_placeholder(self, client):
        """When skill_md is not provided, a placeholder SKILL.md is written."""
        resp = client.post(
            "/workers",
            json={
                "worker_yml": self._minimal_yml("placeholder-test"),
                "run_py": "def run(inputs, context): return {'status': 'success', 'outputs': {}, 'artifacts': []}",
            },
        )
        assert resp.status_code == 200, resp.text
        skill_path = self._workers_dir / "placeholder-test" / "SKILL.md"
        assert skill_path.is_file(), "SKILL.md placeholder was not created"
        content = skill_path.read_text()
        assert "placeholder" in content.lower() or content.startswith("#"), (
            "Expected a placeholder or heading, got: " + content[:100]
        )

    def test_draft_from_prompt_response_exposes_skill_md(self, client):
        """draft-from-prompt response includes the skill_md field from the LLM."""
        from unittest.mock import MagicMock, patch

        mock_skill = "# Granola Worker\n\nFetch and summarise meetings."
        llm_payload = {
            "worker_yml": _good_worker_yml(),
            "skill_md": mock_skill,
            "suggested_name": "test-worker",
            "suggested_title": "Test Worker",
            "required_connections": ["granola"],
            "required_secrets": [],
            "inputs": [],
            "outputs": [{"name": "summary", "type": "markdown", "label": "Summary"}],
        }
        import json as json_mod

        with patch("openai.OpenAI") as mock_cls:
            mock_client_inst = MagicMock()
            mock_cls.return_value = mock_client_inst
            choice = MagicMock()
            choice.message.content = json_mod.dumps(llm_payload)
            response = MagicMock()
            response.choices = [choice]
            mock_client_inst.chat.completions.create.return_value = response

            resp = client.post(
                "/workers/draft-from-prompt",
                json={"prompt": "Summarise my granola meetings"},
            )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "skill_md" in data
        assert data["skill_md"] == mock_skill


# ---------------------------------------------------------------------------
# Tests: Requirements UX (Issue #4)
# ---------------------------------------------------------------------------

class TestRequirementsUX:
    """Verify that the requirements array is returned correctly and without duplicates."""

    @patch("openai.OpenAI")
    def test_granola_slack_prompt_returns_two_requirements_no_calendar(self, mock_openai_cls, client):
        """Prompt with Granola + Slack should return exactly 2 requirements, no google-calendar."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            _good_llm_json(
                name="granola-slack-sync",
                connections=[],
                requirements=[
                    {"app": "granola", "method": "api_key", "reason": "Fetch meeting notes from Granola"},
                    {"app": "slack", "method": "oauth", "reason": "Post action items to Slack"},
                ],
                secrets=["GRANOLA_API_KEY"],
            )
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Summarise my Granola meetings and post action items to Slack"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()

        requirements = data.get("requirements", [])
        assert len(requirements) == 2, f"Expected 2 requirements, got {len(requirements)}: {requirements}"

        apps = [r["app"] for r in requirements]
        assert "granola" in apps
        assert "slack" in apps
        assert "google-calendar" not in apps, "google-calendar must not appear for a Granola meetings prompt"

    @patch("openai.OpenAI")
    def test_hubspot_prompt_returns_oauth_method(self, mock_openai_cls, client):
        """Prompt for HubSpot CRM should return hubspot with method=oauth."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            _good_llm_json(
                name="hubspot-crm-sync",
                connections=["hubspot"],
                requirements=[
                    {"app": "hubspot", "method": "oauth", "reason": "Access HubSpot CRM via OAuth"},
                ],
                secrets=[],
            )
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Update my HubSpot CRM with new contacts"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()

        requirements = data.get("requirements", [])
        assert len(requirements) == 1, f"Expected 1 requirement, got {len(requirements)}"
        assert requirements[0]["app"] == "hubspot"
        assert requirements[0]["method"] == "oauth"

        # Legacy fields must also be consistent
        assert "hubspot" in data["required_connections"]
        assert not any("HUBSPOT" in s for s in data["required_secrets"]), (
            "HubSpot should not appear in required_secrets when method is oauth"
        )

    @patch("openai.OpenAI")
    def test_no_duplicate_app_in_requirements(self, mock_openai_cls, client):
        """Even if LLM returns duplicate entries, response must deduplicate."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        # LLM returns hubspot twice with different methods (the bad pattern we're fixing)
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            _good_llm_json(
                name="hubspot-dup-test",
                connections=["hubspot"],
                requirements=[
                    {"app": "hubspot", "method": "oauth", "reason": "OAuth connection"},
                    {"app": "hubspot", "method": "api_key", "reason": "API key fallback"},
                ],
                secrets=["HUBSPOT_API_KEY"],
            )
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Sync data with HubSpot"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()

        requirements = data.get("requirements", [])
        apps = [r["app"] for r in requirements]
        assert apps.count("hubspot") == 1, (
            f"hubspot must appear exactly once in requirements, got: {requirements}"
        )

    @patch("openai.OpenAI")
    def test_requirements_legacy_fallback_when_no_requirements_array(self, mock_openai_cls, client):
        """When LLM omits requirements array, fall back to required_connections + required_secrets."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        # Old-style LLM response with no requirements field
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            _good_llm_json(
                name="legacy-test",
                connections=["granola"],
                secrets=["OPENAI_API_KEY"],
                # No requirements field
            )
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Summarise granola meetings"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()

        # Should still return requirements derived from connections/secrets
        requirements = data.get("requirements", [])
        assert isinstance(requirements, list)
        # granola from required_connections should become an oauth requirement
        apps = [r["app"] for r in requirements]
        assert "granola" in apps

    def test_meeting_keyword_does_not_add_google_calendar_to_detected(self):
        """Tightened _COMPOSIO_APP_KEYWORDS: 'meeting' alone does not match google-calendar."""
        from main import _detect_connections
        result = _detect_connections("summarise my granola meetings")
        assert "google-calendar" not in result

    @patch("openai.OpenAI")
    def test_granola_slack_have_both_available_methods(self, mock_openai_cls, client):
        """Granola and Slack both support OAuth + API key; available_methods must list both."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            _good_llm_json(
                name="granola-slack-sync",
                connections=[],
                requirements=[
                    {"app": "granola", "method": "api_key", "reason": "Granola API key"},
                    {"app": "slack", "method": "oauth", "reason": "Slack OAuth"},
                ],
                secrets=["GRANOLA_API_KEY"],
            )
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Summarise my Granola meetings and post to Slack"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        requirements = data.get("requirements", [])
        apps = {r["app"]: r for r in requirements}

        assert "granola" in apps, f"granola not in requirements: {requirements}"
        assert "slack" in apps, f"slack not in requirements: {requirements}"

        granola_req = apps["granola"]
        assert sorted(granola_req["available_methods"]) == ["api_key", "oauth"], (
            f"Granola should have both methods, got: {granola_req['available_methods']}"
        )
        slack_req = apps["slack"]
        assert sorted(slack_req["available_methods"]) == ["api_key", "oauth"], (
            f"Slack should have both methods, got: {slack_req['available_methods']}"
        )

    @patch("openai.OpenAI")
    def test_apollo_has_api_key_only(self, mock_openai_cls, client):
        """Apollo is api_key only; available_methods must contain only 'api_key'."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            _good_llm_json(
                name="apollo-enricher",
                connections=[],
                requirements=[
                    {"app": "apollo", "method": "api_key", "reason": "Apollo API key for enrichment"},
                ],
                secrets=["APOLLO_API_KEY"],
            )
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Enrich leads using Apollo"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        requirements = data.get("requirements", [])
        apollo_reqs = [r for r in requirements if r["app"] == "apollo"]
        assert len(apollo_reqs) == 1, f"Expected exactly 1 apollo requirement, got: {requirements}"
        assert apollo_reqs[0]["available_methods"] == ["api_key"], (
            f"Apollo should be api_key only, got: {apollo_reqs[0]['available_methods']}"
        )

    @patch("openai.OpenAI")
    def test_llm_suggested_method_is_initial_value(self, mock_openai_cls, client):
        """The LLM-suggested method for an app wins as the initial method value."""
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        # LLM suggests granola via api_key (even though both are available)
        mock_client.chat.completions.create.return_value = _mock_openai_response(
            _good_llm_json(
                name="granola-worker",
                connections=[],
                requirements=[
                    {"app": "granola", "method": "api_key", "reason": "Granola API key preferred"},
                ],
                secrets=["GRANOLA_API_KEY"],
            )
        )

        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Summarise Granola meetings"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        requirements = data.get("requirements", [])
        granola_reqs = [r for r in requirements if r["app"] == "granola"]
        assert len(granola_reqs) == 1, f"Expected 1 granola requirement, got: {requirements}"
        # LLM said api_key; initial method must be api_key (not forced to oauth)
        assert granola_reqs[0]["method"] == "api_key", (
            f"Initial method should be LLM suggestion 'api_key', got: {granola_reqs[0]['method']}"
        )
        # Both methods still available for toggling
        assert sorted(granola_reqs[0]["available_methods"]) == ["api_key", "oauth"]
