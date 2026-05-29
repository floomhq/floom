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
import subprocess
import uuid as _uuid_mod
import zipfile
import ipaddress
import math
import requests
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Dict, List, Optional, TypedDict

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Path as PathParam, Query, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.responses import StreamingResponse
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from dotenv import load_dotenv

from auth import AuthContext, get_auth_context, get_auth_provider
from auth.context import current_auth_user_id
from contexts import (
    MAX_CONTEXT_BYTES,
    CONTEXTS_DIR,
    context_scope_for_user,
    context_dir,
    context_file_metadata,
    context_owner_id,
    context_mount_names,
    context_total_size,
    context_updated_at,
    current_contexts_root,
    delete_context_metadata,
    ensure_contexts_dir,
    guess_mime_type,
    is_binary_file,
    iter_context_files,
    load_context_metadata,
    normalize_context_mount,
    normalize_context_file_path,
    safe_context_file_path,
    set_context_scope_resolver,
    set_context_metadata,
    use_context_scope,
    validate_context_name,
)

try:
    from slowapi.util import get_remote_address as _slowapi_get_remote_address
except Exception:  # pragma: no cover - fallback only used when dependency is absent locally
    _slowapi_get_remote_address = None

from db import DB_PATH, Repositories, get_db, get_repos, get_repositories, init_db, now_iso, sqlite_runtime_settings
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
from run_service import (
    create_run,
    fail_interrupted_runs_on_startup,
    re_enqueue_queued_runs_on_startup,
    get_worker_config_for_run,
    start_run,
    update_run_status,
    request_active_run_shutdown,
    start_drain_loop,
    stop_drain_loop,
    queued_run_position,
    InsufficientDiskSpaceError,
)
from run_service import register_sse_publisher, register_part_publisher

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
    register_part_publisher(_run_part_publish)
    # Startup
    _validate_startup_configuration()
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local":
        bootstrap_user_id = _bootstrap_user_id()
        _reload_workers_for_user(bootstrap_user_id)
        fail_interrupted_runs_on_startup(user_id=bootstrap_user_id)
        re_enqueue_queued_runs_on_startup()
        start_drain_loop()
        from scheduler import start_scheduler

        start_scheduler()
        # Launch hourly connection health sweep
        _sweep_task = asyncio.create_task(_hourly_sweep_loop())
    yield
    # Shutdown
    if deploy == "local":
        stop_drain_loop(timeout=5.0)
        from scheduler import stop_scheduler

        stop_scheduler()
        try:
            drain_timeout = float(os.environ.get("WORKEROS_SHUTDOWN_RUN_DRAIN_SECONDS", "75"))
        except ValueError:
            drain_timeout = 75.0
        cancelled_runs = await asyncio.to_thread(
            request_active_run_shutdown,
            timeout_seconds=drain_timeout,
        )
        if cancelled_runs:
            logger.warning("Shutdown requested cancellation for %d active run(s)", cancelled_runs)
        if _sweep_task:
            _sweep_task.cancel()
            try:
                await _sweep_task
            except asyncio.CancelledError:
                pass


app = FastAPI(
    title="Floom API",
    version="0.1.0",
    description="Open-source self-hosted runtime for AI workers",
    lifespan=lifespan,
)


@app.exception_handler(InsufficientDiskSpaceError)
async def insufficient_disk_space_handler(_request: Request, exc: InsufficientDiskSpaceError):
    return JSONResponse(
        status_code=507,
        content={"detail": "Insufficient disk space for run creation", "error": str(exc)},
    )


DEFAULT_JSON_BODY_LIMIT_BYTES = 256 * 1024
FROM_BUNDLE_BODY_LIMIT_BYTES = 5 * 1024 * 1024
DEFAULT_CHAT_MESSAGE_MAX_CHARS = 20_000
DEFAULT_RATE_LIMIT = (60, 60.0)
BODYLESS_METHODS = {"GET", "HEAD", "OPTIONS"}
RATE_LIMIT_RULES = [
    (re.compile(r"^/cli-auth/devices$"), (5, 60.0)),
    (re.compile(r"^/workers/from-bundle$"), (10, 60.0)),
    (re.compile(r"^/workers$"), (20, 60.0)),
    (re.compile(r"^/connections/connect/[^/]+$"), (10, 60.0)),
    (re.compile(r"^/connections$"), (20, 60.0)),
]

PROTECTED_STOCK_WORKER_IDS = frozenset(
    {
        "csv_enricher",
        "cv_writeup",
        "dach_compliance",
        "github-digest",
        "gmail_intake_brief",
        "kugelaudio-bug-intake",
        "kugelaudio-meeting-pipeline",
        "linkedin-post-engagements",
        "node-smoke-test",
        "openblog",
        "opendraft",
        "outbound-approval-demo",
        "research_brief",
        "reverse_match_crm",
        "slack-listener",
        "weekly_update",
        "whatsapp-listener",
        "worker-author",
        "workspace-agent",
    }
)

PUBLIC_STOCK_WORKER_IDS = frozenset(
    {
        "csv_enricher",
        "cv_writeup",
        "dach_compliance",
        "github-digest",
        "gmail_intake_brief",
        "linkedin-post-engagements",
        "node-smoke-test",
        "openblog",
        "opendraft",
        "outbound-approval-demo",
        "research_brief",
        "reverse_match_crm",
        "weekly_update",
    }
)

_INTERNAL_WORKER_ID_PREFIXES = (
    "_mcp_",
    "audit-local-",
    "smoke-",
)

# Engine/system knowledge packs that power Workeros itself (e.g. the
# worker-generation style guide). They are internal config, not operator
# content, so they are hidden from the /contexts operator view — the contexts
# equivalent of system_worker:true. A pack can also opt in via metadata
# {"system": true}.
SYSTEM_CONTEXT_PACKS = frozenset({"worker-author-style"})

# 1.5.2: trigger sources that belong in the operator /runs view. Everything
# else (audit, test, smoke runs like s35_concurrency_*, synthetic data, etc.)
# is internal telemetry and is hidden from the default view. Data is preserved
# and reachable via GET /runs?include_system=true.
_OPERATOR_TRIGGER_SOURCES = frozenset({
    "manual",
    "schedule",
    "approval",
    "composio",
    "webhook",
    "workspace-agent",
})


def _is_operator_run(row: Any) -> bool:
    source = (row_to_dict(row).get("trigger_source") or "").strip().lower()
    # Treat unknown/empty as operator-facing only if explicitly allowlisted;
    # blank trigger_source is legacy "manual" and stays visible.
    if not source:
        return True
    return source in _OPERATOR_TRIGGER_SOURCES


def _cors_allowed_origins() -> List[str]:
    configured = os.environ.get("ALLOWED_ORIGINS", "")
    if configured.strip():
        return [origin.strip() for origin in configured.split(",") if origin.strip()]

    origins = ["https://workers.floom.dev"]
    if os.environ.get("WORKEROS_DEV"):
        origins.extend(["http://localhost:3000", "http://localhost:3011"])
    return origins


