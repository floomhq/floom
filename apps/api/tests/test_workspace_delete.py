"""#805 — DELETE /workspaces/{id} (Settings > Danger).

Local OSS workspaces could be created/listed/duplicated but not deleted.
Adds an owner-scoped delete; the default workspace is protected (409).

Run: cd apps/api && python -m pytest tests/test_workspace_delete.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-wsdelete"
OWNER = "federico"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield c, main
    db.get_repositories.cache_clear()


def test_create_then_delete_workspace(client):
    c, _ = client
    created = c.post("/workspaces", json={"name": "Scratch"})
    assert created.status_code == 200, created.text
    ws_id = created.json()["id"]

    listed_before = {w["id"] for w in c.get("/workspaces").json()["workspaces"]}
    assert ws_id in listed_before

    deleted = c.delete(f"/workspaces/{ws_id}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["deleted"] is True

    listed_after = {w["id"] for w in c.get("/workspaces").json()["workspaces"]}
    assert ws_id not in listed_after


def test_delete_default_workspace_blocked(client):
    c, main = client
    resp = c.delete(f"/workspaces/{main.DEFAULT_WORKSPACE_ID}")
    assert resp.status_code == 409


def test_delete_unknown_workspace_404(client):
    c, _ = client
    assert c.delete("/workspaces/ws_doesnotexist").status_code == 404
