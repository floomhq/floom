"""Floom API — FastAPI backend for the OS for Background Workers."""

import asyncio
import os
import json
import sqlite3
import logging
import mimetypes
import hashlib
import hmac
import base64
import io
import shutil
import fcntl
import re
import sys
import time
import collections
import threading
import tempfile
import secrets as pysecrets
import uuid as _uuid_mod
import zipfile
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, TypedDict

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from db import init_db, get_db, now_iso, DB_PATH
from files import blob_path, ensure_blob_dir, extension_for_file, is_sha256, normalize_media_type
from models import (
    RunCreate,
    WorkerSummary,
    WorkerDetail,
    WorkerFile,
    RunSummary,
    RunDetail,
    LogEntry,
    Artifact,
    OutputField,
    SecretItem,
    ReloadResponse,
    ActionResponse,
    RunStatus,
    SecretStatus,
    WorkerStatus,
    WorkerConfig,
    WorkerUpdateRequest,
    RecentStats,
    TriggerSpec,
    TimeseriesDay,
)
from worker_registry import (
    WORKERS_DIR,
    discover_workers,
    get_worker,
    invalidate_worker_cache,
)
from run_service import create_run, get_worker_config_for_run, start_run, add_log, update_run_status
from run_service import register_sse_publisher

load_dotenv()
api_env_path = Path("/root/.config/workeros/api.env")
if api_env_path.is_file():
    load_dotenv(api_env_path, override=False)
init_db()

# ---------------------------------------------------------------------------
# App & middleware
# ---------------------------------------------------------------------------


_sweep_task: Optional[asyncio.Task] = None
_SWEEP_INTERVAL_SECONDS = 3600  # Hourly


async def _hourly_sweep_loop() -> None:
    """Run the connection health sweep every hour in the background."""
    # Delay first run by 60s to let startup finish
    await asyncio.sleep(60)
    while True:
        try:
            await _run_connection_sweep()
        except Exception as exc:
            logger.warning("Connection sweep error: %s", exc)
        await asyncio.sleep(_SWEEP_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan: startup + shutdown hooks."""
    global _sweep_task
    # Wire up SSE publisher before starting workers (avoids circular import)
    register_sse_publisher(_sse_publish)
    # Startup
    reload_workers()
    from scheduler import start_scheduler
    start_scheduler()
    # Launch hourly connection health sweep
    _sweep_task = asyncio.create_task(_hourly_sweep_loop())
    yield
    # Shutdown
    from scheduler import stop_scheduler
    stop_scheduler()
    if _sweep_task:
        _sweep_task.cancel()
        try:
            await _sweep_task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="Floom API",
    version="0.1.0",
    description="The OS for Background Workers",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3011", "https://workers.floom.dev"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    """Add OWASP-recommended security headers to every response.

    Cloudflare adds some of these in front of us, but defense-in-depth.
    """
    response = await call_next(request)
    response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Permissions-Policy",
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    )
    # The API serves JSON only; tight CSP is safe.
    response.headers.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
    return response

# Simple in-memory token bucket rate limit per x-floom-secret hash.
# 200 req/min per caller. Reset every 60s. No persistence — per-process,
# resets on restart. Good enough for single-tenant launch.
import hashlib
_rate_lock = threading.Lock()
_rate_buckets: Dict[str, list] = {}
_RATE_LIMIT = int(os.environ.get("FLOOM_RATE_LIMIT_PER_MIN", "2000"))
_RATE_WINDOW = 60.0


def _rate_caller_key(request: Request) -> str:
    """Hash the secret header so logs never expose it. Fall back to IP for unauthed paths."""
    secret = request.headers.get("x-floom-secret") or ""
    if secret:
        return "s:" + hashlib.sha256(secret.encode()).hexdigest()[:16]
    return "ip:" + (request.client.host if request.client else "unknown")


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """200 req/min per caller. Exempt: webhooks (their own HMAC), healthz."""
    path = request.url.path
    if path.startswith("/webhooks/") or path in {"/healthz", "/health"}:
        return await call_next(request)
    now = time.time()
    key = _rate_caller_key(request)
    with _rate_lock:
        bucket = _rate_buckets.get(key, [])
        bucket = [t for t in bucket if t > now - _RATE_WINDOW]
        if len(bucket) >= _RATE_LIMIT:
            from fastapi.responses import JSONResponse as _RLJSONResponse
            return _RLJSONResponse(
                status_code=429,
                content={"detail": f"Rate limit exceeded: {_RATE_LIMIT} req/min"},
                headers={"Retry-After": "60"},
            )
        bucket.append(now)
        _rate_buckets[key] = bucket
    return await call_next(request)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Require x-floom-secret on ALL requests except exempt paths.

    Exempt paths (no internal secret needed):
      - /webhooks/*       — HMAC-authed by per-worker secret
      - /healthz          — liveness probe, no secret
      - /composio-events  — Composio webhook receiver
      - /connections/callback — OAuth browser redirect validates connection state
      - OPTIONS           — CORS preflight

    When FLOOM_SECRET is not set (localhost dev mode), all requests pass.
    Previously GET/HEAD were exempt; this was a security hole — MCP read
    tools were effectively unauthenticated.
    """
    secret = os.environ.get("FLOOM_SECRET", "")
    if secret and request.method != "OPTIONS":
        path = request.url.path
        if (
            path.startswith("/webhooks/")
            or path in {"/healthz", "/health"}
            or path == "/composio-events"
            or path == "/connections/callback"
            or path == "/cli-auth/devices"
            or path.startswith("/cli-auth/poll/")
        ):
            return await call_next(request)
        header = request.headers.get("x-floom-secret", "")
        if header != secret:
            from fastapi.responses import JSONResponse as _JSONResponse
            return _JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)

logger = logging.getLogger("floom.api")

# Process start time for /system/metrics uptime reporting.
_PROCESS_START_TIME = time.time()
_PROCESS_STARTED_AT = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_PROCESS_START_TIME))


# Architecture banner: visible in journalctl on every API boot so auditors
# and operators don't have to read the source to learn that workers run
# in E2B sandbox microVMs, never in this process. See ARCHITECTURE.md.
print(
    "[workeros] Execution: E2B sandbox microVMs only "
    "(no in-process worker execution). See ARCHITECTURE.md.",
    flush=True,
)


# ---------------------------------------------------------------------------
# SSE event queue registry
# ---------------------------------------------------------------------------
# Maps run_id → list of (queue, loop). Each connected SSE consumer gets one
# queue. Cross-thread asyncio.Queue.put_nowait is unsafe, so we capture the
# loop the queue was bound to and use call_soon_threadsafe from worker threads.
_sse_queues: Dict[str, List[tuple]] = {}
_sse_lock = threading.Lock()

_TERMINAL_STATUSES = frozenset({
    RunStatus.COMPLETED.value,
    RunStatus.FAILED.value,
})


def _sse_publish(run_id: str, event: Dict[str, Any]) -> None:
    """Publish an SSE event to all active consumers for a run.

    Called from run_service (worker threads) after each state change.
    asyncio.Queue is not thread-safe, so we route the put through each
    queue's bound loop via call_soon_threadsafe.
    """
    with _sse_lock:
        entries = list(_sse_queues.get(run_id, []))
    for q, loop in entries:
        def _put(q=q, event=event):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("SSE queue full for run %s, dropping event", run_id)
        try:
            loop.call_soon_threadsafe(_put)
        except RuntimeError:
            # Loop already closed (consumer disconnected, cleanup pending).
            pass


def _sse_cleanup(run_id: str, q: asyncio.Queue) -> None:
    """Remove a specific consumer queue from the registry."""
    with _sse_lock:
        entries = _sse_queues.get(run_id)
        if entries:
            _sse_queues[run_id] = [(eq, el) for (eq, el) in entries if eq is not q]
            if not _sse_queues[run_id]:
                _sse_queues.pop(run_id, None)


# ---------------------------------------------------------------------------
# /healthz
# ---------------------------------------------------------------------------

@app.get("/healthz")
@app.get("/health")
def healthz():
    """Liveness probe — exempt from x-floom-secret. Aliased at /health for common LB conventions."""
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.exception_handler(ValueError)
async def value_error_handler(_request, exc: ValueError):
    logger.warning("Validation error: %s", exc)
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(Exception)
async def generic_error_handler(_request, exc: Exception):
    logger.exception("Unhandled exception")
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def _parse_iso8601(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _normalize_run_status(status_value: str) -> str:
    value = (status_value or "").lower()
    if value in {"completed", "approved", "success"}:
        return "success"
    if value in {"running", "queued", "pending_approval"}:
        return "running"
    return "error"


def _resolve_run_status_filters(raw_status: Optional[str]) -> List[str]:
    if not raw_status:
        return []
    mapping = {
        "success": ["completed"],
        "error": ["failed"],
        "running": ["running", "queued"],
        "cancelled": ["cancelled"],
        "completed": ["completed"],
        "failed": ["failed"],
        "queued": ["queued"],
    }
    statuses: List[str] = []
    for token in raw_status.split(","):
        key = token.strip().lower()
        if not key:
            continue
        resolved = mapping.get(key)
        if resolved is None:
            raise HTTPException(status_code=400, detail=f"Invalid status filter: {token.strip()}")
        for item in resolved:
            if item not in statuses:
                statuses.append(item)
    return statuses


def _sanitize_download_name(name: str) -> str:
    sanitized = (
        (name or "file")
        .replace("\\", "_")
        .replace("/", "_")
        .replace('"', "_")
        .replace("\r", "_")
        .replace("\n", "_")
    )
    return sanitized or "file"


def _extract_primary_output_file(output_payload: Dict[str, Any]) -> Optional[tuple[str, bytes]]:
    def _decode_data_uri(value: str) -> Optional[tuple[bytes, Optional[str]]]:
        if not value.startswith("data:") or ";base64," not in value:
            return None
        header, _, encoded = value.partition(",")
        if not encoded:
            return None
        media_type = "application/octet-stream"
        if ":" in header:
            media_type = header.split(":", 1)[1].split(";", 1)[0] or media_type
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except Exception:
            return None
        guessed = mimetypes.guess_extension(media_type) or ".bin"
        return decoded, guessed

    def _decode_entry(entry: Any) -> Optional[tuple[str, bytes]]:
        if isinstance(entry, str):
            maybe_uri = _decode_data_uri(entry)
            if maybe_uri:
                payload, ext = maybe_uri
                return (f"output{ext or '.bin'}", payload)
            return None
        if not isinstance(entry, dict):
            return None
        b64_value = None
        for key in ("content_base64", "data_base64", "base64", "data"):
            value = entry.get(key)
            if isinstance(value, str) and value:
                b64_value = value
                break
        if not b64_value:
            return None
        maybe_uri = _decode_data_uri(b64_value)
        if maybe_uri:
            payload, ext = maybe_uri
            filename = entry.get("filename") if isinstance(entry.get("filename"), str) else None
            if filename:
                ext = Path(filename).suffix or ext
            return (f"output{ext or '.bin'}", payload)
        try:
            payload = base64.b64decode(b64_value, validate=True)
        except Exception:
            return None
        filename = entry.get("filename") if isinstance(entry.get("filename"), str) else ""
        if filename:
            ext = Path(filename).suffix or ".bin"
        else:
            content_type = (
                entry.get("content_type")
                if isinstance(entry.get("content_type"), str)
                else entry.get("mime_type")
                if isinstance(entry.get("mime_type"), str)
                else ""
            )
            ext = mimetypes.guess_extension(content_type) if content_type else None
            ext = ext or ".bin"
        return (f"output{ext}", payload)

    for key in ("primary_output", "output_artifact", "artifact", "file"):
        if key in output_payload:
            decoded = _decode_entry(output_payload.get(key))
            if decoded:
                return decoded
    for value in output_payload.values():
        decoded = _decode_entry(value)
        if decoded:
            return decoded
    return None


def _get_last_run_for_worker(worker_id: str) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, worker_id, 'manual' as trigger_source, status,
                   created_at, started_at, completed_at, duration_ms
            FROM runs WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1
            """,
            (worker_id,),
        )
        row = cursor.fetchone()
    return row_to_dict(row) if row else None


def _make_run_summary(row: sqlite3.Row) -> RunSummary:
    d = row_to_dict(row)
    status_value = str(d.get("status") or "").lower()
    status_aliases = {
        "approved": RunStatus.COMPLETED.value,
        "success": RunStatus.COMPLETED.value,
        "rejected": RunStatus.FAILED.value,
        "error": RunStatus.FAILED.value,
        "cancelled": RunStatus.FAILED.value,
        "pending_approval": RunStatus.RUNNING.value,
    }
    normalized_status = status_aliases.get(status_value, status_value or RunStatus.FAILED.value)
    return RunSummary(
        id=d["id"],
        worker_id=d["worker_id"],
        worker_name=d.get("worker_name"),
        status=RunStatus(normalized_status),
        trigger_source=d["trigger_source"],
        created_at=d.get("created_at"),
        started_at=d.get("started_at"),
        completed_at=d.get("completed_at"),
        duration_ms=d.get("duration_ms"),
        error=d.get("error"),
    )


def _get_stats_batch(worker_ids: List[str]) -> Dict[str, RecentStats]:
    """Batch-query 7-day run stats for a list of worker IDs in one SQL call."""
    if not worker_ids:
        return {}
    placeholders = ",".join("?" for _ in worker_ids)
    try:
        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    worker_id,
                    MAX(created_at) AS last_run_at,
                    COUNT(*) AS runs_7d,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS success_rate_7d
                FROM runs
                WHERE created_at > datetime('now', '-7 days')
                  AND worker_id IN ({placeholders})
                GROUP BY worker_id
                """,
                worker_ids,
            ).fetchall()
    except sqlite3.OperationalError:
        return {}
    result: Dict[str, RecentStats] = {}
    for row in rows:
        d = row_to_dict(row)
        wid = d["worker_id"]
        runs_7d = int(d["runs_7d"] or 0)
        rate = float(d["success_rate_7d"]) if d["success_rate_7d"] is not None and runs_7d > 0 else None
        result[wid] = RecentStats(
            last_run_at=d.get("last_run_at"),
            runs_7d=runs_7d,
            success_rate_7d=rate,
        )
    return result


