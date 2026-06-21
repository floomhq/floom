"""Unit tests for Track A — PostHog LLM Observability.

Contracts under test (spec §12.3 Track A):
  1. Fail-soft: no client + no emission when POSTHOG_API_KEY is unset.
  2. One $ai_generation per model call, with model/provider/tokens/cost.
  3. Run cost = SUM of child generations (trace-derived, not blended).
  4. Metadata-only mode (default) sends NO prompt/completion/tool bodies;
     full/redacted modes send scrubbed, truncated bodies.
  5. $ai_span per tool call; $ai_trace rollup on finish.
  6. $exception capture on crash with type + stack trace.
  7. Cost is litellm-derived, None for unknown models (never guessed).
"""
from __future__ import annotations

import os
import sys

import pytest

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

from services import analytics_posthog  # noqa: E402
from services import ai_observability as ai  # noqa: E402


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.delenv("POSTHOG_API_KEY", raising=False)
    monkeypatch.delenv("POSTHOG_HOST", raising=False)
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


def _ctx(**over):
    base = dict(
        trace_id="trace-1",
        run_id="run-1",
        worker_id="worker-1",
        workspace_id="ws-1",
        owner_id="owner-1",
    )
    base.update(over)
    return ai.AITraceContext(**base)


def _events(stub, name):
    return [kw for ev, kw in stub.captured if ev == name]


# ---------------------------------------------------------------------------
# 1. Fail-soft
# ---------------------------------------------------------------------------
class TestFailSoft:
    def test_disabled_when_key_absent(self):
        assert ai.is_enabled() is False

    def test_generation_noop_when_disabled(self):
        ctx = _ctx()
        # rollup still accumulates so cost is correct even with analytics off,
        # but nothing is sent.
        ctx.capture_generation(model="gpt-4o", input_tokens=10, output_tokens=5)
        ctx.capture_span(name="t")
        ctx.finish()
        assert ctx.generation_count == 1  # rollup works
        # No client at all -> nothing could have been captured.

    def test_capture_exception_noop_when_disabled(self):
        ai.capture_exception(
            owner_id="o", exc=ValueError("x"), run_id="r", worker_id="w"
        )  # must not raise


