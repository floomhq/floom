import importlib
import json
import sys
import types
from pathlib import Path

import pytest

from fastapi.testclient import TestClient


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "mcp-test-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKSPACE_AGENT_MCP_TOKEN", "test-langdock-token")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)

    sys.path.insert(0, str(api_dir))
    for name in list(sys.modules):
        if any(name == m or name.startswith(m + ".") for m in [
            "main", "db", "models", "worker_registry", "runner_utils",
            "run_service", "chat_service", "auth", "contexts", "git_ops",
        ]):
            sys.modules.pop(name, None)
        for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
            sys.modules.pop(_rn, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _auth_headers(token: str = "test-langdock-token"):
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _secret_headers():
    return {"x-floom-secret": "test-api-secret"}


def _rpc(method, request_id=1, params=None):
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        payload["params"] = params
    return payload


def test_langdock_mcp_initialize_bypasses_floom_secret_with_bearer_auth(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app) as client:
        response = client.post(
            "/langdock/mcp",
            data=json.dumps(_rpc("initialize")),
            headers=_auth_headers(),
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["jsonrpc"] == "2.0"
    assert body["id"] == 1
    assert body["result"]["serverInfo"]["name"] == "workeros"
    assert "tools" in body["result"]["capabilities"]


@pytest.mark.parametrize(
    "path,expected_status",
    [
        ("/api/mcp", 200),
        ("/mcp", 200),
        ("/api/mcp/setup/langdock", 200),
        ("/mcp/setup/langdock", 200),
        ("/langdock/mcp", 200),
        ("/workspace-agent/mcp", 200),
        ("/api/langdock/mcp", 200),
        ("/api/workspace-agent/mcp", 200),
    ],
)
def test_workspace_agent_mcp_discovery_routes_require_auth(monkeypatch, tmp_path, path, expected_status):
    main = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app) as client:
        missing = client.get(path)
        authenticated = client.get(path, headers=_secret_headers())

    assert missing.status_code == 401, missing.text
    assert authenticated.status_code == expected_status, authenticated.text
    body = authenticated.json()
    if "setup" in path:
        assert body["server_url"] == "http://localhost:8000/api/mcp"
        assert body["transport"] == "STREAMABLE_HTTP"
        assert body["authentication"]["method"] == "API Key"
        assert body["authentication"]["token_configured"] is True
    else:
        assert body["name"] == "workeros"
        assert body["version"] == "0.2.0"
        assert body["protocol"] == "2024-11-05"
        assert body["transport"] == "streamable-http"
        assert body["endpoint"] == "POST /api/mcp"
        assert "workers.list" in body["tools"]
        assert "contexts.write" in body["tools"]


def test_workspace_agent_mcp_get_discovery_matches_nova_pattern(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app) as client:
        response = client.get("/api/mcp", headers=_secret_headers())
        mounted_response = client.get("/mcp", headers=_secret_headers())

    assert response.status_code == 200, response.text
    assert mounted_response.status_code == 200, mounted_response.text
    body = response.json()
    assert body["name"] == "workeros"
    assert body["version"] == "0.2.0"
    assert body["protocol"] == "2024-11-05"
    assert body["transport"] == "streamable-http"
    assert body["endpoint"] == "POST /api/mcp"
    assert "ask_workspace_agent" in body["tools"]
    assert "workers.list" in body["tools"]
    assert "contexts.write" in body["tools"]
    assert mounted_response.json() == body


def test_langdock_mcp_accepts_existing_workeros_secret_and_rejects_invalid_token(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app) as client:
        missing = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/list")),
            headers={"Content-Type": "application/json"},
        )
        invalid = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/list")),
            headers=_auth_headers("wrong-token"),
        )
        existing_secret = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/list")),
            headers={"x-api-key": "test-api-secret", "Content-Type": "application/json"},
        )

    assert missing.status_code == 401
    assert invalid.status_code == 401
    assert existing_secret.status_code == 200, existing_secret.text


def test_cloud_mcp_accepts_workeros_api_token_via_x_api_key(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    from auth import AuthContext, register_auth_provider

    seen_headers = []

    class FakeCloudAuthProvider:
        async def verify(self, request):
            seen_headers.append(request.headers.get("x-floom-token"))
            if request.headers.get("x-floom-token") != "workspace-pat":
                raise main.HTTPException(status_code=401, detail="invalid token")
            return AuthContext(user_id="00000000-0000-4000-8000-000000000001", scopes=("api",))

    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    register_auth_provider("cloud", lambda: FakeCloudAuthProvider())

    with TestClient(main.app) as client:
        response = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/list")),
            headers={"x-api-key": "workspace-pat", "Content-Type": "application/json"},
        )

    assert response.status_code == 200, response.text
    assert seen_headers == ["workspace-pat"]