def _get_timeseries_batch(worker_ids: List[str], days: int = 14) -> Dict[str, List[TimeseriesDay]]:
    """Batch-query per-day run counts for sparkline charts (last N days).

    Returns a dict mapping worker_id -> list of N TimeseriesDay objects,
    oldest first, zero-filled for days with no runs.
    """
    if not worker_ids:
        return {}
    import datetime as _dt
    today = _dt.date.today()
    date_range = [(today - _dt.timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]

    placeholders = ",".join("?" for _ in worker_ids)
    try:
        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    worker_id,
                    DATE(created_at) AS run_date,
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
                FROM runs
                WHERE created_at > datetime('now', '-{days} days')
                  AND worker_id IN ({placeholders})
                GROUP BY worker_id, DATE(created_at)
                """,
                worker_ids,
            ).fetchall()
    except sqlite3.OperationalError:
        return {}

    # Index raw DB rows by (worker_id, date)
    raw: Dict[tuple, Dict[str, Any]] = {}
    for row in rows:
        d = row_to_dict(row)
        raw[(d["worker_id"], d["run_date"])] = d

    result: Dict[str, List[TimeseriesDay]] = {}
    for wid in worker_ids:
        days_list: List[TimeseriesDay] = []
        for date_str in date_range:
            key = (wid, date_str)
            if key in raw:
                r = raw[key]
                days_list.append(TimeseriesDay(
                    date=date_str,
                    total=int(r.get("total") or 0),
                    completed=int(r.get("completed") or 0),
                    failed=int(r.get("failed") or 0),
                ))
            else:
                days_list.append(TimeseriesDay(date=date_str, total=0, completed=0, failed=0))
        result[wid] = days_list
    return result


@app.get("/workers/{worker_id}/runs/timeseries", response_model=List[TimeseriesDay])
def get_worker_timeseries(
    worker_id: str,
    days: int = Query(default=14, ge=1, le=90),
) -> List[TimeseriesDay]:
    """Return per-day run counts for the last N days (default 14). Zero-filled."""
    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    batch = _get_timeseries_batch([worker_id], days=days)
    return batch.get(worker_id, [])


def _trigger_label(trigger: Dict[str, Any]) -> str:
    """Return a human-readable label for one trigger dict."""
    t_type = (trigger.get("type") or "manual").lower()
    if t_type == "manual":
        return "Manual"
    if t_type in ("schedule", "scheduled"):
        cron_expr = trigger.get("cron")
        if cron_expr:
            return f"Cron · {cron_expr}"
        every = trigger.get("every")
        at_time = trigger.get("at")
        if every and at_time:
            return f"Every {every} at {at_time}"
        if every:
            return f"Every {every}"
        return "Scheduled"
    if t_type == "webhook":
        return "Webhook"
    if t_type == "composio":
        composio = trigger.get("composio")
        if composio and isinstance(composio, dict):
            event = composio.get("event") or ""
            conn_id = composio.get("connection_id") or ""
            app_hint = conn_id.split("_")[0].split("-")[0] if conn_id else "integration"
            if event:
                return f"On {app_hint} · {event}"
            return f"On {app_hint}"
        return "On integration"
    return t_type.title()


def _build_triggers_spec(worker: Dict[str, Any]) -> List[TriggerSpec]:
    """Build a structured list of TriggerSpec from a worker dict.

    Prefers triggers_json (multi-trigger DB column) when present.
    Falls back to config.trigger for single-trigger / legacy workers.
    Legacy workers without triggers_json are wrapped as a one-element list.
    """
    triggers_json = worker.get("triggers_json")
    if triggers_json:
        try:
            raw = json.loads(triggers_json)
            if isinstance(raw, list) and raw:
                specs = []
                for t in raw:
                    if not isinstance(t, dict):
                        continue
                    specs.append(TriggerSpec(
                        type=t.get("type", "manual"),
                        cron=t.get("cron"),
                        timezone=t.get("timezone"),
                        webhook=t.get("webhook"),
                        composio=t.get("composio"),
                    ))
                if specs:
                    return specs
        except Exception:
            pass

    # Fall back to single trigger from config
    config: Dict[str, Any] = worker.get("config") or {}
    trigger: Dict[str, Any] = config.get("trigger") or {}
    trigger_type = (worker.get("trigger_type") or trigger.get("type") or "manual").lower()
    return [TriggerSpec(
        type=trigger_type,
        cron=trigger.get("cron"),
        timezone=trigger.get("timezone"),
        webhook=trigger.get("webhook"),
        composio=trigger.get("composio"),
    )]


def _build_triggers_list(worker: Dict[str, Any]) -> List[str]:
    """Extract all configured trigger labels from a worker dict.

    Prefers triggers_json (multi-trigger) if present; falls back to single trigger.
    Returns labels like ['Manual', 'Cron · 0 9 * * *', 'Webhook', 'On gmail · new_email'].
    """
    # Try multi-trigger first (from DB triggers_json column)
    triggers_json = worker.get("triggers_json")
    if triggers_json:
        try:
            triggers_list = json.loads(triggers_json)
            if isinstance(triggers_list, list) and triggers_list:
                return [_trigger_label(t) for t in triggers_list if isinstance(t, dict)]
        except Exception:
            pass

    # Fall back to single-trigger logic from config
    config: Dict[str, Any] = worker.get("config") or {}
    trigger: Dict[str, Any] = config.get("trigger") or {}
    trigger_type = (worker.get("trigger_type") or trigger.get("type") or "manual").lower()
    trigger_with_type = dict(trigger)
    trigger_with_type.setdefault("type", trigger_type)
    label = _trigger_label(trigger_with_type)
    return [label] if label else [trigger_type.title()]


def _read_transcript_rows(run_runner: str, artifacts: List[Artifact]) -> List[Dict[str, Any]]:
    if not (run_runner or "").startswith("skill"):
        return []
    transcript = next((artifact for artifact in artifacts if artifact.name == "transcript.jsonl"), None)
    if not transcript:
        return []

    from runner_utils import ARTIFACTS_DIR

    try:
        artifacts_dir = ARTIFACTS_DIR.resolve()
        path = Path(transcript.path).resolve()
        path.relative_to(artifacts_dir)
    except Exception:
        return []
    if not path.is_file() or path.stat().st_size > 2_000_000:
        return []

    rows: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            parsed = {"type": "parse_error", "content": line}
        if isinstance(parsed, dict):
            rows.append(parsed)
    return rows


def _skill_version_id(worker_id: str, manifest: Dict[str, Any]) -> str:
    version = str(manifest.get("version") or "0.1.0")
    safe_version = version.replace(".", "_").replace("-", "_")
    return f"sv_{worker_id}_{safe_version}"


def _composio_webhook_url() -> str:
    base = (
        os.environ.get("COMPOSIO_WEBHOOK_URL")
        or os.environ.get("WORKERS_API_URL")
        or os.environ.get("FLOOM_API_BASE")
        or "https://workers-api.floom.dev"
    )
    base = base.rstrip("/")
    if base.endswith("/composio-events"):
        return base
    return f"{base}/composio-events"


def _composio_trigger_signature(config: Optional[WorkerConfig]) -> Optional[Dict[str, Any]]:
    if not config or config.trigger.type != "composio" or not config.trigger.composio:
        return None
    composio = config.trigger.composio
    return {
        "event": composio.event,
        "connection_id": composio.connection_id,
        "filters": composio.filters or {},
    }


def _config_from_manifest_for_worker(raw: Dict[str, Any], worker_id: str) -> Optional[WorkerConfig]:
    try:
        from models import WorkerContract, parse_worker_manifest, worker_contract_to_worker_config
        parsed = parse_worker_manifest(raw)
        if isinstance(parsed, WorkerContract):
            return worker_contract_to_worker_config(parsed, worker_id)
        return parsed
    except Exception:
        logger.exception("Failed to parse worker manifest for composio lifecycle: %s", worker_id)
        return None


def _existing_composio_state(conn: sqlite3.Connection, worker_id: str) -> Dict[str, Any]:
    try:
        row = conn.execute(
            """
            SELECT w.composio_trigger_id, w.composio_event, sv.manifest_json
            FROM workers w
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE w.id = ?
            """,
            (worker_id,),
        ).fetchone()
    except sqlite3.OperationalError:
        return {}
    if not row:
        return {}
    manifest = json.loads(row["manifest_json"] or "{}")
    old_config = _config_from_manifest_for_worker(manifest, worker_id) if isinstance(manifest, dict) else None
    return {
        "trigger_id": row["composio_trigger_id"],
        "event": row["composio_event"],
        "signature": _composio_trigger_signature(old_config),
    }


def _disable_composio_trigger(event: Optional[str], trigger_id: Optional[str], worker_id: str) -> None:
    if not event:
        return
    try:
        from composio_client import disable_trigger
        disable_trigger(event, trigger_id)
    except Exception as exc:
        logger.exception("Failed to disable Composio trigger for worker %s", worker_id)
        raise RuntimeError(f"Composio disable failed for worker {worker_id}: {exc}") from exc


def _enable_composio_trigger(config: WorkerConfig, worker_id: str) -> str:
    signature = _composio_trigger_signature(config)
    if not signature:
        raise RuntimeError(f"Worker {worker_id} does not declare trigger.composio")
    try:
        from composio_client import enable_trigger
        return enable_trigger(
            signature["event"],
            signature["connection_id"],
            _composio_webhook_url(),
            signature["filters"],
        )
    except Exception as exc:
        logger.exception("Failed to enable Composio trigger for worker %s", worker_id)
        raise RuntimeError(f"Composio enable failed for worker {worker_id}: {exc}") from exc


def _sync_composio_registration(
    conn: sqlite3.Connection,
    worker_id: str,
    config: Optional[WorkerConfig],
    existing: Optional[Dict[str, Any]] = None,
) -> tuple[Optional[str], Optional[str]]:
    existing = existing or _existing_composio_state(conn, worker_id)
    new_signature = _composio_trigger_signature(config)
    old_signature = existing.get("signature")
    old_trigger_id = existing.get("trigger_id")
    old_event = existing.get("event") or (old_signature or {}).get("event")

    if not new_signature:
        if old_trigger_id:
            _disable_composio_trigger(old_event, old_trigger_id, worker_id)
        return None, None

    if old_trigger_id and old_signature == new_signature:
        return old_trigger_id, new_signature["event"]

    enabled_id = _enable_composio_trigger(config, worker_id)
    if old_trigger_id:
        try:
            _disable_composio_trigger(old_event, old_trigger_id, worker_id)
        except RuntimeError:
            try:
                _disable_composio_trigger(new_signature["event"], enabled_id, worker_id)
            except RuntimeError:
                logger.exception(
                    "Failed to roll back newly enabled Composio trigger for worker %s",
                    worker_id,
                )
            raise
    return enabled_id, new_signature["event"]


def _extract_triggers_from_manifest(manifest: Dict[str, Any], config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract the canonical list of trigger dicts from a manifest or config.

    Checks manifest.triggers first (new format), then manifest.trigger,
    then config.trigger as fallback.
    """
    # New format: manifest.triggers list
    raw_triggers = manifest.get("triggers")
    if isinstance(raw_triggers, list) and raw_triggers:
        return [t for t in raw_triggers if isinstance(t, dict)]
    # Old format: manifest.trigger single object
    manifest_trigger = manifest.get("trigger")
    if isinstance(manifest_trigger, dict) and manifest_trigger:
        return [manifest_trigger]
    # Fallback: config.trigger
    config_trigger = config.get("trigger")
    if isinstance(config_trigger, dict) and config_trigger:
        return [config_trigger]
    return [{"type": "manual"}]


def _persist_discovered_workers(conn: sqlite3.Connection, workers: List[Dict[str, Any]]) -> None:
    now = now_iso()
    for w in workers:
        manifest = w.get("manifest") or {}
        config = w.get("config") or {}
        trigger = config.get("trigger") or {}
        worker_id = w["id"]
        skill_version_id = _skill_version_id(worker_id, manifest)
        config_model = _config_from_manifest_for_worker(manifest, worker_id)
        if config_model is None and config:
            try:
                config_model = WorkerConfig(**config)
            except Exception:
                logger.exception("Failed to parse worker config for composio lifecycle: %s", worker_id)
        existing_composio = _existing_composio_state(conn, worker_id)
        composio_trigger_id, composio_event = _sync_composio_registration(
            conn,
            worker_id,
            config_model,
            existing_composio,
        )
        # Build triggers list for multi-trigger storage
        triggers_list = _extract_triggers_from_manifest(manifest, config)
        triggers_json_str = json.dumps(triggers_list)
        # Primary trigger type is the first trigger's type
        primary_trigger_type = triggers_list[0].get("type") if triggers_list else "manual"

        conn.execute(
            """
            INSERT INTO skill_versions
                (id, name, version, manifest_json, bundle_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(name, version) DO UPDATE SET
                manifest_json=excluded.manifest_json,
                bundle_path=excluded.bundle_path
            """,
            (
                skill_version_id,
                manifest.get("name") or worker_id.replace("_", "-"),
                manifest.get("version") or "0.1.0",
                json.dumps(manifest),
                str((WORKERS_DIR / worker_id).resolve()),
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO workers
                (id, skill_version_id, name, trigger_type, cron_expr, cron_timezone,
                 next_run_at, last_scheduled_run_at, webhook_secret_hash, notify_email,
                 notify_webhook_url, grants_json, input_values_json, enabled, created_at, owner_id,
                 composio_trigger_id, composio_event, triggers_json)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?, 1, ?, 'federico', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                skill_version_id=excluded.skill_version_id,
                name=excluded.name,
                trigger_type=excluded.trigger_type,
                cron_expr=excluded.cron_expr,
                cron_timezone=excluded.cron_timezone,
                composio_trigger_id=excluded.composio_trigger_id,
                composio_event=excluded.composio_event,
                triggers_json=excluded.triggers_json
            """,
            (
                worker_id,
                skill_version_id,
                w["name"],
                primary_trigger_type or trigger.get("type") or w.get("trigger_type") or "manual",
                trigger.get("cron"),
                trigger.get("timezone"),
                json.dumps({}),
                json.dumps({}),
                now,
                composio_trigger_id,
                composio_event,
                triggers_json_str,
            ),
        )


def _db_worker_from_row(row: sqlite3.Row) -> Dict[str, Any]:
    d = row_to_dict(row)
    config = get_worker_config_for_run(d["id"])
    manifest = json.loads(d.get("manifest_json") or "{}")
    manifest_dict = manifest if isinstance(manifest, dict) else {}
    return {
        "id": d["id"],
        "name": d["name"],
        "description": manifest_dict.get("description"),
        "long_description": manifest_dict.get("long_description"),
        "use_cases": manifest_dict.get("use_cases"),
        "example_input": manifest_dict.get("example_input"),
        "example_output": manifest_dict.get("example_output"),
        "how_it_works": manifest_dict.get("how_it_works"),
        "tags": manifest_dict.get("tags") or [],
        "folder": manifest_dict.get("folder"),
        "status": "healthy",
        "trigger_type": d.get("trigger_type") or (config.trigger.type if config else "manual"),
        "runner": config.runtime.runner if config and config.runtime else "local",
        "config": config.model_dump(mode="json") if config else {},
        "manifest": manifest_dict,
        "triggers_json": d.get("triggers_json"),
    }


def _list_db_workers() -> List[Dict[str, Any]]:
    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT w.id, w.name, w.trigger_type, w.triggers_json, sv.manifest_json
                FROM workers w
                JOIN skill_versions sv ON sv.id = w.skill_version_id
                ORDER BY w.created_at, w.id
                """
            ).fetchall()
        return [_db_worker_from_row(row) for row in rows]
    except sqlite3.OperationalError:
        return []


def _get_db_worker(worker_id: str) -> Optional[Dict[str, Any]]:
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT w.id, w.name, w.trigger_type, w.triggers_json, sv.manifest_json
                FROM workers w
                JOIN skill_versions sv ON sv.id = w.skill_version_id
                WHERE w.id = ?
                """,
                (worker_id,),
            ).fetchone()
        return _db_worker_from_row(row) if row else None
    except sqlite3.OperationalError:
        return None


# ---------------------------------------------------------------------------
# Workers
# ---------------------------------------------------------------------------


def _parse_accepts(value: Optional[str]) -> set[str]:
    if not value:
        return set()
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return {normalize_media_type(str(item)) for item in parsed if str(item).strip()}
    except json.JSONDecodeError:
        pass
    return {normalize_media_type(part) for part in value.split(",") if part.strip()}


_WORKER_FILE_IGNORE = frozenset({
    "__pycache__",
    ".DS_Store",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "node_modules",
    ".eggs",
    "dist",
    "build",
    "*.pyc",
})


def _should_ignore_worker_file(rel_path: str) -> bool:
    """Return True if the file should be omitted from the worker's file listing."""
    parts = Path(rel_path).parts
    for part in parts:
        if part in _WORKER_FILE_IGNORE:
            return True
        if part.endswith(".pyc"):
            return True
    return False


def _language_for_path(rel_path: str) -> str:
    """Map a file path to a language identifier for syntax highlighting."""
    ext = Path(rel_path).suffix.lower()
    return {
        ".md": "markdown",
        ".py": "python",
        ".yml": "yaml",
        ".yaml": "yaml",
        ".json": "json",
        ".txt": "text",
        ".sh": "bash",
        ".toml": "toml",
        ".js": "javascript",
        ".ts": "typescript",
        ".html": "html",
        ".css": "css",
    }.get(ext, "text")


def _read_worker_files(worker_dir: Path) -> List[WorkerFile]:
    """Read all non-ignored files from a worker directory recursively.

    Priority order for display: worker.yml first, SKILL.md second, run.py third,
    then all remaining files alphabetically.
    """
    if not worker_dir.is_dir():
        return []

    raw_files: List[WorkerFile] = []
    for file_path in sorted(worker_dir.rglob("*")):
        if not file_path.is_file():
            continue
        try:
            rel = file_path.relative_to(worker_dir).as_posix()
        except ValueError:
            continue
        if _should_ignore_worker_file(rel):
            continue
        size = file_path.stat().st_size
        language = _language_for_path(rel)
        # Attempt UTF-8 read; mark binary if it fails
        try:
            content = file_path.read_text(encoding="utf-8")
            raw_files.append(WorkerFile(path=rel, language=language, content=content, binary=False, size=size))
        except (UnicodeDecodeError, OSError):
            raw_files.append(WorkerFile(path=rel, language="text", content=None, binary=True, size=size))

    # Sort: worker.yml first, SKILL.md second, run.py third, then alphabetic
    def _sort_key(f: WorkerFile) -> tuple:
        order = {"worker.yml": 0, "SKILL.md": 1, "run.py": 2}
        return (order.get(f.path, 3), f.path)

    raw_files.sort(key=_sort_key)
    return raw_files


def _worker_bundle_dir(worker_id: str, config: WorkerConfig) -> Path:
    bundle_path = config.runtime.bundle_path if config and config.runtime else None
    if bundle_path:
        raw_path = Path(bundle_path)
        target = raw_path if raw_path.is_absolute() else WORKERS_DIR.parent.joinpath(raw_path)
    else:
        target = WORKERS_DIR / worker_id
    resolved = target.resolve()
    allowed_root = WORKERS_DIR.parent.resolve()
    try:
        resolved.relative_to(allowed_root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid worker bundle path")
    return resolved


_ARTIFACTS_DIR = Path(os.environ.get("FLOOM_ARTIFACTS_DIR", "../../data/artifacts")).resolve()


def _increment_file_ref_counts(file_ids: List[str]) -> None:
    """Increment file ref_counts in one short transaction tolerant of run bursts."""
    if not file_ids:
        return
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    counts = collections.Counter(file_ids)
    conn = sqlite3.connect(DB_PATH, timeout=30, detect_types=sqlite3.PARSE_DECLTYPES)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        for file_id, count in counts.items():
            conn.execute(
                "UPDATE files SET ref_count = ref_count + ? WHERE id = ?",
                (count, file_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _resolve_file_input_references(
    worker_id: str, run_id: str, inputs: Dict[str, Any], bound_by: str = "anonymous"
) -> Dict[str, Any]:
    """Stage blob files into a per-run inputs directory.

    Files are copied from the content-addressed blob store into
    ``<artifacts>/<run_id>/inputs/<name><ext>`` so that concurrent runs for
    the same worker never share or overwrite each other's input files.
    Optional inputs omitted by this run produce no file in the run directory.

    The resolved value stored in *inputs* is the **absolute path** to the
    staged file so that the local runner can read it without relying on the
    process-global cwd.
    """
    config = get_worker_config_for_run(worker_id)
    if not config:
        return dict(inputs)

    resolved_inputs = dict(inputs)
    file_inputs = [inp for inp in config.inputs if inp.type == "file"]
    if not file_inputs:
        return resolved_inputs

    # Per-run staging dir — isolated from bundle and from other concurrent runs.
    artifacts_dir = Path(os.environ.get("FLOOM_ARTIFACTS_DIR", str(_ARTIFACTS_DIR))).resolve()
    run_inputs_dir = artifacts_dir / run_id / "inputs"
    run_inputs_dir.mkdir(parents=True, exist_ok=True)
    bound_file_ids: List[str] = []

    with get_db() as conn:
        for inp in file_inputs:
            value = resolved_inputs.get(inp.name)
            if value in (None, ""):
                # Optional file omitted for this run — leave it absent in the
                # per-run dir so stale files from earlier runs are never visible.
                continue
            if not is_sha256(value):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"File input '{inp.name}': value must be a SHA-256 reference "
                        f"from /uploads, got non-SHA value"
                    ),
                )
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", inp.name):
                raise HTTPException(status_code=400, detail=f"Invalid file input name: {inp.name}")

            row = conn.execute(
                "SELECT id, filename, media_type, size_bytes, uploaded_by FROM files WHERE id = ?",
                (value,),
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Uploaded file not found: {inp.name}")

            source = blob_path(row["id"])
            if not source.is_file():
                raise HTTPException(status_code=400, detail=f"Uploaded file blob missing: {inp.name}")

            # Fix 4: Bind-time revalidation — reject if blob violates this input's constraints.
            if inp.accepts:
                accepted = set(inp.accepts)
                if row["media_type"] not in accepted:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"File input '{inp.name}': stored media_type {row['media_type']!r} "
                            f"is not in accepts {sorted(accepted)}"
                        ),
                    )
            if inp.max_size_mb is not None:
                max_bytes = int(inp.max_size_mb * 1024 * 1024)
                if row["size_bytes"] > max_bytes:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"File input '{inp.name}': stored size {row['size_bytes']} bytes "
                            f"exceeds max_size_mb={inp.max_size_mb}"
                        ),
                    )

            # Fix 5: File ownership audit — log cross-user bindings (non-blocking per T1c).
            file_owner = row["uploaded_by"] or "anonymous"
            if file_owner != bound_by:
                logger.info(
                    "file_binding_audit: run=%s worker=%s input=%s sha=%s "
                    "uploaded_by=%r bound_by=%r",
                    run_id,
                    worker_id,
                    inp.name,
                    row["id"],
                    file_owner,
                    bound_by,
                )
                with get_db() as audit_conn:
                    audit_conn.execute(
                        """
                        INSERT INTO file_binding_audit
                            (run_id, worker_id, input_name, file_id, uploaded_by, bound_by, bound_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (run_id, worker_id, inp.name, row["id"], file_owner, bound_by, now_iso()),
                    )

            ext = extension_for_file(row["filename"], row["media_type"])
            mounted = run_inputs_dir / f"{inp.name}{ext}"
            shutil.copyfile(source, mounted)
            # Store absolute path so runners don't need cwd tricks to locate the file.
            resolved_inputs[inp.name] = str(mounted)
            bound_file_ids.append(row["id"])

    _increment_file_ref_counts(bound_file_ids)

    return resolved_inputs


_DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024  # 25 MB hard ceiling


@app.post("/uploads")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    max_size_mb: Optional[float] = Form(None),
    accepts: Optional[str] = Form(None),
) -> Dict[str, Any]:
    if max_size_mb is not None and max_size_mb <= 0:
        raise HTTPException(status_code=400, detail="max_size_mb must be greater than 0")

    # P1-3: reject path-traversal-shaped filenames at the request boundary.
    # The blob is stored by SHA so a malicious filename never reaches the FS, but
    # we surface a 400 instead of silently sanitizing — the caller should know.
    raw_filename = file.filename or ""
    if raw_filename and (
        "/" in raw_filename
        or "\\" in raw_filename
        or raw_filename.startswith(".")
        or ".." in raw_filename.split("/")
    ):
        raise HTTPException(
            status_code=400,
            detail="filename must not contain path separators, leading dots, or '..' segments",
        )

    media_type = normalize_media_type(
        file.content_type or mimetypes.guess_type(file.filename or "")[0]
    )
    accepted = _parse_accepts(accepts)
    if accepted and media_type not in accepted:
        raise HTTPException(
            status_code=400,
            detail=f"Upload media type {media_type!r} is not accepted",
        )

    # Fix 3: enforce a hard ceiling even when the client omits max_size_mb.
    # Stream to a temp file (not memory) and hash on the fly so large uploads
    # never fully buffer in process RAM before the 413 is raised.
    if max_size_mb is not None:
        max_bytes = min(int(max_size_mb * 1024 * 1024), _DEFAULT_UPLOAD_MAX_BYTES)
    else:
        max_bytes = _DEFAULT_UPLOAD_MAX_BYTES

    hasher = hashlib.sha256()
    size = 0
    # Stream directly to a temp file to avoid memory buffering.
    # Use BLOBS_DIR from files.py (already env-resolved) so the temp file is on
    # the same filesystem as the final target, making os.replace atomic.
    from files import BLOBS_DIR as _BLOBS_DIR
    _BLOBS_DIR.mkdir(parents=True, exist_ok=True)
    tmp_upload = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=_BLOBS_DIR,
            prefix=".upload.",
            suffix=".tmp",
            delete=False,
        ) as tmp_out:
            tmp_upload = Path(tmp_out.name)
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    tmp_out.flush()
                    limit_mb = max_size_mb if max_size_mb is not None else (_DEFAULT_UPLOAD_MAX_BYTES // (1024 * 1024))
                    raise HTTPException(
                        status_code=413,
                        detail=f"Uploaded file exceeds {limit_mb:g} MB",
                    )
                hasher.update(chunk)
                tmp_out.write(chunk)
    except HTTPException:
        if tmp_upload is not None:
            tmp_upload.unlink(missing_ok=True)
        raise

    sha256 = hasher.hexdigest()
    target = ensure_blob_dir(sha256)
    if not target.exists():
        final_tmp = target.parent / f".{sha256}.tmp.{os.getpid()}.{threading.get_ident()}"
        try:
            os.replace(tmp_upload, final_tmp)
            os.replace(final_tmp, target)
        finally:
            final_tmp.unlink(missing_ok=True)
            tmp_upload.unlink(missing_ok=True)
    else:
        # Blob already exists — dedup; remove the temp file.
        tmp_upload.unlink(missing_ok=True)

    uploaded_by = request.headers.get("x-floom-user") or "anonymous"
    uploaded_at = now_iso()
    filename = file.filename or sha256
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO files
                (id, filename, media_type, size_bytes, uploaded_by, uploaded_at, ref_count)
            VALUES (?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(id) DO UPDATE SET
                filename=files.filename,
                media_type=files.media_type,
                size_bytes=files.size_bytes,
                uploaded_by=files.uploaded_by,
                uploaded_at=files.uploaded_at,
                ref_count=files.ref_count
            """,
            (sha256, filename, media_type, size, uploaded_by, uploaded_at),
        )

    return {"id": sha256, "sha256": sha256, "size": size, "media_type": media_type}


@app.get("/workers", response_model=List[WorkerSummary])
def list_workers() -> List[WorkerSummary]:
    workers = _list_db_workers() or discover_workers(use_cache=True)
    worker_ids = [w["id"] for w in workers]
    stats_by_id = _get_stats_batch(worker_ids)
    timeseries_by_id = _get_timeseries_batch(worker_ids, days=14)
    result: List[WorkerSummary] = []
    for w in workers:
        last_run_row = _get_last_run_for_worker(w["id"])
        last_run = _make_run_summary(last_run_row) if last_run_row else None

        # Check secrets
        config = get_worker_config_for_run(w["id"])
        status = WorkerStatus(w["status"])
        if config and config.secrets:
            missing = [s for s in config.secrets if s not in os.environ]
            if missing:
                status = WorkerStatus.MISSING_SECRET
        if (
            status == WorkerStatus.HEALTHY
            and last_run
            and last_run.status == RunStatus.FAILED
        ):
            status = WorkerStatus.NEEDS_ATTENTION

        triggers = _build_triggers_list(w)
        triggers_spec = _build_triggers_spec(w)
        recent_stats = stats_by_id.get(w["id"])
        timeseries = timeseries_by_id.get(w["id"])

        result.append(
            WorkerSummary(
                id=w["id"],
                name=w["name"],
                description=w.get("description"),
                long_description=w.get("long_description"),
                use_cases=w.get("use_cases"),
                example_input=w.get("example_input"),
                example_output=w.get("example_output"),
                how_it_works=w.get("how_it_works"),
                tags=w.get("tags") or [],
                folder=w.get("folder"),
                status=status,
                trigger_type=w["trigger_type"],
                runner=w["runner"],
                last_run=last_run,
                triggers=triggers,
                triggers_spec=triggers_spec,
                recent_stats=recent_stats,
                timeseries=timeseries,
            )
        )
    return result


