from __future__ import annotations

import datetime as dt
import threading

from models import RunStatus


def _create_worker(repos, manifest) -> None:
    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )


def test_reaper_fails_stale_running_run_but_keeps_fresh_run(repo_bundle):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale_started = (now - dt.timedelta(seconds=500)).isoformat()
    fresh_started = (now - dt.timedelta(seconds=20)).isoformat()

    repos.runs.create(
        user_id="user-a",
        run_id="run-stale",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at=stale_started,
        trigger_source="manual",
        runner="e2b",
    )
    repos.runs.create(
        user_id="user-a",
        run_id="run-fresh",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at=fresh_started,
        trigger_source="manual",
        runner="e2b",
    )

    reaped = run_service.reap_abandoned_runs(
        repos=repos,
        now=now,
        timeout_seconds=300,
        grace_seconds=60,
    )

    assert reaped == 1
    stale = repos.runs.get(user_id="user-a", run_id="run-stale")
    fresh = repos.runs.get(user_id="user-a", run_id="run-fresh")
    assert stale["status"] == RunStatus.FAILED.value
    assert stale["error"] == run_service.ABANDONED_RUN_ERROR
    assert stale["error_code"] == run_service.ABANDONED_RUN_ERROR_CODE
    assert stale["completed_at"]
    assert stale["duration_ms"] >= 499_000
    assert fresh["status"] == RunStatus.RUNNING.value
    assert fresh["completed_at"] is None

    logs = repos.runs.list_logs(user_id="user-a", run_id="run-stale")
    assert [log["message"] for log in logs] == [run_service.ABANDONED_RUN_ERROR]

    assert (
        run_service.reap_abandoned_runs(
            repos=repos,
            now=now,
            timeout_seconds=300,
            grace_seconds=60,
        )
        == 0
    )


def test_reaper_skips_stale_running_run_with_active_execution_handle(repo_bundle):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale_started = (now - dt.timedelta(seconds=500)).isoformat()
    repos.runs.create(
        user_id="user-a",
        run_id="run-active",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at=stale_started,
        trigger_source="manual",
        runner="e2b",
    )

    active = run_service._ActiveRun(
        run_id="run-active",
        worker_id="worker-a",
        user_id="user-a",
        thread=threading.current_thread(),
    )
    run_service._register_active_run(active)
    try:
        reaped = run_service.reap_abandoned_runs(
            repos=repos,
            now=now,
            timeout_seconds=300,
            grace_seconds=60,
        )
    finally:
        run_service._unregister_active_run("run-active")

    assert reaped == 0
    row = repos.runs.get(user_id="user-a", run_id="run-active")
    assert row["status"] == RunStatus.RUNNING.value
    assert row["completed_at"] is None
