"""#816 — GET /workers/{id}/bundle.zip downloads a worker as a skill bundle.

Import existed (POST /workers/from-bundle) but there was no export. This zips
the worker's on-disk files for download / re-import.

Run: cd apps/api && python -m pytest tests/test_worker_bundle_export.py -q
"""
from __future__ import annotations

import importlib
import io
import sys
import zipfile
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-bundle"

_YML = """\
schema_version: "0.3"
name: "exportable"
title: "Exportable Worker"
description: "can be downloaded"
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
    wdir = workers_dir / "exportable"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hello bundle')\n", encoding="utf-8")
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
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield c
    db.get_repositories.cache_clear()


def test_download_bundle_zip(client):
    resp = client.get("/workers/exportable/bundle.zip")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/zip"
    assert "attachment" in resp.headers["content-disposition"]
    assert "exportable.zip" in resp.headers["content-disposition"]
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    names = zf.namelist()
    assert "exportable/worker.yml" in names
    assert "exportable/run.py" in names
    assert b"hello bundle" in zf.read("exportable/run.py")


def test_download_unknown_worker_404(client):
    assert client.get("/workers/nope/bundle.zip").status_code == 404
