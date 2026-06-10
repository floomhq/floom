"""Tests for the worker feedback API (SPEC §12).

Covers:
  POST   /workers/{id}/feedback              — leave a comment (anyone who can SEE)
  GET    /workers/{id}/feedback              — list comments (oldest first)
  DELETE /workers/{id}/feedback/{fid}        — remove a comment (author/owner/admin)

Runs against an in-memory SQLite DB with a real FastAPI TestClient; no network.
"""

from __future__ import annotations

import importlib
import platform
import sys
from pathlib import Path

import pytest

# The fixture boots the full FastAPI app (SQLite-backed) which imports `fcntl`,
# a Linux-only module. Skip on Windows; these run in CI on ubuntu-latest.
_LINUX_ONLY = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="SQLite db layer uses fcntl (Linux only); runs in CI on ubuntu-latest",
)

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_WORKER_YML = """\
schema_version: "0.3"
name: "ai-news-digest"
title: "AI News Digest"
description: "Fetches AI news and posts to Discord every 60 minutes."
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "0 * * * *"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
connections: []
"""

_WORKER_ID = "ai-news-digest"
_SECRET = "test-secret-feedback"
_USER_ID = "federico"


@pytest.fixture
def client_and_repos(monkeypatch, tmp_path):
    """Spin up a full FastAPI TestClient with an isolated SQLite DB."""
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    wdir = workers_dir / _WORKER_ID
    wdir.mkdir()
    (wdir / "worker.yml").write_text(_WORKER_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('running')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
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
        main._persist_discovered_workers(conn, workers, user_id=_USER_ID)

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": _SECRET})
    repos = db.get_repositories()
    yield client, repos
    db.get_repositories.cache_clear()


@_LINUX_ONLY
class TestWorkerFeedback:
    def test_create_feedback_returns_201_with_shape(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.post(
            f"/workers/{_WORKER_ID}/feedback",
            json={"content": "The Discord formatting is off on long stories."},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["worker_id"] == _WORKER_ID
        assert body["content"] == "The Discord formatting is off on long stories."
        assert body["id"].startswith("fdbk_")
        assert body["author_id"]  # author captured from auth
        assert body["created_at"]

    def test_create_feedback_404_for_unknown_worker(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.post("/workers/ghost/feedback", json={"content": "hi"})
        assert resp.status_code == 404

    def test_create_feedback_400_for_empty_content(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.post(f"/workers/{_WORKER_ID}/feedback", json={"content": "   "})
        assert resp.status_code == 400

    def test_list_feedback_returns_all_oldest_first(self, client_and_repos):
        client, _ = client_and_repos
        client.post(f"/workers/{_WORKER_ID}/feedback", json={"content": "first"})
        client.post(f"/workers/{_WORKER_ID}/feedback", json={"content": "second"})
        resp = client.get(f"/workers/{_WORKER_ID}/feedback")
        assert resp.status_code == 200
        items = resp.json()
        assert [i["content"] for i in items] == ["first", "second"]

    def test_list_feedback_404_for_unknown_worker(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.get("/workers/ghost/feedback")
        assert resp.status_code == 404

    def test_delete_feedback_by_author(self, client_and_repos):
        client, _ = client_and_repos
        created = client.post(
            f"/workers/{_WORKER_ID}/feedback", json={"content": "remove me"}
        ).json()
        fid = created["id"]
        resp = client.delete(f"/workers/{_WORKER_ID}/feedback/{fid}")
        assert resp.status_code == 204
        remaining = client.get(f"/workers/{_WORKER_ID}/feedback").json()
        assert all(i["id"] != fid for i in remaining)

    def test_delete_unknown_feedback_404(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.delete(f"/workers/{_WORKER_ID}/feedback/fdbk_does_not_exist")
        assert resp.status_code == 404
