"""Single source of truth for the PostHog event names + REQUIRED properties the
WorkerOS API actually EMITS.

WHY THIS EXISTS
---------------
The PostHog dashboards/insights in project **479185** (``WorkerOS Cloud``) are
built against specific event names and property keys. If a refactor renames a
property (``error_category`` -> ``failure_category``), drops one
(``cost_is_partial``), or removes an event, the dashboards rot SILENTLY — the
charts just go empty with no error anywhere. Codex flagged this as the gap:
"dashboards rot silently on drift."

``test_posthog_event_contract.py`` drives every real emit path with a stub
client and asserts the captured event name + properties match THIS contract,
failing CI on drift. So this file is the contract the code is held to AND the
contract the 479185 dashboards target — keep them in lockstep. When you
intentionally change an emitted event, update this contract in the same PR and
re-point the affected 479185 insight.

CONTRACT SHAPE
--------------
``EVENT_CONTRACT[event] = {"required_props": {...}, "emitter": "...", "surface": "..."}``

* ``required_props`` — keys that MUST be present on the captured event
  (presence, not value — a key set to ``None`` still counts as present; the
  spec deliberately sends explicit nulls for "null-unless-failed" outcome
  fields). Optional/situational props (e.g. ``output_bytes`` only on
  ``run_completed``) live in ``optional_props`` and are not asserted present.
* ``emitter`` — ``server`` (product events via ``analytics_posthog``, which
  injects ``schema_version``+``emitter``) or ``ai`` (AI-obs events via
  ``ai_observability``, which carry ``ai_schema_version``).
* The injected envelope keys (``schema_version``/``emitter`` for product,
  ``ai_schema_version`` for AI) are asserted by the test from these tags, not
  re-listed per event.

This contract reflects what the code emits TODAY. Events named in the spec but
NOT yet emitted by the code (e.g. ``approval_approved``/``approval_rejected``,
``worker_updated``) are intentionally ABSENT here so the contract never claims
coverage the code does not have. Add them when the emit path lands.
"""
from __future__ import annotations

from typing import Any, Dict

# Envelope keys auto-injected by each surface (asserted by the test per emitter).
# Product events get schema_version+emitter from analytics_posthog._base_properties.
# AI events route through the SAME funnel, so they carry schema_version+emitter
# TOO, plus their own ai_schema_version.
SERVER_ENVELOPE_PROPS = {"schema_version", "emitter"}
AI_ENVELOPE_PROPS = {"schema_version", "emitter", "ai_schema_version"}

# Canonical id keys that the test recognizes as identity props.
CANONICAL_IDS = {"run_id", "worker_id", "workspace_id", "approval_id"}

EMITTER_SERVER = "server"
EMITTER_AI = "ai"


