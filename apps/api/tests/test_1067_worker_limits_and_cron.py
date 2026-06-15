"""#1067 — worker config bypassed execution-cost ceilings.

(1) limits in worker_yml were stored verbatim: author-set timeout_seconds /
    max_total_tokens / max_output_tokens / max_monthly_cost_usd had no server
    ceiling. Timeout is now rejected above the operator maximum at model level;
    token and spend ceilings are clamped on every create/update path that
    builds WorkerLimits.
(2) cron had no minimum interval: every-minute and 6-field sub-minute crons
    were accepted. Now rejected (min 5-minute interval, 5-field only).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerLimits
from cron_utils import is_valid_cron_expr


# --- (1) limit clamping -------------------------------------------------------

def test_oversized_limits_reject_timeout_and_clamp_tokens():
    with pytest.raises(ValidationError):
        WorkerLimits(timeout_seconds=3601)

    lim = WorkerLimits(
        timeout_seconds=3600,
        max_output_tokens=999999999,
        max_total_tokens=999999999,
        max_monthly_cost_usd=999999.0,
    )
    assert lim.timeout_seconds == 3600
    assert lim.max_output_tokens == 1_000_000
    assert lim.max_total_tokens == 2_000_000
    assert lim.max_monthly_cost_usd == 100_000.0


def test_normal_limits_pass_through():
    lim = WorkerLimits(
        timeout_seconds=600,
        max_output_tokens=8000,
        max_total_tokens=50000,
        max_monthly_cost_usd=25.0,
    )
    assert lim.timeout_seconds == 600
    assert lim.max_output_tokens == 8000
    assert lim.max_total_tokens == 50000
    assert lim.max_monthly_cost_usd == 25.0


def test_defaults_unchanged():
    lim = WorkerLimits()
    assert lim.timeout_seconds == 300
    assert lim.max_output_tokens == 1_000_000
    assert lim.max_total_tokens == 1_000_000
    assert lim.max_monthly_cost_usd is None  # unlimited stays unlimited


# --- (2) cron minimum interval / field count ---------------------------------

def test_every_minute_cron_rejected():
    assert is_valid_cron_expr("* * * * *") is False
    assert is_valid_cron_expr("*/1 * * * *") is False
    assert is_valid_cron_expr("*/2 * * * *") is False


def test_six_field_cron_rejected():
    assert is_valid_cron_expr("* * * * * *") is False


def test_valid_crons_accepted():
    assert is_valid_cron_expr("*/5 * * * *") is True
    assert is_valid_cron_expr("0 9 * * *") is True
    assert is_valid_cron_expr("0 * * * *") is True  # hourly
    assert is_valid_cron_expr("0 9 * * 1") is True


def test_garbage_cron_still_rejected():
    assert is_valid_cron_expr("notacron") is False
    assert is_valid_cron_expr("") is False
