"""Integration: AgentDriver emits $ai_generation / $ai_span through the live
stream-consume path, host-side (Track A).

Drives ``_consume_streamed_result`` with a fake Agents-SDK event stream:
  - a usage-bearing raw_response_event (one model call -> one $ai_generation)
  - a tool_call + tool_output (two $ai_span events)
and asserts the AI trace context accumulated cost/tokens and the spans/generation
fired through the real driver code (not the helpers in isolation).
"""
from __future__ import annotations

import asyncio
import os
import sys
from types import SimpleNamespace

import pytest

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

from runner_sandbox.agent_driver import AgentDriver  # noqa: E402
from services import analytics_posthog  # noqa: E402
from services import ai_observability as ai  # noqa: E402


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.delenv("POSTHOG_API_KEY", raising=False)
    monkeypatch.delenv("POSTHOG_AI_SAMPLE_RATE", raising=False)
    analytics_posthog._reset_for_tests()
    yield
    analytics_posthog._reset_for_tests()


class _StubClient:
    def __init__(self):
        self.captured = []

    def capture(self, event, **kwargs):
        self.captured.append((event, kwargs))

    def flush(self):
        pass

    def shutdown(self):
        pass


def _enable(monkeypatch):
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_test")
    analytics_posthog._reset_for_tests()
    stub = _StubClient()
    analytics_posthog._client = stub
    analytics_posthog._init_attempted = True
    return stub


class _FakeStreamResult:
    """Minimal stand-in for an Agents-SDK streamed result."""

    def __init__(self, events):
        self._events = events

    async def stream_events(self):
        for e in self._events:
            yield e

    def cancel(self):
        pass


def _raw_usage_event(model, input_tokens, output_tokens):
    """A raw_response_event whose data.response carries usage (a completed gen)."""
    usage = SimpleNamespace(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        input_tokens_details=SimpleNamespace(cached_tokens=0),
    )
    response = SimpleNamespace(model=model, usage=usage)
    return SimpleNamespace(type="raw_response_event", data=SimpleNamespace(response=response))


def test_consume_emits_generation_and_spans(monkeypatch):
    stub = _enable(monkeypatch)

    # tool_call + tool_output decode to spans; the raw usage event -> generation.
    import runner_sandbox.stream_adapter as stream_adapter

    tool_items = iter(
        [
            SimpleNamespace(
                kind="tool_call",
                tool_name="web_search",
                args={"q": "hi"},
                call_id="call_1",
                metadata={},
            ),
            SimpleNamespace(
                kind="tool_output",
                output={"ok": True},
                call_id="call_1",
                is_error=False,
                metadata={},
            ),
        ]
    )

    def _decode(event):
        # Only tool events decode to a part; the usage event decodes to None.
        if getattr(event, "type", None) == "raw_response_event":
            return None
        return next(tool_items)

    monkeypatch.setattr(stream_adapter, "decode_stream_event", _decode)

    events = [
        _raw_usage_event("gpt-4o", 1000, 500),  # one model call
        SimpleNamespace(type="run_item_stream_event"),  # tool_call
        SimpleNamespace(type="run_item_stream_event"),  # tool_output
    ]

    driver = AgentDriver()
    ctx = ai.AITraceContext(
        trace_id="trace-x",
        run_id="run-x",
        worker_id="worker-x",
        workspace_id="ws-x",
        owner_id="owner-x",
    )

    async def _run():
        return await driver._consume_streamed_result(
            result=_FakeStreamResult(events),
            run_id="run-x",
            transcript=[],
            total_tokens=0,
            max_total_tokens=10_000_000,
            ai_ctx=ctx,
        )

    result = asyncio.run(_run())

    # total_tokens flowed through the existing accounting
    assert result["total_tokens"] == 1500

    # one generation, two spans emitted to PostHog
    gens = [kw for ev, kw in stub.captured if ev == "$ai_generation"]
    spans = [kw for ev, kw in stub.captured if ev == "$ai_span"]
    assert len(gens) == 1
    assert len(spans) == 2

    gp = gens[0]["properties"]
    assert gp["$ai_model"] == "gpt-4o"
    assert gp["$ai_input_tokens"] == 1000
    assert gp["$ai_output_tokens"] == 500
    assert gp["$ai_total_cost_usd"] is not None and gp["$ai_total_cost_usd"] > 0

    # trace rollup accumulated cost = the single generation's cost
    assert ctx.generation_count == 1
    assert ctx.span_count == 2
    assert ctx.rolled_total_cost_usd == ai.generation_cost_usd("gpt-4o", 1000, 500)


def test_consume_is_noop_when_ai_ctx_none(monkeypatch):
    """Disabled path: ai_ctx None -> stream still consumed, no AI events."""
    stub = _enable(monkeypatch)
    import runner_sandbox.stream_adapter as stream_adapter

    monkeypatch.setattr(stream_adapter, "decode_stream_event", lambda e: None)
    events = [_raw_usage_event("gpt-4o", 10, 5)]
    driver = AgentDriver()

    async def _run():
        return await driver._consume_streamed_result(
            result=_FakeStreamResult(events),
            run_id="r",
            transcript=[],
            total_tokens=0,
            max_total_tokens=10_000_000,
            ai_ctx=None,
        )

    result = asyncio.run(_run())
    assert result["total_tokens"] == 15
    assert [ev for ev, _ in stub.captured if ev.startswith("$ai")] == []
