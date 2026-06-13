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
from typing import Annotated, Any, Dict, Iterable, List, Literal, NotRequired, Optional, TypedDict

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
from auth.guards import _require_admin, _require_workspace_write
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
    VersionSummary,
    AssetPermissions,
    RunCreate,
    WorkerVisibilityUpdate,
    WorkerSummary,
    WorkerDetail,
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

# Git workspace + commit-identity helpers live in services.git_service; re-export
# for the many call sites in this module and for backward compatibility.
from services.git_service import (
    _git_workspace,
    _git_author,
    _git_ops_lock,
    _ensure_git_workspace_ready,
    _WORKSPACE_TOOLS_FILENAME,
    _sync_workspace_tools_yml,
    _workers_git_prefix,
)

# Env-file secret IO + platform-secret specs live in services.secrets_env;
# re-exported for the secrets/settings routes still in main, channels/slack,
# and tests importing them from `main`.
from services.secrets_env import (
    _env_file_path,
    _ENV_PATH,
    _secret_value_has_control_chars,
    _read_env_lines,
    _write_env_lines,
    _upsert_env_var,
    _delete_env_var,
    PlatformSecretSpec,
    PLATFORM_SECRET_SPECS,
    INFRA_PATH_SPECS,
    PLATFORM_SECRETS,
    _available_secret_names_for_user,
)

# GitHub workspace config + encrypted secrets vault live in services.git_service;
# re-exported for the /system/git routes, startup restore, and tests. Cloud
# registers its Supabase key resolver via the re-exported setter (which mutates
# the service module's global, keeping one source of truth).
from services.git_service import (
    _git_workspace_key,
    _git_cfg_get,
    _git_cfg_upsert,
    _git_cfg_delete,
    _SECRETS_ENC_FILENAME,
    set_secrets_key_resolver,
    _LOCAL_KEY_PATH,
    _get_or_create_secrets_key,
    _encrypt_secrets_blob,
    _decrypt_secrets_blob,
    _sync_secrets_to_enc,
    _load_secrets_from_enc,
    _load_workspace_tools_yml,
)

# Upload pipeline (validation/quota/signing/blob GC) lives in services.uploads;
# re-exported here for the approval upload routes, runs artifact ownership
# checks, _gc_orphan_blobs, and approval public-link signing still in main.
from services.uploads import (
    _DEFAULT_UPLOAD_MAX_BYTES,
    _DEFAULT_UPLOAD_HOURLY_CAP_BYTES,
    _UPLOAD_HOURLY_WINDOW_SECONDS,
    _UPLOAD_ALLOWED_MEDIA_TYPES,
    _UPLOAD_ALLOWED_EXTENSIONS,
    _UPLOAD_DANGEROUS_MEDIA_TYPES,
    _UPLOAD_BLOCKED_EXTENSIONS,
    _upload_quota_lock,
    _upload_quota_store,
    _upload_max_bytes,
    _upload_hourly_cap_bytes,
    _format_bytes,
    _upload_quota_key,
    _claim_upload_quota,
    _validate_upload_filename,
    _upload_url_ttl_seconds,
    _upload_signing_key,
    _b64url_encode,
    _b64url_decode,
    _make_upload_download_token,
    _verify_upload_download_token,
    _user_owns_uploaded_file,
    _parse_accepts,
    _delete_blob_file,
    _store_uploaded_blob,
)

# Small pure utilities live in core.utils; re-exported for this module's call
# sites and for channels/* + tests that import them from `main`.
from core.utils import row_to_dict, _parse_iso8601, _positive_int_env
# Public base-URL resolvers live in core.urls; re-exported for call sites here.
from core.urls import (
    _short_link_base_url,
    _public_api_base_url,
    _frontend_base_url,
    _api_public_base,
    _frontend_public_base,
)
# Client-IP / trusted-proxy resolution lives in core.net; re-exported for the
# rate-limit + auth middleware and the cli-auth/audit call sites.
from core.net import _client_ip, _trusted_proxy_peer, _valid_ip_literal

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

load_dotenv()
try:
    api_env_path = Path.home() / ".config" / "workeros" / "api.env"
    if api_env_path.is_file():
        load_dotenv(api_env_path, override=False)
except OSError:
    pass
init_db()

