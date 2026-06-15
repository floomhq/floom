"""Repository-backed run cancellation checks for sandbox drivers."""

from __future__ import annotations

import logging
import os
import threading

logger = logging.getLogger("floom.runner_sandbox.cancel")

_CANCEL_FLAG_DB_READ_ERRORS_LOCK = threading.Lock()
_CANCEL_FLAG_DB_READ_ERRORS_TOTAL = 0


def cancel_flag_db_read_errors_total() -> int:
    with _CANCEL_FLAG_DB_READ_ERRORS_LOCK:
        return _CANCEL_FLAG_DB_READ_ERRORS_TOTAL


def _record_cancel_flag_read_error(run_id: str, message: str, *, exc_info: bool) -> None:
    global _CANCEL_FLAG_DB_READ_ERRORS_TOTAL
    with _CANCEL_FLAG_DB_READ_ERRORS_LOCK:
        _CANCEL_FLAG_DB_READ_ERRORS_TOTAL += 1
    logger.warning(message, run_id, exc_info=exc_info)


def run_cancel_requested(run_id: str) -> bool:
    """Return whether a run has been cancelled through the active repository."""
    try:
        from db import get_repositories

        row = get_repositories().runs.get_any(run_id=run_id)
        if row is None:
            if os.environ.get("WORKEROS_DEPLOY", "").strip().lower() == "cloud":
                _record_cancel_flag_read_error(
                    run_id,
                    "Cancel flag read found no run row for %s in cloud; treating as cancelled",
                    exc_info=False,
                )
                return True
            return False
        return bool(row.get("cancel_requested"))
    except Exception as exc:
        if os.environ.get("WORKEROS_DEPLOY", "").strip().lower() != "cloud":
            if "no such table: runs" in str(exc).lower():
                return False
        _record_cancel_flag_read_error(
            run_id,
            "Cancel flag read failed for run %s; treating as cancelled",
            exc_info=True,
        )
        return True
