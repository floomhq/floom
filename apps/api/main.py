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
from typing import Annotated, Any, Dict, Iterable, List, Literal, NotRequired, Optional, Protocol, TypedDict, Union

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

# #997 security: never auto-load a cwd .env outside explicit dev mode. Production
# supplies env via the orchestrator (WORKEROS_DEPLOY != local); fixed api.env
# loading remains below. LOCAL deploy (the default) IS dev mode, so load the cwd
# .env there too — otherwise `python main.py` / scripts/dev.* get no FLOOM_DB and
# no provider creds, and auth collapses EVERY session to the 'federico' dev
# default (db/__init__ + auth/dependency._is_local_dev_mode both key off FLOOM_DB).
if os.environ.get("WORKEROS_DEV") == "1":
    load_dotenv()
elif (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower() == "local":
    load_dotenv()

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
    WorkerListSummary,
    DraftFile,
    DraftFromPromptRequest,
    DraftFromPromptInputField,
    DraftFromPromptOutputField,
    RequirementItem,
    DraftFromPromptResponse,
    NewWorkerFromPromptRequest,
    NewWorkerFromPromptResponse,
    DraftAndCreateRequest,
    DraftAndCreateResponse,
    _AuthSetupRequest,
    _LoginRequest,
    _PATCreateRequest,
    _PATCreateResponse,
    _PATOut,
    _UserCreateRequest,
    _UserOut,
    _UserUpdateRequest,
    WorkspaceMemberOut,
    WorkspaceMembersResponse,
    WorkspaceMemberInviteRequest,
    WorkspaceMemberRoleUpdate,
    WorkspaceTransferOwnerRequest,
    WorkspaceShareLinkResponse,
    WorkspaceImportResponse,
    ChangelogEntry,
    _WorkspaceSettingValue,
    VersionSummary,
    AssetPermissions,
    RunCreate,
    WorkerCreateRequest,
    WorkerVisibilityUpdate,
    SecretWarning,
    CandidateFeedbackCreateRequest,
    ContextWorkerRef,
    ContextSummary,
    ContextFileItem,
    ContextDetail,
    ContextCategoryRequest,
    ContextCreateRequest,
    ContextDeleteResponse,
    ContextFileMoveRequest,
    ContextSecretScanFile,
    ContextSecretScanResponse,
    ContextSensitiveRequest,
    ContextTextWriteRequest,
    ContextUploadResponse,
    ContextVisibilityUpdate,
    _SqliteView,
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
    WorkerNotRunnableError,
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
    set_git_workspace_resolver,
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
    _worker_owner_id,
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

# The cwd `.env` is loaded EARLY (top of this module, before any import that
# resolves paths/credentials) in LOCAL mode — see the load_dotenv() block above.
# #997: it is NEVER auto-loaded in production. The fixed-location loader below
# (WORKEROS_API_ENV_FILE / ~/.config/workeros/api.env) is the supported production
# path and runs in every mode; override=False so it never clobbers a set var.
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
    WORKER_FILES_BODY_LIMIT_BYTES,
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
from services.worker_create import (
    _acquire_worker_create_lock,
    _worker_record_from_worker_yml,
    _write_worker_bundle_files,
    _cleanup_worker_create_state,
    _reject_raw_local_runner_on_create,
    _create_worker_from_parsed_payload,
)
from services.workspace_ops import (
    WORKSPACE_TEMPLATE_SCHEMA_VERSION,
    WORKSPACE_TEMPLATE_FILENAME,
    _active_workspace_id,
    _member_out,
    _ensure_owner_membership,
    _git_commit_workspace_md,
    _git_commit_workspace_base_md,
    _is_exportable_operator_worker,
    _build_workspace_template_zip,
    _workspace_template_response,
    _workspace_share_payload,
    _workspace_share_token,
    _safe_zip_rel,
)
from services.health_ops import (
    _HEALTH_CACHE,
    _HEALTH_CACHE_TTL_SECONDS,
    _HEALTH_MIN_FREE_DISK_GB,
    _health_check_db,
    _health_check_disk,
    _health_check_openai,
    _health_check_e2b,
    _health_check_composio,
    _health_check_scheduler,
    _run_health_checks,
    _prometheus_escape,
    _prometheus_label,
)
from services.auth_ops import (
    _SESSION_TTL_SECONDS,
    _MAGIC_LINK_FALLBACK_SECRET,
    _MIN_PASSWORD_LENGTH,
    _COMMON_PASSWORDS,
    _FAILED_LOGIN_LOCKOUT_THRESHOLD,
    _FAILED_LOGIN_WINDOW_SECONDS,
    _BOOTSTRAP_SECRETS_TO_SEED,
    _failed_login_attempts,
    _failed_login_lock,
    _bcrypt_hash,
    _bcrypt_verify,
    _claim_bootstrap_assets_for_new_admin,
    _clear_failed_logins,
    _is_sequential_password,
    _issue_magic_link,
    _login_locked_out,
    _magic_link_secret,
    _prune_expired_sessions,
    _record_failed_login,
    _require_multi_member_repos,
    _seed_bootstrap_secrets,
    _session_cookie_secure,
    _consume_magic_link_nonce,
    _set_session_cookie,
    _validate_magic_link,
    _validate_magic_link_full,
    _validate_new_password,
)
from services.worker_codegen import (
    _available_methods_for_app,
    _draft_rate_key,
    _claim_draft_slot,
    _draft_rate_store,
    _drafts_last_hour_total,
    _enforce_draft_rate_limit,
    _detect_connections,
    _call_draft_llm,
    _repair_generated_worker_manifest,
)
from services.worker_serialize import (
    _build_triggers_list,
    _connection_slug_for_worker_card,
    _get_last_run_for_worker,
    _starred_worker_ids,
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
    _active_local_workspace_id,
    _AssetAccessEntry,
    _require_members_repo,
    _asset_access_list,
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
    _worker_for_mutation,
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
    _mint_worker_short_id,
    _ensure_worker_short_links_table,
    _worker_short_link_response,
    _load_short_link_public_worker,
)

# Public worker projection (PublicWorker allow-list + signed-link resolver +
# share-card payload) lives in services.public_worker; re-export for routes.
from services.public_worker import (
    _public_connection_labels,
    _public_worker_response,
    _load_public_worker,
    _public_worker_share_from_worker,
    _public_file_entry,
    _public_brain_file_share,
    _public_brain_pack_share,
    _standalone_share_payload,
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
    _context_upload_limit_bytes,
    _format_limit_mb,
    _read_context_upload_bytes,
    _contexts_git_prefix,
    _context_git_path,
    _git_commit_context,
    _increment_file_ref_counts,
    _require_readable_context_for_user,
    _context_detail,
    _raise_context_quota_if_needed,
    _write_context_file,
    _block_secrets_in_contexts,
    _scan_context_write,
    _file_has_share_blocking_secret,
    _assert_context_file_shareable,
    _assert_context_pack_shareable,
)

# Public-facing redaction + SSE event shaping cluster lives in
# services.public_view; re-exported here for this module's call sites and for
# tests that read the redaction constants/headlines via the `main` module.
from services.public_view import (
    _public_noindex_headers,
    _json_noindex,
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
                    """
                    UPDATE runs
                    SET status = ?,
                        error = COALESCE(NULLIF(error, ''), ?),
                        error_code = COALESCE(NULLIF(error_code, ''), ?)
                    WHERE id = ? AND status = ?
                    """,
                    (
                        RunStatus.FAILED.value,
                        "Approval expired before a decision was recorded.",
                        "approval_expired",
                        r["run_id"],
                        RunStatus.PENDING_APPROVAL.value,
                    ),
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


def _backfill_worker_memory_packs(user_id: str) -> int:
    from models import WorkerConfig
    from runner_sandbox.memory_context import ensure_memory_context_pack

    count = 0

    def _log(message: str, level: str = "info") -> None:
        if level == "warning":
            logger.warning(message)
        else:
            logger.debug(message)

    with use_context_scope(context_scope_for_user(user_id)):
        for worker in discover_workers(use_cache=False):
            if worker.get("status") == "error":
                continue
            try:
                config = WorkerConfig(**(worker.get("config") or {}))
                if ensure_memory_context_pack(config=config, user_id=user_id, log_fn=_log):
                    count += 1
            except Exception:
                logger.warning("Skipping memory backfill for worker %s", worker.get("id"), exc_info=True)
    if count:
        logger.info("Backfilled %d worker memory packs", count)
    return count


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan: startup + shutdown hooks."""
    global _sweep_task
    # Wire up SSE publisher before starting workers (avoids circular import)
    register_sse_publisher(_sse_publish)
    register_part_publisher(_run_part_publish)
    # Startup
    _validate_startup_configuration()
    _warn_if_composio_webhook_unconfigured()
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
        # Worker reload MUST be non-fatal on startup. A single malformed or
        # foreign worker (dangling FK, invalid manifest, non-worker backup dir
        # with a worker.yml) used to raise here and crash the process with
        # "Application startup failed. Exiting." — and since the autodeploy
        # restarts every ~60s, that became a guaranteed crash-loop / outage.
        # Per-worker isolation inside _persist_discovered_workers already skips
        # individual bad workers; this guard catches any remaining systemic
        # failure so the service still comes up in degraded mode (the HTTP
        # /workers/reload endpoint keeps its RuntimeError -> 502 contract).
        try:
            _reload_workers_for_user(bootstrap_user_id)
        except Exception as _reload_exc:
            logger.error(
                "Startup worker reload failed (non-fatal, starting in degraded "
                "mode — workers may be missing until /workers/reload succeeds): %s",
                _reload_exc,
                exc_info=True,
            )
        try:
            _backfill_worker_memory_packs(bootstrap_user_id)
        except Exception as _memory_exc:
            logger.warning("Startup worker memory backfill failed (non-fatal): %s", _memory_exc)
        fail_interrupted_runs_on_startup(user_id=bootstrap_user_id)
        # #1130: sweep for zombie runs from previous deployments / server restarts.
        # Unlike fail_interrupted_runs_on_startup (process-local tracking), this
        # uses a very broad window (24h) to catch runs that were never cleaned up
        # regardless of how many restarts occurred since.
        try:
            from run_service import reap_abandoned_runs as _reap
            _reap(timeout_seconds=86400, grace_seconds=0)
        except Exception as _reap_exc:
            logger.warning("Startup zombie-run sweep failed (non-fatal): %s", _reap_exc)
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


@app.middleware("http")
async def hot_get_cache_invalidation_middleware(request: Request, call_next):
    response = await call_next(request)
    if request.method.upper() not in {"GET", "HEAD", "OPTIONS"} and response.status_code < 500:
        from core.hot_cache import clear as _clear_hot_cache

        _clear_hot_cache()
    return response


@app.exception_handler(InsufficientDiskSpaceError)
async def insufficient_disk_space_handler(_request: Request, exc: InsufficientDiskSpaceError):
    return JSONResponse(
        status_code=507,
        content={"detail": "Insufficient disk space for run creation", "error": str(exc)},
    )




def _context_upload_body_limit_bytes() -> int:
    # Multipart framing adds overhead beyond the uploaded file bytes.
    return _context_upload_limit_bytes() + (1024 * 1024)




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



# 1.5.2: trigger sources that belong in the operator /runs view. Everything
# else (audit, test, smoke runs like s35_concurrency_*, synthetic data, etc.)
# is internal telemetry and is hidden from the default view. Data is preserved
# and reachable via GET /runs?include_system=true.




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
    # subdomain meant workspace-wide CSRF. Production now relies on the explicit
    # allowlist above; set ALLOWED_ORIGIN_REGEX to opt back in.
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





























def _rate_limit_for_path(path: str) -> tuple[int, float]:
    for pattern, limit in RATE_LIMIT_RULES:
        if pattern.fullmatch(path):
            return limit
    return DEFAULT_RATE_LIMIT


# #1024: PUT /workers/{id}/files — atomic file replace, may carry bundled data.
_WORKER_FILES_PATH_RE = re.compile(r"^/workers/[^/]+/files$")
_WORKER_SOURCE_PATH_RE = re.compile(r"^/workers/[^/]+$")


def _body_limit_for_request(request: Request) -> Optional[int]:
    method = request.method.upper()
    if method not in {"POST", "PUT", "PATCH"}:
        return None
    path = request.url.path
    if path == "/workers/from-bundle":
        return FROM_BUNDLE_BODY_LIMIT_BYTES
    if path == "/workspace/import":
        return WORKSPACE_IMPORT_BODY_LIMIT_BYTES
    # Worker source writes may carry data-bundled modules, so they need the same
    # bounded headroom as atomic file deploys without broadening worker run/admin
    # subpaths.
    if (
        (method == "POST" and path == "/workers")
        or (method in {"PUT", "PATCH"} and _WORKER_SOURCE_PATH_RE.match(path))
        or (method == "PUT" and _WORKER_FILES_PATH_RE.match(path))
    ):
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
    # #1184: add per-secret and per-session keys so NAT/shared-IP clients don't
    # exhaust each other's buckets, and so attackers with many IPs can't bypass.
    ip = _client_ip(request)
    keys = [f"ip:{ip}:{path}"]
    headers = {k.lower(): v for k, v in (
        (h[0].decode("latin-1", errors="replace"), h[1].decode("latin-1", errors="replace"))
        for h in request.scope.get("headers", [])
    )}
    raw_secret = headers.get("x-floom-secret", "").strip()
    if raw_secret:
        secret_key = hashlib.sha256(raw_secret.encode()).hexdigest()[:16]
        keys.append(f"secret:{secret_key}:{path}")
    # Session-cookie based auth (multi-member)
    cookie_header = headers.get("cookie", "")
    for part in cookie_header.split(";"):
        part = part.strip()
        if part.startswith("wos_session="):
            session_val = part.split("=", 1)[1]
            session_key = hashlib.sha256(session_val.encode()).hexdigest()[:16]
            keys.append(f"session:{session_key}:{path}")
            break
    # Bearer PAT (wos_...)
    auth_header = headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        bearer = auth_header[7:].strip()
        bearer_key = hashlib.sha256(bearer.encode()).hexdigest()[:16]
        keys.append(f"bearer:{bearer_key}:{path}")
    return keys


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
            # #992: validate with the SAME resolution chain used to mint
            # (resolver -> WORKEROS_WORKER_CALL_SECRET -> FLOOM_SECRET), not the
            # raw FLOOM_SECRET. Passing secret="" here (when FLOOM_SECRET is
            # stripped but a worker-call secret/resolver is configured) bypassed
            # the fallback and rejected every otherwise-valid worker-call token.
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
        if not (
            _RE_RUN_COMPOSIO_PROXY.match(path)
            or _RE_RUN_LLM_PROXY.match(path)
            or _RE_RUN_LLM_BATCH_PROXY.match(path)
            or _RE_RUN_EMBEDDINGS_PROXY.match(path)
        ):
            return _JSONResponse(
                status_code=403,
                content={"detail": "Run tokens are only valid for run-scoped platform proxy calls"},
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
            or _RE_RUN_STREAM.match(path)  # #1338: endpoint enforces auth OR worker share token
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
_RE_RUN_LLM_PROXY = _re.compile(r"^/runs/[a-zA-Z0-9_-]+/llm$")
_RE_RUN_LLM_BATCH_PROXY = _re.compile(r"^/runs/[a-zA-Z0-9_-]+/llm/batch$")
_RE_RUN_EMBEDDINGS_PROXY = _re.compile(r"^/runs/[a-zA-Z0-9_-]+/embeddings$")
_RE_RUN_STREAM = _re.compile(r"^/runs/[a-zA-Z0-9_-]+/stream$")
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
        parent_run_id = str(token_payload.get("parent_run_id") or "")
        if (
            method == "POST"
            and parent_run_id
            and (
                _RE_RUN_LLM_PROXY.match(path)
                or _RE_RUN_LLM_BATCH_PROXY.match(path)
                or _RE_RUN_EMBEDDINGS_PROXY.match(path)
            )
        ):
            path_run_id = path.split("/", 3)[2] if path.startswith("/runs/") else ""
            return path_run_id == parent_run_id
        return False
    run_row = repos.runs.get_any(run_id=run_match.group(1))
    if not run_row:
        return False
    return (
        str(run_row.get("trigger_source") or "").startswith("worker_call")  # #994: depth-suffixed
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





# Minimum free disk before /health flips to degraded. A full disk silently
# corrupts SQLite writes and 507s worker-create while /health stayed "ok" at
# 0 bytes free (2026-06-02 P1). Override with HEALTH_MIN_FREE_DISK_GB.




















# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.exception_handler(ValueError)
async def value_error_handler(_request, exc: ValueError):
    # #920: ValueErrors bubble up from arbitrary internal code and can carry
    # filesystem paths, config values, or provider internals. Log the detail
    # server-side; clients get a generic message. Field-level validation errors
    # reach clients via the Pydantic handler, not this one.
    logger.warning("Validation error: %s", exc, exc_info=exc)
    return JSONResponse(status_code=400, content={"detail": "Invalid request"})




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











# Defense-in-depth: strip HTML/XML tags from display-string fields (worker
# name, worker description, workspace name). These are plain-text labels —
# angle-bracket markup is never valid content. React JSX already escapes
# these values when rendering, but removing raw HTML at the storage layer
# ensures no future render path (markdown header, email, export) can fire
# stored XSS from a crafted name.
_HTML_TAG_SANITIZE_RE = re.compile(r"<[^>]*>")


def _strip_html_tags(text: str) -> str:
    """Remove HTML/XML tags from a plain-text display string."""
    return _HTML_TAG_SANITIZE_RE.sub("", text)


_SENSITIVE_ARTIFACT_FILENAMES = frozenset({"transcript.jsonl"})












from services.secrets_env import _platform_openai_api_key  # noqa: E402  (re-export)








# Worker telemetry/alerts/feedback routes -> routers/worker_telemetry.py



# ---------------------------------------------------------------------------
# Versioning: GET /workers/{id}/versions, POST /workers/{id}/rollback/{vid}
#             GET /contexts/{name}/versions, POST /contexts/{name}/rollback/{vid}
#             GET /workspace/versions, POST /workspace/rollback/{vid}
# ---------------------------------------------------------------------------



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

















































# Worker version/rollback routes -> routers/worker_versions.py

































































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
    """Backward-compatible wrapper for tests and legacy call sites."""
    from services.worker_materialization import rematerialize_worker_from_db as _rematerialize

    return _rematerialize(worker_id)










_ARTIFACTS_DIR = Path(os.environ.get("FLOOM_ARTIFACTS_DIR", "../../data/artifacts")).resolve()




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














































































































from models import (  # noqa: E402  (re-export)
    _WorkerSuggestRequest,
    _WorkerSuggestResponse,
    _WorkerSuggestion,
    _ImportFromShareRequest,
)






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
        new_name = _strip_html_tags(payload.name.strip())
        if not new_name:
            raise HTTPException(status_code=422, detail="name cannot be empty")
        updates["name"] = new_name
    if payload.description is not None:
        manifest = dict(worker.get("manifest") or {})
        manifest["description"] = _strip_html_tags(payload.description)
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
                trigger_lines = ["trigger:", f"  type: {effective_type}"]
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




# Stable module-level alias for the PATCH (instance-settings) update handler.
# The plain name ``update_worker`` is reassigned later by the PUT full-rewrite
# handler, so in-process callers wanting PATCH semantics use this alias.
update_worker_instance = update_worker


# Worker star/contexts/pause/resume/delete routes -> routers/worker_lifecycle.py



# ---------------------------------------------------------------------------
# Worker creation
# ---------------------------------------------------------------------------



# ---------------------------------------------------------------------------
# POST /workers/draft-from-prompt
# ---------------------------------------------------------------------------

# Strict keyword map: only match if the app name itself appears in the prompt.
# Generic words like "meeting", "message", "file" have been removed to avoid
# false positives (e.g. "Granola meetings" should not imply google-calendar).











# ---------------------------------------------------------------------------
# Authoritative auth-modes table
# The LLM's reported available_methods is informational only; this table is
# authoritative because the LLM hallucinates. Backend enriches every
# RequirementItem with available_methods from this table before returning.
# ---------------------------------------------------------------------------


























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
        # Single-worker save: surface a persist failure (don't silently skip).
        _persist_discovered_workers(conn, this_worker_list, user_id=user_id, raise_on_skip=True)

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








# ---------------------------------------------------------------------------
# POST /workers/from-bundle — create a worker from a zip bundle
# ---------------------------------------------------------------------------



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









# Worker-dir export helpers (secret-bearing-path filter + file iterator) live in
# services.worker_serialize; re-exported here for backward-compat call sites.
from services.worker_serialize import (  # noqa: E402  (re-export)
    _WORKSPACE_EXPORT_SECRET_BASENAMES,
    _is_secret_bearing_export_path,
    _iter_worker_dir_files,
)










# ---------------------------------------------------------------------------
# Workspace share link (W9b): mint a signed, login-free URL that lets a
# recipient DOWNLOAD this workspace's template .zip, then import it into their
# own instance. Mirrors the worker share-link HMAC pattern
# (``_worker_public_token``): the token is bound to the owner so it can never
# resolve a different operator's template, and the public download carries the
# SAME no-secret-value guarantee as the authenticated export (it reuses
# ``_build_workspace_template_zip``).
# ---------------------------------------------------------------------------


















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
    # Single-worker update: only persist the target worker with strict error
    # propagation (raise_on_skip=True) so a composio-disable failure during
    # the update rolls back the persist and returns 502 to the caller.
    # Passing all discovered workers with the default (raise_on_skip=False)
    # swallowed the RuntimeError from _sync_composio_registration, which
    # caused the update to return 200 instead of 502 (#1070 regression).
    this_worker_list = [w for w in workers if w["id"] == worker_id]
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, this_worker_list, user_id=auth.user_id, raise_on_skip=True)
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
                # Single-worker save: surface a persist failure (don't silently
                # skip) so the file-restore rollback below runs.
                _persist_discovered_workers(
                    conn, this_worker_list, user_id=auth.user_id, raise_on_skip=True
                )
            except Exception as exc:
                # Roll back: restore backups. Catch any persist failure
                # (IntegrityError, ValidationError, RuntimeError) so a bad save
                # never leaves the worker files half-written.
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

    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos, role=auth.role)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    true_owner_id = _worker_owner_id(worker_id, repos) or str(worker.get("owner_id") or "")
    if not true_owner_id:
        raise HTTPException(status_code=409, detail=f"Worker {worker_id} owner not found")

    # B-P1-1 (2026-05-29): a smoke-disabled worker must NOT run on demand. The
    # smoke+gate disables a worker whose first test run failed (enabled=False);
    # honour that here so a broken worker cannot be run from the UI/API to a
    # green-but-empty no-op. Reject with 409 + the worker_disabled headline.
    try:
        recipe = repos.workers.get_recipe(worker_id=worker_id, user_id=true_owner_id)
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
            user_id=true_owner_id,
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
    except WorkerNotRunnableError as exc:
        # Genuine cross-tenant ownership denial raised by RunsRepo.create. Caught
        # explicitly (it subclasses ValueError) so the 403 is robust rather than
        # relying on the substring match below. Keep the raw "does not belong"
        # detail server-side; clients get a safe, operator-facing message.
        logger.warning("create_run denied for worker %s: %s", worker_id, exc, exc_info=exc)
        raise HTTPException(
            status_code=403,
            detail="You do not have permission to run this worker.",
        ) from exc
    except ValueError as exc:
        # Un-mask known run-create ValueErrors at the source instead of letting
        # them bubble to the global ValueError handler, which collapses every
        # cause into a useless 400 "Invalid request" (that exact masking hid the
        # "worker does not belong" + path-traversal failures on the demo worker).
        # We surface a SPECIFIC, operator-actionable message but keep raw
        # filesystem paths server-side (the global handler's #920 concern). The
        # cross-tenant "does not belong" case is already a typed
        # WorkerNotRunnableError handled above.
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
            error_code="file_input_resolution_failed",
            user_id=true_owner_id,
            repos=repos,
        )
        raise
    except Exception as exc:
        update_run_status(
            run_id,
            RunStatus.FAILED.value,
            error=str(exc),
            error_code="file_input_resolution_failed",
            user_id=true_owner_id,
            repos=repos,
        )
        raise
    # Persist resolved inputs (absolute file paths replace SHA values) so that
    # GET /runs/:id returns the staged paths, not raw SHA strings.
    repos.runs.set_input_json(user_id=true_owner_id, run_id=run_id, input_json=resolved_inputs)
    repos.runs.update(
        user_id=true_owner_id,
        run_id=run_id,
        status=RunStatus.QUEUED.value,
        started_at=None,
    )
    start_run(run_id, worker_id, resolved_inputs, user_id=true_owner_id, repos=repos)
    return ActionResponse(status="running", run_id=run_id)


@app.post("/workers/{worker_id}/runs/{run_id}/replay")
def replay_run(
    worker_id: str,
    run_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos, role=auth.role)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    row = repos.runs.get(user_id=auth.user_id, run_id=run_id)
    if not row:
        try:
            candidate = repos.runs.get_any(run_id=run_id)
        except Exception:
            candidate = None
        if not candidate or str(candidate.get("actor_user_id") or "") != str(auth.user_id):
            raise HTTPException(status_code=404, detail="Run not found")
        row = candidate
    actor_user_id = row.get("actor_user_id")
    if actor_user_id is not None and str(actor_user_id) != str(auth.user_id):
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


class _ManagedLLMRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    messages: List[Dict[str, Any]]
    model: Optional[str] = None
    max_tokens: Optional[int] = Field(default=None, ge=1, le=24000)
    temperature: Optional[float] = Field(default=None, ge=0, le=2)


class _ManagedLLMBatchRequest(BaseModel):
    requests: List[_ManagedLLMRequest] = Field(default_factory=list, min_length=1, max_length=50)
    max_parallel: int = Field(default=8, ge=1, le=16)


class _ManagedEmbeddingsRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    input: Union[str, List[str]]
    model: Optional[str] = None


def _platform_managed_llm_model() -> str:
    value = (
        os.environ.get("WORKEROS_MANAGED_LLM_MODEL")
        or os.environ.get("WORKEROS_WORKER_AGENT_MODEL")
        or os.environ.get("WORKEROS_CHAT_MODEL")
        or ""
    ).strip()
    if value:
        return value
    from models import default_worker_agent_model as _default_worker_agent_model

    return _default_worker_agent_model()


def _platform_managed_embedding_model() -> str:
    return (
        os.environ.get("WORKEROS_MANAGED_EMBEDDING_MODEL")
        or os.environ.get("WORKEROS_EMBEDDING_MODEL")
        or os.environ.get("OPENAI_EMBEDDING_MODEL")
        or "text-embedding-3-small"
    ).strip()


def _response_to_jsonable(response: Any) -> Any:
    if hasattr(response, "model_dump"):
        return response.model_dump()
    if hasattr(response, "dict"):
        return response.dict()
    return jsonable_encoder(response)


def _require_running_run_for_platform_proxy(run_id: str, repos: Repositories) -> Dict[str, Any]:
    run_row = repos.runs.get_any(run_id=run_id)
    if run_row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if run_row.get("status") != RunStatus.RUNNING.value:
        raise HTTPException(
            status_code=403,
            detail=f"Run is not currently running (status={run_row.get('status')})",
        )
    return run_row


def _authorize_run_platform_proxy(request: Request, run_id: str) -> None:
    from run_token import validate_worker_call_token as _validate_worker_call_token
    from run_token import verify_run_token as _verify_run_token

    simple_token = request.headers.get("x-workeros-run-token", "")
    if simple_token:
        token_run_id = _verify_run_token(simple_token)
        if token_run_id is None:
            raise HTTPException(status_code=401, detail="Missing or invalid run token")
        if token_run_id != run_id:
            raise HTTPException(status_code=403, detail="Run token does not match request run_id")
        return

    authorization_header = request.headers.get("authorization", "")
    bearer = authorization_header[7:].strip() if authorization_header.startswith("Bearer ") else ""
    if bearer.startswith("wrt_"):
        try:
            payload = _validate_worker_call_token(bearer)
        except ValueError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        if str(payload.get("parent_run_id") or "") != run_id:
            raise HTTPException(status_code=403, detail="Worker-call token does not match request run_id")
        return

    raise HTTPException(status_code=401, detail="Missing or invalid run token")


def _managed_llm_completion(body: _ManagedLLMRequest) -> Any:
    import llm as _llm

    model = body.model or _platform_managed_llm_model()
    if not _llm.provider_credentials_present(model):
        raise HTTPException(status_code=503, detail="No managed LLM provider credentials configured")
    data = body.model_dump(exclude_none=True)
    data.pop("model", None)
    messages = data.pop("messages")
    try:
        return _response_to_jsonable(_llm.completion(model=model, messages=messages, **data))
    except Exception as exc:  # noqa: BLE001 - provider SDK exceptions vary
        detail = _llm.safe_llm_error_message(exc, action="Managed LLM call")
        raise HTTPException(status_code=502, detail=detail) from exc


def _managed_embeddings(body: _ManagedEmbeddingsRequest) -> Any:
    import llm as _llm

    model = body.model or _platform_managed_embedding_model()
    data = body.model_dump(exclude_none=True)
    data.pop("model", None)
    try:
        return _response_to_jsonable(_llm.embedding(model=model, **data))
    except Exception as exc:  # noqa: BLE001 - provider SDK exceptions vary
        detail = _llm.safe_llm_error_message(exc, action="Managed embedding call")
        raise HTTPException(status_code=502, detail=detail) from exc


@app.post("/runs/{run_id}/llm")
def managed_llm_proxy(
    request: Request,
    run_id: str,
    body: _ManagedLLMRequest,
    repos: Repositories = Depends(get_repos),
) -> Any:
    _authorize_run_platform_proxy(request, run_id)
    _require_running_run_for_platform_proxy(run_id, repos)
    return _managed_llm_completion(body)


@app.post("/runs/{run_id}/llm/batch")
def managed_llm_batch_proxy(
    request: Request,
    run_id: str,
    body: _ManagedLLMBatchRequest,
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    from concurrent.futures import ThreadPoolExecutor

    _authorize_run_platform_proxy(request, run_id)
    _require_running_run_for_platform_proxy(run_id, repos)
    with ThreadPoolExecutor(max_workers=min(body.max_parallel, len(body.requests))) as pool:
        results = list(pool.map(_managed_llm_completion, body.requests))
    return {"results": results}


@app.post("/runs/{run_id}/embeddings")
def managed_embeddings_proxy(
    request: Request,
    run_id: str,
    body: _ManagedEmbeddingsRequest,
    repos: Repositories = Depends(get_repos),
) -> Any:
    _authorize_run_platform_proxy(request, run_id)
    _require_running_run_for_platform_proxy(run_id, repos)
    return _managed_embeddings(body)


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


# --- #1075: pluggable webhook delivery-receipt store seam --------------------
# `_claim_webhook_delivery` dedups inbound webhooks (GitHub/Composio redeliver
# with the same delivery id). The default is SQLite, which on the ephemeral,
# sometimes multi-instance managed cloud (a) loses receipts across redeploys, so
# sender retries fire the worker again, and (b) can raise "database is locked"
# under concurrent inbound webhooks. Cloud registers a Supabase-backed store via
# `set_webhook_delivery_store` so claims are atomic + durable across instances —
# same seam pattern as set_context_scope_resolver / set_worker_call_secret_resolver.
class WebhookDeliveryStore(Protocol):
    def claim(self, source: str, delivery_id: str) -> bool:
        """Atomically record (source, delivery_id). Return True if this is the
        FIRST time it is seen (claim succeeds → process the webhook), False if it
        is a duplicate/redelivery (drop it). Implementations own their own TTL."""
        ...


_webhook_delivery_store: "WebhookDeliveryStore | None" = None


def set_webhook_delivery_store(store: "WebhookDeliveryStore | None") -> None:
    """Register a pluggable webhook delivery-receipt store (cloud: Supabase).
    Pass ``None`` to clear and fall back to the SQLite default (OSS mode)."""
    global _webhook_delivery_store
    _webhook_delivery_store = store


def _sqlite_claim_webhook_delivery(source: str, delivery_id: str) -> bool:
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


def _claim_webhook_delivery(source: str, delivery_id: str) -> bool:
    if not delivery_id:
        return True
    store = _webhook_delivery_store
    if store is not None:
        return store.claim(source, delivery_id)
    return _sqlite_claim_webhook_delivery(source, delivery_id)


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
    _run_connection_sweep,
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

# Worker admin/detail/share/visibility/archive/suggest/sample-input routes.
from routers.worker_admin import (
    worker_admin_router,
    create_worker_share_link,
    revoke_worker_share_link,
    get_worker_detail,
    download_worker_bundle,
    set_worker_visibility,
    restore_worker,
    archive_worker,
    suggest_worker_updates,
    get_worker_sample_input,
)
app.include_router(worker_admin_router)

# Public/shared worker + brain routes (signed-link projection, short-links,
# share-link mint/revoke, standalone-share resolver + download, share import).
from routers.worker_public import (
    worker_public_router,
    get_public_worker,
    create_worker_short_link,
    resolve_worker_short_link,
    import_worker_from_share,
    create_brain_pack_share_link,
    create_brain_file_share_link,
    revoke_brain_pack_share_link,
    revoke_brain_file_share_link,
    download_standalone_share_file,
    get_standalone_share,
)
app.include_router(worker_public_router)

# Asset access-listing routes (who can access a worker / brain pack).
from routers.asset_access import (
    asset_access_router,
    list_worker_access,
    list_context_access,
)
app.include_router(asset_access_router)

# Context (knowledge-pack / brain) route group. list_contexts is re-exported
# because the /search and workspace-agent MCP routes call it directly.
from routers.contexts import (
    contexts_router,
    list_contexts,
    _record_candidate_feedback_event,
)
app.include_router(contexts_router)

# Workspace route group (instructions/base-persona docs, members, settings,
# template export/import, share link, changelog).
from routers.workspace import workspace_router
app.include_router(workspace_router)

# Auth + users route group (setup/login/logout/magic/me, user CRUD, PAT tokens).
from routers.auth import auth_router
app.include_router(auth_router)

# Worker creation routes (POST /workers, POST /workers/from-bundle).
from routers.worker_create import worker_create_router, create_worker
app.include_router(worker_create_router)

# System health + metrics routes (/health, /healthz, /metrics, /system/metrics).
from routers.system_health import system_health_router, prometheus_metrics  # noqa: F401  (re-exported for tests / back-compat)
app.include_router(system_health_router)

# Worker listing route (GET /workers). list_workers re-exported because the
# workspace-agent MCP tool layer + /search call it directly.
from routers.worker_listing import worker_listing_router, list_workers
app.include_router(worker_listing_router)

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
    _require_secret_mutation_allowed,
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


def _mcp_internal_error(request_id: Any, exc: BaseException, where: str) -> Dict[str, Any]:
    """M-04: log full detail server-side; return a generic message so SQLSTATE
    codes / bound values / internals don't leak to external MCP clients."""
    logger.exception("MCP remote (%s) unhandled exception", where)
    return _mcp_error(request_id, -32603, "Internal server error")


def _mcp_tool_error(message: str) -> Dict[str, Any]:
    return {
        "content": [{"type": "text", "text": message}],
        "isError": True,
    }


_MCP_SECRET_QUERY_RE = re.compile(
    r"([?&](?:token|key|secret|signature|sig|code|api[_-]?key)=)([^&\s]+)",
    re.IGNORECASE,
)
_MCP_SECRET_ASSIGNMENT_RE = re.compile(
    r"\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;&\"'}]+)",
    re.IGNORECASE,
)
_MCP_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE)


def _mcp_redact_string(value: str) -> str:
    redacted = _MCP_SECRET_QUERY_RE.sub(r"\1[redacted]", value)
    redacted = _MCP_SECRET_ASSIGNMENT_RE.sub(r"\1[redacted]", redacted)
    return _MCP_BEARER_RE.sub("Bearer [redacted]", redacted)


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
    if isinstance(value, str):
        return _mcp_redact_string(value)
    return value


def _mcp_text(data: Any, summary: Optional[str] = None) -> str:
    safe = _mcp_redact(jsonable_encoder(data))
    rendered = json.dumps(safe, ensure_ascii=False, indent=2)
    return f"{summary}\n{rendered}" if summary else rendered


def _mcp_call_result(data: Any, summary: Optional[str] = None) -> Dict[str, Any]:
    structured = _mcp_redact(jsonable_encoder(data))
    if not isinstance(structured, dict):
        structured = {"data": structured}
    return {
        "content": [{"type": "text", "text": _mcp_text(data, summary)}],
        "structuredContent": structured,
        "isError": False,
    }


def _mcp_api_result(data: Any, status_code: int) -> Dict[str, Any]:
    return _mcp_content(_mcp_text(data), status_code >= 400)


def _mcp_max_batch_items() -> int:
    raw = os.environ.get("WORKEROS_MCP_MAX_BATCH_ITEMS", "50")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = 50
    return min(max(value, 1), 200)


def _mcp_http_error_result(exc: HTTPException) -> Dict[str, Any]:
    detail = exc.detail if isinstance(exc.detail, str) else json.dumps(jsonable_encoder(exc.detail), ensure_ascii=False)
    return {
        "content": [{"type": "text", "text": _mcp_redact_string(detail)}],
        "structuredContent": _mcp_redact({"status": exc.status_code, "detail": jsonable_encoder(exc.detail)}),
        "isError": True,
    }


def _mcp_json_schema(properties: Dict[str, Any], required: Optional[List[str]] = None) -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": False,
    }