def test_langdock_mcp_lists_remote_workeros_control_plane_tools(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app) as client:
        response = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/list")),
            headers={"x-api-key": "test-langdock-token", "Content-Type": "application/json"},
        )

    assert response.status_code == 200, response.text
    tools = response.json()["result"]["tools"]
    names = [tool["name"] for tool in tools]
    assert "ask_workspace_agent" in names
    assert "workers.list" in names
    assert "workers.create" in names
    assert "workers.update" in names
    assert "workers.run" in names
    assert "runs.list" in names
    assert "runs.watch" in names
    assert "secrets.list" in names
    assert "secrets.set" in names
    # #838: connections.add_mcp is gated off by default on every MCP surface;
    # it is only advertised when WORKEROS_MCP_ENABLE_DESTRUCTIVE=1.
    assert "connections.add_mcp" not in names
    assert "contexts.read" in names
    assert "contexts.write" in names
    monkeypatch.setenv("WORKEROS_MCP_ENABLE_DESTRUCTIVE", "1")
    with TestClient(main.app) as client:
        opted_in = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/list")),
            headers={"x-api-key": "test-langdock-token", "Content-Type": "application/json"},
        )
    opted_names = [tool["name"] for tool in opted_in.json()["result"]["tools"]]
    assert "connections.add_mcp" in opted_names
    workspace_tool = next(tool for tool in tools if tool["name"] == "ask_workspace_agent")
    assert workspace_tool["inputSchema"]["required"] == ["message"]
    create_tool = next(tool for tool in tools if tool["name"] == "workers.create")
    create_desc = create_tool["inputSchema"]["properties"]["worker_yml"]["description"]
    assert 'schema_version: "0.3"' in create_desc
    assert "inputs.json" in create_desc
    assert "result.json" in create_desc


def test_langdock_mcp_tool_call_forwards_to_workspace_agent(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    calls = []

    async def fake_collect(*, message, user_id, conversation_id):
        calls.append((message, user_id, conversation_id))
        return "workspace agent answer"

    monkeypatch.setattr(main, "_collect_workspace_agent_reply_for_langdock", fake_collect)

    payload = _rpc(
        "tools/call",
        request_id="call-1",
        params={
            "name": "ask_workeros_workspace_agent",
            "arguments": {
                "message": "Summarize failed worker runs",
                "conversation_id": "chat 123",
            },
        },
    )

    with TestClient(main.app) as client:
        response = client.post(
            "/api/mcp",
            data=json.dumps(payload),
            headers=_auth_headers(),
        )

    assert response.status_code == 200, response.text
    assert calls == [("Summarize failed worker runs", "mcp-test-user", "langdock:chat_123")]
    body = response.json()
    assert body["id"] == "call-1"
    assert body["result"]["content"] == [{"type": "text", "text": "workspace agent answer"}]
    assert body["result"]["structuredContent"] == {"conversation_id": "langdock:chat_123"}
    assert body["result"]["isError"] is False


def test_langdock_mcp_returns_tool_error_for_unknown_tool(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    payload = _rpc(
        "tools/call",
        params={"name": "unknown", "arguments": {"message": "hello"}},
    )

    with TestClient(main.app) as client:
        response = client.post(
            "/api/mcp",
            data=json.dumps(payload),
            headers=_auth_headers(),
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["result"]["isError"] is True
    assert body["result"]["content"][0]["text"] == "Unknown tool: unknown"


def test_remote_mcp_direct_tools_can_list_workers_and_roundtrip_context_file(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app) as client:
        create_context = client.post(
            "/contexts/demo",
            data=json.dumps({"writeable": True}),
            headers={"x-floom-secret": "test-api-secret", "Content-Type": "application/json"},
        )
        workers_list = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/call", params={"name": "workers.list", "arguments": {}})),
            headers=_auth_headers(),
        )
        context_write = client.post(
            "/api/mcp",
            data=json.dumps(
                _rpc(
                    "tools/call",
                    request_id="ctx-write",
                    params={
                        "name": "contexts.write",
                        "arguments": {
                            "name": "demo",
                            "path": "notes/hello.md",
                            "content": "hello from remote mcp",
                        },
                    },
                )
            ),
            headers=_auth_headers(),
        )
        context_read = client.post(
            "/api/mcp",
            data=json.dumps(
                _rpc(
                    "tools/call",
                    request_id="ctx-read",
                    params={
                        "name": "contexts.read",
                        "arguments": {"name": "demo", "path": "notes/hello.md"},
                    },
                )
            ),
            headers=_auth_headers(),
        )

    assert create_context.status_code == 200, create_context.text
    assert workers_list.status_code == 200, workers_list.text
    assert workers_list.json()["result"]["isError"] is False
    assert isinstance(workers_list.json()["result"]["structuredContent"], dict)
    assert context_write.status_code == 200, context_write.text
    assert context_write.json()["result"]["isError"] is False
    assert context_read.status_code == 200, context_read.text
    read_result = context_read.json()["result"]
    assert read_result["isError"] is False
    assert read_result["structuredContent"]["content"] == "hello from remote mcp"


def test_langdock_setup_card_exposes_self_service_metadata(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app) as client:
        response = client.get("/api/mcp/setup/langdock", headers=_secret_headers())

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["server_url"] == "http://localhost:8000/api/mcp"
    assert body["transport"] == "STREAMABLE_HTTP"
    assert body["authentication"]["method"] == "API Key"
    assert body["authentication"]["token_configured"] is True
    assert "ask_workspace_agent" in body["tools"]
    assert any("Langdock" in item for item in body["checklist"])
