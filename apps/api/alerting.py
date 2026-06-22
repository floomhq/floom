"""Worker alerting — success-rate drop detection and notification.

Runs as a lightweight in-process check called from the cron scheduler tick.

Algorithm
---------
Every ALERT_POLL_INTERVAL_TICKS scheduler ticks (default: every tick = every
minute, but the check is fast):

1. For each non-archived worker that has runs in the past 7 days, compute
   7-day success rate = completed / (completed + failed).
2. "Incident" definition: a worker that was "healthy" (success_rate_7d >= 80%
   at some point in the last 7d OR has consecutive_failures >= threshold) and
   is now either:
     a. consecutive_failures >= ALERT_CONSECUTIVE_FAILURES (default 3), OR
     b. success_rate_7d < ALERT_SUCCESS_RATE_THRESHOLD AND previously >= 80%.
3. On first incident detection, fire an alert and persist it to the
   `alert_incidents` table so the same incident isn't re-sent.
4. Incident is cleared (reset) when the worker has a successful run after the
   last failure.

Notification channels (all configurable via env):
  WORKEROS_ALERT_ENABLED=true          default: true
  WORKEROS_ALERT_EMAIL=<addr>          email to notify (reads WORKEROS_SMTP_* or
                                        falls back to SMTP_HOST/USER/PASS)
  WORKEROS_SMTP_HOST                   SMTP server hostname
  WORKEROS_SMTP_PORT                   SMTP port (default: 587)
  WORKEROS_SMTP_USER                   SMTP login
  WORKEROS_SMTP_PASS                   SMTP password
  WORKEROS_SMTP_FROM                   From address (defaults to SMTP user)
  WORKEROS_ALERT_CONSECUTIVE_FAILURES  int, default 3
  WORKEROS_ALERT_SUCCESS_RATE_THRESHOLD float 0-1, default 0.5

If no SMTP config is available, the alert is logged as a structured WARNING
so it's visible in journalctl without crashing the process.

NEVER logs secret values.
"""

import json
import logging
import os
import smtplib
import socket
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Any, Optional

logger = logging.getLogger("floom.alerting")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_ALERT_ENABLED = os.environ.get("WORKEROS_ALERT_ENABLED", "true").strip().lower() not in ("0", "false", "no")
_ALERT_EMAIL: Optional[str] = os.environ.get("WORKEROS_ALERT_EMAIL") or None
_SMTP_HOST: Optional[str] = os.environ.get("WORKEROS_SMTP_HOST") or None
_SMTP_PORT: int = int(os.environ.get("WORKEROS_SMTP_PORT", "587"))
_SMTP_USER: Optional[str] = os.environ.get("WORKEROS_SMTP_USER") or None
_SMTP_PASS: Optional[str] = os.environ.get("WORKEROS_SMTP_PASS") or None
_SMTP_FROM: Optional[str] = os.environ.get("WORKEROS_SMTP_FROM") or _SMTP_USER or None

_ALERT_CONSECUTIVE_FAILURES: int = int(os.environ.get("WORKEROS_ALERT_CONSECUTIVE_FAILURES", "3"))
_ALERT_SUCCESS_RATE_THRESHOLD: float = float(os.environ.get("WORKEROS_ALERT_SUCCESS_RATE_THRESHOLD", "0.5"))
_ALERT_HEALTHY_THRESHOLD: float = 0.80   # must have been >= this to trigger rate-drop alert
_FAILURE_STATUSES = {"failed", "error", "cancelled", "rejected", "timeout"}
_SUCCESS_STATUSES = {"completed", "approved", "success", "succeeded"}

# How many scheduler ticks to skip between alerting checks (0 = every tick)
_ALERT_POLL_EVERY_N_TICKS: int = int(os.environ.get("WORKEROS_ALERT_POLL_TICKS", "5"))
_tick_counter: int = 0


def _smtp_available() -> bool:
    return bool(_SMTP_HOST and _SMTP_USER)


def _send_email(subject: str, body: str) -> None:
    """Send an alert email. Logs WARNING on failure instead of raising."""
    if not _ALERT_EMAIL:
        return
    if not _smtp_available():
        logger.warning(
            "ALERT (no SMTP configured) — %s: %s", subject, body[:300]
        )
        return
    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = _SMTP_FROM or _SMTP_USER
        msg["To"] = _ALERT_EMAIL
        msg.set_content(body)

        # Use STARTTLS on port 587, or plain SSL on 465, or plain on others
        if _SMTP_PORT == 465:
            server = smtplib.SMTP_SSL(host=_SMTP_HOST, port=_SMTP_PORT, timeout=15)
        else:
            server = smtplib.SMTP(host=_SMTP_HOST, port=_SMTP_PORT, timeout=15)
            server.starttls()

        if _SMTP_USER and _SMTP_PASS:
            server.login(_SMTP_USER, _SMTP_PASS)
        server.send_message(msg)
        server.quit()
        logger.info("Alert email sent to %s: %s", _ALERT_EMAIL, subject)
    except (smtplib.SMTPException, socket.error, OSError) as exc:
        # Non-fatal: never crash the scheduler because email failed
        logger.warning("Failed to send alert email (%s): %s", type(exc).__name__, exc)