def _mcp_validate_arguments_against_schema(
    tool_definitions: List[Dict[str, Any]],
    tool_name: str,
    arguments: Dict[str, Any],
) -> Optional[str]:
    tool = next((t for t in tool_definitions if t.get("name") == tool_name), None)
    schema = tool.get("inputSchema") if isinstance(tool, dict) else None
    if not isinstance(schema, dict):
        return None
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    required = schema.get("required") if isinstance(schema.get("required"), list) else []
    for name in required:
        if name not in arguments:
            return f"Invalid params: missing {name}"
    for name, value in arguments.items():
        prop = properties.get(name)
        if not isinstance(prop, dict):
            continue
        expected = prop.get("type")
        if expected == "string" and not isinstance(value, str):
            return f"Invalid params: {name} must be a string"
        if expected == "boolean" and not isinstance(value, bool):
            return f"Invalid params: {name} must be a boolean"
        if expected == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
            return f"Invalid params: {name} must be an integer"
        if expected == "object" and not isinstance(value, dict):
            return f"Invalid params: {name} must be an object"
        if expected == "array" and not isinstance(value, list):
            return f"Invalid params: {name} must be an array"
    return None


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


def _internal_asgi_request() -> Request:
    """Minimal in-process Request for direct calls into route fns that require a
    ``request`` positional. host=asgi makes the worker-write workspace check
    short-circuit (these come from already-authenticated internal dispatchers)."""
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "query_string": b"",
        "headers": [(b"host", b"asgi")],
    }
    return Request(scope)


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
    data = create_worker(payload, _internal_asgi_request(), auth=auth, repos=repos)
    return _mcp_call_result(data, "Worker created.")


