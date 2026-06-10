"""#785 — PATCH worker title/description edits worker.yml + DB; id is unchanged."""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "rename-secret-785"


def _yml(name: str) -> str:
    return f"""\
schema_version: "0.3"
name: "{name}"
title: "Old Title"
description: "Old description."
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
    from fastapi.testclient import TestClient
    yield TestClient(main.app, headers={"x-floom-secret": _SECRET}), d / "worker.yml"
    db.get_repositories.cache_clear()


def test_rename_title_and_description(ctx):
    client, yml_path = ctx
    before = client.get("/workers/alpha")
    assert before.status_code == 200, before.text
    assert before.json()["name"] == "Old Title"

    patched = client.patch("/workers/alpha", json={"title": "New Title", "description": "Fresh desc."})
    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["id"] == "alpha"  # identity unchanged
    assert body["name"] == "New Title"
    assert body["description"] == "Fresh desc."

    # Persisted to worker.yml.
    text = yml_path.read_text()
    assert 'title: "New Title"' in text
    assert 'description: "Fresh desc."' in text

    # Reflected on re-fetch.
    assert client.get("/workers/alpha").json()["name"] == "New Title"
