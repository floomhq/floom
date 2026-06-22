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
    _sandbox_resource_log_line,
    _sanitize_sandbox_exception_detail,
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


def test_h2_connection_terminated_repr_is_not_stored_in_run_error_1700():
    # #1700: an h2 transport drop surfaces its __repr__ as the exception message;
    # that raw library repr must NOT be persisted into run.error.
    class ConnectionTerminated(Exception):
        def __str__(self) -> str:
            return "<ConnectionTerminated error_code:1, last_stream_id:343, additional_data:None>"

    result = _sandbox_exception_result(
        ConnectionTerminated(), elapsed_seconds=1.5, timeout_seconds=300
    )

    assert result.error_code == "e2b_sandbox_error"
    assert result.error is not None
    # The raw repr (angle brackets + internal fields) must be gone; only the
    # collapsed class name remains.
    assert "<ConnectionTerminated" not in result.error
    assert "error_code:1" not in result.error
    assert "last_stream_id" not in result.error
    assert "ConnectionTerminated" in result.error


def test_sanitize_sandbox_exception_detail_collapses_library_repr_1700():
    assert (
        _sanitize_sandbox_exception_detail(
            "<ConnectionTerminated error_code:1, last_stream_id:343, additional_data:None>"
        )
        == "ConnectionTerminated"
    )
    # Plain human detail is untouched.
    assert _sanitize_sandbox_exception_detail("context deadline exceeded") == "context deadline exceeded"
    assert _sanitize_sandbox_exception_detail("") == ""


def test_sandbox_resource_log_line_does_not_leak_template_id_1700():
    # #1700: the E2B template id (e.g. gzm0071hrus9jwkse7w6) is an internal infra
    # identifier and must never appear in run logs.
    line = _sandbox_resource_log_line(None, "gzm0071hrus9jwkse7w6")
    assert "gzm0071hrus9jwkse7w6" not in line
    assert "custom template" in line
    # Still [e2b]-prefixed so the operator Logs tab filters it.
    assert line.startswith("[e2b]")

    default_line = _sandbox_resource_log_line(None, None)
    assert "E2B SDK default template" in default_line


def test_memory_diagnostics_detect_cgroup_oom_kill():
    diagnostics = "/sys/fs/cgroup/memory.events: low 0\nhigh 0\nmax 12\noom 1\noom_kill 1"

    assert _diagnostics_show_oom(diagnostics) is True


def test_memory_diagnostics_are_appended_to_error_message():
    error = _append_memory_diagnostics("Sandbox ran out of memory", "memory.events: oom_kill 1")

    assert "Sandbox ran out of memory" in error
    assert "Sandbox memory diagnostics" in error
    assert "oom_kill 1" in error