def _mcp_call_workers_update(arguments: Dict[str, Any], auth: AuthContext, repos: Repositories) -> Dict[str, Any]:
    worker_id = _mcp_arg(arguments, "id")
    update_args = {k: v for k, v in arguments.items() if k != "id"}
    payload = WorkerUpdateRequest(**update_args)
    # update_worker (module name) is shadowed by the PUT full-rewrite handler;
    # MCP "workers.update" wants PATCH instance-settings semantics -> use the alias.
    data = update_worker_instance(
        worker_id, payload, _internal_asgi_request(), auth=auth, repos=repos
    )
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
    value = arguments.get("value")
    if not isinstance(value, str):
        raise ValueError("Tool argument 'value' must be a string")
    try:
        payload = SecretUpsertRequest(value=value)
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc
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
    except ValidationError:
        raise
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
            if _mcp_default_tool(t["name"]) is None or _mcp_access_error(t["name"], auth) is None
        ]
        return _mcp_result(request_id, {"tools": tools})
    if method != "tools/call":
        return _mcp_error(request_id, -32601, f"Unsupported MCP method: {method or 'unknown'}")

    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    tool_name = str(params.get("name") or "")
    arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
    invalid_args = _mcp_validate_arguments_against_schema(
        _workeros_remote_mcp_tool_definitions(),
        tool_name,
        arguments,
    )
    if invalid_args:
        return _mcp_error(request_id, -32602, invalid_args)
    try:
        return _mcp_result(request_id, await _call_workeros_remote_mcp_tool(tool_name, arguments))
    except ValidationError as exc:
        return _mcp_error(request_id, -32602, f"Invalid params: {exc}")
    except Exception as exc:
        return _mcp_internal_error(request_id, exc, f"tools/call:{tool_name or 'unknown'}")


