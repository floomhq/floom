"""Regression tests for the run reaper's per-run timeout and liveness rules.

Context: floomhq/workeros-cloud#1232 (comment 5477384486, 2026-08-31).

Production symptom: `run_170264ee7906` declared `timeout_seconds: 1800` in its
manifest, started 05:00:49 UTC, wrote `out/board.md` at 05:07:15, and was still
marked `executor lost mid-run` at 05:08:21 -- 452 s in. The periodic reaper had
resolved its window from the *global* `DEFAULT_TIMEOUT_SECONDS` (300 s, see
`runner_utils.py:63`) plus 60 s grace, not from the run's own effective timeout.
It then enqueued a `restart_retry` against a sandbox that was demonstrably still
executing (it went on to call `GMAIL_SEND_EMAIL` twice afterwards).

The two invariants under test:

A. The reaper must resolve each candidate row's *own* effective timeout and
   leave it alone until that deadline (plus grace) has actually passed.
B. A run with fresh durable-execution log activity is provably alive and must
   neither be failed nor requeued, whatever the clock says.

Plus the lineage invariant that turned one false reap into two retry trees:

C. One retry child per (original run, attempt), regardless of `trigger_source`.
   `_retry_run_id` hashes `trigger_source` into the id, so `retry` and
   `restart_retry` could fork sibling children for one attempt.

Every reaper test here calls `recover_abandoned_runs()` WITHOUT
`timeout_seconds`, which is exactly how the production reaper thread invokes it
(`_run_reaper_loop`); the pre-existing suite always passes 300 explicitly and so
never exercised the global-default fallback that caused the incident.

Two fixtures of realism matter, or the tests pass/fail for the wrong reason:
  * Each run carries a sandbox-start log. A real 452 s run has one, and without
    it the *separate* dispatch-orphan reaper (120 s, no-sandbox-log predicate)
    fires instead and masks what is under test.
  * The worker-recipe cache is disabled. It is keyed by worker id with a 10 s
    TTL, so within one test module a later test would otherwise resolve an
    earlier test's timeout.
"""

from __future__ import annotations

import datetime as dt
import sys

import pytest

from models import RunStatus


@pytest.fixture(autouse=True)
def _fresh_run_service(repo_bundle):
    """Re-import `run_service` for every test in this module.

    `repo_bundle` reloads the `db` package per test. A `run_service` imported
    against a previous test's `db` module keeps references to the old objects,
    so `_load_worker_recipe` raises and the reaper falls back to the 3600 s
    ceiling instead of reading the manifest. Without this, only the first test
    in the module actually exercises per-manifest timeout resolution.
    """
    sys.modules.pop("run_service", None)
    yield
    sys.modules.pop("run_service", None)


def _manifest_with_timeout(worker_id: str, timeout_seconds: int) -> dict:
    """Manifest shaped like `daily-outlier-idea-agent`: an explicit limit."""
    return {
        "id": worker_id,
        "name": worker_id,
        "trigger": {"type": "manual"},
        "runtime": {
            "type": "python",
            "entrypoint": "run.py",
            "runner": "e2b",
            "limits": {"timeout_seconds": timeout_seconds},
        },
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
    }


def _worker(repos, worker_id: str, *, timeout_seconds: int) -> None:
    repos.workers.create(
        user_id="user-a",
        worker_id=worker_id,
        name=worker_id,
        manifest_json=_manifest_with_timeout(worker_id, timeout_seconds),
        bundle_path=f"workers/{worker_id}",
    )


def _running_with_sandbox_log(
    repos,
    run_id: str,
    worker_id: str,
    *,
    started: dt.datetime,
    last_activity: dt.datetime | None = None,
) -> None:
    """A `running` row that has genuinely entered sandbox execution.

    `last_activity` adds a later durable-execution row, modelling an agent that
    is still issuing tool calls.
    """
    repos.runs.create(
        user_id="user-a",
        run_id=run_id,
        worker_id=worker_id,
        status=RunStatus.RUNNING.value,
        started_at=started.isoformat(),
        trigger_source="schedule",
        runner="e2b",
        input_json={"q": "hello"},
        retry_attempt=0,
    )
    repos.runs.add_log(
        user_id="user-a",
        run_id=run_id,
        level="info",
        message="[e2b] Sandbox ready",
        timestamp=started.isoformat(),
    )
    if last_activity is not None:
        repos.runs.add_log(
            user_id="user-a",
            run_id=run_id,
            level="info",
            message="Tool call: GMAIL_SEND_EMAIL",
            timestamp=last_activity.isoformat(),
        )