@app.get("/workers/{worker_id}", response_model=WorkerDetail)
def get_worker_detail(worker_id: str) -> WorkerDetail:
    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, worker_id, status, trigger_source,
                   created_at, started_at, completed_at, duration_ms, error
            FROM runs WHERE worker_id = ? ORDER BY created_at DESC LIMIT 10
            """,
            (worker_id,),
        )
        recent_runs = [_make_run_summary(r) for r in cursor.fetchall()]

    config_dict = worker.get("config", {})
    try:
        config = WorkerConfig(**config_dict)
    except Exception:
        config = WorkerConfig(
            id=worker["id"],
            name=worker["name"],
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )

    status = WorkerStatus(worker["status"])
    if config and config.secrets:
        missing = [s for s in config.secrets if s not in os.environ]
        if missing:
            status = WorkerStatus.MISSING_SECRET
    if (
        status == WorkerStatus.HEALTHY
        and recent_runs
        and recent_runs[0].status == RunStatus.FAILED
    ):
        status = WorkerStatus.NEEDS_ATTENTION

    # Read all files from the worker directory for Code tab and edit page
    manifest_yaml: Optional[str] = None
    run_py: Optional[str] = None
    skill_md_content: Optional[str] = None
    run_py_content: Optional[str] = None
    worker_files: List[WorkerFile] = []
    try:
        from worker_registry import WORKERS_DIR
        worker_dir = WORKERS_DIR / worker_id
        yml_path = worker_dir / "worker.yml"
        run_path = worker_dir / "run.py"
        skill_path = worker_dir / "SKILL.md"
        if yml_path.is_file():
            manifest_yaml = yml_path.read_text()
        elif worker.get("manifest"):
            import yaml as pyyaml
            manifest_yaml = pyyaml.safe_dump(worker["manifest"], sort_keys=False)
        if run_path.is_file():
            run_py = run_path.read_text()
            run_py_content = run_py
        if skill_path.is_file():
            skill_md_content = skill_path.read_text()
        worker_files = _read_worker_files(worker_dir)
    except Exception:
        pass

    # Build webhook URL if this worker has a webhook trigger
    from webhook_service import build_webhook_url as _build_webhook_url
    webhook_url: Optional[str] = None
    if _worker_has_webhook_trigger(worker["id"], config):
        try:
            webhook_url = _build_webhook_url(worker["id"])
        except Exception:
            pass

    triggers_spec = _build_triggers_spec(worker)

    return WorkerDetail(
        id=worker["id"],
        name=worker["name"],
        description=worker.get("description"),
        long_description=worker.get("long_description"),
        use_cases=worker.get("use_cases"),
        example_input=worker.get("example_input"),
        example_output=worker.get("example_output"),
        how_it_works=worker.get("how_it_works"),
        tags=worker.get("tags") or [],
        folder=worker.get("folder"),
        status=status,
        trigger_type=worker["trigger_type"],
        runner=worker["runner"],
        config=config,
        recent_runs=recent_runs,
        manifest_yaml=manifest_yaml,
        run_py=run_py,
        skill_md_content=skill_md_content,
        run_py_content=run_py_content,
        files=worker_files,
        webhook_url=webhook_url,
        triggers_spec=triggers_spec,
    )


# ---------------------------------------------------------------------------
# PATCH /workers/{worker_id} — partial update
# ---------------------------------------------------------------------------

@app.patch("/workers/{worker_id}", response_model=WorkerDetail)
def update_worker(worker_id: str, payload: WorkerUpdateRequest) -> WorkerDetail:
    """Partially update a worker instance.

    All fields are optional. Rotation of webhook_secret returns the new raw
    secret once in the response (new_webhook_secret field) — it is never
    stored in plaintext.
    """
    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    # Validate cron expression if provided
    new_cron_expr = payload.cron_expr
    if new_cron_expr is not None:
        try:
            from scheduler import compute_next_run_at
            from datetime import datetime, timezone
            test_dt = datetime.now(timezone.utc)
            if compute_next_run_at(new_cron_expr, test_dt) is None:
                raise HTTPException(status_code=400, detail=f"Invalid cron expression: {new_cron_expr!r}")
        except ImportError:
            # croniter not available — try basic validation via regex
            # Standard cron has 5 space-separated fields
            import re as _re
            if not _re.fullmatch(r"[\d\*\-\,\/]+(?: [\d\*\-\,\/]+){4}", new_cron_expr.strip()):
                raise HTTPException(status_code=400, detail=f"Invalid cron expression: {new_cron_expr!r}")

    updates: list[str] = []
    params: list[Any] = []

    if payload.trigger_type is not None:
        updates.append("trigger_type = ?")
        params.append(payload.trigger_type)

    if new_cron_expr is not None:
        updates.append("cron_expr = ?")
        params.append(new_cron_expr)

    if payload.cron_timezone is not None:
        updates.append("cron_timezone = ?")
        params.append(payload.cron_timezone)

    if payload.input_values is not None:
        updates.append("input_values_json = ?")
        params.append(json.dumps(payload.input_values))

    # capabilities field is declared-not-enforced per T1c flip — just accept it
    # No DB column to write to currently; stored in manifest only.

    new_raw_secret: Optional[str] = None
    if payload.webhook_secret_rotate:
        from webhook_service import generate_webhook_secret
        # Verify the worker actually has a webhook trigger before rotating
        config = get_worker_config_for_run(worker_id)
        if not _worker_has_webhook_trigger(worker_id, config):
            raise HTTPException(
                status_code=400,
                detail=f"Worker {worker_id!r} does not have a webhook trigger — cannot rotate secret",
            )
        new_raw_secret = generate_webhook_secret(worker_id)

    if updates:
        params.append(worker_id)
        with get_db() as conn:
            conn.execute(
                f"UPDATE workers SET {', '.join(updates)} WHERE id = ?",
                tuple(params),
            )
        invalidate_worker_cache()

    # Reload cron schedule if trigger/cron changed
    if payload.trigger_type is not None or new_cron_expr is not None or payload.cron_timezone is not None:
        with get_db() as conn:
            conn.execute(
                "UPDATE workers SET next_run_at = NULL WHERE id = ?",
                (worker_id,),
            )

    # N6 fix: persist trigger changes to worker.yml on disk so they survive
    # a server restart / worker registry reload (which reads from disk).
    trigger_changed = (
        payload.trigger_type is not None
        or new_cron_expr is not None
        or payload.cron_timezone is not None
    )
    if trigger_changed:
        from worker_registry import WORKERS_DIR
        worker_yml_path = WORKERS_DIR / worker_id / "worker.yml"
        if worker_yml_path.exists():
            try:
                existing_yml = worker_yml_path.read_text()
                # Build the updated trigger block from DB state so the single
                # source of truth (DB) is serialised back to disk.
                effective_type = payload.trigger_type or (
                    worker.get("config", {}).get("trigger", {}).get("type", "manual")
                )
                effective_cron = new_cron_expr or (
                    worker.get("config", {}).get("trigger", {}).get("cron")
                )
                effective_tz = payload.cron_timezone or (
                    worker.get("config", {}).get("trigger", {}).get("timezone", "UTC")
                )
                trigger_lines = [f"trigger:", f"  type: {effective_type}"]
                if effective_type == "schedule":
                    cron_val = effective_cron or "0 9 * * *"
                    tz_val = effective_tz or "UTC"
                    trigger_lines.append(f'  cron: "{cron_val}"')
                    trigger_lines.append(f'  timezone: "{tz_val}"')
                new_trigger_yaml = "\n".join(trigger_lines)

                # Replace the trigger block inside the YAML string
                lines = existing_yml.split("\n")
                start = next(
                    (i for i, ln in enumerate(lines) if re.match(r"^triggers?:\s*$", ln)),
                    None,
                )
                if start is not None:
                    end = len(lines)
                    for i in range(start + 1, len(lines)):
                        if re.match(r"^[A-Za-z_][\w_-]*:\s*", lines[i]):
                            end = i
                            break
                    updated_yml = "\n".join(
                        lines[:start] + new_trigger_yaml.split("\n") + lines[end:]
                    )
                else:
                    # No trigger block found — append
                    updated_yml = existing_yml.rstrip("\n") + "\n\n" + new_trigger_yaml + "\n"
                worker_yml_path.write_text(updated_yml)
                logger.info(
                    "PATCH %s: wrote trigger changes to worker.yml on disk (type=%s, cron=%s)",
                    worker_id,
                    effective_type,
                    effective_cron,
                )
            except Exception as exc:
                # Non-fatal: DB is authoritative; log the disk-write failure
                logger.warning(
                    "PATCH %s: could not update worker.yml on disk: %s",
                    worker_id,
                    exc,
                )

    detail = get_worker_detail(worker_id)
    if new_raw_secret is not None:
        detail.new_webhook_secret = new_raw_secret
    return detail


# ---------------------------------------------------------------------------
# DELETE /workers/{worker_id}
# ---------------------------------------------------------------------------

@app.delete("/workers/{worker_id}", status_code=204)
def delete_worker(worker_id: str):
    """Delete a worker and all dependent rows (runs, artifacts, logs).

    - FK ON DELETE CASCADE handles dependent rows.
    - Cancels any in-progress run gracefully (marks failed).
    - Cleans up webhook secret.
    - Removes scheduler slot (next_run_at cleared before delete).
    - skill_version is preserved if other workers share it.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, skill_version_id FROM workers WHERE id = ?", (worker_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Worker not found")
        skill_version_id = row["skill_version_id"]
        composio_state = _existing_composio_state(conn, worker_id)

    if composio_state.get("trigger_id"):
        try:
            _disable_composio_trigger(
                composio_state.get("event") or (composio_state.get("signature") or {}).get("event"),
                composio_state.get("trigger_id"),
                worker_id,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Cancel any in-progress runs gracefully before deletion
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id FROM runs WHERE worker_id = ? AND status IN ('queued', 'running')",
            (worker_id,),
        )
        active_runs = [r["id"] for r in cursor.fetchall()]

    for run_id in active_runs:
        try:
            update_run_status(run_id, RunStatus.FAILED.value, error="Worker deleted")
            logger.info("Cancelled active run %s before worker deletion", run_id)
        except Exception as exc:
            logger.warning("Could not cancel run %s: %s", run_id, exc)

    # Remove webhook secret
    try:
        from webhook_service import delete_webhook_secret
        delete_webhook_secret(worker_id)
    except Exception as exc:
        logger.warning("Could not delete webhook secret for %s: %s", worker_id, exc)

    # Delete the worker (FK CASCADE removes runs/artifacts/logs/webhooks)
    with get_db() as conn:
        conn.execute("DELETE FROM workers WHERE id = ?", (worker_id,))

    # Check if skill_version is still referenced by other workers; preserve if so.
    # If unreferenced, also delete the skill_versions row so name+version can
    # be reused when the user recreates a worker with the same ID (N5 fix).
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(*) as cnt FROM workers WHERE skill_version_id = ?",
            (skill_version_id,),
        )
        ref_count = cursor.fetchone()["cnt"]
        if ref_count == 0 and skill_version_id:
            conn.execute(
                "DELETE FROM skill_versions WHERE id = ?",
                (skill_version_id,),
            )
            logger.info("Removed unreferenced skill_version %s", skill_version_id)

    # Remove bundle files from disk only if no other worker references this skill_version
    from worker_registry import WORKERS_DIR
    bundle_dir = WORKERS_DIR / worker_id
    if ref_count == 0 and bundle_dir.is_dir():
        try:
            import shutil
            shutil.rmtree(bundle_dir)
            logger.info("Removed bundle dir %s", bundle_dir)
        except Exception as exc:
            logger.warning("Could not remove bundle dir %s: %s", bundle_dir, exc)
    elif ref_count > 0:
        logger.info("skill_version %s still referenced by %d workers, bundle preserved", skill_version_id, ref_count)

    invalidate_worker_cache()
    # 204 No Content — FastAPI returns empty body automatically for status_code=204
    return None


# ---------------------------------------------------------------------------
# Worker creation
# ---------------------------------------------------------------------------

class WorkerCreateRequest(BaseModel):
    worker_yml: str
    run_py: str
    skill_md: Optional[str] = None


# ---------------------------------------------------------------------------
# POST /workers/draft-from-prompt
# ---------------------------------------------------------------------------

# Strict keyword map: only match if the app name itself appears in the prompt.
# Generic words like "meeting", "message", "file" have been removed to avoid
# false positives (e.g. "Granola meetings" should not imply google-calendar).
_COMPOSIO_APP_KEYWORDS: Dict[str, List[str]] = {
    "gmail": ["gmail"],
    "hubspot": ["hubspot"],
    "slack": ["slack"],
    "notion": ["notion"],
    "granola": ["granola"],
    "salesforce": ["salesforce", "sfdc"],
    "google-calendar": ["google calendar", "google cal"],
    "github": ["github"],
    "linear": ["linear"],
    "google-sheets": ["google sheets", "google sheet"],
    "airtable": ["airtable"],
    "stripe": ["stripe"],
    "jira": ["jira"],
    "figma": ["figma"],
    "discord": ["discord"],
    "twitter": ["twitter", "x.com"],
    "linkedin": ["linkedin"],
    "dropbox": ["dropbox"],
    "google-drive": ["google drive", "gdrive"],
    "apollo": ["apollo"],
}

_DRAFT_SYSTEM_PROMPT = """You are a Workeros worker designer. Given a natural-language description of an automation task, you output a skill bundle: a set of files that define the worker.

The bundle is returned via the `files` array. Every file has `path` (relative, e.g. "worker.yml") and `content` (UTF-8 string). The bundle MUST contain `worker.yml` at the root.

=== WORKER ARCHETYPES ===

The execution mode is derived from `exec.entry`:

- `entry: SKILL.md` -> agent mode. The platform runs an LLM tool loop with web_search, file tools, and any declared connections.
- `entry: run.py` (or `.sh` / `.js`) -> script mode. The platform just runs the file in an E2B sandbox.

Both shapes are first-class. Pick the one the task needs:

A - AGENT (pure reasoning, web research, agent-driven orchestration):
Use when: the task is reasoning, analysis, summarisation, writing, or anything that benefits from live web search.
Files: worker.yml + SKILL.md
worker.yml exec block:
  exec:
    entry: "SKILL.md"
    runtime: "skill"
    runner: "e2b"

B - SCRIPT (deterministic data transform, you control the code):
Use when: the task is a predictable data transform, file conversion, calculation, or API choreography you want to write yourself.
Files: worker.yml + run.py + requirements.txt
worker.yml exec block:
  exec:
    entry: "run.py"
    command: "python run.py"
    runtime: "python311"
    runner: "e2b"

Both are valid. A script that needs to call an LLM is just script-mode with an openai import; no separate "hybrid" mode is needed.

=== WORKED EXAMPLES ===

Example A (agent):
files:
  worker.yml: |
    schema_version: "0.3"
    name: "research-brief"
    title: "Research Brief Generator"
    description: "Generate a structured research brief from topic and audience."
    version: "0.1.0"
    entrypoint: "SKILL.md"
    targets: [generic]
    exec:
      entry: "SKILL.md"
      runtime: "skill"
      runner: "e2b"
      inputs:
      - name: topic
        kind: scalar
        type: string
        required: true
        label: "Research topic"
      - name: audience
        kind: scalar
        type: string
        required: false
        label: "Target audience"
        default: "general"
      outputs:
      - name: brief
        kind: file
        media_type: text/markdown
        path: out/brief.md
        required: true
        label: "Research brief"
    trigger:
      type: manual
  SKILL.md: |
    You are a research analyst. The user provides a topic, audience, and depth.
    Generate a structured markdown brief. Call write_output(name="brief", content="...").

Example B (script):
files:
  worker.yml: |
    schema_version: "0.3"
    name: "csv-enricher"
    title: "CSV Enricher"
    description: "Enrich a CSV file with computed columns."
    version: "0.1.0"
    targets: [generic]
    exec:
      entry: "run.py"
      runtime: "python311"
      runner: "e2b"
      command: "python run.py"
      inputs:
      - name: csv_data
        kind: file
        media_type: text/csv
        required: true
        label: "Input CSV"
      outputs:
      - name: result
        kind: file
        media_type: text/csv
        path: out/result.csv
        required: true
        label: "Enriched CSV"
    trigger:
      type: manual
  run.py: |
    import json, csv, io, os
    try:
        from dotenv import load_dotenv
        load_dotenv(".env.local")
    except ImportError:
        pass
    inputs = json.load(open("inputs.json"))
    # process inputs["csv_data"] ...
    json.dump({"status": "completed", "outputs": {}, "artifacts": []}, open("result.json", "w"))
  requirements.txt: |
    python-dotenv>=1.0.0

Example C (script that calls an LLM):
files:
  worker.yml: |
    schema_version: "0.3"
    name: "granola-hubspot-sync"
    title: "Granola to HubSpot Meeting Sync"
    description: "Fetch recent Granola meetings and update HubSpot with action items."
    version: "0.1.0"
    targets: [generic]
    exec:
      entry: "run.py"
      runtime: "python311"
      runner: "e2b"
      command: "python run.py"
      secrets:
      - GRANOLA_API_KEY
      connections:
      - hubspot
      outputs:
      - name: summary
        kind: file
        media_type: text/markdown
        path: out/summary.md
        required: true
        label: "Sync summary"
    trigger:
      type: schedule
      cron: "0 9 * * *"
      timezone: "Europe/Berlin"
  SKILL.md: |
    You are summarising a Granola meeting transcript into HubSpot-ready action items.
    Input: meeting transcript. Output JSON: {"summary": str, "action_items": [str]}.
  run.py: |
    import json, os
    try:
        from dotenv import load_dotenv
        load_dotenv(".env.local")
    except ImportError:
        pass
    from agent import run as run_agent
    from lib.granola_client import fetch_recent_meetings
    from lib.hubspot_client import create_note
    granola_key = os.environ.get("GRANOLA_API_KEY") or json.load(open("secrets.json")).get("GRANOLA_API_KEY", "")
    for meeting in fetch_recent_meetings(granola_key):
        result = run_agent("SKILL.md", input=meeting["transcript"])
        hubspot_token = os.environ.get("HUBSPOT_ACCESS_TOKEN", "")
        create_note(hubspot_token, meeting["id"], result["summary"])
    json.dump({"status": "completed", "outputs": {}, "artifacts": []}, open("result.json", "w"))
  lib/granola_client.py: |
    import requests
    def fetch_recent_meetings(api_key):
        resp = requests.get("https://api.granola.so/v1/meetings", headers={"Authorization": f"Bearer {api_key}"})
        return resp.json().get("meetings", [])
  lib/hubspot_client.py: |
    import requests
    def create_note(token, contact_id, body):
        requests.post("https://api.hubapi.com/crm/v3/objects/notes", json={"properties": {"hs_note_body": body}}, headers={"Authorization": f"Bearer {token}"})
  requirements.txt: |
    requests>=2.31

=== YAML RULES ===

The WorkerContract YAML must follow schema_version "0.3":
- `name`: lowercase slug 3-64 chars (letters, digits, hyphens)
- `title`: human-readable title
- `description`: 1-2 sentence description (max 500 chars)
- ALWAYS double-quote every string scalar value (colons inside strings cause parse errors)
- `trigger.cron`: REQUIRED when trigger.type is "schedule". Default: "0 9 * * *" if not specified.
- `version`: semver like "0.1.0"
- `targets`: ["generic"]

=== INTEGRATION RULES ===

- Only include integrations for apps EXPLICITLY NAMED in the user's prompt.
- Choose ONE auth method per app: "oauth" (for Gmail/HubSpot/Slack/etc.) or "api_key" (for Granola/Apollo/Stripe/etc.)
- Never list the same app twice.

=== RESPONSE FORMAT ===

Respond with ONLY valid JSON (no markdown fences). The `files` array is mandatory. `worker_yml` must match the content of the worker.yml file.

{
  "files": [
    {"path": "worker.yml", "content": "<full YAML string>"},
    {"path": "SKILL.md", "content": "<agent instructions>"},
    {"path": "run.py", "content": "<python code>"},
    {"path": "requirements.txt", "content": "<pip deps>"}
  ],
  "worker_yml": "<same as files[0].content>",
  "skill_md": "<same as SKILL.md content or null>",
  "suggested_name": "<slug>",
  "suggested_title": "<human title>",
  "requirements": [
    {"app": "<app-slug>", "method": "oauth_or_api_key", "reason": "<one-line why>"}
  ],
  "available_methods_hint": {"<app-slug>": ["oauth", "api_key"]},
  "required_connections": ["<oauth-app-slugs>"],
  "required_secrets": ["<UPPER_SNAKE_CASE_API_KEY>"],
  "inputs": [{"name": "field_name", "type": "string", "label": "Human label", "required": false, "default": null}],
  "outputs": [{"name": "summary", "type": "markdown", "label": "Summary"}]
}

Only include files that are needed. Omit run.py for agent-only (A), omit SKILL.md for pure-script (B).
The `requirements` array is the authoritative source. `required_connections` = oauth slugs only. `required_secrets` = API_KEY names only."""


class DraftFromPromptRequest(BaseModel):
    prompt: str


class DraftFromPromptInputField(BaseModel):
    name: str
    type: str
    label: str
    required: bool = False
    default: Optional[Any] = None


class DraftFromPromptOutputField(BaseModel):
    name: str
    type: str
    label: str


class RequirementItem(BaseModel):
    """One integration requirement: a single app with exactly one auth method."""
    app: str
    method: str  # "oauth" or "api_key" -- the CURRENT selection (default = LLM suggestion)
    available_methods: List[str] = []  # both "oauth" and "api_key" if both supported; otherwise just the one
    reason: str = ""


# ---------------------------------------------------------------------------
# Authoritative auth-modes table
# The LLM's reported available_methods is informational only; this table is
# authoritative because the LLM hallucinates. Backend enriches every
# RequirementItem with available_methods from this table before returning.
# ---------------------------------------------------------------------------

_BOTH_METHODS: frozenset = frozenset({
    "gmail",
    "hubspot",
    "slack",
    "notion",
    "github",
    "linear",
    "googlecalendar",
    "google-calendar",
    "googlesheets",
    "google-sheets",
    "googledrive",
    "google-drive",
    "googledocs",
    "google-docs",
    "salesforce",
    "linkedin",
    "discord",
    "dropbox",
    "airtable",
    "jira",
    "granola",
    "asana",
    "monday",
    "trello",
    "twitter",
})

_API_KEY_ONLY: frozenset = frozenset({
    "apollo",
    "stripe",
    "openai",
    "perplexityai",
    "anthropic",
    "serpapi",
    "firecrawl",
    "tavily",
})


def _available_methods_for_app(app_slug: str) -> List[str]:
    """Return the authoritative list of available auth methods for an app.

    Normalises slug to lowercase before lookup.
    """
    slug = (app_slug or "").lower().strip()
    if slug in _API_KEY_ONLY:
        return ["api_key"]
    if slug in _BOTH_METHODS:
        return ["oauth", "api_key"]
    # Unknown app: default to both so the user is not blocked
    return ["oauth", "api_key"]


