"""Failure-alert throttle — dedup + per-workspace daily cap + recovery.

Regression guard for the 2026-07 alert-email storm: two crash-looping
scheduled workers emitted ~163 failure emails in a day (one per failed run,
no dedup) and exhausted the shared Resend quota, blocking signup email.

Covers:
  - repeated identical failures → ONE alert (dedup within cooldown window)
  - a DIFFERENT failure signature re-alerts
  - the per-workspace/day cap trips as a hard backstop even across signatures
  - recovery clears dedup so the next failure re-alerts
  - in-process fallback throttles when no durable repo is registered
  - a persistence error degrades to the fallback (never crashes, still throttles)
  - failure_signature normalises volatile ids and prefers error_code
  - _fire_alert_webhooks suppresses a throttled failure email but not webhooks
    or success emails
"""
from __future__ import annotations

import importlib
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _thr():
    return importlib.import_module("services.alert_throttle")


def _rn():
    return importlib.import_module("services.run_notifications")


class _FakeThrottleRepo:
    """In-memory AlertThrottleRepository double (ISO strings sort lexically)."""

    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, str]] = []

    def record(self, *, workspace_id, worker_id, signature, sent_at_iso) -> None:
        self.rows.append((workspace_id, worker_id, signature, sent_at_iso))

    def count_since(self, *, since_iso, workspace_id=None, worker_id=None, signature=None) -> int:
        return sum(
            1
            for (ws, wk, sg, at) in self.rows
            if at >= since_iso
            and (workspace_id is None or ws == workspace_id)
            and (worker_id is None or wk == worker_id)
            and (signature is None or sg == signature)
        )

    def clear_dedup(self, *, workspace_id, worker_id) -> None:
        self.rows = [r for r in self.rows if not (r[0] == workspace_id and r[1] == worker_id)]


class _ExplodingRepo:
    def record(self, **_):
        raise RuntimeError("db down")

    def count_since(self, **_):
        raise RuntimeError("db down")


@pytest.fixture(autouse=True)
def _reset_fallback():
    # The in-process fallback is module-global; reset between tests.
    thr = _thr()
    thr._fallback = thr._InProcessThrottle()
    yield


# ---------------------------------------------------------------------------
# Dedup / cooldown
# ---------------------------------------------------------------------------

def test_repeated_failures_send_one_alert(monkeypatch):
    monkeypatch.setenv("WORKEROS_ALERT_DEDUP_WINDOW_SECONDS", "14400")
    monkeypatch.setenv("WORKEROS_ALERT_WORKSPACE_DAILY_CAP", "100")
    thr = _thr()
    repos = SimpleNamespace(alert_throttle=_FakeThrottleRepo())
    now = datetime(2026, 7, 6, 12, 0, tzinfo=timezone.utc)

    decisions = [
        thr.should_send_failure_alert(
            repos=repos, workspace_id="ws1", worker_id="w1", signature="missing_secret",
            now=now + timedelta(minutes=10 * i),
        )
        for i in range(5)
    ]
    assert decisions == [True, False, False, False, False]


def test_different_signature_realerts(monkeypatch):
    monkeypatch.setenv("WORKEROS_ALERT_DEDUP_WINDOW_SECONDS", "14400")
    monkeypatch.setenv("WORKEROS_ALERT_WORKSPACE_DAILY_CAP", "100")
    thr = _thr()
    repos = SimpleNamespace(alert_throttle=_FakeThrottleRepo())
    now = datetime(2026, 7, 6, 12, 0, tzinfo=timezone.utc)

    a = thr.should_send_failure_alert(repos=repos, workspace_id="ws1", worker_id="w1", signature="sigA", now=now)
    b = thr.should_send_failure_alert(repos=repos, workspace_id="ws1", worker_id="w1", signature="sigB", now=now)
    assert a is True and b is True


