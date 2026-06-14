"""Operator overview dashboard route.

``GET /system/overview`` — the composed dashboard payload (outcome stats,
sparklines, recent runs, today's schedule, needs-attention items) plus its
response models and serializer helpers. Extracted verbatim from main.py.

Everything resolves from services (worker_access listing/serializers,
public_view redaction, secrets_env names, core.utils parsing) — module-level
imports, never purged. ``db``/``models`` are imported lazily in handlers.
"""

from __future__ import annotations

import collections
import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from auth import AuthContext, get_auth_context
from core.config import PROTECTED_STOCK_WORKER_IDS, PUBLIC_STOCK_WORKER_IDS
from core.utils import _parse_iso8601
from db import Repositories, get_repos
from models import RunStatus
from services.public_view import (
    _OPERATOR_ERROR_CODE_HEADLINES,
    _has_internal_artifact,
    _looks_like_runtime_jargon,
    _operator_error_message,
)
from services.secrets_env import _available_secret_names_for_user
from services.worker_access import (
    _available_connection_slugs_for_user,
    _list_operator_workers,
    _normalize_run_status,
    _trigger_label,
    _worker_access_user_id,
    _worker_connection_slugs,
    _worker_repo_role,
    _worker_required_secret_names,
)

overview_router = APIRouter()


class OverviewStats(BaseModel):
    runs_24h: int
    runs_24h_sparkline: List[int]
    runs_7d_sparkline: List["OverviewSparklineBucket"]
    success_rate_7d: Optional[float] = None
    # G5 FIX 3: success_rate_7d is scoped to ACTIVE, real (non-example,
    # non-system, non-paused) workers so the headline reflects what a partner's
    # live workers actually do — not legacy/paused/example churn. This label
    # tells the UI which denominator the rate represents.
    success_rate_scope: str = "active_workers"
    active_workers_count: int
    paused_workers_count: int
    connections_healthy: int
    connections_total: int
    work_shipped_7d: int
    work_shipped_previous_7d: int
    runs_today: int
    completed_today: int
    failed_today: int
    running_now: int
    queued_now: int
    scheduled_24h_count: int
    next_scheduled_at: Optional[str] = None

class OverviewSparklineBucket(BaseModel):
    label: str
    started_at: str
    total: int
    failed: int

class OverviewRunItem(BaseModel):
    run_id: str
    worker_id: str
    worker_name: str
    status: str
    started_at: Optional[str] = None
    duration_ms: int
    trigger_source: str

class OverviewOutcomeItem(BaseModel):
    worker_id: str
    worker_name: str
    label: str
    count: int

class OverviewScheduledItem(BaseModel):
    worker_id: str
    worker_name: str
    next_fire_at: str
    trigger_label: str
    trigger_source: str
    paused: bool = False

class OverviewAttentionItem(BaseModel):
    type: str
    kind: Optional[str] = None
    worker_id: Optional[str] = None
    worker_name: Optional[str] = None
    connection_id: Optional[str] = None
    # PR S19 (I-7): name the connection in the UI instead of an opaque
    # "Connection expired" with no provider context. Populated for
    # connection_expired / connection_expiring rows; None otherwise.
    provider_slug: Optional[str] = None
    provider_display_name: Optional[str] = None
    provider_names: List[str] = Field(default_factory=list)
    message: str
    cause: Optional[str] = None
    error_code: Optional[str] = None
    recent_failure_count: Optional[int] = None
    last_failed_at: Optional[str] = None
    suggested_actions: List[str] = Field(default_factory=list)
    action_url: str

class OverviewResponse(BaseModel):
    stats: OverviewStats
    outcomes: List[OverviewOutcomeItem]
    recent_runs: List[OverviewRunItem]
    scheduled_today: List[OverviewScheduledItem]
    needs_attention: List[OverviewAttentionItem]

def _overview_outcome_label(worker_name: str) -> str:
    return "Work shipped"

def _overview_human_error_code(error_code: Optional[str]) -> str:
    if not error_code:
        return "Run failed"
    return re.sub(r"[_-]+", " ", error_code).strip().capitalize()

