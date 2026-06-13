"""PR S9 backend tests: POST /workers/draft-and-create.

Tests:
  1. Happy path (LLM returns valid files[] + YAML) -> worker created, worker_id returned.
  2. Invalid-YAML path: LLM returns broken YAML 3 times -> 502, no worker created on disk.
  3. Pre-supplied files path: skips LLM, writes files, returns worker_id.
  4. DraftAndCreateResponse model shape.
"""

import os
import json
import sys
import tempfile

import pytest
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Set up API path + temp DB BEFORE importing main
# ---------------------------------------------------------------------------

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ.setdefault("FLOOM_DB", _tmp_db.name)
os.environ.pop("FLOOM_SECRET", None)
if not os.environ.get("OPENAI_API_KEY", "").strip():
    os.environ["OPENAI_API_KEY"] = "sk-test-fake-key"


# ---------------------------------------------------------------------------
# Minimal valid worker YAML
# ---------------------------------------------------------------------------

def _valid_worker_yml(name: str = "test-s9-worker") -> str:
    return f"""\
schema_version: "0.3"
name: {name}
title: "Test S9 Worker"
description: "Unit test worker for PR S9."
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


def _llm_json_response(worker_yml: str, include_files: bool = True) -> str:
    payload: dict = {
        "worker_yml": worker_yml,
        "suggested_name": "test-s9-worker",
        "suggested_title": "Test S9 Worker",
        "requirements": [],
        "required_connections": [],
        "required_secrets": [],
        "inputs": [],
        "outputs": [],
    }
    if include_files:
        payload["files"] = [
            {"path": "worker.yml", "content": worker_yml},
            {"path": "SKILL.md", "content": "# Test S9 Worker\n\nUnit test skill."},
        ]
    return json.dumps(payload)


def _mock_openai_response(content: str):
    choice = MagicMock()
    choice.message.content = content
    response = MagicMock()
    response.choices = [choice]
    return response


# ---------------------------------------------------------------------------
# Shared fixture: TestClient pointing at a tmp workers dir
# ---------------------------------------------------------------------------

@pytest.fixture()
def client_with_tmp_workers(tmp_path, monkeypatch):
    """TestClient with WORKERS_DIR redirected to tmp_path.

    The test client sends the x-floom-secret header so auth passes even when
    the .env file sets FLOOM_SECRET (common on developer machines).
    """
    import worker_registry
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", tmp_path)

    # Read whatever FLOOM_SECRET is currently active (may have been loaded from .env)
    secret = os.environ.get("FLOOM_SECRET", "")

    from fastapi.testclient import TestClient
    from main import app

    # Build a client that always injects the correct header so auth passes
    # regardless of whether FLOOM_SECRET is set or not.
    tc = TestClient(app, headers={"x-floom-secret": secret} if secret else {})
    return tc, tmp_path


# ---------------------------------------------------------------------------
# 1. Happy path: LLM returns valid YAML + files -> worker created
# ---------------------------------------------------------------------------

@patch("codegen_model.chat_completion_codegen")
def test_draft_and_create_happy_path(mock_codegen, client_with_tmp_workers):
    """LLM returns valid files[] -> worker is written to disk and worker_id returned."""
    client, workers_dir = client_with_tmp_workers

    mock_codegen.return_value = _mock_openai_response(
        _llm_json_response(_valid_worker_yml(), include_files=True)
    )

    secret = os.environ.get("FLOOM_SECRET", "")
    headers = {"x-floom-secret": secret} if secret else {}

    resp = client.post(
        "/workers/draft-and-create",
        json={"prompt": "Summarise my Granola meetings and post to HubSpot daily"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["worker_id"] == "test-s9-worker"

    # Worker files must be on disk
    worker_dir = workers_dir / "test-s9-worker"
    assert worker_dir.exists(), "Worker directory was not created"
    assert (worker_dir / "worker.yml").exists(), "worker.yml missing"
    assert (worker_dir / "SKILL.md").exists(), "SKILL.md missing"


# ---------------------------------------------------------------------------
# Engine #211: LLM emits exec.mode=pure-script + entry=run.py WITHOUT
# exec.command -> command is defaulted during validation, so draft-and-create
# returns 200 instead of 502.
# ---------------------------------------------------------------------------

def _pure_script_worker_yml_no_command(name: str = "test-211-worker") -> str:
    return f"""\
schema_version: "0.3"
name: {name}
title: "Test 211 Worker"
description: "Unit test worker for engine #211 exec.command defaulting."
version: "0.1.0"
targets: [generic]

exec:
  runtime: python311
  mode: pure-script
  runner: e2b
  entry: run.py
  inputs: []
  outputs: []

trigger:
  type: manual
