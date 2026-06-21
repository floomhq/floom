"""Unit test for the worker_created -> PostHog emission in worker_create.

Exercises _emit_worker_created directly with a stub config (no DB / no router).
"""

from __future__ import annotations

import os
import sys
import types

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

from services import analytics_posthog, worker_create  # noqa: E402


class _Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, distinct_id, event, properties=None, groups=None):
        self.calls.append(
            {"distinct_id": distinct_id, "event": event, "properties": properties or {}, "groups": groups}
        )


def _config(cron=None, connections=None, calls=None, runner="e2b"):
    trigger = types.SimpleNamespace(cron=cron)
    runtime = types.SimpleNamespace(runner=runner)
    return types.SimpleNamespace(
        trigger=trigger,
        runtime=runtime,
        connections=connections or [],
        calls=calls or [],
    )


def test_worker_created_emits_counts_and_flags(monkeypatch):
    rec = _Recorder()
    monkeypatch.setattr("services.analytics_posthog.is_enabled", lambda: True)
    monkeypatch.setattr("services.analytics_posthog.capture_event", rec)

    cfg = _config(cron="0 9 * * *", connections=["gmail"], calls=["other-worker"])
    worker_create._emit_worker_created(worker_id="wkr-1", owner_id="owner-1", config=cfg)

    assert len(rec.calls) == 1
    call = rec.calls[0]
    assert call["event"] == "worker_created"
    assert call["distinct_id"] == "owner-1"
    assert call["groups"] == {"workspace": "local-default"}
    props = call["properties"]
    assert props["worker_id"] == "wkr-1"
    assert props["has_schedule"] is True
    assert props["tool_count"] == 2
    assert props["runner"] == "e2b"


def test_worker_created_no_schedule(monkeypatch):
    rec = _Recorder()
    monkeypatch.setattr("services.analytics_posthog.is_enabled", lambda: True)
    monkeypatch.setattr("services.analytics_posthog.capture_event", rec)
    worker_create._emit_worker_created(
        worker_id="w", owner_id="o", config=_config(cron=None)
    )
    assert rec.calls[0]["properties"]["has_schedule"] is False
    assert rec.calls[0]["properties"]["tool_count"] == 0


def test_worker_created_disabled_noop(monkeypatch):
    rec = _Recorder()
    monkeypatch.setattr("services.analytics_posthog.is_enabled", lambda: False)
    monkeypatch.setattr("services.analytics_posthog.capture_event", rec)
    worker_create._emit_worker_created(worker_id="w", owner_id="o", config=_config())
    assert rec.calls == []
