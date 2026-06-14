from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


SECRET = "test-secret-emily-async"
OWNER = "federico"

_YML = """\
schema_version: "0.3"
name: "candidate-search-contract"
title: "Candidate Search Contract"
description: "Async candidate search smoke worker"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  inputs:
    - name: mandate
      type: string
      label: Mandate
  outputs:
    - name: candidates
      type: json
      label: Candidates
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "candidate-search-contract"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('candidate search')\n", encoding="utf-8")

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

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=OWNER)

    def complete_run(run_id, worker_id, inputs, *, user_id=None, repos=None):
        main.update_run_status(
            run_id,
            main.RunStatus.COMPLETED.value,
            output={
                "candidates": [
                    {"candidate_id": "cand_001", "name": "Ada Lovelace"},
                    {"candidate_id": "cand_002", "name": "Grace Hopper"},
                ]
            },
            user_id=user_id or OWNER,
            repos=repos,
        )

    monkeypatch.setattr(main, "start_run", complete_run)

    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield client, main
    db.get_repositories.cache_clear()


def test_emily_worker_async_v4_contract(client_and_main):
    client, _main = client_and_main

    started = client.post(
        "/workers/candidate-search-contract/runs",
        json={
            "inputs": {"mandate": "Find senior backend engineers in Berlin"},
            "trigger_source": "manual",
        },
    )
    assert started.status_code == 200, started.text
    start_body = started.json()
    assert start_body["status"] == "running"
    assert start_body["run_id"].startswith("run_")

    detail = client.get(f"/runs/{start_body['run_id']}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["id"] == start_body["run_id"]
    assert body["status"] == "completed"
    assert body["outputs"]["candidates"][0]["candidate_id"] == "cand_001"
    assert body["inputs"] == {"mandate": "Find senior backend engineers in Berlin"}
