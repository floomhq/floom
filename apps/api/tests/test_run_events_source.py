"""Run lifecycle PostHog events must carry source from the trigger origin."""

from __future__ import annotations

import os
import sys

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

import run_service  # noqa: E402
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


def _emit_run_started(trigger_source: str) -> None:
    run_service._emit_run_lifecycle_event(
        run_id=f"run-{trigger_source}",
        status="running",
        worker_id="wkr-1",
        owner_id="owner-1",
        error=None,
        error_code=None,
        run_row={
            "trigger_source": trigger_source,
            "runner": "e2b",
            "input_json": {"a": 1},
        },
        repos=None,
    )


def test_run_started_source_uses_schedule_trigger(monkeypatch):
    stub = _enable_with_stub(monkeypatch)

    _emit_run_started("schedule")

    assert len(stub.captured) == 1
    event, kwargs = stub.captured[0]
    assert event == "run_started"
    assert kwargs["properties"]["source"] == "schedule"
    assert kwargs["properties"]["trigger_source"] == "schedule"


def test_run_started_source_uses_mcp_trigger(monkeypatch):
    stub = _enable_with_stub(monkeypatch)

    _emit_run_started("mcp")

    assert len(stub.captured) == 1
    event, kwargs = stub.captured[0]
    assert event == "run_started"
    assert kwargs["properties"]["source"] == "mcp"
    assert kwargs["properties"]["trigger_source"] == "mcp"


def test_run_started_source_context_restored_after_emit(monkeypatch):
    stub = _enable_with_stub(monkeypatch)

    _emit_run_started("schedule")
    analytics_posthog.capture_event(distinct_id="owner-1", event="probe", properties={})

    probe = [capture for capture in stub.captured if capture[0] == "probe"][0]
    assert probe[1]["properties"]["source"] == "api"
