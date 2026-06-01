"""Tests for POST /workers/{worker_id}/suggest.

Verifies:
- Returns 404 for unknown workers.
- Returns has_conflicts=False + empty suggestions when OpenAI is not configured.
- Returns structured suggestions when OpenAI returns conflicts (mocked).
- Gracefully returns has_conflicts=False when the OpenAI call fails.
- Never leaks errors to the caller — always returns a valid response shape.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


_SCHEDULED_WORKER_YML = """\
schema_version: "0.3"
name: "ai-news-digest"
title: "AI News Digest"
description: "Posts AI news to Discord every 5 minutes."
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "*/5 * * * *"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs:
  - name: "discord_channel_id"
    kind: "scalar"
    type: "string"
    required: true
    label: "Discord Channel ID"
  - name: "max_stories"
    kind: "scalar"
    type: "number"
    required: false
    label: "Max Stories"
    default: 3
secrets:
  - "DISCORD_BOT_TOKEN"
  - "NEWS_API_KEY"
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    wdir = workers_dir / "ai-news-digest"
    wdir.mkdir()
    (wdir / "worker.yml").write_text(_SCHEDULED_WORKER_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-suggest")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

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

    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": "test-secret-suggest"})
    yield client, main
    db.get_repositories.cache_clear()


def test_suggest_unknown_worker_returns_404(client_and_main):
    client, _ = client_and_main
    resp = client.post(
        "/workers/does-not-exist/suggest",
        json={"new_description": "Does something"},
    )
    assert resp.status_code == 404


def test_suggest_returns_no_conflicts_when_no_openai_key(client_and_main, monkeypatch):
    """When OPENAI_API_KEY is unset, the endpoint returns safely with no conflicts."""
    client, _ = client_and_main
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    resp = client.post(
        "/workers/ai-news-digest/suggest",
        json={"new_description": "Posts AI news every morning at 9am instead."},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["has_conflicts"] is False
    assert body["suggestions"] == []


def test_suggest_returns_conflicts_from_llm(client_and_main, monkeypatch):
    """When the LLM detects a conflict, it is surfaced as a structured suggestion."""
    client, _ = client_and_main
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-fake")

    mock_response = MagicMock()
    mock_response.choices[0].message.content = """{
        "has_conflicts": true,
        "suggestions": [
            {
                "field": "trigger.cron",
                "current": "*/5 * * * *",
                "suggested": "0 9 * * *",
                "reason": "Description says 'every morning at 9am' but cron is every 5 minutes."
            }
        ]
    }"""

    with patch("openai.OpenAI") as mock_openai_cls:
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock_response

        resp = client.post(
            "/workers/ai-news-digest/suggest",
            json={"new_description": "Posts AI news every morning at 9am."},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["has_conflicts"] is True
    assert len(body["suggestions"]) == 1
    s = body["suggestions"][0]
    assert s["field"] == "trigger.cron"
    assert "9am" in s["reason"] or "9" in s["suggested"]


def test_suggest_returns_no_conflicts_on_llm_error(client_and_main, monkeypatch):
    """If the OpenAI call throws, the endpoint degrades gracefully — no 500."""
    client, _ = client_and_main
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-fake")

    with patch("openai.OpenAI") as mock_openai_cls:
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.side_effect = RuntimeError("network timeout")

        resp = client.post(
            "/workers/ai-news-digest/suggest",
            json={"new_description": "Some description that would normally trigger a call."},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["has_conflicts"] is False
    assert body["suggestions"] == []


def test_suggest_no_conflicts_when_description_matches(client_and_main, monkeypatch):
    """When description is coherent with config, LLM returns no conflicts."""
    client, _ = client_and_main
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-fake")

    mock_response = MagicMock()
    mock_response.choices[0].message.content = '{"has_conflicts": false, "suggestions": []}'

    with patch("openai.OpenAI") as mock_openai_cls:
        mock_client = MagicMock()
        mock_openai_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = mock_response

        resp = client.post(
            "/workers/ai-news-digest/suggest",
            json={"new_description": "Posts AI news to Discord every 5 minutes."},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["has_conflicts"] is False
    assert body["suggestions"] == []
