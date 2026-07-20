from __future__ import annotations

import datetime as dt
import contextlib
import time
import threading

from models import RunStatus
from db import DURABLE_EXECUTION_LOG_PREFIXES


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

def _make_stale_running(
    repos, manifest, run_id, *, started, retry_attempt=0, trigger_ref=None
):
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
        trigger_ref=trigger_ref,
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


def test_recover_requeues_stale_active_thread_before_sandbox_start(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=180)).isoformat()
    _make_stale_running(repos, manifest, "run-active-pre-sandbox", started=stale)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-active-pre-sandbox",
        level="info",
        message="Queue drain claimed run; dispatching executor thread.",
        timestamp=stale,
    )
    active = run_service._ActiveRun(
        run_id="run-active-pre-sandbox",
        worker_id="worker-a",
        user_id="user-a",
        thread=threading.current_thread(),
        started_monotonic=time.monotonic() - 180,
        stage="thread_entry",
    )
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw))
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    monkeypatch.setenv("WORKEROS_DISPATCH_ORPHAN_TIMEOUT_SECONDS", "120")

    run_service._register_active_run(active)
    try:
        result = run_service.recover_abandoned_runs(
            repos=repos, now=now, timeout_seconds=300, grace_seconds=60
        )
    finally:
        run_service._unregister_active_run("run-active-pre-sandbox")

    assert result == {"failed": 1, "requeued": 1}
    row = repos.runs.get(user_id="user-a", run_id="run-active-pre-sandbox")
    assert row["status"] == RunStatus.FAILED.value
    assert row["error_code"] == run_service.DISPATCH_ORPHAN_ERROR_CODE
    assert scheduled[0]["original_run_id"] == "run-active-pre-sandbox"


def test_recover_does_not_reap_fresh_active_thread_before_sandbox_start(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    fresh = (now - dt.timedelta(seconds=20)).isoformat()
    _make_stale_running(repos, manifest, "run-fresh-active-pre-sandbox", started=fresh)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-fresh-active-pre-sandbox",
        level="info",
        message="Queue drain claimed run; dispatching executor thread.",
        timestamp=fresh,
    )
    active = run_service._ActiveRun(
        run_id="run-fresh-active-pre-sandbox",
        worker_id="worker-a",
        user_id="user-a",
        thread=threading.current_thread(),
        started_monotonic=time.monotonic(),
        stage="thread_entry",
    )
    monkeypatch.setenv("WORKEROS_DISPATCH_ORPHAN_TIMEOUT_SECONDS", "120")

    run_service._register_active_run(active)
    try:
        result = run_service.recover_abandoned_runs(
            repos=repos, now=now, timeout_seconds=300, grace_seconds=60
        )
    finally:
        run_service._unregister_active_run("run-fresh-active-pre-sandbox")

    assert result == {"failed": 0, "requeued": 0}
    row = repos.runs.get(user_id="user-a", run_id="run-fresh-active-pre-sandbox")
    assert row["status"] == RunStatus.RUNNING.value


def test_executor_thread_logs_and_fails_pre_sandbox_exception(repo_bundle, monkeypatch):
    import alerting
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    repos.runs.create(
        user_id="user-a",
        run_id="run-context-boom",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        trigger_source="manual",
        runner="e2b",
        input_json={"q": "hello"},
    )

    @contextlib.contextmanager
    def broken_context(_run_id):
        raise RuntimeError("workspace lookup hung up")
        yield

    scheduled: list[dict] = []
    dispatched: list[dict] = []
    monkeypatch.setattr(run_service, "_run_execution_context", broken_context)
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw))
    monkeypatch.setattr(
        alerting,
        "dispatch_ops_run_failure",
        lambda **kwargs: dispatched.append(kwargs),
    )

    run_service._run_thread_entry_with_semaphore(
        "run-context-boom",
        "worker-a",
        {"q": "hello"},
        user_id="user-a",
        repos=repos,
    )

    row = repos.runs.get(user_id="user-a", run_id="run-context-boom")
    assert row["status"] == RunStatus.FAILED.value
    assert row["error_code"] == "executor_thread_pre_sandbox_exception"
    logs = repos.runs.list_logs(user_id="user-a", run_id="run-context-boom")
    messages = [log["message"] for log in logs]
    assert "Executor thread entered; preparing run context." in messages
    assert any("Executor thread crashed before sandbox startup" in msg for msg in messages)
    # The workspace context itself failed, so the engine cannot evaluate the
    # workspace spend cap safely and does not admit a restart retry.
    assert scheduled == []
    assert dispatched[0]["run_id"] == "run-context-boom"
    assert dispatched[0]["error_code"] == "executor_thread_pre_sandbox_exception"


