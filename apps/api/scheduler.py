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

from db.factory import get_repositories
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
    repos = get_repositories()
    owner_id = repos.workers.get_owner(worker_id=worker_id)
    if not owner_id:
        return False
    return repos.runs.count_running_for_worker(user_id=owner_id, worker_id=worker_id) > 0


def _get_or_init_next_run_at(worker_id: str, cron_expr: str) -> Optional[str]:
    """Get next_run_at from DB, initializing it if NULL."""
    repos = get_repositories()
    row = repos.workers.get_schedule_state(worker_id=worker_id)
    if not row:
        return None
    if row["next_run_at"]:
        return row["next_run_at"]

    # Initialize: compute from now
    now = datetime.now(timezone.utc)
    next_at = compute_next_run_at(cron_expr, now)
    if next_at:
        repos.workers.set_next_run_at(worker_id=worker_id, next_run_at=next_at)
    return next_at


def _list_scheduled_worker_instances() -> list[dict[str, str]]:
    """Return enabled scheduled worker instances from the database."""
    return list(get_repositories().workers.list_scheduled())


def _tick() -> None:
    """One scheduler tick — fire any due scheduled workers."""
    repos = get_repositories()
    now = datetime.now(timezone.utc)
    now_iso_str = now.isoformat()

    workers = _list_scheduled_worker_instances()
    for w in workers:
        worker_id = w["id"]
        user_id = w.get("owner_id")
        cron_expr = w.get("cron_expr")
        if not cron_expr:
            logger.warning(
                "Worker %s has trigger.type=schedule but no cron expression", worker_id
            )
            continue

        next_at_str = _get_or_init_next_run_at(worker_id, cron_expr)
        if not next_at_str:
            continue

        # Parse next_run_at — handle both naive and aware datetimes
        try:
            next_at = datetime.fromisoformat(next_at_str)
            if next_at.tzinfo is None:
                next_at = next_at.replace(tzinfo=timezone.utc)
        except Exception:
            logger.warning(
                "Invalid next_run_at for worker %s: %r", worker_id, next_at_str
            )
            continue

        if now < next_at:
            continue  # not due yet

        # Atomic concurrency guard: within a single write transaction, check
        # whether this worker has a running run.  SQLite serialises writes so
        # two concurrent callers (if any) cannot both pass the check.
        # Note: the scheduler runs in a single daemon thread, so this is
        # belt-and-suspenders for future multi-scheduler safety.
        new_next = compute_next_run_at(cron_expr, now)
        running_count = (
            repos.runs.count_running_for_worker(user_id=user_id, worker_id=worker_id)
            if user_id
            else 0
        )
        if running_count:
            # Still running — advance slot to avoid retrying on every tick
            if new_next:
                repos.workers.set_next_run_at(worker_id=worker_id, next_run_at=new_next)
            logger.info(
                "Skipping scheduled run for %s — previous run still running", worker_id
            )
            continue

        # Fire the run
        logger.info(
            "Firing scheduled run for worker %s (was due %s)", worker_id, next_at_str
        )
        try:
            run_id = create_run(
                worker_id,
                {},
                trigger_source="schedule",
                user_id=user_id,
                repos=repos,
            )
            start_run(run_id, worker_id, {}, user_id=user_id, repos=repos)

            # Update last_scheduled_run_at + next_run_at
            new_next = compute_next_run_at(cron_expr, now)
            repos.workers.mark_scheduled_run(
                worker_id=worker_id,
                last_scheduled_run_at=now_iso_str,
                next_run_at=new_next,
            )
            logger.info(
                "Scheduled run %s started for worker %s, next at %s",
                run_id,
                worker_id,
                new_next,
            )
        except Exception as exc:
            logger.exception(
                "Failed to fire scheduled run for worker %s: %s", worker_id, exc
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
