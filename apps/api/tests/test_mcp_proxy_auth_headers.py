"""#851 — the internal MCP proxy must forward the x-api-key header.

RCA: ``_api_call`` forwarded auth headers from an inline allow-list that did
not include ``x-api-key``, so any internal path authenticating via x-api-key
saw proxied requests as unauthenticated.

Fix: the allow-list is hoisted to ``_API_CALL_AUTH_HEADERS`` (module constant,
testable) and includes ``x-api-key``.

Run:
    cd apps/api && python -m pytest tests/test_mcp_proxy_auth_headers.py -v
"""
from __future__ import annotations

import asyncio
import importlib
import sys
from pathlib import Path

# module level so FastAPI can resolve the postponed "Request" annotation of
# the test-local echo handler (this file uses `from __future__ import annotations`)
from starlette.requests import Request

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def test_x_api_key_in_forwarded_header_allowlist(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert "x-api-key" in main._API_CALL_AUTH_HEADERS


def test_api_call_forwards_x_api_key_end_to_end(monkeypatch, tmp_path):
    """_api_call proxies a request carrying x-api-key; the in-process echo
    endpoint must receive the header."""
    main = _load_main(monkeypatch, tmp_path)

    seen: dict[str, str | None] = {}

    @main.app.get("/__test_echo_api_key")
    def _echo(request: Request):
        seen["x-api-key"] = request.headers.get("x-api-key")
        seen["x-unrelated"] = request.headers.get("x-unrelated")
        return {"ok": True}

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/mcp-tools/serve",
        "query_string": b"",
        "headers": [
            (b"x-api-key", b"key-123"),
            (b"x-unrelated", b"nope"),
        ],
    }
    outer = Request(scope)

    data, status = asyncio.run(main._api_call("GET", "/__test_echo_api_key", outer))

    assert status == 200, str(data)
    assert seen["x-api-key"] == "key-123"
    # non-auth headers must NOT be forwarded
    assert seen["x-unrelated"] is None
