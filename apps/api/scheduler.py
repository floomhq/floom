"""Cron scheduler — background thread for schedule-triggered workers.

Runs once per minute. Iterates the normalized ``worker_triggers`` rows of
type ``schedule`` (so a worker that declares N schedule triggers fires N
independent runs, each tagged with the trigger row that fired it), computes
each row's ``next_run_at`` via croniter, and fires a run when due.

Backward-compat: when a DB has no schedule trigger rows yet (legacy DB whose
workers haven't been reconciled into ``worker_triggers``), it falls back to
the historical worker-scalar path that reads ``workers.cron_expr``.

Concurrency rule: skip if a previous run for this worker is still running.
"""

import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Optional

from croniter import croniter

from db.factory import get_repositories
from run_service import create_run, get_worker_config_for_run, start_run
from alerting import alerting_tick


def _missing_secrets_for_scheduled_worker(repos, worker_id: str, user_id: str | None) -> list[str]:
    """Return required secret names not yet configured for this worker's owner."""
    if not user_id:
        return []
    config = get_worker_config_for_run(worker_id)
    required = list(getattr(config, "secrets", []) or []) if config else []
    if not required:
        return []
    try:
        available = set(repos.secrets.list_names(user_id=user_id))
    except Exception:
        return []
    return [s for s in required if s not in available]


def _missing_connections_for_scheduled_worker(repos, worker_id: str, user_id: str | None) -> list[str]:
    """Return required connection slugs not yet active for this worker's owner."""
    if not user_id:
        return []
    config = get_worker_config_for_run(worker_id)
    raw_connections = list(getattr(config, "connections", []) or []) if config else []
    required_slugs: list[str] = []
    for c in raw_connections:
        if isinstance(c, str) and c.strip():
            required_slugs.append(c.strip().lower())
        elif isinstance(c, dict):
            slug = (c.get("app") or c.get("slug") or "").strip().lower()
            if slug:
                required_slugs.append(slug)
    if not required_slugs:
        return []
    try:
        _live = {"active", "valid", "connected"}
        rows = repos.connections.list(user_id=user_id)
        available_slugs = {
            str(r.get("app_name") or "").lower()
            for r in rows
            if str(r.get("status") or "").lower() in _live
        }
    except Exception:
        return []
    return [s for s in required_slugs if s not in available_slugs]


def _advance_next_run_after_failure(
    repos,
    *,
    worker_id: str,
    next_run_at: str | None,
    trigger_id: str | None = None,
) -> None:
    """Advance the schedule slot even when firing the run fails."""
    if trigger_id is not None:
        repos.workers.set_trigger_next_run_at(trigger_id=trigger_id, next_run_at=next_run_at)
        return
    repos.workers.set_next_run_at(worker_id=worker_id, next_run_at=next_run_at)

logger = logging.getLogger("floom.scheduler")

POLL_INTERVAL_SECONDS = 60  # check every minute
_stop_event: threading.Event = threading.Event()
_scheduler_thread: threading.Thread | None = None
_scheduler_lock = threading.Lock()


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


def _cron_expr_from_trigger_config(config_json: Optional[str]) -> Optional[str]:
    """Extract the cron expression from a worker_triggers row config blob."""
    if not config_json:
        return None
    try:
        config: Any = json.loads(config_json)
    except Exception:
        return None
    if isinstance(config, dict):
        return config.get("cron")
    return None


def _worker_is_archived(worker_id: str) -> bool:
    try:
        from worker_registry import get_worker
        worker_meta = get_worker(worker_id)
        return bool(worker_meta and (worker_meta.get("manifest") or {}).get("archived") is True)
    except Exception:
        return False


def _effective_scheduled_inputs(repos, worker_id: str) -> tuple[dict[str, object], list[str]]:
    """Return inputs a schedule run will see, plus missing required fields."""
    config = get_worker_config_for_run(worker_id)
    recipe = None
    try:
        recipe = repos.workers.get_recipe(worker_id=worker_id)
    except Exception:
        recipe = None

    inputs: dict[str, object] = {}
    if isinstance(recipe, dict) and isinstance(recipe.get("input_values"), dict):
        inputs.update(recipe["input_values"])

    if config is not None:
        for inp in getattr(config, "inputs", []) or []:
            if inp.default is not None and inp.name not in inputs:
                inputs[inp.name] = inp.default

    missing: list[str] = []
    if config is not None:
        for inp in getattr(config, "inputs", []) or []:
            if getattr(inp, "required", False) and inputs.get(inp.name) in (None, ""):
                missing.append(inp.name)
    return inputs, missing


