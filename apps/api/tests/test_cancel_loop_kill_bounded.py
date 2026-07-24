"""The shutdown/worker-deletion cancel loop must stay within budget.

``_cancel_active_runs`` kills every active run's sandbox serially. The driver's
default control-plane kill timeout is 60s, so a single hung kill could blow the
whole shutdown budget (N runs x 60s). The loop now bounds each kill and stops
issuing kills once the overall budget is spent.
"""
from __future__ import annotations

import sys
import threading
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service
from runner_sandbox import e2b_driver


class _FakeRuns:
    def cancel(self, **_kwargs):
        return None

    def add_log(self, **_kwargs):
        return None


class _FakeRepos:
    def __init__(self):
        self.runs = _FakeRuns()


def _finished_thread() -> threading.Thread:
    t = threading.Thread(target=lambda: None)
    t.start()
    t.join()
    return t


def test_liveness_unconfirmed_is_never_retried_even_with_manifest_optin():
    """sandbox_liveness_unconfirmed is a safety terminal: a worker manifest that
    names it in retry.on (or retryable=True) must NOT force a re-dispatch, which
    would risk duplicating side effects."""

    class _RetryCfg:
        on = ["sandbox_liveness_unconfirmed"]
        max_attempts = 5

    decision = run_service._classify_retry_failure(
        error_code="sandbox_liveness_unconfirmed",
        error="sandbox could not be confirmed stopped",
        result_retryable=True,
        retry_cfg=_RetryCfg(),
    )
    assert decision.retryable is False
    assert decision.permanent is True
    assert decision.reason == "never_retry_safety"


def test_cancel_sandbox_forwards_bounded_request_timeout():
    kills: list[float] = []

    class _Sandbox:
        def kill(self, request_timeout=None, **_kwargs):
            kills.append(request_timeout)

    e2b_driver._register_sandbox("run-forward", _Sandbox())
    try:
        assert e2b_driver.cancel_sandbox("run-forward", request_timeout=7.5) is True
    finally:
        e2b_driver._active_sandboxes.pop("run-forward", None)
    assert kills == [7.5]


def test_shutdown_does_not_requeue_started_worker_runs(monkeypatch):
    """Graceful shutdown must not requeue a run whose worker command already
    started (re-running it would duplicate side effects). A pre-command run is
    still requeued."""
    # Each run thread waits until its sandbox is cancelled, then (like the real
    # executor) unregisters itself so the shutdown join sees it stop.
    stop_events = {"run-started": threading.Event(), "run-pre": threading.Event()}

    def fake_cancel(run_id, *, reason=None, request_timeout=None):
        stop_events[run_id].set()
        return True

    monkeypatch.setattr(e2b_driver, "cancel_sandbox", fake_cancel)

    requeued: list[str] = []
    monkeypatch.setattr(
        run_service,
        "_requeue_interrupted_run_in_place",
        lambda _repos, run_id, _user_id: (requeued.append(run_id) or True),
    )

    def make_thread(run_id: str) -> threading.Thread:
        def target():
            stop_events[run_id].wait(timeout=3)
            run_service._unregister_active_run(run_id)

        return threading.Thread(target=target)

    started = run_service._ActiveRun(
        run_id="run-started", worker_id="w", user_id="u", thread=make_thread("run-started")
    )
    started.worker_command_started = True
    pre_command = run_service._ActiveRun(
        run_id="run-pre", worker_id="w", user_id="u", thread=make_thread("run-pre")
    )

    run_service._register_active_run(started)
    run_service._register_active_run(pre_command)
    started.thread.start()
    pre_command.thread.start()
    try:
        run_service.request_active_run_shutdown(repos=_FakeRepos(), timeout_seconds=5.0)
    finally:
        run_service._unregister_active_run("run-started")
        run_service._unregister_active_run("run-pre")

    assert "run-started" not in requeued  # started worker never re-run
    assert "run-pre" in requeued  # pre-command run safely requeued


def test_mark_run_worker_command_started_sets_flag():
    run = run_service._ActiveRun(
        run_id="run-mark", worker_id="w", user_id="u", thread=_finished_thread()
    )
    run_service._register_active_run(run)
    try:
        assert run.worker_command_started is False
        run_service.mark_run_worker_command_started("run-mark")
        assert run.worker_command_started is True
    finally:
        run_service._unregister_active_run("run-mark")


def test_cancel_loop_is_time_bounded_on_hung_kills(monkeypatch):
    # Fake clock so each kill "takes" long enough to blow a 1s budget.
    clock = [1000.0]
    monkeypatch.setattr(run_service.time, "monotonic", lambda: clock[0])

    calls: list[tuple[str, float]] = []

    def fake_cancel(run_id, *, reason=None, request_timeout=None):
        calls.append((run_id, request_timeout))
        clock[0] += 5.0  # a hung/slow kill consumes 5s of wall time
        return True

    monkeypatch.setattr(e2b_driver, "cancel_sandbox", fake_cancel)

    active = [
        run_service._ActiveRun(
            run_id=f"run-{i}",
            worker_id="w",
            user_id="u",
            thread=_finished_thread(),
        )
        for i in range(4)
    ]

    run_service._cancel_active_runs(
        active,
        repos=_FakeRepos(),
        timeout_seconds=1.0,
        reason="shutdown",
        mark_shutdown_cancelled=False,
    )

    # Only the first run is killed before the 1s budget is exhausted; the rest
    # are skipped (handled by thread-join + startup recovery), so the loop does
    # NOT run for 4 x 60s.
    assert len(calls) == 1
    run_id, request_timeout = calls[0]
    assert run_id == "run-0"
    # Each kill timeout is bounded by both the per-call cap and remaining budget.
    assert request_timeout is not None
    assert request_timeout <= run_service._CANCEL_LOOP_SANDBOX_KILL_REQUEST_TIMEOUT_SECONDS
    assert request_timeout <= 1.0
