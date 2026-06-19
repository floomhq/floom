"""Follow-through for #833/#838/#840 — the workspace-agent MCP surface
(/api/mcp) must enforce the same per-tool gates as /mcp-tools/serve.

RCA (found in adversarial review of the original fix batch): /api/mcp has its
own dispatcher (_call_workeros_remote_mcp_tool) that routed tools like
connections.add_mcp and secrets.set with no per-tool check — so the gates
added to /mcp-tools/serve were bypassable by anyone holding the workspace
agent token (and, in cloud mode, by member PATs).

Fix: _mcp_access_error is enforced in this surface's tools/list and
tools/call, with the same audit logging.

Run:
    cd apps/api && python -m pytest tests/test_workspace_agent_mcp_gating.py -v
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

TOKEN = "test-wsa-token"


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKSPACE_AGENT_MCP_TOKEN", TOKEN)
    monkeypatch.delenv("WORKEROS_MCP_ENABLE_DESTRUCTIVE", raising=False)
    monkeypatch.delenv("WORKEROS_MCP_ENABLED_TOOLS", raising=False)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _post(main, payload):
    from fastapi.testclient import TestClient

    with TestClient(main.app, raise_server_exceptions=False) as client:
        return client.post(
            "/api/mcp",
            data=json.dumps(payload),
            headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        )


def _rpc(method, request_id, params=None):
    body = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        body["params"] = params
    return body


def test_add_mcp_blocked_on_workspace_agent_surface_by_default(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    resp = _post(main, _rpc("tools/call", "c1", {
        "name": "connections.add_mcp",
        "arguments": {"label": "evil", "url": "https://attacker.example/mcp"},
    }))

    assert resp.status_code == 200
    result = resp.json()["result"]
    assert result["isError"] is True
    assert "not enabled" in result["content"][0]["text"]


def test_tools_list_excludes_gated_tools_by_default(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    resp = _post(main, _rpc("tools/list", "l1"))

    assert resp.status_code == 200
    names = {t["name"] for t in resp.json()["result"]["tools"]}
    assert "connections.add_mcp" not in names
    assert "workers.list" in names  # read tools still served


def test_admin_only_tool_still_works_for_operator_token(monkeypatch, tmp_path):
    """The static workspace-agent token is operator-level (admin context), so
    admin-only tools like secrets.set keep working through this surface."""
    main = _load_main(monkeypatch, tmp_path)

    resp = _post(main, _rpc("tools/call", "s1", {
        "name": "secrets.set",
        "arguments": {"key": "TEST_KEY", "value": "test-value"},
    }))

    assert resp.status_code == 200
    result = resp.json()["result"]
    assert result.get("isError") is not True, result


@pytest.mark.parametrize("bad_value", [12345, False, 0])
def test_secrets_set_rejects_non_string_values(monkeypatch, tmp_path, bad_value):
    main = _load_main(monkeypatch, tmp_path)

    resp = _post(main, _rpc("tools/call", "s2", {
        "name": "secrets.set",
        "arguments": {"key": "TEST_KEY", "value": bad_value},
    }))

    assert resp.status_code == 200
    body = resp.json()
    assert body["error"]["code"] == -32602
    assert body["error"]["message"] == "Invalid params: value must be a string"


def test_workspace_chat_tool_is_not_gated(monkeypatch, tmp_path):
    """The chat tool is this surface's primary purpose and is not in any
    gated set — tools/list must still advertise it."""
    main = _load_main(monkeypatch, tmp_path)

    resp = _post(main, _rpc("tools/list", "l2"))
    names = {t["name"] for t in resp.json()["result"]["tools"]}
    assert main._WORKSPACE_AGENT_MCP_TOOL_NAME in names
