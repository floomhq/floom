"""Unit tests for the server-side PostHog analytics wrapper.

Pure-function / no-network. The contracts under test:
  1. Fail-soft: no client + no emission when POSTHOG_API_KEY is unset (dev/OSS).
  2. When enabled, capture_event forwards distinct_id / properties / groups and
     injects schema_version + emitter.
  3. Empty distinct_id is dropped (no anonymous person bloat).
  4. flush/shutdown are safe no-ops when disabled and never raise.
  5. hash_value is a stable sha256[:n] (no clear identifiers leak).
"""

from __future__ import annotations

import os
import sys

import pytest

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

from services import ai_observability, analytics_posthog  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_client(monkeypatch):
    """Each test starts with a clean (un-inited) client and no key."""
    monkeypatch.delenv("POSTHOG_API_KEY", raising=False)
    monkeypatch.delenv("POSTHOG_HOST", raising=False)
    analytics_posthog._reset_for_tests()
    yield
    analytics_posthog._reset_for_tests()


class _StubClient:
    """Records capture/flush/shutdown calls instead of hitting PostHog."""

    def __init__(self):
        self.captured = []
        self.flushed = 0
        self.shut = 0

    def capture(self, event, **kwargs):
        self.captured.append((event, kwargs))

    def flush(self):
        self.flushed += 1

    def shutdown(self):
        self.shut += 1


def _enable_with_stub(monkeypatch):
    """Enable analytics with a stub client (no real SDK / network)."""
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_test_key")
    analytics_posthog._reset_for_tests()
    stub = _StubClient()
    # Force the module to use our stub regardless of SDK import.
    analytics_posthog._client = stub
    analytics_posthog._init_attempted = True
    return stub


# ---------------------------------------------------------------------------
# Fail-soft (key absent)
# ---------------------------------------------------------------------------

class TestFailSoft:
    def test_disabled_when_key_absent(self):
        assert analytics_posthog.is_enabled() is False

    def test_capture_is_noop_when_disabled(self):
        # Must not raise even though no client exists.
        analytics_posthog.capture_event(
            distinct_id="user-1", event="run_started", properties={"x": 1}
        )

    def test_flush_and_shutdown_noop_when_disabled(self):
        analytics_posthog.flush()
        analytics_posthog.shutdown()  # no raise

    def test_blank_key_is_disabled(self, monkeypatch):
        monkeypatch.setenv("POSTHOG_API_KEY", "   ")
        analytics_posthog._reset_for_tests()
        assert analytics_posthog.is_enabled() is False


# ---------------------------------------------------------------------------
# Enabled path
# ---------------------------------------------------------------------------

