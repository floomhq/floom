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
