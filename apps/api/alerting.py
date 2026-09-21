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
import queue
import re
import smtplib
import socket
import threading
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Any, Optional

from models import UnsafeOutboundUrlError, assert_safe_outbound_url
from services.run_notifications import _open_pinned_webhook

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


# ---------------------------------------------------------------------------
# Platform OPS alerts
# ---------------------------------------------------------------------------

_OPS_ALERT_WINDOW = timedelta(minutes=10)
_OPS_COUNT_WINDOW = timedelta(minutes=15)
_OPS_THROTTLE_WORKSPACE = "__floom_ops__"
_OPS_THROTTLE_WORKER = "platform"
_OPS_WATCHDOG_ERROR_CODE = "worker_service_self_watchdog"
_OPS_DISPATCH_QUEUE_MAX = 256
_OPS_PLATFORM_ERROR_CODES = {
    "e2b_quota_exhausted",
    "e2b_sandbox_error",
    "executor_lost_mid_run",
    "executor_thread_pre_sandbox_exception",
    "interrupted_by_restart",
    "llm_provider_capacity",
    "llm_provider_capacity_retry_exhausted",
    "missing_e2b_key",
    "orphaned",
    "run_abandoned_server_restart",
    "run_claimed_without_dispatch",
    "run_execution_exception",
    "sandbox_crash",
    "sandbox_driver_internal_error",
    "sandbox_liveness_unconfirmed",
    "sandbox_transport_retry_exhausted",
    "schedule_missed",
    "scheduler_missed",
    "scheduler_row_error",
    "transient_network_error",
    "transient_network_retry_exhausted",
    "unknown",
    "unknown_error",
    "warm_sandbox_cleanup_failed",
    _OPS_WATCHDOG_ERROR_CODE,
}

# Frozen at the point OPS alerting was introduced. A future code absent from
# both sets is treated as new and alerts on its first persisted occurrence.
_KNOWN_NON_OPS_ERROR_CODES = {
    "agent_runtime_error",
    "approval_loop_killed",
    "approval_proposal_config_error",
    "cancelled",
    "cancelled_before_start",
    "cancelled_queued",
    "connection_rejected",
    "context_mount_failed",
    "execution_error",
    "file_input_resolution_failed",
    "install_failed",
    "invalid_outputs_shape",
    "invalid_result_json",
    "invalid_worker",
    "llm_auth_error",
    "llm_model_not_configured",
    "llm_provider_error",
    "llm_quota_exceeded",
    "llm_rate_limited",
    "mcp_connect_failed",
    "missing_connection",
    "missing_required_input",
    "missing_result",
    "missing_secret",
    "output_token_limit",
    "output_too_large",
    "quality_gate_failed",
    "sandbox_oom",
    "schema_violation",
    "self_hosted_runner_unavailable",
    "spend_cap_exceeded",
    "timeout",
    "token_cap_exceeded",
    "tool_iteration_cap_exceeded",
    "upstream_http_4xx",
    "upstream_http_5xx",
    "user_cancel",
    "worker_deleted",
    "worker_disabled",
    "worker_error",
    "worker_not_found",
    "worker_reported_error",
}
_OPS_CODE_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,79}$")
_EMAIL_LIKE_RE = re.compile(r"[^\s@]+@[^\s@]+")
_ops_state_lock = threading.Lock()
_ops_seen_unknown_codes: set[str] = set()
_ops_fallback_last_sent: dict[str, datetime] = {}
_ops_suppressed_counts: dict[str, int] = {}
_ops_queued_codes: set[str] = set()
_ops_dispatch_queue: queue.Queue[tuple[str, str, dict[str, Any]]] = queue.Queue(
    maxsize=_OPS_DISPATCH_QUEUE_MAX
)
_ops_dispatch_thread: threading.Thread | None = None


def _normalize_ops_error_code(error_code: str | None) -> str:
    code = str(error_code or "unknown_error").strip().lower()
    return code if _OPS_CODE_RE.fullmatch(code) else "invalid_error_code"


def _ops_identifier(value: object, *, fallback: str) -> str:
    """Keep opaque ids compact and prevent an email address entering payloads."""
    text = str(value or "").strip()
    if not text:
        return fallback
    if _EMAIL_LIKE_RE.search(text):
        return "redacted"
    return text[:160]


def _ops_workspace_id(*, repos: Any, worker_id: str) -> str:
    try:
        worker = repos.workers.get_any(worker_id=worker_id)
        return _ops_identifier((worker or {}).get("workspace_id"), fallback="local-default")
    except Exception:
        return "local-default"