def _isolate_recipe_cache(monkeypatch) -> None:
    monkeypatch.setenv("WORKEROS_RUN_RECIPE_CACHE_TTL_SECONDS", "0")


def _capture_retries(monkeypatch, run_service) -> list[dict]:
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw) or True)
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    monkeypatch.setenv("WORKEROS_MAX_RESTART_RETRIES", "1")
    return scheduled


# ---------------------------------------------------------------------------
# A. per-run timeout, not the global 300 s default
# ---------------------------------------------------------------------------


def test_reaper_honours_manifest_timeout_and_spares_run_inside_its_deadline(
    repo_bundle, monkeypatch
):
    """The exact #1232 scenario: 452 s into an 1800 s worker.

    Liveness is switched off so that only the per-run deadline can save this
    row; before the fix the window was the global 300 + 60 = 360 s, the row was
    failed as `executor lost mid-run`, and a `restart_retry` was enqueued while
    the original sandbox kept running.
    """
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "0")
    _worker(repos, "worker-1800", timeout_seconds=1800)
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(
        repos,
        "run-170264ee7906",
        "worker-1800",
        started=now - dt.timedelta(seconds=452),
    )
    scheduled = _capture_retries(monkeypatch, run_service)

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 0, "requeued": 0}
    row = repos.runs.get(user_id="user-a", run_id="run-170264ee7906")
    assert row["status"] == RunStatus.RUNNING.value
    assert row["error"] is None
    assert scheduled == []


def test_reaper_still_reaps_run_past_its_own_manifest_deadline(repo_bundle, monkeypatch):
    """The fix must not simply disable the reaper for long workers."""
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "0")
    _worker(repos, "worker-1800", timeout_seconds=1800)
    now = dt.datetime.now(dt.timezone.utc)
    # 1800 s timeout + 60 s grace = 1860 s; 1900 s is genuinely abandoned.
    _running_with_sandbox_log(
        repos,
        "run-really-lost",
        "worker-1800",
        started=now - dt.timedelta(seconds=1900),
    )
    scheduled = _capture_retries(monkeypatch, run_service)

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 1, "requeued": 1}
    row = repos.runs.get(user_id="user-a", run_id="run-really-lost")
    assert row["status"] == RunStatus.FAILED.value
    assert len(scheduled) == 1


def test_reaper_honours_default_worker_limit_of_900_seconds(repo_bundle, monkeypatch):
    """Blast radius is wider than the workers that declare 1800 s.

    `WorkerLimits.timeout_seconds` defaults to DEFAULT_RUN_TIMEOUT_SECONDS
    (900 s) while the reaper defaulted to 300 s, so *any* worker running longer
    than 360 s was eligible for a false reap.
    """
    import run_service
    from runtime_limits import DEFAULT_RUN_TIMEOUT_SECONDS

    assert DEFAULT_RUN_TIMEOUT_SECONDS == 900

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "0")
    _worker(repos, "worker-900", timeout_seconds=DEFAULT_RUN_TIMEOUT_SECONDS)
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(
        repos,
        "run-default-limits",
        "worker-900",
        started=now - dt.timedelta(seconds=600),
    )
    scheduled = _capture_retries(monkeypatch, run_service)

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 0, "requeued": 0}
    assert (
        repos.runs.get(user_id="user-a", run_id="run-default-limits")["status"]
        == RunStatus.RUNNING.value
    )
    assert scheduled == []


# ---------------------------------------------------------------------------
# B. durable-log liveness: never retry against a live original
# ---------------------------------------------------------------------------


def test_reaper_spares_run_with_fresh_durable_execution_activity(repo_bundle, monkeypatch):
    """A run emitting tool calls seconds ago is alive, whatever the clock says.

    In the incident the original logged `out/board.md` at 05:07:15 and was
    reaped at 05:08:21, 66 s later. Durable-execution log rows are written by
    the sandbox driver and are visible across processes, so they are a valid
    cross-executor heartbeat where the process-local `_active_runs` registry is
    not: in Cloud the reaper thread and the executor are different processes,
    so that registry is empty for another process' runs.

    The declared timeout is deliberately short and already exceeded, so only
    liveness can spare this row.
    """
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "600")
    _worker(repos, "worker-300", timeout_seconds=300)
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(
        repos,
        "run-alive",
        "worker-300",
        started=now - dt.timedelta(seconds=900),
        last_activity=now - dt.timedelta(seconds=20),
    )
    scheduled = _capture_retries(monkeypatch, run_service)

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 0, "requeued": 0}
    assert repos.runs.get(user_id="user-a", run_id="run-alive")["status"] == RunStatus.RUNNING.value
    assert scheduled == [], "must never retry against a demonstrably live original"


