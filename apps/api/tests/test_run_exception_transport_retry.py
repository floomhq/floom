from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service


class _Runs:
    def __init__(self, retry_attempt: int = 0):
        self.retry_attempt = retry_attempt

    def get_any(self, *, run_id: str):
        return {"id": run_id, "retry_attempt": self.retry_attempt}


class _Repos:
    def __init__(self, retry_attempt: int = 0):
        self.runs = _Runs(retry_attempt=retry_attempt)


@pytest.mark.parametrize(
    "message",
    (
        "Server disconnected",
        "<ConnectionTerminated error_code:1, last_stream_id:343, additional_data:None>",
        "[Errno 104] Connection reset by peer",
        "[Errno 32] Broken pipe",
    ),
)
def test_observed_transport_disconnects_are_classified_retryable(message):
    error_code = run_service._classify_run_exception(RuntimeError(message))

    assert error_code == "transient_network_error"
    decision = run_service._classify_retry_failure(error_code=error_code)
    assert decision.retryable is True
    assert decision.category == "network"


def test_unknown_outer_exception_stays_crash_and_is_not_scheduled(monkeypatch):
    scheduled: list[dict] = []
    monkeypatch.setattr(
        run_service,
        "_schedule_retry_for_failed_run",
        lambda **kwargs: scheduled.append(kwargs) or True,
    )

    error_code = run_service._classify_run_exception(RuntimeError("worker invariant violated"))
    final_code = run_service._retry_run_exception(
        run_id="run-unknown",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        error_code=error_code,
        error="worker invariant violated",
        execution_stage="driver_run",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert error_code == "run_execution_exception"
    assert run_service._classify_retry_failure(error_code=error_code).category == "crash"
    assert final_code == "run_execution_exception"
    assert scheduled == []


def test_transient_outer_exception_uses_bounded_retry_scheduler(monkeypatch):
    scheduled: list[dict] = []
    monkeypatch.setattr(
        run_service,
        "_schedule_retry_for_failed_run",
        lambda **kwargs: scheduled.append(kwargs) or True,
    )

    final_code = run_service._retry_run_exception(
        run_id="run-transport",
        worker_id="worker-a",
        inputs={"query": "status"},
        owner_id="user-a",
        config=None,
        error_code="transient_network_error",
        error="Server disconnected",
        execution_stage="driver_run",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert final_code == "transient_network_error"
    assert len(scheduled) == 1
    assert scheduled[0]["result_retryable"] is True
    assert scheduled[0]["result_error_code"] == "transient_network_error"


def test_transport_disconnect_after_driver_return_is_not_retried(monkeypatch):
    scheduled: list[dict] = []
    monkeypatch.setattr(
        run_service,
        "_schedule_retry_for_failed_run",
        lambda **kwargs: scheduled.append(kwargs) or True,
    )

    final_code = run_service._retry_run_exception(
        run_id="run-post-driver",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        error_code="transient_network_error",
        error="Server disconnected",
        execution_stage="driver_returned",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert final_code == "transient_network_error"
    assert scheduled == []


def test_transport_retry_exhaustion_has_clear_terminal_code(monkeypatch):
    monkeypatch.delenv("WORKEROS_INFRA_RETRY_MAX_ATTEMPTS", raising=False)
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    final_code = run_service._retry_run_exception(
        run_id="run-transport-final",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        error_code="transient_network_error",
        error="Server disconnected",
        execution_stage="driver_run",
        repos=_Repos(retry_attempt=2),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert final_code == "transient_network_retry_exhausted"
    assert scheduled == []
    decision = run_service._classify_retry_failure(error_code=final_code)
    assert decision.retryable is False
    assert decision.category == "network"