async def _workspace_agent_mcp_post(request: Request) -> Response:
    if not _workspace_agent_mcp_enabled():
        raise HTTPException(status_code=503, detail="Workeros Remote MCP is disabled")
    static_tokens = _workspace_agent_mcp_tokens()
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if not static_tokens and deploy != "cloud":
        raise HTTPException(status_code=503, detail="No Workeros MCP/API token is configured")
    # M-05: on CLOUD the static token must NOT short-circuit to the global
    # bootstrap admin context (no workspace binding => cross-tenant admin to any
    # holder of the single cloud-wide secret). Force cloud callers down the
    # per-tenant PAT path. Static token stays valid only on OSS/local.
    if deploy != "cloud" and _verify_workspace_agent_mcp_auth(request):
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
        if len(payload) > _mcp_max_batch_items():
            return JSONResponse(_mcp_error(None, -32600, "Batch too large"))
        responses = []
        for item in payload:
            if not isinstance(item, dict):
                responses.append(_mcp_error(None, -32600, "Invalid JSON-RPC request"))
                continue
            try:
                response = await _handle_workspace_agent_mcp_message(item)
            except Exception as exc:
                response = _mcp_internal_error(item.get("id"), exc, "batch-item")
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
        response = _mcp_internal_error(payload.get("id"), exc, "single")
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
    # M-03: forward x-floom-user so the re-authenticated in-process sub-request
    # can resolve the acting user under WORKEROS_ENABLE_USER_HEADER_SCOPE.
    "x-floom-user",
})


