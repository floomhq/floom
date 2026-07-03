from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-telemetry-e2e"


class _StubClient:
    def __init__(self):
        self.captured = []

    def capture(self, event, *, distinct_id=None, properties=None, groups=None, **_):
        self.captured.append(
            {
                "event": event,
                "distinct_id": distinct_id,
                "properties": properties or {},
                "groups": groups,
            }
        )

    def flush(self):
        pass

    def shutdown(self):
        pass


@pytest.fixture
def app_and_stub(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_test")
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
        "main",
        "run_service",
        "scheduler",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()

    from auth.factory import get_auth_provider
    from services import analytics_posthog

    get_auth_provider.cache_clear()
    main = importlib.import_module("main")
    analytics_posthog._reset_for_tests()
    stub = _StubClient()
    analytics_posthog._client = stub
    analytics_posthog._init_attempted = True
    yield main, db, stub
    analytics_posthog._reset_for_tests()
    get_auth_provider.cache_clear()
    db.get_repositories.cache_clear()


def _events(stub, name):
    return [event for event in stub.captured if event["event"] == name]


def test_cli_command_telemetry_endpoint_tags_source_cli(app_and_stub):
    main, _db, stub = app_and_stub
    client = TestClient(main.app, headers={"x-floom-secret": SECRET})

    response = client.post(
        "/telemetry/cli-command",
        json={
            "command": "run",
            "success": True,
            "duration_ms": 42,
            "exit_code": 0,
            "api_base_kind": "cloud",
            "worker_id": "wkr-1",
            "run_id": "run-1",
        },
    )

    assert response.status_code == 204
    events = _events(stub, "cli_command_invoked")
    assert len(events) == 1
    assert events[0]["properties"]["source"] == "cli"

    metrics = client.get("/system/metrics")
    assert metrics.status_code == 200
    telemetry = metrics.json()["telemetry"]
    assert set(telemetry) == {"captured_total", "failed_total", "last_failure_ts"}
    assert telemetry["captured_total"] >= 1


def test_mcp_tool_telemetry_endpoint_tags_source_mcp(app_and_stub):
    main, _db, stub = app_and_stub
    client = TestClient(main.app, headers={"x-floom-secret": SECRET})

    response = client.post(
        "/telemetry/mcp-tool",
        json={
            "tool_name": "workers.run",
            "success": True,
            "duration_ms": 51,
            "auth_method": "pat",
            "worker_id": "wkr-1",
            "run_id": "run-1",
            "status_code": 200,
            "is_custom_tool": False,
        },
    )

    assert response.status_code == 204
    events = _events(stub, "mcp_tool_called")
    assert len(events) == 1
    assert events[0]["properties"]["source"] == "mcp"


def test_cloud_mcp_dispatcher_tags_source_mcp(app_and_stub):
    main, _db, stub = app_and_stub
    from auth.context import AuthContext

    auth = AuthContext(
        user_id="owner-1",
        email="u@example.com",
        role="member",
        scopes=("member",),
        auth_method="pat",
        username=None,
    )

    main._emit_mcp_tool_called_event(
        auth=auth,
        tool_name="workers.list",
        arguments={},
        result=None,
        success=True,
        duration_ms=7,
    )

    events = _events(stub, "mcp_tool_called")
    assert len(events) == 1
    assert events[0]["properties"]["source"] == "mcp"
    assert events[0]["properties"]["tool_name"] == "workers.list"


def test_scheduler_trigger_fired_tags_source_schedule(app_and_stub):
    _main, _db, stub = app_and_stub
    scheduler = importlib.import_module("scheduler")

    scheduler._emit_trigger_fired(
        owner_id="owner-1",
        worker_id="wkr-1",
        run_id="run-1",
        trigger_type="schedule",
    )

    events = _events(stub, "trigger_fired")
    assert len(events) == 1
    assert events[0]["properties"]["source"] == "schedule"


def test_run_service_schedule_lifecycle_emits_one_completed_event(app_and_stub, monkeypatch):
    _main, db, stub = app_and_stub
    repos = db.get_repositories()
    run_service = importlib.import_module("run_service")
    from models import RunStatus

    manifest = {
        "id": "wkr-schedule",
        "name": "Scheduled Worker",
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "trigger": {"type": "schedule"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
    }
    repos.workers.create(
        user_id="owner-1",
        worker_id="wkr-schedule",
        name="Scheduled Worker",
        manifest_json=manifest,
        bundle_path="workers/wkr-schedule",
        trigger_type="schedule",
        workspace_id="ws_schedule",
        visibility="private",
    )
    repos.runs.create(
        user_id="owner-1",
        run_id="run-schedule-1",
        worker_id="wkr-schedule",
        trigger_source="schedule",
        status=RunStatus.RUNNING.value,
        runner="e2b",
        input_json={"x": 1},
        duration_ms=123,
    )

    monkeypatch.setattr(run_service, "_persist_run_cost", lambda *_, **__: None)
    monkeypatch.setattr(run_service, "_dispatch_terminal_run_alerts", lambda *_, **__: None)
    monkeypatch.setattr(run_service, "flush_run_logs", lambda *_args, **_kwargs: None)

    run_service.update_run_status(
        "run-schedule-1",
        RunStatus.COMPLETED.value,
        output={"ok": True},
        user_id="owner-1",
        repos=repos,
    )

    completed = [
        event
        for event in _events(stub, "run_completed")
        if event["properties"].get("run_id") == "run-schedule-1"
    ]
    assert len(completed) == 1
    assert completed[0]["properties"]["source"] == "schedule"
    assert completed[0]["properties"]["trigger_source"] == "schedule"