def _ops_error_code_stats(
    *,
    repos: Any,
    user_id: str | None,
    error_code: str,
    run_id: str,
    since_iso: str,
) -> tuple[int, bool]:
    """Return recent same-code failures and whether this code predates the run."""
    method = getattr(getattr(repos, "runs", None), "ops_error_code_stats", None)
    if callable(method):
        try:
            stats = method(
                error_code=error_code,
                since_iso=since_iso,
                exclude_run_id=run_id,
            )
            return max(1, int(stats.get("count_since") or 0)), bool(stats.get("seen_before"))
        except Exception:
            logger.warning(
                "OPS alert error-code stats failed for code=%s; using bounded fallback",
                error_code,
                exc_info=True,
            )

    # Compatibility path for downstream repositories that have not adopted the
    # aggregate yet. It is owner-scoped and bounded; the cloud bump implements
    # the exact global aggregate before production deployment.
    if user_id:
        try:
            rows, _ = repos.runs.list(
                user_id=user_id,
                statuses=["failed"],
                limit=1000,
                offset=0,
                include_total=False,
            )
            matching = [
                row
                for row in rows
                if _normalize_ops_error_code(row.get("error_code")) == error_code
            ]
            recent = sum(
                1
                for row in matching
                if str(row.get("completed_at") or row.get("started_at") or row.get("created_at") or "")
                >= since_iso
            )
            seen_before = any(str(row.get("id") or row.get("run_id") or "") != run_id for row in matching)
            return max(1, recent), seen_before
        except Exception:
            logger.debug("OPS alert bounded stats fallback failed", exc_info=True)
    return 1, False


def _ops_is_alertable_code(*, error_code: str, seen_before: bool) -> bool:
    if error_code in _OPS_PLATFORM_ERROR_CODES:
        return True
    if error_code in _KNOWN_NON_OPS_ERROR_CODES:
        return False
    if seen_before:
        return False
    with _ops_state_lock:
        if error_code in _ops_seen_unknown_codes:
            return False
        _ops_seen_unknown_codes.add(error_code)
        # This cache prevents repeated DB reads inside one process. Clearing a
        # full cache is safe because the repository remains the durable fallback.
        if len(_ops_seen_unknown_codes) > 256:
            _ops_seen_unknown_codes.clear()
            _ops_seen_unknown_codes.add(error_code)
    return True


def _release_ops_alert_reservation(
    *,
    repos: Any,
    error_code: str,
    reserved_at: datetime,
) -> None:
    """Release a throttle claim when no webhook was delivered."""
    signature = f"ops:{error_code}"
    repo = getattr(repos, "alert_throttle", None) if repos is not None else None
    if repo is not None:
        release = getattr(repo, "release", None)
        if callable(release):
            try:
                release(
                    workspace_id=_OPS_THROTTLE_WORKSPACE,
                    worker_id=_OPS_THROTTLE_WORKER,
                    signature=signature,
                    sent_at_iso=reserved_at.isoformat(),
                )
            except Exception:
                logger.warning(
                    "OPS alert throttle release failed for code=%s",
                    error_code,
                    exc_info=True,
                )
    with _ops_state_lock:
        if _ops_fallback_last_sent.get(error_code) == reserved_at:
            _ops_fallback_last_sent.pop(error_code, None)


def _reserve_ops_alert(
    *,
    repos: Any,
    error_code: str,
    now: datetime,
) -> tuple[bool, int]:
    """Reserve one per-code alert slot and return prior suppressed occurrences."""
    signature = f"ops:{error_code}"
    since = (now - _OPS_ALERT_WINDOW).isoformat()
    repo = getattr(repos, "alert_throttle", None) if repos is not None else None

    with _ops_state_lock:
        allowed = False
        if repo is not None:
            try:
                reserve = getattr(repo, "reserve", None)
                if callable(reserve):
                    allowed = bool(
                        reserve(
                            since_iso=since,
                            workspace_id=_OPS_THROTTLE_WORKSPACE,
                            worker_id=_OPS_THROTTLE_WORKER,
                            signature=signature,
                            sent_at_iso=now.isoformat(),
                        )
                    )
                else:
                    recent = repo.count_since(
                        since_iso=since,
                        workspace_id=_OPS_THROTTLE_WORKSPACE,
                        worker_id=_OPS_THROTTLE_WORKER,
                        signature=signature,
                    )
                    if not recent:
                        repo.record(
                            workspace_id=_OPS_THROTTLE_WORKSPACE,
                            worker_id=_OPS_THROTTLE_WORKER,
                            signature=signature,
                            sent_at_iso=now.isoformat(),
                        )
                        allowed = True
            except Exception:
                logger.warning(
                    "OPS alert throttle persistence failed for code=%s; using in-process fallback",
                    error_code,
                    exc_info=True,
                )
                repo = None

        if repo is None:
            last_sent = _ops_fallback_last_sent.get(error_code)
            if last_sent is None or now - last_sent >= _OPS_ALERT_WINDOW:
                _ops_fallback_last_sent[error_code] = now
                allowed = True

        if not allowed:
            _ops_suppressed_counts[error_code] = _ops_suppressed_counts.get(error_code, 0) + 1
            return False, _ops_suppressed_counts[error_code]
        return True, _ops_suppressed_counts.pop(error_code, 0)