def _api_call_auth_headers(request: Request) -> dict[str, str]:
    auth_headers = {k.lower(): v for k, v in request.headers.items() if k.lower() in _API_CALL_AUTH_HEADERS}
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local" and "x-workeros-workspace" not in auth_headers:
        auth_headers["x-workeros-workspace"] = DEFAULT_WORKSPACE_ID
    return auth_headers


async def _api_call(
    method: str,
    path: str,
    request: Request,
    *,
    body: Any = None,
    params: dict | None = None,
) -> tuple[Any, int]:
    import httpx
    auth_headers = _api_call_auth_headers(request)
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


def _mcp_default_tool_by_name() -> Dict[str, dict]:
    return {str(tool["name"]): tool for tool in _MCP_DEFAULT_TOOLS}


def _mcp_default_tool(name: str) -> Optional[dict]:
    return _mcp_default_tool_by_name().get(name)


def _mcp_visible_default_tools(auth: AuthContext) -> List[dict]:
    return [
        tool for tool in _MCP_DEFAULT_TOOLS
        if _mcp_tool_served(str(tool["name"]))
        and _mcp_access_error(str(tool["name"]), auth) is None
    ]


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
    if _mcp_default_tool(name) is not None and not _mcp_tool_served(name):
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
        return _mcp_api_result(data, s)
    if name == "workers.get":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}", request)
        return _mcp_api_result(data, s)
    if name == "workers.create":
        body = {k: a[k] for k in ("worker_yml", "run_py") if k in a}
        if "skill_md" in a: body["skill_md"] = a["skill_md"]
        data, s = await _api_call("POST", "/workers", request, body=body)
        return _mcp_api_result(data, s)
    if name == "workers.update":
        body = {k: a[k] for k in a if k != "id"}
        data, s = await _api_call("PATCH", f"/workers/{_enc(a['id'])}", request, body=body)
        return _mcp_api_result(data, s)
    if name == "workers.delete":
        data, s = await _api_call("DELETE", f"/workers/{_enc(a['id'])}", request)
        return _mcp_api_result(data, s)
    if name == "workers.run":
        body = {"inputs": a.get("inputs") or {}, "trigger_source": a.get("trigger_source", "manual")}
        data, s = await _api_call("POST", f"/workers/{_enc(a['id'])}/runs", request, body=body)
        return _mcp_api_result(data, s)
    if name == "workers.write_file":
        data, s = await _api_call("PUT", f"/workers/{_enc(a['id'])}/files", request, body={"files": a["files"]})
        return _mcp_api_result(data, s)
    if name == "workers.logs":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/logs", request, params={"level": a.get("level"), "since": a.get("since"), "limit": a.get("limit", 200)})
        return _mcp_api_result(data, s)
    if name == "workers.stats":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/stats", request)
        return _mcp_api_result(data, s)
    if name == "workers.timeseries":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/runs/timeseries", request, params={"days": a.get("days", 30)})
        return _mcp_api_result(data, s)
    if name == "workers.versions":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/versions", request, params={"limit": a.get("limit", 50)})
        return _mcp_api_result(data, s)
    if name == "workers.rollback":
        data, s = await _api_call("POST", f"/workers/{_enc(a['id'])}/rollback/{_enc(a['version_id'])}", request)
        return _mcp_api_result(data, s)
    if name == "workers.archive":
        data, s = await _api_call("POST", f"/workers/{_enc(a['id'])}/archive", request)
        return _mcp_api_result(data, s)
    if name == "workers.restore":
        data, s = await _api_call("POST", f"/workers/{_enc(a['id'])}/restore", request)
        return _mcp_api_result(data, s)
    if name == "workers.reload":
        data, s = await _api_call("POST", "/workers/reload", request)
        return _mcp_api_result(data, s)
    if name == "workers.sample_input":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/sample-input", request)
        return _mcp_api_result(data, s)
    if name == "workers.alerts.list":
        data, s = await _api_call("GET", f"/workers/{_enc(a['id'])}/alerts", request)
        return _mcp_api_result(data, s)
    if name == "workers.alerts.create":
        body = {k: a[k] for k in a if k != "id"}
        data, s = await _api_call("POST", f"/workers/{_enc(a['id'])}/alerts", request, body=body)
        return _mcp_api_result(data, s)
    if name == "workers.alerts.delete":
        data, s = await _api_call("DELETE", f"/workers/{_enc(a['id'])}/alerts/{_enc(a['alert_id'])}", request)
        return _mcp_api_result(data, s)

    # --- runs ---
    if name == "runs.list":
        data, s = await _api_call("GET", "/runs", request, params={"worker_id": a.get("worker_id"), "status": a.get("status"), "limit": a.get("limit", 50), "offset": a.get("offset", 0)})
        return _mcp_api_result(data, s)
    if name == "runs.get":
        data, s = await _api_call("GET", f"/runs/{_enc(a['id'])}", request)
        return _mcp_api_result(data, s)
    if name == "runs.cancel":
        data, s = await _api_call("POST", f"/runs/{_enc(a['id'])}/cancel", request)
        return _mcp_api_result(data, s)
    if name == "runs.replay":
        data, s = await _api_call("POST", f"/workers/{_enc(a['worker_id'])}/runs/{_enc(a['run_id'])}/replay", request)
        return _mcp_api_result(data, s)
    if name == "runs.watch":
        run_id = a["id"]
        timeout = _mcp_watch_timeout_seconds(a.get("timeout_ms"))  # #834: 30s cap
        deadline = _time.monotonic() + timeout
        run = None
        while _time.monotonic() < deadline:
            await asyncio.sleep(1.5)
            run_data, s = await _api_call("GET", f"/runs/{_enc(run_id)}", request)
            if s >= 400:
                return _mcp_api_result(run_data, s)
            if run_data.get("status") in ("completed", "failed", "cancelled"):
                return _mcp_content(_mcp_text(run_data), run_data.get("status") == "failed")
        return _mcp_content(f"Run {run_id!r} did not complete within {timeout:.0f}s", is_error=True)

    # --- secrets ---
    if name == "secrets.list":
        data, s = await _api_call("GET", "/secrets", request)
        return _mcp_api_result(data, s)
    if name == "secrets.set":
        data, s = await _api_call("POST", f"/secrets/{_enc(a['key'])}", request, body={"value": a["value"]})
        return _mcp_api_result(data, s)
    if name == "secrets.delete":
        data, s = await _api_call("DELETE", f"/secrets/{_enc(a['key'])}", request)
        return _mcp_api_result(data, s)
    if name == "secrets.test":
        data, s = await _api_call("POST", f"/secrets/{_enc(a['key'])}/test", request)
        return _mcp_api_result(data, s)

    # --- connections ---
    if name == "connections.list":
        data, s = await _api_call("GET", "/connections", request)
        return _mcp_api_result(data, s)
    if name == "connections.add_mcp":
        data, s = await _api_call("POST", "/connections/mcp", request, body=a)
        return _mcp_api_result(data, s)
    if name == "connections.delete":
        data, s = await _api_call("DELETE", f"/connections/{_enc(a['connection_id'])}", request)
        return _mcp_api_result(data, s)
    if name == "connections.status":
        data, s = await _api_call("GET", f"/connections/{_enc(a['connection_id'])}/status", request)
        return _mcp_api_result(data, s)
    if name == "connections.test":
        data, s = await _api_call("POST", f"/connections/{_enc(a['connection_id'])}/test", request)
        return _mcp_api_result(data, s)

    # --- contexts ---
    if name == "contexts.list":
        data, s = await _api_call("GET", "/contexts", request)
        return _mcp_api_result(data, s)
    if name == "contexts.create":
        data, s = await _api_call("POST", f"/contexts/{_enc(a['name'])}", request, body={"writeable": a.get("writeable", False), "sensitive": a.get("sensitive", True)})
        return _mcp_api_result(data, s)
    if name == "contexts.read":
        encoded_path = "/".join(_enc(p) for p in a["path"].split("/"))
        data, s = await _api_call("GET", f"/contexts/{_enc(a['name'])}/files/{encoded_path}", request)
        return _mcp_api_result(data, s)
    if name == "contexts.write":
        encoded_path = "/".join(_enc(p) for p in a["path"].split("/"))
        data, s = await _api_call("PUT", f"/contexts/{_enc(a['name'])}/files/{encoded_path}", request, body={"content": a["content"]})
        return _mcp_api_result(data, s)
    if name == "record_candidate_feedback":
        body = {k: a[k] for k in ("run_id", "candidate_id", "rank", "feedback_text", "outcome") if k in a}
        if "scope" in a:
            body["scope"] = a["scope"]
        if "reporter" in a:
            body["reporter"] = a["reporter"]
        data, s = await _api_call("POST", f"/contexts/{_enc(a['name'])}/record-candidate-feedback", request, body=body)
        return _mcp_api_result(data, s)
    if name == "contexts.delete":
        qs = "?force=true" if a.get("force") else ""
        data, s = await _api_call("DELETE", f"/contexts/{_enc(a['name'])}{qs}", request)
        return _mcp_api_result(data, s)
    if name == "contexts.delete_file":
        encoded_path = "/".join(_enc(p) for p in a["path"].split("/"))
        data, s = await _api_call("DELETE", f"/contexts/{_enc(a['name'])}/files/{encoded_path}", request)
        return _mcp_api_result(data, s)
    if name == "contexts.versions":
        data, s = await _api_call("GET", f"/contexts/{_enc(a['name'])}/versions", request, params={"limit": a.get("limit", 50)})
        return _mcp_api_result(data, s)
    if name == "contexts.rollback":
        data, s = await _api_call("POST", f"/contexts/{_enc(a['name'])}/rollback/{_enc(a['version_id'])}", request)
        return _mcp_api_result(data, s)

    # --- triggers ---
    if name == "triggers.list":
        data, s = await _api_call("GET", "/integrations/triggers", request, params={"worker_id": a.get("worker_id"), "app": a.get("app")})
        return _mcp_api_result(data, s)

    # --- approvals ---
    if name == "approvals.list":
        data, s = await _api_call("GET", "/approvals", request, params={"limit": a.get("limit", 50)})
        return _mcp_api_result(data, s)
    if name == "approvals.approve":
        data, s = await _api_call("POST", f"/runs/{_enc(a['run_id'])}/approve", request, body={"comment": a.get("comment")})
        return _mcp_api_result(data, s)
    if name == "approvals.reject":
        data, s = await _api_call("POST", f"/runs/{_enc(a['run_id'])}/reject", request, body={"comment": a.get("comment")})
        return _mcp_api_result(data, s)

    # --- workspace ---
    if name == "workspace.chat":
        message = str(a.get("message") or "").strip()
        if not message:
            return _mcp_content("Tool argument 'message' is required", is_error=True)
        if len(message) > 20000:
            return _mcp_content("Tool argument 'message' is too long", is_error=True)
        conversation_id = _workspace_agent_mcp_conversation_id(a.get("conversation_id"))
        reply = await _collect_workspace_agent_reply_for_langdock(
            message=message,
            user_id=auth.user_id,
            conversation_id=conversation_id,
        )
        return _mcp_call_result(
            {
                "reply": reply or "(No reply)",
                "conversation_id": conversation_id,
            },
            "Workspace agent reply.",
        )
    if name == "workspace.instructions.get":
        data, s = await _api_call("GET", "/workspace", request)
        return _mcp_api_result(data, s)
    if name == "workspace.instructions.set":
        data, s = await _api_call("PUT", "/workspace", request, body={"content": a["content"]})
        return _mcp_api_result(data, s)
    if name == "workspace.versions":
        data, s = await _api_call("GET", "/workspace/versions", request, params={"limit": a.get("limit", 20)})
        return _mcp_api_result(data, s)
    if name == "workspace.rollback":
        data, s = await _api_call("POST", f"/workspace/rollback/{_enc(a['version_id'])}", request)
        return _mcp_api_result(data, s)

    # --- system ---
    if name == "system.overview":
        data, s = await _api_call("GET", "/system/overview", request)
        return _mcp_api_result(data, s)
    if name == "system.stats":
        data, s = await _api_call("GET", "/stats", request)
        return _mcp_api_result(data, s)
    if name == "system.info":
        data, s = await _api_call("GET", "/system/info", request)
        return _mcp_api_result(data, s)
    if name == "system.alerts":
        data, s = await _api_call("GET", "/system/alerts", request)
        return _mcp_api_result(data, s)

    # --- integrations ---
    if name == "integrations.catalog":
        data, s = await _api_call("GET", "/integrations/catalog", request)
        return _mcp_api_result(data, s)

    # --- conversations ---
    if name == "conversations.list":
        data, s = await _api_call("GET", "/conversations", request, params={"limit": a.get("limit", 20)})
        return _mcp_api_result(data, s)
    if name == "conversations.get":
        data, s = await _api_call("GET", f"/conversations/{_enc(a['id'])}", request)
        return _mcp_api_result(data, s)

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
            return _mcp_content(_mcp_text(run.get("error") or "Worker run failed"), is_error=True)
        output = run.get("output_json") or run.get("output") or {}
        return _mcp_content(_mcp_text(output))

    return _mcp_content(f"Unknown tool: {name!r}", is_error=True)