EVENT_CONTRACT: Dict[str, Dict[str, Any]] = {
    # --- run lifecycle (server, run_service._emit_run_lifecycle_event) -------
    "run_started": {
        "emitter": EMITTER_SERVER,
        "surface": "run_service._emit_run_lifecycle_event",
        "required_props": {
            "run_id",
            "worker_id",
            "status",
            "trigger_source",
            "runner",
            "input_bytes",
            "input_present",
        },
        "optional_props": set(),
    },
    "run_completed": {
        "emitter": EMITTER_SERVER,
        "surface": "run_service._emit_run_lifecycle_event",
        "required_props": {
            "run_id",
            "worker_id",
            "status",
            "trigger_source",
            "runner",
            "duration_ms",
            "total_tokens",
            "total_cost_usd",
        },
        "optional_props": {"output_bytes"},
    },
    "run_failed": {
        "emitter": EMITTER_SERVER,
        "surface": "run_service._emit_run_lifecycle_event",
        "required_props": {
            "run_id",
            "worker_id",
            "status",
            "trigger_source",
            "runner",
            "duration_ms",
            "total_tokens",
            "total_cost_usd",
            "error_category",
            "error_code",
        },
        "optional_props": set(),
    },
    "run_cancelled": {
        "emitter": EMITTER_SERVER,
        "surface": "run_service._emit_run_lifecycle_event",
        "required_props": {
            "run_id",
            "worker_id",
            "status",
            "trigger_source",
            "runner",
            "duration_ms",
            "total_tokens",
            "total_cost_usd",
            "error_category",
            "error_code",
        },
        "optional_props": set(),
    },
    # --- worker lifecycle (server, services.worker_create) -------------------
    "worker_created": {
        "emitter": EMITTER_SERVER,
        "surface": "services.worker_create._emit_worker_created",
        "required_props": {
            "worker_id",
            "has_schedule",
            "tool_count",
            "runner",
        },
        "optional_props": set(),
    },
    # --- approvals (server, run_service._emit_approval_requested) ------------
    "approval_requested": {
        "emitter": EMITTER_SERVER,
        "surface": "run_service._emit_approval_requested",
        "required_props": {
            "approval_id",
            "run_id",
            "worker_id",
            "tool_name",
            "risk_level",
        },
        "optional_props": set(),
    },
    # --- AI observability (ai, services.ai_observability) --------------------
    # Trace = run-level rollup; carries the trace-derived cost provenance the
    # dashboards sum from (NEVER the sampled drill-down events).
    "$ai_trace": {
        "emitter": EMITTER_AI,
        "surface": "ai_observability.AITraceContext.finish",
        "required_props": {
            "$ai_trace_id",
            "run_id",
            "status",
            "generation_count",
            "span_count",
            "cost_source",
            "pricing_version",
            "cost_is_partial",
        },
        "optional_props": {
            "worker_id",
            "workspace_id",
            "total_tokens",
            "total_cost_usd",
            "total_input_tokens",
            "total_output_tokens",
            "unpriced_generation_count",
            "p95_step_latency_ms",
            "ai_error_count",
            "duration_ms",
            "$ai_span_id",
            "$ai_is_error",
            "totals_unsampled",
            "sample_rate",
            "$insert_id",
            "runner",
            "$session_id",
        },
    },
    "$ai_generation": {
        "emitter": EMITTER_AI,
        "surface": "ai_observability.AITraceContext.capture_generation",
        "required_props": {
            "$ai_trace_id",
            "$ai_span_id",
            "$insert_id",
            "$ai_model",
            "$ai_input_tokens",
            "$ai_output_tokens",
            "$ai_total_cost_usd",
            "cost_source",
            "pricing_version",
            "model_priced",
            "run_id",
        },
        "optional_props": {
            "$ai_provider",
            "$ai_parent_id",
            "$ai_cache_read_input_tokens",
            "$ai_is_error",
            "$ai_http_status",
            "$ai_latency",
            "worker_id",
            "workspace_id",
            "sample_rate",
            "sampled",
            "runner",
        },
    },
    "$ai_span": {
        "emitter": EMITTER_AI,
        "surface": "ai_observability.AITraceContext.capture_span",
        "required_props": {
            "$ai_trace_id",
            "$ai_span_id",
            "$insert_id",
            "$ai_span_name",
            "$ai_span_type",
            "run_id",
        },
        "optional_props": {
            "$ai_parent_id",
            "$ai_is_error",
            "$ai_latency",
            "worker_id",
            "workspace_id",
            "sample_rate",
            "sampled",
            "runner",
        },
    },
    "$exception": {
        "emitter": EMITTER_AI,
        "surface": "ai_observability.capture_exception",
        "required_props": {
            "$exception_list",
            "$exception_type",
            "$exception_message",
            "$exception_fingerprint",
            "$insert_id",
            "run_id",
        },
        "optional_props": {
            "worker_id",
            "workspace_id",
            "error_code",
            "error_category",
            "$ai_trace_id",
        },
    },
    "posthog_ingestion_canary": {
        "emitter": EMITTER_AI,
        "surface": "ai_observability.emit_ingestion_canary",
        "required_props": {
            "canary_source",
            "delivery_counters",
        },
        "optional_props": {"emitted_at_monotonic"},
    },
}


def event_names() -> "set[str]":
    return set(EVENT_CONTRACT)


def required_props(event: str) -> "set[str]":
    return set(EVENT_CONTRACT[event]["required_props"])


def envelope_props(event: str) -> "set[str]":
    """The auto-injected envelope keys expected for this event's emitter."""
    emitter = EVENT_CONTRACT[event]["emitter"]
    return set(SERVER_ENVELOPE_PROPS if emitter == EMITTER_SERVER else AI_ENVELOPE_PROPS)
