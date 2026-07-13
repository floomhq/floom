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

import json

import run_service
from runner_sandbox.e2b_driver import (
    _recover_worker_reported_failure,
    _sandbox_exception_result,
)
from services import run_metrics
from routers.connections import _connection_app_slug


class _HttpError(Exception):
    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


class _FakeSandboxFiles:
    def __init__(self, payload):
        self._payload = payload

    def read(self, _path):
        if self._payload is None:
            raise FileNotFoundError("no result.json")
        return self._payload


class _FakeSandbox:
    def __init__(self, payload):
        self.files = _FakeSandboxFiles(payload)


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
    assert run_metrics.classify_failure(error_code="sandbox_transport_retry_exhausted") == "crash"
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


# --- non-zero-exit result.json recovery (the main "unknown" source) ---------


def _noop_log(_msg, _level="info"):
    pass


def test_recover_worker_reported_code_on_nonzero_exit():
    # Worker wrote a structured failure result then sys.exit(1). The driver must
    # recover the worker's OWN error_code instead of flattening to execution_error.
    payload = json.dumps(
        {
            "status": "error",
            "outputs": {},
            "error": "Unipile rejected the LinkedIn account",
            "error_code": "connection_rejected",
        }
    )
    recovered = _recover_worker_reported_failure(
        _FakeSandbox(payload), "/w/result.json", _noop_log
    )
    assert recovered == ("Unipile rejected the LinkedIn account", "connection_rejected")


def test_recover_worker_failure_without_code_gets_worker_reported():
    payload = json.dumps({"status": "failed", "outputs": {}, "error": "boom"})
    recovered = _recover_worker_reported_failure(
        _FakeSandbox(payload), "/w/result.json", _noop_log
    )
    assert recovered == ("boom", "worker_reported_error")


def test_recover_returns_none_when_no_result_json():
    # No result.json -> caller keeps execution_error.
    assert (
        _recover_worker_reported_failure(_FakeSandbox(None), "/w/result.json", _noop_log)
        is None
    )


def test_recover_returns_none_for_successful_result():
    # A worker that exited non-zero but wrote a success result is NOT a
    # worker-reported failure; caller keeps execution_error.
    payload = json.dumps({"status": "success", "outputs": {"ok": True}})
    assert (
        _recover_worker_reported_failure(_FakeSandbox(payload), "/w/result.json", _noop_log)
        is None
    )


# --- auth-rejection code inference from a codeless message ------------------


def test_infer_connection_rejected_from_auth_message():
    assert run_service._infer_failure_code_from_message("HTTP 401 Unauthorized") == "connection_rejected"
    assert run_service._infer_failure_code_from_message("token invalid: 403 Forbidden") == "connection_rejected"
    assert run_service._infer_failure_code_from_message("invalid api key") == "connection_rejected"


def test_infer_returns_none_for_non_auth_message():
    assert run_service._infer_failure_code_from_message("KeyError: 'x'") is None
    assert run_service._infer_failure_code_from_message("") is None
    assert run_service._infer_failure_code_from_message(None) is None


def test_connection_rejected_classifies_as_auth():
    assert run_metrics.classify_failure(error_code="connection_rejected") == "auth"
