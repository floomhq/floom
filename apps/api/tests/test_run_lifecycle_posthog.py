"""Tests for the run-lifecycle -> PostHog emission in run_service.

Exercises _emit_run_lifecycle_event directly (no DB / no executor) to assert:
  - one event per terminal/running transition, with the right event name;
  - run_failed.error_category == classify_failure(error_code, error)
    (taxonomy parity — never a hand-typed string);
  - run_cancelled carries error_category="cancelled" (off the failure funnel);
  - distinct_id = owner, groups = {"workspace": ...};
  - no emission when analytics is disabled (no double-/spurious-emit).
"""

from __future__ import annotations

import os
import sys

import pytest

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

import run_service  # noqa: E402
from services import analytics_posthog, run_metrics  # noqa: E402


class _Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, distinct_id, event, properties=None, groups=None):
        self.calls.append(
            {
                "distinct_id": distinct_id,
                "event": event,
                "properties": properties or {},
                "groups": groups,
            }
        )


@pytest.fixture
def emit(monkeypatch):
    """Patch analytics to enabled + a recorder, and stub cost lookups."""
    rec = _Recorder()
    monkeypatch.setattr(analytics_posthog, "is_enabled", lambda: True)
    monkeypatch.setattr(analytics_posthog, "capture_event", rec)
    # Deterministic token/cost so terminal events don't hit the transcript store.
    import cost as cost_mod

    monkeypatch.setattr(cost_mod, "total_tokens_from_transcript", lambda run_id: 4242)
    monkeypatch.setattr(cost_mod, "estimate_cost_usd", lambda toks: 0.05)
    return rec


def _emit(status, **kw):
    defaults = dict(
        run_id="run-1",
        status=status,
        worker_id="wkr-1",
        owner_id="owner-1",
        error=None,
        error_code=None,
        run_row={"trigger_source": "manual", "runner": "e2b", "input_json": {"a": 1}},
        repos=None,
    )
    defaults.update(kw)
    run_service._emit_run_lifecycle_event(**defaults)


class TestRunLifecycleEmit:
    def test_run_started_single_event(self, emit):
        _emit("running")
        assert len(emit.calls) == 1
        call = emit.calls[0]
        assert call["event"] == "run_started"
        assert call["distinct_id"] == "owner-1"
        assert call["groups"] == {"workspace": "local-default"}
        props = call["properties"]
        assert props["run_id"] == "run-1"
        assert props["worker_id"] == "wkr-1"
        assert props["trigger_source"] == "manual"
        assert props["runner"] == "e2b"
        assert props["input_present"] is True
        assert props["input_bytes"] and props["input_bytes"] > 0

    def test_run_completed_carries_cost(self, emit):
        _emit("completed")
        assert len(emit.calls) == 1
        props = emit.calls[0]["properties"]
        assert emit.calls[0]["event"] == "run_completed"
        assert props["total_tokens"] == 4242
        assert props["total_cost_usd"] == 0.05
        assert "error_category" not in props

    def test_run_failed_error_category_matches_classifier(self, emit):
        _emit("failed", error="Agent run exceeded timeout of 300s", error_code="timeout")
        assert len(emit.calls) == 1
        props = emit.calls[0]["properties"]
        assert emit.calls[0]["event"] == "run_failed"
        expected = run_metrics.classify_failure(
            error_code="timeout", error="Agent run exceeded timeout of 300s"
        )
        assert props["error_category"] == expected == "timeout"
        assert props["error_code"] == "timeout"

    def test_run_failed_abandoned_is_crash_not_unknown(self, emit):
        # Spec §11 gap fixed at source: classifier returns crash, event inherits.
        _emit("failed", error="run abandoned", error_code="interrupted_by_restart")
        props = emit.calls[0]["properties"]
        assert props["error_category"] == "crash"

    def test_run_cancelled_category_is_cancelled(self, emit):
        _emit("cancelled", error_code="user_cancel")
        assert len(emit.calls) == 1
        props = emit.calls[0]["properties"]
        assert emit.calls[0]["event"] == "run_cancelled"
        assert props["error_category"] == "cancelled"

    def test_disabled_emits_nothing(self, monkeypatch):
        rec = _Recorder()
        monkeypatch.setattr(analytics_posthog, "is_enabled", lambda: False)
        monkeypatch.setattr(analytics_posthog, "capture_event", rec)
        run_service._emit_run_lifecycle_event(
            run_id="r", status="completed", worker_id="w", owner_id="o",
            error=None, error_code=None, run_row={}, repos=None,
        )
        assert rec.calls == []

    def test_non_lifecycle_status_emits_nothing(self, emit):
        _emit("pending_approval")
        assert emit.calls == []

    def test_one_event_per_transition_no_double_emit(self, emit):
        # Calling once per transition yields exactly one event each.
        _emit("running")
        _emit("completed")
        assert [c["event"] for c in emit.calls] == ["run_started", "run_completed"]
