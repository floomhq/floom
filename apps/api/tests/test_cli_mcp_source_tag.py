from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest
from fastapi import Request
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-telemetry-source"


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
    yield main, stub
    analytics_posthog._reset_for_tests()
    get_auth_provider.cache_clear()


def _events(stub, name):
    return [event for event in stub.captured if event["event"] == name]


class _CloudMembers:
    def __init__(self, workspace_id):
        self.workspace_id = workspace_id

    def list_for_user(self, *, user_id):
        return [
            {
                "workspace_id": self.workspace_id,
                "user_id": user_id,
                "role": "admin",
                "status": "active",
            }
        ]


class _CloudRepos:
    def __init__(self, workspace_id):
        self.members = _CloudMembers(workspace_id)


def test_cli_command_telemetry_endpoint_forces_cli_source(app_and_stub):
    main, stub = app_and_stub
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


def test_cli_command_telemetry_endpoint_uses_cloud_membership_workspace(
    app_and_stub, monkeypatch
):
    main, stub = app_and_stub
    from auth.context import AuthContext

    workspace_id = "ws_cloud_real"
    auth = AuthContext(
        user_id="user-cloud-1",
        email="u@example.com",
        role="admin",
        scopes=("admin",),
        auth_method="pat",
        username="cloud-user",
    )

    async def _cloud_auth(request: Request):
        request.state.auth_context = auth
        return auth

    monkeypatch.setattr(main, "get_repositories", lambda: _CloudRepos(workspace_id))
    main.app.dependency_overrides[main.get_auth_context] = _cloud_auth
    try:
        client = TestClient(main.app)
        response = client.post(
            "/telemetry/cli-command",
            headers={"x-floom-secret": SECRET},
            json={
                "command": "run",
                "success": True,
                "duration_ms": 42,
                "exit_code": 0,
                "api_base_kind": "cloud",
            },
        )
    finally:
        main.app.dependency_overrides.pop(main.get_auth_context, None)

    assert response.status_code == 204
    events = _events(stub, "cli_command_invoked")
    assert len(events) == 1
    assert events[0]["distinct_id"] == auth.user_id
    assert events[0]["groups"] == {"workspace": workspace_id}
    assert events[0]["groups"]["workspace"] != "local-default"
    assert events[0]["properties"]["api_base_kind"] == "cloud"


def test_mcp_tool_telemetry_endpoint_forces_mcp_source(app_and_stub):
    main, stub = app_and_stub
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


def test_cli_command_telemetry_endpoint_honors_do_not_track(app_and_stub):
    main, stub = app_and_stub
    client = TestClient(main.app)

    response = client.post(
        "/telemetry/cli-command",
        headers={"x-floom-secret": SECRET, "X-Floom-Do-Not-Track": "1"},
        json={
            "command": "run",
            "success": True,
            "duration_ms": 42,
            "exit_code": 0,
            "api_base_kind": "cloud",
        },
    )

    assert response.status_code == 204
    assert _events(stub, "cli_command_invoked") == []


def test_cli_command_telemetry_endpoint_drops_probe_commands(app_and_stub):
    main, stub = app_and_stub
    client = TestClient(main.app)

    response = client.post(
        "/telemetry/cli-command",
        headers={"x-floom-secret": SECRET},
        json={
            "command": "codex.telemetry_probe.issue_945",
            "success": True,
            "duration_ms": 1,
            "exit_code": 0,
            "api_base_kind": "cloud",
        },
    )

    assert response.status_code == 204
    assert _events(stub, "cli_command_invoked") == []


def test_mcp_tool_telemetry_endpoint_honors_do_not_track(app_and_stub):
    main, stub = app_and_stub
    client = TestClient(main.app)

    response = client.post(
        "/telemetry/mcp-tool",
        headers={"x-floom-secret": SECRET, "X-Floom-Do-Not-Track": "1"},
        json={
            "tool_name": "workers.run",
            "success": True,
            "duration_ms": 51,
            "auth_method": "pat",
            "status_code": 200,
            "is_custom_tool": False,
        },
    )

    assert response.status_code == 204
    assert _events(stub, "mcp_tool_called") == []


def test_mcp_tool_telemetry_endpoint_drops_probe_tools(app_and_stub):
    main, stub = app_and_stub
    client = TestClient(main.app)

    response = client.post(
        "/telemetry/mcp-tool",
        headers={"x-floom-secret": SECRET},
        json={
            "tool_name": "does.not.exist",
            "success": False,
            "duration_ms": 1,
            "auth_method": "pat",
            "status_code": 404,
            "is_custom_tool": True,
        },
    )

    assert response.status_code == 204
    assert _events(stub, "mcp_tool_called") == []


def test_cloud_mcp_dispatcher_forces_mcp_source(app_and_stub):
    """The cloud MCP dispatcher (_emit_mcp_tool_called_event) serves
    /mcp/{workspace} tool calls which carry no X-Floom-Source header, so it must
    force source="mcp" rather than defaulting to "api"."""
    main, stub = app_and_stub
    from auth.context import AuthContext

    auth = AuthContext(
        user_id="owner-1", email="u@example.com", role="member",
        scopes=("member",), auth_method="pat", username=None,
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
