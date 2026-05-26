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
import shutil
import fcntl
import re
import time
import collections
import threading
import tempfile
import uuid as _uuid_mod
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from db import init_db, get_db, now_iso, DB_PATH
from files import blob_path, ensure_blob_dir, extension_for_file, is_sha256, normalize_media_type
from models import (
    RunCreate,
    WorkerSummary,
    WorkerDetail,
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
)
from worker_registry import (
    WORKERS_DIR,
    discover_workers,
    get_worker,
    invalidate_worker_cache,
)
from run_service import create_run, get_worker_config_for_run, start_run, add_log
from run_service import register_sse_publisher

load_dotenv()
api_env_path = Path("/root/.config/workeros/api.env")
if api_env_path.is_file():
    load_dotenv(api_env_path, override=False)
init_db()

# ---------------------------------------------------------------------------
# App & middleware
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan: startup + shutdown hooks."""
    # Wire up SSE publisher before starting workers (avoids circular import)
    register_sse_publisher(_sse_publish)
    # Startup
    reload_workers()
    from scheduler import start_scheduler
    start_scheduler()
    yield
    # Shutdown
    from scheduler import stop_scheduler
    stop_scheduler()


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
_RATE_LIMIT = int(os.environ.get("FLOOM_RATE_LIMIT_PER_MIN", "200"))
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
        ):
            return await call_next(request)
        header = request.headers.get("x-floom-secret", "")
        if header != secret:
            from fastapi.responses import JSONResponse as _JSONResponse
            return _JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)

logger = logging.getLogger("floom.api")

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
    return RunSummary(
        id=d["id"],
        worker_id=d["worker_id"],
        worker_name=d.get("worker_name"),
        status=RunStatus(d["status"]),
        trigger_source=d["trigger_source"],
        created_at=d.get("created_at"),
        started_at=d.get("started_at"),
        completed_at=d.get("completed_at"),
        duration_ms=d.get("duration_ms"),
        error=d.get("error"),
    )


def _read_transcript_rows(run_runner: str, artifacts: List[Artifact]) -> List[Dict[str, Any]]:
    if not (run_runner or "").startswith("skill"):
        return []
    transcript = next((artifact for artifact in artifacts if artifact.name == "transcript.jsonl"), None)
    if not transcript:
        return []

    from runner_local import ARTIFACTS_DIR

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
                 composio_trigger_id, composio_event)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?, 1, ?, 'federico', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                skill_version_id=excluded.skill_version_id,
                name=excluded.name,
                trigger_type=excluded.trigger_type,
                cron_expr=excluded.cron_expr,
                cron_timezone=excluded.cron_timezone,
                composio_trigger_id=excluded.composio_trigger_id,
                composio_event=excluded.composio_event
            """,
            (
                worker_id,
                skill_version_id,
                w["name"],
                trigger.get("type") or w.get("trigger_type") or "manual",
                trigger.get("cron"),
                trigger.get("timezone"),
                json.dumps({}),
                json.dumps({}),
                now,
                composio_trigger_id,
                composio_event,
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
    }


def _list_db_workers() -> List[Dict[str, Any]]:
    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT w.id, w.name, w.trigger_type, sv.manifest_json
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
                SELECT w.id, w.name, w.trigger_type, sv.manifest_json
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

    # Read raw YAML for manifest viewer
    manifest_yaml: Optional[str] = None
    run_py: Optional[str] = None
    try:
        from worker_registry import WORKERS_DIR
        yml_path = WORKERS_DIR / worker_id / "worker.yml"
        run_path = WORKERS_DIR / worker_id / "run.py"
        if yml_path.is_file():
            manifest_yaml = yml_path.read_text()
        elif worker.get("manifest"):
            import yaml as pyyaml
            manifest_yaml = pyyaml.safe_dump(worker["manifest"], sort_keys=False)
        if run_path.is_file():
            run_py = run_path.read_text()
    except Exception:
        pass

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
        if not config or config.trigger.type != "webhook":
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
            from run_service import update_run_status
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

    # Check if skill_version is still referenced by other workers; preserve if so
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(*) as cnt FROM workers WHERE skill_version_id = ?",
            (skill_version_id,),
        )
        ref_count = cursor.fetchone()["cnt"]

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


