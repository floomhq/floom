from __future__ import annotations

import importlib
import io
import json
import sys
import time
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


OWNER = "local-user"
SECRET = "test-drop-secret"

_YML = """\
schema_version: "0.3"
name: "drop-worker"
title: "Drop Worker"
description: "processes one uploaded file"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
inputs:
  - name: source_file
    type: file
    label: Source file
outputs: []
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "drop-worker"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("def run(inputs, context):\n    return inputs\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_DROP_LINK_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "workeros.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "workeros.db"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "files", "models", "worker_registry", "runner_utils",
        "run_service", "main", "routers.drop", "services.uploads",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=OWNER)

    from fastapi.testclient import TestClient

    client = TestClient(main.app, raise_server_exceptions=False)
    yield client, main
    db.get_repositories.cache_clear()


def test_public_drop_upload_stores_blob_and_queues_owner_run(client_and_main):
    client, main = client_and_main
    from routers.drop import make_drop_upload_token

    token = make_drop_upload_token(
        drop_id="drop_1",
        owner_id=OWNER,
        worker_id="drop-worker",
        input_name="source_file",
        expires_at=int(time.time()) + 300,
        accepts="text/plain",
        max_size_mb=1,
    )

    response = client.post(
        f"/drop/public/drop_1/uploads?token={token}",
        files={"file": ("lead.txt", io.BytesIO(b"hello"), "text/plain")},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["worker_id"] == "drop-worker"
    assert body["input_name"] == "source_file"
    assert body["sha256"]
    row = main.get_repositories().runs.get(user_id=OWNER, run_id=body["run_id"])
    assert row is not None
    assert row["trigger_source"] == "drop"
    inputs = row["input_json"]
    if isinstance(inputs, str):
        inputs = json.loads(inputs)
    assert inputs["source_file"] == body["sha256"]


def test_public_drop_upload_rejects_bad_token(client_and_main):
    client, _main = client_and_main

    response = client.post(
        "/drop/public/drop_1/uploads?token=not-a-valid-token",
        files={"file": ("lead.txt", io.BytesIO(b"hello"), "text/plain")},
    )

    assert response.status_code == 404
