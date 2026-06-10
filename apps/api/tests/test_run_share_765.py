"""#765 — run share link: create → public resolve (safe payload) → revoke (404)."""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "run-share-765"


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
def ctx(monkeypatch, tmp_path):
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
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")
        # Seed a completed run for the worker (run visibility derives from the
        # worker's owner, which the persist set to "federico").
        conn.execute(
            "INSERT INTO runs (id, worker_id, status, trigger_source, runner, created_at, output_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("run-1", "alpha", "completed", "manual", "local", main.now_iso(),
             '{"result": "Hello output"}'),
        )
    from fastapi.testclient import TestClient
    yield TestClient(main.app, headers={"x-floom-secret": _SECRET})
    db.get_repositories.cache_clear()


def test_run_share_create_resolve_revoke(ctx):
    client = ctx
    created = client.post("/runs/run-1/share-link")
    assert created.status_code == 200, created.text
    token = created.json()["token"]

    pub = client.get(f"/s/{token}")
    assert pub.status_code == 200, pub.text
    body = pub.json()
    assert body["entity_type"] == "run"
    assert body["run"]["result"] == "Hello output"
    assert body["run"]["worker_name"] == "Alpha"
    assert body["run"]["status"] == "completed"

    assert client.delete("/runs/run-1/share-link").status_code == 204
    assert client.get(f"/s/{token}").status_code == 404


def test_run_share_unknown_run_404(ctx):
    assert ctx.post("/runs/ghost/share-link").status_code == 404