def _ops_sink() -> tuple[str | None, bool]:
    webhook = (os.environ.get("WORKEROS_OPS_ALERT_WEBHOOK") or "").strip()
    if webhook:
        return webhook, False
    slack_webhook = (os.environ.get("WORKEROS_OPS_SLACK_WEBHOOK") or "").strip()
    if slack_webhook:
        return slack_webhook, True
    return None, False


def _post_ops_webhook(*, url: str, payload: dict[str, Any], slack: bool) -> None:
    assert_safe_outbound_url(url, label="OPS alert webhook URL")
    body: dict[str, Any]
    if slack:
        body = {
            "text": (
                "Floom OPS alert\n"
                f"error_code: {payload['error_code']}\n"
                f"worker_id: {payload['worker_id']}\n"
                f"workspace_id: {payload['workspace_id']}\n"
                f"run_id: {payload['run_id']}\n"
                f"count_same_code_last_15m: {payload['count_same_code_last_15m']}\n"
                f"ts: {payload['ts']}"
            )
        }
    else:
        body = payload
    encoded = json.dumps(body, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=encoded,
        headers={"Content-Type": "application/json", "User-Agent": "Floom-OPS-Alert/1"},
        method="POST",
    )
    with _open_pinned_webhook(request, timeout=5):
        pass


def _emit_ops_alert(
    *,
    repos: Any,
    error_code: str,
    worker_id: str,
    workspace_id: str,
    run_id: str,
    count_same_code_last_15m: int,
    now: datetime,
    reservation: tuple[bool, int] | None = None,
) -> dict[str, Any]:
    allowed, suppressed = reservation or _reserve_ops_alert(
        repos=repos,
        error_code=error_code,
        now=now,
    )
    if not allowed:
        logger.info("OPS alert suppressed by per-code throttle code=%s", error_code)
        return {"sent": False, "suppressed": True, "error_code": error_code}

    payload = {
        "error_code": error_code,
        "worker_id": _ops_identifier(worker_id, fallback="unknown-worker"),
        "workspace_id": _ops_identifier(workspace_id, fallback="local-default"),
        "run_id": _ops_identifier(run_id, fallback=""),
        "ts": now.isoformat(),
        "count_same_code_last_15m": max(1, count_same_code_last_15m, suppressed + 1),
    }
    url, slack = _ops_sink()
    if not url:
        logger.warning("OPS_ALERT sink=log-only payload=%s", json.dumps(payload, separators=(",", ":")))
        return {"sent": False, "logged": True, "payload": payload}
    try:
        _post_ops_webhook(url=url, payload=payload, slack=slack)
        logger.warning(
            "OPS alert delivered code=%s count_same_code_last_15m=%s",
            error_code,
            payload["count_same_code_last_15m"],
        )
        return {"sent": True, "payload": payload}
    except UnsafeOutboundUrlError:
        logger.error("OPS alert webhook URL rejected by outbound safety policy code=%s", error_code)
    except Exception as exc:
        # Webhook URLs commonly contain secret path tokens. Do not log the
        # exception message or traceback because urllib errors can echo the URL.
        logger.error(
            "OPS alert delivery failed code=%s error_type=%s",
            error_code,
            type(exc).__name__,
        )
        _release_ops_alert_reservation(
            repos=repos,
            error_code=error_code,
            reserved_at=now,
        )
    return {"sent": False, "delivery_failed": True, "payload": payload}


