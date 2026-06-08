from __future__ import annotations

import importlib
import json
import sqlite3
import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _alerting():
    return importlib.import_module("alerting")


def test_manual_only_worker_is_filtered_from_scheduler_alerts():
    alerting = _alerting()
    config = {"trigger": {"type": "manual"}}

    assert alerting._is_manual_only_worker("manual", json.dumps(config)) is True


def test_scheduled_worker_is_not_filtered_from_scheduler_alerts():
    alerting = _alerting()
    config = {"trigger": {"type": "schedule", "cron": "0 * * * *"}}

    assert alerting._is_manual_only_worker("schedule", json.dumps(config)) is False


def test_multi_trigger_worker_with_schedule_is_not_filtered_from_scheduler_alerts():
    alerting = _alerting()
    config = {
        "trigger": {"type": "manual"},
        "triggers": [{"type": "manual"}, {"type": "schedule", "cron": "0 9 * * *"}],
    }

    assert alerting._is_manual_only_worker("manual", json.dumps(config)) is False


def test_persisted_schedule_trigger_is_not_filtered_from_scheduler_alerts():
    alerting = _alerting()
    config = {"trigger": {"type": "manual"}}
    triggers = [{"type": "schedule", "cron": "0 * * * *"}]

    assert alerting._is_manual_only_worker("manual", json.dumps(config), json.dumps(triggers)) is False


def test_resolved_incident_can_reopen_without_duplicate_spam():
    alerting = _alerting()
    conn = sqlite3.connect(":memory:")
    alerting._ensure_alert_incidents_table(conn)

    alerting._open_incident(conn, "worker-a", "consecutive_failures", "3 failures", "old")
    assert alerting._is_incident_open(conn, "worker-a", "consecutive_failures") is True
    assert alerting._resolve_incident(conn, "worker-a", "consecutive_failures") is True
    assert alerting._is_incident_open(conn, "worker-a", "consecutive_failures") is False

    alerting._open_incident(conn, "worker-a", "consecutive_failures", "4 failures", "new")
    assert alerting._is_incident_open(conn, "worker-a", "consecutive_failures") is True
    rows = conn.execute(
        """
        SELECT reason, details, resolved_at
        FROM alert_incidents
        WHERE worker_id = ? AND incident_key = ?
        """,
        ("worker-a", "consecutive_failures"),
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "4 failures"
    assert rows[0][1] == "new"
    assert rows[0][2] is None


def test_alerting_tick_fires_every_n_ticks(monkeypatch):
    alerting = _alerting()
    fired: list[int] = []

    monkeypatch.setattr(alerting, "_ALERT_ENABLED", True)
    monkeypatch.setattr(alerting, "_ALERT_POLL_EVERY_N_TICKS", 5)
    monkeypatch.setattr(alerting, "_tick_counter", 0)
    monkeypatch.setattr(alerting, "_run_alerting_check", lambda: fired.append(alerting._tick_counter))

    for _ in range(10):
        alerting.alerting_tick()

    assert fired == [5, 10]