# ---------------------------------------------------------------------------
# POST /workers/draft-from-prompt
# ---------------------------------------------------------------------------

_COMPOSIO_APP_KEYWORDS: Dict[str, List[str]] = {
    "gmail": ["gmail", "email", "mail", "inbox", "message"],
    "hubspot": ["hubspot", "crm", "contact", "deal", "lead"],
    "slack": ["slack", "channel", "dm", "message"],
    "notion": ["notion", "page", "database", "notes"],
    "granola": ["granola", "meeting", "calendar meeting", "notes"],
    "salesforce": ["salesforce", "sfdc", "opportunity", "account"],
    "google-calendar": ["google calendar", "calendar", "event", "schedule", "meeting"],
    "github": ["github", "pr", "pull request", "issue", "repository", "repo"],
    "linear": ["linear", "ticket", "issue", "sprint", "project"],
    "google-sheets": ["google sheets", "spreadsheet", "sheet", "excel"],
    "airtable": ["airtable", "base", "record"],
    "stripe": ["stripe", "payment", "invoice", "subscription", "billing"],
    "jira": ["jira", "ticket", "issue", "sprint"],
    "figma": ["figma", "design", "prototype"],
    "discord": ["discord", "channel", "server", "message"],
    "twitter": ["twitter", "tweet", "post"],
    "linkedin": ["linkedin", "profile", "connection", "post"],
    "dropbox": ["dropbox", "file", "folder"],
    "google-drive": ["google drive", "gdrive", "drive", "document", "doc"],
}

_DRAFT_SYSTEM_PROMPT = """You are a Workeros worker designer. Given a natural-language description of an automation task, you must output a VALID YAML WorkerContract and extracted metadata as JSON.

The WorkerContract YAML must follow schema_version "0.3" exactly. Key rules:
- `name`: lowercase slug 3-64 chars (letters, digits, hyphens)
- `title`: human-readable title
- `description`: 1-2 sentence description (max 500 chars)
- `exec.runtime`: must be "skill" for agent mode, or "python311"/"bash"/"node22"/"none"
- `exec.mode`: "agent" (default for skill runtime) or "pure-script"
- `exec.runner`: "e2b" (default, sandboxed) or "local"
- `exec.inputs`: list of fields with name/kind/type/required/label. kind is "scalar" or "file". scalar fields need type (string/number/boolean/select). File fields need media_type.
- `exec.outputs`: list of fields with name/kind and for files: media_type+path, for scalars: type
- `exec.secrets`: list of env var names (UPPER_SNAKE_CASE)
- `trigger.type`: "manual" (default), "schedule", "webhook", or "composio"
- `version`: semver like "0.1.0"
- `entrypoint`: "SKILL.md" for agent mode
- `targets`: ["generic"]
- `connections`: list of Composio app slugs if integrations are needed
- `use_cases`: list of 3-5 items

For an agent-mode skill worker, use:
```yaml
exec:
  runtime: skill
  mode: agent
  runner: e2b
  entrypoint: SKILL.md
```

The SKILL.md content (returned as `skill_md` key) should be detailed system-prompt-style instructions for the agent. Include what tools/APIs to call, what the output format should be, error handling, and any important context.

Respond with ONLY valid JSON in this exact shape (no markdown fences, no extra text):
{
  "worker_yml": "<full YAML string>",
  "skill_md": "<markdown instructions for the agent>",
  "suggested_name": "<slug>",
  "suggested_title": "<human title>",
  "required_connections": ["app-slug1", "app-slug2"],
  "required_secrets": ["SECRET_NAME"],
  "inputs": [{"name": "field_name", "type": "string", "label": "Human label", "required": false, "default": null}],
  "outputs": [{"name": "summary", "type": "markdown", "label": "Summary"}]
}"""


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


