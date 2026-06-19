"""Worker telemetry, alerts, and feedback routes.

Per-worker run timeseries / stats, workspace stats, run logs, the alert-incident
CRUD, and the worker-feedback CRUD. Extracted verbatim from main.py.

Deps resolve to services (worker_access visibility, worker_serialize stats/
timeseries batches, public_view log redaction) + models/db; db is lazy in
handlers. The router is purged in lockstep with main by the worker test fixtures.
"""

from __future__ import annotations

import re
import uuid as _uuid_mod
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from auth import AuthContext, get_auth_context
from core.utils import _parse_iso8601
from db import Repositories, get_repos
from models import (
    RunStatus,
    TimeseriesDay,
    UnsafeOutboundUrlError,
    WorkerAlert,
    WorkerAlertCreate,
    WorkerFeedback,
    WorkerFeedbackCreate,
    WorkerStats,
    WorkspaceStats,
    assert_safe_outbound_url,
)
from services.public_view import _redact_public_log_message
from services.worker_access import _active_local_workspace_id, _get_visible_worker
from services.worker_serialize import _get_stats_batch, _get_timeseries_batch

worker_telemetry_router = APIRouter()

# #1068 — conservative email syntactic check (not full RFC 5322), enough to
# reject garbage / header-injection in alert recipients.
_EMAIL_RE = re.compile(r"^[^@\s,;:<>\"]+@[^@\s,;:<>\"]+\.[^@\s,;:<>\"]+$")

@worker_telemetry_router.get("/workers/{worker_id}/runs/timeseries", response_model=List[TimeseriesDay])
def get_worker_timeseries(
    worker_id: str,
    days: int = Query(default=14, ge=1, le=90),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[TimeseriesDay]:
    """Return per-day run counts for the last N days (default 14). Zero-filled."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    batch = _get_timeseries_batch(
        [worker_id],
        user_id=auth.user_id,
        repos=repos,
        days=days,
    )
    return batch.get(worker_id, [])


# ---------------------------------------------------------------------------
# Monitoring: GET /workers/{id}/stats
# ---------------------------------------------------------------------------

@worker_telemetry_router.get("/workers/{worker_id}/stats", response_model=WorkerStats)
def get_worker_stats(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerStats:
    """Extended health and run statistics for a single worker."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    stats_7d = repos.workers.stats_batch(
        user_id=auth.user_id, worker_ids=[worker_id], days=7
    ).get(worker_id)
    stats_30d = repos.workers.stats_batch(
        user_id=auth.user_id, worker_ids=[worker_id], days=30
    ).get(worker_id)

    # Aggregate duration and last failure from raw run rows
    runs_30d_rows, _ = repos.runs.list(
        user_id=auth.user_id,
        worker_id=worker_id,
        limit=200,
    )
    durations = [
        r["duration_ms"]
        for r in runs_30d_rows
        if r.get("duration_ms") is not None
    ]
    avg_duration_ms: Optional[float] = (
        sum(durations) / len(durations) if durations else None
    )
    p95_duration_ms: Optional[float] = None
    if durations:
        sorted_d = sorted(durations)
        idx = max(0, int(len(sorted_d) * 0.95) - 1)
        p95_duration_ms = float(sorted_d[idx])

    failed_rows = [
        r for r in runs_30d_rows if r.get("status") == RunStatus.FAILED.value
    ]
    last_failure = failed_rows[0] if failed_rows else None

    return WorkerStats(
        worker_id=worker_id,
        last_run_at=stats_7d.last_run_at if stats_7d else None,
        runs_7d=stats_7d.runs_7d if stats_7d else 0,
        success_rate_7d=stats_7d.success_rate_7d if stats_7d else None,
        success_rate_change_7d=stats_7d.success_rate_change_7d if stats_7d else None,
        runs_30d=stats_30d.runs_7d if stats_30d else 0,
        success_rate_30d=stats_30d.success_rate_7d if stats_30d else None,
        avg_duration_ms=avg_duration_ms,
        p95_duration_ms=p95_duration_ms,
        total_failures=len(failed_rows),
        last_error=last_failure.get("error") if last_failure else None,
        last_error_at=last_failure.get("completed_at") or last_failure.get("created_at") if last_failure else None,
    )


# ---------------------------------------------------------------------------
# Monitoring: GET /stats (workspace-level aggregate)
# ---------------------------------------------------------------------------