def _tick_trigger_rows(repos, now: datetime, now_iso_str: str) -> int:
    """Iterate normalized schedule trigger ROWS and fire any that are due.

    Returns the number of schedule trigger rows considered (used to decide
    whether to fall back to the legacy worker-scalar path).
    """
    rows = repos.workers.list_due_schedule_triggers(now_iso=now_iso_str)
    for row in rows:
        trigger_id = row["id"]
        worker_id = row["worker_id"]
        user_id = row.get("owner_id")
        cron_expr = _cron_expr_from_trigger_config(row.get("config_json"))
        if not cron_expr:
            logger.warning(
                "Trigger %s (worker %s) is type=schedule but has no cron", trigger_id, worker_id
            )
            continue
        if _worker_is_archived(worker_id):
            logger.info("Skipping schedule trigger %s — worker %s is archived", trigger_id, worker_id)
            continue

        # Initialize next_run_at on first sight.
        next_at_str = row.get("next_run_at")
        if not next_at_str:
            next_at_str = compute_next_run_at(cron_expr, now)
            if next_at_str:
                repos.workers.set_trigger_next_run_at(trigger_id=trigger_id, next_run_at=next_at_str)
            continue  # never fire on the same tick we initialized

        try:
            next_at = datetime.fromisoformat(next_at_str)
            if next_at.tzinfo is None:
                next_at = next_at.replace(tzinfo=timezone.utc)
        except Exception:
            logger.warning("Invalid next_run_at for trigger %s: %r", trigger_id, next_at_str)
            continue

        if now < next_at:
            continue  # not due yet

        new_next = compute_next_run_at(cron_expr, now)
        # Concurrency guard is per-WORKER (one bundle, one running run at a time).
        running_count = (
            repos.runs.count_running_for_worker(user_id=user_id, worker_id=worker_id)
            if user_id
            else 0
        )
        if running_count:
            if new_next:
                repos.workers.set_trigger_next_run_at(trigger_id=trigger_id, next_run_at=new_next)
            logger.info(
                "Skipping schedule trigger %s (worker %s) — previous run still running",
                trigger_id,
                worker_id,
            )
            continue

        scheduled_inputs, missing_inputs = _effective_scheduled_inputs(repos, worker_id)
        if missing_inputs:
            if new_next:
                repos.workers.set_trigger_next_run_at(trigger_id=trigger_id, next_run_at=new_next)
            logger.warning(
                "Skipping schedule trigger %s for worker %s: missing required scheduled input(s): %s",
                trigger_id,
                worker_id,
                ", ".join(missing_inputs),
            )
            continue

        # #551: Block upfront if required secrets/connections are not configured.
        _sched_missing_secrets = _missing_secrets_for_scheduled_worker(repos, worker_id, user_id)
        if _sched_missing_secrets:
            if new_next:
                repos.workers.set_trigger_next_run_at(trigger_id=trigger_id, next_run_at=new_next)
            logger.warning(
                "Skipping schedule trigger %s for worker %s: missing secret(s): %s",
                trigger_id, worker_id, ", ".join(_sched_missing_secrets),
            )
            continue
        _sched_missing_conns = _missing_connections_for_scheduled_worker(repos, worker_id, user_id)
        if _sched_missing_conns:
            if new_next:
                repos.workers.set_trigger_next_run_at(trigger_id=trigger_id, next_run_at=new_next)
            logger.warning(
                "Skipping schedule trigger %s for worker %s: missing connection(s): %s",
                trigger_id, worker_id, ", ".join(_sched_missing_conns),
            )
            continue

        logger.info(
            "Firing schedule trigger %s for worker %s (was due %s)",
            trigger_id,
            worker_id,
            next_at_str,
        )
        try:
            run_id = create_run(
                worker_id,
                scheduled_inputs,
                trigger_source="schedule",
                user_id=user_id,
                trigger_ref=trigger_id,
                repos=repos,
            )
            start_run(run_id, worker_id, scheduled_inputs, user_id=user_id, repos=repos)
            repos.workers.mark_trigger_fired(
                trigger_id=trigger_id,
                last_fired_at=now_iso_str,
                next_run_at=new_next,
            )
            # Keep the worker-scalar bookkeeping roughly in sync for any legacy
            # readers of workers.last_scheduled_run_at.
            try:
                repos.workers.set_next_run_at(worker_id=worker_id, next_run_at=new_next)
            except Exception:
                pass
            logger.info(
                "Schedule trigger %s started run %s for worker %s, next at %s",
                trigger_id,
                run_id,
                worker_id,
                new_next,
            )
        except Exception as exc:
            _advance_next_run_after_failure(
                repos,
                worker_id=worker_id,
                trigger_id=trigger_id,
                next_run_at=new_next,
            )
            logger.exception(
                "Failed to fire schedule trigger %s for worker %s: %s",
                trigger_id,
                worker_id,
                exc,
            )
            if new_next:
                try:
                    repos.workers.set_trigger_next_run_at(trigger_id=trigger_id, next_run_at=new_next)
                except Exception:
                    pass
    return len(rows)