def test_realerts_after_window_elapses(monkeypatch):
    monkeypatch.setenv("WORKEROS_ALERT_DEDUP_WINDOW_SECONDS", "3600")
    monkeypatch.setenv("WORKEROS_ALERT_WORKSPACE_DAILY_CAP", "100")
    thr = _thr()
    repos = SimpleNamespace(alert_throttle=_FakeThrottleRepo())
    now = datetime(2026, 7, 6, 12, 0, tzinfo=timezone.utc)

    first = thr.should_send_failure_alert(repos=repos, workspace_id="ws1", worker_id="w1", signature="s", now=now)
    within = thr.should_send_failure_alert(repos=repos, workspace_id="ws1", worker_id="w1", signature="s", now=now + timedelta(minutes=30))
    after = thr.should_send_failure_alert(repos=repos, workspace_id="ws1", worker_id="w1", signature="s", now=now + timedelta(minutes=61))
    assert [first, within, after] == [True, False, True]


# ---------------------------------------------------------------------------
# Workspace daily cap backstop
# ---------------------------------------------------------------------------

def test_workspace_daily_cap_trips_across_signatures(monkeypatch):
    # Dedup would allow every distinct signature; the cap must still stop the storm.
    monkeypatch.setenv("WORKEROS_ALERT_DEDUP_WINDOW_SECONDS", "14400")
    monkeypatch.setenv("WORKEROS_ALERT_WORKSPACE_DAILY_CAP", "3")
    thr = _thr()
    repos = SimpleNamespace(alert_throttle=_FakeThrottleRepo())
    now = datetime(2026, 7, 6, 12, 0, tzinfo=timezone.utc)

    results = [
        thr.should_send_failure_alert(
            repos=repos, workspace_id="ws1", worker_id="w1", signature=f"sig{i}",
            now=now + timedelta(minutes=i),
        )
        for i in range(6)
    ]
    assert results == [True, True, True, False, False, False]


def test_daily_cap_is_per_workspace(monkeypatch):
    monkeypatch.setenv("WORKEROS_ALERT_DEDUP_WINDOW_SECONDS", "14400")
    monkeypatch.setenv("WORKEROS_ALERT_WORKSPACE_DAILY_CAP", "1")
    thr = _thr()
    repos = SimpleNamespace(alert_throttle=_FakeThrottleRepo())
    now = datetime(2026, 7, 6, 12, 0, tzinfo=timezone.utc)

    ws1 = thr.should_send_failure_alert(repos=repos, workspace_id="ws1", worker_id="w1", signature="s", now=now)
    ws1_2 = thr.should_send_failure_alert(repos=repos, workspace_id="ws1", worker_id="w2", signature="s2", now=now)
    ws2 = thr.should_send_failure_alert(repos=repos, workspace_id="ws2", worker_id="w9", signature="s", now=now)
    assert [ws1, ws1_2, ws2] == [True, False, True]


# ---------------------------------------------------------------------------
# Recovery
# ---------------------------------------------------------------------------

def test_recovery_clears_dedup(monkeypatch):
    monkeypatch.setenv("WORKEROS_ALERT_DEDUP_WINDOW_SECONDS", "14400")
    monkeypatch.setenv("WORKEROS_ALERT_WORKSPACE_DAILY_CAP", "100")
    thr = _thr()
    repos = SimpleNamespace(alert_throttle=_FakeThrottleRepo())
    now = datetime(2026, 7, 6, 12, 0, tzinfo=timezone.utc)

    first = thr.should_send_failure_alert(repos=repos, workspace_id="ws1", worker_id="w1", signature="s", now=now)
    suppressed = thr.should_send_failure_alert(repos=repos, workspace_id="ws1", worker_id="w1", signature="s", now=now + timedelta(minutes=5))
    thr.note_worker_recovered(repos=repos, workspace_id="ws1", worker_id="w1")
    after_recovery = thr.should_send_failure_alert(repos=repos, workspace_id="ws1", worker_id="w1", signature="s", now=now + timedelta(minutes=10))
    assert [first, suppressed, after_recovery] == [True, False, True]


# ---------------------------------------------------------------------------
# Fallback + resilience
# ---------------------------------------------------------------------------

