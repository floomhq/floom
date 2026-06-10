"""#836 — _api_call must not forward raw internal error text to MCP clients.

RCA: when the in-process proxied request returned a non-JSON body (HTML error
page, WSGI stack trace, proxy timeout page), ``_api_call`` fell back to
``{"detail": resp.text}`` — forwarding the raw body verbatim to external MCP
clients (information disclosure: paths, versions, stack frames).

Fix: response parsing moved to ``_api_call_response_data``; the non-JSON
fallback now returns a generic ``{"detail": "Internal server error"}`` and
logs the raw body server-side.

Run:
    cd apps/api && python -m pytest tests/test_mcp_proxy_error_disclosure.py -v
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

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


class _FakeResponse:
    def __init__(self, *, json_body=None, text="", status_code=200):
        self._json_body = json_body
        self.text = text
        self.status_code = status_code

    def json(self):
        if self._json_body is None:
            raise ValueError("not json")
        return self._json_body


def test_non_json_body_returns_generic_detail(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    leaked = 'Traceback (most recent call last):\n  File "/srv/app/main.py", line 42'

    data = main._api_call_response_data(_FakeResponse(text=leaked, status_code=500))

    assert data == {"detail": "Internal server error"}
    assert leaked not in str(data)


def test_json_body_passes_through(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    data = main._api_call_response_data(_FakeResponse(json_body={"ok": True}))

    assert data == {"ok": True}


def test_raw_body_is_logged_server_side(monkeypatch, tmp_path, caplog):
    main = _load_main(monkeypatch, tmp_path)

    import logging

    with caplog.at_level(logging.WARNING):
        main._api_call_response_data(_FakeResponse(text="<html>secret-path</html>", status_code=502))

    assert any("secret-path" in r.getMessage() for r in caplog.records)
