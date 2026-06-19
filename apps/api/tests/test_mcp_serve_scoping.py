"""#833 — the MCP serve surface must not be an unscoped admin proxy.

RCA: /mcp-tools/serve exposed all default tools to any authenticated caller
with no per-tool permission check — a single leaked secret or member PAT
yielded workspace-destruction capability (workers.delete, secrets.set,
contexts.delete, workspace.instructions.set, ...).

Fix (enforced identically in tools/list and tools/call):
1. Destructive tools (_MCP_ADMIN_ONLY_TOOLS) require auth.is_admin.
2. WORKEROS_MCP_ENABLED_TOOLS (comma-separated) optionally restricts which
   default tools are served at all.
3. Every tools/call is audit-logged with tool, user, and role.

Run:
    cd apps/api && python -m pytest tests/test_mcp_serve_scoping.py -v
"""
from __future__ import annotations

import asyncio
import importlib
import logging
import sys
from pathlib import Path
from types import SimpleNamespace

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.delenv("WORKEROS_MCP_ENABLED_TOOLS", raising=False)
    monkeypatch.delenv("WORKEROS_MCP_ENABLE_DESTRUCTIVE", raising=False)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth.") or name.startswith("routers"):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _member(main):
    from auth.context import AuthContext

    return AuthContext(user_id="m-1", role="member", auth_method="pat")


def _admin(main):
    from auth.context import AuthContext

    return AuthContext(user_id="a-1", role="admin", auth_method="secret", scopes=("admin",))


def _repos():
    return SimpleNamespace(
        mcp_tools=SimpleNamespace(list=lambda *, user_id: [], get_by_name=lambda *, user_id, name: None),
    )


def _fake_request(main):
    from starlette.requests import Request

    return Request({"type": "http", "method": "POST", "path": "/mcp-tools/serve", "query_string": b"", "headers": []})


def _call(main, auth, tool, arguments=None):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool, "arguments": arguments or {}}}
    return asyncio.run(main._mcp_handle_request(body, auth, _repos(), _fake_request(main)))


def _list_tools(main, auth):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    out = asyncio.run(main._mcp_handle_request(body, auth, _repos(), _fake_request(main)))
    return {t["name"] for t in out["result"]["tools"]}


def test_member_cannot_call_destructive_tools(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    for tool in ("workers.delete", "secrets.set", "contexts.delete", "workspace.instructions.set"):
        out = _call(main, _member(main), tool, {"id": "x", "key": "K", "value": "v", "name": "n", "content": "c"})
        assert out["result"]["isError"] is True, tool
        assert "requires admin" in out["result"]["content"][0]["text"], tool


def test_admin_passes_the_gate(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    async def _fake_api_call(method, path, request, **kwargs):
        return {"ok": True}, 200

    monkeypatch.setattr(main, "_api_call", _fake_api_call)
    out = _call(main, _admin(main), "workers.delete", {"id": "w-1"})
    assert out["result"]["isError"] is False


def test_tools_list_hides_admin_tools_from_members(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    member_tools = _list_tools(main, _member(main))
    admin_tools = _list_tools(main, _admin(main))

    assert "workers.delete" not in member_tools
    assert "workers.delete" in admin_tools
    assert "workers.list" in member_tools  # read tools stay visible


def test_enabled_tools_allowlist_restricts_serving(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    monkeypatch.setenv("WORKEROS_MCP_ENABLED_TOOLS", "workers.list, runs.get")

    tools = _list_tools(main, _admin(main))
    assert tools == {"workers.list", "runs.get"}

    out = _call(main, _admin(main), "workers.get", {"id": "w-1"})
    assert out["result"]["isError"] is True
    assert "not enabled" in out["result"]["content"][0]["text"]


def test_tools_call_is_audit_logged(monkeypatch, tmp_path, caplog):
    main = _load_main(monkeypatch, tmp_path)

    async def _fake_api_call(method, path, request, **kwargs):
        return {"ok": True}, 200

    monkeypatch.setattr(main, "_api_call", _fake_api_call)
    with caplog.at_level(logging.INFO):
        _call(main, _admin(main), "workers.list")

    audit = [r.getMessage() for r in caplog.records if "mcp tools/call" in r.getMessage()]
    assert audit, "no audit log emitted"
    assert "workers.list" in audit[0]
    assert "a-1" in audit[0]
