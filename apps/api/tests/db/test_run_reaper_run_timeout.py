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
   `restart_retry` used to be able to fork sibling children for one attempt.

Every test here calls `recover_abandoned_runs()` WITHOUT `timeout_seconds`,
which is exactly how the production reaper thread invokes it
(`_run_reaper_loop`); the existing suite always passes 300 explicitly and so
never exercised the global-default fallback.
"""

from __future__ import annotations

import datetime as dt

from models import RunStatus


def _long_timeout_manifest(worker_id: str, name: str, timeout_seconds: int = 1800) -> dict:
    """Manifest mirroring `daily-outlier-idea-agent`: an explicit 1800 s limit."""
    return {
        "id": worker_id,
        "name": name,
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


def _create_long_worker(repos, *, timeout_seconds: int = 1800) -> None:
    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=_long_timeout_manifest("worker-a", "Worker A", timeout_seconds),
        bundle_path="workers/worker-a",
    )


def _running(repos, run_id: str, *, started: str, retry_attempt: int = 0) -> None:
    repos.runs.create(
        user_id="user-a",
        run_id=run_id,
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at=started,
        trigger_source="schedule",
        runner="e2b",
        input_json={"q": "hello"},
        retry_attempt=retry_attempt,
    )


# ---------------------------------------------------------------------------
# A. per-run timeout, not the global 300 s default
# ---------------------------------------------------------------------------


def test_reaper_honours_manifest_timeout_and_spares_run_inside_its_deadline(
    repo_bundle, monkeypatch
):
    """The exact #1232 scenario: 452 s into an 1800 s worker.

    Before the fix the reaper window was 300 + 60 = 360 s, so this row was
    failed as `executor lost mid-run` and a `restart_retry` was enqueued while
    the original sandbox kept running.
    """
    import run_service

    repos, _db, _manifest = repo_bundle
    _create_long_worker(repos, timeout_seconds=1800)
    now = dt.datetime.now(dt.timezone.utc)
    started = (now - dt.timedelta(seconds=452)).isoformat()
    _running(repos, "run-170264ee7906", started=started)

    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw) or True)
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    monkeypatch.setenv("WORKEROS_MAX_RESTART_RETRIES", "1")

    # No timeout_seconds: the production reaper-thread call path.
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
    _create_long_worker(repos, timeout_seconds=1800)
    now = dt.datetime.now(dt.timezone.utc)
    # 1800 s timeout + 60 s grace = 1860 s; 1900 s is genuinely abandoned.
    started = (now - dt.timedelta(seconds=1900)).isoformat()
    _running(repos, "run-really-lost", started=started)

    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw) or True)
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    monkeypatch.setenv("WORKEROS_MAX_RESTART_RETRIES", "1")

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 1, "requeued": 1}
    row = repos.runs.get(user_id="user-a", run_id="run-really-lost")
    assert row["status"] == RunStatus.FAILED.value
    assert len(scheduled) == 1


def test_reaper_honours_default_worker_limit_of_900_seconds(repo_bundle, monkeypatch):
    """Blast radius is wider than the 1800 s workers.

    `WorkerLimits.timeout_seconds` defaults to DEFAULT_RUN_TIMEOUT_SECONDS
    (900 s) while the reaper defaulted to 300 s, so *any* worker running longer
    than 360 s was eligible for a false reap.
    """
    import run_service
    from runtime_limits import DEFAULT_RUN_TIMEOUT_SECONDS

    assert DEFAULT_RUN_TIMEOUT_SECONDS == 900

    repos, _db, _manifest = repo_bundle
    _create_long_worker(repos, timeout_seconds=DEFAULT_RUN_TIMEOUT_SECONDS)
    now = dt.datetime.now(dt.timezone.utc)
    started = (now - dt.timedelta(seconds=600)).isoformat()
    _running(repos, "run-default-limits", started=started)

    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 0, "requeued": 0}
    assert (
        repos.runs.get(user_id="user-a", run_id="run-default-limits")["status"]
        == RunStatus.RUNNING.value
    )


# ---------------------------------------------------------------------------
# B. durable-log liveness: never retry against a live original
# ---------------------------------------------------------------------------


def test_reaper_spares_run_with_fresh_durable_execution_activity(repo_bundle, monkeypatch):
    """A run emitting tool calls seconds ago is alive, whatever the clock says.

    In the incident the original logged `out/board.md` at 05:07:15 and was
    reaped at 05:08:21, 66 s later. Durable-execution log rows are written by
    the sandbox driver and are visible across processes, so they are a valid
    cross-executor heartbeat where the process-local `_active_runs` registry is
    not.
    """
    import run_service

    repos, _db, _manifest = repo_bundle
    # Short declared timeout, so only liveness can save this row.
    _create_long_worker(repos, timeout_seconds=300)
    now = dt.datetime.now(dt.timezone.utc)
    started = (now - dt.timedelta(seconds=900)).isoformat()
    _running(repos, "run-alive", started=started)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-alive",
        level="info",
        message="Tool call: GMAIL_SEND_EMAIL",
        timestamp=(now - dt.timedelta(seconds=20)).isoformat(),
    )

    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw) or True)
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    monkeypatch.setenv("WORKEROS_MAX_RESTART_RETRIES", "1")

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 0, "requeued": 0}
    assert repos.runs.get(user_id="user-a", run_id="run-alive")["status"] == RunStatus.RUNNING.value
    assert scheduled == [], "must never retry against a demonstrably live original"


def test_reaper_reaps_run_whose_durable_activity_went_silent(repo_bundle, monkeypatch):
    """Liveness must expire: a silent executor is still recovered."""
    import run_service

    repos, _db, _manifest = repo_bundle
    _create_long_worker(repos, timeout_seconds=300)
    now = dt.datetime.now(dt.timezone.utc)
    started = (now - dt.timedelta(seconds=3000)).isoformat()
    _running(repos, "run-silent", started=started)
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-silent",
        level="info",
        message="Tool call: GMAIL_SEND_EMAIL",
        timestamp=(now - dt.timedelta(seconds=2400)).isoformat(),
    )

    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kw: scheduled.append(kw) or True)
    monkeypatch.setenv("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1")
    monkeypatch.setenv("WORKEROS_MAX_RESTART_RETRIES", "1")

    result = run_service.recover_abandoned_runs(repos=repos, now=now)

    assert result == {"failed": 1, "requeued": 1}
    assert repos.runs.get(user_id="user-a", run_id="run-silent")["status"] == RunStatus.FAILED.value


# ---------------------------------------------------------------------------
# C. one retry child per lineage+attempt, regardless of trigger_source
# ---------------------------------------------------------------------------


def test_retry_and_restart_retry_cannot_fork_sibling_children(repo_bundle):
    """`_retry_run_id` hashes trigger_source, so the ids differ by construction.

    That is fine for addressing, but scheduling must still refuse the second
    child: in the incident the false `restart_retry` and the original's own
    `retry` both landed for attempt 1, producing two retry trees from one
    scheduled run.
    """
    import run_service

    repos, _db, _manifest = repo_bundle
    _create_long_worker(repos)
    _running(repos, "run-root", started=dt.datetime.now(dt.timezone.utc).isoformat())

    restart_id = run_service._retry_run_id("run-root", 1, "restart_retry")
    plain_id = run_service._retry_run_id("run-root", 1, "retry")
    assert restart_id != plain_id, "precondition: ids fork on trigger_source"

    first = run_service._schedule_retry(
        original_run_id="run-root",
        worker_id="worker-a",
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
        worker_id="worker-a",
        inputs={"q": "hello"},
        attempt=1,
        delay_seconds=0,
        user_id="user-a",
        repos=repos,
        trigger_source="retry",
    )

    assert second is False, "a second child for the same attempt must be refused"
    assert repos.runs.get_any(run_id=plain_id) is None

    children = [
        r
        for r in repos.runs.list_all_ids(user_id="user-a")
        if str(r.get("id") or r.get("run_id") or "") in {restart_id, plain_id}
    ]
    assert len(children) == 1, f"exactly one retry child per attempt, got {children}"