def test_reaper_reaps_run_whose_durable_activity_went_silent(repo_bundle, monkeypatch):
    """Liveness must expire: a silent executor is still recovered."""
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "600")
    _worker(repos, "worker-300", timeout_seconds=300)
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(
        repos,
        "run-silent",
        "worker-300",
        started=now - dt.timedelta(seconds=3000),
        last_activity=now - dt.timedelta(seconds=2400),
    )
    scheduled = _capture_retries(monkeypatch, run_service)

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 1, "requeued": 1}
    assert repos.runs.get(user_id="user-a", run_id="run-silent")["status"] == RunStatus.FAILED.value
    assert len(scheduled) == 1


def test_reaper_leaves_run_alone_when_its_worker_recipe_cannot_be_resolved(
    repo_bundle, monkeypatch
):
    """Unresolvable timeout must err long, not fall back to the 300 s default.

    Reaping a live run duplicates outbound side effects; reaping late only
    delays recovery. The fallback is still finite (the 3600 s ceiling) so a
    broken recipe cannot pin a row in `running` for ever.
    """
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "0")
    _worker(repos, "worker-broken", timeout_seconds=300)
    monkeypatch.setattr(
        run_service,
        "_load_worker_recipe",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("recipe unavailable")),
    )
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(
        repos,
        "run-unresolvable",
        "worker-broken",
        started=now - dt.timedelta(seconds=900),
    )
    scheduled = _capture_retries(monkeypatch, run_service)

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 0, "requeued": 0}
    assert scheduled == []


def test_startup_recovery_is_deliberately_exempt_from_both_guards(repo_bundle, monkeypatch):
    """The new guards must not slow a deploy down (#1434).

    `fail_interrupted_runs_on_startup` passes an explicit 0/0 window: the
    process has just booted, so every `running` row belongs to a dead
    predecessor and a log written a second ago is evidence of recent death, not
    of life. Both the deadline and the liveness guard are therefore skipped for
    explicit-window callers, and this run is recovered immediately despite an
    1800 s manifest timeout and one-second-old activity.
    """
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    _worker(repos, "worker-1800", timeout_seconds=1800)
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(
        repos,
        "run-boot",
        "worker-1800",
        started=now - dt.timedelta(seconds=1),
        last_activity=now - dt.timedelta(seconds=1),
    )
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **_kw: True)

    failed = run_service.fail_interrupted_runs_on_startup(user_id="ignored", repos=repos)

    assert failed == 1
    row = repos.runs.get(user_id="user-a", run_id="run-boot")
    assert row["error_code"] == "executor_lost_mid_run"


# ---------------------------------------------------------------------------
# C. one retry child per lineage+attempt, regardless of trigger_source
# ---------------------------------------------------------------------------


def test_retry_and_restart_retry_cannot_fork_sibling_children(repo_bundle, monkeypatch):
    """`_retry_run_id` hashes trigger_source, so the ids differ by construction.

    That is fine for addressing, but scheduling must still refuse the second
    child: in the incident the false `restart_retry` and the original's own
    `retry` both landed for attempt 1, producing two retry trees from one
    scheduled run.
    """
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    _worker(repos, "worker-1800", timeout_seconds=1800)
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(repos, "run-root", "worker-1800", started=now)

    restart_id = run_service._retry_run_id("run-root", 1, "restart_retry")
    plain_id = run_service._retry_run_id("run-root", 1, "retry")
    assert restart_id != plain_id, "precondition: ids fork on trigger_source"

    first = run_service._schedule_retry(
        original_run_id="run-root",
        worker_id="worker-1800",
        inputs={"q": "hello"},
        attempt=1,
        delay_seconds=0,
        user_id="user-a",
        repos=repos,
        trigger_source="restart_retry",
    )
    assert first is not False
    assert repos.runs.get_any(run_id=restart_id) is not None

    # The still-live original now hits its real timeout and asks for its own
    # retry of the SAME attempt. It must be refused, not forked.
    second = run_service._schedule_retry(
        original_run_id="run-root",
        worker_id="worker-1800",
        inputs={"q": "hello"},
        attempt=1,
        delay_seconds=0,
        user_id="user-a",
        repos=repos,
        trigger_source="retry",
    )

    assert second is False, "a second child for the same attempt must be refused"
    assert repos.runs.get_any(run_id=plain_id) is None