class DraftFromPromptResponse(BaseModel):
    worker_yml: str
    suggested_name: str
    suggested_title: str
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


@app.post("/workers/draft-from-prompt", response_model=DraftFromPromptResponse)
async def draft_worker_from_prompt(payload: DraftFromPromptRequest) -> DraftFromPromptResponse:
    """Draft a WorkerContract YAML from a natural-language prompt using LLM."""
    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required and must not be empty")
    if len(prompt) > 4000:
        raise HTTPException(status_code=400, detail="prompt must be 4000 characters or fewer")

    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not openai_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY not configured")

    # Pre-detect connections for the prompt to give the LLM a hint
    prompt_lower = prompt.lower()
    detected_connections = _detect_connections(prompt_lower)

    user_message = f"""Design a Workeros worker for this task:

{prompt}

Detected Composio apps that may be needed: {detected_connections if detected_connections else 'none detected — infer from context'}

Generate the full WorkerContract YAML and metadata JSON as specified. Make sure the YAML is valid and passes schema_version 0.3 validation."""

    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": _DRAFT_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            temperature=0.2,
            max_tokens=3000,
        )
    except Exception as exc:
        logger.exception("OpenAI call failed in draft-from-prompt")
        raise HTTPException(status_code=502, detail=f"LLM call failed: {exc}") from exc

    raw_content = response.choices[0].message.content or ""

    # Strip markdown code fences if the model wrapped the response
    raw_content = raw_content.strip()
    if raw_content.startswith("```"):
        raw_content = "\n".join(raw_content.split("\n")[1:])
    if raw_content.endswith("```"):
        raw_content = "\n".join(raw_content.split("\n")[:-1])
    raw_content = raw_content.strip()

    try:
        parsed = json.loads(raw_content)
    except json.JSONDecodeError as exc:
        logger.error("LLM returned non-JSON for draft-from-prompt: %s", raw_content[:500])
        raise HTTPException(status_code=502, detail=f"LLM returned invalid JSON: {exc}") from exc

    worker_yml = parsed.get("worker_yml", "")
    if not worker_yml:
        raise HTTPException(status_code=502, detail="LLM returned empty worker_yml")

    # Validate the YAML round-trips through parse_worker_manifest
    import yaml as pyyaml
    try:
        raw_manifest = pyyaml.safe_load(worker_yml)
        if not isinstance(raw_manifest, dict):
            raise ValueError("worker_yml must be a YAML mapping")
        from models import parse_worker_manifest
        parse_worker_manifest(raw_manifest)
    except Exception as exc:
        logger.warning("LLM-generated YAML failed validation: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"LLM-generated worker YAML is not valid: {exc}",
        ) from exc

    suggested_name = parsed.get("suggested_name", "my-worker")
    suggested_title = parsed.get("suggested_title", "My Worker")
    required_connections = parsed.get("required_connections") or detected_connections
    required_secrets = parsed.get("required_secrets") or []

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

    return DraftFromPromptResponse(
        worker_yml=worker_yml,
        suggested_name=suggested_name,
        suggested_title=suggested_title,
        required_connections=required_connections,
        required_secrets=required_secrets,
        inputs=inputs,
        outputs=outputs,
    )


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
        except RuntimeError as exc:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            invalidate_worker_cache()
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Return the new worker detail
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
    if not skill_path.exists():
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


