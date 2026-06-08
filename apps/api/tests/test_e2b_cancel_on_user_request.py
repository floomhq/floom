from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    (tmp_path / "workers").mkdir()

    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "worker_registry",
        "runner_utils",
        "runner_sandbox",
        "runner_sandbox.e2b_driver",
        "run_service",
        "main",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return db, main


def _create_worker_and_run(repos, *, status: str) -> None:
    manifest = {
        "id": "node-smoke-test",
        "name": "Node Smoke Test",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
    }
    repos.workers.create(
        user_id="federico",
        worker_id="node-smoke-test",
        name="Node Smoke Test",
        manifest_json=manifest,
        bundle_path="workers/node-smoke-test",
    )
    repos.runs.create(
        user_id="federico",
        run_id="run-cancel",
        worker_id="node-smoke-test",
        status=status,
        trigger_source="manual",
        runner="e2b",
    )


def test_running_run_cancel_kills_e2b_sandbox(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    _create_worker_and_run(repos, status="running")

    calls: list[tuple[str, str | None]] = []
    e2b_driver = importlib.import_module("runner_sandbox.e2b_driver")
    monkeypatch.setattr(
        e2b_driver,
        "cancel_sandbox",
        lambda run_id, *, reason=None: calls.append((run_id, reason)) or True,
    )

    client = TestClient(main.app, raise_server_exceptions=False)
    resp = client.post(
        "/runs/run-cancel/cancel",
        headers={"x-floom-secret": "test-secret"},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancel_requested"
    assert calls == [("run-cancel", "User requested cancellation.")]

    row = repos.runs.get(user_id="federico", run_id="run-cancel")
    assert row["cancel_requested"] == 1
    assert row["status"] == "running"
    db.get_repositories.cache_clear()


def test_running_run_cancel_still_records_request_when_no_e2b_sandbox(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    _create_worker_and_run(repos, status="running")

    calls: list[str] = []
    e2b_driver = importlib.import_module("runner_sandbox.e2b_driver")
    monkeypatch.setattr(
        e2b_driver,
        "cancel_sandbox",
        lambda run_id, *, reason=None: calls.append(run_id) and False,
    )

    client = TestClient(main.app, raise_server_exceptions=False)
    resp = client.post(
        "/runs/run-cancel/cancel",
        headers={"x-floom-secret": "test-secret"},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancel_requested"
    assert calls == ["run-cancel"]

    row = repos.runs.get(user_id="federico", run_id="run-cancel")
    assert row["cancel_requested"] == 1
    assert row["status"] == "running"
    db.get_repositories.cache_clear()


def test_queued_run_cancel_does_not_call_e2b_sandbox(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    _create_worker_and_run(repos, status="queued")

    calls: list[str] = []
    e2b_driver = importlib.import_module("runner_sandbox.e2b_driver")
    monkeypatch.setattr(
        e2b_driver,
        "cancel_sandbox",
        lambda run_id, *, reason=None: calls.append(run_id) or True,
    )

    client = TestClient(main.app, raise_server_exceptions=False)
    resp = client.post(
        "/runs/run-cancel/cancel",
        headers={"x-floom-secret": "test-secret"},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancelled"
    assert calls == []

    row = repos.runs.get(user_id="federico", run_id="run-cancel")
    assert row["cancel_requested"] == 1
    assert row["status"] == "failed"
    assert row["error_code"] == "cancelled_queued"
    db.get_repositories.cache_clear()


def test_cancel_flag_db_read_failure_fails_closed_and_is_metrified(monkeypatch, tmp_path, caplog):
    db, main = _load_app(monkeypatch, tmp_path)
    import db as db_module
    import runner_sandbox.agent_driver as agent_driver
    from unittest.mock import patch

    before = agent_driver.cancel_flag_db_read_errors_total()

    with patch.object(db_module, "get_db", side_effect=RuntimeError("db unavailable")):
        with caplog.at_level("WARNING", logger="floom.runner_sandbox.agent"):
            result = agent_driver.AgentDriver()._cancel_requested("run-missing")

    assert result is True
    assert agent_driver.cancel_flag_db_read_errors_total() == before + 1
    assert any("cancel flag read failed" in record.message.lower() for record in caplog.records)

    client = TestClient(main.app, raise_server_exceptions=False)
    metrics = client.get("/system/metrics", headers={"x-floom-secret": "test-secret"})
    assert metrics.status_code == 200, metrics.text
    assert metrics.json()["cancel_flag_db_read_errors"] == before + 1

    prom = client.get("/metrics", headers={"x-floom-secret": "test-secret"})
    assert prom.status_code == 200, prom.text
    assert f"workeros_cancel_flag_db_read_errors_total {before + 1}" in prom.text
    db.get_repositories.cache_clear()