_draft_rate_lock = threading.Lock()
_draft_rate_store: Dict[str, collections.deque] = {}
_DRAFT_RATE_LIMIT_HOUR = int(os.environ.get("WORKEROS_DRAFT_RATE_HOUR", "20"))
_DRAFT_RATE_WINDOW_SECONDS = 3600.0


def _draft_rate_key(request: Request) -> str:
    """Per-secret bucket key for draft endpoints.

    Hashes x-floom-secret so the raw value is never persisted in-memory logs.
    In dev mode (no header), all callers share the same "anon" bucket.
    """
    secret = request.headers.get("x-floom-secret") or ""
    if not secret:
        return "anon"
    return "s:" + hashlib.sha256(secret.encode()).hexdigest()[:16]


def _claim_draft_slot(request: Request) -> Optional[int]:
    """Reserve one draft slot.

    Returns:
      - None when allowed
      - retry_after_seconds when rate-limited
    """
    now = time.monotonic()
    cutoff = now - _DRAFT_RATE_WINDOW_SECONDS
    key = _draft_rate_key(request)
    with _draft_rate_lock:
        dq = _draft_rate_store.setdefault(key, collections.deque())
        while dq and dq[0] <= cutoff:
            dq.popleft()
        if len(dq) >= _DRAFT_RATE_LIMIT_HOUR:
            oldest = dq[0]
            retry_after = max(1, int(_DRAFT_RATE_WINDOW_SECONDS - (now - oldest)))
            return retry_after
        dq.append(now)
        return None


def _drafts_last_hour_total() -> int:
    """Total accepted drafts in the last hour across all callers."""
    now = time.monotonic()
    cutoff = now - _DRAFT_RATE_WINDOW_SECONDS
    total = 0
    with _draft_rate_lock:
        stale_keys: List[str] = []
        for key, dq in _draft_rate_store.items():
            while dq and dq[0] <= cutoff:
                dq.popleft()
            if dq:
                total += len(dq)
            else:
                stale_keys.append(key)
        for key in stale_keys:
            _draft_rate_store.pop(key, None)
    return total


def _enforce_draft_rate_limit(request: Request) -> None:
    retry_after = _claim_draft_slot(request)
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail=f"Draft rate limit reached: {_DRAFT_RATE_LIMIT_HOUR}/hour. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )


class DraftFile(BaseModel):
    """A single file in a skill bundle returned by draft-from-prompt."""
    path: str      # e.g. "worker.yml", "run.py", "SKILL.md", "lib/granola_client.py"
    content: str   # UTF-8 text content


class DraftFromPromptResponse(BaseModel):
    worker_yml: str
    skill_md: Optional[str] = None
    suggested_name: str
    suggested_title: str
    # New: one entry per app, method is "oauth" or "api_key"
    requirements: List[RequirementItem] = []
    # Skill-bundle: all files returned by the LLM (worker.yml, run.py, SKILL.md, lib/*.py, etc.)
    # When present, the frontend should use these files directly instead of constructing them.
    files: List[DraftFile] = []
    # Legacy fields kept for backward compatibility
    required_connections: List[str]
    required_secrets: List[str]
    inputs: List[DraftFromPromptInputField]
    outputs: List[DraftFromPromptOutputField]


def _detect_connections(prompt_lower: str) -> List[str]:
    """Keyword-match Composio app slugs from the prompt text."""
    found: List[str] = []
    for slug, keywords in _COMPOSIO_APP_KEYWORDS.items():
        if any(kw in prompt_lower for kw in keywords):
            found.append(slug)
    return found


def _call_draft_llm(
    client: Any,
    user_message: str,
    extra_system_instructions: Optional[str] = None,
) -> Dict[str, Any]:
    """Single OpenAI call returning a parsed JSON payload. Raises HTTPException on transport/JSON errors."""
    system_prompt = _DRAFT_SYSTEM_PROMPT
    if extra_system_instructions:
        system_prompt = f"{system_prompt}\n\n{extra_system_instructions}"

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=0.2,
            max_tokens=3000,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        logger.exception("OpenAI call failed in draft-from-prompt")
        raise HTTPException(status_code=502, detail=f"LLM call failed: {exc}") from exc

    raw_content = (response.choices[0].message.content or "").strip()
    if raw_content.startswith("```"):
        raw_content = "\n".join(raw_content.split("\n")[1:])
    if raw_content.endswith("```"):
        raw_content = "\n".join(raw_content.split("\n")[:-1])
    raw_content = raw_content.strip()

    try:
        return json.loads(raw_content)
    except json.JSONDecodeError as exc:
        logger.error("LLM returned non-JSON for draft-from-prompt: %s", raw_content[:500])
        raise HTTPException(status_code=502, detail=f"LLM returned invalid JSON: {exc}") from exc


@app.post("/workers/draft-from-prompt", response_model=DraftFromPromptResponse)
async def draft_worker_from_prompt(payload: DraftFromPromptRequest, request: Request) -> DraftFromPromptResponse:
    """Draft a WorkerContract YAML from a natural-language prompt using LLM."""
    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required and must not be empty")
    if len(prompt) > 4000:
        raise HTTPException(status_code=400, detail="prompt must be 4000 characters or fewer")

    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not openai_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY not configured")
    _enforce_draft_rate_limit(request)

    # Pre-detect connections for the prompt to give the LLM a hint
    prompt_lower = prompt.lower()
    detected_connections = _detect_connections(prompt_lower)

    user_message = f"""Design a Workeros worker for this task:

{prompt}

Detected Composio apps that may be needed: {detected_connections if detected_connections else 'none detected, infer from context'}

Generate the full WorkerContract YAML and metadata JSON as specified. Make sure the YAML is valid and passes schema_version 0.3 validation. Remember: every string scalar in the YAML must be wrapped in double quotes."""

    from openai import OpenAI
    import yaml as pyyaml
    from models import parse_worker_manifest

    client = OpenAI(api_key=openai_key)

    max_attempts = 3
    last_yaml_error: Optional[str] = None
    parsed: Dict[str, Any] = {}
    worker_yml = ""

    for attempt in range(1, max_attempts + 1):
        extra_instructions: Optional[str] = None
        if last_yaml_error:
            extra_instructions = (
                f"PREVIOUS ATTEMPT FAILED YAML VALIDATION with error: {last_yaml_error}\n"
                "Retry. Double-quote every single string value in the YAML, including title, description, labels, "
                "use_cases entries, and any prompt examples. Do not leave any string unquoted. "
                "Treat colons inside strings as parse hazards and quote the whole value."
            )

        parsed = _call_draft_llm(client, user_message, extra_instructions)
        worker_yml = parsed.get("worker_yml", "")
        if not worker_yml:
            last_yaml_error = "empty worker_yml returned"
            continue

        try:
            raw_manifest = pyyaml.safe_load(worker_yml)
            if not isinstance(raw_manifest, dict):
                raise ValueError("worker_yml must be a YAML mapping")
            parse_worker_manifest(raw_manifest)
            last_yaml_error = None
            break
        except Exception as exc:
            last_yaml_error = str(exc)
            logger.warning(
                "draft-from-prompt YAML validation failed on attempt %d/%d: %s",
                attempt,
                max_attempts,
                exc,
            )

    if last_yaml_error:
        raise HTTPException(
            status_code=502,
            detail=f"LLM-generated worker YAML is not valid after {max_attempts} attempts: {last_yaml_error}",
        )

    suggested_name = parsed.get("suggested_name", "my-worker")
    suggested_title = parsed.get("suggested_title", "My Worker")

    # --- Process requirements array (new format) ---
    # Build deduplicated requirements: one entry per app, no duplicates.
    requirements: List[RequirementItem] = []
    seen_apps: set = set()

    raw_requirements = parsed.get("requirements") or []
    if isinstance(raw_requirements, list):
        for req in raw_requirements:
            if not isinstance(req, dict):
                continue
            app_slug = (req.get("app") or "").strip().lower()
            method = (req.get("method") or "oauth").strip().lower()
            reason = req.get("reason") or ""
            if not app_slug or app_slug in seen_apps:
                continue
            # Normalize method: only "oauth" or "api_key" are valid
            if method not in ("oauth", "api_key"):
                method = "oauth"
            requirements.append(RequirementItem(app=app_slug, method=method, reason=reason))
            seen_apps.add(app_slug)

    # If LLM did not return structured requirements, fall back to detected connections
    # and build requirements from required_connections + required_secrets.
    if not requirements:
        llm_connections = parsed.get("required_connections") or detected_connections
        llm_secrets = parsed.get("required_secrets") or []
        # Infer apps from secrets: HUBSPOT_API_KEY -> hubspot
        secret_apps = set()
        for secret in llm_secrets:
            if isinstance(secret, str) and secret.endswith("_API_KEY"):
                app_from_secret = secret[: -len("_API_KEY")].lower().replace("_", "-")
                secret_apps.add(app_from_secret)
        for conn in llm_connections:
            slug = (conn or "").strip().lower()
            if not slug or slug in seen_apps:
                continue
            # If this app also appears in secret_apps, prefer oauth (not both)
            requirements.append(RequirementItem(app=slug, method="oauth", reason=""))
            seen_apps.add(slug)
        for app_slug in secret_apps:
            if app_slug not in seen_apps:
                requirements.append(RequirementItem(app=app_slug, method="api_key", reason=""))
                seen_apps.add(app_slug)

    # Enrich each requirement with available_methods from the authoritative table.
    # The LLM's suggestion for method is kept as the default selection, but
    # available_methods tells the frontend which toggle options to show the user.
    enriched_requirements: List[RequirementItem] = []
    for req in requirements:
        avail = _available_methods_for_app(req.app)
        # If LLM suggested a method not in avail, pick the first available instead.
        method = req.method if req.method in avail else avail[0]
        enriched_requirements.append(RequirementItem(
            app=req.app,
            method=method,
            available_methods=avail,
            reason=req.reason,
        ))
    requirements = enriched_requirements

    # Derive legacy fields from requirements for backward compatibility
    required_connections = [r.app for r in requirements if r.method == "oauth"]
    required_secrets_from_reqs = [
        f"{r.app.upper().replace('-', '_')}_API_KEY"
        for r in requirements if r.method == "api_key"
    ]
    # Also include any explicitly-listed secrets that don't overlap with api_key requirements
    llm_raw_secrets = parsed.get("required_secrets") or []
    extra_secrets = [
        s for s in llm_raw_secrets
        if isinstance(s, str) and s not in required_secrets_from_reqs
    ]
    required_secrets = required_secrets_from_reqs + extra_secrets

    raw_inputs = parsed.get("inputs") or []
    inputs = [
        DraftFromPromptInputField(
            name=f.get("name", "input"),
            type=f.get("type", "string"),
            label=f.get("label", f.get("name", "Input")),
            required=bool(f.get("required", False)),
            default=f.get("default"),
        )
        for f in raw_inputs if isinstance(f, dict) and f.get("name")
    ]

    raw_outputs = parsed.get("outputs") or []
    if not raw_outputs:
        raw_outputs = [{"name": "summary", "type": "markdown", "label": "Summary"}]
    outputs = [
        DraftFromPromptOutputField(
            name=f.get("name", "summary"),
            type=f.get("type", "markdown"),
            label=f.get("label", f.get("name", "Output")),
        )
        for f in raw_outputs if isinstance(f, dict) and f.get("name")
    ]

    skill_md = parsed.get("skill_md") or None

    # Build the files list from the LLM's files array (new bundle format)
    raw_files = parsed.get("files") or []
    draft_files: List[DraftFile] = []
    if isinstance(raw_files, list):
        for f in raw_files:
            if not isinstance(f, dict):
                continue
            path = (f.get("path") or "").strip()
            content = f.get("content") or ""
            if not path:
                continue
            # Guard against path traversal in LLM-generated paths
            parts = path.replace("\\", "/").split("/")
            if any(p in ("", "..") for p in parts):
                continue
            draft_files.append(DraftFile(path=path, content=content))

    # If the LLM returned files but worker.yml isn't in the list, synthesise it from worker_yml
    paths_in_files = {f.path for f in draft_files}
    if draft_files and "worker.yml" not in paths_in_files:
        draft_files.insert(0, DraftFile(path="worker.yml", content=worker_yml))
    elif not draft_files:
        # Legacy LLM: no files array — synthesise from worker_yml + skill_md
        draft_files.append(DraftFile(path="worker.yml", content=worker_yml))
        if skill_md:
            draft_files.append(DraftFile(path="SKILL.md", content=skill_md))

    return DraftFromPromptResponse(
        worker_yml=worker_yml,
        skill_md=skill_md,
        suggested_name=suggested_name,
        suggested_title=suggested_title,
        requirements=requirements,
        files=draft_files,
        required_connections=required_connections,
        required_secrets=required_secrets,
        inputs=inputs,
        outputs=outputs,
    )


# ---------------------------------------------------------------------------
# POST /workers/draft-and-create — draft + register in one round-trip
# ---------------------------------------------------------------------------

class DraftAndCreateRequest(BaseModel):
    prompt: str = ""
    # Optional pre-built files to skip the LLM step (used for .md / .py uploads)
    files: List[DraftFile] = []


class DraftAndCreateResponse(BaseModel):
    worker_id: str


@app.post("/workers/draft-and-create", response_model=DraftAndCreateResponse)
async def draft_and_create_worker(payload: DraftAndCreateRequest, request: Request) -> DraftAndCreateResponse:
    """Draft a worker via LLM (or from pre-supplied files) and immediately register it.

    If ``files`` is provided (non-empty), skips the LLM and writes those files directly.
    If only ``prompt`` is given, calls the LLM with up to 3 retries; returns 502 on
    persistent YAML validation failure (no worker is written to disk on failure).
    """
    from worker_registry import WORKERS_DIR
    import yaml as pyyaml
    from models import parse_worker_manifest

    # ----------------------------------------------------------------
    # Path A: pre-supplied files (upload flow — skip LLM)
    # ----------------------------------------------------------------
    if payload.files:
        draft_files = []
        for f in payload.files:
            path = (f.path or "").strip()
            parts = path.replace("\\", "/").split("/")
            if any(p in ("", "..") for p in parts):
                raise HTTPException(status_code=400, detail=f"Invalid path: {path!r}")
            draft_files.append(f)

        worker_yml_file = next((f for f in draft_files if f.path == "worker.yml"), None)
        if not worker_yml_file:
            raise HTTPException(status_code=400, detail="files must include worker.yml")

        worker_id, _config = _parse_worker_payload(worker_yml_file.content)

        target_dir = WORKERS_DIR / worker_id
        if target_dir.exists():
            raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")

        target_dir.mkdir(parents=True, exist_ok=False)
        try:
            for f in draft_files:
                parts = f.path.replace("\\", "/").split("/")
                dest = target_dir
                for part in parts[:-1]:
                    dest = dest / part
                    dest.mkdir(exist_ok=True)
                (dest / parts[-1]).write_text(f.content)

            if not (target_dir / "run.py").exists():
                (target_dir / "run.py").write_text(
                    "from typing import Dict, Any\n\n"
                    "def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:\n"
                    "    return {'status': 'success', 'outputs': {}, 'artifacts': []}\n"
                )
            if not (target_dir / "requirements.txt").exists():
                (target_dir / "requirements.txt").write_text("")
        except HTTPException:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            raise
        except Exception as exc:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail=f"Failed to write files: {exc}") from exc

        invalidate_worker_cache()
        workers = discover_workers()
        with get_db() as conn:
            try:
                _persist_discovered_workers(conn, workers)
            except (sqlite3.IntegrityError, RuntimeError) as exc:
                import shutil
                shutil.rmtree(target_dir, ignore_errors=True)
                invalidate_worker_cache()
                raise HTTPException(status_code=409, detail=str(exc)) from exc

        return DraftAndCreateResponse(worker_id=worker_id)

    # ----------------------------------------------------------------
    # Path B: LLM draft from prompt
    # ----------------------------------------------------------------
    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt or files is required")
    if len(prompt) > 4000:
        raise HTTPException(status_code=400, detail="prompt must be 4000 characters or fewer")

    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not openai_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY not configured")
    _enforce_draft_rate_limit(request)

    from openai import OpenAI

    prompt_lower = prompt.lower()
    detected_connections = _detect_connections(prompt_lower)

    user_message = (
        f"Design a Workeros worker for this task:\n\n{prompt}\n\n"
        f"Detected Composio apps that may be needed: "
        f"{detected_connections if detected_connections else 'none detected, infer from context'}\n\n"
        "Generate the full WorkerContract YAML and metadata JSON as specified. "
        "Make sure the YAML is valid and passes schema_version 0.3 validation. "
        "Remember: every string scalar in the YAML must be wrapped in double quotes."
    )

    client = OpenAI(api_key=openai_key)

    max_attempts = 3
    last_yaml_error: Optional[str] = None
    draft_files_from_llm: List[DraftFile] = []
    worker_yml_str = ""
    parsed_llm: Dict[str, Any] = {}

    for attempt in range(1, max_attempts + 1):
        extra_instructions: Optional[str] = None
        if last_yaml_error:
            extra_instructions = (
                f"PREVIOUS ATTEMPT FAILED YAML VALIDATION with error: {last_yaml_error}\n"
                "Retry. Double-quote every single string value in the YAML. "
                "Do not leave any string unquoted."
            )

        parsed_llm = _call_draft_llm(client, user_message, extra_instructions)
        worker_yml_str = parsed_llm.get("worker_yml", "")
        if not worker_yml_str:
            last_yaml_error = "empty worker_yml returned"
            continue

        try:
            raw_manifest = pyyaml.safe_load(worker_yml_str)
            if not isinstance(raw_manifest, dict):
                raise ValueError("worker_yml must be a YAML mapping")
            parse_worker_manifest(raw_manifest)
            last_yaml_error = None
            break
        except Exception as exc:
            last_yaml_error = str(exc)
            logger.warning(
                "draft-and-create YAML validation failed on attempt %d/%d: %s",
                attempt,
                max_attempts,
                exc,
            )

    if last_yaml_error:
        raise HTTPException(
            status_code=502,
            detail=f"LLM-generated worker YAML is not valid after {max_attempts} attempts: {last_yaml_error}",
        )

    # Assemble files from LLM response
    raw_files = parsed_llm.get("files") or []
    if isinstance(raw_files, list):
        for f in raw_files:
            if not isinstance(f, dict):
                continue
            path = (f.get("path") or "").strip()
            content = f.get("content") or ""
            if not path:
                continue
            parts = path.replace("\\", "/").split("/")
            if any(p in ("", "..") for p in parts):
                continue
            draft_files_from_llm.append(DraftFile(path=path, content=content))

    paths_in_files = {f.path for f in draft_files_from_llm}
    if draft_files_from_llm and "worker.yml" not in paths_in_files:
        draft_files_from_llm.insert(0, DraftFile(path="worker.yml", content=worker_yml_str))
    elif not draft_files_from_llm:
        draft_files_from_llm.append(DraftFile(path="worker.yml", content=worker_yml_str))
        skill_md_str = parsed_llm.get("skill_md")
        if skill_md_str:
            draft_files_from_llm.append(DraftFile(path="SKILL.md", content=skill_md_str))

    # Parse worker_id from validated YAML
    worker_id, _config2 = _parse_worker_payload(worker_yml_str)

    target_dir = WORKERS_DIR / worker_id
    if target_dir.exists():
        raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")

    target_dir.mkdir(parents=True, exist_ok=False)
    try:
        for f in draft_files_from_llm:
            parts = f.path.replace("\\", "/").split("/")
            dest = target_dir
            for part in parts[:-1]:
                dest = dest / part
                dest.mkdir(exist_ok=True)
            (dest / parts[-1]).write_text(f.content)

        if not (target_dir / "run.py").exists():
            (target_dir / "run.py").write_text(
                "from typing import Dict, Any\n\n"
                "def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:\n"
                "    return {'status': 'success', 'outputs': {}, 'artifacts': []}\n"
            )
        if not (target_dir / "requirements.txt").exists():
            (target_dir / "requirements.txt").write_text("")
    except Exception as exc:
        import shutil
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Failed to write worker files: {exc}") from exc

    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers)
        except (sqlite3.IntegrityError, RuntimeError) as exc:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            invalidate_worker_cache()
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    return DraftAndCreateResponse(worker_id=worker_id)


def _parse_worker_payload(worker_yml: str) -> tuple[str, WorkerConfig]:
    import yaml as pyyaml

    try:
        raw = pyyaml.safe_load(worker_yml)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {exc}")
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="worker_yml must contain a YAML mapping")

    # P1-3: reject path-traversal in caller-supplied bundle_path BEFORE schema parsing
    # (the projection from WorkerContract may strip the field, so we check raw YAML).
    raw_exec = raw.get("exec") if isinstance(raw.get("exec"), dict) else {}
    raw_runtime = raw.get("runtime") if isinstance(raw.get("runtime"), dict) else {}
    for src in (raw_exec, raw_runtime, raw):
        bundle_hint = src.get("bundle_path") if isinstance(src, dict) else None
        if not bundle_hint:
            continue
        if not isinstance(bundle_hint, str):
            raise HTTPException(status_code=400, detail="bundle_path must be a string")
        if bundle_hint.startswith("/") or "\\" in bundle_hint:
            raise HTTPException(status_code=400, detail="bundle_path must be a relative path")
        if ".." in bundle_hint.replace("\\", "/").split("/"):
            raise HTTPException(status_code=400, detail="bundle_path must not contain '..' segments")

    try:
        from models import WorkerContract, parse_worker_manifest, worker_contract_to_worker_config
        parsed = parse_worker_manifest(raw)
        if isinstance(parsed, WorkerContract):
            worker_id = parsed.name
            config = worker_contract_to_worker_config(parsed, worker_id)
        else:
            config = parsed
            worker_id = config.id
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Schema validation failed: {exc}")

    if not re.fullmatch(r"[a-z0-9_-]+", worker_id):
        raise HTTPException(status_code=400, detail=f"Worker ID must be lowercase kebab/snake-case: {worker_id!r}")
    return worker_id, config