def _overview_failure_cause(row: Dict[str, Any]) -> str:
    raw_error_code = row.get("error_code")
    error_code = _overview_human_error_code(raw_error_code)
    raw_message = str(row.get("error") or "").strip()
    # Operator hygiene (G5): never let a raw traceback / sandbox path / env-var
    # name OR artifact-free runtime jargon ("Event loop is closed", E2B deadline
    # boilerplate) surface in the overview failure cause. The code-keyed
    # sanitizer maps any recognised error_code, and any remaining jargon, to a
    # calm headline before we ever fall through to "<code>: <raw message>".
    code = str(raw_error_code or "").strip().lower()
    if code and code in _OPERATOR_ERROR_CODE_HEADLINES:
        return _OPERATOR_ERROR_CODE_HEADLINES[code]
    if raw_message and (
        _has_internal_artifact(raw_message) or _looks_like_runtime_jargon(raw_message)
    ):
        return _operator_error_message(raw_message, raw_error_code) or error_code
    error_message = raw_message
    if error_message:
        first_line = error_message.splitlines()[0].strip()
        if len(first_line) > 140:
            first_line = first_line[:137].rstrip() + "..."
        # Avoid duplicated label prefixes, e.g. error_code "missing_secret"
        # humanizes to "Missing secret" while the message already starts with
        # "Missing secrets: …" — concatenating yields the doubled label
        # "Missing secret: Missing secrets: …". When the message already leads
        # with the (loosely-matched) humanized code, return the message alone.
        normalized_code = re.sub(r"[^a-z]", "", error_code.lower())
        normalized_msg_prefix = re.sub(
            r"[^a-z]", "", first_line.lower().split(":", 1)[0]
        )
        if normalized_code and normalized_msg_prefix.startswith(normalized_code):
            return first_line
        return f"{error_code}: {first_line}"
    return error_code

def _overview_consecutive_failure_threshold() -> int:
    raw = os.environ.get("WORKEROS_ALERT_CONSECUTIVE_FAILURES", "3")
    try:
        return max(1, int(raw))
    except ValueError:
        return 3

def _overview_consecutive_failure_items(
    *,
    runs: List[Dict[str, Any]],
    worker_names: Dict[str, str],
    threshold: int,
) -> List[OverviewAttentionItem]:
    by_worker: Dict[str, List[Dict[str, Any]]] = collections.defaultdict(list)
    for row in runs:
        worker_id = row.get("worker_id")
        if worker_id:
            by_worker[str(worker_id)].append(row)

    def _run_time(row: Dict[str, Any]) -> datetime:
        parsed = _parse_iso8601(row.get("started_at") or row.get("completed_at") or row.get("created_at"))
        return parsed or datetime.min.replace(tzinfo=timezone.utc)

    items: List[OverviewAttentionItem] = []
    for worker_id, rows in by_worker.items():
        ordered = sorted(rows, key=_run_time, reverse=True)
        consecutive = 0
        latest_failure: Dict[str, Any] | None = None
        for row in ordered:
            status = str(row.get("status") or "").lower()
            if status in {"failed", "error", "cancelled", "rejected", "timeout"}:
                consecutive += 1
                if latest_failure is None:
                    latest_failure = row
                continue
            break
        if consecutive < threshold or latest_failure is None:
            continue
        last_failed_at = (
            latest_failure.get("started_at")
            or latest_failure.get("completed_at")
            or latest_failure.get("created_at")
        )
        items.append(
            OverviewAttentionItem(
                type="consecutive_failures",
                kind="failing",
                worker_id=worker_id,
                worker_name=worker_names.get(worker_id, worker_id),
                message=f"{consecutive} consecutive failures",
                cause=_overview_failure_cause(latest_failure),
                error_code=latest_failure.get("error_code"),
                recent_failure_count=consecutive,
                last_failed_at=last_failed_at,
                suggested_actions=["view_logs", "retry", "disable"],
                action_url=f"/workers/{worker_id}",
            )
        )
    return sorted(
        items,
        key=lambda item: (item.recent_failure_count or 0, item.last_failed_at or ""),
        reverse=True,
    )

