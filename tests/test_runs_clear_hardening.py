"""FIX 1 (post-incident 2026-05-29) — /runs/clear hardening.

A referee agent called /runs/clear?confirm=yes-wipe-all-runs against the prod
API (:8011) thinking it was local dev and wiped 593 runs. These tests lock the
incident class shut in code:

  1. A clear ALWAYS snapshots the DB first; the snapshot exists + is non-empty.
  2. If the backup fails, the clear is ABORTED and no run is deleted.
  3. The delete is scoped to the caller (owner_id) — never a global wipe of
     every user's runs.
"""

from __future__ import annotations

import importlib
import os
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

AUTH = {"x-floom-secret": "clear-secret"}


def _headers(user_id: str) -> dict[str, str]:
    return {**AUTH, "x-floom-user": user_id}


def _load_api(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    backups_dir = tmp_path / "backups"

    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_SECRET", AUTH["x-floom-secret"])
    monkeypatch.setenv("WORKEROS_PRECLEAR_BACKUP_DIR", str(backups_dir))
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setenv("WORKEROS_USER_ID", "user-a")
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGIN_REGEX", raising=False)
    monkeypatch.delenv("WORKEROS_DEV", raising=False)

    reset_prefixes = ("auth.", "db.")
    reset_exact = {
        "main", "auth", "chat_service", "contexts", "db", "files", "models",
        "worker_registry", "run_service", "composio_client", "scheduler",
    }
    for name in list(sys.modules):
        if name in reset_exact or name.startswith(reset_prefixes):
            sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    run_service = importlib.import_module("run_service")
    main._rate_buckets.clear()
    main.start_run = lambda *args, **kwargs: None
    run_service.start_run = main.start_run
    return main, backups_dir


def _worker_payload(name: str) -> dict[str, str]:
    worker_yml = f"""schema_version: "0.3"
name: "{name}"
title: "{name}"
description: "clear test worker"
version: "0.1.0"
targets: [generic]
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  inputs: []
  outputs: []
trigger:
  type: manual
"""
    return {
        "worker_yml": worker_yml,
        "run_py": (
            "def run(inputs, context):\n"
            "    return {'status': 'success', 'outputs': {}, 'artifacts': []}\n"
        ),
    }


def _create_run(client, *, user_id: str, worker_slug: str) -> str:
    created = client.post(
        "/workers", headers=_headers(user_id), json=_worker_payload(worker_slug)
    )
    assert created.status_code == 200, created.text
    run = client.post(
        f"/workers/{worker_slug}/runs",
        headers=_headers(user_id),
        json={"inputs": {}, "trigger_source": "manual"},
    )
    assert run.status_code == 200, run.text
    return run.json()["run_id"]


def test_clear_requires_confirm(monkeypatch, tmp_path):
    main, _ = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    resp = client.post("/runs/clear", headers=_headers("user-a"))
    assert resp.status_code == 400, resp.text


def test_clear_backs_up_before_deleting_and_is_owner_scoped(monkeypatch, tmp_path):
    main, backups_dir = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    run_a = _create_run(client, user_id="user-a", worker_slug="clear-owner")
    run_b = _create_run(client, user_id="user-b", worker_slug="clear-foreign")

    # No backups yet.
    assert not backups_dir.exists() or not list(backups_dir.glob("*.db"))

    resp = client.post(
        "/runs/clear?confirm=yes-wipe-all-runs", headers=_headers("user-a")
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "cleared"
    assert body["cleared_count"] == 1  # only user-a's run

    # 1. Backup created before delete, non-empty.
    backup_path = Path(body["backup_path"])
    assert backup_path.is_file()
    assert backup_path.stat().st_size > 0
    assert str(backups_dir) in str(backup_path)

    # 3. Owner-scoped: user-a's run gone, user-b's run untouched.
    a_after = client.get("/runs", headers=_headers("user-a")).json()
    b_after = client.get("/runs", headers=_headers("user-b")).json()
    assert run_a not in {r["id"] for r in a_after}
    assert run_b in {r["id"] for r in b_after}


def test_clear_aborts_when_backup_fails(monkeypatch, tmp_path):
    main, _ = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    run_a = _create_run(client, user_id="user-a", worker_slug="clear-abort")

    def _boom() -> str:
        raise RuntimeError("simulated backup failure")

    # clear_runs lives in routers.runs and calls _backup_db_before_clear by bare
    # name out of that module — patch there, not main's re-export.
    import routers.runs as _runs
    monkeypatch.setattr(_runs, "_backup_db_before_clear", _boom)

    resp = client.post(
        "/runs/clear?confirm=yes-wipe-all-runs", headers=_headers("user-a")
    )
    # 2. Clear aborted, no data deleted.
    assert resp.status_code == 500, resp.text
    assert "backup failed" in resp.json()["detail"].lower()

    a_after = client.get("/runs", headers=_headers("user-a")).json()
    assert run_a in {r["id"] for r in a_after}
