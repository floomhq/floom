"""Cron scheduler — background thread for schedule-triggered workers.

Runs once per minute. Polls workers with trigger.type == 'schedule',
computes next_run_at via croniter, fires a run when due.

Concurrency rule: skip if previous run for this worker is still running.
"""

import logging
import threading
from datetime import datetime, timezone
from typing import Optional

from croniter import croniter

from db import get_db, now_iso
from worker_registry import discover_workers, get_worker_config
from run_service import create_run, start_run

logger = logging.getLogger("floom.scheduler")

POLL_INTERVAL_SECONDS = 60  # check every minute
_stop_event: threading.Event = threading.Event()


def compute_next_run_at(cron_expr: str, after: datetime) -> Optional[str]:
    """Return the next ISO run time after `after` for the given cron expression.

    Returns None if the expression is invalid.
    """
    try:
        it = croniter(cron_expr, after)
        next_dt = it.get_next(datetime)
        return next_dt.replace(tzinfo=timezone.utc).isoformat()
    except Exception as exc:
        logger.warning("Invalid cron expression %r: %s", cron_expr, exc)
        return None


def _is_worker_running(worker_id: str) -> bool:
    """Return True if there is a run in 'running' state for this worker."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(*) as cnt FROM runs WHERE worker_id = ? AND status = 'running'",
            (worker_id,),
        )
        row = cursor.fetchone()
        return (row["cnt"] if row else 0) > 0


def _get_or_init_next_run_at(worker_id: str, cron_expr: str) -> Optional[str]:
    """Get next_run_at from DB, initializing it if NULL."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT next_run_at FROM workers WHERE id = ?",
            (worker_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None
        if row["next_run_at"]:
            return row["next_run_at"]

    # Initialize: compute from now
    now = datetime.now(timezone.utc)
    next_at = compute_next_run_at(cron_expr, now)
    if next_at:
        with get_db() as conn:
            conn.execute(
                "UPDATE workers SET next_run_at = ? WHERE id = ?",
                (next_at, worker_id),
            )
    return next_at


def _tick() -> None:
    """One scheduler tick — fire any due scheduled workers."""
    now = datetime.now(timezone.utc)
    now_iso_str = now.isoformat()

    workers = discover_workers(use_cache=False)
    for w in workers:
        if w.get("status") == "error":
            continue

        config = get_worker_config(w["id"])
        if not config:
            continue
        if config.trigger.type != "schedule":
            continue

        cron_expr = config.trigger.cron
        if not cron_expr:
            logger.warning(
                "Worker %s has trigger.type=schedule but no cron expression", w["id"]
            )
            continue

        next_at_str = _get_or_init_next_run_at(w["id"], cron_expr)
        if not next_at_str:
            continue

        # Parse next_run_at — handle both naive and aware datetimes
        try:
            next_at = datetime.fromisoformat(next_at_str)
            if next_at.tzinfo is None:
                next_at = next_at.replace(tzinfo=timezone.utc)
        except Exception:
            logger.warning(
                "Invalid next_run_at for worker %s: %r", w["id"], next_at_str
            )
            continue

        if now < next_at:
            continue  # not due yet

        # Concurrency guard: skip if previous run still running
        if _is_worker_running(w["id"]):
            logger.info(
                "Skipping scheduled run for %s — previous run still running", w["id"]
            )
            # Advance next_run_at so we don't re-attempt this slot every tick
            new_next = compute_next_run_at(cron_expr, now)
            if new_next:
                with get_db() as conn:
                    conn.execute(
                        "UPDATE workers SET next_run_at = ? WHERE id = ?",
                        (new_next, w["id"]),
                    )
            continue

        # Fire the run
        logger.info(
            "Firing scheduled run for worker %s (was due %s)", w["id"], next_at_str
        )
        try:
            run_id = create_run(w["id"], {}, trigger_source="schedule")
            start_run(run_id, w["id"], {})

            # Update last_scheduled_run_at + next_run_at
            new_next = compute_next_run_at(cron_expr, now)
            with get_db() as conn:
                conn.execute(
                    "UPDATE workers SET last_scheduled_run_at = ?, next_run_at = ? WHERE id = ?",
                    (now_iso_str, new_next, w["id"]),
                )
            logger.info(
                "Scheduled run %s started for worker %s, next at %s",
                run_id,
                w["id"],
                new_next,
            )
        except Exception as exc:
            logger.exception(
                "Failed to fire scheduled run for worker %s: %s", w["id"], exc
            )


def start_scheduler() -> None:
    """Start the scheduler in a background daemon thread."""

    def _loop() -> None:
        logger.info("Scheduler started (poll interval: %ds)", POLL_INTERVAL_SECONDS)
        while not _stop_event.is_set():
            try:
                _tick()
            except Exception as exc:
                logger.exception("Scheduler tick failed: %s", exc)
            _stop_event.wait(timeout=POLL_INTERVAL_SECONDS)
        logger.info("Scheduler stopped")

    t = threading.Thread(target=_loop, daemon=True, name="workeros-scheduler")
    t.start()


def stop_scheduler() -> None:
    """Signal the scheduler to stop."""
    _stop_event.set()