def test_executor_thread_pre_sandbox_crash_retries_with_owner_scope(
    repo_bundle, monkeypatch
):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    repos.runs.create(
        user_id="user-a",
        run_id="run-execute-crash",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        trigger_source="manual",
        runner="e2b",
        input_json={"q": "hello"},
    )
    scheduled: list[dict] = []
    monkeypatch.setattr(
        run_service,
        "execute_run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    monkeypatch.setattr(
        run_service,
        "_schedule_retry",
        lambda **kw: scheduled.append(kw) or True,
    )

    run_service._run_thread_entry_with_semaphore(
        "run-execute-crash",
        "worker-a",
        {"q": "hello"},
        user_id="user-a",
        repos=repos,
    )

    row = repos.runs.get(user_id="user-a", run_id="run-execute-crash")
    assert row["error_code"] == "executor_thread_pre_sandbox_exception"
    assert scheduled[0]["original_run_id"] == "run-execute-crash"
    assert scheduled[0]["user_id"] == "user-a"


def test_pre_sandbox_exception_does_not_loop_restart_retry(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    repos.runs.create(
        user_id="user-a",
        run_id="run-context-boom-retry",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        trigger_source="restart_retry",
        runner="e2b",
        input_json={"q": "hello"},
    )

    @contextlib.contextmanager
    def broken_context(_run_id):
        raise RuntimeError("workspace lookup still failing")
        yield

    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_run_execution_context", broken_context)
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw))

    run_service._run_thread_entry_with_semaphore(
        "run-context-boom-retry",
        "worker-a",
        {"q": "hello"},
        user_id="user-a",
        repos=repos,
    )

    row = repos.runs.get(user_id="user-a", run_id="run-context-boom-retry")
    assert row["status"] == RunStatus.FAILED.value
    assert row["error_code"] == "executor_thread_pre_sandbox_exception"
    assert scheduled == []


def test_retry_dispatch_rechecks_spend_cap_before_sandbox(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    repos.runs.create(
        user_id="user-a",
        run_id="run-retry-cap-blocked",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        trigger_source="retry",
        runner="e2b",
        input_json={"q": "hello"},
        retry_of_run_id="run-original",
        retry_attempt=1,
    )
    monkeypatch.setattr(
        run_service,
        "_enforce_run_spend_caps",
        lambda **_kw: (_ for _ in ()).throw(
            run_service.SpendCapExceeded("workspace cap reached")
        ),
    )

    run_service._run_thread_entry_with_semaphore(
        "run-retry-cap-blocked",
        "worker-a",
        {"q": "hello"},
        user_id="user-a",
        repos=repos,
    )

    row = repos.runs.get(user_id="user-a", run_id="run-retry-cap-blocked")
    assert row["status"] == RunStatus.FAILED.value
    assert row["error_code"] == "spend_cap_exceeded"
    logs = repos.runs.list_logs(user_id="user-a", run_id="run-retry-cap-blocked")
    assert any("Automatic retry cancelled" in log["message"] for log in logs)
    assert not any(
        log["message"].startswith(prefix)
        for log in logs
        for prefix in DURABLE_EXECUTION_LOG_PREFIXES
    )


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


def test_agent_execution_log_is_classified_as_executor_lost_mid_run(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=700)).isoformat()
    _make_stale_running(repos, manifest, "run-agent-lost", started=stale)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-agent-lost",
        level="debug",
        message="Executing worker (mode=agent, runner=e2b)",
        timestamp=stale,
    )
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw) or True)

    result = run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )

    assert result == {"failed": 1, "requeued": 1}
    row = repos.runs.get(user_id="user-a", run_id="run-agent-lost")
    assert row["error"] == "executor lost mid-run"
    assert row["error_code"] == "executor_lost_mid_run"
    assert scheduled[0]["delay_seconds"] == 60
    assert scheduled[0]["trigger_source"] == "restart_retry"


