"""#796 — GET /runs/export.csv bulk-exports the run list as CSV.

Run: cd apps/api && python -m pytest tests/test_runs_csv_export.py -q
"""
from __future__ import annotations

import csv
import importlib
import io
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-runscsv"
OWNER = "federico"

_YML = """\
schema_version: "0.3"
name: "csvw"
title: "CSV Worker"
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
    wdir = workers_dir / "csvw"
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
    repos = main.get_repositories()
    for i in range(3):
        repos.runs.create(
            user_id=OWNER, run_id=f"run-{i}", worker_id="csvw",
            status=main.RunStatus.COMPLETED.value, trigger_source="manual",
            runner="e2b", input_json={}, output_json={},
        )
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield c
    db.get_repositories.cache_clear()


def test_export_csv(client):
    resp = client.get("/runs/export.csv")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in resp.headers["content-disposition"]
    reader = list(csv.reader(io.StringIO(resp.text)))
    assert reader[0] == [
        "id", "worker_id", "worker_name", "status", "trigger_source",
        "created_at", "started_at", "completed_at", "duration_ms", "error_code",
    ]
    ids = {row[0] for row in reader[1:]}
    assert {"run-0", "run-1", "run-2"} <= ids


def test_export_csv_filtered_by_worker(client):
    resp = client.get("/runs/export.csv?worker_id=csvw")
    assert resp.status_code == 200
    rows = list(csv.reader(io.StringIO(resp.text)))[1:]
    assert all(r[1] == "csvw" for r in rows)


def test_export_csv_invalid_since_400(client):
    assert client.get("/runs/export.csv?since=not-a-date").status_code == 400