async def _mcp_handle_request(
    body: Any,
    auth: AuthContext,
    repos: "Repositories",
    request: Request | None = None,
) -> Any:
    """Core MCP JSON-RPC 2.0 dispatcher. Called by /mcp-tools/serve and by the cloud /mcp/{workspace_id}."""
    if isinstance(body, list):
        if not body:
            return _mcp_err(None, -32600, "Invalid JSON-RPC request")
        if len(body) > _mcp_max_batch_items():
            return _mcp_err(None, -32600, "Batch too large")
        responses = []
        for item in body:
            if not isinstance(item, dict):
                responses.append(_mcp_err(None, -32600, "Invalid JSON-RPC request"))
                continue
            responses.append(await _mcp_handle_request(item, auth, repos, request))
        return responses

    if not isinstance(body, dict):
        return _mcp_err(None, -32600, "Invalid JSON-RPC request")

    rpc_id = body.get("id")
    method = body.get("method", "")
    params = body.get("params") or {}
    if not isinstance(params, dict):
        return _mcp_err(rpc_id, -32602, "Invalid params")

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
        tools = _mcp_visible_default_tools(auth) + [
            {"name": t["name"], "description": t["description"], "inputSchema": t["input_schema"]}
            for t in custom
        ]
        return _mcp_ok(rpc_id, {"tools": tools})

    if method == "tools/call":
        if request is None:
            return _mcp_err(rpc_id, -32603, "Internal error: request context unavailable")
        tool_name = params.get("name", "")
        if not isinstance(tool_name, str) or not tool_name:
            return _mcp_err(rpc_id, -32602, "Invalid params")
        raw_arguments = params.get("arguments")
        arguments = {} if raw_arguments is None else raw_arguments
        if not isinstance(arguments, dict):
            return _mcp_err(rpc_id, -32602, "Invalid params")
        default_tool = _mcp_default_tool(tool_name)
        invalid_args = (
            _mcp_validate_arguments_against_schema([default_tool], tool_name, arguments)
            if default_tool is not None
            else None
        )
        if invalid_args:
            return _mcp_err(rpc_id, -32602, invalid_args)
        # #833: audit trail for every MCP tool invocation.
        logger.info(
            "mcp tools/call: tool=%r user=%s role=%s auth_method=%s",
            tool_name, auth.user_id, auth.role, auth.auth_method,
        )
        denied = _mcp_access_error(tool_name, auth)
        if denied is not None:
            return _mcp_ok(rpc_id, _mcp_content(denied, is_error=True))
        try:
            result = await _mcp_dispatch(tool_name, arguments, auth, repos, request)
        except KeyError as exc:
            missing = str(exc).strip("'") or "required argument"
            return _mcp_err(rpc_id, -32602, f"Invalid params: missing {missing}")
        except ValidationError as exc:
            return _mcp_err(rpc_id, -32602, f"Invalid params: {exc}")
        except Exception:
            logger.exception("MCP serve tools/call failed: tool=%r", tool_name)
            return _mcp_err(rpc_id, -32603, "Internal error")
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

