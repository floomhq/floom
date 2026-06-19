from __future__ import annotations

import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import main
from runner_sandbox.e2b_driver import (
    _append_memory_diagnostics,
    _diagnostics_show_oom,
    _sandbox_exception_result,
    _worker_result_failure_fields,
)


def test_worker_reported_failure_without_fields_gets_error_code_and_message():
    error, error_code = _worker_result_failure_fields(
        {"status": "error", "outputs": {}, "error": "", "error_code": ""}
    )

    assert error == "Worker reported failure without an error message."
    assert error_code == "worker_reported_error"


def test_worker_reported_failure_preserves_human_error_and_adds_code():
    error, error_code = _worker_result_failure_fields(
        {"status": "failed", "outputs": {}, "error": "PostHog query HTTP 403: forbidden"}
    )

    assert error == "PostHog query HTTP 403: forbidden"
    assert error_code == "worker_reported_error"


def test_fast_timeout_like_e2b_exception_is_sandbox_error_not_worker_timeout():
    exc = TimeoutError("context deadline exceeded while creating sandbox")

    result = _sandbox_exception_result(exc, elapsed_seconds=1.787, timeout_seconds=300)

    assert result.error_code == "e2b_sandbox_error"
    assert "before the worker timeout was reached" in (result.error or "")
    assert "300s timeout" not in (result.error or "")


def test_near_cap_timeout_like_e2b_exception_is_worker_timeout():
    exc = TimeoutError("context deadline exceeded")

    result = _sandbox_exception_result(exc, elapsed_seconds=291.0, timeout_seconds=300)

    assert result.error_code == "timeout"
    assert result.error == "Worker exceeded its 300s timeout and was stopped."


def test_e2b_sandbox_error_operator_message_is_not_timeout_headline():
    headline = main._operator_error_message(
        "E2B sandbox failed before the worker timeout was reached: context deadline exceeded",
        "e2b_sandbox_error",
    )

    assert headline == (
        "The sandbox could not start or stay connected. Try again, then check the E2B "
        "configuration if it repeats."
    )
    assert "too long" not in headline


def test_memory_diagnostics_detect_cgroup_oom_kill():
    diagnostics = "/sys/fs/cgroup/memory.events: low 0\nhigh 0\nmax 12\noom 1\noom_kill 1"

    assert _diagnostics_show_oom(diagnostics) is True


def test_memory_diagnostics_are_appended_to_error_message():
    error = _append_memory_diagnostics("Sandbox ran out of memory", "memory.events: oom_kill 1")

    assert "Sandbox ran out of memory" in error
    assert "Sandbox memory diagnostics" in error
    assert "oom_kill 1" in error
