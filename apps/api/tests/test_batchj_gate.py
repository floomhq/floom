"""Batch J — run-create gate on a disabled worker (B-P1-1, 2026-05-29).

A smoke-disabled worker (enabled=False) must reject an on-demand run with
HTTP 409 worker_disabled BEFORE any run row is created — not run it to a
green-but-empty no-op.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


_WORKER_YML = """\
schema_version: '0.3'
name: gated-probe
title: Gated Probe
description: A worker for testing the disabled gate.
version: 0.1.0
targets:
- generic
exec:
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
inputs:
- name: x
  kind: scalar
  type: string
  required: true
  label: X
outputs:
- name: y
  kind: scalar
  type: string
  required: true
  label: Y
trigger:
  type: manual
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    wdir = workers_dir / "gated-probe"
    wdir.mkdir()
    (wdir / "worker.yml").write_text(_WORKER_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
    (wdir / "requirements.txt").write_text("", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-batchj")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    repos = db.get_repositories()

    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": "test-secret-batchj"})
    yield client, main, repos
    db.get_repositories.cache_clear()


def test_enabled_worker_run_is_not_gated(client_and_main):
    client, main, repos = client_and_main
    # An enabled worker is NOT blocked by the gate (it may still fail later in
    # the sandbox, but it must not 409 worker_disabled). We assert it does not
    # return 409.
    resp = client.post("/workers/gated-probe/runs", json={"inputs": {"x": "v"}})
    assert resp.status_code != 409, resp.text


def test_disabled_worker_run_returns_409(client_and_main):
    client, main, repos = client_and_main
    # Disable it the way the smoke gate does.
    repos.workers.update(user_id="federico", worker_id="gated-probe", enabled=False)

    resp = client.post("/workers/gated-probe/runs", json={"inputs": {"x": "v"}})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    # The taxonomy headline for worker_disabled, not a raw string.
    assert body["detail"] == main._OPERATOR_ERROR_CODE_HEADLINES["worker_disabled"]


# --------------------------------------------------------------------------
# Batch L / P2 — worker-detail honesty:
#  - a never-run worker reports neutral "ready", never an unearned "healthy"
#  - GET /workers/{id} never leaks the absolute bundle_path (deploy dir)
#  - `enabled` is exposed so the UI can disable Run on a paused worker
# --------------------------------------------------------------------------

def test_never_run_worker_reports_ready_not_healthy(client_and_main):
    client, main, repos = client_and_main
    resp = client.get("/workers/gated-probe")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # No runs yet -> neutral READY, NOT the unearned "healthy".
    assert body["status"] == "ready", body["status"]
    assert body["enabled"] is True


def test_worker_detail_does_not_leak_bundle_path(client_and_main):
    client, main, repos = client_and_main
    resp = client.get("/workers/gated-probe")
    assert resp.status_code == 200, resp.text
    runtime = (resp.json().get("config") or {}).get("runtime") or {}
    bundle_path = runtime.get("bundle_path")
    # If present at all, it must be a bare basename — never an absolute host path.
    if bundle_path:
        assert "/root/workeros" not in bundle_path, bundle_path
        assert not bundle_path.startswith("/"), bundle_path
        assert "/" not in bundle_path, bundle_path
    # Belt: the whole serialized detail never contains the deploy dir.
    assert "/root/workeros/workers" not in resp.text


def test_paused_worker_detail_reports_enabled_false(client_and_main):
    client, main, repos = client_and_main
    repos.workers.update(user_id="federico", worker_id="gated-probe", enabled=False)
    resp = client.get("/workers/gated-probe")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["enabled"] is False
    # A paused worker that has never run is needs_attention, not healthy/ready.
    assert body["status"] != "healthy"
