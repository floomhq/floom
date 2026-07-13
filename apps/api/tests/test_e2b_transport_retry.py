from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerResult
from runner_sandbox import e2b_driver
from runner_sandbox.e2b_driver import (
    E2BSandboxDriver,
    E2BTransportDroppedError,
    _is_transient_e2b_transport_error,
    _pace_sandbox_create,
)


def test_transient_transport_classifier_matches_observed_errors():
    assert _is_transient_e2b_transport_error(RuntimeError("Server disconnected")) is True
    assert _is_transient_e2b_transport_error(RuntimeError("[Errno 32] Broken pipe")) is True

    class ConnectionTerminated(Exception):
        def __str__(self) -> str:
            return "<ConnectionTerminated error_code:1, last_stream_id:343>"

    assert _is_transient_e2b_transport_error(ConnectionTerminated()) is True
    assert _is_transient_e2b_transport_error(RuntimeError("worker raised ValueError")) is False


class _RetryDriver(E2BSandboxDriver):
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def _run_in_sandbox(self, *_args, **_kwargs):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def test_transport_drop_retries_with_fresh_sandbox_before_failing_run(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_RETRY_BASE_SECONDS", "0")
    monkeypatch.setattr(e2b_driver, "run_cancel_requested", lambda _run_id: False)

    driver = _RetryDriver(
        [
            E2BTransportDroppedError(RuntimeError("Server disconnected"), phase="worker_command"),
            WorkerResult(status="success", outputs={"ok": True}),
        ]
    )
    logs: list[tuple[str, str]] = []

    result = driver.run(
        worker_id="worker-a",
        run_id="run-a",
        inputs={},
        secrets={},
        log_fn=lambda msg, level="info": logs.append((msg, level)),
        trace_id="trace-a",
    )

    assert driver.calls == 2
    assert result.status == "success"
    assert result.outputs == {"ok": True}
    assert any("retrying sandbox attempt 2/3" in msg for msg, _level in logs)


def test_transport_retry_exhaustion_has_distinct_terminal_code(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_MAX_ATTEMPTS", "2")
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_RETRY_BASE_SECONDS", "0")
    monkeypatch.setattr(e2b_driver, "run_cancel_requested", lambda _run_id: False)

    driver = _RetryDriver(
        [
            E2BTransportDroppedError(RuntimeError("Server disconnected"), phase="worker_command"),
            E2BTransportDroppedError(RuntimeError("[Errno 32] Broken pipe"), phase="worker_command"),
        ]
    )

    result = driver.run(
        worker_id="worker-a",
        run_id="run-a",
        inputs={},
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace-a",
    )

    assert driver.calls == 2
    assert result.status == "error"
    assert result.error_code == "sandbox_transport_retry_exhausted"
    assert result.retryable is False
    assert "before the worker produced a result" in (result.error or "")


def test_sandbox_create_pacing_waits_between_creates(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_CREATE_MIN_INTERVAL_SECONDS", "1.0")
    monkeypatch.setattr(e2b_driver, "_last_sandbox_create_at", 99.5)
    now = [100.0]
    sleeps: list[float] = []

    monkeypatch.setattr(e2b_driver.time, "monotonic", lambda: now[0])

    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(e2b_driver.time, "sleep", fake_sleep)

    _pace_sandbox_create(lambda *_args, **_kwargs: None)

    assert sleeps == [0.5]
    assert e2b_driver._last_sandbox_create_at == 100.5
