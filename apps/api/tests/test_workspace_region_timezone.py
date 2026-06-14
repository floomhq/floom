"""#791 — PATCH /workspaces/{id} sets name/region/timezone.

Adds region + timezone columns (migration 71) and extends PATCH to update
any subset (name optional).

Run: cd apps/api && python -m pytest tests/test_workspace_region_timezone.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-wsregion"
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
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth.") or name.startswith("routers"):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield c
    db.get_repositories.cache_clear()


def _new_ws(client) -> str:
    return client.post("/workspaces", json={"name": "Side"}).json()["id"]


def test_default_region_timezone_null(client):
    ws = client.get("/workspaces").json()["workspaces"][0]
    assert ws["region"] is None
    assert ws["timezone"] is None


def test_patch_region_and_timezone(client):
    ws_id = _new_ws(client)
    resp = client.patch(f"/workspaces/{ws_id}", json={"region": "EU Frankfurt", "timezone": "Europe/Berlin"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["region"] == "EU Frankfurt"
    assert resp.json()["timezone"] == "Europe/Berlin"
    # persisted
    again = next(w for w in client.get("/workspaces").json()["workspaces"] if w["id"] == ws_id)
    assert again["region"] == "EU Frankfurt"
    assert again["timezone"] == "Europe/Berlin"


def test_patch_name_only_keeps_region(client):
    ws_id = _new_ws(client)
    client.patch(f"/workspaces/{ws_id}", json={"region": "US East"})
    resp = client.patch(f"/workspaces/{ws_id}", json={"name": "Renamed"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Renamed"
    assert resp.json()["region"] == "US East"  # unchanged


def test_patch_empty_payload_422(client):
    ws_id = _new_ws(client)
    assert client.patch(f"/workspaces/{ws_id}", json={}).status_code == 422


def test_patch_unknown_workspace_404(client):
    assert client.patch("/workspaces/ws_unknownunknow", json={"region": "X"}).status_code == 404
