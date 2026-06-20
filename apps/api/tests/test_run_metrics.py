"""Unit tests for post-hoc run metrics: duration outlier handling + taxonomy.

Pure-function tests (no DB / no app). The headline guarantee: a single stuck /
orphaned run (duration measured across hours of wall-clock) must NOT poison the
avg/p95 duration aggregate.
"""

from __future__ import annotations

import os
import sys

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

from services.run_metrics import (  # noqa: E402
    DURATION_OUTLIER_TIMEOUT_FACTOR,
    MAX_RUN_TIMEOUT_SECONDS,
    classify_failure,
    duration_summary,
    failures_by_category,
)

# A duration above this is treated as an orphaned/never-closed outlier.
_OUTLIER_CEILING_MS = MAX_RUN_TIMEOUT_SECONDS * 1000 * DURATION_OUTLIER_TIMEOUT_FACTOR


def _run(duration_ms=None, status="completed", error_code=None, error=None):
    return {
        "duration_ms": duration_ms,
        "status": status,
        "error_code": error_code,
        "error": error,
    }


# ---------------------------------------------------------------------------
# Duration aggregation
# ---------------------------------------------------------------------------

class TestDurationSummary:
    def test_empty_returns_none(self):
        out = duration_summary([])
        assert out["avg_duration_ms"] is None
        assert out["median_duration_ms"] is None
        assert out["p95_duration_ms"] is None
        assert out["duration_sample_size"] == 0
        assert out["duration_outliers_excluded"] == 0

    def test_normal_durations_aggregate(self):
        runs = [_run(1000), _run(2000), _run(3000)]
        out = duration_summary(runs)
        assert out["avg_duration_ms"] == 2000
        assert out["median_duration_ms"] == 2000
        assert out["duration_sample_size"] == 3
        assert out["duration_outliers_excluded"] == 0

    def test_stuck_run_does_not_poison_avg_or_p95(self):
        """The core bug: one 14.5h orphaned run must be excluded from the headline."""
        normal = [_run(1000), _run(1500), _run(2000), _run(2500), _run(3000)]
        # run_ee90e0db5937 was 52431881 ms (~14.5h). Include one such monster.
        stuck = _run(52_431_881, status="failed", error_code="timeout")
        out = duration_summary(normal + [stuck])

        # Excluded the one outlier; aggregate computed over the 5 clean runs only.
        assert out["duration_outliers_excluded"] == 1
        assert out["duration_sample_size"] == 5
        # Without exclusion the mean would be ~8.7M ms; with it, 2000 ms.
        assert out["avg_duration_ms"] == 2000
        assert out["p95_duration_ms"] <= 3000
        # Sanity: the poisoned mean is what we are NOT returning.
        poisoned_mean = (1000 + 1500 + 2000 + 2500 + 3000 + 52_431_881) / 6
        assert out["avg_duration_ms"] < poisoned_mean / 100

    def test_outlier_boundary(self):
        # Exactly at the ceiling is kept; just above is excluded.
        at_ceiling = _run(_OUTLIER_CEILING_MS)
        above = _run(_OUTLIER_CEILING_MS + 1)
        out = duration_summary([at_ceiling, above])
        assert out["duration_sample_size"] == 1
        assert out["duration_outliers_excluded"] == 1
        assert out["avg_duration_ms"] == float(_OUTLIER_CEILING_MS)

    def test_all_outliers_returns_none_with_count(self):
        runs = [_run(_OUTLIER_CEILING_MS + 1), _run(_OUTLIER_CEILING_MS + 2)]
        out = duration_summary(runs)
        assert out["avg_duration_ms"] is None
        assert out["duration_outliers_excluded"] == 2

    def test_ignores_null_durations(self):
        runs = [_run(None), _run(1000), _run(None)]
        out = duration_summary(runs)
        assert out["avg_duration_ms"] == 1000
        assert out["duration_sample_size"] == 1


# ---------------------------------------------------------------------------
# Failure taxonomy
# ---------------------------------------------------------------------------

class TestClassifyFailure:
    def test_timeout_by_code(self):
        assert classify_failure(error_code="timeout") == "timeout"

    def test_timeout_by_message(self):
        assert classify_failure(error="Agent run exceeded timeout of 300s") == "timeout"

    def test_crash_server_disconnected(self):
        assert classify_failure(error="Server disconnected") == "crash"

    def test_path_traversal_then_disconnect_is_crash(self):
        assert classify_failure(error="Path traversal attempt: ../../etc") == "crash"

    def test_auth_missing_secret(self):
        assert classify_failure(error_code="missing_secret") == "auth"

    def test_config_invalid_worker(self):
        assert classify_failure(error_code="invalid_worker") == "config"

    def test_resource_oom(self):
        assert classify_failure(error_code="sandbox_oom") == "resource"

    def test_network_mcp(self):
        assert classify_failure(error_code="mcp_connect_failed") == "network"

    def test_cancelled(self):
        assert classify_failure(error_code="user_cancel") == "cancelled"

    def test_unknown_code_falls_through_to_message(self):
        # error_code is the generic fallback; message carries the real signal.
        assert classify_failure(error_code="unknown_error", error="connection refused") == "network"

    def test_unknown_when_nothing_matches(self):
        assert classify_failure(error_code=None, error="???") == "unknown"
        assert classify_failure() == "unknown"

    def test_code_takes_precedence_over_message(self):
        # A real code wins even if the message mentions another category.
        assert classify_failure(error_code="timeout", error="connection refused") == "timeout"


class TestFailuresByCategory:
    def test_groups_and_counts(self):
        failed = [
            _run(status="failed", error_code="timeout"),
            _run(status="failed", error_code="timeout"),
            _run(status="failed", error="Server disconnected"),
            _run(status="failed", error_code="missing_secret"),
        ]
        out = failures_by_category(failed)
        assert out == {"timeout": 2, "crash": 1, "auth": 1}

    def test_empty(self):
        assert failures_by_category([]) == {}