def _tick() -> None:
    """One scheduler tick — fire any due scheduled workers + run alerting check."""
    # Run alerting check (rate-limited internally; fast no-op on off-ticks)
    alerting_tick()
    repos = get_repositories()
    now = datetime.now(timezone.utc)
    now_iso_str = now.isoformat()

    # Primary path: iterate normalized worker_triggers schedule rows, so ALL
    # declared schedule triggers fire (multi-trigger). If the DB has any
    # schedule trigger rows at all, this path is authoritative.
    try:
        if repos.workers.count_schedule_trigger_rows() > 0:
            _tick_trigger_rows(repos, now, now_iso_str)
            return
    except Exception:
        logger.exception("Schedule trigger-row tick failed; falling back to worker-scalar path")

    # Backward-compat fallback: legacy DBs whose workers have not yet been
    # reconciled into worker_triggers still fire via the worker scalar.
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
        # Belt-and-suspenders: skip if manifest marks worker as archived.
        # The enabled=0 DB flag should already exclude them, but guard against
        # stale DB state (e.g. worker.yml updated but reload not yet called).
        try:
            from worker_registry import get_worker
            worker_meta = get_worker(worker_id)
            if worker_meta and (worker_meta.get("manifest") or {}).get("archived") is True:
                logger.info(
                    "Skipping scheduled run for %s — worker is archived", worker_id
                )
                continue
        except Exception:
            pass

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
        scheduled_inputs, missing_inputs = _effective_scheduled_inputs(repos, worker_id)
        if missing_inputs:
            if new_next:
                repos.workers.set_next_run_at(worker_id=worker_id, next_run_at=new_next)
            logger.warning(
                "Skipping scheduled run for worker %s: missing required scheduled input(s): %s",
                worker_id,
                ", ".join(missing_inputs),
            )
            continue

        # #551: Block upfront if required secrets/connections are not configured.
        _sched_missing_secrets = _missing_secrets_for_scheduled_worker(repos, worker_id, user_id)
        if _sched_missing_secrets:
            if new_next:
                repos.workers.set_next_run_at(worker_id=worker_id, next_run_at=new_next)
            logger.warning(
                "Skipping scheduled run for worker %s: missing secret(s): %s",
                worker_id, ", ".join(_sched_missing_secrets),
            )
            continue
        _sched_missing_conns = _missing_connections_for_scheduled_worker(repos, worker_id, user_id)
        if _sched_missing_conns:
            if new_next:
                repos.workers.set_next_run_at(worker_id=worker_id, next_run_at=new_next)
            logger.warning(
                "Skipping scheduled run for worker %s: missing connection(s): %s",
                worker_id, ", ".join(_sched_missing_conns),
            )
            continue

        logger.info(
            "Firing scheduled run for worker %s (was due %s)", worker_id, next_at_str
        )
        try:
            run_id = create_run(
                worker_id,
                scheduled_inputs,
                trigger_source="schedule",
                user_id=user_id,
                repos=repos,
            )
            start_run(run_id, worker_id, scheduled_inputs, user_id=user_id, repos=repos)

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
            _advance_next_run_after_failure(
                repos,
                worker_id=worker_id,
                next_run_at=new_next,
            )
            logger.exception(
                "Failed to fire scheduled run for worker %s: %s", worker_id, exc
            )
            if new_next:
                try:
                    repos.workers.set_next_run_at(worker_id=worker_id, next_run_at=new_next)
                except Exception:
                    pass


def start_scheduler() -> None:
    """Start the scheduler in a background daemon thread."""
    global _scheduler_thread
    with _scheduler_lock:
        if _scheduler_thread is not None and _scheduler_thread.is_alive():
            return
        _stop_event.clear()

        def _loop() -> None:
            logger.info("Scheduler started (poll interval: %ds)", POLL_INTERVAL_SECONDS)
            while not _stop_event.is_set():
                try:
                    _tick()
                except Exception as exc:
                    logger.exception("Scheduler tick failed: %s", exc)
                _stop_event.wait(timeout=POLL_INTERVAL_SECONDS)
            logger.info("Scheduler stopped")

        _scheduler_thread = threading.Thread(target=_loop, daemon=True, name="workeros-scheduler")
        _scheduler_thread.start()


def stop_scheduler() -> None:
    """Signal the scheduler to stop."""
    _stop_event.set()


def scheduler_status() -> dict[str, Any]:
    """Return scheduler thread readiness state for /health."""
    thread = _scheduler_thread
    alive = bool(thread is not None and thread.is_alive())
    running = alive and not _stop_event.is_set()
    return {
        "ok": running,
        "running": running,
        "thread": thread.name if thread is not None else None,
        "stopping": _stop_event.is_set(),
    }