@app.post("/workers", response_model=WorkerDetail)
def create_worker(payload: WorkerCreateRequest) -> WorkerDetail:
    """Create a new worker from YAML + Python source."""
    from worker_registry import WORKERS_DIR

    worker_id, config = _parse_worker_payload(payload.worker_yml)

    target_dir = WORKERS_DIR / worker_id
    if target_dir.exists():
        raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")

    # Write files
    target_dir.mkdir(parents=True, exist_ok=False)
    (target_dir / "worker.yml").write_text(payload.worker_yml)
    (target_dir / "run.py").write_text(payload.run_py)
    (target_dir / "requirements.txt").write_text("")
    if payload.skill_md:
        (target_dir / "SKILL.md").write_text(payload.skill_md)
    else:
        (target_dir / "SKILL.md").write_text(
            f"# {config.name}\n\n"
            "This WorkerContract entrypoint is a placeholder for the markdown skill runtime. "
            "Current Workeros execution uses `exec.command` from `worker.yml`.\n"
        )

    # Register
    invalidate_worker_cache()
    workers = discover_workers()

    # Persist to DB
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers)
        except sqlite3.IntegrityError as exc:
            # Orphaned skill_versions row from a previously-deleted worker with
            # the same name+version caused a FK or UNIQUE conflict. Clean up
            # and return a user-friendly 409 (N5 fix).
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            invalidate_worker_cache()
            raise HTTPException(
                status_code=409,
                detail=f"Worker {worker_id!r} already exists or conflicts with a previous version. "
                       "Delete the old worker first, then recreate.",
            ) from exc
        except RuntimeError as exc:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            invalidate_worker_cache()
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Return the new worker detail
    return get_worker_detail(worker_id)


# ---------------------------------------------------------------------------
# POST /workers/from-bundle — create a worker from a zip bundle
# ---------------------------------------------------------------------------

@app.post("/workers/from-bundle", response_model=WorkerDetail)
async def create_worker_from_bundle(
    bundle: UploadFile = File(...),
) -> WorkerDetail:
    """Create a new worker from an uploaded zip bundle.

    The zip must contain ``worker.yml`` at the root or inside exactly one
    top-level directory. It must include at least one of: SKILL.md, run.py.
    Returns 400 if the structure is invalid, 409 if the worker_id already
    exists.
    """
    import zipfile
    import io
    from worker_registry import WORKERS_DIR

    raw_bytes = await bundle.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail=f"Not a valid zip file: {exc}")

    names = zf.namelist()

    # Determine bundle prefix: support flat root or single top-level dir.
    # worker.yml can be at "worker.yml" or "<dir>/worker.yml"
    prefix = ""
    if "worker.yml" not in names:
        # Try single-dir layout: all paths share the same top-level dir
        top_dirs = {n.split("/")[0] for n in names if "/" in n}
        if len(top_dirs) == 1:
            candidate = f"{next(iter(top_dirs))}/worker.yml"
            if candidate in names:
                prefix = next(iter(top_dirs)) + "/"
    if not prefix and "worker.yml" not in names:
        raise HTTPException(
            status_code=400,
            detail="Bundle must contain worker.yml at root or inside a single top-level directory",
        )

    worker_yml_path_in_zip = f"{prefix}worker.yml"
    worker_yml = zf.read(worker_yml_path_in_zip).decode("utf-8")

    worker_id, config = _parse_worker_payload(worker_yml)

    target_dir = WORKERS_DIR / worker_id
    if target_dir.exists():
        raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")

    # Extract all files under the prefix into target_dir
    target_dir.mkdir(parents=True, exist_ok=False)
    try:
        for zip_name in names:
            if not zip_name.startswith(prefix):
                continue
            rel = zip_name[len(prefix):]
            if not rel or rel.endswith("/"):
                continue  # skip directories
            # Guard against path traversal
            parts = rel.split("/")
            if any(p in ("", "..") for p in parts):
                raise HTTPException(status_code=400, detail=f"Invalid path in bundle: {rel!r}")
            dest = target_dir
            for part in parts[:-1]:
                dest = dest / part
                dest.mkdir(exist_ok=True)
            (dest / parts[-1]).write_bytes(zf.read(zip_name))
    except HTTPException:
        import shutil
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    except Exception as exc:
        import shutil
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"Failed to extract bundle: {exc}") from exc

    # Ensure run.py exists (stub if absent)
    run_py_path = target_dir / "run.py"
    if not run_py_path.exists():
        run_py_path.write_text(
            "from typing import Dict, Any\n\n"
            "def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:\n"
            "    return {'status': 'success', 'outputs': {}, 'artifacts': []}\n"
        )

    # Ensure requirements.txt exists
    req_path = target_dir / "requirements.txt"
    if not req_path.exists():
        req_path.write_text("")

    # Register
    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers)
        except RuntimeError as exc:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            invalidate_worker_cache()
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    return get_worker_detail(worker_id)


@app.put("/workers/{worker_id}", response_model=WorkerDetail)
def update_worker(worker_id: str, payload: WorkerCreateRequest) -> WorkerDetail:
    """Update an existing worker from YAML + Python source."""
    from worker_registry import WORKERS_DIR

    parsed_worker_id, _config = _parse_worker_payload(payload.worker_yml)
    if parsed_worker_id != worker_id:
        raise HTTPException(
            status_code=400,
            detail=f"worker_yml name {parsed_worker_id!r} does not match path worker_id {worker_id!r}",
        )

    target_dir = WORKERS_DIR / worker_id
    if not target_dir.exists():
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = target_dir / "worker.yml"
    run_py_path = target_dir / "run.py"
    requirements_path = target_dir / "requirements.txt"
    skill_path = target_dir / "SKILL.md"
    old_worker_yml = worker_yml_path.read_text() if worker_yml_path.exists() else None
    old_run_py = run_py_path.read_text() if run_py_path.exists() else None
    had_requirements = requirements_path.exists()
    old_skill = skill_path.read_text() if skill_path.exists() else None

    worker_yml_path.write_text(payload.worker_yml)
    run_py_path.write_text(payload.run_py)
    if not requirements_path.exists():
        requirements_path.write_text("")
    if payload.skill_md:
        skill_path.write_text(payload.skill_md)
    elif not skill_path.exists():
        skill_path.write_text(
            f"# {_config.name}\n\n"
            "This WorkerContract entrypoint is a placeholder for the markdown skill runtime. "
            "Current Workeros execution uses `exec.command` from `worker.yml`.\n"
        )

    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers)
        except RuntimeError as exc:
            if old_worker_yml is not None:
                worker_yml_path.write_text(old_worker_yml)
            if old_run_py is not None:
                run_py_path.write_text(old_run_py)
            if not had_requirements and requirements_path.exists():
                requirements_path.unlink()
            if old_skill is not None:
                skill_path.write_text(old_skill)
            elif skill_path.exists():
                skill_path.unlink()
            invalidate_worker_cache()
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    return get_worker_detail(worker_id)


# ---------------------------------------------------------------------------
# PUT /workers/{worker_id}/files — bulk file replacement (atomic)
# ---------------------------------------------------------------------------

class WorkerFilePatch(BaseModel):
    path: str
    content: str


class WorkerFilesUpdateRequest(BaseModel):
    files: List[WorkerFilePatch]


def _validate_worker_file_path(path: str) -> None:
    """Raise HTTPException if the path is invalid or contains traversal sequences."""
    if not path or not path.strip():
        raise HTTPException(status_code=400, detail="file path must not be empty")
    parts = Path(path).parts
    for part in parts:
        if part in ("", ".."):
            raise HTTPException(status_code=400, detail=f"file path contains invalid segment: {path!r}")
    if path.startswith("/") or "\\" in path:
        raise HTTPException(status_code=400, detail=f"file path must be relative: {path!r}")


@app.put("/workers/{worker_id}/files", response_model=WorkerDetail)
def update_worker_files(worker_id: str, payload: WorkerFilesUpdateRequest) -> WorkerDetail:
    """Replace all files in a worker's directory atomically.

    Accepts a list of {path, content} objects and writes them to disk.
    The write is atomic: files are written to a temp directory first, then
    swapped in. If any validation fails, the worker directory is left untouched.

    Path traversal is blocked: paths containing '..' segments or absolute paths
    are rejected with 400.
    """
    from worker_registry import WORKERS_DIR

    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    target_dir = WORKERS_DIR / worker_id
    if not target_dir.is_dir():
        raise HTTPException(status_code=404, detail="Worker directory not found")

    if not payload.files:
        raise HTTPException(status_code=400, detail="files list must not be empty")

    # Validate all paths upfront before touching the filesystem
    seen_paths: set = set()
    for item in payload.files:
        _validate_worker_file_path(item.path)
        if item.path in seen_paths:
            raise HTTPException(status_code=400, detail=f"duplicate file path: {item.path!r}")
        seen_paths.add(item.path)

    # Must include worker.yml
    if "worker.yml" not in seen_paths:
        raise HTTPException(status_code=400, detail="files must include worker.yml")

    # Validate worker.yml is parseable
    yml_item = next(f for f in payload.files if f.path == "worker.yml")
    parsed_worker_id, _config = _parse_worker_payload(yml_item.content)
    if parsed_worker_id != worker_id:
        raise HTTPException(
            status_code=400,
            detail=f"worker.yml name {parsed_worker_id!r} does not match path worker_id {worker_id!r}",
        )

    # Atomic write strategy:
    #   1. Write all new file contents to a temp staging dir (same filesystem).
    #   2. Back up existing files by renaming them to .bak paths.
    #   3. Move staged files into the target dir.
    #   4. On success: remove backups. On failure: restore backups.
    #
    # This keeps the worker_id directory in place throughout, avoiding the
    # FK constraint issues that arise when the directory is renamed away and
    # re-discovered with a different skill_version_id.
    import shutil

    tmp_dir: Optional[Path] = None
    backed_up: List[tuple] = []  # list of (original_path, backup_path)

    try:
        # Stage new files to a temp dir
        tmp_dir = WORKERS_DIR / f".{worker_id}.tmp.{os.getpid()}"
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir)
        tmp_dir.mkdir(parents=True)

        for item in payload.files:
            dest = tmp_dir / item.path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(item.content, encoding="utf-8")

        # Remove any existing files NOT in the new payload (keep backups)
        existing_files = list(target_dir.rglob("*"))
        new_paths = {item.path for item in payload.files}
        for existing in existing_files:
            if not existing.is_file():
                continue
            try:
                rel = existing.relative_to(target_dir).as_posix()
            except ValueError:
                continue
            if rel not in new_paths and not _should_ignore_worker_file(rel):
                bak = existing.with_suffix(existing.suffix + f".bak{os.getpid()}")
                existing.rename(bak)
                backed_up.append((existing, bak))

        # Write new files from staging dir into target dir, backing up existing ones
        for item in payload.files:
            dest = target_dir / item.path
            if dest.exists():
                bak = dest.with_suffix(dest.suffix + f".bak{os.getpid()}")
                dest.rename(bak)
                backed_up.append((dest, bak))
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(tmp_dir / item.path, dest)

        # Reload registry and re-persist only this worker to avoid FK conflicts
        # with other workers in a shared DB environment.
        invalidate_worker_cache()
        workers = discover_workers()
        this_worker_list = [w for w in workers if w["id"] == worker_id]
        if not this_worker_list:
            raise HTTPException(status_code=500, detail=f"Worker {worker_id!r} not found after update")
        with get_db() as conn:
            try:
                _persist_discovered_workers(conn, this_worker_list)
            except RuntimeError as exc:
                # Roll back: restore backups
                for orig, bak in reversed(backed_up):
                    try:
                        if orig.exists():
                            orig.unlink()
                        bak.rename(orig)
                    except Exception:
                        pass
                invalidate_worker_cache()
                raise HTTPException(status_code=502, detail=str(exc)) from exc

        # Remove backups on success
        for _orig, bak in backed_up:
            bak.unlink(missing_ok=True)
        backed_up.clear()

        return get_worker_detail(worker_id)

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("update_worker_files failed for %s", worker_id)
        # Restore backups on unexpected error
        for orig, bak in reversed(backed_up):
            try:
                if orig.exists():
                    orig.unlink()
                bak.rename(orig)
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"Failed to update worker files: {exc}") from exc
    finally:
        if tmp_dir is not None and tmp_dir.exists():
            try:
                shutil.rmtree(tmp_dir)
            except Exception:
                pass


@app.post("/workers/reload", response_model=ReloadResponse)
def reload_workers() -> ReloadResponse:
    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    return ReloadResponse(status="success", workers_loaded=len(workers))


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

@app.post("/workers/{worker_id}/runs", response_model=ActionResponse)
def create_worker_run(worker_id: str, payload: RunCreate, request: Request) -> ActionResponse:
    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    # P1-2: Validate required inputs at the request boundary before creating a run row.
    # Use the same WorkerConfig the runner will see — get_worker_config_for_run resolves
    # both DB-backed and filesystem-discovered workers into the same shape.
    run_config = get_worker_config_for_run(worker_id)
    if run_config is not None:
        declared_inputs = getattr(run_config, "inputs", []) or []
        missing = [
            inp.name for inp in declared_inputs
            if getattr(inp, "required", False)
            and (inp.name not in payload.inputs or payload.inputs.get(inp.name) in (None, ""))
        ]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Missing required inputs: {', '.join(missing)}",
            )

    # Create the run record first so we have a run_id for per-run file staging.
    run_id = create_run(worker_id, payload.inputs, payload.trigger_source)
    bound_by = request.headers.get("x-floom-user") or "anonymous"
    try:
        resolved_inputs = _resolve_file_input_references(
            worker_id, run_id, payload.inputs, bound_by=bound_by
        )
    except HTTPException as exc:
        update_run_status(run_id, RunStatus.FAILED.value, error=str(exc.detail))
        raise
    except Exception as exc:
        update_run_status(run_id, RunStatus.FAILED.value, error=str(exc))
        raise
    # Persist resolved inputs (absolute file paths replace SHA values) so that
    # GET /runs/:id returns the staged paths, not raw SHA strings.
    with get_db() as conn:
        conn.execute(
            "UPDATE runs SET input_json = ? WHERE id = ?",
            (json.dumps(resolved_inputs), run_id),
        )
    start_run(run_id, worker_id, resolved_inputs)
    return ActionResponse(status="running", run_id=run_id)


