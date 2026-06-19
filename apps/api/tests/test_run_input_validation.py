from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _worker_yml(*, worker_id: str, inputs: str) -> str:
    return f"""\
schema_version: "0.3"
name: "{worker_id}"
title: "{worker_id.replace('-', ' ').title()}"
description: "Test worker for input validation."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  inputs:
{inputs}
  outputs:
    - name: "summary"
      kind: "file"
      media_type: "text/markdown"
      path: "out/summary.md"
      required: true
      label: "Summary"
connections: []
"""


def _load_app(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    scalar_inputs = """\
    - name: "topic"
      label: "Topic"
      type: "string"
      required: true
"""
    file_inputs = """\
    - name: "source_file"
      label: "Source File"
      type: "file"
      required: true
      accepts:
        - "text/plain"
"""
    (workers_dir / "required-topic").mkdir()
    (workers_dir / "required-topic" / "worker.yml").write_text(
        _worker_yml(worker_id="required-topic", inputs=scalar_inputs),
        encoding="utf-8",
    )
    (workers_dir / "required-file").mkdir()
    (workers_dir / "required-file" / "worker.yml").write_text(
        _worker_yml(worker_id="required-file", inputs=file_inputs),
        encoding="utf-8",
    )

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-inputs")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))

    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "worker_registry",
        "runner_utils",
        "run_service",
        "main",
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

    client = TestClient(main.app, raise_server_exceptions=False)
    return client, main, db


def test_run_creation_rejects_missing_required_inputs(monkeypatch, tmp_path):
    client, main, db = _load_app(monkeypatch, tmp_path)

    with main.get_db() as conn:
        before = conn.execute(
            "SELECT COUNT(*) AS total FROM runs WHERE worker_id = ?",
            ("required-topic",),
        ).fetchone()["total"]

    resp = client.post(
        "/workers/required-topic/runs",
        json={"inputs": {}},
        headers={"x-floom-secret": "test-secret-inputs"},
    )

    with main.get_db() as conn:
        after = conn.execute(
            "SELECT COUNT(*) AS total FROM runs WHERE worker_id = ?",
            ("required-topic",),
        ).fetchone()["total"]

    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Missing required inputs: topic"
    assert before == after == 0
    db.get_repositories.cache_clear()


def test_run_creation_rejects_invalid_file_input_sha(monkeypatch, tmp_path):
    client, main, db = _load_app(monkeypatch, tmp_path)

    with main.get_db() as conn:
        before = conn.execute(
            "SELECT COUNT(*) AS total FROM runs WHERE worker_id = ?",
            ("required-file",),
        ).fetchone()["total"]

    resp = client.post(
        "/workers/required-file/runs",
        json={"inputs": {"source_file": "not-a-sha256-reference"}},
        headers={"x-floom-secret": "test-secret-inputs"},
    )

    with main.get_db() as conn:
        after = conn.execute(
            "SELECT COUNT(*) AS total FROM runs WHERE worker_id = ?",
            ("required-file",),
        ).fetchone()["total"]

    assert resp.status_code == 400, resp.text
    assert "SHA-256 reference" in resp.json()["detail"]
    assert before == after == 0
    db.get_repositories.cache_clear()