@worker_telemetry_router.get("/stats", response_model=WorkspaceStats)
def get_workspace_stats(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkspaceStats:
    """Aggregate health and run statistics across the entire workspace."""
    workers = repos.workers.list(user_id=auth.user_id)
    worker_ids = [w["id"] for w in workers if not w.get("archived")]
    total_workers = len(worker_ids)

    if not worker_ids:
        return WorkspaceStats(total_workers=total_workers)

    stats_map = repos.workers.stats_batch(
        user_id=auth.user_id, worker_ids=worker_ids, days=7
    )

    total_runs_7d = sum(s.runs_7d for s in stats_map.values())
    active_workers = sum(1 for s in stats_map.values() if s.runs_7d > 0)

    all_completions = sum(
        int((s.success_rate_7d or 0) * s.runs_7d)
        for s in stats_map.values()
        if s.success_rate_7d is not None
    )
    success_rate_7d: Optional[float] = (
        all_completions / total_runs_7d if total_runs_7d > 0 else None
    )

    most_active = max(stats_map.items(), key=lambda kv: kv[1].runs_7d, default=None)
    most_active_worker_id = most_active[0] if most_active and most_active[1].runs_7d > 0 else None
    most_active_worker_name: Optional[str] = None
    if most_active_worker_id:
        w_row = next((w for w in workers if w["id"] == most_active_worker_id), None)
        most_active_worker_name = w_row.get("name") if w_row else None

    # Avg duration across recent runs
    runs_rows, _ = repos.runs.list(
        user_id=auth.user_id, limit=200
    )
    durations = [r["duration_ms"] for r in runs_rows if r.get("duration_ms") is not None]
    avg_duration_ms: Optional[float] = sum(durations) / len(durations) if durations else None

    return WorkspaceStats(
        total_workers=total_workers,
        active_workers=active_workers,
        total_runs_7d=total_runs_7d,
        success_rate_7d=success_rate_7d,
        avg_duration_ms=avg_duration_ms,
        most_active_worker_id=most_active_worker_id,
        most_active_worker_name=most_active_worker_name,
    )


# ---------------------------------------------------------------------------
# Monitoring: GET /workers/{id}/logs (cross-run logs)
# ---------------------------------------------------------------------------

@worker_telemetry_router.get("/workers/{worker_id}/logs", response_model=List[Dict[str, Any]])
def get_worker_logs(
    worker_id: str,
    level: Optional[str] = Query(None, description="Filter by log level (info, warning, error, debug)"),
    since: Optional[str] = Query(None, description="ISO 8601 timestamp lower bound"),
    limit: int = Query(200, ge=1, le=1000),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[Dict[str, Any]]:
    """Cross-run logs for a worker, optionally filtered by level and start time."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    since_dt = _parse_iso8601(since) if since else None
    if since and since_dt is None:
        raise HTTPException(status_code=400, detail="Invalid since value")
    rows = repos.runs.list_logs_for_worker(
        user_id=auth.user_id,
        worker_id=worker_id,
        level=level,
        since=since_dt.isoformat() if since_dt else None,
        limit=limit,
    )
    return [
        {
            "run_id": r.get("run_id"),
            "level": r.get("level"),
            "message": _redact_public_log_message(r.get("message", "")),
            "timestamp": r.get("timestamp"),
            "trace_id": r.get("trace_id"),
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Alerts: POST/GET/DELETE /workers/{id}/alerts
# ---------------------------------------------------------------------------

@worker_telemetry_router.post("/workers/{worker_id}/alerts", response_model=WorkerAlert, status_code=201)
def create_worker_alert(
    worker_id: str,
    body: WorkerAlertCreate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerAlert:
    """Register a webhook endpoint to be called when this worker's runs terminate."""
    from db import now_iso
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    if not body.url and not body.email_to:
        raise HTTPException(
            status_code=400,
            detail="At least one of url (webhook) or email_to (email recipients) is required.",
        )
    # #1068 — email_to could target arbitrary external recipients (spam/phishing
    # off the platform's mail reputation). Validate syntax always, and restrict
    # to workspace-member addresses when the membership directory is populated
    # (the open-signup cloud case); fall back to syntax-only when no member
    # emails are known (local single-user with no email on file).
    if body.email_to:
        for addr in body.email_to:
            if not isinstance(addr, str) or not _EMAIL_RE.match(addr.strip()):
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid alert email recipient: {addr!r}",
                )
        member_emails: set[str] = set()
        members_repo = getattr(repos, "members", None)
        if members_repo is not None:
            try:
                workspace_id = _active_local_workspace_id(auth)
                member_emails = {
                    (m.get("email") or "").strip().lower()
                    for m in members_repo.list(workspace_id=workspace_id)
                    if m.get("email")
                }
            except Exception:
                member_emails = set()
        if member_emails:
            not_members = [
                addr for addr in body.email_to
                if addr.strip().lower() not in member_emails
            ]
            if not_members:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Alert email recipients must be workspace members: "
                        f"{not_members}"
                    ),
                )
    # SSRF guard at store time: a webhook URL pointing at an internal /
    # loopback / link-local / metadata target is rejected on save (400), so a
    # bad URL never lands in the DB to be POSTed to later. The webhook delivery
    # path re-checks at send time (DNS-rebinding defense in depth).
    if body.url:
        try:
            body.url = assert_safe_outbound_url(body.url, label="Alert webhook URL")
        except UnsafeOutboundUrlError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    valid_events = {"failed", "completed"}
    invalid = [e for e in body.on if e not in valid_events]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid events: {invalid}. Allowed: {sorted(valid_events)}",
        )
    import json as _json
    alert_id = f"alrt_{_uuid_mod.uuid4().hex[:12]}"
    email_to_json = _json.dumps(body.email_to) if body.email_to else None
    row = repos.alerts.add(
        alert_id=alert_id,
        worker_id=worker_id,
        url=body.url,
        email_to=email_to_json,
        events=",".join(body.on),
        description=body.description,
        created_at=now_iso(),
    )
    _et = row.get("email_to")
    return WorkerAlert(
        id=row["id"],
        worker_id=row["worker_id"],
        url=row.get("url"),
        email_to=_json.loads(_et) if _et else None,
        on=row["events"].split(","),
        description=row.get("description"),
        created_at=row["created_at"],
    )


