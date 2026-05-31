from __future__ import annotations

import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerConfig, WorkerContractTrigger


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