def test_second_attempt_is_still_allowed_after_a_sibling_completes_its_attempt(
    repo_bundle, monkeypatch
):
    """Lineage dedupe is per attempt, so genuine escalation still works."""
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    _worker(repos, "worker-1800", timeout_seconds=1800)
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(repos, "run-root", "worker-1800", started=now)

    assert (
        run_service._schedule_retry(
            original_run_id="run-root",
            worker_id="worker-1800",
            inputs={},
            attempt=1,
            delay_seconds=0,
            user_id="user-a",
            repos=repos,
            trigger_source="restart_retry",
        )
        is not False
    )
    # Attempt 2 is a different lineage slot and must not be blocked.
    assert (
        run_service._schedule_retry(
            original_run_id="run-root",
            worker_id="worker-1800",
            inputs={},
            attempt=2,
            delay_seconds=0,
            user_id="user-a",
            repos=repos,
            trigger_source="retry",
        )
        is not False
    )
    assert repos.runs.get_any(run_id=run_service._retry_run_id("run-root", 2, "retry")) is not None


# ---------------------------------------------------------------------------
# D. the reaper deadline must equal the DRIVER's deadline, not the manifest's
# ---------------------------------------------------------------------------


def _scheduled_agent_manifest(worker_id: str, timeout_seconds: int) -> dict:
    """A scheduled agent worker: `.md` entrypoint plus a cron trigger.

    `agent_driver._resolve_agent_timeout_seconds` raises the effective timeout
    of this shape to AGENT_SCHEDULED_TIMEOUT_SECONDS (1800), so the declared
    300 s is NOT the deadline the driver enforces.
    """
    return {
        "id": worker_id,
        "name": worker_id,
        "trigger": {"type": "schedule", "cron": "0 7 * * *"},
        "runtime": {
            "type": "python",
            "entrypoint": "agent.md",
            "runner": "e2b",
            "mode": "agent",
            "limits": {"timeout_seconds": timeout_seconds},
        },
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
    }


def test_reaper_matches_the_driver_deadline_for_scheduled_agent_workers(
    repo_bundle, monkeypatch
):
    """A scheduled agent declaring 300 s is really allowed 1800 s.

    Resolving only the manifest/workspace timeout here would leave exactly the
    #1232 defect in place for the most common worker shape on the platform: the
    reaper would fire at 360 s while the driver was still legitimately running.
    """
    import run_service
    from runtime_limits import AGENT_SCHEDULED_TIMEOUT_SECONDS, effective_agent_timeout_seconds

    assert AGENT_SCHEDULED_TIMEOUT_SECONDS == 1800
    assert effective_agent_timeout_seconds(300, scheduled=True) == 1800

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "0")
    repos.workers.create(
        user_id="user-a",
        worker_id="worker-sched-agent",
        name="worker-sched-agent",
        manifest_json=_scheduled_agent_manifest("worker-sched-agent", 300),
        bundle_path="workers/worker-sched-agent",
    )
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(
        repos,
        "run-sched-agent",
        "worker-sched-agent",
        started=now - dt.timedelta(seconds=600),
    )
    scheduled = _capture_retries(monkeypatch, run_service)

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 0, "requeued": 0}
    assert (
        repos.runs.get(user_id="user-a", run_id="run-sched-agent")["status"]
        == RunStatus.RUNNING.value
    )
    assert scheduled == []


# ---------------------------------------------------------------------------
# E. safety properties of the two extra reads the reaper now performs
# ---------------------------------------------------------------------------


def test_only_evaluated_rows_can_be_failed(repo_bundle, monkeypatch):
    """The candidate read and the failing update are two non-atomic queries.

    If the candidate read returns a truncated population (PostgREST caps rows),
    a row that was never checked against its own deadline must NOT be failed by
    the second query.
    """
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "0")
    _worker(repos, "worker-300", timeout_seconds=300)
    now = dt.datetime.now(dt.timezone.utc)
    for run_id in ("run-seen", "run-unseen"):
        _running_with_sandbox_log(
            repos, run_id, "worker-300", started=now - dt.timedelta(seconds=3000)
        )

    # Simulate a capped candidate read that only returns one of the two rows.
    real_list = repos.runs.list_stale_running
    monkeypatch.setattr(
        repos.runs,
        "list_stale_running",
        lambda **kw: [r for r in real_list(**kw) if r["run_id"] == "run-seen"],
    )
    _capture_retries(monkeypatch, run_service)

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result["failed"] == 1
    assert repos.runs.get(user_id="user-a", run_id="run-seen")["status"] == RunStatus.FAILED.value
    assert (
        repos.runs.get(user_id="user-a", run_id="run-unseen")["status"] == RunStatus.RUNNING.value
    ), "a row the reaper never evaluated must survive the sweep"


