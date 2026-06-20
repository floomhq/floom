"""Unit tests for the adversarial-review correctness fixes (Track A).

Covers the five gaps Codex flagged:
  1. Deterministic $insert_id on every AI event (run_id, type, index/fp).
  2. Sampling correctness: sampled events carry sample_rate; run totals unsampled.
  3. Cost provenance: cost_source/pricing_version/model_priced + cost_is_partial.
  4. $exception scrub + stable fingerprint.
  5. Ingestion canary fires; delivery-failure counter increments.
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
    ai._reset_delivery_counters_for_tests()
    yield
    analytics_posthog._reset_for_tests()
    ai._reset_delivery_counters_for_tests()


class _StubClient:
    def __init__(self):
        self.captured = []
        self.flushes = 0

    def capture(self, event, **kwargs):
        self.captured.append((event, kwargs))

    def flush(self):
        self.flushes += 1

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
# 1. Deterministic $insert_id
# ---------------------------------------------------------------------------
class TestInsertId:
    def test_identical_logical_event_same_insert_id(self, monkeypatch):
        """Same (run, kind, index) across two independent runs -> same id, so
        PostHog dedupes a replay/backfill."""
        s1 = _enable(monkeypatch)
        ctx1 = _ctx()
        ctx1.capture_generation(model="gpt-4o", input_tokens=10, output_tokens=5)
        id1 = _events(s1, "$ai_generation")[0]["properties"]["$insert_id"]

        # simulate a replay of the same run
        s2 = _enable(monkeypatch)
        ctx2 = _ctx()
        ctx2.capture_generation(model="gpt-4o", input_tokens=10, output_tokens=5)
        id2 = _events(s2, "$ai_generation")[0]["properties"]["$insert_id"]
        assert id1 == id2

    def test_insert_id_distinct_per_index(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=10, output_tokens=5)
        ctx.capture_generation(model="gpt-4o", input_tokens=20, output_tokens=5)
        ids = [g["properties"]["$insert_id"] for g in _events(stub, "$ai_generation")]
        assert len(ids) == 2 and ids[0] != ids[1]

    def test_insert_id_distinct_per_event_kind(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=10, output_tokens=5)
        ctx.capture_span(name="t")
        ctx.finish()
        gen_id = _events(stub, "$ai_generation")[0]["properties"]["$insert_id"]
        span_id = _events(stub, "$ai_span")[0]["properties"]["$insert_id"]
        trace_id = _events(stub, "$ai_trace")[0]["properties"]["$insert_id"]
        assert len({gen_id, span_id, trace_id}) == 3

    def test_trace_insert_id_deterministic(self, monkeypatch):
        s1 = _enable(monkeypatch)
        _ctx().finish()
        t1 = _events(s1, "$ai_trace")[0]["properties"]["$insert_id"]
        s2 = _enable(monkeypatch)
        _ctx().finish()
        t2 = _events(s2, "$ai_trace")[0]["properties"]["$insert_id"]
        assert t1 == t2

    def test_exception_insert_id_deterministic_per_run(self, monkeypatch):
        s1 = _enable(monkeypatch)
        try:
            raise RuntimeError("boom")
        except RuntimeError as e:
            ai.capture_exception(owner_id="o", exc=e, run_id="run-9", worker_id="w")
        id1 = _events(s1, "$exception")[0]["properties"]["$insert_id"]
        s2 = _enable(monkeypatch)
        try:
            raise RuntimeError("boom")
        except RuntimeError as e:
            ai.capture_exception(owner_id="o", exc=e, run_id="run-9", worker_id="w")
        id2 = _events(s2, "$exception")[0]["properties"]["$insert_id"]
        assert id1 == id2


# ---------------------------------------------------------------------------
# 2. Sampling correctness — sampled events stamped; run totals unsampled
# ---------------------------------------------------------------------------
class TestSamplingTotals:
    def test_sampled_events_carry_sample_rate(self, monkeypatch):
        stub = _enable(monkeypatch)
        monkeypatch.setenv("POSTHOG_AI_SAMPLE_RATE", "1")  # keep events to inspect
        # Force a <1 rate but pass-through by stubbing the sampler so the event
        # is emitted AND stamped.
        monkeypatch.setattr(ai, "sample_rate", lambda: 0.5)
        monkeypatch.setattr(ai, "_passes_sample", lambda: True)
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=10, output_tokens=5)
        ctx.capture_span(name="t")
        gp = _events(stub, "$ai_generation")[0]["properties"]
        sp = _events(stub, "$ai_span")[0]["properties"]
        assert gp["sample_rate"] == 0.5 and gp["sampled"] is True
        assert sp["sample_rate"] == 0.5 and sp["sampled"] is True

    def test_run_totals_unsampled_even_when_events_dropped(self, monkeypatch):
        stub = _enable(monkeypatch)
        monkeypatch.setenv("POSTHOG_AI_SAMPLE_RATE", "0")  # drop ALL detail events
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=1000, output_tokens=500)
        ctx.capture_generation(model="gpt-4o", input_tokens=200, output_tokens=100)
        ctx.capture_span(name="t")
        ctx.finish()
        # no detail events
        assert _events(stub, "$ai_generation") == []
        assert _events(stub, "$ai_span") == []
        # but the trace rollup is full + marked unsampled
        tp = _events(stub, "$ai_trace")[0]["properties"]
        assert tp["totals_unsampled"] is True
        assert tp["generation_count"] == 2
        assert tp["total_tokens"] == 1800
        assert tp["total_cost_usd"] is not None and tp["total_cost_usd"] > 0

    def test_no_sample_rate_when_full(self, monkeypatch):
        stub = _enable(monkeypatch)  # default rate 1.0
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=10, output_tokens=5)
        gp = _events(stub, "$ai_generation")[0]["properties"]
        assert "sample_rate" not in gp and "sampled" not in gp


# ---------------------------------------------------------------------------
# 3. Cost provenance
# ---------------------------------------------------------------------------
class TestCostProvenance:
    def test_priced_model_marks_litellm_source(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=1000, output_tokens=500)
        gp = _events(stub, "$ai_generation")[0]["properties"]
        assert gp["cost_source"] == ai.COST_SOURCE_LITELLM
        assert gp["model_priced"] is True
        assert gp["pricing_version"] == ai.PRICING_VERSION

    def test_unpriced_model_sets_partial(self, monkeypatch):
        stub = _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=1000, output_tokens=500)
        ctx.capture_generation(model="totally-unknown-xyz", input_tokens=100, output_tokens=50)
        ctx.finish()
        assert ctx.unpriced_generation_count == 1
        assert ctx.cost_is_partial is True
        tp = _events(stub, "$ai_trace")[0]["properties"]
        assert tp["cost_is_partial"] is True
        assert tp["unpriced_generation_count"] == 1
        # cost still summed from the priced one, but flagged partial (not null)
        assert tp["total_cost_usd"] is not None

    def test_all_unpriced_is_partial_and_unknown(self, monkeypatch):
        _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_generation(model="unknown-xyz", input_tokens=100, output_tokens=50)
        assert ctx.cost_is_partial is True
        assert ctx.cost_source == ai.COST_SOURCE_UNKNOWN
        assert ctx.rolled_total_cost_usd is None  # honest null, not 0

    def test_detail_returns_provenance(self):
        cost, source, priced = ai.generation_cost_detail("gpt-4o", 1000, 500)
        assert cost > 0 and source == ai.COST_SOURCE_LITELLM and priced is True
        cost2, source2, priced2 = ai.generation_cost_detail("nope-xyz", 10, 10)
        assert cost2 is None and source2 == ai.COST_SOURCE_UNKNOWN and priced2 is False


# ---------------------------------------------------------------------------
# 4. $exception scrub + fingerprint
# ---------------------------------------------------------------------------
class TestExceptionScrubFingerprint:
    def test_secret_scrubbed_from_message(self, monkeypatch):
        stub = _enable(monkeypatch)
        secret = "sk-" + "abcdefghijklmnopqrstuvwx0123"
        try:
            raise RuntimeError(f"auth failed with key {secret} for bob@floom.dev")
        except RuntimeError as e:
            ai.capture_exception(owner_id="o", exc=e, run_id="r", worker_id="w")
        p = _events(stub, "$exception")[0]["properties"]
        assert secret not in p["$exception_message"]
        assert secret not in p["$exception_list"][0]["stacktrace"]["text"]
        assert "bob@floom.dev" not in p["$exception_message"]

    def test_fingerprint_stable_across_volatile_ids(self, monkeypatch):
        stub = _enable(monkeypatch)
        for msg in (
            "row 12345 missing at /srv/a/run-aaaa1111-2222-3333-4444-555566667777.py",
            "row 99999 missing at /tmp/b/run-bbbb9999-8888-7777-6666-555544443333.py",
        ):
            try:
                raise KeyError(msg)
            except KeyError as e:
                ai.capture_exception(owner_id="o", exc=e, run_id="r" + msg[:3], worker_id="w")
        fps = [kw["properties"]["$exception_fingerprint"] for kw in _events(stub, "$exception")]
        # both KeyErrors with the same shape -> ONE group
        assert len(fps) == 2 and fps[0] == fps[1]

    def test_fingerprint_differs_by_type(self):
        assert ai.exception_fingerprint("ValueError", "x") != ai.exception_fingerprint("KeyError", "x")

    def test_fingerprint_stable_across_prefixed_id_tails(self):
        # Gap 1 (live ingestion proof): the SAME logical crash from two different
        # runs must group into ONE issue. The only difference is the volatile
        # run_<alnum> / ws_/wk_/art_/gen_ id tail, which must normalize away.
        a = ai.exception_fingerprint("RuntimeError", "worker failed in run_3f9ac1b2e otherwise identical")
        b = ai.exception_fingerprint("RuntimeError", "worker failed in run_88aa55cc1 otherwise identical")
        assert a == b
        c = ai.exception_fingerprint("KeyError", "missing ws_aa11bb22 / wk_ccddeeff / art_1234abcd / gen_99xy")
        d = ai.exception_fingerprint("KeyError", "missing ws_zz99yy88 / wk_gghhiijj / art_zzzz0000 / gen_11ab")
        assert c == d

    def test_fingerprint_still_differs_for_genuinely_different_crashes(self):
        # The id-tail stripper must NOT collapse genuinely different errors.
        assert ai.exception_fingerprint("RuntimeError", "database connection refused in run_aaaa1111") != \
            ai.exception_fingerprint("RuntimeError", "permission denied on resource in run_bbbb2222")


# ---------------------------------------------------------------------------
# 5. Ingestion canary + delivery telemetry
# ---------------------------------------------------------------------------
class TestCanaryAndDelivery:
    def test_canary_fires_when_enabled(self, monkeypatch):
        stub = _enable(monkeypatch)
        assert ai.emit_ingestion_canary(source="startup") is True
        canaries = _events(stub, "posthog_ingestion_canary")
        assert len(canaries) == 1
        assert canaries[0]["properties"]["canary_source"] == "startup"
        assert ai.delivery_counters()["canary_fired"] == 1
        # canary forces a flush
        assert ai.delivery_counters()["flush_attempted"] >= 1

    def test_canary_noop_when_disabled(self):
        assert ai.emit_ingestion_canary() is False
        assert ai.delivery_counters()["canary_fired"] == 0

    def test_emit_attempt_counted(self, monkeypatch):
        _enable(monkeypatch)
        ctx = _ctx()
        ctx.capture_generation(model="gpt-4o", input_tokens=10, output_tokens=5)
        assert ai.delivery_counters()["emit_attempted"] >= 1

    def test_flush_failure_increments_counter(self, monkeypatch):
        _enable(monkeypatch)

        def _boom():
            raise RuntimeError("flush exploded")

        # analytics_posthog.flush swallows internally, so simulate a flush that
        # raises through the telemetry wrapper.
        monkeypatch.setattr(analytics_posthog, "flush", _boom)
        ai.flush_with_telemetry()
        assert ai.delivery_counters()["flush_failed"] == 1

    def test_on_error_hook_increments_emit_failed(self, monkeypatch):
        _enable(monkeypatch)
        # Simulate the posthog SDK invoking its on_error callback on a failed
        # batch of 3 items.
        analytics_posthog._on_delivery_error(RuntimeError("502"), items=[1, 2, 3])
        assert ai.delivery_counters()["emit_failed"] == 3
