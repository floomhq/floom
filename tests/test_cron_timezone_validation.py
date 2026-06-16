import sys
from pathlib import Path

import pytest
from pydantic import ValidationError


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_worker_trigger_rejects_invalid_timezone():
    from models import WorkerTrigger

    with pytest.raises(ValidationError, match="invalid timezone"):
        WorkerTrigger(type="schedule", cron="0 9 * * *", timezone="Foo/Bar-Not-A-Zone")


def test_worker_contract_trigger_rejects_invalid_timezone():
    from models import WorkerContractTrigger

    with pytest.raises(ValidationError, match="invalid timezone"):
        WorkerContractTrigger(type="schedule", cron="0 9 * * *", timezone="Foo/Bar-Not-A-Zone")


def test_worker_update_request_rejects_invalid_cron_timezone():
    from models import WorkerUpdateRequest

    with pytest.raises(ValidationError, match="invalid timezone"):
        WorkerUpdateRequest(cron_timezone="Foo/Bar-Not-A-Zone")


def test_timezone_validation_strips_valid_timezone():
    from models import WorkerTrigger

    trigger = WorkerTrigger(type="schedule", cron="0 9 * * *", timezone=" Europe/Berlin ")

    assert trigger.timezone == "Europe/Berlin"