@app.get("/runs", response_model=List[RunSummary])
def list_runs(
    worker_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> List[RunSummary]:
    with get_db() as conn:
        cursor = conn.cursor()
        query = """
            SELECT r.id, r.worker_id, w.name as worker_name, r.status,
                   r.trigger_source, r.created_at,
                   r.started_at, r.completed_at, r.duration_ms, r.error
            FROM runs r
            LEFT JOIN workers w ON r.worker_id = w.id
            WHERE 1=1
        """
        params: list[Any] = []
        if worker_id:
            query += " AND r.worker_id = ?"
            params.append(worker_id)
        if status:
            query += " AND r.status = ?"
            params.append(status)
        query += " ORDER BY r.created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
    return [_make_run_summary(r) for r in rows]


@app.post("/runs/clear")
def clear_runs():
    with get_db() as conn:
        conn.execute("DELETE FROM artifacts")
        conn.execute("DELETE FROM logs")
        conn.execute("DELETE FROM runs")
    logger.info("All run history cleared")
    return {"status": "cleared"}


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

    from runner_local import ARTIFACTS_DIR
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
            SELECT r.id, r.worker_id, w.name as worker_name, r.status, r.trigger_source, r.runner,
                   r.input_json, r.output_json, r.error,
                   r.started_at, r.completed_at, r.duration_ms, r.created_at
            FROM runs r
            LEFT JOIN workers w ON r.worker_id = w.id
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
    """Create or update a secret. Value is write-only — never returned."""
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
    """Delete a secret from .env and env."""
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

PLATFORM_SECRETS: frozenset[str] = frozenset({
    "COMPOSIO_API_KEY",
    "COMPOSIO_WEBHOOK_SIGNING_KEY",
    "WORKERS_FRONTEND_URL",
    "FLOOM_DB",
    "FLOOM_WORKERS_DIR",
    "FLOOM_ARTIFACTS_DIR",
    "FLOOM_RUN_TIMEOUT",
    "FLOOM_SECRET",
    "E2B_API_KEY",
})


@app.get("/secrets", response_model=List[SecretItem])
def list_secrets() -> List[SecretItem]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM secrets ORDER BY name")
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

        result.append(
            SecretItem(
                name=name,
                status=status,
                last_used_at=db_secrets.get(name, {}).get("last_used_at"),
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
    category: str = Query("", max_length=80),
) -> IntegrationCatalogResponse:
    from composio_client import list_catalog_apps

    try:
        result = list_catalog_apps(
            page=page,
            limit=limit,
            search=search,
            category=category,
        )
    except Exception as exc:
        logger.exception("Failed to load Composio catalog")
        raise HTTPException(status_code=502, detail=f"Composio catalog error: {exc}") from exc
    return IntegrationCatalogResponse(**result)


@app.get("/connections", response_model=List[ConnectionItem])
def list_connections() -> List[ConnectionItem]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, app_name, composio_connection_id, status, created_at, updated_at "
            "FROM composio_connections ORDER BY app_name"
        )
        rows = cursor.fetchall()
    return [ConnectionItem(**row_to_dict(r)) for r in rows]


@app.post("/connections", response_model=ConnectionInitResponse)
def initiate_connection(payload: ConnectionInitRequest) -> ConnectionInitResponse:
    from composio_client import initiate_connection as composio_initiate
    app_name = payload.app_name.lower().strip()
    if not app_name:
        raise HTTPException(status_code=400, detail="app_name is required")

    callback_url = _get_callback_url()
    try:
        result = composio_initiate(app_name, callback_url)
    except Exception as exc:
        logger.exception("Failed to initiate Composio connection for %s", app_name)
        raise HTTPException(status_code=502, detail=f"Composio error: {exc}") from exc

    composio_conn_id = result["composio_connection_id"]
    redirect_url = result["redirect_url"]

    # Upsert into local DB (replace any prior row for this app)
    conn_id = str(_uuid_mod.uuid4())
    now = now_iso()
    with get_db() as conn:
        # Check if row already exists for this app
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id FROM composio_connections WHERE app_name = ?", (app_name,)
        )
        existing = cursor.fetchone()
        if existing:
            conn_id = existing["id"]
            conn.execute(
                "UPDATE composio_connections SET composio_connection_id=?, status='initiated', updated_at=? WHERE id=?",
                (composio_conn_id, now, conn_id),
            )
        else:
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


