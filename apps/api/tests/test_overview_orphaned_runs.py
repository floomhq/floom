"""Orphaned-run 404 fix (2026-06-04).

The /overview "Worker activity" feed links each run to /runs/{id}, and its
failure-cluster attention items link to /workers/{id}. Both feeds previously
pulled runs with an UNFILTERED repos.runs.list(), so runs belonging to a worker
that is no longer API-visible (deleted/hidden internal listeners like
slack-listener / whatsapp-listener, whose 435 orphaned failed runs survive
worker deletion) were surfaced. Clicking them hit a "Run not found" 404 wall,
because GET /runs/{id} 404s any run whose worker fails _run_visible_to_api.

These tests pin the fix: the overview feeds must only surface runs whose worker
is API-visible. The run rows themselves are NOT deleted (no-wipe guardrail) —
this is a serving/query filter.
"""

from __future__ import annotations

import importlib
import sys
import types
import uuid
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _worker_yml(name: str) -> str:
    return f"""\
schema_version: '0.3'
name: {name}
title: {name}
description: probe worker for orphaned-run overview test.
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
    # Two filesystem workers: one operator-visible ("visible-probe") and one with
    # a "smoke-" prefix that _worker_hidden_from_api hides unconditionally. Both
    # get persisted to the DB (so their runs survive the runs.list workers JOIN),
    # but only the visible one is API-reachable — mirroring the deleted/hidden
    # listener workers (slack-listener / whatsapp-listener) in production.
    for name in ("visible-probe", "smoke-orphan-listener"):
        wdir = workers_dir / name
        wdir.mkdir()
        (wdir / "worker.yml").write_text(_worker_yml(name), encoding="utf-8")
        (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
        (wdir / "requirements.txt").write_text("", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-orphan")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local",
    ]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

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
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-orphan"}) as client:
        yield client, main, repos
    db.get_repositories.cache_clear()


def _seed_run(repos, worker_id: str, status: str) -> str:
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    repos.runs.create(
        user_id="federico",
        worker_id=worker_id,
        run_id=run_id,
        status=status,
    )
    return run_id


def test_orphaned_worker_runs_excluded_from_overview_feeds(client_and_main):
    client, main, repos = client_and_main

    # Sanity: the hidden id is treated as hidden by the API; its DB row exists.
    assert main._worker_hidden_from_api("smoke-orphan-listener") is True
    assert main._worker_hidden_from_api("visible-probe") is False
    assert repos.workers.get(user_id="federico", worker_id="smoke-orphan-listener") is not None

    # Visible worker: a completed run that SHOULD surface in the activity feed.
    visible_run = _seed_run(repos, "visible-probe", "completed")
    # Orphaned/hidden worker: failed runs that must NOT surface (their /runs/{id}
    # detail 404s, so a surfaced link would be a dead "Run not found" wall).
    orphan_runs = [_seed_run(repos, "smoke-orphan-listener", "failed") for _ in range(5)]

    resp = client.get("/system/overview")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # 1) Worker activity feed (recent_runs) must not surface orphaned-worker runs.
    recent_ids = {r["run_id"] for r in body["recent_runs"]}
    recent_workers = {r["worker_id"] for r in body["recent_runs"]}
    assert visible_run in recent_ids, body["recent_runs"]
    assert "smoke-orphan-listener" not in recent_workers, body["recent_runs"]
    for rid in orphan_runs:
        assert rid not in recent_ids, body["recent_runs"]

    # 2) needs_attention failure clusters must not surface the orphaned worker
    #    (its /workers/{id} link would 404 too).
    attention_workers = {item.get("worker_id") for item in body["needs_attention"]}
    assert "smoke-orphan-listener" not in attention_workers, body["needs_attention"]

    # 3) The inconsistency the filter resolves: GET /runs/{orphan} still 404s.
    #    Confirms we filtered the *source* of the broken link, not just hid it.
    detail = client.get(f"/runs/{orphan_runs[0]}")
    assert detail.status_code == 404, detail.text
