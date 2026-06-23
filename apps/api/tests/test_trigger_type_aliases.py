from __future__ import annotations

import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerConfig, WorkerContract, WorkerContractTrigger


def test_legacy_cron_trigger_alias_normalizes_to_schedule():
    config = WorkerConfig(
        id="gmail_inbox_manager",
        name="Gmail Inbox Manager",
        trigger={"type": "cron", "cron": "0 7 * * *"},
        runtime={"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        inputs=[],
        secrets=[],
        outputs=[],
    )

    assert config.trigger.type == "schedule"
    assert config.trigger.cron == "0 7 * * *"


def test_contract_cron_trigger_alias_normalizes_to_schedule():
    trigger = WorkerContractTrigger(type="cron", cron="0 7 * * *")

    assert trigger.type == "schedule"


def test_contract_accepts_single_trigger_list_from_worker_author():
    contract = WorkerContract(
        schema_version="0.3",
        name="daily-brief",
        title="Daily Brief",
        description="Daily Brief",
        version="0.1.0",
        trigger=[{"type": "schedule", "cron": "0 7 * * *"}],
        exec={"entry": "run.py", "runner": "e2b", "runtime": "python311"},
    )

    assert contract.trigger.type == "schedule"
    assert contract.trigger.cron == "0 7 * * *"
    assert contract.triggers
    assert contract.triggers[0].type == "schedule"