def test_startup_recovery_classifies_recent_claim_without_execution_as_pre_dispatch(
    repo_bundle, monkeypatch
):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    started = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)).isoformat()
    _make_stale_running(repos, manifest, "run-startup-claimed", started=started)
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw) or True)

    failed = run_service.fail_interrupted_runs_on_startup(user_id="ignored", repos=repos)

    assert failed == 1
    row = repos.runs.get(user_id="user-a", run_id="run-startup-claimed")
    assert row["error_code"] == run_service.DISPATCH_ORPHAN_ERROR_CODE
    assert scheduled[0]["original_run_id"] == "run-startup-claimed"


def test_startup_recovery_classifies_execution_evidence_as_executor_lost(
    repo_bundle, monkeypatch
):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    started = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)).isoformat()
    _make_stale_running(repos, manifest, "run-startup-executing", started=started)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-startup-executing",
        level="info",
        message="Tool finished: web_search",
        timestamp=started,
    )
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **_kw: True)

    failed = run_service.fail_interrupted_runs_on_startup(user_id="ignored", repos=repos)

    assert failed == 1
    row = repos.runs.get(user_id="user-a", run_id="run-startup-executing")
    assert row["error_code"] == "executor_lost_mid_run"


def test_executor_loss_retry_checks_cap_for_original_actor(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    started = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=700)).isoformat()
    repos.runs.create(
        user_id="user-a",
        run_id="run-member-actor",
        worker_id="worker-a",
        actor_user_id="user-b",
        status=RunStatus.RUNNING.value,
        started_at=started,
        trigger_source="manual",
        runner="e2b",
        input_json={"q": "hello"},
    )
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-member-actor",
        level="info",
        message="Executing worker (mode=agent, runner=e2b)",
        timestamp=started,
    )
    cap_calls: list[dict] = []
    monkeypatch.setattr(
        run_service,
        "_enforce_run_spend_caps",
        lambda **kw: cap_calls.append(kw),
    )
    monkeypatch.setattr(run_service, "start_run", lambda *_args, **_kwargs: None)

    result = run_service.recover_abandoned_runs(
        repos=repos,
        timeout_seconds=300,
        grace_seconds=60,
    )

    assert result == {"failed": 1, "requeued": 1}
    assert cap_calls[0]["owner_id"] == "user-a"
    assert cap_calls[0]["cap_user_id"] == "user-b"
    child_id = run_service._retry_run_id(
        "run-member-actor",
        1,
        "restart_retry",
    )
    child = repos.runs.get_any(run_id=child_id)
    assert child["actor_user_id"] == "user-b"


def test_executor_loss_retry_is_persisted_once_with_real_backoff(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=700)).isoformat()
    _make_stale_running(
        repos,
        manifest,
        "run-retry-parent",
        started=stale,
        trigger_ref="run-worker-call-parent",
    )
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-retry-parent",
        level="debug",
        message="Executing worker (mode=agent, runner=e2b)",
        timestamp=stale,
    )
    monkeypatch.setattr(run_service, "start_run", lambda *_args, **_kwargs: None)

    result = run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )

    assert result == {"failed": 1, "requeued": 1}
    child_id = run_service._retry_run_id("run-retry-parent", 1, "restart_retry")
    child = repos.runs.get_any(run_id=child_id)
    assert child["trigger_source"] == "restart_retry"
    assert child["retry_of_run_id"] == "run-retry-parent"
    assert child["retry_attempt"] == 1
    assert child["trigger_ref"] == "run-worker-call-parent"
    assert child["started_at"] is None
    not_before = dt.datetime.fromisoformat(child["retry_not_before"])
    assert 55 <= (not_before - dt.datetime.now(dt.timezone.utc)).total_seconds() <= 60
    assert child_id not in {row["run_id"] for row in repos.runs.get_queued(limit=50)}

    repeated = run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )
    assert repeated == {"failed": 0, "requeued": 0}


def test_historical_agent_tool_log_is_execution_evidence(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=700)).isoformat()
    _make_stale_running(repos, manifest, "run-agent-tool-lost", started=stale)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-agent-tool-lost",
        level="info",
        message="Tool finished: web_search",
        timestamp=stale,
    )
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **_kw: True)

    run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )

    row = repos.runs.get(user_id="user-a", run_id="run-agent-tool-lost")
    assert row["error_code"] == "executor_lost_mid_run"


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