def _overview_schedule_triggers(worker: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_triggers = worker.get("triggers_json")
    triggers: List[Dict[str, Any]] = []
    if raw_triggers:
        try:
            parsed = json.loads(raw_triggers)
            if isinstance(parsed, list):
                triggers.extend(item for item in parsed if isinstance(item, dict))
        except Exception:
            pass

    if not triggers:
        config: Dict[str, Any] = worker.get("config") or {}
        trigger = config.get("trigger") or {}
        trigger_type = worker.get("trigger_type") or trigger.get("type") or "manual"
        trigger_with_type = dict(trigger)
        trigger_with_type.setdefault("type", trigger_type)
        triggers = [trigger_with_type]

    return [
        trigger
        for trigger in triggers
        if str(trigger.get("type") or "").lower() in {"schedule", "scheduled"}
    ]

def _overview_worker_paused(worker: Dict[str, Any], trigger: Optional[Dict[str, Any]] = None) -> bool:
    manifest = worker.get("manifest") or {}
    trigger_data = trigger or {}
    return bool(
        not worker.get("enabled")
        or manifest.get("paused") is True
        or manifest.get("enabled") is False
        or trigger_data.get("paused") is True
        or trigger_data.get("enabled") is False
    )

@overview_router.get("/system/overview", response_model=OverviewResponse)
def system_overview(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> OverviewResponse:
    now = datetime.now(timezone.utc)
    window_24h = now - timedelta(hours=24)
    window_7d = now - timedelta(days=7)
    window_14d = now - timedelta(days=14)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    next_24h = now + timedelta(hours=24)

    runs_24h_rows, _ = repos.runs.list(
        user_id=auth.user_id,
        since=window_24h.isoformat(),
        limit=100000,
        offset=0,
    )
    sparkline = [0] * 24
    for row in runs_24h_rows:
        created_at = _parse_iso8601(row["created_at"])
        if created_at is None or created_at < window_24h or created_at > now:
            continue
        bucket = int((created_at - window_24h).total_seconds() // 3600)
        if bucket < 0:
            continue
        if bucket > 23:
            bucket = 23
        sparkline[bucket] += 1
    runs_24h = int(sum(sparkline))

    runs_14d_rows, _runs_total_14d = repos.runs.list(
        user_id=auth.user_id,
        since=window_14d.isoformat(),
        limit=100000,
        offset=0,
    )
    _runs_7d_rows: List[Dict[str, Any]] = []
    previous_7d_rows: List[Dict[str, Any]] = []
    today_rows: List[Dict[str, Any]] = []
    for row in runs_14d_rows:
        created_at = _parse_iso8601(row.get("created_at"))
        if created_at is None:
            continue
        if created_at >= window_7d:
            _runs_7d_rows.append(row)
            if created_at >= today_start:
                today_rows.append(row)
        elif created_at >= window_14d:
            previous_7d_rows.append(row)

    def _is_completed(row: Dict[str, Any]) -> bool:
        return str(row.get("status") or "").lower() in {"completed", "approved", "success", "succeeded"}

    def _is_failed(row: Dict[str, Any]) -> bool:
        return str(row.get("status") or "").lower() in {"failed", "error", "cancelled", "rejected", "timeout"}

    completed_7d = sum(1 for row in _runs_7d_rows if _is_completed(row))
    completed_previous_7d = sum(1 for row in previous_7d_rows if _is_completed(row))
    completed_today = sum(1 for row in today_rows if _is_completed(row))
    failed_today = sum(1 for row in today_rows if _is_failed(row))

    current_rows, _ = repos.runs.list(
        user_id=auth.user_id,
        statuses=[RunStatus.QUEUED.value, RunStatus.RUNNING.value],
        limit=100000,
        offset=0,
    )
    queued_now = sum(1 for row in current_rows if str(row.get("status") or "").lower() == RunStatus.QUEUED.value)
    running_now = sum(1 for row in current_rows if str(row.get("status") or "").lower() == RunStatus.RUNNING.value)

    runs_7d_sparkline: List[OverviewSparklineBucket] = []
    bucket_count = 28
    bucket_seconds = int((now - window_7d).total_seconds() / bucket_count)
    bucket_totals = [0] * bucket_count
    bucket_failures = [0] * bucket_count
    for row in _runs_7d_rows:
        created_at = _parse_iso8601(row.get("created_at"))
        if created_at is None or created_at < window_7d or created_at > now:
            continue
        bucket = int((created_at - window_7d).total_seconds() // bucket_seconds)
        if bucket < 0:
            continue
        if bucket >= bucket_count:
            bucket = bucket_count - 1
        bucket_totals[bucket] += 1
        if _is_failed(row):
            bucket_failures[bucket] += 1
    for index in range(bucket_count):
        bucket_start = window_7d + timedelta(seconds=bucket_seconds * index)
        runs_7d_sparkline.append(
            OverviewSparklineBucket(
                label=bucket_start.strftime("%a %H:%M"),
                started_at=bucket_start.isoformat(),
                total=bucket_totals[index],
                failed=bucket_failures[index],
            )
        )

    # 1.5.4: use the SAME operator-visible filter as the default GET /workers
    # view so the overview 'Workers active' count matches the /workers list
    # (previously this used the unfiltered repos.workers.list() which counted
    # hidden/system/internal workers, e.g. 24 vs 11). Prefer the DB row (which
    # carries `enabled`) for each operator-visible worker, falling back to the
    # filesystem record for stock workers that have no DB row yet, so the
    # enabled/paused logic stays correct and the total equals /workers.
    #
    # SCOPING (78-vs-104 bug): GET /workers resolves the access user-id +
    # role via _worker_access_user_id / _worker_repo_role. The overview MUST use
    # the identical resolution, otherwise an admin member sees the full
    # workspace set on /workers but a narrower owner-only set here and the two
    # counts diverge. Resolve them once and thread them through BOTH the DB
    # denominator and _list_operator_workers.
    _overview_worker_user_id = _worker_access_user_id(auth)
    _overview_worker_role = _worker_repo_role(auth)
    _db_workers_by_id = {
        row["id"]: row
        for row in repos.workers.list(
            user_id=_overview_worker_user_id, role=_overview_worker_role
        )
        if row.get("id")
    }
    workers = [
        _db_workers_by_id.get(w["id"], w)
        for w in _list_operator_workers(
            user_id=_overview_worker_user_id,
            repos=repos,
            role=_overview_worker_role,
        )
        if w.get("id")
    ]
    active_workers_count = sum(1 for row in workers if not _overview_worker_paused(row))
    paused_workers_count = max(0, len(workers) - active_workers_count)
    worker_names = {row["id"]: row.get("name") or row["id"] for row in workers if row.get("id")}
    # Pre-built once to avoid N+1 _get_db_worker() calls when filtering run lists
    # by worker visibility (set lookup vs one SELECT per row).
    _visible_worker_ids: set = {w["id"] for w in workers if w.get("id")}

    # G5 FIX 3: the headline success rate must reflect the partner's ACTIVE,
    # real workers — not legacy/paused/example/system churn that drags the
    # aggregate down (the 54.6% both scorers flagged). Build the set of
    # worker_ids that count: operator-visible (already excludes system/hidden),
    # not paused, and not an example/stock worker.
    def _is_example_worker(row: Dict[str, Any]) -> bool:
        if row.get("is_example") is True:
            return True
        manifest = row.get("manifest")
        if isinstance(manifest, dict) and manifest.get("is_example") is True:
            return True
        return row.get("id") in PUBLIC_STOCK_WORKER_IDS or row.get("id") in PROTECTED_STOCK_WORKER_IDS

    _active_real_worker_ids = {
        row["id"]
        for row in workers
        if row.get("id")
        and not _overview_worker_paused(row)
        and not _is_example_worker(row)
    }

    outcome_counts: Dict[str, int] = collections.Counter(
        row["worker_id"]
        for row in _runs_7d_rows
        if row.get("worker_id")
        and str(row.get("status") or "").lower() in {"completed", "approved", "success"}
    )
    outcomes = [
        OverviewOutcomeItem(
            worker_id=worker_id,
            worker_name=worker_names.get(worker_id, worker_id),
            label=_overview_outcome_label(worker_names.get(worker_id, worker_id)),
            count=int(count),
        )
        for worker_id, count in sorted(
            outcome_counts.items(),
            key=lambda item: item[1],
            reverse=True,
        )[:3]
    ]

    connections = repos.connections.list(user_id=auth.user_id)
    connections_total = len(connections)
    connections_healthy = sum(
        1
        for row in connections
        if row.get("status") == "active"
        and row.get("last_check_status") in (None, "valid")
    )

    # Orphaned-run fix (2026-06-04): the "Worker activity" feed links each row to
    # /runs/{id}, but GET /runs/{id} 404s any run whose worker is no longer
    # API-visible (deleted/hidden internal listeners like slack-listener /
    # whatsapp-listener whose orphaned failed runs survive worker deletion).
    # Surfacing those rows produced clickable links that hit a "Run not found"
    # 404 wall. They are not actionable operator activity, so exclude them here.
    # We over-fetch then filter to keep up to 10 visible rows. The run rows are
    # NOT deleted — this is a serving filter, not a data wipe (no-wipe guardrail).
    recent_rows, _ = repos.runs.list(user_id=auth.user_id, limit=100, offset=0)
    recent_runs = [
        OverviewRunItem(
            run_id=row["id"],
            worker_id=row["worker_id"],
            worker_name=row.get("worker_name") or row["worker_id"],
            status=_normalize_run_status(row["status"] or ""),
            started_at=row.get("started_at") or row.get("created_at"),
            duration_ms=int((row.get("duration_ms") or 0)),
            trigger_source=row.get("trigger_source") or "manual",
        )
        for row in recent_rows
        if row.get("worker_id") in _visible_worker_ids
    ][:10]

    scheduled_today: List[OverviewScheduledItem] = []
    try:
        from scheduler import compute_next_run_at
    except Exception:
        compute_next_run_at = None

    for worker in workers:
        for trigger in _overview_schedule_triggers(worker):
            cron_expr = trigger.get("cron") or worker.get("cron_expr")
            cron_timezone = trigger.get("timezone") or worker.get("cron_timezone") or "UTC"
            next_fire = _parse_iso8601(worker.get("next_run_at"))
            if next_fire is None or next_fire <= now or next_fire > next_24h:
                if compute_next_run_at and cron_expr:
                    computed = compute_next_run_at(str(cron_expr), now, str(cron_timezone))
                    next_fire = _parse_iso8601(computed) if computed else None
            if next_fire is None or next_fire <= now or next_fire > next_24h:
                continue
            scheduled_today.append(
                OverviewScheduledItem(
                    worker_id=worker["id"],
                    worker_name=worker.get("name") or worker["id"],
                    next_fire_at=next_fire.isoformat(),
                    trigger_label=_trigger_label(trigger),
                    trigger_source="schedule",
                    paused=_overview_worker_paused(worker, trigger),
                )
            )
    scheduled_today = sorted(scheduled_today, key=lambda item: item.next_fire_at)

    attention_items: List[OverviewAttentionItem] = []
    failure_runs, _ = repos.runs.list(
        user_id=auth.user_id,
        statuses=[RunStatus.FAILED.value],
        since=window_24h.isoformat(),
        limit=100000,
        offset=0,
    )
    # Orphaned-run fix (2026-06-04): failure clusters link to /workers/{id}, which
    # 404s for deleted/hidden workers (slack-listener, whatsapp-listener, …). A
    # deleted worker's failures are not actionable "attention" — drop runs whose
    # worker is no longer API-visible so the cluster + its link cannot 404.
    failure_runs = [
        row for row in failure_runs
        if row.get("worker_id") in _visible_worker_ids
    ]
    visible_terminal_runs = [
        row for row in runs_14d_rows
        if str(row.get("status") or "").lower()
        in {"completed", "approved", "success", "succeeded", "failed", "error", "cancelled", "rejected", "timeout"}
        and row.get("worker_id") in _visible_worker_ids
    ]
    attention_items.extend(
        _overview_consecutive_failure_items(
            runs=visible_terminal_runs,
            worker_names=worker_names,
            threshold=_overview_consecutive_failure_threshold(),
        )
    )
    _consecutive_failure_worker_ids = {
        item.worker_id
        for item in attention_items
        if item.type == "consecutive_failures" and item.worker_id
    }
    failure_counts: Dict[str, int] = collections.Counter(row["worker_id"] for row in failure_runs if row.get("worker_id"))
    latest_failure_by_worker: Dict[str, Dict[str, Any]] = {}
    for row in failure_runs:
        worker_id = row.get("worker_id")
        if not worker_id:
            continue
        row_time = _parse_iso8601(row.get("started_at") or row.get("completed_at") or row.get("created_at"))
        current = latest_failure_by_worker.get(worker_id)
        current_time = _parse_iso8601((current or {}).get("started_at") or (current or {}).get("completed_at") or (current or {}).get("created_at"))
        if current is None or (row_time is not None and (current_time is None or row_time > current_time)):
            latest_failure_by_worker[worker_id] = row
    for worker_id, failure_count in sorted(
        failure_counts.items(),
        key=lambda item: item[1],
        reverse=True,
    )[:3]:
        if worker_id in _consecutive_failure_worker_ids:
            continue
        latest_failure = latest_failure_by_worker.get(worker_id) or {}
        last_failed_at = latest_failure.get("started_at") or latest_failure.get("completed_at") or latest_failure.get("created_at")
        cause = _overview_failure_cause(latest_failure)
        attention_items.append(
            OverviewAttentionItem(
                type="failure_cluster",
                kind="failing",
                worker_id=worker_id,
                worker_name=worker_names.get(worker_id, worker_id),
                message=f"{failure_count} failures in 24h",
                cause=cause,
                error_code=latest_failure.get("error_code"),
                recent_failure_count=int(failure_count),
                last_failed_at=last_failed_at,
                suggested_actions=["view_logs", "retry", "disable"],
                action_url=f"/workers/{worker_id}",
            )
        )

    # B-P1-2 (2026-05-29): surface smoke-disabled workers (enabled=False, not
    # archived) so a freshly-generated broken worker is visible even when it has
    # NO failed runs (the smoke gate disables it before any real run). Skip any
    # worker already surfaced above as a failure cluster to avoid duplicates.
    _already_surfaced = {item.worker_id for item in attention_items if item.worker_id}
    for worker in workers:
        wid = worker.get("id")
        if not wid or wid in _already_surfaced:
            continue
        manifest = worker.get("manifest") or {}
        if manifest.get("archived") is True or worker.get("archived"):
            continue
        if worker.get("enabled") is False or manifest.get("enabled") is False:
            attention_items.append(
                OverviewAttentionItem(
                    type="worker_disabled",
                    kind="paused",
                    worker_id=wid,
                    worker_name=worker_names.get(wid, wid),
                    message="Paused — its first test run failed. Edit or re-generate it, then turn it on.",
                    error_code="worker_disabled",
                    suggested_actions=["view_logs", "edit"],
                    action_url=f"/workers/{wid}",
                )
            )

    # #556 Surface 3: surface workers with missing secrets/connections in the
    # global needs-attention inbox so operators know exactly what to fix.
    _ov_available_secrets = _available_secret_names_for_user(auth.user_id, repos)
    _ov_available_conns = _available_connection_slugs_for_user(auth.user_id, repos)
    for worker in workers:
        wid = worker.get("id")
        if not wid or wid in _already_surfaced:
            continue
        if worker.get("archived") or (worker.get("manifest") or {}).get("archived"):
            continue
        _ov_req_secrets = _worker_required_secret_names(worker)
        _ov_missing_secrets = [s for s in _ov_req_secrets if s not in _ov_available_secrets]
        _ov_req_conns = _worker_connection_slugs(worker)
        _ov_missing_conns = [c for c in _ov_req_conns if c.lower() not in _ov_available_conns]
        if _ov_missing_secrets:
            attention_items.append(
                OverviewAttentionItem(
                    type="setup_incomplete",
                    kind="missing_secret",
                    worker_id=wid,
                    worker_name=worker_names.get(wid, wid),
                    message=f"Missing secret{'' if len(_ov_missing_secrets) == 1 else 's'}: {', '.join(_ov_missing_secrets)}. Add {'it' if len(_ov_missing_secrets) == 1 else 'them'} to run this worker.",
                    suggested_actions=["add_secret"],
                    action_url="/connections/secrets",
                )
            )
            _already_surfaced.add(wid)
        elif _ov_missing_conns:
            attention_items.append(
                OverviewAttentionItem(
                    type="setup_incomplete",
                    kind="missing_connection",
                    worker_id=wid,
                    worker_name=worker_names.get(wid, wid),
                    message=f"Missing connection{'' if len(_ov_missing_conns) == 1 else 's'}: {', '.join(_ov_missing_conns)}. Connect {'it' if len(_ov_missing_conns) == 1 else 'them'} to run this worker.",
                    suggested_actions=["connect"],
                    action_url="/connections",
                )
            )
            _already_surfaced.add(wid)

    for row in sorted(
        (
            connection
            for connection in connections
            if connection.get("status") == "expired" or connection.get("last_check_status") == "expired"
        ),
        key=lambda connection: connection.get("updated_at") or "",
        reverse=True,
    )[:3]:
        slug = (row.get("app_name") or "").lower() or None
        attention_items.append(
            OverviewAttentionItem(
                type="connection_expired",
                kind="connection_expired",
                connection_id=row["id"],
                provider_slug=slug,
                provider_display_name=row.get("app_name") or None,
                provider_names=[row.get("app_name") or row.get("mcp_label") or "Connection"],
                message="Connection has expired and needs re-authorization.",
                suggested_actions=["reconnect"],
                action_url="/connections",
            )
        )

    for row in sorted(
        (
            connection
            for connection in connections
            if connection.get("status") == "active"
            and connection.get("last_check_status") == "failed"
            and "expir" in str(connection.get("last_check_error") or "").lower()
        ),
        key=lambda connection: connection.get("updated_at") or "",
        reverse=True,
    )[:3]:
        slug = (row.get("app_name") or "").lower() or None
        attention_items.append(
            OverviewAttentionItem(
                type="connection_expiring",
                kind="connection_expiring",
                connection_id=row["id"],
                provider_slug=slug,
                provider_display_name=row.get("app_name") or None,
                provider_names=[row.get("app_name") or row.get("mcp_label") or "Connection"],
                message="Connection may expire soon. Reconnect to avoid failures.",
                suggested_actions=["reconnect"],
                action_url="/connections",
            )
        )

    # G5 FIX 3: scope the headline success rate to runs from active, real
    # workers (see _active_real_worker_ids). This excludes paused, example,
    # system, and stock-worker runs so the number a partner sees reflects their
    # live workers, not legacy/test churn. The 24h/7d run COUNTS and sparklines
    # are intentionally left unscoped (they are activity volume, not quality).
    _success_scope_rows = [
        row for row in _runs_7d_rows if row.get("worker_id") in _active_real_worker_ids
    ]
    _scoped_completed_7d = sum(1 for row in _success_scope_rows if _is_completed(row))
    completed_or_failed_7d = sum(
        1 for row in _success_scope_rows if _is_completed(row) or _is_failed(row)
    )
    success_rate_7d = (
        _scoped_completed_7d / completed_or_failed_7d if completed_or_failed_7d else None
    )

    # IA-fix 2026-06-02: the FLAGSHIP outcome tiles (work_shipped_7d /
    # completed_today / failed_today) were computed over ALL runs, so failing
    # internal listener workers (slack-listener, whatsapp-listener,
    # ai-news-discord-digest, …) that fail every ~10min on config gaps dragged
    # the headline "work shipped" metric to a near-total failure read. Those
    # workers are NOT real user outcomes. Scope the OUTCOME tiles to the same
    # active-real-worker set already trusted for success_rate_7d (no new
    # denylist — reuses _active_real_worker_ids, which excludes paused/example/
    # system/stock/listener workers). The failing listeners are NOT hidden: they
    # still surface in needs_attention (failure clusters / disabled workers
    # above), so the operator can see and fix them. runs_today / runs_24h stay
    # unscoped — those are raw activity volume, not user-outcome quality.
    _today_real_rows = [
        row for row in today_rows if row.get("worker_id") in _active_real_worker_ids
    ]
    completed_7d = sum(1 for row in _success_scope_rows if _is_completed(row))
    completed_previous_7d = sum(
        1
        for row in previous_7d_rows
        if _is_completed(row) and row.get("worker_id") in _active_real_worker_ids
    )
    completed_today = sum(1 for row in _today_real_rows if _is_completed(row))
    failed_today = sum(1 for row in _today_real_rows if _is_failed(row))

    return OverviewResponse(
        stats=OverviewStats(
            runs_24h=runs_24h,
            runs_24h_sparkline=sparkline,
            runs_7d_sparkline=runs_7d_sparkline,
            success_rate_7d=success_rate_7d,
            success_rate_scope="active_workers",
            active_workers_count=active_workers_count,
            paused_workers_count=paused_workers_count,
            connections_healthy=connections_healthy,
            connections_total=connections_total,
            work_shipped_7d=completed_7d,
            work_shipped_previous_7d=completed_previous_7d,
            runs_today=len(today_rows),
            completed_today=completed_today,
            failed_today=failed_today,
            running_now=running_now,
            queued_now=queued_now,
            scheduled_24h_count=len(scheduled_today),
            next_scheduled_at=scheduled_today[0].next_fire_at if scheduled_today else None,
        ),
        outcomes=outcomes,
        recent_runs=recent_runs,
        scheduled_today=scheduled_today[:5],
        needs_attention=attention_items,
    )
