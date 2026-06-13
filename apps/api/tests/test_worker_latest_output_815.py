"""#815 — worker detail surfaces the most recent completed run's output
(output-first overview).

Run: cd apps/api && python -m pytest tests/test_worker_latest_output_815.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-latestout"
OWNER = "federico"

_YML = """\
schema_version: "0.3"
name: "outw"
title: "Output Worker"
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
    wdir = workers_dir / "outw"
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
    # Purge router modules too: handlers hold Depends(get_repos) directly, so a
    # cached router would keep the prior db's get_repos and 404 after re-import.
    for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
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
    yield c, main
    db.get_repositories.cache_clear()


def test_latest_output_surfaced(client):
    c, main = client
    repos = main.get_repositories()
    # an older completed run and a newer one with distinct output
    repos.runs.create(
        user_id=OWNER, run_id="old", worker_id="outw",
        status=main.RunStatus.COMPLETED.value, trigger_source="manual",
        runner="e2b", input_json={}, output_json={"answer": "OLD"},
    )
    repos.runs.create(
        user_id=OWNER, run_id="new", worker_id="outw",
        status=main.RunStatus.COMPLETED.value, trigger_source="manual",
        runner="e2b", input_json={}, output_json={"answer": "NEW"},
    )
    body = c.get("/workers/outw").json()
    assert body["latest_output"] == {"answer": "NEW"}
    assert body["latest_output_run_id"] == "new"


def test_no_completed_run_null(client):
    c, main = client
    repos = main.get_repositories()
    repos.runs.create(
        user_id=OWNER, run_id="failed", worker_id="outw",
        status=main.RunStatus.FAILED.value, trigger_source="manual",
        runner="e2b", input_json={}, output_json={},
    )
    body = c.get("/workers/outw").json()
    assert body["latest_output"] is None
    assert body["latest_output_run_id"] is None