def test_recover_does_not_duplicate_existing_retry_child(repo_bundle, monkeypatch):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=500)).isoformat()
    _make_stale_running(repos, manifest, "run-parent", started=stale)
    retry_run_id = run_service._retry_run_id("run-parent", 1, "retry")
    repos.runs.create(
        user_id="user-a",
        run_id=retry_run_id,
        worker_id="worker-a",
        status=RunStatus.QUEUED.value,
        trigger_source="retry",
        input_json={"q": "hello"},
        retry_of_run_id="run-parent",
        retry_attempt=1,
    )
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw))
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")

    result = run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )

    assert result == {"failed": 1, "requeued": 0}
    assert scheduled == []
    assert repos.runs.get_any(run_id=retry_run_id) is not None


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


def test_recover_restores_workspace_context_and_suppresses_retry_at_spend_cap(
    repo_bundle, monkeypatch
):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=700)).isoformat()
    _make_stale_running(repos, manifest, "run-cap-blocked", started=stale)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-cap-blocked",
        level="debug",
        message="Executing worker (mode=agent, runner=e2b)",
        timestamp=stale,
    )
    context_events: list[str] = []

    @contextlib.contextmanager
    def restored_context(run_id, *, strict=False):
        assert strict is True
        context_events.append(f"enter:{run_id}")
        try:
            yield
        finally:
            context_events.append(f"exit:{run_id}")

    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_run_execution_context", restored_context)
    monkeypatch.setattr(
        run_service,
        "_enforce_run_spend_caps",
        lambda **_kw: (_ for _ in ()).throw(run_service.SpendCapExceeded("workspace cap reached")),
    )
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw))

    result = run_service.recover_abandoned_runs(
        repos=repos, now=now, timeout_seconds=300, grace_seconds=60
    )

    assert result == {"failed": 1, "requeued": 0}
    assert context_events == ["enter:run-cap-blocked", "exit:run-cap-blocked"]
    assert scheduled == []
    logs = repos.runs.list_logs(user_id="user-a", run_id="run-cap-blocked")
    assert any("retry skipped" in log["message"].lower() for log in logs)


def test_recover_fails_closed_when_workspace_context_provider_fails(
    repo_bundle, monkeypatch
):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=700)).isoformat()
    _make_stale_running(repos, manifest, "run-context-provider-failed", started=stale)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-context-provider-failed",
        level="debug",
        message="Executing worker (mode=agent, runner=e2b)",
        timestamp=stale,
    )

    def broken_provider(_run_id):
        raise RuntimeError("workspace lookup failed")

    scheduled: list[dict] = []
    run_service.set_run_execution_context_provider(broken_provider)
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw))
    try:
        result = run_service.recover_abandoned_runs(
            repos=repos, now=now, timeout_seconds=300, grace_seconds=60
        )
    finally:
        run_service.set_run_execution_context_provider(None)

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
        trigger_ref="run-worker-call-parent",
        duration_ms=1234,
        cancel_requested=True, cancelled_at=dt.datetime.now(dt.timezone.utc).isoformat(),
    )
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    monkeypatch.setenv("WORKEROS_MAX_RESTART_RETRIES", "1")

    assert run_service._requeue_interrupted_run_in_place(repos, "run-int", "user-a") is True
    row = repos.runs.get(user_id="user-a", run_id="run-int")
    assert row["status"] == RunStatus.QUEUED.value
    assert row["trigger_source"] == "restart_retry"
    assert not row["cancel_requested"]
    assert row["cancelled_at"] is None
    assert row["trigger_ref"] == "run-worker-call-parent"
    assert row["started_at"] is None
    assert row["duration_ms"] is None
    not_before = dt.datetime.fromisoformat(row["retry_not_before"])
    assert 55 <= (not_before - dt.datetime.now(dt.timezone.utc)).total_seconds() <= 60
    assert "run-int" not in {queued["run_id"] for queued in repos.runs.get_queued(limit=50)}
    assert repos.runs.claim_queued(
        user_id="user-a",
        run_id="run-int",
        started_at=(not_before - dt.timedelta(seconds=1)).isoformat(),
    ) is None
    claimed = repos.runs.claim_queued(
        user_id="user-a",
        run_id="run-int",
        started_at=(not_before + dt.timedelta(seconds=1)).isoformat(),
    )
    assert claimed is not None
    assert claimed["status"] == RunStatus.RUNNING.value
    assert not row.get("error")