# Per-process fallback HMAC key for magic links when no env var is set (local dev only).
# Tokens signed with this key are valid only for the lifetime of the process.

# #850: 12+ characters per NIST SP 800-63B (length over composition rules —
# arbitrary complexity requirements are intentionally omitted). 800-63B does
# call for rejecting commonly-used passwords, repetitive/sequential strings,
# and context-specific words (the username), so those checks are below.
# Applies to new/changed passwords only; existing shorter passwords keep
# working at login.

# Starter blocklist: common breach-corpus passwords that pass the 12-char
# minimum. Compared lowercase.








# #850: per-username lockout after repeated failed logins. The 5/min per-IP
# rate limit does not stop distributed credential-stuffing; this does. Keyed
# by username only (an attacker rotating IPs still locks out), which trades a
# bounded 15-minute targeted-DoS window for brute-force protection.






















































# --- User management (admin only) ---










# --- Personal access tokens (current user) ---


















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
    #
    # uvicorn (>=0.49) globs any exclude that is not an *existing* dir, and
    # pathlib.glob() raises NotImplementedError on an absolute pattern — so on a
    # fresh clone, where data/ does not exist yet at startup, `python main.py`
    # would crash before serving. Create data/ up front and pass only paths that
    # already exist, so uvicorn keeps them as dir-excludes and never globs.
    _api_dir = _Path(__file__).resolve().parent
    (_api_dir / "data").mkdir(parents=True, exist_ok=True)
    _exclude_candidates = [_api_dir / "data"]
    try:
        from worker_registry import WORKERS_DIR as _WORKERS_DIR
        _exclude_candidates.append(_Path(_WORKERS_DIR).resolve())
    except Exception:
        pass
    _reload_excludes = [str(p) for p in _exclude_candidates if p.is_dir()]
    uvicorn.run(
        "main:app",
        host=os.environ.get("WORKEROS_API_HOST", "0.0.0.0"),
        port=int(os.environ.get("WORKEROS_API_PORT", "8000")),
        reload=True,
        reload_excludes=_reload_excludes,
    )
