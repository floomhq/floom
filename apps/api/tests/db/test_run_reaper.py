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


# --- #1434: auto-requeue abandoned runs after a restart -----------------------

def _make_stale_running(repos, manifest, run_id, *, started, retry_attempt=0):
    repos.runs.create(
        user_id="user-a",
        run_id=run_id,
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at=started,
        trigger_source="manual",
        runner="e2b",
        input_json={"q": "hello"},
        retry_attempt=retry_attempt,
    )


def test_recover_requeues_abandoned_run_within_budget(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=500)).isoformat()
    _make_stale_running(repos, manifest, "run-stale", started=stale)

    scheduled: list[dict] = []
    monkeypatch.setattr(
        run_service,
        "_schedule_retry",
        lambda **kw: scheduled.append(kw),
    )
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    monkeypatch.setenv("WORKEROS_MAX_RESTART_RETRIES", "1")

    result = run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )

    assert result == {"failed": 1, "requeued": 1}
    # The orphaned row still records the abandonment (a fresh retry carries the work).
    row = repos.runs.get(user_id="user-a", run_id="run-stale")
    assert row["status"] == RunStatus.FAILED.value
    # A retry was scheduled for the right run/worker, carrying the original inputs.
    assert len(scheduled) == 1
    assert scheduled[0]["original_run_id"] == "run-stale"
    assert scheduled[0]["worker_id"] == "worker-a"
    assert scheduled[0]["attempt"] == 1
    assert scheduled[0]["inputs"] == {"q": "hello"}


def test_recover_requeues_claimed_run_that_never_reached_sandbox(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=180)).isoformat()
    _make_stale_running(repos, manifest, "run-claimed-orphan", started=stale)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-claimed-orphan",
        level="info",
        message="Queue drain claimed run; dispatching executor thread.",
        timestamp=stale,
    )

    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw))
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    monkeypatch.setenv("WORKEROS_DISPATCH_ORPHAN_TIMEOUT_SECONDS", "120")

    result = run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )

    assert result == {"failed": 1, "requeued": 1}
    row = repos.runs.get(user_id="user-a", run_id="run-claimed-orphan")
    assert row["status"] == RunStatus.FAILED.value
    assert row["error_code"] == run_service.DISPATCH_ORPHAN_ERROR_CODE
    logs = repos.runs.list_logs(user_id="user-a", run_id="run-claimed-orphan")
    assert any(log["message"] == run_service.DISPATCH_ORPHAN_ERROR for log in logs)
    assert scheduled[0]["original_run_id"] == "run-claimed-orphan"


def test_recover_does_not_reap_running_run_after_sandbox_start_log(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=180)).isoformat()
    _make_stale_running(repos, manifest, "run-started", started=stale)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-started",
        level="info",
        message="[e2b] Spawning sandbox",
        timestamp=stale,
    )

    monkeypatch.setenv("WORKEROS_DISPATCH_ORPHAN_TIMEOUT_SECONDS", "120")
    result = run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )

    assert result == {"failed": 0, "requeued": 0}
    assert repos.runs.get(user_id="user-a", run_id="run-started")["status"] == RunStatus.RUNNING.value


def test_recover_does_not_requeue_a_restart_retry(repo_bundle, monkeypatch):
    """A run that is ITSELF a restart-recovery retry must not be recovered again,
    so a worker that crashes the executor on every boot cannot loop forever. The
    bound is on trigger_source (robust even though create() drops retry_attempt)."""
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=500)).isoformat()
    repos.runs.create(
        user_id="user-a",
        run_id="run-restart-retry",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at=stale,
        trigger_source="restart_retry",
        runner="e2b",
        input_json={"q": "hello"},
    )

    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw))
    monkeypatch.setenv("WORKEROS_MAX_RESTART_RETRIES", "1")

    result = run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )

    assert result == {"failed": 1, "requeued": 0}
    assert scheduled == []
    assert repos.runs.get(user_id="user-a", run_id="run-restart-retry")["status"] == RunStatus.FAILED.value


def test_recover_respects_disable_flag(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=500)).isoformat()
    _make_stale_running(repos, manifest, "run-stale", started=stale)

    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw))
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "0")

    result = run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )

    assert result == {"failed": 1, "requeued": 0}
    assert scheduled == []


# --- #1434: graceful-SIGTERM requeue (in place) ------------------------------

def test_requeue_interrupted_run_in_place(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    repos.runs.create(
        user_id="user-a", run_id="run-int", worker_id="worker-a",
        status=RunStatus.FAILED.value, trigger_source="manual", runner="e2b",
        error=run_service.INTERRUPTED_RUN_ERROR, input_json={"q": 1},
    )
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    monkeypatch.setenv("WORKEROS_MAX_RESTART_RETRIES", "1")

    assert run_service._requeue_interrupted_run_in_place(repos, "run-int", "user-a") is True
    row = repos.runs.get(user_id="user-a", run_id="run-int")
    assert row["status"] == RunStatus.QUEUED.value
    assert row["trigger_source"] == "restart_retry"
    assert not row.get("error")


def test_requeue_interrupted_does_not_loop_on_restart_retry(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    repos.runs.create(
        user_id="user-a", run_id="run-int2", worker_id="worker-a",
        status=RunStatus.FAILED.value, trigger_source="restart_retry", runner="e2b",
    )
    monkeypatch.setenv("WORKEROS_MAX_RESTART_RETRIES", "1")
    # Already a restart_retry -> must not requeue again (bounded across deploys).
    assert run_service._requeue_interrupted_run_in_place(repos, "run-int2", "user-a") is False
    assert repos.runs.get(user_id="user-a", run_id="run-int2")["status"] == RunStatus.FAILED.value
