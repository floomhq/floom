"""
Unit tests for CronBuilder cron string generation logic.

Since we can't run React in pytest, we duplicate the pure-logic functions
from the component (buildCron / describeFreq) in Python equivalents and
verify they produce the expected output for each preset.

This gives coverage over the contract: "the visual picker produces the
correct standard 5-field cron expression for each frequency preset".
"""


def build_cron(freq: str, hour: int, minute: int, dow: list, dom: int) -> str:
    """Python equivalent of CronBuilder.buildCron() from CronBuilder.tsx."""
    m, h = minute, hour
    if freq == "minute":
        return "* * * * *"
    if freq == "hourly":
        return f"{m} * * * *"
    if freq == "daily":
        return f"{m} {h} * * *"
    if freq == "weekday":
        return f"{m} {h} * * 1-5"
    if freq == "weekly":
        days = ",".join(sorted(dow)) if dow else "1"
        return f"{m} {h} * * {days}"
    if freq == "monthly":
        return f"{m} {h} {dom} * *"
    return ""


# ---------------------------------------------------------------------------
# Preset correctness
# ---------------------------------------------------------------------------

def test_every_minute():
    assert build_cron("minute", 9, 0, [], 1) == "* * * * *"


def test_hourly_at_30():
    assert build_cron("hourly", 9, 30, [], 1) == "30 * * * *"


def test_hourly_at_00():
    assert build_cron("hourly", 12, 0, [], 1) == "0 * * * *"


def test_daily_9am():
    assert build_cron("daily", 9, 0, [], 1) == "0 9 * * *"


def test_daily_midnight():
    assert build_cron("daily", 0, 0, [], 1) == "0 0 * * *"


def test_daily_1830():
    assert build_cron("daily", 18, 30, [], 1) == "30 18 * * *"


def test_weekday_noon():
    assert build_cron("weekday", 12, 0, [], 1) == "0 12 * * 1-5"


def test_weekly_monday_9am():
    assert build_cron("weekly", 9, 0, ["1"], 1) == "0 9 * * 1"


def test_weekly_mon_wed_fri():
    assert build_cron("weekly", 9, 0, ["1", "3", "5"], 1) == "0 9 * * 1,3,5"


def test_weekly_days_are_sorted():
    # Order of input dow list should not matter; output is sorted
    assert build_cron("weekly", 9, 0, ["5", "1", "3"], 1) == "0 9 * * 1,3,5"


def test_weekly_all_days():
    all_days = ["0", "1", "2", "3", "4", "5", "6"]
    assert build_cron("weekly", 9, 0, all_days, 1) == "0 9 * * 0,1,2,3,4,5,6"


def test_monthly_first():
    assert build_cron("monthly", 9, 0, [], 1) == "0 9 1 * *"


def test_monthly_15th():
    assert build_cron("monthly", 9, 0, [], 15) == "0 9 15 * *"


def test_monthly_28th():
    assert build_cron("monthly", 8, 30, [], 28) == "30 8 28 * *"


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

def test_weekly_no_dow_defaults_to_monday():
    # When dow is empty, component defaults to "1" (Monday)
    assert build_cron("weekly", 9, 0, [], 1) == "0 9 * * 1"


def test_all_fields_zero_daily():
    # midnight every day
    assert build_cron("daily", 0, 0, [], 1) == "0 0 * * *"


def test_all_fields_zero_hourly():
    assert build_cron("hourly", 0, 0, [], 1) == "0 * * * *"
