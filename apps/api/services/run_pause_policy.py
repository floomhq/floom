"""Worker pause + workspace alerting policy.

Extracted verbatim from run_service.py: persisting a worker's paused flag,
auto-pausing scheduled workers after repeated setup failures, the workspace
setting/toggle accessors, and the deprecated consecutive-failure auto-pause
compatibility shim. run_service re-imports these names for backward
compatibility. The missing-secret pause threshold helper is lazy-imported from
run_service.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Optional

from db.factory import Repositories
from models import RunStatus

logger = logging.getLogger("floom.run_service")

_TERMINAL_SCHEDULE_SETUP_ERROR_CODES = {
    "llm_model_not_configured",
    "missing_secret",
}

_SCHEDULER_MISSED_ERROR_CODES = {
    "schedule_missed",
    "scheduler_missed",
}


def _persist_worker_paused_flag(
    worker_id: str,
    *,
    repos: Repositories,
    user_id: str | None,
    archive_reason: str | None = None,
) -> None:
    if not user_id:
        return
    worker = repos.workers.get(user_id=user_id, worker_id=worker_id)
    manifest = dict((worker or {}).get("manifest") or {})
    if manifest:
        manifest["paused"] = True
        manifest["enabled"] = False
        manifest["archive_reason"] = (
            manifest.get("archive_reason")
            or archive_reason
            or "Paused automatically after repeated scheduled setup failures."
        )
        repos.workers.update(
            user_id=user_id,
            worker_id=worker_id,
            enabled=False,
            manifest_json=manifest,
        )
    else:
        repos.workers.update(user_id=user_id, worker_id=worker_id, enabled=False)

    # Resolve WORKERS_DIR at call time: tests reload worker_registry (fresh
    # FLOOM_WORKERS_DIR) without reloading this module, so an import-time binding
    # would write the paused flag to a stale workers dir.
    from worker_registry import WORKERS_DIR

    worker_yml = WORKERS_DIR / worker_id / "worker.yml"
    if not worker_yml.exists():
        return
    try:
        raw = worker_yml.read_text(encoding="utf-8")
        updated = raw
        if re.search(r"(?m)^paused:\s*(true|false)\s*$", updated):
            updated = re.sub(r"(?m)^(paused:\s*)(true|false)\s*$", r"\1true", updated)
        else:
            if not updated.endswith("\n"):
                updated += "\n"
            updated += "paused: true\n"
        if re.search(r"(?m)^enabled:\s*(true|false)\s*$", updated):
            updated = re.sub(r"(?m)^(enabled:\s*)(true|false)\s*$", r"\1false", updated)
        if updated != raw:
            worker_yml.write_text(updated, encoding="utf-8")
    except Exception as exc:
        logger.warning("Failed to persist auto-pause flag for %s: %s", worker_id, exc)


def _maybe_pause_scheduled_worker_after_setup_failure(
    *,
    worker_id: str,
    run_id: str,
    user_id: str | None,
    error_code: str,
    repos: Repositories,
) -> bool:
    """Pause a scheduled worker after repeated deterministic setup failures."""
    from run_service import _schedule_missing_secret_pause_threshold
    normalized_error_code = str(error_code or "").strip().lower()
    if normalized_error_code not in _TERMINAL_SCHEDULE_SETUP_ERROR_CODES or not user_id:
        return False

    threshold = _schedule_missing_secret_pause_threshold()
    if threshold <= 0:
        return False

    current = repos.runs.get(user_id=user_id, run_id=run_id)
    if not current or current.get("trigger_source") != "schedule":
        return False

    rows, _ = repos.runs.list(
        user_id=user_id,
        worker_id=worker_id,
        limit=threshold * 2,
        offset=0,
    )
    attempts = [
        row
        for row in rows
        if not (
            str(row.get("trigger_source") or "").strip().lower()
            in _SCHEDULER_MISSED_ERROR_CODES
            and str(row.get("error_code") or "").strip().lower()
            in _SCHEDULER_MISSED_ERROR_CODES
        )
    ][:threshold]
    if len(attempts) < threshold:
        return False
    for row in attempts:
        if row.get("trigger_source") != "schedule":
            return False
        if row.get("status") != RunStatus.FAILED.value:
            return False
        if str(row.get("error_code") or "").strip().lower() != normalized_error_code:
            return False

    worker = repos.workers.get(user_id=user_id, worker_id=worker_id)
    manifest = dict((worker or {}).get("manifest") or {})
    if not worker or worker.get("enabled") is False or manifest.get("paused") is True:
        return False

    _persist_worker_paused_flag(worker_id, repos=repos, user_id=user_id)
    logger.warning(
        "Auto-paused scheduled worker %s after %d consecutive %s failures",
        worker_id,
        threshold,
        normalized_error_code,
    )
    return True


_FALSEY = {"0", "false", "no", "off"}


def _workspace_setting(key: str, *, workspace_id: str = "local-default") -> Optional[str]:
    """#794: read a workspace behaviour toggle from the workspace_settings KV
    table (set via PUT /workspace/settings/{key}). Returns None when unset."""
    try:
        from db import get_db
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ? LIMIT 1",
                (workspace_id, key),
            ).fetchone()
        return str(row["value"]) if row and row["value"] is not None else None
    except Exception:
        return None


def _workspace_toggle(key: str, *, env_var: str, default: bool) -> bool:
    """#794: a DB workspace setting wins over the env var, which wins over the
    hard default."""
    setting = _workspace_setting(key)
    if setting is not None:
        return setting.strip().lower() not in _FALSEY
    raw = os.environ.get(env_var)
    if raw is not None:
        return raw.strip().lower() not in _FALSEY
    return default


def _workspace_failure_email_recipients() -> list[str]:
    """#794: where workspace failure emails go — the `failure_email_to`
    workspace setting (comma-separated), else NOTIFY_EMAIL / WORKEROS_ALERT_EMAIL."""
    raw = _workspace_setting("failure_email_to") or os.environ.get("NOTIFY_EMAIL") or os.environ.get("WORKEROS_ALERT_EMAIL") or ""
    return [addr.strip() for addr in raw.split(",") if addr.strip()]


def _auto_pause_on_consecutive_failures_enabled() -> bool:
    # Deprecated/no-op for broad consecutive-failure auto-pause. The workspace
    # setting and env var are still accepted by settings APIs for compatibility,
    # but repeated automatic failures now remain visible through incidents,
    # overview attention, and run history instead of disabling the scheduler.
    _workspace_toggle(
        "auto_pause_enabled",
        env_var="WORKEROS_AUTO_PAUSE_ON_CONSECUTIVE_FAILURES",
        default=False,
    )
    return False


def _alert_consecutive_failure_threshold() -> int:
    # Raised from 3 → 5 to avoid pausing workers on transient E2B/network blips.
    raw = os.environ.get("WORKEROS_ALERT_CONSECUTIVE_FAILURES", "5")
    try:
        return max(1, int(raw))
    except ValueError:
        return 5


def _maybe_pause_worker_after_consecutive_failures(
    *,
    worker_id: str,
    user_id: str | None,
    repos: Repositories,
) -> bool:
    """Deprecated compatibility shim for broad consecutive-failure auto-pause.

    Repeated automatic failures are now surfaced through the incident/overview
    paths without mutating worker.enabled. The older setup-specific missing
    secret pause path remains separate.
    """
    if not user_id:
        return False
    _auto_pause_on_consecutive_failures_enabled()
    return False
