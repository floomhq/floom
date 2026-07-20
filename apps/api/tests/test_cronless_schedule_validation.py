from __future__ import annotations

import logging
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from models import WorkerContractTrigger, WorkerTrigger
from services.worker_registry_ops import _parse_worker_payload
import scheduler


@pytest.mark.parametrize(
    "trigger_block",
    (
        "trigger:\n  type: schedule\n  timezone: Europe/Berlin",
        "triggers:\n  - type: schedule\n    timezone: Europe/Berlin",
    ),
)
def test_worker_save_rejects_schedule_trigger_without_cron(trigger_block):
    worker_yml = f"""
id: cronless-worker
name: Cronless worker
{trigger_block}
runtime:
  type: python
  entrypoint: run.py
  runner: e2b
"""

    with pytest.raises(HTTPException, match="cron expression") as exc_info:
        _parse_worker_payload(worker_yml)

    assert exc_info.value.status_code == 400
    assert "trigger.cron" in exc_info.value.detail


@pytest.mark.parametrize("alias", ("cron", "scheduled"))
def test_schedule_alias_without_cron_is_rejected_on_save(alias):
    worker_yml = f"""
id: cronless-worker
name: Cronless worker
trigger:
  type: {alias}
runtime:
  type: python
  entrypoint: run.py
  runner: e2b
"""

    with pytest.raises(HTTPException, match="cron expression"):
        _parse_worker_payload(worker_yml)


def test_existing_cronless_schedule_models_remain_readable():
    assert WorkerTrigger(type="schedule", timezone="Europe/Berlin").cron is None
    assert WorkerContractTrigger(type="schedule", timezone="Europe/Berlin").cron is None


def test_existing_invalid_schedule_warns_once_per_worker(caplog):
    class Workers:
        @staticmethod
        def list_due_schedule_triggers(*, now_iso):
            return [
                {
                    "id": "trigger-1",
                    "worker_id": "phd-research-assistant",
                    "owner_id": "user-1",
                    "workspace_id": "workspace-1",
                    "config_json": '{"timezone":"Europe/Berlin"}',
                    "next_run_at": None,
                }
            ]

    class Repos:
        workers = Workers()

    scheduler._WARNED_CRONLESS_SCHEDULE_WORKERS.clear()
    now = datetime(2026, 7, 19, tzinfo=timezone.utc)
    with caplog.at_level(logging.WARNING, logger="floom.scheduler"):
        assert scheduler._tick_trigger_rows(Repos(), now, now.isoformat()) == 1
        assert scheduler._tick_trigger_rows(Repos(), now, now.isoformat()) == 1

    matching = [
        record for record in caplog.records
        if "phd-research-assistant" in record.getMessage()
    ]
    assert len(matching) == 1
    assert matching[0].levelno == logging.WARNING
    assert "will not run" in matching[0].getMessage()
