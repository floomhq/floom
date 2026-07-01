"""Scheduler-fired trigger_fired events must be tagged source="schedule".

The scheduler runs in a background thread (no HTTP request context), so without
an explicit override the analytics source would default to "api".
"""

from __future__ import annotations

import os
import sys

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

import scheduler  # noqa: E402
from services import analytics_posthog  # noqa: E402


class _StubClient:
    def __init__(self):
        self.captured = []

    def capture(self, event, **kwargs):
        self.captured.append((event, kwargs))

    def flush(self):
        pass

    def shutdown(self):
        pass


def _enable_with_stub(monkeypatch):
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_test_key")
    analytics_posthog._reset_for_tests()
    stub = _StubClient()
    analytics_posthog._client = stub
    analytics_posthog._init_attempted = True
    return stub


def test_trigger_fired_tagged_source_schedule(monkeypatch):
    stub = _enable_with_stub(monkeypatch)
    scheduler._emit_trigger_fired(
        owner_id="owner-1",
        worker_id="wkr-1",
        run_id="run-1",
        trigger_type="schedule",
    )

    assert len(stub.captured) == 1
    event, kwargs = stub.captured[0]
    assert event == "trigger_fired"
    assert kwargs["properties"]["source"] == "schedule"


def test_trigger_fired_noop_without_owner(monkeypatch):
    stub = _enable_with_stub(monkeypatch)
    scheduler._emit_trigger_fired(
        owner_id=None,
        worker_id="wkr-1",
        run_id="run-1",
        trigger_type="schedule",
    )
    assert stub.captured == []


def test_source_context_restored_after_emit(monkeypatch):
    """The scheduler override must not leak the source into later emits."""
    stub = _enable_with_stub(monkeypatch)
    scheduler._emit_trigger_fired(
        owner_id="owner-1", worker_id="w", run_id="r", trigger_type="schedule"
    )
    # After the scheduler emit, a plain capture should fall back to the default.
    analytics_posthog.capture_event(distinct_id="owner-1", event="probe", properties={})
    probe = [c for c in stub.captured if c[0] == "probe"][0]
    assert probe[1]["properties"]["source"] == "api"
