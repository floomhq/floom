"""#796 — POST /runs/export bundles multiple runs into one ZIP."""
from __future__ import annotations

import importlib
import io
import sys
import types
import zipfile
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "bulk-export-796"


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
        for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
            sys.modules.pop(_rn, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")
        for rid, res in (("run-1", "first"), ("run-2", "second")):
            conn.execute(
                "INSERT INTO runs (id, worker_id, status, trigger_source, runner, created_at, output_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (rid, "alpha", "completed", "manual", "local", main.now_iso(), f'{{"result": "{res}"}}'),
            )
    from fastapi.testclient import TestClient
    yield TestClient(main.app, headers={"x-floom-secret": _SECRET})
    db.get_repositories.cache_clear()


def test_bulk_export_zips_each_run(client):
    resp = client.post("/runs/export", json={"run_ids": ["run-1", "run-2"]})
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    names = zf.namelist()
    assert "run-run-1/metadata.json" in names
    assert "run-run-2/metadata.json" in names
    assert "run-run-1/outputs.json" in names
    # Output payload carried over.
    assert "first" in zf.read("run-run-1/outputs.json").decode()


def test_bulk_export_unknown_runs_404(client):
    assert client.post("/runs/export", json={"run_ids": ["ghost"]}).status_code == 404


def test_bulk_export_empty_list_422(client):
    assert client.post("/runs/export", json={"run_ids": []}).status_code == 422
