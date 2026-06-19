"""#767/#768 — specific-people share grants: add / list / revoke (owner-scoped)."""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "share-grants-767"


def _yml(name: str) -> str:
    return f"""\
schema_version: "0.3"
name: "{name}"
title: "Alpha"
description: "A worker."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "local"
  command: "python run.py"
inputs: []
outputs:
  - name: "summary"
    type: "markdown"
    required: true
connections: []
"""


@pytest.fixture
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    d = workers_dir / "alpha"
    d.mkdir(parents=True)
    (d / "worker.yml").write_text(_yml("alpha"), encoding="utf-8")
    (d / "run.py").write_text("print('x')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in ["db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                 "db.interface", "models", "worker_registry", "run_service", "scheduler", "main"]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="local-user")
    from fastapi.testclient import TestClient
    yield TestClient(main.app, headers={"x-floom-secret": _SECRET})
    db.get_repositories.cache_clear()


def _grant_body(email="alice@example.com"):
    return {"asset_type": "worker", "asset_id": "alpha", "email": email}


def test_add_list_revoke_grant(client):
    assert client.get("/share/grants?asset_type=worker&asset_id=alpha").json() == []

    created = client.post("/share/grants", json=_grant_body())
    assert created.status_code == 201, created.text
    gid = created.json()["id"]
    assert created.json()["email"] == "alice@example.com"

    listed = client.get("/share/grants?asset_type=worker&asset_id=alpha").json()
    assert [g["email"] for g in listed] == ["alice@example.com"]

    # Idempotent re-grant returns the same row.
    again = client.post("/share/grants", json=_grant_body())
    assert again.json()["id"] == gid

    assert client.delete(f"/share/grants/{gid}").status_code == 204
    assert client.get("/share/grants?asset_type=worker&asset_id=alpha").json() == []
    assert client.delete(f"/share/grants/{gid}").status_code == 404


def test_invalid_email_422(client):
    assert client.post("/share/grants", json=_grant_body("notanemail")).status_code == 422


def test_grant_unknown_worker_404(client):
    assert client.post("/share/grants", json={"asset_type": "worker", "asset_id": "ghost", "email": "a@b.com"}).status_code == 404