def _notify(worker_id: str, worker_name: str, reason: str, details: str) -> None:
    """Dispatch alert via all configured channels."""
    frontend_url = os.environ.get("WORKERS_FRONTEND_URL", "https://localhost:3000").rstrip("/")
    worker_url = f"{frontend_url}/workers/{worker_id}"

    # Structured log is always emitted (visible via journalctl)
    logger.warning(
        "WORKER_ALERT worker_id=%s worker_name=%r reason=%s details=%s url=%s",
        worker_id, worker_name, reason, details, worker_url
    )

    # Email notification (if configured)
    if _ALERT_EMAIL:
        subject = f"[Floom] Worker alert: {worker_name or worker_id}"
        body = (
            f"Worker: {worker_name or worker_id}\n"
            f"ID: {worker_id}\n"
            f"Reason: {reason}\n"
            f"Details: {details}\n"
            f"\nView worker: {worker_url}\n"
        )
        _send_email(subject, body)


def _count_consecutive_failures(statuses: list[str]) -> int:
    count = 0
    for status in statuses:
        normalized = (status or "").strip().lower()
        if normalized in _FAILURE_STATUSES:
            count += 1
            continue
        if normalized in _SUCCESS_STATUSES:
            break
        break
    return count


# ---------------------------------------------------------------------------
# Incident persistence helpers
# ---------------------------------------------------------------------------

def _ensure_alert_incidents_table(conn) -> None:
    """Create alert_incidents if it doesn't exist (idempotent)."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id TEXT NOT NULL,
            incident_key TEXT NOT NULL,
            reason TEXT NOT NULL,
            details TEXT,
            fired_at TEXT NOT NULL,
            resolved_at TEXT,
            UNIQUE(worker_id, incident_key)
        )
        """
    )
    # Index for fast worker lookups
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_alert_incidents_worker ON alert_incidents(worker_id)"
    )


def _is_incident_open(conn, worker_id: str, incident_key: str) -> bool:
    """Return True if there's an open (unresolved) incident for this key."""
    row = conn.execute(
        "SELECT id FROM alert_incidents WHERE worker_id=? AND incident_key=? AND resolved_at IS NULL",
        (worker_id, incident_key),
    ).fetchone()
    return row is not None


def _open_incident(conn, worker_id: str, incident_key: str, reason: str, details: str) -> None:
    """Persist a new incident (no-op if already open)."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT INTO alert_incidents (worker_id, incident_key, reason, details, fired_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(worker_id, incident_key) DO UPDATE SET
            reason = excluded.reason,
            details = excluded.details,
            fired_at = excluded.fired_at,
            resolved_at = NULL
        """,
        (worker_id, incident_key, reason, details, now),
    )


def _resolve_incident(conn, worker_id: str, incident_key: str) -> bool:
    """Mark an incident resolved. Returns True if a row was updated."""
    now = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        """
        UPDATE alert_incidents
        SET resolved_at = ?
        WHERE worker_id = ? AND incident_key = ? AND resolved_at IS NULL
        """,
        (now, worker_id, incident_key),
    )
    return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# Core alerting check
# ---------------------------------------------------------------------------

def alerting_tick() -> None:
    """Called from the scheduler every tick; runs the full alerting check.

    Rate-limited: only runs every _ALERT_POLL_EVERY_N_TICKS ticks to keep
    overhead negligible.
    """
    global _tick_counter
    _tick_counter += 1

    if not _ALERT_ENABLED:
        return

    if _ALERT_POLL_EVERY_N_TICKS > 0 and (_tick_counter % _ALERT_POLL_EVERY_N_TICKS) != 0:
        return

    try:
        _run_alerting_check()
    except Exception as exc:
        # Never crash the scheduler
        logger.exception("Alerting check failed: %s", exc)


