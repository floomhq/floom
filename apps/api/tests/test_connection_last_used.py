"""#802 — GET /connections surfaces last_used_at + last_used_by per connection.

ConnectionItem had last_checked_at (health) but no last_used. Added a
correlation: the most recent run of any worker declaring the connection slug.

Run: cd apps/api && python -m pytest tests/test_connection_last_used.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-connused"
OWNER = "federico"

_YML = """\
schema_version: "0.3"
name: "gmail-worker"
title: "Gmail Worker"
description: "uses gmail"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections:
  - "gmail"
"""


@pytest.fixture
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "gmail-worker"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
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
    for _n in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(_n, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=OWNER)
    repos = main.get_repositories()
    now = main.now_iso()
    repos.connections.upsert(
        user_id=OWNER, id="conn-gmail", app_name="gmail",
        composio_connection_id="ca_gmail", status="active",
        account_label="me@example.com", created_at=now, updated_at=now,
    )
    repos.runs.create(
        user_id=OWNER, run_id="run-1", worker_id="gmail-worker",
        status=main.RunStatus.COMPLETED.value, trigger_source="manual",
        runner="e2b", input_json={}, output_json={},
    )
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield c
    db.get_repositories.cache_clear()


def test_connection_shows_last_used(client):
    resp = client.get("/connections")
    assert resp.status_code == 200, resp.text
    gmail = next((c for c in resp.json() if c["app_name"] == "gmail"), None)
    assert gmail is not None
    assert gmail["last_used_at"] is not None
    assert gmail["last_used_by"] == "Gmail Worker"  # the worker's display name


def test_unused_connection_has_null_last_used(client, monkeypatch):
    # a connection with no worker/run declaring it stays null
    import importlib
    main = importlib.import_module("main")
    repos = main.get_repositories()
    now = main.now_iso()
    repos.connections.upsert(
        user_id=OWNER, id="conn-slack", app_name="slack",
        composio_connection_id="ca_slack", status="active",
        account_label="team", created_at=now, updated_at=now,
    )
    resp = client.get("/connections")
    slack = next((c for c in resp.json() if c["app_name"] == "slack"), None)
    assert slack is not None
    assert slack["last_used_at"] is None
    assert slack["last_used_by"] is None
