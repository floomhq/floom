"""Regression tests for issue #1825: grouped multi-file episode ingest.

Several clips dropped together in one request (or any drop tagged with a
``group_id``) must become a SINGLE run whose worker file input carries the
ordered set of files. Single files stay one run each. Also covers the
list-aware file-input staging and the E2B upload remap planner.
"""

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
name: "episode-worker"
title: "Episode Worker"
description: "processes one or more uploaded clips as an episode"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
inputs:
  - name: clips
    type: file
    label: Clips
outputs: []
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "episode-worker"
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
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
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


def _token(main):
    from routers.drop import make_drop_upload_token

    return make_drop_upload_token(
        drop_id="drop_ep",
        owner_id=OWNER,
        worker_id="episode-worker",
        input_name="clips",
        expires_at=int(time.time()) + 300,
        accepts="text/plain",
        max_size_mb=1,
    )


def _run_inputs(main, run_id):
    row = main.get_repositories().runs.get(user_id=OWNER, run_id=run_id)
    assert row is not None
    inputs = row["input_json"]
    return json.loads(inputs) if isinstance(inputs, str) else inputs


def test_batch_drop_groups_clips_into_single_ordered_run(client_and_main):
    client, main = client_and_main
    token = _token(main)

    response = client.post(
        f"/drop/public/drop_ep/uploads?token={token}",
        files=[
            ("file", ("a.txt", io.BytesIO(b"clip-one"), "text/plain")),
            ("file", ("b.txt", io.BytesIO(b"clip-two"), "text/plain")),
            ("file", ("c.txt", io.BytesIO(b"clip-three"), "text/plain")),
        ],
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["grouped"] is True
    assert body["file_count"] == 3
    assert len(body["files"]) == 3
    # Top-level fields keep the first file for single-file client back-compat.
    assert body["sha256"] == body["files"][0]["sha256"]

    staged = _run_inputs(main, body["run_id"])["clips"]
    assert isinstance(staged, list)
    assert len(staged) == 3
    # The worker receives the files in upload order.
    contents = [Path(p).read_bytes() for p in staged]
    assert contents == [b"clip-one", b"clip-two", b"clip-three"]
    # Ordinal-prefixed names in a per-input subdir keep ordering deterministic.
    assert [Path(p).name for p in staged] == ["000_clips.txt", "001_clips.txt", "002_clips.txt"]


def test_single_file_with_group_id_is_grouped_as_list(client_and_main):
    client, main = client_and_main
    token = _token(main)

    response = client.post(
        f"/drop/public/drop_ep/uploads?token={token}",
        files={"file": ("solo.txt", io.BytesIO(b"only-clip"), "text/plain")},
        data={"group_id": "episode-42"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["grouped"] is True
    assert body["group_id"] == "episode-42"
    assert body["file_count"] == 1

    staged = _run_inputs(main, body["run_id"])["clips"]
    assert isinstance(staged, list)
    assert len(staged) == 1
    assert Path(staged[0]).read_bytes() == b"only-clip"


def test_single_file_without_group_is_one_run_not_grouped(client_and_main):
    client, main = client_and_main
    token = _token(main)

    response = client.post(
        f"/drop/public/drop_ep/uploads?token={token}",
        files={"file": ("solo.txt", io.BytesIO(b"only-clip"), "text/plain")},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["grouped"] is False
    assert body["file_count"] == 1

    staged = _run_inputs(main, body["run_id"])["clips"]
    assert isinstance(staged, str)
    assert Path(staged).read_bytes() == b"only-clip"


def test_resolve_file_input_references_stages_list_in_order(client_and_main, tmp_path):
    client, main = client_and_main

    # Upload two blobs through the authed uploads endpoint to register them.
    from services.uploads import _store_uploaded_blob  # noqa: F401  (ensures module loaded)

    # Store blobs directly via the files table so we exercise resolution only.
    blobs = []
    with main.get_db() as conn:
        for idx, payload in enumerate((b"first", b"second")):
            from files import blob_path, ensure_blob_dir
            import hashlib

            sha = hashlib.sha256(payload).hexdigest()
            ensure_blob_dir(sha)
            blob_path(sha).write_bytes(payload)
            conn.execute(
                "INSERT OR REPLACE INTO files (id, filename, media_type, size_bytes, uploaded_by, uploaded_at, ref_count)"
                " VALUES (?, ?, ?, ?, ?, ?, 0)",
                (sha, f"clip{idx}.txt", "text/plain", len(payload), OWNER, main.now_iso()),
            )
            blobs.append(sha)

    resolved = main._resolve_file_input_references(
        "episode-worker", "run_resolve_test", {"clips": blobs}, bound_by=OWNER
    )
    staged = resolved["clips"]
    assert isinstance(staged, list) and len(staged) == 2
    assert [Path(p).read_bytes() for p in staged] == [b"first", b"second"]


def test_validate_file_input_references_rejects_non_sha_in_list(client_and_main):
    client, main = client_and_main
    config = main.get_worker_config_for_run("episode-worker")
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        main._validate_file_input_references(config, {"clips": ["not-a-sha", "x"]})
    assert exc.value.status_code == 400


def test_plan_input_file_uploads_remaps_single_and_grouped(tmp_path):
    from runner_sandbox.e2b_driver import _plan_input_file_uploads

    single = tmp_path / "single.txt"
    single.write_text("s")
    clip0 = tmp_path / "000_clips.txt"
    clip0.write_text("0")
    clip1 = tmp_path / "001_clips.txt"
    clip1.write_text("1")

    uploads, sandbox_inputs = _plan_input_file_uploads(
        {
            "doc": str(single),
            "clips": [str(clip0), str(clip1)],
            "text": "plain-scalar",
            "missing": "/nonexistent/relative-not-uploaded",
        }
    )

    # Single file -> inputs/<basename>; grouped -> inputs/<key>/<basename> in order.
    assert sandbox_inputs["doc"] == "inputs/single.txt"
    assert sandbox_inputs["clips"] == ["inputs/clips/000_clips.txt", "inputs/clips/001_clips.txt"]
    assert sandbox_inputs["text"] == "plain-scalar"
    assert sandbox_inputs["missing"] == "/nonexistent/relative-not-uploaded"

    remote_paths = [rel for _, rel in uploads]
    assert remote_paths == [
        "inputs/single.txt",
        "inputs/clips/000_clips.txt",
        "inputs/clips/001_clips.txt",
    ]