def alert_ops_run_failure(
    *,
    run_id: str,
    worker_id: str,
    error_code: str | None,
    user_id: str | None,
    repos: Any,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Evaluate and synchronously deliver one terminal run failure OPS alert."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    code = _normalize_ops_error_code(error_code)
    if code in _KNOWN_NON_OPS_ERROR_CODES:
        return {"sent": False, "eligible": False, "error_code": code}

    reservation: tuple[bool, int] | None = None
    if code in _OPS_PLATFORM_ERROR_CODES:
        reservation = _reserve_ops_alert(repos=repos, error_code=code, now=now)
        if not reservation[0]:
            logger.info("OPS alert suppressed by per-code throttle code=%s", code)
            return {"sent": False, "suppressed": True, "error_code": code}

    recent, seen_before = _ops_error_code_stats(
        repos=repos,
        user_id=user_id,
        error_code=code,
        run_id=run_id,
        since_iso=(now - _OPS_COUNT_WINDOW).isoformat(),
    )
    if reservation is None and not _ops_is_alertable_code(
        error_code=code,
        seen_before=seen_before,
    ):
        return {"sent": False, "eligible": False, "error_code": code}
    return _emit_ops_alert(
        repos=repos,
        error_code=code,
        worker_id=worker_id,
        workspace_id=_ops_workspace_id(repos=repos, worker_id=worker_id),
        run_id=run_id,
        count_same_code_last_15m=recent,
        now=now,
        reservation=reservation,
    )


def dispatch_ops_run_failure(**kwargs: Any) -> None:
    """Deliver a terminal run failure OPS alert without blocking finalization."""
    code = _normalize_ops_error_code(kwargs.get("error_code"))
    if code in _KNOWN_NON_OPS_ERROR_CODES:
        return
    _enqueue_ops_dispatch(kind="run", error_code=code, kwargs=kwargs)


def alert_ops_watchdog_trip(
    *,
    repos: Any | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Deliver the cloud worker-service self-watchdog trip alert."""
    if repos is None:
        from db.factory import get_repositories

        repos = get_repositories()
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return _emit_ops_alert(
        repos=repos,
        error_code=_OPS_WATCHDOG_ERROR_CODE,
        worker_id="floom-worker-service",
        workspace_id="platform",
        run_id="",
        count_same_code_last_15m=1,
        now=now,
    )


def dispatch_ops_watchdog_trip(**kwargs: Any) -> None:
    _enqueue_ops_dispatch(
        kind="watchdog",
        error_code=_OPS_WATCHDOG_ERROR_CODE,
        kwargs=kwargs,
    )


def _ops_dispatch_worker() -> None:
    while True:
        kind, error_code, kwargs = _ops_dispatch_queue.get()
        try:
            if kind == "watchdog":
                alert_ops_watchdog_trip(**kwargs)
            else:
                alert_ops_run_failure(**kwargs)
        except Exception:
            logger.exception(
                "OPS alert background evaluation failed kind=%s code=%s",
                kind,
                error_code,
            )
        finally:
            with _ops_state_lock:
                _ops_queued_codes.discard(error_code)
            _ops_dispatch_queue.task_done()


def _ensure_ops_dispatch_worker() -> None:
    global _ops_dispatch_thread
    with _ops_state_lock:
        if _ops_dispatch_thread is not None and _ops_dispatch_thread.is_alive():
            return
        _ops_dispatch_thread = threading.Thread(
            target=_ops_dispatch_worker,
            daemon=True,
            name="floom-ops-alert-dispatch",
        )
        _ops_dispatch_thread.start()


def _enqueue_ops_dispatch(
    *,
    kind: str,
    error_code: str,
    kwargs: dict[str, Any],
) -> None:
    """Coalesce same-code bursts behind one bounded background worker."""
    _ensure_ops_dispatch_worker()
    with _ops_state_lock:
        coalesce = error_code in _OPS_PLATFORM_ERROR_CODES
        if coalesce and error_code in _ops_queued_codes:
            _ops_suppressed_counts[error_code] = _ops_suppressed_counts.get(error_code, 0) + 1
            return
        if coalesce:
            _ops_queued_codes.add(error_code)
        try:
            _ops_dispatch_queue.put_nowait((kind, error_code, kwargs))
        except queue.Full:
            if coalesce:
                _ops_queued_codes.discard(error_code)
            _ops_suppressed_counts[error_code] = _ops_suppressed_counts.get(error_code, 0) + 1
            logger.error(
                "OPS alert dispatch queue full kind=%s code=%s; retained in suppressed count",
                kind,
                error_code,
            )


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
