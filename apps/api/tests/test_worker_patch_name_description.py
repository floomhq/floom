"""#785 — PATCH /workers/{id} accepts name and description.

Previously WorkerUpdateRequest only accepted trigger/cron/input fields;
changing name or description required a full PUT /workers/{id} YAML rewrite.
This adds name (DB column) and description (manifest) to the PATCH path,
persisted back to worker.yml so they survive a registry reload.

Run: cd apps/api && python -m pytest tests/test_worker_patch_name_description.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-patchnd"

_YML = """\
schema_version: "0.3"
name: "old-name"
title: "Old Title"
description: "old description"
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
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "patch-nd-worker"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
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
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="local-user")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": SECRET})
    yield client, main, wdir
    db.get_repositories.cache_clear()


def test_patch_name_and_description(client_and_main):
    client, main, wdir = client_and_main
    resp = client.patch(
        "/workers/patch-nd-worker",
        json={"name": "new-name", "description": "a much better description"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "new-name"
    assert body["description"] == "a much better description"

    # persisted to worker.yml
    yml = (wdir / "worker.yml").read_text(encoding="utf-8")
    assert 'name: "new-name"' in yml
    assert 'description: "a much better description"' in yml

    # survives a fresh detail fetch
    again = client.get("/workers/patch-nd-worker")
    assert again.json()["name"] == "new-name"
    assert again.json()["description"] == "a much better description"


def test_patch_empty_name_rejected(client_and_main):
    client, _, _ = client_and_main
    resp = client.patch("/workers/patch-nd-worker", json={"name": "   "})
    assert resp.status_code == 422


def test_patch_description_only_keeps_name(client_and_main):
    client, _, _ = client_and_main
    original_name = client.get("/workers/patch-nd-worker").json()["name"]
    resp = client.patch("/workers/patch-nd-worker", json={"description": "only desc changed"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == original_name  # unchanged
    assert resp.json()["description"] == "only desc changed"
