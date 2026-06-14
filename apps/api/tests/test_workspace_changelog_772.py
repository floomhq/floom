"""#772 — unified workspace changelog merging worker + context + workspace
prompt git history into one timeline.

The git-workspace plumbing is exercised by the per-asset /versions tests;
here we mock _git_ops.get_log to return synthetic history per path and assert
the changelog's fan-out / merge / sort / asset-tagging logic.

Run: cd apps/api && python -m pytest tests/test_workspace_changelog_772.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-changelog"
OWNER = "federico"

_YML = """\
schema_version: "0.3"
name: "cl-worker"
title: "Changelog Worker"
description: "d"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections: []
"""


@pytest.fixture
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "cl-worker"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main", "contexts",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=OWNER)
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    # a non-sensitive (git-tracked) brain pack
    c.post("/contexts/facts", json={"writeable": True, "sensitive": False})
    yield c, main
    db.get_repositories.cache_clear()


def _fake_log(monkeypatch, main, mapping):
    """mapping: rel_path-substring -> list of (sha, message, timestamp)."""
    def _get_log(workspace, rel_path=None, limit=50, asset_type="", asset_id=""):
        for needle, rows in mapping.items():
            if needle in (rel_path or ""):
                return [
                    {"id": sha, "sha": sha, "message": msg, "author": "a",
                     "timestamp": ts, "asset_type": asset_type, "asset_id": asset_id}
                    for sha, msg, ts in rows
                ]
        return []
    monkeypatch.setattr(main._git_ops, "get_log", _get_log)


def test_changelog_merges_and_sorts(client, monkeypatch):
    c, main = client
    _fake_log(monkeypatch, main, {
        "cl-worker": [("aaaaaaa", "worker edit", "2026-06-10T10:00:00Z")],
        "facts": [("bbbbbbb", "added fact", "2026-06-11T09:00:00Z")],
        "workspace.md": [("ccccccc", "prompt tweak", "2026-06-09T08:00:00Z")],
    })
    resp = c.get("/workspace/changelog")
    assert resp.status_code == 200, resp.text
    entries = resp.json()
    # newest first across all asset types
    assert [e["sha"] for e in entries[:3]] == ["bbbbbbb", "aaaaaaa", "ccccccc"]
    by_sha = {e["sha"]: e for e in entries}
    assert by_sha["aaaaaaa"]["asset_type"] == "worker"
    assert by_sha["aaaaaaa"]["asset_name"] == "Changelog Worker"
    assert by_sha["bbbbbbb"]["asset_type"] == "context"
    assert by_sha["bbbbbbb"]["asset_name"] == "facts"
    assert by_sha["ccccccc"]["asset_type"] == "workspace_instructions"


def test_asset_types_filter(client, monkeypatch):
    c, main = client
    _fake_log(monkeypatch, main, {
        "cl-worker": [("aaaaaaa", "w", "2026-06-10T10:00:00Z")],
        "facts": [("bbbbbbb", "ctx", "2026-06-11T09:00:00Z")],
    })
    entries = c.get("/workspace/changelog?asset_types=worker").json()
    assert all(e["asset_type"] == "worker" for e in entries)
    assert any(e["sha"] == "aaaaaaa" for e in entries)


def test_limit_applied(client, monkeypatch):
    c, main = client
    _fake_log(monkeypatch, main, {
        "cl-worker": [(f"sha{i:04d}", "m", f"2026-06-{i+1:02d}T00:00:00Z") for i in range(10)],
    })
    entries = c.get("/workspace/changelog?limit=3").json()
    assert len(entries) == 3
