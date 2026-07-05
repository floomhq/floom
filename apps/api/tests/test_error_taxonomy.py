"""Failure error_code taxonomy: fill the "unknown" gap with meaningful codes.

Covers the additive taxonomy work:
  - e2b driver classifies an HTTP-status-bearing sandbox failure as
    upstream_http_4xx / upstream_http_5xx (else keeps e2b_sandbox_error).
  - run_service classifies an uncaught run crash (timeout / upstream http /
    sandbox) instead of the blanket run_execution_exception, and falls back to a
    worker_error code for a codeless worker failure result.
  - run_metrics maps every new code to a real category (never "unknown").
  - the connection telemetry resolves the app slug from the connection object.
"""
from __future__ import annotations

import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service
from runner_sandbox.e2b_driver import _sandbox_exception_result
from services import run_metrics
from routers.connections import _connection_app_slug


class _HttpError(Exception):
    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


# --- e2b driver upstream HTTP classification -------------------------------


def test_sandbox_upstream_4xx_is_classified():
    result = _sandbox_exception_result(
        _HttpError("bad request from provider", 403),
        elapsed_seconds=2.0,
        timeout_seconds=300,
    )
    assert result.error_code == "upstream_http_4xx"
    assert result.retryable is False


def test_sandbox_upstream_5xx_is_classified():
    result = _sandbox_exception_result(
        _HttpError("provider exploded", 502),
        elapsed_seconds=2.0,
        timeout_seconds=300,
    )
    assert result.error_code == "upstream_http_5xx"
    assert result.retryable is True


def test_sandbox_exception_without_status_stays_sandbox_error():
    # Regression guard for the existing #1065 behavior: no status -> unchanged.
    result = _sandbox_exception_result(
        RuntimeError("connection reset by peer"),
        elapsed_seconds=1.5,
        timeout_seconds=300,
    )
    assert result.error_code == "e2b_sandbox_error"


# --- run_service crash classification --------------------------------------


def test_classify_run_exception_timeout():
    assert run_service._classify_run_exception(TimeoutError("worker timed out")) == "timeout"


def test_classify_run_exception_http_status():
    assert run_service._classify_run_exception(_HttpError("nope", 404)) == "upstream_http_4xx"
    assert run_service._classify_run_exception(_HttpError("nope", 503)) == "upstream_http_5xx"


def test_classify_run_exception_sandbox():
    assert run_service._classify_run_exception(RuntimeError("sandbox died")) == "sandbox_crash"


def test_classify_run_exception_fallback_is_unchanged():
    # Nothing distinguishable -> keep the historical code (not "unknown").
    assert (
        run_service._classify_run_exception(RuntimeError("kaboom"))
        == "run_execution_exception"
    )


def test_worker_error_fallback_constant():
    assert run_service.WORKER_ERROR_CODE == "worker_error"


# --- run_metrics: new codes never fall into "unknown" ----------------------


def test_new_codes_have_real_categories():
    assert run_metrics.classify_failure(error_code="worker_error") == "crash"
    assert run_metrics.classify_failure(error_code="e2b_sandbox_error") == "crash"
    assert run_metrics.classify_failure(error_code="sandbox_crash") == "crash"
    assert run_metrics.classify_failure(error_code="upstream_http_4xx") == "network"
    assert run_metrics.classify_failure(error_code="upstream_http_5xx") == "network"


def test_worker_error_is_not_unknown():
    # The whole point: a worker failure with this code stops showing as "unknown".
    assert run_metrics.classify_failure(error_code="worker_error") != "unknown"


# --- connection telemetry app slug -----------------------------------------


def test_connection_app_slug_prefers_app_name():
    assert _connection_app_slug({"app_name": "gmail"}) == "gmail"


def test_connection_app_slug_falls_back_to_mcp_label():
    # MCP-kind rows carry the slug in mcp_label with an empty app_name; the old
    # code sent app: None for these.
    row = {"app_name": "", "mcp_label": "Notion MCP", "kind": "mcp"}
    assert _connection_app_slug(row) == "Notion MCP"


def test_connection_app_slug_uses_caller_fallback_first():
    assert _connection_app_slug({"app_name": "slack"}, fallback="gmail") == "gmail"


def test_connection_app_slug_empty_when_unknown():
    assert _connection_app_slug({"app_name": "", "mcp_label": ""}) == ""
    assert _connection_app_slug(None) == ""