def _cors_allowed_origin_regex() -> str:
    configured = os.environ.get("ALLOWED_ORIGIN_REGEX", "")
    if configured.strip():
        return configured.strip()
    if os.environ.get("WORKEROS_DEV"):
        return r"^https://[a-z0-9-]+\.workeros-[a-z0-9-]+\.vercel\.app$"
    return r"^https://([a-z0-9-]+\.)*floom\.dev$"


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allowed_origins(),
    allow_origin_regex=_cors_allowed_origin_regex(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _active_context_scope() -> str | None:
    return context_scope_for_user(current_auth_user_id())


set_context_scope_resolver(_active_context_scope)


def _validate_startup_configuration() -> None:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy != "local":
        get_auth_provider()


def _is_cloud_deploy() -> bool:
    """True when running in multi-tenant cloud mode.

    In cloud mode the shared filesystem WORKERS_DIR holds bundles from
    multiple tenants and MUST NOT be used as a fallback list source for
    any per-user endpoint. Defaults to False when WORKEROS_DEPLOY is unset
    so OSS single-tenant installs keep their first-time UX (empty DB ->
    enumerate filesystem).
    """
    return (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud"


async def require_secret(request: Request) -> str:
    """DEPRECATED: use Depends(get_auth_context) instead."""
    ctx = await get_auth_context(request)
    return ctx.user_id


def _connection_row_for_user(
    connection_id: str,
    user_id: str,
    columns: str,
    repos: Repositories | None = None,
) -> Dict[str, Any]:
    _ = columns
    row = (repos or get_repositories()).connections.get(
        user_id=user_id,
        composio_id=connection_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    return dict(row)


def _rate_limit_for_path(path: str) -> tuple[int, float]:
    for pattern, limit in RATE_LIMIT_RULES:
        if pattern.fullmatch(path):
            return limit
    return DEFAULT_RATE_LIMIT


def _client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    if _trusted_proxy_peer(peer):
        cf_connecting_ip = (request.headers.get("cf-connecting-ip") or "").strip()
        if _valid_ip_literal(cf_connecting_ip):
            return cf_connecting_ip

        forwarded_for = (request.headers.get("x-forwarded-for") or "").split(",", 1)[0].strip()
        if _valid_ip_literal(forwarded_for):
            return forwarded_for

    if _slowapi_get_remote_address is not None:
        return _slowapi_get_remote_address(request) or peer or "unknown"
    return peer or "unknown"


def _trusted_proxy_peer(peer: str) -> bool:
    configured = (
        os.environ.get("trusted_proxies")
        or os.environ.get("TRUSTED_PROXIES")
        or os.environ.get("WORKEROS_TRUSTED_PROXIES")
        or ""
    )
    entries = [entry.strip() for entry in configured.split(",") if entry.strip()]
    if not entries:
        return peer in {"testclient", "127.0.0.1", "::1", "localhost"}
    if "*" in entries:
        return True
    if peer in entries:
        return True
    try:
        peer_ip = ipaddress.ip_address(peer)
    except ValueError:
        return False
    for entry in entries:
        try:
            if "/" in entry and peer_ip in ipaddress.ip_network(entry, strict=False):
                return True
            if "/" not in entry and peer_ip == ipaddress.ip_address(entry):
                return True
        except ValueError:
            continue
    return False


def _valid_ip_literal(value: str) -> bool:
    if not value:
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _body_limit_for_request(request: Request) -> Optional[int]:
    method = request.method.upper()
    if method not in {"POST", "PUT", "PATCH"}:
        return None
    path = request.url.path
    if path == "/workers/from-bundle":
        return FROM_BUNDLE_BODY_LIMIT_BYTES
    if path.startswith("/uploads"):
        return None
    if path.startswith("/contexts"):
        return None
    return DEFAULT_JSON_BODY_LIMIT_BYTES


@app.middleware("http")
async def request_body_size_middleware(request: Request, call_next):
    if request.method.upper() in BODYLESS_METHODS:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > 0:
                    return JSONResponse(status_code=413, content={"detail": "Request body not allowed"})
            except ValueError:
                return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
        if request.headers.get("transfer-encoding"):
            return JSONResponse(status_code=413, content={"detail": "Request body not allowed"})
        return await call_next(request)

    max_bytes = _body_limit_for_request(request)
    if max_bytes is None:
        return await call_next(request)

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                return JSONResponse(status_code=413, content={"detail": "Request body too large"})
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})

    body = await request.body()
    if len(body) > max_bytes:
        return JSONResponse(status_code=413, content={"detail": "Request body too large"})
    return await call_next(request)


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

# Simple in-memory token bucket rate limit per client IP.
_rate_lock = threading.Lock()
_rate_buckets: Dict[str, list[float]] = {}


def _rate_caller_keys(request: Request, path: str) -> List[str]:
    return [f"ip:{_client_ip(request)}:{path}"]


def _run_create_quota_config() -> tuple[int, float]:
    try:
        limit = int(os.environ.get("WORKEROS_RUN_CREATE_RATE_LIMIT", "10"))
    except ValueError:
        limit = 10
    try:
        window = float(os.environ.get("WORKEROS_RUN_CREATE_RATE_WINDOW_SECONDS", "60"))
    except ValueError:
        window = 60.0
    return max(0, limit), max(1.0, window)


def _run_create_per_worker_limit() -> int:
    raw = os.environ.get("WORKEROS_RUN_CREATE_PER_WORKER_RATE_LIMIT")
    if raw is None:
        return 0
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def _run_replay_per_run_limit() -> int:
    raw = os.environ.get("WORKEROS_RUN_REPLAY_PER_RUN_RATE_LIMIT")
    if raw is None:
        return 0
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def _claim_run_create_quota_slot(key: str, *, limit: int, window: float) -> Optional[int]:
    if limit <= 0:
        return None

    now = time.time()
    cutoff = now - window
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS run_create_rate_limits (
                key TEXT NOT NULL,
                ts REAL NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_run_create_rate_limits_key_ts ON run_create_rate_limits(key, ts)"
        )
        conn.execute("DELETE FROM run_create_rate_limits WHERE ts <= ?", (cutoff,))
        row = conn.execute(
            "SELECT COUNT(*) AS count, MIN(ts) AS oldest_ts FROM run_create_rate_limits WHERE key = ?",
            (key,),
        ).fetchone()
        count = int(row["count"] or 0) if row else 0
        if count >= limit:
            oldest_ts = float(row["oldest_ts"] or now) if row else now
            retry_after = max(1, int(math.ceil((oldest_ts + window) - now)))
            return retry_after
        conn.execute("INSERT INTO run_create_rate_limits (key, ts) VALUES (?, ?)", (key, now))
    return None


def _raise_run_create_quota(limit: int, window: float, retry_after: int) -> None:
    raise HTTPException(
        status_code=429,
        detail=f"Run creation rate limit exceeded: {limit}/{int(window)}s",
        headers={"Retry-After": str(retry_after)},
    )


def _enforce_run_create_quota(auth: AuthContext, worker_id: str) -> None:
    limit, window = _run_create_quota_config()
    retry_after = _claim_run_create_quota_slot(
        f"user:{auth.user_id}:runs",
        limit=limit,
        window=window,
    )
    if retry_after is not None:
        _raise_run_create_quota(limit, window, retry_after)

    per_worker_limit = _run_create_per_worker_limit()
    retry_after = _claim_run_create_quota_slot(
        f"user:{auth.user_id}:worker:{worker_id}",
        limit=per_worker_limit,
        window=window,
    )
    if retry_after is not None:
        _raise_run_create_quota(per_worker_limit, window, retry_after)


def _enforce_run_replay_quota(auth: AuthContext, worker_id: str, source_run_id: str) -> None:
    replay_limit = _run_replay_per_run_limit()
    if replay_limit <= 0:
        return
    _limit, window = _run_create_quota_config()
    retry_after = _claim_run_create_quota_slot(
        f"user:{auth.user_id}:worker:{worker_id}:replay:{source_run_id}",
        limit=replay_limit,
        window=window,
    )
    if retry_after is not None:
        _raise_run_create_quota(replay_limit, window, retry_after)


def _chat_quota_config() -> tuple[int, float]:
    """Per-user /chat quota.

    /chat calls OpenAI on every request (the workspace agent), so an
    unbounded caller can run up a real LLM bill. The shared IP rate limiter
    (60/60s) is too loose for a paid-LLM path; enforce a tighter per-user cap
    keyed on the authenticated user, durable across restarts via the same
    DB-backed sliding window used for run-create.
    """
    try:
        limit = int(os.environ.get("WORKEROS_CHAT_RATE_LIMIT", "20"))
    except ValueError:
        limit = 20
    try:
        window = float(os.environ.get("WORKEROS_CHAT_RATE_WINDOW_SECONDS", "60"))
    except ValueError:
        window = 60.0
    return max(0, limit), max(1.0, window)


def _enforce_chat_quota(auth: AuthContext) -> None:
    limit, window = _chat_quota_config()
    retry_after = _claim_run_create_quota_slot(
        f"user:{auth.user_id}:chat",
        limit=limit,
        window=window,
    )
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail=f"Chat rate limit exceeded: {limit}/{int(window)}s",
            headers={"Retry-After": str(retry_after)},
        )


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Apply per-IP and per-secret limits. Exempt webhooks and health checks."""
    path = request.url.path
    if path.startswith("/webhooks/") or path in {"/healthz", "/health"}:
        return await call_next(request)
    if not os.environ.get("FLOOM_SECRET") and os.environ.get("WORKEROS_RATE_LIMIT_DEV") != "1":
        return await call_next(request)

    limit, window = _rate_limit_for_path(path)
    now = time.time()
    keys = _rate_caller_keys(request, path)
    with _rate_lock:
        for key in keys:
            bucket = [t for t in _rate_buckets.get(key, []) if t > now - window]
            _rate_buckets[key] = bucket
            if len(bucket) >= limit:
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Rate limit exceeded"},
                    headers={"Retry-After": str(int(window))},
                )
        for key in keys:
            _rate_buckets[key].append(now)
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
            or _RE_RUN_COMPOSIO_PROXY.match(path)
        ):
            return await call_next(request)
        header = request.headers.get("x-floom-secret", "")
        if header != secret:
            from fastapi.responses import JSONResponse as _JSONResponse
            return _JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)

logger = logging.getLogger("floom.api")

# Regex for run-authenticated Composio proxy (no x-floom-secret required;
# auth is by run_id which the sandbox knows as FLOOM_RUN_ID).
import re as _re
_RE_RUN_COMPOSIO_PROXY = _re.compile(r"^/runs/[a-zA-Z0-9_-]+/composio-execute/[A-Z0-9_]+$")

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
_run_part_buffers: Dict[str, Dict[str, Any]] = {}
_run_part_cleanup_timers: Dict[str, threading.Timer] = {}
_run_part_lock = threading.Lock()
_RUN_PART_TTL_SECONDS = 300

_TERMINAL_STATUSES = frozenset({
    RunStatus.COMPLETED.value,
    RunStatus.FAILED.value,
})


# ---------------------------------------------------------------------------
# Per-user concurrent SSE stream cap (Round 16 DoS finding)
# ---------------------------------------------------------------------------
# Unlimited concurrent SSE streams (/runs/<id>/stream + /runs/<id>/events) are
# a DoS vector: each open stream holds a connection + queue + worker slot. Cap
# the number of simultaneous streams per user with a simple in-process counter
# keyed by user_id. The slot is always released on disconnect via the
# contextmanager's finally block, so a dropped client frees its slot.
_sse_user_stream_counts: Dict[str, int] = {}
_sse_stream_count_lock = threading.Lock()


def _max_concurrent_streams() -> int:
    try:
        return max(1, int(os.environ.get("WORKEROS_MAX_CONCURRENT_STREAMS", "10")))
    except (TypeError, ValueError):
        return 10


def _sse_stream_acquire(user_id: str) -> str:
    """Reserve a per-user SSE stream slot or raise 429 if the cap is exceeded.

    Returns the registry key to pass to _sse_stream_release. Acquisition happens
    synchronously in the endpoint body so the 429 is returned before any
    StreamingResponse is constructed.
    """
    cap = _max_concurrent_streams()
    key = user_id or "anonymous"
    with _sse_stream_count_lock:
        current = _sse_user_stream_counts.get(key, 0)
        if current >= cap:
            raise HTTPException(
                status_code=429,
                detail="Too many concurrent streams. Close existing streams and retry.",
            )
        _sse_user_stream_counts[key] = current + 1
    return key


def _sse_stream_release(key: str) -> None:
    """Free a previously reserved per-user SSE stream slot.

    Called from the generator's finally block so a dropped/disconnected client
    always frees its slot.
    """
    with _sse_stream_count_lock:
        remaining = _sse_user_stream_counts.get(key, 0) - 1
        if remaining <= 0:
            _sse_user_stream_counts.pop(key, None)
        else:
            _sse_user_stream_counts[key] = remaining


def _sse_publish(run_id: str, event: Dict[str, Any]) -> None:
    """Publish an SSE event to all active consumers for a run.

    Called from run_service (worker threads) after each state change.
    asyncio.Queue is not thread-safe, so we route the put through each
    queue's bound loop via call_soon_threadsafe.
    """
    public_event = _public_sse_event(event)
    with _sse_lock:
        entries = list(_sse_queues.get(run_id, []))
    for q, loop in entries:
        def _put(q=q, event=public_event):
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


def _run_part_state(run_id: str) -> Dict[str, Any]:
    state = _run_part_buffers.get(run_id)
    if state is None:
        state = {
            "next_id": 0,
            "parts": collections.deque(maxlen=2000),
            "queues": [],
            "finished_at": None,
        }
        _run_part_buffers[run_id] = state
    return state


def _run_part_is_finish(part: Dict[str, Any]) -> bool:
    return part.get("type") == "finish"


def _cancel_run_part_cleanup(run_id: str) -> None:
    timer = _run_part_cleanup_timers.pop(run_id, None)
    if timer is not None:
        timer.cancel()


def _schedule_run_part_cleanup(run_id: str) -> None:
    def _cleanup() -> None:
        with _run_part_lock:
            _run_part_buffers.pop(run_id, None)
            _run_part_cleanup_timers.pop(run_id, None)

    with _run_part_lock:
        _cancel_run_part_cleanup(run_id)
        timer = threading.Timer(_RUN_PART_TTL_SECONDS, _cleanup)
        timer.daemon = True
        _run_part_cleanup_timers[run_id] = timer
        timer.start()


def _run_part_publish(run_id: str, part: Dict[str, Any]) -> None:
    """Publish one AI SDK part to the replay buffer and active consumers."""
    public_part = _public_run_part(part)
    with _run_part_lock:
        state = _run_part_state(run_id)
        event_id = state["next_id"]
        state["next_id"] = event_id + 1
        state["parts"].append((event_id, public_part))
        if _run_part_is_finish(public_part):
            state["finished_at"] = time.time()
        entries = list(state["queues"])

    for q, loop in entries:
        def _put(q=q, event_id=event_id, part=public_part):
            try:
                q.put_nowait((event_id, part))
            except asyncio.QueueFull:
                logger.warning("Run part queue full for run %s, dropping part", run_id)

        try:
            loop.call_soon_threadsafe(_put)
        except RuntimeError:
            pass

    if _run_part_is_finish(public_part):
        _schedule_run_part_cleanup(run_id)


def _run_part_register(run_id: str, q: asyncio.Queue, loop: asyncio.AbstractEventLoop) -> None:
    with _run_part_lock:
        state = _run_part_state(run_id)
        _cancel_run_part_cleanup(run_id)
        state["queues"].append((q, loop))


def _run_part_cleanup(run_id: str, q: asyncio.Queue) -> None:
    with _run_part_lock:
        state = _run_part_buffers.get(run_id)
        if not state:
            return
        state["queues"] = [(eq, el) for (eq, el) in state["queues"] if eq is not q]
        finished = state.get("finished_at") is not None
    if finished:
        _schedule_run_part_cleanup(run_id)


def _run_part_snapshot(run_id: str) -> Optional[Dict[str, Any]]:
    with _run_part_lock:
        state = _run_part_buffers.get(run_id)
        if state is None:
            return None
        return {
            "parts": list(state["parts"]),
            "finished": state.get("finished_at") is not None,
        }


def _format_run_part_sse(event_id: int, part: Dict[str, Any]) -> str:
    return f"id: {event_id}\nevent: part\ndata: {json.dumps(part)}\n\n"


def _parse_last_event_id(value: Optional[str]) -> int:
    if not value:
        return -1
    try:
        return int(value)
    except ValueError:
        return -1


def _finish_part_from_run_row(row: sqlite3.Row) -> Optional[Dict[str, Any]]:
    status = row["status"]
    if status == RunStatus.COMPLETED.value:
        return {"type": "finish", "status": "completed"}
    if status == RunStatus.FAILED.value:
        part: Dict[str, Any] = {"type": "finish", "status": "failed"}
        if row["error"]:
            part["error"] = _redact_public_log_message(str(row["error"]))
        return part
    return None


def _log_replay_parts(repos: "Repositories", user_id: str, run_id: str) -> List[Dict[str, Any]]:
    """Build replay parts from persisted log rows for a run.

    When a client opens the stream for a run whose in-memory part buffer is
    gone (terminal run after the buffer TTL'd out, or a fresh server process),
    the live tail is empty. Without this, the stream emitted only the finish
    part and the historical logs were lost (#188). Replaying the persisted log
    rows lets the UI reconstruct the transcript.
    """
    parts: List[Dict[str, Any]] = []
    try:
        rows = repos.runs.list_logs(user_id=user_id, run_id=run_id)
    except Exception:
        logger.exception("Failed to load logs for SSE replay (run %s)", run_id)
        return parts
    for r in rows:
        row = row_to_dict(r)
        parts.append(
            {
                "type": "log",
                "level": row.get("level"),
                "message": _redact_public_log_message(row.get("message") or ""),
                "timestamp": row.get("timestamp"),
            }
        )
    return parts


# ---------------------------------------------------------------------------
# Health checks
# ---------------------------------------------------------------------------

_HEALTH_CACHE: Dict[str, Any] = {"checked_at": 0.0, "payload": None}
_HEALTH_CACHE_TTL_SECONDS = 60.0


def _health_check_db() -> Dict[str, Any]:
    with get_db() as conn:
        conn.execute("SELECT 1").fetchone()
    return {"ok": True}


def _health_check_e2b() -> Dict[str, Any]:
    if not os.environ.get("E2B_API_KEY"):
        return {"ok": False, "error": "E2B_API_KEY missing"}
    from e2b import Sandbox

    Sandbox.list(limit=1).next_items()
    return {"ok": True}


def _health_check_openai() -> Dict[str, Any]:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return {"ok": False, "error": "OPENAI_API_KEY missing"}
    response = requests.get(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {key}"},
        timeout=3,
    )
    return {"ok": response.status_code == 200, "status_code": response.status_code}


def _health_check_composio() -> Dict[str, Any]:
    key = os.environ.get("COMPOSIO_API_KEY")
    if not key:
        return {"ok": False, "error": "COMPOSIO_API_KEY missing"}
    response = requests.get(
        "https://backend.composio.dev/api/v3/toolkits",
        headers={"x-api-key": key},
        params={"limit": 1},
        timeout=3,
    )
    return {"ok": response.status_code == 200, "status_code": response.status_code}


def _run_health_checks() -> Dict[str, Any]:
    now = time.monotonic()
    cached = _HEALTH_CACHE.get("payload")
    if cached is not None and now - float(_HEALTH_CACHE.get("checked_at") or 0.0) < _HEALTH_CACHE_TTL_SECONDS:
        return cached
    checks: Dict[str, Any] = {}
    for name, fn in {
        "db": _health_check_db,
        "e2b": _health_check_e2b,
        "openai": _health_check_openai,
        "composio": _health_check_composio,
    }.items():
        try:
            checks[name] = fn()
        except Exception as exc:
            checks[name] = {"ok": False, "error": str(exc)[:300]}
    payload = {
        "status": "ok" if all(check.get("ok") for check in checks.values()) else "degraded",
        "checks": checks,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    _HEALTH_CACHE["checked_at"] = now
    _HEALTH_CACHE["payload"] = payload
    return payload


@app.get("/healthz")
def healthz():
    """Liveness probe — exempt from x-floom-secret."""
    return {"status": "ok"}


@app.get("/health")
def health():
    """Readiness probe with cached dependency checks."""
    return _run_health_checks()


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.exception_handler(ValueError)
async def value_error_handler(_request, exc: ValueError):
    logger.warning("Validation error: %s", exc)
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def _redacted_validation_errors(errors: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    sanitized: List[Dict[str, str]] = []
    for error in errors[:10]:
        sanitized.append(
            {
                "loc": "request",
                "msg": str(error.get("msg") or "invalid value"),
                "type": str(error.get("type") or "value_error"),
            }
        )
    return sanitized


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(_request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"detail": "validation failed", "errors": _redacted_validation_errors(exc.errors())},
    )


@app.exception_handler(ValidationError)
async def pydantic_validation_error_handler(_request, exc: ValidationError):
    return JSONResponse(
        status_code=422,
        content={"detail": "validation failed", "errors": _redacted_validation_errors(exc.errors())},
    )


@app.exception_handler(Exception)
async def generic_error_handler(_request, exc: Exception):
    logger.exception("Unhandled exception")
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def row_to_dict(row: Any) -> Dict[str, Any]:
    if row is None:
        return {}
    if isinstance(row, dict):
        return dict(row)
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
    if value == "pending_approval":
        return "pending_approval"
    if value in {"running", "queued"}:
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
        "pending_approval": ["pending_approval"],
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


_SENSITIVE_ARTIFACT_FILENAMES = frozenset({"transcript.jsonl"})


def _is_sensitive_artifact_name(name: str) -> bool:
    normalized = (name or "").replace("\\", "/").rsplit("/", 1)[-1].lower()
    return normalized in _SENSITIVE_ARTIFACT_FILENAMES


def _is_sensitive_artifact_row(row: Any) -> bool:
    data = row_to_dict(row)
    return _is_sensitive_artifact_name(str(data.get("name") or data.get("path") or ""))


def _raise_if_protected_worker_mutation(worker_id: str) -> None:
    if worker_id in PROTECTED_STOCK_WORKER_IDS:
        raise HTTPException(status_code=403, detail="Stock workers cannot be modified through the API")


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


def _get_last_run_for_worker(
    worker_id: str,
    *,
    user_id: str,
    repos: Repositories,
) -> Optional[Dict[str, Any]]:
    row = repos.workers.get_last_run(user_id=user_id, worker_id=worker_id)
    return dict(row) if row else None


def _make_run_summary(row: Any) -> RunSummary:
    d = row_to_dict(row)
    status_value = str(d.get("status") or "").lower()
    status_aliases = {
        "approved": RunStatus.COMPLETED.value,
        "success": RunStatus.COMPLETED.value,
        "rejected": RunStatus.FAILED.value,
        "error": RunStatus.FAILED.value,
        "cancelled": RunStatus.FAILED.value,
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
        error=_operator_error_message(d.get("error"), d.get("error_code")),
        error_code=d.get("error_code"),
    )


def _get_stats_batch(
    worker_ids: List[str],
    *,
    user_id: str,
    repos: Repositories,
) -> Dict[str, RecentStats]:
    """Batch-query 7-day run stats for a list of worker IDs in one SQL call."""
    if not worker_ids:
        return {}
    placeholders = ",".join("?" for _ in worker_ids)
    try:
        return repos.workers.stats_batch(user_id=user_id, worker_ids=worker_ids)
    except sqlite3.OperationalError:
        return {}


def _get_timeseries_batch(
    worker_ids: List[str],
    *,
    user_id: str,
    repos: Repositories,
    days: int = 14,
) -> Dict[str, List[TimeseriesDay]]:
    """Batch-query per-day run counts for sparkline charts (last N days).

    Returns a dict mapping worker_id -> list of N TimeseriesDay objects,
    oldest first, zero-filled for days with no runs.
    """
    if not worker_ids:
        return {}
    try:
        return repos.workers.timeseries_batch(user_id=user_id, worker_ids=worker_ids, days=days)
    except sqlite3.OperationalError:
        return {}


@app.get("/workers/{worker_id}/runs/timeseries", response_model=List[TimeseriesDay])
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


def _bootstrap_user_id() -> str:
    configured = (os.environ.get("WORKEROS_USER_ID") or "").strip()
    return configured or "federico"


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


def _persist_discovered_workers(
    conn: sqlite3.Connection,
    workers: List[Dict[str, Any]],
    *,
    user_id: str,
) -> None:
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
        # Archived workers are disabled from the scheduler: they never fire cron runs.
        is_archived = manifest.get("archived") is True
        enabled_value = 0 if is_archived or manifest.get("paused") is True or manifest.get("enabled") is False else 1

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
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                skill_version_id=excluded.skill_version_id,
                name=excluded.name,
                trigger_type=excluded.trigger_type,
                cron_expr=excluded.cron_expr,
                cron_timezone=excluded.cron_timezone,
                enabled=excluded.enabled,
                owner_id=workers.owner_id,
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
                enabled_value,
                now,
                user_id,
                composio_trigger_id,
                composio_event,
                triggers_json_str,
            ),
        )

        # Mirror to the canonical repository so non-local deployments
        # (e.g. managed-deployment -> Supabase) actually persist the row.
        # Local SQLite already writes through `conn` above. Calling the
        # repository here would open a second SQLite connection while the
        # first transaction is still active and can fail startup with
        # `database is locked`.
        try:
            from db.factory import get_repositories
            from db.sqlite import SqliteWorkerRepository

            canonical_workers = get_repositories().workers
            if not isinstance(canonical_workers, SqliteWorkerRepository):
                canonical_workers.upsert(
                    user_id=user_id,
                    worker_id=worker_id,
                    name=w["name"],
                    manifest_json=manifest,
                    bundle_path=str((WORKERS_DIR / worker_id).resolve()),
                    skill_version_id=skill_version_id,
                    trigger_type=(
                        primary_trigger_type
                        or trigger.get("type")
                        or w.get("trigger_type")
                        or "manual"
                    ),
                    cron_expr=trigger.get("cron"),
                    cron_timezone=trigger.get("timezone"),
                    created_at=now,
                    composio_trigger_id=composio_trigger_id,
                    composio_event=composio_event,
                    triggers_json=triggers_list,
                )
        except Exception:
            logger.exception(
                "repos.workers.upsert failed for worker %s (user %s) — "
                "filesystem bundle written, but DB row may be missing",
                worker_id,
                user_id,
            )
            raise


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
        "is_example": manifest_dict.get("is_example"),
        "archived": bool(manifest_dict.get("archived", False)),
        "archive_reason": manifest_dict.get("archive_reason"),
        "tags": manifest_dict.get("tags") or [],
        "folder": manifest_dict.get("folder"),
        "status": "healthy",
        "trigger_type": d.get("trigger_type") or (config.trigger.type if config else "manual"),
        "runner": config.runtime.runner if config and config.runtime else "local",
        "config": config.model_dump(mode="json") if config else {},
        "manifest": manifest_dict,
        "triggers_json": d.get("triggers_json"),
    }


def _list_db_workers(
    *,
    user_id: str,
    repos: Repositories,
) -> List[Dict[str, Any]]:
    try:
        return repos.workers.list(user_id=user_id)
    except sqlite3.OperationalError:
        return []


def _user_scoped_local_mode() -> bool:
    return os.environ.get("WORKEROS_ENABLE_USER_HEADER_SCOPE") == "1"


def _shared_filesystem_fallback_allowed() -> bool:
    return not _is_cloud_deploy() and not _user_scoped_local_mode()


@lru_cache(maxsize=1)
def _tracked_worker_ids() -> frozenset[str]:
    repo_root = Path(__file__).resolve().parents[2]
    try:
        tracked = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files", "workers/*/worker.yml"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        worker_ids = {
            worker_yml.parent.name
            for worker_yml in (repo_root / "workers").glob("*/worker.yml")
            if worker_yml.is_file()
        }
    else:
        worker_ids = {
            Path(line.strip()).parent.name
            for line in tracked.stdout.splitlines()
            if line.strip().endswith("/worker.yml")
        }
    return frozenset(worker_ids)


def _worker_hidden_from_api(worker_id: str) -> bool:
    if any(worker_id.startswith(prefix) for prefix in _INTERNAL_WORKER_ID_PREFIXES):
        return True
    tracked_ids = _tracked_worker_ids()
    if worker_id in tracked_ids:
        return worker_id not in PUBLIC_STOCK_WORKER_IDS
    return False


def _worker_source_visible_to_api(worker_id: str) -> bool:
    if _worker_hidden_from_api(worker_id):
        return False
    # Public stock/example workers ship their source on purpose — the Source
    # tab is meant to show run.py / SKILL.md / worker.yml so users can learn
    # from and fork them. These are git-tracked, so the generic
    # "not tracked" rule below would hide them (R3: /workers/<stock>#code was
    # empty for every example worker). Make stock source explicitly visible.
    if worker_id in PUBLIC_STOCK_WORKER_IDS:
        return True
    return worker_id not in _tracked_worker_ids()


def _stock_workers_from_filesystem(*, use_cache: bool = True) -> List[Dict[str, Any]]:
    return [
        worker
        for worker in discover_workers(use_cache=use_cache)
        if worker["id"] in PUBLIC_STOCK_WORKER_IDS
    ]


def _list_visible_workers(
    *,
    user_id: str,
    repos: Repositories,
    use_cache: bool = True,
) -> List[Dict[str, Any]]:
    visible = {
        worker["id"]: worker
        for worker in _list_db_workers(user_id=user_id, repos=repos)
        if not _worker_hidden_from_api(worker["id"])
    }
    for worker in _stock_workers_from_filesystem(use_cache=use_cache):
        visible.setdefault(worker["id"], worker)
    if _shared_filesystem_fallback_allowed():
        for worker in discover_workers(use_cache=use_cache):
            worker_id = str(worker.get("id") or "")
            if worker_id and not _worker_hidden_from_api(worker_id):
                visible.setdefault(worker_id, worker)
    return list(visible.values())


def _list_operator_workers(
    *,
    user_id: str,
    repos: Repositories,
    use_cache: bool = True,
) -> List[Dict[str, Any]]:
    """Workers shown in the operator's default view.

    Same filter as the default GET /workers view: visible (non-hidden) workers,
    minus system_worker:true and archived. Shared by /workers and the overview
    'Workers active' count so the two numbers cannot drift (1.5.4).
    """
    workers = _list_visible_workers(user_id=user_id, repos=repos, use_cache=use_cache)
    workers = [
        w for w in workers
        if not (w.get("manifest") or {}).get("system_worker", False)
    ]
    workers = [w for w in workers if not w.get("archived", False)]
    return workers


def _get_db_worker(
    worker_id: str,
    *,
    user_id: str,
    repos: Repositories,
) -> Optional[Dict[str, Any]]:
    try:
        return repos.workers.get(user_id=user_id, worker_id=worker_id)
    except sqlite3.OperationalError:
        return None


def _archived_tracked_worker(worker_id: str) -> Optional[Dict[str, Any]]:
    """Return a tracked worker's filesystem record iff it is archived.

    Archived workers are intentionally inactive but NOT deleted: the detail
    page must still render them (archived badge + reason + Restore) instead of
    404ing (1.5.3). Only archived workers get this fallback — other hidden
    tracked workers stay hidden.
    """
    if worker_id not in _tracked_worker_ids():
        return None
    worker = get_worker(worker_id)
    if worker is not None and worker.get("archived"):
        return worker
    return None


def _get_visible_worker(
    worker_id: str,
    *,
    user_id: str,
    repos: Repositories,
) -> Optional[Dict[str, Any]]:
    worker = _get_db_worker(worker_id, user_id=user_id, repos=repos)
    if worker is not None:
        if _worker_hidden_from_api(worker["id"]):
            # Archived workers stay reachable for detail rendering (not 404).
            if worker.get("archived"):
                return worker
            archived = _archived_tracked_worker(worker["id"])
            if archived is not None:
                return archived
            return None
        return worker
    if _worker_hidden_from_api(worker_id):
        # 1.5.3: archived tracked workers must render, not 404. Archived means
        # inactive, not deleted.
        archived = _archived_tracked_worker(worker_id)
        if archived is not None:
            return archived
        return None
    if _shared_filesystem_fallback_allowed() or worker_id in PUBLIC_STOCK_WORKER_IDS:
        return get_worker(worker_id)
    return None


def _run_visible_to_api(row: Any, *, user_id: str, repos: Repositories) -> bool:
    worker_id = str(row_to_dict(row).get("worker_id") or "")
    if not worker_id:
        return False
    return _get_visible_worker(worker_id, user_id=user_id, repos=repos) is not None


def _get_visible_run(
    run_id: str,
    *,
    user_id: str,
    repos: Repositories,
) -> Any:
    row = repos.runs.get(user_id=user_id, run_id=run_id)
    if row is None or not _run_visible_to_api(row, user_id=user_id, repos=repos):
        return None
    return row


# Hidden/system workers whose runs the operator nonetheless drives directly by
# run_id through the product UI, so single-run-by-id reads must NOT be filtered
# out the way the LIST view filters them. Currently just the generation
# meta-worker: POST /workers/new/from-prompt returns its run_id and the
# /workers/new GeneratingPanel polls GET /runs/{id} + /stream + /events + /logs.
#
# This is deliberately an ALLOWLIST, not "any hidden worker": internal infra
# workers (e.g. the slack-listener trigger) stay inaccessible by id — see
# test_round8_worker_authz.test_hidden_internal_worker_runs_stay_inaccessible.
# "worker-author" — kept as a literal because _WORKER_AUTHOR_ID is defined
# later in the module; asserted equal in a test.
_OPERATOR_REACHABLE_HIDDEN_WORKER_IDS = frozenset({"worker-author"})


def _get_run_by_explicit_id(
    run_id: str,
    *,
    user_id: str,
    repos: Repositories,
) -> Any:
    """Fetch a run by its EXACT id, scoped to the caller's workspace.

    Returns the run if EITHER:
      - it passes the normal visibility filter (``_get_visible_run``), OR
      - its worker is in ``_OPERATOR_REACHABLE_HIDDEN_WORKER_IDS`` (the
        generation meta-worker), which the operator drives directly by run_id
        from the product UI.

    The system/audit visibility filter (``_run_visible_to_api`` ->
    ``_worker_hidden_from_api``) is for the LIST view: it keeps meta/system runs
    out of the operator's default /runs listing. But the /workers/new generation
    UI already holds the precise worker-author ``run_id`` (returned by POST
    /workers/new/from-prompt) and must be able to read its
    detail/logs/output/stream/events to drive the GeneratingPanel. Filtering
    those out returned a spurious 404 and hung generation (regression from PR
    #231/#235).

    This stays an allowlist so internal infra workers (slack-listener etc.)
    remain inaccessible by id. Authorization is enforced via the user-scoped
    ``repos.runs.get``.
    """
    row = repos.runs.get(user_id=user_id, run_id=run_id)
    if row is None:
        return None
    if _run_visible_to_api(row, user_id=user_id, repos=repos):
        return row
    worker_id = str(row_to_dict(row).get("worker_id") or "")
    if worker_id in _OPERATOR_REACHABLE_HIDDEN_WORKER_IDS:
        return row
    return None


def _list_visible_runs(
    *,
    user_id: str,
    repos: Repositories,
    worker_id: str | None = None,
    statuses: list[str] | None = None,
    since: str | None = None,
    until: str | None = None,
    limit: int = 50,
    offset: int = 0,
    include_system: bool = False,
) -> tuple[list[Any], int]:
    batch_size = max(limit, 100)
    raw_offset = 0
    raw_total_count: int | None = None
    visible_total = 0
    visible_rows: list[Any] = []

    while raw_total_count is None or raw_offset < raw_total_count:
        rows, raw_total_count = repos.runs.list(
            user_id=user_id,
            worker_id=worker_id,
            statuses=statuses,
            since=since,
            until=until,
            limit=batch_size,
            offset=raw_offset,
        )
        if not rows:
            break
        raw_offset += len(rows)
        for row in rows:
            if not _run_visible_to_api(row, user_id=user_id, repos=repos):
                continue
            # 1.5.2: hide audit/system/test telemetry from the default
            # operator view unless explicitly requested.
            if not include_system and not _is_operator_run(row):
                continue
            visible_total += 1
            if visible_total <= offset:
                continue
            if len(visible_rows) < limit:
                visible_rows.append(row)
    return visible_rows, visible_total


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
            if not _user_owns_uploaded_file(conn, row["id"], bound_by):
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
                try:
                    conn.execute(
                        """
                        INSERT INTO file_binding_audit
                            (run_id, worker_id, input_name, file_id, uploaded_by, bound_by, bound_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (run_id, worker_id, inp.name, row["id"], file_owner, bound_by, now_iso()),
                    )
                except sqlite3.OperationalError as exc:
                    logger.debug("file_binding_audit write skipped: %s", exc)
                raise HTTPException(status_code=403, detail=f"Uploaded file not found: {inp.name}")

            ext = extension_for_file(row["filename"], row["media_type"])
            mounted = run_inputs_dir / f"{inp.name}{ext}"
            shutil.copyfile(source, mounted)
            # Store absolute path so runners don't need cwd tricks to locate the file.
            resolved_inputs[inp.name] = str(mounted)
            bound_file_ids.append(row["id"])

    _increment_file_ref_counts(bound_file_ids)

    return resolved_inputs


_DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
_DEFAULT_UPLOAD_HOURLY_CAP_BYTES = 1024 * 1024 * 1024
_UPLOAD_HOURLY_WINDOW_SECONDS = 3600.0
_UPLOAD_ALLOWED_MEDIA_TYPES = frozenset({
    "application/json",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/yaml",
    "application/zip",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/csv",
    "text/markdown",
    "text/plain",
})
_UPLOAD_ALLOWED_EXTENSIONS = frozenset({
    ".csv",
    ".docx",
    ".gif",
    ".jpeg",
    ".jpg",
    ".json",
    ".md",
    ".markdown",
    ".pdf",
    ".png",
    ".txt",
    ".webp",
    ".xlsx",
    ".yaml",
    ".yml",
    ".zip",
})
_UPLOAD_BLOCKED_EXTENSIONS = frozenset({
    ".bat",
    ".cmd",
    ".dll",
    ".exe",
    ".js",
    ".php",
    ".ps1",
    ".sh",
})
_upload_quota_lock = threading.Lock()
_upload_quota_store: Dict[str, collections.deque] = {}


def _positive_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _chat_message_max_chars() -> int:
    return _positive_int_env("WORKEROS_CHAT_MESSAGE_MAX_CHARS", DEFAULT_CHAT_MESSAGE_MAX_CHARS)


def _upload_max_bytes() -> int:
    return _positive_int_env("WORKEROS_UPLOAD_MAX_BYTES", _DEFAULT_UPLOAD_MAX_BYTES)


def _upload_hourly_cap_bytes() -> int:
    return _positive_int_env("WORKEROS_UPLOAD_HOURLY_CAP_BYTES", _DEFAULT_UPLOAD_HOURLY_CAP_BYTES)


def _format_bytes(value: int) -> str:
    if value % (1024 * 1024) == 0:
        return f"{value // (1024 * 1024)} MiB"
    return f"{value} bytes"


def _upload_quota_key(request: Request) -> str:
    secret = request.headers.get("x-floom-secret") or ""
    if not secret:
        return "anon"
    return "s:" + hashlib.sha256(secret.encode()).hexdigest()[:16]


def _claim_upload_quota(request: Request, size: int) -> Optional[int]:
    now = time.monotonic()
    cutoff = now - _UPLOAD_HOURLY_WINDOW_SECONDS
    cap = _upload_hourly_cap_bytes()
    key = _upload_quota_key(request)
    with _upload_quota_lock:
        dq = _upload_quota_store.setdefault(key, collections.deque())
        while dq and dq[0][0] <= cutoff:
            dq.popleft()
        used = sum(entry_size for _entry_ts, entry_size in dq)
        if used + size > cap:
            return cap
        dq.append((now, size))
        return None


def _validate_upload_filename(raw_filename: str) -> None:
    if not raw_filename:
        raise HTTPException(status_code=400, detail="filename is required")
    if (
        "%00" in raw_filename.lower()
        or any(ord(char) < 32 or ord(char) == 127 for char in raw_filename)
    ):
        raise HTTPException(
            status_code=400,
            detail="filename must not contain control characters",
        )
    if (
        "/" in raw_filename
        or "\\" in raw_filename
        or raw_filename.startswith(".")
        or ".." in raw_filename.split("/")
    ):
        raise HTTPException(
            status_code=400,
            detail="filename must not contain path separators, leading dots, or '..' segments",
        )
    suffixes = [suffix.lower() for suffix in Path(raw_filename).suffixes]
    for inner_suffix in suffixes[:-1]:
        if inner_suffix in _UPLOAD_BLOCKED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Upload filename contains blocked inner extension {inner_suffix!r}",
            )
    suffix = Path(raw_filename).suffix.lower()
    if suffix in _UPLOAD_BLOCKED_EXTENSIONS or suffix not in _UPLOAD_ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Upload filename extension {suffix or '<none>'!r} is not allowed",
        )


def _upload_url_ttl_seconds() -> int:
    try:
        return max(60, int(os.environ.get("WORKEROS_UPLOAD_URL_TTL_SECONDS", "3600")))
    except ValueError:
        return 3600


def _upload_signing_key() -> bytes:
    key = (
        os.environ.get("WORKEROS_UPLOAD_URL_SIGNING_SECRET")
        or os.environ.get("FLOOM_SECRET")
        or "local-dev-upload-url-signing"
    )
    return key.encode("utf-8")


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _make_upload_download_token(file_id: str, uploaded_by: str) -> str:
    expires_at = int(time.time()) + _upload_url_ttl_seconds()
    payload = _b64url_encode(
        json.dumps(
            {"file_id": file_id, "uploaded_by": uploaded_by, "expires_at": expires_at},
            separators=(",", ":"),
        ).encode("utf-8")
    )
    signature = hmac.new(_upload_signing_key(), payload.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def _verify_upload_download_token(file_id: str, token: str) -> str:
    try:
        payload, signature = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Uploaded file not found") from exc

    expected = hmac.new(_upload_signing_key(), payload.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=404, detail="Uploaded file not found")

    try:
        claims = json.loads(_b64url_decode(payload).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Uploaded file not found") from exc

    if claims.get("file_id") != file_id:
        raise HTTPException(status_code=404, detail="Uploaded file not found")
    expires_at = int(claims.get("expires_at") or 0)
    if expires_at < int(time.time()):
        raise HTTPException(status_code=404, detail="Uploaded file not found")
    uploaded_by = str(claims.get("uploaded_by") or "")
    if not uploaded_by:
        raise HTTPException(status_code=404, detail="Uploaded file not found")
    return uploaded_by


def _user_owns_uploaded_file(conn: sqlite3.Connection, file_id: str, user_id: str) -> bool:
    owner_row = conn.execute(
        "SELECT 1 FROM file_owners WHERE file_id = ? AND user_id = ? LIMIT 1",
        (file_id, user_id),
    ).fetchone()
    if owner_row is not None:
        return True
    legacy_row = conn.execute(
        "SELECT 1 FROM files WHERE id = ? AND COALESCE(uploaded_by, 'anonymous') = ? LIMIT 1",
        (file_id, user_id),
    ).fetchone()
    return legacy_row is not None


@app.post("/uploads")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    max_size_mb: Optional[float] = Form(None),
    accepts: Optional[str] = Form(None),
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    if max_size_mb is not None and max_size_mb <= 0:
        raise HTTPException(status_code=400, detail="max_size_mb must be greater than 0")

    raw_filename = file.filename or ""
    _validate_upload_filename(raw_filename)

    media_type = normalize_media_type(
        file.content_type or mimetypes.guess_type(raw_filename)[0]
    )
    if media_type not in _UPLOAD_ALLOWED_MEDIA_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Upload media type {media_type!r} is not allowed",
        )

    accepted = _parse_accepts(accepts)
    if accepted and media_type not in accepted:
        raise HTTPException(
            status_code=400,
            detail=f"Upload media type {media_type!r} is not accepted",
        )

    configured_max_bytes = _upload_max_bytes()
    if max_size_mb is not None:
        max_bytes = min(int(max_size_mb * 1024 * 1024), configured_max_bytes)
    else:
        max_bytes = configured_max_bytes

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
                    raise HTTPException(
                        status_code=400,
                        detail=f"Uploaded file exceeds {_format_bytes(max_bytes)} limit",
                    )
                hasher.update(chunk)
                tmp_out.write(chunk)
    except HTTPException:
        if tmp_upload is not None:
            tmp_upload.unlink(missing_ok=True)
        raise

    exceeded_cap = _claim_upload_quota(request, size)
    if exceeded_cap is not None:
        if tmp_upload is not None:
            tmp_upload.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail=f"Upload hourly cap exceeded: {_format_bytes(exceeded_cap)} per hour",
        )

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

    uploaded_by = auth.user_id or "anonymous"
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
        conn.execute(
            """
            INSERT INTO file_owners (file_id, user_id, first_uploaded_at)
            VALUES (?, ?, ?)
            ON CONFLICT(file_id, user_id) DO NOTHING
            """,
            (sha256, uploaded_by, uploaded_at),
        )

    download_token = _make_upload_download_token(sha256, uploaded_by)
    upload_url = f"/uploads/{sha256}?download_token={download_token}"
    return {
        "id": sha256,
        "sha256": sha256,
        "size": size,
        "media_type": media_type,
        "url": upload_url,
    }


@app.get("/uploads/{file_id}")
def download_upload(
    file_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> FileResponse:
    if not is_sha256(file_id):
        raise HTTPException(status_code=404, detail="Uploaded file not found")

    download_token = request.query_params.get("download_token", "")
    token_user_id = _verify_upload_download_token(file_id, download_token)
    if auth.user_id != token_user_id:
        raise HTTPException(status_code=404, detail="Uploaded file not found")
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT filename, media_type
            FROM files
            WHERE id = ?
            """,
            (file_id,),
        ).fetchone()
        if row is not None and not _user_owns_uploaded_file(conn, file_id, auth.user_id):
            raise HTTPException(status_code=404, detail="Uploaded file not found")

    path = blob_path(file_id)
    if row is None or not path.exists():
        raise HTTPException(status_code=404, detail="Uploaded file not found")

    filename = row["filename"] or file_id
    media_type = normalize_media_type(row["media_type"])
    return FileResponse(
        path,
        filename=filename,
        media_type=media_type,
        headers={"Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------------------
# Contexts — filesystem-backed worker knowledge/state folders
# ---------------------------------------------------------------------------

class ContextWorkerRef(BaseModel):
    worker_id: str
    worker_name: str


class ContextSummary(BaseModel):
    name: str
    file_count: int
    total_size_bytes: int
    updated_at: Optional[str] = None
    writeable: bool = False
    worker_count: int = 0
    description: Optional[str] = None


class ContextFileItem(BaseModel):
    path: str
    size: int
    mime_type: str
    updated_at: str
    is_binary: bool
    description: Optional[str] = None
    display_type: str = "File"


class ContextDetail(ContextSummary):
    files: List[ContextFileItem] = Field(default_factory=list)
    used_by: List[ContextWorkerRef] = Field(default_factory=list)


class ContextCreateRequest(BaseModel):
    writeable: bool = False


class ContextTextWriteRequest(BaseModel):
    content: str


class ContextDeleteResponse(BaseModel):
    status: str
    referenced_by: List[str] = Field(default_factory=list)


class ContextUploadResponse(BaseModel):
    files: List[ContextFileItem]
    total_size_bytes: int


def _context_name_or_400(name: str) -> str:
    try:
        return validate_context_name(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _context_file_path_or_400(path: str) -> str:
    try:
        return normalize_context_file_path(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _safe_context_file_or_400(name: str, path: str) -> Path:
    try:
        return safe_context_file_path(name, path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _unowned_contexts_visible_to_caller() -> bool:
    return os.environ.get("WORKEROS_ENABLE_USER_HEADER_SCOPE") != "1" and not _is_cloud_deploy()


def _is_system_context_pack(
    name: str,
    metadata: dict[str, dict[str, Any]] | None = None,
) -> bool:
    """True for engine/system packs that must be hidden from operators."""
    try:
        safe_name = validate_context_name(name)
    except ValueError:
        return False
    if safe_name in SYSTEM_CONTEXT_PACKS:
        return True
    meta = metadata if metadata is not None else load_context_metadata()
    return bool((meta.get(safe_name) or {}).get("system"))


def _context_visible_to_user(
    name: str,
    *,
    user_id: str,
    metadata: dict[str, dict[str, Any]] | None = None,
) -> bool:
    safe_name = validate_context_name(name)
    meta = metadata if metadata is not None else load_context_metadata()
    # Engine/system packs are internal config, never operator-facing.
    if _is_system_context_pack(safe_name, meta):
        return False
    owner_id = context_owner_id(safe_name, meta)
    if owner_id:
        return owner_id == user_id
    return _unowned_contexts_visible_to_caller()


def _require_context_for_user(
    name: str,
    *,
    user_id: str,
    metadata: dict[str, dict[str, Any]] | None = None,
) -> tuple[str, dict[str, dict[str, Any]]]:
    safe_name = _context_name_or_400(name)
    meta = metadata if metadata is not None else load_context_metadata()
    if not context_dir(safe_name).is_dir() or not _context_visible_to_user(
        safe_name,
        user_id=user_id,
        metadata=meta,
    ):
        raise HTTPException(status_code=404, detail="Context not found")
    return safe_name, meta


def _context_summary(name: str, metadata: dict[str, dict[str, Any]]) -> ContextSummary:
    root = context_dir(name)
    files = list(iter_context_files(root))
    total_size = sum(path.stat().st_size for path in files)
    return ContextSummary(
        name=name,
        file_count=len(files),
        total_size_bytes=total_size,
        updated_at=context_updated_at(root),
        writeable=bool(metadata.get(name, {}).get("writeable", False)),
    )


def _context_description(root: Path) -> Optional[str]:
    """Return the first non-empty line of README.md as the context description, or None."""
    readme = root / "README.md"
    if not readme.is_file():
        return None
    try:
        for line in readme.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.lstrip("#").strip()
            if stripped:
                return stripped[:500]
    except Exception:
        pass
    return None


def _context_detail(
    name: str,
    metadata: dict[str, dict[str, Any]] | None = None,
    *,
    repos: Optional[Repositories] = None,
    user_id: str = "federico",
) -> ContextDetail:
    root = context_dir(name)
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="Context not found")
    meta = metadata if metadata is not None else load_context_metadata()
    files = [
        ContextFileItem(**context_file_metadata(root, path))
        for path in sorted(iter_context_files(root), key=lambda p: p.relative_to(root).as_posix())
    ]
    summary = _context_summary(name, meta)
    # Compute used_by and worker_count when repos is available.
    used_by: List[ContextWorkerRef] = []
    if repos is not None:
        try:
            for worker in repos.workers.list(user_id=user_id):
                try:
                    contexts = (worker.get("config") or {}).get("contexts") or []
                    if name in context_mount_names(contexts):
                        used_by.append(ContextWorkerRef(
                            worker_id=str(worker["id"]),
                            worker_name=str(worker.get("name") or worker["id"]),
                        ))
                except Exception:
                    continue
        except Exception:
            pass
    description = _context_description(root)
    summary.worker_count = len(used_by)
    summary.description = description
    return ContextDetail(
        **summary.model_dump(),
        files=files,
        used_by=used_by,
    )


def _raise_context_quota_if_needed(name: str) -> None:
    total = context_total_size(context_dir(name))
    if total > MAX_CONTEXT_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Context exceeds 50MB total size limit ({total} bytes)",
        )


def _write_context_file(name: str, file_path: str, data: bytes, *, user_id: str) -> ContextFileItem:
    root = context_dir(name)
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="Context not found")
    destination = _safe_context_file_or_400(name, file_path)
    previous = destination.read_bytes() if destination.exists() else None
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    try:
        _raise_context_quota_if_needed(name)
    except HTTPException:
        if previous is None:
            destination.unlink(missing_ok=True)
        else:
            destination.write_bytes(previous)
        raise
    set_context_metadata(name, owner_id=user_id)
    return ContextFileItem(**context_file_metadata(root, destination))


def _workers_referencing_context(name: str, *, user_id: str, repos: Repositories) -> List[str]:
    referenced_by: List[str] = []
    for worker in repos.workers.list(user_id=user_id):
        try:
            contexts = (worker.get("config") or {}).get("contexts") or []
            if name in context_mount_names(contexts):
                referenced_by.append(str(worker["id"]))
        except Exception:
            continue
    return sorted(set(referenced_by))


@app.get("/contexts", response_model=List[ContextSummary])
def list_contexts(
    auth: AuthContext = Depends(get_auth_context),
) -> List[ContextSummary]:
    ensure_contexts_dir()
    metadata = load_context_metadata()
    root = current_contexts_root()
    items = [
        _context_summary(folder.name, metadata)
        for folder in sorted(root.iterdir(), key=lambda p: p.name)
        if folder.is_dir() and not folder.is_symlink() and not folder.name.startswith(".")
        and _context_visible_to_user(folder.name, user_id=auth.user_id, metadata=metadata)
    ]
    return items


@app.post("/contexts/{name}", response_model=ContextDetail)
def create_context(
    name: str,
    payload: Optional[ContextCreateRequest] = Body(default=None),
    auth: AuthContext = Depends(get_auth_context),
) -> ContextDetail:
    safe_name = _context_name_or_400(name)
    root = context_dir(safe_name)
    metadata = load_context_metadata()
    if root.exists():
        if not _context_visible_to_user(safe_name, user_id=auth.user_id, metadata=metadata):
            raise HTTPException(status_code=404, detail="Context not found")
        raise HTTPException(status_code=409, detail="Context already exists")
    root.mkdir(parents=True)
    set_context_metadata(
        safe_name,
        writeable=bool(payload.writeable) if payload else False,
        owner_id=auth.user_id,
    )
    return _context_detail(safe_name)


@app.get("/contexts/{name}", response_model=ContextDetail)
def get_context(
    name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    safe_name, metadata = _require_context_for_user(name, user_id=auth.user_id)
    return _context_detail(safe_name, metadata, repos=repos, user_id=auth.user_id)


@app.delete("/contexts/{name}", response_model=ContextDeleteResponse)
def delete_context(
    name: str,
    force: bool = Query(False),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDeleteResponse:
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    root = context_dir(safe_name)
    referenced_by = _workers_referencing_context(safe_name, user_id=auth.user_id, repos=repos)
    if referenced_by and not force:
        raise HTTPException(
            status_code=409,
            detail={"message": "Context is referenced by workers", "referenced_by": referenced_by},
        )
    shutil.rmtree(root)
    delete_context_metadata(safe_name)
    return ContextDeleteResponse(status="deleted", referenced_by=referenced_by)


@app.get("/contexts/{name}/files/{file_path:path}")
def get_context_file(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
):
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    rel = _context_file_path_or_400(file_path)
    target = _safe_context_file_or_400(safe_name, rel)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Context file not found")
    mime_type = guess_mime_type(rel)
    headers = {"Cache-Control": "no-store"}
    if is_binary_file(rel, mime_type):
        headers["Content-Disposition"] = f'attachment; filename="{Path(rel).name}"'
        return FileResponse(target, media_type=mime_type, headers=headers)
    return Response(content=target.read_bytes(), media_type=mime_type, headers=headers)


@app.put("/contexts/{name}/files/{file_path:path}", response_model=ContextFileItem)
async def put_context_file(
    name: str,
    file_path: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> ContextFileItem:
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    rel = _context_file_path_or_400(file_path)
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type == "application/json":
        try:
            payload = ContextTextWriteRequest(**(await request.json()))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON body: {exc}") from exc
        data = payload.content.encode("utf-8")
    else:
        data = await request.body()
    return _write_context_file(safe_name, rel, data, user_id=auth.user_id)


@app.delete("/contexts/{name}/files/{file_path:path}", response_model=ContextDetail)
def delete_context_file(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
) -> ContextDetail:
    safe_name, metadata = _require_context_for_user(name, user_id=auth.user_id)
    rel = _context_file_path_or_400(file_path)
    target = _safe_context_file_or_400(safe_name, rel)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Context file not found")
    target.unlink()
    for parent in target.parents:
        if parent == context_dir(safe_name):
            break
        try:
            parent.rmdir()
        except OSError:
            break
    set_context_metadata(safe_name, owner_id=auth.user_id)
    return _context_detail(safe_name, metadata)


@app.post("/contexts/{name}/upload", response_model=ContextUploadResponse)
async def upload_context_files(
    name: str,
    files: List[UploadFile] = File(...),
    path_prefix: str = Form(""),
    auth: AuthContext = Depends(get_auth_context),
) -> ContextUploadResponse:
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    raw_prefix = path_prefix.strip().strip("/")
    prefix = _context_file_path_or_400(raw_prefix) if raw_prefix else ""
    written: List[ContextFileItem] = []
    for upload in files:
        filename = _context_file_path_or_400(upload.filename or "upload.bin")
        rel = f"{prefix}/{filename}" if prefix else filename
        data = await upload.read()
        written.append(_write_context_file(safe_name, rel, data, user_id=auth.user_id))
    return ContextUploadResponse(
        files=written,
        total_size_bytes=context_total_size(context_dir(safe_name)),
    )


@app.get("/workers", response_model=List[WorkerSummary])
def list_workers(
    include_system: bool = False,
    include_archived: bool = False,
    shape: str = "full",
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[WorkerSummary]:
    """List workers.

    ?shape=list           — trimmed payload (~15 KB for 18 workers) for the web UI list view.
                            Drops: long_description, use_cases, example_input, example_output,
                            how_it_works, timeseries. Keeps all fields needed to render the card.
    ?shape=full           — full payload (default, backwards-compat for CLI + MCP consumers).
    ?include_archived=true — include archived workers (archived:true in worker.yml).
                             Default: excluded from All/Starred/Recent; shown only in Archived view.
    """
    workers = _list_visible_workers(user_id=auth.user_id, repos=repos, use_cache=True)
    # Filter out system_worker: true workers unless explicitly requested.
    if not include_system:
        workers = [
            w for w in workers
            if not (w.get("manifest") or {}).get("system_worker", False)
        ]
    # Filter out archived workers unless explicitly requested.
    # NOTE: when include_system and include_archived are both False this matches
    # _list_operator_workers exactly (shared filter, see 1.5.4).
    if not include_archived:
        workers = [w for w in workers if not w.get("archived", False)]
    worker_ids = [w["id"] for w in workers]
    stats_by_id = _get_stats_batch(worker_ids, user_id=auth.user_id, repos=repos)
    # S44 Win 3: skip expensive timeseries fetch when list shape requested.
    list_shape = shape == "list"
    timeseries_by_id = (
        {} if list_shape
        else _get_timeseries_batch(worker_ids, user_id=auth.user_id, repos=repos, days=14)
    )
    available_secret_names = repos.secrets.list_names(user_id=auth.user_id)
    result: List[WorkerSummary] = []
    for w in workers:
        last_run_row = _get_last_run_for_worker(w["id"], user_id=auth.user_id, repos=repos)
        last_run = _make_run_summary(last_run_row) if last_run_row else None

        # Check secrets
        config = get_worker_config_for_run(w["id"])
        status = WorkerStatus(w["status"])
        if config and config.secrets:
            missing = [s for s in config.secrets if s not in available_secret_names]
            if missing:
                status = WorkerStatus.MISSING_SECRET
        # Archived workers never show needs_attention — they're intentionally inactive.
        is_archived = w.get("archived", False)
        if (
            not is_archived
            and status == WorkerStatus.HEALTHY
            and last_run
            and last_run.status == RunStatus.FAILED
        ):
            status = WorkerStatus.NEEDS_ATTENTION

        triggers = _build_triggers_list(w)
        triggers_spec = _build_triggers_spec(w)
        recent_stats = stats_by_id.get(w["id"])
        timeseries = timeseries_by_id.get(w["id"])

        # Extract connection slugs and runtime from worker config dict.
        # These are lightweight and needed for the worker card tool-logo strip.
        _worker_config_dict = w.get("config") or {}
        _raw_connections = _worker_config_dict.get("connections") or w.get("connections") or []
        _conn_slugs = [
            c if isinstance(c, str) else (c.get("mcp", {}).get("label") or "mcp")
            for c in _raw_connections
        ]
        _raw_runtime = _worker_config_dict.get("runtime") or {}
        _runtime_type = (
            _raw_runtime.get("type") if isinstance(_raw_runtime, dict)
            else (str(_raw_runtime) if _raw_runtime else None)
        )

        result.append(
            WorkerSummary(
                id=w["id"],
                name=w["name"],
                description=w.get("description"),
                # S44 Win 3: omit detail-only fields in list shape.
                long_description=None if list_shape else w.get("long_description"),
                use_cases=None if list_shape else w.get("use_cases"),
                example_input=None if list_shape else w.get("example_input"),
                example_output=None if list_shape else w.get("example_output"),
                how_it_works=None if list_shape else w.get("how_it_works"),
                is_example=w.get("is_example"),
                archived=is_archived,
                archive_reason=_sanitize_operator_text(w.get("archive_reason")),
                tags=w.get("tags") or [],
                folder=w.get("folder"),
                status=status,
                trigger_type=w["trigger_type"],
                runner=w["runner"],
                last_run=last_run,
                triggers=triggers,
                triggers_spec=triggers_spec,
                recent_stats=recent_stats,
                timeseries=None if list_shape else timeseries,
                # B7: always include connection slugs and runtime for worker card tool strip.
                connections=_conn_slugs,
                runtime=_runtime_type,
            )
        )
    return result


def _build_worker_detail(
    worker_id: str,
    *,
    user_id: str,
    repos: Repositories,
) -> WorkerDetail:
    worker = _get_visible_worker(worker_id, user_id=user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    recent_runs = [
        _make_run_summary(row)
        for row in repos.runs.list_for_worker(
            user_id=user_id,
            worker_id=worker_id,
            limit=10,
            offset=0,
        )
    ]

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
        available_secret_names = repos.secrets.list_names(user_id=user_id)
        missing = [s for s in config.secrets if s not in available_secret_names]
        if missing:
            status = WorkerStatus.MISSING_SECRET
    if (
        status == WorkerStatus.HEALTHY
        and recent_runs
        and recent_runs[0].status == RunStatus.FAILED
    ):
        status = WorkerStatus.NEEDS_ATTENTION

    manifest_yaml: Optional[str] = None
    run_py: Optional[str] = None
    skill_md_content: Optional[str] = None
    run_py_content: Optional[str] = None
    worker_files: List[WorkerFile] = []
    if _worker_source_visible_to_api(worker_id):
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
    if _worker_has_webhook_trigger(worker, config):
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
        is_example=worker.get("is_example"),
        archived=bool(worker.get("archived", False)),
        archive_reason=_sanitize_operator_text(worker.get("archive_reason")),
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


@app.get("/workers/{worker_id}", response_model=WorkerDetail)
def get_worker_detail(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    return _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)


@app.post("/workers/{worker_id}/restore", response_model=WorkerDetail)
def restore_worker(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Restore an archived worker (set archived: false in worker.yml).

    Writes back to the bundle file so the change survives server restarts.
    Invalidates the worker cache so the worker reappears in the default list.
    """
    from worker_registry import WORKERS_DIR as _WORKERS_DIR
    import re as _re

    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = _WORKERS_DIR / worker_id / "worker.yml"
    if not worker_yml_path.exists():
        raise HTTPException(status_code=404, detail="Worker not found")
    try:
        raw_yml = worker_yml_path.read_text()
        # Remove or set archived to false. Match both `archived: true` and `archived:true`.
        updated = _re.sub(r"(?m)^(archived:\s*)true\s*$", r"\1false\n", raw_yml)
        if updated == raw_yml:
            # Field may be missing — just remove it (defaults to false)
            updated = raw_yml  # already not archived
        # Also remove archive_reason line when restoring
        updated = _re.sub(r"(?m)^archive_reason:.*\n?", "", updated)
        worker_yml_path.write_text(updated)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to update worker.yml: {exc}") from exc
    invalidate_worker_cache()
    return _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)


@app.get("/workers/{worker_id}/sample-input")
def get_worker_sample_input(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Any:
    """Return the sample input JSON for a worker if present.

    Sample inputs live at docs/workers/inputs/<worker_id>.json relative to the
    repo root (one level above the workers/ directory).
    Returns 404 if no sample input exists for the worker.
    """
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    safe_id = worker_id.replace("..", "").replace("/", "").replace("\\", "")
    # Walk from WORKERS_DIR up one level to the repo root, then into docs/workers/inputs/
    sample_path = WORKERS_DIR.parent / "docs" / "workers" / "inputs" / f"{safe_id}.json"
    if not sample_path.is_file():
        raise HTTPException(status_code=404, detail=f"No sample input found for worker {worker_id!r}")
    try:
        data = json.loads(sample_path.read_text())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to parse sample input: {exc}") from exc
    return data


# ---------------------------------------------------------------------------
# PATCH /workers/{worker_id} — partial update
# ---------------------------------------------------------------------------

@app.patch("/workers/{worker_id}", response_model=WorkerDetail)
def update_worker(
    worker_id: str,
    payload: WorkerUpdateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Partially update a worker instance.

    All fields are optional. Rotation of webhook_secret returns the new raw
    secret once in the response (new_webhook_secret field) — it is never
    stored in plaintext.
    """
    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
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

    updates: Dict[str, Any] = {}

    if payload.trigger_type is not None:
        updates["trigger_type"] = payload.trigger_type

    if new_cron_expr is not None:
        updates["cron_expr"] = new_cron_expr

    if payload.cron_timezone is not None:
        updates["cron_timezone"] = payload.cron_timezone

    if payload.input_values is not None:
        updates["input_values_json"] = payload.input_values

    # capabilities field is declared-not-enforced per T1c flip — just accept it
    # No DB column to write to currently; stored in manifest only.

    new_raw_secret: Optional[str] = None
    if payload.webhook_secret_rotate:
        from webhook_service import generate_webhook_secret
        # Verify the worker actually has a webhook trigger before rotating
        config = get_worker_config_for_run(worker_id)
        if not _worker_has_webhook_trigger(worker, config):
            raise HTTPException(
                status_code=400,
                detail=f"Worker {worker_id!r} does not have a webhook trigger — cannot rotate secret",
            )
        new_raw_secret = generate_webhook_secret(worker_id, repos=repos)

    if updates:
        repos.workers.update(user_id=auth.user_id, worker_id=worker_id, **updates)
        invalidate_worker_cache()

    # Reload cron schedule if trigger/cron changed
    if payload.trigger_type is not None or new_cron_expr is not None or payload.cron_timezone is not None:
        repos.workers.update(
            user_id=auth.user_id,
            worker_id=worker_id,
            next_run_at=None,
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

    detail = _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)
    if new_raw_secret is not None:
        detail.new_webhook_secret = new_raw_secret
    return detail


# ---------------------------------------------------------------------------
# DELETE /workers/{worker_id}
# ---------------------------------------------------------------------------

@app.delete("/workers/{worker_id}", status_code=204)
def delete_worker(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Delete a worker and all dependent rows (runs, artifacts, logs).

    - Dependent run, artifact, log, and webhook rows are removed with the worker.
    - Cancels any in-progress run gracefully (marks failed).
    - Cleans up webhook secret.
    - Removes scheduler slot (next_run_at cleared before delete).
    - skill_version is preserved if other workers share it.
    """
    _raise_if_protected_worker_mutation(worker_id)
    worker = repos.workers.get(user_id=auth.user_id, worker_id=worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    skill_version_id = worker.get("skill_version_id")
    config = get_worker_config_for_run(worker_id)
    composio_state = {
        "trigger_id": worker.get("composio_trigger_id"),
        "event": worker.get("composio_event"),
        "signature": _composio_trigger_signature(config),
    }

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
    active_runs = repos.workers.list_active_run_ids(user_id=auth.user_id, worker_id=worker_id)

    for run_id in active_runs:
        try:
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error="Worker deleted",
                user_id=auth.user_id,
                repos=repos,
            )
            logger.info("Cancelled active run %s before worker deletion", run_id)
        except Exception as exc:
            logger.warning("Could not cancel run %s: %s", run_id, exc)

    # Remove webhook secret
    try:
        from webhook_service import delete_webhook_secret
        delete_webhook_secret(worker_id, repos=repos)
    except Exception as exc:
        logger.warning("Could not delete webhook secret for %s: %s", worker_id, exc)

    # Delete the worker (FK CASCADE removes runs/artifacts/logs/webhooks)
    repos.workers.delete(user_id=auth.user_id, worker_id=worker_id)

    # Check if skill_version is still referenced by other workers; preserve if so.
    # If unreferenced, also delete the skill_versions row so name+version can
    # be reused when the user recreates a worker with the same ID (N5 fix).
    ref_count = repos.workers.get_skill_version_ref_count(skill_version_id=skill_version_id)
    if ref_count == 0 and skill_version_id:
        repos.workers.delete_skill_version(skill_version_id=skill_version_id)
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
    model_config = ConfigDict(extra="forbid")

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
- `name`: lowercase slug 3-64 chars (letters, digits, hyphens). DERIVE IT FROM
  THE USER'S PROMPT — pick the primary verb + the primary noun/object and slugify
  them (e.g. "follow up with applicants" -> "applicant-followup", "summarise
  Granola meetings into HubSpot" -> "granola-hubspot-summary", "chase overdue
  invoices" -> "invoice-chaser"). The name MUST reflect THIS prompt's task.
  NEVER reuse a generic placeholder or a name from the examples above when it
  does not match the prompt. Two different prompts must produce two different names.
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
# POST /workers/new/from-prompt — streamed worker-author run
# ---------------------------------------------------------------------------
# Replaces the sync draft-from-prompt pattern with a real worker run.
# Returns 202 + run_id immediately. The client subscribes to
#   GET /runs/{run_id}/events  (or /runs/{run_id}/stream for AI SDK parts)
# to observe the agent thinking and tool calls.
#
# On completion the run outputs a bundle.json artifact the client reads via
#   GET /runs/{run_id}/artifacts/bundle
#
# This eliminates the Vercel 60s timeout on draft-from-prompt (task #18).
# ---------------------------------------------------------------------------

class NewWorkerFromPromptRequest(BaseModel):
    prompt: str
    mode: str = "draft"  # "draft" | "create"
    parent_worker_id: Optional[str] = None


class NewWorkerFromPromptResponse(BaseModel):
    run_id: str
    worker_id: str = "worker-author"
    status: str = "running"


_WORKER_AUTHOR_ID = "worker-author"


@app.post("/workers/new/from-prompt", response_model=NewWorkerFromPromptResponse)
def new_worker_from_prompt(
    payload: NewWorkerFromPromptRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> NewWorkerFromPromptResponse:
    """Create a worker-author run to generate a new worker bundle.

    Returns 202-style (run_id, status=running). The client polls
    GET /runs/{run_id}/events for progress and GET /runs/{run_id}/artifacts
    for the final bundle.json when the run completes.
    """
    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    if len(prompt) > 4000:
        raise HTTPException(status_code=400, detail="prompt must be 4000 characters or fewer")

    mode = (payload.mode or "draft").strip()
    if mode not in ("draft", "create"):
        raise HTTPException(status_code=400, detail="mode must be 'draft' or 'create'")

    # Ensure worker-author bundle is registered
    worker = _get_db_worker(_WORKER_AUTHOR_ID, user_id=auth.user_id, repos=repos) or get_worker(_WORKER_AUTHOR_ID)
    if not worker:
        # Auto-discover and register the worker-author bundle on first use
        invalidate_worker_cache()
        workers = discover_workers(use_cache=False)
        with get_db() as conn:
            try:
                _persist_discovered_workers(conn, workers, user_id=auth.user_id)
            except Exception as exc:
                logger.warning("Failed to auto-register worker-author: %s", exc)
        worker = _get_db_worker(_WORKER_AUTHOR_ID, user_id=auth.user_id, repos=repos) or get_worker(_WORKER_AUTHOR_ID)
        if not worker:
            raise HTTPException(
                status_code=503,
                detail="worker-author bundle not found. Ensure workers/worker-author/ exists on disk.",
            )

    inputs: Dict[str, Any] = {
        "prompt": prompt,
        "mode": mode,
    }
    if payload.parent_worker_id:
        inputs["parent_worker_id"] = payload.parent_worker_id

    run_id = create_run(
        _WORKER_AUTHOR_ID,
        inputs,
        "manual",
        user_id=auth.user_id,
        repos=repos,
    )
    start_run(run_id, _WORKER_AUTHOR_ID, inputs, user_id=auth.user_id, repos=repos)
    return NewWorkerFromPromptResponse(run_id=run_id)


# ---------------------------------------------------------------------------
# POST /workers/draft-and-create — draft + register in one round-trip
# ---------------------------------------------------------------------------

class DraftAndCreateRequest(BaseModel):
    prompt: str = ""
    # Optional pre-built files to skip the LLM step (used for .md / .py uploads)
    files: List[DraftFile] = []


class DraftAndCreateResponse(BaseModel):
    worker_id: str


def _free_worker_id(base_id: str, repos: "Repositories | None" = None) -> str:
    """Return a worker id that does not collide with an existing worker.

    The LLM author frequently returns the same suggested id (e.g.
    "applicant-followup") regardless of prompt, which made every second
    draft-and-create 409 (#186). Instead of failing, derive a free id by
    appending ``-2``, ``-3``, ... and finally a short random suffix so the
    create always succeeds. Protected stock ids are never reused.

    #54 (follow-up to #200): in a multi-tenant deploy (managed-deployment) the
    canonical worker store is the DB, not the request's ephemeral filesystem
    view, and the worker id is a GLOBAL primary key (``id TEXT PRIMARY KEY``
    on the ``workers`` table — not a ``(owner_id, id)`` composite). A collision
    can therefore come from a DB row in a DIFFERENT workspace that is not on
    this request's filesystem. Checking only the filesystem let the dedupe
    return an id that then collided on insert (or whose workspace-scoped
    post-insert ``get`` returned None), producing a hard 409
    "failed to upsert <id>".

    The repository ``get_any`` is an UNSCOPED, global existence check (by ``id``
    only). Consulting it in addition to the filesystem makes the dedupe correct
    for the global id namespace in both modes: in local OSS mode ``repos`` is
    the SQLite repo (and the filesystem is the source of truth anyway); in
    cloud mode ``repos`` is the Supabase repo and is the source of truth.
    """
    from worker_registry import WORKERS_DIR

    def _is_free(candidate: str) -> bool:
        if candidate in PROTECTED_STOCK_WORKER_IDS:
            return False
        if (WORKERS_DIR / candidate).exists():
            return False
        if repos is not None:
            try:
                if repos.workers.get_any(worker_id=candidate) is not None:
                    return False
            except Exception:
                # A repo lookup failure must never make dedupe falsely report
                # an id as free; fall back to filesystem-only for this check.
                logger.warning(
                    "repos.workers.get_any failed during dedupe for %r; "
                    "falling back to filesystem-only availability",
                    candidate,
                    exc_info=True,
                )
        return True

    if _is_free(base_id):
        return base_id
    for suffix in range(2, 100):
        candidate = f"{base_id}-{suffix}"
        if _is_free(candidate):
            return candidate
    # Extremely unlikely fallback: append a random suffix.
    import secrets

    for _ in range(20):
        candidate = f"{base_id}-{secrets.token_hex(3)}"
        if _is_free(candidate):
            return candidate
    raise HTTPException(status_code=409, detail=f"Could not allocate a free id for {base_id!r}")


def _rewrite_worker_yml_id(worker_yml: str, new_id: str) -> str:
    """Rewrite the worker manifest's identity field to ``new_id``.

    0.3 contracts key off ``name``; legacy configs use ``id``. Preserve which
    key the manifest already uses so the parsed worker_id matches the dir.
    """
    import yaml as pyyaml

    raw = pyyaml.safe_load(worker_yml)
    if not isinstance(raw, dict):
        return worker_yml
    if "id" in raw and not (raw.get("schema_version") == "0.3"):
        raw["id"] = new_id
    else:
        raw["name"] = new_id
    return pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False)


@app.post("/workers/draft-and-create", response_model=DraftAndCreateResponse)
async def draft_and_create_worker(
    payload: DraftAndCreateRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> DraftAndCreateResponse:
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
        _enforce_draft_rate_limit(request)
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

        worker_id, _config = _parse_worker_payload(worker_yml_file.content, user_id=auth.user_id)

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
                _persist_discovered_workers(conn, workers, user_id=auth.user_id)
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
    worker_id, _config2 = _parse_worker_payload(worker_yml_str, user_id=auth.user_id)

    # #186: the LLM author often returns the same suggested id regardless of
    # prompt. Rather than 409 on collision, allocate a free id and rewrite the
    # manifest identity so the worker.yml, the dir, and the DB row all agree.
    free_id = _free_worker_id(worker_id, repos=repos)
    if free_id != worker_id:
        worker_id = free_id
        worker_yml_str = _rewrite_worker_yml_id(worker_yml_str, worker_id)
        for f in draft_files_from_llm:
            if f.path == "worker.yml":
                f.content = worker_yml_str

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
            _persist_discovered_workers(conn, workers, user_id=auth.user_id)
        except (sqlite3.IntegrityError, RuntimeError) as exc:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            invalidate_worker_cache()
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    return DraftAndCreateResponse(worker_id=worker_id)


def _parse_worker_payload(worker_yml: str, *, user_id: str | None = None) -> tuple[str, WorkerConfig]:
    import yaml as pyyaml

    try:
        raw = pyyaml.safe_load(worker_yml)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {exc}")
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="worker_yml must contain a YAML mapping")
    raw_worker_id = str(raw.get("id") or raw.get("name") or "").strip()
    if raw_worker_id in PROTECTED_STOCK_WORKER_IDS:
        _raise_if_protected_worker_mutation(raw_worker_id)

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
    except ValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Schema validation failed",
                "errors": _redacted_validation_errors(exc.errors()),
            },
        ) from exc
    except Exception as exc:
        logger.info("Worker schema validation failed: %s", exc)
        raise HTTPException(status_code=400, detail="Schema validation failed") from exc

    if not re.fullmatch(r"[a-z0-9_-]+", worker_id):
        raise HTTPException(status_code=400, detail=f"Worker ID must be lowercase kebab/snake-case: {worker_id!r}")
    if user_id:
        with use_context_scope(context_scope_for_user(user_id)):
            metadata = load_context_metadata()
            for raw_context in config.contexts or []:
                try:
                    context = normalize_context_mount(raw_context)
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc
                if context["source"] != "local":
                    continue
                context_name = context["name"]
                if not context_dir(context_name).is_dir() or not _context_visible_to_user(
                    context_name,
                    user_id=user_id,
                    metadata=metadata,
                ):
                    raise HTTPException(status_code=400, detail=f"Context not found: {context_name}")
    _raise_if_protected_worker_mutation(worker_id)
    return worker_id, config


@app.post("/workers", response_model=WorkerDetail)
def create_worker(
    payload: WorkerCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Create a new worker from YAML + Python source."""
    from worker_registry import WORKERS_DIR

    worker_id, config = _parse_worker_payload(payload.worker_yml, user_id=auth.user_id)

    target_dir = WORKERS_DIR / worker_id
    if target_dir.exists():
        raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")

    # Write files
    try:
        target_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists") from exc
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
            _persist_discovered_workers(conn, workers, user_id=auth.user_id)
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
    return _build_worker_detail(
        worker_id,
        user_id=auth.user_id,
        repos=repos,
    )


# ---------------------------------------------------------------------------
# POST /workers/from-bundle — create a worker from a zip bundle
# ---------------------------------------------------------------------------

@app.post("/workers/from-bundle", response_model=WorkerDetail)
async def create_worker_from_bundle(
    bundle: UploadFile = File(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
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

    for info in zf.infolist():
        file_type = (info.external_attr >> 16) & 0o170000
        if file_type == 0o120000:
            raise HTTPException(status_code=400, detail=f"Bundle contains unsupported symlink: {info.filename!r}")

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

    worker_id, config = _parse_worker_payload(worker_yml, user_id=auth.user_id)

    target_dir = WORKERS_DIR / worker_id
    if target_dir.exists():
        raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")

    # Extract all files under the prefix into target_dir
    try:
        target_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists") from exc
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
            _persist_discovered_workers(conn, workers, user_id=auth.user_id)
        except RuntimeError as exc:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            invalidate_worker_cache()
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    return _build_worker_detail(
        worker_id,
        user_id=auth.user_id,
        repos=repos,
    )


@app.put("/workers/{worker_id}", response_model=WorkerDetail)
def update_worker(
    worker_id: str,
    payload: WorkerCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Update an existing worker from YAML + Python source."""
    from worker_registry import WORKERS_DIR

    _raise_if_protected_worker_mutation(worker_id)
    parsed_worker_id, _config = _parse_worker_payload(payload.worker_yml, user_id=auth.user_id)
    if parsed_worker_id != worker_id:
        raise HTTPException(
            status_code=400,
            detail=f"worker_yml name {parsed_worker_id!r} does not match path worker_id {worker_id!r}",
        )
    if _get_db_worker(worker_id, user_id=auth.user_id, repos=repos) is None:
        raise HTTPException(status_code=404, detail="Worker not found")

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
            _persist_discovered_workers(conn, workers, user_id=auth.user_id)
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
    return _build_worker_detail(
        worker_id,
        user_id=auth.user_id,
        repos=repos,
    )


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
def update_worker_files(
    worker_id: str,
    payload: WorkerFilesUpdateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Replace all files in a worker's directory atomically.

    Accepts a list of {path, content} objects and writes them to disk.
    The write is atomic: files are written to a temp directory first, then
    swapped in. If any validation fails, the worker directory is left untouched.

    Path traversal is blocked: paths containing '..' segments or absolute paths
    are rejected with 400.
    """
    from worker_registry import WORKERS_DIR

    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=get_repositories())
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
    parsed_worker_id, _config = _parse_worker_payload(yml_item.content, user_id=auth.user_id)
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
                _persist_discovered_workers(conn, this_worker_list, user_id=auth.user_id)
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

        return _build_worker_detail(
            worker_id,
            user_id=auth.user_id,
            repos=repos,
        )

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


def _reload_workers_for_user(user_id: str) -> ReloadResponse:
    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers, user_id=user_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    return ReloadResponse(status="success", workers_loaded=len(workers))


@app.post("/workers/reload", response_model=ReloadResponse)
def reload_workers(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ReloadResponse:
    return _reload_workers_for_user(auth.user_id)


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

@app.post("/workers/{worker_id}/runs", response_model=ActionResponse)
def create_worker_run(
    worker_id: str,
    payload: RunCreate,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
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

    _enforce_run_create_quota(auth, worker_id)

    # Create the run record first so we have a run_id for per-run file staging.
    run_id = create_run(
        worker_id,
        payload.inputs,
        payload.trigger_source,
        status=RunStatus.RUNNING.value,
        user_id=auth.user_id,
        repos=repos,
    )
    bound_by = auth.user_id or "anonymous"
    try:
        resolved_inputs = _resolve_file_input_references(
            worker_id, run_id, payload.inputs, bound_by=bound_by
        )
    except HTTPException as exc:
        update_run_status(
            run_id,
            RunStatus.FAILED.value,
            error=str(exc.detail),
            user_id=auth.user_id,
            repos=repos,
        )
        raise
    except Exception as exc:
        update_run_status(
            run_id,
            RunStatus.FAILED.value,
            error=str(exc),
            user_id=auth.user_id,
            repos=repos,
        )
        raise
    # Persist resolved inputs (absolute file paths replace SHA values) so that
    # GET /runs/:id returns the staged paths, not raw SHA strings.
    repos.runs.set_input_json(user_id=auth.user_id, run_id=run_id, input_json=resolved_inputs)
    repos.runs.update(
        user_id=auth.user_id,
        run_id=run_id,
        status=RunStatus.QUEUED.value,
        started_at=None,
    )
    start_run(run_id, worker_id, resolved_inputs, user_id=auth.user_id, repos=repos)
    return ActionResponse(status="running", run_id=run_id)


@app.post("/workers/{worker_id}/runs/{run_id}/replay")
def replay_run(
    worker_id: str,
    run_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    row = repos.runs.get(user_id=auth.user_id, run_id=run_id)
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    if row["worker_id"] != worker_id:
        raise HTTPException(status_code=404, detail="Run not found")

    source_inputs = json.loads(row["input_json"] or "{}")
    replay_inputs = json.loads(json.dumps(source_inputs))
    _enforce_run_create_quota(auth, worker_id)
    _enforce_run_replay_quota(auth, worker_id, run_id)
    new_run_id = create_run(
        worker_id,
        replay_inputs,
        trigger_source="manual",
        user_id=auth.user_id,
        repos=repos,
    )
    start_run(new_run_id, worker_id, replay_inputs, user_id=auth.user_id, repos=repos)
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
    include_system: bool = Query(
        False,
        description="Include internal/system runs (audit, test, smoke). Hidden by default.",
    ),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
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

    if worker_id and _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos) is None:
        response.headers["X-Total-Count"] = "0"
        return []

    visible_rows, visible_total = _list_visible_runs(
        user_id=auth.user_id,
        repos=repos,
        worker_id=worker_id,
        statuses=statuses,
        since=since_dt.isoformat() if since_dt else None,
        until=until_dt.isoformat() if until_dt else None,
        limit=limit,
        offset=offset,
        include_system=include_system,
    )
    response.headers["X-Total-Count"] = str(visible_total)
    return [_make_run_summary(r) for r in visible_rows]


@app.post("/runs/clear")
def clear_runs(
    confirm: str = Query("", description="Must be 'yes-wipe-all-runs' to proceed."),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Wipe all run history.

    Destructive operation. Requires explicit `?confirm=yes-wipe-all-runs`
    query param to proceed.
    """
    if confirm != "yes-wipe-all-runs":
        raise HTTPException(
            status_code=400,
            detail=(
                "Destructive endpoint. Append ?confirm=yes-wipe-all-runs to "
                "proceed. This wipes every run, log, and artifact record."
            ),
        )
    deleted_count = repos.runs.clear_all(user_id=auth.user_id)
    logger.warning("All run history cleared (%d runs deleted)", deleted_count)
    return {"status": "cleared", "deleted_runs": deleted_count}


_TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "pending_approval"})


@app.post("/runs/{run_id}/cancel", response_model=ActionResponse)
def cancel_run(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Request cancellation of an in-flight or queued run.

    For queued runs (not yet dispatched to a sandbox): immediately marks the
    run as failed with error_code=cancelled_queued so no sandbox is ever
    spawned.  Sets cancel_requested=1 first so the drain loop skips the row
    if it is already past the get_queued() poll boundary.

    For running runs: sets cancel_requested=1; the runner respects this between
    iterations (AgentDriver) or on the next status write (other drivers).

    Returns 404 if no cancellable run is visible, 200 if cancellation was
    recorded.
    """
    # Cancellation operates on the caller's own run by explicit id, so it must
    # work for system/meta runs too (e.g. aborting a worker-author generation
    # from the /workers/new GeneratingPanel). The system/audit visibility filter
    # is for the LIST view only.
    row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if row["status"] in _TERMINAL_RUN_STATUSES:
        raise HTTPException(status_code=404, detail="Run not found")

    cancelled_at = now_iso()
    repos.runs.cancel(
        user_id=auth.user_id,
        run_id=run_id,
        cancelled_at=cancelled_at,
    )

    if row["status"] == RunStatus.QUEUED.value:
        # Immediately fail the run so it does not linger in the queued state.
        # The drain loop checks cancel_requested before dispatching, but marking
        # it failed here is cleaner for callers that poll status directly.
        update_run_status(
            run_id,
            RunStatus.FAILED.value,
            error="Run was cancelled before execution started.",
            error_code="cancelled_queued",
            user_id=auth.user_id,
            repos=repos,
        )
        logger.info("Cancelled queued run %s before dispatch", run_id)
        return ActionResponse(status="cancelled", run_id=run_id)

    logger.info("Cancel requested for run %s", run_id)
    return ActionResponse(status="cancel_requested", run_id=run_id)


# ---------------------------------------------------------------------------
# S47 HITL — approval endpoints
# ---------------------------------------------------------------------------

class ApproveRequest(BaseModel):
    edited_output: Optional[Dict[str, Any]] = None


class RejectRequest(BaseModel):
    reason: Optional[str] = None


@app.get("/approvals")
def list_approvals(
    status: Optional[str] = Query(None, description="Filter by status (default: pending)"),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """List approval requests for the authenticated user."""
    status_filter = (status or "pending").lower()
    if status_filter == "pending":
        rows = repos.approvals.list_pending(owner_id=auth.user_id)
    else:
        # For non-pending statuses, query directly
        with get_db() as conn:
            rows = [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT a.*, w.name AS worker_name
                    FROM approvals a
                    LEFT JOIN workers w ON w.id = a.worker_id
                    WHERE a.owner_id = ? AND a.status = ?
                    ORDER BY a.created_at DESC
                    """,
                    (auth.user_id, status_filter),
                ).fetchall()
            ]
    return rows


@app.get("/approvals/count")
def count_pending_approvals(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Return count of pending approvals for the authenticated user."""
    count = repos.approvals.count_pending(owner_id=auth.user_id)
    return {"pending": count}


@app.post("/runs/{run_id}/approve", response_model=ActionResponse)
def approve_run(
    run_id: str,
    body: ApproveRequest = Body(default_factory=ApproveRequest),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Approve a PENDING_APPROVAL run and spawn a follow-up execution run.

    The follow-up run receives all original inputs merged with:
      - decision: "approved"
      - approved_output: the (optionally edited) proposed output
    """
    run_row = _get_visible_run(run_id, user_id=auth.user_id, repos=repos)
    if run_row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if row_to_dict(run_row).get("status") != RunStatus.PENDING_APPROVAL.value:
        raise HTTPException(status_code=409, detail="Run is not awaiting approval")

    approval_row = repos.approvals.get_by_run_id(run_id=run_id)
    if approval_row is None:
        raise HTTPException(status_code=404, detail="Approval record not found")
    if approval_row.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Approval already decided")

    # Load original inputs
    original_inputs: Dict[str, Any] = {}
    raw_decision_input = approval_row.get("decision_input_json")
    if raw_decision_input:
        try:
            original_inputs = json.loads(raw_decision_input)
        except Exception:
            original_inputs = {}

    # Load proposed output
    run_data = row_to_dict(run_row)
    proposed_output: Dict[str, Any] = {}
    raw_output = run_data.get("output_json")
    if raw_output:
        try:
            proposed_output = json.loads(raw_output)
        except Exception:
            proposed_output = {}

    # Build follow-up inputs
    edited_output = body.edited_output if body.edited_output is not None else proposed_output
    follow_up_inputs = {
        **original_inputs,
        "decision": "approved",
        "approved_output": edited_output,
    }

    # Create the follow-up run
    worker_id = run_data["worker_id"]
    try:
        follow_up_run_id = create_run(
            worker_id,
            follow_up_inputs,
            trigger_source="approval",
            user_id=auth.user_id,
            repos=repos,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to spawn follow-up run: {exc}") from exc

    decided_at = now_iso()
    edited_output_json = json.dumps(edited_output) if body.edited_output is not None else None
    repos.approvals.approve(
        owner_id=auth.user_id,
        run_id=run_id,
        decided_at=decided_at,
        edited_output_json=edited_output_json,
        follow_up_run_id=follow_up_run_id,
    )

    # 1.5.1: transition the ORIGINAL run off pending_approval to a terminal
    # state. Without this the original run is stuck at pending_approval forever
    # (zombie approval); the decision is recorded in the approvals table.
    repos.runs.update_status(
        user_id=auth.user_id,
        run_id=run_id,
        status=RunStatus.COMPLETED.value,
    )

    # Kick off the follow-up run
    start_run(follow_up_run_id, worker_id, follow_up_inputs, user_id=auth.user_id, repos=repos)

    # Broadcast the decision
    _sse_publish(run_id, {
        "type": "approval_decided",
        "run_id": run_id,
        "decision": "approved",
        "follow_up_run_id": follow_up_run_id,
    })

    return ActionResponse(status="approved", run_id=follow_up_run_id)


@app.post("/runs/{run_id}/reject", response_model=ActionResponse)
def reject_run(
    run_id: str,
    body: RejectRequest = Body(default_factory=RejectRequest),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Reject a PENDING_APPROVAL run. No follow-up run is spawned."""
    run_row = _get_visible_run(run_id, user_id=auth.user_id, repos=repos)
    if run_row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if row_to_dict(run_row).get("status") != RunStatus.PENDING_APPROVAL.value:
        raise HTTPException(status_code=409, detail="Run is not awaiting approval")

    approval_row = repos.approvals.get_by_run_id(run_id=run_id)
    if approval_row is None:
        raise HTTPException(status_code=404, detail="Approval record not found")
    if approval_row.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Approval already decided")

    decided_at = now_iso()
    repos.approvals.reject(
        owner_id=auth.user_id,
        run_id=run_id,
        decided_at=decided_at,
        reason=body.reason,
    )

    # 1.5.1: transition the ORIGINAL run off pending_approval to a terminal
    # state so it is not stuck forever (zombie approval). The rejection itself
    # is recorded in the approvals table (status='rejected' + reason).
    repos.runs.update_status(
        user_id=auth.user_id,
        run_id=run_id,
        status=RunStatus.COMPLETED.value,
    )

    _sse_publish(run_id, {
        "type": "approval_decided",
        "run_id": run_id,
        "decision": "rejected",
        "reason": body.reason,
    })

    return ActionResponse(status="rejected", run_id=run_id)


@app.get("/runs/{run_id}/download")
def download_run_bundle(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    run_row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if not run_row:
        raise HTTPException(status_code=404, detail="Run not found")
    artifact_rows = repos.runs.list_artifacts(user_id=auth.user_id, run_id=run_id)

    output_payload = json.loads(run_row["output_json"] or "{}")
    if not isinstance(output_payload, dict):
        output_payload = {}
    run_data = row_to_dict(run_row)

    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        metadata = {
            "id": run_data.get("id"),
            "worker_id": run_data.get("worker_id"),
            "status": run_data.get("status"),
            "trigger_source": run_data.get("trigger_source"),
            "runner": run_data.get("runner"),
            "created_at": run_data.get("created_at"),
            "started_at": run_data.get("started_at"),
            "completed_at": run_data.get("completed_at"),
            "duration_ms": run_data.get("duration_ms"),
        }
        archive.writestr("metadata.json", json.dumps(metadata, indent=2, sort_keys=True))
        archive.writestr("outputs.json", json.dumps(output_payload, indent=2, sort_keys=True))
        archive.writestr(
            "README.txt",
            "This archive omits run inputs, logs, and internal transcripts. "
            "Use the Workeros UI for redacted run history.\n",
        )

        primary_output = _extract_primary_output_file(output_payload)
        if primary_output:
            output_name, output_bytes = primary_output
            archive.writestr(output_name, output_bytes)

        from runner_utils import ARTIFACTS_DIR

        artifacts_root = ARTIFACTS_DIR.resolve()
        for row in artifact_rows:
            if _is_sensitive_artifact_row(row):
                continue
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
def get_run_bundle_file(
    run_id: str,
    filename: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    if _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos) is None:
        raise HTTPException(status_code=404, detail="Bundle file not found")
    snapshot_path = repos.runs.get_bundle_snapshot_path(user_id=auth.user_id, run_id=run_id)
    if snapshot_path is None:
        raise HTTPException(status_code=404, detail="Bundle file not found")
    if not snapshot_path:
        raise HTTPException(status_code=404, detail="Bundle file not found")

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
def download_artifact(
    run_id: str,
    artifact_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    if _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos) is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    row = next(
        (
            artifact
            for artifact in repos.runs.list_artifacts(user_id=auth.user_id, run_id=run_id)
            if artifact["id"] == artifact_id
        ),
        None,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Artifact not found")
    if _is_sensitive_artifact_row(row):
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


@app.get("/runs/{run_id}", response_model=RunDetail, response_model_exclude_none=True)
def get_run(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> RunDetail:
    run = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

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

    logs = [
        LogEntry(
            level=r["level"],
            message=_redact_public_log_message(r["message"]),
            timestamp=r["timestamp"],
        )
        for r in repos.runs.list_logs(user_id=auth.user_id, run_id=run_id)
    ]

    artifacts = [
        Artifact(
            id=r["id"],
            run_id=r["run_id"],
            name=r["name"],
            type=row_to_dict(r).get("type"),
            path=r["path"],
            size_bytes=row_to_dict(r).get("size_bytes"),
            created_at=r["created_at"],
        )
        for r in repos.runs.list_artifacts(user_id=auth.user_id, run_id=run_id)
        if not _is_sensitive_artifact_row(r)
    ]
    transcript: List[Dict[str, Any]] = []

    queue_position: Optional[int] = None
    if run["status"] == RunStatus.QUEUED.value:
        pos = queued_run_position(run_id)
        queue_position = pos if pos > 0 else None

    return RunDetail(
        id=run["id"],
        worker_id=run["worker_id"],
        # PR S21: query already SELECTs worker_name (line ~3670) but it was
        # never plumbed through to the response model — UI showed the slug.
        worker_name=run.get("worker_name"),
        status=RunStatus(run["status"]),
        trigger_source=run["trigger_source"],
        runner=run["runner"],
        input={},
        output=run["output"],
        output_schema=output_schema,
        logs=logs,
        artifacts=artifacts,
        transcript=transcript,
        error=_operator_error_message(run.get("error"), run.get("error_code")),
        # Raw error/traceback kept only for the debug "Raw" tab, secrets redacted.
        # Surfaced separately so it is never the operator-facing headline. We keep
        # it whenever the operator headline differs from the raw text (artifact,
        # runtime jargon, or error_code mapping) so engineers can still see it.
        error_raw=_run_error_raw(run.get("error"), run.get("error_code")),
        error_code=run.get("error_code"),
        started_at=run.get("started_at"),
        completed_at=run.get("completed_at"),
        duration_ms=run.get("duration_ms"),
        created_at=run.get("created_at"),
        queue_position=queue_position,
    )


@app.get("/runs/{run_id}/stream")
async def stream_run_parts(
    run_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Server-Sent Events stream of AI SDK parts for a single run."""
    row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")

    last_seen = _parse_last_event_id(request.headers.get("last-event-id"))

    # Per-user concurrent-stream cap (Round 16 DoS finding). Acquire
    # synchronously so the 429 is returned before the StreamingResponse.
    stream_slot = _sse_stream_acquire(auth.user_id)

    async def event_generator():
        try:
            snapshot = _run_part_snapshot(run_id)
            if snapshot is None:
                final_part = _finish_part_from_run_row(row)
                if final_part is not None:
                    # #188: the in-memory part buffer is gone (terminal run past its
                    # TTL, or a fresh server process). Replay persisted log rows so
                    # the client reconstructs the transcript instead of receiving a
                    # bare finish event.
                    event_id = 0
                    for log_part in _log_replay_parts(repos, auth.user_id, run_id):
                        if event_id > last_seen:
                            yield _format_run_part_sse(event_id, log_part)
                        event_id += 1
                    if event_id > last_seen:
                        yield _format_run_part_sse(event_id, final_part)
                    return
                snapshot = {"parts": [], "finished": False}

            for event_id, part in snapshot["parts"]:
                if event_id > last_seen:
                    yield _format_run_part_sse(event_id, part)

            if snapshot["finished"]:
                return

            q: asyncio.Queue = asyncio.Queue(maxsize=512)
            loop = asyncio.get_running_loop()
            _run_part_register(run_id, q, loop)
            try:
                while True:
                    if await request.is_disconnected():
                        break

                    try:
                        event_id, part = await asyncio.wait_for(q.get(), timeout=5.0)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue

                    yield _format_run_part_sse(event_id, part)
                    if _run_part_is_finish(part):
                        break
            finally:
                _run_part_cleanup(run_id, q)
        finally:
            _sse_stream_release(stream_slot)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/runs/{run_id}/events")
async def stream_run_events(
    run_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
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
    run_row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if not run_row:
        raise HTTPException(status_code=404, detail="Run not found")

    initial_status = run_row["status"]
    already_terminal = initial_status in _TERMINAL_STATUSES

    # Per-user concurrent-stream cap (Round 16 DoS finding). Acquire
    # synchronously so the 429 is returned before the StreamingResponse.
    stream_slot = _sse_stream_acquire(auth.user_id)

    async def event_generator():
        try:
            q: asyncio.Queue = asyncio.Queue(maxsize=512)

            # If run already terminal, emit current state and close immediately
            if already_terminal:
                final_row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
                if final_row:
                    evt = _public_sse_event({
                        "type": "status",
                        "run_id": run_id,
                        "status": final_row["status"],
                        "error": final_row["error"],
                        "completed_at": final_row["completed_at"],
                    })
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
        finally:
            _sse_stream_release(stream_slot)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


_INTERNAL_LOG_TOKEN_RE = re.compile(
    r"\b(?:trace_[A-Za-z0-9_.:-]+|(?:thread|step|run|call|msg|tool)_[A-Za-z0-9][A-Za-z0-9_-]{7,})\b"
)
_LOG_METADATA_RE = re.compile(r"\b(?:mode|runner)=[^\s,;]+", re.IGNORECASE)
_MISSING_SECRETS_RE = re.compile(r"Missing secrets?:\s*[A-Z0-9_, ]+", re.IGNORECASE)
_ENV_SECRET_CONFIG_RE = re.compile(
    r"\b[A-Z][A-Z0-9]{1,63}(?:_[A-Z0-9]{1,64})+\b(?:\s+is)?\s+(?:not set|not configured|missing)\b(?:\.[^\n]*)?",
    re.IGNORECASE,
)


def _redact_public_log_message(message: str) -> str:
    redacted = _MISSING_SECRETS_RE.sub("Missing required secrets", message or "")
    redacted = _ENV_SECRET_CONFIG_RE.sub("Required platform secret is not configured", redacted)
    redacted = _INTERNAL_LOG_TOKEN_RE.sub("[redacted-id]", redacted)
    redacted = _LOG_METADATA_RE.sub("[redacted-metadata]", redacted)
    return redacted


# ---------------------------------------------------------------------------
# Operator-surface hygiene (G5): nothing internal is ever shown to operators.
#
# Raw Python tracebacks, sandbox paths (/home/user/worker/run.py), and env-var
# names must never be the operator-facing error or archive reason. We map them
# to a calm, human, actionable headline. The raw text is preserved separately
# (run.error_raw / the Logs tab) for engineers who need it.
# ---------------------------------------------------------------------------

# Sandbox/runtime paths that should never appear in an operator string.
_SANDBOX_PATH_RE = re.compile(r"(?:/(?:home|root|tmp|usr|opt|app|workspace)\b[^\s\"']*)")
# Bare ALL_CAPS env-var-style identifiers (FOO_BAR_TOKEN), 2+ segments so we
# don't eat normal words like "OK" or "JSON".
_ENV_VAR_NAME_RE = re.compile(r"\b[A-Z][A-Z0-9]{1,40}(?:_[A-Z0-9]{1,40}){1,8}\b")
# Internal git branch / lane identifiers (lane/x, feat/x, fix/x, chore/x, …).
_GIT_BRANCH_RE = re.compile(
    r"\b(?:lane|feat|feature|fix|hotfix|chore|recover|docs|polish|backend|land)/[A-Za-z0-9._/-]+"
)

# Structured error_code -> calm operator headline. This is the PRIMARY mapping:
# the run pipeline already classifies every failure into this taxonomy, so we
# key the operator headline off the code FIRST (before any free-text matching).
# That guarantees no raw runtime/sandbox jargon reaches the operator surface,
# even when the raw string carries no traceback / path / env-var artifact.
#
# Any code not listed here falls through to _OPERATOR_ERROR_RULES (free-text)
# and then to the generic fallback, so every failure gets a clean headline.
_TIMEOUT_HEADLINE = "This worker took too long and was stopped. Try again, or simplify the input."
_RUNTIME_HEADLINE = (
    "This worker hit an internal error and stopped. Check the run logs, then edit or re-run the worker."
)
_CONNECTION_HEADLINE = "This worker needs an account connected before it can run. Connect it, then re-run."
_AUTH_HEADLINE = "A connected account or key was rejected. Reconnect the account this worker uses, then re-run."
_INPUT_HEADLINE = "This worker is missing a required input. Add it, then re-run."
_SECRET_HEADLINE = "This worker is missing a required credential. Add it in settings, then re-run."
_OUTPUT_HEADLINE = "This worker finished but its result didn't pass validation. Check the run logs, then re-run."
_CODE_HEADLINE = "This worker's code has an error and couldn't run. Edit the worker to fix it, or re-generate it."
_CANCELLED_HEADLINE = "This run was cancelled before it finished."

_OPERATOR_ERROR_CODE_HEADLINES: Dict[str, str] = {
    # Runtime / agent / sandbox internals (the residual G5 leak class).
    "agent_runtime_error": _RUNTIME_HEADLINE,
    "run_execution_exception": _RUNTIME_HEADLINE,
    "execution_error": _RUNTIME_HEADLINE,
    "skill_runtime_error": _RUNTIME_HEADLINE,
    "openai_call_failed": _RUNTIME_HEADLINE,
    "interrupted_by_restart": "This run was interrupted while the service restarted. Re-run the worker.",
    "context_mount_failed": _RUNTIME_HEADLINE,
    "mcp_connect_failed": _CONNECTION_HEADLINE,
    # Sandbox / timeout / resource.
    "e2b_sandbox_error": _TIMEOUT_HEADLINE,
    "timeout": _TIMEOUT_HEADLINE,
    "sandbox_oom": "This worker ran out of memory and was stopped. Try simplifying the input.",
    "token_cap_exceeded": "This worker reached its output limit and was stopped. Try simplifying the task.",
    "tool_iteration_cap_exceeded": "This worker took too many steps and was stopped. Try simplifying the task.",
    "tool_loop_exhausted": "This worker took too many steps and was stopped. Try simplifying the task.",
    "missing_e2b_key": _RUNTIME_HEADLINE,
    # Setup / configuration.
    "missing_connection": _CONNECTION_HEADLINE,
    "missing_secret": _SECRET_HEADLINE,
    "missing_required_input": _INPUT_HEADLINE,
    "install_failed": "This worker is missing a required package. Add it to the worker's requirements and re-run.",
    "invalid_worker": _CODE_HEADLINE,
    "skill_not_found": _CODE_HEADLINE,
    "worker_not_found": "This worker no longer exists.",
    "worker_disabled": "This worker is paused. Turn it on to run it again.",
    # Output / result.
    "output_validation_failed": _OUTPUT_HEADLINE,
    "schema_violation": _OUTPUT_HEADLINE,
    "quality_gate_failed": "This worker's result didn't meet its quality bar. Check the run logs, then re-run.",
    "missing_result": "This worker finished but didn't produce a result. Check the run logs, then re-run.",
    # Cancellation (not a true failure; kept calm).
    "cancelled": _CANCELLED_HEADLINE,
    "cancelled_queued": _CANCELLED_HEADLINE,
    "cancelled_before_start": _CANCELLED_HEADLINE,
}

# Generic fallback for any unknown / future error_code — never raw jargon.
_OPERATOR_ERROR_GENERIC = (
    "This worker failed to run. Check the run logs for details, then edit or re-run the worker."
)

# Ordered (pattern, operator-message) map. First hit wins for the headline.
# Free-text fallback used only when error_code is absent or unrecognised.
_OPERATOR_ERROR_RULES: List[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bSyntaxError\b|\bIndentationError\b", re.IGNORECASE),
     _CODE_HEADLINE),
    (re.compile(r"\bModuleNotFoundError\b|\bImportError\b", re.IGNORECASE),
     "This worker is missing a required package. Add it to the worker's requirements and re-run."),
    (re.compile(r"\b(?:401|403|Unauthorized|Forbidden|invalid[_ ]?token|authentication)\b", re.IGNORECASE),
     _AUTH_HEADLINE),
    (re.compile(r"Event loop is closed|\basyncio\b|coroutine|RuntimeError", re.IGNORECASE),
     _RUNTIME_HEADLINE),
    (re.compile(r"\bKeyError\b|\bNameError\b|\bAttributeError\b|\bTypeError\b|\bValueError\b", re.IGNORECASE),
     _RUNTIME_HEADLINE),
    (re.compile(r"\b(?:Timed?\s?out|timeout|deadline exceeded)\b", re.IGNORECASE),
     _TIMEOUT_HEADLINE),
    (re.compile(r"\b(?:Connection|Network|DNS|getaddrinfo|ECONN|socket)\b", re.IGNORECASE),
     "This worker couldn't reach an external service. Check the connection, then re-run."),
    (re.compile(r"SHA-256 reference|from /uploads", re.IGNORECASE),
     "This worker needs a file uploaded for one of its inputs. Upload the file, then re-run."),
]


def _has_internal_artifact(text: str) -> bool:
    """True when the string contains a traceback, sandbox path, env-var name,
    or git branch — anything that must never reach an operator surface."""
    if not text:
        return False
    if "Traceback (most recent call last)" in text:
        return True
    if _SANDBOX_PATH_RE.search(text):
        return True
    if _GIT_BRANCH_RE.search(text):
        return True
    if _ENV_VAR_NAME_RE.search(text):
        return True
    return False


def _operator_error_message(
    raw_error: Optional[str], error_code: Optional[str] = None
) -> Optional[str]:
    """Map a run error to a calm, operator-readable headline.

    Resolution order (so NO raw runtime/sandbox jargon ever reaches an operator,
    even when the raw string carries no traceback/path/env-var artifact):

    1. Structured ``error_code`` taxonomy (PRIMARY). The pipeline classifies
       every failure into a known code; we map the code to a fixed headline.
    2. A small set of operator-clean structured messages that are safe to show
       verbatim ("Missing required inputs: prospect_name", "Invalid value 'en';
       expected one of: …", etc.) pass through unchanged.
    3. Free-text rules (``_OPERATOR_ERROR_RULES``) for codeless errors.
    4. Generic fallback. Never the raw string when it looks like jargon.

    Returns None when raw_error is empty.
    """
    code = (error_code or "").strip().lower()
    if code and code in _OPERATOR_ERROR_CODE_HEADLINES:
        return _OPERATOR_ERROR_CODE_HEADLINES[code]

    if raw_error is None:
        # No raw text but an unrecognised code -> generic operator headline.
        return _OPERATOR_ERROR_GENERIC if code else None
    text = str(raw_error).strip()
    if not text:
        return _OPERATOR_ERROR_GENERIC if code else None

    # Light log redaction first (maps "Missing secrets: X" -> generic, etc.).
    redacted = _redact_public_log_message(text)

    # Operator-clean structured messages may pass through verbatim ONLY when
    # they carry no internal artifact AND are not raw runtime/sandbox jargon.
    if not _has_internal_artifact(redacted) and not _looks_like_runtime_jargon(redacted):
        return redacted

    # Free-text fallback for codeless / unrecognised-code errors.
    for pattern, message in _OPERATOR_ERROR_RULES:
        if pattern.search(text):
            return message
    return _OPERATOR_ERROR_GENERIC


# Raw runtime/sandbox boilerplate that is artifact-free (no traceback/path/env)
# yet pure jargon to an operator. Used to stop these from passing through
# verbatim when an error_code is missing or unrecognised.
_RUNTIME_JARGON_RE = re.compile(
    r"(?i:Event loop is closed"
    r"|context deadline exceeded"
    r"|process or directory watch"
    r"|use '0' to disable"
    r"|\basyncio\b"
    r"|\bcoroutine\b"
    r"|SHA-256 reference"
    r"|\bTraceback\b)"
    # Bare Python exception class names (RuntimeError, KeyError, …) are jargon
    # even without a traceback wrapper. CamelCase, case-sensitive, so we do NOT
    # eat the ordinary lowercase word "error" in a clean operator message.
    r"|\b[A-Z][A-Za-z0-9]*(?:Error|Exception)\b",
)


def _looks_like_runtime_jargon(text: str) -> bool:
    """True for artifact-free strings that are still pure runtime/sandbox jargon
    (e.g. 'Event loop is closed', E2B deadline boilerplate). These must not pass
    through verbatim to the operator surface."""
    if not text:
        return False
    return bool(_RUNTIME_JARGON_RE.search(text))


def _run_error_raw(
    raw_error: Optional[str], error_code: Optional[str] = None
) -> Optional[str]:
    """Redacted raw error for the debug 'Raw' tab. Returned only when the
    operator-facing headline differs from the raw text (i.e. we rewrote it),
    so engineers can still inspect what really happened. When the raw text is
    already operator-clean and shown verbatim, there is nothing extra to keep."""
    raw = str(raw_error or "").strip()
    if not raw:
        return None
    headline = _operator_error_message(raw, error_code)
    if headline is None or headline == raw:
        return None
    return _redact_public_log_message(raw) or None


def _sanitize_operator_text(text: Optional[str]) -> Optional[str]:
    """Strip internal artifacts from a short operator-facing string (archive
    reasons, status notes). Never alters strings that are already clean."""
    if text is None:
        return None
    value = str(text).strip()
    if not value:
        return None
    if not _has_internal_artifact(value):
        return value
    value = _GIT_BRANCH_RE.sub("an internal change", value)
    value = _SANDBOX_PATH_RE.sub("the worker's files", value)
    value = _ENV_VAR_NAME_RE.sub("a required credential", value)
    value = re.sub(r"\bTraceback \(most recent call last\):.*", "", value, flags=re.DOTALL)
    value = re.sub(r"\s{2,}", " ", value).strip(" .,;:") + "."
    return value


def _public_sse_event(event: Dict[str, Any]) -> Dict[str, Any]:
    public_event = dict(event)
    if "message" in public_event:
        public_event["message"] = _redact_public_log_message(str(public_event.get("message") or ""))
    if public_event.get("error") is not None:
        public_event["error"] = _redact_public_log_message(str(public_event["error"]))
    public_event.pop("trace_id", None)
    return public_event


def _public_run_part(part: Dict[str, Any]) -> Dict[str, Any]:
    public_part = dict(part)
    if "message" in public_part:
        public_part["message"] = _redact_public_log_message(str(public_part.get("message") or ""))
    if public_part.get("error") is not None:
        public_part["error"] = _redact_public_log_message(str(public_part["error"]))
    return public_part


@app.get("/runs/{run_id}/logs")
def get_run_logs(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[Dict[str, Any]]:
    if _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos) is None:
        raise HTTPException(status_code=404, detail="Run not found")
    rows = repos.runs.list_logs(user_id=auth.user_id, run_id=run_id)
    return [
        {
            "level": r["level"],
            "message": _redact_public_log_message(r["message"]),
            "timestamp": r["timestamp"],
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Run-authenticated Composio tool-execute proxy
# ---------------------------------------------------------------------------
# Workers inside E2B sandboxes cannot hold COMPOSIO_API_KEY (platform secret).
# Instead, they call POST /runs/{run_id}/composio-execute/{tool_slug} using
# their own FLOOM_RUN_ID as the auth token.  The API validates the run_id is
# in RUNNING status, looks up the connection for the requested app, and proxies
# the Composio v3 tool-execute call server-side.
#
# Auth: no x-floom-secret (the path is middleware-exempt). The run_id itself
# acts as a short-lived bearer token — it's valid only while the run is active.

class _ComposioProxyRequest(BaseModel):
    # Composio tool-execute body fields (all optional; forwarded as-is)
    connected_account_id: Optional[str] = None
    user_id: Optional[str] = None
    arguments: Optional[Dict[str, Any]] = None


@app.post("/runs/{run_id}/composio-execute/{tool_slug}")
def composio_execute_proxy(
    run_id: str,
    tool_slug: str,
    body: _ComposioProxyRequest,
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Server-side proxy for Composio tool execution — called from worker sandboxes.

    The worker sends its FLOOM_RUN_ID as the path parameter.  The API:
      1. Validates run_id exists and is in RUNNING status.
      2. Resolves the connected_account_id from the run's worker connections
         (unless caller supplies it explicitly).
      3. Proxies the call to Composio v3 /tools/execute/{tool_slug} with the
         server-side COMPOSIO_API_KEY.
      4. Returns Composio's JSON response verbatim.
    """
    import requests as _req_lib

    # 1. Validate run_id — must exist in DB and be RUNNING
    run_row = repos.runs.get_any(run_id=run_id)
    if run_row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if run_row.get("status") != RunStatus.RUNNING.value:
        raise HTTPException(
            status_code=403,
            detail=f"Run is not currently running (status={run_row.get('status')})",
        )

    # 2. Resolve COMPOSIO_API_KEY from server env
    composio_key = os.environ.get("COMPOSIO_API_KEY", "")
    if not composio_key:
        raise HTTPException(status_code=503, detail="COMPOSIO_API_KEY not configured on server")

    # 3. Resolve connected_account_id if not supplied by caller
    connected_account_id = body.connected_account_id
    if not connected_account_id:
        worker_id = run_row.get("worker_id", "")
        owner_id = run_row.get("user_id", "")
        from db import get_db as _get_db
        with _get_db() as conn:
            # Find the active connection for the tool's implied app.
            # The caller should pass connected_account_id when they know it;
            # this fallback finds the first active connection for the worker's owner.
            tool_prefix = tool_slug.split("_")[0].lower()  # e.g. "GMAIL_..." -> "gmail"
            row = conn.execute(
                "SELECT composio_connection_id FROM composio_connections "
                "WHERE app_name = ? AND status = 'active' LIMIT 1",
                (tool_prefix,),
            ).fetchone()
            if row:
                connected_account_id = row["composio_connection_id"]

    # 4. Build and forward the Composio request
    proxy_body: Dict[str, Any] = {}
    if connected_account_id:
        proxy_body["connected_account_id"] = connected_account_id
    if body.user_id:
        proxy_body["user_id"] = body.user_id
    if body.arguments is not None:
        proxy_body["arguments"] = body.arguments
    else:
        proxy_body["arguments"] = {}

    try:
        r = _req_lib.post(
            f"https://backend.composio.dev/api/v3/tools/execute/{tool_slug}",
            headers={"x-api-key": composio_key, "Content-Type": "application/json"},
            json=proxy_body,
            timeout=30,
        )
        # Return Composio's response as-is (success or error)
        return r.json()
    except _req_lib.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Composio proxy error: {exc}")


# ---------------------------------------------------------------------------
# Secrets — CRUD + test
# ---------------------------------------------------------------------------

# Path to the .env file used by the API
_ENV_PATH = Path(__file__).parent / ".env"


class SecretUpsertRequest(BaseModel):
    value: str = Field(min_length=1, max_length=32 * 1024)


class SecretTestResult(BaseModel):
    status: str  # "valid" | "invalid"
    reason: Optional[str] = None


SecretName = Annotated[str, PathParam(min_length=1, max_length=64, pattern=r"^[A-Z][A-Z0-9_]*$")]


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
    if len(name) < 1 or len(name) > 64:
        raise ValueError("Secret name must be 1-64 characters")
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
        raise ValueError(f"Invalid secret name: {name!r}")
    if len(value) < 1 or len(value) > 32 * 1024:
        raise ValueError("Secret value must be 1-32768 characters")
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
def upsert_secret(
    name: SecretName,
    payload: SecretUpsertRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> SecretTestResult:
    """Create or update a secret. Value is write-only — never returned.

    Platform infrastructure secrets are managed outside the user-secrets API.
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
    repos.secrets.set(
        user_id=auth.user_id,
        name=name,
        value=payload.value,
        status=SecretStatus.SET.value,
    )
    logger.info("Secret %s upserted", name)
    return SecretTestResult(status="valid", reason=f"Secret {name!r} saved.")


@app.delete("/secrets/{name}", response_model=SecretTestResult)
def delete_secret(
    name: SecretName,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> SecretTestResult:
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
    if repos.secrets.get(user_id=auth.user_id, name=name) is None:
        raise HTTPException(status_code=404, detail=f"Secret {name!r} not found in .env")
    repos.secrets.delete(user_id=auth.user_id, name=name)
    logger.info("Secret %s deleted", name)
    return SecretTestResult(status="valid", reason=f"Secret {name!r} removed.")


@app.post("/secrets/{name}/test", response_model=SecretTestResult)
def test_secret(
    name: SecretName,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> SecretTestResult:
    """Test a user-managed secret without exposing provider details or values."""
    if name in PLATFORM_SECRETS:
        raise HTTPException(status_code=404, detail="Secret not found")
    if repos.secrets.get(user_id=auth.user_id, name=name) is None:
        raise HTTPException(status_code=404, detail="Secret not found")
    value = repos.secrets.read_value(user_id=auth.user_id, name=name)
    if not value:
        raise HTTPException(status_code=404, detail="Secret not found")

    return SecretTestResult(status="valid", reason="Secret is configured.")


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
        "name": "FLOOM_CONTEXTS_DIR",
        "required": False,
        "default": "../../contexts",
        "description": "Contexts directory",
    },
    {
        "name": "FLOOM_RUN_TIMEOUT",
        "required": False,
        "default": "300",
        "description": "Default run timeout in seconds",
    },
]

# Set of platform-managed names for fast membership checks. Used to keep
# system/infra vars out of the operator-facing /secrets list and to refuse
# upsert/delete/test on them.
#
# P1-8 (audit 2026-05-29): this previously covered only PLATFORM_SECRET_SPECS,
# so the INFRA_PATH_SPECS vars (FLOOM_DB, FLOOM_WORKERS_DIR, FLOOM_ARTIFACTS_DIR,
# FLOOM_CONTEXTS_DIR, FLOOM_RUN_TIMEOUT) leaked into the user Secrets list with a
# Delete action — deleting FLOOM_DB from the UI could break the running system.
# Both spec lists are platform-managed and must be excluded from the user API.
PLATFORM_SECRETS: frozenset[str] = frozenset(
    s["name"] for s in (PLATFORM_SECRET_SPECS + INFRA_PATH_SPECS)
)


@app.get("/secrets", response_model=List[SecretItem])
def list_secrets(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[SecretItem]:
    db_secrets = {
        row["name"]: row_to_dict(row)
        for row in repos.secrets.list(user_id=auth.user_id)
    }

    workers = _list_visible_workers(user_id=auth.user_id, repos=repos, use_cache=True)

    # (a) All secrets declared by any worker.yml
    worker_secret_names: set[str] = set()
    for w in workers:
        config = get_worker_config_for_run(w["id"])
        if config:
            worker_secret_names.update(config.secrets)

    # Filter out platform-managed secrets — they appear in Settings, not here
    all_secret_names = (worker_secret_names | set(db_secrets)) - PLATFORM_SECRETS

    result: List[SecretItem] = []
    for name in sorted(all_secret_names):
        db_row = db_secrets.get(name, {})
        value = db_row.get("value")
        status_value = str(db_row.get("status") or "").lower()
        if status_value in SecretStatus._value2member_map_:
            status = SecretStatus(status_value)
        else:
            status = SecretStatus.SET if value else SecretStatus.MISSING
        used_by = []
        for w in workers:
            config = get_worker_config_for_run(w["id"])
            if config and name in config.secrets:
                used_by.append(w["name"])
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


class MCPConnectionCreateRequest(BaseModel):
    label: str
    url: str
    auth_secret: Optional[str] = None
    allowed_tools: List[str] = Field(default_factory=list)


class ConnectionItem(BaseModel):
    id: str
    app_name: str
    composio_connection_id: str
    status: str
    created_at: str
    updated_at: str
    kind: str = "composio"
    scopes: List[str] = []
    account_label: Optional[str] = None
    display_name: Optional[str] = None
    last_checked_at: Optional[str] = None
    last_check_status: Optional[str] = None
    mcp_label: Optional[str] = None
    mcp_url: Optional[str] = None
    mcp_auth_secret: Optional[str] = None
    mcp_allowed_tools: List[str] = []


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


def _parse_json_string_list(value: Optional[str]) -> List[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str) and item.strip()]


_CONNECTION_LIST_REFRESH_STATUSES = {"initiated", "pending"}
_CONNECTION_LIST_REFRESH_INTERVAL = timedelta(seconds=30)
_COMPOSIO_ACTIVE_STATUSES = {"active", "valid"}


def _normalize_composio_connection_status(status: Optional[str]) -> str:
    normalized = (status or "").strip().lower()
    if normalized in _COMPOSIO_ACTIVE_STATUSES:
        return "active"
    return normalized


def _connection_list_refresh_due(row: Dict[str, Any], now: datetime) -> bool:
    if (row.get("kind") or "composio") != "composio":
        return False

    status = str(row.get("status") or "").lower()
    if status not in _CONNECTION_LIST_REFRESH_STATUSES:
        return False

    updated_at = _parse_iso8601(row.get("updated_at"))
    if updated_at is None or now - updated_at < _CONNECTION_LIST_REFRESH_INTERVAL:
        return False

    last_checked_at = _parse_iso8601(row.get("last_checked_at"))
    if last_checked_at is not None and now - last_checked_at < _CONNECTION_LIST_REFRESH_INTERVAL:
        return False

    return True


def _refresh_connection_status_for_list(
    row: Dict[str, Any],
    *,
    user_id: str,
    repos: Repositories,
    now: datetime,
) -> Dict[str, Any]:
    if not _connection_list_refresh_due(row, now):
        return row

    checked_at = now.isoformat()
    try:
        from composio_client import check_status

        remote_status = _normalize_composio_connection_status(
            check_status(row["composio_connection_id"])
        )
    except Exception as exc:
        logger.warning("Could not refresh Composio status for %s during list: %s", row.get("id"), exc)
        updated = repos.connections.update(
            user_id=user_id,
            composio_id=row["id"],
            last_checked_at=checked_at,
            last_check_status="failed",
            last_check_error=str(exc)[:500],
        )
        return row_to_dict(updated) if updated else row

    updates: Dict[str, Any] = {
        "last_checked_at": checked_at,
        "last_check_status": remote_status or "unknown",
        "last_check_error": None,
    }
    if remote_status and remote_status != "not_found" and remote_status != str(row.get("status") or "").lower():
        updates["status"] = remote_status
        updates["updated_at"] = checked_at

    updated = repos.connections.update(
        user_id=user_id,
        composio_id=row["id"],
        **updates,
    )
    return row_to_dict(updated) if updated else row


def _redact_connection_account_label(value: Optional[str]) -> Optional[str]:
    """Mask an account identity for any CROSS-USER / multi-tenant surface.

    Workeros OS is single-tenant: the owner is the only principal and MUST see
    their own account identity (the GitHub login, the connected Google email).
    This helper is retained for a future multi-tenant / shared path where one
    user must NOT see another user's account identity — call it only there.
    For the owner's own connections use ``_normalize_owner_account_label``.
    """
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if "@" in text:
        return "Connected account"
    return text[:32]


def _normalize_owner_account_label(value: Optional[str]) -> Optional[str]:
    """Return the owner's own account identity verbatim (single-tenant view).

    No redaction: in single-tenant the owner is entitled to see their real
    GitHub login / Google email. The placeholder "Connected account" string is
    treated as "no real label yet" so the UI can fall back to other fields.
    """
    if not value:
        return None
    text = str(value).strip()
    if not text or text == "Connected account":
        return None
    return text


def _public_connection_item(data: Dict[str, Any]) -> ConnectionItem:
    item = dict(data)
    item["kind"] = item.get("kind") or "composio"
    # Single-tenant owner view: show the owner their OWN account identity.
    # display_name carries the real label when present; fall back to
    # account_label. Both are the owner's own data, so no redaction.
    raw_label = item.get("display_name") or item.get("account_label")
    normalized = _normalize_owner_account_label(raw_label)
    item["account_label"] = normalized
    item["display_name"] = normalized
    item["mcp_allowed_tools"] = _parse_json_string_list(item.pop("mcp_allowed_tools_json", None))
    return ConnectionItem(**item)


def _normalize_mcp_connection_payload(payload: MCPConnectionCreateRequest) -> Dict[str, Any]:
    label = payload.label.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", label):
        raise HTTPException(
            status_code=400,
            detail="MCP label must be 1-64 letters, digits, underscores, or hyphens",
        )

    url = payload.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="MCP URL must start with http:// or https://")

    auth_secret = (payload.auth_secret or "").strip() or None
    if auth_secret and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", auth_secret):
        raise HTTPException(status_code=400, detail="MCP auth secret must be a valid secret name")

    allowed_tools = [tool.strip() for tool in payload.allowed_tools if tool and tool.strip()]
    if len(allowed_tools) != len(payload.allowed_tools):
        raise HTTPException(status_code=400, detail="MCP allowed tools must be non-empty")

    return {
        "label": label,
        "url": url,
        "auth_secret": auth_secret,
        "allowed_tools": allowed_tools,
    }


def _fetch_provider_email(toolkit_slug: str, composio_conn_id: str, user_id: str) -> Optional[str]:
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
        "github": ("GITHUB_GET_THE_AUTHENTICATED_USER", lambda d: d.get("email") or d.get("login")),
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
            json={"connected_account_id": composio_conn_id, "user_id": user_id, "arguments": {}},
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


def _fetch_composio_account_info(composio_conn_id: str, *, user_id: str) -> Dict[str, Any]:
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
        # Scopes: Composio v3 does NOT return a `scopes` list on the
        # connected_account. The real granted scopes live as a delimited
        # `scope` STRING under data/params/state.val (verified 2026-05-29):
        #   github -> "codespace,gist,repo,..."           (comma-delimited)
        #   google -> "https://.../auth/x https://.../y"  (space-delimited)
        # Parse whichever container is present and split on comma OR whitespace.
        scopes: List[str] = []
        raw_scopes = account.get("scopes")
        if isinstance(raw_scopes, list):
            scopes = [s for s in raw_scopes if isinstance(s, str) and s]
        if not scopes:
            scope_str = ""
            for container in (
                account.get("data"),
                account.get("params"),
                (account.get("state") or {}).get("val"),
            ):
                if isinstance(container, dict):
                    candidate = container.get("scope") or container.get("scopes")
                    if isinstance(candidate, str) and candidate.strip():
                        scope_str = candidate
                        break
                    if isinstance(candidate, list) and candidate:
                        scopes = [s for s in candidate if isinstance(s, str) and s]
                        break
            if scope_str and not scopes:
                scopes = [s for s in re.split(r"[,\s]+", scope_str.strip()) if s]
        # Fallback: Composio doesn't return email for managed-OAuth connections
        # and masks the raw access_token, so we cannot call provider userinfo
        # directly. Use Composio's /tools/execute proxy to invoke a per-provider
        # identity tool (e.g. GMAIL_GET_PROFILE) which runs server-side with the
        # real token and returns the email. Cached on the DB row by the caller.
        if not email:
            toolkit_slug = ((account.get("toolkit") or {}).get("slug") or "").lower()
            if toolkit_slug and composio_conn_id:
                email = _fetch_provider_email(toolkit_slug, composio_conn_id, user_id)
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
def list_connections(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[ConnectionItem]:
    rows = repos.connections.list(user_id=auth.user_id)
    now = datetime.now(timezone.utc)

    result = []
    for row in rows:
        d = row_to_dict(row)
        d = _refresh_connection_status_for_list(d, user_id=auth.user_id, repos=repos, now=now)
        d["scopes"] = _parse_scopes_json(d.pop("scopes_json", None))
        result.append(_public_connection_item(d))
    return result


@app.post("/connections", response_model=ConnectionInitResponse)
def initiate_connection(
    payload: ConnectionInitRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ConnectionInitResponse:
    from composio_client import initiate_connection as composio_initiate, NoManagedAuthError
    app_name = payload.app_name.lower().strip()
    if not app_name:
        raise HTTPException(status_code=400, detail="app_name is required")

    callback_url = _get_callback_url()
    try:
        result = composio_initiate(app_name, callback_url, user_id=auth.user_id)
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
    repos.connections.upsert(
        user_id=auth.user_id,
        id=conn_id,
        app_name=app_name,
        composio_connection_id=composio_conn_id,
        status="initiated",
        created_at=now,
        updated_at=now,
    )

    return ConnectionInitResponse(
        id=conn_id,
        app_name=app_name,
        redirect_url=redirect_url,
        composio_connection_id=composio_conn_id,
    )


@app.post("/connections/mcp", response_model=ConnectionItem)
def create_mcp_connection(
    payload: MCPConnectionCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ConnectionItem:
    normalized = _normalize_mcp_connection_payload(payload)
    label = normalized["label"]
    label_key = label.lower()
    for existing in repos.connections.list(user_id=auth.user_id):
        if (existing.get("kind") or "composio") != "mcp":
            continue
        if str(existing.get("mcp_label") or "").lower() == label_key:
            raise HTTPException(status_code=409, detail="MCP label already exists")

    conn_id = str(_uuid_mod.uuid4())
    now = now_iso()
    app_name = f"mcp:{label.lower()}"
    row = repos.connections.upsert(
        user_id=auth.user_id,
        id=conn_id,
        app_name=app_name,
        composio_connection_id=f"mcp:{conn_id}",
        status="active",
        created_at=now,
        updated_at=now,
        kind="mcp",
        account_label=normalized["url"],
        mcp_label=label,
        mcp_url=normalized["url"],
        mcp_auth_secret=normalized["auth_secret"],
        mcp_allowed_tools_json=normalized["allowed_tools"],
    )
    item = row_to_dict(row)
    item["scopes"] = _parse_scopes_json(item.pop("scopes_json", None))
    return _public_connection_item(item)


@app.get("/connections/callback")
def connections_callback(connection_id: str = "", status: str = ""):
    """OAuth callback landing — Composio redirects here after user authorizes.

    Composio sends: ?connection_id=<composio_conn_id>&status=<status>
    We update the local DB and redirect the user to /connections.
    """
    from fastapi.responses import RedirectResponse

    if connection_id:
        repos = get_repositories()
        existing = repos.connections.get_by_composio_connection_id(
            composio_connection_id=connection_id,
        )

        # Ignore unknown callback IDs; known IDs are validated by persisted state.
        if not existing:
            frontend_url = os.environ.get("WORKERS_FRONTEND_URL", "https://workers.floom.dev")
            return RedirectResponse(url=f"{frontend_url}/connections?connected=1")

        # Try to refresh from Composio first
        try:
            from composio_client import check_status
            remote_status = _normalize_composio_connection_status(check_status(connection_id))
        except Exception:
            remote_status = ""

        final_status = (
            remote_status
            if remote_status and remote_status != "not_found"
            else (status or existing["status"])
        )
        now = now_iso()
        repos.connections.update(
            user_id=existing["user_id"],
            composio_id=existing["id"],
            status=final_status,
            composio_connection_id=connection_id,
            updated_at=now,
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
def get_connection_status(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ConnectionItem:
    user_id = auth.user_id
    row = _connection_row_for_user(
        connection_id,
        user_id,
        "id, app_name, composio_connection_id, status, created_at, updated_at, "
        "scopes_json, account_label, last_checked_at, last_check_status",
        repos=repos,
    )

    item = row_to_dict(row)
    item["scopes"] = _parse_scopes_json(item.pop("scopes_json", None))

    if (item.get("kind") or "composio") != "composio":
        return _public_connection_item(item)

    # Refresh from Composio
    try:
        from composio_client import check_status
        remote_status = _normalize_composio_connection_status(
            check_status(item["composio_connection_id"])
        )
        if remote_status and remote_status != item["status"]:
            now = now_iso()
            repos.connections.update(
                user_id=user_id,
                composio_id=connection_id,
                status=remote_status,
                updated_at=now,
            )
            item["status"] = remote_status
            item["updated_at"] = now
    except Exception as exc:
        logger.warning("Could not refresh Composio status for %s: %s", connection_id, exc)

    return _public_connection_item(item)


@app.delete("/connections/{connection_id}")
def delete_connection(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    user_id = auth.user_id
    row = _connection_row_for_user(connection_id, user_id, "composio_connection_id, kind", repos=repos)

    composio_conn_id = row["composio_connection_id"]

    # Attempt to revoke from Composio (best-effort)
    if (row.get("kind") or "composio") == "composio":
        try:
            from composio_client import revoke_connection
            revoke_connection(composio_conn_id)
        except Exception as exc:
            logger.warning("Could not revoke Composio connection %s: %s", composio_conn_id, exc)

    repos.connections.delete(user_id=user_id, composio_id=connection_id)

    return {"status": "deleted"}


@app.get("/connections/{connection_id}/account-info")
def get_connection_account_info(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return Composio connected-account info needed by the UI.

    The frontend calls this to hydrate connection cards. The Composio API key
    lives here on the API service so it never needs to be on Vercel.
    """
    row = _connection_row_for_user(
        connection_id,
        auth.user_id,
        "composio_connection_id, created_at",
        repos=repos,
    )

    composio_conn_id = row["composio_connection_id"]
    info = _fetch_composio_account_info(composio_conn_id, user_id=auth.user_id)
    if not info:
        raise HTTPException(status_code=502, detail="Unable to fetch account info from upstream")

    # Cache scopes + account_label in DB for the list endpoint.
    account_label = info.get("email") or ""
    if info.get("scopes") is not None or account_label:
        now = now_iso()
        repos.connections.update(
            user_id=auth.user_id,
            composio_id=connection_id,
            scopes_json=info.get("scopes") or [],
            account_label=account_label,
            updated_at=now,
        )

    # Single-tenant owner view: return the owner's own account identity so the
    # UI can render the real GitHub login / Google email instead of a placeholder.
    return {
        "email": account_label or None,
        "scopes": info.get("scopes") or [],
        "connected_at": row["created_at"],
    }


@app.get("/connections/auth-configs/{auth_config_id}", dependencies=[Depends(get_auth_context)])
def get_auth_config(auth_config_id: str) -> Dict[str, Any]:
    """Return Composio auth_config (scopes definition) for a given auth_config_id.

    Proxies to Composio so the key stays on the API service, not on Vercel.
    """
    if os.environ.get("WORKEROS_ENABLE_INTERNAL_AUTH_CONFIGS") != "1":
        raise HTTPException(status_code=404, detail="Not found")

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
def test_connection(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ConnectionTestResult:
    """Test whether a connection's token is still valid by calling Composio."""
    row = _connection_row_for_user(
        connection_id,
        auth.user_id,
        "composio_connection_id, kind",
        repos=repos,
    )

    composio_conn_id = row["composio_connection_id"]
    tested_at = now_iso()

    if (row.get("kind") or "composio") != "composio":
        _write_connection_check(connection_id, "valid", None, tested_at, repos=repos)
        return ConnectionTestResult(
            status="valid",
            reason="MCP server is saved; runtime connection is checked when a worker runs.",
            tested_at=tested_at,
        )

    try:
        from composio_client import check_status
        remote_status = _normalize_composio_connection_status(check_status(composio_conn_id))
    except Exception as exc:
        _write_connection_check(connection_id, "failed", str(exc), tested_at, repos=repos)
        return ConnectionTestResult(
            status="failed",
            reason=f"Upstream check failed: {exc}",
            tested_at=tested_at,
        )

    if remote_status == "not_found":
        _write_connection_check(
            connection_id,
            "failed",
            "Connection not found in upstream",
            tested_at,
            repos=repos,
        )
        return ConnectionTestResult(
            status="failed",
            reason="Connection not found in the integration service",
            tested_at=tested_at,
        )
    if remote_status in ("expired", "failed"):
        _write_connection_check(
            connection_id,
            remote_status,
            f"Status: {remote_status}",
            tested_at,
            repos=repos,
        )
        return ConnectionTestResult(
            status=remote_status,
            reason=f"Connection status is {remote_status}",
            tested_at=tested_at,
        )
    if remote_status == "active":
        _write_connection_check(connection_id, "valid", None, tested_at, repos=repos)
        return ConnectionTestResult(
            status="valid",
            reason="Connection is active",
            tested_at=tested_at,
        )

    # Unknown status: treat as valid but note it
    _write_connection_check(
        connection_id,
        "valid",
        f"Status: {remote_status}",
        tested_at,
        repos=repos,
    )
    return ConnectionTestResult(
        status="valid",
        reason=f"Connection status: {remote_status}",
        tested_at=tested_at,
    )


def _connection_by_id(
    connection_id: str,
    repos: Repositories | None = None,
) -> Optional[Dict[str, Any]]:
    rows = (repos or get_repositories()).connections.list_all()
    return next((row_to_dict(row) for row in rows if row["id"] == connection_id), None)


def _write_connection_check(
    connection_id: str,
    check_status: str,
    error: Optional[str],
    checked_at: str,
    repos: Repositories | None = None,
) -> None:
    """Persist health-check result to the DB row."""
    repos_obj = repos or get_repositories()
    row = _connection_by_id(connection_id, repos_obj)
    if row is None:
        return
    repos_obj.connections.update(
        user_id=row["user_id"],
        composio_id=connection_id,
        last_checked_at=checked_at,
        last_check_status=check_status,
        last_check_error=error,
        updated_at=checked_at,
    )


async def _run_connection_sweep(*, user_id: str | None = None) -> None:
    """Background task: test every connection and update last_checked_at columns."""
    logger.info("Connection health sweep starting")
    repos = get_repositories()
    rows = repos.connections.list(user_id=user_id) if user_id else repos.connections.list_all()

    for row in rows:
        if (row.get("kind") or "composio") != "composio":
            logger.debug("Skipped MCP connection %s during Composio sweep", row["id"])
            continue
        conn_id = row["id"]
        composio_conn_id = row["composio_connection_id"]
        tested_at = now_iso()
        try:
            from composio_client import check_status
            remote_status = _normalize_composio_connection_status(
                check_status(composio_conn_id)
            )
            check = "valid" if remote_status == "active" else (
                remote_status if remote_status in ("expired", "failed") else "valid"
            )
            error = None if remote_status == "active" else f"Status: {remote_status}"
        except Exception as exc:
            check = "failed"
            error = str(exc)
        _write_connection_check(conn_id, check, error, tested_at, repos=repos)
        # Also refresh account_label + scopes for ACTIVE connections so the
        # user sees their actual email rather than the hardcoded "federico"
        # user_id. _fetch_composio_account_info uses Composio's tool-execute
        # proxy to get the real email via GMAIL_GET_PROFILE etc.
        if check == "valid":
            try:
                info = _fetch_composio_account_info(composio_conn_id, user_id=row["user_id"])
                email_or_user = info.get("email") or info.get("user_id") or ""
                scopes = info.get("scopes") or []
                update_kwargs: Dict[str, Any] = {}
                if email_or_user:
                    update_kwargs["account_label"] = email_or_user
                if scopes:
                    update_kwargs["scopes_json"] = scopes
                if update_kwargs:
                    repos.connections.update(
                        user_id=row["user_id"],
                        composio_id=conn_id,
                        updated_at=tested_at,
                        **update_kwargs,
                    )
            except Exception as exc:
                logger.debug("account_label/scopes refresh failed for %s: %s", conn_id, exc)
        logger.debug("Swept connection %s: %s", conn_id, check)
        await asyncio.sleep(0.5)  # Rate-limit Composio calls

    logger.info("Connection health sweep complete (%d connections)", len(rows))


_connection_sweep_gate_lock = threading.Lock()
_connection_sweep_last_started_at_by_user: Dict[str, float] = {}


def _connection_sweep_cooldown_seconds() -> float:
    try:
        return max(0.0, float(os.environ.get("WORKEROS_SWEEP_COOLDOWN_SECONDS", "300")))
    except ValueError:
        return 300.0


@app.post("/system/sweep-connections")
async def sweep_connections_endpoint(
    auth: AuthContext = Depends(get_auth_context),
):
    """Trigger a health-check sweep for all connections. Called by external cron."""
    now = time.monotonic()
    cooldown = _connection_sweep_cooldown_seconds()
    user_key = auth.user_id or "anonymous"
    with _connection_sweep_gate_lock:
        last_started_at = _connection_sweep_last_started_at_by_user.get(user_key, 0.0)
        elapsed = now - last_started_at
        if cooldown > 0 and last_started_at and elapsed < cooldown:
            retry_after = max(1, int(cooldown - elapsed))
            raise HTTPException(
                status_code=429,
                detail="Connection sweep already started recently",
                headers={"Retry-After": str(retry_after)},
            )
        _connection_sweep_last_started_at_by_user[user_key] = now
    asyncio.create_task(_run_connection_sweep(user_id=auth.user_id))
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


def _webhook_receipt_ttl_seconds() -> int:
    try:
        return max(3600, int(os.environ.get("WORKEROS_WEBHOOK_RECEIPT_TTL_SECONDS", "604800")))
    except ValueError:
        return 604800


def _claim_webhook_delivery(source: str, delivery_id: str) -> bool:
    if not delivery_id:
        return True
    now_ts = time.time()
    cutoff = now_ts - _webhook_receipt_ttl_seconds()
    with get_db() as conn:
        conn.execute(
            "DELETE FROM webhook_delivery_receipts WHERE source = ? AND received_at <= ?",
            (source, cutoff),
        )
        try:
            conn.execute(
                """
                INSERT INTO webhook_delivery_receipts (source, delivery_id, received_at)
                VALUES (?, ?, ?)
                """,
                (source, delivery_id, now_ts),
            )
        except sqlite3.IntegrityError:
            return False
    return True


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

    delivery_id = (
        request.headers.get("webhook-id")
        or (payload.get("id") if isinstance(payload, dict) else "")
        or ""
    )
    if not _claim_webhook_delivery(f"composio:{worker_id}", str(delivery_id)):
        return ActionResponse(status="duplicate_ignored")

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
    runs_7d_sparkline: List["OverviewSparklineBucket"]
    success_rate_7d: Optional[float] = None
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


@app.get("/system/overview", response_model=OverviewResponse)
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
    _db_workers_by_id = {
        row["id"]: row
        for row in repos.workers.list(user_id=auth.user_id)
        if row.get("id")
    }
    workers = [
        _db_workers_by_id.get(w["id"], w)
        for w in _list_operator_workers(user_id=auth.user_id, repos=repos)
        if w.get("id")
    ]
    active_workers_count = sum(1 for row in workers if not _overview_worker_paused(row))
    paused_workers_count = max(0, len(workers) - active_workers_count)
    worker_names = {row["id"]: row.get("name") or row["id"] for row in workers if row.get("id")}

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

    recent_rows, _ = repos.runs.list(user_id=auth.user_id, limit=10, offset=0)
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
    ]

    scheduled_today: List[OverviewScheduledItem] = []
    try:
        from scheduler import compute_next_run_at
    except Exception:
        compute_next_run_at = None

    for worker in workers:
        for trigger in _overview_schedule_triggers(worker):
            cron_expr = trigger.get("cron") or worker.get("cron_expr")
            next_fire = _parse_iso8601(worker.get("next_run_at"))
            if next_fire is None or next_fire <= now or next_fire > next_24h:
                if compute_next_run_at and cron_expr:
                    computed = compute_next_run_at(str(cron_expr), now)
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

    completed_or_failed_7d = sum(1 for row in _runs_7d_rows if _is_completed(row) or _is_failed(row))
    success_rate_7d = completed_7d / completed_or_failed_7d if completed_or_failed_7d else None

    return OverviewResponse(
        stats=OverviewStats(
            runs_24h=runs_24h,
            runs_24h_sparkline=sparkline,
            runs_7d_sparkline=runs_7d_sparkline,
            success_rate_7d=success_rate_7d,
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


@app.get("/system/alerts")
def system_alerts(auth: AuthContext = Depends(get_auth_context)):
    """Return open (unresolved) alert incidents.

    Returns a list of {worker_id, incident_key, reason, details, fired_at} for
    incidents that have not yet been resolved.  Used for diagnostics and the
    test harness.
    """
    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT id, worker_id, incident_key, reason, details, fired_at, resolved_at
                FROM alert_incidents
                ORDER BY fired_at DESC
                LIMIT 200
                """
            ).fetchall()
    except Exception:
        # Table may not exist yet if migrations haven't run (e.g., test env)
        return {"incidents": []}
    return {
        "incidents": [
            {
                "id": row["id"],
                "worker_id": row["worker_id"],
                "incident_key": row["incident_key"],
                "reason": row["reason"],
                "details": row["details"],
                "fired_at": row["fired_at"],
                "resolved_at": row["resolved_at"],
                "open": row["resolved_at"] is None,
            }
            for row in rows
        ]
    }


@app.get("/system/metrics")
def system_metrics(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Operational metrics for the dashboard / external monitors.

    Gated by x-floom-secret like other admin routes. Returns a flat counters
    payload suitable for cron-scraped JSON monitoring.
    """
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


def _prometheus_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _prometheus_label(worker_id: str, status: str | None = None) -> str:
    labels = [f'worker_id="{_prometheus_escape(worker_id)}"']
    if status is not None:
        labels.append(f'status="{_prometheus_escape(status)}"')
    return "{" + ",".join(labels) + "}"


_METRICS_DB_CONNECTION_ERRORS_TOTAL = 0


@app.get("/metrics", response_class=PlainTextResponse)
def prometheus_metrics(auth: AuthContext = Depends(get_auth_context)):
    """Prometheus text exposition for runtime health."""
    buckets = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600]
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
        "# HELP workeros_active_runs Active queued or running runs.",
        "# TYPE workeros_active_runs gauge",
        f"workeros_active_runs {int(active_runs or 0)}",
    ])
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4")


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


def _worker_has_webhook_trigger(worker: Dict[str, Any], config: Optional["WorkerConfig"]) -> bool:
    """Return True if any of the worker's triggers is of type 'webhook'.

    Checks triggers_json in the DB first (multi-trigger support), then
    falls back to the single config.trigger.type.
    """
    # Check multi-trigger DB column first
    try:
        if worker.get("triggers_json"):
            triggers = json.loads(worker["triggers_json"])
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

    Requires a worker-specific webhook credential.
    On success returns run_id immediately (non-blocking).
    """
    from webhook_service import get_webhook_secret_hash, verify_signature, verify_webhook_token
    repos = get_repositories()

    # Rate limit: 60 req/60s per (worker_id, client_ip) — in-memory sliding window
    client_ip = (request.client.host if request.client else "unknown")
    rl_key = f"{worker_id}:{client_ip}"
    if not _check_webhook_rate_limit(rl_key):
        raise HTTPException(status_code=429, detail="Too many webhook requests")

    worker = repos.workers.get_any(worker_id=worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    user_id = worker.get("owner_id")
    config = get_worker_config_for_run(worker_id)
    if not _worker_has_webhook_trigger(worker, config):
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
            secret_hash = get_webhook_secret_hash(worker_id, repos=repos)
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
    run_id = create_run(
        worker_id,
        inputs,
        trigger_source="webhook",
        user_id=user_id,
        repos=repos,
    )
    start_run(run_id, worker_id, inputs, user_id=user_id, repos=repos)

    return ActionResponse(status="queued", run_id=run_id)


@app.post("/workers/{worker_id}/webhook-secret/rotate", response_model=WebhookSecretResponse)
def rotate_webhook_secret(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WebhookSecretResponse:
    """Rotate the webhook HMAC secret for a worker.

    Returns the new raw secret exactly once — it is never stored in plaintext.
    """
    from webhook_service import generate_webhook_secret

    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    config = get_worker_config_for_run(worker_id)
    if not _worker_has_webhook_trigger(worker, config):
        raise HTTPException(
            status_code=400,
            detail=f"Worker {worker_id!r} does not have a webhook trigger",
        )

    raw_secret = generate_webhook_secret(worker_id, repos=repos)
    return WebhookSecretResponse(worker_id=worker_id, secret=raw_secret)


# ---------------------------------------------------------------------------
# CLI device-code auth
# ---------------------------------------------------------------------------

_CLI_AUTH_EXPIRES_SECONDS = 600
_CLI_AUTH_POLL_INTERVAL_SECONDS = 2
_CLI_AUTH_USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CLI_AUTH_MAX_DEVICES = 100


class CliAuthDeviceCreateRequest(BaseModel):
    client_name: str
    scopes: List[str] = []


class CliAuthCodeRequest(BaseModel):
    user_code: str


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
def create_cli_device(payload: CliAuthDeviceCreateRequest, request: Request) -> Dict[str, Any]:
    client_name = (payload.client_name or "").strip()
    if not client_name:
        raise HTTPException(status_code=400, detail="client_name is required")

    repos = get_repositories()
    now_ts = time.time()
    expires_at = now_ts + _CLI_AUTH_EXPIRES_SECONDS
    user_id = _bootstrap_user_id()
    repos.cli_auth.prune_expired(now_ts=now_ts)

    existing_devices = repos.cli_auth.list(user_id=user_id)
    while len(existing_devices) >= _CLI_AUTH_MAX_DEVICES:
        oldest = min(existing_devices, key=lambda row: float(row.get("created_at", 0.0)))
        repos.cli_auth.delete(device_code=oldest["device_code"])
        existing_devices = repos.cli_auth.list(user_id=user_id)

    device_code = _new_device_code()
    existing_device_codes = {row["device_code"] for row in existing_devices}
    while device_code in existing_device_codes:
        device_code = _new_device_code()

    existing_user_codes = {str(record.get("user_code", "")) for record in existing_devices}
    user_code = _new_user_code()
    while user_code in existing_user_codes:
        user_code = _new_user_code()

    repos.cli_auth.create_device(
        user_id=user_id,
        device_code=device_code,
        user_code=user_code,
        status="pending",
        secret=None,
        client_name=client_name,
        scopes=list(payload.scopes or []),
        created_ip=_client_ip(request),
        created_at=now_ts,
        expires_at=expires_at,
    )

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
    repos = get_repositories()
    now_ts = time.time()
    record = repos.cli_auth.get_by_device_code(device_code)
    if not record:
        raise HTTPException(status_code=404, detail="Device code not found")

    if float(record.get("expires_at", 0.0)) <= now_ts:
        repos.cli_auth.delete(device_code=device_code)
        raise HTTPException(status_code=404, detail="Device code not found")

    status = str(record.get("status", "pending"))
    if status == "pending":
        return {"status": "pending"}

    if status == "denied":
        repos.cli_auth.delete(device_code=device_code)
        raise HTTPException(status_code=404, detail="Device code not found")

    if status == "approved":
        consumed = repos.cli_auth.consume(device_code)
        if consumed is None:
            raise HTTPException(status_code=404, detail="Device code not found")
        secret = str(consumed.get("secret") or "")
        if not secret:
            raise HTTPException(status_code=500, detail="Approved device missing API secret")
        return {
            "status": "approved",
            "api_secret": secret,
            "api_base": _api_public_base(),
        }

    raise HTTPException(status_code=500, detail=f"Unexpected device status: {status}")


@app.post("/cli-auth/approve")
def approve_cli_device(
    payload: CliAuthCodeRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    floom_secret = os.environ.get("FLOOM_SECRET", "")
    if not floom_secret:
        raise HTTPException(status_code=503, detail="FLOOM_SECRET is not configured")

    now_ts = time.time()
    repos.cli_auth.prune_expired(now_ts=now_ts)
    record = repos.cli_auth.verify_device(payload.user_code)
    if not record or record["user_id"] != auth.user_id:
        raise HTTPException(status_code=404, detail="User code not found")
    if str(record.get("status")) != "pending":
        raise HTTPException(status_code=409, detail="Device code is no longer pending")
    repos.cli_auth.update(
        device_code=record["device_code"],
        status="approved",
        secret=floom_secret,
        approved_at=now_ts,
    )
    return {"ok": True, "client_name": record.get("client_name") or "unknown"}


@app.post("/cli-auth/deny")
def deny_cli_device(
    payload: CliAuthCodeRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    now_ts = time.time()
    repos.cli_auth.prune_expired(now_ts=now_ts)
    record = repos.cli_auth.verify_device(payload.user_code)
    if not record or record["user_id"] != auth.user_id:
        raise HTTPException(status_code=404, detail="User code not found")
    if str(record.get("status")) != "pending":
        raise HTTPException(status_code=409, detail="Device code is no longer pending")
    repos.cli_auth.update(
        device_code=record["device_code"],
        status="denied",
        secret=None,
    )
    return {"ok": True, "client_name": record.get("client_name") or "unknown"}


# ---------------------------------------------------------------------------
# S37 — Workspace agent /chat endpoint + conversation history
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str
    conversation_id: Optional[str] = None


class ConversationSummary(BaseModel):
    id: str
    title: Optional[str] = None
    created_at: str
    updated_at: str
    message_count: int


class ConversationDetail(BaseModel):
    id: str
    title: Optional[str] = None
    created_at: str
    updated_at: str
    messages: List[Dict[str, Any]]


@app.get("/workspace")
async def get_workspace(auth: AuthContext = Depends(get_auth_context)) -> PlainTextResponse:
    """Return the current workspace.md content."""
    from chat_service import get_workspace_md
    return PlainTextResponse(get_workspace_md(), media_type="text/markdown")


@app.put("/workspace", status_code=204)
async def put_workspace(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> Response:
    """Update workspace.md (replaces entire content)."""
    from chat_service import set_workspace_md
    body = await request.body()
    content = body.decode("utf-8", errors="replace")
    if not content.strip():
        raise HTTPException(status_code=400, detail="workspace.md content cannot be empty")
    set_workspace_md(content)
    return Response(status_code=204)


@app.post("/chat")
async def post_chat(
    payload: ChatRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> StreamingResponse:
    """Stream a workspace agent response as Server-Sent Events.

    Each SSE event is a JSON-encoded AI SDK part:
      {"type": "text", "text": "..."}
      {"type": "tool-call", "toolName": "...", "args": {...}, "callId": "..."}
      {"type": "tool-result", "callId": "...", "result": {...}}
      {"type": "finish", "conversation_id": "...", "message_id": "..."}
    """
    import asyncio
    from chat_service import stream_chat

    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    max_chars = _chat_message_max_chars()
    if len(message) > max_chars:
        raise HTTPException(
            status_code=413,
            detail=f"message exceeds {max_chars} character limit",
        )
    # /chat calls OpenAI per request; enforce a per-user quota so a single
    # caller cannot run up an unbounded LLM bill (the shared IP limiter is too
    # loose for a paid-LLM path).
    _enforce_chat_quota(auth)

    part_queue: asyncio.Queue = asyncio.Queue(maxsize=1024)
    loop = asyncio.get_running_loop()

    async def _run_in_thread():
        """Execute the agent in a thread (agent driver is sync-bridged)."""
        try:
            await stream_chat(
                message=message,
                user_id=auth.user_id,
                conversation_id=payload.conversation_id,
                part_queue=part_queue,
            )
        except Exception as exc:
            logger.exception("chat background task failed")
            try:
                await part_queue.put({"type": "error", "error": str(exc)})
                await part_queue.put({"type": "finish", "conversation_id": None, "message_id": None})
            except Exception:
                pass

    task = loop.create_task(_run_in_thread())

    async def event_generator():
        while True:
            if await request.is_disconnected():
                task.cancel()
                break
            try:
                part = await asyncio.wait_for(part_queue.get(), timeout=5.0)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(part, default=str)}\n\n"
            if part.get("type") == "finish":
                break

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/conversations", response_model=List[ConversationSummary])
async def list_conversations(
    auth: AuthContext = Depends(get_auth_context),
    limit: int = Query(default=50, ge=1, le=200),
) -> List[Dict[str, Any]]:
    """List conversations for the authenticated user."""
    from chat_service import list_conversations as _list
    return _list(auth.user_id, limit=limit)


@app.get("/conversations/{conversation_id}")
async def get_conversation_detail(
    conversation_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    """Get a conversation with its messages."""
    from chat_service import get_conversation, list_conversation_messages
    conv = get_conversation(conversation_id, auth.user_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    messages = list_conversation_messages(conversation_id, auth.user_id)
    return {**conv, "messages": messages}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
