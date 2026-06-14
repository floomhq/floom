"""System health + metrics routes: /health, /health/details, /healthz,
/metrics (Prometheus), /system/metrics.

Liveness + readiness probes, the detailed per-dependency health view, the
Prometheus exposition endpoint, and the operator system-metrics JSON. Extracted
verbatim from main.py.

Health probes + Prometheus formatters come from services.health_ops; the
drafts-last-hour gauge from services.worker_codegen; db.get_db / models.RunStatus
are lazy in system_metrics. Purged in lockstep with main.
"""

from __future__ import annotations

import collections
from datetime import datetime, timedelta, timezone
import time
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse

from auth import AuthContext, get_auth_context
from auth.guards import _require_admin
from core.config import _PROCESS_START_TIME
from db import Repositories, get_repos
from services.health_ops import _prometheus_escape, _prometheus_label, _run_health_checks
from services.worker_codegen import _drafts_last_hour_total

import logging

logger = logging.getLogger("floom.api")

system_health_router = APIRouter()

# Module-level counter owned by prometheus_metrics (read+incremented there only).
_METRICS_DB_CONNECTION_ERRORS_TOTAL = 0


@system_health_router.get("/healthz")
def healthz():
    """Liveness probe — exempt from x-floom-secret."""
    return {"status": "ok"}


@system_health_router.get("/health")
def health():
    """Readiness probe — public, minimal.

    #853 RCA: this endpoint returned the full dependency-check payload (disk
    free space, E2B/OpenAI/Composio status, scheduler thread name) without
    auth — infrastructure reconnaissance for free. Probes only need the
    aggregate status; the detailed checks moved to GET /health/details
    (admin-only).
    """
    payload = _run_health_checks()
    return {"status": payload["status"], "checked_at": payload["checked_at"]}


@system_health_router.get("/health/details")
def health_details(auth: AuthContext = Depends(get_auth_context)):
    """Full dependency checks — admin only (#853)."""
    _require_admin(auth)
    return _run_health_checks()


