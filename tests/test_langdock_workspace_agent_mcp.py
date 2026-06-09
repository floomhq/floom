import importlib
import json
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "mcp-test-user")
    monkeypatch.setenv("WORKSPACE_AGENT_MCP_TOKEN", "test-langdock-token")

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "chat_service"]:
        sys.modules.pop(name, None)
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
    assert body["result"]["serverInfo"]["version"] == "0.2.0"
    assert "tools" in body["result"]["capabilities"]


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


def test_langdock_mcp_rejects_missing_or_invalid_token(monkeypatch, tmp_path):
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

    assert missing.status_code == 401
    assert invalid.status_code == 401


def test_langdock_mcp_lists_workspace_agent_tool(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app) as client:
        response = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/list")),
            headers={"x-api-key": "test-langdock-token", "Content-Type": "application/json"},
        )

    assert response.status_code == 200, response.text
    tools = response.json()["result"]["tools"]
    by_name = {tool["name"]: tool for tool in tools}
    assert "ask_workspace_agent" in by_name
    assert "workers.list" in by_name
    assert "contexts.write" in by_name
    assert by_name["ask_workspace_agent"]["inputSchema"]["required"] == ["message"]


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