@app.post("/workers/{worker_id}/runs/{run_id}/replay")
def replay_run(worker_id: str, run_id: str) -> Dict[str, str]:
    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    with get_db() as conn:
        row = conn.execute(
            "SELECT input_json FROM runs WHERE id = ? AND worker_id = ?",
            (run_id, worker_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")

    source_inputs = json.loads(row["input_json"] or "{}")
    replay_inputs = json.loads(json.dumps(source_inputs))
    new_run_id = create_run(worker_id, replay_inputs, trigger_source="manual")
    start_run(new_run_id, worker_id, replay_inputs)
    return {"run_id": new_run_id}


@app.get("/runs", response_model=List[RunSummary])
def list_runs(
    response: Response,
    worker_id: Optional[str] = None,
    status: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> List[RunSummary]:
    statuses = _resolve_run_status_filters(status)
    since_dt = _parse_iso8601(since) if since else None
    if since and since_dt is None:
        raise HTTPException(status_code=400, detail="Invalid since value")
    until_dt = _parse_iso8601(until) if until else None
    if until and until_dt is None:
        raise HTTPException(status_code=400, detail="Invalid until value")
    if since_dt and until_dt and since_dt > until_dt:
        raise HTTPException(status_code=400, detail="since must be before until")

    with get_db() as conn:
        cursor = conn.cursor()
        select_clause = """
            SELECT r.id, r.worker_id,
                   COALESCE(
                       JSON_EXTRACT(sv.manifest_json, '$.title'),
                       w.name
                   ) as worker_name,
                   r.status,
                   r.trigger_source, r.created_at,
                   r.started_at, r.completed_at, r.duration_ms, r.error
            FROM runs r
            LEFT JOIN workers w ON r.worker_id = w.id
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE 1=1
        """
        params: list[Any] = []
        if worker_id:
            select_clause += " AND r.worker_id = ?"
            params.append(worker_id)
        if statuses:
            placeholders = ", ".join(["?"] * len(statuses))
            select_clause += f" AND r.status IN ({placeholders})"
            params.extend(statuses)
        if since_dt:
            select_clause += " AND r.created_at >= ?"
            params.append(since_dt.isoformat())
        if until_dt:
            select_clause += " AND r.created_at <= ?"
            params.append(until_dt.isoformat())

        count_query = f"SELECT COUNT(*) AS total FROM ({select_clause}) AS filtered_runs"
        total_count = conn.execute(count_query, tuple(params)).fetchone()["total"]

        query = f"{select_clause} ORDER BY r.created_at DESC LIMIT ? OFFSET ?"
        query_params = [*params, limit, offset]
        cursor.execute(query, tuple(query_params))
        rows = cursor.fetchall()
    response.headers["X-Total-Count"] = str(int(total_count or 0))
    return [_make_run_summary(r) for r in rows]


@app.post("/runs/clear")
def clear_runs(confirm: str = Query("", description="Must be 'yes-wipe-all-runs' to proceed.")):
    """Wipe all run history.

    Destructive operation. Requires explicit `?confirm=yes-wipe-all-runs`
    query param to proceed. A May 2026 audit accidentally deleted 256 runs
    by hitting this endpoint with just the platform secret. The confirmation
    string makes the destructive intent explicit and prevents accidental
    invocation by API explorers.
    """
    if confirm != "yes-wipe-all-runs":
        raise HTTPException(
            status_code=400,
            detail=(
                "Destructive endpoint. Append ?confirm=yes-wipe-all-runs to "
                "proceed. This wipes every run, log, and artifact record."
            ),
        )
    with get_db() as conn:
        cursor = conn.execute("SELECT COUNT(*) AS n FROM runs")
        row = cursor.fetchone()
        deleted_count = int(row["n"]) if row else 0
        conn.execute("DELETE FROM artifacts")
        conn.execute("DELETE FROM logs")
        conn.execute("DELETE FROM runs")
    logger.warning("All run history cleared (%d runs deleted)", deleted_count)
    return {"status": "cleared", "deleted_runs": deleted_count}


_TERMINAL_RUN_STATUSES = frozenset({"completed", "failed"})


@app.post("/runs/{run_id}/cancel", response_model=ActionResponse)
def cancel_run(run_id: str) -> ActionResponse:
    """Request cancellation of an in-flight run.

    Sets cancel_requested=1 on the run row. The runner respects this between
    iterations (AgentDriver) or on the next status write (other drivers).
    Returns 404 if no such run, 409 if already terminal, 200 if cancellation
    was recorded (idempotent).
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT status, cancel_requested FROM runs WHERE id = ?", (run_id,))
        row = cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Run not found")
        if row["status"] in _TERMINAL_RUN_STATUSES:
            raise HTTPException(status_code=409, detail=f"Run already {row['status']}")
        conn.execute(
            "UPDATE runs SET cancel_requested = 1, cancelled_at = ? WHERE id = ?",
            (now_iso(), run_id),
        )
    logger.info("Cancel requested for run %s", run_id)
    return ActionResponse(status="cancel_requested", run_id=run_id)


@app.get("/runs/{run_id}/download")
def download_run_bundle(run_id: str):
    with get_db() as conn:
        run_row = conn.execute(
            "SELECT id, input_json, output_json FROM runs WHERE id = ?",
            (run_id,),
        ).fetchone()
        if not run_row:
            raise HTTPException(status_code=404, detail="Run not found")
        log_rows = conn.execute(
            "SELECT timestamp, level, message FROM logs WHERE run_id = ? ORDER BY timestamp",
            (run_id,),
        ).fetchall()
        artifact_rows = conn.execute(
            "SELECT name, path FROM artifacts WHERE run_id = ? ORDER BY created_at, name",
            (run_id,),
        ).fetchall()

    input_payload = json.loads(run_row["input_json"] or "{}")
    output_payload = json.loads(run_row["output_json"] or "{}")
    if not isinstance(input_payload, dict):
        input_payload = {}
    if not isinstance(output_payload, dict):
        output_payload = {}

    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("inputs.json", json.dumps(input_payload, indent=2, sort_keys=True))
        archive.writestr("outputs.json", json.dumps(output_payload, indent=2, sort_keys=True))

        primary_output = _extract_primary_output_file(output_payload)
        if primary_output:
            output_name, output_bytes = primary_output
            archive.writestr(output_name, output_bytes)

        log_lines = []
        for row in log_rows:
            ts = row["timestamp"] or ""
            level = (row["level"] or "info").upper()
            msg = row["message"] or ""
            log_lines.append(f"[{ts}] {level} {msg}")
        archive.writestr("logs.txt", "\n".join(log_lines))

        from runner_utils import ARTIFACTS_DIR

        artifacts_root = ARTIFACTS_DIR.resolve()
        for row in artifact_rows:
            path_value = row["path"] or ""
            try:
                resolved = Path(path_value).resolve()
                resolved.relative_to(artifacts_root)
            except Exception:
                continue
            if not resolved.is_file():
                continue
            artifact_name = _sanitize_download_name(str(row["name"] or resolved.name))
            with resolved.open("rb") as handle:
                archive.writestr(f"artifacts/{artifact_name}", handle.read())

    archive_buffer.seek(0)
    short_id = run_id.split("_", 1)[-1][:8] or run_id[:8]
    filename = f"run-{_sanitize_download_name(short_id)}.zip"
    return StreamingResponse(
        archive_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/runs/{run_id}/bundle/{filename:path}")
def get_run_bundle_file(run_id: str, filename: str):
    with get_db() as conn:
        row = conn.execute(
            "SELECT bundle_snapshot_path FROM runs WHERE id = ?",
            (run_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    snapshot_path = row["bundle_snapshot_path"]
    if not snapshot_path:
        raise HTTPException(status_code=410, detail="Bundle snapshot is not available for this run")

    base_dir = (Path(DB_PATH).resolve().parent / snapshot_path).resolve()
    try:
        target = (base_dir / filename).resolve()
        target.relative_to(base_dir)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid bundle path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Bundle file not found")

    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return FileResponse(path=target, media_type=media_type)


@app.get("/runs/{run_id}/artifacts/{artifact_id}/download")
def download_artifact(run_id: str, artifact_id: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM artifacts WHERE id = ? AND run_id = ?",
            (artifact_id, run_id),
        )
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Artifact not found")

    art = row_to_dict(row)
    path_str = art["path"]

    from runner_utils import ARTIFACTS_DIR
    from pathlib import Path
    try:
        artifacts_dir = ARTIFACTS_DIR.resolve()
        resolved = Path(path_str).resolve()
    except Exception:
        raise HTTPException(status_code=403, detail="Invalid path")

    try:
        resolved.relative_to(artifacts_dir)
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found on disk")

    content_type, _ = mimetypes.guess_type(art["name"])
    content_type = content_type or "application/octet-stream"
    filename = (
        str(art["name"])
        .replace("\\", "_")
        .replace('"', "_")
        .replace("\r", "_")
        .replace("\n", "_")
    )

    def iter_file():
        with open(resolved, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        iter_file(),
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/runs/{run_id}", response_model=RunDetail)
def get_run(run_id: str) -> RunDetail:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT r.id, r.worker_id,
                   COALESCE(
                       JSON_EXTRACT(sv.manifest_json, '$.title'),
                       w.name
                   ) as worker_name,
                   r.status, r.trigger_source, r.runner,
                   r.input_json, r.output_json, r.error,
                   r.started_at, r.completed_at, r.duration_ms, r.created_at
            FROM runs r
            LEFT JOIN workers w ON r.worker_id = w.id
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE r.id = ?
            """,
            (run_id,),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Run not found")

        run = row_to_dict(row)
        run["input"] = json.loads(run.get("input_json") or "{}")
        run["output"] = json.loads(run.get("output_json") or "{}")
        # Build typed output schema from worker config
        output_config = get_worker_config_for_run(run["worker_id"])
        output_schema = []
        if output_config:
            raw_output = run["output"]
            for out in output_config.outputs:
                output_schema.append(OutputField(
                    name=out.name,
                    label=out.label,
                    type=out.type,
                    value=raw_output.get(out.name),
                ))

        cursor.execute(
            """
            SELECT level, message, timestamp, trace_id
            FROM logs WHERE run_id = ? ORDER BY timestamp
            """,
            (run_id,),
        )
        logs = [
            LogEntry(level=r["level"], message=r["message"], timestamp=r["timestamp"], trace_id=row_to_dict(r).get("trace_id"))
            for r in cursor.fetchall()
        ]

        cursor.execute(
            "SELECT * FROM artifacts WHERE run_id = ?",
            (run_id,),
        )
        artifacts = [
            Artifact(
                id=r["id"], run_id=r["run_id"], name=r["name"],
                type=row_to_dict(r).get("type"), path=r["path"],
                size_bytes=row_to_dict(r).get("size_bytes"), created_at=r["created_at"],
            )
            for r in cursor.fetchall()
        ]
        transcript = _read_transcript_rows(run["runner"], artifacts)

    return RunDetail(
        id=run["id"],
        worker_id=run["worker_id"],
        status=RunStatus(run["status"]),
        trigger_source=run["trigger_source"],
        runner=run["runner"],
        input=run["input"],
        output=run["output"],
        output_schema=output_schema,
        logs=logs,
        artifacts=artifacts,
        transcript=transcript,
        error=run.get("error"),
        started_at=run.get("started_at"),
        completed_at=run.get("completed_at"),
        duration_ms=run.get("duration_ms"),
        created_at=run.get("created_at"),
    )


@app.get("/runs/{run_id}/events")
async def stream_run_events(run_id: str, request: Request):
    """Server-Sent Events stream for a single run.

    Emits one ``data: <json>\\n\\n`` line per state change: status updates,
    log lines, artifact additions.

    Closes automatically when the run reaches a terminal state (completed,
    failed, approved, rejected).

    Memory management:
    - Queue is registered in _sse_queues when consumer connects.
    - Queue is removed in _sse_cleanup when consumer disconnects or run ends.
    - If run is already terminal when client connects, current state is emitted
      immediately then the stream closes.
    """
    # Check run exists
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, status FROM runs WHERE id = ?", (run_id,))
        run_row = cursor.fetchone()
    if not run_row:
        raise HTTPException(status_code=404, detail="Run not found")

    initial_status = run_row["status"]
    already_terminal = initial_status in _TERMINAL_STATUSES

    async def event_generator():
        q: asyncio.Queue = asyncio.Queue(maxsize=512)

        # If run already terminal, emit current state and close immediately
        if already_terminal:
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT id, worker_id, status, error, completed_at FROM runs WHERE id = ?",
                    (run_id,),
                )
                final_row = cursor.fetchone()
            if final_row:
                evt = {
                    "type": "status",
                    "run_id": run_id,
                    "status": final_row["status"],
                    "error": final_row["error"],
                    "completed_at": final_row["completed_at"],
                }
                yield f"data: {json.dumps(evt)}\n\n"
            yield "data: {\"type\": \"close\"}\n\n"
            return

        # Register the consumer queue with its bound event loop
        loop = asyncio.get_running_loop()
        with _sse_lock:
            _sse_queues.setdefault(run_id, []).append((q, loop))

        try:
            while True:
                # Check for client disconnect
                if await request.is_disconnected():
                    break

                try:
                    event = await asyncio.wait_for(q.get(), timeout=5.0)
                except asyncio.TimeoutError:
                    # Send keepalive comment
                    yield ": keepalive\n\n"
                    continue

                yield f"data: {json.dumps(event)}\n\n"

                # Close stream if run reached terminal state
                evt_type = event.get("type")
                evt_status = event.get("status", "")
                if evt_type == "close" or evt_status in _TERMINAL_STATUSES:
                    break
        finally:
            _sse_cleanup(run_id, q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/runs/{run_id}/logs", response_model=List[LogEntry])
def get_run_logs(run_id: str) -> List[LogEntry]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM runs WHERE id = ?", (run_id,))
        if cursor.fetchone() is None:
            raise HTTPException(status_code=404, detail="Run not found")
        cursor.execute(
            """
            SELECT level, message, timestamp, trace_id
            FROM logs WHERE run_id = ? ORDER BY timestamp
            """,
            (run_id,),
        )
        rows = cursor.fetchall()
    return [
        LogEntry(level=r["level"], message=r["message"], timestamp=r["timestamp"], trace_id=row_to_dict(r).get("trace_id"))
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Secrets — CRUD + test
# ---------------------------------------------------------------------------

# Path to the .env file used by the API
_ENV_PATH = Path(__file__).parent / ".env"


class SecretUpsertRequest(BaseModel):
    value: str


class SecretTestResult(BaseModel):
    status: str  # "valid" | "invalid"
    reason: Optional[str] = None


def _read_env_lines() -> list[str]:
    """Read .env lines; return [] if file does not exist."""
    if not _ENV_PATH.exists():
        return []
    with open(_ENV_PATH, "r") as f:
        return f.readlines()


def _write_env_lines(lines: list[str]) -> None:
    """Atomically write .env lines with fcntl lock."""
    _ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_ENV_PATH, "a+") as lock_fd:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            with open(_ENV_PATH, "w") as f:
                f.writelines(lines)
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)


def _upsert_env_var(name: str, value: str) -> None:
    """Set or replace NAME=value in the .env file, then reload into os.environ."""
    # Validate name is a legal env var identifier
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError(f"Invalid secret name: {name!r}")
    # Reject values that contain newline or null bytes — they corrupt the .env
    # file by injecting extra lines (newline injection attack).
    if any(c in value for c in ("\n", "\r", "\x00")):
        raise ValueError(
            "Secret value must not contain newline or null characters"
        )

    lines = _read_env_lines()
    new_line = f"{name}={value}\n"
    replaced = False
    new_lines: list[str] = []
    for line in lines:
        stripped = line.rstrip("\n")
        if stripped.startswith(f"{name}=") or stripped == name:
            new_lines.append(new_line)
            replaced = True
        else:
            new_lines.append(line)
    if not replaced:
        # Ensure trailing newline before appending
        if new_lines and not new_lines[-1].endswith("\n"):
            new_lines[-1] += "\n"
        new_lines.append(new_line)
    _write_env_lines(new_lines)
    # Reload in-process so workers immediately see the new value
    os.environ[name] = value


def _delete_env_var(name: str) -> bool:
    """Remove NAME from .env and os.environ. Returns True if it was present."""
    lines = _read_env_lines()
    new_lines = [
        line for line in lines
        if not (line.rstrip("\n").startswith(f"{name}=") or line.rstrip("\n") == name)
    ]
    removed = len(new_lines) < len(lines)
    if removed:
        _write_env_lines(new_lines)
    os.environ.pop(name, None)
    return removed


@app.post("/secrets/{name}", response_model=SecretTestResult)
def upsert_secret(name: str, payload: SecretUpsertRequest) -> SecretTestResult:
    """Create or update a secret. Value is write-only — never returned.

    SECURITY: refuses to overwrite a platform infrastructure secret. A
    May 2026 audit found that POST /secrets/FLOOM_SECRET would happily
    overwrite the running process's FLOOM_SECRET env var, locking the
    owner out immediately. Platform secrets are managed via systemd
    EnvironmentFile, not the user-secrets API.
    """
    if name in PLATFORM_SECRETS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{name!r} is a platform infrastructure secret managed via "
                "the server's environment file. It cannot be set via the "
                "secrets API. See ARCHITECTURE.md."
            ),
        )
    try:
        _upsert_env_var(name, payload.value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Refresh DB record
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO secrets (name, status, created_at, updated_at)
            VALUES (?, 'set', ?, ?)
            ON CONFLICT(name) DO UPDATE SET status='set', updated_at=excluded.updated_at
            """,
            (name, now_iso(), now_iso()),
        )
    logger.info("Secret %s upserted", name)
    return SecretTestResult(status="valid", reason=f"Secret {name!r} saved.")


@app.delete("/secrets/{name}", response_model=SecretTestResult)
def delete_secret(name: str) -> SecretTestResult:
    """Delete a secret from .env and env.

    SECURITY: refuses to delete a platform infrastructure secret for the
    same reason as upsert_secret.
    """
    if name in PLATFORM_SECRETS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{name!r} is a platform infrastructure secret. It cannot "
                "be deleted via the secrets API."
            ),
        )
    removed = _delete_env_var(name)
    with get_db() as conn:
        conn.execute("DELETE FROM secrets WHERE name = ?", (name,))
    if not removed:
        raise HTTPException(status_code=404, detail=f"Secret {name!r} not found in .env")
    logger.info("Secret %s deleted", name)
    return SecretTestResult(status="valid", reason=f"Secret {name!r} removed.")


@app.post("/secrets/{name}/test", response_model=SecretTestResult)
def test_secret(name: str) -> SecretTestResult:
    """Test a secret. For OPENAI_API_KEY: does a 1-token completion. Others: confirms env var is set."""
    value = os.environ.get(name)
    if not value:
        return SecretTestResult(status="invalid", reason=f"{name} is not set in the environment.")

    if name == "OPENAI_API_KEY":
        try:
            import openai
            client = openai.OpenAI(api_key=value)
            resp = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
            )
            _ = resp.choices[0].message.content
            return SecretTestResult(status="valid", reason="OpenAI API key is valid (1-token ping succeeded).")
        except Exception as exc:
            return SecretTestResult(status="invalid", reason=f"OpenAI API key test failed: {exc}")

    # Generic: secret is set
    return SecretTestResult(
        status="valid",
        reason=f"{name} is set ({len(value)} chars). No additional test available for this secret type.",
    )


# ---------------------------------------------------------------------------
# Platform secrets — infra vars that belong in Settings, NOT the secrets UI
# ---------------------------------------------------------------------------

class PlatformSecretSpec(TypedDict):
    name: str
    required: bool
    default: Optional[str]
    description: Optional[str]


PLATFORM_SECRET_SPECS: list[PlatformSecretSpec] = [
    {
        "name": "OPENAI_API_KEY",
        "required": True,
        "default": None,
        "description": "OpenAI API key, used by the platform for prompt-to-worker drafting and any worker that calls OpenAI",
    },
    {
        "name": "E2B_API_KEY",
        "required": True,
        "default": None,
        "description": "E2B sandbox API key",
    },
    {
        "name": "COMPOSIO_API_KEY",
        "required": True,
        "default": None,
        "description": "Composio API key for the connections backend",
    },
    {
        "name": "COMPOSIO_WEBHOOK_SIGNING_KEY",
        "required": True,
        "default": None,
        "description": "HMAC key for verifying Composio webhook deliveries",
    },
    {
        "name": "FLOOM_SECRET",
        "required": True,
        "default": None,
        "description": "Shared secret for x-floom-secret auth",
    },
    {
        "name": "WORKERS_FRONTEND_URL",
        "required": True,
        "default": None,
        "description": "Base URL for OAuth callbacks (e.g. https://workers.floom.dev)",
    },
]

# Infrastructure/filesystem config vars shown in a separate section on /settings.
# Not secrets: no values, just paths and tuning params.
INFRA_PATH_SPECS: list[PlatformSecretSpec] = [
    {
        "name": "FLOOM_DB",
        "required": False,
        "default": "../../data/floom.db",
        "description": "SQLite DB path",
    },
    {
        "name": "FLOOM_WORKERS_DIR",
        "required": False,
        "default": "../../workers",
        "description": "Workers directory",
    },
    {
        "name": "FLOOM_ARTIFACTS_DIR",
        "required": False,
        "default": "../../data/artifacts",
        "description": "Artifacts directory",
    },
    {
        "name": "FLOOM_RUN_TIMEOUT",
        "required": False,
        "default": "300",
        "description": "Default run timeout in seconds",
    },
]

# Set of platform secret names for fast membership checks (used in list_secrets filtering)
PLATFORM_SECRETS: frozenset[str] = frozenset(s["name"] for s in PLATFORM_SECRET_SPECS)


@app.get("/secrets", response_model=List[SecretItem])
def list_secrets() -> List[SecretItem]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name, status, last_used_at, last_checked_at, last_check_status "
            "FROM secrets ORDER BY name"
        )
        db_secrets = {r["name"]: row_to_dict(r) for r in cursor.fetchall()}

    workers = _list_db_workers() or discover_workers(use_cache=True)

    # (a) All secrets declared by any worker.yml
    worker_secret_names: set[str] = set()
    for w in workers:
        config = get_worker_config_for_run(w["id"])
        if config:
            worker_secret_names.update(config.secrets)

    # (b) All keys present in the .env file (user-added secrets not yet referenced by a worker)
    env_secret_names: set[str] = set()
    for line in _read_env_lines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key:
                env_secret_names.add(key)

    # Filter out platform-managed secrets — they appear in Settings, not here
    all_secret_names = (worker_secret_names | env_secret_names) - PLATFORM_SECRETS

    result: List[SecretItem] = []
    for name in sorted(all_secret_names):
        value = os.environ.get(name)
        status = SecretStatus.SET if value else SecretStatus.MISSING
        used_by = []
        for w in workers:
            config = get_worker_config_for_run(w["id"])
            if config and name in config.secrets:
                used_by.append(w["name"])

        with get_db() as conn:
            now = now_iso()
            conn.execute(
                """
                INSERT INTO secrets (name, status, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (name, status.value, now, now),
            )

        db_row = db_secrets.get(name, {})
        result.append(
            SecretItem(
                name=name,
                status=status,
                last_used_at=db_row.get("last_used_at"),
                last_checked_at=db_row.get("last_checked_at"),
                last_check_status=db_row.get("last_check_status"),
                used_by=used_by,
            )
        )
    return result


# ---------------------------------------------------------------------------
# Connections (Composio OAuth)
# ---------------------------------------------------------------------------

class ConnectionInitRequest(BaseModel):
    app_name: str


class ConnectionItem(BaseModel):
    id: str
    app_name: str
    composio_connection_id: str
    status: str
    created_at: str
    updated_at: str
    scopes: List[str] = []
    account_label: Optional[str] = None
    display_name: Optional[str] = None
    last_checked_at: Optional[str] = None
    last_check_status: Optional[str] = None


class ConnectionTestResult(BaseModel):
    status: str  # "valid" | "failed" | "expired"
    reason: str
    tested_at: str


class ConnectionInitResponse(BaseModel):
    id: str
    app_name: str
    redirect_url: str
    composio_connection_id: str


class IntegrationCatalogItem(BaseModel):
    slug: str
    name: str
    logo_url: str
    description: str
    categories: List[str]
    tools_count: int = 0
    triggers_count: int = 0


class IntegrationCatalogResponse(BaseModel):
    items: List[IntegrationCatalogItem]
    page: int
    limit: int
    total_items: int
    total_pages: int
    next_page: Optional[int] = None
    categories: List[str] = []


def _get_callback_url() -> str:
    """Build the OAuth callback URL for Composio to redirect to."""
    base = os.environ.get("WORKERS_FRONTEND_URL", "https://workers.floom.dev")
    return f"{base}/connections/callback"


@app.get("/integrations/catalog", response_model=IntegrationCatalogResponse)
def integrations_catalog(
    page: int = Query(1, ge=1),
    limit: int = Query(30, ge=1, le=100),
    search: str = Query("", max_length=120),
    category: str = Query("", max_length=200),
) -> IntegrationCatalogResponse:
    """Return the integration catalog, with optional comma-separated category OR-filter.

    When ``category`` contains multiple comma-separated slugs, results from each
    slug are fetched separately and merged (union, de-duplicated by app slug).
    """
    from composio_client import list_catalog_apps

    # Split comma-separated categories for OR-merge support.
    category_slugs = [s.strip() for s in category.split(",") if s.strip()] if category.strip() else []

    try:
        if len(category_slugs) <= 1:
            # Simple path: single category or no category.
            single_category = category_slugs[0] if category_slugs else ""
            result = list_catalog_apps(
                page=page,
                limit=limit,
                search=search,
                category=single_category,
            )
        else:
            # Multi-category: fetch each slug and merge (de-duplicated by app slug).
            seen: Dict[str, Any] = {}
            for slug in category_slugs:
                try:
                    partial = list_catalog_apps(
                        page=1,
                        limit=100,
                        search=search,
                        category=slug,
                    )
                    for item in partial.get("items") or []:
                        if item["slug"] not in seen:
                            seen[item["slug"]] = item
                except Exception:
                    logger.warning("Failed to fetch category %s from Composio", slug)

            all_items = list(seen.values())
            total_items = len(all_items)
            total_pages = max(1, (total_items + limit - 1) // limit)
            start = (page - 1) * limit
            page_items = all_items[start : start + limit]
            next_page_num = page + 1 if page < total_pages else None
            all_categories = sorted({cat for item in all_items for cat in (item.get("categories") or [])})
            result = {
                "items": page_items,
                "page": page,
                "limit": limit,
                "total_items": total_items,
                "total_pages": total_pages,
                "next_page": next_page_num,
                "categories": all_categories,
            }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to load Composio catalog")
        raise HTTPException(status_code=502, detail=f"Composio catalog error: {exc}") from exc
    return IntegrationCatalogResponse(**result)


def _parse_scopes_json(scopes_json: Optional[str]) -> List[str]:
    """Parse a JSON-encoded scopes list from the DB; return [] on any error."""
    if not scopes_json:
        return []
    try:
        parsed = json.loads(scopes_json)
        if isinstance(parsed, list):
            return [s for s in parsed if isinstance(s, str)]
    except Exception:
        pass
    return []


def _fetch_provider_email(toolkit_slug: str, composio_conn_id: str) -> Optional[str]:
    """Resolve the connected user's email via Composio's tool-execute proxy.

    Composio masks the raw OAuth access_token from `/connected_accounts/<id>`
    (returns only 8 chars), so we cannot call provider userinfo endpoints
    directly. Instead, we invoke a per-toolkit identity tool through Composio's
    /tools/execute proxy; Composio uses the real token server-side and returns
    just the response we asked for. Returns None on any error.

    Verified working for Gmail via GMAIL_GET_PROFILE -> response_data.emailAddress.
    Per-provider tool slug map below; extend as needed.
    """
    import requests as _requests
    PROVIDER_IDENTITY_TOOLS = {
        "gmail": ("GMAIL_GET_PROFILE", lambda d: d.get("emailAddress")),
        "googledrive": ("GOOGLEDRIVE_GET_ABOUT_USER", lambda d: ((d.get("user") or {}).get("emailAddress"))),
        "googlecalendar": ("GOOGLECALENDAR_GET_CURRENT_USER", lambda d: d.get("email")),
        "linkedin": ("LINKEDIN_GET_MY_INFO", lambda d: d.get("email")),
        "hubspot": ("HUBSPOT_GET_OWNER_BY_ID", lambda d: d.get("email")),
        "slack": ("SLACK_USERS_INFO", lambda d: ((d.get("user") or {}).get("profile") or {}).get("email")),
        "github": ("GITHUB_GET_THE_AUTHENTICATED_USER", lambda d: d.get("email") or (d.get("login") and f"{d['login']}@github")),
    }
    spec = PROVIDER_IDENTITY_TOOLS.get(toolkit_slug)
    if not spec:
        return None
    tool_slug, extract = spec
    try:
        key = os.environ.get("COMPOSIO_API_KEY", "")
        if not key:
            return None
        r = _requests.post(
            f"https://backend.composio.dev/api/v3/tools/execute/{tool_slug}",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            json={"connected_account_id": composio_conn_id, "user_id": "federico", "arguments": {}},
            timeout=8,
        )
        if not r.ok:
            return None
        payload = r.json()
        if not payload.get("successful"):
            return None
        # Composio nests the tool output under either "response_data" or
        # "response_dict" depending on the tool implementation. Try both.
        outer = payload.get("data", {}) or {}
        data = (
            outer.get("response_data")
            or outer.get("response_dict")
            or outer
        )
        return extract(data) if isinstance(data, dict) else None
    except Exception as exc:
        logger.debug("provider email fetch failed for %s: %s", toolkit_slug, exc)
    return None


def _fetch_composio_account_info(composio_conn_id: str) -> Dict[str, Any]:
    """Fetch Composio connected-account and return normalized account info.

    Returns a dict with keys: email, scopes, user_id, auth_config_id.
    Returns empty dict on any error.
    """
    import requests as _requests
    base = "https://backend.composio.dev/api/v3"
    try:
        key = os.environ.get("COMPOSIO_API_KEY", "")
        if not key:
            return {}
        r = _requests.get(
            f"{base}/connected_accounts/{composio_conn_id}",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            timeout=10,
        )
        if not r.ok:
            return {}
        data = r.json()
        account = data.get("connected_account") or data
        if not isinstance(account, dict):
            return {}

        email = (
            account.get("email")
            or account.get("account_email")
            or (account.get("connection_data") or {}).get("email")
            or (account.get("data") or {}).get("email")
            or (account.get("metadata") or {}).get("email")
            or (account.get("user") or {}).get("email")
        )
        raw_scopes = account.get("scopes") or []
        if not isinstance(raw_scopes, list):
            raw_scopes = []
        scopes = [s for s in raw_scopes if isinstance(s, str)]
        # Fallback: Composio doesn't return email for managed-OAuth connections
        # and masks the raw access_token, so we cannot call provider userinfo
        # directly. Use Composio's /tools/execute proxy to invoke a per-provider
        # identity tool (e.g. GMAIL_GET_PROFILE) which runs server-side with the
        # real token and returns the email. Cached on the DB row by the caller.
        if not email:
            toolkit_slug = ((account.get("toolkit") or {}).get("slug") or "").lower()
            if toolkit_slug and composio_conn_id:
                email = _fetch_provider_email(toolkit_slug, composio_conn_id)
        return {
            "email": email,
            "scopes": scopes,
            "user_id": account.get("user_id") or account.get("userId"),
            "auth_config_id": (
                (account.get("auth_config") or {}).get("id")
                or account.get("auth_config_id")
            ),
            "status": (account.get("status") or "").lower() or None,
        }
    except Exception as exc:
        logger.warning("Composio account-info fetch failed for %s: %s", composio_conn_id, exc)
        return {}


@app.get("/connections", response_model=List[ConnectionItem])
def list_connections() -> List[ConnectionItem]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, app_name, composio_connection_id, status, created_at, updated_at, "
            "scopes_json, account_label, last_checked_at, last_check_status "
            "FROM composio_connections ORDER BY app_name"
        )
        rows = cursor.fetchall()

    result = []
    for row in rows:
        d = row_to_dict(row)
        d["scopes"] = _parse_scopes_json(d.pop("scopes_json", None))
        result.append(ConnectionItem(**d))
    return result


@app.post("/connections", response_model=ConnectionInitResponse)
def initiate_connection(payload: ConnectionInitRequest) -> ConnectionInitResponse:
    from composio_client import initiate_connection as composio_initiate, NoManagedAuthError
    app_name = payload.app_name.lower().strip()
    if not app_name:
        raise HTTPException(status_code=400, detail="app_name is required")

    callback_url = _get_callback_url()
    try:
        result = composio_initiate(app_name, callback_url)
    except NoManagedAuthError as exc:
        # App does not support Composio-managed OAuth (e.g. API-key-only apps).
        # Return 422 with a prefixed detail string so the frontend can detect it
        # and offer an "Add API key" flow instead.
        raise HTTPException(
            status_code=422,
            detail=f"api_key_only: {exc}",
        ) from exc
    except Exception as exc:
        logger.exception("Failed to initiate Composio connection for %s", app_name)
        raise HTTPException(status_code=502, detail=f"Composio error: {exc}") from exc

    composio_conn_id = result["composio_connection_id"]
    redirect_url = result["redirect_url"]

    # Always insert a new row — multiple accounts per app are allowed.
    # Each Composio connected_account is a distinct row identified by its own UUID.
    conn_id = str(_uuid_mod.uuid4())
    now = now_iso()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO composio_connections (id, app_name, composio_connection_id, status, created_at, updated_at) "
            "VALUES (?, ?, ?, 'initiated', ?, ?)",
            (conn_id, app_name, composio_conn_id, now, now),
        )

    return ConnectionInitResponse(
        id=conn_id,
        app_name=app_name,
        redirect_url=redirect_url,
        composio_connection_id=composio_conn_id,
    )


