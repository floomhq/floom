"""#773 — per-user appearance settings (GET/PUT /user/settings).

Theme/accent are per-user prefs with no backend (only localStorage). Adds a
user_settings table + GET/PUT scoped to the authenticated user.

Run: cd apps/api && python -m pytest tests/test_user_settings.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-usersettings"


@pytest.fixture
def client(monkeypatch, tmp_path):
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
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield c
    db.get_repositories.cache_clear()


def test_default_settings_when_unset(client):
    resp = client.get("/user/settings")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"theme": "system", "accent": None}


def test_put_then_get_roundtrip(client):
    put = client.put("/user/settings", json={"theme": "dark", "accent": "#7C3AED"})
    assert put.status_code == 200, put.text
    assert put.json() == {"theme": "dark", "accent": "#7C3AED"}
    got = client.get("/user/settings")
    assert got.json() == {"theme": "dark", "accent": "#7C3AED"}


def test_partial_update_keeps_other_field(client):
    client.put("/user/settings", json={"theme": "dark", "accent": "#111"})
    # update only theme -> accent preserved
    resp = client.put("/user/settings", json={"theme": "day"})
    assert resp.json() == {"theme": "day", "accent": "#111"}


def test_invalid_theme_rejected(client):
    assert client.put("/user/settings", json={"theme": "neon"}).status_code == 422


def test_unknown_field_rejected(client):
    assert client.put("/user/settings", json={"font_size": 14}).status_code == 422
