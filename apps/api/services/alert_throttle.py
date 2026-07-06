"""Failure-alert throttle: dedup + rate-limit + per-workspace daily cap.

A worker that crash-loops on a schedule (e.g. every 10 min) otherwise emits ONE
failure email per failed run — ~144 emails/day for a SINGLE worker — with no
dedup. On a shared email provider (Resend) a couple of broken workers exhaust
the whole account's daily quota and block unrelated transactional mail
(signup/magic-link). This gate closes that class of incident.

Rules (env-configurable):

  1. DEDUP / COOLDOWN — for a given (workspace, worker, failure-signature) the
     FIRST failure alert is sent, then repeats are suppressed for
     WORKEROS_ALERT_DEDUP_WINDOW_SECONDS (default 4h). A DIFFERENT failure
     signature (new error), or the same one after the window elapses,
     re-alerts. So the owner learns a worker is broken without 100 emails, and
     still gets a fresh alert if the failure changes or persists across the
     window.

  2. WORKSPACE DAILY CAP — a hard backstop: at most
     WORKEROS_ALERT_WORKSPACE_DAILY_CAP (default 20) failure-alert emails per
     workspace per UTC day, regardless of dedup. Even if the dedup key has a
     gap (many distinct signatures, a code bug), no single workspace can
     re-exhaust the shared quota.

State is persisted via ``repos.alert_throttle`` (Supabase in cloud, SQLite in
self-host) so the daily cap survives process restarts. When no throttle repo is
registered (older/mismatched deploy) an in-process fallback still enforces both
rules for the life of the process — the cloud API runs a single uvicorn worker,
so the fallback alone stops a storm; it just does not survive a restart.

``should_send_failure_alert(...)`` is an atomic-ish check-and-record ("reserve a
slot"): it returns True AND records the send when allowed, False when
suppressed. It NEVER raises — on any persistence error it degrades to the
in-process fallback rather than letting the alert path crash or spam.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("floom.run_service")

_DEFAULT_DEDUP_WINDOW_SECONDS = 4 * 60 * 60  # 4h
_DEFAULT_WORKSPACE_DAILY_CAP = 20


def _dedup_window_seconds() -> int:
    try:
        return max(0, int(os.environ.get("WORKEROS_ALERT_DEDUP_WINDOW_SECONDS", str(_DEFAULT_DEDUP_WINDOW_SECONDS))))
    except (TypeError, ValueError):
        return _DEFAULT_DEDUP_WINDOW_SECONDS


def _workspace_daily_cap() -> int:
    try:
        return max(0, int(os.environ.get("WORKEROS_ALERT_WORKSPACE_DAILY_CAP", str(_DEFAULT_WORKSPACE_DAILY_CAP))))
    except (TypeError, ValueError):
        return _DEFAULT_WORKSPACE_DAILY_CAP


def failure_signature(*, error: str | None, error_code: str | None = None, status: str | None = None) -> str:
    """Stable short key for a failure so the same recurring error dedups but a
    genuinely different failure re-alerts.

    Prefers an explicit ``error_code`` (e.g. "missing_secret"); otherwise hashes
    a normalised first line of the error text (digits/UUIDs/hex stripped so
    per-run identifiers don't defeat the dedup)."""
    code = (error_code or "").strip().lower()
    if code:
        return code[:80]
    raw = (error or "").strip()
    if not raw:
        return (status or "failed").strip().lower()[:80] or "failed"
    first_line = raw.splitlines()[0]
    # Strip volatile tokens so "run_abc123" / timestamps / ids don't fragment the key.
    normalised = re.sub(r"[0-9a-f]{6,}", "#", first_line.lower())
    normalised = re.sub(r"\d+", "#", normalised)
    normalised = " ".join(normalised.split())[:200]
    digest = hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:16]
    return f"h:{digest}"


def _utc_day_start_iso(now: datetime) -> str:
    return now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


def _iso(dt: datetime) -> str:
    return dt.isoformat()


# ---------------------------------------------------------------------------
# In-process fallback store (used when repos.alert_throttle is unavailable or
# a persistence call fails). Thread-safe; bounded to the current process.
# ---------------------------------------------------------------------------

