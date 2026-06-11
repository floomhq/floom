"""#799 + #801 — channel connection-status endpoints for Settings > Channels.

#799 GET /channels/email   → { connected, email? } (derived from auth.email)
#801 GET /whatsapp/status  → { connected, wa_id?, status? } (from bindings)

Run: cd apps/api && python -m pytest tests/test_channel_status_endpoints.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-channels"


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth.") or name.startswith("channels"):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _client(main):
    from fastapi.testclient import TestClient
    return TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)


def test_whatsapp_status_not_connected(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as c:
        resp = c.get("/whatsapp/status")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"connected": False}


def test_whatsapp_status_active_binding(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    # the shared-secret context resolves to the WORKEROS_USER_ID default
    user_id = (__import__("os").environ.get("WORKEROS_USER_ID") or "federico")
    with main.get_db() as conn:
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, created_at, updated_at)
            VALUES (?, ?, ?, 'active', ?, ?)
            """,
            ("15551239709", user_id, "Tester", main.now_iso(), main.now_iso()),
        )
    with _client(main) as c:
        resp = c.get("/whatsapp/status")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["connected"] is True
    assert body["status"] == "active"
    assert body["wa_id"].endswith("9709")
    assert body["wa_id"].startswith("*")  # masked


def test_email_channel_connected_when_email_present(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    from auth.context import AuthContext
    out = main.channels_email_status(auth=AuthContext(user_id="u-1", email="ops@example.com", role="admin"))
    assert out == {"connected": True, "email": "ops@example.com"}


def test_email_channel_not_connected_without_email(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    from auth.context import AuthContext
    out = main.channels_email_status(auth=AuthContext(user_id="u-1", email=None, role="admin"))
    assert out == {"connected": False, "email": None}
