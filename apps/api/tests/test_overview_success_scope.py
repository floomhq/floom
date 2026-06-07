"""Batch K / G5 FIX 3 — honest overview success metric (2026-05-29).

success_rate_7d must reflect ACTIVE, real workers only. Paused/example/system
workers (the legacy/test churn that produced the 54.6% aggregate both G5
scorers flagged) must NOT drag the headline rate down.
"""

from __future__ import annotations

import importlib
import sys
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
description: probe worker for overview scope test.
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
    for name in ("active-probe", "paused-probe"):
        wdir = workers_dir / name
        wdir.mkdir()
        (wdir / "worker.yml").write_text(_worker_yml(name), encoding="utf-8")
        (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
        (wdir / "requirements.txt").write_text("", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-overview")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    import types

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
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-overview"}) as client:
        yield client, main, repos
    db.get_repositories.cache_clear()


def _seed_run(repos, worker_id: str, status: str) -> None:
    repos.runs.create(
        user_id="federico",
        worker_id=worker_id,
        run_id=f"run_{uuid.uuid4().hex[:12]}",
        status=status,
    )


def test_success_rate_excludes_paused_worker_runs(client_and_main):
    client, main, repos = client_and_main

    # Active worker: 1 completed + 1 failed -> 50%.
    _seed_run(repos, "active-probe", "completed")
    _seed_run(repos, "active-probe", "failed")
    # Paused worker: 4 failures. If counted, the aggregate would be 1/6 = 16.7%.
    repos.workers.update(user_id="federico", worker_id="paused-probe", enabled=False)
    for _ in range(4):
        _seed_run(repos, "paused-probe", "failed")

    resp = client.get("/system/overview")
    assert resp.status_code == 200, resp.text
    stats = resp.json()["stats"]

    # Honest, scoped rate: only the active worker's runs count -> exactly 50%.
    assert stats["success_rate_7d"] == pytest.approx(0.5), stats
    assert stats["success_rate_scope"] == "active_workers"
    # The 24h/7d run COUNTS remain unscoped (activity volume, not quality):
    # all 6 seeded runs are still reflected in the activity totals.
    assert stats["runs_today"] >= 6, stats
    # IA-fix 2026-06-02: the OUTCOME tiles (work_shipped_7d / completed_today /
    # failed_today) are now scoped to active, real workers — the paused worker's
    # 4 failures must NOT pollute them. Only active-probe's 1 completed + 1
    # failed count toward the headline outcome tiles.
    assert stats["work_shipped_7d"] == 1, stats
    assert stats["completed_today"] == 1, stats
    assert stats["failed_today"] == 1, stats


def test_success_rate_none_when_no_active_worker_runs(client_and_main):
    client, main, repos = client_and_main
    # Only the paused worker has runs -> nothing in the active-real scope.
    repos.workers.update(user_id="federico", worker_id="paused-probe", enabled=False)
    _seed_run(repos, "paused-probe", "failed")
    _seed_run(repos, "paused-probe", "completed")

    resp = client.get("/system/overview")
    assert resp.status_code == 200, resp.text
    stats = resp.json()["stats"]
    assert stats["success_rate_7d"] is None, stats
    assert stats["success_rate_scope"] == "active_workers"
