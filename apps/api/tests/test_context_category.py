"""#780 — brain folder content-category tags (marketing/accounting/...).

Adds an optional category to context pack metadata: set at create, surfaced
on the context detail/summary, and settable/clearable via
PUT /contexts/{name}/category. File-based metadata (no migration).

Run: cd apps/api && python -m pytest tests/test_context_category.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-ctxcat"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    for name in list(sys.modules):
        if name in ("main", "db", "contexts") or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield c
    db.get_repositories.cache_clear()


def test_create_with_category(client):
    resp = client.post("/contexts/marketing-pack", json={"writeable": True, "category": "marketing"})
    assert resp.status_code in (200, 201), resp.text
    assert resp.json()["category"] == "marketing"
    # surfaced on a fresh GET
    assert client.get("/contexts/marketing-pack").json()["category"] == "marketing"


def test_default_category_is_null(client):
    client.post("/contexts/plain-pack", json={"writeable": True})
    assert client.get("/contexts/plain-pack").json()["category"] is None


def test_set_and_clear_category(client):
    client.post("/contexts/research-pack", json={"writeable": True})
    set_resp = client.put("/contexts/research-pack/category", json={"category": "research"})
    assert set_resp.status_code == 200, set_resp.text
    assert set_resp.json()["category"] == "research"

    # clear it
    cleared = client.put("/contexts/research-pack/category", json={"category": ""})
    assert cleared.json()["category"] is None


def test_category_in_list(client):
    client.post("/contexts/acct-pack", json={"writeable": True, "category": "accounting"})
    listing = client.get("/contexts").json()
    acct = next((c for c in listing if c["name"] == "acct-pack"), None)
    assert acct is not None
    assert acct["category"] == "accounting"
