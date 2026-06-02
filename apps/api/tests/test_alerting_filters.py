from __future__ import annotations

import importlib
import json
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