@app.get("/connections/{connection_id}/status", response_model=ConnectionItem)
def get_connection_status(connection_id: str) -> ConnectionItem:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, app_name, composio_connection_id, status, created_at, updated_at "
            "FROM composio_connections WHERE id = ?",
            (connection_id,),
        )
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")

    item = row_to_dict(row)

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


# ---------------------------------------------------------------------------
# Integration trigger catalog + Composio event receiver
# ---------------------------------------------------------------------------

_trigger_catalog_cache: Dict[str, Any] = {"expires_at": 0.0, "items": None}
_trigger_catalog_lock = threading.Lock()


@app.get("/integrations/triggers")
def list_integration_triggers():
    """Proxy Composio's trigger catalog, cached for one hour."""
    now = time.monotonic()
    with _trigger_catalog_lock:
        if _trigger_catalog_cache["items"] is not None and now < _trigger_catalog_cache["expires_at"]:
            return {"items": _trigger_catalog_cache["items"]}

    try:
        from composio_client import list_triggers
        items = list_triggers()
    except Exception as exc:
        logger.exception("Failed to fetch Composio trigger catalog")
        raise HTTPException(status_code=502, detail=f"Composio error: {exc}") from exc

    with _trigger_catalog_lock:
        _trigger_catalog_cache["items"] = items
        _trigger_catalog_cache["expires_at"] = now + 3600
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
    """Receive signed Composio trigger webhooks and create worker runs."""
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


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------

@app.get("/system/platform-config")
def platform_config():
    """Return platform-level configuration vars with set/missing status (values never returned)."""
    items = []
    for name in sorted(PLATFORM_SECRETS):
        items.append({
            "name": name,
            "status": "set" if os.environ.get(name) else "missing",
        })
    return {"platform_secrets": items}


@app.get("/system/info")
def system_info():
    workers = discover_workers(use_cache=True)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as cnt FROM runs")
        run_count = cursor.fetchone()["cnt"]
    from runner_local import ARTIFACTS_DIR
    from worker_registry import WORKERS_DIR
    return {
        "api_version": app.version,
        "workers_dir": str(WORKERS_DIR),
        "db_path": DB_PATH,
        "artifacts_dir": str(ARTIFACTS_DIR),
        "run_count": run_count,
        "worker_count": len(workers),
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


@app.post("/webhooks/{worker_id}", response_model=ActionResponse)
async def webhook_trigger(worker_id: str, request: Request) -> ActionResponse:
    """Receive an incoming webhook and trigger a worker run.

    If the worker declares webhook.secret=true, the X-Floom-Signature header
    is verified. On success returns run_id immediately (non-blocking).
    """
    from webhook_service import get_webhook_secret_hash, verify_signature

    # Rate limit: 60 req/60s per (worker_id, client_ip) — in-memory sliding window
    client_ip = (request.client.host if request.client else "unknown")
    rl_key = f"{worker_id}:{client_ip}"
    if not _check_webhook_rate_limit(rl_key):
        raise HTTPException(status_code=429, detail="Too many webhook requests")

    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    config = get_worker_config_for_run(worker_id)
    if not config or config.trigger.type != "webhook":
        raise HTTPException(
            status_code=400,
            detail=f"Worker {worker_id!r} does not have a webhook trigger",
        )

    body = await request.body()

    # Signature verification (only when webhook.secret=true)
    webhook_cfg = config.trigger.webhook
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
    if not config or config.trigger.type != "webhook":
        raise HTTPException(
            status_code=400,
            detail=f"Worker {worker_id!r} does not have a webhook trigger",
        )

    raw_secret = generate_webhook_secret(worker_id)
    return WebhookSecretResponse(worker_id=worker_id, secret=raw_secret)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
