"""#806 — global ⌘K search across workers, runs, brain, connections.

Run: cd apps/api && python -m pytest tests/test_global_search.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-search"
OWNER = "federico"


def _yml(name: str, desc: str) -> str:
    return f"""\
schema_version: "0.3"
name: "{name}"
title: "{name}"
description: "{desc}"
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
    for n, d in [("invoice-bot", "reconciles invoices"), ("newsletter", "weekly digest")]:
        wdir = workers_dir / n
        wdir.mkdir(parents=True)
        (wdir / "worker.yml").write_text(_yml(n, d), encoding="utf-8")
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
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=OWNER)
    repos = main.get_repositories()
    now = main.now_iso()
    repos.connections.upsert(
        user_id=OWNER, id="conn-gmail", app_name="gmail",
        composio_connection_id="ca_g", status="active",
        account_label="me", created_at=now, updated_at=now,
    )
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    # seed a brain pack
    c.post("/contexts/research-notes", json={"writeable": True})
    yield c
    db.get_repositories.cache_clear()


def test_search_workers(client):
    resp = client.get("/search?q=invoice")
    assert resp.status_code == 200, resp.text
    items = resp.json()["results"]
    worker_ids = {i["id"] for i in items if i["type"] == "worker"}
    assert "invoice-bot" in worker_ids
    assert "newsletter" not in worker_ids


def test_search_connection(client):
    items = client.get("/search?q=gmail").json()["results"]
    assert any(i["type"] == "connection" and "gmail" in (i["subtitle"] or "") for i in items)


def test_search_brain(client):
    items = client.get("/search?q=research").json()["results"]
    assert any(i["type"] == "brain" and i["id"] == "research-notes" for i in items)


def test_search_types_filter(client):
    # only workers requested -> no connection results even if they match
    items = client.get("/search?q=gmail&types=workers").json()["results"]
    assert all(i["type"] == "worker" for i in items)


def test_search_empty_q_422(client):
    assert client.get("/search?q=").status_code == 422