# Configuration constants live in core.config. They are re-exported here for
# backward compatibility with the many modules and tests that import them from
# `main` (e.g. `from main import PROTECTED_STOCK_WORKER_IDS`).
from core.config import (
    API_VERSION,
    _PROCESS_START_TIME,
    _PROCESS_STARTED_AT,
    PUBLIC_SHARE_TEXT_PREVIEW_LIMIT,
    DEFAULT_JSON_BODY_LIMIT_BYTES,
    FROM_BUNDLE_BODY_LIMIT_BYTES,
    DEFAULT_CONTEXT_UPLOAD_LIMIT_BYTES,
    WORKSPACE_IMPORT_BODY_LIMIT_BYTES,
    DEFAULT_CHAT_MESSAGE_MAX_CHARS,
    DEFAULT_RATE_LIMIT,
    BODYLESS_METHODS,
    RATE_LIMIT_RULES,
    PROTECTED_STOCK_WORKER_IDS,
    PUBLIC_STOCK_WORKER_IDS,
    _SYSTEM_WORKER_IDS,
    _INTERNAL_WORKER_ID_PREFIXES,
    SYSTEM_CONTEXT_PACKS,
    SYSTEM_CONTEXT_DESCRIPTIONS,
    _is_cloud_deploy,
    _user_scoped_local_mode,
    _bootstrap_user_id,
    _WORKER_AUTHOR_ID,
)

# Worker access-control + visibility cluster lives in services.worker_access;
# re-exported here for this module's call sites and backward compatibility.
from services.worker_mutation import (
    _require_worker_write_workspace_context,
    _set_worker_enabled,
    _set_db_manifest_archived,
    _patch_worker_yml_field,
    _set_worker_yml_is_example,
    _raw_worker_id_from_worker_yml,
    _validate_worker_file_path,
    _toggle_worker_star,
    _reload_workers_for_user,
    _mutate_worker_contexts,
)
from services.worker_registry_ops import (
    DraftFile,
    _git_join,
    _skill_version_id,
    _rewrite_worker_yml_id,
    _redacted_validation_errors,
    _should_embed_file,
    _extract_triggers_from_manifest,
    _free_worker_id,
    _parse_worker_payload,
    _SENSITIVE_FILE_NAMES,
    _SENSITIVE_FILE_SUFFIXES,
    _git_commit_worker,
    _embed_files_in_skill_version,
    _register_worker_from_files,
    _persist_discovered_workers,
    _ensure_worker_row_for_rotation,
)
from services.worker_serialize import (
    _get_timeseries_batch,
    _language_for_path,
    _should_ignore_worker_file,
    _worker_public_payload,
    _worker_public_token,
    _worker_public_link,
    _worker_bundle_dir,
    _get_stats_batch,
    _worker_has_webhook_trigger,
    _build_triggers_spec,
    _resolve_worker_status,
    _read_worker_files,
    _worker_files_from_manifest,
    _build_worker_detail,
    _DEFAULT_RUN_PY_STUB,
    _WORKER_FILE_IGNORE,
)
from services.worker_access import (
    _raise_if_protected_worker_mutation,
    _canonical_worker_id,
    _slugify_worker_id,
    _shared_filesystem_fallback_allowed,
    _tracked_worker_ids,
    _worker_hidden_from_api,
    _visibility_role,
    _db_worker_owners,
    _granted_asset_ids,
    _granted_worker_ids,
    _get_db_worker,
    _archived_tracked_worker,
    _get_visible_worker,
    _worker_permissions,
    _list_db_workers,
    _worker_access_user_id,
    _normalize_run_status,
    _available_connection_slugs_for_user,
    _normalize_trigger_type,
    _trigger_label,
    _list_operator_workers,
    _worker_required_secret_names,
    _worker_connection_slugs,
    _worker_repo_role,
    _build_owned_tracked_ids,
    _worker_source_visible_to_api,
    _stock_workers_from_filesystem,
    _list_visible_workers,
    _delete_worker_impl,
)

# Run visibility + artifact-serving access helpers (shared by runs + approvals).
from services.run_access import (
    _run_visible_to_api,
    _get_visible_run,
    _sanitize_download_name,
    _SENSITIVE_ARTIFACT_FILENAMES,
    _is_sensitive_artifact_name,
    _is_sensitive_artifact_row,
    _artifact_file_response,
    _OPERATOR_REACHABLE_HIDDEN_WORKER_IDS,
    _get_run_by_explicit_id,
    _OPERATOR_TRIGGER_SOURCES,
    _is_operator_run,
    _list_visible_runs,
)
from services.run_serialize import (
    _resolve_run_status_filters,
    _read_transcript_rows,
    _extract_total_tokens_from_transcript,
    _parse_tool_calls_from_transcript,
    _make_run_summary,
    _extract_primary_output_file,
)
from services.share_links import (
    _standalone_share_url,
    _mint_standalone_share_token,
    _ensure_standalone_share_links_table,
    _load_standalone_share_row,
    _create_or_get_standalone_share_link,
    _revoke_standalone_share_link,
)