@worker_telemetry_router.get("/workers/{worker_id}/alerts", response_model=List[WorkerAlert])
def list_worker_alerts(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[WorkerAlert]:
    """List all registered webhook alerts for a worker."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    import json as _json
    rows = repos.alerts.list(worker_id=worker_id)
    return [
        WorkerAlert(
            id=r["id"],
            worker_id=r["worker_id"],
            url=r.get("url"),
            email_to=_json.loads(r["email_to"]) if r.get("email_to") else None,
            on=r["events"].split(","),
            description=r.get("description"),
            created_at=r["created_at"],
        )
        for r in rows
    ]


@worker_telemetry_router.delete("/workers/{worker_id}/alerts/{alert_id}", status_code=204, response_class=Response)
def delete_worker_alert(
    worker_id: str,
    alert_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """Remove a registered webhook alert."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    deleted = repos.alerts.delete(alert_id=alert_id, worker_id=worker_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Alert not found")
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Worker feedback: anyone who can SEE a worker can leave a comment, surfaced to
# the owner (SPEC §12). GET/POST /workers/{id}/feedback, DELETE one.
# ---------------------------------------------------------------------------

def _feedback_to_model(row: Dict[str, Any]) -> WorkerFeedback:
    return WorkerFeedback(
        id=row["id"],
        worker_id=row["worker_id"],
        author_id=row["author_id"],
        author_name=row.get("author_name"),
        content=row["content"],
        created_at=row["created_at"],
    )


@worker_telemetry_router.post("/workers/{worker_id}/feedback", response_model=WorkerFeedback, status_code=201)
def create_worker_feedback(
    worker_id: str,
    body: WorkerFeedbackCreate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerFeedback:
    """Leave feedback on a worker. Anyone who can SEE the worker may comment (SPEC §12)."""
    from db import now_iso
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    if repos.feedback is None:
        raise HTTPException(status_code=503, detail="feedback not available")
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Feedback content is required.")
    row = repos.feedback.add(
        feedback_id=f"fdbk_{_uuid_mod.uuid4().hex[:12]}",
        worker_id=worker_id,
        author_id=auth.user_id,
        author_name=auth.username or auth.email,
        content=content,
        created_at=now_iso(),
    )
    return _feedback_to_model(row)


@worker_telemetry_router.get("/workers/{worker_id}/feedback", response_model=List[WorkerFeedback])
def list_worker_feedback(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[WorkerFeedback]:
    """List feedback on a worker (oldest first). Visible to anyone who can see the worker."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    if repos.feedback is None:
        return []
    return [_feedback_to_model(r) for r in repos.feedback.list(worker_id=worker_id)]


@worker_telemetry_router.delete("/workers/{worker_id}/feedback/{feedback_id}", status_code=204, response_class=Response)
def delete_worker_feedback(
    worker_id: str,
    feedback_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """Delete a feedback comment. The author, the worker owner, or an admin may remove it."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    if repos.feedback is None:
        raise HTTPException(status_code=503, detail="feedback not available")
    row = repos.feedback.get(feedback_id=feedback_id)
    if not row or row.get("worker_id") != worker_id:
        raise HTTPException(status_code=404, detail="Feedback not found")
    owner_id = worker.get("owner_id")
    is_author = row.get("author_id") == auth.user_id
    is_worker_owner = bool(owner_id) and owner_id == auth.user_id
    if not (is_author or is_worker_owner or auth.is_admin):
        raise HTTPException(status_code=403, detail="Not allowed to delete this feedback.")
    repos.feedback.delete(feedback_id=feedback_id, worker_id=worker_id)
    return Response(status_code=204)
