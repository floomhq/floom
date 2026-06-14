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
try:
    import fcntl as _fcntl_mod
    def _flock(fd, op): _fcntl_mod.flock(fd, op)
    _LOCK_EX = _fcntl_mod.LOCK_EX
    _LOCK_UN = _fcntl_mod.LOCK_UN
except ImportError:
    # Windows: no fcntl, so use msvcrt or fall back to a no-op for single-process dev.
    try:
        import msvcrt as _msvcrt
        def _flock(fd, op):
            if op == 1:
                _msvcrt.locking(fd.fileno(), _msvcrt.LK_NBLCK, 1)
            else:
                _msvcrt.locking(fd.fileno(), _msvcrt.LK_UNLCK, 1)
    except Exception:
        def _flock(fd, op): pass
    class _fcntl_mod:  # type: ignore[no-redef]
        LOCK_EX = 1; LOCK_SH = 0; LOCK_UN = 8; LOCK_NB = 4
        @staticmethod
        def flock(fd, op): _flock(fd, op)
    _LOCK_EX = 1
    _LOCK_UN = 8
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
import urllib.parse
import ipaddress
import math
import requests
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Callable, Dict, Iterable, List, Literal, NotRequired, Optional, TypedDict

from fastapi import BackgroundTasks, Body, Depends, FastAPI, File, Form, HTTPException, Path as PathParam, Query, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.responses import StreamingResponse
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from dotenv import load_dotenv

from auth import AuthContext, get_auth_context, get_auth_provider
from auth.context import current_auth_context, current_auth_user_id, set_current_auth_context
from auth.local_workspaces import (
    DEFAULT_WORKSPACE_ID,
    create_local_workspace,
    delete_local_workspace,
    get_local_workspace,
    list_local_workspaces,
    local_workspace_base_user_id,
    local_workspace_user_id,
    rename_local_workspace,
    update_local_workspace,
    requested_local_workspace_id,
)
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
    effective_context_user_id,
    ensure_contexts_dir,
    guess_mime_type,
    is_active_markup,
    is_binary_file,
    iter_context_files,
    load_context_metadata,
    normalize_context_mount,
    normalize_context_file_path,
    safe_context_file_path,
    set_context_scope_resolver,
    set_context_file_metadata,
    set_context_file_secret_flag,
    is_context_sensitive,
    set_context_metadata,
    use_context_scope,
    validate_context_name,
)

try:
    from slowapi.util import get_remote_address as _slowapi_get_remote_address
except Exception:  # pragma: no cover - fallback only used when dependency is absent locally
    _slowapi_get_remote_address = None

from db import DB_PATH, Repositories, WorkspaceMemberRepository, assistant_row_id, derive_workspace_id, get_db, get_repos, get_repositories, init_db, now_iso, sqlite_runtime_settings
from files import blob_path, ensure_blob_dir, extension_for_file, is_sha256, normalize_media_type
from secret_scan import scan_bytes
from models import (
    AssetPermissions,
    RunCreate,
    WorkerVisibilityUpdate,
    WorkerSummary,
    WorkerDetail,
    DetailLastRun,
    PublicWorker,
    PublicWorkerInput,
    PublicWorkerOutput,
    WorkerFile,
    RunSummary,
    RunDetail,
    ToolCallEntry,
    ApprovalEntry,
    LogEntry,
    Artifact,
    OutputField,
    SecretItem,
    ReloadResponse,
    ActionResponse,
    McpToolItem,
    McpToolCreate,
    McpToolUpdate,
    RunStatus,
    SecretStatus,
    WorkerStatus,
    WorkerConfig,
    WorkerInput,
    WorkerSummaryInput,
    WorkerUpdateRequest,
    RecentStats,
    TriggerSpec,
    TimeseriesDay,
    WorkerAlert,
    WorkerAlertCreate,
    WorkerFeedback,
    WorkerFeedbackCreate,
    WorkerStats,
    WorkspaceStats,
    UnsafeMCPUrlError,
    UnsafeOutboundUrlError,
    assert_safe_outbound_mcp_url,
    assert_safe_outbound_url,
    composio_app_for_tool_slug,
    composio_tool_allowed_by_scope,
    declared_composio_connections,
    declared_composio_connection_scopes,
    read_only_preset_for_app,
    read_only_presets,
)
from worker_registry import (
    WORKERS_DIR,
    discover_workers,
    get_worker,
    invalidate_worker_cache,
)
import git_ops as _git_ops


# #1001: a host (managed-deployment) maintains its per-workspace git repos in its
# own materialized tree (var/workspaces/{id}), NOT WORKERS_DIR/{id}. It registers
# a resolver here so EVERY engine git op — versions read AND rollback — runs in
# the same real tree (mirrors run_token.set_worker_call_secret_resolver). Pass
# None to clear (OSS mode). Receives the active workspace_id (or None).
_git_workspace_resolver: "Optional[Callable[[Optional[str]], Optional[Path | str]]]" = None


def set_git_workspace_resolver(resolver: "Optional[Callable[[Optional[str]], Optional[Path | str]]]") -> None:
    global _git_workspace_resolver
    _git_workspace_resolver = resolver


def _git_workspace() -> Path:
    """Return the git workspace root for the current request.

    OSS (single-tenant): WORKEROS_WORKSPACE_DIR env var, or WORKERS_DIR.parent.
    Cloud (multi-tenant): a host-registered resolver (#1001) returns the real
    materialized per-workspace git root; else WORKERS_DIR / {workspace_id}.
    """
    custom = os.environ.get("WORKEROS_WORKSPACE_DIR", "").strip()
    if custom:
        return Path(custom).resolve()
    workspace_id = _git_ops.get_active_workspace_id()
    # #1001: host resolver wins — points read AND rollback at one consistent tree.
    if _git_workspace_resolver is not None:
        try:
            resolved = _git_workspace_resolver(workspace_id)
        except Exception:
            logger.warning("git workspace resolver failed for %s", workspace_id, exc_info=True)
            resolved = None
        if resolved:
            return Path(resolved).resolve()
    if workspace_id:
        # Cloud default (no resolver): each workspace has its own git repo.
        return (WORKERS_DIR / workspace_id).resolve()
    # OSS: single workspace at WORKERS_DIR.parent
    return WORKERS_DIR.parent.resolve()


def _git_author(auth: "AuthContext") -> tuple[str, str]:
    """Return (author_name, author_email) suitable for a git commit."""
    name = getattr(auth, "username", None) or getattr(auth, "user_id", None) or "WorkerOS"
    email = getattr(auth, "email", None) or f"{name}@workeros.local"
    return name, email
from run_service import (
    create_run,
    fail_interrupted_runs_on_startup,
    reap_abandoned_pending_approval_runs,
    re_enqueue_queued_runs_on_startup,
    get_worker_config_for_run,
    start_run,
    update_run_status,
    request_active_run_shutdown,
    start_drain_loop,
    start_run_reaper_loop,
    stop_drain_loop,
    stop_run_reaper_loop,
    queued_run_position,
    smoke_and_gate_generated_worker,
    InsufficientDiskSpaceError,
)
from run_service import register_sse_publisher, register_part_publisher

# #997: do NOT load a `.env` from the process cwd in production — a stale dev
# .env (or one an attacker drops in the cwd) would silently inject config/
# secrets. The explicit fixed-location loader below (WORKEROS_API_ENV_FILE /
# ~/.config/workeros/api.env) is the supported path; production sets env vars
# via the orchestrator. The cwd convenience load is gated to dev mode only.
if os.environ.get("WORKEROS_DEV") == "1":
    import sys as _sys
    load_dotenv()
    print("[workeros] WORKEROS_DEV=1: loaded .env from cwd (dev only)", file=_sys.stderr)
try:
    api_env_override = os.environ.get("WORKEROS_API_ENV_FILE") or os.environ.get("FLOOM_API_ENV_FILE")
    api_env_path = (
        Path(api_env_override).expanduser()
        if api_env_override
        else Path.home() / ".config" / "workeros" / "api.env"
    )
    if api_env_path.is_file():
        load_dotenv(api_env_path, override=False)
except OSError:
    pass
init_db()

PUBLIC_SHARE_TEXT_PREVIEW_LIMIT = 512 * 1024

# ---------------------------------------------------------------------------
# App & middleware
# ---------------------------------------------------------------------------


_sweep_task: Optional[asyncio.Task] = None
_SWEEP_INTERVAL_SECONDS = 3600  # Hourly


def _expire_stale_approvals() -> int:
    """#798: mark pending approvals past their expires_at as 'expired' and move
    the run off pending_approval, so a paused run never sits pending forever.
    Returns the number expired. Best-effort."""
    from datetime import datetime as _dt, timezone as _tz

    now_iso_str = _dt.now(_tz.utc).isoformat()
    expired = 0
    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT id, run_id, owner_id FROM approvals
                WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?
                """,
                (now_iso_str,),
            ).fetchall()
            for r in rows:
                conn.execute(
                    "UPDATE approvals SET status = 'expired', decided_at = ?, "
                    "reason = COALESCE(reason, 'Approval expired') WHERE id = ?",
                    (now_iso_str, r["id"]),
                )
                conn.execute(
                    "UPDATE runs SET status = ? WHERE id = ? AND status = ?",
                    (RunStatus.FAILED.value, r["run_id"], RunStatus.PENDING_APPROVAL.value),
                )
                expired += 1
        for r in rows:
            try:
                _sse_publish(r["run_id"], {
                    "type": "approval_decided", "run_id": r["run_id"], "decision": "expired",
                })
            except Exception:
                pass
    except Exception:
        logger.warning("approval expiry sweep failed (non-fatal)", exc_info=True)
    if expired:
        logger.info("Expired %d stale pending approvals", expired)
    return expired


async def _hourly_sweep_loop() -> None:
    """Run the connection health sweep + approval-expiry sweep every hour."""
    # Delay first run by 60s to let startup finish
    await asyncio.sleep(60)
    while True:
        try:
            await _run_connection_sweep()
        except Exception as exc:
            logger.warning("Connection sweep error: %s", exc)
        try:
            _expire_stale_approvals()  # #798
        except Exception as exc:
            logger.warning("Approval expiry sweep error: %s", exc)
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
    # #603: migrate any DB rows that still store exec.mode="hybrid" to "pure-script".
    # The "hybrid" mode was a deprecated alias; removing it from the Literal without
    # migrating existing rows would break workers whose manifests were saved before
    # the deprecation was enforced.
    try:
        with get_db() as _mig_conn:
            _rows_updated = _mig_conn.execute(
                "UPDATE workers SET manifest_json = REPLACE(manifest_json, '\"mode\": \"hybrid\"', '\"mode\": \"pure-script\"') "
                "WHERE manifest_json LIKE '%\"mode\": \"hybrid\"%'"
            ).rowcount
            if _rows_updated:
                logger.info("Migration #603: converted %d workers from exec.mode=hybrid to pure-script", _rows_updated)
    except Exception as _mig_exc:
        logger.warning("Migration #603 (hybrid→pure-script) failed (non-fatal): %s", _mig_exc)
    _warn_if_composio_webhook_unconfigured()
    # Ensure the git workspace repo is initialized (idempotent)
    try:
        _wgit = _git_workspace()
        _git_remote = os.environ.get("WORKEROS_GIT_REMOTE", "").strip()
        if _git_remote and not (_wgit / ".git").exists():
            # Fresh install with a remote configured: clone so full history arrives.
            logger.info("Git workspace: cloning from %s ...", _git_remote)
            _git_ops.clone_or_init(_wgit, _git_remote)
        else:
            _git_ops.ensure_repo(_wgit)
            if _git_remote:
                _git_ops.configure_remote(_wgit, _git_remote)
                try:
                    _git_ops.pull(_wgit)
                except Exception as _pull_exc:
                    logger.warning("Git pull from remote failed (non-fatal): %s", _pull_exc)
    except Exception as _git_exc:
        logger.warning("Git workspace init failed (non-fatal): %s", _git_exc)
    # Restore workspace config from git on startup (secrets + MCP tools).
    try:
        _bootstrap_uid = _bootstrap_user_id()
        _startup_repos = get_repositories()
        _n = 0
        _startup_cfg = _git_cfg_get(_bootstrap_uid)
        if _startup_cfg and _startup_cfg.get("github_pat") and _startup_cfg.get("repo_full_name"):
            _n = _load_secrets_from_enc(
                _bootstrap_uid, _startup_repos,
                _startup_cfg["github_pat"], _startup_cfg["repo_full_name"],
            )
        if _n:
            logger.info("Restored %d secrets from %s on startup", _n, _SECRETS_ENC_FILENAME)
        _seeded = _seed_bootstrap_secrets(_bootstrap_uid, _startup_repos)
        if _seeded:
            logger.info("Seeded %d bootstrap secrets from process env on startup", _seeded)
        _t = _load_workspace_tools_yml(_bootstrap_uid, _startup_repos)
        if _t:
            logger.info("Restored %d MCP tools from %s on startup", _t, _WORKSPACE_TOOLS_FILENAME)
    except Exception as _sec_exc:
        logger.warning("Startup workspace config restore failed (non-fatal): %s", _sec_exc)
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local":
        bootstrap_user_id = _bootstrap_user_id()
        _reload_workers_for_user(bootstrap_user_id)
        fail_interrupted_runs_on_startup(user_id=bootstrap_user_id)
        reap_abandoned_pending_approval_runs()
        re_enqueue_queued_runs_on_startup()
        start_drain_loop()
        start_run_reaper_loop()
        from scheduler import start_scheduler

        start_scheduler()
        # Launch hourly connection health sweep
        _sweep_task = asyncio.create_task(_hourly_sweep_loop())
    yield
    # Shutdown
    if deploy == "local":
        stop_run_reaper_loop(timeout=5.0)
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
    version="0.2.0",
    description="Open-source self-hosted runtime for AI workers",
    lifespan=lifespan,
)


@app.middleware("http")
async def versioned_api_alias_middleware(request: Request, call_next):
    """Accept conventional /api/v1 and /v1 prefixes without duplicating routes."""
    path = request.scope.get("path", "")
    for prefix in ("/api/v1", "/v1"):
        if path == prefix:
            request.scope["path"] = "/"
            request.scope["raw_path"] = b"/"
            break
        if path.startswith(f"{prefix}/"):
            stripped = path[len(prefix):] or "/"
            request.scope["path"] = stripped
            raw_path = request.scope.get("raw_path")
            if isinstance(raw_path, bytes):
                raw_prefix = prefix.encode("utf-8")
                if raw_path == raw_prefix:
                    request.scope["raw_path"] = b"/"
                elif raw_path.startswith(raw_prefix + b"/"):
                    request.scope["raw_path"] = raw_path[len(raw_prefix):]
            break
    return await call_next(request)


@app.exception_handler(InsufficientDiskSpaceError)
async def insufficient_disk_space_handler(_request: Request, exc: InsufficientDiskSpaceError):
    return JSONResponse(
        status_code=507,
        content={"detail": "Insufficient disk space for run creation", "error": str(exc)},
    )


DEFAULT_JSON_BODY_LIMIT_BYTES = 256 * 1024
FROM_BUNDLE_BODY_LIMIT_BYTES = 5 * 1024 * 1024
DEFAULT_CONTEXT_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024
# #1024: PUT /workers/{id}/files replaces ALL worker files atomically, so a
# worker that bundles a data file (candidate pools, datasets) must re-send it on
# every deploy. The 256 KB JSON default 413'd those before the body was read,
# surfacing as a broken pipe at the edge. Cap generously (matches context
# uploads) so data-bundled workers deploy.
WORKER_FILES_BODY_LIMIT_BYTES = 25 * 1024 * 1024
# A workspace template bundles every operator worker + knowledge pack, so it is
# larger than a single worker bundle. Cap it generously but bounded.
WORKSPACE_IMPORT_BODY_LIMIT_BYTES = 50 * 1024 * 1024
# #931: zip-bomb guards for /workspace/import — uncompressed expansion and
# entry count are bounded independently of the compressed body size.
_MAX_IMPORT_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
_MAX_IMPORT_ENTRIES = 5000
DEFAULT_CHAT_MESSAGE_MAX_CHARS = 20_000
DEFAULT_RATE_LIMIT = (60, 60.0)
BODYLESS_METHODS = {"GET", "HEAD", "OPTIONS"}
RATE_LIMIT_RULES = [
    # #601: auth/identity endpoints — strict limits to prevent brute-force and
    # credential-stuffing. 5 attempts per minute per IP is generous for humans
    # while blocking automated attacks. /auth/me is included because it is the
    # primary identity probe used by scanners checking for auth bypass (#594).
    (re.compile(r"^/auth/login$"), (5, 60.0)),
    (re.compile(r"^/auth/setup$"), (5, 60.0)),
    (re.compile(r"^/auth/me$"), (30, 60.0)),
    (re.compile(r"^/auth/tokens$"), (10, 60.0)),
    (re.compile(r"^/auth/magic-link$"), (5, 60.0)),
    (re.compile(r"^/auth/magic/.+$"), (10, 60.0)),
    (re.compile(r"^/cli-auth/devices$"), (5, 60.0)),
    (re.compile(r"^/workers/from-bundle$"), (10, 60.0)),
    (re.compile(r"^/workspace/import$"), (10, 60.0)),
    # #948: a full-workspace ZIP per request — keep bulk re-download slow.
    # 5 per hour is generous for humans and starves scripted exfiltration.
    (re.compile(r"^/workspace/export$"), (5, 3600.0)),
    (re.compile(r"^/workers$"), (20, 60.0)),
    (re.compile(r"^/connections/connect/[^/]+$"), (10, 60.0)),
    (re.compile(r"^/connections$"), (20, 60.0)),
    # #839: the MCP serve endpoint grants workspace-wide capability from a
    # single secret; the 60/min default was generous enough for secret
    # brute-forcing and runs.watch connection-pinning. 10/min matches the
    # other sensitive endpoints above.
    (re.compile(r"^/mcp-tools/serve$"), (10, 60.0)),
]


def _context_upload_limit_bytes() -> int:
    try:
        configured = int(os.environ.get("WORKEROS_CONTEXT_UPLOAD_MAX_BYTES", ""))
    except ValueError:
        configured = 0
    return configured if configured > 0 else DEFAULT_CONTEXT_UPLOAD_LIMIT_BYTES


def _context_upload_body_limit_bytes() -> int:
    # Multipart framing adds overhead beyond the uploaded file bytes.
    return _context_upload_limit_bytes() + (1024 * 1024)


def _format_limit_mb(size_bytes: int) -> str:
    mb = size_bytes / (1024 * 1024)
    return f"{mb:.0f} MB" if mb.is_integer() else f"{mb:.1f} MB"


def _context_upload_too_large_response() -> JSONResponse:
    return JSONResponse(
        status_code=413,
        content={
            "detail": (
                "Brain upload is too large. Upload files up to "
                f"{_format_limit_mb(_context_upload_limit_bytes())}."
            )
        },
    )

# #872 SECURITY: PROTECTED_STOCK_WORKER_IDS is ALSO consulted by Emily's
# _worker_can_view (chat_service) as a visibility bypass — `worker_id in
# PUBLIC_STOCK_WORKER_IDS or worker_id in PROTECTED_STOCK_WORKER_IDS` grants
# read/run to EVERY user regardless of owner/visibility. So curating
# PUBLIC_STOCK_WORKER_IDS alone is NOT enough: any tenant-private worker still
# listed here keeps leaking (a non-owner member can view AND run it). This set
# is curated to the same standard — genuine ship-with-product example/demo
# templates + engine/system workers only. Tenant-specific workers that read
# Federico's real Gmail / PostHog / GSC / Notion / CRM data are removed:
#   - gmail-summarize-latest  reads the operator's real Gmail inbox (is_example:false)
#   - openpaper-posthog-daily reads the real OpenPaper PostHog project + emails it
#   - seo-opportunity-digest  reads real openpaper.dev GSC data + writes to Notion
# Removing them here also correctly makes them owner-deletable and owner-scoped
# (they were never real stock). When unsure, EXCLUDE.
PROTECTED_STOCK_WORKER_IDS = frozenset(
    {
        # genuine ship-with-product example/demo templates (is_example: true,
        # generic pattern, no person-specific account data)
        "csv_enricher",
        "github-digest",
        "node-smoke-test",
        "openblog",
        "opendraft",
        "outbound-approval-demo",
        "research_brief",
        # engine/system workers that power Workeros itself (not tenant content)
        "slack-listener",
        "whatsapp-listener",
        "worker-author",
        "workspace-agent",
    }
)

_worker_create_locks_guard = threading.Lock()
_worker_create_locks: Dict[str, threading.Lock] = {}
_git_ops_lock = threading.Lock()


def _acquire_worker_create_lock(worker_id: str) -> threading.Lock:
    with _worker_create_locks_guard:
        lock = _worker_create_locks.get(worker_id)
        if lock is None:
            lock = threading.Lock()
            _worker_create_locks[worker_id] = lock
    lock.acquire()
    return lock


# #872 SECURITY: PUBLIC_STOCK_WORKER_IDS are returned to ANY member regardless
# of visibility=private (the ownership guards check stock IDs first, by design
# for genuine ship-with-product templates). This set previously included a
# tenant's REAL private workers (Gmail/DACH/kugelaudio/CV/GSC/LinkedIn/CRM/
# weekly_update), leaking their existence and letting members trigger runs.
# Curated down to genuinely-shareable example/demo templates only. Stock =
# ships-with-product examples, never a tenant's data. A removed worker now
# correctly 404s for a non-owner member.
#
# Inclusion criterion (deliberately stricter than `is_example: true`): a worker
# belongs here ONLY if it is BOTH (a) marked `is_example: true` in worker.yml
# AND (b) a generic pattern demo that touches no person-specific account data or
# real client/business logic. `is_example: true` alone is NOT sufficient — many
# of the tenant's REAL workers (cv_writeup, dach_compliance, gmail_intake_brief,
# kugelaudio-*, reverse_match_crm, weekly_update) carry that flag yet operate on
# Federico's actual Gmail/CRM/client data, so they are excluded. When unsure,
# EXCLUDE: a wrongly-excluded worker merely isn't a public template; a
# wrongly-included one leaks a tenant's private worker.
#
# gmail-summarize-latest is excluded: it reads the operator's real connected
# Gmail inbox ("the latest message from your Gmail inbox") and is itself marked
# `is_example: false` — i.e. not a ship-with-product example.
PUBLIC_STOCK_WORKER_IDS = frozenset(
    {
        "csv_enricher",          # is_example, enriches arbitrary CSV rows — no real data source
        "github-digest",         # is_example, digest of the runner's own GitHub — generic pattern
        "node-smoke-test",       # is_example, benign runtime smoke (used by E2E)
        "openblog",              # is_example, upstream OpenBlog engine demo
        "opendraft",             # is_example, upstream OpenDraft engine demo
        "outbound-approval-demo",# is_example, HITL two-run approval pattern demo
        "research_brief",        # is_example, research brief on any topic — generic
    }
)

# System/infra workers whose runs are never surfaced in the operator /runs list.
# These run autonomously in the background (trigger-based, high-volume, or
# internal generation agents) and flooding the runs list with them harms UX.
_SYSTEM_WORKER_IDS = frozenset({
    "workspace-agent",
    "worker-author",
    "slack-listener",
    "whatsapp-listener",
})

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

# One-line, operator-facing descriptions for system packs that ship without a
# README.md. Surfaced read-only on the /contexts page so operators understand
# what each engine pack does.
SYSTEM_CONTEXT_DESCRIPTIONS: dict[str, str] = {
    "worker-author-style": (
        "Engine style guide and schema the worker author follows when "
        "generating new workers from your prompts (read-only)."
    ),
}


def _system_context_description(name: str) -> Optional[str]:
    try:
        safe_name = validate_context_name(name)
    except ValueError:
        return None
    return SYSTEM_CONTEXT_DESCRIPTIONS.get(safe_name)

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

    # #921: explicit production origins only — no wildcard subdomain match.
    origins = ["https://workers.floom.dev", "https://workeros.floom.dev"]
    if os.environ.get("WORKEROS_DEV"):
        origins.extend(["http://localhost:3000", "http://localhost:3011"])
    return origins


def _cors_allowed_origin_regex() -> Optional[str]:
    configured = os.environ.get("ALLOWED_ORIGIN_REGEX", "")
    if configured.strip():
        return configured.strip()
    if os.environ.get("WORKEROS_DEV"):
        return r"^https://[a-z0-9-]+\.workeros-[a-z0-9-]+\.vercel\.app$"
    # #921: the old default `^https://([a-z0-9-]+\.)*floom\.dev$` allowed ANY
    # floom.dev subdomain to make credentialed requests — one compromised
    # subdomain meant workspace-wide CSRF. Production now relies on the
    # explicit allowlist above; set ALLOWED_ORIGIN_REGEX to opt back in.
    return None


# #921: with allow_credentials=True, enumerate methods and headers instead of
# reflecting whatever a cross-origin attacker asks for.
_CORS_ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
_CORS_ALLOWED_HEADERS = [
    "Authorization",
    "Content-Type",
    "Accept",
    "Cache-Control",
    "X-Requested-With",
    "X-Floom-Secret",
    "X-Floom-User",
    "X-Workeros-Workspace",
    "X-Workeros-Run-Token",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allowed_origins(),
    allow_origin_regex=_cors_allowed_origin_regex(),
    allow_credentials=True,
    allow_methods=_CORS_ALLOWED_METHODS,
    allow_headers=_CORS_ALLOWED_HEADERS,
)


def _active_context_scope() -> str | None:
    return context_scope_for_user(current_auth_user_id())


set_context_scope_resolver(_active_context_scope)


def _context_actor_user_id(user_id: str) -> str:
    return effective_context_user_id(user_id)


def _validate_startup_configuration() -> None:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy != "local":
        get_auth_provider()


def _warn_if_composio_webhook_unconfigured() -> None:
    """#908: without COMPOSIO_WEBHOOK_SIGNING_KEY the /composio-events receiver
    503s every delivery, so composio-triggered workers silently never fire.
    Surface that loudly at startup instead of letting it fail again."""
    if os.environ.get("COMPOSIO_WEBHOOK_SIGNING_KEY", "").strip():
        return
    count = 0
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM workers "
                "WHERE composio_trigger_id IS NOT NULL AND composio_trigger_id != ''"
            ).fetchone()
            count = int(row["cnt"] or 0) if row else 0
    except Exception:
        count = 0
    if count:
        logger.error(
            "COMPOSIO_WEBHOOK_SIGNING_KEY is not configured but %d worker(s) have "
            "enabled Composio event triggers — deliveries are rejected with 503 at "
            "/composio-events and those workers will NEVER fire. Set the key and "
            "register the webhook URL in the Composio dashboard (#908).",
            count,
        )
    elif os.environ.get("COMPOSIO_API_KEY", "").strip():
        logger.warning(
            "COMPOSIO_WEBHOOK_SIGNING_KEY is not configured; Composio event "
            "triggers cannot be enabled until it is set (#908)."
        )


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


class LocalWorkspaceCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


class LocalWorkspaceRenameRequest(BaseModel):
    # #791: name optional so region/timezone can be updated alone.
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    region: Optional[str] = None
    timezone: Optional[str] = None


class LocalWorkspaceOut(BaseModel):
    id: str
    name: str
    owner_user_id: str
    created_at: str
    region: Optional[str] = None  # #791
    timezone: Optional[str] = None  # #791


class LocalWorkspaceListResponse(BaseModel):
    workspaces: List[LocalWorkspaceOut]
    active_id: str


class CurrentUserResponse(BaseModel):
    user_id: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    workspace_id: Optional[str] = None
    scopes: List[str] = []
    role: str = "admin"
    username: Optional[str] = None


class WorkspaceAgentSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    brain_read: Optional[bool] = None
    brain_write: Optional[bool] = None
    connections_read: Optional[bool] = None
    connections_use: Optional[bool] = None
    connections_add: Optional[bool] = None


def _local_workspace_out(row: Dict[str, Any]) -> LocalWorkspaceOut:
    return LocalWorkspaceOut(
        id=str(row["id"]),
        name=str(row["name"]),
        owner_user_id=str(row["owner_user_id"]),
        created_at=str(row["created_at"]),
        region=(row.get("region") if isinstance(row, dict) else None) or None,  # #791
        timezone=(row.get("timezone") if isinstance(row, dict) else None) or None,  # #791
    )


def _active_local_workspace_id(auth: AuthContext) -> str:
    base_user_id = local_workspace_base_user_id(auth.user_id)
    if auth.user_id == base_user_id:
        return DEFAULT_WORKSPACE_ID
    marker = "__"
    return auth.user_id.split(marker, 1)[1]


def _require_local_workspace_mode() -> None:
    if _is_cloud_deploy():
        raise HTTPException(status_code=404, detail="not found")


@app.get("/me", response_model=CurrentUserResponse)
def get_current_user(auth: AuthContext = Depends(get_auth_context)) -> CurrentUserResponse:
    return CurrentUserResponse(
        user_id=auth.user_id,
        email=auth.email,
        display_name=auth.email or auth.username or auth.user_id,
        workspace_id=_active_local_workspace_id(auth) if not _is_cloud_deploy() else None,
        scopes=list(auth.scopes or ()),
        role=auth.role,
        username=auth.username,
    )


@app.get("/workspaces", response_model=LocalWorkspaceListResponse)
def list_workspaces(auth: AuthContext = Depends(get_auth_context)) -> LocalWorkspaceListResponse:
    """List local OSS workspaces for the single-user dashboard."""
    _require_local_workspace_mode()
    base_user_id = local_workspace_base_user_id(auth.user_id)
    rows = list_local_workspaces(base_user_id)
    return LocalWorkspaceListResponse(
        workspaces=[_local_workspace_out(row) for row in rows],
        active_id=_active_local_workspace_id(auth),
    )


@app.post("/workspaces", response_model=LocalWorkspaceOut)
def create_workspace(
    payload: LocalWorkspaceCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> LocalWorkspaceOut:
    """Create a local OSS workspace.

    Selection is client-side for OSS: the web app stores the active workspace id
    and sends it as x-workeros-workspace on every proxied request.
    """
    _require_local_workspace_mode()
    base_user_id = local_workspace_base_user_id(auth.user_id)
    return _local_workspace_out(create_local_workspace(base_user_id, payload.name))


@app.patch("/workspaces/{workspace_id}", response_model=LocalWorkspaceOut)
def rename_workspace(
    workspace_id: str,
    payload: LocalWorkspaceRenameRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> LocalWorkspaceOut:
    """#791: update a local OSS workspace's name/region/timezone (owner-scoped)."""
    _require_local_workspace_mode()
    if payload.name is None and payload.region is None and payload.timezone is None:
        raise HTTPException(status_code=422, detail="nothing to update")
    base_user_id = local_workspace_base_user_id(auth.user_id)
    try:
        updated = update_local_workspace(
            base_user_id, workspace_id,
            name=payload.name, region=payload.region, timezone=payload.timezone,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    return _local_workspace_out(updated)


@app.post("/workspaces/{workspace_id}/select", response_model=LocalWorkspaceOut)
def select_workspace(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> LocalWorkspaceOut:
    """Validate and echo a local OSS workspace selection."""
    _require_local_workspace_mode()
    base_user_id = local_workspace_base_user_id(auth.user_id)
    workspace = get_local_workspace(base_user_id, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    return _local_workspace_out(workspace)


@app.delete("/workspaces/{workspace_id}")
def delete_workspace(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, bool]:
    """#805: delete a local OSS workspace (Settings > Danger).

    Owner-scoped (404 for another owner's / unknown workspace). The default
    workspace cannot be deleted (409) — there must always be one. On this
    single-tenant engine workers/knowledge live in a shared on-disk pool, so
    deleting a workspace removes only the workspace row + its selection, not
    the shared assets.
    """
    _require_local_workspace_mode()
    if workspace_id == DEFAULT_WORKSPACE_ID:
        raise HTTPException(status_code=409, detail="The default workspace cannot be deleted")
    base_user_id = local_workspace_base_user_id(auth.user_id)
    if get_local_workspace(base_user_id, workspace_id) is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    delete_local_workspace(base_user_id, workspace_id)
    return {"deleted": True}


def _duplicate_workspace_name(name: str) -> str:
    """``"Acme"`` -> ``"Acme (copy)"`` (clamped to the 80-char name limit)."""
    base = (name or "").strip() or "Untitled"
    suffix = " (copy)"
    if len(base) + len(suffix) > 80:
        base = base[: 80 - len(suffix)].rstrip()
    return f"{base}{suffix}"


@app.post("/workspaces/{workspace_id}/duplicate", response_model=LocalWorkspaceOut)
def duplicate_workspace(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> LocalWorkspaceOut:
    """Duplicate a local OSS workspace into a new ``"<name> (copy)"`` sibling.

    Owner-scoped: the source workspace must belong to the caller's local base
    user, otherwise 404. On this single-tenant OSS instance, workers and
    knowledge packs live in a shared on-disk pool (not per-workspace storage),
    so duplication mints a new workspace row that surfaces the same worker pool.
    Use Export → Import (the template round-trip) to move workers between
    instances.
    """
    _require_local_workspace_mode()
    base_user_id = local_workspace_base_user_id(auth.user_id)
    source = get_local_workspace(base_user_id, workspace_id)
    if source is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    created = create_local_workspace(
        base_user_id, _duplicate_workspace_name(source.get("name") or "")
    )
    return _local_workspace_out(created)


# ---------------------------------------------------------------------------
# Workspace members (STEP 2 — Codex members design, build-order step 2).
#
# Engine-owned membership endpoints calling the step-1
# ``WorkspaceMemberRepository``. ONE model for BOTH products: the OSS engine is
# the single-owner degenerate case (one active owner = the local user), Cloud
# implements the same Protocol against Supabase. The role matrix lives in the
# repository layer (owner-only role/transfer; owner+admin invite/remove; admin
# cannot target owner/admin); these endpoints map repository PermissionError /
# ValueError to 403 / 400 and never trust the client for authority.
# ---------------------------------------------------------------------------

class WorkspaceMemberOut(BaseModel):
    workspace_id: str
    user_id: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    role: Literal["owner", "admin", "member"]
    status: Literal["active", "invited", "removed"] = "active"
    invited_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class WorkspaceMembersResponse(BaseModel):
    """Members list + the caller's own identity/role so the web UI gates the
    invite / change-role / remove / transfer affordances without re-deriving
    authority from member rows."""

    members: List[WorkspaceMemberOut]
    workspace_id: str
    my_user_id: str
    my_role: Optional[Literal["owner", "admin", "member"]] = None


class WorkspaceMemberInviteRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    # ``owner`` is rejected (use transfer ownership); default to the least
    # privileged role, matching Notion/Linear invite defaults.
    role: Literal["admin", "member"] = "member"


class WorkspaceMemberRoleUpdate(BaseModel):
    role: Literal["admin", "member"]


class WorkspaceTransferOwnerRequest(BaseModel):
    new_owner_id: str = Field(..., min_length=1)


def _member_out(row: Dict[str, Any]) -> WorkspaceMemberOut:
    return WorkspaceMemberOut(
        workspace_id=str(row.get("workspace_id") or ""),
        user_id=str(row.get("user_id") or ""),
        email=row.get("email"),
        display_name=row.get("display_name"),
        role=str(row.get("role") or "member"),  # type: ignore[arg-type]
        status=str(row.get("status") or "active"),  # type: ignore[arg-type]
        invited_by=row.get("invited_by"),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


def _require_members_repo(repos: Repositories) -> WorkspaceMemberRepository:
    members = getattr(repos, "members", None)
    if members is None:
        raise HTTPException(status_code=501, detail="Membership not available")
    return members


def _ensure_owner_membership(
    repos: Repositories, *, workspace_id: str, auth: AuthContext
) -> None:
    """Idempotently guarantee the caller has an active owner row in this workspace.

    OS degenerate case: the local user is the single owner. The step-1 migration
    backfills an owner row per local workspace keyed by ``owner_user_id`` (the
    base user) — but a freshly created (non-default) workspace, or a workspace
    with no workers, may not have a row keyed by the *scoped* request identity
    (``auth.user_id``). Without this, the Members page would render empty on the
    very instance that is supposed to always show "you = Owner". So we upsert the
    owner row keyed by the request identity, carrying the caller's email when the
    auth context has one. Cloud overrides membership via its own repo + RLS, so
    this no-ops there (cloud deploy short-circuits before calling it).
    """
    if _is_cloud_deploy():
        return
    try:
        existing = repos.members.get(workspace_id=workspace_id, user_id=auth.user_id)
    except Exception:
        return
    if existing is not None:
        # Backfill a missing email once the auth context carries one, so the row
        # the UI shows isn't a bare id. Never downgrade an existing value.
        if auth.email and not existing.get("email"):
            try:
                with get_db() as conn:
                    conn.execute(
                        "UPDATE workspace_members SET email = ?, updated_at = ? "
                        "WHERE workspace_id = ? AND user_id = ? AND (email IS NULL OR email = '')",
                        (auth.email, now_iso(), workspace_id, auth.user_id),
                    )
            except Exception:
                logger.debug("could not backfill owner email", exc_info=True)
        return
    # No row for this identity yet: insert the owner row. The partial unique
    # index forbids a second active owner, so guard with INSERT OR IGNORE and
    # only when no active owner exists for the workspace.
    try:
        with get_db() as conn:
            owner = conn.execute(
                "SELECT 1 FROM workspace_members "
                "WHERE workspace_id = ? AND role = 'owner' AND status = 'active' LIMIT 1",
                (workspace_id,),
            ).fetchone()
            if owner is not None:
                return
            now = now_iso()
            conn.execute(
                """
                INSERT OR IGNORE INTO workspace_members
                    (workspace_id, user_id, email, display_name, role,
                     status, invited_by, created_at, updated_at)
                VALUES (?, ?, ?, NULL, 'owner', 'active', NULL, ?, ?)
                """,
                (workspace_id, auth.user_id, auth.email, now, now),
            )
    except Exception:
        logger.debug("could not ensure owner membership", exc_info=True)


@app.get("/workspace/members", response_model=WorkspaceMembersResponse)
def list_workspace_members(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkspaceMembersResponse:
    """List the active members of the caller's current workspace + their role.

    OS single-owner: returns one row (you = Owner). The invite affordance is
    gated client-side on ``my_role`` (owner/admin), and the page renders
    identically to what Cloud will show with real members — one model, no fork.
    """
    members_repo = _require_members_repo(repos)
    workspace_id = _active_local_workspace_id(auth)
    _ensure_owner_membership(repos, workspace_id=workspace_id, auth=auth)
    rows = members_repo.list(workspace_id=workspace_id)
    me = members_repo.get(workspace_id=workspace_id, user_id=auth.user_id)
    return WorkspaceMembersResponse(
        members=[_member_out(r) for r in rows],
        workspace_id=workspace_id,
        my_user_id=auth.user_id,
        my_role=(me.get("role") if me else None),  # type: ignore[arg-type]
    )


@app.post("/workspace/members", response_model=WorkspaceMemberOut, status_code=201)
def invite_workspace_member(
    payload: WorkspaceMemberInviteRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkspaceMemberOut:
    """Invite a member by email (owner/admin only). The repository enforces the
    matrix and rejects a second owner; we map its errors to 403/400."""
    members_repo = _require_members_repo(repos)
    workspace_id = _active_local_workspace_id(auth)
    _ensure_owner_membership(repos, workspace_id=workspace_id, auth=auth)
    try:
        row = members_repo.invite(
            workspace_id=workspace_id,
            email=payload.email.strip(),
            role=payload.role,
            invited_by=auth.user_id,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _member_out(row)


@app.patch("/workspace/members/{user_id}", response_model=WorkspaceMemberOut)
def set_workspace_member_role(
    user_id: str,
    payload: WorkspaceMemberRoleUpdate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkspaceMemberOut:
    """Promote/demote a member between admin and member (owner only). Owner role
    is changed only via transfer-owner; the repository rejects it."""
    members_repo = _require_members_repo(repos)
    workspace_id = _active_local_workspace_id(auth)
    _ensure_owner_membership(repos, workspace_id=workspace_id, auth=auth)
    try:
        row = members_repo.set_role(
            workspace_id=workspace_id,
            actor_id=auth.user_id,
            user_id=user_id,
            role=payload.role,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if row is None:
        raise HTTPException(status_code=404, detail="Member not found")
    return _member_out(row)


@app.delete("/workspace/members/{user_id}", status_code=204)
def remove_workspace_member(
    user_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """Remove a member (owner/admin only; admins can't remove owner/admins; the
    owner can't be removed — transfer ownership first)."""
    members_repo = _require_members_repo(repos)
    workspace_id = _active_local_workspace_id(auth)
    _ensure_owner_membership(repos, workspace_id=workspace_id, auth=auth)
    try:
        removed = members_repo.remove(
            workspace_id=workspace_id,
            actor_id=auth.user_id,
            user_id=user_id,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not removed:
        raise HTTPException(status_code=404, detail="Member not found")
    return Response(status_code=204)


@app.post("/workspace/members/transfer-owner", response_model=WorkspaceMemberOut)
def transfer_workspace_owner(
    payload: WorkspaceTransferOwnerRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkspaceMemberOut:
    """Transfer ownership to another active member (current owner only). The
    current owner is demoted to admin; the partial unique index keeps exactly
    one active owner per workspace."""
    members_repo = _require_members_repo(repos)
    workspace_id = _active_local_workspace_id(auth)
    _ensure_owner_membership(repos, workspace_id=workspace_id, auth=auth)
    try:
        row = members_repo.transfer_owner(
            workspace_id=workspace_id,
            actor_id=auth.user_id,
            new_owner_id=payload.new_owner_id.strip(),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _member_out(row)


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
    if path == "/workspace/import":
        return WORKSPACE_IMPORT_BODY_LIMIT_BYTES
    # #1024: worker file deploys bundle datasets; exempt from the 256 KB JSON cap.
    if _WORKER_FILES_PATH_RE.match(path):
        return WORKER_FILES_BODY_LIMIT_BYTES
    if path.startswith("/uploads"):
        return None
    # X4: approval-scoped screenshot uploads stream a multipart image body; the
    # /uploads handler enforces its own size + quota caps, so exempt them from
    # the small JSON default here (authed owner + signed-link public reviewer).
    if path.endswith("/uploads") and (
        path.startswith("/approvals/") or path.startswith("/approvals/public/")
    ):
        return None
    if path.startswith("/contexts"):
        return None
    # #872 FINDING-3: the Slack/WhatsApp webhook handlers advertise (and enforce)
    # a 1 MB cap via channels.common._MAX_WEBHOOK_BODY_BYTES, but the global
    # 256 KB DEFAULT_JSON_BODY_LIMIT_BYTES below fired first — so the advertised
    # 1 MB was a lie and any 256 KB-1 MB Slack event was 413'd before the
    # route's own (signature-gated) size check ran. Exempt them here so each
    # route's explicit 1 MB cap + HMAC verification governs.
    if path in {
        "/slack/events",
        "/slack/commands",
        "/slack/interactivity",
        "/whatsapp/webhook",
    }:
        return None
    return DEFAULT_JSON_BODY_LIMIT_BYTES


def _is_context_upload_request(request: Request) -> bool:
    path = request.url.path
    return (
        request.method.upper() == "POST"
        and path.startswith("/contexts/")
        and path.endswith("/upload")
    )


_WST_ALLOWED_POST_RE = re.compile(r"^/workers/[^/]+/runs$")
# #1024: PUT /workers/{id}/files — atomic file replace, may carry bundled data.
_WORKER_FILES_PATH_RE = re.compile(r"^/workers/[^/]+/files$")
_WST_DENIED_PREFIXES = (
    "/secrets", "/connections", "/auth", "/workspace/tokens", "/workspace/secrets",
    "/workspace/settings", "/system", "/settings", "/contexts", "/chat",
)


@app.middleware("http")
async def workspace_token_scope_middleware(request: Request, call_next):
    """Workspace API tokens (wst_) are read+run only.

    Reads stay permission-scoped by the synthetic member actor (shared workers
    only); this gate removes every write surface except firing a run, and
    blocks credential/config surfaces outright — including reads — so a leaked
    token can never enumerate secrets, connections, or settings.
    """
    bearer = (request.headers.get("authorization") or "").strip()
    if bearer.lower().startswith("bearer wst_"):
        path = request.url.path
        if any(path == pfx or path.startswith(pfx + "/") for pfx in _WST_DENIED_PREFIXES):
            return JSONResponse(
                status_code=403,
                content={"detail": "workspace tokens cannot access this resource"},
            )
        if request.method.upper() not in {"GET", "HEAD"} and not (
            request.method.upper() == "POST" and _WST_ALLOWED_POST_RE.match(path)
        ):
            return JSONResponse(
                status_code=403,
                content={"detail": "workspace tokens are read-and-run only"},
            )
    return await call_next(request)


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

    if _is_context_upload_request(request):
        # Context uploads are multipart streams. Returning a 413 from middleware
        # before the body is consumed can make edge proxies surface a 502 while
        # the client continues sending the multipart body. Let the route's
        # bounded streaming reader enforce the same 25 MB file cap and return
        # the friendly JSON 413 from inside the request handler.
        return await call_next(request)

    max_bytes = _body_limit_for_request(request)
    if max_bytes is None:
        return await call_next(request)

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                return JSONResponse(
                    status_code=413,
                    content={
                        "detail": (
                            "Request body is too large. Reduce the payload size "
                            "and try again."
                        )
                    },
                )
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})

    body = await request.body()
    if len(body) > max_bytes:
        return JSONResponse(
            status_code=413,
            content={
                "detail": (
                    "Request body is too large. Reduce the payload size "
                    "and try again."
                )
            },
        )
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
      - /webhooks/*         — HMAC-authed by per-worker secret
      - /healthz            — liveness probe, no secret
      - /composio-events    — Composio webhook receiver
      - /connections/callback — OAuth browser redirect validates connection state
      - OPTIONS             — CORS preflight

    Run-scoped tokens (X-Workeros-Run-Token header):
      Sandbox workers receive a WORKEROS_RUN_TOKEN env var — a short-lived
      HMAC-signed token that permits ONLY /runs/{id}/composio-execute/* calls.
      Presenting a run token on ANY other endpoint returns 403, making it
      cryptographically impossible for sandboxed worker code to delete workers,
      modify other workers, or access the operator API.

    Worker-call bearer tokens (Authorization: Bearer wrt_...):
      Worker-to-worker chains use a separate token family. Those tokens can
      create a child run through POST /workers/{id}/runs and poll the child
      run they spawned through GET /runs/{run_id}, but nothing else.

    When FLOOM_SECRET is not set (localhost dev mode), all requests pass.
    """
    from fastapi.responses import JSONResponse as _JSONResponse  # noqa: PLC0415
    from run_token import validate_worker_call_token, verify_run_token  # noqa: PLC0415

    secret = os.environ.get("FLOOM_SECRET", "")
    if request.method == "OPTIONS":
        return await call_next(request)

    path = request.url.path
    authorization_header = request.headers.get("authorization", "")
    bearer_token_header = ""
    if authorization_header.startswith("Bearer "):
        bearer_token_header = authorization_header[7:].strip()
    if bearer_token_header.startswith("wrt_"):
        try:
            worker_call_payload = validate_worker_call_token(bearer_token_header)
        except ValueError as exc:
            return _JSONResponse(status_code=401, content={"detail": str(exc)})
        # #916: a run token is only as alive as its user — reject at the
        # perimeter when the owning account is disabled or deleted.
        try:
            from auth.multi_member import _require_active_token_user  # noqa: PLC0415

            _require_active_token_user(str(worker_call_payload.get("user_id") or ""))
        except HTTPException as exc:
            return _JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        worker_call_repos = None
        if request.method == "GET" and _RE_RUN_DETAIL.match(path):
            try:
                from db import get_repositories  # noqa: PLC0415

                worker_call_repos = get_repositories()
            except Exception:
                worker_call_repos = None
        if not _worker_call_token_allows_request(
            path=path,
            method=request.method,
            token_payload=worker_call_payload,
            repos=worker_call_repos,
        ):
            return _JSONResponse(
                status_code=403,
                content={"detail": "Worker-call tokens are only valid for child run creation and child-run polling"},
            )

    # Run-scoped token check — always evaluated, even in dev mode. A run token
    # is a narrow sandbox capability: it can only call its own Composio proxy
    # path. Worker-to-worker orchestration and destructive actions use the
    # authenticated operator/server paths, never this sandbox token.
    run_token_header = request.headers.get("x-workeros-run-token", "")
    if run_token_header:
        run_id_from_token = verify_run_token(run_token_header, secret=secret)
        if run_id_from_token is None:
            return _JSONResponse(
                status_code=401,
                content={"detail": "Invalid or expired run token"},
            )
        if not _RE_RUN_COMPOSIO_PROXY.match(path):
            return _JSONResponse(
                status_code=403,
                content={"detail": "Run tokens are only valid for Composio proxy calls"},
            )
        path_run_id = path.split("/", 3)[2] if path.startswith("/runs/") else ""
        if path_run_id != run_id_from_token:
            return _JSONResponse(
                status_code=403,
                content={"detail": "Run token does not match request run_id"},
            )
        return await call_next(request)

    if secret:
        if (
            path.startswith("/webhooks/")
            or path in {"/healthz", "/health"}
            or path == "/composio-events"
            or path == "/slack/events"
            or path == "/slack/commands"
            or path == "/slack/interactivity"
            or path == "/slack/oauth/callback"
            or path == "/whatsapp/webhook"
            or path == "/mcp"
            or path == "/api/mcp"
            or path == "/mcp/setup/langdock"
            or path == "/api/mcp/setup/langdock"
            or path == "/langdock/mcp"
            or path == "/workspace-agent/mcp"
            or path == "/api/langdock/mcp"
            or path == "/api/workspace-agent/mcp"
            or path == "/connections/callback"
            or path.startswith("/approvals/public/")
            or path.startswith("/workers/public/")
            or path.startswith("/runs/public/")  # #765: token-gated read-only run view
            or path.startswith("/workers/short-links/")
            or path.startswith("/s/")
            or path.startswith("/c/")
            or path.startswith("/workspace/template/")
            or path == "/cli-auth/devices"
            or path.startswith("/cli-auth/poll/")
            or _RE_RUN_COMPOSIO_PROXY.match(path)
            # Multi-member: login/setup paths always exempt so users can authenticate without secret
            or path in {"/auth/setup", "/auth/login", "/auth/logout", "/auth/me", "/auth/setup-required"}
            # Magic-link consume: unauthenticated by definition — user has no session yet
            or path.startswith("/auth/magic/")
        ):
            return await call_next(request)
        raw_secret = None
        bearer_token = None
        session_cookie = None
        for key, value in request.scope.get("headers", []):
            if key.lower() == b"x-floom-secret":
                raw_secret = value
            elif key.lower() == b"authorization":
                auth_value = value.decode("latin-1", errors="replace")
                if auth_value.startswith("Bearer "):
                    bearer_token = auth_value[7:].strip()
            elif key.lower() == b"cookie":
                # Parse backend session cookie from Cookie header (wos_session is the backend multi-member session)
                cookie_str = value.decode("latin-1", errors="replace")
                for part in cookie_str.split(";"):
                    part = part.strip()
                    if part.startswith("wos_session="):
                        session_cookie = part.split("=", 1)[1]
        # Multi-member auth: Bearer PAT or session cookie bypass x-floom-secret
        if bearer_token or session_cookie:
            return await call_next(request)
        if raw_secret is not None:
            raw_secret_text = raw_secret.decode("latin-1", errors="replace").strip()
            if raw_secret_text.startswith("wos_"):
                return await call_next(request)
        expected = secret.encode("latin-1")
        if raw_secret is None:
            return _JSONResponse(status_code=401, content={"detail": "Unauthorized"})
        if not hmac.compare_digest(raw_secret, expected):
            return _JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)

logger = logging.getLogger("floom.api")

# Regex for run-authenticated Composio proxy (no x-floom-secret required;
# auth is by X-Workeros-Run-Token, scoped to the run_id in the path).
import re as _re
_RE_RUN_COMPOSIO_PROXY = _re.compile(r"^/runs/[a-zA-Z0-9_-]+/composio-execute/[A-Z0-9_]+$")
_RE_WORKER_RUN_CREATE = _re.compile(r"^/workers/[^/]+/runs$")
_RE_RUN_DETAIL = _re.compile(r"^/runs/([a-zA-Z0-9_-]+)$")


def _worker_call_run_metadata(auth: AuthContext) -> tuple[str | None, str | None]:
    """Return the trigger metadata for a worker-call child run, if any."""
    if auth.auth_method != "run_token" or not auth.run_token_payload:
        return None, None
    parent_run_id = str(auth.run_token_payload.get("parent_run_id") or "").strip() or None
    if not parent_run_id:
        return None, None
    # #994: encode the child's call depth so the chain is trackable and the
    # next level enforces the cap (holder depth + 1).
    try:
        holder_depth = int(auth.run_token_payload.get("depth") or 0)
    except (TypeError, ValueError):
        holder_depth = 0
    return f"worker_call:depth={holder_depth + 1}", parent_run_id


def _worker_call_token_allows_request(
    *,
    path: str,
    method: str,
    token_payload: Dict[str, Any],
    repos: Any | None = None,
) -> bool:
    """Allow worker-call bearer tokens only on child creation and child polling."""
    if method == "POST" and _RE_WORKER_RUN_CREATE.match(path):
        # #994: a run whose token is already at the depth cap may not spawn
        # another child — bounds worker-to-worker recursion on the script path.
        from run_token import MAX_CALL_DEPTH

        try:
            depth = int(token_payload.get("depth") or 0)
        except (TypeError, ValueError):
            depth = 0
        return depth < MAX_CALL_DEPTH
    run_match = _RE_RUN_DETAIL.match(path)
    if method != "GET" or run_match is None or repos is None:
        return False
    run_row = repos.runs.get_any(run_id=run_match.group(1))
    if not run_row:
        return False
    return (
        str(run_row.get("trigger_source") or "").startswith("worker_call")  # #994: depth-suffixed
        and str(run_row.get("trigger_ref") or "") == str(token_payload.get("parent_run_id") or "")
    )

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
        return max(1, int(os.environ.get("WORKEROS_MAX_CONCURRENT_STREAMS", "50")))
    except (TypeError, ValueError):
        return 50


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
    # G5 P1: collapse the e2b stderr code-echo on the RAW ordered rows FIRST,
    # THEN per-row redact, so the rebuilt transcript is as calm as the live panel.
    _raw_parts: List[Dict[str, Any]] = []
    for r in rows:
        row = row_to_dict(r)
        _raw_parts.append(
            {
                "type": "log",
                "level": row.get("level"),
                "message": row.get("message") or "",
                "timestamp": row.get("timestamp"),
            }
        )
    for part in _collapse_stderr_code_echo_rows(_raw_parts):
        part["message"] = _redact_public_log_message(part["message"])
        parts.append(part)
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


# Minimum free disk before /health flips to degraded. A full disk silently
# corrupts SQLite writes and 507s worker-create while /health stayed "ok" at
# 0 bytes free (2026-06-02 P1). Override with HEALTH_MIN_FREE_DISK_GB.
_HEALTH_MIN_FREE_DISK_GB = float(os.environ.get("HEALTH_MIN_FREE_DISK_GB", "5") or "5")


def _health_check_disk() -> Dict[str, Any]:
    """Warn before the disk fills. Checks the filesystem holding the SQLite DB."""
    db_path = str(DB_PATH)
    target = db_path if os.path.exists(db_path) else (os.path.dirname(db_path) or "/")
    usage = shutil.disk_usage(target if os.path.exists(target) else "/")
    free_gb = usage.free / (1024**3)
    ok = free_gb >= _HEALTH_MIN_FREE_DISK_GB
    result: Dict[str, Any] = {
        "ok": ok,
        "free_gb": round(free_gb, 2),
        "min_free_gb": _HEALTH_MIN_FREE_DISK_GB,
    }
    if not ok:
        result["error"] = f"low disk: {free_gb:.2f}GB free < {_HEALTH_MIN_FREE_DISK_GB}GB"
    return result


def _health_check_e2b() -> Dict[str, Any]:
    if not os.environ.get("E2B_API_KEY"):
        return {"ok": False, "error": "E2B_API_KEY missing"}
    import concurrent.futures

    from e2b import Sandbox

    def _list_sandboxes() -> None:
        Sandbox.list(limit=1).next_items()

    executor = concurrent.futures.ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="workeros-e2b-health",
    )
    try:
        future = executor.submit(_list_sandboxes)
        future.result(timeout=3)
    except concurrent.futures.TimeoutError:
        return {"ok": False, "error": "E2B health check timed out after 3s"}
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    return {"ok": True}


def _health_check_openai() -> Dict[str, Any]:
    key = _platform_openai_api_key()
    if not key:
        return {"ok": False, "error": "PLATFORM_OPENAI_API_KEY missing"}
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


def _health_check_scheduler() -> Dict[str, Any]:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy != "local":
        return {"ok": True, "enabled": False, "deploy": deploy}
    try:
        from scheduler import scheduler_status
        return scheduler_status()
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:300]}


def _run_health_checks() -> Dict[str, Any]:
    now = time.monotonic()
    cached = _HEALTH_CACHE.get("payload")
    if cached is not None and now - float(_HEALTH_CACHE.get("checked_at") or 0.0) < _HEALTH_CACHE_TTL_SECONDS:
        return cached
    checks: Dict[str, Any] = {}
    for name, fn in {
        "db": _health_check_db,
        "disk": _health_check_disk,
        "e2b": _health_check_e2b,
        "openai": _health_check_openai,
        "composio": _health_check_composio,
        "scheduler": _health_check_scheduler,
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
    """Readiness probe — public, minimal.

    #853 RCA: this endpoint returned the full dependency-check payload (disk
    free space, E2B/OpenAI/Composio status, scheduler thread name) without
    auth — infrastructure reconnaissance for free. Probes only need the
    aggregate status; the detailed checks moved to GET /health/details
    (admin-only).
    """
    payload = _run_health_checks()
    return {"status": payload["status"], "checked_at": payload["checked_at"]}


@app.get("/health/details")
def health_details(auth: AuthContext = Depends(get_auth_context)):
    """Full dependency checks — admin only (#853)."""
    _require_admin(auth)
    return _run_health_checks()


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.exception_handler(ValueError)
async def value_error_handler(_request, exc: ValueError):
    # #920: ValueErrors bubble up from arbitrary internal code and can carry
    # filesystem paths, config values, or provider internals. Log the detail
    # server-side; clients get a generic message. Field-level validation
    # errors reach clients via the Pydantic handler, not this one.
    logger.warning("Validation error: %s", exc, exc_info=exc)
    return JSONResponse(status_code=400, content={"detail": "Invalid request"})


def _redacted_validation_errors(
    errors: List[Dict[str, Any]],
    *,
    expose_locations: bool = True,
) -> List[Dict[str, str]]:
    sanitized: List[Dict[str, str]] = []
    for error in errors[:10]:
        raw_loc = error.get("loc") or ()
        if isinstance(raw_loc, (list, tuple)):
            loc_str = ".".join(str(part) for part in raw_loc) if raw_loc else "request"
        else:
            loc_str = str(raw_loc) or "request"
        if not expose_locations:
            loc_str = "request"
        sanitized.append(
            {
                "loc": loc_str,
                "msg": str(error.get("msg") or "invalid value"),
                "type": str(error.get("type") or "value_error"),
            }
        )
    return sanitized


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(_request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "detail": "validation failed",
            "errors": _redacted_validation_errors(exc.errors(), expose_locations=False),
        },
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


def _canonical_worker_id(value: str) -> str:
    text = (value or "").strip()
    if text in PROTECTED_STOCK_WORKER_IDS:
        return text
    return _slugify_worker_id(text)


def _require_worker_write_workspace_context(request: Request) -> None:
    require_explicit = os.environ.get("WORKEROS_REQUIRE_WORKSPACE_HEADER_FOR_WRITES") == "1"
    # ASGI-internal requests (from _api_call / MCP dispatcher) have host "asgi".
    # They're already authenticated — skip workspace check.
    if (request.headers.get("host") or "").lower() == "asgi":
        return
    if _is_cloud_deploy():
        raw_workspace = (
            request.headers.get("x-workeros-workspace")
            or request.query_params.get("workspace_id")
            or ""
        ).strip()
        if not raw_workspace:
            raise HTTPException(
                status_code=400,
                detail="x-workeros-workspace header is required for worker writes.",
            )
        return
    if not require_explicit:
        return
    if requested_local_workspace_id(request) is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "A valid x-workeros-workspace header or workspace_id query parameter "
                "is required for worker writes."
            ),
        )


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
    # #1022: surface the run's stored input (the mandate/request) so the run list
    # is a queryable log. input_json is already SELECTed by the list queries, so
    # this adds no extra round trips.
    run_input: Dict[str, Any] = {}
    _raw_input_json = d.get("input_json")
    if _raw_input_json:
        try:
            _parsed_input = (
                json.loads(_raw_input_json)
                if isinstance(_raw_input_json, str)
                else _raw_input_json
            )
            if isinstance(_parsed_input, dict):
                run_input = _parsed_input
        except Exception:
            run_input = {}
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
        input=run_input,
        inputs=run_input,
    )


def _run_output_preview_from_json(raw_output_json: Any, *, limit: int = 280) -> Optional[str]:
    if raw_output_json is None:
        return None
    try:
        parsed = json.loads(raw_output_json) if isinstance(raw_output_json, str) else raw_output_json
    except Exception:
        parsed = raw_output_json

    value: Any = parsed
    if isinstance(parsed, dict):
        if not parsed:
            return None
        for key in ("result", "summary", "output", "text", "answer", "body"):
            candidate = parsed.get(key)
            if candidate not in (None, ""):
                value = candidate
                break
    elif isinstance(parsed, list) and not parsed:
        return None

    if value in (None, ""):
        return None
    if isinstance(value, str):
        text = value
    elif isinstance(value, (int, float, bool)):
        text = str(value)
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        except Exception:
            text = str(value)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] if text else None


def _worker_detail_artifact_previews(
    *,
    user_id: str,
    run_id: str,
    repos: Repositories,
) -> List[Dict[str, Any]]:
    try:
        rows = repos.runs.list_artifacts(user_id=user_id, run_id=run_id)
    except Exception:
        logger.debug("artifact preview fetch failed for run %s", run_id, exc_info=True)
        return []
    previews: List[Dict[str, Any]] = []
    for row in rows:
        if _is_sensitive_artifact_row(row):
            continue
        data = row_to_dict(row)
        name = str(data.get("name") or Path(str(data.get("path") or "")).name or "artifact")
        previews.append({"name": name, "size": data.get("size_bytes")})
    return previews


def _make_worker_detail_last_run(
    summary: Optional[RunSummary],
    *,
    user_id: str,
    repos: Repositories,
) -> Optional[DetailLastRun]:
    if summary is None:
        return None
    output_preview: Optional[str] = None
    try:
        run_row = repos.runs.get(user_id=user_id, run_id=summary.id)
        if run_row:
            output_preview = _run_output_preview_from_json(run_row.get("output_json"))
    except Exception:
        logger.debug("last-run preview fetch failed for run %s", summary.id, exc_info=True)

    return DetailLastRun(
        id=summary.id,
        worker_id=summary.worker_id,
        worker_name=summary.worker_name,
        status=summary.status,
        trigger_source=summary.trigger_source,
        created_at=summary.created_at,
        started_at=summary.started_at,
        completed_at=summary.completed_at,
        finished_at=summary.completed_at,
        duration_ms=summary.duration_ms,
        error=summary.error,
        error_code=summary.error_code,
        output_preview=output_preview,
        artifacts=_worker_detail_artifact_previews(user_id=user_id, run_id=summary.id, repos=repos),
    )


def _resolve_worker_status(
    worker: Dict[str, Any],
    *,
    config: Optional["WorkerConfig"],
    available_secret_names: Iterable[str],
    last_run_status: Optional[RunStatus],
    has_run: bool,
) -> WorkerStatus:
    """Single source of truth for an operator-facing worker status.

    Used by BOTH the LIST path (``list_workers``) and the DETAIL path
    (``_build_worker_detail``) so the two surfaces can never disagree for the
    same worker. The full honesty downgrade ladder, in order:

    1. MISSING_SECRET — a required secret is not configured.
    2. NEEDS_ATTENTION — the most recent run FAILED.
    3. NEEDS_ATTENTION — the worker is durably disabled (``enabled is False``,
       e.g. smoke-gated on creation). A disabled worker is broken, not healthy.
    4. READY — the worker has never run, so "healthy" (which implies a
       verified-working worker) has not been EARNED. READY renders identically
       to HEALTHY in the quiet UI; this only keeps the API claim honest.

    Archived workers are intentionally inactive and keep their stored status
    (they surface via the archived badge, not needs_attention).
    Already-broken raw states (e.g. "error") are preserved as-is — we only
    ever downgrade FROM healthy, never fabricate health.
    """
    raw = worker.get("status") or WorkerStatus.HEALTHY.value
    try:
        status = WorkerStatus(raw)
    except ValueError:
        status = WorkerStatus.ERROR
    is_archived = bool(worker.get("archived", False))
    # `enabled` defaults to True: stock/filesystem workers have no recipe row
    # and are not durably disable-able, so absence means "enabled".
    enabled = bool(worker.get("enabled", True))
    secret_set = set(available_secret_names)

    if config and config.secrets:
        missing = [s for s in config.secrets if s not in secret_set]
        if missing:
            status = WorkerStatus.MISSING_SECRET

    if (
        not is_archived
        and status == WorkerStatus.HEALTHY
        and last_run_status == RunStatus.FAILED
    ):
        status = WorkerStatus.NEEDS_ATTENTION

    if (
        not is_archived
        and status == WorkerStatus.HEALTHY
        and not enabled
    ):
        status = WorkerStatus.NEEDS_ATTENTION

    if (
        status == WorkerStatus.HEALTHY
        and not has_run
        and not is_archived
        and enabled
    ):
        status = WorkerStatus.READY

    return status


def _platform_openai_api_key() -> Optional[str]:
    """The platform's OWN OpenAI key — powers Emily, prompt-to-worker drafting,
    and codegen. Env-managed and reserved. PLATFORM_OPENAI_API_KEY is canonical;
    OPENAI_API_KEY is the back-compat fallback so existing single-key deploys keep
    working. This is NOT a worker key: workers bring their own OPENAI_API_KEY via
    the secrets DB, and the platform key must never reach a worker sandbox."""
    return os.environ.get("PLATFORM_OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY") or None


def _available_secret_names_for_user(user_id: str, repos: Repositories) -> set[str]:
    # Owner/user-managed secrets from the DB. OPENAI_API_KEY is a normal user
    # secret added via Settings -> Secrets, so it shows up here once added.
    # Platform-infra keys (PLATFORM_OPENAI_API_KEY etc.) are deliberately NOT
    # included: they power Emily/codegen and must never gate or feed an untrusted
    # worker sandbox. Keeping this DB-only makes worker-secret behaviour identical
    # in OSS and cloud — each owner brings their own worker key. See ARCHITECTURE.md.
    return set(repos.secrets.list_names(user_id=user_id))


def _available_connection_slugs_for_user(user_id: str, repos: Repositories) -> set[str]:
    """Return lower-cased app_name slugs for all active connections owned by user_id."""
    _live = {"active", "valid", "connected"}
    try:
        rows = repos.connections.list(user_id=user_id)
        return {
            row_to_dict(r).get("app_name", "").lower()
            for r in rows
            if str((row_to_dict(r).get("status") or "")).lower() in _live
        }
    except Exception:
        return set()


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


# ---------------------------------------------------------------------------
# Monitoring: GET /workers/{id}/stats
# ---------------------------------------------------------------------------

@app.get("/workers/{worker_id}/stats", response_model=WorkerStats)
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

@app.get("/stats", response_model=WorkspaceStats)
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

@app.get("/workers/{worker_id}/logs", response_model=List[Dict[str, Any]])
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

@app.post("/workers/{worker_id}/alerts", response_model=WorkerAlert, status_code=201)
def create_worker_alert(
    worker_id: str,
    body: WorkerAlertCreate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerAlert:
    """Register a webhook endpoint to be called when this worker's runs terminate."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    if not body.url and not body.email_to:
        raise HTTPException(
            status_code=400,
            detail="At least one of url (webhook) or email_to (email recipients) is required.",
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


@app.get("/workers/{worker_id}/alerts", response_model=List[WorkerAlert])
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


@app.delete("/workers/{worker_id}/alerts/{alert_id}", status_code=204)
def delete_worker_alert(
    worker_id: str,
    alert_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> None:
    """Remove a registered webhook alert."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    deleted = repos.alerts.delete(alert_id=alert_id, worker_id=worker_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Alert not found")


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


@app.post("/workers/{worker_id}/feedback", response_model=WorkerFeedback, status_code=201)
def create_worker_feedback(
    worker_id: str,
    body: WorkerFeedbackCreate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerFeedback:
    """Leave feedback on a worker. Anyone who can SEE the worker may comment (SPEC §12)."""
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


@app.get("/workers/{worker_id}/feedback", response_model=List[WorkerFeedback])
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


@app.delete("/workers/{worker_id}/feedback/{feedback_id}", status_code=204)
def delete_worker_feedback(
    worker_id: str,
    feedback_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> None:
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
    return None


# ---------------------------------------------------------------------------
# Versioning: GET /workers/{id}/versions, POST /workers/{id}/rollback/{vid}
#             GET /contexts/{name}/versions, POST /contexts/{name}/rollback/{vid}
#             GET /workspace/versions, POST /workspace/rollback/{vid}
# ---------------------------------------------------------------------------

_WORKSPACE_INSTRUCTIONS_ASSET_TYPE = "workspace_instructions"
_WORKSPACE_BASE_PERSONA_ASSET_TYPE = "workspace_base_persona"


def _workspace_instructions_asset_id(request: Request | None = None) -> str:
    """Scope version history per cloud workspace when x-workeros-workspace is set."""
    if request is not None:
        workspace_id = (request.headers.get("x-workeros-workspace") or "").strip()
        if workspace_id and workspace_id != "local-default":
            return workspace_id
    return "default"


def _workspace_base_persona_asset_id(request: Request | None = None) -> str:
    """Scope base-persona version history per cloud workspace."""
    return _workspace_instructions_asset_id(request)


def _workers_git_prefix() -> str:
    """Relative path of the workers dir within the workspace git root.

    OSS: git root is WORKERS_DIR.parent, so workers are at 'workers/'.
    Cloud: git root IS WORKERS_DIR/workspace_id, so workers sit at root — prefix is ''.
    """
    if _git_ops.get_active_workspace_id():
        return ""  # Cloud: worker_id/ is directly under the git root
    try:
        return WORKERS_DIR.relative_to(_git_workspace()).as_posix()
    except ValueError:
        return "workers"


def _contexts_git_prefix() -> str:
    """Relative path of the contexts dir within the workspace git root.

    OSS: git root is WORKERS_DIR.parent, contexts at 'contexts/'.
    Cloud: contexts live under CONTEXTS_DIR/workspace_id which may be outside the
    workers-scoped git root. If so, fall back to 'contexts' and note that contexts
    versioning in cloud requires a unified workspace dir (v2 cloud work).
    """
    if _git_ops.get_active_workspace_id():
        # In cloud, CONTEXTS_DIR may be a separate FS root from WORKERS_DIR.
        # Try to compute relative path; if outside git root, use 'contexts' as
        # a best-effort path (commits will no-op if the path doesn't exist).
        try:
            return CONTEXTS_DIR.relative_to(_git_workspace()).as_posix()
        except ValueError:
            return "contexts"
    try:
        return CONTEXTS_DIR.relative_to(_git_workspace()).as_posix()
    except ValueError:
        return "contexts"


def _git_join(*parts: str) -> str:
    """Join path parts, skipping empty segments (handles empty prefix in cloud mode)."""
    return "/".join(p for p in parts if p)


def _context_git_path(name: str, rel_path: Optional[str] = None) -> str:
    try:
        base = context_dir(name).relative_to(_git_workspace()).as_posix()
        return _git_join(base, rel_path or "")
    except Exception:
        return _git_join(_contexts_git_prefix(), name, rel_path or "")


def _ensure_git_workspace_ready(workspace: Path) -> None:
    """Initialize the git workspace before path-level commit helpers run."""
    remote = os.environ.get("WORKEROS_GIT_REMOTE", "").strip()
    if remote and not (workspace / ".git").exists():
        _git_ops.clone_or_init(workspace, remote)
    else:
        _git_ops.ensure_repo(workspace)
        if remote:
            _git_ops.configure_remote(workspace, remote)


def _git_commit_worker(
    worker_id: str,
    *,
    message: str,
    author_name: str = "WorkerOS",
    author_email: str = "workeros@local",
) -> None:
    try:
        workspace = _git_workspace()
        with _git_ops_lock:
            _ensure_git_workspace_ready(workspace)
            rel = _git_join(_workers_git_prefix(), worker_id)
            _git_ops.commit_paths(workspace, [rel], message, author_name, author_email)
            _git_ops.push_background(workspace)
    except Exception as exc:
        logger.warning("git commit failed for worker %s: %s", worker_id, exc)


def _git_commit_context(
    name: str,
    rel_path: Optional[str] = None,
    *,
    message: str,
    author_name: str = "WorkerOS",
    author_email: str = "workeros@local",
) -> None:
    if is_context_sensitive(name):
        return  # sensitive contexts never enter git
    try:
        workspace = _git_workspace()
        with _git_ops_lock:
            _ensure_git_workspace_ready(workspace)
            rel = _context_git_path(name, rel_path)
            _git_ops.commit_paths(workspace, [rel], message, author_name, author_email)
            _git_ops.push_background(workspace)
    except Exception as exc:
        logger.warning("git commit failed for context %s: %s", name, exc)


def _git_commit_workspace_md(
    *,
    message: str,
    author_name: str = "WorkerOS",
    author_email: str = "workeros@local",
) -> None:
    try:
        from chat_service import WORKSPACE_MD_PATH
        workspace = _git_workspace()
        with _git_ops_lock:
            _ensure_git_workspace_ready(workspace)
            try:
                rel = WORKSPACE_MD_PATH.relative_to(workspace).as_posix()
            except ValueError:
                rel = "workspace.md"
            _git_ops.commit_paths(workspace, [rel], message, author_name, author_email)
            _git_ops.push_background(workspace)
    except Exception as exc:
        logger.warning("git commit failed for workspace.md: %s", exc)


def _git_commit_workspace_base_md(
    *,
    message: str,
    author_name: str = "WorkerOS",
    author_email: str = "workeros@local",
) -> None:
    try:
        from chat_service import WORKSPACE_BASE_PERSONA_PATH
        workspace = _git_workspace()
        with _git_ops_lock:
            _ensure_git_workspace_ready(workspace)
            try:
                rel = WORKSPACE_BASE_PERSONA_PATH.relative_to(workspace).as_posix()
            except ValueError:
                rel = "workspace.base.md"
            _git_ops.commit_paths(workspace, [rel], message, author_name, author_email)
            _git_ops.push_background(workspace)
    except Exception as exc:
        logger.warning("git commit failed for workspace.base.md: %s", exc)

class VersionSummary(BaseModel):
    id: str           # 7-char git SHA
    sha: str          # same 7-char git SHA
    message: str      # commit message
    author: str       # git author name
    timestamp: str    # ISO 8601 commit date
    asset_type: str   # kept for API compat
    asset_id: str     # kept for API compat
    change_source: Optional[str] = None


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
    # Engine/system knowledge packs (e.g. worker-author-style) are surfaced
    # read-only so operators can SEE what shapes worker generation, but cannot
    # edit or delete them. Operator-created packs have system=False.
    system: bool = False
    read_only: bool = False
    category: Optional[str] = None  # #780: content-category tag
    # Sensitive packs are never committed to git or pushed to GitHub.
    # Sensitive is the DEFAULT — set sensitive=False to opt in to git tracking.
    sensitive: bool = True
    # Members STEP 4: ownership + per-asset visibility + computed permissions.
    # Mirrors the worker surface so the same Share control renders on brain packs.
    owner_id: Optional[str] = None
    visibility: str = "private"
    permissions: AssetPermissions = Field(default_factory=AssetPermissions)


class ContextVisibilityUpdate(BaseModel):
    """Set a brain pack's visibility. ``specific_people`` reserved (UI hides it)."""
    visibility: Literal["private", "workspace", "specific_people"]


class AssistantVisibilityUpdate(BaseModel):
    """Set the workspace assistant's visibility. ``specific_people`` reserved."""
    visibility: Literal["private", "workspace", "specific_people"]


class SecretWarning(BaseModel):
    """A masked secret-detection finding. NEVER carries the raw value."""

    pattern: str
    line: int
    masked: str


class ContextFileItem(BaseModel):
    path: str
    size: int
    mime_type: str
    updated_at: str
    is_binary: bool
    description: Optional[str] = None
    display_type: str = "File"
    tags: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    # Set when the file's content matched a high-confidence secret pattern.
    # The UI badges these so operators can move the credential to Secrets.
    has_secret_warning: bool = False
    # Populated only on the write/upload response (and the audit scan), so the
    # operator sees WHAT was detected (masked) without re-scanning. Never
    # persisted to disk, never contains the raw value.
    secret_warnings: List[SecretWarning] = Field(default_factory=list)
    # Set on a restore response when the restored version was a "deleted"
    # snapshot, so the History UI knows the file was removed (not written).
    deleted: bool = False


class ContextDetail(ContextSummary):
    files: List[ContextFileItem] = Field(default_factory=list)
    used_by: List[ContextWorkerRef] = Field(default_factory=list)


class ContextCreateRequest(BaseModel):
    writeable: bool = False
    # Sensitive (the default) excludes the context from git versioning — it may
    # hold credentials. Set false to opt the context into git history (versions,
    # rollback). See contexts.is_context_sensitive.
    sensitive: bool = True
    category: Optional[str] = None  # #780: content-category tag


class ContextCategoryRequest(BaseModel):
    category: Optional[str] = None  # #780; empty/null clears it


class ContextTextWriteRequest(BaseModel):
    content: str
    tags: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None


class CandidateFeedbackCreateRequest(BaseModel):
    run_id: str = Field(min_length=1, max_length=200)
    candidate_id: str = Field(min_length=1, max_length=200)
    rank: int
    feedback_text: str = Field(min_length=1, max_length=10000)
    outcome: Literal["good", "bad", "miss"]
    scope: Literal["global", "client"] = "global"
    reporter: Optional[str] = Field(default=None, max_length=200)


class CandidateFeedbackRecord(BaseModel):
    uuid: str
    run_id: str
    candidate_id: str
    rank: int
    feedback_text: str
    outcome: Literal["good", "bad", "miss"]
    scope: Literal["global", "client"]
    reporter: str
    ts: str
    path: str


class ContextFileMoveRequest(BaseModel):
    new_path: str  # #770: destination path within the same context


class ContextDeleteResponse(BaseModel):
    status: str
    referenced_by: List[str] = Field(default_factory=list)


class ContextUploadResponse(BaseModel):
    files: List[ContextFileItem]
    total_size_bytes: int


class ContextSecretScanFile(BaseModel):
    path: str
    secret_warnings: List[SecretWarning] = Field(default_factory=list)


class ContextSecretScanResponse(BaseModel):
    name: str
    scanned_files: int
    flagged_files: List[ContextSecretScanFile] = Field(default_factory=list)


@app.get("/workers/{worker_id}/versions", response_model=List[VersionSummary])
def list_worker_versions(
    worker_id: str,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[VersionSummary]:
    """List git commit history for a worker (newest first)."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    prefix = _workers_git_prefix()
    workspace = _git_workspace()
    rows = _git_ops.get_log(
        workspace,
        rel_path=f"{prefix}/{worker_id}",
        limit=min(limit, 100),
        asset_type="worker",
        asset_id=worker_id,
    )
    # #979: a GET must be side-effect free. The old path committed a baseline
    # when history was empty, so a read (incl. a browser prefetch or crawler)
    # mutated server-side git state and could snapshot a wrongly-visible
    # private worker. Baseline creation now happens on worker
    # create/update/import; an empty history just returns [].
    return [VersionSummary(**r) for r in rows]


@app.get("/workers/{worker_id}/versions/{sha}")
def get_worker_version(
    worker_id: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return the file tree for a worker at a specific git commit."""
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    workspace = _git_workspace()
    prefix = _workers_git_prefix()
    file_paths = _git_ops.list_files_at_sha(workspace, sha, f"{prefix}/{worker_id}")
    if not file_paths:
        raise HTTPException(status_code=404, detail="Version not found or worker had no files at this commit")
    files = []
    for fp in file_paths:
        content = _git_ops.get_file_at_sha(workspace, sha, fp)
        if content is not None:
            rel = fp[len(f"{prefix}/{worker_id}/"):]
            files.append({"path": rel, "content": content})
    return {"files": files}


def _require_sha_in_asset_history(workspace: Path, sha: str, rel_path: str) -> None:
    """#928: rollback/restore SHAs must come from the target asset's own git
    history. The workspace repo is shared across users and assets, so an
    arbitrary commit id would let a caller materialize file states from other
    users' workers or brain packs into an asset they control."""
    if not _git_ops.sha_in_path_history(workspace, sha, rel_path):
        raise HTTPException(
            status_code=404,
            detail=f"Commit {sha!r} not found in this asset's history",
        )


@app.post("/workers/{worker_id}/rollback/{sha}", response_model=WorkerDetail)
def rollback_worker(
    worker_id: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Restore a worker to the state at a given git commit SHA."""
    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    workspace = _git_workspace()
    prefix = _workers_git_prefix()
    worker_git_path = f"{prefix}/{worker_id}"

    _require_sha_in_asset_history(workspace, sha, worker_git_path)
    try:
        _git_ops.checkout_path(workspace, sha, worker_git_path)
    except _git_ops.GitOpsError as exc:
        raise HTTPException(status_code=404, detail=f"Commit {sha!r} not found: {exc}") from exc

    author_name, author_email = _git_author(auth)
    _git_commit_worker(
        worker_id,
        message=f"rollback: restore {worker_id} to {sha}",
        author_name=author_name,
        author_email=author_email,
    )

    invalidate_worker_cache()
    workers = discover_workers()
    this_worker_list = [w for w in workers if w["id"] == worker_id]
    if not this_worker_list:
        raise HTTPException(status_code=500, detail=f"Worker {worker_id!r} not found after rollback")
    with get_db() as conn:
        _persist_discovered_workers(conn, this_worker_list, user_id=auth.user_id)

    try:
        from worker_registry import WORKERS_DIR as _WD
        _embed_files_in_skill_version(worker_id, _WD / worker_id)
    except Exception:
        logger.warning("Failed to embed files in DB after rollback for worker %s", worker_id, exc_info=True)

    return _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)


@app.get("/contexts/{name}/versions", response_model=List[VersionSummary])
def list_context_versions(
    name: str,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[VersionSummary]:
    """List git commit history for a brain pack (newest first)."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    workspace = _git_workspace()
    rel_path = _context_git_path(safe_name)
    rows = _git_ops.get_log(
        workspace,
        rel_path=rel_path,
        limit=min(limit, 100),
        asset_type="brain_pack",
        asset_id=safe_name,
    )
    if not rows:
        _git_commit_context(safe_name, message=f"baseline: snapshot existing context {safe_name}")
        rows = _git_ops.get_log(
            workspace,
            rel_path=rel_path,
            limit=min(limit, 100),
            asset_type="brain_pack",
            asset_id=safe_name,
        )
    return [VersionSummary(**r) for r in rows]


@app.get("/contexts/{name}/versions/{sha}")
def get_context_version(
    name: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return the file tree for a brain pack at a specific git commit."""
    import base64 as _base64
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    workspace = _git_workspace()
    context_path = _context_git_path(safe_name)
    file_paths = _git_ops.list_files_at_sha(workspace, sha, context_path)
    if not file_paths:
        raise HTTPException(status_code=404, detail="Version not found or context had no files at this commit")
    files = []
    for fp in file_paths:
        content = _git_ops.get_file_at_sha(workspace, sha, fp)
        if content is not None:
            rel = fp[len(f"{context_path}/"):]
            try:
                content.encode("utf-8")
                files.append({"path": rel, "content": content, "encoding": "utf-8"})
            except Exception:
                files.append({"path": rel, "content": _base64.b64encode(content.encode("latin1")).decode(), "encoding": "base64"})
    return {"files": files}


@app.get("/contexts/{name}/files/{file_path:path}/versions", response_model=List[VersionSummary])
def list_context_file_versions(
    name: str,
    file_path: str,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[VersionSummary]:
    """List git commits that touched one brain-pack file (newest first)."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    rel = _context_file_path_or_400(file_path)
    rows = _git_ops.get_log(
        _git_workspace(),
        rel_path=_context_git_path(safe_name, rel),
        limit=min(limit, 100),
        asset_type="brain_file",
        asset_id=f"{safe_name}:{rel}",
    )
    return [VersionSummary(**r) for r in rows]


@app.get("/contexts/{name}/files/{file_path:path}/versions/{sha}")
def get_context_file_version(
    name: str,
    file_path: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return file content at a specific git commit for one brain-pack file."""
    import base64 as _base64

    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    rel = _context_file_path_or_400(file_path)
    git_path = _context_git_path(safe_name, rel)
    if is_binary_file(rel, guess_mime_type(rel)):
        content_bytes = _git_ops.get_file_bytes_at_sha(_git_workspace(), sha, git_path)
        if content_bytes is None:
            raise HTTPException(status_code=404, detail="Version not found")
        return {
            "file": {
                "path": rel,
                "content": _base64.b64encode(content_bytes).decode("ascii"),
                "encoding": "base64",
            }
        }
    content = _git_ops.get_file_at_sha(_git_workspace(), sha, git_path)
    if content is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return {"file": {"path": rel, "content": content, "encoding": "utf-8"}}


@app.post("/contexts/{name}/files/{file_path:path}/restore/{sha}", response_model=ContextFileItem)
def restore_context_file_version(
    name: str,
    file_path: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextFileItem:
    """Restore one brain-pack file to its state at a given git commit SHA."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    rel = _context_file_path_or_400(file_path)
    workspace = _git_workspace()
    git_path = _context_git_path(safe_name, rel)

    _require_sha_in_asset_history(workspace, sha, git_path)
    try:
        _git_ops.checkout_path(workspace, sha, git_path)
    except _git_ops.GitOpsError as exc:
        raise HTTPException(status_code=404, detail=f"Commit {sha!r} not found: {exc}") from exc

    author_name, author_email = _git_author(auth)
    _git_commit_context(
        safe_name, rel,
        message=f"context {safe_name}: restore {rel} to {sha}",
        author_name=author_name,
        author_email=author_email,
    )

    target = safe_context_file_path(safe_name, rel)
    if not target.is_file():
        return ContextFileItem(
            path=rel, size=0, mime_type=guess_mime_type(rel),
            updated_at=now_iso(),
            is_binary=is_binary_file(rel, guess_mime_type(rel)),
            display_type=context_file_display_type(rel, guess_mime_type(rel)),
            deleted=True,
        )
    return _write_context_file(safe_name, rel, target.read_bytes(), user_id=auth.user_id)


@app.post("/contexts/{name}/rollback/{sha}")
def rollback_context(
    name: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Restore a brain pack to its state at a given git commit SHA."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    workspace = _git_workspace()
    ctx_git_path = _context_git_path(safe_name)

    _require_sha_in_asset_history(workspace, sha, ctx_git_path)
    try:
        _git_ops.checkout_path(workspace, sha, ctx_git_path)
    except _git_ops.GitOpsError as exc:
        raise HTTPException(status_code=404, detail=f"Commit {sha!r} not found: {exc}") from exc

    author_name, author_email = _git_author(auth)
    _git_commit_context(
        safe_name,
        message=f"rollback: restore context {safe_name} to {sha}",
        author_name=author_name,
        author_email=author_email,
    )
    set_context_metadata(safe_name, owner_id=auth.user_id)
    return _context_detail(safe_name, _metadata, repos=repos, user_id=auth.user_id)


def _normalize_trigger_type(value: Any) -> str:
    normalized = str(value or "manual").strip().lower()
    if normalized in {"cron", "scheduled"}:
        return "schedule"
    return normalized or "manual"


def _trigger_label(trigger: Dict[str, Any]) -> str:
    """Return a human-readable label for one trigger dict."""
    t_type = _normalize_trigger_type(trigger.get("type"))
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
                        type=_normalize_trigger_type(t.get("type")),
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
    trigger_type = _normalize_trigger_type(worker.get("trigger_type") or trigger.get("type"))
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
    trigger_type = _normalize_trigger_type(worker.get("trigger_type") or trigger.get("type"))
    trigger_with_type = dict(trigger)
    trigger_with_type.setdefault("type", trigger_type)
    label = _trigger_label(trigger_with_type)
    return [label] if label else [trigger_type.title()]


def _connection_slug_for_worker_card(connection: Any) -> Optional[str]:
    """Return a display slug for list-card connection icons.

    Worker manifests have accepted several connection shapes over time:
    plain app slugs, typed app dicts, and MCP dicts. A malformed/null entry in
    one worker must not take down the whole `/workers` list endpoint.
    """
    if isinstance(connection, str):
        return connection
    if not isinstance(connection, dict):
        return None

    mcp = connection.get("mcp")
    if isinstance(mcp, dict):
        label = mcp.get("label")
        if isinstance(label, str) and label.strip():
            return label

    for key in ("app", "slug", "toolkit", "label", "name"):
        value = connection.get(key)
        if isinstance(value, str) and value.strip():
            return value

    return None


def _read_transcript_rows(run_runner: str, artifacts: List[Artifact]) -> List[Dict[str, Any]]:
    runner = (run_runner or "").lower()
    is_agent = runner.startswith("agent") or "agent" in runner

    if not is_agent:
        return []
    candidate_names = {"outputs/transcript.jsonl", "transcript.jsonl"}

    transcript = next(
        (a for a in artifacts if (a.name or "") in candidate_names),
        None,
    )
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

    raw_rows: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            parsed = {"type": "parse_error", "content": line}
        if isinstance(parsed, dict):
            raw_rows.append(parsed)

    # AgentDriver writes message dicts. Normalize to the
    # {type, id, name, arguments, content} shape consumed by run detail callers.
    rows: List[Dict[str, Any]] = []
    for msg in raw_rows:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if isinstance(content, str):
            rows.append({"type": "message", "role": role, "content": content, "tool_calls": []})
            continue
        if not isinstance(content, list):
            rows.append(msg)
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type", "")
            if btype == "text":
                rows.append({"type": "message", "role": role, "content": block.get("text", ""), "tool_calls": []})
            elif btype == "tool_use":
                rows.append({
                    "type": "tool_call",
                    "id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "arguments": block.get("input") or {},
                })
            elif btype == "tool_result":
                result_content = block.get("content", "")
                if isinstance(result_content, list):
                    result_content = " ".join(
                        b.get("text", "") for b in result_content if isinstance(b, dict)
                    )
                rows.append({
                    "type": "tool_result",
                    "tool_call_id": block.get("tool_use_id", ""),
                    "content": result_content,
                })
    return rows


def _extract_total_tokens_from_transcript(rows: List[Dict[str, Any]]) -> Optional[int]:
    """Return total_tokens from the usage row appended by agent_driver, or None."""
    for row in rows:
        if row.get("type") == "usage" and isinstance(row.get("total_tokens"), int):
            return row["total_tokens"]
    return None


def _parse_tool_calls_from_transcript(rows: List[Dict[str, Any]]) -> List[ToolCallEntry]:
    """Build paired ToolCallEntry list from normalised transcript rows."""
    # Index tool_call rows by id first, then attach matching tool_result rows.
    calls: Dict[str, ToolCallEntry] = {}
    order: List[str] = []
    for row in rows:
        rtype = row.get("type", "")
        if rtype == "tool_call":
            call_id = str(row.get("id") or "")
            args = row.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {"_raw": args}
            entry = ToolCallEntry(
                id=call_id or f"tc_{len(calls)}",
                name=str(row.get("name") or "unknown"),
                arguments=args if isinstance(args, dict) else {},
            )
            calls[call_id] = entry
            order.append(call_id)
        elif rtype == "tool_result":
            call_id = str(row.get("tool_call_id") or "")
            if call_id in calls:
                result = row.get("content")
                calls[call_id] = ToolCallEntry(
                    id=calls[call_id].id,
                    name=calls[call_id].name,
                    arguments=calls[call_id].arguments,
                    result=result,
                )
    return [calls[cid] for cid in order if cid in calls]


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


_BOOTSTRAP_SECRETS_TO_SEED: tuple[str, ...] = ("OPENAI_API_KEY", "E2B_API_KEY")


def _seed_bootstrap_secrets(user_id: str, repos: Repositories) -> int:
    """Copy bootstrap-owned env secrets into the DB on first setup.

    The secrets UI and worker status checks are DB-backed. On a fresh install
    the process env may already carry OPENAI_API_KEY, but the secrets table has
    no row yet, so the operator sees the worker-author/defaulted worker as
    "missing secret" even though the key is present. Seed the bootstrap user's
    row from env exactly once when it is absent or empty.
    """
    seeded = 0
    for name in _BOOTSTRAP_SECRETS_TO_SEED:
        value = os.environ.get(name)
        if not value or not value.strip():
            continue
        try:
            existing = repos.secrets.get(user_id=user_id, name=name)
        except Exception:
            logger.warning("Failed to read bootstrap secret row for %s", name, exc_info=True)
            continue
        if existing and existing.get("value"):
            continue
        try:
            repos.secrets.set(user_id=user_id, name=name, value=value, status=SecretStatus.SET.value)
            seeded += 1
        except Exception:
            logger.warning("Failed to seed bootstrap secret %s", name, exc_info=True)
    return seeded


def _claim_bootstrap_assets_for_new_admin(new_admin_id: str, repos: Repositories) -> Dict[str, int]:
    """First-account setup: transfer the bootstrap (local-default) identity's
    workers, connections, and secrets to the newly-created admin.

    On an OSS install everything is seeded under the bootstrap user
    (``_bootstrap_user_id`` / ``WORKEROS_USER_ID``). When the first admin account
    is created via ``/auth/setup`` it gets a fresh uuid and would otherwise own
    NOTHING: it can SEE the seed workers (admin listing is role-aware) but cannot
    RUN them, because a run executes with the worker OWNER's connections/secrets
    and the owner is the bootstrap id, not the admin. Claiming the bootstrap
    assets makes the admin the real owner, so the seed workers run with the
    admin's own connections.

    Idempotent and safe: no-op when admin == bootstrap, or off the local deploy
    (cloud is multi-tenant and has no single bootstrap owner). Best-effort per
    table so a missing table/column never breaks setup.
    """
    summary: Dict[str, int] = {"workers": 0, "connections": 0, "secrets": 0}
    if (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower() != "local":
        return summary
    bootstrap_id = _bootstrap_user_id()
    if not bootstrap_id or bootstrap_id == new_admin_id:
        return summary
    from db import get_db as _get_db
    with _get_db() as conn:
        for table, col, key in (
            ("workers", "owner_id", "workers"),
            ("composio_connections", "user_id", "connections"),
        ):
            try:
                summary[key] = conn.execute(
                    f"UPDATE {table} SET {col} = ? WHERE {col} = ?",
                    (new_admin_id, bootstrap_id),
                ).rowcount
            except Exception:
                logger.warning("claim-on-setup: could not move %s", table, exc_info=True)
        conn.commit()
    # Secrets: the value lives outside the metadata row, so copy value-safely via
    # the repo (don't UPDATE the table). Then seed any env-provided bootstrap
    # secrets the admin still lacks (e.g. OPENAI_API_KEY from process env).
    try:
        for name in repos.secrets.list_names(user_id=bootstrap_id):
            existing = repos.secrets.get(user_id=new_admin_id, name=name)
            if existing and existing.get("value"):
                continue
            src = repos.secrets.get(user_id=bootstrap_id, name=name)
            if src and src.get("value"):
                repos.secrets.set(
                    user_id=new_admin_id, name=name,
                    value=src["value"], status=SecretStatus.SET.value,
                )
                summary["secrets"] += 1
    except Exception:
        logger.warning("claim-on-setup: could not copy secrets", exc_info=True)
    try:
        summary["secrets"] += _seed_bootstrap_secrets(new_admin_id, repos)
    except Exception:
        pass
    return summary


def _resolve_composio_connection_id(connection_ref: str) -> str:
    """Resolve a trigger's connection reference to the raw Composio ``ca_*`` id.

    NEW-7 (2026-06-02): the raw ``ca_*`` id is no longer exposed via GET /connections,
    so the worker form now references a connection by its internal Floom UUID ``id``.
    Existing worker.yml files still carry the raw ``ca_*`` value, so this resolver is
    backward-compatible: a ``ca_*`` ref passes through unchanged, anything else is
    looked up by internal id. Composio's enable_trigger needs the raw ``ca_*`` value.
    """
    ref = (connection_ref or "").strip()
    if not ref or ref.startswith("ca_"):
        return ref
    try:
        repos = get_repositories()
        row = repos.connections.get(user_id=_bootstrap_user_id(), composio_id=ref)
        if row and row.get("composio_connection_id"):
            return str(row["composio_connection_id"])
    except Exception:
        logger.exception("Failed to resolve composio connection ref %s", ref)
    # Fall back to the original ref so the upstream call surfaces a clear error
    # instead of silently dropping the connection.
    return ref


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
    # #908: without the signing key the /composio-events receiver 503s every
    # delivery, so an enabled trigger is shipped-but-broken. Fail at enable
    # time with the operator fix instead of silently never firing.
    if not os.environ.get("COMPOSIO_WEBHOOK_SIGNING_KEY", "").strip():
        raise RuntimeError(
            f"Cannot enable Composio trigger for worker {worker_id}: "
            "COMPOSIO_WEBHOOK_SIGNING_KEY is not configured, so the "
            "/composio-events receiver rejects all deliveries (503). Set the "
            "env var from the Composio dashboard webhook settings and register "
            f"the webhook URL ({_composio_webhook_url()}) there, then retry."
        )
    try:
        from composio_client import enable_trigger
        return enable_trigger(
            signature["event"],
            _resolve_composio_connection_id(signature["connection_id"]),
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
    def normalize_trigger(trigger: Dict[str, Any]) -> Dict[str, Any]:
        normalized = dict(trigger)
        normalized["type"] = _normalize_trigger_type(normalized.get("type"))
        return normalized

    # New format: manifest.triggers list
    raw_triggers = manifest.get("triggers")
    if isinstance(raw_triggers, list) and raw_triggers:
        return [normalize_trigger(t) for t in raw_triggers if isinstance(t, dict)]
    # Old format: manifest.trigger single object
    manifest_trigger = manifest.get("trigger")
    if isinstance(manifest_trigger, dict) and manifest_trigger:
        return [normalize_trigger(manifest_trigger)]
    # Fallback: config.trigger
    config_trigger = config.get("trigger")
    if isinstance(config_trigger, dict) and config_trigger:
        return [normalize_trigger(config_trigger)]
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

        # Preserve _files if previously embedded — the raw manifest from disk
        # never contains _files, so a plain upsert would wipe them on every
        # discover cycle, breaking container-redeploy resilience.
        sv_name = manifest.get("name") or worker_id.replace("_", "-")
        sv_version = manifest.get("version") or "0.1.0"
        existing_sv = conn.execute(
            "SELECT manifest_json FROM skill_versions WHERE id = ?",
            (skill_version_id,),
        ).fetchone()
        manifest_to_store = manifest
        if existing_sv:
            try:
                existing_manifest = json.loads(existing_sv["manifest_json"] or "{}")
                if "_files" in existing_manifest and "_files" not in manifest:
                    manifest_to_store = dict(manifest)
                    manifest_to_store["_files"] = existing_manifest["_files"]
            except Exception:
                pass
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
                sv_name,
                sv_version,
                json.dumps(manifest_to_store),
                f"workers/{worker_id}",
                now,
            ),
        )
        # System workers must be workspace-visible so any authenticated user
        # can run them regardless of which bootstrap user originally persisted
        # the row (#698). Stock/example demos (PROTECTED_STOCK_WORKER_IDS or
        # is_example:true) ship with the product and are meant for every member
        # to run (e.g. outbound-approval-demo). They were persisted 'private' +
        # fede-owned, so a fresh member hit "worker <id> does not belong to
        # <uid>" at RunsRepository.create (owner OR 'workspace' only). Seed them
        # 'workspace' too, without leaking a tenant's real private workers.
        is_system_worker = bool(manifest.get("system_worker"))
        is_stock_demo = (
            worker_id in PROTECTED_STOCK_WORKER_IDS
            or manifest.get("is_example") is True
        )
        worker_visibility = (
            "workspace" if (is_system_worker or is_stock_demo) else "private"
        )

        conn.execute(
            """
            INSERT INTO workers
                (id, skill_version_id, name, trigger_type, cron_expr, cron_timezone,
                 next_run_at, last_scheduled_run_at, webhook_secret_hash, notify_email,
                 notify_webhook_url, grants_json, input_values_json, enabled, created_at, owner_id,
                 composio_trigger_id, composio_event, triggers_json, visibility)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                triggers_json=excluded.triggers_json,
                visibility=excluded.visibility
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
                worker_visibility,
            ),
        )

        # Reconcile the normalized worker_triggers rows so EVERY declared
        # trigger (not just the primary one) becomes an independently
        # schedulable / resolvable row. Existing single-trigger workers get
        # exactly one row, preserving backward-compat. The composio
        # registration id is stamped on the composio row for event resolution.
        # Local SQLite writes through the already-open `conn` (a second
        # connection here would deadlock with `database is locked`); the
        # non-SQLite mirror happens in the canonical block below.
        try:
            from db.sqlite import SqliteWorkerRepository

            SqliteWorkerRepository.reconcile_triggers_conn(
                conn,
                worker_id=worker_id,
                triggers=triggers_list,
                external_trigger_id=composio_trigger_id,
                enabled=bool(enabled_value),
            )
        except Exception:
            logger.exception(
                "reconcile_triggers failed for worker %s — multi-trigger rows "
                "may be stale (scheduler falls back to the worker scalar)",
                worker_id,
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
                    bundle_path=f"workers/{worker_id}",
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
                    # Mirror the same visibility the local SQLite row got, so a
                    # cloud (Supabase) deploy seeds system + stock/example demos
                    # as 'workspace' too — otherwise the cloud mirror defaults to
                    # 'private' and members hit "does not belong" on the demo.
                    visibility=worker_visibility,
                )
                # Non-SQLite (cloud) reconcile: SQLite already reconciled via
                # the open `conn` above. Guarded separately so a cloud repo that
                # has not yet shipped reconcile_triggers degrades to the legacy
                # single-trigger behaviour instead of failing the worker upsert.
                reconcile = getattr(canonical_workers, "reconcile_triggers", None)
                if callable(reconcile):
                    try:
                        reconcile(
                            worker_id=worker_id,
                            triggers=triggers_list,
                            external_trigger_id=composio_trigger_id,
                            enabled=bool(enabled_value),
                        )
                    except Exception:
                        logger.exception(
                            "cloud reconcile_triggers failed for worker %s — "
                            "multi-trigger rows may be stale",
                            worker_id,
                        )
        except Exception:
            logger.exception(
                "repos.workers.upsert failed for worker %s (user %s) — "
                "filesystem bundle written, but DB row may be missing",
                worker_id,
                user_id,
            )
            raise


def _list_db_workers(
    *,
    user_id: str,
    repos: Repositories,
    role: Optional[str] = None,
) -> List[Dict[str, Any]]:
    try:
        return repos.workers.list(user_id=user_id, role=role)
    except sqlite3.OperationalError:
        return []


def _worker_access_user_id(auth: AuthContext) -> str:
    """Resolve the engine owner id for worker visibility checks."""
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local" and auth.user_id != local_workspace_base_user_id(auth.user_id):
        return auth.user_id
    username = (auth.username or "").strip()
    if deploy != "local" or not username or username == auth.user_id:
        return auth.user_id
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT 1
                FROM workspace_members
                WHERE workspace_id = ?
                  AND user_id = ?
                  AND role IN ('owner', 'admin')
                  AND status = 'active'
                LIMIT 1
                """,
                (DEFAULT_WORKSPACE_ID, username),
            ).fetchone()
            if row is not None:
                return username
            row = conn.execute(
                """
                SELECT 1
                FROM local_workspaces
                WHERE id = ? AND owner_user_id = ?
                LIMIT 1
                """,
                (DEFAULT_WORKSPACE_ID, username),
            ).fetchone()
            if row is not None:
                return username
    except Exception:
        logger.debug("worker access user-id compatibility lookup failed", exc_info=True)
    return auth.user_id


def _worker_repo_role(auth: AuthContext) -> str | None:
    """Return the worker-repo role for the current auth context.

    Local OSS secret auth uses the shared backdoor but still needs workspace
    boundaries, so it must not bypass the repo with admin visibility. Session /
    PAT / cloud auth keep their declared role semantics.
    """
    if (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower() == "local" and auth.auth_method == "secret":
        return None
    return auth.role


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


def _worker_hidden_from_api(
    worker_id: str,
    _owned_tracked_ids: frozenset[str] | None = None,
) -> bool:
    """Return True if worker_id should be hidden from the public API.

    Pass _owned_tracked_ids (a pre-fetched frozenset of git-tracked workers
    that have a DB owner) when calling inside a list loop to avoid one
    extra SELECT per worker (N+1). When absent the function falls back to
    an individual get_owner() query.
    """
    if worker_id.startswith("."):
        return True
    if any(worker_id.startswith(prefix) for prefix in _INTERNAL_WORKER_ID_PREFIXES):
        return True
    tracked_ids = _tracked_worker_ids()
    if worker_id in tracked_ids:
        if worker_id in _SYSTEM_WORKER_IDS:
            return True
        if worker_id in PUBLIC_STOCK_WORKER_IDS:
            return False
        # Git-tracked workers that have a DB owner are user workers — always visible.
        # Only pure engine/stock workers (no DB owner) are hidden from the user API.
        if _owned_tracked_ids is not None:
            return worker_id not in _owned_tracked_ids
        from db import get_repositories
        try:
            owner = get_repositories().workers.get_owner(worker_id=worker_id)
            if owner:
                return False
        except Exception:
            # On DB error expose the worker rather than silently clearing the
            # entire list (fail open for visibility, not fail closed).
            return False
        return True
    return False


def _build_owned_tracked_ids() -> frozenset[str]:
    """Return the set of git-tracked worker IDs that have a DB owner.

    Called once before a list loop to pre-load ownership for all tracked
    workers in a single query, eliminating the N+1 problem in
    _worker_hidden_from_api().
    """
    tracked = _tracked_worker_ids()
    if not tracked:
        return frozenset()
    from db import get_repositories
    try:
        placeholders = ",".join("?" * len(tracked))
        from db import get_db
        with get_db() as conn:
            rows = conn.execute(
                f"SELECT id FROM workers WHERE id IN ({placeholders}) AND owner_id IS NOT NULL",
                tuple(tracked),
            ).fetchall()
        return frozenset(str(r["id"]) for r in rows)
    except Exception:
        return frozenset(tracked)  # Fail open: treat all as owned


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


def _visibility_role(role: Optional[str]) -> Optional[str]:
    """Resolve the worker-visibility role for the current request.

    Most callers pass role=None and historically relied on the shared-filesystem
    fallback to surface admin/shared workers. Now that the fallback is owner-
    scoped, default the role from the active request's auth context so admins
    still see EVERY worker and members still see workers SHARED with them, while
    another member's private worker stays hidden. Outside a request (no auth
    context) the role stays None — legacy owner-scoped behaviour.

    Security: local secret auth deliberately passes role=None via _worker_repo_role
    to keep workspace scoping intact. If we override that None with the auth
    context's default role ("admin"), _list_db_workers runs unfiltered and leaks
    workers across workspaces (issue #809). We must honour the explicit None from
    _worker_repo_role by skipping the auth-context default for local secret auth.
    """
    if role is not None:
        return role
    ctx = current_auth_context()
    if ctx is None:
        return None
    # Local single-operator secret auth: _worker_repo_role deliberately passes
    # None so the DB query stays scoped to the requesting user's workspace. Do
    # NOT upgrade that None to ctx.role ("admin" by default), which would bypass
    # workspace isolation. All other auth methods (session, PAT, cloud, supabase)
    # should use their declared role so admins/members see the right workers.
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local" and ctx.auth_method == "secret":
        return None
    return ctx.role


def _db_worker_owners() -> Dict[str, str]:
    """Map every DB worker id to its owner_id in one query.

    Used to keep the shared-filesystem fallback from leaking another member's
    runtime-created worker: a worker on disk that has a DB owner who is not the
    requesting user belongs to them and must never be surfaced.
    """
    from db import get_db
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, owner_id FROM workers WHERE owner_id IS NOT NULL"
            ).fetchall()
        return {str(r[0]): str(r[1]) for r in rows if r[0] and r[1]}
    except sqlite3.OperationalError:
        return {}


def _granted_asset_ids(asset_type: str) -> frozenset[str]:
    """Asset ids of ``asset_type`` granted to the CURRENT request's viewer.

    #767/#768 enforcement hook. A ``specific_people`` grant records a grantee by
    email (``asset_grants.grantee_email``); this resolves the active request's
    auth-context email to the set of assets shared with them so the visibility
    resolvers can surface those assets. Returns an empty set outside a request
    (no auth context) or for an email-less context — fail CLOSED (no grant)
    rather than open. Never raises: a grant probe must not break a list/detail.
    """
    ctx = current_auth_context()
    email = ((ctx.email if ctx else None) or "").strip().lower()
    if not email:
        return frozenset()
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT asset_id FROM asset_grants "
                "WHERE asset_type = ? AND lower(grantee_email) = ?",
                (asset_type, email),
            ).fetchall()
    except sqlite3.OperationalError:
        return frozenset()
    return frozenset(str(r[0]) for r in rows if r and r[0])


def _granted_worker_ids() -> frozenset[str]:
    """Canonical worker ids the current viewer has been granted (#767/#768)."""
    return frozenset(_canonical_worker_id(wid) for wid in _granted_asset_ids("worker"))


def _list_visible_workers(
    *,
    user_id: str,
    repos: Repositories,
    use_cache: bool = True,
    role: Optional[str] = None,
) -> List[Dict[str, Any]]:
    # Admin sees all, member sees own + shared; default from the request context
    # so the owner-scoped fallback below doesn't hide admin/shared workers.
    role = _visibility_role(role)
    # Pre-load ownership for all git-tracked workers in one query so
    # _worker_hidden_from_api() inside the loop doesn't fire N extra SELECTs.
    _owned = _build_owned_tracked_ids()
    visible = {
        worker["id"]: worker
        for worker in _list_db_workers(user_id=user_id, repos=repos, role=role)
        if not str(worker.get("id") or "").startswith(".")
        and not _worker_hidden_from_api(str(worker.get("id") or ""), _owned)
    }
    for worker in _stock_workers_from_filesystem(use_cache=use_cache):
        visible.setdefault(worker["id"], worker)
    if _shared_filesystem_fallback_allowed():
        # Owner-scope the fallback so it never leaks another member's runtime
        # worker. Only unowned on-disk workers (true first-run orphans) and the
        # requesting user's own workers are surfaced here; curated shipped
        # templates already came in via _stock_workers_from_filesystem() above.
        # This keeps single-operator first-run UX intact (you still see all your
        # own + shipped workers) while making worker visibility consistent with
        # the per-member run/secret isolation.
        _owners = _db_worker_owners()
        for worker in discover_workers(use_cache=use_cache):
            worker_id = str(worker.get("id") or "")
            if not worker_id or _worker_hidden_from_api(worker_id, _owned):
                continue
            owner = _owners.get(worker_id)
            if owner is not None and owner != user_id:
                continue  # belongs to another member — do not surface
            visible.setdefault(worker_id, worker)
    # #767/#768 enforcement: surface workers explicitly shared with this viewer
    # (by email) even when visibility (private/specific_people) would otherwise
    # hide them. get_any bypasses owner/visibility scoping — the grant IS the
    # authorization. This is read access only; repo UPDATE/DELETE stay
    # owner-scoped (WHERE owner_id=?), so a grantee cannot edit or delete.
    for gid in _granted_worker_ids():
        if gid in visible or _worker_hidden_from_api(gid, _owned):
            continue
        try:
            granted = repos.workers.get_any(worker_id=gid)
        except Exception:
            granted = None
        if granted is not None:
            visible[gid] = granted
    return list(visible.values())


def _list_operator_workers(
    *,
    user_id: str,
    repos: Repositories,
    use_cache: bool = True,
    role: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Workers shown in the operator's default view.

    Same filter as the default GET /workers view: visible (non-hidden) workers,
    minus system_worker:true and archived. Shared by /workers and the overview
    'Workers active' count so the two numbers cannot drift (1.5.4).

    ``role`` MUST be threaded through identically to GET /workers
    (``_worker_repo_role(auth)``); otherwise an admin member sees the full
    workspace-visible set on /workers but a smaller owner-only set on the
    overview, and the two counts diverge (the 78-vs-104 scoping bug). The
    ``user_id`` passed here must likewise be the access-resolved id
    (``_worker_access_user_id(auth)``), not the raw caller id.
    """
    workers = _list_visible_workers(
        user_id=user_id, repos=repos, use_cache=use_cache, role=role
    )
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
    role: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    try:
        return repos.workers.get(user_id=user_id, worker_id=worker_id, role=role)
    except TypeError as exc:
        if "role" not in str(exc):
            raise
        return repos.workers.get(user_id=user_id, worker_id=worker_id)
    except sqlite3.OperationalError:
        return None


def _worker_for_mutation(
    worker_id: str,
    auth: AuthContext,
    repos: Repositories,
) -> Optional[Dict[str, Any]]:
    """Resolve a worker the caller may MUTATE (donation model).

    - Owner fetch (unchanged): a member mutates their own private workers.
    - Admins additionally mutate workspace-shared workers, which are owned by
      the synthetic workspace actor after share-transfer — no human is ever
      is_owner of those, so this is the ONLY mutation path for shared workers.
    Returns None when the caller has no mutation rights (callers 404).
    """
    worker = _get_db_worker(worker_id, user_id=auth.user_id, repos=repos)
    if worker is not None:
        return worker
    if auth.is_admin:
        any_row = repos.workers.get_any(worker_id=worker_id)
        if any_row and str(any_row.get("visibility") or "private") == "workspace":
            return any_row
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
    role: Optional[str] = None,
    include_grants: bool = False,
) -> Optional[Dict[str, Any]]:
    # Admin sees all, member sees own + shared; default from the request context
    # so the owner-scoped filesystem fallback below doesn't 404 an admin or a
    # worker shared with this member.
    #
    # include_grants (#767/#768) is OFF by default so EVERY mutation endpoint
    # that gates on this helper keeps owner/workspace-only semantics — a
    # specific-people grantee 404s there and can never edit/delete/run. Only the
    # read path (GET /workers/{id} detail) opts in, giving a grantee VIEW access.
    role = _visibility_role(role)
    worker = _get_db_worker(worker_id, user_id=user_id, repos=repos, role=role)
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
    if worker_id in PUBLIC_STOCK_WORKER_IDS:
        return get_worker(worker_id)
    # #767/#768 enforcement: a viewer explicitly granted this worker can fetch it
    # even when visibility (private/specific_people) hides it from the owner-scoped
    # repo query above. get_any bypasses owner/visibility scoping; the grant IS the
    # authorization. VIEW only and opt-in (include_grants): only the read path
    # passes it, so a grantee never reaches a mutation endpoint's owner-scoped
    # write or the delete orphan-reap. Checked before the filesystem fallback so it
    # works in cloud (fallback disabled) too.
    if include_grants and _canonical_worker_id(worker_id) in _granted_worker_ids():
        try:
            granted = repos.workers.get_any(worker_id=worker_id)
        except Exception:
            granted = None
        if granted is not None:
            return granted
    if _shared_filesystem_fallback_allowed():
        # Owner-scope the filesystem fallback so one member cannot fetch — and,
        # via the endpoints that gate on this (run/edit/delete/files), act on —
        # another member's runtime worker. Unowned on-disk workers (true
        # first-run orphans) stay reachable; a worker owned by a different user
        # returns None (404).
        owner = _db_worker_owners().get(worker_id)
        if owner is not None and owner != user_id:
            return None
        return get_worker(worker_id)
    return None


def _run_visible_to_api(row: Any, *, user_id: str, repos: Repositories) -> bool:
    worker_id = str(row_to_dict(row).get("worker_id") or "")
    if not worker_id:
        return False
    # Always hide runs for system/infra workers — they're high-volume background
    # workers whose runs would flood the operator view and are never user-initiated.
    if worker_id in _SYSTEM_WORKER_IDS:
        return False
    if worker_id.startswith(".") or any(worker_id.startswith(p) for p in _INTERNAL_WORKER_ID_PREFIXES):
        return False
    if _worker_hidden_from_api(worker_id):
        return False
    # A run is visible if its worker is owned by the requesting user — regardless
    # of whether the worker is a stock/tracked worker. This closes the gap where
    # Emily (which bypasses the visibility filter) could see runs that /runs hid.
    worker = _get_db_worker(worker_id, user_id=user_id, repos=repos)
    if worker is not None:
        return True
    # Filesystem fallback: public stock workers are always visible.
    if _shared_filesystem_fallback_allowed() or worker_id in PUBLIC_STOCK_WORKER_IDS:
        return get_worker(worker_id) is not None
    return False


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


_SENSITIVE_FILE_NAMES = frozenset({".env", ".env.local", ".env.production", ".env.development"})
_SENSITIVE_FILE_SUFFIXES = frozenset({".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".p8", ".der", ".ppk"})


def _should_embed_file(rel_path: str) -> bool:
    if _should_ignore_worker_file(rel_path):
        return False
    name = Path(rel_path).name
    if name in _SENSITIVE_FILE_NAMES or name.startswith(".env"):
        return False
    if Path(rel_path).suffix.lower() in _SENSITIVE_FILE_SUFFIXES:
        return False
    return True


def _embed_files_in_skill_version(worker_id: str, worker_dir: Path) -> None:
    """Store all text worker files into manifest_json._files so they survive container redeploys."""
    files: dict = {}
    for fpath in sorted(worker_dir.rglob("*")):
        if fpath.is_symlink() or not fpath.is_file():
            continue
        rel = fpath.relative_to(worker_dir).as_posix()
        if not _should_embed_file(rel):
            continue
        try:
            files[rel] = fpath.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            pass
    if not files:
        return
    with get_db() as conn:
        row = conn.execute(
            "SELECT sv.id, sv.manifest_json FROM skill_versions sv "
            "JOIN workers w ON w.skill_version_id = sv.id WHERE w.id = ?",
            (worker_id,),
        ).fetchone()
        if not row:
            return
        manifest = json.loads(row["manifest_json"] or "{}")
        manifest["_files"] = files
        conn.execute(
            "UPDATE skill_versions SET manifest_json = ? WHERE id = ?",
            (json.dumps(manifest), row["id"]),
        )


def rematerialize_worker_from_db(worker_id: str) -> bool:
    """Write worker files from manifest_json._files back to WORKERS_DIR.

    Returns True if files were written, False if no _files stored in DB.
    Uses an atomic temp-dir swap so a partial failure never leaves a corrupt dir.
    """
    import shutil as _shutil
    from worker_registry import WORKERS_DIR
    with get_db() as conn:
        row = conn.execute(
            "SELECT sv.manifest_json FROM skill_versions sv "
            "JOIN workers w ON w.skill_version_id = sv.id WHERE w.id = ?",
            (worker_id,),
        ).fetchone()
    if not row:
        return False
    manifest = json.loads(row["manifest_json"] or "{}")
    files = manifest.get("_files")
    if not files:
        return False
    worker_dir = WORKERS_DIR / worker_id
    tmp_dir = Path(tempfile.mkdtemp(prefix=f".rmat.{worker_id}.", dir=str(WORKERS_DIR)))
    try:
        resolved_tmp = tmp_dir.resolve()
        for rel_path, content in files.items():
            dest = (tmp_dir / rel_path).resolve()
            try:
                dest.relative_to(resolved_tmp)
            except ValueError:
                logger.warning("Skipping path traversal in _files for worker %s: %s", worker_id, rel_path)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content, encoding="utf-8")
        if worker_dir.exists():
            _shutil.rmtree(worker_dir)
        tmp_dir.rename(worker_dir)
    except Exception:
        _shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    logger.info("Re-materialized %d files for worker %s from DB", len(files), worker_id)
    return True


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


def _worker_files_from_manifest(worker: Dict[str, Any]) -> List[WorkerFile]:
    """Build the minimal editable source view for DB-backed workers without a bundle dir."""
    import yaml as pyyaml

    files: List[WorkerFile] = []
    manifest = worker.get("manifest") or worker.get("manifest_json") or {}
    if manifest:
        try:
            manifest_yaml = pyyaml.safe_dump(manifest, sort_keys=False)
            files.append(
                WorkerFile(
                    path="worker.yml",
                    language=_language_for_path("worker.yml"),
                    content=manifest_yaml,
                    binary=False,
                    size=len(manifest_yaml.encode("utf-8")),
                )
            )
        except Exception:
            pass

    config = worker.get("config") or {}
    runtime = config.get("runtime") if isinstance(config, dict) else {}
    entrypoint = ""
    if isinstance(runtime, dict):
        entrypoint = str(runtime.get("entrypoint") or "")
    for rel in ("SKILL.md", "run.py"):
        content = ""
        if isinstance(manifest, dict):
            files_section = manifest.get("files")
            if isinstance(files_section, dict) and isinstance(files_section.get(rel), str):
                content = files_section[rel]
        if not content and rel == "run.py" and entrypoint == "run.py":
            content = _DEFAULT_RUN_PY_STUB
        if content:
            files.append(
                WorkerFile(
                    path=rel,
                    language=_language_for_path(rel),
                    content=content,
                    binary=False,
                    size=len(content.encode("utf-8")),
                )
            )
    return files


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
    """Increment file ref_counts in one short transaction tolerant of run bursts.

    Uses ``get_db()`` so the DB path is resolved dynamically from the configured
    ``WORKEROS_DB``/``FLOOM_DB`` env (the canonical resolution every other read
    path uses), instead of the module-import-time ``DB_PATH`` global. The stale
    global could diverge from the live path (deploy-dir swaps / test suites that
    re-pin the DB), silently writing ref_count updates to the wrong database.
    """
    if not file_ids:
        return
    counts = collections.Counter(file_ids)
    with get_db() as conn:
        for file_id, count in counts.items():
            conn.execute(
                "UPDATE files SET ref_count = ref_count + ? WHERE id = ?",
                (count, file_id),
            )


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


def _validate_file_input_references(
    run_config: Optional[WorkerConfig],
    inputs: Dict[str, Any],
) -> None:
    """Reject invalid file input references before a run row is created."""
    if not run_config:
        return
    for inp in getattr(run_config, "inputs", []) or []:
        if getattr(inp, "type", None) != "file":
            continue
        value = inputs.get(inp.name)
        if value in (None, ""):
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


_DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
_DEFAULT_UPLOAD_HOURLY_CAP_BYTES = 1024 * 1024 * 1024
_UPLOAD_HOURLY_WINDOW_SECONDS = 3600.0
_UPLOAD_ALLOWED_MEDIA_TYPES = frozenset({
    "application/json",
    "application/pdf",
    "application/rtf",
    "application/sql",
    "application/toml",
    "application/typescript",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/x-yaml",
    "application/xml",
    "application/yaml",
    "application/zip",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/css",
    "text/csv",
    "text/html",
    "text/markdown",
    "text/plain",
    "text/tab-separated-values",
    "text/x-python",
    "text/xml",
    "text/yaml",
})
# Text/code/data/doc/image formats a worker can read as context or a user can
# attach. Mirrors what Mac/GitHub treat as ordinary repo files. True
# executables / scripts stay in the blocklist below.
_UPLOAD_ALLOWED_EXTENSIONS = frozenset({
    ".c", ".cpp", ".cc", ".h", ".hpp",
    ".csv", ".tsv",
    ".css", ".scss",
    ".docx", ".pptx", ".xlsx", ".rtf", ".odt",
    ".gif", ".jpeg", ".jpg", ".png", ".webp",
    ".go", ".rs", ".rb", ".java", ".kt", ".swift",
    ".htm", ".html", ".xml",
    ".ini", ".toml", ".env", ".conf", ".cfg",
    ".ipynb",
    ".json", ".jsonl", ".ndjson",
    ".log",
    ".md", ".markdown", ".mdx", ".rst",
    ".pdf",
    ".py",
    ".sql",
    ".ts", ".tsx", ".jsx",
    ".txt", ".text",
    ".yaml", ".yml",
    ".zip",
})
# Declared media types we reject outright (defense-in-depth), even when the
# file extension is benign — these signal an executable/script payload.
_UPLOAD_DANGEROUS_MEDIA_TYPES = frozenset({
    "application/javascript",
    "image/svg+xml",
    "image/svg",
    "application/x-dosexec",
    "application/x-executable",
    "application/x-msdownload",
    "application/x-msdos-program",
    "application/x-sh",
    "application/x-shellscript",
    "application/vnd.microsoft.portable-executable",
    "text/javascript",
})
# Active/executable formats: blocked regardless of the allowlist (a blocked
# extension always wins, see _validate_upload_filename).
_UPLOAD_BLOCKED_EXTENSIONS = frozenset({
    ".bat",
    ".svg",
    ".cmd",
    ".com",
    ".dll",
    ".exe",
    ".js",
    ".mjs",
    ".php",
    ".ps1",
    ".scr",
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


# #930: when no signing secret is configured, fall back to a per-process
# random key instead of a hardcoded public string. Download tokens can no
# longer be forged offline; they just stop validating across restarts (the
# documented trade-off for unconfigured local installs).
_UPLOAD_FALLBACK_SIGNING_KEY: str = pysecrets.token_hex(32)


def _upload_signing_key() -> bytes:
    key = (
        os.environ.get("WORKEROS_UPLOAD_URL_SIGNING_SECRET")
        or os.environ.get("FLOOM_SECRET")
        or _UPLOAD_FALLBACK_SIGNING_KEY
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


async def _store_uploaded_blob(
    request: Request,
    file: UploadFile,
    uploaded_by: str,
    *,
    max_size_mb: Optional[float] = None,
    accepts: Optional[str] = None,
    allowed_media_prefixes: Optional[tuple[str, ...]] = None,
) -> Dict[str, Any]:
    """Validate + content-address one uploaded file under `uploaded_by`.

    Shared by the authed `/uploads` route and the approval-scoped upload routes
    (authed owner + signed-link public reviewer). The same extension allowlist,
    size/quota caps, and content-addressed dedup apply on every path, so the
    public no-auth reviewer cannot smuggle in an executable or oversized blob.
    `allowed_media_prefixes` further restricts the upload to e.g. image/* only.
    """
    if max_size_mb is not None and max_size_mb <= 0:
        raise HTTPException(status_code=400, detail="max_size_mb must be greater than 0")

    raw_filename = file.filename or ""
    _validate_upload_filename(raw_filename)

    media_type = normalize_media_type(
        file.content_type or mimetypes.guess_type(raw_filename)[0]
    )
    suffix = Path(raw_filename).suffix.lower()
    if media_type in _UPLOAD_DANGEROUS_MEDIA_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Upload media type {media_type!r} is not allowed",
        )
    media_type_ok = (
        media_type in _UPLOAD_ALLOWED_MEDIA_TYPES
        or suffix in _UPLOAD_ALLOWED_EXTENSIONS
        or media_type in {"application/octet-stream", ""}
        or media_type.startswith("text/")
    )
    if not media_type_ok:
        raise HTTPException(
            status_code=400,
            detail=f"Upload media type {media_type!r} is not allowed",
        )

    if allowed_media_prefixes is not None and not any(
        media_type.startswith(prefix) for prefix in allowed_media_prefixes
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Upload media type {media_type!r} is not accepted here",
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
        tmp_upload.unlink(missing_ok=True)

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


@app.post("/uploads")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    max_size_mb: Optional[float] = Form(None),
    accepts: Optional[str] = Form(None),
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    return await _store_uploaded_blob(
        request,
        file,
        auth.user_id or "anonymous",
        max_size_mb=max_size_mb,
        accepts=accepts,
    )


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
    # #929: uploads may be HTML/XML. FileResponse(filename=...) already forces
    # Content-Disposition: attachment; nosniff stops browsers from second-
    # guessing the media type and executing stored markup same-origin.
    return FileResponse(
        path,
        filename=filename,
        media_type=media_type,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.delete("/uploads/{file_id}", status_code=204)
def delete_upload(
    file_id: str,
    auth: AuthContext = Depends(get_auth_context),
):
    """Owner-scoped delete of an uploaded blob.

    F4 (2026-06-03): uploaded blobs (approval screenshots, file inputs) with
    ``ref_count = 0`` previously lingered on disk forever — no cleanup route
    existed, so orphaned blobs accumulated. This route lets an owner release a
    blob and GCs it when it is truly unreferenced.

    Semantics (blobs are content-addressed + can be shared across owners and
    bound to runs):
      - The caller MUST own the file (file_owners row, or legacy uploaded_by).
      - The caller's ownership is dropped.
      - The physical blob + files row are deleted ONLY when no owners remain AND
        ``ref_count == 0`` (i.e. not bound to any run). If another owner holds it
        or a run still references it, the blob is kept; the caller simply no
        longer owns it.

    Returns 204 on success (idempotent for the caller's own ownership);
    404 if the caller does not own the file (no existence oracle for others'
    files — same 404 as a genuinely-missing file).
    """
    if not is_sha256(file_id):
        raise HTTPException(status_code=404, detail="Uploaded file not found")

    user_id = auth.user_id or "anonymous"
    with get_db() as conn:
        row = conn.execute(
            "SELECT ref_count FROM files WHERE id = ? LIMIT 1",
            (file_id,),
        ).fetchone()
        if row is None or not _user_owns_uploaded_file(conn, file_id, user_id):
            raise HTTPException(status_code=404, detail="Uploaded file not found")

        # Drop the caller's ownership (both the explicit row and any legacy
        # uploaded_by anchor that made them an owner).
        conn.execute(
            "DELETE FROM file_owners WHERE file_id = ? AND user_id = ?",
            (file_id, user_id),
        )
        conn.execute(
            "UPDATE files SET uploaded_by = NULL WHERE id = ? AND COALESCE(uploaded_by, 'anonymous') = ?",
            (file_id, user_id),
        )

        remaining_owners = conn.execute(
            "SELECT 1 FROM file_owners WHERE file_id = ? LIMIT 1",
            (file_id,),
        ).fetchone()
        ref_count = int(row["ref_count"] or 0)

        if remaining_owners is None and ref_count <= 0:
            # No owners + not bound to any run → safe to GC the blob + row.
            conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
            _delete_blob_file(file_id)

    return Response(status_code=204)


def _delete_blob_file(file_id: str) -> None:
    """Best-effort removal of a content-addressed blob from disk."""
    try:
        path = blob_path(file_id)
    except ValueError:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("Failed to remove orphan blob %s: %s", file_id, exc)


def _gc_orphan_blobs(*, limit: int = 500) -> int:
    """Sweep ``ref_count = 0`` blobs that also have NO owners, deleting the row
    and the on-disk blob. Returns the number of blobs reclaimed.

    Idempotent + bounded. Safe to call from a periodic sweep. Blobs that are
    still bound to a run (ref_count > 0) or still owned by anyone are left
    untouched.
    """
    reclaimed = 0
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT f.id AS id
            FROM files f
            WHERE COALESCE(f.ref_count, 0) <= 0
              AND NOT EXISTS (
                  SELECT 1 FROM file_owners o WHERE o.file_id = f.id
              )
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        for row in rows:
            fid = row["id"]
            conn.execute("DELETE FROM files WHERE id = ?", (fid,))
            _delete_blob_file(fid)
            reclaimed += 1
    return reclaimed


# ---------------------------------------------------------------------------
# Contexts — filesystem-backed worker knowledge/state folders
# ---------------------------------------------------------------------------


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
    repos: Optional[Repositories] = None,
) -> bool:
    safe_name = validate_context_name(name)
    actor_user_id = _context_actor_user_id(user_id)
    meta = metadata if metadata is not None else load_context_metadata()
    # Engine/system packs are internal config, never operator-facing.
    if _is_system_context_pack(safe_name, meta):
        return False
    owner_id = context_owner_id(safe_name, meta)
    if owner_id:
        if owner_id == actor_user_id:
            return True
        # Members STEP 4: a pack shared with the workspace is visible to members.
        # Only consult the access mirror when repos is available (the OSS list /
        # detail / require paths pass it); background paths without repos keep the
        # strict owner-only check so nothing widens silently.
        if repos is not None and _brain_pack_visibility(
            safe_name, meta, repos=repos
        ) == "workspace":
            return True
        return False
    return _unowned_contexts_visible_to_caller()


def _require_context_for_user(
    name: str,
    *,
    user_id: str,
    metadata: dict[str, dict[str, Any]] | None = None,
    repos: Optional[Repositories] = None,
) -> tuple[str, dict[str, dict[str, Any]]]:
    """Mutate access: the caller must be able to EDIT the pack (owner, or
    owner/admin for a workspace-shared pack). A workspace member who can only
    read a shared pack gets 404 here (the same not-found shape the read path
    uses, never revealing edit-gated state). On the OSS single-owner engine the
    local user owns their packs, so this is unchanged.
    """
    safe_name = _context_name_or_400(name)
    meta = metadata if metadata is not None else load_context_metadata()
    if not context_dir(safe_name).is_dir() or not _context_visible_to_user(
        safe_name,
        user_id=user_id,
        metadata=meta,
        repos=repos,
    ):
        raise HTTPException(status_code=404, detail="Context not found")
    # When the pack is visible only because it is workspace-shared (not owned),
    # gate mutation on can_edit so a plain member cannot edit someone else's pack.
    owner_id = context_owner_id(safe_name, meta)
    if repos is not None and owner_id and owner_id != user_id:
        _owner, _vis, perms = _brain_pack_access(
            safe_name, meta, user_id=user_id, repos=repos
        )
        if not perms.can_edit:
            raise HTTPException(status_code=404, detail="Context not found")
    return safe_name, meta


def _require_readable_context_for_user(
    name: str,
    *,
    user_id: str,
    metadata: dict[str, dict[str, Any]] | None = None,
    repos: Optional[Repositories] = None,
) -> tuple[str, dict[str, dict[str, Any]]]:
    """Read access: operator-visible packs OR read-only system packs.

    Mutating endpoints must keep using ``_require_context_for_user`` so system
    packs stay non-editable (it returns 404 for them).
    """
    safe_name = _context_name_or_400(name)
    meta = metadata if metadata is not None else load_context_metadata()
    if not context_dir(safe_name).is_dir():
        raise HTTPException(status_code=404, detail="Context not found")
    if _is_system_context_pack(safe_name, meta):
        return safe_name, meta
    if not _context_visible_to_user(
        safe_name, user_id=user_id, metadata=meta, repos=repos
    ):
        raise HTTPException(status_code=404, detail="Context not found")
    return safe_name, meta


def _context_worker_counts(repos: Optional[Repositories], user_id: str) -> dict[str, int]:
    """Map context-pack name -> number of workers that mount it.

    Computed from a single ``workers.list`` call so the LIST endpoint stays
    O(workers) instead of O(packs * workers). Mirrors the per-pack ``used_by``
    computation in ``_context_detail`` so list == detail.
    """
    counts: dict[str, int] = {}
    if repos is None:
        return counts
    try:
        workers = repos.workers.list(user_id=user_id)
    except Exception:
        return counts
    for worker in workers:
        try:
            contexts = (worker.get("config") or {}).get("contexts") or []
            for ctx_name in context_mount_names(contexts):
                counts[ctx_name] = counts.get(ctx_name, 0) + 1
        except Exception:
            continue
    return counts


def _ensure_brain_pack_row(
    name: str,
    *,
    owner_id: str | None,
    repos: Optional[Repositories],
) -> Optional[dict[str, Any]]:
    """Lazily upsert + return the brain_packs access-control mirror row.

    Brain packs are filesystem dirs; their owner lives in the per-workspace
    ``.workeros-contexts.json``. The first time the API touches a pack's
    visibility it materializes the row (default ``private``) so the generic
    ``AssetAccessRepository`` can resolve permissions exactly like a worker. The
    pack id is the pack name (one pack per name per workspace). Never raises —
    visibility is a UI affordance, not a hard gate (the FS owner check below
    still governs read access).
    """
    if repos is None or not owner_id:
        return None
    asset_access = getattr(repos, "asset_access", None)
    ensure = getattr(asset_access, "ensure_brain_pack", None)
    if ensure is None:
        return None
    try:
        return ensure(
            pack_id=name,
            workspace_id=derive_workspace_id(owner_id),
            owner_id=owner_id,
            name=name,
        )
    except Exception:
        logger.debug("ensure brain_pack row failed for %s", name, exc_info=True)
        return None


def _brain_pack_access(
    name: str,
    metadata: dict[str, dict[str, Any]] | None,
    *,
    user_id: str,
    repos: Optional[Repositories],
) -> tuple[Optional[str], str, AssetPermissions]:
    """Resolve (owner_id, visibility, permissions) for a brain pack.

    Delegates to the AssetAccessRepository (engine-owned, Cloud-mirrorable). Falls
    back to the FS-metadata owner with owner-permissive defaults when no row /
    repo is available, so the OSS single-owner UX is unchanged. Never raises.
    """
    meta = metadata if metadata is not None else load_context_metadata()
    actor_user_id = _context_actor_user_id(user_id)
    owner_id = context_owner_id(name, meta)
    asset_access = getattr(repos, "asset_access", None) if repos is not None else None
    if asset_access is not None and owner_id:
        _ensure_brain_pack_row(name, owner_id=owner_id, repos=repos)
        try:
            perms = asset_access.get_permissions(
                workspace_id=derive_workspace_id(owner_id),
                user_id=actor_user_id,
                asset_type="brain_pack",
                asset_id=name,
            )
            return (
                owner_id,
                str(perms.get("visibility") or "private"),
                AssetPermissions(
                    is_owner=bool(perms.get("is_owner", owner_id == user_id)),
                    can_view=bool(perms.get("can_view", True)),
                    can_edit=bool(perms.get("can_edit", True)),
                    can_run=bool(perms.get("can_run", True)),
                    can_delete=bool(perms.get("can_delete", True)),
                    can_share=bool(perms.get("can_share", True)),
                ),
            )
        except Exception:
            logger.debug("brain_pack permission probe failed for %s", name, exc_info=True)
    # Fallback: no DB row (unowned pack) — the viewer who can see it is owner.
    is_owner = (not owner_id) or owner_id == actor_user_id
    return (
        owner_id,
        "private",
        AssetPermissions(
            is_owner=is_owner,
            can_view=is_owner,
            can_edit=is_owner,
            can_run=is_owner,
            can_delete=is_owner,
            can_share=is_owner,
        ),
    )


def _brain_pack_visibility(
    name: str,
    metadata: dict[str, dict[str, Any]] | None,
    *,
    repos: Optional[Repositories],
) -> str:
    """Current visibility string for a pack from the access mirror row.

    Returns ``private`` when there is no row yet (the secure default, matching the
    pre-STEP-4 owner-only behaviour). Used by the visibility gate in
    ``_context_visible_to_user`` so a ``workspace`` pack is visible to members.
    """
    meta = metadata if metadata is not None else load_context_metadata()
    owner_id = context_owner_id(name, meta)
    asset_access = getattr(repos, "asset_access", None) if repos is not None else None
    if asset_access is None or not owner_id:
        return "private"
    try:
        row = _ensure_brain_pack_row(name, owner_id=owner_id, repos=repos)
        if row:
            return str(row.get("visibility") or "private")
    except Exception:
        logger.debug("brain_pack visibility lookup failed for %s", name, exc_info=True)
    return "private"


def _ensure_assistant_row(
    *,
    user_id: str,
    repos: Optional[Repositories],
) -> Optional[dict[str, Any]]:
    """Lazily upsert + return the workspace assistant's access mirror row.

    The assistant is one shared tool per workspace (default ``workspace``). The
    owner is the workspace owner; on the OSS single-owner engine that is the local
    user. Never raises.
    """
    if repos is None or not user_id:
        return None
    asset_access = getattr(repos, "asset_access", None)
    ensure = getattr(asset_access, "ensure_assistant", None)
    if ensure is None:
        return None
    workspace_id = derive_workspace_id(user_id)
    try:
        return ensure(
            assistant_id=assistant_row_id(workspace_id),
            workspace_id=workspace_id,
            owner_id=user_id,
        )
    except Exception:
        logger.debug("ensure assistant row failed for %s", user_id, exc_info=True)
        return None


def _assistant_access(
    *,
    user_id: str,
    repos: Optional[Repositories],
) -> tuple[Optional[str], str, AssetPermissions]:
    """Resolve (owner_id, visibility, permissions) for the workspace assistant.

    Delegates to the AssetAccessRepository. Falls back to owner-permissive
    workspace defaults when no repo/row is available (OSS single-owner: the local
    user owns + can share the assistant). Never raises.
    """
    asset_access = getattr(repos, "asset_access", None) if repos is not None else None
    workspace_id = derive_workspace_id(user_id)
    aid = assistant_row_id(workspace_id)
    if asset_access is not None:
        _ensure_assistant_row(user_id=user_id, repos=repos)
        try:
            perms = asset_access.get_permissions(
                workspace_id=workspace_id,
                user_id=user_id,
                asset_type="assistant",
                asset_id=aid,
            )
            return (
                str(perms.get("owner_id") or user_id),
                str(perms.get("visibility") or "workspace"),
                AssetPermissions(
                    is_owner=bool(perms.get("is_owner", True)),
                    can_view=bool(perms.get("can_view", True)),
                    can_edit=bool(perms.get("can_edit", True)),
                    can_run=bool(perms.get("can_run", True)),
                    can_delete=bool(perms.get("can_delete", True)),
                    can_share=bool(perms.get("can_share", True)),
                ),
            )
        except Exception:
            logger.debug("assistant permission probe failed", exc_info=True)
    return (user_id, "workspace", AssetPermissions())


def _context_summary(
    name: str,
    metadata: dict[str, dict[str, Any]],
    *,
    worker_count: int = 0,
    repos: Optional[Repositories] = None,
    user_id: Optional[str] = None,
) -> ContextSummary:
    root = context_dir(name)
    files = list(iter_context_files(root))
    total_size = sum(path.stat().st_size for path in files)
    is_system = _is_system_context_pack(name, metadata)
    description = _context_description(root)
    if description is None and is_system:
        description = _system_context_description(name)
    # Members STEP 4: ownership + visibility + computed permissions. System packs
    # are read-only engine config — surface their FS owner but no share rights.
    owner_id = context_owner_id(name, metadata)
    visibility = "private"
    permissions = AssetPermissions()
    if not is_system and user_id is not None:
        owner_id, visibility, permissions = _brain_pack_access(
            name, metadata, user_id=user_id, repos=repos
        )
    elif is_system:
        permissions = AssetPermissions(
            can_edit=False, can_delete=False, can_share=False
        )
    return ContextSummary(
        name=name,
        file_count=len(files),
        total_size_bytes=total_size,
        updated_at=context_updated_at(root),
        writeable=bool(metadata.get(name, {}).get("writeable", False)),
        sensitive=bool(metadata.get(name, {}).get("sensitive", True)),
        category=(metadata.get(name, {}).get("category") or None),  # #780
        worker_count=worker_count,
        description=description,
        system=is_system,
        read_only=is_system,
        owner_id=owner_id,
        visibility=visibility,
        permissions=permissions,
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
    path_prefix: str | None = None,
) -> ContextDetail:
    root = context_dir(name)
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="Context not found")
    meta = metadata if metadata is not None else load_context_metadata()
    # #783: optional path_prefix narrows the (otherwise flat) file list to one
    # subfolder so the Brain UI can navigate nested folders. Normalized to a
    # trailing-slash dir prefix; matched against each file's posix relpath.
    norm_prefix = ""
    if path_prefix and path_prefix.strip("/"):
        norm_prefix = path_prefix.strip("/") + "/"
    files = [
        ContextFileItem(**context_file_metadata(root, path, pack_metadata=meta.get(name) or {}))
        for path in sorted(iter_context_files(root), key=lambda p: p.relative_to(root).as_posix())
        if not norm_prefix or path.relative_to(root).as_posix().startswith(norm_prefix)
    ]
    summary = _context_summary(name, meta, repos=repos, user_id=user_id)
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
    if description is None and summary.system:
        description = _system_context_description(name)
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


def _block_secrets_in_contexts() -> bool:
    """Strict mode (default OFF): reject context writes that contain a live
    credential instead of warning. Env-gated so existing installs see no
    behavior change."""
    return os.environ.get("WORKEROS_BLOCK_SECRETS_IN_CONTEXTS") == "1"


def _scan_context_write(file_path: str, data: bytes) -> List[SecretWarning]:
    """Scan context-write bytes for high-confidence secrets. Returns masked
    warnings only — the raw secret value is never returned or logged.

    In strict mode (WORKEROS_BLOCK_SECRETS_IN_CONTEXTS=1) a non-empty result
    raises 400; the detail names the pattern (masked) and points the operator
    at the Secrets vault.
    """
    findings = scan_bytes(data)
    if not findings:
        return []
    warnings = [SecretWarning(**f.to_dict()) for f in findings]
    if _block_secrets_in_contexts():
        first = warnings[0]
        raise HTTPException(
            status_code=400,
            detail=(
                f"This file appears to contain a live credential "
                f"({first.pattern}: {first.masked}). Store secrets in "
                f"Settings → Secrets, not in a Brain pack."
            ),
        )
    return warnings


def _write_context_file(
    name: str,
    file_path: str,
    data: bytes,
    *,
    user_id: str,
    tags: List[str] | None = None,
    file_metadata: Dict[str, Any] | None = None,
) -> ContextFileItem:
    root = context_dir(name)
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="Context not found")
    # Detective control at the write boundary: scan BEFORE persisting so strict
    # mode can reject without ever writing the secret to disk.
    secret_warnings = _scan_context_write(file_path, data)
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
    if tags is not None or file_metadata is not None:
        pack_meta = set_context_file_metadata(
            name,
            file_path,
            tags=tags,
            file_metadata=file_metadata,
            owner_id=user_id,
        )
    else:
        set_context_metadata(name, owner_id=user_id)
        pack_meta = load_context_metadata().get(name) or {}
    # Persist the warning flag so list/detail views badge the file even after
    # the write response is gone. (Cleared when a later write comes back clean.)
    set_context_file_secret_flag(name, file_path, bool(secret_warnings))
    pack_meta = load_context_metadata().get(name) or pack_meta
    item = ContextFileItem(**context_file_metadata(root, destination, pack_metadata=pack_meta))
    item.secret_warnings = secret_warnings
    item.has_secret_warning = bool(secret_warnings)
    return item


def _record_candidate_feedback_event(
    name: str,
    body: CandidateFeedbackCreateRequest,
    *,
    auth: AuthContext,
    repos: Repositories,
) -> CandidateFeedbackRecord:
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, metadata = _require_context_for_user(
        name,
        user_id=context_user_id,
        repos=repos,
    )
    if not bool((metadata.get(safe_name) or {}).get("writeable", False)):
        raise HTTPException(status_code=400, detail="Candidate feedback requires a writable context.")

    run_id = body.run_id.strip()
    candidate_id = body.candidate_id.strip()
    feedback_text = body.feedback_text.strip()
    reporter = (body.reporter or auth.username or auth.email or auth.user_id).strip()
    if not run_id:
        raise HTTPException(status_code=400, detail="run_id is required.")
    if not candidate_id:
        raise HTTPException(status_code=400, detail="candidate_id is required.")
    if not feedback_text:
        raise HTTPException(status_code=400, detail="feedback_text is required.")
    if not reporter:
        raise HTTPException(status_code=400, detail="reporter is required.")

    now = datetime.now(timezone.utc)
    ts = now.isoformat().replace("+00:00", "Z")
    day = now.date().isoformat()

    for _attempt in range(5):
        event_uuid = str(_uuid_mod.uuid4())
        rel = f"feedback/raw/{day}/{event_uuid}.json"
        if not _safe_context_file_or_400(safe_name, rel).exists():
            break
    else:
        raise HTTPException(status_code=409, detail="Could not allocate feedback event path.")

    event = {
        "uuid": event_uuid,
        "run_id": run_id,
        "candidate_id": candidate_id,
        "rank": body.rank,
        "feedback_text": feedback_text,
        "outcome": body.outcome,
        "scope": body.scope,
        "reporter": reporter,
        "ts": ts,
    }
    _write_context_file(
        safe_name,
        rel,
        (json.dumps(event, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        user_id=context_user_id,
        tags=["candidate-feedback"],
        file_metadata={"kind": "candidate_feedback", "run_id": run_id},
    )
    author_name, author_email = _git_author(auth)
    _git_commit_context(
        safe_name,
        rel,
        message=f"context {safe_name}: record candidate feedback {event_uuid}",
        author_name=author_name,
        author_email=author_email,
    )
    return CandidateFeedbackRecord(**event, path=rel)


async def _read_context_upload_bytes(upload: UploadFile, remaining_bytes: int) -> bytes:
    data = bytearray()
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > remaining_bytes:
            raise HTTPException(
                status_code=413,
                detail=(
                    "Brain upload is too large. Upload files up to "
                    f"{_format_limit_mb(_context_upload_limit_bytes())}."
                ),
            )
    return bytes(data)


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
    repos: Repositories = Depends(get_repos),
) -> List[ContextSummary]:
    context_user_id = _context_actor_user_id(auth.user_id)
    ensure_contexts_dir()
    metadata = load_context_metadata()
    root = current_contexts_root()
    # Compute worker_count for every pack from a single workers.list() call so
    # the LIST row matches the DETAIL view (used_by) without N+1 queries.
    worker_counts = _context_worker_counts(repos, context_user_id)
    operator_items: List[ContextSummary] = []
    system_items: List[ContextSummary] = []
    for folder in sorted(root.iterdir(), key=lambda p: p.name):
        if not folder.is_dir() or folder.is_symlink() or folder.name.startswith("."):
            continue
        # System/engine packs are surfaced read-only so operators can see what
        # shapes worker generation; they cannot be edited or deleted.
        if _is_system_context_pack(folder.name, metadata):
            system_items.append(_context_summary(
                folder.name, metadata, worker_count=worker_counts.get(folder.name, 0)
            ))
            continue
        if _context_visible_to_user(
            folder.name, user_id=context_user_id, metadata=metadata, repos=repos
        ):
            operator_items.append(_context_summary(
                folder.name,
                metadata,
                worker_count=worker_counts.get(folder.name, 0),
                repos=repos,
                user_id=context_user_id,
            ))
    # Operator packs first, then read-only system packs.
    return operator_items + system_items


@app.post("/contexts/{name}", response_model=ContextDetail)
def create_context(
    name: str,
    payload: Optional[ContextCreateRequest] = Body(default=None),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name = _context_name_or_400(name)
    root = context_dir(safe_name)
    metadata = load_context_metadata()
    if root.exists():
        if not _context_visible_to_user(
            safe_name, user_id=context_user_id, metadata=metadata, repos=repos
        ):
            raise HTTPException(status_code=404, detail="Context not found")
        raise HTTPException(status_code=409, detail="Context already exists")
    root.mkdir(parents=True)
    set_context_metadata(
        safe_name,
        writeable=bool(payload.writeable) if payload else False,
        sensitive=bool(payload.sensitive) if payload else True,
        owner_id=context_user_id,
        category=(payload.category if payload else None),  # #780
    )
    # Materialize the access-control mirror row (default private) so the Share
    # control + permission checks work immediately. Members STEP 4.
    _ensure_brain_pack_row(safe_name, owner_id=context_user_id, repos=repos)
    return _context_detail(safe_name, repos=repos, user_id=context_user_id)


@app.put("/contexts/{name}/category", response_model=ContextDetail)
def set_context_category(
    name: str,
    payload: ContextCategoryRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    """#780: set/clear a brain pack's content-category tag (marketing,
    accounting, research, data, ...). Empty/null clears it."""
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, _metadata = _require_context_for_user(name, user_id=context_user_id)
    set_context_metadata(safe_name, category=(payload.category or ""))
    return _context_detail(safe_name, repos=repos, user_id=context_user_id)


@app.get("/contexts/{name}", response_model=ContextDetail)
def get_context(
    name: str,
    path_prefix: Optional[str] = None,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, metadata = _require_readable_context_for_user(
        name, user_id=context_user_id, repos=repos
    )
    # #783: ?path_prefix=reports filters the file list to that subfolder.
    return _context_detail(
        safe_name, metadata, repos=repos, user_id=context_user_id, path_prefix=path_prefix
    )


@app.put("/contexts/{name}/visibility", response_model=ContextDetail)
def set_context_visibility(
    name: str,
    payload: ContextVisibilityUpdate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    """Set a brain pack's visibility (Private <-> Shared with workspace).

    Owner/admin only. The AssetAccessRepository enforces ``can_share`` + the enum;
    a non-owner without share rights gets 403. On the OSS single-owner engine the
    local user owns their packs, so this always succeeds for them. System/engine
    packs are read-only (404 from the require helper). 404 for an invisible pack.
    """
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, metadata = _require_context_for_user(
        name, user_id=context_user_id, repos=repos
    )
    asset_access = getattr(repos, "asset_access", None)
    if asset_access is None or not hasattr(asset_access, "set_visibility"):
        raise HTTPException(status_code=501, detail="Visibility control not available")

    owner_id = context_owner_id(safe_name, metadata)
    if not owner_id:
        raise HTTPException(
            status_code=409,
            detail="This pack is read-only and its visibility cannot be changed.",
        )
    # Ensure the mirror row exists before flipping visibility.
    _ensure_brain_pack_row(safe_name, owner_id=owner_id, repos=repos)
    try:
        result = asset_access.set_visibility(
            workspace_id=derive_workspace_id(owner_id),
            actor_id=context_user_id,
            asset_type="brain_pack",
            asset_id=safe_name,
            visibility=payload.visibility,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Context not found")
    return _context_detail(safe_name, repos=repos, user_id=context_user_id)


class ContextSensitiveRequest(BaseModel):
    sensitive: bool


@app.patch("/contexts/{name}/sensitive")
def set_context_sensitive(
    name: str,
    body: ContextSensitiveRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    """Mark a brain pack as sensitive (skips git + GitHub, Supabase Storage only).

    Sensitive contexts are encrypted at rest in Supabase Storage but never
    committed to git, never appear in git history, and never pushed to any
    connected GitHub repo. Toggle off to resume git tracking from the next write.
    """
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, _metadata = _require_context_for_user(name, user_id=context_user_id)
    set_context_metadata(safe_name, sensitive=body.sensitive)
    return {"name": safe_name, "sensitive": body.sensitive}


@app.delete("/contexts/{name}", response_model=ContextDeleteResponse)
def delete_context(
    name: str,
    force: bool = Query(False),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDeleteResponse:
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, _metadata = _require_context_for_user(name, user_id=context_user_id)
    root = context_dir(safe_name)
    referenced_by = _workers_referencing_context(safe_name, user_id=context_user_id, repos=repos)
    if referenced_by and not force:
        raise HTTPException(
            status_code=409,
            detail={"message": "Context is referenced by workers", "referenced_by": referenced_by},
        )
    shutil.rmtree(root)
    delete_context_metadata(safe_name)
    # Record the deletion in git so the history is preserved but the directory is gone.
    _git_commit_context(safe_name, message=f"context {safe_name}: delete")
    return ContextDeleteResponse(status="deleted", referenced_by=referenced_by)


@app.get("/contexts/{name}/files/{file_path:path}")
def get_context_file(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
):
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, _metadata = _require_readable_context_for_user(name, user_id=context_user_id)
    rel = _context_file_path_or_400(file_path)
    target = _safe_context_file_or_400(safe_name, rel)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Context file not found")
    mime_type = guess_mime_type(rel)
    headers = {"Cache-Control": "no-store"}
    if is_binary_file(rel, mime_type):
        headers["Content-Disposition"] = f'attachment; filename="{Path(rel).name}"'
        return FileResponse(target, media_type=mime_type, headers=headers)
    # Active markup (html, svg, xhtml, xml) is "text" but a browser would
    # EXECUTE it inline — that is stored XSS for an uploaded context file.
    # Force download AND neutralize the content-type so it can never run in
    # our origin. Safe-preview text (md/txt/json/py/yaml/...) still serves
    # inline below.
    if is_active_markup(rel, mime_type):
        headers["Content-Disposition"] = f'attachment; filename="{Path(rel).name}"'
        headers["X-Content-Type-Options"] = "nosniff"
        return Response(
            content=target.read_bytes(),
            media_type="text/plain; charset=utf-8",
            headers=headers,
        )
    return Response(content=target.read_bytes(), media_type=mime_type, headers=headers)




@app.put("/contexts/{name}/files/{file_path:path}", response_model=ContextFileItem)
async def put_context_file(
    name: str,
    file_path: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextFileItem:
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, _metadata = _require_context_for_user(name, user_id=context_user_id)
    rel = _context_file_path_or_400(file_path)
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type == "application/json":
        try:
            payload = ContextTextWriteRequest(**(await request.json()))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON body: {exc}") from exc
        data = payload.content.encode("utf-8")
        tags = payload.tags
        file_metadata = payload.metadata
    else:
        data = await request.body()
        tags = None
        file_metadata = None
    result = _write_context_file(
        safe_name,
        rel,
        data,
        user_id=context_user_id,
        tags=tags,
        file_metadata=file_metadata,
    )
    author_name, author_email = _git_author(auth)
    _git_commit_context(safe_name, rel, message=f"context {safe_name}: update {rel}", author_name=author_name, author_email=author_email)
    return result


@app.post(
    "/contexts/{name}/record-candidate-feedback",
    response_model=CandidateFeedbackRecord,
    status_code=201,
)
def record_candidate_feedback(
    name: str,
    body: CandidateFeedbackCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> CandidateFeedbackRecord:
    return _record_candidate_feedback_event(name, body, auth=auth, repos=repos)


@app.delete("/contexts/{name}/files/{file_path:path}", response_model=ContextDetail)
def delete_context_file(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, metadata = _require_context_for_user(name, user_id=context_user_id)
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
    set_context_file_metadata(safe_name, rel, tags=[], file_metadata={}, owner_id=context_user_id)
    author_name, author_email = _git_author(auth)
    _git_commit_context(safe_name, rel, message=f"context {safe_name}: delete {rel}", author_name=author_name, author_email=author_email)
    return _context_detail(safe_name, repos=repos, user_id=context_user_id)


class _SqliteView(BaseModel):
    tables: List[str] = Field(default_factory=list)
    table: Optional[str] = None
    columns: Optional[List[str]] = None
    rows: Optional[List[List[Any]]] = None
    row_count: Optional[int] = None
    truncated: Optional[bool] = None


@app.get("/contexts/{name}/sqlite/{file_path:path}", response_model=_SqliteView)
def view_context_sqlite(
    name: str,
    file_path: str,
    table: Optional[str] = None,
    limit: int = 100,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _SqliteView:
    """#777: inspect a brain .db file — list tables, or read a table's rows.
    Opens the file READ-ONLY; table name is validated against the real table
    list before use (no injection); rows are capped and BLOBs are summarised."""
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, _meta = _require_context_for_user(name, user_id=context_user_id)
    rel = _context_file_path_or_400(file_path)
    target = _safe_context_file_or_400(safe_name, rel)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Context file not found")
    if not rel.lower().endswith((".db", ".sqlite", ".sqlite3")):
        raise HTTPException(status_code=400, detail="Not a SQLite database file")
    capped = max(1, min(int(limit or 100), 500))

    def _cell(v: Any) -> Any:
        return f"<{len(v)} bytes>" if isinstance(v, (bytes, bytearray)) else v

    try:
        conn = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not open database: {exc}") from exc
    try:
        names = [
            str(r[0]) for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).fetchall()
        ]
        if not table:
            return _SqliteView(tables=names)
        if table not in names:
            raise HTTPException(status_code=404, detail="Table not found")
        cur = conn.execute(f'SELECT * FROM "{table}" LIMIT ?', (capped + 1,))
        columns = [str(d[0]) for d in cur.description] if cur.description else []
        fetched = cur.fetchall()
        truncated = len(fetched) > capped
        rows = [[_cell(c) for c in row] for row in fetched[:capped]]
        return _SqliteView(
            tables=names, table=table, columns=columns,
            rows=rows, row_count=len(rows), truncated=truncated,
        )
    finally:
        conn.close()


@app.post("/contexts/{name}/files/{file_path:path}/move", response_model=ContextFileItem)
def move_context_file(
    name: str,
    file_path: str,
    payload: ContextFileMoveRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextFileItem:
    """#770: move/rename a brain file within a context, preserving git history.

    DELETE old + PUT new loses version history; this renames on disk and
    commits both paths so git records it as a rename.
    """
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, _metadata = _require_context_for_user(name, user_id=context_user_id)
    old_rel = _context_file_path_or_400(file_path)
    new_rel = _context_file_path_or_400(payload.new_path)
    if old_rel == new_rel:
        raise HTTPException(status_code=400, detail="new_path is the same as the current path")
    src = _safe_context_file_or_400(safe_name, old_rel)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="Context file not found")
    dst = _safe_context_file_or_400(safe_name, new_rel)
    if dst.exists():
        raise HTTPException(status_code=409, detail="A file already exists at new_path")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    # carry metadata to the new path, clear the old
    old_meta = (load_context_metadata().get(safe_name, {}).get("files", {}) or {}).get(old_rel, {})
    set_context_file_metadata(
        safe_name, new_rel,
        tags=old_meta.get("tags", []) or [],
        file_metadata=old_meta.get("metadata", {}) or {},
        owner_id=context_user_id,
    )
    set_context_file_metadata(safe_name, old_rel, tags=[], file_metadata={}, owner_id=context_user_id)
    # prune now-empty source dirs
    for parent in src.parents:
        if parent == context_dir(safe_name):
            break
        try:
            parent.rmdir()
        except OSError:
            break
    author_name, author_email = _git_author(auth)
    _git_commit_context(
        safe_name, message=f"context {safe_name}: move {old_rel} -> {new_rel}",
        author_name=author_name, author_email=author_email,
    )
    root = context_dir(safe_name)
    meta = load_context_metadata()
    return ContextFileItem(**context_file_metadata(root, dst, pack_metadata=meta.get(safe_name) or {}))


@app.post("/contexts/{name}/upload", response_model=ContextUploadResponse)
async def upload_context_files(
    name: str,
    files: List[UploadFile] = File(...),
    path_prefix: str = Form(""),
    tags_json: str = Form(""),
    metadata_json: str = Form(""),
    create_if_missing: bool = Form(True),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextUploadResponse:
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name = _context_name_or_400(name)
    root = context_dir(safe_name)
    if root.is_dir():
        safe_name, _metadata = _require_context_for_user(
            safe_name,
            user_id=context_user_id,
            repos=repos,
        )
    elif create_if_missing:
        if _user_scoped_local_mode() or _is_cloud_deploy():
            raise HTTPException(status_code=404, detail="Context not found")
        root.mkdir(parents=True, exist_ok=True)
        set_context_metadata(safe_name, writeable=True, owner_id=context_user_id)
        _ensure_brain_pack_row(safe_name, owner_id=context_user_id, repos=repos)
    else:
        raise HTTPException(status_code=404, detail="Context not found")
    raw_prefix = path_prefix.strip().strip("/")
    prefix = _context_file_path_or_400(raw_prefix) if raw_prefix else ""
    upload_tags: List[str] | None = None
    upload_metadata: Dict[str, Any] | None = None
    if tags_json.strip():
        try:
            parsed_tags = json.loads(tags_json)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid tags_json: {exc}") from exc
        if not isinstance(parsed_tags, list):
            raise HTTPException(status_code=400, detail="tags_json must be a JSON array")
        upload_tags = [str(tag) for tag in parsed_tags]
    if metadata_json.strip():
        try:
            parsed_metadata = json.loads(metadata_json)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid metadata_json: {exc}") from exc
        if not isinstance(parsed_metadata, dict):
            raise HTTPException(status_code=400, detail="metadata_json must be a JSON object")
        upload_metadata = dict(parsed_metadata)
    written: List[ContextFileItem] = []
    written_paths: List[str] = []
    total_upload_bytes = 0
    upload_limit = _context_upload_limit_bytes()
    for upload in files:
        filename = _context_file_path_or_400(upload.filename or "upload.bin")
        rel = f"{prefix}/{filename}" if prefix else filename
        data = await _read_context_upload_bytes(upload, upload_limit - total_upload_bytes)
        total_upload_bytes += len(data)
        written.append(
            _write_context_file(
                safe_name,
                rel,
                data,
                user_id=context_user_id,
                tags=upload_tags,
                file_metadata=upload_metadata,
            )
        )
        written_paths.append(rel)
    author_name, author_email = _git_author(auth)
    _git_commit_context(safe_name, message=f"context {safe_name}: upload {len(written_paths)} file(s)", author_name=author_name, author_email=author_email)
    return ContextUploadResponse(
        files=written,
        total_size_bytes=context_total_size(context_dir(safe_name)),
    )


@app.get("/contexts/{name}/secret-scan", response_model=ContextSecretScanResponse)
def scan_context_for_secrets(
    name: str,
    auth: AuthContext = Depends(get_auth_context),
) -> ContextSecretScanResponse:
    """Audit a Brain pack's CURRENT files for stored live credentials.

    Owner-gated (operator must own/see the pack; the whole /contexts surface
    also requires x-floom-secret). This is the control that would have caught
    keys already stored as readable context content. Returns only masked
    findings — never the raw value — and refreshes the persisted
    has_secret_warning flag so the UI badge stays accurate.
    """
    context_user_id = _context_actor_user_id(auth.user_id)
    safe_name, _metadata = _require_readable_context_for_user(name, user_id=context_user_id)
    root = context_dir(safe_name)
    scanned = 0
    flagged: List[ContextSecretScanFile] = []
    for path in iter_context_files(root):
        rel = path.relative_to(root).as_posix()
        mime_type = guess_mime_type(rel)
        if is_binary_file(rel, mime_type):
            continue
        scanned += 1
        try:
            data = path.read_bytes()
        except Exception:
            continue
        findings = scan_bytes(data)
        warnings = [SecretWarning(**f.to_dict()) for f in findings]
        # Refresh the persisted flag so list/detail badges reflect reality.
        try:
            set_context_file_secret_flag(safe_name, rel, bool(warnings))
        except Exception:
            pass
        if warnings:
            flagged.append(ContextSecretScanFile(path=rel, secret_warnings=warnings))
    return ContextSecretScanResponse(
        name=safe_name,
        scanned_files=scanned,
        flagged_files=flagged,
    )


class WorkerListSummary(WorkerSummary):
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SearchResultItem(BaseModel):
    type: str  # "worker" | "run" | "brain" | "connection"
    id: str
    title: str
    subtitle: Optional[str] = None
    url: Optional[str] = None


class SearchResponse(BaseModel):
    results: List[SearchResultItem]


@app.get("/search", response_model=SearchResponse)
def global_search(
    q: str = Query(..., min_length=1),
    types: str = "workers,runs,brain,connections",
    limit: int = Query(20, ge=1, le=100),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> SearchResponse:
    """#806: global ⌘K search across workers, runs, brain packs, and
    connections (case-insensitive substring), owner/visibility scoped. Each
    type is capped so one source can't crowd out the others."""
    needle = q.strip().lower()
    wanted = {t.strip() for t in types.split(",") if t.strip()}
    per_type = max(3, limit // max(1, len(wanted)))
    results: List[SearchResultItem] = []

    if "workers" in wanted:
        for w in _list_visible_workers(user_id=auth.user_id, repos=repos, use_cache=True):
            if needle in str(w.get("name") or "").lower() or needle in str(w.get("description") or "").lower():
                results.append(SearchResultItem(
                    type="worker", id=str(w["id"]),
                    title=str(w.get("name") or w["id"]),
                    subtitle=(str(w.get("description") or "") or None),
                    url=f"/workers/{w['id']}",
                ))
                if sum(1 for r in results if r.type == "worker") >= per_type:
                    break

    if "brain" in wanted:
        try:
            for c in list_contexts(auth=auth, repos=repos):
                if needle in c.name.lower() or needle in str(c.description or "").lower():
                    results.append(SearchResultItem(
                        type="brain", id=c.name, title=c.name,
                        subtitle=(c.description or None), url=f"/brain/{c.name}",
                    ))
                    if sum(1 for r in results if r.type == "brain") >= per_type:
                        break
        except Exception:
            logger.debug("search: brain enumeration failed", exc_info=True)

    if "connections" in wanted:
        try:
            for row in repos.connections.list(user_id=auth.user_id):
                d = row_to_dict(row)
                app = str(d.get("app_name") or "")
                label = str(d.get("mcp_label") or "")
                if needle in app.lower() or needle in label.lower():
                    results.append(SearchResultItem(
                        type="connection", id=str(d.get("id")),
                        title=label or app, subtitle=(app or None),
                        url="/connections",
                    ))
                    if sum(1 for r in results if r.type == "connection") >= per_type:
                        break
        except Exception:
            logger.debug("search: connection enumeration failed", exc_info=True)

    if "runs" in wanted:
        try:
            rows, _ = _list_visible_runs(
                user_id=auth.user_id, repos=repos, worker_id=None, statuses=None,
                since=None, until=None, limit=200, offset=0, include_system=False,
            )
            for r in rows:
                d = row_to_dict(r)
                rid = str(d.get("id") or "")
                wname = str(d.get("worker_name") or "")
                if needle in rid.lower() or needle in wname.lower():
                    results.append(SearchResultItem(
                        type="run", id=rid, title=(wname or rid),
                        subtitle=str(d.get("status") or "") or None,
                        url=f"/runs/{rid}",
                    ))
                    if sum(1 for r2 in results if r2.type == "run") >= per_type:
                        break
        except Exception:
            logger.debug("search: run enumeration failed", exc_info=True)

    return SearchResponse(results=results[:limit])


def _starred_worker_ids(user_id: str) -> set[str]:
    """#782: the set of worker ids the user has starred."""
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT worker_id FROM user_worker_prefs WHERE user_id = ? AND starred = 1",
                (user_id,),
            ).fetchall()
        return {str(r["worker_id"]) for r in rows}
    except Exception:
        return set()


def _toggle_worker_star(user_id: str, worker_id: str) -> bool:
    """#782: flip the star for (user, worker); returns the new state."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT starred FROM user_worker_prefs WHERE user_id = ? AND worker_id = ?",
            (user_id, worker_id),
        ).fetchone()
        new_state = 0 if (row and row["starred"]) else 1
        conn.execute(
            """
            INSERT INTO user_worker_prefs (user_id, worker_id, starred, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, worker_id) DO UPDATE SET
                starred = excluded.starred, updated_at = excluded.updated_at
            """,
            (user_id, worker_id, new_state, now_iso()),
        )
    return bool(new_state)


@app.get("/workers", response_model=List[WorkerListSummary])
def list_workers(
    include_system: bool = False,
    include_archived: bool = False,
    shape: str = "full",
    visibility: Optional[str] = None,
    q: Optional[str] = None,
    starred: Optional[bool] = None,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[WorkerListSummary]:
    """List workers.

    ?shape=list           — trimmed payload (~15 KB for 18 workers) for the web UI list view.
                            Drops: long_description, use_cases, example_input, example_output,
                            how_it_works, timeseries. Keeps all fields needed to render the card.
    ?shape=full           — full payload (default, backwards-compat for CLI + MCP consumers).
    ?include_archived=true — include archived workers (archived:true in worker.yml).
                             Default: excluded from All/Starred/Recent; shown only in Archived view.
    """
    worker_user_id = _worker_access_user_id(auth)
    workers = _list_visible_workers(
        user_id=worker_user_id,
        repos=repos,
        use_cache=True,
        role=_worker_repo_role(auth),
    )
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
    # #771: optional visibility-tier filter. Does NOT change access control —
    # only shapes the already-authorized list. "all" is the default no-op.
    if visibility and visibility != "all":
        if visibility not in ("private", "workspace", "public"):
            raise HTTPException(status_code=422, detail="visibility must be private, workspace, public, or all")
        workers = [
            w for w in workers
            if str(w.get("visibility") or "private") == visibility
        ]
    # #779: server-side substring search on name + description (case-insensitive),
    # so large workspaces don't ship the full list to the client to filter.
    if q and q.strip():
        needle = q.strip().lower()
        workers = [
            w for w in workers
            if needle in str(w.get("name") or "").lower()
            or needle in str(w.get("description") or "").lower()
        ]
    # #782: per-user star set; optional ?starred=true filter feeds the
    # "starred" tag tab.
    _starred_ids = _starred_worker_ids(auth.user_id)
    if starred:
        workers = [w for w in workers if w["id"] in _starred_ids]
    worker_ids = [w["id"] for w in workers]
    stats_by_id = _get_stats_batch(worker_ids, user_id=worker_user_id, repos=repos)
    # S44 Win 3: skip expensive timeseries fetch when list shape requested.
    list_shape = shape == "list"
    timeseries_by_id = (
        {} if list_shape
        else _get_timeseries_batch(worker_ids, user_id=worker_user_id, repos=repos, days=14)
    )
    available_secret_names = _available_secret_names_for_user(worker_user_id, repos)
    available_conn_slugs = _available_connection_slugs_for_user(worker_user_id, repos)
    result: List[WorkerListSummary] = []
    for w in workers:
        last_run_row = _get_last_run_for_worker(w["id"], user_id=worker_user_id, repos=repos)
        last_run = _make_run_summary(last_run_row) if last_run_row else None

        # Resolve status via the SHARED resolver so LIST and DETAIL agree
        # exactly for the same worker (full honesty ladder: missing-secret /
        # failed-run / disabled / never-run, see _resolve_worker_status).
        config = get_worker_config_for_run(w["id"])
        is_archived = w.get("archived", False)
        status = _resolve_worker_status(
            w,
            config=config,
            available_secret_names=available_secret_names,
            last_run_status=last_run.status if last_run else None,
            has_run=last_run is not None,
        )

        triggers = _build_triggers_list(w)
        triggers_spec = _build_triggers_spec(w)
        recent_stats = stats_by_id.get(w["id"])
        timeseries = timeseries_by_id.get(w["id"])

        # #556: compute which required secrets/connections are not yet configured.
        _secret_set = set(available_secret_names)
        _req_secrets = _worker_required_secret_names(w) if config else []
        _missing_secrets = [s for s in _req_secrets if s not in _secret_set]
        _req_conn_slugs = _worker_connection_slugs(w)
        _missing_connections = [c for c in _req_conn_slugs if c.lower() not in available_conn_slugs]

        # Extract connection slugs and runtime from worker config dict.
        # These are lightweight and needed for the worker card tool-logo strip.
        _worker_config_dict = w.get("config") or {}
        _raw_connections = _worker_config_dict.get("connections") or w.get("connections") or []
        _conn_slugs = [
            slug
            for c in _raw_connections
            if (slug := _connection_slug_for_worker_card(c))
        ]
        _raw_runtime = _worker_config_dict.get("runtime") or {}
        _runtime_type = (
            _raw_runtime.get("type") if isinstance(_raw_runtime, dict)
            else (str(_raw_runtime) if _raw_runtime else None)
        )
        _inputs = []
        for _raw_input in _worker_config_dict.get("inputs") or []:
            if isinstance(_raw_input, dict):
                try:
                    if list_shape:
                        _inputs.append(
                            WorkerSummaryInput(
                                name=str(_raw_input["name"]),
                                type=str(_raw_input["type"]),
                            )
                        )
                    else:
                        _inputs.append(WorkerInput(**_raw_input))
                except Exception:
                    continue

        result.append(
            WorkerListSummary(
                id=w["id"],
                name=w["name"],
                created_at=w.get("created_at"),
                updated_at=w.get("updated_at"),
                description=w.get("description"),
                # S44 Win 3: omit detail-only fields in list shape.
                long_description=None if list_shape else w.get("long_description"),
                use_cases=None if list_shape else w.get("use_cases"),
                example_input=None if list_shape else w.get("example_input"),
                example_output=None if list_shape else w.get("example_output"),
                how_it_works=None if list_shape else w.get("how_it_works"),
                is_example=w.get("is_example"),
                system=bool((w.get("manifest") or {}).get("system_worker", False)),
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
                missing_secrets=_missing_secrets,
                missing_connections=_missing_connections,
                inputs=_inputs,
                runtime=_runtime_type,
                public_link=_worker_public_link(w) if str(w.get("visibility") or "private") == "public" else None,
                owner_id=w.get("owner_id"),
                visibility=str(w.get("visibility") or "private"),
                starred=w["id"] in _starred_ids,  # #782
                permissions=_worker_permissions(
                    w,
                    user_id=worker_user_id,
                    repos=repos,
                    owner_aliases={auth.user_id, auth.username or ""},
                ),
            )
        )
    return result


def _worker_public_payload(worker: Dict[str, Any]) -> str:
    """Stable HMAC payload for a worker share link.

    Bound to both the worker id AND its owner so a link minted for one owner's
    worker can never resolve a same-id worker owned by someone else (defense in
    depth alongside the owner-scoped detail build).
    """
    return ".".join(
        ("worker", str(worker.get("id") or ""), str(worker.get("owner_id") or ""))
    )


def _worker_public_token(worker: Dict[str, Any]) -> str:
    # #998: never sign/verify a public share token with a public constant —
    # a missing secret would let anyone forge share links. Fail closed.
    secret = (os.environ.get("FLOOM_SECRET") or "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="Server signing secret not configured")
    return hmac.new(
        secret.encode("utf-8"),
        _worker_public_payload(worker).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _worker_public_link(worker: Dict[str, Any]) -> Optional[str]:
    """Owner-only standalone share URL for a worker (or None if id is missing)."""
    worker_id = str(worker.get("id") or "")
    if not worker_id:
        return None
    token = _worker_public_token(worker)
    return f"{_frontend_base_url()}/w/{worker_id}?token={token}"


def _standalone_share_url(token: str) -> str:
    return f"{_frontend_base_url()}/s/{urllib.parse.quote(token, safe='')}"


def _public_noindex_headers() -> Dict[str, str]:
    return {
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "no-store",
    }


def _short_link_base_url() -> str:
    return (os.environ.get("WORKEROS_SHORT_LINK_BASE_URL") or "https://floom.dev/s").rstrip("/")


def _mint_worker_short_id() -> str:
    return f"fls_{pysecrets.token_urlsafe(8).replace('-', '').replace('_', '')[:10]}"


def _mint_standalone_share_token() -> str:
    return f"fls_{pysecrets.token_urlsafe(18).replace('-', '').replace('_', '')[:24]}"


def _hash_share_token(token: str) -> str:
    """#934: share tokens are bearer credentials — store only their SHA-256."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


_SHARE_LINKS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS standalone_share_links (
        token_hash TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        file_path TEXT NOT NULL DEFAULT '',
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(entity_type, entity_id, file_path, owner_id)
    );
    CREATE INDEX IF NOT EXISTS idx_standalone_share_links_entity
        ON standalone_share_links(entity_type, entity_id, file_path, owner_id);
"""


def _ensure_standalone_share_links_table() -> None:
    with get_db() as conn:
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(standalone_share_links)")}
        if "token" in cols and "token_hash" not in cols:
            # #934 migration: legacy rows stored the raw token. Hash them in
            # place so a database dump no longer hands out every active link.
            rows = conn.execute(
                "SELECT token, entity_type, entity_id, file_path, owner_id, created_at "
                "FROM standalone_share_links"
            ).fetchall()
            conn.execute("ALTER TABLE standalone_share_links RENAME TO standalone_share_links_legacy")
            conn.executescript(_SHARE_LINKS_TABLE_SQL)
            for row in rows:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO standalone_share_links
                        (token_hash, entity_type, entity_id, file_path, owner_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        _hash_share_token(str(row["token"])),
                        row["entity_type"],
                        row["entity_id"],
                        row["file_path"],
                        row["owner_id"],
                        row["created_at"],
                    ),
                )
            conn.execute("DROP TABLE standalone_share_links_legacy")
            return
        conn.executescript(_SHARE_LINKS_TABLE_SQL)


def _create_or_get_standalone_share_link(
    *,
    entity_type: Literal["worker", "brain_file", "brain_pack", "run"],
    entity_id: str,
    owner_id: str,
    file_path: str = "",
) -> Dict[str, str]:
    safe_file_path = file_path or ""
    if not entity_id or not owner_id:
        raise HTTPException(status_code=409, detail="Item cannot be shared")
    _ensure_standalone_share_links_table()
    # #934: only SHA-256(token) is stored, so the raw value of an existing row
    # cannot be returned — re-sharing ROTATES the link (the old URL stops
    # resolving). Revocation already deleted-and-reminted, so rotation is the
    # established product semantic for share links.
    token = ""
    ts = now_iso()
    with get_db() as conn:
        for _ in range(8):
            candidate = _mint_standalone_share_token()
            try:
                conn.execute(
                    """
                    INSERT INTO standalone_share_links
                        (token_hash, entity_type, entity_id, file_path, owner_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(entity_type, entity_id, file_path, owner_id) DO UPDATE SET
                        token_hash = excluded.token_hash,
                        created_at = excluded.created_at
                    """,
                    (_hash_share_token(candidate), entity_type, entity_id, safe_file_path, owner_id, ts),
                )
                token = candidate
                break
            except sqlite3.IntegrityError:
                # token_hash PK collision (astronomically unlikely) — retry.
                continue
    if not token:
        raise HTTPException(status_code=500, detail="Could not create share link")
    return {
        "token": token,
        "url": _standalone_share_url(token),
        "entity_type": entity_type,
    }


def _ensure_worker_short_links_table() -> None:
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS worker_short_links (
                short_id TEXT PRIMARY KEY,
                worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
                owner_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(worker_id, owner_id)
            );
            CREATE INDEX IF NOT EXISTS idx_worker_short_links_worker_owner
                ON worker_short_links(worker_id, owner_id);
            """
        )


def _worker_short_link_response(worker: Dict[str, Any]) -> Dict[str, str]:
    worker_id = str(worker.get("id") or "")
    owner_id = str(worker.get("owner_id") or "")
    if not worker_id or not owner_id:
        raise HTTPException(status_code=409, detail="Worker cannot be shared")
    _ensure_worker_short_links_table()
    with get_db() as conn:
        existing = conn.execute(
            """
            SELECT short_id FROM worker_short_links
            WHERE worker_id = ? AND owner_id = ?
            LIMIT 1
            """,
            (worker_id, owner_id),
        ).fetchone()
        if existing:
            short_id = str(existing["short_id"])
        else:
            ts = now_iso()
            for _ in range(5):
                short_id = _mint_worker_short_id()
                try:
                    conn.execute(
                        """
                        INSERT INTO worker_short_links (short_id, worker_id, owner_id, created_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (short_id, worker_id, owner_id, ts),
                    )
                    break
                except sqlite3.IntegrityError:
                    owner_existing = conn.execute(
                        """
                        SELECT short_id FROM worker_short_links
                        WHERE worker_id = ? AND owner_id = ?
                        LIMIT 1
                        """,
                        (worker_id, owner_id),
                    ).fetchone()
                    if owner_existing:
                        short_id = str(owner_existing["short_id"])
                        break
                    short_id = ""
            if not short_id:
                raise HTTPException(status_code=500, detail="Could not mint short link")
    return {"short_id": short_id, "short_url": f"{_short_link_base_url()}/{short_id}"}


def _worker_permissions(
    worker: Dict[str, Any],
    *,
    user_id: str,
    repos: Repositories,
    owner_aliases: Optional[set[str]] = None,
) -> AssetPermissions:
    """Compute the requesting user's access matrix for a worker.

    Delegates to the AssetAccessRepository when available (the engine-owned,
    Cloud-mirrorable rule). Falls back to an owner-permissive default for
    filesystem/stock workers that have no DB row (the caller is the de-facto
    owner of a stock worker they can see), so the OSS single-owner UX is
    unchanged. Never raises — a permission probe must not break a list/detail.
    """
    asset_access = getattr(repos, "asset_access", None)
    worker_id = str(worker.get("id") or "")
    owner_id = str(worker.get("owner_id") or "")
    visibility = str(worker.get("visibility") or "private")
    # #767/#768: a specific-people grant adds VIEW access for the grantee, never
    # run/edit/delete/share (those stay with the owner / workspace admins). The
    # engine asset_access rule does not know about the app-level asset_grants
    # table, so the grant is layered in here.
    granted = bool(worker_id) and _canonical_worker_id(worker_id) in _granted_worker_ids()
    aliases = {user_id}
    if owner_aliases:
        aliases.update(alias for alias in owner_aliases if alias)
    is_owner = (not owner_id) or owner_id in aliases
    if asset_access is not None and worker_id and owner_id:
        try:
            perms = asset_access.get_permissions(
                workspace_id=str(worker.get("workspace_id") or "local-default"),
                user_id=user_id,
                asset_type="worker",
                asset_id=worker_id,
            )
            return AssetPermissions(
                is_owner=is_owner or bool(perms.get("is_owner", False)),
                can_view=is_owner or bool(perms.get("can_view", True)) or granted,
                can_edit=is_owner or bool(perms.get("can_edit", True)),
                can_run=is_owner or bool(perms.get("can_run", True)),
                can_delete=is_owner or bool(perms.get("can_delete", True)),
                can_share=is_owner or bool(perms.get("can_share", True)),
            )
        except Exception:
            logger.debug("permission probe failed for worker %s", worker_id, exc_info=True)
    # Fallback: stock/FS worker (no DB row) — the viewer who can see it is the
    # de-facto owner on the single-owner engine.
    shared = visibility == "workspace"
    return AssetPermissions(
        is_owner=is_owner,
        can_view=is_owner or shared or granted,
        can_edit=is_owner,
        can_run=is_owner or shared,
        can_delete=is_owner,
        can_share=is_owner,
    )


def _public_connection_labels(config: WorkerConfig) -> List[str]:
    """Public, display-only tool/connection identifiers.

    Composio connections are plain app slugs (safe). MCP connections expose only
    their human LABEL — never the server url, env, command, args, or auth value,
    which can carry internal infrastructure detail or credentials.
    """
    labels: List[str] = []
    for connection in (config.connections or []):
        if isinstance(connection, str):
            slug = connection.strip()
            if slug:
                labels.append(slug)
        else:
            # WorkerConnection(mcp=WorkerMCPConnection(...)) — expose the human
            # label only, never the url/env/command/auth.
            mcp = getattr(connection, "mcp", None)
            label = (getattr(mcp, "label", "") or "").strip() if mcp else ""
            if label:
                labels.append(label)
    return labels


def _public_worker_response(worker: Dict[str, Any], config: WorkerConfig) -> PublicWorker:
    """Project a full worker dict + parsed config into the public allow-list.

    NOTHING outside the ``PublicWorker`` field set leaves this function: no
    secrets, no source files, no run history, no owner id, no webhook url, no
    config internals (bundle paths, MCP urls/env). Inputs and outputs are
    re-projected through ``PublicWorkerInput`` / ``PublicWorkerOutput`` so a
    future sensitive field on ``WorkerInput`` is not auto-forwarded.
    """
    return PublicWorker(
        id=str(worker.get("id") or config.id),
        name=str(worker.get("name") or config.name),
        description=worker.get("description"),
        long_description=worker.get("long_description"),
        use_cases=worker.get("use_cases"),
        how_it_works=worker.get("how_it_works"),
        is_example=worker.get("is_example"),
        tags=worker.get("tags") or [],
        example_input=worker.get("example_input"),
        example_output=worker.get("example_output"),
        trigger_type=str(worker.get("trigger_type") or "manual"),
        runtime=(config.runtime.type if config.runtime else None),
        connections=_public_connection_labels(config),
        inputs=[
            PublicWorkerInput(
                name=inp.name,
                label=inp.label,
                type=inp.type,
                required=inp.required,
                description=inp.description,
                options=inp.options,
            )
            for inp in (config.inputs or [])
        ],
        outputs=[
            PublicWorkerOutput(name=out.name, label=out.label, type=out.type)
            for out in (config.outputs or [])
        ],
    )


def _build_worker_detail(
    worker_id: str,
    *,
    user_id: str,
    repos: Repositories,
    role: Optional[str] = None,
    include_grants: bool = False,
    owner_aliases: Optional[set[str]] = None,
) -> WorkerDetail:
    worker = _get_visible_worker(
        worker_id, user_id=user_id, repos=repos, role=role, include_grants=include_grants
    )
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

    # #815: latest output — the most recent COMPLETED run's output, fetched once
    # so the detail page renders an output-first overview without a second call.
    latest_output: Optional[Dict[str, Any]] = None
    latest_output_run_id: Optional[str] = None
    _latest_completed = next(
        (r for r in recent_runs if r.status == RunStatus.COMPLETED),
        None,
    )
    if _latest_completed is not None:
        try:
            _run_row = repos.runs.get(user_id=user_id, run_id=_latest_completed.id)
            if _run_row:
                parsed = json.loads(_run_row.get("output_json") or "{}")
                if isinstance(parsed, dict):
                    latest_output = parsed
                    latest_output_run_id = _latest_completed.id
        except Exception:
            logger.debug("latest-output fetch failed for worker %s", worker_id, exc_info=True)

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

    # Resolve status via the SHARED resolver so DETAIL and LIST agree exactly
    # for the same worker (full honesty ladder: missing-secret / failed-run /
    # disabled / never-run, see _resolve_worker_status). The worker dict already
    # carries `enabled` (same w.enabled column get_recipe reads), so no separate
    # recipe fetch is needed.
    available_secret_names = _available_secret_names_for_user(user_id, repos)
    available_conn_slugs_detail = _available_connection_slugs_for_user(user_id, repos)
    status = _resolve_worker_status(
        worker,
        config=config,
        available_secret_names=available_secret_names,
        last_run_status=recent_runs[0].status if recent_runs else None,
        has_run=bool(recent_runs),
    )
    # #556: compute specific missing items.
    _det_req_secrets = _worker_required_secret_names(worker) if config else []
    _det_missing_secrets = [s for s in _det_req_secrets if s not in available_secret_names]
    _det_req_conns = _worker_connection_slugs(worker)
    _det_missing_connections = [c for c in _det_req_conns if c.lower() not in available_conn_slugs_detail]
    # `enabled` mirrors the same w.enabled column the resolver reads; stock /
    # filesystem workers carry no enabled flag and are treated as enabled.
    worker_enabled = bool(worker.get("enabled", True))

    manifest_yaml: Optional[str] = None
    run_py: Optional[str] = None
    skill_md_content: Optional[str] = None
    run_py_content: Optional[str] = None
    worker_files: List[WorkerFile] = []
    if _worker_source_visible_to_api(worker_id):
        try:
            worker_dir = _worker_bundle_dir(worker_id, config)
            yml_path = worker_dir / "worker.yml"
            run_path = worker_dir / "run.py"
            skill_path = worker_dir / "SKILL.md"
            if yml_path.is_file():
                manifest_yaml = yml_path.read_text(encoding='utf-8')
            elif worker.get("manifest"):
                import yaml as pyyaml
                manifest_yaml = pyyaml.safe_dump(worker["manifest"], sort_keys=False)
            if run_path.is_file():
                run_py = run_path.read_text(encoding='utf-8')
                run_py_content = run_py
            if skill_path.is_file():
                skill_md_content = skill_path.read_text(encoding='utf-8')
            worker_files = _read_worker_files(worker_dir)
            if not worker_files:
                worker_files = _worker_files_from_manifest(worker)
        except Exception:
            worker_files = _worker_files_from_manifest(worker)

    # Build webhook URL if this worker has a webhook trigger.
    # #978: the webhook URL carries a bearer token that triggers a run with no
    # session auth (POST /webhooks/{id}?token=...). A view-only grantee
    # (specific-people grant = VIEW only) must NOT receive a durable execution
    # capability, so only surface it to callers who can actually run the
    # worker (owner / workspace admin / run rights). Treat it as a secret.
    from webhook_service import build_webhook_url as _build_webhook_url
    webhook_url: Optional[str] = None
    if _worker_has_webhook_trigger(worker, config):
        _perms = _worker_permissions(worker, user_id=user_id, repos=repos, owner_aliases=owner_aliases)
        if _perms.can_run:
            try:
                # Token derives from the worker's current rotatable secret (backfilled
                # lazily if absent), so this always surfaces the working current URL.
                webhook_url = _build_webhook_url(worker["id"], repos=repos)
            except Exception:
                logger.warning("Could not build webhook URL for %s", worker["id"], exc_info=True)

    triggers_spec = _build_triggers_spec(worker)

    # P2 (2026-05-29): runtime.bundle_path carries the absolute host path
    # (/root/workeros/workers/<id>) and is serialized into the public `config`.
    # The UI never renders it, but the API exposed the deploy dir + storage
    # layout. Relativise to the bundle BASENAME (the worker id) so the value
    # stays self-consistent (worker_registry resolves it under WORKERS_DIR
    # server-side) without disclosing the host path. `config` here is freshly
    # constructed for this response only; mutating it does not affect any
    # server-side bundle resolution (which reads from disk / a fresh config).
    if config and config.runtime and config.runtime.bundle_path:
        config.runtime.bundle_path = Path(config.runtime.bundle_path).name

    last_run_detail = _make_worker_detail_last_run(
        recent_runs[0] if recent_runs else None,
        user_id=user_id,
        repos=repos,
    )

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
        enabled=worker_enabled,
        archive_reason=_sanitize_operator_text(worker.get("archive_reason")),
        tags=worker.get("tags") or [],
        folder=worker.get("folder"),
        status=status,
        trigger_type=worker["trigger_type"],
        runner=worker["runner"],
        config=config,
        last_run=last_run_detail,
        recent_runs=recent_runs,
        latest_output=latest_output,  # #815
        latest_output_run_id=latest_output_run_id,  # #815
        recent_stats=_get_stats_batch([worker_id], user_id=user_id, repos=repos).get(worker_id),
        manifest_yaml=manifest_yaml,
        run_py=run_py,
        skill_md_content=skill_md_content,
        run_py_content=run_py_content,
        files=worker_files,
        webhook_url=webhook_url,
        triggers_spec=triggers_spec,
        missing_secrets=_det_missing_secrets,
        missing_connections=_det_missing_connections,
        public_link=_worker_public_link(worker) if str(worker.get("visibility") or "private") == "public" else None,
        owner_id=worker.get("owner_id"),
        visibility=str(worker.get("visibility") or "private"),
        permissions=_worker_permissions(worker, user_id=user_id, repos=repos, owner_aliases=owner_aliases),
    )


def _load_public_worker(worker_id: str, token: str, repos: Repositories) -> Dict[str, Any]:
    """Resolve + authenticate a worker for a signed public share link.

    Missing worker -> 404. Forged/missing token -> 401 (constant-time compare).
    Returns the full worker dict (owner-scoped projection happens in the route).
    """
    try:
        worker = repos.workers.get_any(worker_id=worker_id)
    except Exception:
        worker = None
    if worker is None:
        raise HTTPException(status_code=404, detail="Worker not found")
    expected = _worker_public_token(worker)
    if not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid worker link")
    return worker


def _load_short_link_public_worker(short_id: str, repos: Repositories) -> Dict[str, Any]:
    if not re.fullmatch(r"fls_[A-Za-z0-9]{6,64}", short_id or ""):
        raise HTTPException(status_code=404, detail="Short link not found")
    _ensure_worker_short_links_table()
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT worker_id, owner_id
            FROM worker_short_links
            WHERE short_id = ?
            LIMIT 1
            """,
            (short_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Short link not found")
    worker = repos.workers.get_any(worker_id=str(row["worker_id"]))
    if not worker or str(worker.get("owner_id") or "") != str(row["owner_id"]):
        raise HTTPException(status_code=404, detail="Short link not found")
    return worker


@app.get("/workers/public/{worker_id}", response_model=PublicWorker)
def get_public_worker(
    worker_id: str,
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
) -> PublicWorker:
    """Return a read-only, allow-listed projection of a worker for a signed link.

    Authenticated solely by the HMAC ``token`` (no app login). The response is
    a strict ``PublicWorker`` allow-list — no secrets, source, run history,
    owner id, or webhook url. See ``_public_worker_response``.
    """
    worker = _load_public_worker(worker_id, token, repos)
    config_dict = worker.get("config", {})
    try:
        config = WorkerConfig(**config_dict)
    except Exception:
        config = WorkerConfig(
            id=str(worker.get("id") or worker_id),
            name=str(worker.get("name") or worker_id),
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )
    return _public_worker_response(worker, config)


@app.post("/workers/{worker_id}/short-link")
def create_worker_short_link(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    return _worker_short_link_response(worker)


@app.get("/workers/short-links/{short_id}", response_model=PublicWorker)
def resolve_worker_short_link(
    short_id: str,
    repos: Repositories = Depends(get_repos),
) -> PublicWorker:
    worker = _load_short_link_public_worker(short_id, repos)
    try:
        config = WorkerConfig(**(worker.get("config") or {}))
    except Exception:
        config = WorkerConfig(
            id=str(worker.get("id") or short_id),
            name=str(worker.get("name") or short_id),
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )
    return _public_worker_response(worker, config)


def _json_noindex(payload: Dict[str, Any], *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status_code, headers=_public_noindex_headers())


def _file_has_share_blocking_secret(rel: str, data: bytes) -> bool:
    return bool(_scan_context_write(rel, data))


def _assert_context_file_shareable(rel: str, target: Path) -> None:
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Context file not found")
    try:
        data = target.read_bytes()
    except OSError:
        raise HTTPException(status_code=404, detail="Context file not found")
    if _file_has_share_blocking_secret(rel, data):
        raise HTTPException(
            status_code=409,
            detail="Move detected secrets to the Secrets vault before sharing this file",
        )


def _assert_context_pack_shareable(name: str) -> None:
    root = context_dir(name)
    for path in iter_context_files(root):
        rel = path.relative_to(root).as_posix()
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if _file_has_share_blocking_secret(rel, data):
            raise HTTPException(
                status_code=409,
                detail=f"Move detected secrets to the Secrets vault before sharing {rel}",
            )


def _public_file_entry(name: str, root: Path, path: Path, token: str | None = None) -> Dict[str, Any]:
    rel = path.relative_to(root).as_posix()
    meta = context_file_metadata(root, path, pack_metadata=load_context_metadata().get(name) or {})
    raw = path.read_bytes()
    mime_type = str(meta.get("mime_type") or guess_mime_type(rel))
    binary = bool(meta.get("is_binary")) or is_binary_file(rel, mime_type)
    content_text: str | None = None
    if not binary and len(raw) <= PUBLIC_SHARE_TEXT_PREVIEW_LIMIT:
        content_text = raw.decode("utf-8", errors="replace")
    entry = {
        "path": rel,
        "size": int(meta.get("size") or len(raw)),
        "mime_type": mime_type,
        "display_type": meta.get("display_type") or "File",
        "is_binary": binary,
        "updated_at": meta.get("updated_at"),
        "description": meta.get("description"),
        "tags": meta.get("tags") or [],
        "metadata": meta.get("metadata") or {},
        "content_text": content_text,
    }
    if token:
        entry["download_url"] = f"{_frontend_base_url()}/s/{urllib.parse.quote(token, safe='')}/download"
    return entry


def _public_brain_file_share(row: Dict[str, Any]) -> Dict[str, Any]:
    owner_id = str(row.get("owner_id") or "")
    name = str(row.get("entity_id") or "")
    rel = str(row.get("file_path") or "")
    token = str(row.get("token") or "")
    with use_context_scope(context_scope_for_user(owner_id)):
        safe_name = _context_name_or_400(name)
        rel = _context_file_path_or_400(rel)
        target = _safe_context_file_or_400(safe_name, rel)
        _assert_context_file_shareable(rel, target)
        root = context_dir(safe_name)
        summary = _context_summary(safe_name, load_context_metadata(), user_id=owner_id)
        file_entry = _public_file_entry(safe_name, root, target, token)
    return {
        "entity_type": "brain_file",
        "title": Path(rel).name,
        "description": f"{safe_name} / {rel}",
        "pack": {
            "name": summary.name,
            "description": summary.description,
            "file_count": summary.file_count,
            "total_size_bytes": summary.total_size_bytes,
        },
        "file": file_entry,
        "files": [file_entry],
    }


def _public_brain_pack_share(row: Dict[str, Any]) -> Dict[str, Any]:
    owner_id = str(row.get("owner_id") or "")
    name = str(row.get("entity_id") or "")
    with use_context_scope(context_scope_for_user(owner_id)):
        safe_name = _context_name_or_400(name)
        _assert_context_pack_shareable(safe_name)
        root = context_dir(safe_name)
        if not root.is_dir():
            raise HTTPException(status_code=404, detail="Brain pack not found")
        metadata = load_context_metadata()
        summary = _context_summary(safe_name, metadata, user_id=owner_id)
        files = [
            _public_file_entry(safe_name, root, path)
            for path in sorted(iter_context_files(root), key=lambda p: p.relative_to(root).as_posix())
        ]
    preview_file = next((f for f in files if f.get("content_text")), files[0] if files else None)
    return {
        "entity_type": "brain_pack",
        "title": summary.name,
        "description": summary.description or f"{summary.file_count} files",
        "pack": {
            "name": summary.name,
            "description": summary.description,
            "file_count": summary.file_count,
            "total_size_bytes": summary.total_size_bytes,
            "updated_at": summary.updated_at,
        },
        "file": preview_file,
        "files": files,
    }


def _public_worker_share_from_worker(worker: Dict[str, Any]) -> Dict[str, Any]:
    try:
        config = WorkerConfig(**(worker.get("config") or {}))
    except Exception:
        config = WorkerConfig(
            id=str(worker.get("id") or ""),
            name=str(worker.get("name") or ""),
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )
    public = _public_worker_response(worker, config).model_dump()
    # Read the actual source files so the share card can preview them and the
    # import endpoint can clone them without a separate DB/FS lookup.
    from worker_registry import WORKERS_DIR as _SHARE_WORKERS_DIR
    worker_dir = _SHARE_WORKERS_DIR / str(worker.get("id") or "")
    raw_files = _read_worker_files(worker_dir)
    share_files = [
        {"path": f.path, "content": f.content or "", "binary": f.binary}
        for f in raw_files
        if not f.binary
    ]
    return {
        "entity_type": "worker",
        "title": public.get("name"),
        "description": public.get("description") or public.get("long_description"),
        "worker": public,
        "files": share_files,
    }


def _load_standalone_share_row(token: str) -> Optional[Dict[str, Any]]:
    if not re.fullmatch(r"fls_[A-Za-z0-9]{6,80}", token or ""):
        raise HTTPException(status_code=404, detail="Share link not found")
    _ensure_standalone_share_links_table()
    with get_db() as conn:
        # #934: lookup is by SHA-256 of the presented token — the raw value is
        # never stored, so a DB dump can't be replayed as live share links.
        row = conn.execute(
            """
            SELECT entity_type, entity_id, file_path, owner_id, created_at
            FROM standalone_share_links
            WHERE token_hash = ?
            LIMIT 1
            """,
            (_hash_share_token(token),),
        ).fetchone()
    return dict(row) if row else None


def _standalone_share_payload(token: str, repos: Repositories) -> Dict[str, Any]:
    row = _load_standalone_share_row(token)
    if row:
        entity_type = str(row.get("entity_type") or "")
        if entity_type == "worker":
            worker = repos.workers.get_any(worker_id=str(row.get("entity_id") or ""))
            if not worker or str(worker.get("owner_id") or "") != str(row.get("owner_id") or ""):
                raise HTTPException(status_code=404, detail="Share link not found")
            return _public_worker_share_from_worker(worker)
        if entity_type == "brain_file":
            return _public_brain_file_share(row)
        if entity_type == "brain_pack":
            return _public_brain_pack_share(row)
        raise HTTPException(status_code=404, detail="Share link not found")

    # Backward compatibility for worker short links created before the unified
    # share table existed.
    worker = _load_short_link_public_worker(token, repos)
    return _public_worker_share_from_worker(worker)


class _ImportFromShareRequest(BaseModel):
    token: str


@app.post("/workers/import-from-share")
def import_worker_from_share(
    body: _ImportFromShareRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Clone a shared worker into the authenticated user's workspace.

    Resolves the share token, reads the source worker's files from the share
    payload (populated by _public_worker_share_from_worker), and registers
    them as a new worker owned by the caller. Colliding IDs are deduplicated
    automatically so the same token can be imported by multiple users.
    """
    payload = _standalone_share_payload(body.token, repos)
    if payload.get("entity_type") != "worker":
        raise HTTPException(status_code=400, detail="Share link is not a worker")
    share_files = payload.get("files") or []
    if not share_files:
        raise HTTPException(status_code=409, detail="Worker has no importable files")
    draft_files = [DraftFile(path=f["path"], content=f.get("content") or "") for f in share_files if f.get("path")]
    if not any(f.path == "worker.yml" for f in draft_files):
        raise HTTPException(status_code=409, detail="Worker share is missing worker.yml")
    new_id = _register_worker_from_files(draft_files, user_id=auth.user_id, repos=repos, dedupe_id=True)
    return {"worker_id": new_id, "url": f"/workers/{new_id}"}


class _GrantRequest(BaseModel):
    asset_type: str = Field(..., max_length=32)
    asset_id: str = Field(..., max_length=256)
    email: str = Field(..., max_length=256)


class _GrantOut(BaseModel):
    id: str
    email: str
    created_at: str


def _canonical_grant_asset_id(asset_type: str, asset_id: str) -> str:
    """Normalize a grant's asset id. Worker ids are canonicalized so a grant
    stored under any alias resolves the same id the enforcement path looks up;
    other asset types are stored verbatim."""
    return _canonical_worker_id(asset_id) if asset_type == "worker" else asset_id


def _assert_can_share_asset(asset_type: str, asset_id: str, auth: AuthContext, repos: Repositories) -> None:
    """#767: only someone who can share the asset may grant access to it."""
    if asset_type == "worker":
        worker = _get_visible_worker(_canonical_worker_id(asset_id), user_id=auth.user_id, repos=repos)
        if not worker:
            raise HTTPException(status_code=404, detail="Asset not found")
        if not _worker_permissions(worker, user_id=auth.user_id, repos=repos).can_share:
            raise HTTPException(status_code=403, detail="You cannot share this asset")
    # brain/run/workspace grants are owner-scoped — the auth check suffices.


@app.post("/share/grants", response_model=_GrantOut, status_code=201)
def add_share_grant(
    body: _GrantRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _GrantOut:
    """#767: grant a person (by email) access to an asset."""
    email = body.email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=422, detail="A valid email is required")
    _assert_can_share_asset(body.asset_type, body.asset_id, auth, repos)
    # Store the canonical worker id so the enforcement path (which canonicalizes
    # the requested id) finds the grant regardless of the alias the caller used.
    asset_id = _canonical_grant_asset_id(body.asset_type, body.asset_id)
    ts = now_iso()
    gid = str(_uuid_mod.uuid4())
    with get_db() as conn:
        try:
            conn.execute(
                "INSERT INTO asset_grants (id, asset_type, asset_id, owner_id, grantee_email, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (gid, body.asset_type, asset_id, auth.user_id, email, ts),
            )
        except sqlite3.IntegrityError:
            existing = conn.execute(
                "SELECT id, created_at FROM asset_grants "
                "WHERE asset_type=? AND asset_id=? AND owner_id=? AND grantee_email=?",
                (body.asset_type, asset_id, auth.user_id, email),
            ).fetchone()
            return _GrantOut(id=str(existing["id"]), email=email, created_at=str(existing["created_at"]))
    return _GrantOut(id=gid, email=email, created_at=ts)


@app.get("/share/grants", response_model=List[_GrantOut])
def list_share_grants(
    asset_type: str,
    asset_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[_GrantOut]:
    """#768: list the people granted access to an asset (owner-scoped)."""
    asset_id = _canonical_grant_asset_id(asset_type, asset_id)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, grantee_email, created_at FROM asset_grants "
            "WHERE asset_type=? AND asset_id=? AND owner_id=? ORDER BY created_at",
            (asset_type, asset_id, auth.user_id),
        ).fetchall()
    return [
        _GrantOut(id=str(r["id"]), email=str(r["grantee_email"]), created_at=str(r["created_at"]))
        for r in rows
    ]


@app.delete("/share/grants/{grant_id}", status_code=204)
def delete_share_grant(
    grant_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> None:
    """#767: revoke a person's access grant."""
    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM asset_grants WHERE id = ? AND owner_id = ?", (grant_id, auth.user_id)
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Grant not found")


class _AssetAccessEntry(BaseModel):
    user_id: Optional[str] = None
    email: Optional[str] = None
    display_name: Optional[str] = None
    role: str  # "owner" | "editor" | "viewer"
    source: str  # "owner" | "workspace" | "grant"


def _asset_access_list(
    *,
    asset_type: str,
    asset_id: str,
    owner_id: str,
    visibility: str,
    auth: AuthContext,
    repos: Repositories,
) -> List[_AssetAccessEntry]:
    """#768: who can access this asset and why. Always the owner; workspace
    members when visibility=workspace; grantees when visibility=specific_people
    (grants are also surfaced if any exist, since they confer access)."""
    entries: List[_AssetAccessEntry] = []
    seen_emails: set[str] = set()

    # owner (resolve display info from the users table if available)
    owner_email = None
    owner_name = None
    try:
        if repos.users is not None:
            urow = repos.users.get(user_id=owner_id)
            if urow:
                owner_email = urow.get("email")
                owner_name = urow.get("display_name") or urow.get("username")
    except Exception:
        pass
    entries.append(_AssetAccessEntry(
        user_id=owner_id, email=owner_email, display_name=owner_name,
        role="owner", source="owner",
    ))
    if owner_email:
        seen_emails.add(owner_email.lower())

    if visibility == "workspace":
        try:
            members_repo = _require_members_repo(repos)
            workspace_id = _active_local_workspace_id(auth)
            for m in members_repo.list(workspace_id=workspace_id):
                if str(m.get("user_id")) == str(owner_id):
                    continue
                email = (m.get("email") or "")
                role = "editor" if str(m.get("role")) in ("owner", "admin") else "viewer"
                entries.append(_AssetAccessEntry(
                    user_id=str(m.get("user_id")), email=email or None,
                    display_name=m.get("display_name"), role=role, source="workspace",
                ))
                if email:
                    seen_emails.add(email.lower())
        except Exception:
            logger.debug("access list: workspace members lookup failed", exc_info=True)

    # grants (always surfaced — a grant confers access regardless of the tier)
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT grantee_email FROM asset_grants "
                "WHERE asset_type=? AND asset_id=? AND owner_id=? ORDER BY created_at",
                (asset_type, asset_id, owner_id),
            ).fetchall()
        for r in rows:
            email = str(r["grantee_email"] or "")
            if not email or email.lower() in seen_emails:
                continue
            seen_emails.add(email.lower())
            entries.append(_AssetAccessEntry(
                user_id=None, email=email, display_name=None,
                role="viewer", source="grant",
            ))
    except Exception:
        logger.debug("access list: grant lookup failed", exc_info=True)

    return entries


@app.get("/workers/{worker_id}/access", response_model=List[_AssetAccessEntry])
def list_worker_access(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[_AssetAccessEntry]:
    """#768: people-with-access listing for a worker (owner/workspace/grant)."""
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    return _asset_access_list(
        asset_type="worker", asset_id=worker_id,
        owner_id=str(worker.get("owner_id") or auth.user_id),
        visibility=str(worker.get("visibility") or "private"),
        auth=auth, repos=repos,
    )


@app.get("/contexts/{name}/access", response_model=List[_AssetAccessEntry])
def list_context_access(
    name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[_AssetAccessEntry]:
    """#768: people-with-access listing for a brain pack."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    summary = _context_summary(safe_name, _metadata, repos=repos, user_id=auth.user_id)
    return _asset_access_list(
        asset_type="brain_pack", asset_id=safe_name,
        owner_id=str(getattr(summary, "owner_id", None) or auth.user_id),
        visibility=str(getattr(summary, "visibility", "private")),
        auth=auth, repos=repos,
    )


@app.post("/workers/{worker_id}/share-link")
def create_worker_share_link(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    perms = _worker_permissions(worker, user_id=auth.user_id, repos=repos)
    if not perms.can_share:
        raise HTTPException(status_code=403, detail="You cannot share this worker")
    return _create_or_get_standalone_share_link(
        entity_type="worker",
        entity_id=str(worker["id"]),
        owner_id=str(worker.get("owner_id") or auth.user_id),
    )


@app.post("/contexts/{name}/share-link")
def create_brain_pack_share_link(
    name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    summary = _context_summary(safe_name, _metadata, repos=repos, user_id=auth.user_id)
    if not summary.permissions.can_share:
        raise HTTPException(status_code=403, detail="You cannot share this brain pack")
    _assert_context_pack_shareable(safe_name)
    return _create_or_get_standalone_share_link(
        entity_type="brain_pack",
        entity_id=safe_name,
        owner_id=auth.user_id,
    )


@app.post("/contexts/{name}/files/{file_path:path}/share-link")
def create_brain_file_share_link(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    summary = _context_summary(safe_name, _metadata, repos=repos, user_id=auth.user_id)
    if not summary.permissions.can_share:
        raise HTTPException(status_code=403, detail="You cannot share this brain file")
    rel = _context_file_path_or_400(file_path)
    target = _safe_context_file_or_400(safe_name, rel)
    _assert_context_file_shareable(rel, target)
    return _create_or_get_standalone_share_link(
        entity_type="brain_file",
        entity_id=safe_name,
        file_path=rel,
        owner_id=auth.user_id,
    )


def _revoke_standalone_share_link(
    *,
    entity_type: str,
    entity_id: str,
    owner_id: str,
    file_path: str = "",
) -> Dict[str, bool]:
    # #766: delete the token row so the public link stops resolving. A later
    # POST /share-link mints a fresh token (the frontend toggle off->on flow).
    _ensure_standalone_share_links_table()
    with get_db() as conn:
        cursor = conn.execute(
            """
            DELETE FROM standalone_share_links
            WHERE entity_type = ? AND entity_id = ? AND file_path = ? AND owner_id = ?
            """,
            (entity_type, entity_id, file_path or "", owner_id),
        )
    return {"revoked": cursor.rowcount > 0}


@app.delete("/workers/{worker_id}/share-link")
def revoke_worker_share_link(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#766: revoke (disable) a worker's public share link."""
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    perms = _worker_permissions(worker, user_id=auth.user_id, repos=repos)
    if not perms.can_share:
        raise HTTPException(status_code=403, detail="You cannot share this worker")
    return _revoke_standalone_share_link(
        entity_type="worker",
        entity_id=str(worker["id"]),
        owner_id=str(worker.get("owner_id") or auth.user_id),
    )


@app.delete("/contexts/{name}/share-link")
def revoke_brain_pack_share_link(
    name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#766: revoke a brain pack's public share link."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    return _revoke_standalone_share_link(
        entity_type="brain_pack",
        entity_id=safe_name,
        owner_id=auth.user_id,
    )


@app.delete("/contexts/{name}/files/{file_path:path}/share-link")
def revoke_brain_file_share_link(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#766: revoke a brain file's public share link."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    rel = _context_file_path_or_400(file_path)
    return _revoke_standalone_share_link(
        entity_type="brain_file",
        entity_id=safe_name,
        file_path=rel,
        owner_id=auth.user_id,
    )


@app.get("/s/{token}/download")
def download_standalone_share_file(
    token: str,
    repos: Repositories = Depends(get_repos),
) -> Response:
    row = _load_standalone_share_row(token)
    if not row or row.get("entity_type") != "brain_file":
        raise HTTPException(status_code=404, detail="Download not found")
    owner_id = str(row.get("owner_id") or "")
    safe_name = str(row.get("entity_id") or "")
    rel = str(row.get("file_path") or "")
    with use_context_scope(context_scope_for_user(owner_id)):
        safe_name = _context_name_or_400(safe_name)
        rel = _context_file_path_or_400(rel)
        target = _safe_context_file_or_400(safe_name, rel)
        _assert_context_file_shareable(rel, target)
        mime_type = guess_mime_type(rel)
        headers = {
            **_public_noindex_headers(),
            "Content-Disposition": f'attachment; filename="{_sanitize_download_name(Path(rel).name)}"',
            "X-Content-Type-Options": "nosniff",
        }
        return FileResponse(target, media_type=mime_type, headers=headers)


@app.get("/s/{token}")
def get_standalone_share(
    token: str,
    repos: Repositories = Depends(get_repos),
) -> JSONResponse:
    return _json_noindex(_standalone_share_payload(token, repos))


@app.get("/workers/{worker_id}", response_model=WorkerDetail)
def get_worker_detail(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    canonical_id = _canonical_worker_id(worker_id)
    # include_grants=True: a specific-people grantee (#767/#768) can VIEW the
    # worker detail. This is the only caller that opts in; mutation endpoints
    # keep owner/workspace-only access.
    return _build_worker_detail(
        canonical_id,
        user_id=_worker_access_user_id(auth),
        repos=repos,
        role=_worker_repo_role(auth),
        include_grants=True,
        owner_aliases={auth.user_id, auth.username or ""},
    )


class _RequestEditAccessBody(BaseModel):
    message: Optional[str] = Field(default=None, max_length=2000)


@app.post("/workers/{worker_id}/request-edit", status_code=201)
def request_worker_edit_access(
    worker_id: str,
    body: _RequestEditAccessBody,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """#807: a member viewing a locked (workspace-shared, not owned) worker
    asks the owner/admin for edit access. 404 if the worker isn't visible,
    403 if the caller already has edit rights. Records a pending request
    (idempotent) and notifies the owner best-effort.
    """
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(
        worker_id, user_id=auth.user_id, repos=repos,
        role=_worker_repo_role(auth), include_grants=True,
    )
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    perms = _worker_permissions(
        worker, user_id=auth.user_id, repos=repos,
        owner_aliases={auth.user_id, auth.username or ""},
    )
    if perms.can_edit:
        raise HTTPException(status_code=403, detail="You already have edit access to this worker.")

    req_id = f"editreq_{_uuid_mod.uuid4().hex[:12]}"
    created = False
    with get_db() as conn:
        try:
            conn.execute(
                "INSERT INTO edit_access_requests (id, worker_id, requester_id, message, status, created_at) "
                "VALUES (?, ?, ?, ?, 'pending', ?)",
                (req_id, worker_id, auth.user_id, (body.message or None), now_iso()),
            )
            created = True
        except sqlite3.IntegrityError:
            # idempotent: a pending request from this member already exists
            created = False
    if created:
        try:
            from alerting import _send_email  # noqa: PLC0415

            _send_email(
                f"Edit-access request for worker {worker.get('name') or worker_id}",
                f"{auth.username or auth.user_id} requested edit access to "
                f"'{worker.get('name') or worker_id}'."
                + (f"\n\nMessage: {body.message}" if body.message else ""),
            )
        except Exception:
            logger.debug("edit-access request email failed (non-fatal)", exc_info=True)
    return {"ok": True, "pending": True}


@app.get("/workers/{worker_id}/edit-requests")
def list_worker_edit_requests(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[Dict[str, Any]]:
    """#807: the owner/admin lists pending edit-access requests for a worker."""
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(
        worker_id, user_id=auth.user_id, repos=repos,
        role="admin" if auth.is_admin else _worker_repo_role(auth),
    )
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    perms = _worker_permissions(
        worker, user_id=auth.user_id, repos=repos,
        owner_aliases={auth.user_id, auth.username or ""},
    )
    if not (perms.can_edit or auth.is_admin):
        raise HTTPException(status_code=403, detail="Only the owner or an admin can view edit requests.")
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, worker_id, requester_id, message, status, created_at "
            "FROM edit_access_requests WHERE worker_id = ? AND status = 'pending' "
            "ORDER BY created_at DESC",
            (worker_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/workers/{worker_id}/bundle.zip")
def download_worker_bundle(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """#816: download a worker as a skill bundle (zip of its on-disk files:
    worker.yml, run.py, SKILL.md, requirements.txt). Importable via
    POST /workers/from-bundle. Visible-worker scoped (404 otherwise)."""
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    buf = io.BytesIO()
    file_count = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, data in _iter_worker_dir_files(worker_id):
            zf.writestr(f"{worker_id}/{rel}", data)
            file_count += 1
    if file_count == 0:
        raise HTTPException(status_code=409, detail="Worker has no exportable files")
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", worker_id)[:60] or "worker"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe}.zip"'},
    )


@app.put("/workers/{worker_id}/visibility", response_model=WorkerDetail)
def set_worker_visibility(
    worker_id: str,
    payload: WorkerVisibilityUpdate,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Set a worker's visibility (Private <-> Shared with workspace).

    Owner/admin only. The AssetAccessRepository enforces ``can_share`` and the
    enum; a non-owner without share rights gets 403. On the OSS single-owner
    engine the local user owns their workers, so this always succeeds for them
    and is a no-op-shaped toggle for the one-member workspace. 404 for an
    invisible/unknown worker (never reveals another owner's private worker).
    """
    _require_worker_write_workspace_context(request)
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(
        worker_id,
        user_id=auth.user_id,
        repos=repos,
        # donation model: workspace-shared workers are owned by the synthetic
        # workspace actor, so the admin doing the unshare is not their owner.
        role="admin" if auth.is_admin else None,
    )
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    asset_access = getattr(repos, "asset_access", None)
    if asset_access is None:
        raise HTTPException(status_code=501, detail="Visibility control not available")

    owner_id = worker.get("owner_id")
    if not owner_id:
        # Stock/filesystem worker with no DB row — not an editable asset.
        raise HTTPException(
            status_code=409,
            detail="This worker is read-only and its visibility cannot be changed.",
        )

    try:
        result = asset_access.set_visibility(
            workspace_id=str(worker.get("workspace_id") or "local-default"),
            actor_id=auth.user_id,
            asset_type="worker",
            asset_id=worker_id,
            visibility=payload.visibility,
            actor_role="admin" if auth.is_admin else None,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Worker not found")

    # Write visibility back to worker.yml so it travels with the repo
    _patch_worker_yml_field(worker_id, "visibility", str(payload.visibility))
    author_name, author_email = _git_author(auth)
    _git_commit_worker(
        worker_id,
        message=f"worker {worker_id}: set visibility to {payload.visibility}",
        author_name=author_name,
        author_email=author_email,
    )

    # Donation model: after share-transfer the caller is no longer the owner,
    # but they can still VIEW the now-workspace-shared worker — fetch the
    # response with the member/admin role path, not the owner-scoped default.
    return _build_worker_detail(
        worker_id,
        user_id=auth.user_id,
        repos=repos,
        role="admin" if auth.is_admin else "member",
    )


def _patch_worker_yml_field(worker_id: str, field: str, value: Any) -> None:
    """Write a single field into worker.yml on disk without disturbing other fields."""
    import yaml as pyyaml
    worker_dir = WORKERS_DIR / worker_id
    yml_path = worker_dir / "worker.yml"
    if not yml_path.is_file():
        return
    try:
        raw = pyyaml.safe_load(yml_path.read_text(encoding="utf-8")) or {}
        raw[field] = value
        yml_path.write_text(
            pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False, allow_unicode=True),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.warning("Failed to patch %s in worker.yml for %s: %s", field, worker_id, exc)


def _set_db_manifest_archived(
    worker_id: str,
    *,
    archived: bool,
    user_id: str,
    repos: Repositories,
) -> None:
    """Mirror a worker's archived flag into its DB manifest (skill_versions.manifest_json).

    The API resolves ``archived`` from the DB manifest (via ``repos.workers.get``),
    not from worker.yml on disk. Archive/restore write worker.yml for restart
    durability, so the DB copy must be updated in lockstep or the detail response,
    the Archived list view, and the Restore button all read stale state.

    No-op (and non-fatal) for filesystem-only workers that have no DB row — those
    are served from disk via ``discover_workers`` after cache invalidation.
    """
    try:
        db_worker = repos.workers.get(user_id=user_id, worker_id=worker_id)
    except sqlite3.OperationalError:
        db_worker = None
    if db_worker is None:
        return
    manifest = dict(db_worker.get("manifest") or {})
    if archived:
        manifest["archived"] = True
    else:
        # Restore: drop the flag entirely so it defaults to false, matching the
        # worker.yml write which removes/clears archived + archive_reason.
        manifest.pop("archived", None)
        manifest.pop("archive_reason", None)
    repos.workers.update(user_id=user_id, worker_id=worker_id, manifest_json=manifest)


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

    worker_id = _canonical_worker_id(worker_id)
    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = _WORKERS_DIR / worker_id / "worker.yml"
    if not worker_yml_path.exists():
        raise HTTPException(status_code=404, detail="Worker not found")
    try:
        raw_yml = worker_yml_path.read_text(encoding='utf-8')
        # Remove or set archived to false. Match both `archived: true` and `archived:true`.
        updated = _re.sub(r"(?m)^(archived:\s*)true\s*$", r"\1false\n", raw_yml)
        if updated == raw_yml:
            # Field may be missing — just remove it (defaults to false)
            updated = raw_yml  # already not archived
        # Also remove archive_reason line when restoring
        updated = _re.sub(r"(?m)^archive_reason:.*\n?", "", updated)
        worker_yml_path.write_text(updated, encoding='utf-8')
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to update worker.yml: {exc}") from exc
    # Mirror the cleared archived flag into the DB manifest (see archive_worker:
    # the API reads `archived` from the DB, not disk).
    _set_db_manifest_archived(worker_id, archived=False, user_id=auth.user_id, repos=repos)
    invalidate_worker_cache()
    return _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)


@app.post("/workers/{worker_id}/archive", response_model=WorkerDetail)
def archive_worker(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Archive a worker (set archived: true in worker.yml).

    Reversible counterpart to /restore. Writes back to the bundle file so the
    change survives server restarts, and invalidates the worker cache so the
    worker drops out of the default list (it stays reachable under the Archived
    view + by direct link, where Restore is offered).
    """
    from worker_registry import WORKERS_DIR as _WORKERS_DIR
    import re as _re

    worker_id = _canonical_worker_id(worker_id)
    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = _WORKERS_DIR / worker_id / "worker.yml"
    if not worker_yml_path.exists():
        raise HTTPException(status_code=404, detail="Worker not found")
    try:
        raw_yml = worker_yml_path.read_text(encoding='utf-8')
        # Flip an existing `archived: false` to true; otherwise append the field.
        # Match both `archived: true` and `archived:true` spacing, same as restore.
        updated, n = _re.subn(r"(?m)^(archived:\s*)false\s*$", r"\1true\n", raw_yml)
        if n == 0 and not _re.search(r"(?m)^archived:\s*true\s*$", raw_yml):
            # Field missing entirely — append it (default was false).
            if not updated.endswith("\n"):
                updated += "\n"
            updated += "archived: true\n"
        worker_yml_path.write_text(updated, encoding='utf-8')
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to update worker.yml: {exc}") from exc
    # Persist the archived flag to the DB manifest too. The API reads `archived`
    # from skill_versions.manifest_json (via repos.workers.get), NOT from disk —
    # writing worker.yml alone left the detail response, the Archived view, and
    # the Restore button stale (archived:false) for DB-tracked workers, because
    # invalidate_worker_cache() only clears the filesystem discovery cache.
    _set_db_manifest_archived(worker_id, archived=True, user_id=auth.user_id, repos=repos)
    invalidate_worker_cache()
    return _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)


class _WorkerSuggestion(BaseModel):
    field: str
    current: str
    suggested: str
    reason: str

class _WorkerSuggestResponse(BaseModel):
    has_conflicts: bool
    suggestions: list[_WorkerSuggestion]

class _WorkerSuggestRequest(BaseModel):
    new_description: str

@app.post("/workers/{worker_id}/suggest", response_model=_WorkerSuggestResponse)
async def suggest_worker_updates(
    worker_id: str,
    payload: _WorkerSuggestRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _WorkerSuggestResponse:
    """Compare a new description against the current worker config and surface conflicts.

    Makes a single focused OpenAI call. Returns structured suggestions so the UI
    can show a conflict-resolution modal before the user saves.
    """
    import json as _json
    import os as _os
    import llm as _llm
    from codegen_model import codegen_model as _codegen_model
    from worker_registry import WORKERS_DIR as _WORKERS_DIR

    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = _WORKERS_DIR / worker_id / "worker.yml"
    current_yml = worker_yml_path.read_text(encoding="utf-8") if worker_yml_path.exists() else (
        getattr(worker, "manifest_yaml", "") or ""
    )

    suggest_model = _os.environ.get("WORKEROS_SUGGEST_MODEL") or _codegen_model()
    if not _llm.provider_credentials_present(suggest_model):
        return _WorkerSuggestResponse(has_conflicts=False, suggestions=[])

    prompt = (
        "You are reviewing a Workeros worker configuration for consistency with a new description.\n\n"
        f"New description from user:\n{payload.new_description}\n\n"
        f"Current worker.yml:\n{current_yml}\n\n"
        "Identify ONLY real conflicts between the new description and the existing config.\n"
        "Focus on: trigger schedule/type, required inputs, connections, and secrets.\n"
        "Ignore stylistic or wording differences — only flag functional mismatches.\n"
        "If the description does not clearly imply a change, do NOT flag a conflict.\n\n"
        'Return JSON: {"has_conflicts": bool, "suggestions": [{"field": str, "current": str, "suggested": str, "reason": str}]}\n'
        'If no conflicts: {"has_conflicts": false, "suggestions": []}'
    )

    try:
        response = _llm.completion(
            model=suggest_model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=512,
        )
        raw = response.choices[0].message.content or "{}"
        result = _json.loads(raw)
        return _WorkerSuggestResponse(
            has_conflicts=bool(result.get("has_conflicts", False)),
            suggestions=[_WorkerSuggestion(**s) for s in result.get("suggestions", [])],
        )
    except Exception as exc:
        logger.warning("suggest_worker_updates LLM call failed: %s", exc)
        return _WorkerSuggestResponse(has_conflicts=False, suggestions=[])


@app.get("/workers/{worker_id}/sample-input")
def get_worker_sample_input(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Any:
    """Return the sample input JSON for a worker.

    Resolution order (consistent for ALL workers, not just stock ones):
      1. A static docs/workers/inputs/<worker_id>.json file, if present (stock
         workers ship curated samples there).
      2. The worker's own ``example_input`` from its manifest (every generated /
         user worker has this — it's what the UI prefills with).
    Returns 404 only when the worker has no sample input from EITHER source, so
    an API consumer gets the same answer the UI shows instead of a spurious 404
    on generated workers (the manifest example_input was always available).
    """
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    safe_id = worker_id.replace("..", "").replace("/", "").replace("\\", "")
    # Walk from WORKERS_DIR up one level to the repo root, then into docs/workers/inputs/
    sample_path = WORKERS_DIR.parent / "docs" / "workers" / "inputs" / f"{safe_id}.json"
    if sample_path.is_file():
        try:
            return json.loads(sample_path.read_text(encoding='utf-8'))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to parse sample input: {exc}") from exc

    # Fall back to the worker's manifest example_input (consistent with the UI,
    # which prefers example_input and only used this endpoint as a fallback).
    example_input = (worker.get("manifest") or {}).get("example_input")
    if example_input is None:
        example_input = worker.get("example_input")
    if example_input is not None:
        return example_input

    raise HTTPException(status_code=404, detail=f"No sample input found for worker {worker_id!r}")


# ---------------------------------------------------------------------------
# PATCH /workers/{worker_id} — partial update
# ---------------------------------------------------------------------------

def _ensure_worker_row_for_rotation(
    *,
    worker_id: str,
    worker: Dict[str, Any],
    config: Optional[WorkerConfig],
    auth: AuthContext,
    repos: Repositories,
) -> None:
    """Persist a filesystem-registry worker before storing FK-backed webhook state."""
    if _get_db_worker(worker_id, user_id=auth.user_id, repos=repos, role=auth.role):
        return

    manifest = worker.get("manifest") or worker.get("manifest_json") or {}
    if not isinstance(manifest, dict):
        manifest = {}
    config_dict: Dict[str, Any] = {}
    if config is not None:
        config_dict = config.model_dump(mode="json")
        if not manifest:
            manifest = config_dict
    elif isinstance(worker.get("config"), dict):
        config_dict = worker["config"]

    trigger = (config_dict.get("trigger") if isinstance(config_dict, dict) else None) or {}
    triggers_json = _extract_triggers_from_manifest(manifest, config_dict)
    repos.workers.upsert(
        user_id=auth.user_id,
        worker_id=worker_id,
        name=worker.get("name") or manifest.get("name") or worker_id,
        manifest_json=manifest,
        bundle_path=worker.get("bundle_path") or str((WORKERS_DIR / worker_id).resolve()),
        trigger_type=worker.get("trigger_type") or trigger.get("type") or "manual",
        cron_expr=worker.get("cron_expr") or trigger.get("cron"),
        cron_timezone=worker.get("cron_timezone") or trigger.get("timezone"),
        grants_json=worker.get("grants_json") or {},
        input_values_json=worker.get("input_values_json") or {},
        triggers_json=triggers_json,
        visibility=worker.get("visibility") or "private",
    )


@app.patch("/workers/{worker_id}", response_model=WorkerDetail)
def update_worker(
    worker_id: str,
    payload: WorkerUpdateRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Partially update a worker instance.

    All fields are optional. Rotation of webhook_secret returns the new raw
    secret once in the response (new_webhook_secret field) — it is never
    stored in plaintext.
    """
    _require_worker_write_workspace_context(request)
    worker_id = _canonical_worker_id(worker_id)
    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    # Validate cron expression if provided. Shares the exact same validator
    # the create path (WorkerTrigger/WorkerContractTrigger) uses — single
    # source of truth in cron_utils.is_valid_cron_expr.
    new_cron_expr = payload.cron_expr
    if new_cron_expr is not None:
        from cron_utils import is_valid_cron_expr
        if not is_valid_cron_expr(new_cron_expr):
            raise HTTPException(status_code=400, detail=f"Invalid cron expression: {new_cron_expr!r}")

    updates: Dict[str, Any] = {}

    if payload.trigger_type is not None:
        # "cron" is an accepted alias for "schedule"
        updates["trigger_type"] = "schedule" if payload.trigger_type == "cron" else payload.trigger_type

    if new_cron_expr is not None:
        updates["cron_expr"] = new_cron_expr

    if payload.cron_timezone is not None:
        updates["cron_timezone"] = payload.cron_timezone

    if payload.input_values is not None:
        updates["input_values_json"] = payload.input_values

    # #785: name/description edits. name is a DB column; description lives in the
    # manifest (skill_versions.manifest_json). Both are also patched into
    # worker.yml on disk below so they survive a registry reload.
    if payload.name is not None:
        new_name = payload.name.strip()
        if not new_name:
            raise HTTPException(status_code=422, detail="name cannot be empty")
        updates["name"] = new_name
    if payload.description is not None:
        manifest = dict(worker.get("manifest") or {})
        manifest["description"] = payload.description
        updates["manifest_json"] = manifest

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
        _ensure_worker_row_for_rotation(
            worker_id=worker_id,
            worker=worker,
            config=config,
            auth=auth,
            repos=repos,
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
        base_trigger = (worker.get("config") or {}).get("trigger") or {}
        effective_type = (
            payload.trigger_type
            or worker.get("trigger_type")
            or base_trigger.get("type")
            or "manual"
        )
        effective_type = "schedule" if effective_type == "cron" else effective_type
        effective_cron = (
            new_cron_expr
            if new_cron_expr is not None
            else (worker.get("cron_expr") or base_trigger.get("cron"))
        )
        effective_tz = (
            payload.cron_timezone
            if payload.cron_timezone is not None
            else (worker.get("cron_timezone") or base_trigger.get("timezone") or "UTC")
        )
        declared_trigger: Dict[str, Any] = {"type": effective_type}
        if effective_type == "schedule":
            declared_trigger["cron"] = effective_cron or "0 9 * * *"
            declared_trigger["timezone"] = effective_tz or "UTC"
        declared_triggers = [declared_trigger]
        repos.workers.update(
            user_id=auth.user_id,
            worker_id=worker_id,
            triggers_json=declared_triggers,
        )
        repos.workers.reconcile_triggers(
            worker_id=worker_id,
            triggers=declared_triggers,
            enabled=bool(worker.get("enabled", True)),
        )

        from worker_registry import WORKERS_DIR
        worker_yml_path = WORKERS_DIR / worker_id / "worker.yml"
        if worker_yml_path.exists():
            try:
                existing_yml = worker_yml_path.read_text(encoding='utf-8')
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
                worker_yml_path.write_text(updated_yml, encoding='utf-8')
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

    # #785: persist name/description to worker.yml so they survive a registry
    # reload (DB stays authoritative; disk write is best-effort, like triggers).
    if payload.name is not None or payload.description is not None:
        from worker_registry import WORKERS_DIR
        worker_yml_path = WORKERS_DIR / worker_id / "worker.yml"
        if worker_yml_path.exists():
            try:
                lines = worker_yml_path.read_text(encoding="utf-8").split("\n")
                def _patch_scalar(field: str, value: str) -> None:
                    safe = value.replace('"', '\\"')
                    for i, ln in enumerate(lines):
                        if re.match(rf"^{field}:\s", ln):
                            lines[i] = f'{field}: "{safe}"'
                            return
                if payload.name is not None:
                    _patch_scalar("name", payload.name.strip())
                if payload.description is not None:
                    _patch_scalar("description", payload.description)
                worker_yml_path.write_text("\n".join(lines), encoding="utf-8")
            except Exception as exc:
                logger.warning("PATCH %s: could not update name/description in worker.yml: %s", worker_id, exc)

    detail = _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)
    if new_raw_secret is not None:
        detail.new_webhook_secret = new_raw_secret

    # Snapshot metadata changes for versioning (fire-and-forget)
    if updates:
        author_name, author_email = _git_author(auth)
        _git_commit_worker(worker_id, message=f"worker: update {worker_id}", author_name=author_name, author_email=author_email)

    return detail


def _set_worker_enabled(
    worker_id: str,
    *,
    enabled: bool,
    auth: AuthContext,
    repos: Repositories,
    request: Request,
) -> WorkerDetail:
    # #788 shared body for pause/resume. enabled is a real DB column; toggling
    # it (plus clearing next_run_at on pause) takes the worker in/out of the
    # scheduler without a full worker.yml rewrite.
    _require_worker_write_workspace_context(request)
    worker_id = _canonical_worker_id(worker_id)
    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    update_fields: Dict[str, Any] = {"enabled": enabled}
    if not enabled:
        update_fields["next_run_at"] = None  # unschedule pending cron fire
    repos.workers.update(user_id=auth.user_id, worker_id=worker_id, **update_fields)
    # Re-reconcile triggers so resume re-enqueues and pause tears down.
    try:
        triggers = (worker.get("config") or {}).get("triggers") or worker.get("triggers_json") or []
        if triggers:
            repos.workers.reconcile_triggers(worker_id=worker_id, triggers=triggers, enabled=enabled)
    except Exception:
        logger.debug("reconcile_triggers on enabled-toggle failed (non-fatal)", exc_info=True)
    invalidate_worker_cache()
    return _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)


@app.post("/workers/{worker_id}/star")
def toggle_worker_star(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#782: toggle the caller's star/favorite for a worker. Per-user; returns
    the new state. 404 if the worker is not visible to the caller."""
    worker_id = _canonical_worker_id(worker_id)
    if _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos) is None:
        raise HTTPException(status_code=404, detail="Worker not found")
    return {"starred": _toggle_worker_star(auth.user_id, worker_id)}


class _WorkerContextAttachRequest(BaseModel):
    name: str
    writeable: bool = False


class _WorkerContextUpdateRequest(BaseModel):
    writeable: bool


def _patch_worker_contexts_in_yml(worker_yml_path: Path, new_contexts: List[Dict[str, Any]]) -> None:
    import yaml as _pyyaml

    original = worker_yml_path.read_text(encoding="utf-8")
    lines = original.splitlines()
    had_final_newline = original.endswith("\n")
    block_lines = _pyyaml.safe_dump(
        {"contexts": new_contexts},
        sort_keys=False,
        default_flow_style=False,
    ).rstrip("\n").splitlines()

    def _is_top_level_key(line: str) -> bool:
        return bool(re.match(r"^[A-Za-z_][\w_-]*\s*:", line))

    def _remove_exec_contexts(raw_lines: List[str]) -> List[str]:
        exec_start = next((i for i, ln in enumerate(raw_lines) if re.match(r"^exec\s*:", ln)), None)
        if exec_start is None:
            return raw_lines
        exec_end = len(raw_lines)
        for i in range(exec_start + 1, len(raw_lines)):
            if _is_top_level_key(raw_lines[i]):
                exec_end = i
                break
        ctx_start = None
        ctx_indent = 0
        for i in range(exec_start + 1, exec_end):
            match = re.match(r"^(\s+)contexts\s*:", raw_lines[i])
            if match:
                ctx_start = i
                ctx_indent = len(match.group(1))
                break
        if ctx_start is None:
            return raw_lines
        ctx_end = exec_end
        for i in range(ctx_start + 1, exec_end):
            stripped = raw_lines[i].strip()
            if not stripped:
                continue
            indent = len(raw_lines[i]) - len(raw_lines[i].lstrip(" "))
            if indent <= ctx_indent:
                ctx_end = i
                break
        return raw_lines[:ctx_start] + raw_lines[ctx_end:]

    lines = _remove_exec_contexts(lines)
    start = next((i for i, ln in enumerate(lines) if re.match(r"^contexts\s*:", ln)), None)
    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend(block_lines)
    else:
        end = len(lines)
        for i in range(start + 1, len(lines)):
            if _is_top_level_key(lines[i]):
                end = i
                break
        lines = lines[:start] + block_lines + lines[end:]

    updated = "\n".join(lines)
    if had_final_newline:
        updated += "\n"
    worker_yml_path.write_text(updated, encoding="utf-8")


def _mutate_worker_contexts(
    worker_id: str,
    mutate,
    *,
    auth: AuthContext,
    repos: Repositories,
) -> WorkerDetail:
    """#790: apply a mutation to a worker's mounted contexts (attach/detach/
    set-writeable) by patching the DB manifest (drives detail + runs) and the
    on-disk worker.yml (survives reload), without a full YAML rewrite."""
    worker_id = _canonical_worker_id(worker_id)
    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    manifest = dict(worker.get("manifest") or {})
    raw = manifest.get("contexts")
    if not isinstance(raw, list):
        exec_block = manifest.get("exec")
        raw = exec_block.get("contexts") if isinstance(exec_block, dict) else None
    current: List[Dict[str, Any]] = []
    for c in (raw or []):
        if isinstance(c, str):
            current.append({"name": c, "writeable": False})
        elif isinstance(c, dict) and c.get("name"):
            current.append({"name": str(c["name"]), "writeable": bool(c.get("writeable", False))})
    new_contexts = mutate(current)
    manifest["contexts"] = new_contexts
    if isinstance(manifest.get("exec"), dict):
        manifest["exec"].pop("contexts", None)  # avoid top-level vs exec ambiguity
    repos.workers.update(user_id=auth.user_id, worker_id=worker_id, manifest_json=manifest)
    invalidate_worker_cache()
    # Best-effort worker.yml write-back so the change survives a registry reload.
    try:
        from worker_registry import WORKERS_DIR
        wpath = WORKERS_DIR / worker_id / "worker.yml"
        if wpath.exists():
            _patch_worker_contexts_in_yml(wpath, new_contexts)
    except Exception:
        logger.warning("PATCH %s: could not write contexts to worker.yml", worker_id, exc_info=True)
    return _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)


@app.post("/workers/{worker_id}/contexts", response_model=WorkerDetail)
def attach_worker_context(
    worker_id: str,
    payload: _WorkerContextAttachRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#790: attach a brain folder to a worker (or update its writeable flag)."""
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="context name required")

    def _add(contexts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        for c in contexts:
            if c["name"] == name:
                c["writeable"] = payload.writeable
                return contexts
        contexts.append({"name": name, "writeable": payload.writeable})
        return contexts

    return _mutate_worker_contexts(worker_id, _add, auth=auth, repos=repos)


@app.patch("/workers/{worker_id}/contexts/{context_name}", response_model=WorkerDetail)
def update_worker_context(
    worker_id: str,
    context_name: str,
    payload: _WorkerContextUpdateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#790: change a mounted brain folder's read/write access."""
    found = {"hit": False}

    def _update(contexts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        for c in contexts:
            if c["name"] == context_name:
                c["writeable"] = payload.writeable
                found["hit"] = True
        return contexts

    detail = _mutate_worker_contexts(worker_id, _update, auth=auth, repos=repos)
    if not found["hit"]:
        raise HTTPException(status_code=404, detail="Context not attached to this worker")
    return detail


@app.delete("/workers/{worker_id}/contexts/{context_name}", response_model=WorkerDetail)
def detach_worker_context(
    worker_id: str,
    context_name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#790: detach a brain folder from a worker."""
    found = {"hit": False}

    def _remove(contexts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        kept = [c for c in contexts if c["name"] != context_name]
        found["hit"] = len(kept) != len(contexts)
        return kept

    detail = _mutate_worker_contexts(worker_id, _remove, auth=auth, repos=repos)
    if not found["hit"]:
        raise HTTPException(status_code=404, detail="Context not attached to this worker")
    return detail


@app.post("/workers/{worker_id}/pause", response_model=WorkerDetail)
def pause_worker(
    worker_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#788: pause a worker (enabled=false) so it stops running on schedule."""
    return _set_worker_enabled(worker_id, enabled=False, auth=auth, repos=repos, request=request)


@app.post("/workers/{worker_id}/resume", response_model=WorkerDetail)
def resume_worker(
    worker_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#788: resume a paused worker (enabled=true) and re-enqueue its schedule."""
    return _set_worker_enabled(worker_id, enabled=True, auth=auth, repos=repos, request=request)


# ---------------------------------------------------------------------------
# DELETE /workers/{worker_id}
# ---------------------------------------------------------------------------

def _delete_worker_impl(worker_id: str, owner_id: str, repos: Repositories) -> None:
    """Core delete-worker logic, shared by the DELETE endpoint and approval execution."""
    worker_id = _canonical_worker_id(worker_id)
    _raise_if_protected_worker_mutation(worker_id)
    worker = repos.workers.get(user_id=owner_id, worker_id=worker_id)
    if not worker:
        bundle_dir = WORKERS_DIR / worker_id
        if bundle_dir.is_dir():
            shutil.rmtree(bundle_dir, ignore_errors=True)
            invalidate_worker_cache()
            logger.info("Removed orphaned worker bundle dir %s", bundle_dir)
            return
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
    active_runs = repos.workers.list_active_run_ids(user_id=owner_id, worker_id=worker_id)

    for run_id in active_runs:
        try:
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error="Worker deleted",
                user_id=owner_id,
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
    repos.workers.delete(user_id=owner_id, worker_id=worker_id)

    # Check if skill_version is still referenced by other workers; preserve if so.
    ref_count = repos.workers.get_skill_version_ref_count(skill_version_id=skill_version_id)
    if ref_count == 0 and skill_version_id:
        repos.workers.delete_skill_version(skill_version_id=skill_version_id)
        logger.info("Removed unreferenced skill_version %s", skill_version_id)

    # Remove bundle files from disk only if no other worker references this skill_version
    bundle_dir = WORKERS_DIR / worker_id
    if ref_count == 0 and bundle_dir.is_dir():
        try:
            shutil.rmtree(bundle_dir)
            logger.info("Removed bundle dir %s", bundle_dir)
            # Record the deletion in git history (files gone, history preserved)
            try:
                workspace = _git_workspace()
                prefix = _workers_git_prefix()
                with _git_ops_lock:
                    _ensure_git_workspace_ready(workspace)
                    _git_ops.commit_paths(workspace, [f"{prefix}/{worker_id}"], f"worker: delete {worker_id}")
            except Exception as _git_exc:
                logger.warning("git commit for worker deletion failed (non-fatal): %s", _git_exc)
        except Exception as exc:
            logger.warning("Could not remove bundle dir %s: %s", bundle_dir, exc)
    elif ref_count > 0:
        logger.info("skill_version %s still referenced by %d workers, bundle preserved", skill_version_id, ref_count)

    invalidate_worker_cache()


@app.delete("/workers/{worker_id}", status_code=204)
def delete_worker(
    worker_id: str,
    request: Request,
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
    _require_worker_write_workspace_context(request)
    # Owner-gate: a member must not be able to delete (or no-op-204 against)
    # another member's worker. _get_visible_worker is now owner-scoped, so this
    # returns 404 for a worker the caller can't see — consistent with GET/run/edit.
    #
    # Exception: filesystem-only orphans (no DB row) have no owner to protect.
    # When WORKEROS_ENABLE_USER_HEADER_SCOPE=1, _shared_filesystem_fallback_allowed()
    # is False, so _get_visible_worker returns None for orphan dirs — blocking
    # _delete_worker_impl's orphan-reap path (issue #810). We must fall through
    # to _delete_worker_impl when the worker has no DB row at all; only deny when
    # a DB row exists but isn't visible to the caller (owned by someone else).
    canonical_id = _canonical_worker_id(worker_id)
    if canonical_id in _db_worker_owners():
        # DB-backed worker: mutation rights are required — the caller must be
        # its owner, or an admin when it is workspace-shared (donation model:
        # the sharer is NOT the owner anymore and must get 404 here even
        # though the bundle dir still exists on disk; the filesystem-visibility
        # fallback below must never bypass DB ownership).
        if _worker_for_mutation(canonical_id, auth, repos) is None:
            raise HTTPException(status_code=404, detail="Worker not found")
    elif _get_visible_worker(canonical_id, user_id=auth.user_id, repos=repos) is None:
        # No DB row anywhere: a true orphan (directory without DB row) falls
        # through so _delete_worker_impl can reap it (issue #810); anything
        # else invisible stays a 404.
        if canonical_id in _db_worker_owners():
            raise HTTPException(status_code=404, detail="Worker not found")
    _delete_worker_impl(worker_id, auth.user_id, repos)
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
    from pathlib import Path
    inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
    csv_path = inputs["csv_data"]            # FILE input -> value IS the path
    rows = list(csv.reader(open(csv_path, encoding="utf-8")))
    # ...enrich rows...
    os.makedirs("out", exist_ok=True)
    out_path = "out/result.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(rows)
    Path("result.json").write_text(json.dumps({
        "status": "success",
        "outputs": {"result": out_path},
        "artifacts": [{"name": out_path, "relative_path": out_path, "type": "text/csv"}],
    }, encoding='utf-8'), encoding="utf-8")
  requirements.txt: |
    # stdlib only — no third-party deps needed

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
    from pathlib import Path
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
  "outputs": [{"name": "summary", "type": "markdown", "label": "Summary"}],
  "sample_input_json": "<JSON object string with a realistic value for EVERY input>"
}

=== SAMPLE INPUT RULE (so the worker is one-click runnable) ===
- ALWAYS return `sample_input_json`: a JSON object string with one realistic
  value for EVERY input the worker declares, scalar AND file.
- For a FILE input, the value MUST be the file's INLINE TEXT CONTENT as a string
  (e.g. a small CSV "name\\nalice\\nbob\\n"), NEVER a path or placeholder. The
  platform turns it into a real uploaded file so the operator can run the worker
  immediately with no manual upload.

=== RUN.PY CONTRACT (script mode — these EXACT mistakes crash generated workers) ===
When you emit run.py, follow this contract EXACTLY:
- Read inputs: `inputs = json.loads(Path("inputs.json").read_text(encoding='utf-8'))`. A SCALAR
  input is the literal value inline (use it directly, never open() it). A FILE
  input's value IS already the relative path (e.g. "inputs/csv_file") — open() it
  directly; NEVER os.path.join("inputs", value) (double-prepend is a top crash).
- Use ONLY the Python standard library unless you ALSO list the package in
  requirements.txt. NEVER `import dotenv` / `from dotenv import ...` (NOT installed
  -> ModuleNotFoundError). Read secrets from os.environ with a secrets.json fallback.
- import EVERY module you reference (os, json, csv, io, re, statistics, ...).
- OUTPUT CONTRACT (scalar vs file): a SCALAR output -> outputs[name] is the LITERAL
  VALUE (string/number), NEVER a path, no out/ file, no artifact (e.g.
  outputs={"reversed":"olleh"}). A FILE output -> write under out/ (mkdir it) and
  put the relative path in outputs[name] + one artifacts[] entry.
- IMPLEMENT EVERY declared output FULLY: if the prompt asks for several results
  (words AND sentences AND average length), compute ALL of them — never return
  only the first.
- Write result.json to the WORKING DIRECTORY ("result.json", NOT "out/result.json")
  on BOTH success and error: {"status":"success"|"error","outputs":{...},
  "artifacts":[{"name","relative_path","type"}],"error":<msg-on-error>}.
- End with `if __name__ == "__main__": main()`.

Worked run.py examples (copy the matching shape):
  # reverse a string (scalar in -> scalar out):
  #   import json; from pathlib import Path
  #   inputs = json.loads(Path("inputs.json").read_text(encoding='utf-8'))
  #   Path("result.json").write_text(json.dumps({"status":"success",
  #     "outputs":{"reversed": str(inputs["text"], encoding='utf-8')[::-1]}, "artifacts":[], "error":None}))
  # word+char+sentence count (scalar in -> json file out, ALL three computed):
  #   import json, re, os; from pathlib import Path
  #   t = str(json.loads(Path("inputs.json").read_text(encoding='utf-8')).get("text") or "")
  #   c = {"words":len(t.split()),"chars":len(t),
  #        "sentences":len([s for s in re.split(r"[.!?]+",t) if s.strip()])}
  #   os.makedirs("out",exist_ok=True); Path("out/counts.json").write_text(json.dumps(c), encoding='utf-8')
  #   Path("result.json").write_text(json.dumps({"status":"success",
  #     "outputs":{"counts":"out/counts.json"},
  #     "artifacts":[{"name":"out/counts.json","relative_path":"out/counts.json","type":"application/json"}],"error":None}), encoding='utf-8')

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
        if not dq:
            _draft_rate_store.pop(key, None)
            dq = _draft_rate_store.setdefault(key, collections.deque())
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
    user_message: str,
    extra_system_instructions: Optional[str] = None,
) -> Dict[str, Any]:
    """Single LLM call returning a parsed JSON payload. Raises HTTPException on transport/JSON errors."""
    system_prompt = _DRAFT_SYSTEM_PROMPT
    if extra_system_instructions:
        system_prompt = f"{system_prompt}\n\n{extra_system_instructions}"

    try:
        from codegen_model import chat_completion_codegen

        response = chat_completion_codegen(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=0.2,
            max_output_tokens=8000,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        logger.exception("OpenAI call failed in draft-from-prompt")
        # #951: never echo raw provider errors (quota status, key fragments).
        from llm import safe_llm_error_message

        raise HTTPException(
            status_code=502,
            detail=safe_llm_error_message(exc, action="Worker generation"),
        ) from exc

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


def _repair_generated_worker_manifest(raw_manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize small schema drift in generated WorkerContract YAML.

    The worker-author and draft-from-prompt LLMs occasionally emit `schema_version`
    as a numeric scalar and omit the required top-level `version`. Repair those
    two cases in the generation path so the backend returns a valid contract
    instead of bouncing a retry on a trivially fixable format error.
    """
    repaired = dict(raw_manifest)
    schema_version = repaired.get("schema_version")
    if schema_version is not None and not isinstance(schema_version, str):
        repaired["schema_version"] = str(schema_version)
    if repaired.get("schema_version") == "0.3":
        version = repaired.get("version")
        if not isinstance(version, str) or not version.strip():
            repaired["version"] = "0.1.0"
        elif not version:
            repaired["version"] = "0.1.0"
    if "version" in repaired and repaired["version"] is not None and not isinstance(repaired["version"], str):
        repaired["version"] = str(repaired["version"])
    return repaired


@app.post("/workers/draft-from-prompt", response_model=DraftFromPromptResponse)
async def draft_worker_from_prompt(
    payload: DraftFromPromptRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> DraftFromPromptResponse:
    """Draft a WorkerContract YAML from a natural-language prompt using LLM."""
    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required and must not be empty")
    if len(prompt) > 4000:
        raise HTTPException(status_code=400, detail="prompt must be 4000 characters or fewer")

    import llm as _llm
    from codegen_model import codegen_model as _codegen_model
    if not _llm.provider_credentials_present(_codegen_model()):
        raise HTTPException(status_code=503, detail="No LLM provider configured: set OPENAI_API_KEY or AWS credentials for the configured model")
    _enforce_draft_rate_limit(request)

    # Pre-detect connections for the prompt to give the LLM a hint
    prompt_lower = prompt.lower()
    detected_connections = _detect_connections(prompt_lower)

    user_message = f"""Design a Workeros worker for this task:

{prompt}

Detected Composio apps that may be needed: {detected_connections if detected_connections else 'none detected, infer from context'}

Generate the full WorkerContract YAML and metadata JSON as specified. Make sure the YAML is valid and passes schema_version "0.3" validation. Always include version: "0.1.0" in the top-level manifest. Remember: every string scalar in the YAML must be wrapped in double quotes."""

    import yaml as pyyaml
    from models import parse_worker_manifest

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

        parsed = _call_draft_llm(user_message, extra_instructions)
        worker_yml = parsed.get("worker_yml", "")
        if not worker_yml:
            last_yaml_error = "empty worker_yml returned"
            continue

        try:
            raw_manifest = pyyaml.safe_load(worker_yml)
            if not isinstance(raw_manifest, dict):
                raise ValueError("worker_yml must be a YAML mapping")
            raw_manifest = _repair_generated_worker_manifest(raw_manifest)
            worker_yml = pyyaml.safe_dump(
                raw_manifest,
                sort_keys=False,
                default_flow_style=False,
            )
            parsed["worker_yml"] = worker_yml
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
    # FIX 4 (2026-05-29): both creation paths run the smoke+repair safety net.
    # smoke_status: "passed" | "failed" | "skipped" | None. When "failed" the
    # worker is created but DISABLED (stays editable) — surface the reason so
    # the caller does not present it as a clean, ready worker.
    smoke_status: Optional[str] = None
    smoke_reason: Optional[str] = None


def _slugify_worker_id(value: str) -> str:
    """Coerce an arbitrary id into a SLUG_PATTERN-valid slug.

    ``SLUG_PATTERN`` (``^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$``) forbids
    underscores, uppercase, leading/trailing hyphens, and ids shorter than 3
    chars. The 8 stock workers are underscore-named (``weekly_update`` etc.), so
    a clone base of ``weekly_update-copy`` is NOT a valid slug and would be
    rejected at registration with HTTP 400. Lowercase, replace every invalid
    character with a hyphen, collapse runs of hyphens, and strip leading/trailing
    hyphens so the result always matches SLUG_PATTERN (e.g. ``weekly_update`` ->
    ``weekly-update``). A too-short result is padded so the min-length rule holds.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if len(slug) < 3:
        slug = (slug + "-worker").strip("-")
    return slug


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


def _set_worker_yml_is_example(worker_yml: str, is_example: bool) -> str:
    """Set the manifest ``is_example`` flag (used when forking a stock worker).

    A clone-on-edit copy is a user-owned working worker, not a stock example,
    so its manifest must carry ``is_example: false`` instead of inheriting the
    stock source's ``is_example: true``.
    """
    import yaml as pyyaml

    raw = pyyaml.safe_load(worker_yml)
    if not isinstance(raw, dict):
        return worker_yml
    raw["is_example"] = is_example
    return pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False)


def _worker_record_from_worker_yml(worker_id: str, worker_yml: str) -> Dict[str, Any]:
    import yaml as pyyaml
    from models import (
        WorkerContract,
        parse_worker_manifest,
        worker_config_to_worker_contract,
        worker_contract_to_worker_config,
    )

    raw = pyyaml.safe_load(worker_yml)
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="worker_yml must contain a YAML mapping")
    parsed = parse_worker_manifest(raw)
    if isinstance(parsed, WorkerContract):
        contract = parsed
        config = worker_contract_to_worker_config(contract, worker_id)
    else:
        config = parsed
        contract = worker_config_to_worker_contract(config)
    return {
        "id": worker_id,
        "name": config.name,
        "description": config.description,
        "long_description": contract.long_description,
        "use_cases": contract.use_cases,
        "example_input": contract.example_input,
        "example_output": contract.example_output,
        "how_it_works": contract.how_it_works,
        "is_example": contract.is_example,
        "archived": contract.archived,
        "archive_reason": contract.archive_reason,
        "tags": contract.tags or [],
        "folder": contract.folder,
        "config": config.model_dump(),
        "manifest": contract.model_dump(mode="json", exclude_none=True),
        "status": "healthy",
        "trigger_type": config.trigger.type,
        "runner": config.runtime.runner,
        # Visibility from worker.yml — if set, used as the initial value on create/reload.
        # "private" is the safe default if not specified in the manifest.
        "visibility": contract.visibility or "private",
    }


def _raw_worker_id_from_worker_yml(worker_yml: str) -> str:
    import yaml as pyyaml

    try:
        raw = pyyaml.safe_load(worker_yml)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="worker_yml must contain a YAML mapping")
    return str(raw.get("id") or raw.get("name") or "").strip()


def _write_worker_bundle_files(
    target_dir: Path,
    *,
    worker_yml: str,
    run_py: str,
    skill_md: Optional[str],
    config: WorkerConfig,
) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / "worker.yml").write_text(worker_yml, encoding="utf-8")
    (target_dir / "run.py").write_text(run_py, encoding="utf-8")
    (target_dir / "requirements.txt").write_text("", encoding="utf-8")
    if skill_md:
        (target_dir / "SKILL.md").write_text(skill_md, encoding="utf-8")
    else:
        (target_dir / "SKILL.md").write_text(
            f"# {config.name}\n\n"
            "This WorkerContract entrypoint is a placeholder for the markdown skill runtime. "
            "Current Workeros execution uses `exec.command` from `worker.yml`.\n",
            encoding="utf-8",
        )


def _cleanup_worker_create_state(
    *,
    worker_id: str,
    user_id: str,
    repos: Repositories,
    staging_dir: Optional[Path] = None,
    target_dir: Optional[Path] = None,
    skill_version_id: Optional[str] = None,
    delete_persisted: bool = True,
) -> None:
    for path in (staging_dir, target_dir):
        if path and path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
    if not delete_persisted:
        invalidate_worker_cache()
        return
    try:
        repos.workers.delete(user_id=user_id, worker_id=worker_id)
    except Exception:
        logger.debug("worker create cleanup repo delete failed for %s", worker_id, exc_info=True)
    try:
        with get_db() as conn:
            conn.execute("DELETE FROM worker_triggers WHERE worker_id = ?", (worker_id,))
            conn.execute("DELETE FROM workers WHERE id = ? AND owner_id = ?", (worker_id, user_id))
            if skill_version_id:
                conn.execute(
                    """
                    DELETE FROM skill_versions
                    WHERE id = ?
                      AND NOT EXISTS (
                          SELECT 1 FROM workers WHERE skill_version_id = ?
                      )
                    """,
                    (skill_version_id, skill_version_id),
                )
    except Exception:
        logger.debug("worker create cleanup sqlite delete failed for %s", worker_id, exc_info=True)
    invalidate_worker_cache()


# Placeholder run.py for a script worker created without code (e.g. the
# worker-author drafted a script-mode worker but returned no run_code, or a
# .md upload). It MUST satisfy BOTH execution contracts:
#   - E2B pure-script (the default runner): `python run.py` must WRITE
#     result.json with {"status","outputs","artifacts"} or the run fails with
#     error_code=missing_result (live-found 2026-05-29 — a runnable worker is
#     part of the wedge gate).
#   - Legacy local runner: a `run(inputs, context)` callable.
_DEFAULT_RUN_PY_STUB = (
    "import json\n"
    "from pathlib import Path\n"
    "from typing import Dict, Any\n\n\n"
    "def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:\n"
    "    # Placeholder worker — edit run.py to do the real work.\n"
    "    return {\"status\": \"success\", \"outputs\": {}, \"artifacts\": []}\n\n\n"
    "if __name__ == \"__main__\":\n"
    "    # E2B pure-script entry: write result.json so the run does not fail\n"
    "    # with missing_result. Edit this to produce real outputs.\n"
    "    Path(\"result.json\").write_text(\n"
    "        json.dumps({\"status\": \"success\", \"outputs\": {}, \"artifacts\": []}),\n"
    "        encoding='utf-8',\n"
    "    )\n"
)


def _register_worker_from_files(
    files: List[DraftFile],
    *,
    user_id: str | None,
    repos: "Repositories | None" = None,
    dedupe_id: bool = False,
) -> str:
    """Write a worker bundle (``files``) to disk and register it in the DB.

    This is the single, shared registration path used by BOTH the
    ``/workers/draft-and-create`` files branch AND the worker-author
    post-completion hook (``run_service._register_authored_worker``) so the
    prompt-to-worker flow yields a real, editable, runnable worker rather than
    dead-ending on a drafted bundle.json.

    ``files`` must include ``worker.yml``. ``run.py`` and ``requirements.txt``
    are backfilled with safe defaults when absent (matching the upload flow).

    When ``dedupe_id`` is True (the author hook), a colliding worker id is
    rewritten to a free id instead of raising 409 — the worker-author LLM
    frequently reuses a suggested id, and a generation must never fail just
    because the slug is taken (#186 pattern).

    Returns the registered ``worker_id``. Raises ``HTTPException`` on invalid
    YAML / write failure / DB conflict so the existing endpoint behaviour is
    unchanged.
    """
    from worker_registry import WORKERS_DIR

    draft_files: List[DraftFile] = []
    for f in files:
        path = (f.path or "").strip()
        parts = path.replace("\\", "/").split("/")
        if any(p in ("", "..") for p in parts):
            raise HTTPException(status_code=400, detail=f"Invalid path: {path!r}")
        draft_files.append(f)

    worker_yml_file = next((f for f in draft_files if f.path == "worker.yml"), None)
    if not worker_yml_file:
        raise HTTPException(status_code=400, detail="files must include worker.yml")

    worker_id, _config = _parse_worker_payload(worker_yml_file.content, user_id=user_id)

    # The author hook can collide on a reused suggested id; allocate a free id
    # and rewrite the manifest identity so dir + worker.yml + DB row all agree.
    if dedupe_id:
        free_id = _free_worker_id(worker_id, repos=repos)
        if free_id != worker_id:
            new_yml = _rewrite_worker_yml_id(worker_yml_file.content, free_id)
            worker_id = free_id
            worker_yml_file.content = new_yml

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
            (dest / parts[-1]).write_text(f.content, encoding='utf-8')

        if not (target_dir / "run.py").exists():
            (target_dir / "run.py").write_text(_DEFAULT_RUN_PY_STUB, encoding='utf-8')
        if not (target_dir / "requirements.txt").exists():
            (target_dir / "requirements.txt").write_text("", encoding='utf-8')
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
            _persist_discovered_workers(conn, workers, user_id=user_id)
        except (sqlite3.IntegrityError, RuntimeError) as exc:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            invalidate_worker_cache()
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    try:
        _embed_files_in_skill_version(worker_id, target_dir)
    except Exception:
        logger.warning("Failed to embed files in DB for worker %s", worker_id, exc_info=True)

    return worker_id


def persist_worker_run_py(worker_id: str, run_py: str, *, user_id: str | None) -> None:
    """Persist a repaired ``run.py`` for ``worker_id`` through the canonical path.

    This is the SAME on-disk-write + cache-invalidate + re-discover + recipe
    re-persist that the editor (`update_worker_files`) uses, factored out so the
    smoke-repair loop persists a fix exactly the way a manual edit would. The
    executor reads ``run.py`` from disk (`WORKERS_DIR/worker_id`) on every run, so
    writing the file here is what reaches the run; the discover+persist keeps the
    registered recipe/cache in sync so the worker is never registered against a
    stale manifest after a repair.

    Raises on failure (path-traversal, write error, persist error) so the caller
    can treat an un-persisted repair as a smoke FAILURE (disable the worker)
    instead of silently shipping the worker against unverified disk state.
    """
    from worker_registry import WORKERS_DIR

    target_dir = (WORKERS_DIR / worker_id).resolve()
    run_py_path = (target_dir / "run.py").resolve()
    # Path-safety: the resolved file must stay inside the worker's own dir.
    try:
        run_py_path.relative_to(target_dir)
    except ValueError as exc:
        raise ValueError(
            f"refusing to write run.py outside worker dir: {run_py_path}"
        ) from exc
    if not target_dir.is_dir():
        raise FileNotFoundError(f"worker directory not found: {target_dir}")

    run_py_path.write_text(run_py, encoding="utf-8")

    invalidate_worker_cache()
    workers = discover_workers()
    this_worker_list = [w for w in workers if w["id"] == worker_id]
    if not this_worker_list:
        raise RuntimeError(f"worker {worker_id!r} not found after repair persist")
    with get_db() as conn:
        _persist_discovered_workers(conn, this_worker_list, user_id=user_id)

    try:
        _embed_files_in_skill_version(worker_id, target_dir)
    except Exception:
        logger.warning("Failed to embed files in DB for worker %s", worker_id, exc_info=True)


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

    async def _smoke_gate_and_respond(
        created_worker_id: str,
        sample_input: Any,
        *,
        allow_code_repair: bool,
    ) -> DraftAndCreateResponse:
        # Wedge safety net (FIX 4, 2026-05-29): unify the raw create path with the
        # UI worker-author path. Prove the SCRIPT-mode worker actually RUNS,
        # validate it produces real output, and gate it: a smoke-failed worker is
        # DISABLED (not deleted — stays editable) so it is never presented as a
        # clean, ready worker. Runs on a worker thread so the E2B run does not
        # block the event loop. Never fails the create.
        #
        # allow_code_repair (least-surprise, 2026-05-29): TRUE only for the
        # LLM-generated draft (Path B), where bounded auto-repair of run.py is the
        # wedge. FALSE for USER-SUPPLIED uploads (Path A) — those are smoked and
        # gated but the user's run.py is NEVER rewritten.
        smoke_result: Optional[Dict[str, Any]] = None
        try:
            smoke_bundle: Dict[str, Any] = {}
            if isinstance(sample_input, dict):
                smoke_bundle["example_input"] = sample_input
            try:
                manifest_text = (WORKERS_DIR / created_worker_id / "worker.yml").read_text(encoding="utf-8")
                smoke_bundle["worker_yml"] = manifest_text
            except OSError:
                pass

            def _draft_smoke_log(msg: str, level: str = "info") -> None:
                logger.info("draft-and-create smoke %s: %s", created_worker_id, msg)

            smoke_result = await asyncio.to_thread(
                smoke_and_gate_generated_worker,
                created_worker_id,
                smoke_bundle,
                user_id=auth.user_id,
                repos=repos,
                log_fn=_draft_smoke_log,
                allow_code_repair=allow_code_repair,
            )
        except Exception:
            logger.exception("draft-and-create smoke+gate failed for %s", created_worker_id)

        if isinstance(smoke_result, dict) and smoke_result.get("status") == "failed":
            return DraftAndCreateResponse(
                worker_id=created_worker_id,
                smoke_status="failed",
                smoke_reason=(
                    humanize_smoke_reason(smoke_result.get("reason"))
                    or "This worker's first test run failed. Edit it, then re-run."
                ),
            )
        return DraftAndCreateResponse(
            worker_id=created_worker_id,
            smoke_status=(smoke_result.get("status") if isinstance(smoke_result, dict) else None),
        )

    # ----------------------------------------------------------------
    # Path A: pre-supplied files (upload flow — skip LLM)
    # ----------------------------------------------------------------
    if payload.files:
        _enforce_draft_rate_limit(request)
        worker_id = _register_worker_from_files(
            payload.files,
            user_id=auth.user_id,
            repos=repos,
        )
        sample_input = None
        try:
            cfg = get_worker_config_for_run(worker_id)
            sample_input = getattr(cfg, "example_input", None)
        except Exception:
            sample_input = None
        # Path A is USER-SUPPLIED code: smoke + gate it, but never rewrite the
        # user's run.py (least-surprise).
        return await _smoke_gate_and_respond(
            worker_id, sample_input, allow_code_repair=False
        )

    # ----------------------------------------------------------------
    # Path B: LLM draft from prompt
    # ----------------------------------------------------------------
    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt or files is required")
    if len(prompt) > 4000:
        raise HTTPException(status_code=400, detail="prompt must be 4000 characters or fewer")

    import llm as _llm
    from codegen_model import codegen_model as _codegen_model
    if not _llm.provider_credentials_present(_codegen_model()):
        raise HTTPException(status_code=503, detail="No LLM provider configured: set OPENAI_API_KEY or AWS credentials for the configured model")
    _enforce_draft_rate_limit(request)

    prompt_lower = prompt.lower()
    detected_connections = _detect_connections(prompt_lower)

    user_message = (
        f"Design a Workeros worker for this task:\n\n{prompt}\n\n"
        f"Detected Composio apps that may be needed: "
        f"{detected_connections if detected_connections else 'none detected, infer from context'}\n\n"
        "Generate the full WorkerContract YAML and metadata JSON as specified. "
        "Make sure the YAML is valid and passes schema_version \"0.3\" validation. "
        "Always include version: \"0.1.0\" in the top-level manifest. "
        "Remember: every string scalar in the YAML must be wrapped in double quotes."
    )

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

        parsed_llm = _call_draft_llm(user_message, extra_instructions)
        worker_yml_str = parsed_llm.get("worker_yml", "")
        if not worker_yml_str:
            last_yaml_error = "empty worker_yml returned"
            continue

        try:
            raw_manifest = pyyaml.safe_load(worker_yml_str)
            if not isinstance(raw_manifest, dict):
                raise ValueError("worker_yml must be a YAML mapping")
            raw_manifest = _repair_generated_worker_manifest(raw_manifest)
            worker_yml_str = pyyaml.safe_dump(
                raw_manifest,
                sort_keys=False,
                default_flow_style=False,
            )
            parsed_llm["worker_yml"] = worker_yml_str
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

    # G5 FIX 4: guarantee a runnable "Fill with sample input" even when the LLM
    # omits example_input — backfill it into the worker.yml from the bundle's
    # sample_input_json (the realistic values it already produced). Mirrors the
    # worker-author run path (_backfill_example_input).
    from run_service import _backfill_example_input as _backfill_ex

    def _draft_backfill_log(msg: str, level: str = "info") -> None:
        logger.info("draft-and-create %s: %s", worker_id, msg)

    backfilled_yml = _backfill_ex(
        worker_yml_str, parsed_llm.get("sample_input_json"), _draft_backfill_log
    )
    if backfilled_yml != worker_yml_str:
        worker_yml_str = backfilled_yml
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
            (dest / parts[-1]).write_text(f.content, encoding='utf-8')

        if not (target_dir / "run.py").exists():
            (target_dir / "run.py").write_text(_DEFAULT_RUN_PY_STUB, encoding='utf-8')
        if not (target_dir / "requirements.txt").exists():
            (target_dir / "requirements.txt").write_text("", encoding='utf-8')
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

    sample_input = None
    try:
        # Read the freshly-persisted config so the smoke run uses the
        # backfilled example_input (G5 FIX 4), not the pre-backfill parse.
        _persisted_cfg = get_worker_config_for_run(worker_id)
        sample_input = getattr(_persisted_cfg, "example_input", None)
    except Exception:
        sample_input = getattr(_config2, "example_input", None)
    # Path B is LLM-GENERATED code: bounded auto-repair of run.py is the wedge.
    return await _smoke_gate_and_respond(
        worker_id, sample_input, allow_code_repair=True
    )


def _parse_worker_payload(
    worker_yml: str,
    *,
    user_id: str | None = None,
    allow_protected_worker_id: bool = False,
) -> tuple[str, WorkerConfig]:
    import yaml as pyyaml

    try:
        raw = pyyaml.safe_load(worker_yml)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {exc}")
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="worker_yml must contain a YAML mapping")
    raw_worker_id = str(raw.get("id") or raw.get("name") or "").strip()
    if raw_worker_id in PROTECTED_STOCK_WORKER_IDS and not allow_protected_worker_id:
        _raise_if_protected_worker_mutation(raw_worker_id)

    # Reject connections nested under exec: — a common authoring mistake that
    # silently ignores the connections list (WorkerContract only reads top-level
    # connections:). Catch it BEFORE Pydantic parsing so the error is clear.
    raw_exec_pre = raw.get("exec") if isinstance(raw.get("exec"), dict) else {}
    if raw_exec_pre.get("connections") is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                "connections: must be a top-level field, not nested under exec:. "
                "Move it to the top level."
            ),
        )

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

    raw_runner = None
    if isinstance(raw_exec.get("runner"), str):
        raw_runner = raw_exec["runner"]
    elif isinstance(raw_runtime.get("runner"), str):
        raw_runner = raw_runtime["runner"]
    elif isinstance(raw.get("runner"), str):
        raw_runner = raw["runner"]
    if raw_runner and raw_runner.strip().lower() == "local":
        raise HTTPException(
            status_code=400,
            detail=(
                "exec.runner: local is not supported by the hosted Workeros API. "
                "Set exec.runner: e2b for workers created through the API or MCP."
            ),
        )

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
    if len(worker_id) > 64:
        raise HTTPException(status_code=422, detail=f"Worker ID must be 64 characters or fewer (got {len(worker_id)})")
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
                context_is_mountable = _is_system_context_pack(
                    context_name,
                    metadata,
                ) or _context_visible_to_user(
                    context_name,
                    user_id=user_id,
                    metadata=metadata,
                )
                if not context_dir(context_name).is_dir() or not context_is_mountable:
                    raise HTTPException(status_code=400, detail=f"Context not found: {context_name}")
    if worker_id in PROTECTED_STOCK_WORKER_IDS and not allow_protected_worker_id:
        _raise_if_protected_worker_mutation(worker_id)
    return worker_id, config
def _reject_raw_local_runner_on_create(worker_yml: str) -> None:
    import yaml as pyyaml

    try:
        raw = pyyaml.safe_load(worker_yml)
    except Exception:
        return
    if not isinstance(raw, dict):
        return
    candidates = []
    for section in (raw.get("exec"), raw.get("runtime"), raw):
        if isinstance(section, dict):
            candidates.append(str(section.get("runner") or "").strip().lower())
    if "local" in candidates:
        raise HTTPException(
            status_code=400,
            detail=(
                "exec.runner: local is not supported by the hosted Workeros API. "
                "Set exec.runner: e2b for workers created through the API or MCP."
            ),
        )


def _create_worker_from_parsed_payload(
    *,
    worker_id: str,
    worker_yml: str,
    payload: WorkerCreateRequest,
    config: WorkerConfig,
    auth: AuthContext,
    repos: Repositories,
) -> WorkerDetail:
    from worker_registry import WORKERS_DIR

    create_lock = _acquire_worker_create_lock(worker_id)
    try:
        target_dir = WORKERS_DIR / worker_id
        if target_dir.exists():
            raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")
        try:
            if repos.workers.get_any(worker_id=worker_id) is not None:
                raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")
        except HTTPException:
            raise
        except Exception:
            logger.warning("worker existence lookup failed for %s", worker_id, exc_info=True)

        staging_dir = Path(tempfile.mkdtemp(prefix=f".{worker_id}.", dir=str(WORKERS_DIR.parent)))
        worker_record: Optional[Dict[str, Any]] = None
        skill_version_id: Optional[str] = None
        create_complete = False
        target_committed = False
        delete_persisted = True
        try:
            _write_worker_bundle_files(
                staging_dir,
                worker_yml=worker_yml,
                run_py=payload.run_py,
                skill_md=payload.skill_md,
                config=config,
            )
            worker_record = _worker_record_from_worker_yml(worker_id, worker_yml)
            skill_version_id = _skill_version_id(worker_id, worker_record.get("manifest") or {})
            invalidate_worker_cache()
            with get_db() as conn:
                _persist_discovered_workers(conn, [worker_record], user_id=auth.user_id)
            _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)
            os.replace(staging_dir, target_dir)
            target_committed = True
            try:
                _embed_files_in_skill_version(worker_id, target_dir)
            except Exception:
                logger.warning("Failed to embed files in DB for worker %s", worker_id, exc_info=True)
            invalidate_worker_cache()
            detail = _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)
            # Commit new worker files to the workspace git repo.
            author_name, author_email = _git_author(auth)
            worker_name = (config.name if config else None) or worker_id
            _git_commit_worker(
                worker_id,
                message=f"worker: create {worker_name}",
                author_name=author_name,
                author_email=author_email,
            )
            create_complete = True
            return detail
        except sqlite3.IntegrityError as exc:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Worker {worker_id!r} already exists or conflicts with a previous version. "
                    "Delete the old worker first, then recreate."
                ),
            ) from exc
        except FileExistsError as exc:
            delete_persisted = False
            raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to create worker {worker_id!r}: {exc}") from exc
        finally:
            if not create_complete:
                _cleanup_worker_create_state(
                    worker_id=worker_id,
                    user_id=auth.user_id,
                    repos=repos,
                    staging_dir=staging_dir,
                    target_dir=target_dir if target_committed else None,
                    skill_version_id=skill_version_id,
                    delete_persisted=delete_persisted,
                )
    finally:
        create_lock.release()


def _apply_workspace_approval_default(worker_yml: str) -> str:
    """#794: at CREATE time, if the workspace `approval_default` is "always" and
    the manifest has no explicit `approvals` block, stamp approvals.required so
    the persisted worker.yml (the source of truth) carries the default. An
    explicit `approvals:` in the manifest is left untouched."""
    try:
        import yaml as _pyyaml
        from run_service import _workspace_setting

        if (_workspace_setting("approval_default") or "").strip().lower() != "always":
            return worker_yml
        raw = _pyyaml.safe_load(worker_yml)
        if not isinstance(raw, dict) or "approvals" in raw:
            return worker_yml
        raw["approvals"] = {"required": True}
        return _pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False, allow_unicode=True)
    except Exception:
        logger.debug("approval_default yaml injection failed", exc_info=True)
        return worker_yml


@app.post("/workers", response_model=WorkerDetail)
def create_worker(
    payload: WorkerCreateRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Create a new worker from YAML + Python source."""
    _require_worker_write_workspace_context(request)

    worker_yml = payload.worker_yml
    raw_worker_id = _raw_worker_id_from_worker_yml(worker_yml)
    if raw_worker_id in PROTECTED_STOCK_WORKER_IDS:
        worker_id = _free_worker_id(f"{_slugify_worker_id(raw_worker_id)}-copy", repos=repos)
        worker_yml = _set_worker_yml_is_example(
            _rewrite_worker_yml_id(worker_yml, worker_id),
            False,
        )
    else:
        worker_id = _canonical_worker_id(raw_worker_id)
        if worker_id != raw_worker_id:
            worker_yml = _rewrite_worker_yml_id(worker_yml, worker_id)
    _reject_raw_local_runner_on_create(worker_yml)
    worker_yml = _apply_workspace_approval_default(worker_yml)  # #794
    worker_id, config = _parse_worker_payload(worker_yml, user_id=auth.user_id)
    return _create_worker_from_parsed_payload(
        worker_id=worker_id,
        worker_yml=worker_yml,
        payload=payload,
        config=config,
        auth=auth,
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

    # Zip-bomb guards: cap total uncompressed size and entry count BEFORE
    # extracting so a tiny zip cannot exhaust memory/disk. ZipInfo.file_size
    # is the declared uncompressed size; we pre-check the sum, then re-guard
    # the running total during extraction in case a header lies.
    _MAX_BUNDLE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024  # 50 MB
    _MAX_BUNDLE_ENTRIES = 2000

    infolist = zf.infolist()
    if len(infolist) > _MAX_BUNDLE_ENTRIES:
        raise HTTPException(
            status_code=413,
            detail=f"Bundle has too many entries ({len(infolist)} > {_MAX_BUNDLE_ENTRIES})",
        )
    declared_total = 0
    for info in infolist:
        file_type = (info.external_attr >> 16) & 0o170000
        if file_type == 0o120000:
            raise HTTPException(status_code=400, detail=f"Bundle contains unsupported symlink: {info.filename!r}")
        declared_total += info.file_size
        if declared_total > _MAX_BUNDLE_UNCOMPRESSED_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Bundle too large: uncompressed size exceeds "
                    f"{_MAX_BUNDLE_UNCOMPRESSED_BYTES // (1024 * 1024)} MB"
                ),
            )

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
        extracted_total = 0
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
            # #932: strip secret-bearing files (.env, credentials.json, *.key,
            # ...) — export filters them out, so import must too, or a crafted
            # bundle can plant secrets that later leak via worker detail/share
            # endpoints or get committed to the workspace git repo.
            if _is_secret_bearing_export_path(rel):
                logger.info("from-bundle: stripped secret-bearing file %r", rel)
                continue
            data = zf.read(zip_name)
            # Re-guard the running total in case a ZipInfo header under-reported
            # the real uncompressed size (defends against a lying header).
            extracted_total += len(data)
            if extracted_total > _MAX_BUNDLE_UNCOMPRESSED_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"Bundle too large: uncompressed size exceeds "
                        f"{_MAX_BUNDLE_UNCOMPRESSED_BYTES // (1024 * 1024)} MB"
                    ),
                )
            dest = target_dir
            for part in parts[:-1]:
                dest = dest / part
                dest.mkdir(exist_ok=True)
            (dest / parts[-1]).write_bytes(data)
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
        run_py_path.write_text(_DEFAULT_RUN_PY_STUB, encoding='utf-8')

    # Ensure requirements.txt exists
    req_path = target_dir / "requirements.txt"
    if not req_path.exists():
        req_path.write_text("", encoding='utf-8')

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

    try:
        _embed_files_in_skill_version(worker_id, target_dir)
    except Exception:
        logger.warning("Failed to embed files in DB for worker %s", worker_id, exc_info=True)

    return _build_worker_detail(
        worker_id,
        user_id=auth.user_id,
        repos=repos,
    )


# ---------------------------------------------------------------------------
# Workspace duplicate (Notion-template style): export the operator's whole
# workspace (workers + knowledge packs + workspace-agent config) as a single
# downloadable .zip template, and import such a template into another
# workspace. A workspace = operator WORKERS + operator KNOWLEDGE PACKS +
# workspace.md. Reuses the per-worker bundle layout, the contexts create/upload
# path, and _register_worker_from_files for import.
#
# SECURITY: the export NEVER contains secret VALUES or connection tokens. It
# only carries the worker bundle files (worker.yml/run.py/SKILL.md/...) which
# declare required secrets/connections by NAME, plus operator knowledge-pack
# files (operator content), plus workspace.md. The importer reconnects secrets
# and connections itself. See _collect_workspace_secret_names() for the manifest
# names surface, and the test suite for the no-secret-value guarantee.
# ---------------------------------------------------------------------------

WORKSPACE_TEMPLATE_SCHEMA_VERSION = 1


def _is_exportable_operator_worker(w: Dict[str, Any]) -> bool:
    """True for a worker that belongs in a workspace template.

    Excludes example/stock workers and system workers. ``_list_operator_workers``
    already drops system_worker:true + archived + hidden; this adds the
    example/stock filter so a template carries only the operator's OWN authored
    workers (mirrors _is_example_worker in the overview).
    """
    wid = w.get("id")
    if not wid:
        return False
    if w.get("is_example") is True:
        return False
    manifest = w.get("manifest")
    if isinstance(manifest, dict) and manifest.get("is_example") is True:
        return False
    if wid in PUBLIC_STOCK_WORKER_IDS or wid in PROTECTED_STOCK_WORKER_IDS:
        return False
    if (manifest or {}).get("system_worker", False):
        return False
    return True


def _worker_required_secret_names(w: Dict[str, Any]) -> List[str]:
    """Required secret NAMES declared by a worker manifest (never values).

    The normalized ``WorkerConfig`` surfaces secrets at the top level
    (``config["secrets"]``); raw manifests may also nest them under
    ``capabilities.secrets`` / ``exec.secrets``. Read all three so the name list
    is complete regardless of which shape we got.
    """
    names: List[str] = []
    config = w.get("config") or {}
    for s in config.get("secrets") or []:
        if isinstance(s, str) and s.strip():
            names.append(s.strip())
    cap = config.get("capabilities") or {}
    for s in cap.get("secrets") or []:
        if isinstance(s, str) and s.strip():
            names.append(s.strip())
    exec_block = config.get("exec") or {}
    for s in exec_block.get("secrets") or []:
        if isinstance(s, str) and s.strip():
            names.append(s.strip())
    # de-dup, preserve order
    seen: set[str] = set()
    ordered: List[str] = []
    for n in names:
        if n not in seen:
            seen.add(n)
            ordered.append(n)
    return ordered


def _worker_connection_slugs(w: Dict[str, Any]) -> List[str]:
    """Required connection slugs declared by a worker manifest (never tokens)."""
    config = w.get("config") or {}
    raw = config.get("connections") or []
    slugs: List[str] = []
    for c in raw:
        if isinstance(c, str) and c.strip():
            slugs.append(c.strip())
        elif isinstance(c, dict):
            label = (c.get("mcp", {}) or {}).get("label") or c.get("app") or c.get("slug")
            if isinstance(label, str) and label.strip():
                slugs.append(label.strip())
    seen: set[str] = set()
    ordered: List[str] = []
    for s in slugs:
        if s not in seen:
            seen.add(s)
            ordered.append(s)
    return ordered


# Filenames / patterns that may hold secret VALUES and must NEVER be exported in
# a workspace template. A worker bundle is worker.yml + run.py / SKILL.md +
# requirements.txt + lib/*; a .env (or similar) is operator credential state,
# not bundle content. Defense-in-depth: a real worker dir should not contain
# these, but if one does we drop it rather than leak a secret value.
_WORKSPACE_EXPORT_SECRET_BASENAMES = frozenset({
    ".env",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "credentials",
    "credentials.json",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
    ".secrets",
})


def _is_secret_bearing_export_path(rel: str) -> bool:
    """True if a worker-dir file may carry secret values (excluded from export)."""
    base = rel.rsplit("/", 1)[-1].lower()
    if base in _WORKSPACE_EXPORT_SECRET_BASENAMES:
        return True
    # .env, .env.local, .env.production, foo.env, etc.
    if base == ".env" or base.startswith(".env.") or base.endswith(".env"):
        return True
    # Private keys / certs.
    if base.endswith((".pem", ".key", ".p12", ".pfx")):
        return True
    return False


def _iter_worker_dir_files(worker_id: str):
    """Yield (relpath, bytes) for every exportable file in a worker's dir.

    Skips symlinks (security), __pycache__ / *.pyc cruft, and any
    secret-bearing file (``.env`` and friends — see
    ``_is_secret_bearing_export_path``) so a template never carries a secret
    VALUE.
    """
    from worker_registry import WORKERS_DIR

    base = (WORKERS_DIR / worker_id).resolve()
    if not base.is_dir():
        return
    for path in sorted(base.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        rel = path.relative_to(base).as_posix()
        parts = rel.split("/")
        if "__pycache__" in parts or rel.endswith(".pyc"):
            continue
        if _is_secret_bearing_export_path(rel):
            continue
        yield rel, path.read_bytes()


def _build_workspace_template_zip(
    *,
    user_id: str,
    repos: Repositories,
    exported_at: Optional[str] = None,
) -> bytes:
    """Build the workspace template .zip and return its raw bytes.

    Shared by the authenticated ``GET /workspace/export`` download and the
    signed public ``GET /workspace/template/{token}`` share-link download so the
    bundle layout, the example/system exclusions, and the no-secret-value
    guarantee live in exactly ONE place.
    """
    # ---- workers --------------------------------------------------------
    all_operator = _list_operator_workers(user_id=user_id, repos=repos)
    workers = [w for w in all_operator if _is_exportable_operator_worker(w)]

    worker_manifest_entries: List[Dict[str, Any]] = []
    # Build the zip in memory.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for w in workers:
            wid = w["id"]
            file_count = 0
            for rel, data in _iter_worker_dir_files(wid):
                zf.writestr(f"workers/{wid}/{rel}", data)
                file_count += 1
            if file_count == 0:
                # No on-disk files (shouldn't happen for a real worker); skip so
                # we never emit an empty, un-importable worker entry.
                continue
            worker_manifest_entries.append({
                "id": wid,
                "name": w.get("name") or wid,
                "trigger_type": w.get("trigger_type"),
                "required_secrets": _worker_required_secret_names(w),
                "required_connections": _worker_connection_slugs(w),
                "file_count": file_count,
            })

        # ---- operator knowledge packs (contexts) ----------------------
        context_manifest_entries: List[Dict[str, Any]] = []
        ensure_contexts_dir()
        meta = load_context_metadata()
        root = current_contexts_root()
        if root.is_dir():
            for folder in sorted(root.iterdir(), key=lambda p: p.name):
                if not folder.is_dir() or folder.is_symlink() or folder.name.startswith("."):
                    continue
                # EXCLUDE system/engine packs and other users' packs.
                if _is_system_context_pack(folder.name, meta):
                    continue
                if not _context_visible_to_user(folder.name, user_id=user_id, metadata=meta):
                    continue
                pack_files = 0
                for fpath in iter_context_files(folder):
                    rel = fpath.relative_to(folder).as_posix()
                    parts = rel.split("/")
                    if "__pycache__" in parts or rel.endswith(".pyc"):
                        continue
                    # Defense-in-depth: never export a secret-bearing file even
                    # if an operator dropped one into a knowledge pack.
                    if _is_secret_bearing_export_path(rel):
                        continue
                    zf.writestr(f"contexts/{folder.name}/{rel}", fpath.read_bytes())
                    pack_files += 1
                writeable = bool((meta.get(folder.name) or {}).get("writeable", False))
                context_manifest_entries.append({
                    "name": folder.name,
                    "file_count": pack_files,
                    "writeable": writeable,
                })

        # ---- workspace-agent config (workspace.md) --------------------
        from chat_service import WORKSPACE_MD_PATH as _WS_MD_PATH
        has_workspace_md = bool(_WS_MD_PATH.is_file())
        if has_workspace_md:
            zf.writestr("workspace.md", _WS_MD_PATH.read_bytes())

        # ---- manifest -------------------------------------------------
        # Aggregate the full set of secret/connection NAMES to reconnect.
        all_secret_names: set[str] = set()
        all_conn_slugs: set[str] = set()
        for entry in worker_manifest_entries:
            all_secret_names.update(entry["required_secrets"])
            all_conn_slugs.update(entry["required_connections"])

        manifest = {
            "schema_version": WORKSPACE_TEMPLATE_SCHEMA_VERSION,
            "exported_at": (exported_at or datetime.now(timezone.utc).isoformat()),
            "workers": worker_manifest_entries,
            "contexts": context_manifest_entries,
            "has_workspace_md": has_workspace_md,
            "required_secrets": sorted(all_secret_names),
            "required_connections": sorted(all_conn_slugs),
            "counts": {
                "workers": len(worker_manifest_entries),
                "contexts": len(context_manifest_entries),
            },
        }
        zf.writestr("workspace.json", json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    return buf.getvalue()


WORKSPACE_TEMPLATE_FILENAME = "workeros-workspace-template.zip"


def _workspace_template_response(payload: bytes) -> Response:
    return Response(
        content=payload,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{WORKSPACE_TEMPLATE_FILENAME}"',
            "Cache-Control": "no-store",
        },
    )


@app.get("/workspace/export")
def export_workspace(
    exported_at: Optional[str] = Query(None),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """Export this workspace as a single downloadable .zip template.

    Bundles every NON-EXAMPLE, non-system operator worker (worker.yml + run.py /
    SKILL.md + requirements.txt + lib/*), every OPERATOR knowledge pack
    (contexts; system packs like worker-author-style and other users' packs are
    excluded), the workspace-agent config (workspace.md if present), and a
    ``workspace.json`` manifest.

    NO secret values or connection tokens are ever written — only the NAMES of
    required secrets/connections so the importer knows what to reconnect.
    """
    # #925: a full-workspace download is an admin capability — a compromised
    # member session must not be able to exfiltrate the whole workspace.
    _require_admin(auth)
    # #925/#948: every export is audit-logged with the actor — the structured
    # log (journalctl) AND a persistent, queryable audit row so a compromised-
    # admin exfiltration is reviewable after the fact.
    logger.info("workspace export by user=%s role=%s", auth.user_id, auth.role)
    try:
        with get_db() as _conn:
            _conn.execute(
                "INSERT INTO workspace_export_audit (id, user_id, role, exported_at) "
                "VALUES (?, ?, ?, ?)",
                (f"export_{_uuid_mod.uuid4().hex[:12]}", auth.user_id, auth.role, now_iso()),
            )
    except Exception:
        logger.warning("workspace export audit row insert failed", exc_info=True)
    payload = _build_workspace_template_zip(
        user_id=auth.user_id, repos=repos, exported_at=exported_at
    )
    return _workspace_template_response(payload)


@app.get("/workspace/export/audit")
def list_workspace_export_audit(
    limit: int = Query(50, ge=1, le=500),
    auth: AuthContext = Depends(get_auth_context),
) -> List[Dict[str, Any]]:
    """#925: admin-only review of the workspace-export audit trail."""
    _require_admin(auth)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, user_id, role, exported_at FROM workspace_export_audit "
            "ORDER BY exported_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Workspace share link (W9b): mint a signed, login-free URL that lets a
# recipient DOWNLOAD this workspace's template .zip, then import it into their
# own instance. Mirrors the worker share-link HMAC pattern
# (``_worker_public_token``): the token is bound to the owner so it can never
# resolve a different operator's template, and the public download carries the
# SAME no-secret-value guarantee as the authenticated export (it reuses
# ``_build_workspace_template_zip``).
# ---------------------------------------------------------------------------


def _workspace_share_payload(user_id: str) -> str:
    """Stable HMAC payload for an owner's workspace template share link."""
    return ".".join(("workspace-template", str(user_id or "")))


def _workspace_share_token(user_id: str) -> str:
    # #998: never sign/verify a public share token with a public constant —
    # a missing secret would let anyone forge share links. Fail closed.
    secret = (os.environ.get("FLOOM_SECRET") or "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="Server signing secret not configured")
    return hmac.new(
        secret.encode("utf-8"),
        _workspace_share_payload(user_id).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


class WorkspaceShareLinkResponse(BaseModel):
    url: str
    token: str


@app.get("/workspace/share-link", response_model=WorkspaceShareLinkResponse)
def workspace_share_link(
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceShareLinkResponse:
    """Return a signed, login-free URL to download this workspace as a template.

    The recipient opens the URL, downloads the .zip, and imports it via
    ``POST /workspace/import`` on their own instance. The link carries no secret
    values (see ``_build_workspace_template_zip``); the HMAC token is bound to
    the owner id so it cannot resolve another operator's workspace.
    """
    token = _workspace_share_token(auth.user_id)
    owner_q = urllib.parse.quote(auth.user_id, safe="")
    url = f"{_public_api_base_url()}/workspace/template/{token}?owner={owner_q}"
    return WorkspaceShareLinkResponse(url=url, token=token)


@app.get("/workspace/template/{token}")
def download_shared_workspace_template(
    token: str,
    owner: str = Query(..., min_length=1),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """Download a workspace template via a signed share link (no app login).

    Authenticated solely by the HMAC ``token`` bound to ``owner`` (constant-time
    compare). Reuses ``_build_workspace_template_zip`` so the public bundle is
    byte-for-byte the same allow-listed, secret-free template as the
    authenticated export.
    """
    expected = _workspace_share_token(owner)
    if not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid workspace link")
    payload = _build_workspace_template_zip(user_id=owner, repos=repos)
    return _workspace_template_response(payload)


class WorkspaceImportResponse(BaseModel):
    workers_imported: List[str] = []
    contexts_imported: List[str] = []
    skipped: List[Dict[str, str]] = []
    id_remaps: Dict[str, str] = {}
    required_secrets: List[str] = []
    required_connections: List[str] = []
    workspace_md_present: bool = False


def _safe_zip_rel(name: str) -> Optional[str]:
    """Sanitize a zip member name; reject traversal/absolute paths.

    Returns the cleaned posix-relative path, or None if the member should be
    skipped (directory entry) or rejected.
    """
    cleaned = (name or "").replace("\\", "/")
    if not cleaned or cleaned.endswith("/"):
        return None
    if cleaned.startswith("/"):
        raise HTTPException(status_code=400, detail=f"Unsafe path in zip: {name!r}")
    parts = cleaned.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise HTTPException(status_code=400, detail=f"Unsafe path in zip: {name!r}")
    return cleaned


@app.post("/workspace/import", response_model=WorkspaceImportResponse)
async def import_workspace(
    bundle: UploadFile = File(...),
    request: Request = None,  # type: ignore[assignment]
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkspaceImportResponse:
    """Import a workspace template .zip produced by GET /workspace/export.

    Unpacks the template, registers each worker via the shared
    ``_register_worker_from_files`` path (id-deduped — never clobbers an
    existing worker), and creates each knowledge pack + files. Returns a summary
    plus the list of secrets/connections the operator still needs to reconnect.
    """
    if request is not None:
        _enforce_draft_rate_limit(request)

    raw_bytes = await bundle.read()
    if len(raw_bytes) > WORKSPACE_IMPORT_BODY_LIMIT_BYTES:
        raise HTTPException(status_code=413, detail="Workspace template too large")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail=f"Not a valid zip file: {exc}")

    # #931: zip-bomb guards, mirroring POST /workers/from-bundle. The 50 MB
    # compressed cap alone let a highly-compressed archive expand to gigabytes
    # in memory. Enforce entry count + declared uncompressed size up front,
    # then re-guard the running total during extraction (lying headers).
    infolist = zf.infolist()
    if len(infolist) > _MAX_IMPORT_ENTRIES:
        raise HTTPException(
            status_code=413,
            detail=f"Template has too many entries ({len(infolist)} > {_MAX_IMPORT_ENTRIES})",
        )
    declared_total = 0
    for info in infolist:
        # Reject symlink members (security).
        file_type = (info.external_attr >> 16) & 0o170000
        if file_type == 0o120000:
            raise HTTPException(
                status_code=400,
                detail=f"Template contains unsupported symlink: {info.filename!r}",
            )
        declared_total += info.file_size
        if declared_total > _MAX_IMPORT_UNCOMPRESSED_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Template too large: uncompressed size exceeds "
                    f"{_MAX_IMPORT_UNCOMPRESSED_BYTES // (1024 * 1024)} MB"
                ),
            )

    names = zf.namelist()

    # ---- group members by worker id / context name ---------------------
    worker_files: Dict[str, List[DraftFile]] = collections.OrderedDict()
    context_files: Dict[str, List[tuple[str, bytes]]] = collections.OrderedDict()
    extracted_total = 0

    def _read_member_guarded(member_name: str) -> bytes:
        nonlocal extracted_total
        data = zf.read(member_name)
        extracted_total += len(data)
        if extracted_total > _MAX_IMPORT_UNCOMPRESSED_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Template too large: uncompressed size exceeds "
                    f"{_MAX_IMPORT_UNCOMPRESSED_BYTES // (1024 * 1024)} MB"
                ),
            )
        return data

    for name in names:
        rel = _safe_zip_rel(name)
        if rel is None:
            continue
        parts = rel.split("/")
        if parts[0] == "workers" and len(parts) >= 3:
            wid = parts[1]
            inner = "/".join(parts[2:])
            # Decode worker bundle files as text (they are YAML/py/md/txt).
            try:
                content = _read_member_guarded(name).decode("utf-8")
            except UnicodeDecodeError:
                raise HTTPException(
                    status_code=400,
                    detail=f"Worker file {rel!r} is not valid UTF-8 text",
                )
            worker_files.setdefault(wid, []).append(DraftFile(path=inner, content=content))
        elif parts[0] == "contexts" and len(parts) >= 3:
            cname = parts[1]
            inner = "/".join(parts[2:])
            context_files.setdefault(cname, []).append((inner, _read_member_guarded(name)))
        # workspace.md / workspace.json and anything else are intentionally
        # ignored for import (workspace.md is operator-agent config that the
        # importer reviews, not auto-overwritten).

    workers_imported: List[str] = []
    contexts_imported: List[str] = []
    skipped: List[Dict[str, str]] = []
    id_remaps: Dict[str, str] = {}

    # ---- register workers (id-dedup, never clobber) --------------------
    for wid, files in worker_files.items():
        if not any(f.path == "worker.yml" for f in files):
            skipped.append({"type": "worker", "id": wid, "reason": "missing worker.yml"})
            continue
        try:
            new_id = _register_worker_from_files(
                files,
                user_id=auth.user_id,
                repos=repos,
                dedupe_id=True,
            )
        except HTTPException as exc:
            skipped.append({"type": "worker", "id": wid, "reason": str(exc.detail)})
            continue
        workers_imported.append(new_id)
        if new_id != wid:
            id_remaps[wid] = new_id

    # ---- create knowledge packs (skip existing, never clobber) ---------
    meta = load_context_metadata()
    for cname, files in context_files.items():
        try:
            safe_name = validate_context_name(cname)
        except ValueError:
            skipped.append({"type": "context", "id": cname, "reason": "invalid pack name"})
            continue
        try:
            dir_path = context_dir(safe_name)
        except ValueError:
            skipped.append({"type": "context", "id": cname, "reason": "invalid pack name"})
            continue
        if dir_path.exists():
            skipped.append({"type": "context", "id": safe_name, "reason": "already exists"})
            continue
        dir_path.mkdir(parents=True)
        set_context_metadata(safe_name, writeable=False, owner_id=auth.user_id)
        for inner, data in files:
            try:
                _write_context_file(safe_name, inner, data, user_id=auth.user_id)
            except (HTTPException, ValueError) as exc:
                skipped.append({
                    "type": "context_file",
                    "id": f"{safe_name}/{inner}",
                    "reason": str(getattr(exc, "detail", exc)),
                })
        contexts_imported.append(safe_name)

    # ---- surface what to reconnect, from the manifest if present -------
    required_secrets: List[str] = []
    required_connections: List[str] = []
    if "workspace.json" in names:
        try:
            mani = json.loads(zf.read("workspace.json").decode("utf-8"))
            if isinstance(mani, dict):
                required_secrets = [s for s in (mani.get("required_secrets") or []) if isinstance(s, str)]
                required_connections = [s for s in (mani.get("required_connections") or []) if isinstance(s, str)]
        except Exception:
            pass

    return WorkspaceImportResponse(
        workers_imported=workers_imported,
        contexts_imported=contexts_imported,
        skipped=skipped,
        id_remaps=id_remaps,
        required_secrets=required_secrets,
        required_connections=required_connections,
        workspace_md_present=("workspace.md" in names),
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

    worker_id = _canonical_worker_id(worker_id)
    raw_worker_id = _raw_worker_id_from_worker_yml(payload.worker_yml)
    if raw_worker_id.replace("-", "_") != worker_id.replace("-", "_"):
        raise HTTPException(
            status_code=400,
            detail=f"worker_yml name {raw_worker_id!r} does not match path worker_id {worker_id!r}",
        )
    _raise_if_protected_worker_mutation(worker_id)

    parsed_worker_id, _config = _parse_worker_payload(payload.worker_yml, user_id=auth.user_id)
    if parsed_worker_id.replace("-", "_") != worker_id.replace("-", "_"):
        raise HTTPException(
            status_code=400,
            detail=f"worker_yml name {parsed_worker_id!r} does not match path worker_id {worker_id!r}",
        )
    if _worker_for_mutation(worker_id, auth, repos) is None:
        raise HTTPException(status_code=404, detail="Worker not found")

    target_dir = WORKERS_DIR / worker_id
    if not target_dir.exists():
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = target_dir / "worker.yml"
    run_py_path = target_dir / "run.py"
    requirements_path = target_dir / "requirements.txt"
    skill_path = target_dir / "SKILL.md"
    old_worker_yml = worker_yml_path.read_text(encoding='utf-8') if worker_yml_path.exists() else None
    old_run_py = run_py_path.read_text(encoding='utf-8') if run_py_path.exists() else None
    had_requirements = requirements_path.exists()
    old_skill = skill_path.read_text(encoding='utf-8') if skill_path.exists() else None

    worker_yml_path.write_text(payload.worker_yml, encoding='utf-8')
    run_py_path.write_text(payload.run_py, encoding='utf-8')
    if not requirements_path.exists():
        requirements_path.write_text("", encoding='utf-8')
    if payload.skill_md:
        skill_path.write_text(payload.skill_md, encoding='utf-8')
    elif not skill_path.exists():
        skill_path.write_text(
            f"# {_config.name}\n\n"
            "This WorkerContract entrypoint is a placeholder for the markdown skill runtime. "
            "Current Workeros execution uses `exec.command` from `worker.yml`.\n"
        , encoding='utf-8')

    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers, user_id=auth.user_id)
        except RuntimeError as exc:
            if old_worker_yml is not None:
                worker_yml_path.write_text(old_worker_yml, encoding='utf-8')
            if old_run_py is not None:
                run_py_path.write_text(old_run_py, encoding='utf-8')
            if not had_requirements and requirements_path.exists():
                requirements_path.unlink()
            if old_skill is not None:
                skill_path.write_text(old_skill, encoding='utf-8')
            elif skill_path.exists():
                skill_path.unlink()
            invalidate_worker_cache()
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    return _build_worker_detail(
        worker_id,
        user_id=auth.user_id,
        repos=repos,
        # donation model: an admin editing a workspace-owned worker is not its
        # owner, so the detail fetch needs the admin-role path.
        role="admin" if auth.is_admin else None,
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


def _clone_protected_worker_for_edit(
    worker_id: str,
    edited_files: List[WorkerFilePatch],
    *,
    user_id: str,
    repos: "Repositories",
) -> str:
    """Fork a read-only stock worker into a user-owned editable copy (clone-on-edit).

    Stock/example workers (``PROTECTED_STOCK_WORKER_IDS``) are git-tracked shared
    templates: writing the operator's edit back into the stock worker dir would
    corrupt the template for every user. Instead of erroring, the FIRST edit of a
    stock worker transparently creates a copy the operator owns, applies the edit
    to the copy, and returns the new id so the caller keeps working on "their"
    version.

    ``edited_files`` is the operator's already-mutated bundle (e.g. worker.yml
    with the new ``contexts`` / ``connections`` block). It is overlaid on the
    stock worker's source files (so files the editor did not send — run.py,
    SKILL.md, lib/* — are carried over), the manifest identity is rewritten to a
    free id (``<id>-copy``, ``-copy-2``, ...), and the bundle is registered via
    the shared ``_register_worker_from_files`` path. The stock template on disk is
    never touched.

    Returns the new worker id.
    """
    from worker_registry import WORKERS_DIR

    # Source-of-truth files for the stock worker (the bundle the editor was viewing).
    stock = _get_visible_worker(worker_id, user_id=user_id, repos=repos)
    if not stock:
        raise HTTPException(status_code=404, detail="Worker not found")
    try:
        stock_config = WorkerConfig(**(stock.get("config") or {}))
    except Exception:
        stock_config = None
    base_files: Dict[str, str] = {}
    if stock_config is not None:
        try:
            bundle_dir = _worker_bundle_dir(worker_id, stock_config)
            for wf in _read_worker_files(bundle_dir):
                if not wf.binary and wf.content is not None:
                    base_files[wf.path] = wf.content
        except Exception:
            base_files = {}
    if not base_files:
        # DB-backed worker with no on-disk bundle: fall back to the manifest view.
        for wf in _worker_files_from_manifest(stock):
            if not wf.binary and wf.content is not None:
                base_files[wf.path] = wf.content

    # Overlay the operator's edited files on top of the stock bundle.
    for item in edited_files:
        base_files[item.path] = item.content

    worker_yml = base_files.get("worker.yml")
    if not worker_yml:
        raise HTTPException(status_code=400, detail="files must include worker.yml")

    # Allocate a free, non-protected id and rewrite the manifest identity so the
    # new dir + worker.yml + DB row all agree. _register_worker_from_files parses
    # the manifest id eagerly (and re-rejects protected ids), so the rewrite MUST
    # happen before registration. The base MUST be slugified first: the 8 stock
    # workers are underscore-named (``weekly_update`` ...), and ``<id>-copy`` is
    # then NOT a valid SLUG_PATTERN id, so registration would 400. Slugify maps
    # ``weekly_update`` -> ``weekly-update`` -> ``weekly-update-copy``.
    new_id = _free_worker_id(f"{_slugify_worker_id(worker_id)}-copy", repos=repos)
    rewritten_yml = _rewrite_worker_yml_id(worker_yml, new_id)
    # A user's working copy is not a stock example: clear ``is_example`` so the
    # copy renders as a real owned worker (not in the example gallery) — it would
    # otherwise inherit ``is_example: true`` from the stock source manifest.
    base_files["worker.yml"] = _set_worker_yml_is_example(rewritten_yml, False)

    draft_files = [DraftFile(path=path, content=content) for path, content in base_files.items()]
    created_id = _register_worker_from_files(
        draft_files,
        user_id=user_id,
        repos=repos,
        dedupe_id=True,
    )
    return created_id


@app.put("/workers/{worker_id}/files", response_model=WorkerDetail)
def update_worker_files(
    worker_id: str,
    payload: WorkerFilesUpdateRequest,
    request: Request = None,
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

    if request is not None:
        _require_worker_write_workspace_context(request)
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=get_repositories())
    if not worker:
        # Donation model: admins edit workspace-shared workers (workspace-actor
        # owned; the owner-scoped fetch above can no longer see them).
        worker = _worker_for_mutation(worker_id, auth, get_repositories())
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    if not payload.files:
        raise HTTPException(status_code=400, detail="files list must not be empty")

    # Validate all paths upfront before touching the filesystem (also gates the
    # clone-on-edit path below — a stock fork must not carry invalid paths).
    seen_paths: set = set()
    for item in payload.files:
        _validate_worker_file_path(item.path)
        if item.path in seen_paths:
            raise HTTPException(status_code=400, detail=f"duplicate file path: {item.path!r}")
        seen_paths.add(item.path)

    _raise_if_protected_worker_mutation(worker_id)

    config_dict = worker.get("config") or {}
    try:
        existing_config = WorkerConfig(**config_dict)
    except Exception:
        existing_config = None
    target_dir = WORKERS_DIR / worker_id
    if existing_config is not None:
        try:
            configured_dir = _worker_bundle_dir(worker_id, existing_config)
            if configured_dir.is_dir():
                target_dir = configured_dir
        except HTTPException:
            raise
        except Exception:
            target_dir = WORKERS_DIR / worker_id

    # Must include worker.yml
    if "worker.yml" not in seen_paths:
        raise HTTPException(status_code=400, detail="files must include worker.yml")

    # Validate worker.yml is parseable
    yml_item = next(f for f in payload.files if f.path == "worker.yml")
    parsed_worker_id, _config = _parse_worker_payload(yml_item.content, user_id=auth.user_id)
    if parsed_worker_id.replace("-", "_") != worker_id.replace("-", "_"):
        raise HTTPException(
            status_code=400,
            detail=f"worker.yml name {parsed_worker_id!r} does not match path worker_id {worker_id!r}",
        )
    target_dir.mkdir(parents=True, exist_ok=True)

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

        try:
            _embed_files_in_skill_version(worker_id, target_dir)
        except Exception:
            logger.warning("Failed to embed files in DB for worker %s", worker_id, exc_info=True)

        # Commit the updated files to the workspace git repo
        author_name, author_email = _git_author(auth)
        _git_commit_worker(worker_id, message=f"worker: save files for {worker_id}", author_name=author_name, author_email=author_email)

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
    worker_id = _canonical_worker_id(worker_id)

    # Worker-to-worker call token enforcement
    trigger_source = payload.trigger_source
    trigger_ref = None
    if auth.auth_method == "run_token" and auth.run_token_payload:
        rtp = auth.run_token_payload
        callable_workers: list[str] = rtp.get("callable_workers") or []
        if worker_id not in callable_workers:
            raise HTTPException(
                status_code=403,
                detail=f"Worker {worker_id!r} is not in the caller's calls: list",
            )
        from run_token import MAX_CALL_DEPTH
        depth = int(rtp.get("depth") or 0)
        if depth >= MAX_CALL_DEPTH:
            raise HTTPException(
                status_code=403,
                detail=f"Maximum worker call depth ({MAX_CALL_DEPTH}) exceeded",
            )
        trigger_source, trigger_ref = _worker_call_run_metadata(auth)
        trigger_source = trigger_source or "worker_call"

    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    # B-P1-1 (2026-05-29): a smoke-disabled worker must NOT run on demand. The
    # smoke+gate disables a worker whose first test run failed (enabled=False);
    # honour that here so a broken worker cannot be run from the UI/API to a
    # green-but-empty no-op. Reject with 409 + the worker_disabled headline.
    try:
        recipe = repos.workers.get_recipe(worker_id=worker_id, user_id=auth.user_id)
    except Exception:
        recipe = None
    if isinstance(recipe, dict) and recipe.get("enabled") is False:
        raise HTTPException(
            status_code=409,
            detail=_OPERATOR_ERROR_CODE_HEADLINES["worker_disabled"],
        )

    # #551: Reject the run if any required secret or connection is not configured.
    _run_available_secrets = _available_secret_names_for_user(auth.user_id, repos)
    _run_required_secrets = _worker_required_secret_names(worker)
    _run_missing_secrets = [s for s in _run_required_secrets if s not in _run_available_secrets]
    if _run_missing_secrets:
        raise HTTPException(
            status_code=422,
            detail=f"Cannot run: missing required secret(s): {', '.join(_run_missing_secrets)}. "
                   f"Add them at /connections/secrets before running.",
        )
    _run_available_conn_slugs = _available_connection_slugs_for_user(auth.user_id, repos)
    _run_required_conn_slugs = _worker_connection_slugs(worker)
    _run_missing_conns = [c for c in _run_required_conn_slugs if c.lower() not in _run_available_conn_slugs]
    if _run_missing_conns:
        raise HTTPException(
            status_code=422,
            detail=f"Cannot run: missing required connection(s): {', '.join(_run_missing_conns)}. "
                   f"Connect them at /connections before running.",
        )

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
        _validate_file_input_references(run_config, payload.inputs)

    _enforce_run_create_quota(auth, worker_id)

    # Create the run record first so we have a run_id for per-run file staging.
    from run_service import SpendCapExceeded

    try:
        run_id = create_run(
            worker_id,
            payload.inputs,
            trigger_source,
            status=RunStatus.RUNNING.value,
            user_id=auth.user_id,
            trigger_ref=trigger_ref,
            repos=repos,
        )
    except SpendCapExceeded as exc:
        # #793: refuse cleanly (not a 500) with a machine-readable code the UI
        # surfaces on the Limits tab.
        raise HTTPException(
            status_code=402,
            detail={"error_code": "spend_cap_exceeded", "message": str(exc)},
        ) from exc
    except ValueError as exc:
        # Un-mask known run-create ValueErrors at the source instead of letting
        # them bubble to the global ValueError handler, which collapses every
        # cause into a useless 400 "Invalid request" (that exact masking hid the
        # "worker does not belong" + path-traversal failures on the demo worker).
        # We surface a SPECIFIC, operator-actionable message but keep raw
        # filesystem paths server-side (the global handler's #920 concern).
        msg = str(exc)
        logger.warning("create_run rejected for worker %s: %s", worker_id, msg, exc_info=exc)
        if "does not belong" in msg:
            # Authorization failure: the worker exists but this user cannot run
            # it (private + non-owner). 403, not a generic 400.
            raise HTTPException(
                status_code=403,
                detail="You do not have permission to run this worker.",
            ) from exc
        if "Path traversal" in msg:
            # Server-side misconfiguration (e.g. FLOOM_WORKERS_DIR drift): the
            # worker's source dir can't be resolved. Don't leak the path.
            raise HTTPException(
                status_code=500,
                detail="Worker source could not be resolved on the server.",
            ) from exc
        if "owner not found" in msg or "is disabled" in msg:
            raise HTTPException(status_code=409, detail=msg) from exc
        # Unknown ValueError: keep it generic but still 400 with the safe copy.
        raise HTTPException(status_code=400, detail="Could not start this run.") from exc
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


@app.get("/runs/export.csv")
def export_runs_csv(
    worker_id: Optional[str] = None,
    status: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    limit: int = Query(1000, ge=1, le=10000),
    include_system: bool = Query(False),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """#796: bulk-export the run list as a CSV attachment, with the same
    filters as GET /runs (worker_id, status, since, until). Owner/visibility
    scoped via _list_visible_runs."""
    statuses = _resolve_run_status_filters(status)
    since_dt = _parse_iso8601(since) if since else None
    if since and since_dt is None:
        raise HTTPException(status_code=400, detail="Invalid since value")
    until_dt = _parse_iso8601(until) if until else None
    if until and until_dt is None:
        raise HTTPException(status_code=400, detail="Invalid until value")
    rows, _total = _list_visible_runs(
        user_id=auth.user_id,
        repos=repos,
        worker_id=worker_id,
        statuses=statuses,
        since=since_dt.isoformat() if since_dt else None,
        until=until_dt.isoformat() if until_dt else None,
        limit=limit,
        offset=0,
        include_system=include_system,
    )
    import csv as _csv
    import io as _io
    out = _io.StringIO()
    writer = _csv.writer(out)
    writer.writerow([
        "id", "worker_id", "worker_name", "status", "trigger_source",
        "created_at", "started_at", "completed_at", "duration_ms", "error_code",
    ])
    for r in rows:
        d = row_to_dict(r)
        writer.writerow([
            d.get("id"), d.get("worker_id"), d.get("worker_name"), d.get("status"),
            d.get("trigger_source"), d.get("created_at"), d.get("started_at"),
            d.get("completed_at"), d.get("duration_ms"), d.get("error_code"),
        ])
    return Response(
        content=out.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="runs.csv"'},
    )


_DEFAULT_PRECLEAR_BACKUP_DIR = "/root/backups/manual"


def _preclear_backup_dir() -> str:
    return os.environ.get("WORKEROS_PRECLEAR_BACKUP_DIR") or _DEFAULT_PRECLEAR_BACKUP_DIR


def _live_db_file_path() -> Optional[str]:
    """Resolve the on-disk path of the main SQLite database, or None for
    an in-memory DB. Uses PRAGMA database_list so it reflects the connection
    actually in use rather than a possibly-stale module global."""
    with get_db() as conn:
        for row in conn.execute("PRAGMA database_list").fetchall():
            # row: (seq, name, file). The main schema is named 'main'.
            if row["name"] == "main":
                file_path = row["file"]
                return file_path or None
    return None


def _backup_db_before_clear() -> str:
    """Snapshot the live DB to a timestamped file before a destructive clear.

    Uses SQLite ``VACUUM INTO`` for an atomic, WAL-consistent single-file copy.
    Raises on any failure so the caller can ABORT the clear (never wipe without
    a verified backup). Returns the backup file path.
    """
    db_file = _live_db_file_path()
    if not db_file:
        raise RuntimeError("cannot back up an in-memory database before clear")
    backup_dir = _preclear_backup_dir()
    os.makedirs(backup_dir, exist_ok=True)
    backup_path = os.path.join(
        backup_dir, f"floom-preclear-{time.time_ns()}.db"
    )
    # VACUUM cannot run inside a transaction. Use a standalone autocommit
    # connection so callers can safely invoke this before owner-scoped deletes.
    with sqlite3.connect(db_file, timeout=30.0, isolation_level=None) as conn:
        conn.execute("PRAGMA busy_timeout = 30000")
        # VACUUM INTO writes a fresh, fully-consistent copy (no WAL sidecar).
        conn.execute("VACUUM INTO ?", (backup_path,))
    if not os.path.isfile(backup_path) or os.path.getsize(backup_path) == 0:
        raise RuntimeError(f"backup file missing or empty after VACUUM INTO: {backup_path}")
    return backup_path


@app.post("/runs/clear")
def clear_runs(
    confirm: str = Query("", description="Must be 'yes-wipe-all-runs' to proceed."),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Clear the caller's run history.

    Destructive operation. Requires explicit `?confirm=yes-wipe-all-runs`
    query param to proceed.

    Hardened (post-incident 2026-05-29):
    - Backs up the full DB to ``/root/backups/manual/floom-preclear-<epoch>.db``
      BEFORE deleting anything. If the backup fails, the clear is ABORTED.
    - Scopes deletion to the caller (``owner_id``) only — never a global wipe
      of every user's runs.
    """
    if confirm != "yes-wipe-all-runs":
        raise HTTPException(
            status_code=400,
            detail=(
                "Destructive endpoint. Append ?confirm=yes-wipe-all-runs to "
                "proceed. This backs up the DB, then clears YOUR run/log/"
                "artifact history."
            ),
        )
    try:
        backup_path = _backup_db_before_clear()
    except Exception as exc:
        logger.error("Aborting /runs/clear: pre-clear backup failed: %s", exc)
        raise HTTPException(
            status_code=500,
            detail=f"Pre-clear backup failed; clear aborted (no data deleted): {exc}",
        ) from exc
    # clear_all is owner-scoped (WHERE w.owner_id = ?), so this never touches
    # other tenants' runs.
    deleted_count = repos.runs.clear_all(user_id=auth.user_id)
    logger.warning(
        "Run history cleared for user %s (%d runs deleted, backup at %s)",
        auth.user_id,
        deleted_count,
        backup_path,
    )
    return {
        "status": "cleared",
        "cleared_count": deleted_count,
        # Back-compat alias for pre-hardening callers.
        "deleted_runs": deleted_count,
        "backup_path": backup_path,
    }


_TERMINAL_RUN_STATUSES = frozenset({"completed", "failed"})


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

    For running runs: sets cancel_requested=1 and asks the E2B driver to kill
    any registered sandbox command for this run.

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

    try:
        from runner_sandbox.e2b_driver import cancel_sandbox

        cancel_sandbox(run_id, reason="User requested cancellation.")
    except Exception:
        logger.warning("Failed to cancel E2B sandbox for run %s", run_id, exc_info=True)

    logger.info("Cancel requested for running run %s", run_id)
    return ActionResponse(status="cancel_requested", run_id=run_id)


# ---------------------------------------------------------------------------
# S47 HITL — approval endpoints
# ---------------------------------------------------------------------------

# --- X4: structured reviewer annotations -----------------------------------
# Caps keep a malicious/fat-fingered reviewer from persisting an unbounded blob
# onto the approval row. These are deliberately generous for a review pass but
# hard ceilings.
_ANNOTATION_MAX_TEXT_ITEMS = 200
_ANNOTATION_MAX_IMAGE_ITEMS = 30
_ANNOTATION_MAX_PINS_PER_IMAGE = 50
_ANNOTATION_MAX_STR = 8000
_ANNOTATION_MAX_JSON_BYTES = 256 * 1024


def _clean_annotation_str(value: Any, *, limit: int = _ANNOTATION_MAX_STR) -> str:
    if not isinstance(value, str):
        return ""
    # Strip control chars (defense-in-depth — this text is rendered back to the
    # owner) but keep newlines/tabs which are legitimate in a comment.
    cleaned = "".join(ch for ch in value if ch in "\n\t" or ord(ch) >= 32)
    return cleaned[:limit].strip()


def _safe_annotation_image_url(value: Any) -> Optional[str]:
    """Only accept image refs that point at OUR content-addressed upload store.

    The reviewer can only attach images they uploaded through the approval-scoped
    upload endpoints, which return `/uploads/<sha256>?download_token=...`. We
    refuse arbitrary http(s) URLs so a persisted annotation can never become an
    SSRF vector or an off-site beacon when the owner later views the feedback.
    """
    if not isinstance(value, str):
        return None
    ref = value.strip()
    if not ref.startswith("/uploads/"):
        return None
    path_part = ref.split("?", 1)[0]
    file_id = path_part[len("/uploads/"):]
    if not is_sha256(file_id):
        return None
    return ref[:_ANNOTATION_MAX_STR]


def _sanitize_annotations(raw: Any) -> Optional[Dict[str, Any]]:
    """Coerce reviewer-supplied annotations into a bounded, safe shape.

    Returns None when there is no usable content (so we don't persist `{}`).
    Shape:
      {"text":  [{"quote", "comment"}],
       "images":[{"url", "caption", "pins":[{"x","y","comment"}]}]}
    """
    if not isinstance(raw, dict):
        return None

    text_out: list[Dict[str, Any]] = []
    for item in (raw.get("text") or [])[:_ANNOTATION_MAX_TEXT_ITEMS]:
        if not isinstance(item, dict):
            continue
        quote = _clean_annotation_str(item.get("quote"))
        comment = _clean_annotation_str(item.get("comment"))
        if not quote and not comment:
            continue
        text_out.append({"quote": quote, "comment": comment})

    images_out: list[Dict[str, Any]] = []
    for item in (raw.get("images") or [])[:_ANNOTATION_MAX_IMAGE_ITEMS]:
        if not isinstance(item, dict):
            continue
        url = _safe_annotation_image_url(item.get("url"))
        if not url:
            continue
        caption = _clean_annotation_str(item.get("caption"))
        pins_out: list[Dict[str, Any]] = []
        for pin in (item.get("pins") or [])[:_ANNOTATION_MAX_PINS_PER_IMAGE]:
            if not isinstance(pin, dict):
                continue
            try:
                x = float(pin.get("x"))
                y = float(pin.get("y"))
            except (TypeError, ValueError):
                continue
            # Pins are normalized 0..1 coordinates over the image.
            x = min(1.0, max(0.0, x))
            y = min(1.0, max(0.0, y))
            pins_out.append({
                "x": round(x, 4),
                "y": round(y, 4),
                "comment": _clean_annotation_str(pin.get("comment")),
            })
        images_out.append({"url": url, "caption": caption, "pins": pins_out})

    if not text_out and not images_out:
        return None
    return {"text": text_out, "images": images_out}


def _annotations_json_or_none(raw: Any) -> Optional[str]:
    """Sanitize + serialize annotations to a JSON string, or None.

    Enforces a hard byte ceiling on the serialized blob as a final backstop.
    """
    sanitized = _sanitize_annotations(raw)
    if sanitized is None:
        return None
    encoded = json.dumps(sanitized, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > _ANNOTATION_MAX_JSON_BYTES:
        raise HTTPException(status_code=400, detail="Annotations payload is too large")
    return encoded


class ApproveRequest(BaseModel):
    edited_output: Optional[Dict[str, Any]] = None
    annotations: Optional[Dict[str, Any]] = None
    reason: Optional[str] = None  # #769: optional plain-text approve comment


class RejectRequest(BaseModel):
    reason: Optional[str] = None
    annotations: Optional[Dict[str, Any]] = None


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
    return [_approval_response(dict(row), repos) for row in rows]


@app.get("/approvals/count")
def count_pending_approvals(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Return count of pending approvals for the authenticated user."""
    count = repos.approvals.count_pending(owner_id=auth.user_id)
    return {"pending": count}


def _approval_artifacts_for_response(
    approval: Dict[str, Any],
    repos: Repositories,
) -> list[Dict[str, Any]]:
    owner_id = str(approval.get("owner_id") or "")
    run_id = str(approval.get("run_id") or "")
    if not owner_id or not run_id:
        return []
    try:
        rows = repos.runs.list_artifacts(user_id=owner_id, run_id=run_id)
    except Exception:
        logger.exception("Failed to load approval artifacts for run %s", run_id)
        return []
    artifacts: list[Dict[str, Any]] = []
    for row in rows:
        if _is_sensitive_artifact_row(row):
            continue
        art = row_to_dict(row)
        artifacts.append(
            {
                "id": art.get("id"),
                "run_id": art.get("run_id"),
                "name": art.get("name"),
                "type": art.get("type"),
                "path": art.get("path"),
                "relative_path": art.get("relative_path"),
                "size_bytes": art.get("size_bytes"),
                "created_at": art.get("created_at"),
            }
        )
    return artifacts


def _approval_response(
    approval: Dict[str, Any],
    repos: Repositories,
) -> Dict[str, Any]:
    response = dict(approval)
    response["artifacts"] = _approval_artifacts_for_response(response, repos)
    # X4: surface the structured reviewer feedback (highlight+comment / screenshot
    # pins) as a parsed object so the owner sees it on the run/approval, not just
    # the free-text reason. The raw JSON column is dropped from the response.
    raw_annotations = response.pop("annotations_json", None)
    parsed_annotations: Optional[Dict[str, Any]] = None
    if raw_annotations:
        try:
            parsed_annotations = json.loads(raw_annotations)
        except Exception:
            parsed_annotations = None
    response["annotations"] = parsed_annotations
    # #792: surface the typed preview payload as a parsed object (email/records/
    # tasks) so the UI can render a rich preview; drop the raw JSON column.
    raw_preview_payload = response.pop("preview_payload_json", None)
    parsed_preview_payload: Optional[Any] = None
    if raw_preview_payload:
        try:
            parsed_preview_payload = json.loads(raw_preview_payload)
        except Exception:
            parsed_preview_payload = None
    response["preview_payload"] = parsed_preview_payload
    # expires_at (#798) + preview_type (#792) pass through from the row as-is.
    # `type` mirrors preview_type for the v4 frontend's preview dispatcher.
    if response.get("preview_type") is not None:
        response["type"] = response.get("preview_type")
    # Standalone share/review link for the authenticated owner. The token is the
    # same deterministic HMAC the /approvals/public/* routes verify, so the owner
    # can copy this URL to open the approval full-page (no app chrome) or share it
    # with an external approver. Mirrors the chat tool's `link` field.
    response["public_link"] = (
        f"{_frontend_base_url()}/approvals/review"
        f"?id={response.get('id')}&token={_approval_public_token(dict(approval))}"
    )
    return response


def _publish_approval_terminal_status(
    run_id: str,
    decision: str,
    user_id: str,
    repos: Repositories,
    *,
    follow_up_run_id: str | None = None,
) -> None:
    """Publish a terminal `status` SSE event for an approve/reject decision.

    The original run has just transitioned off PENDING_APPROVAL to COMPLETED.
    Live SSE consumers (the run page) track `type:"status"` events; the
    `approval_decided` event alone does not move their status, so without this
    the UI would never observe the run leaving pending_approval.
    """
    completed_at: str | None = None
    try:
        run_row = repos.runs.get(user_id=user_id, run_id=run_id)
        if run_row is not None:
            completed_at = row_to_dict(run_row).get("completed_at")
    except Exception:
        completed_at = None
    event: Dict[str, Any] = {
        "type": "status",
        "run_id": run_id,
        "status": decision,
        "completed_at": completed_at,
    }
    if follow_up_run_id is not None:
        event["follow_up_run_id"] = follow_up_run_id
    _sse_publish(run_id, event)


def _approval_public_payload(approval: Dict[str, Any]) -> str:
    return ".".join(
        str(approval.get(key) or "")
        for key in ("id", "run_id", "owner_id")
    )


def _approval_public_token(approval: Dict[str, Any]) -> str:
    # #998: never sign/verify a public share token with a public constant —
    # a missing secret would let anyone forge share links. Fail closed.
    secret = (os.environ.get("FLOOM_SECRET") or "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="Server signing secret not configured")
    return hmac.new(
        secret.encode("utf-8"),
        _approval_public_payload(approval).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


# F3 (2026-06-03): the public approval endpoints must NOT leak which approval
# ids exist. Returning 404 for "no such approval" but 401 for "exists but bad
# token" is an existence oracle: an attacker can enumerate valid approval ids by
# diffing the status codes. We return the SAME response for both — a missing
# approval and a present-but-wrong-token approval are indistinguishable. We also
# always run an HMAC comparison (against a dummy expected value when the row is
# missing) so the two paths do roughly the same work and don't open a coarse
# timing oracle either.
_PUBLIC_APPROVAL_DENIED = HTTPException(
    status_code=401, detail="Invalid or expired approval link"
)


def _load_public_approval(
    approval_id: str,
    token: str,
    repos: Repositories,
) -> Dict[str, Any]:
    approval = repos.approvals.get_public(approval_id=approval_id)
    if approval is None:
        # Burn an equivalent HMAC compare so a missing approval and a
        # present-but-wrong-token approval are indistinguishable (no oracle).
        hmac.compare_digest(token or "", "0" * 64)
        raise _PUBLIC_APPROVAL_DENIED
    expected = _approval_public_token(dict(approval))
    if not token or not hmac.compare_digest(token, expected):
        # Identical response to the not-found case — no existence oracle.
        raise _PUBLIC_APPROVAL_DENIED
    return dict(approval)


def _public_approval_response(approval: Dict[str, Any], repos: Repositories) -> Dict[str, Any]:
    public = _approval_response(approval, repos)
    public.pop("owner_id", None)
    # The owner-only share link (and its token) is not echoed back to external
    # signed-link approvers — they already hold the token they arrived with.
    public.pop("public_link", None)
    return public


def _artifact_file_response(row: Any) -> StreamingResponse:
    if _is_sensitive_artifact_row(row):
        raise HTTPException(status_code=404, detail="Artifact not found")

    art = row_to_dict(row)
    path_str = str(art.get("path") or "")

    from runner_utils import ARTIFACTS_DIR

    try:
        artifacts_dir = ARTIFACTS_DIR.resolve()
        stored_path = Path(path_str)
        resolved = (
            stored_path.resolve()
            if stored_path.is_absolute()
            else (artifacts_dir / stored_path).resolve()
        )
        resolved.relative_to(artifacts_dir)
    except Exception:
        raise HTTPException(status_code=403, detail="Access denied")

    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found on disk")

    name = str(art.get("name") or resolved.name)
    content_type, _ = mimetypes.guess_type(name)
    content_type = content_type or "application/octet-stream"
    filename = _sanitize_download_name(name)

    def iter_file():
        with open(resolved, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        iter_file(),
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class PublicApprovalDecisionRequest(BaseModel):
    reason: str | None = None
    edited_output: Dict[str, Any] | None = None
    annotations: Dict[str, Any] | None = None


@app.get("/approvals/public/{approval_id}")
def get_public_approval(
    approval_id: str,
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
):
    """Return one approval for a signed standalone review link."""
    approval = _load_public_approval(approval_id, token, repos)
    return _public_approval_response(approval, repos)


@app.get("/approvals/public/{approval_id}/artifacts/{artifact_id}/download")
def download_public_approval_artifact(
    approval_id: str,
    artifact_id: str,
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
):
    """Download a non-sensitive run artifact from a signed standalone approval link."""
    approval = _load_public_approval(approval_id, token, repos)
    owner_id = str(approval.get("owner_id") or "")
    run_id = str(approval.get("run_id") or "")
    row = next(
        (
            artifact
            for artifact in repos.runs.list_artifacts(user_id=owner_id, run_id=run_id)
            if artifact["id"] == artifact_id
        ),
        None,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Artifact not found")
    return _artifact_file_response(row)


@app.post("/approvals/public/{approval_id}/approve", response_model=ActionResponse)
def approve_public_approval(
    approval_id: str,
    body: PublicApprovalDecisionRequest = Body(default_factory=PublicApprovalDecisionRequest),
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Approve from a signed standalone link without requiring app navigation."""
    approval = _load_public_approval(approval_id, token, repos)
    auth = AuthContext(user_id=str(approval["owner_id"]), email=None, scopes=("approval",))
    decision_input: Dict[str, Any] = {}
    try:
        decision_input = json.loads(approval.get("decision_input_json") or "{}")
    except Exception:
        pass
    if decision_input.get("kind") == "destructive_delete":
        result = approve_destructive_action(
            approval_id,
            auth,
            repos,
            annotations=body.annotations,
            reason=body.reason,  # #769: was dropped on the public destructive-delete path
        )
        return ActionResponse(status=str(result.get("status") or "approved"), run_id=str(approval["run_id"]))
    if decision_input.get("kind") == "agent_tool":
        return approve_agent_tool_approval(
            approval_id,
            # #769: forward the public approver's plain-text reason (was dropped)
            ApproveRequest(edited_output=body.edited_output, annotations=body.annotations, reason=body.reason),
            auth,
            repos,
        )
    return approve_run(
        str(approval["run_id"]),
        ApproveRequest(edited_output=body.edited_output, annotations=body.annotations, reason=body.reason),
        auth,
        repos,
    )


@app.post("/approvals/public/{approval_id}/reject", response_model=ActionResponse)
def reject_public_approval(
    approval_id: str,
    body: PublicApprovalDecisionRequest = Body(default_factory=PublicApprovalDecisionRequest),
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Reject from a signed standalone link without requiring app navigation."""
    approval = _load_public_approval(approval_id, token, repos)
    auth = AuthContext(user_id=str(approval["owner_id"]), email=None, scopes=("approval",))
    decision_input: Dict[str, Any] = {}
    try:
        decision_input = json.loads(approval.get("decision_input_json") or "{}")
    except Exception:
        pass
    if decision_input.get("kind") == "destructive_delete":
        result = reject_destructive_action(
            approval_id,
            RejectRequest(reason=body.reason, annotations=body.annotations),
            auth,
            repos,
        )
        return ActionResponse(status=str(result.get("status") or "rejected"), run_id=str(approval["run_id"]))
    if decision_input.get("kind") == "agent_tool":
        return reject_agent_tool_approval(
            approval_id,
            RejectRequest(reason=body.reason, annotations=body.annotations),
            auth,
            repos,
        )
    return reject_run(
        str(approval["run_id"]),
        RejectRequest(reason=body.reason, annotations=body.annotations),
        auth,
        repos,
    )


# X4: screenshot uploads attached to a review. Both endpoints store the blob
# under the APPROVAL OWNER's user_id so the resulting `/uploads/<sha>` ref is
# readable by the owner when they later view the annotations on the run — even
# when an external signed-link reviewer did the upload. The same extension /
# size / quota gates as `/uploads` apply, and `allowed_media_prefixes` pins the
# upload to images so a reviewer can't smuggle in a non-image blob here.
@app.post("/approvals/{approval_id}/uploads")
async def upload_approval_screenshot(
    approval_id: str,
    request: Request,
    file: UploadFile = File(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Authed owner uploads a review screenshot for one of their approvals."""
    approval = repos.approvals.get(owner_id=auth.user_id, approval_id=approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    return await _store_uploaded_blob(
        request,
        file,
        auth.user_id or "anonymous",
        allowed_media_prefixes=("image/",),
    )


@app.post("/approvals/public/{approval_id}/uploads")
async def upload_public_approval_screenshot(
    approval_id: str,
    request: Request,
    file: UploadFile = File(...),
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Signed-link (no-auth) reviewer uploads a review screenshot.

    The link IS the credential: a valid per-approval HMAC token unlocks the
    upload, and the blob is owned by the approval owner so they can read it back.
    """
    approval = _load_public_approval(approval_id, token, repos)
    owner_id = str(approval.get("owner_id") or "")
    return await _store_uploaded_blob(
        request,
        file,
        owner_id or "anonymous",
        allowed_media_prefixes=("image/",),
    )


def _load_typed_approval(
    approval_id: str,
    user_id: str,
    expected_kind: str,
    repos: Repositories,
) -> Dict[str, Any]:
    """Fetch an approval by ID and validate ownership, pending status, and kind.

    Raises HTTPException(404/409/400) on any check failure so callers only need
    to handle the happy path. Returns the approval row dict.
    """
    approval = repos.approvals.get(owner_id=user_id, approval_id=approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    if approval.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Approval already decided")
    decision_input: Dict[str, Any] = {}
    try:
        decision_input = json.loads(approval.get("decision_input_json") or "{}")
    except Exception:
        pass
    if decision_input.get("kind") != expected_kind:
        raise HTTPException(
            status_code=400,
            detail=f"This approval has kind={decision_input.get('kind')!r}, expected {expected_kind!r}.",
        )
    return approval


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

    # Reject agent-tool approvals — they must use POST /approvals/{id}/approve
    # to avoid spawning a follow-up run while the in-process polling loop also
    # resumes the original agent (double execution).
    _di: Dict[str, Any] = {}
    try:
        _di = json.loads(approval_row.get("decision_input_json") or "{}")
    except Exception:
        pass
    if _di.get("kind") == "agent_tool":
        raise HTTPException(
            status_code=400,
            detail="This approval was created by request_approval(). Use POST /approvals/{approval_id}/approve instead.",
        )

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
    annotations_json = _annotations_json_or_none(getattr(body, "annotations", None))
    repos.approvals.approve(
        owner_id=auth.user_id,
        run_id=run_id,
        decided_at=decided_at,
        edited_output_json=edited_output_json,
        follow_up_run_id=follow_up_run_id,
        annotations_json=annotations_json,
        reason=getattr(body, "reason", None),  # #769
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

    # Emit a terminal status event so live SSE consumers (the run page) observe
    # the original run leaving pending_approval. The frontend tracks
    # `type:"status"` events; without this it never sees the resolution.
    _publish_approval_terminal_status(
        run_id, "approved", auth.user_id, repos, follow_up_run_id=follow_up_run_id
    )

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

    _di_r: Dict[str, Any] = {}
    try:
        _di_r = json.loads(approval_row.get("decision_input_json") or "{}")
    except Exception:
        pass
    if _di_r.get("kind") == "agent_tool":
        raise HTTPException(
            status_code=400,
            detail="This approval was created by request_approval(). Use POST /approvals/{approval_id}/reject instead.",
        )

    decided_at = now_iso()
    annotations_json = _annotations_json_or_none(getattr(body, "annotations", None))
    repos.approvals.reject(
        owner_id=auth.user_id,
        run_id=run_id,
        decided_at=decided_at,
        reason=body.reason,
        annotations_json=annotations_json,
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

    # Emit a terminal status event so live SSE consumers (the run page) observe
    # the original run leaving pending_approval. The frontend tracks
    # `type:"status"` events; without this it never sees the resolution.
    _publish_approval_terminal_status(run_id, "rejected", auth.user_id, repos)

    return ActionResponse(status="rejected", run_id=run_id)


# ---------------------------------------------------------------------------
# Destructive-action approvals (kind=destructive_delete)
# ---------------------------------------------------------------------------
# When a sandboxed worker issues DELETE, the middleware queues an approval
# instead of executing immediately. The operator decides here.

import re as _re_action

_RE_DELETE_WORKER = _re_action.compile(r"^/workers/([^/]+)$")
_RE_DELETE_CONTEXT = _re_action.compile(r"^/contexts/([^/]+)$")
_RE_DELETE_CONTEXT_FILE = _re_action.compile(r"^/contexts/([^/]+)/files/(.+)$")


def _execute_destructive_delete(path: str, owner_id: str, repos: Repositories) -> str:
    """Execute a pre-approved destructive delete and return a description."""
    m = _RE_DELETE_WORKER.match(path)
    if m:
        worker_id = m.group(1)
        _delete_worker_impl(worker_id, owner_id, repos)
        return f"Worker '{worker_id}' deleted"

    m = _RE_DELETE_CONTEXT.match(path)
    if m:
        name = m.group(1)
        ctx = repos.contexts.get(owner_id=owner_id, name=name) if hasattr(repos, "contexts") else None
        if ctx is None:
            raise HTTPException(status_code=404, detail=f"Brain pack '{name}' not found")
        repos.contexts.delete(owner_id=owner_id, name=name)
        return f"Brain pack '{name}' deleted"

    m = _RE_DELETE_CONTEXT_FILE.match(path)
    if m:
        name, file_path = m.group(1), m.group(2)
        from worker_registry import WORKERS_DIR  # noqa: PLC0415
        context_dir = WORKERS_DIR.parent / "contexts" / name
        target = context_dir / file_path
        if not target.exists():
            raise HTTPException(status_code=404, detail=f"File '{file_path}' not found in brain pack '{name}'")
        target.unlink()
        return f"File '{file_path}' deleted from brain pack '{name}'"

    raise HTTPException(
        status_code=422,
        detail=f"Approved delete path '{path}' could not be matched to a known resource type.",
    )


class ApproveActionRequest(BaseModel):
    annotations: Optional[Dict[str, Any]] = None
    reason: Optional[str] = None  # #769: optional plain-text approve comment


@app.post("/approvals/{approval_id}/approve-action")
def approve_destructive_action(
    approval_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
    body: ApproveActionRequest = Body(default_factory=ApproveActionRequest),
    annotations: Optional[Dict[str, Any]] = None,
    reason: Optional[str] = None,
):
    """Approve and execute a sandboxed-worker DELETE request.

    Only works for approvals created by the run-token middleware (kind=destructive_delete).
    The optional `annotations`/`reason` keywords let the public-link forwarder
    pass reviewer feedback without a request body; the route body carries them
    for authed callers.
    """
    approval = _load_typed_approval(approval_id, auth.user_id, "destructive_delete", repos)
    decision_input: Dict[str, Any] = json.loads(approval.get("decision_input_json") or "{}")
    path = decision_input.get("path", "")
    description = _execute_destructive_delete(path, auth.user_id, repos)

    annotations_json = _annotations_json_or_none(
        annotations if annotations is not None else body.annotations
    )
    repos.approvals.approve(
        owner_id=auth.user_id,
        run_id=approval["run_id"],
        decided_at=now_iso(),
        annotations_json=annotations_json,
        # #769: forward the approve reason for the destructive-delete path too
        # (mirrors reject_destructive_action; was previously dropped).
        reason=reason if reason is not None else getattr(body, "reason", None),
    )

    _sse_publish(approval["run_id"], {
        "type": "approval_decided",
        "run_id": approval["run_id"],
        "decision": "approved",
        "detail": description,
    })

    return {"status": "approved", "executed": path, "detail": description}


@app.post("/approvals/{approval_id}/reject-action")
def reject_destructive_action(
    approval_id: str,
    body: RejectRequest = Body(default_factory=RejectRequest),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Reject a sandboxed-worker DELETE request without executing it."""
    approval = _load_typed_approval(approval_id, auth.user_id, "destructive_delete", repos)
    decision_input: Dict[str, Any] = json.loads(approval.get("decision_input_json") or "{}")
    annotations_json = _annotations_json_or_none(getattr(body, "annotations", None))
    repos.approvals.reject(
        owner_id=auth.user_id,
        run_id=approval["run_id"],
        decided_at=now_iso(),
        reason=body.reason,
        annotations_json=annotations_json,
    )

    _sse_publish(approval["run_id"], {
        "type": "approval_decided",
        "run_id": approval["run_id"],
        "decision": "rejected",
        "reason": body.reason,
    })

    return {"status": "rejected", "path": decision_input.get("path", ""), "reason": body.reason}


@app.post("/approvals/{approval_id}/approve", response_model=ActionResponse)
def approve_agent_tool_approval(
    approval_id: str,
    body: ApproveRequest = Body(default_factory=ApproveRequest),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Approve a mid-run agent-tool approval (kind=agent_tool).

    Does NOT spawn a new run. Flips the approval record to 'approved' so the
    in-process polling loop in agent_driver can resume the run in-place.
    Any edited_output is stored and returned to the agent by the polling loop.
    """
    approval = _load_typed_approval(approval_id, auth.user_id, "agent_tool", repos)
    edited_output_json = json.dumps(body.edited_output) if body.edited_output is not None else None
    repos.approvals.approve(
        owner_id=auth.user_id,
        run_id=approval["run_id"],
        approval_id=approval_id,
        decided_at=now_iso(),
        edited_output_json=edited_output_json,
    )

    _sse_publish(approval["run_id"], {
        "type": "approval_decided",
        "run_id": approval["run_id"],
        "approval_id": approval_id,
        "decision": "approved",
    })

    return ActionResponse(status="approved", run_id=str(approval["run_id"]))


@app.post("/approvals/{approval_id}/reject", response_model=ActionResponse)
def reject_agent_tool_approval(
    approval_id: str,
    body: RejectRequest = Body(default_factory=RejectRequest),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Reject a mid-run agent-tool approval (kind=agent_tool).

    Does NOT affect run status directly — the polling loop in agent_driver
    picks up the 'rejected' status and resumes with approved=False.
    """
    approval = _load_typed_approval(approval_id, auth.user_id, "agent_tool", repos)
    annotations_json = _annotations_json_or_none(getattr(body, "annotations", None))
    repos.approvals.reject(
        owner_id=auth.user_id,
        run_id=approval["run_id"],
        approval_id=approval_id,
        decided_at=now_iso(),
        reason=body.reason,
        annotations_json=annotations_json,
    )

    _sse_publish(approval["run_id"], {
        "type": "approval_decided",
        "run_id": approval["run_id"],
        "approval_id": approval_id,
        "decision": "rejected",
    })

    return ActionResponse(status="rejected", run_id=str(approval["run_id"]))


class _RunExportRequest(BaseModel):
    run_ids: List[str] = Field(..., min_length=1, max_length=200)


@app.post("/runs/export")
def export_runs_bundle(
    body: _RunExportRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """#796: bulk-export multiple runs as one ZIP — `run-<id>/` per run, reusing
    the single-run bundle's redaction rules (no inputs/logs/transcripts; sensitive
    + out-of-root artifacts skipped)."""
    from runner_utils import ARTIFACTS_DIR
    artifacts_root = ARTIFACTS_DIR.resolve()
    archive_buffer = io.BytesIO()
    included = 0
    with zipfile.ZipFile(archive_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for run_id in body.run_ids:
            run_row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
            if not run_row:
                continue
            run_data = row_to_dict(run_row)
            prefix = f"run-{_sanitize_download_name(str(run_data.get('id') or run_id))}/"
            output_payload = json.loads(run_row["output_json"] or "{}")
            if not isinstance(output_payload, dict):
                output_payload = {}
            metadata = {
                k: run_data.get(k)
                for k in ("id", "worker_id", "status", "trigger_source", "runner",
                          "created_at", "started_at", "completed_at", "duration_ms")
            }
            archive.writestr(prefix + "metadata.json", json.dumps(metadata, indent=2, sort_keys=True))
            archive.writestr(prefix + "outputs.json", json.dumps(output_payload, indent=2, sort_keys=True))
            primary = _extract_primary_output_file(output_payload)
            if primary:
                out_name, out_bytes = primary
                archive.writestr(prefix + out_name, out_bytes)
            for row in repos.runs.list_artifacts(user_id=auth.user_id, run_id=run_id):
                if _is_sensitive_artifact_row(row):
                    continue
                try:
                    resolved = Path(row["path"] or "").resolve()
                    resolved.relative_to(artifacts_root)
                except Exception:
                    continue
                if not resolved.is_file():
                    continue
                safe = _sanitize_download_name(str(row["name"] or resolved.name))
                archive.writestr(prefix + "artifacts/" + safe, resolved.read_bytes())
            included += 1
        if included == 0:
            raise HTTPException(status_code=404, detail="No exportable runs found")
        archive.writestr(
            "README.txt",
            "Bulk run export. Inputs, logs and internal transcripts are omitted.\n",
        )
    archive_buffer.seek(0)
    return Response(
        content=archive_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="runs-export.zip"'},
    )


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
    return _artifact_file_response(row)


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
    run["outputs"] = run["output"]
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

    # G5 P1: collapse the e2b stderr code-echo on the RAW ordered rows FIRST
    # (frame + caret anchors intact), THEN per-row redact each survivor.
    _raw_log_rows = [
        {"level": r["level"], "message": r["message"], "timestamp": r["timestamp"]}
        for r in repos.runs.list_logs(user_id=auth.user_id, run_id=run_id)
    ]
    logs = [
        LogEntry(
            level=row["level"],
            message=_redact_public_log_message(row["message"]),
            timestamp=row["timestamp"],
        )
        for row in _collapse_stderr_code_echo_rows(_raw_log_rows)
    ]

    _artifact_rows = repos.runs.list_artifacts(user_id=auth.user_id, run_id=run_id)
    _has_sensitive_run_artifacts = any(_is_sensitive_artifact_row(r) for r in _artifact_rows)
    artifacts = [
        Artifact(
            id=r["id"],
            run_id=r["run_id"],
            name=r["name"],
            type=row_to_dict(r).get("type"),
            # PATH-1: never return the absolute host path; expose only the path
            # relative to the artifacts root. Download resolves the real path
            # server-side from the artifact id.
            path=_public_artifact_path(r["path"]),
            relative_path=_public_artifact_path(r["path"]),
            size_bytes=row_to_dict(r).get("size_bytes"),
            created_at=r["created_at"],
        )
        for r in _artifact_rows
        if not _is_sensitive_artifact_row(r)
    ]
    transcript: List[Dict[str, Any]] = []

    queue_position: Optional[int] = None
    if run["status"] == RunStatus.QUEUED.value:
        pos = queued_run_position(run_id)
        queue_position = pos if pos > 0 else None

    # #561: parse the run's actual input from the stored JSON.
    run_input: Dict[str, Any] = {}
    _raw_input_json = run.get("input_json")
    if _raw_input_json:
        try:
            run_input = json.loads(_raw_input_json) if isinstance(_raw_input_json, str) else _raw_input_json
            if not isinstance(run_input, dict):
                run_input = {}
        except Exception:
            run_input = {}
    if _has_sensitive_run_artifacts:
        run_input = {}

    # #561: extract structured tool calls and token usage from transcript artifact.
    _transcript_rows = _read_transcript_rows(run.get("runner", ""), artifacts)
    _tool_calls = _parse_tool_calls_from_transcript(_transcript_rows)
    _total_tokens = _extract_total_tokens_from_transcript(_transcript_rows)

    # #561: approval trail — single approval row per run (if any).
    _approval_trail: Optional[ApprovalEntry] = None
    try:
        _appr_row = repos.approvals.get_by_run_id(run_id=run_id)
        if _appr_row:
            _approval_trail = ApprovalEntry(
                id=str(_appr_row.get("id", "")),
                status=str(_appr_row.get("status", "pending")),
                label=_appr_row.get("label"),
                preview=_appr_row.get("preview"),
                created_at=str(_appr_row.get("created_at", "")),
                decided_at=_appr_row.get("decided_at"),
                reason=_appr_row.get("reason"),
                follow_up_run_id=_appr_row.get("follow_up_run_id"),
            )
    except Exception:
        pass

    # #561: replay is available for terminal statuses.
    _terminal_statuses = {RunStatus.COMPLETED.value, RunStatus.FAILED.value}
    _can_replay = run.get("status") in _terminal_statuses

    return RunDetail(
        id=run["id"],
        worker_id=run["worker_id"],
        # PR S21: query already SELECTs worker_name (line ~3670) but it was
        # never plumbed through to the response model — UI showed the slug.
        worker_name=run.get("worker_name"),
        status=RunStatus(run["status"]),
        trigger_source=run["trigger_source"],
        runner=run["runner"],
        input=run_input,
        inputs=run_input,
        output=run["output"],
        outputs=run["output"],
        output_schema=output_schema,
        logs=logs,
        artifacts=artifacts,
        transcript=transcript,
        tool_calls=_tool_calls,
        approval_trail=_approval_trail,
        can_replay=_can_replay,
        total_tokens=_total_tokens,
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


@app.post("/runs/{run_id}/share-link")
def create_run_share_link(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    """#765: mint a read-only public share link for a run. Owner only.

    Reuses the standalone_share_links infra (entity_type='run'); recipients
    open the run via GET /runs/public/{run_id}?token= with no sign-in.
    """
    run = _get_visible_run(run_id, user_id=auth.user_id, repos=repos)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return _create_or_get_standalone_share_link(
        entity_type="run",
        entity_id=run_id,
        owner_id=auth.user_id,
    )


@app.delete("/runs/{run_id}/share-link")
def revoke_run_share_link(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#765/#766: revoke a run's public share link."""
    run = _get_visible_run(run_id, user_id=auth.user_id, repos=repos)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return _revoke_standalone_share_link(
        entity_type="run", entity_id=run_id, owner_id=auth.user_id,
    )


@app.get("/runs/public/{run_id}", response_model=RunDetail)
def get_public_run(
    run_id: str,
    token: str = Query(..., min_length=10),
    repos: Repositories = Depends(get_repos),
) -> RunDetail:
    """#765: read-only run view for a signed share link, no auth required.

    The token must resolve to a 'run' share row for THIS run_id; the run is
    then rendered under the share owner's identity (same builder as the authed
    GET /runs/{id}). 404 for any token/run mismatch — never leaks another run.
    """
    row = _load_standalone_share_row(token)
    if not row or str(row.get("entity_type")) != "run" or str(row.get("entity_id")) != run_id:
        raise HTTPException(status_code=404, detail="Run not found")
    owner_auth = AuthContext(user_id=str(row.get("owner_id") or ""), email=None, scopes=("run_share",))
    return get_run(run_id, auth=owner_auth, repos=repos)


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
                        "duration_ms": final_row["duration_ms"],
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


_CALM_CODE_ERROR_LOG = "Worker code raised an error (see the Error card for details)."
# A single traceback FRAME line: '  File "...", line N, in name' or the bare
# source line printed under it. After path-scrubbing these become noise like
# 'File "[worker file]", line 9, in main'.
_TRACEBACK_FRAME_LINE_RE = re.compile(r'File\s+"[^"]*",\s*line\s+\d+', re.IGNORECASE)
# A final 'ExcClass: message' line (TypeError: ...), or a bare Traceback header.
_TRACEBACK_HEADER_RE = re.compile(r"Traceback \(most recent call last\)", re.IGNORECASE)

# G5 P1 (2026-05-29): the residual e2b stderr code-echo. Each stderr line is
# emitted as a SEPARATE log row (e2b_driver._emit_command_output splits + strips
# per line), so the multiline-collapse in _redact_runtime_jargon_in_log never
# sees the block, and the single-line branch only matched traceback/exc regexes.
# Three line classes still leaked verbatim to the operator "Recent logs" panel:
#   - the caret marker line  '~~~~~~~~^~~~~~~~~'  (Python 3.11+ error-pointer)
#   - the Command-exit boilerplate  'Command exited with code 1'
#   - the source-line echo  'quotient = number1 / number2' (the line above the caret)
# The caret line is the unambiguous anchor: Python ALWAYS prints the offending
# source line immediately ABOVE the caret. So we collapse these at the ORDERED
# log-list level (where adjacency is preserved) with ZERO false positives — a
# clean stderr print only gets collapsed if it is itself caret-only or the row
# directly followed by a caret row.
_CARET_ONLY_RE = re.compile(r"^[\s~^|+]*[~^][\s~^|+]*$")
_COMMAND_EXIT_RE = re.compile(r"\bCommand exited with code\s+\d+\b", re.IGNORECASE)
# Strip the streaming '[e2b] stderr: ' / '[e2b] ' prefix so the markers above
# match the content even after the driver prepends a channel label.
_E2B_LOG_PREFIX_RE = re.compile(r"^\[e2b\](?:\s+stderr:)?\s*")


def _e2b_log_content(message: str) -> str:
    """Content of an e2b log row with the streaming channel prefix removed."""
    return _E2B_LOG_PREFIX_RE.sub("", str(message or "")).strip()


def _is_caret_marker_line(message: str) -> bool:
    content = _e2b_log_content(message)
    return bool(content) and bool(_CARET_ONLY_RE.match(content))


def _is_command_exit_line(message: str) -> bool:
    return bool(_COMMAND_EXIT_RE.search(_e2b_log_content(message)))


def _collapse_stderr_code_echo_rows(
    rows: List[Dict[str, Any]], message_key: str = "message"
) -> List[Dict[str, Any]]:
    """Drop the residual e2b stderr code-echo from an ORDERED list of RAW log-row
    dicts (call this BEFORE per-row redaction so the 'File ... line N' frame and
    caret anchors are still intact). Anchored on the two unambiguous traceback
    markers Python emits, so it is leak-proof with no false positives:

      - a 'File "...", line N' FRAME row -> the row DIRECTLY AFTER it is the
        echoed source line (Python prints frame then source); drop the echo,
      - a CARET row ('~~~^~~~') -> drop it AND the row directly above it (the
        echoed source line, when not already dropped),
      - a 'Command exited with code N' row -> drop it.

    The frame row / traceback header / exception line themselves are left in
    place — per-row redaction (run AFTER this) collapses them into the single
    calm 'Worker code raised an error' note. Clean rows ('Run started',
    'Worker completed: 9 words') never match these anchors, so they pass through.
    Preserves level/timestamp on surviving rows."""
    n = len(rows)
    drop = [False] * n
    msgs = [str(row.get(message_key) or "") for row in rows]
    for i, msg in enumerate(msgs):
        content = _e2b_log_content(msg)
        if _is_caret_marker_line(msg):
            drop[i] = True
            if i > 0 and not drop[i - 1]:
                drop[i - 1] = True
        elif _is_command_exit_line(msg):
            drop[i] = True
        elif _TRACEBACK_FRAME_LINE_RE.search(content):
            # The line Python prints directly under a frame is the echoed
            # source. Only drop it if it is itself a stderr/e2b row (so we never
            # eat an unrelated subsequent log line) and not already a frame.
            if i + 1 < n:
                nxt = msgs[i + 1]
                nxt_content = _e2b_log_content(nxt)
                is_e2b_row = _E2B_LOG_PREFIX_RE.match(nxt) is not None
                if (
                    is_e2b_row
                    and not _TRACEBACK_FRAME_LINE_RE.search(nxt_content)
                    and not _TRACEBACK_HEADER_RE.search(nxt_content)
                    and not _WORKER_CODE_TRACEBACK_RE.search(nxt_content)
                    and not _is_caret_marker_line(nxt)
                    and not _is_command_exit_line(nxt)
                ):
                    drop[i + 1] = True
    survivors = [row for i, row in enumerate(rows) if not drop[i]]
    # Dedupe CONSECUTIVE rows that per-row redaction will collapse into the same
    # calm note (the traceback header + each frame + the exception line each
    # become _CALM_CODE_ERROR_LOG), so the operator panel shows ONE calm note
    # for the whole traceback block, not five. Only collapses adjacent rows that
    # ALREADY redact to the calm note; unrelated rows are never merged.
    deduped: List[Dict[str, Any]] = []
    prev_calm = False
    for row in survivors:
        redacts_calm = (
            _redact_public_log_message(str(row.get(message_key) or "")) == _CALM_CODE_ERROR_LOG
        )
        if redacts_calm and prev_calm:
            continue
        deduped.append(row)
        prev_calm = redacts_calm
    return deduped


def _redact_runtime_jargon_in_log(message: str) -> str:
    """Collapse Python traceback frames + bare-exception jargon in an operator
    log line into a single calm note (G5 P1-A). The raw text stays available to
    engineers on the run's debug 'Raw' tab (error_raw); the operator-facing log
    surface must read like the calm Error card, never a Python traceback.

    Line-aware so a normal log line ('Worker completed: 9 words') is untouched."""
    if not message:
        return message
    lines = message.splitlines()
    if len(lines) <= 1:
        text = message.strip()
        # Single-line: only rewrite when it is unmistakably runtime jargon
        # (traceback header, a frame line, an exception class/message). A clean
        # operator log line never matches these.
        if (
            _TRACEBACK_HEADER_RE.search(text)
            or _TRACEBACK_FRAME_LINE_RE.search(text)
            or _WORKER_CODE_TRACEBACK_RE.search(text)
            or _BARE_PYTHON_EXC_MSG_RE.search(text)
        ):
            return _CALM_CODE_ERROR_LOG
        return message
    out: List[str] = []
    collapsed = False
    for line in lines:
        if (
            _TRACEBACK_HEADER_RE.search(line)
            or _TRACEBACK_FRAME_LINE_RE.search(line)
            or _WORKER_CODE_TRACEBACK_RE.search(line)
            or _BARE_PYTHON_EXC_MSG_RE.search(line)
        ):
            # Emit ONE calm note for the whole traceback block, drop the rest.
            if not collapsed:
                out.append(_CALM_CODE_ERROR_LOG)
                collapsed = True
            continue
        out.append(line)
    return "\n".join(out).strip() or _CALM_CODE_ERROR_LOG


def _redact_public_log_message(message: str) -> str:
    redacted = _MISSING_SECRETS_RE.sub("Missing required secrets", message or "")
    redacted = _ENV_SECRET_CONFIG_RE.sub("Required platform secret is not configured", redacted)
    redacted = _INTERNAL_LOG_TOKEN_RE.sub("[redacted-id]", redacted)
    redacted = _LOG_METADATA_RE.sub("[redacted-metadata]", redacted)
    # PATH-1 (2026-05-29): logs[].message still leaked host paths
    # (/root/workeros/...) and sandbox paths (/home/user/worker/run.py),
    # unlike error_raw which already strips them. Apply the SAME redaction so
    # the log surface never discloses the deploy dir or sandbox topology.
    redacted = _SANDBOX_PATH_RE.sub("[worker file]", redacted)
    # G5 P1-A (2026-05-29): the e2b driver streams the worker's raw stderr
    # (Traceback + 'TypeError: unsupported operand ...') into the run logs. The
    # "Recent logs" panel rendered that verbatim, undercutting the calm Error
    # card. Collapse runtime jargon/tracebacks into one calm note here — the
    # single chokepoint for every operator-facing log read.
    redacted = _redact_runtime_jargon_in_log(redacted)
    return redacted


def _public_artifact_path(raw_path: Optional[str]) -> str:
    """Return an artifact path safe to expose in an API response (PATH-1).

    The artifacts table stores the absolute host path
    (e.g. /root/workeros/data/artifacts/run_x/out/sorted.csv). Returning it
    discloses the deploy dir + storage layout. Strip the artifacts-root prefix
    so callers see only the relative path (run_x/out/sorted.csv). The download
    endpoint resolves the real on-disk path server-side from the artifact id,
    so relativising here does not break downloads.
    """
    raw = str(raw_path or "").strip()
    if not raw:
        return ""
    try:
        from runner_utils import ARTIFACTS_DIR

        resolved = Path(raw).resolve()
        rel = resolved.relative_to(ARTIFACTS_DIR.resolve())
        return rel.as_posix()
    except Exception:
        # Not under the artifacts root (or unresolvable) — never leak an
        # absolute path; fall back to the basename only.
        return Path(raw).name


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
    (re.compile(
        r"\bKeyError\b|\bNameError\b|\bAttributeError\b|\bTypeError\b|\bValueError\b"
        r"|\bFileNotFoundError\b|\bUnboundLocalError\b|\bIndexError\b|\bOSError\b",
        re.IGNORECASE,
     ),
     _CODE_HEADLINE),
    (re.compile(r"\b(?:Timed?\s?out|timeout|deadline exceeded)\b", re.IGNORECASE),
     _TIMEOUT_HEADLINE),
    (re.compile(r"\b(?:Connection|Network|DNS|getaddrinfo|ECONN|socket)\b", re.IGNORECASE),
     "This worker couldn't reach an external service. Check the connection, then re-run."),
    (re.compile(r"SHA-256 reference|from /uploads", re.IGNORECASE),
     "This worker needs a file uploaded for one of its inputs. Upload the file, then re-run."),
]


# A worker's OWN code crashing (NameError, FileNotFoundError, etc. raised inside
# its run.py) must read as a CODE error the operator can fix/re-generate, NOT as
# a platform "internal error" and NEVER as "took too long". The E2B driver wraps
# such a crash as error_code=execution_error (non-zero exit) or e2b_sandbox_error
# with the exception class name in the raw string. Detect those classes so we can
# route them to _CODE_HEADLINE before the generic code-taxonomy mapping.
_WORKER_CODE_TRACEBACK_RE = re.compile(
    r"\b(?:"
    r"NameError|FileNotFoundError|AttributeError|TypeError|ValueError|KeyError"
    r"|UnboundLocalError|IndexError|ZeroDivisionError|NotImplementedError|RuntimeError"
    r"|SyntaxError|IndentationError|TabError|RecursionError|AssertionError"
    r"|ModuleNotFoundError|ImportError|OSError|IOError|JSONDecodeError"
    r"|UnicodeDecodeError|UnicodeEncodeError"
    r")\b"
)
# Bare Python exception MESSAGES that carry no exception-class name (so
# _WORKER_CODE_TRACEBACK_RE misses them) yet are unmistakably worker-code-crash
# jargon. e.g. a TypeError stringified as just its message
# ("unsupported operand type(s) for /: 'str' and 'float'") with error_code=None.
# These must read as a CODE error, never leak verbatim to the operator (P0-2).
_BARE_PYTHON_EXC_MSG_RE = re.compile(
    r"(?i:"
    r"unsupported operand type\(s\)"
    r"|can't multiply sequence by non-int"
    r"|cannot multiply sequence by non-int"
    r"|object cannot be interpreted as an integer"
    r"|object is not (?:subscriptable|callable|iterable|reversible)"
    r"|object has no attribute"
    r"|object of type .* has no len"
    r"|(?:list|string|tuple|dict) index out of range"
    r"|index out of range"
    r"|division by zero"
    r"|float division by zero"
    r"|integer division or modulo by zero"
    r"|cannot unpack non-iterable"
    r"|(?:not enough|too many) values to unpack"
    r"|takes (?:no|exactly|at least|at most|from) .* argument"
    r"|missing \d+ required (?:positional|keyword-only) argument"
    r"|got an unexpected keyword argument"
    r"|positional argument(?:s)? but \d+ (?:was|were) given"
    r"|could not convert string to float"
    r"|invalid literal for int\(\) with base"
    r"|string indices must be integers"
    r"|'[^']*' is not defined"
    r"|name '[^']*' is not defined"
    r"|can only concatenate"
    r"|unhashable type"
    r"|'NoneType' object"
    r")"
)

# Error codes whose raw text can legitimately carry a worker-code traceback
# (the worker's run.py crashed). For these, a code-class traceback in the raw
# string outranks the generic headline so the operator sees "code has an error".
_WORKER_CODE_ERROR_CODES = frozenset({"execution_error", "e2b_sandbox_error", "timeout"})


def _looks_like_worker_code_error(text: str) -> bool:
    """True when the raw error text contains a Python exception class raised by
    the worker's own code (so the operator headline should be _CODE_HEADLINE).

    Also matches BARE exception messages that carry no class name (a stringified
    TypeError/ValueError message), which the class-name regex would otherwise
    miss and let leak verbatim to the operator surface."""
    if not text:
        return False
    return bool(
        _WORKER_CODE_TRACEBACK_RE.search(text)
        or _BARE_PYTHON_EXC_MSG_RE.search(text)
    )


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

    # A worker's OWN code crash must read as a CODE error (fixable / re-generable),
    # not a platform "internal error" and never "took too long". When the raw text
    # carries a Python exception class AND the code is one that wraps worker
    # execution (execution_error / e2b_sandbox_error) or is absent, route to the
    # code headline before the generic taxonomy. Setup codes (missing_secret,
    # missing_connection, etc.) are unaffected — they never carry a traceback.
    if (not code or code in _WORKER_CODE_ERROR_CODES) and _looks_like_worker_code_error(str(raw_error or "")):
        return _CODE_HEADLINE

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


# The smoke pipeline builds its `reason` as "<raw error> (error_code=<code>)"
# (run_service `smoke_and_gate_generated_worker`). The raw error can carry a
# sandbox path (/home/user/worker/run.py) or a bare Python exception, so the
# reason must never leave the backend verbatim — it reaches the operator via
# the draft-and-create response and the worker-author SSE event.
_SMOKE_REASON_CODE_RE = re.compile(r"\s*\(error_code=([A-Za-z0-9_]+)\)\s*$")

# The smoke pipeline also builds reasons as "<code>: <raw error>" (e.g.
# "output_validation_failed: worker reported success but produced no real
# output"). The leading code prefix must be stripped and routed through the
# operator-headline path too, never leaked verbatim.
_SMOKE_REASON_LEADING_CODE_RE = re.compile(r"^([a-z][a-z0-9_]+):\s*")


def humanize_smoke_reason(reason: Optional[str]) -> Optional[str]:
    """Calm, operator-safe rendering of a smoke `reason` string.

    Splits off the trailing "(error_code=…)" the smoke pipeline appends, then
    routes the raw text + code through the SAME operator-headline/redaction path
    used for run errors. Guarantees no sandbox path or raw Python jargon escapes
    on the create/SSE surfaces (G5 P1-A)."""
    if reason is None:
        return None
    text = str(reason).strip()
    if not text:
        return None
    code: Optional[str] = None
    m = _SMOKE_REASON_CODE_RE.search(text)
    if m:
        code = m.group(1)
        if code.lower() in ("unknown", "none", ""):
            code = None
        text = _SMOKE_REASON_CODE_RE.sub("", text).strip()
    # No trailing code? The pipeline may instead prefix the reason as
    # "<code>: <raw error>" (e.g. "output_validation_failed: …"). Treat the
    # leading prefix as the code and strip it so it never reaches the operator
    # verbatim, then route through the same headline/redaction path.
    if code is None:
        lead = _SMOKE_REASON_LEADING_CODE_RE.match(text)
        if lead:
            lead_code = lead.group(1)
            if lead_code.lower() not in ("unknown", "none", ""):
                code = lead_code
            text = _SMOKE_REASON_LEADING_CODE_RE.sub("", text).strip()
    # A bare quoted token (e.g. "'name'") is a stripped KeyError arg — meaningless
    # to an operator. Treat it as a worker-code error rather than letting the bare
    # key pass through verbatim.
    if re.fullmatch(r"""['"][^'"]*['"]""", text):
        return _CODE_HEADLINE
    headline = _operator_error_message(text, code)
    if headline is None:
        # No raw text resolved to a headline; never return the raw string —
        # scrub any residual path/jargon defensively.
        return _redact_public_log_message(text) or _OPERATOR_ERROR_GENERIC
    return headline


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
    through verbatim to the operator surface.

    Also true for bare Python exception MESSAGES with no class name
    ("unsupported operand type(s) for /: 'str' and 'float'") so they never leak
    verbatim when an error_code is missing or unrecognised (P0-2)."""
    if not text:
        return False
    return bool(
        _RUNTIME_JARGON_RE.search(text) or _BARE_PYTHON_EXC_MSG_RE.search(text)
    )


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
    redacted = _redact_public_log_message(raw)
    # FIX 5 (2026-05-29): the debug 'Raw' tab still leaked real filesystem paths
    # (sandbox /home/user/worker/, server /root/workeros/...). error_raw must
    # never carry a real path. Strip them — the operator headline is unchanged.
    redacted = _SANDBOX_PATH_RE.sub("[worker file]", redacted)
    return redacted or None


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


def _public_error_field(raw_error: Any, error_code: Any = None) -> str:
    """Map a part/event 'error' field to the calm operator HEADLINE — the SAME
    text the Error card and GET /runs error show (G5 P1). Before this, the SSE
    finish 'error' was only path/traceback-scrubbed (_redact_public_log_message),
    so a bare 'ZeroDivisionError: division by zero' / 'Run failed: <raw>' read as
    jargon to a recruiter. Now it carries the headline, then the redactor as a
    belt-and-braces fallback so no internal artifact can ever slip through."""
    raw = str(raw_error or "")
    # A bare 'Command exited with code N' is the non-zero-exit signal of a
    # crashed worker — calm it like any other code error before mapping.
    if _COMMAND_EXIT_RE.search(_e2b_log_content(raw)) and not _looks_like_worker_code_error(raw):
        return _CODE_HEADLINE
    headline = _operator_error_message(raw, str(error_code) if error_code else None)
    redacted = _redact_public_log_message(headline or raw)
    # Final belt-and-braces: never let the exit boilerplate slip through.
    if _COMMAND_EXIT_RE.search(_e2b_log_content(redacted)):
        return _CODE_HEADLINE
    return redacted


def _run_event_metadata(run_id: Any) -> Dict[str, Any]:
    run_id_text = str(run_id or "").strip()
    if not run_id_text:
        return {}
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT r.worker_id, r.completed_at, r.duration_ms,
                       COALESCE(w.name, r.worker_id) AS worker_name
                FROM runs r
                LEFT JOIN workers w ON w.id = r.worker_id
                WHERE r.id = ?
                """,
                (run_id_text,),
            ).fetchone()
        return dict(row) if row else {}
    except Exception:
        return {}


def _public_sse_event(event: Dict[str, Any]) -> Dict[str, Any]:
    public_event = dict(event)
    run_id = public_event.get("run_id")
    run_meta = _run_event_metadata(run_id)
    if run_meta:
        public_event.setdefault("worker_id", run_meta.get("worker_id"))
        public_event.setdefault("worker_name", run_meta.get("worker_name"))
        if public_event.get("type") == "status" and public_event.get("status") in _TERMINAL_STATUSES:
            public_event.setdefault("completed_at", run_meta.get("completed_at"))
            public_event.setdefault("duration_ms", run_meta.get("duration_ms"))
    artifact = public_event.get("artifact")
    if isinstance(artifact, dict) and run_id:
        artifact_id = artifact.get("id")
        if artifact_id:
            artifact.setdefault(
                "download_url",
                f"/runs/{run_id}/artifacts/{artifact_id}/download",
            )
        if run_meta:
            artifact.setdefault("worker_id", run_meta.get("worker_id"))
            artifact.setdefault("worker_name", run_meta.get("worker_name"))
    if "message" in public_event:
        public_event["message"] = _redact_public_log_message(str(public_event.get("message") or ""))
    if public_event.get("error") is not None:
        public_event["error"] = _public_error_field(
            public_event["error"], public_event.get("error_code")
        )
    public_event.pop("trace_id", None)
    return public_event


def _public_run_part(part: Dict[str, Any]) -> Dict[str, Any]:
    public_part = dict(part)
    if "message" in public_part:
        public_part["message"] = _redact_public_log_message(str(public_part.get("message") or ""))
    if public_part.get("error") is not None:
        public_part["error"] = _public_error_field(
            public_part["error"], public_part.get("error_code")
        )
    return public_part


@app.get("/runs/{run_id}/logs")
def get_run_logs(
    run_id: str,
    level: Optional[str] = Query(None, description="Filter by log level (info, warning, error, debug)"),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[Dict[str, Any]]:
    if _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos) is None:
        raise HTTPException(status_code=404, detail="Run not found")
    rows = repos.runs.list_logs(user_id=auth.user_id, run_id=run_id)
    # G5 P1: collapse the e2b stderr code-echo on RAW ordered rows FIRST, THEN
    # per-row redact, so GET /runs/{id}/logs matches the calm panel.
    raw = [
        {"level": r["level"], "message": r["message"], "timestamp": r["timestamp"]}
        for r in rows
    ]
    collapsed = _collapse_stderr_code_echo_rows(raw)
    if level:
        collapsed = [row for row in collapsed if row.get("level") == level]
    return [
        {
            "level": row["level"],
            "message": _redact_public_log_message(row["message"]),
            "timestamp": row["timestamp"],
        }
        for row in collapsed
    ]


# ---------------------------------------------------------------------------
# Run-authenticated Composio tool-execute proxy
# ---------------------------------------------------------------------------
# Workers inside E2B sandboxes cannot hold COMPOSIO_API_KEY (platform secret).
# Instead, they call POST /runs/{run_id}/composio-execute/{tool_slug} using
# their own WORKEROS_RUN_TOKEN header.  The API validates the signed run token,
# validates the run_id is in RUNNING status, looks up the connection for the
# requested app, and proxies the Composio v3 tool-execute call server-side.
#
# Auth: no x-floom-secret (the path is middleware-exempt). The signed run token
# is a short-lived bearer credential and is valid only for this endpoint.

class _ComposioProxyRequest(BaseModel):
    # Composio tool-execute body fields (all optional; forwarded as-is)
    connected_account_id: Optional[str] = None
    user_id: Optional[str] = None
    arguments: Optional[Dict[str, Any]] = None


@app.post("/runs/{run_id}/composio-execute/{tool_slug}")
def composio_execute_proxy(
    request: Request,
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
    from run_token import verify_run_token as _verify_run_token

    token_run_id = _verify_run_token(request.headers.get("x-workeros-run-token", ""))
    if token_run_id is None:
        raise HTTPException(status_code=401, detail="Missing or invalid run token")
    if token_run_id != run_id:
        raise HTTPException(status_code=403, detail="Run token does not match request run_id")

    # 1. Validate run_id — must exist in DB and be RUNNING.
    #    NOTE: get_any() is the UNSCOPED run lookup. That is correct *here* and
    #    only here on an HTTP path: this endpoint is the sandbox→API callback,
    #    middleware-exempt, and authorized by possession of a live run_id (the
    #    capability), not by an operator auth context. The run_id is only a valid
    #    capability while the run is RUNNING — a missing/garbage/terminal run is
    #    rejected below, so get_any() never doubles as an authed read path here.
    #    Do NOT use get_any() on any operator-facing read endpoint; those scope
    #    by user_id via repos.runs.get(user_id=...).
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

    # 3. Authorize the worker's tool call against its declared connection scope.
    #    SECURITY (multi-tenant): a run_id is a sandbox capability, not carte
    #    blanche to drive every owner connection. The worker manifest must
    #    declare the Composio app, and structured declarations can restrict the
    #    exact tool slugs available to this worker.
    worker_id = run_row.get("worker_id", "")
    worker_row = repos.workers.get_any(worker_id=worker_id) if worker_id else None
    if worker_row is None:
        raise HTTPException(status_code=404, detail="Run worker not found")
    owner_id = worker_row.get("owner_id") or ""
    if not owner_id:
        raise HTTPException(status_code=403, detail="Run owner could not be resolved")

    config = get_worker_config_for_run(worker_id)
    declared_connections = declared_composio_connections(config)
    declared_scopes = declared_composio_connection_scopes(config)
    tool_prefix = composio_app_for_tool_slug(tool_slug, declared_connections)
    if not tool_prefix:
        raise HTTPException(
            status_code=403,
            detail=f"Worker did not declare a connection matching tool {tool_slug}",
        )
    allowed_tools = declared_connections.get(tool_prefix)
    if allowed_tools is not None and tool_slug.upper() not in allowed_tools:
        logger.warning(
            "composio tool denied: worker=%s app=%s tool=%s blocked by allowlist",
            worker_id, tool_prefix, tool_slug.upper(),
        )
        raise HTTPException(
            status_code=403,
            detail=f"Tool {tool_slug} is not allowed for worker connection {tool_prefix}",
        )
    if not composio_tool_allowed_by_scope(tool_prefix, tool_slug, declared_scopes.get(tool_prefix)):
        raise HTTPException(
            status_code=403,
            detail=f"Tool {tool_slug} is outside the worker connection scope for {tool_prefix}",
        )

    # 4. Resolve connected_account_id. If the worker supplies one from
    #    connections.json, verify it still belongs to the run owner and app.
    #    Otherwise pick the run-owner's active connection for the declared app.
    connected_account_id = body.connected_account_id
    active_owner_connections = [
        conn_row for conn_row in repos.connections.list(user_id=owner_id)
        if conn_row.get("app_name") == tool_prefix and conn_row.get("status") == "active"
    ]
    if connected_account_id:
        if not any(conn_row.get("composio_connection_id") == connected_account_id for conn_row in active_owner_connections):
            raise HTTPException(
                status_code=403,
                detail=f"Connection is not active for owner/app {tool_prefix}",
            )
    elif active_owner_connections:
        connected_account_id = active_owner_connections[0].get("composio_connection_id")
    else:
        raise HTTPException(
            status_code=403,
            detail=f"No active Composio connection found for app {tool_prefix}",
        )

    if body.user_id and body.user_id != owner_id:
        raise HTTPException(status_code=403, detail="Proxy user_id must match the run owner")

    # 5. Build and forward the Composio request
    proxy_body: Dict[str, Any] = {}
    if connected_account_id:
        proxy_body["connected_account_id"] = connected_account_id
        # Composio v3 requires the owner entity alongside a connected account.
        # The sandbox cannot pick this safely; the server derives it from the run.
        proxy_body["entity_id"] = owner_id
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

# Path to the .env file used by the API. Overridable via WORKEROS_API_ENV_FILE /
# FLOOM_API_ENV_FILE (same knob the db.sqlite secrets writer honours) so tests
# can redirect secret persistence away from the checkout's apps/api/.env.
def _env_file_path() -> Path:
    override = (
        os.environ.get("WORKEROS_API_ENV_FILE")
        or os.environ.get("FLOOM_API_ENV_FILE")
    )
    if override:
        return Path(override)
    return Path(__file__).parent / ".env"


_ENV_PATH = Path(__file__).parent / ".env"


class SecretUpsertRequest(BaseModel):
    value: str = Field(min_length=1, max_length=32 * 1024)


class SecretTestResult(BaseModel):
    status: str  # "valid" | "invalid"
    reason: Optional[str] = None


SecretName = Annotated[str, PathParam(min_length=1, max_length=64, pattern=r"^[A-Z][A-Z0-9_]*$")]


def _secret_value_has_control_chars(value: str) -> bool:
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in value)


def _read_env_lines() -> list[str]:
    """Read .env lines; return [] if file does not exist."""
    env_path = _env_file_path()
    if not env_path.exists():
        return []
    with open(env_path, "r") as f:
        return f.readlines()


def _write_env_lines(lines: list[str]) -> None:
    """Atomically write .env lines with file lock."""
    env_path = _env_file_path()
    env_path.parent.mkdir(parents=True, exist_ok=True)
    with open(env_path, "a+") as lock_fd:
        _fcntl_mod.flock(lock_fd, _LOCK_EX)
        try:
            with open(env_path, "w") as f:
                f.writelines(lines)
        finally:
            _fcntl_mod.flock(lock_fd, _LOCK_UN)


def _upsert_env_var(name: str, value: str) -> None:
    """Set or replace NAME=value in the .env file, then reload into os.environ."""
    # Validate name is a legal env var identifier
    if len(name) < 1 or len(name) > 64:
        raise ValueError("Secret name must be 1-64 characters")
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
        raise ValueError(f"Invalid secret name: {name!r}")
    if len(value) < 1 or len(value) > 32 * 1024:
        raise ValueError("Secret value must be 1-32768 characters")
    # Reject control characters. Newline/CR corrupt the env file by injecting
    # extra lines; other controls make later rendering/logging unsafe.
    if _secret_value_has_control_chars(value):
        raise ValueError(
            "Secret value must not contain newline or control characters"
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


def _require_secret_mutation_allowed(auth: AuthContext, existing: Optional[Dict[str, Any]], name: str) -> None:
    """#952: members may create secrets and manage their own, but must not
    overwrite or delete a secret someone else created.

    Per-user secret repositories (OSS SQLite) never surface another user's
    rows, so this is a no-op there. Workspace-scoped repositories (cloud)
    return the workspace row with its creator's user_id — where, before this
    guard, any member could replace or delete the admin's API keys.
    """
    if existing is None or auth.is_admin:
        return
    creator = str(existing.get("user_id") or "")
    if creator and creator != auth.user_id:
        raise HTTPException(
            status_code=403,
            detail=f"only an admin or the creator can modify secret {name!r}",
        )


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
    if _secret_value_has_control_chars(payload.value):
        raise HTTPException(
            status_code=400,
            detail="Secret value must not contain newline or control characters",
        )
    _require_secret_mutation_allowed(auth, repos.secrets.get(user_id=auth.user_id, name=name), name)
    repos.secrets.set(
        user_id=auth.user_id,
        name=name,
        value=payload.value,
        status=SecretStatus.SET.value,
    )
    # #952: secret mutations are audit-logged with the actor (never the value).
    logger.info("Secret %s upserted by user=%s role=%s", name, auth.user_id, auth.role)
    # Re-encrypt .secrets.enc if workspace is connected to GitHub
    _cfg = _git_cfg_get(auth.user_id)
    if _cfg and _cfg.get("github_pat") and _cfg.get("repo_full_name"):
        _sync_secrets_to_enc(auth.user_id, repos, _cfg["github_pat"], _cfg["repo_full_name"])
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
    existing = repos.secrets.get(user_id=auth.user_id, name=name)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"Secret {name!r} not found in .env")
    _require_secret_mutation_allowed(auth, existing, name)
    repos.secrets.delete(user_id=auth.user_id, name=name)
    # #952: secret mutations are audit-logged with the actor (never the value).
    logger.info("Secret %s deleted by user=%s role=%s", name, auth.user_id, auth.role)
    # Re-encrypt .secrets.enc if workspace is connected to GitHub
    _cfg = _git_cfg_get(auth.user_id)
    if _cfg and _cfg.get("github_pat") and _cfg.get("repo_full_name"):
        _sync_secrets_to_enc(auth.user_id, repos, _cfg["github_pat"], _cfg["repo_full_name"])
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
    db_row = repos.secrets.get(user_id=auth.user_id, name=name)
    if db_row is not None:
        value = repos.secrets.read_value(user_id=auth.user_id, name=name)
        if not value:
            raise HTTPException(status_code=404, detail="Secret not found")
        return SecretTestResult(status="valid", reason="Secret is configured.")
    # Secret not in DB — check if it is available via environment (e.g. set as a
    # platform env var that the list endpoint also surfaces as SET).
    available = _available_secret_names_for_user(auth.user_id, repos)
    if name in available:
        return SecretTestResult(status="valid", reason="Secret is configured.")
    raise HTTPException(status_code=404, detail="Secret not found")


# ---------------------------------------------------------------------------
# Platform secrets — infra vars that belong in Settings, NOT the secrets UI
# ---------------------------------------------------------------------------

class PlatformSecretSpec(TypedDict):
    name: str
    required: bool
    default: Optional[str]
    description: Optional[str]
    fallback: NotRequired[str]


PLATFORM_SECRET_SPECS: list[PlatformSecretSpec] = [
    {
        "name": "PLATFORM_OPENAI_API_KEY",
        "required": True,
        "default": None,
        "fallback": "OPENAI_API_KEY",
        "description": "Platform OpenAI key for Emily and prompt-to-worker drafting/codegen. Falls back to OPENAI_API_KEY for back-compat. Workers bring their OWN OPENAI_API_KEY via Settings -> Secrets (a normal user secret, not a platform secret).",
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
    platform_available = _available_secret_names_for_user(auth.user_id, repos) - set(db_secrets)

    # Build worker configs once — avoids N×M get_worker_config_for_run() calls
    # (one per worker per secret) that would otherwise hit the DB on every secret.
    worker_configs: dict[str, Any] = {}
    worker_secret_names: set[str] = set()
    for w in workers:
        config = get_worker_config_for_run(w["id"])
        worker_configs[w["id"]] = config
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
        elif name in platform_available:
            status = SecretStatus.SET
        else:
            status = SecretStatus.SET if value else SecretStatus.MISSING
        used_by = [
            w["name"]
            for w in workers
            if worker_configs.get(w["id"]) and name in worker_configs[w["id"]].secrets
        ]
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
    transport: Literal["streamable_http", "sse", "stdio"] = "streamable_http"
    url: Optional[str] = None
    command: Optional[str] = None
    args: List[str] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict)
    cwd: Optional[str] = None
    auth_secret: Optional[str] = None
    allowed_tools: List[str] = Field(default_factory=list)


class ConnectionItem(BaseModel):
    # NEW-7 (2026-06-02): the raw Composio ``ca_*`` connection id is no longer
    # exposed. Clients reference a connection by the internal Floom UUID ``id``;
    # the API resolves it to the raw ``ca_*`` server-side (with the server-held
    # COMPOSIO_API_KEY) when registering triggers / fetching account info.
    id: str
    app_name: str
    status: str
    created_at: str
    updated_at: str
    kind: str = "composio"
    scopes: List[str] = []
    account_label: Optional[str] = None
    display_name: Optional[str] = None
    last_checked_at: Optional[str] = None
    last_check_status: Optional[str] = None
    last_used_at: Optional[str] = None  # #802: most recent run using this connection
    last_used_by: Optional[str] = None  # #802: worker name of that run
    owner_id: Optional[str] = None
    mcp_label: Optional[str] = None
    mcp_url: Optional[str] = None
    mcp_transport: str = "streamable_http"
    mcp_command: Optional[str] = None
    mcp_args: List[str] = []
    mcp_env: Dict[str, str] = {}
    mcp_cwd: Optional[str] = None
    mcp_auth_secret: Optional[str] = None
    mcp_allowed_tools: List[str] = []


class ConnectionTestResult(BaseModel):
    status: str  # "valid" | "failed" | "expired"
    reason: str
    tested_at: str
    tools: Optional[List[str]] = None  # #789: live-enumerated MCP tool names


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


def _raise_composio_unavailable(exc: Exception) -> None:
    from composio_client import ComposioConfigurationError

    if isinstance(exc, ComposioConfigurationError):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    raise HTTPException(
        status_code=503,
        detail=(
            "Unable to reach the integration provider right now. "
            "Try again later or use an API-key connection if this app does not support OAuth."
        ),
    ) from exc


@app.get("/integrations/catalog", response_model=IntegrationCatalogResponse)
def integrations_catalog(
    page: int = Query(1, ge=1),
    limit: int = Query(30, ge=1, le=100),
    search: str = Query("", max_length=120),
    category: str = Query("", max_length=200),
    # #919: requires a real auth context — without it, any Bearer token or
    # cookie slipped past the shared-secret middleware check and could
    # enumerate the catalog (and burn Composio quota) unauthenticated.
    auth: AuthContext = Depends(get_auth_context),
) -> IntegrationCatalogResponse:
    """Return the integration catalog, with optional comma-separated category OR-filter.

    When ``category`` contains multiple comma-separated slugs, results from each
    slug are fetched separately and merged (union, de-duplicated by app slug).
    """
    from composio_client import ComposioConfigurationError, list_catalog_apps

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
            first_error: Exception | None = None
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
                except ComposioConfigurationError:
                    raise
                except Exception:
                    if first_error is None:
                        first_error = sys.exc_info()[1]
                    logger.warning("Failed to fetch category %s from Composio", slug)
            if first_error is not None and not seen:
                raise first_error

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
        _raise_composio_unavailable(exc)
    return IntegrationCatalogResponse(**result)


class CatalogToolItem(BaseModel):
    name: str
    description: str


@app.get("/integrations/catalog/{slug}/tools", response_model=List[CatalogToolItem])
def integrations_catalog_tools(
    slug: str,
    limit: int = 100,
    # #919: same auth requirement as the catalog listing above.
    auth: AuthContext = Depends(get_auth_context),
) -> List[CatalogToolItem]:
    """Return up to `limit` tools for a Composio toolkit slug, cached 1 h.

    Designed for the Browse catalog tools modal. Default limit raised to 100
    so the modal can show the full tool list (e.g. Gmail has 85+ tools).
    Returns [] when Composio is unreachable so the UI degrades gracefully.
    """
    from composio_client import list_toolkit_tools
    effective_limit = max(1, min(200, limit))
    try:
        items = list_toolkit_tools(slug, limit=effective_limit)
    except Exception as exc:
        logger.warning("Failed to fetch toolkit tools for %s: %s", slug, exc)
        items = []
    return [CatalogToolItem(**item) for item in items]


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
_COMPOSIO_ACTIVE_STATUSES = {"active", "valid", "connected", "enabled", "success"}


def _normalize_composio_connection_status(status: Optional[str]) -> str:
    normalized = (status or "").strip().lower()
    if normalized in _COMPOSIO_ACTIVE_STATUSES:
        return "active"
    return normalized


def _account_label_from_info(info: Dict[str, Any]) -> str:
    for key in ("email", "account_label", "handle", "username", "login"):
        value = info.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _cache_connection_account_info(
    *,
    repos: Repositories,
    user_id: str,
    connection_id: str,
    composio_connection_id: str,
    now: str,
) -> Dict[str, Any]:
    info = _fetch_composio_account_info(composio_connection_id, user_id=user_id)
    if not info:
        return {}

    updates: Dict[str, Any] = {"updated_at": now}
    account_label = _account_label_from_info(info)
    if account_label:
        updates["account_label"] = account_label
    if info.get("scopes") is not None:
        updates["scopes_json"] = info.get("scopes") or []

    remote_status = _normalize_composio_connection_status(info.get("status"))
    if remote_status and remote_status != "not_found":
        updates["status"] = remote_status

    if len(updates) > 1:
        repos.connections.update(
            user_id=user_id,
            composio_id=connection_id,
            **updates,
        )
    return info


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
    # NEW-7: never surface the raw Composio ``ca_*`` id to clients.
    item.pop("composio_connection_id", None)
    item["owner_id"] = item.get("owner_id") or item.get("user_id")
    item["kind"] = item.get("kind") or "composio"
    # Single-tenant owner view: show the owner their OWN account identity.
    # display_name carries the real label when present; fall back to
    # account_label. Both are the owner's own data, so no redaction.
    raw_label = item.get("display_name") or item.get("account_label")
    normalized = _normalize_owner_account_label(raw_label)
    item["account_label"] = normalized
    item["display_name"] = normalized
    item["mcp_allowed_tools"] = _parse_json_string_list(item.pop("mcp_allowed_tools_json", None))
    item["mcp_args"] = _parse_json_string_list(item.pop("mcp_args_json", None))
    try:
        raw_env = json.loads(item.pop("mcp_env_json", None) or "{}")
        item["mcp_env"] = raw_env if isinstance(raw_env, dict) else {}
    except Exception:
        item["mcp_env"] = {}
    item["mcp_transport"] = item.get("mcp_transport") or "streamable_http"
    return ConnectionItem(**item)


def _normalize_mcp_connection_payload(payload: MCPConnectionCreateRequest) -> Dict[str, Any]:
    label = payload.label.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", label):
        raise HTTPException(
            status_code=400,
            detail="MCP label must be 1-64 letters, digits, underscores, or hyphens",
        )

    transport = payload.transport or "streamable_http"
    if transport not in {"streamable_http", "sse", "stdio"}:
        raise HTTPException(status_code=400, detail="MCP transport must be streamable_http, sse, or stdio")

    url = (payload.url or "").strip() or None
    command = (payload.command or "").strip() or None
    cwd = (payload.cwd or "").strip() or None
    if transport in {"streamable_http", "sse"}:
        if not url:
            raise HTTPException(status_code=400, detail="MCP URL is required for HTTP/SSE transports")
        if not url.startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail="MCP URL must start with http:// or https://")
        # SSRF deny-list: reject internal/loopback/link-local (incl. cloud
        # metadata 169.254.169.254) and RFC1918 targets at registration time.
        # Re-checked at dial time in the agent driver (DNS can rebind).
        try:
            url = assert_safe_outbound_mcp_url(url)
        except UnsafeMCPUrlError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if command:
            raise HTTPException(status_code=400, detail="MCP command is only valid for stdio transport")
    if transport == "stdio":
        if not command:
            raise HTTPException(status_code=400, detail="MCP command is required for stdio transport")
        if url:
            raise HTTPException(status_code=400, detail="MCP URL is not valid for stdio transport")

    auth_secret = (payload.auth_secret or "").strip() or None
    if auth_secret and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", auth_secret):
        raise HTTPException(status_code=400, detail="MCP auth secret must be a valid secret name")
    if auth_secret and transport == "stdio":
        raise HTTPException(status_code=400, detail="MCP auth secret is only valid for HTTP/SSE transports")

    allowed_tools = [tool.strip() for tool in payload.allowed_tools if tool and tool.strip()]
    if len(allowed_tools) != len(payload.allowed_tools):
        raise HTTPException(status_code=400, detail="MCP allowed tools must be non-empty")
    args = [str(arg).strip() for arg in payload.args if str(arg).strip()]
    env: Dict[str, str] = {}
    for key, raw in payload.env.items():
        name = str(key).strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise HTTPException(status_code=400, detail="MCP env keys must be valid environment variable names")
        value = str(raw).strip()
        if value:
            if not value.startswith("secret:"):
                raise HTTPException(
                    status_code=400,
                    detail="MCP env values must reference secrets as secret:SECRET_NAME",
                )
            secret_name = value.split(":", 1)[1]
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", secret_name):
                raise HTTPException(
                    status_code=400,
                    detail="MCP env secret references must use valid secret names",
                )
            env[name] = value

    return {
        "label": label,
        "transport": transport,
        "url": url,
        "command": command,
        "args": args,
        "env": env,
        "cwd": cwd,
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


class _EmailPreviewItem(TypedDict):
    subject: str
    from_name: str
    from_email: str
    date: str


def _fetch_email_peek(toolkit_slug: str, composio_conn_id: str, user_id: str, *, max_results: int = 3) -> List[_EmailPreviewItem]:
    """Fetch recent email subjects/senders via Composio for trust-peek display.

    Only supports gmail for now. Returns [] on any error or unsupported provider.
    Response shapes vary by Composio tool version — handled defensively.
    """
    import requests as _requests
    if toolkit_slug != "gmail":
        return []
    key = os.environ.get("COMPOSIO_API_KEY", "")
    if not key:
        return []
    try:
        r = _requests.post(
            "https://backend.composio.dev/api/v3/tools/execute/GMAIL_FETCH_EMAILS",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            json={
                "connected_account_id": composio_conn_id,
                "user_id": user_id,
                "arguments": {"max_results": max_results, "include_spam_trash": False},
            },
            timeout=10,
        )
        if not r.ok:
            return []
        payload = r.json()
        if not payload.get("successful"):
            return []
        outer = payload.get("data") or {}
        if not isinstance(outer, dict):
            outer = {}
        data = (
            outer.get("response_data")
            or outer.get("response_dict")
            or outer
        )
        # Composio GMAIL_FETCH_EMAILS returns messages in different shapes:
        # {"messages": [{...}]} or directly a list, or {"emails": [{...}]}
        messages: List[Any] = []
        if isinstance(data, list):
            messages = data
        elif isinstance(data, dict):
            messages = data.get("messages") or data.get("emails") or []
        if not isinstance(messages, list):
            return []

        result: List[_EmailPreviewItem] = []
        for msg in messages[:max_results]:
            if not isinstance(msg, dict):
                continue
            # Extract subject — may be in "subject" or "payload.headers"
            subject = str(msg.get("subject") or msg.get("snippet") or "")
            if not subject:
                headers = msg.get("payload", {}).get("headers") or []
                for h in headers:
                    if isinstance(h, dict) and h.get("name", "").lower() == "subject":
                        subject = str(h.get("value") or "")
                        break
            # Extract sender
            sender_raw = str(msg.get("from") or msg.get("sender") or "")
            if not sender_raw:
                headers = msg.get("payload", {}).get("headers") or []
                for h in headers:
                    if isinstance(h, dict) and h.get("name", "").lower() == "from":
                        sender_raw = str(h.get("value") or "")
                        break
            # Parse "Name <email>" or bare email
            from_name, from_email = "", sender_raw
            if "<" in sender_raw and ">" in sender_raw:
                parts = sender_raw.split("<", 1)
                from_name = parts[0].strip().strip('"')
                from_email = parts[1].rstrip(">").strip()
            # Date
            date_str = str(msg.get("date") or msg.get("internalDate") or "")
            if date_str.isdigit():
                # internalDate is milliseconds since epoch
                try:
                    import datetime
                    dt = datetime.datetime.utcfromtimestamp(int(date_str) / 1000)
                    date_str = dt.isoformat() + "Z"
                except Exception:
                    pass
            if subject or from_email:
                result.append(_EmailPreviewItem(
                    subject=subject[:120],
                    from_name=from_name[:80],
                    from_email=from_email[:120],
                    date=date_str,
                ))
        return result
    except Exception as exc:
        logger.debug("email peek fetch failed for %s: %s", toolkit_slug, exc)
    return []


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
        account_label = (
            email
            or account.get("handle")
            or account.get("username")
            or account.get("login")
            or (account.get("connection_data") or {}).get("handle")
            or (account.get("connection_data") or {}).get("username")
            or (account.get("data") or {}).get("handle")
            or (account.get("data") or {}).get("username")
            or (account.get("data") or {}).get("login")
            or (account.get("metadata") or {}).get("handle")
            or (account.get("metadata") or {}).get("username")
            or (account.get("metadata") or {}).get("login")
            or (account.get("user") or {}).get("login")
            or (account.get("user") or {}).get("name")
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
                account_label = email or account_label
        return {
            "email": email,
            "account_label": account_label,
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


@app.get("/connections/tool-presets")
def list_connection_tool_presets(
    app: Optional[str] = None,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    """Curated read-only tool presets for the Tools-tab allowlist editor (C-B9).

    The UI's "Read-only" preset button calls this to fill a worker connection's
    ``allowed_tools`` with the curated read subset for the app. When ``app`` is
    given, returns the single preset (``tools: null`` when no curated preset
    exists, signalling the UI to fall back to the generic read_only scope).
    Without ``app``, returns every preset keyed by canonical app slug.
    """
    if app:
        return {"app": app, "tools": read_only_preset_for_app(app)}
    return {"presets": read_only_presets()}


def _connections_last_used(user_id: str, repos: Repositories) -> Dict[str, tuple[str, str]]:
    """#802: map connection slug -> (last_used_at, worker_name) from the most
    recent run of any worker declaring that connection. One pass over visible
    workers; O(workers) recent-run lookups."""
    last_used: Dict[str, tuple[str, str]] = {}
    try:
        for w in _list_visible_workers(user_id=user_id, repos=repos, use_cache=True):
            slugs = [s.lower() for s in _worker_connection_slugs(w)]
            if not slugs:
                continue
            recent = repos.runs.list_for_worker(user_id=user_id, worker_id=w["id"], limit=1, offset=0)
            if not recent:
                continue
            run = recent[0]
            ts = str(run.get("created_at") or "")
            if not ts:
                continue
            wname = str(w.get("name") or w["id"])
            for slug in slugs:
                prev = last_used.get(slug)
                if prev is None or ts > prev[0]:
                    last_used[slug] = (ts, wname)
    except Exception:
        logger.debug("connection last-used computation failed", exc_info=True)
    return last_used


@app.get("/connections", response_model=List[ConnectionItem])
def list_connections(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[ConnectionItem]:
    rows = repos.connections.list(user_id=auth.user_id)
    now = datetime.now(timezone.utc)
    last_used = _connections_last_used(auth.user_id, repos)  # #802

    refreshed: List[Dict[str, Any]] = []
    for row in rows:
        d = row_to_dict(row)
        d = _refresh_connection_status_for_list(d, user_id=auth.user_id, repos=repos, now=now)
        d["scopes"] = _parse_scopes_json(d.pop("scopes_json", None))
        used = last_used.get(str(d.get("app_name") or "").lower())
        if used:
            d["last_used_at"], d["last_used_by"] = used
        refreshed.append(d)

    # Hide superseded dead rows: once an app has a live (active/valid) composio
    # connection, its leftover expired/initiated/pending/error siblings are dead
    # Composio sessions from earlier reconnects and only confuse the operator
    # ("reconnect did nothing — still Expired"). Suppress them. API-key rows and
    # apps with no live connection are always kept.
    def _is_live(status: object) -> bool:
        return str(status or "").lower() in ("active", "valid", "connected")

    live_apps = {
        d.get("app_name")
        for d in refreshed
        if (d.get("kind") or "composio") == "composio" and _is_live(d.get("status"))
    }
    result = []
    for d in refreshed:
        if (
            (d.get("kind") or "composio") == "composio"
            and d.get("app_name") in live_apps
            and not _is_live(d.get("status"))
        ):
            continue
        result.append(_public_connection_item(d))
    return result


@app.get("/connections/by-app/{app_name}")
def get_connection_for_app(
    app_name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return the live connection (if any) for ``app_name``.

    Powers the "Already connected as <email>" state on the connect screen so a
    user who re-clicks Connect on an app they already authorized is shown the
    existing account + a Reconnect option, instead of silently kicking off a
    fresh OAuth round-trip that would spawn a duplicate connected account.
    """
    slug = (app_name or "").lower().strip()
    if not slug:
        return {"connected": False}

    def _is_live(status: object) -> bool:
        return str(status or "").lower() in ("active", "valid", "connected")

    rows = repos.connections.list(user_id=auth.user_id)
    matches = [
        r
        for r in rows
        if (r.get("kind") or "composio") == "composio"
        and str(r.get("app_name") or "").lower() == slug
        and _is_live(r.get("status"))
    ]
    if not matches:
        return {"connected": False}

    accounts = [
        {
            "id": r["id"],
            "account_label": r.get("account_label") or None,
            "status": str(r.get("status") or "").lower(),
        }
        for r in matches
    ]
    return {
        "connected": True,
        "app_name": slug,
        "accounts": accounts,
    }


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
        _raise_composio_unavailable(exc)

    composio_conn_id = result["composio_connection_id"]
    redirect_url = result["redirect_url"]
    # Always insert a new row — multiple accounts per app are allowed.
    # Each Composio connected_account is a distinct row identified by its own UUID.
    # (Stale expired siblings are hidden from the UI by list_connections once an
    # active connection exists for the app — see the suppression there. We do NOT
    # reuse/replace rows here, which would break genuine multi-account support.)
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
    account_label = normalized["url"] or " ".join(
        [normalized["command"] or "", *normalized["args"]]
    ).strip()
    row = repos.connections.upsert(
        user_id=auth.user_id,
        id=conn_id,
        app_name=app_name,
        composio_connection_id=f"mcp:{conn_id}",
        status="active",
        created_at=now,
        updated_at=now,
        kind="mcp",
        account_label=account_label,
        mcp_label=label,
        mcp_url=normalized["url"],
        mcp_transport=normalized["transport"],
        mcp_command=normalized["command"],
        mcp_args_json=normalized["args"],
        mcp_env_json=normalized["env"],
        mcp_cwd=normalized["cwd"],
        mcp_auth_secret=normalized["auth_secret"],
        mcp_allowed_tools_json=normalized["allowed_tools"],
    )
    item = row_to_dict(row)
    item["scopes"] = _parse_scopes_json(item.pop("scopes_json", None))
    return _public_connection_item(item)


@app.get("/connections/callback")
def connections_callback(request: Request, connection_id: str = "", status: str = ""):
    """OAuth callback landing — Composio redirects here after user authorizes.

    Composio sends: ?connection_id=<composio_conn_id>&status=<status>
    We update the local DB and redirect the user to /connections.
    """
    from fastapi.responses import RedirectResponse

    frontend_url = os.environ.get("WORKERS_FRONTEND_URL", "https://workers.floom.dev")
    # The floom UUID of the row the user should land on / see highlighted, plus
    # the app slug, are forwarded to the connections page for post-connect
    # feedback ("Connected <App> as <email>"). Filled in below once known.
    landing_id = ""
    landing_app = ""

    callback_connection_id = (
        connection_id
        or request.query_params.get("connected_account_id", "")
        or request.query_params.get("connectedAccountId", "")
        or request.query_params.get("connectionId", "")
        or request.query_params.get("id", "")
    )

    if callback_connection_id:
        repos = get_repositories()
        existing = repos.connections.get_by_composio_connection_id(
            composio_connection_id=callback_connection_id,
        )

        # F2 (2026-06-03) — connection-existence timing oracle: ACCEPTED.
        #
        # The lookup above is an indexed, parameterized SQL equality (`= ?`), not
        # a per-character string comparison, so there is NO classic
        # non-constant-time secret-compare oracle here. The only observable
        # difference between a known and an unknown connection_id is control
        # flow: a KNOWN id triggers a downstream Composio `check_status` network
        # round-trip + DB writes (slow), while an UNKNOWN id returns immediately
        # (fast). The RESPONSE is identical in both cases (the same
        # `?connected=1` redirect below), so only a coarse timing signal remains.
        #
        # We accept this residual timing oracle rather than forcing constant time
        # because:
        #   1. The id space is unguessable — Composio connection ids are random
        #      high-entropy `ca_*` handles, so an attacker cannot meaningfully
        #      enumerate them via timing.
        #   2. This is an intentionally UNAUTHENTICATED OAuth-callback landing
        #      (Composio redirects the browser here); padding it to constant time
        #      would mean either always doing the slow remote call (a DoS amp /
        #      SSRF-ish lever for unauth callers) or never doing it (breaking the
        #      legitimate post-OAuth status refresh). Both are worse than the
        #      low-value timing leak they would close.
        # If the id space ever becomes guessable, revisit and pad the hit path.
        #
        # Ignore unknown callback IDs; known IDs are validated by persisted state.
        if not existing:
            return RedirectResponse(url=f"{frontend_url}/connections?connected=1")

        landing_id = existing["id"]
        landing_app = existing.get("app_name") or ""

        # Try to refresh from Composio first
        try:
            from composio_client import check_status
            remote_status = _normalize_composio_connection_status(check_status(callback_connection_id))
        except Exception:
            remote_status = ""

        callback_status = _normalize_composio_connection_status(status)
        final_status = (
            "active"
            if callback_status == "active" and remote_status in ("", "initiated", "pending", "unknown", "not_found")
            else remote_status
            if remote_status and remote_status != "not_found"
            else callback_status
            if callback_status
            else existing["status"]
        )
        now = now_iso()
        repos.connections.update(
            user_id=existing["user_id"],
            composio_id=existing["id"],
            status=final_status,
            composio_connection_id=callback_connection_id,
            updated_at=now,
        )

        # N5-1 dedupe: now that the OAuth round-trip is complete we can learn the
        # real account identity (e.g. the Gmail address) from Composio. If the
        # user just re-authorized an app+account they had ALREADY connected, an
        # older canonical row for the same (user, app, account_label) exists.
        # Merge into it — repoint that row at the fresh composio_connection_id
        # and refresh its status — then delete THIS freshly-created reconnect
        # row, so the (app, account) pair always collapses to a single row.
        landing_id, landing_app = _dedupe_connection_account(
            repos=repos,
            row=existing,
            connection_id=callback_connection_id,
            final_status=final_status,
            now=now,
        )

    redirect_qs = "connected=1"
    if landing_app:
        redirect_qs += f"&app={urllib.parse.quote(landing_app)}"
    if landing_id:
        redirect_qs += f"&connection_id={urllib.parse.quote(landing_id)}"
    return RedirectResponse(url=f"{frontend_url}/connections?{redirect_qs}")


def _dedupe_connection_account(
    *,
    repos: Any,
    row: Dict[str, Any],
    connection_id: str,
    final_status: str,
    now: str,
) -> tuple[str, str]:
    """Collapse a reconnect into the canonical (user, app, account) row.

    Returns ``(landing_floom_id, app_name)`` — the floom UUID the connections
    page should highlight (the surviving canonical row) and its app slug. On any
    failure it degrades gracefully to the row that was passed in.
    """
    user_id = row["user_id"]
    app_name = row.get("app_name") or ""
    new_id = row["id"]
    landing_id = new_id
    try:
        info = _fetch_composio_account_info(connection_id, user_id=user_id)
        account_label = _account_label_from_info(info)
        if not account_label:
            return landing_id, app_name

        # Cache the freshly learned identity on this row regardless of merge.
        repos.connections.update(
            user_id=user_id,
            composio_id=new_id,
            account_label=account_label,
            scopes_json=info.get("scopes") or [],
            updated_at=now,
        )

        canonical = repos.connections.find_by_app_account(
            user_id=user_id,
            app_name=app_name,
            account_label=account_label,
            exclude_id=new_id,
        )
        if not canonical:
            # First time this (app, account) is seen — the new row IS canonical.
            return new_id, app_name

        # Re-point the older canonical row at the new live Composio account and
        # refresh its status + scopes, then drop the duplicate just created.
        repos.connections.update(
            user_id=user_id,
            composio_id=canonical["id"],
            composio_connection_id=connection_id,
            status=final_status,
            account_label=account_label,
            scopes_json=info.get("scopes") or [],
            updated_at=now,
        )
        repos.connections.delete(user_id=user_id, composio_id=new_id)
        landing_id = canonical["id"]
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Connection dedupe failed for %s: %s", connection_id, exc)
    return landing_id, app_name


@app.get(
    "/webhooks/oauth-callback",
    summary="OAuth callback alias",
    description=(
        "Alias for /connections/callback for cleaner webhook namespace. "
        "The existing /connections/callback route remains the primary callback URL."
    ),
)
def connections_callback_alias(request: Request, connection_id: str = "", status: str = ""):
    return connections_callback(request=request, connection_id=connection_id, status=status)


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
    now = now_iso()
    updated_row: Optional[Dict[str, Any]] = None
    try:
        from composio_client import check_status
        remote_status = _normalize_composio_connection_status(
            check_status(item["composio_connection_id"])
        )
        if remote_status and remote_status != "not_found" and remote_status != item["status"]:
            updated_row = repos.connections.update(
                user_id=user_id,
                composio_id=connection_id,
                status=remote_status,
                updated_at=now,
            )
    except Exception as exc:
        logger.warning("Could not refresh Composio status for %s: %s", connection_id, exc)

    _cache_connection_account_info(
        repos=repos,
        user_id=user_id,
        connection_id=connection_id,
        composio_connection_id=item["composio_connection_id"],
        now=now,
    )
    updated_row = repos.connections.get(user_id=user_id, composio_id=connection_id) or updated_row
    if updated_row:
        item = row_to_dict(updated_row)
        item["scopes"] = _parse_scopes_json(item.pop("scopes_json", None))

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


@app.get("/connections/{connection_id}/activity", response_model=List[RunSummary])
def get_connection_activity(
    connection_id: str,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[RunSummary]:
    """Return recent runs for all workers that declare this connection."""
    user_id = auth.user_id
    conn_row = _connection_row_for_user(connection_id, user_id, "id, app_name", repos=repos)
    conn_slug = (row_to_dict(conn_row).get("app_name") or "").lower().strip()

    # Find all workers owned by this user that declare this connection slug.
    all_workers = _list_visible_workers(user_id=user_id, repos=repos, use_cache=True, role=auth.role)
    matching_worker_ids = [
        w["id"]
        for w in all_workers
        if conn_slug and conn_slug in [s.lower() for s in _worker_connection_slugs(w)]
    ]

    if not matching_worker_ids:
        return []

    # Collect recent runs across all matching workers.
    per_worker = max(1, limit // max(1, len(matching_worker_ids)))
    runs: List[Dict[str, Any]] = []
    for wid in matching_worker_ids:
        runs.extend(repos.runs.list_recent_runs(user_id=user_id, worker_id=wid, limit=per_worker))

    runs.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    runs = runs[:limit]

    return [
        RunSummary(
            id=r["id"],
            worker_id=r["worker_id"],
            status=RunStatus(r["status"]),
            trigger_source=r.get("trigger_source") or "manual",
            created_at=r.get("created_at"),
            started_at=r.get("started_at"),
            completed_at=r.get("completed_at"),
            duration_ms=r.get("duration_ms"),
            error=_operator_error_message(r.get("error"), r.get("error_code")),
            error_code=r.get("error_code"),
        )
        for r in runs
    ]


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

    if not os.environ.get("COMPOSIO_API_KEY", "").strip():
        raise HTTPException(
            status_code=503,
            detail="Composio is not configured on this server. Set COMPOSIO_API_KEY to enable connections.",
        )
    composio_conn_id = row["composio_connection_id"]
    info = _fetch_composio_account_info(composio_conn_id, user_id=auth.user_id)
    if not info:
        raise HTTPException(status_code=503, detail="Unable to fetch account info from upstream")

    # Cache scopes + account_label in DB for the list endpoint.
    account_label = _account_label_from_info(info)
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


class _ConnectionPeekResponse(BaseModel):
    emails: List[Dict[str, str]] = Field(default_factory=list)


@app.get("/connections/{connection_id}/peek", response_model=_ConnectionPeekResponse)
def get_connection_peek(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _ConnectionPeekResponse:
    """Return a privacy-conscious email preview for trust-peek on connection detail.

    Only returns data for active gmail connections. Returns empty emails list for
    other providers, MCP connections, or if Composio is unconfigured. Never errors
    so the UI can call it best-effort.
    """
    try:
        row = _connection_row_for_user(
            connection_id,
            auth.user_id,
            "composio_connection_id, app_name, status",
            repos=repos,
        )
    except HTTPException:
        return _ConnectionPeekResponse(emails=[])
    if row.get("status") != "active":
        return _ConnectionPeekResponse(emails=[])
    toolkit_slug = (row.get("app_name") or "").lower()
    composio_conn_id = row.get("composio_connection_id") or ""
    if not composio_conn_id:
        return _ConnectionPeekResponse(emails=[])
    items = _fetch_email_peek(toolkit_slug, composio_conn_id, auth.user_id, max_results=3)
    return _ConnectionPeekResponse(
        emails=[{"subject": i["subject"], "from_name": i["from_name"], "from_email": i["from_email"], "date": i["date"]} for i in items]
    )


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
        "composio_connection_id, kind, mcp_transport, mcp_allowed_tools_json, mcp_url, mcp_auth_secret",
        repos=repos,
    )

    composio_conn_id = row["composio_connection_id"]
    tested_at = now_iso()

    if (row.get("kind") or "composio") != "composio":
        # #599: actually test MCP connections by attempting to initialize the
        # server and enumerate its tools. Previously returned "valid" immediately
        # without contacting the server, so agents couldn't validate credentials
        # or URL before wiring a connection into a worker.
        mcp_url = row.get("mcp_url") or row.get("url") or row.get("server_url") or ""
        mcp_token = row.get("mcp_auth_secret") or row.get("api_key") or row.get("token") or ""
        mcp_transport = str(row.get("mcp_transport") or "streamable_http").lower()
        allowed_tools = set(_parse_json_string_list(row.get("mcp_allowed_tools_json")))
        if mcp_url:
            try:
                import httpx as _httpx
                headers = {}
                if mcp_token:
                    headers["Authorization"] = f"Bearer {mcp_token}"
                # Streamable-HTTP MCP servers (spec 2025-03-26) reject probes
                # without this Accept header (HTTP 406) and may frame their
                # JSON-RPC responses as SSE.
                headers["accept"] = "application/json, text/event-stream"

                def _parse_mcp_response(resp) -> dict:
                    ctype = (resp.headers.get("content-type") or "").lower()
                    if "text/event-stream" in ctype:
                        for line in resp.text.splitlines():
                            line = line.strip()
                            if line.startswith("data:"):
                                try:
                                    parsed = json.loads(line[5:].strip())
                                except Exception:
                                    continue
                                if isinstance(parsed, dict):
                                    return parsed
                        return {}
                    try:
                        body = resp.json()
                    except Exception:
                        return {}
                    return body if isinstance(body, dict) else {}

                probe_url = mcp_url.rstrip("/")
                init_payload = {
                    "jsonrpc": "2.0",
                    "method": "initialize",
                    "id": 1,
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "workeros", "version": "1.0"},
                    },
                }
                tools_payload = {"jsonrpc": "2.0", "method": "tools/list", "id": 2, "params": {}}

                init_resp = _httpx.post(probe_url, json=init_payload, headers=headers, timeout=8.0)
                if init_resp.status_code not in (200, 201):
                    if init_resp.status_code in (401, 403):
                        reason = (
                            f"MCP server reachable but authentication failed (HTTP {init_resp.status_code}). "
                            "Check your API key / token."
                        )
                    elif init_resp.status_code == 404:
                        reason = "MCP server returned 404. Verify the server URL is correct."
                    else:
                        reason = f"MCP server returned HTTP {init_resp.status_code}."
                    _write_connection_check(
                        connection_id,
                        "failed",
                        f"HTTP {init_resp.status_code}",
                        tested_at,
                        status="failed",
                        repos=repos,
                    )
                    return ConnectionTestResult(status="failed", reason=reason, tested_at=tested_at)

                # Streamable-HTTP sessions: echo the server-assigned session id
                # on follow-up requests, or compliant servers reject tools/list.
                init_session_id = init_resp.headers.get("mcp-session-id")
                if init_session_id:
                    headers["mcp-session-id"] = init_session_id

                tools_resp = _httpx.post(probe_url, json=tools_payload, headers=headers, timeout=8.0)
                tools = None
                if tools_resp.status_code in (200, 201):
                    body = _parse_mcp_response(tools_resp)
                    tools = body.get("tools")
                    if tools is None and isinstance(body.get("result"), dict):
                        tools = body["result"].get("tools")
                    if tools is None and isinstance(body.get("result"), dict):
                        tools = body["result"].get("capabilities", {}).get("tools")
                elif tools_resp.status_code in (401, 403):
                    reason = (
                        f"MCP server reachable but authentication failed (HTTP {tools_resp.status_code}). "
                        "Check your API key / token."
                    )
                    _write_connection_check(
                        connection_id,
                        "failed",
                        f"HTTP {tools_resp.status_code}",
                        tested_at,
                        status="failed",
                        repos=repos,
                    )
                    return ConnectionTestResult(status="failed", reason=reason, tested_at=tested_at)
                elif tools_resp.status_code == 404 and mcp_transport in {"streamable_http", "sse"}:
                    legacy_resp = _httpx.get(f"{probe_url}/tools/list", headers=headers, timeout=8.0)
                    if legacy_resp.status_code in (200, 201):
                        body = legacy_resp.json()
                        tools = body.get("tools") if isinstance(body, dict) else None
                    else:
                        if legacy_resp.status_code in (401, 403):
                            reason = (
                                f"MCP server reachable but authentication failed (HTTP {legacy_resp.status_code}). "
                                "Check your API key / token."
                            )
                        elif legacy_resp.status_code == 404:
                            reason = "MCP server returned 404. Verify the server URL is correct."
                        else:
                            reason = f"MCP server returned HTTP {legacy_resp.status_code}."
                        _write_connection_check(
                            connection_id,
                            "failed",
                            f"HTTP {legacy_resp.status_code}",
                            tested_at,
                            status="failed",
                            repos=repos,
                        )
                        return ConnectionTestResult(status="failed", reason=reason, tested_at=tested_at)
                else:
                    reason = f"MCP server returned HTTP {tools_resp.status_code}."
                    _write_connection_check(
                        connection_id,
                        "failed",
                        f"HTTP {tools_resp.status_code}",
                        tested_at,
                        status="failed",
                        repos=repos,
                    )
                    return ConnectionTestResult(status="failed", reason=reason, tested_at=tested_at)

                tool_names = sorted({
                    str(tool.get("name"))
                    for tool in (tools or [])
                    if isinstance(tool, dict) and isinstance(tool.get("name"), str) and tool.get("name")
                })
                tool_count = len(tool_names)
                missing_allowed = sorted(name for name in allowed_tools if name not in tool_names)
                if missing_allowed:
                    reason = (
                        f"MCP server reachable — {tool_count} tools. "
                        f"Allowed-tool mismatch: missing {', '.join(missing_allowed)}."
                    )
                    _write_connection_check(
                        connection_id,
                        "failed",
                        f"tool mismatch: {', '.join(missing_allowed)}",
                        tested_at,
                        status="failed",
                        repos=repos,
                    )
                    return ConnectionTestResult(status="failed", reason=reason, tested_at=tested_at)

                _write_connection_check(connection_id, "valid", None, tested_at, status="active", repos=repos)
                extra_tools = f" — {tool_count} tools" if tool_count is not None else ""
                allowed_tools_note = f" (allowlist: {len(allowed_tools)} tools)" if allowed_tools else ""
                return ConnectionTestResult(
                    status="valid",
                    reason=f"MCP server reachable{extra_tools}{allowed_tools_note}.",
                    tested_at=tested_at,
                    tools=tool_names,  # #789: live tool list
                )
            except Exception as exc:
                _write_connection_check(connection_id, "failed", str(exc), tested_at, status="failed", repos=repos)
                return ConnectionTestResult(
                    status="failed",
                    reason=f"Could not reach MCP server: {exc}",
                    tested_at=tested_at,
                )
        # No URL stored — connection is saved but untestable without a URL
        _write_connection_check(connection_id, "valid", None, tested_at, status="active", repos=repos)
        return ConnectionTestResult(
            status="valid",
            reason="MCP connection saved. Add a server URL to enable live testing.",
            tested_at=tested_at,
        )

    try:
        from composio_client import check_status
        remote_status = _normalize_composio_connection_status(check_status(composio_conn_id))
    except Exception as exc:
        _write_connection_check(connection_id, "failed", str(exc), tested_at, status="failed", repos=repos)
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
            status="failed",
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
            status=remote_status,
            repos=repos,
        )
        return ConnectionTestResult(
            status=remote_status,
            reason=f"Connection status is {remote_status}",
            tested_at=tested_at,
        )
    if remote_status == "active":
        _write_connection_check(connection_id, "valid", None, tested_at, status="active", repos=repos)
        _cache_connection_account_info(
            repos=repos,
            user_id=auth.user_id,
            connection_id=connection_id,
            composio_connection_id=composio_conn_id,
            now=tested_at,
        )
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
        status="active",
        repos=repos,
    )
    _cache_connection_account_info(
        repos=repos,
        user_id=auth.user_id,
        connection_id=connection_id,
        composio_connection_id=composio_conn_id,
        now=tested_at,
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
    *,
    status: Optional[str] = None,
    repos: Repositories | None = None,
) -> None:
    """Persist health-check result to the DB row."""
    repos_obj = repos or get_repositories()
    row = _connection_by_id(connection_id, repos_obj)
    if row is None:
        return
    updates: Dict[str, Any] = {
        "last_checked_at": checked_at,
        "last_check_status": check_status,
        "last_check_error": error,
        "updated_at": checked_at,
    }
    if status:
        updates["status"] = status
    repos_obj.connections.update(user_id=row["user_id"], composio_id=connection_id, **updates)


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
@app.get("/connections/{connection_id}/tools")
def get_connection_tools(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """#789: live tool list advertised by an MCP connection's server.

    Dials the server (reusing the test path) and returns the live tools/list,
    distinct from the operator-configured mcp_allowed_tools allowlist. Returns
    503 when the server is unreachable so the UI degrades gracefully.
    """
    result = test_connection(connection_id, auth=auth, repos=repos)
    if result.status != "valid" or result.tools is None:
        raise HTTPException(status_code=503, detail=result.reason or "MCP server unreachable")
    return {"tools": result.tools}


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
def list_integration_triggers(
    app: Optional[str] = Query(None, description="Filter by app slug (e.g. 'gmail')"),
    auth: AuthContext = Depends(get_auth_context),
):
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
        _raise_composio_unavailable(exc)

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

    # Resolve the specific worker_triggers row (by external/composio trigger id)
    # so the run is tagged with WHICH trigger fired and dedupe is scoped to that
    # trigger. Fall back to the worker-scalar lookup for legacy DBs.
    repos = get_repositories()
    trigger_ref: Optional[str] = None
    worker_id: Optional[str] = None
    for candidate in _candidate_composio_trigger_ids(payload, request):
        try:
            row = repos.workers.find_trigger_by_external_id(external_trigger_id=candidate)
        except Exception:
            row = None
        if row:
            trigger_ref = row["id"]
            worker_id = row["worker_id"]
            break
    if not worker_id:
        worker_id = _find_worker_for_composio_event(payload, request)
    if not worker_id:
        raise HTTPException(status_code=404, detail="No worker registered for Composio trigger")

    delivery_id = (
        request.headers.get("webhook-id")
        or (payload.get("id") if isinstance(payload, dict) else "")
        or ""
    )
    # Dedupe by (trigger, delivery_id): a redelivery of the same event to the
    # same trigger fires at most one run.
    dedupe_key = f"composio:{trigger_ref or worker_id}"
    if not _claim_webhook_delivery(dedupe_key, str(delivery_id)):
        return ActionResponse(status="duplicate_ignored")

    inputs = {"event": payload}
    run_id = create_run(worker_id, inputs, trigger_source="composio", trigger_ref=trigger_ref)
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
# URL base helpers (used by Slack, MCP, approvals, and other routes)
# ---------------------------------------------------------------------------

def _public_api_base_url() -> str:
    raw = (
        os.environ.get("WORKEROS_PUBLIC_API_URL")
        or os.environ.get("WORKEROS_API_URL")
        or os.environ.get("WORKERS_API_URL")
        or "https://workers-api.floom.dev"
    )
    return raw.rstrip("/")


def _frontend_base_url() -> str:
    return (os.environ.get("WORKERS_FRONTEND_URL") or "https://workers.floom.dev").rstrip("/")


# ---------------------------------------------------------------------------
# Slack Events API — extracted to channels/slack.py
# ---------------------------------------------------------------------------
#
# All Slack routes, helpers, and models have been moved to
# apps/api/channels/slack.py (refactor: phase 0.5, WORKPLAN-20260610).
# The APIRouter is included below and exposes the same URL paths.
# Re-exports are provided here for backwards compatibility with any code or
# tests that reference these symbols from ``main``.

from channels.slack import (
    slack_router,
    DEFAULT_SLACK_INSTALL_SCOPES,
    SLACK_SETUP_ENV_ALLOWLIST,
    SlackSetupConfigRequest,
    SlackSetupStatus,
    SlackInstallUrlResponse,
    SlackSetupConfigResponse,
    _slack_oauth_callback_url,
    _slack_events_url,
    _slack_commands_url,
    _slack_interactivity_url,
    _slack_install_scopes,
    _slack_state_secret,
    _issue_slack_oauth_state,
    _consume_slack_oauth_state,
    _slack_install_url,
    _safe_slack_team_env_suffix,
    _slack_team_bot_token_env_key,
    _append_slack_allowed_team_id,
    _list_slack_installations,
    _get_slack_installation,
    _upsert_slack_installation,
    _slack_bot_token_for_team,
    _slack_setup_status_for_user,
    _extract_slack_oauth_scopes,
    _exchange_slack_oauth_code,
    _slack_auth_test,
    _slack_events_enabled,
    _slack_signature_tolerance_seconds,
    _verify_slack_signature,
    _slack_allowed_team_ids,
    _clean_slack_agent_prompt,
    _slack_reaction,
    _post_slack_thread_reply,
    _set_slack_assistant_status,
    _post_slack_response_url,
    _slack_workspace_user_id,
    _parse_slack_form_body,
    _approval_action_value,
    _approval_action_run_id,
    _approve_pending_run_for_slack,
    _reject_pending_run_for_slack,
    _slack_pending_approvals_response,
    _handle_slack_app_mention,
    _handle_slack_assistant_thread_started,
    _handle_slack_direct_message,
    _handle_slack_command_message,
    _slack_command_response_from_form,
    _slack_interactivity_response_from_form,
)
app.include_router(slack_router)

# ---------------------------------------------------------------------------
# WhatsApp integration — extracted to channels/whatsapp.py
# ---------------------------------------------------------------------------
#
# All WhatsApp routes, helpers, and models have been moved to
# apps/api/channels/whatsapp.py (refactor: phase 0.5, WORKPLAN-20260610).
# The APIRouter is included below and exposes the same URL paths.
# Re-exports are provided here for backwards compatibility with any code or
# tests that reference these symbols from ``main``.

from channels.whatsapp import (
    whatsapp_router,
    WHATSAPP_TEXT_MAX,
    WhatsAppClaimRequest,
    _whatsapp_graph_version,
    _whatsapp_phone_id,
    _whatsapp_token,
    _whatsapp_app_secret,
    _whatsapp_webhook_verify_token,
    _whatsapp_enabled,
    _whatsapp_configured,
    _normalize_whatsapp_wa_id,
    _whatsapp_claim_url,
    _whatsapp_binding_user_id,
    _whatsapp_create_claim,
    _verify_whatsapp_signature,
    _split_whatsapp_text,
    _send_whatsapp_json,
    send_whatsapp_text,
    _send_whatsapp_typing_indicator,
    _parse_whatsapp_inbound,
    _handle_whatsapp_message,
    WhatsAppBindingStore,
    set_whatsapp_binding_store,
)
app.include_router(whatsapp_router)

# ---------------------------------------------------------------------------
# Claim short-link redirect — GET /c/{token}
# ---------------------------------------------------------------------------
from channels.shortlink import shortlink_router
app.include_router(shortlink_router)

# Backward-compat alias: tests and langdock reference this name on ``main``
async def _collect_workspace_agent_reply_for_slack(
    *,
    message: str,
    user_id: str,
    conversation_id,
    source: str = "slack",
    system_suffix: str = "",
) -> str:
    from channels.common import collect_agent_reply
    return await collect_agent_reply(
        message=message,
        user_id=user_id,
        conversation_id=conversation_id,
        source=source,
        system_suffix=system_suffix,
    )


# ---------------------------------------------------------------------------
# Workspace Agent MCP API
# ---------------------------------------------------------------------------

_WORKSPACE_AGENT_MCP_TOOL_NAME = "ask_workspace_agent"
_WORKSPACE_AGENT_MCP_LEGACY_TOOL_NAME = "ask_workeros_workspace_agent"
_WORKSPACE_AGENT_MCP_PROTOCOL_VERSION = "2024-11-05"
_WORKEROS_REMOTE_MCP_NAME = "workeros"
_WORKEROS_REMOTE_MCP_VERSION = "0.2.0"
_MCP_TERMINAL_RUN_STATUSES = {"completed", "failed", "pending_approval", "approved", "rejected", "success", "error"}


def _workspace_agent_mcp_enabled() -> bool:
    value = os.environ.get("WORKSPACE_AGENT_MCP_ENABLED", "1").strip().lower()
    return value not in {"0", "false", "no", "off"}


def _workspace_agent_mcp_tokens() -> List[str]:
    tokens: List[str] = []
    for name in (
        "WORKSPACE_AGENT_MCP_TOKEN",
        "LANGDOCK_WORKEROS_MCP_TOKEN",
        "WORKEROS_API_SECRET",
        "WORKEROS_API_TOKEN",
        "FLOOM_SECRET",
    ):
        value = (os.environ.get(name) or "").strip()
        if value and value not in tokens:
            tokens.append(value)
    return tokens


def _verify_workspace_agent_mcp_auth(request: Request) -> bool:
    expected_tokens = _workspace_agent_mcp_tokens()
    if not expected_tokens:
        return False
    authorization = request.headers.get("authorization", "").strip()
    bearer = ""
    if authorization.lower().startswith("bearer "):
        bearer = authorization[7:].strip()
    api_key = request.headers.get("x-api-key", "").strip()
    floom_secret = request.headers.get("x-floom-secret", "").strip()
    floom_token = request.headers.get("x-floom-token", "").strip()
    candidates = [value for value in (bearer, api_key, floom_secret, floom_token) if value]
    return bool(
        any(hmac.compare_digest(candidate, expected) for candidate in candidates for expected in expected_tokens)
    )


def _workspace_agent_mcp_user_id() -> str:
    return (
        os.environ.get("WORKSPACE_AGENT_MCP_USER_ID")
        or os.environ.get("LANGDOCK_WORKEROS_USER_ID")
        or _bootstrap_user_id()
    ).strip() or _bootstrap_user_id()


def _workspace_agent_mcp_auth_context() -> AuthContext:
    existing = current_auth_context()
    if existing is not None:
        return existing
    user_id = _workspace_agent_mcp_user_id()
    if (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower() == "local":
        user_id = local_workspace_user_id(local_workspace_base_user_id(user_id), DEFAULT_WORKSPACE_ID)
    ctx = AuthContext(user_id=user_id, email=None, scopes=("admin", "mcp"))
    set_current_auth_context(ctx)
    return ctx


async def _workspace_agent_mcp_cloud_auth_context(request: Request) -> Optional[AuthContext]:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy != "cloud":
        return None
    authorization = request.headers.get("authorization", "").strip()
    bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    token = (
        request.headers.get("x-floom-token", "").strip()
        or request.headers.get("x-api-key", "").strip()
        or bearer
    )
    if not token:
        return None
    scope = dict(request.scope)
    headers = [
        (key, value)
        for key, value in scope.get("headers", [])
        if key.lower() != b"x-floom-token"
    ]
    headers.append((b"x-floom-token", token.encode("utf-8")))
    scope["headers"] = headers
    ctx = await get_auth_provider().verify(Request(scope, request.receive))
    set_current_auth_context(ctx)
    return ctx


def _workspace_agent_mcp_conversation_id(raw: Any) -> str:
    value = str(raw or "default").strip() or "default"
    safe = re.sub(r"[^a-zA-Z0-9_.:-]+", "_", value)[:160].strip("._:-")
    return f"langdock:{safe or 'default'}"


def _workspace_agent_mcp_discovery() -> Dict[str, Any]:
    return {
        "name": _WORKEROS_REMOTE_MCP_NAME,
        "version": _WORKEROS_REMOTE_MCP_VERSION,
        "protocol": _WORKSPACE_AGENT_MCP_PROTOCOL_VERSION,
        "transport": "streamable-http",
        "endpoint": "POST /api/mcp",
        "tools": [tool["name"] for tool in _workeros_remote_mcp_tool_definitions()],
    }


def _workspace_agent_mcp_setup_card() -> Dict[str, Any]:
    tools = [tool["name"] for tool in _workeros_remote_mcp_tool_definitions()]
    recommended_prompt = (
        "You are the Workeros Agent. Use Workeros MCP actions to inspect workers, "
        "runs, brain packs, connections, and secrets. Use ask_workspace_agent for "
        "broad delegation and direct tools for precise operations. Confirm before "
        "destructive actions such as deleting workers or secrets."
    )
    return {
        "name": "Workeros",
        "description": "Remote MCP setup for Langdock, Claude Code, Cursor, and other agent clients.",
        "server_url": "https://workeros-api.floom.dev/api/mcp",
        "transport": "STREAMABLE_HTTP",
        "authentication": {
            "method": "API Key",
            "header_options": [
                "Authorization: Bearer <WORKEROS_API_TOKEN>",
                "x-api-key: <WORKEROS_API_TOKEN>",
            ],
            "accepts_existing_workeros_token": True,
            "token_configured": bool(_workspace_agent_mcp_tokens()),
        },
        "recommended_langdock_agent": {
            "name": "Workeros Agent",
            "instructions": recommended_prompt,
        },
        "tools": tools,
        "checklist": [
            "Create or copy a Workeros API token.",
            "In Langdock Integrations, add an MCP integration.",
            "Use the Workeros server URL and API key authentication.",
            "Test the connection and save the discovered tools.",
            "Create a Langdock custom agent named Workeros Agent.",
            "Attach the Workeros MCP actions to that agent.",
            "Smoke test: list workers and summarize the latest failed runs.",
        ],
    }


async def _collect_workspace_agent_reply_for_langdock(
    *,
    message: str,
    user_id: str,
    conversation_id: Optional[str],
) -> str:
    return await _collect_workspace_agent_reply_for_slack(
        message=message,
        user_id=user_id,
        conversation_id=conversation_id,
        source="mcp",
    )


def _mcp_result(request_id: Any, result: Dict[str, Any]) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": jsonable_encoder(result)}


def _mcp_error(request_id: Any, code: int, message: str) -> Dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def _mcp_tool_error(message: str) -> Dict[str, Any]:
    return {
        "content": [{"type": "text", "text": message}],
        "isError": True,
    }


def _mcp_redact(value: Any) -> Any:
    if isinstance(value, list):
        return [_mcp_redact(item) for item in value]
    if isinstance(value, dict):
        redacted: Dict[str, Any] = {}
        for key, nested in value.items():
            if re.search(r"(secret|token|password|api[_-]?key)", str(key), re.IGNORECASE):
                redacted[str(key)] = "[redacted]"
            else:
                redacted[str(key)] = _mcp_redact(nested)
        return redacted
    return value


def _mcp_text(data: Any, summary: Optional[str] = None) -> str:
    safe = _mcp_redact(jsonable_encoder(data))
    rendered = json.dumps(safe, ensure_ascii=False, indent=2)
    return f"{summary}\n{rendered}" if summary else rendered


def _mcp_call_result(data: Any, summary: Optional[str] = None) -> Dict[str, Any]:
    structured = jsonable_encoder(data)
    if not isinstance(structured, dict):
        structured = {"data": structured}
    return {
        "content": [{"type": "text", "text": _mcp_text(data, summary)}],
        "structuredContent": structured,
        "isError": False,
    }


def _mcp_http_error_result(exc: HTTPException) -> Dict[str, Any]:
    detail = exc.detail if isinstance(exc.detail, str) else json.dumps(jsonable_encoder(exc.detail), ensure_ascii=False)
    return {
        "content": [{"type": "text", "text": detail}],
        "structuredContent": {"status": exc.status_code, "detail": jsonable_encoder(exc.detail)},
        "isError": True,
    }


def _mcp_json_schema(properties: Dict[str, Any], required: Optional[List[str]] = None) -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": False,
    }


def _workeros_remote_mcp_tool_definitions() -> List[Dict[str, Any]]:
    worker_contract_yaml_description = (
        'WorkerContract YAML content. Required top-level fields: schema_version: "0.3", '
        "name, title, description, version, exec, and trigger. For script workers, "
        'exec must include entry: "run.py", runtime: "python311", runner: "e2b", '
        'command: "python run.py", plus exec.inputs and exec.outputs arrays. '
        "Script workers read inputs.json and write result.json at the worker root."
    )
    workspace_schema = _mcp_json_schema(
        {
            "message": {
                "type": "string",
                "description": "The instruction or question for the Workeros workspace agent.",
            },
            "conversation_id": {
                "type": "string",
                "description": "Optional stable client thread or chat id for continuity.",
            },
        },
        ["message"],
    )
    return [
        {
            "name": _WORKSPACE_AGENT_MCP_TOOL_NAME,
            "description": (
                "Ask the Workeros workspace agent to inspect or operate the workspace: "
                "workers, runs, approvals, brain packs, connections, and secret names."
            ),
            "inputSchema": workspace_schema,
        },
        {
            "name": "workers.list",
            "description": "List Workeros workers.",
            "inputSchema": _mcp_json_schema({
                "include_system": {"type": "boolean", "default": False},
                "include_archived": {"type": "boolean", "default": False},
            }),
        },
        {
            "name": "workers.get",
            "description": "Get a Workeros worker by id.",
            "inputSchema": _mcp_json_schema({"id": {"type": "string"}}, ["id"]),
        },
        {
            "name": "workers.create",
            "description": "Create a Workeros worker from WorkerContract YAML and Python source.",
            "inputSchema": _mcp_json_schema(
                {
                    "worker_yml": {"type": "string", "description": worker_contract_yaml_description},
                    "run_py": {"type": "string", "description": "Python source for run.py."},
                    "skill_md": {"type": "string", "description": "Optional SKILL.md content."},
                },
                ["worker_yml", "run_py"],
            ),
        },
        {
            "name": "workers.update",
            "description": "Update worker settings such as trigger, cron, defaults, and capabilities.",
            "inputSchema": _mcp_json_schema({
                "id": {"type": "string"},
                "trigger_type": {"type": "string"},
                "cron_expr": {"type": "string"},
                "cron_timezone": {"type": "string"},
                "input_values": {"type": "object"},
                "capabilities": {"type": "object"},
                "webhook_secret_rotate": {"type": "boolean"},
            }, ["id"]),
        },
        {
            "name": "workers.run",
            "description": "Start a manual Workeros worker run.",
            "inputSchema": _mcp_json_schema({
                "id": {"type": "string"},
                "inputs": {"type": "object", "default": {}},
                "trigger_source": {"type": "string", "default": "manual"},
            }, ["id"]),
        },
        {
            "name": "runs.list",
            "description": "List Workeros runs, optionally filtered by worker id or status.",
            "inputSchema": _mcp_json_schema({
                "worker_id": {"type": "string"},
                "status": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
                "offset": {"type": "integer", "minimum": 0, "default": 0},
                "include_system": {"type": "boolean", "default": False},
            }),
        },
        {
            "name": "runs.get",
            "description": "Get a Workeros run by id, including logs, outputs, artifacts, and approval status.",
            "inputSchema": _mcp_json_schema({"id": {"type": "string"}}, ["id"]),
        },
        {
            "name": "runs.watch",
            "description": "Poll a Workeros run until terminal status or timeout.",
            "inputSchema": _mcp_json_schema({
                "id": {"type": "string"},
                "timeout_ms": {"type": "integer", "minimum": 1000, "maximum": 30000, "default": 30000},
            }, ["id"]),
        },
        {
            "name": "secrets.list",
            "description": "List configured secret names and status. Values are never returned.",
            "inputSchema": _mcp_json_schema({}),
        },
        {
            "name": "secrets.set",
            "description": "Create or update a secret value.",
            "inputSchema": _mcp_json_schema({
                "key": {"type": "string"},
                "value": {"type": "string"},
            }, ["key", "value"]),
        },
        {
            "name": "connections.list",
            "description": "List configured app and MCP connections.",
            "inputSchema": _mcp_json_schema({}),
        },
        {
            "name": "connections.add_mcp",
            "description": "Save an MCP server connection for workers to use at run time.",
            "inputSchema": _mcp_json_schema({
                "label": {"type": "string"},
                "transport": {"type": "string", "enum": ["streamable_http", "sse", "stdio"], "default": "streamable_http"},
                "url": {"type": "string"},
                "command": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}, "default": []},
                "env": {"type": "object", "additionalProperties": {"type": "string"}, "default": {}},
                "cwd": {"type": "string"},
                "auth_secret": {"type": "string"},
                "allowed_tools": {"type": "array", "items": {"type": "string"}, "default": []},
            }, ["label"]),
        },
        {
            "name": "contexts.list",
            "description": "List Workeros brain packs.",
            "inputSchema": _mcp_json_schema({}),
        },
        {
            "name": "contexts.read",
            "description": "Read a UTF-8 brain-pack file, or return metadata for binary files.",
            "inputSchema": _mcp_json_schema({
                "name": {"type": "string"},
                "path": {"type": "string"},
            }, ["name", "path"]),
        },
        {
            "name": "contexts.write",
            "description": "Create or update a UTF-8 text file inside a brain pack.",
            "inputSchema": _mcp_json_schema({
                "name": {"type": "string"},
                "path": {"type": "string"},
                "content": {"type": "string"},
            }, ["name", "path", "content"]),
        },
        {
            "name": "record_candidate_feedback",
            "description": "Record one immutable candidate feedback JSON event into a writable brain pack.",
            "inputSchema": _mcp_json_schema({
                "name": {"type": "string"},
                "run_id": {"type": "string"},
                "candidate_id": {"type": "string"},
                "rank": {"type": "integer"},
                "feedback_text": {"type": "string"},
                "outcome": {"type": "string", "enum": ["good", "bad", "miss"]},
                "scope": {"type": "string", "enum": ["global", "client"], "default": "global"},
                "reporter": {"type": "string"},
            }, ["name", "run_id", "candidate_id", "rank", "feedback_text", "outcome"]),
        },
    ]


def _mcp_arg(arguments: Dict[str, Any], name: str) -> str:
    value = str(arguments.get(name) or "").strip()
    if not value:
        raise ValueError(f"Tool argument '{name}' is required")
    return value


async def _mcp_call_workspace_agent(arguments: Dict[str, Any]) -> Dict[str, Any]:
    message = str(arguments.get("message") or "").strip()
    if not message:
        return _mcp_tool_error("Tool argument 'message' is required")
    if len(message) > 20000:
        return _mcp_tool_error("Tool argument 'message' is too long")

    conversation_id = _workspace_agent_mcp_conversation_id(arguments.get("conversation_id"))
    reply = await _collect_workspace_agent_reply_for_langdock(
        message=message,
        user_id=current_auth_user_id() or _workspace_agent_mcp_auth_context().user_id,
        conversation_id=conversation_id,
    )
    return {
        "content": [{"type": "text", "text": reply or "(No reply)"}],
        "structuredContent": {"conversation_id": conversation_id},
        "isError": False,
    }


def _mcp_call_workers_list(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    data = list_workers(
        include_system=bool(arguments.get("include_system", False)),
        include_archived=bool(arguments.get("include_archived", False)),
        shape="full",
        auth=auth,
        repos=repos,
    )
    return _mcp_call_result(data)


def _mcp_call_workers_get(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    data = get_worker_detail(_mcp_arg(arguments, "id"), auth=auth, repos=repos)
    return _mcp_call_result(data)


def _mcp_call_workers_create(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    payload = WorkerCreateRequest(
        worker_yml=_mcp_arg(arguments, "worker_yml"),
        run_py=_mcp_arg(arguments, "run_py"),
        skill_md=arguments.get("skill_md"),
    )
    data = create_worker(payload, auth=auth, repos=repos)
    return _mcp_call_result(data, "Worker created.")


def _mcp_call_workers_update(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    worker_id = _mcp_arg(arguments, "id")
    update_args = {k: v for k, v in arguments.items() if k != "id"}
    payload = WorkerUpdateRequest(**update_args)
    data = update_worker(worker_id, payload, auth=auth, repos=repos)
    return _mcp_call_result(data, "Worker updated.")


def _mcp_call_workers_run(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    payload = RunCreate(
        inputs=arguments.get("inputs") if isinstance(arguments.get("inputs"), dict) else {},
        trigger_source=str(arguments.get("trigger_source") or "manual"),
    )
    data = create_worker_run(_mcp_arg(arguments, "id"), payload, request=None, auth=auth, repos=repos)
    return _mcp_call_result(data, "Worker run started.")


def _mcp_call_runs_list(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    data = list_runs(
        Response(),
        worker_id=arguments.get("worker_id") or None,
        status=arguments.get("status") or None,
        limit=min(max(int(arguments.get("limit") or 50), 1), 200),
        offset=max(int(arguments.get("offset") or 0), 0),
        include_system=bool(arguments.get("include_system", False)),
        auth=auth,
        repos=repos,
    )
    return _mcp_call_result(data)


def _mcp_call_runs_get(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    data = get_run(_mcp_arg(arguments, "id"), auth=auth, repos=repos)
    return _mcp_call_result(data)


# #834 RCA: runs.watch accepted timeout_ms up to 600000 (10 minutes) and held
# the HTTP connection open the whole time, polling internally — ~60 concurrent
# tools/call requests (the old default rate limit) could pin workers and
# generate hundreds of internal requests each. Cap all MCP watch/poll waits at
# 30s; clients needing longer poll runs.get between calls.
_MCP_WATCH_MAX_TIMEOUT_MS = 30000


def _mcp_watch_timeout_seconds(raw: Any) -> float:
    """Clamp a client-supplied timeout_ms to [1s, 30s] (#834)."""
    try:
        requested = int(raw) if raw is not None else _MCP_WATCH_MAX_TIMEOUT_MS
    except (TypeError, ValueError, OverflowError):
        # OverflowError: JSON `1e999` parses to float('inf'); int(inf) raises.
        requested = _MCP_WATCH_MAX_TIMEOUT_MS
    return min(max(requested, 1000), _MCP_WATCH_MAX_TIMEOUT_MS) / 1000.0


async def _mcp_call_runs_watch(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    run_id = _mcp_arg(arguments, "id")
    deadline = time.monotonic() + _mcp_watch_timeout_seconds(arguments.get("timeout_ms"))
    last: Dict[str, Any] = {}
    while True:
        row = repos.runs.get(user_id=auth.user_id, run_id=run_id)
        if not row:
            raise HTTPException(status_code=404, detail="Run not found")
        last = row_to_dict(row)
        status = str(last.get("status") or "")
        if status in _MCP_TERMINAL_RUN_STATUSES or time.monotonic() >= deadline:
            break
        await asyncio.sleep(1.0)
    logs = [
        {"level": r["level"], "message": _redact_public_log_message(r["message"]), "timestamp": r["timestamp"]}
        for r in repos.runs.list_logs(user_id=auth.user_id, run_id=run_id)[-50:]
    ]
    return _mcp_call_result({"run_id": run_id, "status": last.get("status"), "run": last, "logs": logs}, "Run watch completed.")


def _mcp_call_secrets_list(auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    data = list_secrets(auth=auth, repos=repos)
    return _mcp_call_result(data)


def _mcp_call_secrets_set(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    key = _mcp_arg(arguments, "key").upper()
    payload = SecretUpsertRequest(value=_mcp_arg(arguments, "value"))
    data = upsert_secret(key, payload, auth=auth, repos=repos)
    return _mcp_call_result(data, "Secret saved.")


def _mcp_call_connections_list(auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    data = list_connections(auth=auth, repos=repos)
    return _mcp_call_result(data)


def _mcp_call_connections_add_mcp(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    payload = MCPConnectionCreateRequest(
        label=_mcp_arg(arguments, "label"),
        transport=arguments.get("transport") or "streamable_http",
        url=arguments.get("url"),
        command=arguments.get("command"),
        args=arguments.get("args") if isinstance(arguments.get("args"), list) else [],
        env=arguments.get("env") if isinstance(arguments.get("env"), dict) else {},
        cwd=arguments.get("cwd"),
        auth_secret=arguments.get("auth_secret"),
        allowed_tools=arguments.get("allowed_tools") if isinstance(arguments.get("allowed_tools"), list) else [],
    )
    data = create_mcp_connection(payload, auth=auth, repos=repos)
    return _mcp_call_result(data, "MCP connection saved.")


def _mcp_call_contexts_list(auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    data = list_contexts(auth=auth, repos=repos)
    return _mcp_call_result(data)


def _mcp_call_contexts_read(arguments: Dict[str, Any], auth: AuthContext) -> Dict[str, Any]:
    name = _mcp_arg(arguments, "name")
    rel = _mcp_arg(arguments, "path")
    safe_name, _metadata = _require_readable_context_for_user(name, user_id=auth.user_id)
    target = _safe_context_file_or_400(safe_name, _context_file_path_or_400(rel))
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Context file not found")
    mime_type = guess_mime_type(rel)
    if is_binary_file(rel, mime_type):
        return _mcp_call_result({
            "name": safe_name,
            "path": rel,
            "size": target.stat().st_size,
            "mime_type": mime_type,
            "is_binary": True,
            "note": "Binary brain-pack file. Use the Workeros HTTP API to download bytes.",
        })
    return _mcp_call_result({
        "name": safe_name,
        "path": rel,
        "size": target.stat().st_size,
        "mime_type": mime_type,
        "is_binary": False,
        "content": target.read_text(errors="replace"),
    })


def _mcp_call_contexts_write(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    name = _mcp_arg(arguments, "name")
    rel = _mcp_arg(arguments, "path")
    content = str(arguments.get("content") or "")
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    result = _write_context_file(
        safe_name,
        _context_file_path_or_400(rel),
        content.encode("utf-8"),
        user_id=auth.user_id,
    )
    _git_commit_context(safe_name, _context_file_path_or_400(rel), message=f"context {safe_name}: update {rel} (ai)")
    message = "Context file saved."
    if result.secret_warnings:
        patterns = ", ".join(sorted({w.pattern for w in result.secret_warnings}))
        message = (
            f"Context file saved. WARNING: this file looks like it contains a live "
            f"credential ({patterns}). Brain packs are readable by anyone with workspace "
            f"access — store secrets in Settings → Secrets, not in a Brain pack."
        )
    return _mcp_call_result(result, message)


def _mcp_call_record_candidate_feedback(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    try:
        payload = CandidateFeedbackCreateRequest(
            run_id=_mcp_arg(arguments, "run_id"),
            candidate_id=_mcp_arg(arguments, "candidate_id"),
            rank=int(_mcp_arg(arguments, "rank")),
            feedback_text=_mcp_arg(arguments, "feedback_text"),
            outcome=_mcp_arg(arguments, "outcome"),
            scope=str(arguments.get("scope") or "global"),
            reporter=arguments.get("reporter"),
        )
    except (TypeError, ValueError, ValidationError) as exc:
        raise ValueError(str(exc)) from exc
    data = _record_candidate_feedback_event(_mcp_arg(arguments, "name"), payload, auth=auth, repos=repos)
    return _mcp_call_result(data, "Candidate feedback recorded.")


async def _call_workeros_remote_mcp_tool(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    auth = _workspace_agent_mcp_auth_context()
    repos = get_repositories()
    # #833/#838/#840: this surface dispatches a subset of the same tools as
    # /mcp-tools/serve and must enforce the same per-tool gates and audit
    # trail — otherwise the serve-side gating is bypassable via /api/mcp
    # (e.g. connections.add_mcp callable here while disabled there).
    logger.info(
        "mcp tools/call (workspace-agent): tool=%r user=%s role=%s",
        tool_name, auth.user_id, auth.role,
    )
    denied = _mcp_access_error(tool_name, auth)
    if denied is not None:
        return _mcp_tool_error(denied)
    try:
        if tool_name in {_WORKSPACE_AGENT_MCP_TOOL_NAME, _WORKSPACE_AGENT_MCP_LEGACY_TOOL_NAME, "workspace.chat"}:
            return await _mcp_call_workspace_agent(arguments)
        if tool_name == "workers.list":
            return _mcp_call_workers_list(arguments, auth, repos)
        if tool_name == "workers.get":
            return _mcp_call_workers_get(arguments, auth, repos)
        if tool_name == "workers.create":
            return _mcp_call_workers_create(arguments, auth, repos)
        if tool_name == "workers.update":
            return _mcp_call_workers_update(arguments, auth, repos)
        if tool_name == "workers.run":
            return _mcp_call_workers_run(arguments, auth, repos)
        if tool_name == "runs.list":
            return _mcp_call_runs_list(arguments, auth, repos)
        if tool_name == "runs.get":
            return _mcp_call_runs_get(arguments, auth, repos)
        if tool_name == "runs.watch":
            return await _mcp_call_runs_watch(arguments, auth, repos)
        if tool_name == "secrets.list":
            return _mcp_call_secrets_list(auth, repos)
        if tool_name == "secrets.set":
            return _mcp_call_secrets_set(arguments, auth, repos)
        if tool_name == "connections.list":
            return _mcp_call_connections_list(auth, repos)
        if tool_name == "connections.add_mcp":
            return _mcp_call_connections_add_mcp(arguments, auth, repos)
        if tool_name == "contexts.list":
            return _mcp_call_contexts_list(auth, repos)
        if tool_name == "contexts.read":
            return _mcp_call_contexts_read(arguments, auth)
        if tool_name == "contexts.write":
            return _mcp_call_contexts_write(arguments, auth, repos)
        if tool_name == "record_candidate_feedback":
            return _mcp_call_record_candidate_feedback(arguments, auth, repos)
        return _mcp_tool_error(f"Unknown tool: {tool_name or 'unknown'}")
    except ValueError as exc:
        return _mcp_tool_error(str(exc))
    except HTTPException as exc:
        return _mcp_http_error_result(exc)


def _workspace_agent_mcp_tool_definition() -> Dict[str, Any]:
    return {
        "name": _WORKSPACE_AGENT_MCP_TOOL_NAME,
        "description": (
            "Ask the Workeros workspace agent to inspect or operate the workspace: "
            "workers, runs, approvals, brain packs, connections, and secret names."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "The instruction or question for the Workeros workspace agent.",
                },
                "conversation_id": {
                    "type": "string",
                    "description": "Optional stable Langdock thread or chat id for continuity.",
                },
            },
            "required": ["message"],
            "additionalProperties": False,
        },
    }


async def _handle_workspace_agent_mcp_message(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    request_id = payload.get("id")
    method = str(payload.get("method") or "")
    if "id" not in payload and method.startswith("notifications/"):
        return None
    if method == "initialize":
        return _mcp_result(
            request_id,
            {
                "protocolVersion": _WORKSPACE_AGENT_MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": _WORKEROS_REMOTE_MCP_NAME,
                    "version": _WORKEROS_REMOTE_MCP_VERSION,
                },
            },
        )
    if method == "tools/list":
        # #833/#838/#840: advertise only what tools/call would accept for this
        # auth context — same predicate as /mcp-tools/serve.
        auth = _workspace_agent_mcp_auth_context()
        tools = [
            t for t in _workeros_remote_mcp_tool_definitions()
            if _mcp_access_error(t["name"], auth) is None
        ]
        return _mcp_result(request_id, {"tools": tools})
    if method != "tools/call":
        return _mcp_error(request_id, -32601, f"Unsupported MCP method: {method or 'unknown'}")

    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    tool_name = str(params.get("name") or "")
    arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
    try:
        return _mcp_result(request_id, await _call_workeros_remote_mcp_tool(tool_name, arguments))
    except Exception as exc:
        return _mcp_error(request_id, -32603, f"Workeros MCP tool call failed: {exc}")


async def _workspace_agent_mcp_post(request: Request) -> Response:
    if not _workspace_agent_mcp_enabled():
        raise HTTPException(status_code=503, detail="Workeros Remote MCP is disabled")
    static_tokens = _workspace_agent_mcp_tokens()
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if not static_tokens and deploy != "cloud":
        raise HTTPException(status_code=503, detail="No Workeros MCP/API token is configured")
    if _verify_workspace_agent_mcp_auth(request):
        _workspace_agent_mcp_auth_context()
    else:
        cloud_ctx = await _workspace_agent_mcp_cloud_auth_context(request)
        if cloud_ctx is None:
            raise HTTPException(status_code=401, detail="Invalid Workeros MCP token")

    body = await request.body()
    try:
        payload = json.loads(body.decode("utf-8") or "{}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid MCP JSON payload") from exc

    if isinstance(payload, list):
        responses = []
        for item in payload:
            if not isinstance(item, dict):
                responses.append(_mcp_error(None, -32600, "Invalid JSON-RPC request"))
                continue
            try:
                response = await _handle_workspace_agent_mcp_message(item)
            except Exception as exc:
                response = _mcp_error(item.get("id"), -32603, f"Internal error: {exc}")
            if response is not None:
                responses.append(response)
        if not responses:
            return Response(status_code=204)
        return JSONResponse(responses)

    if not isinstance(payload, dict):
        return JSONResponse(_mcp_error(None, -32600, "Invalid JSON-RPC request"), status_code=400)
    try:
        response = await _handle_workspace_agent_mcp_message(payload)
    except Exception as exc:
        response = _mcp_error(payload.get("id"), -32603, f"Internal error: {exc}")
    if response is None:
        return Response(status_code=204)
    return JSONResponse(response)


@app.get("/api/mcp")
async def workspace_agent_mcp_discovery(auth: AuthContext = Depends(get_auth_context)) -> Response:
    del auth
    return JSONResponse(_workspace_agent_mcp_discovery())


@app.get("/mcp")
async def workspace_agent_mcp_mount_discovery(auth: AuthContext = Depends(get_auth_context)) -> Response:
    del auth
    return JSONResponse(_workspace_agent_mcp_discovery())


@app.get("/api/mcp/setup/langdock")
async def workspace_agent_mcp_langdock_setup(auth: AuthContext = Depends(get_auth_context)) -> Response:
    del auth
    return JSONResponse(_workspace_agent_mcp_setup_card())


@app.get("/mcp/setup/langdock")
async def workspace_agent_mcp_mount_langdock_setup(auth: AuthContext = Depends(get_auth_context)) -> Response:
    del auth
    return JSONResponse(_workspace_agent_mcp_setup_card())


@app.get("/langdock/mcp")
async def langdock_workspace_agent_mcp_discovery(auth: AuthContext = Depends(get_auth_context)) -> Response:
    del auth
    return JSONResponse(_workspace_agent_mcp_discovery())


@app.get("/workspace-agent/mcp")
async def workspace_agent_named_mcp_discovery(auth: AuthContext = Depends(get_auth_context)) -> Response:
    del auth
    return JSONResponse(_workspace_agent_mcp_discovery())


@app.get("/api/langdock/mcp")
async def api_langdock_workspace_agent_mcp_discovery(auth: AuthContext = Depends(get_auth_context)) -> Response:
    del auth
    return JSONResponse(_workspace_agent_mcp_discovery())


@app.get("/api/workspace-agent/mcp")
async def api_workspace_agent_named_mcp_discovery(auth: AuthContext = Depends(get_auth_context)) -> Response:
    del auth
    return JSONResponse(_workspace_agent_mcp_discovery())


@app.post("/api/mcp")
async def api_workspace_agent_mcp(request: Request) -> Response:
    return await _workspace_agent_mcp_post(request)


@app.post("/mcp")
async def workspace_agent_mcp_mount(request: Request) -> Response:
    return await _workspace_agent_mcp_post(request)


@app.post("/langdock/mcp")
async def langdock_workspace_agent_mcp(request: Request) -> Response:
    return await _workspace_agent_mcp_post(request)


@app.post("/workspace-agent/mcp")
async def workspace_agent_named_mcp(request: Request) -> Response:
    return await _workspace_agent_mcp_post(request)


@app.post("/api/langdock/mcp")
async def api_langdock_workspace_agent_mcp(request: Request) -> Response:
    return await _workspace_agent_mcp_post(request)


@app.post("/api/workspace-agent/mcp")
async def api_workspace_agent_named_mcp(request: Request) -> Response:
    return await _workspace_agent_mcp_post(request)


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


@app.get("/system/platform-config", response_model=PlatformConfig)
def platform_config(auth: AuthContext = Depends(get_auth_context)):
    """Return a redacted platform-config summary.

    PR S13: keep this minimal shape stable. The old settings page and the S12
    tabbed settings page both consume this response.
    """
    required_specs = [s for s in (PLATFORM_SECRET_SPECS + INFRA_PATH_SPECS) if s["required"]]

    def _spec_env_set(s: PlatformSecretSpec) -> bool:
        # A spec is satisfied if its env var is set, or its back-compat fallback
        # is (e.g. PLATFORM_OPENAI_API_KEY falls back to OPENAI_API_KEY).
        if (os.environ.get(s["name"]) or "").strip():
            return True
        fb = s.get("fallback")
        return bool(fb and (os.environ.get(fb) or "").strip())

    missing = [s["name"] for s in required_specs if not _spec_env_set(s)]
    required_count = len(required_specs)
    set_count = required_count - len(missing)
    return PlatformConfig(
        all_required_set=(len(missing) == 0),
        missing=missing,
        set_count=set_count,
        required_count=required_count,
    )


@app.get("/channels/email")
def channels_email_status(auth: AuthContext = Depends(get_auth_context)):
    """#799: email-channel connection status for Settings > Channels.

    OSS has no separate linked email identity; the channel is "connected"
    when the authenticated user has an email on file (the address run-failure
    notifications would go to). Returns { connected, email? }.
    """
    email = (auth.email or "").strip()
    return {"connected": bool(email), "email": email or None}


@app.get("/system/info")
def system_info(auth: AuthContext = Depends(get_auth_context)):
    # #837 RCA: python_version and started_at (process uptime) were returned to
    # every authenticated caller — recon data that maps the runtime for
    # interpreter-specific exploits and restart tracking. Admins keep the full
    # payload; everyone else gets version + runner only.
    info: Dict[str, Any] = {
        "version": app.version,
        "runner": "e2b",
    }
    if auth.is_admin:
        info["started_at"] = _PROCESS_STARTED_AT
        info["python_version"] = sys.version.split()[0]
    return info


@app.get("/system/workspace-agent")
def system_workspace_agent(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Read-only view of the workspace agent that powers /chat.

    GAP #5: operators had no way to see the assistant's system instructions or
    which management tools it can call. Returns the resolved system prompt
    (workspace.md + engine SKILL.md + live workspace snapshot) and the tool
    names + one-line descriptions. Never returns secret values.
    """
    from chat_service import workspace_agent_info

    info = workspace_agent_info(auth.user_id)
    owner_id, visibility, permissions = _assistant_access(
        user_id=auth.user_id, repos=repos
    )
    return {
        "agent_id": info["agent_id"],
        "model": info["model"],
        "base_persona": info.get("base_persona"),
        "worker_authoring_rules": info.get("worker_authoring_rules"),
        "system_prompt": info["system_prompt"],
        "tools": info["tools"],
        "settings": info.get("settings") or {},
        "channels": info["channels"],
        # Members STEP 5: ownership + per-asset visibility + computed permissions.
        # The assistant is a shared workspace tool — default visibility=workspace.
        "owner_id": owner_id,
        "visibility": visibility,
        "permissions": permissions.model_dump(),
    }


@app.put("/system/workspace-agent/settings")
def update_workspace_agent_settings(
    payload: WorkspaceAgentSettingsUpdate,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    """Update per-user workspace-agent capability flags."""
    from chat_service import set_workspace_agent_settings

    settings = set_workspace_agent_settings(
        auth.user_id,
        payload.model_dump(exclude_unset=True),
    )
    return {"settings": settings}


@app.put("/system/workspace-agent/visibility")
def set_workspace_agent_visibility(
    payload: AssistantVisibilityUpdate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Set the workspace assistant's visibility (Private <-> Shared with workspace).

    Owner/admin only (AssetAccessRepository enforces ``can_share`` + the enum).
    The assistant defaults to ``workspace`` (a shared tool); an owner can make it
    private. On the OSS single-owner engine the local user owns it, so this always
    succeeds. Returns the refreshed assistant view.
    """
    asset_access = getattr(repos, "asset_access", None)
    if asset_access is None or not hasattr(asset_access, "set_visibility"):
        raise HTTPException(status_code=501, detail="Visibility control not available")
    owner_id = auth.user_id
    workspace_id = derive_workspace_id(owner_id)
    aid = assistant_row_id(workspace_id)
    _ensure_assistant_row(user_id=owner_id, repos=repos)
    try:
        result = asset_access.set_visibility(
            workspace_id=workspace_id,
            actor_id=owner_id,
            asset_type="assistant",
            asset_id=aid,
            visibility=payload.visibility,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Assistant not found")
    return system_workspace_agent(auth=auth, repos=repos)


# ---------------------------------------------------------------------------
# Git workspace integration: GitHub PAT + repo linking
# ---------------------------------------------------------------------------

class _GitStatus(BaseModel):
    connected: bool
    github_username: Optional[str] = None
    repo_full_name: Optional[str] = None
    repo_url: Optional[str] = None
    connected_at: Optional[str] = None
    last_pushed_at: Optional[str] = None
    # Set after a fresh-install link when secrets were decrypted from .secrets.enc
    secrets_loaded: int = 0


class _GitConnectRequest(BaseModel):
    pat: str


class _GitLinkRequest(BaseModel):
    repo_full_name: str


class _GitCreateRepoRequest(BaseModel):
    name: str


class _GitRepoItem(BaseModel):
    full_name: str
    name: str
    url: str
    private: bool
    description: Optional[str] = None
    pushed_at: Optional[str] = None


def _git_workspace_key(user_id: str) -> str:
    """Return the key for git_workspace_config rows.

    Cloud: workspace_id — all members of a workspace share one GitHub repo.
    OSS:   user_id — single-user or first-admin owns the config.
    """
    return _git_ops.get_active_workspace_id() or user_id


def _git_cfg_get(user_id: str) -> dict | None:
    key = _git_workspace_key(user_id)
    with get_db() as conn:
        row = conn.execute(
            """SELECT github_pat, github_username, repo_full_name, repo_url,
                      remote_url, connected_at, last_pushed_at
               FROM git_workspace_config WHERE user_id = ?""",
            (key,),
        ).fetchone()
    return dict(row) if row else None


def _git_cfg_upsert(user_id: str, **fields: str) -> None:
    key = _git_workspace_key(user_id)
    with get_db() as conn:
        existing = conn.execute(
            "SELECT 1 FROM git_workspace_config WHERE user_id = ?", (key,)
        ).fetchone()
        if existing:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(
                f"UPDATE git_workspace_config SET {set_clause} WHERE user_id = ?",
                [*fields.values(), key],
            )
        else:
            fields["user_id"] = key
            keys = ", ".join(fields)
            placeholders = ", ".join("?" * len(fields))
            conn.execute(
                f"INSERT INTO git_workspace_config ({keys}) VALUES ({placeholders})",
                list(fields.values()),
            )


def _git_cfg_delete(user_id: str) -> None:
    key = _git_workspace_key(user_id)
    with get_db() as conn:
        conn.execute("DELETE FROM git_workspace_config WHERE user_id = ?", (key,))


_SECRETS_ENC_FILENAME = ".secrets.enc"

# Cloud hook — registered by managed-deployment startup.py to return the
# workspace's AES key from Supabase Vault (pgsodium DARE) instead of
# reading from GitHub Variables.
_secrets_key_resolver: Optional[Any] = None


def set_secrets_key_resolver(fn: Optional[Any]) -> None:
    """Register a callable returning the active workspace's AES-256 key bytes.

    Cloud registers this at startup — keys come from Supabase Vault (pgsodium).
    Pass None to clear (OSS fallback).
    """
    global _secrets_key_resolver
    _secrets_key_resolver = fn


_LOCAL_KEY_PATH = Path.home() / ".config" / "workeros" / "secrets.key"


def _get_or_create_secrets_key(pat: str, repo_full_name: str) -> bytes:
    """Return the AES-256 key for .secrets.enc.

    Lookup order:
      1. Cloud: _secrets_key_resolver() — Supabase Vault, never touches GitHub.
      2. OSS + GitHub: GitHub repo Variable (WORKEROS_SECRETS_KEY). Generates
         and stores a random key on first use.
      3. Local git (no GitHub): ~/.config/workeros/secrets.key. Generates and
         writes a random key with mode 600 on first use — same model as SSH keys.
    """
    import github_api as _gh

    # 1. Cloud resolver (Supabase Vault)
    if _secrets_key_resolver is not None:
        return _secrets_key_resolver()

    # 2. OSS + GitHub: key lives in the GitHub repo as an Actions Variable
    if repo_full_name:
        key = _gh.get_secrets_key(pat, repo_full_name)
        if key is None:
            key = os.urandom(32)
            _gh.set_secrets_key(pat, repo_full_name, key)
            logger.info("Generated new secrets key for %s", repo_full_name)
        return key

    # 3. Local git (no GitHub): key lives in ~/.config/workeros/secrets.key
    if _LOCAL_KEY_PATH.exists():
        return _LOCAL_KEY_PATH.read_bytes()
    _LOCAL_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    key = os.urandom(32)
    _LOCAL_KEY_PATH.write_bytes(key)
    _LOCAL_KEY_PATH.chmod(0o600)
    logger.info("Generated local secrets key at %s", _LOCAL_KEY_PATH)
    return key


def _encrypt_secrets_blob(secrets: dict, key: bytes) -> bytes:
    """Encrypt a secrets dict to bytes using AES-256-GCM."""
    import json as _json
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, _json.dumps(secrets).encode("utf-8"), None)
    return nonce + ct  # 12-byte nonce prepended for decryption


def _decrypt_secrets_blob(blob: bytes, key: bytes) -> dict:
    """Decrypt bytes produced by _encrypt_secrets_blob."""
    import json as _json
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce, ct = blob[:12], blob[12:]
    plaintext = AESGCM(key).decrypt(nonce, ct, None)
    return _json.loads(plaintext.decode("utf-8"))


def _sync_secrets_to_enc(user_id: str, repos: Repositories, pat: str, repo_full_name: str) -> None:
    """Encrypt all workspace secrets and commit .secrets.enc to git.

    Called on every secret save/delete when GitHub is connected.
    """
    try:
        secrets: dict[str, str] = {}
        for row in repos.secrets.list(user_id=user_id):
            val = repos.secrets.read_value(user_id=user_id, name=row["name"])
            if val is not None:
                secrets[row["name"]] = val
        if not secrets:
            return
        key = _get_or_create_secrets_key(pat, repo_full_name)
        blob = _encrypt_secrets_blob(secrets, key)
        workspace = _git_workspace()
        enc_path = workspace / _SECRETS_ENC_FILENAME
        enc_path.write_bytes(blob)
        with _git_ops_lock:
            _ensure_git_workspace_ready(workspace)
            _git_ops.commit_paths(
                workspace, [_SECRETS_ENC_FILENAME],
                "secrets: update encrypted vault",
            )
            _git_ops.push_background(workspace)
        logger.debug("Encrypted %d secrets to %s", len(secrets), _SECRETS_ENC_FILENAME)
    except Exception as exc:
        logger.warning("Failed to sync secrets to %s: %s", _SECRETS_ENC_FILENAME, exc)


def _load_secrets_from_enc(user_id: str, repos: Repositories, pat: str, repo_full_name: str) -> int:
    """Decrypt .secrets.enc and load secrets into WorkerOS. Returns count loaded.

    Called on startup (if already connected) and after linking a repo (fresh install).
    """
    try:
        enc_path = _git_workspace() / _SECRETS_ENC_FILENAME
        if not enc_path.is_file():
            return 0
        key = _get_or_create_secrets_key(pat, repo_full_name)
        blob = enc_path.read_bytes()
        secrets = _decrypt_secrets_blob(blob, key)
        loaded = 0
        for name, value in secrets.items():
            try:
                repos.secrets.set(user_id=user_id, name=name, value=str(value))
                loaded += 1
            except Exception:
                pass
        if loaded:
            logger.info("Loaded %d secrets from %s", loaded, _SECRETS_ENC_FILENAME)
        return loaded
    except Exception as exc:
        logger.warning("Failed to load secrets from %s: %s", _SECRETS_ENC_FILENAME, exc)
        return 0


@app.get("/system/git", response_model=_GitStatus)
def get_git_status(auth: AuthContext = Depends(get_auth_context)) -> _GitStatus:
    """Return current GitHub connection + linked repo status."""
    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("repo_full_name"):
        return _GitStatus(connected=False)
    return _GitStatus(
        connected=True,
        github_username=cfg.get("github_username"),
        repo_full_name=cfg.get("repo_full_name"),
        repo_url=cfg.get("repo_url"),
        connected_at=cfg.get("connected_at"),
        last_pushed_at=cfg.get("last_pushed_at"),
    )


@app.post("/system/git/connect")
def connect_github(
    payload: _GitConnectRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    """Validate a GitHub PAT and store it. Admin only."""
    _require_admin(auth)
    import github_api as _gh

    pat = payload.pat.strip()
    if not pat:
        raise HTTPException(status_code=400, detail="PAT cannot be empty")
    try:
        user_info = _gh.validate_pat(pat)
    except _gh.GitHubAPIError as exc:
        status = getattr(exc, "status", 0)
        if status == 401:
            raise HTTPException(status_code=400, detail="Invalid GitHub token — check it has the 'repo' scope") from exc
        raise HTTPException(status_code=400, detail=f"GitHub error: {exc}") from exc

    # Preserve existing repo link if there is one
    existing = _git_cfg_get(auth.user_id) or {}
    _git_cfg_upsert(
        auth.user_id,
        github_pat=pat,
        github_username=user_info.get("login", ""),
        connected_at=existing.get("connected_at") or now_iso(),
        # Keep existing repo fields if already linked
        **({
            "repo_full_name": existing["repo_full_name"],
            "repo_url": existing["repo_url"],
            "remote_url": existing["remote_url"],
        } if existing.get("repo_full_name") else {}),
    )
    return {
        "username": user_info.get("login"),
        "avatar_url": user_info.get("avatar_url"),
        "name": user_info.get("name"),
    }


@app.get("/system/git/repos", response_model=List[_GitRepoItem])
def list_git_repos(auth: AuthContext = Depends(get_auth_context)) -> List[_GitRepoItem]:
    """List GitHub repos that look like WorkerOS workspaces. Admin only."""
    _require_admin(auth)
    import github_api as _gh

    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("github_pat"):
        raise HTTPException(status_code=400, detail="Not connected to GitHub — provide a PAT first")
    try:
        repos = _gh.list_workeros_repos(cfg["github_pat"])
    except _gh.GitHubAPIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [_GitRepoItem(**{k: r[k] for k in _GitRepoItem.model_fields if k in r}) for r in repos]


@app.post("/system/git/repos", response_model=_GitRepoItem, status_code=201)
def create_git_repo(
    payload: _GitCreateRepoRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> _GitRepoItem:
    """Create a new private GitHub repo for this workspace. Admin only."""
    _require_admin(auth)
    import github_api as _gh

    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("github_pat"):
        raise HTTPException(status_code=400, detail="Not connected to GitHub")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Repo name cannot be empty")
    try:
        repo = _gh.create_workeros_repo(cfg["github_pat"], name)
    except _gh.GitHubAPIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _GitRepoItem(**{k: repo[k] for k in _GitRepoItem.model_fields if k in repo})


@app.post("/system/git/link", response_model=_GitStatus)
def link_git_repo(
    payload: _GitLinkRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _GitStatus:
    """Link a GitHub repo as this workspace's remote and push. Admin only."""
    _require_admin(auth)
    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("github_pat"):
        raise HTTPException(status_code=400, detail="Not connected to GitHub")

    pat = cfg["github_pat"]
    full_name = payload.repo_full_name.strip()
    remote_url = f"https://x-access-token:{pat}@github.com/{full_name}.git"
    repo_url = f"https://github.com/{full_name}"

    workspace = _git_workspace()
    try:
        _git_ops.configure_remote(workspace, remote_url)
        # Pull if the remote has commits (e.g. auto-init), then push
        try:
            _git_ops.pull(workspace)
        except _git_ops.GitOpsError:
            pass  # Remote is empty — fine, we'll just push
        _git_ops.push(workspace)
    except _git_ops.GitOpsError as exc:
        raise HTTPException(status_code=500, detail=f"Git operation failed: {exc}") from exc

    pushed_at = now_iso()
    _git_cfg_upsert(
        auth.user_id,
        repo_full_name=full_name,
        repo_url=repo_url,
        remote_url=remote_url,
        last_pushed_at=pushed_at,
    )

    # Fresh-install: if .secrets.enc is in the cloned repo, decrypt and load now.
    # On an existing install this is a no-op (secrets already loaded).
    secrets_loaded = _load_secrets_from_enc(auth.user_id, repos, pat, full_name)

    return _GitStatus(
        connected=True,
        github_username=cfg.get("github_username"),
        repo_full_name=full_name,
        repo_url=repo_url,
        connected_at=cfg.get("connected_at"),
        last_pushed_at=pushed_at,
        secrets_loaded=secrets_loaded,
    )


@app.post("/system/git/push", response_model=_GitStatus)
def push_git_workspace(auth: AuthContext = Depends(get_auth_context)) -> _GitStatus:
    """Push the workspace git repo to GitHub. Admin only."""
    _require_admin(auth)
    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("repo_full_name"):
        raise HTTPException(status_code=400, detail="No GitHub repo linked")
    try:
        _git_ops.push(_git_workspace())
    except _git_ops.GitOpsError as exc:
        raise HTTPException(status_code=500, detail=f"Push failed: {exc}") from exc

    pushed_at = now_iso()
    _git_cfg_upsert(auth.user_id, last_pushed_at=pushed_at)
    return _GitStatus(
        connected=True,
        github_username=cfg.get("github_username"),
        repo_full_name=cfg.get("repo_full_name"),
        repo_url=cfg.get("repo_url"),
        connected_at=cfg.get("connected_at"),
        last_pushed_at=pushed_at,
    )


@app.delete("/system/git", status_code=204)
def disconnect_git(auth: AuthContext = Depends(get_auth_context)) -> Response:
    """Remove stored GitHub credentials and detach the remote. Admin only."""
    _require_admin(auth)
    _git_cfg_delete(auth.user_id)
    try:
        _git_ops._git(["remote", "remove", "origin"], _git_workspace(), check=False)
    except Exception:
        pass
    return Response(status_code=204)


@app.post("/system/git/import", status_code=200)
def import_git_workspace(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Import workers and contexts from the linked GitHub repo into WorkerOS.

    Clones the repo into a temp directory, parses each worker bundle, upserts
    into the repository, then cleans up. Safe to call on an existing install —
    workers already in the DB are updated, not duplicated. Admin only.

    In cloud, repos.workers is SupabaseWorkerRepository so upsert goes to
    Supabase. Secrets are skipped in cloud (.secrets.enc is OSS-only).
    In OSS, worker files are written to WORKERS_DIR and committed to git.
    """
    import tempfile, shutil as _shutil
    import github_api as _gh
    import yaml as pyyaml

    _require_admin(auth)
    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("repo_full_name"):
        raise HTTPException(status_code=400, detail="No GitHub repo linked")

    pat = cfg["github_pat"]
    repo_full_name = cfg["repo_full_name"]
    imported = {"workers": 0, "contexts": 0, "secrets": 0, "tools": 0}

    tmp = Path(tempfile.mkdtemp(prefix="workeros-import-"))
    try:
        # Clone into temp directory
        remote_url = f"https://x-access-token:{pat}@github.com/{repo_full_name}.git"
        try:
            _git_ops.clone_or_init(tmp, remote_url)
        except _git_ops.GitOpsError as exc:
            raise HTTPException(status_code=500, detail=f"Clone failed: {exc}") from exc

        # Import workers
        workers_dir_in_repo = tmp / "workers"
        if workers_dir_in_repo.is_dir():
            for worker_bundle in sorted(workers_dir_in_repo.iterdir()):
                if not worker_bundle.is_dir():
                    continue
                worker_id = worker_bundle.name
                yml_path = worker_bundle / "worker.yml"
                if not yml_path.is_file():
                    continue
                try:
                    manifest = pyyaml.safe_load(yml_path.read_text(encoding="utf-8")) or {}
                    # Embed all other files as _files
                    files: Dict[str, str] = {}
                    for fpath in worker_bundle.iterdir():
                        if fpath.name == "worker.yml" or not fpath.is_file():
                            continue
                        try:
                            files[fpath.name] = fpath.read_text(encoding="utf-8")
                        except Exception:
                            pass
                    if files:
                        manifest["_files"] = files
                    repos.workers.upsert(
                        user_id=auth.user_id,
                        worker_id=worker_id,
                        name=manifest.get("title") or manifest.get("name") or worker_id,
                        manifest_json=manifest,
                        trigger_type=manifest.get("trigger", {}).get("type") or "manual",
                        bundle_path=f"workers/{worker_id}",
                    )
                    imported["workers"] += 1
                except Exception as exc:
                    logger.warning("Import: skipped worker %s: %s", worker_id, exc)

        # Import contexts (write to disk — contexts are filesystem-based in both OSS and cloud)
        contexts_dir_in_repo = tmp / "contexts"
        if contexts_dir_in_repo.is_dir():
            dest_contexts = current_contexts_root()
            for ctx_bundle in sorted(contexts_dir_in_repo.iterdir()):
                if not ctx_bundle.is_dir():
                    continue
                dest = dest_contexts / ctx_bundle.name
                dest.mkdir(parents=True, exist_ok=True)
                for fpath in ctx_bundle.iterdir():
                    if fpath.is_file():
                        try:
                            (dest / fpath.name).write_bytes(fpath.read_bytes())
                        except Exception:
                            pass
                imported["contexts"] += 1

        # Import workspace instructions
        for fname in ("workspace.md", "workspace.base.md"):
            src = tmp / fname
            if src.is_file():
                try:
                    (_git_workspace() / fname).write_bytes(src.read_bytes())
                except Exception:
                    pass

        # Import workspace-tools.yml
        tools_yml = tmp / "workspace-tools.yml"
        if tools_yml.is_file():
            try:
                dest_tools = _git_workspace() / _WORKSPACE_TOOLS_FILENAME
                dest_tools.parent.mkdir(parents=True, exist_ok=True)
                dest_tools.write_bytes(tools_yml.read_bytes())
                imported["tools"] = _load_workspace_tools_yml(auth.user_id, repos)
            except Exception:
                pass

        # Import secrets from .secrets.enc (OSS only — cloud uses Supabase)
        if _secrets_key_resolver is None:
            loaded_secrets = _load_secrets_from_enc(auth.user_id, repos, pat, repo_full_name)
            imported["secrets"] = loaded_secrets

    finally:
        try:
            _shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass

    return {"imported": imported}


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
                SELECT ai.id, ai.worker_id, ai.incident_key, ai.reason, ai.details, ai.fired_at, ai.resolved_at
                FROM alert_incidents ai
                JOIN workers w ON w.id = ai.worker_id
                WHERE w.owner_id = ?
                ORDER BY ai.fired_at DESC
                LIMIT 200
                """,
                (auth.user_id,),
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
    # The CURRENT webhook URL after rotation. Rotating changes the URL token
    # (it derives from the rotatable secret), so the user must re-register this.
    webhook_url: Optional[str] = None


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
        # Deterministic token auth — derived from the worker's CURRENT rotatable
        # secret, so a rotated/leaked URL stops authorizing. Reject on mismatch.
        if not verify_webhook_token(worker_id, token, repos=repos):
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

    # Resolve the specific webhook trigger row so the run is tagged with WHICH
    # trigger fired (multi-trigger workers can declare a webhook alongside other
    # triggers). Falls back to None for legacy DBs without normalized rows.
    trigger_ref: Optional[str] = None
    try:
        trigger_row = repos.workers.find_trigger_for_webhook(worker_id=worker_id)
        if trigger_row:
            trigger_ref = trigger_row["id"]
    except Exception:
        trigger_ref = None

    # Dedupe by (trigger, delivery_id): a redelivery carrying the same delivery
    # id fires at most one run. Senders that don't supply a delivery id are not
    # deduped (delivery_id == "" → always allowed).
    delivery_id = (
        request.headers.get("webhook-id")
        or request.headers.get("X-Delivery-Id")
        or request.headers.get("X-GitHub-Delivery")
        or ""
    )
    if delivery_id and not _claim_webhook_delivery(
        f"webhook:{trigger_ref or worker_id}", str(delivery_id)
    ):
        return ActionResponse(status="duplicate_ignored")

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
        trigger_ref=trigger_ref,
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
    Rotation also changes the webhook URL token (it derives from the rotatable
    secret), so the new ``webhook_url`` is returned for the user to re-register;
    the previous URL stops authorizing.
    """
    from webhook_service import build_webhook_url, generate_webhook_secret

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
    new_url: Optional[str] = None
    try:
        new_url = build_webhook_url(worker_id, repos=repos)
    except Exception:
        logger.warning("Could not build webhook URL after rotation for %s", worker_id, exc_info=True)
    return WebhookSecretResponse(worker_id=worker_id, secret=raw_secret, webhook_url=new_url)


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


_TOKEN_DEFAULT_TTL_DAYS = 90


def _max_token_ttl_days() -> int:
    """#924/#949: maximum API-token lifetime in days. 0 disables the cap
    (legacy never-expiring behavior, explicit opt-out only)."""
    raw = (os.environ.get("WORKEROS_PAT_MAX_TTL_DAYS") or "").strip()
    if not raw:
        return _TOKEN_DEFAULT_TTL_DAYS
    try:
        value = int(raw)
    except ValueError:
        return _TOKEN_DEFAULT_TTL_DAYS
    return max(value, 0)


def _default_token_expiry() -> Optional[str]:
    max_days = _max_token_ttl_days()
    if max_days <= 0:
        return None
    return (datetime.now(timezone.utc) + timedelta(days=max_days)).isoformat()


def _enforce_token_ttl_cap(requested: Optional[str]) -> Optional[str]:
    """Apply the default TTL when no expiry is requested and reject expiries
    beyond the configured cap."""
    max_days = _max_token_ttl_days()
    if not requested:
        return _default_token_expiry()
    try:
        parsed = datetime.fromisoformat(requested)
    except ValueError:
        raise HTTPException(status_code=422, detail="expires_at must be an ISO-8601 timestamp")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed <= datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="expires_at must be in the future")
    if max_days > 0 and parsed > datetime.now(timezone.utc) + timedelta(days=max_days):
        raise HTTPException(
            status_code=422,
            detail=f"expires_at exceeds the maximum token lifetime of {max_days} days",
        )
    return parsed.isoformat()


def _issue_cli_auth_pat(*, user_id: str, client_name: str, repos: Repositories, role: str) -> str:
    # #847 RCA: this used to hardcode role="admin", so ANY member approving a
    # CLI device minted themselves an admin token (member → admin escalation).
    # Fix: the token inherits the approver's role, never more. Unknown role
    # strings clamp to "member" so a bad value can't widen privileges.
    token_role = role if role in ("admin", "member") else "member"
    raw = "wos_" + _secrets_mod.token_urlsafe(32)
    token_id = str(_uuid_mod.uuid4())
    token_name = f"CLI device: {(client_name or 'unknown').strip() or 'unknown'}"
    # #924/#949: CLI tokens get a bounded lifetime instead of living forever.
    expires_at = _default_token_expiry()
    try:
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO cli_api_tokens
                    (id, token_hash, user_id, role, name, created_at, last_used_at, revoked_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
                """,
                (token_id, _hash_pat(raw), user_id, token_role, token_name, now_iso(), expires_at),
            )
        logger.info(
            "cli token minted: user=%s role=%s name=%r expires_at=%s",
            user_id, token_role, token_name, expires_at,
        )
    except Exception as exc:
        logger.exception("Could not issue CLI auth token for user %s", user_id)
        raise HTTPException(
            status_code=500,
            detail="Could not issue CLI API token",
        ) from exc
    return raw


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
    now_ts = time.time()
    repos.cli_auth.prune_expired(now_ts=now_ts)
    record = repos.cli_auth.verify_device(payload.user_code)
    if not record:
        raise HTTPException(status_code=404, detail="User code not found")
    if str(record.get("status")) != "pending":
        raise HTTPException(status_code=409, detail="Device code is no longer pending")
    api_token = _issue_cli_auth_pat(
        user_id=auth.user_id,
        client_name=str(record.get("client_name") or "unknown"),
        repos=repos,
        # #847: CLI token carries the approver's own role — a member approving
        # a device gets a member token, not admin.
        role=auth.role,
    )
    repos.cli_auth.update(
        device_code=record["device_code"],
        status="approved",
        secret=api_token,
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
    if not record:
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
    source: Literal["web", "slack", "mcp", "whatsapp", "cli"] = "web"


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


@app.get("/workspace/base")
async def get_workspace_base_persona(auth: AuthContext = Depends(get_auth_context)) -> PlainTextResponse:
    """Return the resolved editable base persona.

    If no override has been saved, this returns the built-in Emily base persona.
    Workspace custom instructions remain on /workspace.
    """
    from chat_service import get_workspace_base_persona

    return PlainTextResponse(get_workspace_base_persona(), media_type="text/markdown")


@app.get("/workspace/base/state")
async def get_workspace_base_persona_state(
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    """Return the resolved base persona plus whether it is a custom override.

    ``content`` is what currently applies to every conversation. ``is_custom``
    is True when an override has been saved; False means the built-in engine
    default is in effect. ``default`` is the built-in default, used by the UI to
    preview what a reset would restore.
    """
    from chat_service import (
        EMILY_BASE_PERSONA,
        base_persona_is_custom,
        get_workspace_base_persona,
    )

    return {
        "content": get_workspace_base_persona(),
        "is_custom": base_persona_is_custom(),
        "default": EMILY_BASE_PERSONA,
    }


@app.delete("/workspace/base", status_code=204)
async def reset_workspace_base_persona(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """Remove the base-persona override, restoring the built-in engine default.

    Snapshots the built-in default so the reset itself is in version history.
    """
    from chat_service import (
        base_persona_is_custom,
        clear_workspace_base_persona,
        get_workspace_base_persona,
    )

    _require_workspace_write(auth)  # #804
    was_custom = base_persona_is_custom()
    clear_workspace_base_persona()
    if was_custom:
        author_name, author_email = _git_author(auth)
        _git_commit_workspace_base_md(
            message="workspace base: reset-to-default",
            author_name=author_name,
            author_email=author_email,
        )
    return Response(status_code=204)


@app.get("/workspace/base/versions", response_model=List[VersionSummary])
def list_workspace_base_persona_versions(
    request: Request,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[VersionSummary]:
    """List git commit history for workspace.base.md (newest first)."""
    from chat_service import WORKSPACE_BASE_PERSONA_PATH
    workspace = _git_workspace()
    try:
        rel = WORKSPACE_BASE_PERSONA_PATH.relative_to(workspace).as_posix()
    except ValueError:
        rel = "workspace.base.md"
    rows = _git_ops.get_log(workspace, rel_path=rel, limit=min(limit, 100),
                            asset_type=_WORKSPACE_BASE_PERSONA_ASSET_TYPE, asset_id="default")
    for row in rows:
        message = str(row.get("message") or "")
        if "reset-to-default" in message:
            row["change_source"] = "reset-to-default"
        elif "update (ai)" in message:
            row["change_source"] = "ai"
        elif "update (user)" in message:
            row["change_source"] = "user"
    return [VersionSummary(**r) for r in rows]


@app.get("/workspace/base/versions/{sha}")
def get_workspace_base_persona_version(
    sha: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return workspace.base.md content at a specific git commit."""
    from chat_service import WORKSPACE_BASE_PERSONA_PATH
    workspace = _git_workspace()
    try:
        rel = WORKSPACE_BASE_PERSONA_PATH.relative_to(workspace).as_posix()
    except ValueError:
        rel = "workspace.base.md"
    content = _git_ops.get_file_at_sha(workspace, sha, rel)
    if content is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return {"content": content}


@app.post("/workspace/base/rollback/{sha}")
async def rollback_workspace_base_persona(
    sha: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> PlainTextResponse:
    """Restore workspace.base.md to its state at a given git commit SHA."""
    from chat_service import WORKSPACE_BASE_PERSONA_PATH, set_workspace_base_persona
    _require_workspace_write(auth)  # #804
    workspace = _git_workspace()
    try:
        rel = WORKSPACE_BASE_PERSONA_PATH.relative_to(workspace).as_posix()
    except ValueError:
        rel = "workspace.base.md"
    _require_sha_in_asset_history(workspace, sha, rel)
    try:
        _git_ops.checkout_path(workspace, sha, rel)
    except _git_ops.GitOpsError as exc:
        raise HTTPException(status_code=404, detail=f"Commit {sha!r} not found: {exc}") from exc

    content = WORKSPACE_BASE_PERSONA_PATH.read_text(encoding="utf-8") if WORKSPACE_BASE_PERSONA_PATH.is_file() else ""
    author_name, author_email = _git_author(auth)
    _git_commit_workspace_base_md(message=f"workspace base: rollback to {sha}", author_name=author_name, author_email=author_email)
    return PlainTextResponse(content, media_type="text/markdown")


@app.put("/workspace/base", status_code=204)
async def put_workspace_base_persona(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """Update workspace.base.md, the editable base persona override."""
    from chat_service import set_workspace_base_persona, unwrap_workspace_body

    _require_workspace_write(auth)  # #804
    body = await request.body()
    content = unwrap_workspace_body(body.decode("utf-8", errors="replace"))
    if not content.strip():
        raise HTTPException(status_code=400, detail="workspace base persona cannot be empty")
    set_workspace_base_persona(content)
    source = "ai" if request.headers.get("x-workeros-run-token") else "user"
    author_name, author_email = _git_author(auth)
    _git_commit_workspace_base_md(message=f"workspace base: update ({source})", author_name=author_name, author_email=author_email)
    return Response(status_code=204)


@app.get("/workspace/versions", response_model=List[VersionSummary])
def list_workspace_versions(
    request: Request,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[VersionSummary]:
    """List git commit history for workspace.md (newest first)."""
    from chat_service import WORKSPACE_MD_PATH
    workspace = _git_workspace()
    try:
        rel = WORKSPACE_MD_PATH.relative_to(workspace).as_posix()
    except ValueError:
        rel = "workspace.md"
    rows = _git_ops.get_log(workspace, rel_path=rel, limit=min(limit, 100),
                            asset_type=_WORKSPACE_INSTRUCTIONS_ASSET_TYPE, asset_id="default")
    if not rows and WORKSPACE_MD_PATH.is_file():
        _git_commit_workspace_md(message="baseline: snapshot existing workspace instructions")
        rows = _git_ops.get_log(workspace, rel_path=rel, limit=min(limit, 100),
                                asset_type=_WORKSPACE_INSTRUCTIONS_ASSET_TYPE, asset_id="default")
    return [VersionSummary(**r) for r in rows]


class ChangelogEntry(BaseModel):
    asset_type: str  # "worker" | "context" | "workspace_instructions"
    asset_id: str
    asset_name: str
    sha: str
    message: str
    committed_at: str


@app.get("/workspace/changelog", response_model=List[ChangelogEntry])
def workspace_changelog(
    limit: int = 50,
    asset_types: str = "worker,context,workspace_instructions",
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[ChangelogEntry]:
    """#772: unified workspace changelog — merges the git history of all
    workers, brain packs, and the workspace prompt into one timeline (newest
    first). Each asset's log is bounded and the merged result is capped."""
    wanted = {t.strip() for t in asset_types.split(",") if t.strip()}
    limit = min(max(limit, 1), 200)
    per_asset = min(limit, 20)
    workspace = _git_workspace()
    entries: List[ChangelogEntry] = []

    def _collect(rel_path: str, asset_type: str, asset_id: str, asset_name: str) -> None:
        try:
            rows = _git_ops.get_log(workspace, rel_path=rel_path, limit=per_asset,
                                    asset_type=asset_type, asset_id=asset_id)
        except Exception:
            return
        for r in rows:
            entries.append(ChangelogEntry(
                asset_type=asset_type, asset_id=asset_id, asset_name=asset_name,
                sha=str(r.get("sha") or r.get("id") or ""),
                message=str(r.get("message") or ""),
                committed_at=str(r.get("timestamp") or ""),
            ))

    if "worker" in wanted:
        prefix = _workers_git_prefix()
        for w in _list_visible_workers(user_id=auth.user_id, repos=repos, use_cache=True)[:60]:
            _collect(f"{prefix}/{w['id']}", "worker", str(w["id"]), str(w.get("name") or w["id"]))
    if "context" in wanted:
        cprefix = _contexts_git_prefix()
        try:
            for c in list_contexts(auth=auth, repos=repos)[:60]:
                if getattr(c, "sensitive", True):
                    continue  # sensitive packs are never git-tracked
                _collect(f"{cprefix}/{c.name}", "context", c.name, c.name)
        except Exception:
            logger.debug("changelog: context enumeration failed", exc_info=True)
    if "workspace_instructions" in wanted:
        try:
            from chat_service import WORKSPACE_MD_PATH
            try:
                rel = WORKSPACE_MD_PATH.relative_to(workspace).as_posix()
            except ValueError:
                rel = "workspace.md"
            _collect(rel, "workspace_instructions", "default", "Workspace instructions")
        except Exception:
            logger.debug("changelog: workspace.md log failed", exc_info=True)

    entries.sort(key=lambda e: e.committed_at, reverse=True)
    return entries[:limit]


@app.get("/workspace/versions/{sha}")
def get_workspace_version(
    sha: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return workspace.md content at a specific git commit."""
    from chat_service import WORKSPACE_MD_PATH
    workspace = _git_workspace()
    try:
        rel = WORKSPACE_MD_PATH.relative_to(workspace).as_posix()
    except ValueError:
        rel = "workspace.md"
    content = _git_ops.get_file_at_sha(workspace, sha, rel)
    if content is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return {"content": content}


@app.post("/workspace/rollback/{sha}")
async def rollback_workspace_instructions(
    sha: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> PlainTextResponse:
    """Restore workspace.md to its state at a given git commit SHA."""
    from chat_service import WORKSPACE_MD_PATH, set_workspace_md
    _require_workspace_write(auth)  # #804
    workspace = _git_workspace()
    try:
        rel = WORKSPACE_MD_PATH.relative_to(workspace).as_posix()
    except ValueError:
        rel = "workspace.md"
    _require_sha_in_asset_history(workspace, sha, rel)
    try:
        _git_ops.checkout_path(workspace, sha, rel)
    except _git_ops.GitOpsError as exc:
        raise HTTPException(status_code=404, detail=f"Commit {sha!r} not found: {exc}") from exc

    content = WORKSPACE_MD_PATH.read_text(encoding="utf-8") if WORKSPACE_MD_PATH.is_file() else ""
    if content:
        set_workspace_md(content)
    author_name, author_email = _git_author(auth)
    _git_commit_workspace_md(message=f"workspace: rollback to {sha}", author_name=author_name, author_email=author_email)
    return PlainTextResponse(content, media_type="text/markdown")


@app.put("/workspace", status_code=204)
async def put_workspace(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """Update workspace.md (replaces entire content)."""
    from chat_service import set_workspace_md, unwrap_workspace_body

    _require_workspace_write(auth)  # #804
    body = await request.body()
    content = unwrap_workspace_body(body.decode("utf-8", errors="replace"))
    if not content.strip():
        raise HTTPException(status_code=400, detail="workspace.md content cannot be empty")
    set_workspace_md(content)
    source = "ai" if request.headers.get("x-workeros-run-token") else "user"
    author_name, author_email = _git_author(auth)
    _git_commit_workspace_md(message=f"workspace: update instructions ({source})", author_name=author_name, author_email=author_email)
    return Response(status_code=204)


class _ChatAttachmentOut(BaseModel):
    name: str
    size: int
    type: str
    text: Optional[str] = None
    truncated: bool = False


_CHAT_ATTACHMENT_TEXT_EXTS = (
    ".txt", ".md", ".markdown", ".csv", ".json", ".yml", ".yaml", ".log",
    ".py", ".js", ".ts", ".tsx", ".html", ".xml", ".toml", ".ini", ".sql",
)


@app.post("/chat/attachments", response_model=List[_ChatAttachmentOut])
async def upload_chat_attachments(
    files: List[UploadFile] = File(...),
    auth: AuthContext = Depends(get_auth_context),
) -> List[_ChatAttachmentOut]:
    """#778: accept Emily chat attachments. Text-like files are decoded so their
    content rides along in the next message; binaries return metadata only."""
    max_text = 200_000  # chars of extracted text per file
    out: List[_ChatAttachmentOut] = []
    for f in files:
        data = await f.read()
        name = f.filename or "attachment"
        ctype = (f.content_type or "").lower()
        text: Optional[str] = None
        truncated = False
        is_text = ctype.startswith("text/") or name.lower().endswith(_CHAT_ATTACHMENT_TEXT_EXTS)
        if is_text:
            decoded = data.decode("utf-8", errors="replace")
            if len(decoded) > max_text:
                decoded = decoded[:max_text]
                truncated = True
            text = decoded
        out.append(_ChatAttachmentOut(
            name=name, size=len(data),
            type=ctype or "application/octet-stream",
            text=text, truncated=truncated,
        ))
    return out


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
                source=payload.source,
            )
        except Exception as exc:
            logger.exception("chat background task failed")
            try:
                from llm import safe_llm_error_message

                await part_queue.put({"type": "error", "error": safe_llm_error_message(exc, action="Chat")})
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
    from chat_service import get_conversation, list_conversation_messages, list_conversation_tool_cards
    conv = get_conversation(conversation_id, auth.user_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    messages = list_conversation_messages(conversation_id, auth.user_id)
    tool_cards = list_conversation_tool_cards(conversation_id, auth.user_id)
    return {**conv, "messages": messages, "tool_cards": tool_cards}


@app.get("/conversations/{conversation_id}/export")
async def export_conversation(
    conversation_id: str,
    format: str = "md",
    auth: AuthContext = Depends(get_auth_context),
) -> Response:
    """#776: download a conversation transcript as a markdown attachment.

    The Emily header 'Export chat' button had no backend; GET /conversations/
    {id} returns JSON but is not a download. This renders the message turns as
    markdown with a Content-Disposition attachment header.
    """
    if format != "md":
        raise HTTPException(status_code=422, detail="only format=md is supported")
    from chat_service import get_conversation, list_conversation_messages
    conv = get_conversation(conversation_id, auth.user_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    messages = list_conversation_messages(conversation_id, auth.user_id)

    title = str(conv.get("title") or "Conversation")
    lines = [f"# {title}", ""]
    role_label = {"user": "You", "assistant": "Emily"}
    for msg in messages:
        role = str(msg.get("role") or "")
        if role == "tool":
            continue  # tool results are represented by their cards, not transcript prose
        content = str(msg.get("content") or "").strip()
        if not content:
            continue
        who = role_label.get(role, role.capitalize() or "Unknown")
        ts = str(msg.get("created_at") or "")
        header = f"## {who}" + (f" — {ts}" if ts else "")
        lines.extend([header, "", content, ""])
    body = "\n".join(lines).rstrip() + "\n"

    safe_id = re.sub(r"[^A-Za-z0-9_-]+", "-", conversation_id)[:60] or "conversation"
    return Response(
        content=body,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="chat-{safe_id}.md"'},
    )


# ---------------------------------------------------------------------------
# MCP tool CRUD endpoints
# ---------------------------------------------------------------------------

def _mcp_input_schema_from_worker_record(worker: Dict[str, Any]) -> Dict[str, Any]:
    config = worker.get("config") or {}
    inputs = config.get("inputs") if isinstance(config, dict) else []
    if not isinstance(inputs, list):
        return {"type": "object", "properties": {}}
    properties: Dict[str, Any] = {}
    required: List[str] = []
    type_map = {
        "string": "string",
        "text": "string",
        "markdown": "string",
        "number": "number",
        "integer": "integer",
        "boolean": "boolean",
        "bool": "boolean",
        "object": "object",
        "json": "object",
        "array": "array",
    }
    for item in inputs:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        raw_type = str(item.get("type") or item.get("kind") or "string").lower()
        prop: Dict[str, Any] = {"type": type_map.get(raw_type, "string")}
        if item.get("description"):
            prop["description"] = str(item["description"])
        if isinstance(item.get("options"), list):
            prop["enum"] = [str(option) for option in item["options"]]
        properties[name] = prop
        if item.get("required"):
            required.append(name)
    schema: Dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


@app.get("/mcp-tools", response_model=List[McpToolItem])
@app.get("/mcp/tools", response_model=List[McpToolItem])
def list_mcp_tools(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[McpToolItem]:
    return repos.mcp_tools.list(user_id=auth.user_id)


@app.post("/mcp-tools", response_model=McpToolItem)
@app.post("/mcp/tools", response_model=McpToolItem)
def create_mcp_tool(
    payload: McpToolCreate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> McpToolItem:
    worker = repos.workers.get(user_id=auth.user_id, worker_id=payload.worker_id)
    if not worker:
        all_workers = repos.workers.list(user_id=auth.user_id)
        worker = next((w for w in all_workers if w["name"] == payload.worker_id), None)
    if not worker:
        raise HTTPException(status_code=404, detail=f"Worker {payload.worker_id!r} not found")

    if repos.mcp_tools.get_by_name(user_id=auth.user_id, name=payload.name):
        raise HTTPException(status_code=409, detail=f"A tool named {payload.name!r} already exists")

    input_schema = payload.input_schema
    if not input_schema:
        input_schema = _mcp_input_schema_from_worker_record(worker)

    result = repos.mcp_tools.create(
        user_id=auth.user_id,
        name=payload.name,
        description=payload.description,
        input_schema=input_schema,
        worker_id=worker["id"],
    )
    _sync_workspace_tools_yml(auth.user_id, repos)
    return result


@app.put("/mcp-tools/{tool_id}", response_model=McpToolItem)
@app.put("/mcp/tools/{tool_id}", response_model=McpToolItem)
def update_mcp_tool(
    tool_id: str,
    payload: McpToolUpdate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> McpToolItem:
    if not repos.mcp_tools.get(user_id=auth.user_id, tool_id=tool_id):
        raise HTTPException(status_code=404, detail="MCP tool not found")
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    updated = repos.mcp_tools.update(user_id=auth.user_id, tool_id=tool_id, **updates)
    _sync_workspace_tools_yml(auth.user_id, repos)
    return updated


@app.delete("/mcp-tools/{tool_id}", response_model=ActionResponse)
@app.delete("/mcp/tools/{tool_id}", response_model=ActionResponse)
def delete_mcp_tool(
    tool_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    if not repos.mcp_tools.get(user_id=auth.user_id, tool_id=tool_id):
        raise HTTPException(status_code=404, detail="MCP tool not found")
    repos.mcp_tools.delete(user_id=auth.user_id, tool_id=tool_id)
    _sync_workspace_tools_yml(auth.user_id, repos)
    return ActionResponse(status="deleted")


_WORKSPACE_TOOLS_FILENAME = "workspace-tools.yml"


def _sync_workspace_tools_yml(user_id: str, repos: Repositories) -> None:
    """Write all MCP tools to workspace-tools.yml and commit to git.

    Called after every create/update/delete so the file is always the
    authoritative source of truth for the workspace's tool registrations.
    """
    import yaml as pyyaml
    try:
        tools = repos.mcp_tools.list(user_id=user_id)
        doc = {
            "version": 1,
            "tools": [
                {
                    "id": t["id"],
                    "name": t["name"],
                    "worker_id": t["worker_id"],
                    "description": t.get("description", ""),
                }
                for t in tools
            ],
        }
        workspace = _git_workspace()
        yml_path = workspace / _WORKSPACE_TOOLS_FILENAME
        yml_path.write_text(
            pyyaml.safe_dump(doc, sort_keys=False, default_flow_style=False, allow_unicode=True),
            encoding="utf-8",
        )
        with _git_ops_lock:
            _ensure_git_workspace_ready(workspace)
            _git_ops.commit_paths(
                workspace, [_WORKSPACE_TOOLS_FILENAME],
                f"tools: update workspace-tools.yml ({len(tools)} tool{'s' if len(tools) != 1 else ''})",
            )
            _git_ops.push_background(workspace)
    except Exception as exc:
        logger.warning("Failed to sync %s: %s", _WORKSPACE_TOOLS_FILENAME, exc)


def _load_workspace_tools_yml(user_id: str, repos: Repositories) -> int:
    """Parse workspace-tools.yml and sync missing tools into the DB.

    Called on startup after a fresh clone so MCP tool registrations
    are restored automatically. Returns count of tools loaded.
    """
    import yaml as pyyaml
    yml_path = _git_workspace() / _WORKSPACE_TOOLS_FILENAME
    if not yml_path.is_file():
        return 0
    try:
        doc = pyyaml.safe_load(yml_path.read_text(encoding="utf-8")) or {}
        tools_in_file = doc.get("tools") or []
        existing_names = {t["name"] for t in repos.mcp_tools.list(user_id=user_id)}
        loaded = 0
        for t in tools_in_file:
            name = t.get("name", "").strip()
            worker_id = t.get("worker_id", "").strip()
            if not name or not worker_id or name in existing_names:
                continue
            worker = repos.workers.get(user_id=user_id, worker_id=worker_id)
            if not worker:
                continue
            input_schema = _mcp_input_schema_from_worker_record(worker)
            repos.mcp_tools.create(
                user_id=user_id,
                name=name,
                description=t.get("description", ""),
                input_schema=input_schema,
                worker_id=worker_id,
            )
            loaded += 1
        if loaded:
            logger.info("Loaded %d MCP tools from %s", loaded, _WORKSPACE_TOOLS_FILENAME)
        return loaded
    except Exception as exc:
        logger.warning("Failed to load %s: %s", _WORKSPACE_TOOLS_FILENAME, exc)
        return 0


# ---------------------------------------------------------------------------
# HTTP MCP server — JSON-RPC 2.0 over streamable HTTP
# Exposes default WorkerOS management tools + custom workspace tools.
# OSS:   POST /mcp-tools/serve   (x-floom-secret auth)
# Cloud: POST /mcp/{workspace_id} (PAT Bearer auth, added in managed-deployment)
# All default tools proxy to the existing REST API via httpx ASGITransport
# (in-process, no network round-trip).  Custom tools trigger a worker run.
# ---------------------------------------------------------------------------

def _enc(s: str) -> str:
    from urllib.parse import quote
    return quote(str(s), safe="")


def _api_call_response_data(resp: Any) -> Any:
    """Parse an internal proxy response for MCP clients.

    #836 RCA: a non-JSON internal response (HTML error page, stack trace,
    proxy timeout page) used to be forwarded verbatim as {"detail": resp.text}
    — leaking server internals to external MCP clients. The raw body is now
    logged server-side and the client gets a generic message.
    """
    try:
        return resp.json()
    except Exception:
        logger.warning(
            "MCP proxy: non-JSON internal response (status %s): %.300s",
            getattr(resp, "status_code", "?"),
            getattr(resp, "text", ""),
        )
        return {"detail": "Internal server error"}


# Auth headers forwarded by the internal MCP proxy. #851: x-api-key was
# missing, so any internal path authenticating via x-api-key saw the proxied
# request as unauthenticated.
_API_CALL_AUTH_HEADERS = frozenset({
    "x-floom-secret",
    "x-floom-token",
    "x-api-key",
    "authorization",
    "cookie",
    "x-workeros-workspace",
})


async def _api_call(
    method: str,
    path: str,
    request: Request,
    *,
    body: Any = None,
    params: dict | None = None,
) -> tuple[Any, int]:
    import httpx
    auth_headers = {k: v for k, v in request.headers.items() if k.lower() in _API_CALL_AUTH_HEADERS}
    if "x-workeros-workspace" not in auth_headers:
        auth_headers["x-workeros-workspace"] = DEFAULT_WORKSPACE_ID
    clean_params = {k: str(v) for k, v in (params or {}).items() if v is not None}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://asgi",
    ) as client:
        resp = await client.request(method, path, headers=auth_headers, json=body, params=clean_params)
    return _api_call_response_data(resp), resp.status_code


_MCP_DEFAULT_TOOLS: List[dict] = [
    # --- workers ---
    {"name": "workers.list", "description": "List Workeros workers.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "workers.get", "description": "Get a Workeros worker by id.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string", "description": "Worker ID."}}, "required": ["id"]}},
    {"name": "workers.create", "description": "Create a Workeros worker from WorkerContract YAML. For script-mode workers supply run_py. For agent/skill-mode workers supply skill_md and a minimal run_py stub.", "inputSchema": {"type": "object", "properties": {"worker_yml": {"type": "string", "description": "WorkerContract YAML content."}, "run_py": {"type": "string", "description": "Python source for run.py."}, "skill_md": {"type": "string", "description": "Agent system prompt (SKILL.md) for skill-mode workers. Omit for script-mode."}}, "required": ["worker_yml", "run_py"]}},
    {"name": "workers.update", "description": "Update worker instance settings such as trigger, cron, input defaults, and documented capabilities.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string", "description": "Worker ID."}, "trigger_type": {"type": "string"}, "cron_expr": {"type": "string"}, "cron_timezone": {"type": "string"}, "input_values": {"type": "object"}, "capabilities": {"type": "object"}, "webhook_secret_rotate": {"type": "boolean"}}, "required": ["id"]}},
    {"name": "workers.delete", "description": "Delete a Workeros worker.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string", "description": "Worker ID."}}, "required": ["id"]}},
    {"name": "workers.run", "description": "Start a manual Workeros worker run.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string", "description": "Worker ID."}, "inputs": {"type": "object", "default": {}, "description": "Input values for this run."}, "trigger_source": {"type": "string", "default": "manual"}}, "required": ["id"]}},
    {"name": "workers.write_file", "description": "Write or update source files inside a worker directory (worker.yml, SKILL.md, run.py, requirements.txt). Must include worker.yml.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string", "description": "Worker ID."}, "files": {"type": "array", "items": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}, "description": "Files to write. Must include worker.yml."}}, "required": ["id", "files"]}},
    {"name": "workers.logs", "description": "Fetch cross-run logs for a worker, optionally filtered by level or time.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "level": {"type": "string", "enum": ["info", "warning", "error", "debug"]}, "since": {"type": "string", "description": "ISO 8601 timestamp."}, "limit": {"type": "integer", "default": 200}}, "required": ["id"]}},
    {"name": "workers.stats", "description": "Get run statistics for a specific worker — success rate, error rate, average duration for the last 7 days.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "workers.timeseries", "description": "Get daily run counts and success/failure breakdown for a worker over the last N days.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "days": {"type": "integer", "default": 30, "description": "Days of history (1–90)."}}, "required": ["id"]}},
    {"name": "workers.versions", "description": "List saved versions of a worker, newest first.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "limit": {"type": "integer", "default": 50}}, "required": ["id"]}},
    {"name": "workers.rollback", "description": "Restore a worker to a previous version. Use workers.versions to find the version_id.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "version_id": {"type": "string"}}, "required": ["id", "version_id"]}},
    {"name": "workers.archive", "description": "Archive a worker so it no longer appears in the active list or runs on schedule.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "workers.restore", "description": "Restore an archived worker back to active status.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "workers.reload", "description": "Reload all workers from disk. Use after manually editing worker files on an OSS self-hosted deployment.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "workers.sample_input", "description": "Get example input values for a worker's input fields.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "workers.alerts.list", "description": "List configured alerts for a worker (email/webhook on failure, success, etc.).", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "workers.alerts.create", "description": "Add an alert to a worker — fires on specified events via webhook or email.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "on": {"type": "array", "items": {"type": "string"}, "description": "Events to alert on, e.g. ['failed', 'approval_required']."}, "url": {"type": "string"}, "email_to": {"type": "array", "items": {"type": "string"}}}, "required": ["id", "on"]}},
    {"name": "workers.alerts.delete", "description": "Remove a worker alert by its ID.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "alert_id": {"type": "string"}}, "required": ["id", "alert_id"]}},
    # --- runs ---
    {"name": "runs.list", "description": "List Workeros runs, optionally filtered by worker id.", "inputSchema": {"type": "object", "properties": {"worker_id": {"type": "string"}, "status": {"type": "string"}, "limit": {"type": "integer", "default": 50}, "offset": {"type": "integer", "default": 0}}}},
    {"name": "runs.get", "description": "Get a Workeros run by id, including logs, outputs, artifacts, and approval status.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "runs.cancel", "description": "Cancel an in-progress run.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "runs.replay", "description": "Replay a completed or failed run with the same inputs.", "inputSchema": {"type": "object", "properties": {"worker_id": {"type": "string"}, "run_id": {"type": "string"}}, "required": ["worker_id", "run_id"]}},
    {"name": "runs.watch", "description": "Poll a run until it reaches a terminal status. Blocks up to timeout_ms (capped at 30s — poll runs.get for longer waits).", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "timeout_ms": {"type": "integer", "default": 30000, "maximum": 30000}}, "required": ["id"]}},
    # --- secrets ---
    {"name": "secrets.list", "description": "List configured secret names and status.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "secrets.set", "description": "Create or update a secret value.", "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}, "value": {"type": "string"}}, "required": ["key", "value"]}},
    {"name": "secrets.delete", "description": "Delete a secret by key.", "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}},
    {"name": "secrets.test", "description": "Verify a secret exists and is reachable without revealing its value.", "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}},
    # --- connections ---
    {"name": "connections.list", "description": "List configured app connections.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "connections.add_mcp", "description": "Save an MCP server connection. Supports streamable_http, sse, and stdio transports.", "inputSchema": {"type": "object", "properties": {"label": {"type": "string"}, "transport": {"type": "string", "enum": ["streamable_http", "sse", "stdio"], "default": "streamable_http"}, "url": {"type": "string"}, "command": {"type": "string"}, "args": {"type": "array", "items": {"type": "string"}, "default": []}, "env": {"type": "object", "default": {}}, "cwd": {"type": "string"}, "auth_secret": {"type": "string"}, "allowed_tools": {"type": "array", "items": {"type": "string"}, "default": []}}, "required": ["label"]}},
    {"name": "connections.delete", "description": "Remove a configured app connection.", "inputSchema": {"type": "object", "properties": {"connection_id": {"type": "string"}}, "required": ["connection_id"]}},
    {"name": "connections.status", "description": "Check the health and auth status of a configured connection.", "inputSchema": {"type": "object", "properties": {"connection_id": {"type": "string"}}, "required": ["connection_id"]}},
    {"name": "connections.test", "description": "Run a live connectivity check on a configured connection.", "inputSchema": {"type": "object", "properties": {"connection_id": {"type": "string"}}, "required": ["connection_id"]}},
    # --- contexts ---
    {"name": "contexts.list", "description": "List Workeros context folders.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "contexts.create", "description": "Create a new brain pack context folder.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "writeable": {"type": "boolean", "default": False}, "sensitive": {"type": "boolean", "default": True, "description": "Sensitive contexts (default) are excluded from git versioning. Set false to enable version history and rollback."}}, "required": ["name"]}},
    {"name": "contexts.read", "description": "Read a UTF-8 context file, or return metadata for binary files.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "path": {"type": "string"}}, "required": ["name", "path"]}},
    {"name": "contexts.write", "description": "Create or update a UTF-8 text file inside a context.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "path": {"type": "string"}, "content": {"type": "string"}}, "required": ["name", "path", "content"]}},
    {"name": "record_candidate_feedback", "description": "Record one immutable candidate feedback JSON event into a writable context.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "run_id": {"type": "string"}, "candidate_id": {"type": "string"}, "rank": {"type": "integer"}, "feedback_text": {"type": "string"}, "outcome": {"type": "string", "enum": ["good", "bad", "miss"]}, "scope": {"type": "string", "enum": ["global", "client"], "default": "global"}, "reporter": {"type": "string"}}, "required": ["name", "run_id", "candidate_id", "rank", "feedback_text", "outcome"]}},
    {"name": "contexts.delete", "description": "Delete a brain pack context and all its files.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "force": {"type": "boolean", "default": False}}, "required": ["name"]}},
    {"name": "contexts.delete_file", "description": "Delete a specific file from a brain pack context.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "path": {"type": "string"}}, "required": ["name", "path"]}},
    {"name": "contexts.versions", "description": "List saved versions of a brain pack context, newest first.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "limit": {"type": "integer", "default": 50}}, "required": ["name"]}},
    {"name": "contexts.rollback", "description": "Restore a brain pack context to a previous version.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "version_id": {"type": "string"}}, "required": ["name", "version_id"]}},
    # --- triggers ---
    {"name": "triggers.list", "description": "List integration triggers, globally or filtered by worker/app.", "inputSchema": {"type": "object", "properties": {"worker_id": {"type": "string"}, "app": {"type": "string"}}}},
    # --- approvals ---
    {"name": "approvals.list", "description": "List pending approval requests.", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "default": 50}}}},
    {"name": "approvals.approve", "description": "Approve a pending run so it continues executing.", "inputSchema": {"type": "object", "properties": {"run_id": {"type": "string"}, "comment": {"type": "string"}}, "required": ["run_id"]}},
    {"name": "approvals.reject", "description": "Reject a pending run, stopping it from continuing.", "inputSchema": {"type": "object", "properties": {"run_id": {"type": "string"}, "comment": {"type": "string"}}, "required": ["run_id"]}},
    # --- workspace ---
    {"name": "workspace.chat", "description": "Send a message to the Workeros workspace agent and receive a reply.", "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}, "conversation_id": {"type": "string"}, "timeout_ms": {"type": "integer", "default": 120000}}, "required": ["message"]}},
    {"name": "workspace.instructions.get", "description": "Read the current workspace agent instructions.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "workspace.instructions.set", "description": "Update the workspace agent instructions.", "inputSchema": {"type": "object", "properties": {"content": {"type": "string"}}, "required": ["content"]}},
    {"name": "workspace.versions", "description": "List saved versions of the workspace agent instructions.", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "default": 20}}}},
    {"name": "workspace.rollback", "description": "Restore workspace agent instructions to a previous version.", "inputSchema": {"type": "object", "properties": {"version_id": {"type": "string"}}, "required": ["version_id"]}},
    # --- system ---
    {"name": "system.overview", "description": "Full workspace dashboard — worker health, recent run counts, pending approvals, system alerts, and scheduler status.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "system.stats", "description": "Aggregate run statistics across the workspace for the last 7 days.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "system.info", "description": "Get platform version, deployment mode, and configuration flags.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "system.alerts", "description": "Get system-wide active alerts — worker failures, scheduler issues, connection errors.", "inputSchema": {"type": "object", "properties": {}}},
    # --- integrations ---
    {"name": "integrations.catalog", "description": "Browse available integrations (apps, triggers, actions) supported by Workeros.", "inputSchema": {"type": "object", "properties": {}}},
    # --- conversations ---
    {"name": "conversations.list", "description": "List past workspace agent conversations.", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "default": 20}}}},
    {"name": "conversations.get", "description": "Retrieve a full conversation history by ID.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    # --- custom tools management ---
    {"name": "tools_list", "description": "List custom MCP tools registered for this workspace.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "tools_register", "description": "Register a custom MCP tool backed by a worker. Once registered the tool appears in tools/list and can be called directly by name.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "Tool name agents will use."}, "description": {"type": "string"}, "worker_id": {"type": "string", "description": "Worker ID or name."}, "input_schema": {"type": "object", "description": "JSON Schema for inputs (optional — defaults to worker schema)."}}, "required": ["name", "description", "worker_id"]}},
    {"name": "tools_delete", "description": "Delete a custom MCP tool by name.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    {"name": "tools_update", "description": "Update an existing custom MCP tool. Only the fields you provide are changed.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "Name of the tool to update."}, "description": {"type": "string", "description": "New description."}, "worker_id": {"type": "string", "description": "New worker ID or name to back this tool."}, "input_schema": {"type": "object", "description": "New JSON Schema for inputs."}}, "required": ["name"]}},
]


# --- #833: scope + exposure controls for the MCP serve surface -------------
# RCA: /mcp-tools/serve exposed every default tool to any authenticated
# caller with no per-tool permission check — one leaked secret or member PAT
# was full workspace-destruction capability (workers.delete, secrets.set,
# contexts.delete, ...). The REST layer the tools proxy to has its own
# checks, but the MCP surface itself granted member tokens admin-shaped
# reach. Three controls, all enforced in tools/list AND tools/call:
#   1. _MCP_ADMIN_ONLY_TOOLS    — destructive tools require auth.is_admin.
#   2. WORKEROS_MCP_ENABLED_TOOLS — optional comma-separated allow-list; when
#      set, only the named default tools are served at all.
#   3. _MCP_OFF_BY_DEFAULT_TOOLS — tools with remote-takeover potential are
#      not served unless WORKEROS_MCP_ENABLE_DESTRUCTIVE=1 (#838, #840).
# Every tools/call is audit-logged with tool, user, and role.

_MCP_ADMIN_ONLY_TOOLS = frozenset({
    "workers.delete",
    "workers.reload",
    "workers.archive",
    "workers.restore",
    "workers.rollback",
    "secrets.set",
    "secrets.delete",
    "connections.add_mcp",
    "connections.delete",
    "contexts.delete",
    "contexts.delete_file",
    "contexts.rollback",
    "workspace.instructions.set",
    "workspace.rollback",
    "approvals.approve",
    "approvals.reject",
})

# #838/#840: exposed only when WORKEROS_MCP_ENABLE_DESTRUCTIVE=1.
# - connections.add_mcp (#838): registers arbitrary external MCP servers
#   (url/command/env) that workers later invoke — a remote-config C2 /
#   exfiltration channel if the serve secret leaks.
# - workers.reload (#840): reloads ALL workers from disk with zero
#   confirmation — mass worker interruption from one remote call.
_MCP_OFF_BY_DEFAULT_TOOLS: frozenset = frozenset({
    "connections.add_mcp",
    "workers.reload",
})


def _mcp_destructive_tools_enabled() -> bool:
    return os.environ.get("WORKEROS_MCP_ENABLE_DESTRUCTIVE") == "1"


def _mcp_enabled_tool_names() -> set | None:
    """Parse WORKEROS_MCP_ENABLED_TOOLS; None means 'no allow-list set'."""
    raw = (os.environ.get("WORKEROS_MCP_ENABLED_TOOLS") or "").strip()
    if not raw:
        return None
    return {part.strip() for part in raw.split(",") if part.strip()}


def _mcp_tool_served(name: str) -> bool:
    """Is this default tool exposed at all on this deployment?"""
    if name in _MCP_OFF_BY_DEFAULT_TOOLS and not _mcp_destructive_tools_enabled():
        return False
    allowed = _mcp_enabled_tool_names()
    if allowed is not None and name not in allowed:
        return False
    return True


def _mcp_access_error(name: str, auth: AuthContext) -> str | None:
    """Return an error string if this auth context may not call the tool."""
    is_default_tool = any(t["name"] == name for t in _MCP_DEFAULT_TOOLS)
    if is_default_tool and not _mcp_tool_served(name):
        return f"Tool {name!r} is not enabled on this deployment"
    if name in _MCP_ADMIN_ONLY_TOOLS and not auth.is_admin:
        return f"Tool {name!r} requires admin role"
    return None


def _mcp_ok(rpc_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": rpc_id, "result": result}


def _mcp_err(rpc_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}


def _mcp_content(text: str, is_error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


async def _mcp_dispatch(
    name: str,
    arguments: dict,
    auth: AuthContext,
    repos: "Repositories",
    request: Request,
) -> dict:
    import asyncio
    import time as _time

    a = arguments  # shorthand

    # --- workers ---
    if name == "workers.list":
        data, s = await _api_call("GET", "/workers", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.get":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.create":
        body = {k: a[k] for k in ("worker_yml", "run_py") if k in a}
        if "skill_md" in a: body["skill_md"] = a["skill_md"]
        data, s = await _api_call("POST", "/workers", request, body=body)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.update":
        body = {k: a[k] for k in a if k != "id"}
        data, s = await _api_call("PATCH", f"/workers/{_enc(a['id'])}", request, body=body)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.delete":
        data, s = await _api_call("DELETE", f"/workers/{_enc(a['id'])}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.run":
        body = {"inputs": a.get("inputs") or {}, "trigger_source": a.get("trigger_source", "manual")}
        data, s = await _api_call("POST", f"/workers/{_enc(a['id'])}/runs", request, body=body)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.write_file":
        data, s = await _api_call("PUT", f"/workers/{_enc(a['id'])}/files", request, body={"files": a["files"]})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.logs":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/logs", request, params={"level": a.get("level"), "since": a.get("since"), "limit": a.get("limit", 200)})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.stats":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/stats", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.timeseries":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/runs/timeseries", request, params={"days": a.get("days", 30)})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.versions":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/versions", request, params={"limit": a.get("limit", 50)})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.rollback":
        data, s = await _api_call("POST", f"/workers/{_enc(a['id'])}/rollback/{_enc(a['version_id'])}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.archive":
        data, s = await _api_call("POST", f"/workers/{_enc(a['id'])}/archive", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.restore":
        data, s = await _api_call("POST", f"/workers/{_enc(a['id'])}/restore", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.reload":
        data, s = await _api_call("POST", "/workers/reload", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.sample_input":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/sample-input", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.alerts.list":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/alerts", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.alerts.create":
        body = {k: a[k] for k in a if k != "id"}
        data, s = await _api_call("POST", f"/workers/{_enc(a['id'])}/alerts", request, body=body)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workers.alerts.delete":
        data, s = await _api_call("DELETE", f"/workers/{_enc(a['id'])}/alerts/{_enc(a['alert_id'])}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)

    # --- runs ---
    if name == "runs.list":
        data, s = await _api_call("GET", "/runs", request, params={"worker_id": a.get("worker_id"), "status": a.get("status"), "limit": a.get("limit", 50), "offset": a.get("offset", 0)})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "runs.get":
        data, s = await _api_call("GET", f"/runs/{_enc(a['id'])}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "runs.cancel":
        data, s = await _api_call("POST", f"/runs/{_enc(a['id'])}/cancel", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "runs.replay":
        data, s = await _api_call("POST", f"/workers/{_enc(a['worker_id'])}/runs/{_enc(a['run_id'])}/replay", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "runs.watch":
        run_id = a["id"]
        timeout = _mcp_watch_timeout_seconds(a.get("timeout_ms"))  # #834: 30s cap
        deadline = _time.monotonic() + timeout
        run = None
        while _time.monotonic() < deadline:
            await asyncio.sleep(1.5)
            run_data, s = await _api_call("GET", f"/runs/{_enc(run_id)}", request)
            if s >= 400:
                return _mcp_content(json.dumps(run_data, indent=2, default=str), True)
            if run_data.get("status") in ("completed", "failed", "cancelled"):
                return _mcp_content(json.dumps(run_data, indent=2, default=str), run_data.get("status") == "failed")
        return _mcp_content(f"Run {run_id!r} did not complete within {timeout:.0f}s", is_error=True)

    # --- secrets ---
    if name == "secrets.list":
        data, s = await _api_call("GET", "/secrets", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "secrets.set":
        data, s = await _api_call("POST", f"/secrets/{_enc(a['key'])}", request, body={"value": a["value"]})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "secrets.delete":
        data, s = await _api_call("DELETE", f"/secrets/{_enc(a['key'])}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "secrets.test":
        data, s = await _api_call("POST", f"/secrets/{_enc(a['key'])}/test", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)

    # --- connections ---
    if name == "connections.list":
        data, s = await _api_call("GET", "/connections", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "connections.add_mcp":
        data, s = await _api_call("POST", "/connections/mcp", request, body=a)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "connections.delete":
        data, s = await _api_call("DELETE", f"/connections/{_enc(a['connection_id'])}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "connections.status":
        data, s = await _api_call("GET", f"/connections/{_enc(a['connection_id'])}/status", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "connections.test":
        data, s = await _api_call("POST", f"/connections/{_enc(a['connection_id'])}/test", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)

    # --- contexts ---
    if name == "contexts.list":
        data, s = await _api_call("GET", "/contexts", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "contexts.create":
        data, s = await _api_call("POST", f"/contexts/{_enc(a['name'])}", request, body={"writeable": a.get("writeable", False), "sensitive": a.get("sensitive", True)})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "contexts.read":
        encoded_path = "/".join(_enc(p) for p in a["path"].split("/"))
        data, s = await _api_call("GET", f"/contexts/{_enc(a['name'])}/files/{encoded_path}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "contexts.write":
        encoded_path = "/".join(_enc(p) for p in a["path"].split("/"))
        data, s = await _api_call("PUT", f"/contexts/{_enc(a['name'])}/files/{encoded_path}", request, body={"content": a["content"]})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "record_candidate_feedback":
        body = {k: a[k] for k in ("run_id", "candidate_id", "rank", "feedback_text", "outcome") if k in a}
        if "scope" in a:
            body["scope"] = a["scope"]
        if "reporter" in a:
            body["reporter"] = a["reporter"]
        data, s = await _api_call("POST", f"/contexts/{_enc(a['name'])}/record-candidate-feedback", request, body=body)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "contexts.delete":
        qs = "?force=true" if a.get("force") else ""
        data, s = await _api_call("DELETE", f"/contexts/{_enc(a['name'])}{qs}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "contexts.delete_file":
        encoded_path = "/".join(_enc(p) for p in a["path"].split("/"))
        data, s = await _api_call("DELETE", f"/contexts/{_enc(a['name'])}/files/{encoded_path}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "contexts.versions":
        data, s = await _api_call("GET", f"/contexts/{_enc(a['name'])}/versions", request, params={"limit": a.get("limit", 50)})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "contexts.rollback":
        data, s = await _api_call("POST", f"/contexts/{_enc(a['name'])}/rollback/{_enc(a['version_id'])}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)

    # --- triggers ---
    if name == "triggers.list":
        data, s = await _api_call("GET", "/integrations/triggers", request, params={"worker_id": a.get("worker_id"), "app": a.get("app")})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)

    # --- approvals ---
    if name == "approvals.list":
        data, s = await _api_call("GET", "/approvals", request, params={"limit": a.get("limit", 50)})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "approvals.approve":
        data, s = await _api_call("POST", f"/runs/{_enc(a['run_id'])}/approve", request, body={"comment": a.get("comment")})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "approvals.reject":
        data, s = await _api_call("POST", f"/runs/{_enc(a['run_id'])}/reject", request, body={"comment": a.get("comment")})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)

    # --- workspace ---
    if name == "workspace.chat":
        data, s = await _api_call("POST", "/chat", request, body={"message": a["message"], "source": "mcp", "conversation_id": a.get("conversation_id")})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workspace.instructions.get":
        data, s = await _api_call("GET", "/workspace", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workspace.instructions.set":
        data, s = await _api_call("PUT", "/workspace", request, body={"content": a["content"]})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workspace.versions":
        data, s = await _api_call("GET", "/workspace/versions", request, params={"limit": a.get("limit", 20)})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "workspace.rollback":
        data, s = await _api_call("POST", f"/workspace/rollback/{_enc(a['version_id'])}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)

    # --- system ---
    if name == "system.overview":
        data, s = await _api_call("GET", "/system/overview", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "system.stats":
        data, s = await _api_call("GET", "/stats", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "system.info":
        data, s = await _api_call("GET", "/system/info", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "system.alerts":
        data, s = await _api_call("GET", "/system/alerts", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)

    # --- integrations ---
    if name == "integrations.catalog":
        data, s = await _api_call("GET", "/integrations/catalog", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)

    # --- conversations ---
    if name == "conversations.list":
        data, s = await _api_call("GET", "/conversations", request, params={"limit": a.get("limit", 20)})
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)
    if name == "conversations.get":
        data, s = await _api_call("GET", f"/conversations/{_enc(a['id'])}", request)
        return _mcp_content(json.dumps(data, indent=2, default=str), s >= 400)

    # --- custom tools management ---
    if name == "tools_list":
        tools = repos.mcp_tools.list(user_id=auth.user_id)
        return _mcp_content(json.dumps(tools, indent=2, default=str))

    if name == "tools_register":
        tool_name = a.get("name", "")
        description = a.get("description", "")
        worker_ref = a.get("worker_id", "")
        input_schema = a.get("input_schema") or {}
        if not all([tool_name, description, worker_ref]):
            return _mcp_content("name, description, and worker_id are required", is_error=True)
        worker = repos.workers.get(user_id=auth.user_id, worker_id=worker_ref)
        if not worker:
            workers = repos.workers.list(user_id=auth.user_id)
            worker = next((w for w in workers if w["name"] == worker_ref), None)
        if not worker:
            return _mcp_content(f"Worker {worker_ref!r} not found", is_error=True)
        if repos.mcp_tools.get_by_name(user_id=auth.user_id, name=tool_name):
            return _mcp_content(f"Tool {tool_name!r} already exists — use tools_delete first to replace it", is_error=True)
        if not input_schema:
            input_schema = _mcp_input_schema_from_worker_record(worker)
        tool = repos.mcp_tools.create(
            user_id=auth.user_id,
            name=tool_name,
            description=description,
            input_schema=input_schema,
            worker_id=worker["id"],
        )
        return _mcp_content(json.dumps(tool, indent=2, default=str))

    if name == "tools_delete":
        tool_name = a.get("name", "")
        tool = repos.mcp_tools.get_by_name(user_id=auth.user_id, name=tool_name)
        if not tool:
            return _mcp_content(f"Tool {tool_name!r} not found", is_error=True)
        repos.mcp_tools.delete(user_id=auth.user_id, tool_id=tool["id"])
        return _mcp_content(f"Tool {tool_name!r} deleted")

    if name == "tools_update":
        tool_name = a.get("name", "")
        tool = repos.mcp_tools.get_by_name(user_id=auth.user_id, name=tool_name)
        if not tool:
            return _mcp_content(f"Tool {tool_name!r} not found", is_error=True)
        updates: dict = {}
        if a.get("description"):
            updates["description"] = a["description"]
        if a.get("input_schema"):
            updates["input_schema"] = a["input_schema"]
        if a.get("worker_id"):
            worker_ref = a["worker_id"]
            worker = repos.workers.get(user_id=auth.user_id, worker_id=worker_ref)
            if not worker:
                workers = repos.workers.list(user_id=auth.user_id)
                worker = next((w for w in workers if w["name"] == worker_ref), None)
            if not worker:
                return _mcp_content(f"Worker {worker_ref!r} not found", is_error=True)
            updates["worker_id"] = worker["id"]
        updated = repos.mcp_tools.update(user_id=auth.user_id, tool_id=tool["id"], **updates)
        return _mcp_content(json.dumps(updated, indent=2, default=str))

    # --- custom workspace tools — trigger backing worker, wait briefly, return output ---
    custom = repos.mcp_tools.get_by_name(user_id=auth.user_id, name=name)
    if custom:
        worker_id = custom["worker_id"]
        run_id = create_run(worker_id, a, "mcp", user_id=auth.user_id, repos=repos)
        start_run(run_id, worker_id, a, user_id=auth.user_id, repos=repos)
        # #835 RCA: this loop blocked the HTTP connection for up to 120s per
        # call — concurrent custom-tool calls exhausted the connection pool.
        # Fix: wait at most the shared 30s MCP cap so fast tools still return
        # their output inline; slow runs return the run_id (NOT an error) so
        # the client polls runs.get / runs.watch for the result.
        deadline = _time.monotonic() + _mcp_watch_timeout_seconds(None)
        run = None
        while _time.monotonic() < deadline:
            await asyncio.sleep(1.0)
            run = repos.runs.get(user_id=auth.user_id, run_id=run_id)
            if run and run["status"] in ("completed", "failed"):
                break
        if not run or run["status"] not in ("completed", "failed"):
            return _mcp_content(
                json.dumps(
                    {
                        "status": "running",
                        "run_id": run_id,
                        "detail": "Run still in progress. Poll runs.get or runs.watch with this run_id for the result.",
                    },
                    indent=2,
                ),
                is_error=False,
            )
        if run["status"] == "failed":
            return _mcp_content(run.get("error") or "Worker run failed", is_error=True)
        output = run.get("output_json") or run.get("output") or {}
        return _mcp_content(json.dumps(output, indent=2, default=str))

    return _mcp_content(f"Unknown tool: {name!r}", is_error=True)


async def _mcp_handle_request(
    body: dict,
    auth: AuthContext,
    repos: "Repositories",
    request: Request | None = None,
) -> dict:
    """Core MCP JSON-RPC 2.0 dispatcher. Called by /mcp-tools/serve and by the cloud /mcp/{workspace_id}."""
    rpc_id = body.get("id")
    method = body.get("method", "")
    params = body.get("params") or {}

    if method == "initialize":
        return _mcp_ok(rpc_id, {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "workeros", "version": "1.0.0"},
        })

    if method == "tools/list":
        custom = repos.mcp_tools.list(user_id=auth.user_id)
        # #833: only advertise tools this deployment serves and this caller
        # may invoke — same predicate tools/call enforces.
        tools = [
            t for t in _MCP_DEFAULT_TOOLS
            if _mcp_tool_served(t["name"]) and _mcp_access_error(t["name"], auth) is None
        ] + [
            {"name": t["name"], "description": t["description"], "inputSchema": t["input_schema"]}
            for t in custom
        ]
        return _mcp_ok(rpc_id, {"tools": tools})

    if method == "tools/call":
        if request is None:
            return _mcp_err(rpc_id, -32603, "Internal error: request context unavailable")
        tool_name = params.get("name", "")
        # #833: audit trail for every MCP tool invocation.
        logger.info(
            "mcp tools/call: tool=%r user=%s role=%s auth_method=%s",
            tool_name, auth.user_id, auth.role, auth.auth_method,
        )
        denied = _mcp_access_error(tool_name, auth)
        if denied is not None:
            return _mcp_ok(rpc_id, _mcp_content(denied, is_error=True))
        result = await _mcp_dispatch(
            tool_name,
            params.get("arguments") or {},
            auth,
            repos,
            request,
        )
        return _mcp_ok(rpc_id, result)

    return _mcp_err(rpc_id, -32601, f"Method not found: {method!r}")


@app.post("/mcp-tools/serve")
async def mcp_http_endpoint(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(_mcp_err(None, -32700, "Parse error"), status_code=400)
    return JSONResponse(await _mcp_handle_request(body, auth, repos, request))


# ---------------------------------------------------------------------------
# Multi-member: auth, users, personal access tokens (migration 59)
# ---------------------------------------------------------------------------

import secrets as _secrets_mod
from auth.multi_member import SESSION_COOKIE, _hash_token as _hash_pat

_SESSION_TTL_SECONDS = 7 * 24 * 3600  # 7 days
# Per-process fallback HMAC key for magic links when no env var is set (local dev only).
# Tokens signed with this key are valid only for the lifetime of the process.
_MAGIC_LINK_FALLBACK_SECRET: str = pysecrets.token_hex(32)

# #850: 12+ characters per NIST SP 800-63B (length over composition rules —
# arbitrary complexity requirements are intentionally omitted). 800-63B does
# call for rejecting commonly-used passwords, repetitive/sequential strings,
# and context-specific words (the username), so those checks are below.
# Applies to new/changed passwords only; existing shorter passwords keep
# working at login.
_MIN_PASSWORD_LENGTH = 12

# Starter blocklist: common breach-corpus passwords that pass the 12-char
# minimum. Compared lowercase.
_COMMON_PASSWORDS = frozenset({
    "password1234",
    "password12345",
    "password123456",
    "passwordpassword",
    "123456789012",
    "1234567890123",
    "12345678901234",
    "qwertyuiop123",
    "qwerty123456",
    "1q2w3e4r5t6y",
    "abc123456789",
    "iloveyou1234",
    "administrator",
    "adminpassword",
    "welcome123456",
    "letmein123456",
    "passw0rd1234",
})


def _is_sequential_password(lowered: str) -> bool:
    """True when every step is the same/next character (e.g. 123456789012,
    abcdefghijkl, aaaaaaaaaaaa)."""
    return all(0 <= ord(b) - ord(a) <= 1 for a, b in zip(lowered, lowered[1:]))


def _validate_new_password(password: str | None, *, username: str | None = None) -> None:
    if not password or len(password) < _MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"password must be at least {_MIN_PASSWORD_LENGTH} characters",
        )
    lowered = password.lower()
    if lowered in _COMMON_PASSWORDS or _is_sequential_password(lowered):
        raise HTTPException(
            status_code=422,
            detail="password is too common or predictable; choose something less guessable",
        )
    if username and len(username) >= 4 and username.lower() in lowered:
        raise HTTPException(
            status_code=422,
            detail="password must not contain your username",
        )


def _prune_expired_sessions(session_repo) -> None:
    # #849 RCA: SqliteUserSessionRepository.prune_expired existed but was never
    # called, so expired sessions accumulated forever. Called on every
    # session-creating endpoint (setup/login/magic-link) — those already hit
    # the DB, and pruning is one indexed DELETE. Best-effort: a prune failure
    # must never block a login.
    from datetime import datetime, timezone as _tz

    try:
        session_repo.prune_expired(now_iso=datetime.now(timezone.utc).isoformat())
    except Exception:
        logger.warning("session prune failed (non-fatal)", exc_info=True)


# #850: per-username lockout after repeated failed logins. The 5/min per-IP
# rate limit does not stop distributed credential-stuffing; this does. Keyed
# by username only (an attacker rotating IPs still locks out), which trades a
# bounded 15-minute targeted-DoS window for brute-force protection.
_FAILED_LOGIN_WINDOW_SECONDS = 15 * 60
_FAILED_LOGIN_LOCKOUT_THRESHOLD = 5
_failed_login_attempts: Dict[str, List[float]] = {}
_failed_login_lock = threading.Lock()


def _login_locked_out(username: str) -> bool:
    cutoff = time.time() - _FAILED_LOGIN_WINDOW_SECONDS
    with _failed_login_lock:
        attempts = [t for t in _failed_login_attempts.get(username, []) if t > cutoff]
        _failed_login_attempts[username] = attempts
        return len(attempts) >= _FAILED_LOGIN_LOCKOUT_THRESHOLD


def _record_failed_login(username: str) -> None:
    with _failed_login_lock:
        _failed_login_attempts.setdefault(username, []).append(time.time())


def _clear_failed_logins(username: str) -> None:
    with _failed_login_lock:
        _failed_login_attempts.pop(username, None)


def _session_cookie_secure() -> bool:
    return os.environ.get("WORKEROS_INSECURE_COOKIES") != "1"


def _set_session_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="lax",
        max_age=_SESSION_TTL_SECONDS,
        secure=_session_cookie_secure(),
    )


class _AuthSetupRequest(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None


class _LoginRequest(BaseModel):
    username: str
    password: str


class _UserOut(BaseModel):
    id: str
    username: str
    display_name: Optional[str] = None
    role: str
    disabled: bool
    created_at: str


class _UserCreateRequest(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None
    # #975: role is intentionally NOT accepted here. New users are always
    # created as 'member'; promotion to admin is a separate explicit PATCH
    # /users/{id} action (admin-gated, auditable). Accepting role at create
    # let an admin (or a CSRF #947 forced request) mint a backdoor admin in
    # one call with no audit trail.


class _UserUpdateRequest(BaseModel):
    display_name: Optional[str] = None
    role: Optional[str] = None
    disabled: Optional[bool] = None
    password: Optional[str] = None


class _PATOut(BaseModel):
    id: str
    name: str
    last_used_at: Optional[str] = None
    created_at: str
    expires_at: Optional[str] = None


class _PATCreateRequest(BaseModel):
    name: str
    expires_at: Optional[str] = None


class _PATCreateResponse(BaseModel):
    token: str  # raw value — shown once, never stored
    pat: _PATOut


def _bcrypt_hash(password: str) -> str:
    try:
        import bcrypt
        return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    except ImportError:
        raise HTTPException(status_code=500, detail="bcrypt not installed")


def _bcrypt_verify(password: str, hashed: str) -> bool:
    try:
        import bcrypt
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ImportError:
        return False


def _require_multi_member_repos(repos: Repositories):
    if repos.users is None or repos.sessions is None or repos.tokens is None:
        raise HTTPException(status_code=503, detail="multi-member not available")
    return repos.users, repos.sessions, repos.tokens


def _require_admin(auth: AuthContext) -> None:
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="admin required")


def _require_workspace_write(auth: AuthContext) -> None:
    """#804: workspace instructions (workspace.md / workspace.base.md) are admin-write.

    Members are read-only and get a server-enforced 403 — not merely a hidden UI.
    AI worker-authoring still works: run-token auth carries role="member" by design
    (see auth/multi_member.py), so allow auth_method=="run_token" through; those calls
    are what the handlers record as source="ai".
    """
    if auth.is_admin or auth.auth_method == "run_token":
        return
    raise HTTPException(status_code=403, detail="admin required to edit workspace instructions")


@app.post("/auth/setup", response_model=_UserOut, status_code=201)
def auth_setup(
    payload: _AuthSetupRequest,
    response: Response,
    repos: Repositories = Depends(get_repos),
) -> _UserOut:
    """Create the first admin account. Returns 409 if any user already exists."""
    user_repo, session_repo, _ = _require_multi_member_repos(repos)
    if user_repo.count() > 0:
        raise HTTPException(status_code=409, detail="workspace already set up")
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=422, detail="username required")
    password = payload.password
    _validate_new_password(password, username=username)
    if (
        (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower() == "local"
        and username == _bootstrap_user_id()
    ):
        user_id = username
    else:
        user_id = str(_uuid_mod.uuid4())
    pw_hash = _bcrypt_hash(password)
    row = user_repo.create(
        user_id=user_id,
        username=username,
        display_name=payload.display_name,
        password_hash=pw_hash,
        role="admin",
    )
    # Claim the bootstrap (local-default) identity's seed workers, connections,
    # and secrets for this first admin, so they OWN the seed data and can run it
    # (a run uses the owner's connections). Without this the admin owns nothing
    # and seed workers fail to run despite being visible. Non-fatal.
    try:
        _claimed = _claim_bootstrap_assets_for_new_admin(user_id, repos)
        if any(_claimed.values()):
            logger.info("claim-on-setup: first admin %s claimed %s", user_id, _claimed)
    except Exception:
        logger.warning("claim-on-setup failed (non-fatal)", exc_info=True)
    # Auto-login: issue a session cookie so the browser is immediately logged in
    _prune_expired_sessions(session_repo)  # #849
    session_id = _secrets_mod.token_urlsafe(32)
    from datetime import datetime, timedelta, timezone as _tz
    expires = (datetime.now(timezone.utc) + timedelta(seconds=_SESSION_TTL_SECONDS)).isoformat()
    session_repo.create(session_id=session_id, user_id=user_id, expires_at=expires)
    _set_session_cookie(response, session_id)
    return _UserOut(id=row["id"], username=row["username"], display_name=row.get("display_name"),
                    role=row["role"], disabled=bool(row["disabled"]), created_at=row["created_at"])


@app.post("/auth/login")
def auth_login(
    payload: _LoginRequest,
    response: Response,
    repos: Repositories = Depends(get_repos),
) -> dict:
    """Authenticate with username+password; sets a session cookie."""
    user_repo, session_repo, _ = _require_multi_member_repos(repos)
    username = payload.username
    # #850: per-username lockout — checked before the credential comparison so
    # a locked account does not keep burning bcrypt work for an attacker.
    if _login_locked_out(username):
        raise HTTPException(
            status_code=429,
            detail="too many failed login attempts; try again later",
        )
    user = user_repo.get_by_username(username=username)
    if user is None or not _bcrypt_verify(payload.password, user.get("password_hash") or ""):
        _record_failed_login(username)
        raise HTTPException(status_code=401, detail="invalid credentials")
    if user.get("disabled"):
        raise HTTPException(status_code=403, detail="account disabled")
    _clear_failed_logins(username)
    _prune_expired_sessions(session_repo)  # #849
    session_id = _secrets_mod.token_urlsafe(32)
    from datetime import datetime, timedelta, timezone as _tz
    expires = (datetime.now(timezone.utc) + timedelta(seconds=_SESSION_TTL_SECONDS)).isoformat()
    try:
        session_repo.create(session_id=session_id, user_id=user["id"], expires_at=expires)
    except ValueError:
        # #848: user was disabled between the credential check above and the
        # session insert (TOCTOU) — the atomic guard in create() caught it.
        raise HTTPException(status_code=403, detail="account disabled")
    _set_session_cookie(response, session_id)
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user.get("display_name"),
        "role": user["role"],
        "redirect_to": "/overview",
    }


@app.post("/auth/logout")
def auth_logout(
    request: Request,
    response: Response,
    repos: Repositories = Depends(get_repos),
) -> dict:
    """Invalidate the current session cookie."""
    session_id = request.cookies.get(SESSION_COOKIE)
    if session_id and repos.sessions is not None:
        try:
            repos.sessions.delete(session_id=session_id)
        except Exception:
            pass
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


def _magic_link_secret() -> str:
    """Return the HMAC key for magic-link tokens.

    Checks WORKEROS_MAGIC_LINK_SECRET first (dedicated key), then falls back to
    FLOOM_SECRET (shared operator secret). Never raises — falls back to a
    module-level random key so local installs without env vars still work.
    """
    return (
        os.environ.get("WORKEROS_MAGIC_LINK_SECRET", "").strip()
        or os.environ.get("FLOOM_SECRET", "").strip()
        or _MAGIC_LINK_FALLBACK_SECRET
    )


def _issue_magic_link(*, user_id: str, ttl_seconds: int = 900) -> str:
    """Issue a stateless HMAC-signed magic-link token for a user."""
    payload = {
        "user_id": user_id,
        "nonce": pysecrets.token_urlsafe(18),
        "exp": int(time.time()) + ttl_seconds,
    }
    encoded = _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = hmac.new(_magic_link_secret().encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def _validate_magic_link(token: str) -> str:
    """Validate a magic-link token and return the user_id. Raises HTTPException on failure."""
    try:
        encoded, signature = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid magic link") from exc
    expected = hmac.new(_magic_link_secret().encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=400, detail="Invalid magic link")
    try:
        payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid magic link") from exc
    if int(payload.get("exp") or 0) < int(time.time()):
        raise HTTPException(status_code=400, detail="Magic link expired")
    user_id = str(payload.get("user_id") or "")
    if not user_id:
        raise HTTPException(status_code=400, detail="Invalid magic link")
    return user_id


@app.post("/auth/magic-link")
def auth_issue_magic_link(
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    """Issue a one-time sign-in URL for the authenticated user (multi-member mode only)."""
    # #917: the per-process random fallback key makes links unverifiable after
    # a restart and ties a security-critical signing key to process lifetime.
    # Refuse issuance instead of silently minting links only this process can
    # validate; consumption of already-issued links is unaffected.
    if _magic_link_secret() is _MAGIC_LINK_FALLBACK_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Magic links require WORKEROS_MAGIC_LINK_SECRET or FLOOM_SECRET to be configured",
        )
    token = _issue_magic_link(user_id=auth.user_id)
    url = f"{_frontend_base_url()}/auth/magic/{token}"
    return {"url": url, "expires_in": 900}


@app.get("/auth/magic/{token}")
def auth_consume_magic_link(
    token: str,
    response: Response,
    repos: Repositories = Depends(get_repos),
) -> dict:
    """Consume a magic-link token and create a session (multi-member mode only)."""
    user_id = _validate_magic_link(token)
    try:
        user_repo, session_repo, _ = _require_multi_member_repos(repos)
    except HTTPException:
        raise HTTPException(status_code=400, detail="Magic links require multi-member auth mode")
    user = user_repo.get(user_id=user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.get("disabled"):
        raise HTTPException(status_code=403, detail="Account disabled")
    _prune_expired_sessions(session_repo)  # #849
    from datetime import datetime, timedelta, timezone as _tz
    session_id = pysecrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(seconds=_SESSION_TTL_SECONDS)).isoformat()
    try:
        session_repo.create(session_id=session_id, user_id=user_id, expires_at=expires)
    except ValueError:
        # #848: user was disabled between the check above and the session
        # insert (TOCTOU) — the atomic guard in create() caught it.
        raise HTTPException(status_code=403, detail="Account disabled")
    _set_session_cookie(response, session_id)
    return {"ok": True, "redirect_to": "/overview"}


@app.get("/auth/me")
def auth_me(auth: AuthContext = Depends(get_auth_context)) -> dict:
    """Return the current authenticated user's profile."""
    return {
        "user_id": auth.user_id,
        "username": auth.username,
        "role": auth.role,
        "auth_method": auth.auth_method,
        "is_admin": auth.is_admin,
    }


class _UserSettings(BaseModel):
    theme: Literal["day", "dark", "system"] = "system"
    accent: Optional[str] = None


class _UserSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    theme: Optional[Literal["day", "dark", "system"]] = None
    accent: Optional[str] = None


@app.get("/user/settings", response_model=_UserSettings)
def get_user_settings(auth: AuthContext = Depends(get_auth_context)) -> _UserSettings:
    """#773: per-user appearance prefs (theme/accent), scoped to the caller."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT theme, accent FROM user_settings WHERE user_id = ?",
            (auth.user_id,),
        ).fetchone()
    if row is None:
        return _UserSettings()
    return _UserSettings(theme=row["theme"] or "system", accent=row["accent"])


@app.put("/user/settings", response_model=_UserSettings)
def put_user_settings(
    payload: _UserSettingsUpdate,
    auth: AuthContext = Depends(get_auth_context),
) -> _UserSettings:
    """#773: upsert the caller's appearance prefs. Partial — only provided
    fields change."""
    with get_db() as conn:
        existing = conn.execute(
            "SELECT theme, accent FROM user_settings WHERE user_id = ?",
            (auth.user_id,),
        ).fetchone()
        theme = payload.theme if payload.theme is not None else (existing["theme"] if existing else "system")
        accent = payload.accent if payload.accent is not None else (existing["accent"] if existing else None)
        conn.execute(
            """
            INSERT INTO user_settings (user_id, theme, accent, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme,
                accent = excluded.accent, updated_at = excluded.updated_at
            """,
            (auth.user_id, theme, accent, now_iso()),
        )
    return _UserSettings(theme=theme, accent=accent)


@app.get("/auth/setup-required")
def auth_setup_required(repos: Repositories = Depends(get_repos)) -> dict:
    """Public endpoint — returns whether the workspace needs initial setup.

    Used by the login page to decide whether to show the setup form.
    """
    if repos.users is None:
        return {"required": False}
    return {"required": repos.users.count() == 0}


# --- User management (admin only) ---


@app.get("/users", response_model=List[_UserOut])
def list_users(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[_UserOut]:
    _require_admin(auth)
    user_repo, _, _ = _require_multi_member_repos(repos)
    rows = user_repo.list()
    return [_UserOut(id=r["id"], username=r["username"], display_name=r.get("display_name"),
                     role=r["role"], disabled=bool(r["disabled"]), created_at=r["created_at"]) for r in rows]


@app.post("/users", response_model=_UserOut, status_code=201)
def create_user(
    payload: _UserCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _UserOut:
    _require_admin(auth)
    user_repo, _, _ = _require_multi_member_repos(repos)
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=422, detail="username required")
    _validate_new_password(payload.password, username=username)
    if user_repo.get_by_username(username=username) is not None:
        raise HTTPException(status_code=409, detail="username already taken")
    user_id = str(_uuid_mod.uuid4())
    pw_hash = _bcrypt_hash(payload.password)
    # #975: always 'member' regardless of any role in the request body.
    row = user_repo.create(
        user_id=user_id,
        username=username,
        display_name=payload.display_name,
        password_hash=pw_hash,
        role="member",
    )
    return _UserOut(id=row["id"], username=row["username"], display_name=row.get("display_name"),
                    role=row["role"], disabled=bool(row["disabled"]), created_at=row["created_at"])


@app.patch("/users/{uid}", response_model=_UserOut)
def update_user(
    uid: str = PathParam(...),
    payload: _UserUpdateRequest = Body(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _UserOut:
    _require_admin(auth)
    user_repo, _, _ = _require_multi_member_repos(repos)
    updates: dict = {}
    if payload.display_name is not None:
        updates["display_name"] = payload.display_name
    if payload.role is not None:
        if payload.role not in ("admin", "member"):
            raise HTTPException(status_code=422, detail="role must be admin or member")
        updates["role"] = payload.role
    if payload.disabled is not None:
        updates["disabled"] = 1 if payload.disabled else 0
    if payload.password is not None:
        existing_user = user_repo.get(user_id=uid)
        _validate_new_password(
            payload.password,
            username=(existing_user or {}).get("username"),
        )
        updates["password_hash"] = _bcrypt_hash(payload.password)
    # #976: never let the LAST active admin be disabled or demoted — that
    # permanently locks the workspace out with no self-service recovery.
    # Guard fires for self-disable AND for demoting another admin when no
    # other active admin would remain.
    _would_disable = updates.get("disabled") == 1
    _would_demote = updates.get("role") == "member"
    if _would_disable or _would_demote:
        target = user_repo.get(user_id=uid)
        if target is None:
            raise HTTPException(status_code=404, detail="user not found")
        if str(target.get("role")) == "admin" and not bool(target.get("disabled")):
            other_active_admins = [
                u for u in user_repo.list()
                if str(u.get("role")) == "admin"
                and not bool(u.get("disabled"))
                and u.get("id") != uid
            ]
            if not other_active_admins:
                raise HTTPException(
                    status_code=409,
                    detail="At least one active admin is required; "
                           "promote another admin before disabling or demoting this one.",
                )
    row = user_repo.update(user_id=uid, **updates)
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")
    return _UserOut(id=row["id"], username=row["username"], display_name=row.get("display_name"),
                    role=row["role"], disabled=bool(row["disabled"]), created_at=row["created_at"])


@app.delete("/users/{uid}", status_code=204)
def delete_user(
    uid: str = PathParam(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> None:
    _require_admin(auth)
    user_repo, _, _ = _require_multi_member_repos(repos)
    if uid == auth.user_id:
        raise HTTPException(status_code=400, detail="cannot delete your own account")
    if not user_repo.delete(user_id=uid):
        raise HTTPException(status_code=404, detail="user not found")
    # #915: cli_api_tokens has no FK cascade to users — revoke explicitly so a
    # deleted user's CLI tokens can't outlive the account. (The auth provider
    # also rejects tokens for missing users; this keeps the table clean.)
    try:
        with get_db() as conn:
            conn.execute(
                "UPDATE cli_api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
                (now_iso(), uid),
            )
    except Exception:
        logger.exception("failed to revoke CLI tokens for deleted user %s", uid)


# --- Personal access tokens (current user) ---


@app.get("/auth/tokens", response_model=List[_PATOut])
def list_tokens(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[_PATOut]:
    _, _, token_repo = _require_multi_member_repos(repos)
    rows = token_repo.list(user_id=auth.user_id)
    return [_PATOut(**{k: r[k] for k in ("id", "name", "last_used_at", "created_at", "expires_at")}) for r in rows]


@app.post("/auth/tokens", response_model=_PATCreateResponse, status_code=201)
def create_token(
    payload: _PATCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _PATCreateResponse:
    _, _, token_repo = _require_multi_member_repos(repos)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="token name required")
    # #924/#949: tokens are bounded by default — no more accidental forever-keys.
    expires_at = _enforce_token_ttl_cap(payload.expires_at)
    raw = "wos_" + _secrets_mod.token_urlsafe(32)
    token_hash = _hash_pat(raw)
    token_id = str(_uuid_mod.uuid4())
    try:
        row = token_repo.create(
            token_id=token_id,
            user_id=auth.user_id,
            name=name,
            token_hash=token_hash,
            expires_at=expires_at,
        )
    except Exception as _pat_exc:
        # FK constraint failure means auth.user_id has no row in the users
        # table — this happens in dev mode (ghost auth, no setup done).
        # Surface a clear 409 rather than a raw 500.
        import sqlite3 as _sqlite3
        if isinstance(_pat_exc, _sqlite3.IntegrityError):
            raise HTTPException(
                status_code=409,
                detail="Personal access tokens require a real user account. "
                       "Complete workspace setup at /login first.",
            ) from _pat_exc
        raise
    logger.info(
        "PAT created: user=%s name=%r expires_at=%s", auth.user_id, name, expires_at
    )
    pat = _PATOut(**{k: row[k] for k in ("id", "name", "last_used_at", "created_at", "expires_at")})
    return _PATCreateResponse(token=raw, pat=pat)


@app.delete("/auth/tokens/{token_id}", status_code=204)
def delete_token(
    token_id: str = PathParam(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> None:
    _, _, token_repo = _require_multi_member_repos(repos)
    if not token_repo.delete(token_id=token_id, user_id=auth.user_id):
        raise HTTPException(status_code=404, detail="token not found")


# ---------------------------------------------------------------------------
# Workspace API tokens — admin-minted; authenticate as the synthetic workspace
# actor (member role): read+run on workspace-shared workers ONLY, no private
# workers (including the minter's own), no mutations (middleware-gated).
# ---------------------------------------------------------------------------

class _WorkspaceTokenOut(BaseModel):
    id: str
    name: str
    created_by: str
    created_at: str
    last_used_at: Optional[str] = None
    expires_at: Optional[str] = None
    revoked_at: Optional[str] = None


class _WorkspaceTokenCreateRequest(BaseModel):
    name: str
    expires_at: Optional[str] = None


class _WorkspaceTokenCreateResponse(BaseModel):
    id: str
    name: str
    token: str  # shown ONCE; only the hash is stored
    expires_at: Optional[str] = None


def _require_workspace_admin(auth: AuthContext) -> None:
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="workspace tokens are admin-only")


@app.get("/workspace/tokens", response_model=List[_WorkspaceTokenOut])
def list_workspace_tokens(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> List[_WorkspaceTokenOut]:
    _require_workspace_admin(auth)
    workspace_id = _active_workspace_id(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, created_by, created_at, last_used_at, expires_at, revoked_at "
            "FROM workspace_api_tokens WHERE workspace_id = ? ORDER BY created_at DESC",
            (workspace_id,),
        ).fetchall()
    return [_WorkspaceTokenOut(**dict(r)) for r in rows]


@app.post("/workspace/tokens", response_model=_WorkspaceTokenCreateResponse, status_code=201)
def create_workspace_token(
    payload: _WorkspaceTokenCreateRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> _WorkspaceTokenCreateResponse:
    _require_workspace_admin(auth)
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="token name required")
    expires_at = _enforce_token_ttl_cap(payload.expires_at)
    workspace_id = _active_workspace_id(request)
    raw = "wst_" + _secrets_mod.token_urlsafe(32)
    token_id = str(_uuid_mod.uuid4())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO workspace_api_tokens "
            "(id, workspace_id, name, token_hash, created_by, created_at, expires_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (token_id, workspace_id, name, _hash_pat(raw), auth.user_id, now_iso(), expires_at),
        )
    logger.info(
        "workspace token created: workspace=%s name=%r by=%s expires_at=%s",
        workspace_id, name, auth.user_id, expires_at,
    )
    return _WorkspaceTokenCreateResponse(id=token_id, name=name, token=raw, expires_at=expires_at)


@app.delete("/workspace/tokens/{token_id}", status_code=204)
def revoke_workspace_token(
    token_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> None:
    _require_workspace_admin(auth)
    workspace_id = _active_workspace_id(request)
    with get_db() as conn:
        updated = conn.execute(
            "UPDATE workspace_api_tokens SET revoked_at = ? "
            "WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL",
            (now_iso(), token_id, workspace_id),
        ).rowcount
    if not updated:
        raise HTTPException(status_code=404, detail="token not found")


# ---------------------------------------------------------------------------
# Workspace secrets — admin-set credential rows stored under the synthetic
# workspace actor; workspace-shared (donated) workers resolve against these.
# ---------------------------------------------------------------------------

@app.get("/workspace/secrets")
def list_workspace_secrets(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[Dict[str, Any]]:
    _require_workspace_admin(auth)
    from db.sqlite import workspace_actor_id

    actor = workspace_actor_id(_active_workspace_id(request))
    rows = repos.secrets.list(user_id=actor)
    # names + status only, never values
    return [{"name": r.get("name"), "status": r.get("status"), "updated_at": r.get("updated_at")} for r in rows]


class _WorkspaceSecretWrite(BaseModel):
    value: str


@app.post("/workspace/secrets/{name}", status_code=200)
def set_workspace_secret(
    name: str,
    payload: _WorkspaceSecretWrite,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    _require_workspace_admin(auth)
    from db.sqlite import workspace_actor_id

    actor = workspace_actor_id(_active_workspace_id(request))
    repos.secrets.set(user_id=actor, name=name, value=payload.value)
    logger.info("workspace secret %r set by %s (value not logged)", name, auth.user_id)
    return {"ok": True, "name": name}


@app.delete("/workspace/secrets/{name}", status_code=204)
def delete_workspace_secret(
    name: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> None:
    _require_workspace_admin(auth)
    from db.sqlite import workspace_actor_id

    actor = workspace_actor_id(_active_workspace_id(request))
    delete = getattr(repos.secrets, "delete", None)
    if delete is None:
        raise HTTPException(status_code=501, detail="secret delete not available")
    delete(user_id=actor, name=name)


class _WorkspaceSettingValue(BaseModel):
    value: str = Field(..., max_length=4000)


def _active_workspace_id(request: Request) -> str:
    return requested_local_workspace_id(request) or DEFAULT_WORKSPACE_ID


@app.get("/workspace/settings")
def get_workspace_settings(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, str]:
    """#794/#797: workspace behaviour toggles + model defaults (key→value map).

    Also surfaces the read-only `current_month_spend_usd` (#797) so the Settings
    System tab can render spend-against-cap without a separate fetch.
    """
    ws = _active_workspace_id(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT key, value FROM workspace_settings WHERE workspace_id = ?", (ws,)
        ).fetchall()
    out = {str(r["key"]): str(r["value"]) for r in rows}
    try:
        from run_service import _workspace_month_to_date_cost_usd

        out["current_month_spend_usd"] = f"{_workspace_month_to_date_cost_usd():.4f}"
    except Exception:
        pass
    return out


@app.put("/workspace/settings/{key}", status_code=204)
def put_workspace_setting(
    key: str,
    body: _WorkspaceSettingValue,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> None:
    """#794/#797: upsert a workspace setting. Admin-guarded (the #804 model:
    members must not change workspace behaviour, enforced server-side)."""
    _require_workspace_write(auth)
    if not key or len(key) > 64:
        raise HTTPException(status_code=422, detail="invalid setting key")
    ws = _active_workspace_id(request)
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO workspace_settings (workspace_id, key, value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (ws, key, body.value, now_iso()),
        )


@app.post("/auth/tokens/{token_id}/rotate", response_model=_PATCreateResponse)
def rotate_token(
    token_id: str = PathParam(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _PATCreateResponse:
    """#784: rotate a PAT in place — issues a fresh raw value while keeping the
    same token id/name. The old value stops working immediately; the new value
    is shown once."""
    _, _, token_repo = _require_multi_member_repos(repos)
    raw = "wos_" + _secrets_mod.token_urlsafe(32)
    row = token_repo.rotate(token_id=token_id, user_id=auth.user_id, token_hash=_hash_pat(raw))
    if row is None:
        raise HTTPException(status_code=404, detail="token not found")
    pat = _PATOut(**{k: row[k] for k in ("id", "name", "last_used_at", "created_at", "expires_at")})
    return _PATCreateResponse(token=raw, pat=pat)


if __name__ == "__main__":
    import uvicorn
    from pathlib import Path as _Path

    # Exclude runtime-written dirs from the reload watcher. The runner stages a
    # per-run bundle at data/run-bundles/<run_id>/run.py on every execution; since
    # data/ lives under this dir (the watched cwd), each run would otherwise trip
    # WatchFiles and restart the API mid-run (interrupted_by_restart). Worker
    # bundles in WORKERS_DIR are likewise data, not source. Paths must be absolute
    # because watchfiles yields absolute paths and uvicorn matches exclude *dirs*
    # via `exclude_dir in path.parents`.
    _api_dir = _Path(__file__).resolve().parent
    _reload_excludes = [str(_api_dir / "data")]
    try:
        from worker_registry import WORKERS_DIR as _WORKERS_DIR
        _reload_excludes.append(str(_Path(_WORKERS_DIR).resolve()))
    except Exception:
        pass
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_excludes=_reload_excludes,
    )