class _InProcessThrottle:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        # (workspace_id, worker_id, signature) -> last_sent datetime
        self._last_sent: dict[tuple[str, str, str], datetime] = {}
        # workspace_id -> list[datetime] of sends (pruned to today)
        self._ws_sends: dict[str, list[datetime]] = {}

    def reserve(self, *, workspace_id: str, worker_id: str, signature: str, now: datetime, window_s: int, daily_cap: int) -> bool:
        key = (workspace_id, worker_id, signature)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        with self._lock:
            # Cooldown / dedup
            last = self._last_sent.get(key)
            if last is not None and window_s > 0 and (now - last).total_seconds() < window_s:
                return False
            # Daily cap
            sends = [t for t in self._ws_sends.get(workspace_id, []) if t >= day_start]
            if daily_cap > 0 and len(sends) >= daily_cap:
                self._ws_sends[workspace_id] = sends  # prune
                return False
            # Reserve
            self._last_sent[key] = now
            sends.append(now)
            self._ws_sends[workspace_id] = sends
            return True


_fallback = _InProcessThrottle()


def _repo_reserve(repo: Any, *, workspace_id: str, worker_id: str, signature: str, now: datetime, window_s: int, daily_cap: int) -> bool:
    """Durable reserve via repos.alert_throttle. Raises on persistence error so
    the caller can degrade to the in-process fallback."""
    now_iso = _iso(now)
    # Cooldown: any send for this (ws,worker,signature) inside the window?
    if window_s > 0:
        since = datetime.fromtimestamp(now.timestamp() - window_s, tz=timezone.utc)
        recent = repo.count_since(
            since_iso=_iso(since),
            workspace_id=workspace_id,
            worker_id=worker_id,
            signature=signature,
        )
        if recent and recent > 0:
            return False
    # Daily cap: total workspace sends since UTC midnight.
    if daily_cap > 0:
        today = repo.count_since(since_iso=_utc_day_start_iso(now), workspace_id=workspace_id)
        if today is not None and today >= daily_cap:
            return False
    repo.record(workspace_id=workspace_id, worker_id=worker_id, signature=signature, sent_at_iso=now_iso)
    return True


def should_send_failure_alert(
    *,
    repos: Any,
    workspace_id: str | None,
    worker_id: str,
    signature: str,
    now: Optional[datetime] = None,
) -> bool:
    """Reserve a failure-alert email slot. Returns True (and records the send)
    when allowed by the dedup window AND the workspace daily cap; False when
    suppressed. Never raises."""
    ws = (workspace_id or "local-default").strip() or "local-default"
    wid = (worker_id or "").strip()
    sig = (signature or "failed").strip() or "failed"
    now = now or datetime.now(timezone.utc)
    window_s = _dedup_window_seconds()
    daily_cap = _workspace_daily_cap()

    repo = getattr(repos, "alert_throttle", None) if repos is not None else None
    if repo is not None:
        try:
            return _repo_reserve(
                repo,
                workspace_id=ws,
                worker_id=wid,
                signature=sig,
                now=now,
                window_s=window_s,
                daily_cap=daily_cap,
            )
        except Exception as exc:  # noqa: BLE001 — never let alerting crash the run path
            logger.warning(
                "alert_throttle persistence failed (worker=%s); using in-process fallback: %s",
                wid,
                exc,
            )
    return _fallback.reserve(
        workspace_id=ws,
        worker_id=wid,
        signature=sig,
        now=now,
        window_s=window_s,
        daily_cap=daily_cap,
    )


def note_worker_recovered(*, repos: Any, workspace_id: str | None, worker_id: str) -> None:
    """Clear dedup state so the NEXT failure re-alerts immediately after a
    recovery, instead of waiting out the cooldown window. Best-effort; the
    daily-cap history is intentionally NOT cleared (the cap is a per-day quota).
    """
    ws = (workspace_id or "local-default").strip() or "local-default"
    wid = (worker_id or "").strip()
    repo = getattr(repos, "alert_throttle", None) if repos is not None else None
    if repo is not None and hasattr(repo, "clear_dedup"):
        try:
            repo.clear_dedup(workspace_id=ws, worker_id=wid)
        except Exception as exc:  # noqa: BLE001
            logger.debug("alert_throttle clear_dedup failed for %s: %s", wid, exc)
    # In-process fallback: drop any last_sent entries for this worker.
    try:
        with _fallback._lock:  # noqa: SLF001 — internal cooperation
            for key in [k for k in _fallback._last_sent if k[0] == ws and k[1] == wid]:
                _fallback._last_sent.pop(key, None)
    except Exception:
        pass