def alert_worker_failure_if_needed(worker_id: str) -> dict[str, Any] | None:
    """Open and notify a consecutive-failure incident for one worker.

    This is called immediately after a run is marked failed. It reuses the same
    incident table and notification path as the scheduler tick, so a threshold
    crossing fires once and stays quiet until recovery resolves the incident.
    """
    if not _ALERT_ENABLED:
        return None

    from db import get_db

    with get_db() as conn:
        _ensure_alert_incidents_table(conn)
        worker = conn.execute(
            """
            SELECT
                w.id,
                w.name,
                w.enabled,
                w.trigger_type,
                w.triggers_json,
                sv.manifest_json
            FROM workers w
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE w.id = ? AND w.enabled = 1
            """,
            (worker_id,),
        ).fetchone()
        if not worker:
            return None
        worker_name = worker["name"] or worker_id
        if _is_system_worker(worker_name):
            return None
        if _is_manual_only_worker(
            worker["trigger_type"],
            worker["manifest_json"],
            worker["triggers_json"],
        ):
            return None

        rows = conn.execute(
            """
            SELECT status, error, error_code, created_at, started_at, completed_at
            FROM runs
            WHERE worker_id = ?
            ORDER BY COALESCE(completed_at, started_at, created_at) DESC, created_at DESC
            LIMIT 20
            """,
            (worker_id,),
        ).fetchall()
        statuses = [str(row["status"] or "") for row in rows]
        consecutive = _count_consecutive_failures(statuses)
        if consecutive < _ALERT_CONSECUTIVE_FAILURES:
            return {
                "opened": False,
                "worker_id": worker_id,
                "consecutive_failures": consecutive,
                "threshold": _ALERT_CONSECUTIVE_FAILURES,
            }
        if _is_incident_open(conn, worker_id, "consecutive_failures"):
            return {
                "opened": False,
                "worker_id": worker_id,
                "consecutive_failures": consecutive,
                "threshold": _ALERT_CONSECUTIVE_FAILURES,
                "already_open": True,
            }

        latest = rows[0] if rows else None
        reason = f"{consecutive} consecutive failures"
        detail_bits = [
            f"threshold={_ALERT_CONSECUTIVE_FAILURES}",
        ]
        if latest and latest["error_code"]:
            detail_bits.append(f"latest_error_code={latest['error_code']}")
        if latest and latest["error"]:
            detail_bits.append(f"latest_error={str(latest['error']).splitlines()[0][:160]}")
        details = "; ".join(detail_bits)
        _open_incident(conn, worker_id, "consecutive_failures", reason, details)
        conn.commit()
        _notify(worker_id, worker_name, reason, details)
        return {
            "opened": True,
            "worker_id": worker_id,
            "consecutive_failures": consecutive,
            "threshold": _ALERT_CONSECUTIVE_FAILURES,
            "reason": reason,
            "details": details,
        }