def test_truncated_liveness_probe_protects_rather_than_reaps(repo_bundle, monkeypatch):
    """A capped log scan cannot prove silence, so it must not authorise a reap.

    A chatty sibling run of the same worker fills the scan budget, so the quiet
    candidate's newest durable row may sit just past the cut. Treating "not
    seen" as "silent" there would reap a possibly-live run.
    """
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "600")
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_LOG_SCAN_LIMIT", "1")
    _worker(repos, "worker-300", timeout_seconds=300)
    now = dt.datetime.now(dt.timezone.utc)
    # The candidate: past its deadline, no activity inside the window.
    _running_with_sandbox_log(
        repos, "run-quiet", "worker-300", started=now - dt.timedelta(seconds=3000)
    )
    # A sibling run of the SAME worker, still inside its deadline, logging now.
    # Its row alone fills the 1-row scan budget.
    _running_with_sandbox_log(
        repos,
        "run-chatty",
        "worker-300",
        started=now - dt.timedelta(seconds=30),
        last_activity=now - dt.timedelta(seconds=5),
    )
    scheduled = _capture_retries(monkeypatch, run_service)

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 0, "requeued": 0}
    assert repos.runs.get(user_id="user-a", run_id="run-quiet")["status"] == RunStatus.RUNNING.value
    assert scheduled == []


def test_liveness_probe_failure_protects_rather_than_reaps(repo_bundle, monkeypatch):
    """An unreadable log store cannot prove silence either."""
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "600")
    _worker(repos, "worker-300", timeout_seconds=300)
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(
        repos, "run-unreadable", "worker-300", started=now - dt.timedelta(seconds=3000)
    )
    monkeypatch.setattr(
        repos.runs,
        "list_logs_for_worker",
        lambda **_kw: (_ for _ in ()).throw(RuntimeError("log store down")),
    )
    _capture_retries(monkeypatch, run_service)

    assert run_service.recover_abandoned_runs(repos=repos, now=now) == {
        "failed": 0,
        "requeued": 0,
    }


def test_future_dated_activity_cannot_protect_a_run_for_ever(repo_bundle, monkeypatch):
    """Clock skew must not turn one corrupt timestamp into a permanent shield."""
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    monkeypatch.setenv("WORKEROS_RUN_LIVENESS_WINDOW_SECONDS", "600")
    _worker(repos, "worker-300", timeout_seconds=300)
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(
        repos,
        "run-future",
        "worker-300",
        started=now - dt.timedelta(seconds=3000),
        # Far-future timestamp: `now - ts` is very negative and would satisfy a
        # one-sided "<= window" comparison for ever.
        last_activity=now + dt.timedelta(days=30),
    )
    _capture_retries(monkeypatch, run_service)

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result["failed"] == 1
    assert repos.runs.get(user_id="user-a", run_id="run-future")["status"] == RunStatus.FAILED.value


def test_unreadable_sibling_check_refuses_the_second_retry_child(repo_bundle, monkeypatch):
    """Fail closed: an unverifiable lineage must not gain a second child."""
    import run_service

    repos, _db, _manifest = repo_bundle
    _isolate_recipe_cache(monkeypatch)
    _worker(repos, "worker-1800", timeout_seconds=1800)
    now = dt.datetime.now(dt.timezone.utc)
    _running_with_sandbox_log(repos, "run-root", "worker-1800", started=now)

    calls = {"n": 0}
    real_get_any = repos.runs.get_any

    def flaky_get_any(*, run_id):
        # The first lookup (this source's own id) succeeds; the sibling lookup
        # raises, which is the case that used to fail open.
        calls["n"] += 1
        if calls["n"] >= 2:
            raise RuntimeError("read failed")
        return real_get_any(run_id=run_id)

    monkeypatch.setattr(repos.runs, "get_any", flaky_get_any)

    assert (
        run_service._schedule_retry(
            original_run_id="run-root",
            worker_id="worker-1800",
            inputs={},
            attempt=1,
            delay_seconds=0,
            user_id="user-a",
            repos=repos,
            trigger_source="retry",
        )
        is False
    )
