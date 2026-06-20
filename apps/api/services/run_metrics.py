"""Post-hoc run metrics: trustworthy duration aggregation + failure taxonomy.

These are pure helpers used by the worker- and workspace-stats endpoints. They
exist to keep the headline analytics honest in the presence of orphaned /
never-properly-closed runs and a long tail of raw failure strings.

Two problems this module solves:

1. **Duration outliers.** A run's ``duration_ms`` is wall-clock
   ``completed_at - started_at``. If a run is orphaned (sandbox hangs, the drain
   loop dies, a reaper marks it failed hours later) the stored duration can be
   many hours even though the worker timeout is at most
   ``MAX_RUN_TIMEOUT_SECONDS`` (1 h by default). A single such run makes a plain
   ``mean`` and ``p95`` meaningless. We therefore drop durations that exceed the
   absolute timeout ceiling by a sane factor before aggregating, and report a
   ``median`` alongside the (filtered) mean and p95.

2. **No failure taxonomy.** Failures historically surfaced only as the most
   recent raw ``error`` string. ``classify_failure`` maps a run's
   ``error_code`` / ``error`` to a small, stable set of categories so the stats
   endpoints can return a ``failures_by_category`` breakdown.

Everything here is generic — no client names, no secrets, no tenant assumptions.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional

try:  # pragma: no cover - import shim for the absolute timeout ceiling
    from runtime_limits import MAX_RUN_TIMEOUT_SECONDS
except Exception:  # pragma: no cover
    MAX_RUN_TIMEOUT_SECONDS = 3600

# A duration is treated as an orphaned/never-closed outlier (and excluded from
# avg/p95/median) once it exceeds the absolute run-timeout ceiling by this
# factor. The ceiling is the longest a *legitimately* running run can last; a
# small multiplier tolerates teardown/reaper slack without admitting the
# multi-hour stuck runs that poison the headline.
DURATION_OUTLIER_TIMEOUT_FACTOR = 2

# Stable failure categories. Order is the reporting order; "unknown" is the
# catch-all and MUST stay last.
FAILURE_CATEGORIES = (
    "timeout",
    "crash",
    "config",
    "auth",
    "network",
    "resource",
    "validation",
    "quality",
    "cancelled",
    "unknown",
)

# error_code -> category. Codes come from run_service / the sandbox drivers.
_ERROR_CODE_CATEGORY: Dict[str, str] = {
    # timeouts
    "timeout": "timeout",
    "tool_iteration_cap_exceeded": "timeout",
    # process / sandbox crashes
    "agent_runtime_error": "crash",
    "run_execution_exception": "crash",
    "execution_error": "crash",
    "executor_thread_pre_sandbox_exception": "crash",
    "approval_loop_killed": "crash",
    "worker_reported_error": "crash",
    "invalid_result_json": "crash",
    "missing_result": "crash",
    # configuration / worker definition problems
    "invalid_worker": "config",
    "worker_not_found": "config",
    "worker_deleted": "config",
    "worker_disabled": "config",
    "missing_required_input": "config",
    "install_failed": "config",
    "context_mount_failed": "config",
    # auth / credentials
    "missing_secret": "auth",
    "missing_connection": "auth",
    # network / external connectivity
    "mcp_connect_failed": "network",
    # resource limits
    "sandbox_oom": "resource",
    "output_too_large": "resource",
    "output_token_limit": "resource",
    "token_cap_exceeded": "resource",
    "spend_cap_exceeded": "resource",
    # output / schema validation
    "invalid_outputs_shape": "validation",
    "schema_violation": "validation",
    # quality gates
    "quality_gate_failed": "quality",
    # cancellations (operator/user, not a real failure)
    "cancelled": "cancelled",
    "cancelled_before_start": "cancelled",
    "cancelled_queued": "cancelled",
    "user_cancel": "cancelled",
}

# Substrings matched against the raw error message when error_code is absent or
# already "unknown_error". Lowercased contains-match, first hit wins. Order
# matters: more specific phrases first.
_MESSAGE_SUBSTR_CATEGORY = (
    ("exceeded timeout", "timeout"),
    ("timed out", "timeout"),
    ("deadline exceeded", "timeout"),
    ("server disconnected", "crash"),
    ("connection reset", "crash"),
    ("sandbox", "crash"),
    ("traceback", "crash"),
    ("path traversal", "crash"),
    ("out of memory", "resource"),
    ("oom", "resource"),
    ("token", "resource"),
    ("spend cap", "resource"),
    ("missing secret", "auth"),
    ("unauthorized", "auth"),
    ("forbidden", "auth"),
    ("permission denied", "auth"),
    ("connection refused", "network"),
    ("name resolution", "network"),
    ("dns", "network"),
    ("network", "network"),
    ("schema", "validation"),
    ("validation", "validation"),
    ("invalid", "validation"),
    ("cancel", "cancelled"),
)


def classify_failure(
    error_code: Optional[str] = None,
    error: Optional[str] = None,
) -> str:
    """Map a failed run's ``error_code`` / ``error`` to a stable category.

    Prefers ``error_code`` (the structured field). Falls back to substring
    matching the raw message when the code is missing or the generic
    ``unknown_error`` fallback. Returns ``"unknown"`` when nothing matches.
    """
    code = (error_code or "").strip().lower()
    if code and code not in {"unknown_error", "unknown"}:
        mapped = _ERROR_CODE_CATEGORY.get(code)
        if mapped:
            return mapped
    msg = (error or "").strip().lower()
    if msg:
        for needle, category in _MESSAGE_SUBSTR_CATEGORY:
            if needle in msg:
                return category
    return "unknown"


def failures_by_category(failed_runs: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    """Count failed runs per category. Only non-zero categories are returned."""
    counts: Dict[str, int] = {}
    for run in failed_runs:
        category = classify_failure(
            error_code=run.get("error_code"),
            error=run.get("error"),
        )
        counts[category] = counts.get(category, 0) + 1
    return counts


def _percentile(sorted_values: List[float], pct: float) -> float:
    """Nearest-rank percentile of an already-sorted, non-empty list.

    Uses the nearest-rank method: rank = ceil(pct * n), 1-based. p50 of
    [1000, 2000, 3000] -> 2000; p95 of a 5-element list -> the max element.
    """
    n = len(sorted_values)
    rank = max(1, math.ceil(pct * n))
    return float(sorted_values[min(rank, n) - 1])


def _is_outlier_duration(duration_ms: float) -> bool:
    ceiling_ms = MAX_RUN_TIMEOUT_SECONDS * 1000 * DURATION_OUTLIER_TIMEOUT_FACTOR
    return duration_ms > ceiling_ms


def duration_summary(runs: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Trustworthy duration aggregate over run rows.

    Drops orphaned/never-closed runs whose ``duration_ms`` exceeds the absolute
    run-timeout ceiling by ``DURATION_OUTLIER_TIMEOUT_FACTOR`` so a single stuck
    run can't poison the headline. Returns avg/median/p95 over the surviving
    durations plus how many outliers were excluded (for transparency).

    Keys: ``avg_duration_ms``, ``median_duration_ms``, ``p95_duration_ms``,
    ``duration_sample_size``, ``duration_outliers_excluded``. Duration values
    are ``None`` when no clean sample exists.
    """
    all_durations: List[float] = [
        float(r["duration_ms"])
        for r in runs
        if r.get("duration_ms") is not None
    ]
    clean = [d for d in all_durations if not _is_outlier_duration(d)]
    excluded = len(all_durations) - len(clean)

    if not clean:
        return {
            "avg_duration_ms": None,
            "median_duration_ms": None,
            "p95_duration_ms": None,
            "duration_sample_size": 0,
            "duration_outliers_excluded": excluded,
        }

    sorted_d = sorted(clean)
    avg = sum(clean) / len(clean)
    median = _percentile(sorted_d, 0.5)
    p95 = _percentile(sorted_d, 0.95)
    return {
        "avg_duration_ms": avg,
        "median_duration_ms": median,
        "p95_duration_ms": p95,
        "duration_sample_size": len(clean),
        "duration_outliers_excluded": excluded,
    }
