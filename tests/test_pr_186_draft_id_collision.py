"""Issue #186: draft-and-create must not 409 when the LLM author returns the
same suggested id twice. The second create gets a distinct id; both succeed.
"""

import json
import os
import sys
import tempfile

import pytest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ.setdefault("FLOOM_DB", _tmp_db.name)
os.environ.pop("FLOOM_SECRET", None)
if not os.environ.get("OPENAI_API_KEY", "").strip():
    os.environ["OPENAI_API_KEY"] = "sk-test-fake-key"


def _valid_worker_yml(name: str = "applicant-followup") -> str:
    return f"""\
schema_version: "0.3"
name: {name}
title: "Applicant Followup"
description: "Unit test worker for #186."
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]

exec:
  runtime: skill
  mode: agent
  runner: e2b
  entrypoint: SKILL.md
  inputs: []
  outputs: []

trigger:
  type: manual
"""


def _llm_json_response(worker_yml: str) -> str:
    return json.dumps({
        "worker_yml": worker_yml,
        "suggested_name": "applicant-followup",
        "suggested_title": "Applicant Followup",
        "required_connections": [],
        "required_secrets": [],
        "inputs": [],
        "outputs": [],
        "files": [
            {"path": "worker.yml", "content": worker_yml},
            {"path": "SKILL.md", "content": "# Applicant Followup\n\nTest skill."},
        ],
    })


def _mock_openai_response(content: str):
    choice = MagicMock()
    choice.message.content = content
    response = MagicMock()
    response.choices = [choice]
    return response


@pytest.fixture()
def client_with_tmp_workers(tmp_path, monkeypatch):
    import worker_registry
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", tmp_path)
    secret = os.environ.get("FLOOM_SECRET", "")
    from fastapi.testclient import TestClient
    from main import app
    tc = TestClient(app, headers={"x-floom-secret": secret} if secret else {})
    return tc, tmp_path


@patch("codegen_model.chat_completion_codegen")
def test_duplicate_generated_id_gets_distinct_suffix(mock_codegen, client_with_tmp_workers):
    """Two drafts that both yield 'applicant-followup' both succeed; the
    second gets a distinct id instead of a 409."""
    client, workers_dir = client_with_tmp_workers

    # The author always returns the same id regardless of prompt (#186).
    mock_codegen.return_value = _mock_openai_response(
        _llm_json_response(_valid_worker_yml())
    )

    secret = os.environ.get("FLOOM_SECRET", "")
    headers = {"x-floom-secret": secret} if secret else {}

    resp1 = client.post(
        "/workers/draft-and-create",
        json={"prompt": "Follow up with applicants after interviews"},
        headers=headers,
    )
    assert resp1.status_code == 200, resp1.text
    id1 = resp1.json()["worker_id"]
    assert id1 == "applicant-followup"

    resp2 = client.post(
        "/workers/draft-and-create",
        json={"prompt": "Chase down overdue invoices"},
        headers=headers,
    )
    assert resp2.status_code == 200, resp2.text
    id2 = resp2.json()["worker_id"]

    assert id2 != id1, "second worker must get a distinct id, not a 409"
    assert id2 == "applicant-followup-2"

    # Both worker dirs exist with their own worker.yml.
    assert (workers_dir / id1 / "worker.yml").exists()
    assert (workers_dir / id2 / "worker.yml").exists()

    # The rewritten manifest must carry the deduped id so dir/manifest agree.
    import yaml as pyyaml
    raw2 = pyyaml.safe_load((workers_dir / id2 / "worker.yml").read_text())
    assert raw2.get("name") == id2, "worker.yml name must be rewritten to the deduped id"