# Context (knowledge-pack) access-control + serialization cluster lives in
# services.context_access; re-exported here for this module's call sites.
from services.context_access import (
    _system_context_description,
    _context_name_or_400,
    _context_file_path_or_400,
    _safe_context_file_or_400,
    _unowned_contexts_visible_to_caller,
    _is_system_context_pack,
    _context_visible_to_user,
    _require_context_for_user,
    _ensure_assistant_row,
    _assistant_access,
    _context_worker_counts,
    _ensure_brain_pack_row,
    _brain_pack_access,
    _brain_pack_visibility,
    _context_summary,
    _context_description,
    _workers_referencing_context,
)

# Public-facing redaction + SSE event shaping cluster lives in
# services.public_view; re-exported here for this module's call sites and for
# tests that read the redaction constants/headlines via the `main` module.
from services.public_view import (
    _sanitize_operator_text,
    _INTERNAL_LOG_TOKEN_RE,
    _LOG_METADATA_RE,
    _MISSING_SECRETS_RE,
    _ENV_SECRET_CONFIG_RE,
    _CALM_CODE_ERROR_LOG,
    _TRACEBACK_FRAME_LINE_RE,
    _TRACEBACK_HEADER_RE,
    _CARET_ONLY_RE,
    _COMMAND_EXIT_RE,
    _E2B_LOG_PREFIX_RE,
    _SANDBOX_PATH_RE,
    _ENV_VAR_NAME_RE,
    _GIT_BRANCH_RE,
    _TIMEOUT_HEADLINE,
    _RUNTIME_HEADLINE,
    _CONNECTION_HEADLINE,
    _AUTH_HEADLINE,
    _INPUT_HEADLINE,
    _SECRET_HEADLINE,
    _OUTPUT_HEADLINE,
    _CODE_HEADLINE,
    _CANCELLED_HEADLINE,
    _OPERATOR_ERROR_CODE_HEADLINES,
    _OPERATOR_ERROR_GENERIC,
    _OPERATOR_ERROR_RULES,
    _WORKER_CODE_TRACEBACK_RE,
    _BARE_PYTHON_EXC_MSG_RE,
    _WORKER_CODE_ERROR_CODES,
    _SMOKE_REASON_CODE_RE,
    _SMOKE_REASON_LEADING_CODE_RE,
    _RUNTIME_JARGON_RE,
    _e2b_log_content,
    _is_caret_marker_line,
    _is_command_exit_line,
    _collapse_stderr_code_echo_rows,
    _redact_runtime_jargon_in_log,
    _redact_public_log_message,
    _public_artifact_path,
    _looks_like_worker_code_error,
    _has_internal_artifact,
    _operator_error_message,
    humanize_smoke_reason,
    _looks_like_runtime_jargon,
    _run_error_raw,
    _public_error_field,
    _run_event_metadata,
    _public_sse_event,
    _public_run_part,
)

# SSE pub/sub for live run streaming lives in services.sse_streaming. Its module
# state (consumer queues, replay buffers) and helpers are re-exported here for the
# streaming route handlers and lifespan publisher registration. _TERMINAL_STATUSES
# also lives there now and is re-exported (public_view imports it lazily from main).
from services.quota import (
    _run_create_quota_config,
    _run_create_per_worker_limit,
    _run_replay_per_run_limit,
    _chat_quota_config,
    _claim_run_create_quota_slot,
    _raise_run_create_quota,
    _enforce_run_create_quota,
    _enforce_run_replay_quota,
    _enforce_chat_quota,
)
from services.sse_streaming import (
    _sse_queues,
    _sse_lock,
    _run_part_buffers,
    _run_part_cleanup_timers,
    _run_part_lock,
    _RUN_PART_TTL_SECONDS,
    _TERMINAL_STATUSES,
    _sse_user_stream_counts,
    _sse_stream_count_lock,
    _max_concurrent_streams,
    _sse_stream_acquire,
    _sse_stream_release,
    _sse_publish,
    _sse_cleanup,
    _run_part_state,
    _run_part_is_finish,
    _cancel_run_part_cleanup,
    _schedule_run_part_cleanup,
    _run_part_publish,
    _run_part_register,
    _run_part_cleanup,
    _run_part_snapshot,
    _format_run_part_sse,
    _parse_last_event_id,
    _finish_part_from_run_row,
    _log_replay_parts,
)

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
    version=API_VERSION,
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

_worker_create_locks_guard = threading.Lock()
_worker_create_locks: Dict[str, threading.Lock] = {}


def _acquire_worker_create_lock(worker_id: str) -> threading.Lock:
    with _worker_create_locks_guard:
        lock = _worker_create_locks.get(worker_id)
        if lock is None:
            lock = threading.Lock()
            _worker_create_locks[worker_id] = lock
    lock.acquire()
    return lock