def _run_alerting_check() -> None:
    from db import get_db

    now = datetime.now(timezone.utc)
    window_7d = now - timedelta(days=7)
    window_7d_iso = window_7d.isoformat()

    with get_db() as conn:
        _ensure_alert_incidents_table(conn)

        # Fetch all non-archived workers with their owner
        workers = conn.execute(
            """
            SELECT
                w.id,
                w.name,
                w.owner_id,
                w.enabled,
                w.trigger_type,
                w.triggers_json,
                sv.manifest_json
            FROM workers w
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE w.enabled = 1
            """
        ).fetchall()

        if not workers:
            return

        # Fetch 7d run stats per worker in one query
        stats_rows = conn.execute(
            """
            SELECT
                r.worker_id,
                SUM(CASE WHEN r.status IN ('completed','approved','success','succeeded') THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN r.status IN ('failed','error','cancelled','rejected','timeout') THEN 1 ELSE 0 END) AS failed,
                COUNT(*) AS total,
                MAX(r.created_at) AS last_run_at,
                MAX(CASE WHEN r.status IN ('failed','error','cancelled','rejected','timeout') THEN r.created_at END) AS last_failed_at
            FROM runs r
            WHERE r.created_at >= ?
            GROUP BY r.worker_id
            """,
            (window_7d_iso,),
        ).fetchall()

        stats_by_worker = {row["worker_id"]: row for row in stats_rows}

        # Fetch consecutive failures per worker (most recent N runs)
        # We need this separately — look at up to 10 recent runs per worker
        consec_rows = conn.execute(
            """
            SELECT r.worker_id, r.status, r.created_at
            FROM runs r
            INNER JOIN (
                SELECT worker_id, MAX(created_at) AS max_at
                FROM runs
                WHERE created_at >= ?
                GROUP BY worker_id
            ) latest ON latest.worker_id = r.worker_id
            WHERE r.created_at >= ?
            ORDER BY r.worker_id, r.created_at DESC
            """,
            (window_7d_iso, window_7d_iso),
        ).fetchall()

        # Group and count consecutive failures at the tail
        consecutive_failures: dict[str, int] = {}
        _by_worker: dict[str, list] = {}
        for row in consec_rows:
            _by_worker.setdefault(row["worker_id"], []).append(row["status"])

        for wid, statuses in _by_worker.items():
            count = 0
            for status in statuses:  # statuses are DESC order (newest first)
                if status in ("failed", "error", "cancelled", "rejected", "timeout"):
                    count += 1
                else:
                    break
            consecutive_failures[wid] = count

        # Process each worker
        for worker in workers:
            worker_id = worker["id"]
            worker_name = worker["name"] or worker_id

            # Skip system/test workers
            if _is_system_worker(worker_name):
                continue
            if _is_manual_only_worker(
                worker["trigger_type"],
                worker["manifest_json"],
                worker["triggers_json"],
            ):
                continue

            stat = stats_by_worker.get(worker_id)
            if not stat:
                # No runs in 7d — not enough signal
                continue

            completed = int(stat["completed"] or 0)
            failed = int(stat["failed"] or 0)
            total = completed + failed
            consec = consecutive_failures.get(worker_id, 0)

            if total == 0:
                continue

            success_rate = completed / total

            # Determine incident key (stable per incident window)
            incident_key = "consecutive_failures" if consec >= _ALERT_CONSECUTIVE_FAILURES else "low_success_rate"

            # Check condition 1: consecutive failures
            if consec >= _ALERT_CONSECUTIVE_FAILURES:
                if not _is_incident_open(conn, worker_id, "consecutive_failures"):
                    reason = f"{consec} consecutive failures"
                    details = f"Success rate (7d): {success_rate:.0%} ({completed} ok / {failed} failed)"
                    _open_incident(conn, worker_id, "consecutive_failures", reason, details)
                    conn.commit()
                    _notify(worker_id, worker_name, reason, details)
                # No need to check rate-drop if already alerting on consecutive
                continue
            else:
                # Resolve open consecutive-failures incident if worker recovered
                if _resolve_incident(conn, worker_id, "consecutive_failures"):
                    logger.info("Incident resolved for worker %s (consecutive_failures)", worker_id)
                    conn.commit()

            # Check condition 2: success rate drop (was healthy, now below threshold)
            if success_rate < _ALERT_SUCCESS_RATE_THRESHOLD and total >= 3:
                if not _is_incident_open(conn, worker_id, "low_success_rate"):
                    reason = f"Success rate dropped to {success_rate:.0%}"
                    details = f"{completed} ok / {failed} failed in last 7d"
                    _open_incident(conn, worker_id, "low_success_rate", reason, details)
                    conn.commit()
                    _notify(worker_id, worker_name, reason, details)
            elif success_rate >= _ALERT_HEALTHY_THRESHOLD:
                # Worker recovered — resolve any open rate-drop incident
                if _resolve_incident(conn, worker_id, "low_success_rate"):
                    logger.info("Incident resolved for worker %s (low_success_rate)", worker_id)
                    conn.commit()


def _is_system_worker(name: str) -> bool:
    """Filter out internal/test workers from alerting."""
    lower = (name or "").lower()
    return any(
        lower.startswith(prefix)
        for prefix in ("audit-", "smoke-", "quality-gate", "test-", "system-")
    )


def _is_manual_only_worker(
    trigger_type: str | None,
    manifest_json: str | None,
    triggers_json: str | None = None,
) -> bool:
    """Return True for workers that only run from explicit operator action."""
    normalized = (trigger_type or "").strip().lower()
    if normalized and normalized not in ("manual", "on_demand"):
        return False
    try:
        config = json.loads(manifest_json or "{}")
    except (TypeError, json.JSONDecodeError):
        config = {}
    trigger = config.get("trigger") if isinstance(config, dict) else {}
    if isinstance(trigger, dict):
        trigger_kind = str(trigger.get("type") or normalized or "manual").strip().lower()
        if trigger_kind not in ("manual", "on_demand"):
            return False
    triggers = config.get("triggers") if isinstance(config, dict) else None
    if isinstance(triggers, list):
        for item in triggers:
            if not isinstance(item, dict):
                continue
            item_kind = str(item.get("type") or item.get("kind") or "").strip().lower()
            if item_kind and item_kind not in ("manual", "on_demand"):
                return False
    try:
        stored_triggers = json.loads(triggers_json or "[]")
    except (TypeError, json.JSONDecodeError):
        stored_triggers = []
    if isinstance(stored_triggers, list):
        for item in stored_triggers:
            if not isinstance(item, dict):
                continue
            item_kind = str(item.get("type") or item.get("kind") or "").strip().lower()
            if item_kind and item_kind not in ("manual", "on_demand"):
                return False
    return True
