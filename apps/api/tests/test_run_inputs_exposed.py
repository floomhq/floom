from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


SECRET = "test-secret-run-inputs"
OWNER = "local-user"

_YML = """\
schema_version: "0.3"
name: "input-log-worker"
title: "Input Log Worker"
description: "captures run inputs"
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
outputs: []
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "input-log-worker"
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

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=OWNER)
    repos = main.get_repositories()
    repos.runs.create(
        user_id=OWNER,
        run_id="run_input_log_1",
        worker_id="input-log-worker",
        status=main.RunStatus.COMPLETED.value,
        trigger_source="manual",
        runner="e2b",
        input_json={"mandate": "find Berlin platform engineers", "limit": 12},
        output_json={"ok": True},
    )

    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield client, main
    db.get_repositories.cache_clear()


def test_run_inputs_are_exposed_in_list_and_detail(client_and_main):
    client, _main = client_and_main

    listed = client.get("/runs?worker_id=input-log-worker")
    assert listed.status_code == 200, listed.text
    run_summary = next(item for item in listed.json() if item["id"] == "run_input_log_1")
    expected_input = {
        "mandate": "find Berlin platform engineers",
        "limit": 12,
    }
    assert run_summary["input"] == expected_input
    assert run_summary["inputs"] == expected_input

    detail = client.get("/runs/run_input_log_1")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["input"] == expected_input
    assert body["inputs"] == body["input"]