# 1.5.2: trigger sources that belong in the operator /runs view. Everything
# else (audit, test, smoke runs like s35_concurrency_*, synthetic data, etc.)
# is internal telemetry and is hidden from the default view. Data is preserved
# and reachable via GET /runs?include_system=true.




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


async def require_secret(request: Request) -> str:
    """DEPRECATED: use Depends(get_auth_context) instead."""
    ctx = await get_auth_context(request)
    return ctx.user_id




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




def _rate_limit_for_path(path: str) -> tuple[int, float]:
    for pattern, limit in RATE_LIMIT_RULES:
        if pattern.fullmatch(path):
            return limit
    return DEFAULT_RATE_LIMIT


def _body_limit_for_request(request: Request) -> Optional[int]:
    method = request.method.upper()
    if method not in {"POST", "PUT", "PATCH"}:
        return None
    path = request.url.path
    if path == "/workers/from-bundle":
        return FROM_BUNDLE_BODY_LIMIT_BYTES
    if path == "/workspace/import":
        return WORKSPACE_IMPORT_BODY_LIMIT_BYTES
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
    return DEFAULT_JSON_BODY_LIMIT_BYTES


def _is_context_upload_request(request: Request) -> bool:
    path = request.url.path
    return (
        request.method.upper() == "POST"
        and path.startswith("/contexts/")
        and path.endswith("/upload")
    )


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
            worker_call_payload = validate_worker_call_token(bearer_token_header, secret=secret)
        except ValueError as exc:
            return _JSONResponse(status_code=401, content={"detail": str(exc)})
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
    return "worker_call", parent_run_id


def _worker_call_token_allows_request(
    *,
    path: str,
    method: str,
    token_payload: Dict[str, Any],
    repos: Any | None = None,
) -> bool:
    """Allow worker-call bearer tokens only on child creation and child polling."""
    if method == "POST" and _RE_WORKER_RUN_CREATE.match(path):
        return True
    run_match = _RE_RUN_DETAIL.match(path)
    if method != "GET" or run_match is None or repos is None:
        return False
    run_row = repos.runs.get_any(run_id=run_match.group(1))
    if not run_row:
        return False
    return (
        str(run_row.get("trigger_source") or "") == "worker_call"
        and str(run_row.get("trigger_ref") or "") == str(token_payload.get("parent_run_id") or "")
    )



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
# ---------------------------------------------------------------------------
# Per-user concurrent SSE stream cap (Round 16 DoS finding)
# ---------------------------------------------------------------------------
# Unlimited concurrent SSE streams (/runs/<id>/stream + /runs/<id>/events) are
# a DoS vector: each open stream holds a connection + queue + worker slot. Cap
# the number of simultaneous streams per user with a simple in-process counter
# keyed by user_id. The slot is always released on disconnect via the
# contextmanager's finally block, so a dropped client frees its slot.
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
    logger.warning("Validation error: %s", exc)
    return JSONResponse(status_code=400, content={"detail": str(exc)})




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

















def _get_last_run_for_worker(
    worker_id: str,
    *,
    user_id: str,
    repos: Repositories,
) -> Optional[Dict[str, Any]]:
    row = repos.workers.get_last_run(user_id=user_id, worker_id=worker_id)
    return dict(row) if row else None






def _platform_openai_api_key() -> Optional[str]:
    """The platform's OWN OpenAI key — powers Emily, prompt-to-worker drafting,
    and codegen. Env-managed and reserved. PLATFORM_OPENAI_API_KEY is canonical;
    OPENAI_API_KEY is the back-compat fallback so existing single-key deploys keep
    working. This is NOT a worker key: workers bring their own OPENAI_API_KEY via
    the secrets DB, and the platform key must never reach a worker sandbox."""
    return os.environ.get("PLATFORM_OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY") or None








# Worker telemetry/alerts/feedback routes -> routers/worker_telemetry.py



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




def _context_git_path(name: str, rel_path: Optional[str] = None) -> str:
    try:
        base = context_dir(name).relative_to(_git_workspace()).as_posix()
        return _git_join(base, rel_path or "")
    except Exception:
        return _git_join(_contexts_git_prefix(), name, rel_path or "")




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


# Worker version/rollback routes -> routers/worker_versions.py



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






# ---------------------------------------------------------------------------
# Workers
# ---------------------------------------------------------------------------












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