def test_in_process_fallback_when_no_repo(monkeypatch):
    monkeypatch.setenv("WORKEROS_ALERT_DEDUP_WINDOW_SECONDS", "14400")
    monkeypatch.setenv("WORKEROS_ALERT_WORKSPACE_DAILY_CAP", "100")
    thr = _thr()
    repos = SimpleNamespace()  # no alert_throttle attribute
    now = datetime(2026, 7, 6, 12, 0, tzinfo=timezone.utc)

    decisions = [
        thr.should_send_failure_alert(
            repos=repos, workspace_id="wsX", worker_id="wX", signature="s",
            now=now + timedelta(minutes=i),
        )
        for i in range(4)
    ]
    assert decisions == [True, False, False, False]


def test_persistence_error_degrades_to_fallback(monkeypatch):
    monkeypatch.setenv("WORKEROS_ALERT_DEDUP_WINDOW_SECONDS", "14400")
    monkeypatch.setenv("WORKEROS_ALERT_WORKSPACE_DAILY_CAP", "100")
    thr = _thr()
    repos = SimpleNamespace(alert_throttle=_ExplodingRepo())
    now = datetime(2026, 7, 6, 12, 0, tzinfo=timezone.utc)

    first = thr.should_send_failure_alert(repos=repos, workspace_id="wsE", worker_id="wE", signature="s", now=now)
    second = thr.should_send_failure_alert(repos=repos, workspace_id="wsE", worker_id="wE", signature="s", now=now + timedelta(minutes=1))
    # Never raised; fallback still throttled the repeat.
    assert [first, second] == [True, False]


# ---------------------------------------------------------------------------
# failure_signature
# ---------------------------------------------------------------------------

def test_signature_prefers_error_code():
    thr = _thr()
    assert thr.failure_signature(error="anything", error_code="Missing_Secret") == "missing_secret"


def test_signature_normalises_volatile_ids():
    thr = _thr()
    a = thr.failure_signature(error="run run_abc123 failed at 2026-07-06T12:00:01Z")
    b = thr.failure_signature(error="run run_def999 failed at 2026-07-06T18:44:59Z")
    assert a == b  # volatile ids/timestamps normalised → same dedup key


def test_signature_empty_falls_back_to_status():
    thr = _thr()
    assert thr.failure_signature(error="", status="failed") == "failed"


# ---------------------------------------------------------------------------
# _fire_alert_webhooks respects the gate
# ---------------------------------------------------------------------------

def _repos_with_email_alert():
    return SimpleNamespace(
        alerts=SimpleNamespace(
            list=lambda *, worker_id: [
                {"email_to": '["notify@example.com"]', "events": "failed,completed", "url": ""}
            ]
        ),
        workers=SimpleNamespace(get_any=lambda *, worker_id: {"name": "W", "workspace_id": "ws1"}),
        runs=SimpleNamespace(get=lambda *, user_id, run_id: None),
    )


def test_fire_alert_webhooks_suppresses_failure_email_when_gate_false():
    rn = _rn()
    repos = _repos_with_email_alert()
    calls: list = []
    with patch("services.run_notifications._send_email_notification", side_effect=lambda **kw: calls.append(kw)):
        rn._fire_alert_webhooks(
            run_id="run_1", worker_id="w1", status="failed", error="boom",
            repos=repos, failure_email_allowed=lambda: False,
        )
    assert calls == []  # failure email suppressed


def test_fire_alert_webhooks_sends_failure_email_when_gate_true():
    rn = _rn()
    repos = _repos_with_email_alert()
    calls: list = []
    with patch("services.run_notifications._send_email_notification", side_effect=lambda **kw: calls.append(kw)):
        rn._fire_alert_webhooks(
            run_id="run_1", worker_id="w1", status="failed", error="boom",
            repos=repos, failure_email_allowed=lambda: True,
        )
    assert len(calls) == 1


def test_fire_alert_webhooks_success_email_ignores_gate():
    rn = _rn()
    repos = _repos_with_email_alert()
    calls: list = []
    # Gate would suppress, but success emails must never be throttled.
    with patch("services.run_notifications._send_email_notification", side_effect=lambda **kw: calls.append(kw)):
        rn._fire_alert_webhooks(
            run_id="run_1", worker_id="w1", status="completed", error=None,
            repos=repos, failure_email_allowed=lambda: False,
        )
    assert len(calls) == 1
