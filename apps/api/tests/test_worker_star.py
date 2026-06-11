"""#782 — worker star/favorite flag + toggle endpoint + ?starred= filter.

WorkerSummary/Detail had no starred field and there was no toggle. Adds a
per-user user_worker_prefs table (migration 67), POST /workers/{id}/star
(toggle), GET /workers?starred=true filter, and starred on the list summary.

Run: cd apps/api && python -m pytest tests/test_worker_star.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-star"


def _yml(name: str) -> str:
    return f"""\
schema_version: "0.3"
name: "{name}"
title: "{name}"
description: "a worker"
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
    for n in ("alpha", "beta"):
        wdir = workers_dir / n
        wdir.mkdir(parents=True)
        (wdir / "worker.yml").write_text(_yml(n), encoding="utf-8")
        (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield c
    db.get_repositories.cache_clear()


def _by_id(resp):
    return {w["id"]: w for w in resp.json()}


def test_toggle_star_on_and_off(client):
    on = client.post("/workers/alpha/star")
    assert on.status_code == 200, on.text
    assert on.json()["starred"] is True
    # reflected in list
    assert _by_id(client.get("/workers"))["alpha"]["starred"] is True
    assert _by_id(client.get("/workers"))["beta"]["starred"] is False
    # toggle off
    off = client.post("/workers/alpha/star")
    assert off.json()["starred"] is False
    assert _by_id(client.get("/workers"))["alpha"]["starred"] is False


def test_starred_filter(client):
    client.post("/workers/beta/star")
    ids = {w["id"] for w in client.get("/workers?starred=true").json()}
    assert ids == {"beta"}


def test_star_unknown_worker_404(client):
    assert client.post("/workers/nope/star").status_code == 404