@app.get("/contexts", response_model=List[ContextSummary])
def list_contexts(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[ContextSummary]:
    ensure_contexts_dir()
    metadata = load_context_metadata()
    root = current_contexts_root()
    # Compute worker_count for every pack from a single workers.list() call so
    # the LIST row matches the DETAIL view (used_by) without N+1 queries.
    worker_counts = _context_worker_counts(repos, auth.user_id)
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
            folder.name, user_id=auth.user_id, metadata=metadata, repos=repos
        ):
            operator_items.append(_context_summary(
                folder.name,
                metadata,
                worker_count=worker_counts.get(folder.name, 0),
                repos=repos,
                user_id=auth.user_id,
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
    safe_name = _context_name_or_400(name)
    root = context_dir(safe_name)
    metadata = load_context_metadata()
    if root.exists():
        if not _context_visible_to_user(
            safe_name, user_id=auth.user_id, metadata=metadata, repos=repos
        ):
            raise HTTPException(status_code=404, detail="Context not found")
        raise HTTPException(status_code=409, detail="Context already exists")
    root.mkdir(parents=True)
    set_context_metadata(
        safe_name,
        writeable=bool(payload.writeable) if payload else False,
        sensitive=bool(payload.sensitive) if payload else True,
        owner_id=auth.user_id,
        category=(payload.category if payload else None),  # #780
    )
    # Materialize the access-control mirror row (default private) so the Share
    # control + permission checks work immediately. Members STEP 4.
    _ensure_brain_pack_row(safe_name, owner_id=auth.user_id, repos=repos)
    return _context_detail(safe_name, repos=repos, user_id=auth.user_id)


@app.put("/contexts/{name}/category", response_model=ContextDetail)
def set_context_category(
    name: str,
    payload: ContextCategoryRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    """#780: set/clear a brain pack's content-category tag (marketing,
    accounting, research, data, ...). Empty/null clears it."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    set_context_metadata(safe_name, category=(payload.category or ""))
    return _context_detail(safe_name, repos=repos, user_id=auth.user_id)


@app.get("/contexts/{name}", response_model=ContextDetail)
def get_context(
    name: str,
    path_prefix: Optional[str] = None,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    safe_name, metadata = _require_readable_context_for_user(
        name, user_id=auth.user_id, repos=repos
    )
    # #783: ?path_prefix=reports filters the file list to that subfolder.
    return _context_detail(
        safe_name, metadata, repos=repos, user_id=auth.user_id, path_prefix=path_prefix
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
    safe_name, metadata = _require_context_for_user(
        name, user_id=auth.user_id, repos=repos
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
            actor_id=auth.user_id,
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
    return _context_detail(safe_name, repos=repos, user_id=auth.user_id)


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
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    set_context_metadata(safe_name, sensitive=body.sensitive)
    return {"name": safe_name, "sensitive": body.sensitive}


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
    # Record the deletion in git so the history is preserved but the directory is gone.
    _git_commit_context(safe_name, message=f"context {safe_name}: delete")
    return ContextDeleteResponse(status="deleted", referenced_by=referenced_by)


@app.get("/contexts/{name}/files/{file_path:path}")
def get_context_file(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
):
    safe_name, _metadata = _require_readable_context_for_user(name, user_id=auth.user_id)
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
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
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
        user_id=auth.user_id,
        tags=tags,
        file_metadata=file_metadata,
    )
    author_name, author_email = _git_author(auth)
    _git_commit_context(safe_name, rel, message=f"context {safe_name}: update {rel}", author_name=author_name, author_email=author_email)
    return result


@app.delete("/contexts/{name}/files/{file_path:path}", response_model=ContextDetail)
def delete_context_file(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
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
    set_context_file_metadata(safe_name, rel, tags=[], file_metadata={}, owner_id=auth.user_id)
    author_name, author_email = _git_author(auth)
    _git_commit_context(safe_name, rel, message=f"context {safe_name}: delete {rel}", author_name=author_name, author_email=author_email)
    return _context_detail(safe_name, repos=repos, user_id=auth.user_id)


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
    safe_name, _meta = _require_context_for_user(name, user_id=auth.user_id)
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
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
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
        owner_id=auth.user_id,
    )
    set_context_file_metadata(safe_name, old_rel, tags=[], file_metadata={}, owner_id=auth.user_id)
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
    safe_name = _context_name_or_400(name)
    root = context_dir(safe_name)
    if root.is_dir():
        safe_name, _metadata = _require_context_for_user(
            safe_name,
            user_id=auth.user_id,
            repos=repos,
        )
    elif create_if_missing:
        if _user_scoped_local_mode() or _is_cloud_deploy():
            raise HTTPException(status_code=404, detail="Context not found")
        root.mkdir(parents=True, exist_ok=True)
        set_context_metadata(safe_name, writeable=True, owner_id=auth.user_id)
        _ensure_brain_pack_row(safe_name, owner_id=auth.user_id, repos=repos)
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
                user_id=auth.user_id,
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
    safe_name, _metadata = _require_readable_context_for_user(name, user_id=auth.user_id)
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
                permissions=_worker_permissions(w, user_id=worker_user_id, repos=repos),
            )
        )
    return result










def _public_noindex_headers() -> Dict[str, str]:
    return {
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "no-store",
    }


def _mint_worker_short_id() -> str:
    return f"fls_{pysecrets.token_urlsafe(8).replace('-', '').replace('_', '')[:10]}"








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
    )


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
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
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
    from openai import OpenAI as _OpenAI
    from worker_registry import WORKERS_DIR as _WORKERS_DIR

    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = _WORKERS_DIR / worker_id / "worker.yml"
    current_yml = worker_yml_path.read_text(encoding="utf-8") if worker_yml_path.exists() else (
        getattr(worker, "manifest_yaml", "") or ""
    )

    api_key = _platform_openai_api_key()
    if not api_key:
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
        client = _OpenAI(api_key=api_key)
        response = client.chat.completions.create(
            model="gpt-4o-mini",
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




# Worker star/contexts/pause/resume/delete routes -> routers/worker_lifecycle.py



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
        from codegen_model import chat_completion_codegen

        response = chat_completion_codegen(
            client,
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

    openai_key = _platform_openai_api_key() or ""
    if not openai_key:
        raise HTTPException(status_code=503, detail="PLATFORM_OPENAI_API_KEY not configured")
    _enforce_draft_rate_limit(request)

    # Pre-detect connections for the prompt to give the LLM a hint
    prompt_lower = prompt.lower()
    detected_connections = _detect_connections(prompt_lower)

    user_message = f"""Design a Workeros worker for this task:

{prompt}

Detected Composio apps that may be needed: {detected_connections if detected_connections else 'none detected, infer from context'}

Generate the full WorkerContract YAML and metadata JSON as specified. Make sure the YAML is valid and passes schema_version "0.3" validation. Always include version: "0.1.0" in the top-level manifest. Remember: every string scalar in the YAML must be wrapped in double quotes."""

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

    openai_key = _platform_openai_api_key() or ""
    if not openai_key:
        raise HTTPException(status_code=503, detail="PLATFORM_OPENAI_API_KEY not configured")
    _enforce_draft_rate_limit(request)

    from openai import OpenAI

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
    payload = _build_workspace_template_zip(
        user_id=auth.user_id, repos=repos, exported_at=exported_at
    )
    return _workspace_template_response(payload)


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
    secret = os.environ.get("FLOOM_SECRET") or "dev-secret-not-set"
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

    # Reject symlink members (security).
    for info in zf.infolist():
        file_type = (info.external_attr >> 16) & 0o170000
        if file_type == 0o120000:
            raise HTTPException(
                status_code=400,
                detail=f"Template contains unsupported symlink: {info.filename!r}",
            )

    names = zf.namelist()

    # ---- group members by worker id / context name ---------------------
    worker_files: Dict[str, List[DraftFile]] = collections.OrderedDict()
    context_files: Dict[str, List[tuple[str, bytes]]] = collections.OrderedDict()
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
                content = zf.read(name).decode("utf-8")
            except UnicodeDecodeError:
                raise HTTPException(
                    status_code=400,
                    detail=f"Worker file {rel!r} is not valid UTF-8 text",
                )
            worker_files.setdefault(wid, []).append(DraftFile(path=inner, content=content))
        elif parts[0] == "contexts" and len(parts) >= 3:
            cname = parts[1]
            inner = "/".join(parts[2:])
            context_files.setdefault(cname, []).append((inner, zf.read(name)))
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
    if _get_db_worker(worker_id, user_id=auth.user_id, repos=repos) is None:
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
    )


# ---------------------------------------------------------------------------
# PUT /workers/{worker_id}/files — bulk file replacement (atomic)
# ---------------------------------------------------------------------------

class WorkerFilePatch(BaseModel):
    path: str
    content: str


class WorkerFilesUpdateRequest(BaseModel):
    files: List[WorkerFilePatch]




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
    run_id = create_run(
        worker_id,
        payload.inputs,
        trigger_source,
        status=RunStatus.RUNNING.value,
        user_id=auth.user_id,
        trigger_ref=trigger_ref,
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


# Runs routes moved to routers/runs.py (composio_execute_proxy stays below)



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
# Secrets — routes moved to routers/secrets.py; env IO + platform specs to
# services/secrets_env.py
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Connections (Composio OAuth)
# ---------------------------------------------------------------------------



# ---------------------------------------------------------------------------
# Integration trigger catalog (moved to routers/integrations.py) + Composio
# event receiver
# ---------------------------------------------------------------------------


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

from routers.cli_auth import (
    cli_auth_router,
    CliAuthDeviceCreateRequest,
    CliAuthCodeRequest,
    create_cli_device,
    poll_cli_device,
    approve_cli_device,
    deny_cli_device,
    _issue_cli_auth_pat,
)
app.include_router(cli_auth_router)

from routers.chat import chat_router
app.include_router(chat_router)

from routers.workspaces import (
    workspaces_router,
    LocalWorkspaceCreateRequest,
    LocalWorkspaceRenameRequest,
    LocalWorkspaceOut,
    LocalWorkspaceListResponse,
    CurrentUserResponse,
    _local_workspace_out,
    _active_local_workspace_id,
    _require_local_workspace_mode,
    _duplicate_workspace_name,
    get_current_user,
    list_workspaces,
    create_workspace,
    rename_workspace,
    select_workspace,
    delete_workspace,
    duplicate_workspace,
)
app.include_router(workspaces_router)

from routers.user_settings import (
    user_settings_router,
    _UserSettings,
    _UserSettingsUpdate,
    get_user_settings,
    put_user_settings,
)
app.include_router(user_settings_router)

from routers.share import (
    share_router,
    _GrantRequest,
    _GrantOut,
    _canonical_grant_asset_id,
    _assert_can_share_asset,
    add_share_grant,
    list_share_grants,
    delete_share_grant,
)
app.include_router(share_router)

from services.composio import (
    _raise_composio_unavailable,
    _composio_webhook_url,
    _resolve_composio_connection_id,
    _composio_trigger_signature,
    _config_from_manifest_for_worker,
    _existing_composio_state,
    _disable_composio_trigger,
    _enable_composio_trigger,
    _sync_composio_registration,
)
from routers.integrations import (
    integrations_router,
    IntegrationCatalogItem,
    IntegrationCatalogResponse,
    CatalogToolItem,
    _trigger_catalog_cache,
    _trigger_catalog_lock,
    _trigger_item_app_slug,
    integrations_catalog,
    integrations_catalog_tools,
    list_integration_triggers,
)
app.include_router(integrations_router)

from routers.connections import (
    connections_router,
    ConnectionInitRequest,
    MCPConnectionCreateRequest,
    ConnectionItem,
    ConnectionTestResult,
    ConnectionInitResponse,
    _ConnectionPeekResponse,
    _connection_row_for_user,
    _get_callback_url,
    _parse_scopes_json,
    _parse_json_string_list,
    _normalize_composio_connection_status,
    _account_label_from_info,
    _cache_connection_account_info,
    _refresh_connection_status_for_list,
    _public_connection_item,
    _normalize_mcp_connection_payload,
    _fetch_provider_email,
    _fetch_email_peek,
    _fetch_composio_account_info,
    list_connection_tool_presets,
    list_connections,
    get_connection_for_app,
    initiate_connection,
    create_mcp_connection,
    connections_callback,
    connections_callback_alias,
    get_connection_status,
    delete_connection,
    get_connection_activity,
    get_connection_account_info,
    get_connection_peek,
    get_auth_config,
    test_connection,
    get_connection_tools,
    sweep_connections_endpoint,
)
app.include_router(connections_router)

from routers.approvals import (
    approvals_router,
    ApproveRequest,
    RejectRequest,
    PublicApprovalDecisionRequest,
    ApproveActionRequest,
    _sanitize_annotations,
    _annotations_json_or_none,
    _approval_artifacts_for_response,
    _approval_response,
    _publish_approval_terminal_status,
    _approval_public_payload,
    _approval_public_token,
    _load_public_approval,
    _public_approval_response,
    _load_typed_approval,
    _execute_destructive_delete,
    list_approvals,
    count_pending_approvals,
    get_public_approval,
    download_public_approval_artifact,
    approve_public_approval,
    reject_public_approval,
    upload_approval_screenshot,
    upload_public_approval_screenshot,
    approve_run,
    reject_run,
    approve_destructive_action,
    reject_destructive_action,
    approve_agent_tool_approval,
    reject_agent_tool_approval,
)
app.include_router(approvals_router)

from routers.runs import (
    runs_router,
    list_runs,
    export_runs_csv,
    _preclear_backup_dir,
    _live_db_file_path,
    _backup_db_before_clear,
    clear_runs,
    cancel_run,
    _RunExportRequest,
    export_runs_bundle,
    download_run_bundle,
    get_run_bundle_file,
    download_artifact,
    get_run,
    create_run_share_link,
    revoke_run_share_link,
    get_public_run,
    stream_run_parts,
    stream_run_events,
    get_run_logs,
)
app.include_router(runs_router)

from routers.worker_telemetry import (
    worker_telemetry_router,
    get_worker_timeseries,
    get_worker_stats,
    get_workspace_stats,
    get_worker_logs,
    create_worker_alert,
    list_worker_alerts,
    delete_worker_alert,
    _feedback_to_model,
    create_worker_feedback,
    list_worker_feedback,
    delete_worker_feedback,
)
app.include_router(worker_telemetry_router)

from routers.worker_versions import (
    worker_versions_router,
    list_worker_versions,
    get_worker_version,
    rollback_worker,
)
app.include_router(worker_versions_router)

from routers.worker_lifecycle import (
    worker_lifecycle_router,
    toggle_worker_star,
    attach_worker_context,
    update_worker_context,
    detach_worker_context,
    pause_worker,
    resume_worker,
    delete_worker,
    _WorkerContextAttachRequest,
    _WorkerContextUpdateRequest,
)
app.include_router(worker_lifecycle_router)

from routers.uploads import (
    uploads_router,
    upload_file,
    download_upload,
    delete_upload,
)
app.include_router(uploads_router)

from routers.mcp_tools import (
    mcp_tools_router,
    _mcp_input_schema_from_worker_record,
    list_mcp_tools,
    create_mcp_tool,
    update_mcp_tool,
    delete_mcp_tool,
)
app.include_router(mcp_tools_router)

from routers.secrets import (
    secrets_router,
    SecretUpsertRequest,
    SecretTestResult,
    SecretName,
    upsert_secret,
    delete_secret,
    test_secret,
    list_secrets,
)
app.include_router(secrets_router)

from routers.system_git import (
    system_git_router,
    _GitStatus,
    _GitConnectRequest,
    _GitLinkRequest,
    _GitCreateRepoRequest,
    _GitRepoItem,
    get_git_status,
    connect_github,
    list_git_repos,
    create_git_repo,
    link_git_repo,
    push_git_workspace,
    disconnect_git,
    import_git_workspace,
)
app.include_router(system_git_router)

from routers.system import (
    system_router,
    WorkspaceAgentSettingsUpdate,
    AssistantVisibilityUpdate,
    PlatformConfig,
    platform_config,
    channels_email_status,
    system_info,
    system_workspace_agent,
    update_workspace_agent_settings,
    set_workspace_agent_visibility,
    system_alerts,
)
app.include_router(system_router)

from routers.overview import (
    overview_router,
    OverviewStats,
    OverviewSparklineBucket,
    OverviewRunItem,
    OverviewOutcomeItem,
    OverviewScheduledItem,
    OverviewAttentionItem,
    OverviewResponse,
    system_overview,
)
app.include_router(overview_router)

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













































# ---------------------------------------------------------------------------
# Git workspace integration: GitHub PAT + repo linking
# ---------------------------------------------------------------------------

# Git workspace integration routes moved to routers/system_git.py



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

# ---------------------------------------------------------------------------
# S37 — Workspace agent /chat endpoint + conversation history
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# MCP tool CRUD endpoints — moved to routers/mcp_tools.py
# ---------------------------------------------------------------------------

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
        session_repo.prune_expired(now_iso=datetime.now(_tz.utc).isoformat())
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
    role: str = "member"


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
    expires = (datetime.now(_tz.utc) + timedelta(seconds=_SESSION_TTL_SECONDS)).isoformat()
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
    expires = (datetime.now(_tz.utc) + timedelta(seconds=_SESSION_TTL_SECONDS)).isoformat()
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
    expires = (datetime.now(_tz.utc) + timedelta(seconds=_SESSION_TTL_SECONDS)).isoformat()
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
    if payload.role not in ("admin", "member"):
        raise HTTPException(status_code=422, detail="role must be admin or member")
    _validate_new_password(payload.password, username=username)
    if user_repo.get_by_username(username=username) is not None:
        raise HTTPException(status_code=409, detail="username already taken")
    user_id = str(_uuid_mod.uuid4())
    pw_hash = _bcrypt_hash(payload.password)
    row = user_repo.create(
        user_id=user_id,
        username=username,
        display_name=payload.display_name,
        password_hash=pw_hash,
        role=payload.role,
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
    raw = "wos_" + _secrets_mod.token_urlsafe(32)
    token_hash = _hash_pat(raw)
    token_id = str(_uuid_mod.uuid4())
    try:
        row = token_repo.create(
            token_id=token_id,
            user_id=auth.user_id,
            name=name,
            token_hash=token_hash,
            expires_at=payload.expires_at,
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


class _WorkspaceSettingValue(BaseModel):
    value: str = Field(..., max_length=4000)


def _active_workspace_id(request: Request) -> str:
    return requested_local_workspace_id(request) or DEFAULT_WORKSPACE_ID


@app.get("/workspace/settings")
def get_workspace_settings(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, str]:
    """#794/#797: workspace behaviour toggles + model defaults (key→value map)."""
    ws = _active_workspace_id(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT key, value FROM workspace_settings WHERE workspace_id = ?", (ws,)
        ).fetchall()
    return {str(r["key"]): str(r["value"]) for r in rows}


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
