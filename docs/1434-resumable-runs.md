# #1434 - In-flight runs abandoned on API/executor restart

## Problem
Worker runs execute in process-local threads (`run_service._active_runs`) that
drive an E2B sandbox via a **blocking** `sandbox.commands.run(...)`
(`runner_sandbox/e2b_driver.py`). A restart/deploy kills those threads, so the
`running` rows are orphaned and reaped as
`run abandoned (server restarted): no active executor after timeout window`.
For interactive workers (e.g. Search Assistant, ~1-4 min/run) any deploy during a run
surfaced a hard failure with no recovery.

## What is implemented (this change) - auto-requeue, tested

Issue fix option #2 ("automatic retry on abandoned"), fully wired and unit-tested.

- `run_service.recover_abandoned_runs()` = reap stale `running` rows (existing
  behaviour) **plus** enqueue a bounded retry for each, so the user's work
  completes on a fresh run instead of dying. Returns `{"failed", "requeued"}`.
- Wiring:
  - **Startup** (`fail_interrupted_runs_on_startup`) now recovers immediately
    (`timeout=0, grace=0`): at boot the active-run registry is empty, so every
    `running` row is definitionally orphaned and is requeued at once. This is the
    main deploy/hard-restart fix.
  - **Periodic reaper loop** calls `recover_abandoned_runs()` instead of a bare
    reap.
  - **Startup zombie sweep** (`main.py` lifespan) uses `recover_abandoned_runs`.
- **Loop-safe bound:** the retry run is tagged `trigger_source="restart_retry"`;
  a run that is itself a `restart_retry` is never recovered again. This bounds
  recovery to one attempt per lineage and is robust even though
  `RunsRepository.create()` does not persist `retry_attempt` (a latent gap - see
  below). `WORKEROS_MAX_RESTART_RETRIES` (default 1) and
  `WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS` (default on) tune/disable it.
- Reuses the existing cross-backend retry plumbing (`_schedule_retry` ->
  `repos.runs.create(retry_of_run_id=...)` -> `start_run`), so it works on both
  the SQLite and Supabase (cloud) repositories with **no schema/Protocol change**.
- Tests: `tests/db/test_run_reaper.py` (requeue within budget, no-loop on a
  `restart_retry`, disable flag) + existing retry/reaper tests still green.

## What is NOT yet implemented (needs live infra to verify)

### 1. Graceful-SIGTERM-interrupted runs (deploy with a clean shutdown)
On SIGTERM the lifespan calls `request_active_run_shutdown` (30s budget), which
marks in-flight runs cancelled/interrupted (not `running`), so the startup
recovery above does not see them. To requeue these we must, in the shutdown
path, set eligible in-flight runs back to `queued` (tagged `restart_retry`)
**in place** rather than cancelling them - carefully, to avoid racing the run
thread that may also try to mark the row failed as the process exits. This
touches the shutdown critical path and needs the live server lifecycle to verify
(cannot be exercised on the Windows dev host / without E2B).

### 2. True in-place sandbox reconnect (issue fix option #1 - "resumable runs")
"Reconnect to the live E2B sandbox by id and continue the SAME execution"
requires changing the executor from the current **blocking** `commands.run()` to
**background** execution:
- run the worker command with `background=True`, capture the command PID;
- persist `sandbox_id` + PID (+ a log/output offset) on the run row;
- on startup, for each orphaned `running` row: `Sandbox.connect(sandbox_id)`,
  `sandbox.commands.connect(pid)`, resume streaming logs from the offset to
  completion; only if connect fails (sandbox expired/gone) fall back to the
  auto-requeue above;
- graceful shutdown then *detaches* instead of killing, so the sandbox survives
  the deploy and the next boot re-attaches.

This is a re-architecture of the most critical code path and is untestable
without E2B credentials + the sandbox service, so it is intentionally deferred
rather than shipped blind. The auto-requeue above is the safe, verifiable
recovery in the meantime (re-runs fresh rather than resuming, which for
idempotent workers is equivalent and for all workers is strictly better than a
hard failure).

### Related latent gap found
`RunsRepository.create()` (`db/sqlite.py`) does not include `retry_attempt` /
`retry_of_run_id` in its INSERT column list, so retry runs persist
`retry_attempt=0`. The worker-failure retry path bounds on that column; worth a
separate fix (add both columns to the insert on the SQLite + Supabase repos).
The #1434 recovery here deliberately does not rely on it (bounds on
`trigger_source` instead).
