"""#782 — per-user worker stars persist server-side and surface on the list."""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "star-secret-782"


def _yml(name: str) -> str:
    return f"""\
schema_version: "0.3"
name: "{name}"
title: "{name.title()}"
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
    for wid in ("alpha", "beta"):
        d = workers_dir / wid
        d.mkdir(parents=True)
        (d / "worker.yml").write_text(_yml(wid), encoding="utf-8")
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
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")
    from fastapi.testclient import TestClient
    yield TestClient(main.app, headers={"x-floom-secret": _SECRET})
    db.get_repositories.cache_clear()


def _starred(client) -> set[str]:
    resp = client.get("/workers?shape=list")
    assert resp.status_code == 200, resp.text
    return {w["id"] for w in resp.json() if w.get("starred")}


def test_star_unstar_round_trip(client):
    assert _starred(client) == set()

    assert client.post("/workers/alpha/star").status_code == 204
    assert _starred(client) == {"alpha"}

    # Idempotent re-star.
    assert client.post("/workers/alpha/star").status_code == 204
    assert _starred(client) == {"alpha"}

    assert client.delete("/workers/alpha/star").status_code == 204
    assert _starred(client) == set()
    # Idempotent un-star.
    assert client.delete("/workers/alpha/star").status_code == 204


def test_star_unknown_worker_404(client):
    assert client.post("/workers/ghost/star").status_code == 404
