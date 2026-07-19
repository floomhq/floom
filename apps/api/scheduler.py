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
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from croniter import croniter

from db.factory import get_repositories
from models import RunStatus
from run_service import (
    _maybe_pause_scheduled_worker_after_setup_failure,
    create_run,
    get_worker_config_for_run,
    get_worker_recipe_for_run,
    start_run,
)
from alerting import alerting_tick
from services.product_events import emit_product_event


def _missing_secrets_for_scheduled_worker(
    repos,
    worker_id: str,
    user_id: str | None,
    workspace_id: str | None = None,
) -> list[str]:
    """Return required secret names not yet configured for this worker's owner."""
    if not user_id:
        return []
    config = get_worker_config_for_run(
        worker_id,
        repos=repos,
        user_id=user_id,
        workspace_id=workspace_id,
    )
    required = list(getattr(config, "secrets", []) or []) if config else []
    if not required:
        return []
    try:
        available = set(repos.secrets.list_names(user_id=user_id))
    except Exception:
        return []
    return [s for s in required if s not in available]


def _missing_connections_for_scheduled_worker(
    repos,
    worker_id: str,
    user_id: str | None,
    workspace_id: str | None = None,
) -> list[str]:
    """Return required connection slugs not yet active for this worker's owner."""
    if not user_id:
        return []
    config = get_worker_config_for_run(
        worker_id,
        repos=repos,
        user_id=user_id,
        workspace_id=workspace_id,
    )
    raw_connections = list(getattr(config, "connections", []) or []) if config else []
    required_slugs: list[str] = []
    for c in raw_connections:
        if isinstance(c, str) and c.strip():
            required_slugs.append(c.strip().lower())
        elif isinstance(c, dict):
            # Optional connections (e.g. Gmail OR Outlook) never block a scheduled run.
            if c.get("optional") is True or (c.get("composio") or {}).get("optional") is True:
                continue
            slug = (c.get("app") or c.get("slug") or "").strip().lower()
            if slug:
                required_slugs.append(slug)
        elif getattr(getattr(c, "composio", None), "optional", False):
            # Parsed WorkerConnection whose composio spec is optional: skip, never block.
            continue
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


def _emit_trigger_fired(
    *,
    owner_id: str | None,
    worker_id: str,
    run_id: str,
    trigger_type: str,
    trigger_id: str | None = None,
) -> None:
    if not owner_id:
        return
    # The scheduler runs in a background thread with no HTTP request context, so
    # the analytics source would default to "api". These fires originate from the
    # cron scheduler; tag them source="schedule" (the declared enum value).
    from services import analytics_posthog

    tokens = analytics_posthog.set_request_context(source="schedule")
    try:
        emit_product_event(
            owner_id=owner_id,
            event="trigger_fired",
            properties={
                "worker_id": worker_id,
                "run_id": run_id,
                "trigger_type": trigger_type,
                "trigger_id": trigger_id,
            },
        )
    finally:
        analytics_posthog.reset_request_context(tokens)

logger = logging.getLogger("floom.scheduler")

_WARNED_CRONLESS_SCHEDULE_WORKERS: set[str] = set()


def _warn_cronless_schedule_once(worker_id: str, trigger_id: str | None = None) -> None:
    if worker_id in _WARNED_CRONLESS_SCHEDULE_WORKERS:
        return
    _WARNED_CRONLESS_SCHEDULE_WORKERS.add(worker_id)
    if trigger_id:
        logger.warning(
            "Trigger %s for worker %s is type=schedule but has no cron; it will not run",
            trigger_id,
            worker_id,
        )
    else:
        logger.warning(
            "Worker %s has trigger.type=schedule but no cron expression; it will not run",
            worker_id,
        )

POLL_INTERVAL_SECONDS = 60  # check every minute
_stop_event: threading.Event = threading.Event()
_scheduler_thread: threading.Thread | None = None
_scheduler_lock = threading.Lock()
_SCHEDULER_HEARTBEAT_STALE_AFTER_SECONDS = POLL_INTERVAL_SECONDS * 3.0
_scheduler_last_heartbeat_monotonic: float | None = None
SCHEDULE_MISSED_ERROR_CODE = "scheduler_missed"
SCHEDULE_MISSED_ERROR = "Scheduled fire was missed or delayed by the scheduler."