@app.get("/connections/callback")
def connections_callback(connection_id: str = "", status: str = ""):
    """OAuth callback landing — Composio redirects here after user authorizes.

    Composio sends: ?connection_id=<composio_conn_id>&status=<status>
    We update the local DB and redirect the user to /connections.
    """
    from fastapi.responses import RedirectResponse

    if connection_id:
        with get_db() as conn:
            existing = conn.execute(
                "SELECT status FROM composio_connections WHERE composio_connection_id = ?",
                (connection_id,),
            ).fetchone()

        # Ignore unknown callback IDs; known IDs are validated by persisted state.
        if not existing:
            frontend_url = os.environ.get("WORKERS_FRONTEND_URL", "https://workers.floom.dev")
            return RedirectResponse(url=f"{frontend_url}/connections?connected=1")

        # Try to refresh from Composio first
        try:
            from composio_client import check_status
            remote_status = check_status(connection_id)
        except Exception:
            remote_status = ""

        final_status = (
            remote_status
            if remote_status and remote_status != "not_found"
            else (status or existing["status"])
        )
        now = now_iso()
        with get_db() as conn:
            conn.execute(
                "UPDATE composio_connections SET status=?, composio_connection_id=?, updated_at=? "
                "WHERE composio_connection_id=?",
                (final_status, connection_id, now, connection_id),
            )

    frontend_url = os.environ.get("WORKERS_FRONTEND_URL", "https://workers.floom.dev")
    return RedirectResponse(url=f"{frontend_url}/connections?connected=1")


@app.get(
    "/webhooks/oauth-callback",
    summary="OAuth callback alias",
    description=(
        "Alias for /connections/callback for cleaner webhook namespace. "
        "The existing /connections/callback route remains the primary callback URL."
    ),
)
def connections_callback_alias(connection_id: str = "", status: str = ""):
    return connections_callback(connection_id=connection_id, status=status)


@app.get("/connections/{connection_id}/status", response_model=ConnectionItem)
def get_connection_status(connection_id: str) -> ConnectionItem:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, app_name, composio_connection_id, status, created_at, updated_at, "
            "scopes_json, account_label, last_checked_at, last_check_status "
            "FROM composio_connections WHERE id = ?",
            (connection_id,),
        )
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")

    item = row_to_dict(row)
    item["scopes"] = _parse_scopes_json(item.pop("scopes_json", None))

    # Refresh from Composio
    try:
        from composio_client import check_status
        remote_status = check_status(item["composio_connection_id"])
        if remote_status and remote_status != item["status"]:
            now = now_iso()
            with get_db() as conn:
                conn.execute(
                    "UPDATE composio_connections SET status=?, updated_at=? WHERE id=?",
                    (remote_status, now, connection_id),
                )
            item["status"] = remote_status
            item["updated_at"] = now
    except Exception as exc:
        logger.warning("Could not refresh Composio status for %s: %s", connection_id, exc)

    return ConnectionItem(**item)


@app.delete("/connections/{connection_id}")
def delete_connection(connection_id: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT composio_connection_id FROM composio_connections WHERE id = ?",
            (connection_id,),
        )
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")

    composio_conn_id = row["composio_connection_id"]

    # Attempt to revoke from Composio (best-effort)
    try:
        from composio_client import revoke_connection
        revoke_connection(composio_conn_id)
    except Exception as exc:
        logger.warning("Could not revoke Composio connection %s: %s", composio_conn_id, exc)

    with get_db() as conn:
        conn.execute("DELETE FROM composio_connections WHERE id = ?", (connection_id,))

    return {"status": "deleted"}


@app.get("/connections/{connection_id}/account-info")
def get_connection_account_info(connection_id: str) -> Dict[str, Any]:
    """Return Composio connected-account info (email, scopes, user_id, auth_config_id).

    The frontend calls this to hydrate connection cards. The Composio API key
    lives here on the API service so it never needs to be on Vercel.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT composio_connection_id FROM composio_connections WHERE id = ?",
            (connection_id,),
        )
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")

    composio_conn_id = row["composio_connection_id"]
    info = _fetch_composio_account_info(composio_conn_id)
    if not info:
        raise HTTPException(status_code=502, detail="Unable to fetch account info from upstream")

    # Cache scopes + account_label in DB for list endpoint
    if info.get("scopes") is not None or info.get("email"):
        now = now_iso()
        scopes_json = json.dumps(info.get("scopes") or [])
        account_label = info.get("email") or info.get("user_id") or ""
        with get_db() as conn:
            conn.execute(
                "UPDATE composio_connections SET scopes_json=?, account_label=?, updated_at=? WHERE id=?",
                (scopes_json, account_label, now, connection_id),
            )

    return {
        "id": composio_conn_id,
        "email": info.get("email"),
        "scopes": info.get("scopes") or [],
        "user_id": info.get("user_id"),
        "auth_config_id": info.get("auth_config_id"),
    }


@app.get("/connections/auth-configs/{auth_config_id}")
def get_auth_config(auth_config_id: str) -> Dict[str, Any]:
    """Return Composio auth_config (scopes definition) for a given auth_config_id.

    Proxies to Composio so the key stays on the API service, not on Vercel.
    """
    import requests as _requests

    key = os.environ.get("COMPOSIO_API_KEY", "")
    if not key:
        raise HTTPException(status_code=503, detail="Composio API key not configured")

    base = "https://backend.composio.dev/api/v3"

    try:
        r = _requests.get(
            f"{base}/auth_configs/{auth_config_id}",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            timeout=10,
        )
        if r.ok:
            body = r.json()
            scopes = _extract_auth_config_scopes(body)
            config_id = (
                (body.get("auth_config") or {}).get("id")
                or body.get("id")
                or auth_config_id
            )
            return {"id": config_id, "scopes": scopes}

        if r.status_code in {401, 403}:
            raise HTTPException(status_code=r.status_code, detail="Authentication failed")
        if r.status_code == 429:
            raise HTTPException(status_code=429, detail="Rate limited")
        if r.status_code >= 500:
            raise HTTPException(status_code=502, detail="Upstream error")

        # Fall back: search by toolkit slug
        listed = _requests.get(
            f"{base}/auth_configs",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            params={"toolkit_slugs": auth_config_id, "limit": 20},
            timeout=10,
        )
        if listed.ok:
            items = (listed.json().get("items") or [])
            item = next(
                (ac for ac in items if (ac.get("status") or "ENABLED").upper() == "ENABLED"),
                items[0] if items else None,
            )
            if item:
                scopes = _extract_auth_config_scopes(item)
                return {
                    "id": item.get("id") or auth_config_id,
                    "scopes": scopes,
                }
        return {"id": auth_config_id, "scopes": []}
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Auth config fetch failed for %s: %s", auth_config_id, exc)
        return {"id": auth_config_id, "scopes": []}


def _extract_auth_config_scopes(body: Any) -> List[str]:
    """Extract scopes from various Composio auth_config response shapes."""
    if not isinstance(body, dict):
        return []
    candidates = [
        body,
        body.get("auth_config") or {},
        (body.get("auth_config") or {}).get("auth_scheme") or {},
        body.get("auth_scheme") or {},
        body.get("config") or {},
        body.get("oauth") or {},
    ]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        for key in ("scopes", "oauth_scopes", "requested_scopes", "default_scopes"):
            val = candidate.get(key)
            if isinstance(val, list) and val:
                return [s for s in val if isinstance(s, str)]
        scope = candidate.get("scope")
        if isinstance(scope, str) and scope:
            return [s for s in scope.split() if s]
    return []


@app.post("/connections/{connection_id}/test", response_model=ConnectionTestResult)
def test_connection(connection_id: str) -> ConnectionTestResult:
    """Test whether a connection's token is still valid by calling Composio."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT composio_connection_id FROM composio_connections WHERE id = ?",
            (connection_id,),
        )
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")

    composio_conn_id = row["composio_connection_id"]
    tested_at = now_iso()

    try:
        from composio_client import check_status
        remote_status = check_status(composio_conn_id)
    except Exception as exc:
        _write_connection_check(connection_id, "failed", str(exc), tested_at)
        return ConnectionTestResult(
            status="failed",
            reason=f"Upstream check failed: {exc}",
            tested_at=tested_at,
        )

    if remote_status == "not_found":
        _write_connection_check(connection_id, "failed", "Connection not found in upstream", tested_at)
        return ConnectionTestResult(
            status="failed",
            reason="Connection not found in the integration service",
            tested_at=tested_at,
        )
    if remote_status in ("expired", "failed"):
        _write_connection_check(connection_id, remote_status, f"Status: {remote_status}", tested_at)
        return ConnectionTestResult(
            status=remote_status,
            reason=f"Connection status is {remote_status}",
            tested_at=tested_at,
        )
    if remote_status == "active":
        _write_connection_check(connection_id, "valid", None, tested_at)
        return ConnectionTestResult(
            status="valid",
            reason="Connection is active",
            tested_at=tested_at,
        )

    # Unknown status: treat as valid but note it
    _write_connection_check(connection_id, "valid", f"Status: {remote_status}", tested_at)
    return ConnectionTestResult(
        status="valid",
        reason=f"Connection status: {remote_status}",
        tested_at=tested_at,
    )


def _write_connection_check(
    connection_id: str,
    check_status: str,
    error: Optional[str],
    checked_at: str,
) -> None:
    """Persist health-check result to the DB row."""
    with get_db() as conn:
        conn.execute(
            "UPDATE composio_connections "
            "SET last_checked_at=?, last_check_status=?, last_check_error=? "
            "WHERE id=?",
            (checked_at, check_status, error, connection_id),
        )


async def _run_connection_sweep() -> None:
    """Background task: test every connection and update last_checked_at columns."""
    logger.info("Connection health sweep starting")
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, composio_connection_id FROM composio_connections")
        rows = cursor.fetchall()

    for row in rows:
        conn_id = row["id"]
        composio_conn_id = row["composio_connection_id"]
        tested_at = now_iso()
        try:
            from composio_client import check_status
            remote_status = check_status(composio_conn_id)
            check = "valid" if remote_status == "active" else (
                remote_status if remote_status in ("expired", "failed") else "valid"
            )
            error = None if remote_status == "active" else f"Status: {remote_status}"
        except Exception as exc:
            check = "failed"
            error = str(exc)
        _write_connection_check(conn_id, check, error, tested_at)
        # Also refresh account_label + scopes for ACTIVE connections so the
        # user sees their actual email rather than the hardcoded "federico"
        # user_id. _fetch_composio_account_info uses Composio's tool-execute
        # proxy to get the real email via GMAIL_GET_PROFILE etc.
        if check == "valid":
            try:
                info = _fetch_composio_account_info(composio_conn_id)
                email_or_user = info.get("email") or info.get("user_id") or ""
                if email_or_user:
                    with get_db() as conn2:
                        conn2.execute(
                            "UPDATE composio_connections SET account_label=?, updated_at=? WHERE id=?",
                            (email_or_user, tested_at, conn_id),
                        )
            except Exception as exc:
                logger.debug("account_label refresh failed for %s: %s", conn_id, exc)
        logger.debug("Swept connection %s: %s", conn_id, check)
        await asyncio.sleep(0.5)  # Rate-limit Composio calls

    logger.info("Connection health sweep complete (%d connections)", len(rows))


@app.post("/system/sweep-connections")
async def sweep_connections_endpoint():
    """Trigger a health-check sweep for all connections. Called by external cron."""
    asyncio.create_task(_run_connection_sweep())
    return {"status": "sweep_started"}


# ---------------------------------------------------------------------------
# Integration trigger catalog + Composio event receiver
# ---------------------------------------------------------------------------

_trigger_catalog_cache: Dict[str, Any] = {"expires_at": 0.0, "items": None}
_trigger_catalog_lock = threading.Lock()


def _trigger_item_app_slug(item: Dict[str, Any]) -> str:
    """Extract the app/toolkit slug from a Composio trigger catalog item (lowercased)."""
    toolkit = item.get("toolkit") or item.get("app") or {}
    slug = (
        toolkit.get("slug")
        or item.get("toolkit_slug")
        or item.get("app_name")
        or item.get("app")
        or ""
    )
    if isinstance(slug, dict):
        slug = slug.get("slug") or ""
    return str(slug).lower()


@app.get("/integrations/triggers")
def list_integration_triggers(app: Optional[str] = Query(None, description="Filter by app slug (e.g. 'gmail')")):
    """Proxy Composio's trigger catalog, cached for one hour.

    Pass ?app=<slug> to return only triggers for that integration.
    Filtering happens on the cached full catalog so no extra Composio call is
    made per-app — the cache is always populated from the full list.
    """
    now = time.monotonic()
    with _trigger_catalog_lock:
        if _trigger_catalog_cache["items"] is not None and now < _trigger_catalog_cache["expires_at"]:
            items = _trigger_catalog_cache["items"]
            if app:
                app_lower = app.lower()
                items = [
                    item for item in items
                    if _trigger_item_app_slug(item) == app_lower
                ]
            return {"items": items}

    try:
        from composio_client import list_triggers
        items = list_triggers()
    except Exception as exc:
        logger.exception("Failed to fetch Composio trigger catalog")
        raise HTTPException(status_code=502, detail=f"Composio error: {exc}") from exc

    with _trigger_catalog_lock:
        _trigger_catalog_cache["items"] = items
        _trigger_catalog_cache["expires_at"] = now + 3600

    if app:
        app_lower = app.lower()
        items = [item for item in items if _trigger_item_app_slug(item) == app_lower]
    return {"items": items}


def _signature_values(signature_header: str) -> list[str]:
    values: list[str] = []
    signature_header = signature_header.strip()
    if not signature_header:
        return values
    if "," in signature_header:
        values.append(signature_header.split(",", 1)[1].strip())
    for part in signature_header.split():
        if "," in part:
            values.append(part.split(",", 1)[1].strip())
        if "=" in part:
            key, _, value = part.partition("=")
            if key in {"v1", "sha256"} and value:
                values.append(value.strip())
    values.append(signature_header)
    return [value for value in dict.fromkeys(values) if value]


def _verify_composio_signature(body: bytes, request: Request, signing_key: str) -> bool:
    webhook_id = request.headers.get("webhook-id", "")
    webhook_timestamp = request.headers.get("webhook-timestamp", "")
    signature_header = request.headers.get("webhook-signature", "")
    if not webhook_id or not webhook_timestamp or not signature_header:
        return False

    try:
        timestamp = int(webhook_timestamp)
    except ValueError:
        return False
    tolerance = int(os.environ.get("COMPOSIO_WEBHOOK_TOLERANCE_SECONDS", "300"))
    if tolerance > 0 and abs(time.time() - timestamp) > tolerance:
        return False

    signing_string = f"{webhook_id}.{webhook_timestamp}.{body.decode('utf-8')}".encode()
    expected = base64.b64encode(
        hmac.new(signing_key.encode(), signing_string, hashlib.sha256).digest()
    ).decode()
    return any(
        hmac.compare_digest(expected, provided)
        for provided in _signature_values(signature_header)
    )


def _candidate_composio_trigger_ids(payload: Any, request: Request) -> list[str]:
    candidates = [
        request.headers.get("X-Composio-Trigger-Id"),
        request.headers.get("X-Trigger-Id"),
    ]
    if isinstance(payload, dict):
        for key in (
            "composio_trigger_id",
            "trigger_id",
            "triggerId",
            "trigger_instance_id",
            "triggerInstanceId",
            "enabled_trigger_id",
            "connected_account_trigger_id",
        ):
            candidates.append(payload.get(key))
        for nested_key in ("data", "metadata", "trigger"):
            nested = payload.get(nested_key)
            if isinstance(nested, dict):
                nested_keys = [
                    "composio_trigger_id",
                    "trigger_id",
                    "triggerId",
                    "trigger_instance_id",
                    "triggerInstanceId",
                    "enabled_trigger_id",
                    "connected_account_trigger_id",
                ]
                if nested_key != "data":
                    nested_keys.append("id")
                for key in nested_keys:
                    candidates.append(nested.get(key))
    return [str(c) for c in candidates if c]