@system_health_router.get("/system/metrics")
def system_metrics(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Operational metrics for the dashboard / external monitors.

    Gated by x-floom-secret like other admin routes. Returns a flat counters
    payload suitable for cron-scraped JSON monitoring.
    """
    from models import RunStatus

    workers = repos.workers.list(user_id=auth.user_id)
    _runs_page, runs_total = repos.runs.list(user_id=auth.user_id, limit=1, offset=0)
    _runs_7d_page, runs_7d = repos.runs.list(
        user_id=auth.user_id,
        since=(datetime.now(timezone.utc) - timedelta(days=7)).isoformat(),
        limit=1,
        offset=0,
    )
    _failed_7d_page, runs_failed_7d = repos.runs.list(
        user_id=auth.user_id,
        statuses=[RunStatus.FAILED.value],
        since=(datetime.now(timezone.utc) - timedelta(days=7)).isoformat(),
        limit=1,
        offset=0,
    )
    connections_count = len(repos.connections.list(user_id=auth.user_id))
    secrets_count = len(repos.secrets.list(user_id=auth.user_id))
    active_triggers = sum(
        1
        for worker in workers
        if worker.get("enabled") and worker.get("trigger_type") != "manual"
    )
    try:
        from runner_sandbox.agent_driver import cancel_flag_db_read_errors_total
        cancel_flag_errors = cancel_flag_db_read_errors_total()
    except Exception:
        cancel_flag_errors = 0
    return {
        "workers_count": len(workers),
        "runs_total": int(runs_total or 0),
        "runs_7d": int(runs_7d or 0),
        "runs_failed_7d": int(runs_failed_7d or 0),
        "connections_count": int(connections_count or 0),
        "secrets_count": int(secrets_count or 0),
        "active_triggers": int(active_triggers or 0),
        "drafts_last_hour": _drafts_last_hour_total(),
        "cancel_flag_db_read_errors": int(cancel_flag_errors or 0),
        "uptime_seconds": int(time.time() - _PROCESS_START_TIME),
    }


@system_health_router.get("/metrics", response_class=PlainTextResponse)
def prometheus_metrics(auth: AuthContext = Depends(get_auth_context)):
    """Prometheus text exposition for runtime health. Admin-only."""
    # Security (#1072): Prometheus output exposes worker IDs, run counts, error
    # counts, and internal timing data. Gate to admin — members get 403.
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    from db import get_db

    buckets = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600]
    try:
        from runner_sandbox.agent_driver import cancel_flag_db_read_errors_total
        cancel_flag_errors = cancel_flag_db_read_errors_total()
    except Exception:
        cancel_flag_errors = 0
    try:
        with get_db() as conn:
            run_rows = conn.execute(
                """
                SELECT r.worker_id, r.status, COUNT(*) AS total
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ?
                GROUP BY r.worker_id, r.status
                """,
                (auth.user_id,),
            ).fetchall()
            duration_rows = conn.execute(
                """
                SELECT r.worker_id, r.duration_ms
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ?
                  AND r.duration_ms IS NOT NULL
                  AND r.status IN ('completed', 'failed')
                """,
                (auth.user_id,),
            ).fetchall()
            spawn_errors = conn.execute(
                """
                SELECT COUNT(*) AS total
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ?
                  AND r.error_code IN ('e2b_sandbox_error', 'missing_e2b_key')
                """,
                (auth.user_id,),
            ).fetchone()["total"]
            active_runs = conn.execute(
                """
                SELECT COUNT(*) AS total
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ?
                  AND r.status IN ('queued', 'running')
                """,
                (auth.user_id,),
            ).fetchone()["total"]
    except Exception:
        global _METRICS_DB_CONNECTION_ERRORS_TOTAL
        _METRICS_DB_CONNECTION_ERRORS_TOTAL += 1
        logger.exception("Prometheus metrics DB query failed")
        return PlainTextResponse(
            f"workeros_db_connection_errors_total {_METRICS_DB_CONNECTION_ERRORS_TOTAL}\n",
            status_code=500,
            media_type="text/plain; version=0.0.4",
        )

    lines = [
        "# HELP workeros_runs_total Total runs by worker and status.",
        "# TYPE workeros_runs_total counter",
    ]
    for row in run_rows:
        lines.append(
            f"workeros_runs_total{_prometheus_label(row['worker_id'], row['status'])} {int(row['total'] or 0)}"
        )
    lines.extend([
        "# HELP workeros_run_duration_seconds Run duration histogram by worker.",
        "# TYPE workeros_run_duration_seconds histogram",
    ])
    durations_by_worker: Dict[str, List[float]] = collections.defaultdict(list)
    for row in duration_rows:
        durations_by_worker[row["worker_id"]].append(float(row["duration_ms"]) / 1000.0)
    for worker_id, durations in sorted(durations_by_worker.items()):
        cumulative = 0
        for bucket in buckets:
            cumulative = sum(1 for duration in durations if duration <= bucket)
            lines.append(
                f'workeros_run_duration_seconds_bucket{{worker_id="{_prometheus_escape(worker_id)}",le="{bucket}"}} {cumulative}'
            )
        lines.append(
            f'workeros_run_duration_seconds_bucket{{worker_id="{_prometheus_escape(worker_id)}",le="+Inf"}} {len(durations)}'
        )
        lines.append(f"workeros_run_duration_seconds_sum{_prometheus_label(worker_id)} {sum(durations):.3f}")
        lines.append(f"workeros_run_duration_seconds_count{_prometheus_label(worker_id)} {len(durations)}")
    lines.extend([
        "# HELP workeros_sandbox_spawn_errors_total Total E2B sandbox spawn/config errors.",
        "# TYPE workeros_sandbox_spawn_errors_total counter",
        f"workeros_sandbox_spawn_errors_total {int(spawn_errors or 0)}",
        "# HELP workeros_db_connection_errors_total Total DB connection/query errors observed by metrics.",
        "# TYPE workeros_db_connection_errors_total counter",
        f"workeros_db_connection_errors_total {_METRICS_DB_CONNECTION_ERRORS_TOTAL}",
        "# HELP workeros_cancel_flag_db_read_errors_total Total cancel flag DB read failures treated as cancelled.",
        "# TYPE workeros_cancel_flag_db_read_errors_total counter",
        f"workeros_cancel_flag_db_read_errors_total {int(cancel_flag_errors or 0)}",
        "# HELP workeros_active_runs Active queued or running runs.",
        "# TYPE workeros_active_runs gauge",
        f"workeros_active_runs {int(active_runs or 0)}",
    ])
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4")