def test_graceful_restart_retry_checks_cap_for_original_actor(
    repo_bundle, monkeypatch
):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    repos.runs.create(
        user_id="user-a",
        run_id="run-int-member",
        worker_id="worker-a",
        actor_user_id="user-b",
        status=RunStatus.FAILED.value,
        trigger_source="manual",
        runner="e2b",
        error=run_service.INTERRUPTED_RUN_ERROR,
        input_json={"q": 1},
    )
    cap_calls: list[dict] = []
    monkeypatch.setattr(
        run_service,
        "_enforce_run_spend_caps",
        lambda **kw: cap_calls.append(kw),
    )

    assert run_service._requeue_interrupted_run_in_place(
        repos,
        "run-int-member",
        "user-a",
    ) is True
    assert cap_calls[0]["cap_user_id"] == "user-b"


def test_graceful_restart_retry_fails_closed_when_context_provider_fails(
    repo_bundle, monkeypatch
):
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    repos.runs.create(
        user_id="user-a",
        run_id="run-int-context-failed",
        worker_id="worker-a",
        status=RunStatus.FAILED.value,
        trigger_source="manual",
        runner="e2b",
        error=run_service.INTERRUPTED_RUN_ERROR,
        input_json={"q": 1},
    )

    def broken_provider(_run_id):
        raise RuntimeError("workspace lookup failed")

    run_service.set_run_execution_context_provider(broken_provider)
    try:
        assert run_service._requeue_interrupted_run_in_place(
            repos,
            "run-int-context-failed",
            "user-a",
        ) is False
    finally:
        run_service.set_run_execution_context_provider(None)

    row = repos.runs.get(user_id="user-a", run_id="run-int-context-failed")
    assert row["status"] == RunStatus.FAILED.value
    assert row["trigger_source"] == "manual"


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


# --- steady-state reaper uses the same executor-loss classification -----------

def test_recover_with_periodic_labels_marks_executor_lost(repo_bundle, monkeypatch):
    """The periodic reaper labels a mid-execution disappearance consistently."""
    import run_service

    repos, _db, manifest = repo_bundle
    _create_worker(repos, manifest)
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(seconds=700)).isoformat()
    _make_stale_running(repos, manifest, "run-hung", started=stale)
    # The run DID reach sandbox startup (it hung mid-execution), so the
    # dispatch-orphan sweep skips it and the stale-running sweep labels it.
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-hung",
        level="info",
        message="[e2b] Spawning sandbox for worker-a",
        timestamp=stale,
    )

    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: None)

    result = run_service.recover_abandoned_runs(
        repos=repos,
        now=now,
        timeout_seconds=300,
        grace_seconds=60,
        error=run_service.ORPHANED_RUN_ERROR,
        error_code=run_service.ORPHANED_RUN_ERROR_CODE,
    )

    assert result["failed"] == 1
    row = repos.runs.get(user_id="user-a", run_id="run-hung")
    assert row["status"] == RunStatus.FAILED.value
    assert row["error"] == run_service.ORPHANED_RUN_ERROR
    assert row["error_code"] == "executor_lost_mid_run"
    logs = repos.runs.list_logs(user_id="user-a", run_id="run-hung")
    assert run_service.ORPHANED_RUN_ERROR in [log["message"] for log in logs]


def test_run_reaper_loop_sweeps_with_executor_lost_error_code(monkeypatch):
    """Regression (bug B): the periodic loop must (a) actually sweep and
    (b) label swept rows as executor loss. Before this fix the cloud deployment
    never even started the loop, so runs sat in `running` for hours until
    the next deploy's startup recovery caught them."""
    import run_service

    calls: list[dict] = []

    class _OneSweepStop:
        def __init__(self):
            self.waits = 0

        def wait(self, timeout=None):
            self.waits += 1
            return self.waits > 1  # first wait: run one sweep; then stop

    monkeypatch.setattr(run_service, "_run_reaper_stop", _OneSweepStop())
    monkeypatch.setattr(
        run_service,
        "recover_abandoned_runs",
        lambda **kw: calls.append(kw) or {"failed": 0, "requeued": 0},
    )

    run_service._run_reaper_loop()

    assert len(calls) == 1
    assert calls[0]["error_code"] == run_service.ORPHANED_RUN_ERROR_CODE == "executor_lost_mid_run"
    assert calls[0]["error"] == run_service.ORPHANED_RUN_ERROR
