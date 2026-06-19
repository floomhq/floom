"""#768 — people-with-access listing per asset (owner + workspace + grants).

GET /workers/{id}/access and GET /contexts/{name}/access return who can
access the asset and why (source: owner|workspace|grant).

Run: cd apps/api && python -m pytest tests/test_asset_access_listing_768.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-access768"
OWNER = "local-user"

_YML = """\
schema_version: "0.3"
name: "shared-w"
title: "Shared Worker"
description: "d"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections: []
"""


@pytest.fixture
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "shared-w"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main", "contexts",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=OWNER)
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield c
    db.get_repositories.cache_clear()


def test_worker_access_includes_owner(client):
    resp = client.get("/workers/shared-w/access")
    assert resp.status_code == 200, resp.text
    entries = resp.json()
    owners = [e for e in entries if e["source"] == "owner"]
    assert len(owners) == 1
    assert owners[0]["role"] == "owner"


def test_worker_access_includes_grant(client):
    # grant a person, then they appear with source=grant
    g = client.post("/share/grants", json={"asset_type": "worker", "asset_id": "shared-w", "email": "alice@example.com"})
    assert g.status_code == 201, g.text
    entries = client.get("/workers/shared-w/access").json()
    grants = [e for e in entries if e["source"] == "grant"]
    assert any(e["email"] == "alice@example.com" and e["role"] == "viewer" for e in grants)


def test_worker_access_unknown_404(client):
    assert client.get("/workers/nope/access").status_code == 404


def test_context_access_includes_owner_and_grant(client):
    client.post("/contexts/facts", json={"writeable": True})
    client.post("/share/grants", json={"asset_type": "brain_pack", "asset_id": "facts", "email": "bob@example.com"})
    entries = client.get("/contexts/facts/access").json()
    assert any(e["source"] == "owner" for e in entries)
    assert any(e["source"] == "grant" and e["email"] == "bob@example.com" for e in entries)
