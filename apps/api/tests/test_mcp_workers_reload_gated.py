"""#840 — workers.reload must not be remotely callable via MCP by default.

RCA: ``workers.reload`` sat in the default MCP tool list. It reloads ALL
workers from disk with no confirmation — one accidental or malicious remote
call interrupts every worker on an OSS self-hosted instance.

Fix: the tool joins ``_MCP_OFF_BY_DEFAULT_TOOLS`` — hidden from tools/list
and rejected in tools/call unless the operator sets
``WORKEROS_MCP_ENABLE_DESTRUCTIVE=1`` (and it stays admin-only via #833).
The REST endpoint and local CLI flows are unaffected.

Run:
    cd apps/api && python -m pytest tests/test_mcp_workers_reload_gated.py -v
"""
from __future__ import annotations

import asyncio
import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

TOOL = "workers.reload"


def _load_main(monkeypatch, tmp_path, *, enable_destructive: bool = False):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.delenv("WORKEROS_MCP_ENABLED_TOOLS", raising=False)
    if enable_destructive:
        monkeypatch.setenv("WORKEROS_MCP_ENABLE_DESTRUCTIVE", "1")
    else:
        monkeypatch.delenv("WORKEROS_MCP_ENABLE_DESTRUCTIVE", raising=False)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth.") or name.startswith("routers"):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _admin(main):
    from auth.context import AuthContext

    return AuthContext(user_id="a-1", role="admin", auth_method="secret", scopes=("admin",))


def _member(main):
    from auth.context import AuthContext

    return AuthContext(user_id="m-1", role="member", auth_method="pat")


def _repos():
    return SimpleNamespace(
        mcp_tools=SimpleNamespace(list=lambda *, user_id: [], get_by_name=lambda *, user_id, name: None),
    )


def _fake_request():
    from starlette.requests import Request

    return Request({"type": "http", "method": "POST", "path": "/mcp-tools/serve", "query_string": b"", "headers": []})


def _call(main, auth):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": TOOL, "arguments": {}}}
    return asyncio.run(main._mcp_handle_request(body, auth, _repos(), _fake_request()))


def _tool_names(main, auth):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    out = asyncio.run(main._mcp_handle_request(body, auth, _repos(), _fake_request()))
    return {t["name"] for t in out["result"]["tools"]}


def test_reload_rejected_by_default_even_for_admin(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    out = _call(main, _admin(main))

    assert out["result"]["isError"] is True
    assert "not enabled" in out["result"]["content"][0]["text"]


def test_reload_hidden_from_tools_list_by_default(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert TOOL not in _tool_names(main, _admin(main))


def test_opt_in_is_still_admin_only(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path, enable_destructive=True)

    # member: still blocked by the #833 admin gate
    out = _call(main, _member(main))
    assert out["result"]["isError"] is True
    assert "requires admin" in out["result"]["content"][0]["text"]

    # admin with opt-in: passes the gate
    async def _fake_api_call(method, path, request, **kwargs):
        return {"ok": True}, 200

    monkeypatch.setattr(main, "_api_call", _fake_api_call)
    out = _call(main, _admin(main))
    assert out["result"]["isError"] is False