def _event_name_from_payload(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    for key in ("event", "event_name", "trigger_event", "trigger"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    nested = payload.get("metadata")
    if isinstance(nested, dict):
        value = nested.get("trigger_slug") or nested.get("event") or nested.get("event_name")
        if isinstance(value, str) and value:
            return value
    return None


def _find_worker_for_composio_event(payload: Any, request: Request) -> Optional[str]:
    candidates = _candidate_composio_trigger_ids(payload, request)
    with get_db() as conn:
        for trigger_id in candidates:
            row = conn.execute(
                "SELECT id FROM workers WHERE composio_trigger_id = ? LIMIT 1",
                (trigger_id,),
            ).fetchone()
            if row:
                return row["id"]
        if candidates:
            return None
        event_name = _event_name_from_payload(payload)
        if event_name:
            rows = conn.execute(
                "SELECT id FROM workers WHERE composio_event = ? AND composio_trigger_id IS NOT NULL",
                (event_name,),
            ).fetchall()
            if len(rows) == 1:
                return rows[0]["id"]
    return None


@app.post("/composio-events", response_model=ActionResponse)
async def composio_events(request: Request) -> ActionResponse:
    """Receive signed Composio trigger webhooks and create worker runs.

    Alias route: /webhooks/composio-events
    """
    signing_key = os.environ.get("COMPOSIO_WEBHOOK_SIGNING_KEY", "")
    if not signing_key:
        raise HTTPException(status_code=503, detail="COMPOSIO_WEBHOOK_SIGNING_KEY is not configured")

    body = await request.body()
    if not _verify_composio_signature(body, request, signing_key):
        raise HTTPException(status_code=401, detail="Invalid Composio signature")

    if body:
        try:
            payload: Any = json.loads(body)
        except Exception:
            payload = {"raw": body.decode("utf-8", errors="replace")}
    else:
        payload = {}

    worker_id = _find_worker_for_composio_event(payload, request)
    if not worker_id:
        raise HTTPException(status_code=404, detail="No worker registered for Composio trigger")

    inputs = {"event": payload}
    run_id = create_run(worker_id, inputs, trigger_source="composio")
    start_run(run_id, worker_id, inputs)
    return ActionResponse(status="queued", run_id=run_id)


@app.post(
    "/webhooks/composio-events",
    response_model=ActionResponse,
    summary="Composio events alias",
    description=(
        "Alias for /composio-events for cleaner webhook namespace. "
        "The existing /composio-events path remains the primary webhook URL."
    ),
)
async def composio_events_alias(request: Request) -> ActionResponse:
    return await composio_events(request)


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------

class PlatformConfig(BaseModel):
    all_required_set: bool
    missing: List[str]
    set_count: int
    required_count: int


class OverviewStats(BaseModel):
    runs_24h: int
    runs_24h_sparkline: List[int]
    success_rate_7d: float
    active_workers_count: int
    connections_healthy: int
    connections_total: int


class OverviewRunItem(BaseModel):
    run_id: str
    worker_id: str
    worker_name: str
    status: str
    started_at: Optional[str] = None
    duration_ms: int
    trigger_source: str


class OverviewScheduledItem(BaseModel):
    worker_id: str
    worker_name: str
    next_fire_at: str
    trigger_label: str


class OverviewAttentionItem(BaseModel):
    type: str
    worker_id: Optional[str] = None
    connection_id: Optional[str] = None
    # PR S19 (I-7): name the connection in the UI instead of an opaque
    # "Connection expired" with no provider context. Populated for
    # connection_expired / connection_expiring rows; None otherwise.
    provider_slug: Optional[str] = None
    provider_display_name: Optional[str] = None
    message: str
    action_url: str


class OverviewResponse(BaseModel):
    stats: OverviewStats
    recent_runs: List[OverviewRunItem]
    scheduled_today: List[OverviewScheduledItem]
    needs_attention: List[OverviewAttentionItem]


@app.get("/system/overview", response_model=OverviewResponse)
def system_overview() -> OverviewResponse:
    now = datetime.now(timezone.utc)
    window_24h = now - timedelta(hours=24)
    window_7d = now - timedelta(days=7)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow_start = today_start + timedelta(days=1)

    with get_db() as conn:
        runs_24h_rows = conn.execute(
            "SELECT created_at FROM runs WHERE created_at >= ?",
            (window_24h.isoformat(),),
        ).fetchall()
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

        runs_7d_counts = conn.execute(
            """
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS succeeded
            FROM runs
            WHERE created_at >= ?
            """,
            (window_7d.isoformat(),),
        ).fetchone()
        runs_total_7d = int((runs_7d_counts["total"] if runs_7d_counts else 0) or 0)
        runs_success_7d = int((runs_7d_counts["succeeded"] if runs_7d_counts else 0) or 0)
        success_rate_7d = (runs_success_7d / runs_total_7d) if runs_total_7d else 0.0

        active_workers_count = int(
            (
                conn.execute("SELECT COUNT(*) AS total FROM workers WHERE enabled = 1").fetchone()["total"]
            )
            or 0
        )

        connection_counts = conn.execute(
            """
            SELECT
                COUNT(*) AS total,
                SUM(
                    CASE
                        WHEN status = 'active'
                             AND (last_check_status IS NULL OR last_check_status = 'valid')
                        THEN 1
                        ELSE 0
                    END
                ) AS healthy
            FROM composio_connections
            """
        ).fetchone()
        connections_total = int((connection_counts["total"] if connection_counts else 0) or 0)
        connections_healthy = int((connection_counts["healthy"] if connection_counts else 0) or 0)

        recent_rows = conn.execute(
            """
            SELECT
                r.id AS run_id,
                r.worker_id,
                COALESCE(JSON_EXTRACT(sv.manifest_json, '$.title'), w.name, r.worker_id) AS worker_name,
                r.status,
                COALESCE(r.started_at, r.created_at) AS started_at,
                r.duration_ms,
                r.trigger_source
            FROM runs r
            LEFT JOIN workers w ON r.worker_id = w.id
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            ORDER BY r.created_at DESC
            LIMIT 5
            """
        ).fetchall()
        recent_runs = [
            OverviewRunItem(
                run_id=row["run_id"],
                worker_id=row["worker_id"],
                worker_name=row["worker_name"] or row["worker_id"],
                status=_normalize_run_status(row["status"] or ""),
                started_at=row["started_at"],
                duration_ms=int((row["duration_ms"] or 0)),
                trigger_source=row["trigger_source"] or "manual",
            )
            for row in recent_rows
        ]

        scheduled_rows = conn.execute(
            """
            SELECT id, name, next_run_at, cron_expr, trigger_type, triggers_json
            FROM workers
            WHERE enabled = 1
              AND next_run_at IS NOT NULL
              AND next_run_at >= ?
              AND next_run_at < ?
            ORDER BY next_run_at ASC
            LIMIT 5
            """,
            (today_start.isoformat(), tomorrow_start.isoformat()),
        ).fetchall()
        scheduled_today: List[OverviewScheduledItem] = []
        for row in scheduled_rows:
            trigger = {"type": row["trigger_type"] or "schedule", "cron": row["cron_expr"]}
            if row["triggers_json"]:
                try:
                    parsed_triggers = json.loads(row["triggers_json"])
                    if isinstance(parsed_triggers, list):
                        schedule_trigger = next(
                            (
                                item
                                for item in parsed_triggers
                                if isinstance(item, dict)
                                and str(item.get("type", "")).lower() in {"schedule", "scheduled"}
                            ),
                            None,
                        )
                        if schedule_trigger is not None:
                            trigger = schedule_trigger
                except Exception:
                    pass
            scheduled_today.append(
                OverviewScheduledItem(
                    worker_id=row["id"],
                    worker_name=row["name"],
                    next_fire_at=row["next_run_at"],
                    trigger_label=_trigger_label(trigger),
                )
            )

        attention_items: List[OverviewAttentionItem] = []
        failure_rows = conn.execute(
            """
            SELECT worker_id, COUNT(*) AS failure_count
            FROM runs
            WHERE status = 'failed' AND created_at >= ?
            GROUP BY worker_id
            HAVING COUNT(*) >= 3
            ORDER BY failure_count DESC
            LIMIT 3
            """,
            (window_24h.isoformat(),),
        ).fetchall()
        for row in failure_rows:
            failure_count = int(row["failure_count"] or 0)
            attention_items.append(
                OverviewAttentionItem(
                    type="failure_cluster",
                    worker_id=row["worker_id"],
                    message=f"Worker failed {failure_count} times in the last 24 hours.",
                    action_url=f"/workers/{row['worker_id']}",
                )
            )

        # PR S19 (I-7): include provider_slug + provider_display_name so the
        # Overview alert can name the connection ("Gmail" instead of opaque
        # "Connection expired") and the UI can render the right logo.
        expired_rows = conn.execute(
            """
            SELECT id, app_name
            FROM composio_connections
            WHERE status = 'expired' OR last_check_status = 'expired'
            ORDER BY updated_at DESC
            LIMIT 3
            """
        ).fetchall()
        for row in expired_rows:
            slug = (row["app_name"] or "").lower() or None
            attention_items.append(
                OverviewAttentionItem(
                    type="connection_expired",
                    connection_id=row["id"],
                    provider_slug=slug,
                    provider_display_name=row["app_name"] or None,
                    message="Connection has expired and needs re-authorization.",
                    action_url=f"/connections/{row['id']}",
                )
            )

        expiring_rows = conn.execute(
            """
            SELECT id, app_name
            FROM composio_connections
            WHERE status = 'active'
              AND last_check_status = 'failed'
              AND LOWER(COALESCE(last_check_error, '')) LIKE '%expir%'
            ORDER BY updated_at DESC
            LIMIT 3
            """
        ).fetchall()
        for row in expiring_rows:
            slug = (row["app_name"] or "").lower() or None
            attention_items.append(
                OverviewAttentionItem(
                    type="connection_expiring",
                    connection_id=row["id"],
                    provider_slug=slug,
                    provider_display_name=row["app_name"] or None,
                    message="Connection may expire soon. Reconnect to avoid failures.",
                    action_url=f"/connections/{row['id']}",
                )
            )

    return OverviewResponse(
        stats=OverviewStats(
            runs_24h=runs_24h,
            runs_24h_sparkline=sparkline,
            success_rate_7d=success_rate_7d,
            active_workers_count=active_workers_count,
            connections_healthy=connections_healthy,
            connections_total=connections_total,
        ),
        recent_runs=recent_runs,
        scheduled_today=scheduled_today,
        needs_attention=attention_items,
    )


@app.get("/system/platform-config", response_model=PlatformConfig)
def platform_config():
    """Return a redacted platform-config summary.

    PR S13: keep this minimal shape stable. The old settings page and the S12
    tabbed settings page both consume this response.
    """
    required_specs = [s for s in (PLATFORM_SECRET_SPECS + INFRA_PATH_SPECS) if s["required"]]
    missing = [s["name"] for s in required_specs if not os.environ.get(s["name"])]
    required_count = len(required_specs)
    set_count = required_count - len(missing)
    return PlatformConfig(
        all_required_set=(len(missing) == 0),
        missing=missing,
        set_count=set_count,
        required_count=required_count,
    )


@app.get("/system/info")
def system_info():
    return {
        "version": app.version,
        "started_at": _PROCESS_STARTED_AT,
        "python_version": sys.version.split()[0],
        "runner": "e2b",
    }


@app.get("/system/metrics")
def system_metrics():
    """Operational metrics for the dashboard / external monitors.

    Gated by x-floom-secret like other admin routes. Returns a flat counters
    payload suitable for cron-scraped JSON monitoring.
    """
    workers = discover_workers(use_cache=True)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as cnt FROM runs")
        runs_total = cursor.fetchone()["cnt"]
        cursor.execute(
            "SELECT COUNT(*) as cnt FROM runs WHERE created_at >= datetime('now', '-7 days')"
        )
        runs_7d = cursor.fetchone()["cnt"]
        cursor.execute(
            "SELECT COUNT(*) as cnt FROM runs "
            "WHERE created_at >= datetime('now', '-7 days') AND status = ?",
            (RunStatus.FAILED.value,),
        )
        runs_failed_7d = cursor.fetchone()["cnt"]
        try:
            cursor.execute("SELECT COUNT(*) as cnt FROM composio_connections WHERE status = 'active'")
            connections_count = cursor.fetchone()["cnt"]
        except sqlite3.OperationalError:
            connections_count = 0
        try:
            cursor.execute("SELECT COUNT(*) as cnt FROM secrets")
            secrets_count = cursor.fetchone()["cnt"]
        except sqlite3.OperationalError:
            secrets_count = 0
        try:
            cursor.execute(
                "SELECT COUNT(*) as cnt FROM workers WHERE enabled = 1 AND trigger_type != 'manual'"
            )
            active_triggers = cursor.fetchone()["cnt"]
        except sqlite3.OperationalError:
            active_triggers = 0
    return {
        "workers_count": len(workers),
        "runs_total": int(runs_total or 0),
        "runs_7d": int(runs_7d or 0),
        "runs_failed_7d": int(runs_failed_7d or 0),
        "connections_count": int(connections_count or 0),
        "secrets_count": int(secrets_count or 0),
        "active_triggers": int(active_triggers or 0),
        "drafts_last_hour": _drafts_last_hour_total(),
        "uptime_seconds": int(time.time() - _PROCESS_START_TIME),
    }


# ---------------------------------------------------------------------------
# Webhook rate limiter (in-memory sliding window)
# ---------------------------------------------------------------------------

_wh_rate_lock = threading.Lock()
_wh_rate_store: Dict[str, collections.deque] = {}
_WH_RATE_LIMIT = int(os.environ.get("FLOOM_WH_RATE_LIMIT", "60"))   # max calls
_WH_RATE_WINDOW = int(os.environ.get("FLOOM_WH_RATE_WINDOW", "60")) # seconds


def _check_webhook_rate_limit(key: str) -> bool:
    """Return True if the request is within the rate limit, False if exceeded.

    Uses a per-key sliding window (IP or worker_id) stored in memory.
    Resets on process restart — acceptable for single-server MVP.
    """
    now = time.monotonic()
    cutoff = now - _WH_RATE_WINDOW
    with _wh_rate_lock:
        dq = _wh_rate_store.setdefault(key, collections.deque())
        # Evict timestamps older than the window
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= _WH_RATE_LIMIT:
            return False
        dq.append(now)
        return True


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------

class WebhookSecretResponse(BaseModel):
    worker_id: str
    secret: Optional[str] = None  # Only present on generation/rotation


def _worker_has_webhook_trigger(worker_id: str, config: Optional["WorkerConfig"]) -> bool:
    """Return True if any of the worker's triggers is of type 'webhook'.

    Checks triggers_json in the DB first (multi-trigger support), then
    falls back to the single config.trigger.type.
    """
    # Check multi-trigger DB column first
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT triggers_json FROM workers WHERE id = ?",
                (worker_id,),
            ).fetchone()
        if row and row["triggers_json"]:
            triggers = json.loads(row["triggers_json"])
            if isinstance(triggers, list):
                return any(
                    isinstance(t, dict) and t.get("type") == "webhook"
                    for t in triggers
                )
    except Exception:
        pass
    # Fallback: single trigger config
    if config:
        return config.trigger.type == "webhook"
    return False


@app.post("/webhooks/{worker_id}", response_model=ActionResponse)
async def webhook_trigger(
    worker_id: str,
    request: Request,
    token: Optional[str] = Query(None),
) -> ActionResponse:
    """Receive an incoming webhook and trigger a worker run.

    Authentication accepts either:
    - ?token=<derived_token>  (deterministic, shown in UI, no rotation needed)
    - X-Floom-Signature header (legacy HMAC, for backwards compat)

    Both are accepted; if token query param is present it takes priority.
    On success returns run_id immediately (non-blocking).
    """
    from webhook_service import get_webhook_secret_hash, verify_signature, verify_webhook_token

    # Rate limit: 60 req/60s per (worker_id, client_ip) — in-memory sliding window
    client_ip = (request.client.host if request.client else "unknown")
    rl_key = f"{worker_id}:{client_ip}"
    if not _check_webhook_rate_limit(rl_key):
        raise HTTPException(status_code=429, detail="Too many webhook requests")

    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    config = get_worker_config_for_run(worker_id)
    if not _worker_has_webhook_trigger(worker_id, config):
        raise HTTPException(
            status_code=400,
            detail=f"Worker {worker_id!r} does not have a webhook trigger",
        )

    body = await request.body()

    # Authentication: token query param takes priority over signature header.
    if token is not None:
        # Deterministic token auth — reject on mismatch
        if not verify_webhook_token(worker_id, token):
            raise HTTPException(status_code=401, detail="Invalid webhook token")
    else:
        # Signature verification (only when webhook.secret=true on first trigger)
        webhook_cfg = config.trigger.webhook if config else None
        if webhook_cfg and webhook_cfg.secret:
            secret_hash = get_webhook_secret_hash(worker_id)
            if not secret_hash:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        "Webhook secret not configured — call POST "
                        f"/workers/{worker_id}/webhook-secret/rotate first"
                    ),
                )
            sig_header = request.headers.get("X-Floom-Signature", "")
            if not verify_signature(body, sig_header, secret_hash):
                raise HTTPException(status_code=401, detail="Invalid webhook signature")

    # Parse body as JSON inputs (or empty dict)
    inputs: Dict[str, Any] = {}
    if body:
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                inputs = parsed
            else:
                inputs = {"payload": parsed}
        except Exception:
            inputs = {"raw": body.decode("utf-8", errors="replace")}

    # Create and start run (non-blocking)
    run_id = create_run(worker_id, inputs, trigger_source="webhook")
    start_run(run_id, worker_id, inputs)

    return ActionResponse(status="queued", run_id=run_id)


@app.post("/workers/{worker_id}/webhook-secret/rotate", response_model=WebhookSecretResponse)
def rotate_webhook_secret(worker_id: str) -> WebhookSecretResponse:
    """Rotate the webhook HMAC secret for a worker.

    Returns the new raw secret exactly once — it is never stored in plaintext.
    """
    from webhook_service import generate_webhook_secret

    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    config = get_worker_config_for_run(worker_id)
    if not _worker_has_webhook_trigger(worker_id, config):
        raise HTTPException(
            status_code=400,
            detail=f"Worker {worker_id!r} does not have a webhook trigger",
        )

    raw_secret = generate_webhook_secret(worker_id)
    return WebhookSecretResponse(worker_id=worker_id, secret=raw_secret)


# ---------------------------------------------------------------------------
# CLI device-code auth (single-instance in-memory v0)
# ---------------------------------------------------------------------------

# Single-instance launch tradeoff:
# Device auth state is in memory only. Restarting the API process or running
# multiple API replicas will invalidate in-flight device codes.
_cli_auth_lock = threading.Lock()
_cli_auth_devices: Dict[str, Dict[str, Any]] = {}
_CLI_AUTH_EXPIRES_SECONDS = 600
_CLI_AUTH_POLL_INTERVAL_SECONDS = 2
_CLI_AUTH_USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class CliAuthDeviceCreateRequest(BaseModel):
    client_name: str
    scopes: List[str] = []


class CliAuthCodeRequest(BaseModel):
    user_code: str


def _cli_auth_prune_expired(now_ts: Optional[float] = None) -> None:
    ts = now_ts or time.time()
    expired_codes = [
        code
        for code, record in _cli_auth_devices.items()
        if float(record.get("expires_at", 0.0)) <= ts
    ]
    for code in expired_codes:
        _cli_auth_devices.pop(code, None)


def _new_device_code() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")


def _new_user_code() -> str:
    left = "".join(pysecrets.choice(_CLI_AUTH_USER_CODE_ALPHABET) for _ in range(4))
    right = "".join(pysecrets.choice(_CLI_AUTH_USER_CODE_ALPHABET) for _ in range(4))
    return f"{left}-{right}"


def _api_public_base() -> str:
    return (os.environ.get("WORKEROS_API_BASE") or "https://workers-api.floom.dev").rstrip("/")


def _frontend_public_base() -> str:
    return (os.environ.get("WORKERS_FRONTEND_URL") or "https://workers.floom.dev").rstrip("/")


@app.post("/cli-auth/devices")
def create_cli_device(payload: CliAuthDeviceCreateRequest) -> Dict[str, Any]:
    client_name = (payload.client_name or "").strip()
    if not client_name:
        raise HTTPException(status_code=400, detail="client_name is required")

    now_ts = time.time()
    expires_at = now_ts + _CLI_AUTH_EXPIRES_SECONDS
    with _cli_auth_lock:
        _cli_auth_prune_expired(now_ts)

        device_code = _new_device_code()
        while device_code in _cli_auth_devices:
            device_code = _new_device_code()

        existing_user_codes = {str(record.get("user_code", "")) for record in _cli_auth_devices.values()}
        user_code = _new_user_code()
        while user_code in existing_user_codes:
            user_code = _new_user_code()

        _cli_auth_devices[device_code] = {
            "user_code": user_code,
            "status": "pending",
            "created_at": now_ts,
            "expires_at": expires_at,
            "secret": None,
            "client_name": client_name,
            "scopes": list(payload.scopes or []),
        }

    verification_url = f"{_frontend_public_base()}/cli-auth?code={user_code}"
    return {
        "device_code": device_code,
        "user_code": user_code,
        "verification_url": verification_url,
        "polling_interval_seconds": _CLI_AUTH_POLL_INTERVAL_SECONDS,
        "expires_in_seconds": _CLI_AUTH_EXPIRES_SECONDS,
    }


@app.get("/cli-auth/poll/{device_code}")
def poll_cli_device(device_code: str) -> Dict[str, Any]:
    now_ts = time.time()
    with _cli_auth_lock:
        record = _cli_auth_devices.get(device_code)
        if not record:
            raise HTTPException(status_code=404, detail="Device code not found")

        if float(record.get("expires_at", 0.0)) <= now_ts:
            _cli_auth_devices.pop(device_code, None)
            raise HTTPException(status_code=410, detail="Device code expired")

        status = str(record.get("status", "pending"))
        if status == "pending":
            return {"status": "pending"}

        if status == "denied":
            _cli_auth_devices.pop(device_code, None)
            raise HTTPException(status_code=403, detail="Device code denied")

        if status == "approved":
            secret = str(record.get("secret") or "")
            if not secret:
                _cli_auth_devices.pop(device_code, None)
                raise HTTPException(status_code=500, detail="Approved device missing API secret")
            _cli_auth_devices.pop(device_code, None)
            return {
                "status": "approved",
                "api_secret": secret,
                "api_base": _api_public_base(),
            }

        raise HTTPException(status_code=500, detail=f"Unexpected device status: {status}")


def _find_device_code_by_user_code(user_code: str) -> Optional[str]:
    needle = user_code.strip().upper()
    for device_code, record in _cli_auth_devices.items():
        if str(record.get("user_code", "")).upper() == needle:
            return device_code
    return None


@app.post("/cli-auth/approve")
def approve_cli_device(payload: CliAuthCodeRequest) -> Dict[str, Any]:
    floom_secret = os.environ.get("FLOOM_SECRET", "")
    if not floom_secret:
        raise HTTPException(status_code=503, detail="FLOOM_SECRET is not configured")

    now_ts = time.time()
    with _cli_auth_lock:
        _cli_auth_prune_expired(now_ts)
        device_code = _find_device_code_by_user_code(payload.user_code)
        if not device_code:
            raise HTTPException(status_code=404, detail="User code not found")
        record = _cli_auth_devices.get(device_code)
        if not record:
            raise HTTPException(status_code=404, detail="User code not found")
        if str(record.get("status")) != "pending":
            raise HTTPException(status_code=409, detail="Device code is no longer pending")
        record["status"] = "approved"
        record["secret"] = floom_secret
        return {"ok": True, "client_name": record.get("client_name") or "unknown"}


@app.post("/cli-auth/deny")
def deny_cli_device(payload: CliAuthCodeRequest) -> Dict[str, Any]:
    now_ts = time.time()
    with _cli_auth_lock:
        _cli_auth_prune_expired(now_ts)
        device_code = _find_device_code_by_user_code(payload.user_code)
        if not device_code:
            raise HTTPException(status_code=404, detail="User code not found")
        record = _cli_auth_devices.get(device_code)
        if not record:
            raise HTTPException(status_code=404, detail="User code not found")
        if str(record.get("status")) != "pending":
            raise HTTPException(status_code=409, detail="Device code is no longer pending")
        record["status"] = "denied"
        record["secret"] = None
        return {"ok": True, "client_name": record.get("client_name") or "unknown"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
