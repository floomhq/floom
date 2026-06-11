"""API tests for POST /workers/draft-from-prompt through the provider-agnostic LLM seam.

Drives the full endpoint path: route -> _call_draft_llm -> chat_completion_codegen ->
llm.completion (mocked) -> manifest validation -> response. Complements the seam unit
tests (test_llm.py) and the suggest-endpoint API tests (test_worker_suggest.py).
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


_VALID_WORKER_YML = """\
schema_version: "0.3"
name: "news-digest"
title: "News Digest"
description: "Summarizes the day's news into a short digest every morning."
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "0 9 * * *"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
secrets:
  - "NEWS_API_KEY"
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-draft")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-fake")
    # Keep model selection deterministic regardless of the ambient environment.
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", "gpt-5.5")

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": "test-secret-draft"})
    yield client, main
    db.get_repositories.cache_clear()


def _mock_llm_response(payload: dict) -> MagicMock:
    resp = MagicMock()
    resp.choices[0].message.content = json.dumps(payload)
    return resp


def test_draft_from_prompt_drafts_worker_via_seam(client_and_main):
    """Happy path: a valid manifest from the seam is validated and returned."""
    client, _ = client_and_main
    mock = _mock_llm_response(
        {
            "worker_yml": _VALID_WORKER_YML,
            "suggested_name": "news-digest",
            "suggested_title": "News Digest",
        }
    )
    with patch("llm.completion", return_value=mock) as mocked:
        resp = client.post(
            "/workers/draft-from-prompt",
            json={"prompt": "Summarize the news every morning at 9am."},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "schema_version" in body["worker_yml"]
    assert body["suggested_name"] == "news-digest"
    # The seam (not a hardcoded OpenAI client) was actually exercised.
    assert mocked.called


def test_draft_from_prompt_503_when_no_provider_configured(client_and_main, monkeypatch):
    """With no provider credentials, the endpoint fails fast (provider guard)."""
    client, _ = client_and_main
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("PLATFORM_OPENAI_API_KEY", raising=False)
    resp = client.post("/workers/draft-from-prompt", json={"prompt": "Do a thing."})
    assert resp.status_code == 503


def test_draft_from_prompt_502_on_invalid_manifest(client_and_main):
    """A syntactically-valid but schema-invalid manifest is rejected with 502."""
    client, _ = client_and_main
    mock = _mock_llm_response({"worker_yml": "name: incomplete\n"})
    with patch("llm.completion", return_value=mock):
        resp = client.post("/workers/draft-from-prompt", json={"prompt": "x"})
    assert resp.status_code == 502
