"""Repository-backed run cancellation checks for sandbox drivers."""

from __future__ import annotations

import logging
import os
import threading

logger = logging.getLogger("floom.runner_sandbox.cancel")

_CANCEL_FLAG_DB_READ_ERRORS_LOCK = threading.Lock()
_CANCEL_FLAG_DB_READ_ERRORS_TOTAL = 0

# A single failed/blank cancel-flag read must NOT kill a run: drivers poll this
# while streaming, so one transient repository blip (connection pool hiccup,
# replica lag returning no row) used to surface as a spurious
# "Run cancelled by user" mid-turn — observed in cloud on 2026-07-08 with runs
# whose DB row had cancel_requested=false. Only this many CONSECUTIVE failed
# reads for the same run are treated as a cancel signal; any successful read
# resets the streak. A genuinely cancelled run is unaffected (its reads succeed
# and return the flag), and a truly deleted/orphaned row still stops the run
# after the streak threshold (a few poll cycles) instead of on the first blip.
_CANCEL_READ_FAILURE_STREAK_THRESHOLD = 3

_CANCEL_READ_FAILURE_STREAKS_LOCK = threading.Lock()
_CANCEL_READ_FAILURE_STREAKS: dict[str, int] = {}


def cancel_flag_db_read_errors_total() -> int:
    with _CANCEL_FLAG_DB_READ_ERRORS_LOCK:
        return _CANCEL_FLAG_DB_READ_ERRORS_TOTAL


def _record_cancel_flag_read_error(run_id: str, message: str, *, exc_info: bool) -> None:
    global _CANCEL_FLAG_DB_READ_ERRORS_TOTAL
    with _CANCEL_FLAG_DB_READ_ERRORS_LOCK:
        _CANCEL_FLAG_DB_READ_ERRORS_TOTAL += 1
    logger.warning(message, run_id, exc_info=exc_info)


def _reset_failure_streak(run_id: str) -> None:
    with _CANCEL_READ_FAILURE_STREAKS_LOCK:
        _CANCEL_READ_FAILURE_STREAKS.pop(run_id, None)


def _bump_failure_streak(run_id: str) -> bool:
    """Record one failed cancel-flag read; return True once the streak means cancel."""
    with _CANCEL_READ_FAILURE_STREAKS_LOCK:
        streak = _CANCEL_READ_FAILURE_STREAKS.get(run_id, 0) + 1
        if streak >= _CANCEL_READ_FAILURE_STREAK_THRESHOLD:
            _CANCEL_READ_FAILURE_STREAKS.pop(run_id, None)
            return True
        _CANCEL_READ_FAILURE_STREAKS[run_id] = streak
        return False


def run_cancel_requested(run_id: str) -> bool:
    """Return whether a run has been cancelled through the active repository."""
    try:
        from db import get_repositories

        row = get_repositories().runs.get_any(run_id=run_id)
        if row is None:
            if os.environ.get("WORKEROS_DEPLOY", "").strip().lower() == "cloud":
                _record_cancel_flag_read_error(
                    run_id,
                    "Cancel flag read found no run row for %s in cloud; counting toward cancel streak",
                    exc_info=False,
                )
                return _bump_failure_streak(run_id)
            return False
        _reset_failure_streak(run_id)
        return bool(row.get("cancel_requested"))
    except Exception as exc:
        if os.environ.get("WORKEROS_DEPLOY", "").strip().lower() != "cloud":
            if "no such table: runs" in str(exc).lower():
                return False
        _record_cancel_flag_read_error(
            run_id,
            "Cancel flag read failed for run %s; counting toward cancel streak",
            exc_info=True,
        )
        return _bump_failure_streak(run_id)