def _cron_zone(cron_timezone: str | None) -> ZoneInfo:
    timezone_name = (cron_timezone or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(timezone_name)
    except Exception:
        logger.warning("Invalid cron timezone %r; falling back to UTC", cron_timezone)
        return ZoneInfo("UTC")


def compute_next_run_at(cron_expr: str, after: datetime, cron_timezone: str | None = None) -> Optional[str]:
    """Return the next ISO run time after `after` for the given cron expression.

    Returns None if the expression is invalid.
    """
    try:
        if after.tzinfo is None:
            after = after.replace(tzinfo=timezone.utc)
        local_after = after.astimezone(_cron_zone(cron_timezone))
        it = croniter(cron_expr, local_after)
        next_dt = it.get_next(datetime)
        if next_dt.tzinfo is None:
            next_dt = next_dt.replace(tzinfo=local_after.tzinfo)
        return next_dt.astimezone(timezone.utc).isoformat()
    except Exception as exc:
        logger.warning("Invalid cron expression %r: %s", cron_expr, exc)
        return None


def _schedule_missed_grace_seconds() -> int:
    raw = os.environ.get("WORKEROS_SCHEDULE_MISSED_GRACE_SECONDS", "300")
    try:
        return max(0, int(raw))
    except ValueError:
        return 300


def _create_synthetic_failed_schedule_run(
    repos,
    *,
    worker_id: str,
    user_id: str | None,
    now_iso: str,
    error: str,
    error_code: str,
    trigger_source: str = "schedule",
    trigger_ref: str | None = None,
    input_json: dict[str, object] | None = None,
) -> str | None:
    if not user_id:
        return None
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    try:
        repos.runs.create(
            user_id=user_id,
            run_id=run_id,
            worker_id=worker_id,
            status=RunStatus.FAILED.value,
            trigger_source=trigger_source,
            trigger_ref=trigger_ref,
            runner="scheduler",
            input_json=input_json or {},
            error=error,
            error_code=error_code,
            started_at=now_iso,
            completed_at=now_iso,
            duration_ms=0,
            created_at=now_iso,
        )
    except Exception:
        logger.exception(
            "Failed to record synthetic scheduled failure for worker %s",
            worker_id,
        )
        return None

    try:
        paused = _maybe_pause_scheduled_worker_after_setup_failure(
            worker_id=worker_id,
            run_id=run_id,
            user_id=user_id,
            error_code=error_code,
            repos=repos,
        )
        if paused:
            logger.warning(
                "Auto-paused scheduled worker %s after repeated terminal setup failures",
                worker_id,
            )
    except Exception:
        logger.exception(
            "Failed to apply scheduled setup-failure pause policy for worker %s",
            worker_id,
        )
    return run_id


def _record_schedule_missed_if_late(
    repos,
    *,
    worker_id: str,
    user_id: str | None,
    next_at: datetime,
    now: datetime,
    now_iso: str,
    trigger_ref: str | None = None,
) -> str | None:
    grace = _schedule_missed_grace_seconds()
    if (now - next_at).total_seconds() <= grace:
        return None
    return _create_synthetic_failed_schedule_run(
        repos,
        worker_id=worker_id,
        user_id=user_id,
        now_iso=now_iso,
        trigger_source=SCHEDULE_MISSED_ERROR_CODE,
        trigger_ref=trigger_ref,
        error=SCHEDULE_MISSED_ERROR,
        error_code=SCHEDULE_MISSED_ERROR_CODE,
    )


def _owner_is_active(repos, user_id: str | None) -> bool:
    """#918: disabling or deleting a user must halt their scheduled automation.

    Returns False when the install has real user accounts and the worker's
    owner is missing or disabled. Installs with an empty users table (legacy
    single-user ids like "local-user") keep firing. Fails open on repo errors so
    a transient DB hiccup can't silence every schedule.
    """
    users = getattr(repos, "users", None)
    if users is None or not user_id:
        return True
    try:
        row = users.get(user_id=user_id)
        if row is not None:
            return not row.get("disabled")
        return users.count() == 0
    except Exception:
        logger.exception("owner lifecycle check failed for user %s; failing open", user_id)
        return True


def _is_worker_running(worker_id: str) -> bool:
    """Return True if there is a run in 'running' state for this worker."""
    repos = get_repositories()
    owner_id = repos.workers.get_owner(worker_id=worker_id)
    if not owner_id:
        return False
    return repos.runs.count_running_for_worker(user_id=owner_id, worker_id=worker_id) > 0


def _get_or_init_next_run_at(worker_id: str, cron_expr: str, cron_timezone: str | None = None) -> Optional[str]:
    """Get next_run_at from DB, initializing it if NULL."""
    repos = get_repositories()
    row = repos.workers.get_schedule_state(worker_id=worker_id)
    if not row:
        return None
    if row["next_run_at"]:
        return row["next_run_at"]

    # Initialize: compute from now
    now = datetime.now(timezone.utc)
    next_at = compute_next_run_at(cron_expr, now, cron_timezone)
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


def _cron_timezone_from_trigger_config(config_json: Optional[str]) -> Optional[str]:
    """Extract the timezone from a worker_triggers row config blob."""
    if not config_json:
        return None
    try:
        config: Any = json.loads(config_json)
    except Exception:
        return None
    if isinstance(config, dict):
        value = config.get("timezone")
        return value if isinstance(value, str) and value.strip() else None
    return None


def _worker_is_archived(worker_id: str) -> bool:
    try:
        from worker_registry import get_worker
        worker_meta = get_worker(worker_id)
        return bool(worker_meta and (worker_meta.get("manifest") or {}).get("archived") is True)
    except Exception:
        return False


def _effective_scheduled_inputs(
    repos,
    worker_id: str,
    *,
    user_id: str | None = None,
    workspace_id: str | None = None,
) -> tuple[dict[str, object], list[str]]:
    """Return inputs a schedule run will see, plus missing required fields."""
    config = get_worker_config_for_run(
        worker_id,
        repos=repos,
        user_id=user_id,
        workspace_id=workspace_id,
    )
    recipe = None
    try:
        recipe = get_worker_recipe_for_run(
            worker_id,
            repos=repos,
            user_id=user_id,
            workspace_id=workspace_id,
        )
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
        workspace_id = row.get("workspace_id")
        cron_expr = _cron_expr_from_trigger_config(row.get("config_json"))
        if not cron_expr:
            _warn_cronless_schedule_once(worker_id, trigger_id)
            continue
        cron_timezone = _cron_timezone_from_trigger_config(row.get("config_json")) or row.get("cron_timezone") or "UTC"
        if _worker_is_archived(worker_id):
            logger.info("Skipping schedule trigger %s — worker %s is archived", trigger_id, worker_id)
            continue
        if not _owner_is_active(repos, user_id):
            logger.info(
                "Skipping schedule trigger %s — owner %s of worker %s is disabled or deleted",
                trigger_id, user_id, worker_id,
            )
            continue

        # Initialize next_run_at on first sight.
        next_at_str = row.get("next_run_at")
        if not next_at_str:
            next_at_str = compute_next_run_at(cron_expr, now, cron_timezone)
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

        new_next = compute_next_run_at(cron_expr, now, cron_timezone)
        lease_until = (now + timedelta(seconds=max(POLL_INTERVAL_SECONDS * 3, 180))).isoformat()
        claim_schedule_trigger = getattr(repos.workers, "claim_schedule_trigger", None)
        if callable(claim_schedule_trigger):
            try:
                if not claim_schedule_trigger(
                    trigger_id=trigger_id,
                    now_iso=now_iso_str,
                    locked_until=lease_until,
                ):
                    logger.info(
                        "Skipping schedule trigger %s for worker %s: already claimed",
                        trigger_id,
                        worker_id,
                    )
                    continue
            except Exception:
                logger.exception("Failed to claim schedule trigger %s", trigger_id)
                continue
        _record_schedule_missed_if_late(
            repos,
            worker_id=worker_id,
            user_id=user_id,
            next_at=next_at,
            now=now,
            now_iso=now_iso_str,
            trigger_ref=trigger_id,
        )
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

        try:
            scheduled_inputs, missing_inputs = _effective_scheduled_inputs(
                repos,
                worker_id,
                user_id=user_id,
                workspace_id=workspace_id,
            )
            if missing_inputs:
                _create_synthetic_failed_schedule_run(
                    repos,
                    worker_id=worker_id,
                    user_id=user_id,
                    now_iso=now_iso_str,
                    trigger_ref=trigger_id,
                    input_json=scheduled_inputs,
                    error=(
                        "Missing required scheduled input(s): "
                        + ", ".join(missing_inputs)
                    ),
                    error_code="missing_required_input",
                )
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
            _sched_missing_secrets = _missing_secrets_for_scheduled_worker(
                repos,
                worker_id,
                user_id,
                workspace_id=workspace_id,
            )
            if _sched_missing_secrets:
                _create_synthetic_failed_schedule_run(
                    repos,
                    worker_id=worker_id,
                    user_id=user_id,
                    now_iso=now_iso_str,
                    trigger_ref=trigger_id,
                    input_json=scheduled_inputs,
                    error="Missing secrets: " + ", ".join(_sched_missing_secrets),
                    error_code="missing_secret",
                )
                if new_next:
                    repos.workers.set_trigger_next_run_at(trigger_id=trigger_id, next_run_at=new_next)
                logger.warning(
                    "Skipping schedule trigger %s for worker %s: missing secret(s): %s",
                    trigger_id, worker_id, ", ".join(_sched_missing_secrets),
                )
                continue
            _sched_missing_conns = _missing_connections_for_scheduled_worker(
                repos,
                worker_id,
                user_id,
                workspace_id=workspace_id,
            )
            if _sched_missing_conns:
                _create_synthetic_failed_schedule_run(
                    repos,
                    worker_id=worker_id,
                    user_id=user_id,
                    now_iso=now_iso_str,
                    trigger_ref=trigger_id,
                    input_json=scheduled_inputs,
                    error="Missing connections: " + ", ".join(_sched_missing_conns),
                    error_code="missing_connection",
                )
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
                _emit_trigger_fired(
                    owner_id=user_id,
                    worker_id=worker_id,
                    run_id=run_id,
                    trigger_type="schedule",
                    trigger_id=trigger_id,
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
        except Exception as row_exc:
            # #2214: a single worker's broken config/manifest (e.g. an invalid
            # WorkerConfig on disk) used to raise up through this per-row loop,
            # uncaught. That (a) aborted processing of every OTHER due trigger
            # in this tick, (b) tripped `_tick()`'s "trigger-row path failed,
            # fall back to worker-scalar path" branch even though trigger rows
            # ARE available — which re-processed the SAME broken worker via the
            # legacy loop with the identical `now_iso_str`, producing duplicate
            # scheduler_missed markers with identical timestamps — and (c) since
            # the crash happened before any next_run_at advancement, the
            # trigger was re-claimed and re-crashed every lease cycle (~180s)
            # forever, spamming scheduler_missed runs while the real worker
            # never got a diagnosable error and never actually dispatched.
            # Isolate each row: never let one worker's failure affect any
            # other trigger or fall back to the legacy path, always advance
            # the schedule so it can self-heal, and record the REAL reason.
            logger.exception(
                "Schedule trigger %s for worker %s failed with an unexpected error; "
                "recording a diagnosable failure instead of leaving the trigger stuck",
                trigger_id,
                worker_id,
            )
            _create_synthetic_failed_schedule_run(
                repos,
                worker_id=worker_id,
                user_id=user_id,
                now_iso=now_iso_str,
                trigger_source="schedule",
                trigger_ref=trigger_id,
                error=f"Scheduler failed to process this trigger: {row_exc}",
                error_code="scheduler_row_error",
            )
            _advance_next_run_after_failure(
                repos,
                worker_id=worker_id,
                trigger_id=trigger_id,
                next_run_at=new_next,
            )
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
        workspace_id = w.get("workspace_id")
        cron_expr = w.get("cron_expr")
        cron_timezone = w.get("cron_timezone") or "UTC"
        if not cron_expr:
            _warn_cronless_schedule_once(worker_id)
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
        if not _owner_is_active(repos, user_id):
            logger.info(
                "Skipping scheduled run for %s — owner %s is disabled or deleted",
                worker_id, user_id,
            )
            continue

        next_at_str = _get_or_init_next_run_at(worker_id, cron_expr, cron_timezone)
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
        new_next = compute_next_run_at(cron_expr, now, cron_timezone)
        _record_schedule_missed_if_late(
            repos,
            worker_id=worker_id,
            user_id=user_id,
            next_at=next_at,
            now=now,
            now_iso=now_iso_str,
        )
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

        # Fire the run. Isolated per-worker (see the matching comment in
        # _tick_trigger_rows / #2214): a single worker's broken config must
        # never abort processing of the other scheduled workers in this tick.
        try:
            scheduled_inputs, missing_inputs = _effective_scheduled_inputs(
                repos,
                worker_id,
                user_id=user_id,
                workspace_id=workspace_id,
            )
            if missing_inputs:
                _create_synthetic_failed_schedule_run(
                    repos,
                    worker_id=worker_id,
                    user_id=user_id,
                    now_iso=now_iso_str,
                    input_json=scheduled_inputs,
                    error=(
                        "Missing required scheduled input(s): "
                        + ", ".join(missing_inputs)
                    ),
                    error_code="missing_required_input",
                )
                if new_next:
                    repos.workers.set_next_run_at(worker_id=worker_id, next_run_at=new_next)
                logger.warning(
                    "Skipping scheduled run for worker %s: missing required scheduled input(s): %s",
                    worker_id,
                    ", ".join(missing_inputs),
                )
                continue

            # #551: Block upfront if required secrets/connections are not configured.
            _sched_missing_secrets = _missing_secrets_for_scheduled_worker(
                repos,
                worker_id,
                user_id,
                workspace_id=workspace_id,
            )
            if _sched_missing_secrets:
                _create_synthetic_failed_schedule_run(
                    repos,
                    worker_id=worker_id,
                    user_id=user_id,
                    now_iso=now_iso_str,
                    input_json=scheduled_inputs,
                    error="Missing secrets: " + ", ".join(_sched_missing_secrets),
                    error_code="missing_secret",
                )
                if new_next:
                    repos.workers.set_next_run_at(worker_id=worker_id, next_run_at=new_next)
                logger.warning(
                    "Skipping scheduled run for worker %s: missing secret(s): %s",
                    worker_id, ", ".join(_sched_missing_secrets),
                )
                continue
            _sched_missing_conns = _missing_connections_for_scheduled_worker(
                repos,
                worker_id,
                user_id,
                workspace_id=workspace_id,
            )
            if _sched_missing_conns:
                _create_synthetic_failed_schedule_run(
                    repos,
                    worker_id=worker_id,
                    user_id=user_id,
                    now_iso=now_iso_str,
                    input_json=scheduled_inputs,
                    error="Missing connections: " + ", ".join(_sched_missing_conns),
                    error_code="missing_connection",
                )
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
                new_next = compute_next_run_at(cron_expr, now, cron_timezone)
                repos.workers.mark_scheduled_run(
                    worker_id=worker_id,
                    last_scheduled_run_at=now_iso_str,
                    next_run_at=new_next,
                )
                _emit_trigger_fired(
                    owner_id=user_id,
                    worker_id=worker_id,
                    run_id=run_id,
                    trigger_type="schedule",
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
        except Exception as row_exc:
            logger.exception(
                "Scheduled run for worker %s failed with an unexpected error; "
                "recording a diagnosable failure instead of leaving the schedule stuck",
                worker_id,
            )
            _create_synthetic_failed_schedule_run(
                repos,
                worker_id=worker_id,
                user_id=user_id,
                now_iso=now_iso_str,
                error=f"Scheduler failed to process this worker: {row_exc}",
                error_code="scheduler_row_error",
            )
            _advance_next_run_after_failure(
                repos,
                worker_id=worker_id,
                next_run_at=new_next,
            )


def _record_scheduler_heartbeat() -> None:
    global _scheduler_last_heartbeat_monotonic
    _scheduler_last_heartbeat_monotonic = time.monotonic()
    logger.info("Scheduler heartbeat")


def scheduler_heartbeat_status(*, now_monotonic: float | None = None) -> dict[str, Any]:
    """Return scheduler thread and monotonic heartbeat readiness."""
    thread = _scheduler_thread
    alive = bool(thread is not None and thread.is_alive())
    running = alive and not _stop_event.is_set()
    now = time.monotonic() if now_monotonic is None else now_monotonic
    last_heartbeat = _scheduler_last_heartbeat_monotonic
    heartbeat_age = (
        max(0.0, now - last_heartbeat)
        if last_heartbeat is not None
        else None
    )
    stale = running and (
        heartbeat_age is None
        or heartbeat_age > _SCHEDULER_HEARTBEAT_STALE_AFTER_SECONDS
    )
    return {
        "ok": running and not stale,
        "running": running,
        "thread": thread.name if thread is not None else None,
        "stopping": _stop_event.is_set(),
        "heartbeat_age_seconds": heartbeat_age,
        "stale_after_seconds": _SCHEDULER_HEARTBEAT_STALE_AFTER_SECONDS,
        "stale": stale,
    }


def start_scheduler() -> None:
    """Start the scheduler in a background daemon thread."""
    global _scheduler_thread, _scheduler_last_heartbeat_monotonic
    with _scheduler_lock:
        if _scheduler_thread is not None and _scheduler_thread.is_alive():
            return
        _stop_event.clear()
        _scheduler_last_heartbeat_monotonic = time.monotonic()

        def _loop() -> None:
            logger.info("Scheduler started (poll interval: %ds)", POLL_INTERVAL_SECONDS)
            while not _stop_event.is_set():
                _record_scheduler_heartbeat()
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