# ---------------------------------------------------------------------------
# 2 + 7. Generation emission + cost
# ---------------------------------------------------------------------------
class TestGeneration:
    def test_one_generation_per_call(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=1000, output_tokens=500)
        ctx.capture_generation(model="gpt-4o", input_tokens=200, output_tokens=100)
        gens = _events(stub, "$ai_generation")
        assert len(gens) == 2

    def test_generation_properties(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_generation(
            model="gpt-4o", input_tokens=1000, output_tokens=500, latency_s=1.25
        )
        props = _events(stub, "$ai_generation")[0]["properties"]
        assert props["$ai_model"] == "gpt-4o"
        assert props["$ai_provider"] == "openai"
        assert props["$ai_input_tokens"] == 1000
        assert props["$ai_output_tokens"] == 500
        assert props["$ai_total_cost_usd"] is not None and props["$ai_total_cost_usd"] > 0
        assert props["$ai_latency"] == 1.25
        assert props["$ai_trace_id"] == "trace-1"
        assert props["run_id"] == "run-1"
        # group attach: workspace + worker
        groups = _events(stub, "$ai_generation")[0]["groups"]
        assert groups == {"workspace": "ws-1", "worker": "worker-1"}

    def test_cost_none_for_unknown_model(self):
        assert ai.generation_cost_usd("totally-unknown-xyz", 100, 100) is None

    def test_cost_known_for_bedrock_and_openai(self):
        assert ai.generation_cost_usd("openai/gpt-4o-mini", 1000, 500) > 0
        assert (
            ai.generation_cost_usd(
                "bedrock/us.anthropic.claude-3-5-sonnet-20241022-v2:0", 1000, 500
            )
            > 0
        )


# ---------------------------------------------------------------------------
# 3. Run cost = SUM of child generations
# ---------------------------------------------------------------------------
class TestCostRollup:
    def test_total_cost_is_sum_of_generations(self, monkeypatch):
        _enable(monkeypatch)
        ctx = _ctx()
        c1 = ai.generation_cost_usd("gpt-4o", 1000, 500)
        c2 = ai.generation_cost_usd("gpt-4o", 200, 100)
        ctx.capture_generation(model="gpt-4o", input_tokens=1000, output_tokens=500)
        ctx.capture_generation(model="gpt-4o", input_tokens=200, output_tokens=100)
        assert ctx.rolled_total_cost_usd == round(c1 + c2, 8)
        s = ctx.summary()
        assert s["total_tokens"] == 1000 + 500 + 200 + 100
        assert s["total_input_tokens"] == 1200
        assert s["total_output_tokens"] == 600
        assert s["generation_count"] == 2

    def test_cost_none_when_no_generation_had_known_cost(self, monkeypatch):
        _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_generation(model="unknown-xyz", input_tokens=100, output_tokens=50)
        # tokens still summed, cost stays None (not 0) so the run row is honest.
        assert ctx.total_tokens == 150
        assert ctx.rolled_total_cost_usd is None


# ---------------------------------------------------------------------------
# 4. Privacy — metadata-only default sends NO bodies
# ---------------------------------------------------------------------------
class TestPrivacy:
    def test_metadata_mode_sends_no_bodies(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx(capture_mode="metadata")
        ctx.capture_generation(
            model="gpt-4o",
            input_tokens=10,
            output_tokens=5,
            input_body="secret prompt with bob@floom.dev",
            output_body="model said something private",
        )
        props = _events(stub, "$ai_generation")[0]["properties"]
        assert "$ai_input" not in props
        assert "$ai_output_choices" not in props

    def test_default_mode_is_metadata(self):
        ctx = _ctx()
        assert ctx.capture_mode == "metadata"

    def test_junk_mode_coerced_to_metadata(self):
        assert _ctx(capture_mode="garbage").capture_mode == "metadata"

    def test_full_mode_sends_scrubbed_truncated_body(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx(capture_mode="full")
        ctx.capture_generation(
            model="gpt-4o",
            input_tokens=10,
            output_tokens=5,
            input_body='OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwx"',
        )
        props = _events(stub, "$ai_generation")[0]["properties"]
        assert "$ai_input" in props
        # secret value never echoed verbatim
        assert "sk-abcdefghijklmnopqrstuvwx" not in props["$ai_input"]

    def test_redacted_mode_masks_pii(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx(capture_mode="redacted")
        ctx.capture_span(name="send_email", output_body="emailing alice@floom.dev now")
        props = _events(stub, "$ai_span")[0]["properties"]
        assert "alice@floom.dev" not in props["$ai_output_state"]
        assert "[email]" in props["$ai_output_state"]


# ---------------------------------------------------------------------------
# 5. Spans + trace
# ---------------------------------------------------------------------------
class TestSpanAndTrace:
    def test_span_per_tool_call(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_span(name="web_search", span_type="tool")
        ctx.capture_span(name="tool_result", span_type="tool_result", is_error=True)
        spans = _events(stub, "$ai_span")
        assert len(spans) == 2
        assert spans[0]["properties"]["$ai_span_name"] == "web_search"
        assert spans[1]["properties"]["$ai_is_error"] is True

    def test_finish_emits_trace_rollup(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=100, output_tokens=20)
        ctx.capture_span(name="t")
        ctx.finish(status="completed")
        traces = _events(stub, "$ai_trace")
        assert len(traces) == 1
        p = traces[0]["properties"]
        assert p["$ai_trace_id"] == "trace-1"
        assert p["generation_count"] == 1
        assert p["span_count"] == 1
        assert p["status"] == "completed"

    def test_span_parent_defaults_to_trace(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_span(name="t")
        assert _events(stub, "$ai_span")[0]["properties"]["$ai_parent_id"] == "trace-1"


# ---------------------------------------------------------------------------
# 6. Error tracking
# ---------------------------------------------------------------------------
class TestErrorTracking:
    def test_exception_captured_with_type_and_stack(self, monkeypatch):
        stub = _enable(monkeypatch)
        try:
            raise RuntimeError("boom in the agent loop")
        except RuntimeError as exc:
            ai.capture_exception(
                owner_id="owner-1",
                exc=exc,
                run_id="run-1",
                worker_id="worker-1",
                workspace_id="ws-1",
                trace_id="trace-1",
                error_code="run_execution_exception",
                error_category="crash",
            )
        ex = _events(stub, "$exception")
        assert len(ex) == 1
        p = ex[0]["properties"]
        assert p["$exception_type"] == "RuntimeError"
        assert p["$exception_message"] == "boom in the agent loop"
        assert p["error_category"] == "crash"
        assert p["$ai_trace_id"] == "trace-1"
        # stack trace text present
        assert "RuntimeError" in p["$exception_list"][0]["stacktrace"]["text"]

    def test_exception_dropped_without_owner(self, monkeypatch):
        stub = _enable(monkeypatch)
        ai.capture_exception(owner_id="", exc=ValueError("x"), run_id="r")
        assert _events(stub, "$exception") == []


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------
class TestSampling:
    def test_zero_sample_drops_generations_but_keeps_trace(self, monkeypatch):
        stub = _enable(monkeypatch)
        monkeypatch.setenv("POSTHOG_AI_SAMPLE_RATE", "0")
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=10, output_tokens=5)
        ctx.capture_span(name="t")
        ctx.finish()
        assert _events(stub, "$ai_generation") == []
        assert _events(stub, "$ai_span") == []
        # trace rollup is never sampled out
        assert len(_events(stub, "$ai_trace")) == 1
        # rollup still correct despite sampling
        assert ctx.summary()["generation_count"] == 1
