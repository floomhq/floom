"""#789 — GET /connections/{id}/tools returns the live MCP tool list.

test_connection already dials the server and returns tools; this adds the
dedicated GET endpoint the UI needs (503 when unreachable).

Run: cd apps/api && python -m pytest tests/test_connection_tools_endpoint.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-conntools"


@pytest.fixture
def main_mod(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _client(main):
    from fastapi.testclient import TestClient
    return TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)


def test_returns_live_tools(main_mod, monkeypatch):
    main = main_mod

    def _fake_test(connection_id, auth=None, repos=None):
        return main.ConnectionTestResult(
            status="valid", reason="ok", tested_at="2026-06-11T00:00:00Z",
            tools=["search_web", "fetch_url", "summarize"],
        )

    import routers.connections as _conn
    monkeypatch.setattr(_conn, "test_connection", _fake_test)
    with _client(main) as c:
        resp = c.get("/connections/conn-1/tools")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"tools": ["search_web", "fetch_url", "summarize"]}


def test_unreachable_server_503(main_mod, monkeypatch):
    main = main_mod

    def _fake_test(connection_id, auth=None, repos=None):
        return main.ConnectionTestResult(
            status="failed", reason="Could not reach MCP server", tested_at="2026-06-11T00:00:00Z",
        )

    import routers.connections as _conn
    monkeypatch.setattr(_conn, "test_connection", _fake_test)
    with _client(main) as c:
        resp = c.get("/connections/conn-1/tools")
    assert resp.status_code == 503
