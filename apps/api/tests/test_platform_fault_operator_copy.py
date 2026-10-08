"""Platform faults must read as OUR fault, not as the operator's.

Incident 2026-08-02: a customer's scheduled run was abandoned by a platform
restart and the run card said "This worker failed to run. Check the run logs for
details, then edit or re-run the worker." The worker was fine. The three codes
that only ever mean "Floom stopped", scheduler_missed, executor_lost_mid_run and
run_claimed_without_dispatch, had no headline entry and fell through to that
generic operator copy.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from services.public_view import (  # noqa: E402
    _OPERATOR_ERROR_GENERIC,
    _operator_error_message,
)

PLATFORM_FAULT_CODES = [
    "scheduler_missed",
    "executor_lost_mid_run",
    "run_claimed_without_dispatch",
]


@pytest.mark.parametrize("code", PLATFORM_FAULT_CODES)
def test_platform_fault_codes_have_their_own_headline(code):
    message = _operator_error_message(None, code)

    assert message is not None
    assert message != _OPERATOR_ERROR_GENERIC, f"{code} still falls back to the generic blame copy"
    assert "Floom" in message, f"{code} must name the platform as the party at fault"


def test_scheduler_missed_says_the_worker_is_fine():
    message = _operator_error_message(None, "scheduler_missed")

    assert message == (
        "Floom's scheduler was delayed, so this scheduled run started later than its scheduled "
        "time. The worker itself is fine and no action is needed."
    )


def test_executor_lost_mid_run_names_the_platform_fault():
    message = _operator_error_message(None, "executor_lost_mid_run")

    assert message == (
        "Floom's execution service stopped while this run was in progress. This is a platform "
        "fault, not a problem with the worker. Re-run it if the work did not complete."
    )


def test_run_claimed_without_dispatch_says_nothing_ran():
    message = _operator_error_message(None, "run_claimed_without_dispatch")

    assert message == (
        "Floom picked this run up but the platform stopped before the worker started. Nothing in "
        "the worker ran. This is a platform fault; re-run it."
    )


@pytest.mark.parametrize("code", PLATFORM_FAULT_CODES)
def test_platform_fault_copy_wins_over_the_raw_internal_error(code):
    """The raw text of these failures is internal jargon; the code decides."""
    message = _operator_error_message(
        "Scheduled fire was missed or delayed by the scheduler.", code
    )

    assert "Floom" in message
    assert "edit or re-run the worker" not in message


@pytest.mark.parametrize("code", PLATFORM_FAULT_CODES)
def test_platform_fault_copy_never_blames_the_operator(code):
    message = _operator_error_message(None, code)

    assert "This worker failed to run" not in message
    assert "edit or re-run the worker" not in message
    assert "\u2014" not in message, "operator copy must not use em dashes"