class TestEnabled:
    def test_capture_forwards_and_injects_meta(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)
        assert analytics_posthog.is_enabled() is True

        analytics_posthog.capture_event(
            distinct_id="owner-9",
            event="run_completed",
            properties={"run_id": "r1", "duration_ms": 1234},
            groups={"workspace": "ws-7"},
        )

        assert len(stub.captured) == 1
        event, kwargs = stub.captured[0]
        assert event == "run_completed"
        assert kwargs["distinct_id"] == "owner-9"
        assert kwargs["groups"] == {"workspace": "ws-7"}
        props = kwargs["properties"]
        assert props["run_id"] == "r1"
        assert props["duration_ms"] == 1234
        # injected meta
        assert props["schema_version"] == analytics_posthog.SCHEMA_VERSION
        assert props["emitter"] == "server"
        assert props["source"] == "api"
        assert props["$geoip_disable"] is True
        assert props["$ip"] is None
        assert analytics_posthog.capture_stats() == {
            "captured_total": 1,
            "failed_total": 0,
            "last_failure_ts": None,
        }

    def test_capture_strips_client_ip_even_if_caller_sets_one(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)

        analytics_posthog.capture_event(
            distinct_id="owner-9",
            event="run_completed",
            properties={"$ip": "203.0.113.9", "$geoip_disable": False},
            groups={"workspace": "ws-7"},
        )

        props = stub.captured[0][1]["properties"]
        assert props["$geoip_disable"] is True
        assert props["$ip"] is None

    def test_request_source_context_is_injected(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)
        tokens = analytics_posthog.set_request_context(source="cli", do_not_track=False)
        try:
            analytics_posthog.capture_event(
                distinct_id="owner-9",
                event="run_completed",
                properties={"run_id": "r1"},
                groups={"workspace": "ws-7"},
            )
        finally:
            analytics_posthog.reset_request_context(tokens)

        props = stub.captured[0][1]["properties"]
        assert props["source"] == "cli"

    def test_request_do_not_track_suppresses_capture(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)
        tokens = analytics_posthog.set_request_context(source="cli", do_not_track=True)
        try:
            analytics_posthog.capture_event(
                distinct_id="owner-9",
                event="run_completed",
                properties={"run_id": "r1"},
                groups={"workspace": "ws-7"},
            )
        finally:
            analytics_posthog.reset_request_context(tokens)

        assert stub.captured == []

    def test_workspace_opt_out_suppresses_capture(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)
        monkeypatch.setattr(
            analytics_posthog,
            "_workspace_analytics_opted_out",
            lambda workspace_id: workspace_id == "ws-off",
        )
        analytics_posthog.capture_event(
            distinct_id="owner-9",
            event="run_completed",
            properties={"run_id": "r1"},
            groups={"workspace": "ws-off"},
        )
        assert stub.captured == []

    def test_identify_user_links_anonymous_install_id(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)
        analytics_posthog.identify_user(
            distinct_id="owner-9",
            anonymous_distinct_id="anon_install",
            groups={"workspace": "ws-7"},
        )

        assert len(stub.captured) == 1
        event, kwargs = stub.captured[0]
        assert event == "$identify"
        assert kwargs["distinct_id"] == "owner-9"
        assert kwargs["groups"] == {"workspace": "ws-7"}
        assert kwargs["properties"]["$anon_distinct_id"] == "anon_install"

    def test_empty_distinct_id_dropped(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)
        analytics_posthog.capture_event(
            distinct_id="", event="run_started", properties={}
        )
        assert stub.captured == []

    def test_falsy_group_values_dropped(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)
        analytics_posthog.capture_event(
            distinct_id="u",
            event="run_started",
            properties={},
            groups={"workspace": ""},
        )
        _, kwargs = stub.captured[0]
        assert kwargs["groups"] == {}

    def test_flush_and_shutdown_forwarded(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)
        analytics_posthog.flush()
        analytics_posthog.shutdown()
        assert stub.flushed == 1
        assert stub.shut == 1

    def test_capture_never_raises_on_client_error(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)

        def _boom(*a, **k):
            raise RuntimeError("network down")

        stub.capture = _boom
        # Must swallow — telemetry can never break a run.
        analytics_posthog.capture_event(
            distinct_id="u", event="run_failed", properties={}
        )
        stats = analytics_posthog.capture_stats()
        assert stats["captured_total"] == 0
        assert stats["failed_total"] == 1
        assert stats["last_failure_ts"] is not None

    def test_identify_never_raises_on_client_error_and_counts_failure(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)

        def _boom(*a, **k):
            raise RuntimeError("network down")

        stub.capture = _boom
        analytics_posthog.identify_user(
            distinct_id="owner-9",
            anonymous_distinct_id="anon_install",
            groups={"workspace": "ws-7"},
        )
        stats = analytics_posthog.capture_stats()
        assert stats["captured_total"] == 0
        assert stats["failed_total"] == 1
        assert stats["last_failure_ts"] is not None

    def test_delivery_error_hook_counts_failed_items(self):
        analytics_posthog._on_delivery_error(RuntimeError("drop"), items=[1, 2, 3])

        stats = analytics_posthog.capture_stats()
        assert stats["captured_total"] == 0
        assert stats["failed_total"] == 3
        assert stats["last_failure_ts"] is not None

    def test_ingestion_canary_reports_through_capture_counter(self, monkeypatch):
        stub = _enable_with_stub(monkeypatch)
        ai_observability._reset_delivery_counters_for_tests()

        emitted = ai_observability.emit_ingestion_canary(source="test")

        assert emitted is True
        assert stub.captured[0][0] == "posthog_ingestion_canary"
        stats = analytics_posthog.capture_stats()
        assert stats["captured_total"] == 1
        assert stats["failed_total"] == 0
        assert stats["last_failure_ts"] is None


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------

class TestHashValue:
    def test_stable_and_truncated(self):
        h1 = analytics_posthog.hash_value("OPENAI_API_KEY")
        h2 = analytics_posthog.hash_value("OPENAI_API_KEY")
        assert h1 == h2
        assert len(h1) == 24
        # Never the clear value.
        assert "OPENAI" not in h1

    def test_custom_length(self):
        assert len(analytics_posthog.hash_value("x", length=12)) == 12

    def test_empty_returns_empty(self):
        assert analytics_posthog.hash_value("") == ""
        assert analytics_posthog.hash_value(None) == ""
