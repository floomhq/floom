"""End-to-end test: registration reconciles a multi-trigger worker.yml into
worker_triggers rows, and the scheduler fires every schedule trigger.

This closes the loop that the unit tests stub: a real worker.yml declaring a
`triggers:` list flows through `_persist_discovered_workers` into normalized
worker_triggers rows, and a scheduler tick fires one run per due schedule row.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# A worker that declares TWO schedule triggers plus a webhook trigger.
_MULTI_TRIGGER_YML = """\
schema_version: "0.3"
name: "multi-trigger-worker"
title: "Multi Trigger Worker"
description: "Declares two schedule triggers and a webhook trigger."
version: "0.1.0"
triggers:
  - type: "schedule"
    cron: "*/5 * * * *"
  - type: "schedule"
    cron: "0 9 * * 1"
  - type: "webhook"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections: []
"""

# A single-trigger worker, to prove backward-compat (one trigger -> one row).
_SINGLE_TRIGGER_YML = """\
schema_version: "0.3"
name: "single-trigger-worker"
title: "Single Trigger Worker"
description: "A plain single-schedule worker."
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "0 7 * * *"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections: []
"""


@pytest.fixture
def booted(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    for name, yml in [
        ("multi-trigger-worker", _MULTI_TRIGGER_YML),
        ("single-trigger-worker", _SINGLE_TRIGGER_YML),
    ]:
        wdir = workers_dir / name
        wdir.mkdir()
        (wdir / "worker.yml").write_text(yml, encoding="utf-8")
        (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-multitrigger")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "scheduler", "main",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")

    yield db, main
    db.get_repositories.cache_clear()


def test_registration_reconciles_multi_trigger_into_rows(booted):
    db, _main = booted
    repos = db.get_repositories()

    rows = repos.workers.list_trigger_rows(worker_id="multi-trigger-worker")
    types = [r["type"] for r in rows]
    assert types == ["schedule", "schedule", "webhook"], types

    single = repos.workers.list_trigger_rows(worker_id="single-trigger-worker")
    assert len(single) == 1
    assert single[0]["type"] == "schedule"


def test_patch_schedule_to_manual_reconciles_scheduler_trigger_rows(booted):
    db, main = booted
    repos = db.get_repositories()

    before = repos.workers.list_trigger_rows(worker_id="single-trigger-worker")
    assert [(r["type"], r["enabled"]) for r in before] == [("schedule", 1)]
    repos.workers.set_trigger_next_run_at(
        trigger_id=before[0]["id"], next_run_at="2000-01-01T00:00:00+00:00"
    )

    with TestClient(main.app, headers={"x-floom-secret": "test-secret-multitrigger"}) as client:
        response = client.patch(
            "/workers/single-trigger-worker",
            json={"trigger_type": "manual"},
        )

    assert response.status_code == 200, response.text
    after = repos.workers.list_trigger_rows(worker_id="single-trigger-worker")
    assert [(r["type"], r["enabled"]) for r in after] == [("manual", 1)]

    scheduler_rows = repos.workers.list_due_schedule_triggers(
        now_iso="2100-01-01T00:00:00+00:00"
    )
    assert [r for r in scheduler_rows if r["worker_id"] == "single-trigger-worker"] == []


def test_scheduler_fires_both_schedule_triggers_of_multi_worker(booted, monkeypatch):
    db, _main = booted
    import scheduler

    repos = db.get_repositories()
    rows = [
        r
        for r in repos.workers.list_trigger_rows(worker_id="multi-trigger-worker")
        if r["type"] == "schedule"
    ]
    assert len(rows) == 2
    for r in rows:
        repos.workers.set_trigger_next_run_at(
            trigger_id=r["id"], next_run_at="2000-01-01T00:00:00+00:00"
        )

    fired: list[str] = []

    def fake_create_run(worker_id, inputs, trigger_source="manual", **kwargs):
        fired.append(kwargs.get("trigger_ref"))
        return f"run_{len(fired)}"

    monkeypatch.setattr(scheduler, "create_run", fake_create_run)
    monkeypatch.setattr(scheduler, "start_run", lambda *a, **k: None)
    monkeypatch.setattr(scheduler, "alerting_tick", lambda: None)
    monkeypatch.setattr(
        repos.runs, "count_running_for_worker", lambda **k: 0
    )
    monkeypatch.setattr(scheduler, "get_repositories", lambda: repos)

    scheduler._tick()

    assert len(fired) == 2, f"both schedule triggers must fire: {fired}"
    assert set(fired) == {r["id"] for r in rows}
