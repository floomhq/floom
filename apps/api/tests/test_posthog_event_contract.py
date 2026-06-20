"""Schema-contract test: the event names + REQUIRED props the code EMITS must
match the checked-in contract (``services.posthog_event_contract``).

This is the drift gate Codex flagged: PostHog dashboards in project 479185 rot
SILENTLY when a refactor renames/drops a property or removes an event. This test
drives every real emit path with a stub PostHog client and asserts the captured
event carries every ``required_props`` key + the auto-injected envelope keys for
its emitter. A rename/drop/removal fails CII here instead of in an empty chart.

It intercepts at the underlying ``client.capture`` (NOT ``capture_event``) so the
real ``_base_properties`` envelope injection (``schema_version``/``emitter``)
runs and is asserted, exactly as production emits.
"""
from __future__ import annotations

import os
import sys

import pytest

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

import run_service  # noqa: E402
from services import analytics_posthog  # noqa: E402
from services import ai_observability as ai  # noqa: E402
from services import posthog_event_contract as contract  # noqa: E402
from services import worker_create  # noqa: E402


class _StubClient:
    def __init__(self):
        self.captured = []  # list of (event, properties, groups, distinct_id)

    def capture(self, event, *, distinct_id=None, properties=None, groups=None, **_):
        self.captured.append(
            {
                "event": event,
                "properties": properties or {},
                "groups": groups,
                "distinct_id": distinct_id,
            }
        )

    def flush(self):
        pass

    def shutdown(self):
        pass


@pytest.fixture
def stub(monkeypatch):
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_test")
    analytics_posthog._reset_for_tests()
    ai._reset_delivery_counters_for_tests()
    ai._reset_alias_cache_for_tests()
    s = _StubClient()
    analytics_posthog._client = s
    analytics_posthog._init_attempted = True
    # cost lookups are exercised elsewhere; keep terminal run events deterministic.
    import cost as cost_mod

    monkeypatch.setattr(cost_mod, "total_tokens_from_transcript", lambda run_id: 100, raising=False)
    monkeypatch.setattr(cost_mod, "resolved_cost_usd_from_transcript", lambda run_id: 0.01, raising=False)
    yield s
    analytics_posthog._reset_for_tests()
    ai._reset_delivery_counters_for_tests()
    ai._reset_alias_cache_for_tests()


def _events(stub, name):
    return [c for c in stub.captured if c["event"] == name]


# ---------------------------------------------------------------------------
# Drivers: invoke each real emit path so the contract is checked against the
# code, not a hand-maintained mirror.
# ---------------------------------------------------------------------------

def _drive_run_lifecycle(status, **kw):
    defaults = dict(
        run_id="run-1",
        status=status,
        worker_id="wkr-1",
        owner_id="owner-1",
        error=None,
        error_code=None,
        run_row={
            "trigger_source": "manual",
            "runner": "e2b",
            "input_json": {"a": 1},
            "output_json": {"b": 2},
            "started_at": "2026-06-20T00:00:00Z",
        },
        repos=None,
    )
    defaults.update(kw)
    run_service._emit_run_lifecycle_event(**defaults)


def _drive_worker_created():
    class _Runtime:
        runner = "e2b"

    class _Trigger:
        cron = "0 9 * * *"

    class _Config:
        runtime = _Runtime()
        trigger = _Trigger()
        connections = []
        calls = []

    worker_create._emit_worker_created(worker_id="wkr-1", owner_id="owner-1", config=_Config())


def _drive_approval_requested():
    run_service._emit_approval_requested(
        approval_id="appr-1",
        run_id="run-1",
        worker_id="wkr-1",
        owner_id="owner-1",
        tool_name="send_email",
        risk_level="high",
    )


def _ctx():
    return ai.AITraceContext(
        trace_id="run-1",
        run_id="run-1",
        worker_id="wkr-1",
        workspace_id="ws-1",
        owner_id="owner-1",
    )


def _drive_ai_generation():
    _ctx().capture_generation(model="gpt-4o", input_tokens=1000, output_tokens=500)


def _drive_ai_span():
    _ctx().capture_span(name="read_file", span_type="tool")


def _drive_ai_trace():
    ctx = _ctx()
    ctx.capture_generation(model="gpt-4o", input_tokens=10, output_tokens=5)
    ctx.capture_span(name="read_file")
    ctx.finish()


def _drive_exception():
    try:
        raise RuntimeError("boom in run_abcd1234")
    except RuntimeError as e:
        ai.capture_exception(owner_id="owner-1", exc=e, run_id="run-1", worker_id="wkr-1", workspace_id="ws-1")


def _drive_canary():
    ai.emit_ingestion_canary(source="test", owner_id="owner-1")


# event name -> (driver, the event the driver is expected to produce)
_DRIVERS = {
    "run_started": lambda: _drive_run_lifecycle("running"),
    "run_completed": lambda: _drive_run_lifecycle("completed"),
    "run_failed": lambda: _drive_run_lifecycle("failed", error_code="timeout", error="timed out"),
    "run_cancelled": lambda: _drive_run_lifecycle("cancelled", error_code="cancelled"),
    "worker_created": _drive_worker_created,
    "approval_requested": _drive_approval_requested,
    "$ai_generation": _drive_ai_generation,
    "$ai_span": _drive_ai_span,
    "$ai_trace": _drive_ai_trace,
    "$exception": _drive_exception,
    "posthog_ingestion_canary": _drive_canary,
}


def test_every_contract_event_has_a_driver():
    # If a new event is added to the contract, it MUST have a driver here so the
    # required-props assertion actually runs against it (no silent skip).
    missing = contract.event_names() - set(_DRIVERS)
    assert not missing, f"contract events with no driver (cannot be verified): {missing}"


def test_every_driver_is_in_contract():
    # Reverse guard: a driver for an event not in the contract means the contract
    # is incomplete.
    extra = set(_DRIVERS) - contract.event_names()
    assert not extra, f"drivers for events absent from the contract: {extra}"


@pytest.mark.parametrize("event", sorted(contract.event_names()))
def test_emitted_event_matches_contract(stub, event):
    _DRIVERS[event]()
    emitted = _events(stub, event)
    assert emitted, f"{event}: driver emitted no event of this name (renamed/dropped?)"
    props = set(emitted[0]["properties"])

    required = contract.required_props(event)
    missing = required - props
    assert not missing, f"{event}: emitted props MISSING required contract keys: {sorted(missing)}"

    envelope = contract.envelope_props(event)
    env_missing = envelope - props
    assert not env_missing, f"{event}: missing auto-injected envelope keys: {sorted(env_missing)}"


@pytest.mark.parametrize("event", sorted(contract.event_names()))
def test_no_unexpected_required_drift(stub, event):
    # Catch the inverse drift: an emitted prop that is neither required, optional,
    # nor an envelope key indicates the code grew a prop the contract (and thus
    # the dashboards) don't know about. This is a soft drift signal — it fails so
    # the contract stays the single source the 479185 dashboards target.
    _DRIVERS[event]()
    emitted = _events(stub, event)
    props = set(emitted[0]["properties"])
    spec = contract.EVENT_CONTRACT[event]
    known = (
        set(spec["required_props"])
        | set(spec.get("optional_props") or set())
        | contract.envelope_props(event)
    )
    unexpected = props - known
    assert not unexpected, (
        f"{event}: emitted props NOT in contract (update posthog_event_contract.py "
        f"AND the 479185 dashboards): {sorted(unexpected)}"
    )
