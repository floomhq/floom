"""Shared run retry and transient-infrastructure classification."""

from __future__ import annotations


PERMANENT_RETRY_ERROR_CODES = frozenset({
    "cancelled",
    "cancelled_before_start",
    "cancelled_queued",
    "invalid_outputs_shape",
    "invalid_worker",
    "llm_auth_error",
    "llm_model_not_configured",
    "llm_quota_exceeded",
    "missing_connection",
    "missing_required_input",
    "missing_secret",
    "output_token_limit",
    "output_too_large",
    "quality_gate_failed",
    "schema_violation",
    "spend_cap_exceeded",
    "token_cap_exceeded",
    "user_cancel",
    "worker_deleted",
    "worker_disabled",
    "worker_not_found",
})

TRANSIENT_RETRY_ERROR_CODES = frozenset({
    "agent_runtime_disconnected",
    "agent_runtime_error",
    "context_mount_failed",
    "e2b_quota_exhausted",
    "e2b_sandbox_error",
    "llm_provider_error",
    "llm_rate_limited",
    "interrupted_by_restart",
    "mcp_connect_failed",
    "orphaned",
    "run_abandoned_server_restart",
    "run_claimed_without_dispatch",
    "timeout",
})

PERMANENT_RETRY_CATEGORIES = frozenset({
    "auth",
    "cancelled",
    "config",
    "quality",
    "validation",
})

TRANSIENT_RETRY_CATEGORIES = frozenset({
    "network",
    "timeout",
})


def is_infra_retry_error_code(error_code: str | None) -> bool:
    """Return whether a structured failure code represents transient infra."""

    return (error_code or "").strip().lower() in TRANSIENT_RETRY_ERROR_CODES