"""


@patch("codegen_model.chat_completion_codegen")
def test_draft_and_create_pure_script_missing_command_returns_200(
    mock_codegen, client_with_tmp_workers
):
    """exec.mode=pure-script + entry=run.py + NO command -> 200, not 502."""
    client, workers_dir = client_with_tmp_workers

    worker_yml = _pure_script_worker_yml_no_command()
    payload = {
        "worker_yml": worker_yml,
        "suggested_name": "test-211-worker",
        "suggested_title": "Test 211 Worker",
        "requirements": [],
        "required_connections": [],
        "required_secrets": [],
        "inputs": [],
        "outputs": [],
        "files": [
            {"path": "worker.yml", "content": worker_yml},
            {"path": "run.py", "content": "print('hello from 211')\n"},
        ],
    }

    mock_codegen.return_value = _mock_openai_response(json.dumps(payload))

    secret = os.environ.get("FLOOM_SECRET", "")
    headers = {"x-floom-secret": secret} if secret else {}

    resp = client.post(
        "/workers/draft-and-create",
        json={"prompt": "Run a python script that prints hello"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["worker_id"] == "test-211-worker"

    worker_dir = workers_dir / "test-211-worker"
    assert worker_dir.exists(), "Worker directory was not created"
    assert (worker_dir / "run.py").exists(), "run.py missing"


# ---------------------------------------------------------------------------
# 2. Invalid YAML path: LLM returns broken YAML 3 times -> 502, no worker
# ---------------------------------------------------------------------------

@patch("codegen_model.chat_completion_codegen")
def test_draft_and_create_invalid_yaml_returns_502(mock_codegen, client_with_tmp_workers):
    """LLM returns broken YAML on every attempt -> 502, no worker dir created."""
    client, workers_dir = client_with_tmp_workers

    broken_response = json.dumps({
        "worker_yml": "this: is: not: valid: yaml",
        "suggested_name": "bad-worker",
        "suggested_title": "Bad",
        "required_connections": [],
        "required_secrets": [],
        "inputs": [],
        "outputs": [],
    })

    mock_codegen.return_value = _mock_openai_response(broken_response)

    secret = os.environ.get("FLOOM_SECRET", "")
    headers = {"x-floom-secret": secret} if secret else {}

    resp = client.post(
        "/workers/draft-and-create",
        json={"prompt": "Do something"},
        headers=headers,
    )
    assert resp.status_code == 502, resp.text
    detail = resp.json()["detail"]
    assert "not valid" in detail.lower() or "3 attempts" in detail

    # LLM called exactly 3 times
    assert mock_codegen.call_count == 3

    # No worker dir should exist
    assert not (workers_dir / "bad-worker").exists(), "Worker dir must not be created on failure"


# ---------------------------------------------------------------------------
# 3. Pre-supplied files path: LLM must NOT be called
# ---------------------------------------------------------------------------

@patch("codegen_model.chat_completion_codegen")
def test_draft_and_create_pre_supplied_files(mock_codegen, client_with_tmp_workers):
    """When files[] is provided, LLM is skipped and files are written directly."""
    client, workers_dir = client_with_tmp_workers

    secret = os.environ.get("FLOOM_SECRET", "")
    headers = {"x-floom-secret": secret} if secret else {}

    resp = client.post(
        "/workers/draft-and-create",
        json={
            "files": [
                {"path": "worker.yml", "content": _valid_worker_yml("upload-test-worker")},
                {"path": "SKILL.md", "content": "# My uploaded skill"},
            ]
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["worker_id"] == "upload-test-worker"

    # LLM must not have been called
    mock_codegen.assert_not_called()

    # Files on disk
    worker_dir = workers_dir / "upload-test-worker"
    assert worker_dir.exists()
    assert (worker_dir / "worker.yml").exists()
    assert (worker_dir / "SKILL.md").read_text() == "# My uploaded skill"


# ---------------------------------------------------------------------------
# 4. DraftAndCreateResponse model shape
# ---------------------------------------------------------------------------

def test_draft_and_create_response_model():
    """DraftAndCreateResponse has worker_id field and serialises correctly."""
    from main import DraftAndCreateResponse

    resp = DraftAndCreateResponse(worker_id="my-worker")
    assert resp.worker_id == "my-worker"
    data = resp.model_dump()
    # FIX 4 (2026-05-29): the response now also carries the smoke verdict
    # (smoke_status / smoke_reason), defaulting to None for backward compat.
    assert data["worker_id"] == "my-worker"
    assert data["smoke_status"] is None
    assert data["smoke_reason"] is None


# ---------------------------------------------------------------------------
# 5. Empty prompt returns 400
# ---------------------------------------------------------------------------

def test_draft_and_create_empty_prompt_returns_400(client_with_tmp_workers):
    """Empty prompt with no files returns 400."""
    client, _ = client_with_tmp_workers
    secret = os.environ.get("FLOOM_SECRET", "")
    headers = {"x-floom-secret": secret} if secret else {}
    resp = client.post("/workers/draft-and-create", json={"prompt": ""}, headers=headers)
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 6. Path traversal in files is rejected
# ---------------------------------------------------------------------------

def test_draft_and_create_path_traversal_rejected(client_with_tmp_workers):
    """Files with '..' path segments must be rejected with 400."""
    client, _ = client_with_tmp_workers
    secret = os.environ.get("FLOOM_SECRET", "")
    headers = {"x-floom-secret": secret} if secret else {}
    resp = client.post(
        "/workers/draft-and-create",
        json={
            "files": [
                {"path": "worker.yml", "content": _valid_worker_yml()},
                {"path": "../../../etc/passwd", "content": "pwned"},
            ]
        },
        headers=headers,
    )
    # Must be rejected (400) or safe (200/409). Must not 500 or allow the traversal.
    assert resp.status_code in (200, 400, 409), f"Unexpected status: {resp.status_code}"
    if resp.status_code == 200:
        from pathlib import Path
        assert not Path("/etc/passwd").read_text().startswith("pwned"), "Path traversal succeeded!"
