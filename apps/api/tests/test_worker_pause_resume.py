"""#788 — POST /workers/{id}/pause and /resume toggle the enabled state.

Workers have an `enabled` DB column but no dedicated endpoint to toggle it;
pausing required editing worker.yml via a full PUT. These endpoints flip
enabled (and clear next_run_at on pause to unschedule).

Run: cd apps/api && python -m pytest tests/test_worker_pause_resume.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-pause"

_YML = """\
schema_version: "0.3"
name: "pausable"
title: "Pausable Worker"
description: "A worker we can pause and resume"
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "0 9 * * *"
  timezone: "UTC"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "pausable"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
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
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="local-user")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": SECRET})
    yield client, main
    db.get_repositories.cache_clear()


def test_pause_then_resume(client_and_main):
    client, _ = client_and_main
    initial = client.get("/workers/pausable").json()
    assert initial["enabled"] is True
    assert initial["status"] == "ready"

    paused = client.post("/workers/pausable/pause")
    assert paused.status_code == 200, paused.text
    assert paused.json()["enabled"] is False
    assert paused.json()["status"] == "needs_attention"
    paused_detail = client.get("/workers/pausable").json()
    assert paused_detail["enabled"] is False
    assert paused_detail["status"] == "needs_attention"

    resumed = client.post("/workers/pausable/resume")
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["enabled"] is True
    assert resumed.json()["status"] == "ready"
    resumed_detail = client.get("/workers/pausable").json()
    assert resumed_detail["enabled"] is True
    assert resumed_detail["status"] == "ready"


def test_pause_clears_next_run_at(client_and_main):
    client, main = client_and_main
    with main.get_db() as conn:
        conn.execute("UPDATE workers SET next_run_at = '2099-01-01T00:00:00Z' WHERE id = ?", ("pausable",))
    client.post("/workers/pausable/pause")
    with main.get_db() as conn:
        row = conn.execute("SELECT next_run_at FROM workers WHERE id = ?", ("pausable",)).fetchone()
    assert row["next_run_at"] is None


def test_pause_unknown_worker_404(client_and_main):
    client, _ = client_and_main
    assert client.post("/workers/does-not-exist/pause").status_code == 404
