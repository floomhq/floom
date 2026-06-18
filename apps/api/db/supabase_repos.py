from __future__ import annotations

import contextvars
import json
import logging
import os
import time
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Per-request caches populated by batch queries, consumed by per-item calls.
# Each asyncio task / threadpool thread inherits a copy of the context so there
# is no cross-request contamination.

# Populated by stats_batch() → consumed by get_last_run()
# Eliminates N × list_recent_runs() calls in the workers list loop.
_last_run_batch: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "_workeros_last_run_batch", default=None
)

# Populated by list() → consumed by get_recipe()
# Eliminates N × (_worker_rows + _skill_versions_by_id) calls in get_worker_config_for_run().
# Maps worker_id → (raw_worker_row, raw_skill_row | None)
_recipe_cache: contextvars.ContextVar[dict[str, tuple[dict, dict | None]] | None] = contextvars.ContextVar(
    "_workeros_recipe_cache", default=None
)

# Process-level set of "worker_id::skill_version_id" bundles already written to
# disk this process. Config resolution happens on many read paths (GET /runs
# resolves an output schema per run, detail, etc.); without this every one
# re-wrote the same files. Reset per process — a fresh API instance simply
# re-materializes on demand from Supabase, so statelessness is preserved.
_materialized_versions: set[str] = set()

from apps.api.obs import log_failure

_repo_logger = logging.getLogger("workeros.cloud.supabase_repos")

_SYSTEM_RUN_WORKER_IDS = frozenset({"worker-author"})

# Curated catalog of ship-with-product stock/example workers that EVERY tenant
# may run. On cloud these rows are seeded under DIFFERENT demo users in DIFFERENT
# workspaces, so the workspace-scoped ownership pre-check in RunsRepo.create
# would reject a fresh tenant with "worker does not belong" (surfaced as a 404
# "Worker not found" / 400 "Invalid request"). Resolved lazily from the engine's
# main.PUBLIC_STOCK_WORKER_IDS with a DEFERRED import: importing engine `main` at
# module load is heavy/circular, so import it the first time the value is needed
# and cache the result (mirrors the deferred imports in
# _ensure_system_run_worker_row / discover_workers).
_PUBLIC_STOCK_WORKER_IDS_CACHE: frozenset[str] | None = None


def _public_stock_worker_ids() -> frozenset[str]:
    global _PUBLIC_STOCK_WORKER_IDS_CACHE
    if _PUBLIC_STOCK_WORKER_IDS_CACHE is None:
        try:
            from main import PUBLIC_STOCK_WORKER_IDS  # noqa: PLC0415

            _PUBLIC_STOCK_WORKER_IDS_CACHE = frozenset(PUBLIC_STOCK_WORKER_IDS)
        except Exception:
            # Fail closed: if the catalog can't be resolved, no extra worker
            # becomes runnable-by-all (owner/workspace rules still apply).
            _repo_logger.warning(
                "Could not import PUBLIC_STOCK_WORKER_IDS from engine main; "
                "catalog run carve-out disabled this process.",
                exc_info=True,
            )
            _PUBLIC_STOCK_WORKER_IDS_CACHE = frozenset()
    return _PUBLIC_STOCK_WORKER_IDS_CACHE


def _ensure_system_run_worker_row(client: Client, *, worker_id: str, user_id: str) -> None:
    existing = (
        client.table("workers")
        .select("id")
        .eq("id", worker_id)
        .limit(1)
        .execute()
    )
    if _first_row(existing) is not None:
        return

    from worker_registry import discover_workers, invalidate_worker_cache  # noqa: PLC0415

    invalidate_worker_cache()
    worker = next(
        (item for item in discover_workers(use_cache=False) if item.get("id") == worker_id),
        None,
    )
    if worker is None:
        return

    SupabaseWorkerRepository(client).upsert(
        user_id=user_id,
        worker_id=worker_id,
        name=worker.get("name") or worker_id,
        manifest_json=worker.get("manifest") or {},
        trigger_type=worker.get("trigger_type") or "manual",
        bundle_path=f"workers/{worker_id}",
    )

from supabase import Client

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.workspace_context import get_active_member_role, get_active_workspace_id
from apps.api.config import get_supabase_service_client
from apps.api.db import workspaces as workspace_repo
from apps.api.telemetry import capture_posthog_event
from apps.api.db._secret_crypto import (
    decrypt_secret,
    encrypt_secret,
    vault_store_secret,
    vault_update_secret,
    vault_read_secret,
    vault_delete_secret,
    vault_secret_name,
)

ensure_engine_api_path()

from db.interface import RowDict  # noqa: E402
from models import (  # noqa: E402
    RecentStats,
    RunStatus,
    TimeseriesDay,
    WorkerConfig,
    WorkerContract,
    parse_worker_manifest,
    worker_contract_to_worker_config,
)


def _json_dump(value: Any) -> str:
    return json.dumps(value if value is not None else {}, separators=(",", ":"))


def _materialize_worker_files(
    worker_id: str, files: dict[str, str], *, version_key: str | None = None
) -> None:
    """Write worker files from Supabase manifest_json._files to WORKERS_DIR.

    Called by get_recipe() so the engine's skill/e2b drivers find the files
    at the expected path. Supabase is the source of truth in cloud mode;
    the filesystem is a write-through cache rebuilt on demand.

    ``version_key`` ("worker_id::skill_version_id") memoizes the write per
    process: the same bundle is written at most once, so repeated config
    resolutions (runs/detail) don't pay the disk cost again. A new code version
    has a new key, so updates re-materialize.
    """
    if version_key and version_key in _materialized_versions:
        return
    workers_dir_env = (os.environ.get("FLOOM_WORKERS_DIR") or "").strip()
    workers_dir = Path(workers_dir_env) if workers_dir_env else Path("/opt/workeros-cloud/var/workers")
    worker_dir = workers_dir / worker_id
    try:
        worker_dir.mkdir(parents=True, exist_ok=True)
        for fname, content in files.items():
            safe_name = _validate_worker_file_path(str(fname))
            fpath = worker_dir / safe_name
            fpath.parent.mkdir(parents=True, exist_ok=True)
            fpath.write_text(content, encoding="utf-8")
        if version_key:
            _materialized_versions.add(version_key)
        _repo_logger.debug("Materialized %d file(s) for worker %s to %s", len(files), worker_id, worker_dir)
    except Exception:
        _repo_logger.warning("Failed to materialize files for worker %s", worker_id, exc_info=True)


def _read_worker_files_from_disk(worker_id: str) -> dict[str, str]:
    """Read a worker's files from WORKERS_DIR/<id>/ into {relpath: text} (#269).

    Mirrors _materialize_worker_files' dir resolution. The engine chat tools
    (Emily) write worker code to the handling instance's (ephemeral) disk but,
    unlike the REST path, never populate manifest_json._files — so a different
    instance / post-redeploy materializes nothing and every run fails with
    "Worker directory not found". This reads the on-disk files so a write-path
    hook can persist them into _files. Skips binary/oversized files; bounds
    total size; returns {} when the dir is absent or empty (caller treats {}
    as "nothing to capture" and must NOT clobber an existing _files).
    """
    workers_dir_env = (os.environ.get("FLOOM_WORKERS_DIR") or "").strip()
    workers_dir = Path(workers_dir_env) if workers_dir_env else Path("/opt/workeros-cloud/var/workers")
    worker_dir = workers_dir / worker_id
    if not worker_dir.is_dir():
        return {}
    out: dict[str, str] = {}
    total = 0
    MAX_FILES, MAX_TOTAL, MAX_FILE = 200, 5_000_000, 1_000_000
    try:
        for p in sorted(worker_dir.rglob("*")):
            if not p.is_file():
                continue
            try:
                rel = _validate_worker_file_path(p.relative_to(worker_dir).as_posix())
            except Exception:
                continue
            try:
                if p.stat().st_size > MAX_FILE:
                    continue
                content = p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue  # skip binaries / unreadable
            total += len(content.encode("utf-8"))
            if total > MAX_TOTAL or len(out) >= MAX_FILES:
                break
            out[rel] = content
    except Exception:
        return out
    return out


def _json_load(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    if isinstance(default, dict) and isinstance(value, dict):
        return value
    if isinstance(default, list) and isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            loaded = json.loads(value)
        except Exception:
            return default
        return loaded if isinstance(loaded, type(default)) else default
    return default


def _validate_worker_file_path(path: str) -> str:
    path = path.strip()
    if not path:
        raise ValueError("worker file path must not be empty")
    candidate = Path(path)
    if candidate.is_absolute() or "\\" in path:
        raise ValueError(f"worker file path must be relative: {path!r}")
    parts = candidate.parts
    if any(part in ("", ".", "..") or part.startswith(".") for part in parts):
        raise ValueError(f"worker file path contains an invalid segment: {path!r}")
    normalized = candidate.as_posix()
    if normalized.startswith("../") or "/../" in normalized:
        raise ValueError(f"worker file path contains traversal: {path!r}")
    return normalized


def _sanitize_worker_files(files: Mapping[str, Any]) -> dict[str, str]:
    sanitized: dict[str, str] = {}
    for raw_path, raw_content in files.items():
        safe_path = _validate_worker_file_path(str(raw_path))
        if safe_path in sanitized:
            raise ValueError(f"duplicate worker file path: {safe_path!r}")
        if not isinstance(raw_content, str):
            raise ValueError(f"worker file content must be text: {safe_path!r}")
        sanitized[safe_path] = raw_content
    return sanitized


def _json_storage_value(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(default, dict) and isinstance(value, dict):
        return value
    if isinstance(default, list) and isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            loaded = json.loads(value)
        except Exception:
            return default
        return loaded if isinstance(loaded, type(default)) else default
    return default


def _json_text(value: Any, default: Any) -> str:
    if isinstance(value, str):
        return value
    return _json_dump(value if value is not None else default)


def _skill_version_id(worker_id: str, manifest: dict[str, Any]) -> str:
    version = str(manifest.get("version") or "0.1.0").replace(".", "_").replace("-", "_")
    return f"sv_{worker_id}_{version}"


def _config_from_manifest(
    *,
    worker_id: str,
    manifest_json: Any,
    trigger_type: str | None,
    cron_expr: str | None,
    cron_timezone: str | None,
    bundle_path: str | None,
) -> WorkerConfig | None:
    if isinstance(manifest_json, str):
        manifest_raw = json.loads(manifest_json or "{}")
    elif isinstance(manifest_json, dict):
        manifest_raw = manifest_json
    else:
        manifest_raw = {}
    # Engine #190 lifts legacy top-level inputs/outputs/secrets into the exec
    # block inside parse_worker_manifest itself (read + write paths), so no
    # cloud-side lift is needed. Workers ingested before that change are still
    # handled correctly on read because parse_worker_manifest is idempotent.
    try:
        parsed = parse_worker_manifest(manifest_raw)
        if isinstance(parsed, WorkerContract):
            config = worker_contract_to_worker_config(parsed, worker_id)
        else:
            config = parsed if isinstance(parsed, WorkerConfig) else WorkerConfig(**manifest_raw)
    except Exception:
        # A legacy/malformed persisted manifest (e.g. missing the strict
        # id/trigger/runtime fields the current WorkerConfig requires) must NOT
        # take down the entire /workers list — one bad recipe was 422-ing the
        # whole list endpoint. Degrade to a minimal valid config so the worker
        # still lists and resolves; mirrors the detail-path fallback in main.py.
        _repo_logger.warning(
            "worker %s: manifest failed strict parse; using degraded config", worker_id
        )
        config = WorkerConfig(
            id=worker_id,
            name=str((manifest_raw or {}).get("name") or worker_id),
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )
    if trigger_type:
        config.trigger.type = trigger_type
    if cron_expr:
        config.trigger.cron = cron_expr
    if cron_timezone:
        config.trigger.timezone = cron_timezone
    if config.runtime:
        config.runtime.bundle_path = bundle_path
    return config


def _heal_manifest_contract(manifest: Any, *, worker_id: str = "") -> Any:
    """Self-heal a manifest_json whose top-level worker contract was clobbered.

    A partial write can overwrite ``skill_versions.manifest_json`` with only state
    fields (e.g. ``{name, paused, enabled, archive_reason}``) plus ``_files``,
    dropping the parsed contract (``exec``/``title``/``version``/``trigger``).
    The full recipe still lives in ``_files['worker.yml']`` — reconstruct the
    contract from it so the worker resolves to its real config instead of
    degrading to an empty python stub (which would run and produce nothing).

    No-op for healthy manifests (they already carry ``exec``) and for manifests
    whose ``worker.yml`` is missing/unusable.
    """
    if not isinstance(manifest, dict) or manifest.get("exec"):
        return manifest
    files = manifest.get("_files")
    wyml = files.get("worker.yml") if isinstance(files, dict) else None
    if not isinstance(wyml, str) or not wyml.strip():
        return manifest
    try:
        import yaml  # noqa: PLC0415
        parsed = yaml.safe_load(wyml)
    except Exception:
        _repo_logger.warning(
            "manifest heal: worker.yml parse failed for %s",
            worker_id or manifest.get("name"), exc_info=True,
        )
        return manifest
    if not isinstance(parsed, dict) or not parsed.get("exec"):
        return manifest  # worker.yml carries no contract either — nothing to heal
    healed = dict(parsed)
    healed["_files"] = files
    # Preserve runtime state flags that legitimately live alongside the contract.
    for k in ("paused", "enabled", "archived", "archive_reason"):
        if k in manifest:
            healed[k] = manifest[k]
    _repo_logger.info(
        "manifest heal: reconstructed clobbered contract from worker.yml for %s",
        worker_id or manifest.get("name") or "<unknown>",
    )
    return healed


def _worker_record_from_rows(
    worker_row: Mapping[str, Any],
    skill_version_row: Mapping[str, Any] | None,
) -> dict[str, Any]:
    manifest = (
        _json_load(skill_version_row.get("manifest_json"), {})
        if skill_version_row
        else {}
    )
    manifest = _heal_manifest_contract(manifest, worker_id=str(worker_row.get("id") or ""))
    config = _config_from_manifest(
        worker_id=str(worker_row["id"]),
        manifest_json=manifest,
        trigger_type=worker_row.get("trigger_type"),
        cron_expr=worker_row.get("cron_expr"),
        cron_timezone=worker_row.get("cron_timezone"),
        bundle_path=skill_version_row.get("bundle_path") if skill_version_row else None,
    )
    return {
        "id": worker_row["id"],
        "name": worker_row["name"],
        "description": manifest.get("description"),
        "long_description": manifest.get("long_description"),
        "use_cases": manifest.get("use_cases"),
        "example_input": manifest.get("example_input"),
        "example_output": manifest.get("example_output"),
        "how_it_works": manifest.get("how_it_works"),
        "tags": manifest.get("tags") or [],
        "folder": manifest.get("folder"),
        "status": "healthy",
        "trigger_type": worker_row.get("trigger_type") or (config.trigger.type if config else "manual"),
        "runner": config.runtime.runner if config and config.runtime else "local",
        "config": config.model_dump(mode="json") if config else {},
        "manifest": manifest,
        "manifest_json": manifest,
        "archived": bool(manifest.get("archived", False)),
        "archive_reason": manifest.get("archive_reason"),
        "bundle_path": skill_version_row.get("bundle_path") if skill_version_row else None,
        "triggers_json": _json_load(worker_row.get("triggers_json"), []),
        "skill_version_id": worker_row.get("skill_version_id"),
        "cron_expr": worker_row.get("cron_expr"),
        "cron_timezone": worker_row.get("cron_timezone"),
        "next_run_at": worker_row.get("next_run_at"),
        "last_scheduled_run_at": worker_row.get("last_scheduled_run_at"),
        "webhook_secret_hash": worker_row.get("webhook_secret_hash"),
        "notify_email": bool(worker_row.get("notify_email")),
        "notify_webhook_url": worker_row.get("notify_webhook_url"),
        "grants_json": _json_load(worker_row.get("grants_json"), {}),
        "input_values_json": _json_load(worker_row.get("input_values_json"), {}),
        "enabled": bool(worker_row.get("enabled", True)),
        "created_at": worker_row.get("created_at"),
        "owner_id": worker_row.get("user_id"),
        "workspace_id": worker_row.get("workspace_id"),
        "composio_trigger_id": worker_row.get("composio_trigger_id"),
        "composio_event": worker_row.get("composio_event"),
        "visibility": worker_row.get("visibility") or "private",
        "published_at": worker_row.get("published_at"),
        "clone_token_hash": worker_row.get("clone_token_hash"),
        "clone_token_expires_at": worker_row.get("clone_token_expires_at"),
    }


def _response_rows(response: Any) -> list[dict[str, Any]]:
    data = getattr(response, "data", None)
    if data is None:
        return []
    if isinstance(data, list):
        return [dict(item) if isinstance(item, Mapping) else item for item in data]
    if isinstance(data, Mapping):
        return [dict(data)]
    return []


def _as_aware_utc(value: datetime) -> datetime:
    """Coerce a datetime to timezone-aware UTC so cross-source timestamps
    (Postgres timestamptz vs an engine-generated ISO cutoff) compare safely.
    A naive datetime is assumed to already be UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _first_row(response: Any) -> dict[str, Any] | None:
    rows = _response_rows(response)
    return rows[0] if rows else None


def _is_missing_column_error(exc: Exception, column: str) -> bool:
    text = str(exc).lower()
    column = column.lower()
    return column in text and (
        "42703" in text
        or "does not exist" in text
        or "schema cache" in text
        or "could not find" in text
    )


def _bytea_literal(value: bytes | str | bytearray | memoryview | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, memoryview):
        value = value.tobytes()
    if isinstance(value, bytearray):
        value = bytes(value)
    if isinstance(value, bytes):
        return "\\x" + value.hex()
    text = value.strip()
    if not text:
        return None
    if text.startswith("\\x"):
        return text
    try:
        bytes.fromhex(text)
    except ValueError:
        return "\\x" + text.encode().hex()
    return "\\x" + text.lower()


def _bytea_bytes(value: Any) -> bytes | None:
    if value in (None, ""):
        return None
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, memoryview):
        return value.tobytes()
    if isinstance(value, str):
        text = value[2:] if value.startswith("\\x") else value
        try:
            return bytes.fromhex(text)
        except ValueError:
            return value.encode()
    return None


def _bytea_hex(value: Any) -> str | None:
    raw = _bytea_bytes(value)
    return raw.hex() if raw is not None else None


# ---------------------------------------------------------------------------
# Workspace scoping
# ---------------------------------------------------------------------------
#
# The cloud is workspace-scoped, but the engine code that calls these repos
# only knows about ``user_id`` (from AuthContext). The active workspace_id
# is set on a contextvar by SupabaseAuthProvider.verify on every HTTP
# request; we read it here.
#
# Two scoping modes:
#   1. Web request (contextvar set) -> filter by workspace_id.
#   2. Out-of-request (scheduler, webhook -- contextvar unset) -> fall back
#      to filtering by user_id. The scheduler/webhook code already passes
#      the worker's owner_id; user-scoped queries still return correct rows
#      because every workspace_id maps to exactly one owner.
#
# On INSERT we always set workspace_id. Resolution order:
#   a. ``workspace_id`` kwarg explicitly passed (rare; tests or future
#      cross-workspace tooling).
#   b. contextvar.
#   c. worker_id -> workspace_id lookup (scheduler / webhook trigger path).
#   d. user's default workspace (lazy create if zero exist).

def _scope_by_workspace(
    builder: Any,
    *,
    user_id: str | None,
    explicit_workspace_id: str | None = None,
) -> Any:
    """Apply the right scope filter to a Supabase query builder.

    Prefers workspace_id (active workspace for the request); falls back to
    user_id when the contextvar is unset and no explicit workspace_id is
    provided.
    """
    workspace_id = explicit_workspace_id or get_active_workspace_id()
    if workspace_id:
        return builder.eq("workspace_id", workspace_id)
    if user_id is not None:
        return builder.eq("user_id", user_id)
    return builder


def _log_admin_access(
    *,
    workspace_id: str,
    admin_user_id: str,
    target_user_id: str,
    resource_type: str,
    resource_id: str,
) -> None:
    """Silently append a row to admin_access_log. Never raises — logging must not break reads."""
    try:
        get_supabase_service_client().table("admin_access_log").insert(
            {
                "workspace_id": workspace_id,
                "admin_user_id": admin_user_id,
                "target_user_id": target_user_id,
                "resource_type": resource_type,
                "resource_id": resource_id,
            }
        ).execute()
    except Exception:
        _repo_logger.warning(
            "Failed to write admin_access_log for %s/%s", resource_type, resource_id, exc_info=True
        )


def _resolve_workspace_id_for_write(
    *,
    user_id: str,
    explicit_workspace_id: str | None = None,
    worker_id: str | None = None,
    email: str | None = None,
) -> str:
    """Resolve the workspace_id to stamp on a new row.

    Order: explicit kwarg -> contextvar -> worker's existing workspace_id
    -> user's default workspace (lazy-create if none). Always returns a
    non-empty string; never returns None.
    """
    if explicit_workspace_id:
        return explicit_workspace_id
    from_context = get_active_workspace_id()
    if from_context:
        return from_context
    if worker_id:
        existing = workspace_repo.workspace_id_for_worker(worker_id=worker_id)
        if existing:
            return existing
    active = workspace_repo.resolve_active_workspace(
        user_id=user_id,
        email=email,
        requested_id=None,
    )
    return str(active["id"])


class _BaseSupabaseRepository:
    def __init__(self, client: Client | None = None) -> None:
        self._client = client or get_supabase_service_client()


class SupabaseWorkerRepository(_BaseSupabaseRepository):
    def _scope_skill_versions(self, builder: Any) -> Any:
        workspace_id = get_active_workspace_id()
        if workspace_id:
            return builder.eq("workspace_id", workspace_id)
        return builder

    def _execute_skill_versions_scoped(self, builder_factory: Callable[[], Any]) -> Any:
        try:
            return self._scope_skill_versions(builder_factory()).execute()
        except Exception as exc:
            if not _is_missing_column_error(exc, "workspace_id"):
                raise
            _repo_logger.warning(
                "skill_versions.workspace_id is missing; running unscoped compatibility query. "
                "Apply supabase migration 0040_skill_versions_workspace_scope.sql.",
            )
            return builder_factory().execute()

    def _assert_skill_version_write_allowed(
        self,
        *,
        skill_version_id: str,
        workspace_id: str | None,
        user_id: str,
    ) -> None:
        try:
            existing = _first_row(
                self._client.table("skill_versions")
                .select("id,user_id,workspace_id")
                .eq("id", skill_version_id)
                .limit(1)
                .execute()
            )
        except Exception as exc:
            if not _is_missing_column_error(exc, "workspace_id"):
                raise
            existing = _first_row(
                self._client.table("skill_versions")
                .select("id,user_id")
                .eq("id", skill_version_id)
                .limit(1)
                .execute()
            )
        if existing is None:
            return
        existing_workspace_id = existing.get("workspace_id")
        if existing_workspace_id and workspace_id and existing_workspace_id != workspace_id:
            raise RuntimeError("skill version belongs to a different workspace")
        if str(existing.get("user_id") or "") != user_id and not existing_workspace_id:
            raise RuntimeError("skill version belongs to a different user")

    def _skill_versions_by_id(
        self, skill_version_ids: Iterable[str]
    ) -> dict[str, dict[str, Any]]:
        ids = [item for item in dict.fromkeys(skill_version_ids) if item]
        if not ids:
            return {}
        last_error: Exception | None = None
        for attempt in range(2):
            try:
                response = self._execute_skill_versions_scoped(
                    lambda: self._client.table("skill_versions").select("*").in_("id", ids)
                )
                break
            except Exception as exc:
                last_error = exc
                if attempt == 0:
                    time.sleep(0.2)
                    continue
                raise
        else:
            raise last_error or RuntimeError("failed to load skill versions")
        return {
            row["id"]: row
            for row in _response_rows(response)
        }

    def _worker_rows(
        self,
        *,
        user_id: str | None = None,
        worker_id: str | None = None,
        worker_ids: Iterable[str] | None = None,
    ) -> list[dict[str, Any]]:
        builder = self._client.table("workers").select("*")
        # Workspace scope: filter by workspace_id when set (per-request
        # contextvar). Falls back to user_id when out of request context.
        builder = _scope_by_workspace(builder, user_id=user_id)

        # Visibility filter: applies only inside a workspace-scoped request.
        # The read surface is can_view-scoped: own private workers plus shared
        # workers. Workspace admin inventory lives on /api/workspaces/{id}/workers.
        workspace_id_ctx = get_active_workspace_id()
        if workspace_id_ctx and user_id:
            builder = builder.or_(f"user_id.eq.{user_id},visibility.eq.shared")

        if worker_id is not None:
            builder = builder.eq("id", worker_id)
        if worker_ids is not None:
            ids = [item for item in dict.fromkeys(worker_ids) if item]
            if not ids:
                return []
            builder = builder.in_("id", ids)
        response = builder.order("created_at").order("id").execute()
        return _response_rows(response)

    def _worker_name_map(self, worker_ids: Iterable[str]) -> dict[str, str]:
        ids = [item for item in dict.fromkeys(str(wid) for wid in worker_ids) if item]
        cache = _recipe_cache.get()
        if cache is not None:
            # Fast path: all rows already fetched and cached.
            result: dict[str, str] = {}
            uncached = [wid for wid in ids if wid not in cache]
            for wid in ids:
                if wid in cache:
                    row, skill = cache[wid]
                    manifest = _json_load(skill.get("manifest_json"), {}) if skill else {}
                    result[wid] = str(manifest.get("title") or row.get("name") or wid)
            if uncached:
                workers = self._worker_rows(worker_ids=uncached)
                sv_map = self._skill_versions_by_id(
                    r.get("skill_version_id") for r in workers if r.get("skill_version_id")
                )
                for row in workers:
                    skill = sv_map.get(row.get("skill_version_id"))
                    manifest = _json_load(skill.get("manifest_json"), {}) if skill else {}
                    result[str(row["id"])] = str(manifest.get("title") or row.get("name") or row["id"])
            return result

        workers = self._worker_rows(worker_ids=ids)
        skill_map = self._skill_versions_by_id(
            row.get("skill_version_id") for row in workers if row.get("skill_version_id")
        )
        result = {}
        for row in workers:
            skill = skill_map.get(row.get("skill_version_id"))
            manifest = _json_load(skill.get("manifest_json"), {}) if skill else {}
            result[str(row["id"])] = str(manifest.get("title") or row.get("name") or row["id"])
        return result

    def list(self, *, user_id: str, role: str | None = None) -> list[dict[str, Any]]:
        rows = self._worker_rows(user_id=user_id)
        skill_map = self._skill_versions_by_id(
            row.get("skill_version_id") for row in rows if row.get("skill_version_id")
        )
        # Populate request-scoped recipe cache so get_recipe() can skip per-worker
        # DB fetches during the engine's get_worker_config_for_run() loop.
        cache: dict[str, tuple[dict, dict | None]] = {
            str(row["id"]): (row, skill_map.get(row.get("skill_version_id")))
            for row in rows
            if row.get("id")
        }
        _recipe_cache.set(cache)
        return [
            _worker_record_from_rows(row, skill_map.get(row.get("skill_version_id")))
            for row in rows
        ]

    def list_for_agent(
        self,
        *,
        user_id: str,
        include_all_users: bool = False,
        stock_worker_ids: Iterable[str] = (),
    ) -> list[dict[str, Any]]:
        """Cloud impl of WorkerRepository.list_for_agent (engine #1027).

        Workers are workspace-scoped in Supabase, so list() already returns the
        right visible set — stock_worker_ids (an OSS filesystem concept) do not
        apply. Mirror the engine's intent: the default (not include_all_users)
        is the member view even for admins, so a personal "what workers do I
        have?" never leaks another member's private workers. Reshape to the
        engine tool's row shape; manifest_json MUST be a JSON string (the tool
        json.loads it).

        Round-09 #3: include ``owner_id`` so this matches the OSS sqlite
        ``list_for_agent`` row shape. The engine chat tool's hide-helpers
        (``_worker_hidden_from_api`` / ``_build_owned_tracked_ids``) and the
        dashboard grid both key on owner_id; dropping it here left the cloud
        Emily surface unable to attribute ownership the way the grid does
        (the 1-vs-9 split-brain follow-up).
        """
        role = "admin" if (include_all_users and get_active_member_role() == "admin") else "member"
        records = self.list(user_id=user_id, role=role)
        rows: list[dict[str, Any]] = []
        for rec in records:
            manifest = rec.get("manifest") if isinstance(rec.get("manifest"), dict) else {}
            rows.append(
                {
                    "id": rec.get("id"),
                    "name": rec.get("name"),
                    "trigger_type": rec.get("trigger_type"),
                    "enabled": bool(rec.get("enabled", True)),
                    # _worker_record_from_rows maps workers.user_id -> owner_id;
                    # carry it through so the engine tool + grid hide helpers
                    # attribute ownership identically on cloud.
                    "owner_id": rec.get("owner_id"),
                    "manifest_json": json.dumps(manifest),
                }
            )
        return rows

    def get_for_agent(
        self,
        *,
        user_id: str,
        worker_id: str,
        stock_worker_ids: Iterable[str] = (),
        allow_fs_fallback: bool = False,
    ) -> dict[str, Any] | None:
        """Cloud impl of WorkerRepository.get_for_agent (engine #1027).

        Delegate to get(), which already enforces workspace-scoped visibility;
        reshape to the engine tool's row shape (manifest_json as a JSON string).
        """
        rec = self.get(user_id=user_id, worker_id=worker_id, role=get_active_member_role())
        if not rec:
            return None
        manifest = rec.get("manifest") if isinstance(rec.get("manifest"), dict) else {}
        return {
            "id": rec.get("id"),
            "name": rec.get("name"),
            "trigger_type": rec.get("trigger_type"),
            "enabled": bool(rec.get("enabled", True)),
            "cron_expr": rec.get("cron_expr"),
            "manifest_json": json.dumps(manifest),
        }

    def get(self, *, user_id: str, worker_id: str, role: str | None = None) -> dict[str, Any] | None:
        # Fast path: reuse the raw rows already fetched by list() in this request.
        recipe_cache = _recipe_cache.get()
        if recipe_cache is not None:
            cached = recipe_cache.get(worker_id)
            if cached is not None:
                row, skill = cached
                return _worker_record_from_rows(row, skill)

        rows = self._worker_rows(user_id=user_id, worker_id=worker_id)
        if not rows:
            if not get_active_workspace_id():
                return None
            response = (
                self._client.table("workers")
                .select("*")
                .eq("id", worker_id)
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            row = _first_row(response)
            if row is None:
                return None
        else:
            row = rows[0]
        # Log when an admin reads a private worker they don't own.
        workspace_id_ctx = get_active_workspace_id()
        if (
            workspace_id_ctx
            and get_active_member_role() == "admin"
            and str(row.get("user_id", "")) != str(user_id)
            and (row.get("visibility") or "private") == "private"
        ):
            _log_admin_access(
                workspace_id=workspace_id_ctx,
                admin_user_id=user_id,
                target_user_id=str(row.get("user_id", "")),
                resource_type="worker",
                resource_id=worker_id,
            )
        skill_map = self._skill_versions_by_id([row.get("skill_version_id")])
        return _worker_record_from_rows(row, skill_map.get(row.get("skill_version_id")))

    def get_any(self, *, worker_id: str) -> dict[str, Any] | None:
        # Contract (engine db.interface + OSS sqlite impl): get_any is a
        # GLOBAL, UNSCOPED existence check keyed on the worker id alone
        # (``id TEXT PRIMARY KEY`` on the workers table). It MUST NOT be
        # workspace- or user-scoped — _free_worker_id (#54/#186) relies on
        # it to detect cross-workspace id collisions during draft-and-create.
        #
        # Bug: routing through _worker_rows() applied _scope_by_workspace,
        # so when the active-workspace contextvar was set, get_any could not
        # see a row owned by the SAME user in a DIFFERENT workspace. Dedupe
        # then judged the colliding id "free", the insert hit the global PK,
        # and draft-and-create 409'd with "failed to upsert <id>". Query by
        # id only, bypassing all scoping.
        response = (
            self._client.table("workers")
            .select("*")
            .eq("id", worker_id)
            .limit(1)
            .execute()
        )
        rows = _response_rows(response)
        if not rows:
            return None
        row = rows[0]
        skill_map = self._skill_versions_by_id([row.get("skill_version_id")])
        return _worker_record_from_rows(row, skill_map.get(row.get("skill_version_id")))

    def _sync_disk_files_to_manifest(self, worker_id: str, skill_version_id: str) -> None:
        """#269: persist on-disk worker files into manifest_json._files.

        The engine chat tools (Emily) write code to the handling instance's
        ephemeral disk and persist through this repo, but never populate
        _files — only the REST path did. Without _files, get_recipe on another
        instance materializes nothing and runs fail with "Worker directory not
        found". This captures the current on-disk files for the worker.

        Defensive + idempotent: no-op when the disk dir is empty (so a fileless
        instance can NEVER clobber a good _files), and skips the write when
        _files already equals what's on disk. Never raises — a capture failure
        must not break the worker write.
        """
        try:
            disk_files = _read_worker_files_from_disk(worker_id)
            if not disk_files:
                return
            resp = self._execute_skill_versions_scoped(
                lambda: self._client.table("skill_versions")
                .select("manifest_json")
                .eq("id", skill_version_id)
                .limit(1)
            )
            rows = resp.data or []
            if not rows:
                return
            manifest = _json_load(rows[0].get("manifest_json"), {})
            if not isinstance(manifest, dict):
                return
            if manifest.get("_files") == disk_files:
                return
            manifest["_files"] = disk_files
            self._execute_skill_versions_scoped(
                lambda: self._client.table("skill_versions")
                .update({"manifest_json": manifest})
                .eq("id", skill_version_id)
            )
            _repo_logger.info(
                "#269 captured %d on-disk file(s) into _files for worker %s",
                len(disk_files),
                worker_id,
            )
        except Exception:
            _repo_logger.warning(
                "#269 disk->_files capture failed for worker %s", worker_id, exc_info=True
            )

    def create(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        worker_id = fields["worker_id"]
        manifest_json = _json_storage_value(fields.get("manifest_json"), {})
        name = fields.get("name") or manifest_json.get("title") or manifest_json.get("name") or worker_id
        created_at = fields.get("created_at") or datetime.now(timezone.utc).isoformat()
        skill_version_id = fields.get("skill_version_id") or _skill_version_id(worker_id, manifest_json)
        workspace_id = _resolve_workspace_id_for_write(
            user_id=user_id,
            explicit_workspace_id=fields.get("workspace_id"),
        )
        self._assert_skill_version_write_allowed(
            skill_version_id=skill_version_id,
            workspace_id=workspace_id,
            user_id=user_id,
        )
        self._client.table("skill_versions").upsert(
            {
                "id": skill_version_id,
                "workspace_id": workspace_id,
                "user_id": user_id,
                "name": manifest_json.get("name") or name,
                "version": str(manifest_json.get("version") or "0.1.0"),
                "manifest_json": manifest_json,
                "bundle_path": fields.get("bundle_path") or f"workers/{worker_id}",
                "created_at": created_at,
            },
            on_conflict="id",
        ).execute()
        self._client.table("workers").insert(
            {
                "id": worker_id,
                "user_id": user_id,
                "workspace_id": workspace_id,
                "skill_version_id": skill_version_id,
                "name": name,
                "trigger_type": fields.get("trigger_type") or "manual",
                "cron_expr": fields.get("cron_expr"),
                "cron_timezone": fields.get("cron_timezone"),
                "next_run_at": fields.get("next_run_at"),
                "last_scheduled_run_at": fields.get("last_scheduled_run_at"),
                "webhook_secret_hash": _bytea_literal(fields.get("webhook_secret_hash")),
                "notify_email": bool(fields.get("notify_email")),
                "notify_webhook_url": fields.get("notify_webhook_url"),
                "grants_json": _json_storage_value(fields.get("grants_json"), {}),
                "input_values_json": _json_storage_value(fields.get("input_values_json"), {}),
                "enabled": bool(fields.get("enabled", True)),
                "created_at": created_at,
                "composio_trigger_id": fields.get("composio_trigger_id"),
                "composio_event": fields.get("composio_event"),
                "triggers_json": _json_storage_value(fields.get("triggers_json"), []),
            }
        ).execute()
        # #269: capture any code the engine chat tool wrote to disk into _files.
        self._sync_disk_files_to_manifest(worker_id, skill_version_id)
        created = self.get(user_id=user_id, worker_id=worker_id)
        if created is None:
            raise RuntimeError(f"failed to create worker {worker_id}")
        return created

    def upsert(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        """Insert-or-update a worker row in Supabase.

        Called by the engine's _persist_discovered_workers after a worker
        is drafted, created, or updated. Idempotent across repeated
        discovery passes. Verifies ownership when updating: rows owned by
        a different user are NOT clobbered (raises).
        """
        worker_id = fields["worker_id"]
        manifest_json = _json_storage_value(fields.get("manifest_json"), {})
        name = (
            fields.get("name")
            or manifest_json.get("title")
            or manifest_json.get("name")
            or worker_id
        )
        created_at = fields.get("created_at") or datetime.now(timezone.utc).isoformat()
        skill_version_id = fields.get("skill_version_id") or _skill_version_id(
            worker_id, manifest_json
        )

        # Ownership guard: if the row exists under a different user_id we must
        # never reassign it (no theft / no clobber of another tenant's worker).
        #
        # The engine's _persist_discovered_workers re-upserts EVERY worker it
        # discovers on the shared filesystem on every draft-and-create — and
        # in cloud the shared var/workers/ holds demo/seed bundles owned by
        # DIFFERENT demo users (e.g. morning-brief/meeting-prep/slack-weekly-
        # recap are seeded to depontefede@gmail.com, applicant-followup et al.
        # to fede@rocketlist.ai). So when fede drafts a new worker, the bulk
        # re-persist pass reaches meeting-prep (owned by depontefede) and the
        # old behavior RAISED, and the engine re-raises, aborting the WHOLE
        # draft with a 409 — even though the user's newly authored worker was
        # written fine.
        #
        # Skipping (returning the existing row unchanged) is safe here:
        #   - It does NOT reassign ownership or mutate the other tenant's row.
        #   - It is NOT a theft vector: an INTENTIONAL create can never reach a
        #     cross-user id, because _free_worker_id (#54/#186) consults the
        #     unscoped get_any and renames any colliding id to a free one
        #     BEFORE we get here. A cross-user collision at upsert time is
        #     therefore always a discovery re-persist of a shared seed bundle,
        #     never a claim attempt.
        existing_owner = self.get_owner(worker_id=worker_id)
        if existing_owner is not None and existing_owner != user_id:
            existing_row = self.get_any(worker_id=worker_id)
            if existing_row is not None:
                return existing_row
            raise RuntimeError(
                f"worker {worker_id!r} already exists for a different user"
            )

        workspace_id = _resolve_workspace_id_for_write(
            user_id=user_id,
            explicit_workspace_id=fields.get("workspace_id"),
            worker_id=worker_id,
        )
        self._assert_skill_version_write_allowed(
            skill_version_id=skill_version_id,
            workspace_id=workspace_id,
            user_id=user_id,
        )

        self._client.table("skill_versions").upsert(
            {
                "id": skill_version_id,
                "workspace_id": workspace_id,
                "user_id": user_id,
                "name": manifest_json.get("name") or name,
                "version": str(manifest_json.get("version") or "0.1.0"),
                "manifest_json": manifest_json,
                "bundle_path": fields.get("bundle_path") or f"workers/{worker_id}",
                "created_at": created_at,
            },
            on_conflict="id",
        ).execute()

        worker_payload: dict[str, Any] = {
            "id": worker_id,
            "user_id": user_id,
            "skill_version_id": skill_version_id,
            "name": name,
            "trigger_type": fields.get("trigger_type") or "manual",
            "cron_expr": fields.get("cron_expr"),
            "cron_timezone": fields.get("cron_timezone"),
            "grants_json": _json_storage_value(fields.get("grants_json"), {}),
            "input_values_json": _json_storage_value(fields.get("input_values_json"), {}),
            "enabled": bool(fields.get("enabled", True)),
            "created_at": created_at,
            "composio_trigger_id": fields.get("composio_trigger_id"),
            "composio_event": fields.get("composio_event"),
            "triggers_json": _json_storage_value(fields.get("triggers_json"), []),
        }
        # Don't clobber notify_* and next_run_at on update; only set on
        # insert. PostgREST upsert applies the whole payload on conflict,
        # so we have to branch.
        if existing_owner is None:
            # On insert: stamp workspace_id. On update: leave it as-is
            # (a worker's workspace doesn't change after creation; the
            # engine's _persist_discovered_workers re-runs upsert on
            # every discovery pass).
            worker_payload["workspace_id"] = workspace_id
            worker_payload.update(
                {
                    "next_run_at": fields.get("next_run_at"),
                    "last_scheduled_run_at": fields.get("last_scheduled_run_at"),
                    "webhook_secret_hash": _bytea_literal(fields.get("webhook_secret_hash")),
                    "notify_email": bool(fields.get("notify_email")),
                    "notify_webhook_url": fields.get("notify_webhook_url"),
                }
            )
            self._client.table("workers").insert(worker_payload).execute()
        else:
            self._client.table("workers").update(worker_payload).eq(
                "id", worker_id
            ).eq("user_id", user_id).execute()

        # Verify with the GLOBAL (unscoped) read, not self.get(): self.get()
        # is workspace-scoped (via _worker_rows -> _scope_by_workspace), so
        # when the active-workspace contextvar differs from the row's actual
        # workspace it returns None and we'd falsely raise even though the
        # write above (insert/update keyed on id+user_id) succeeded.
        #
        # This poisoned every draft-and-create: _persist_discovered_workers
        # re-upserts ALL discovered workers (including stock seed bundles like
        # applicant-followup, whose DB row lives in another workspace), and
        # the scoped verify on that pre-existing worker raised
        # "failed to upsert applicant-followup" — aborting the whole draft
        # even when the newly authored worker was fine.
        # #269: capture any code the engine wrote to disk into _files.
        self._sync_disk_files_to_manifest(worker_id, skill_version_id)
        upserted = self.get_any(worker_id=worker_id)
        if upserted is None:
            raise RuntimeError(f"failed to upsert worker {worker_id}")
        return upserted

    def update(self, *, user_id: str, worker_id: str, **fields: Any) -> dict[str, Any] | None:
        worker = self.get(user_id=user_id, worker_id=worker_id)
        if worker is None:
            return None
        manifest_json = fields.pop("manifest_json", None)
        bundle_path = fields.pop("bundle_path", None)
        if manifest_json is not None or bundle_path is not None:
            payload: dict[str, Any] = {}
            if manifest_json is not None:
                payload["manifest_json"] = _json_storage_value(manifest_json, {})
            if bundle_path is not None:
                payload["bundle_path"] = bundle_path
            self._execute_skill_versions_scoped(
                lambda: self._client.table("skill_versions")
                .update(payload)
                .eq("id", worker["skill_version_id"])
            )
        payload: dict[str, Any] = {}
        for key in (
            "name",
            "trigger_type",
            "cron_expr",
            "cron_timezone",
            "next_run_at",
            "last_scheduled_run_at",
            "webhook_secret_hash",
            "notify_webhook_url",
            "composio_trigger_id",
            "composio_event",
        ):
            if key in fields:
                if key == "webhook_secret_hash":
                    payload[key] = _bytea_literal(fields[key])
                else:
                    payload[key] = fields[key]
        if "notify_email" in fields:
            payload["notify_email"] = bool(fields["notify_email"])
        if "enabled" in fields:
            payload["enabled"] = bool(fields["enabled"])
        if "grants_json" in fields:
            payload["grants_json"] = _json_storage_value(fields["grants_json"], {})
        if "input_values_json" in fields:
            payload["input_values_json"] = _json_storage_value(fields["input_values_json"], {})
        if "triggers_json" in fields:
            payload["triggers_json"] = _json_storage_value(fields["triggers_json"], [])
        if payload:
            builder = self._client.table("workers").update(payload).eq("id", worker_id)
            builder = _scope_by_workspace(builder, user_id=user_id)
            builder.execute()
        # #269: an update is the point where the engine's canonical editor path
        # (persist_worker_run_py) has written run.py to disk — capture it.
        self._sync_disk_files_to_manifest(worker_id, str(worker["skill_version_id"]))
        return self.get(user_id=user_id, worker_id=worker_id)

    def delete(self, *, user_id: str, worker_id: str) -> bool:
        builder = self._client.table("workers").delete().eq("id", worker_id)
        builder = _scope_by_workspace(builder, user_id=user_id)
        # Members may only delete their own workers, never shared or other-owned ones.
        if get_active_member_role():
            builder = builder.eq("user_id", user_id)
        response = builder.execute()
        return bool(_response_rows(response))

    def list_recent_runs(
        self,
        *,
        user_id: str,
        worker_id: str,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        builder = self._client.table("runs").select(
            "id,worker_id,status,trigger_source,created_at,started_at,completed_at,duration_ms,error"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        builder = builder.eq("worker_id", worker_id)
        response = builder.order("created_at", desc=True).limit(limit).execute()
        return _response_rows(response)

    def get_last_run(self, *, user_id: str, worker_id: str) -> dict[str, Any] | None:
        cache = _last_run_batch.get()
        if cache is not None:
            return cache.get(worker_id)
        runs = self.list_recent_runs(user_id=user_id, worker_id=worker_id, limit=1)
        return runs[0] if runs else None

    def stats_batch(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        days: int = 7,
    ) -> dict[str, RecentStats]:
        if not worker_ids:
            _last_run_batch.set({})
            return {}
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        builder = self._client.table("runs").select("worker_id,status,created_at")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = (
            builder
            .in_("worker_id", worker_ids)
            .gte("created_at", cutoff)
            .execute()
        )
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in _response_rows(response):
            grouped[str(row["worker_id"])].append(row)
        result: dict[str, RecentStats] = {}
        for worker_id, rows in grouped.items():
            last_run_at = max((str(row.get("created_at")) for row in rows if row.get("created_at")), default=None)
            total = len(rows)
            completed = sum(1 for row in rows if row.get("status") == RunStatus.COMPLETED.value)
            result[worker_id] = RecentStats(
                last_run_at=last_run_at,
                runs_7d=total,
                success_rate_7d=(completed / total) if total else None,
            )

        # Batch-prefetch the last run for every worker into the request-scoped
        # contextvar. This replaces N sequential get_last_run() calls (one DB
        # round-trip per worker) with one DISTINCT ON query, cutting
        # workers?shape=list from ~7 s to <1 s.
        workspace_id = get_active_workspace_id()
        if workspace_id:
            try:
                rpc_resp = get_supabase_service_client().rpc(
                    "get_last_run_per_worker",
                    {"p_workspace_id": workspace_id, "p_worker_ids": worker_ids},
                ).execute()
                batch: dict[str, Any] = {}
                for row in (rpc_resp.data or []):
                    wid = str(row.get("worker_id", ""))
                    if wid:
                        batch[wid] = row
                for wid in worker_ids:
                    batch.setdefault(wid, None)
                _last_run_batch.set(batch)
            except Exception:
                # Cache miss is non-fatal — get_last_run falls back to per-worker
                # queries — but the RPC failing means a slow degraded path (and a
                # likely-broken get_last_run_per_worker RPC / migration), so make
                # it visible rather than silent.
                _repo_logger.warning(
                    "get_last_run_per_worker RPC failed for workspace %s (%d workers); "
                    "falling back to per-worker queries",
                    workspace_id,
                    len(worker_ids),
                    exc_info=True,
                )

        return result

    def timeseries_batch(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        days: int = 14,
    ) -> dict[str, list[TimeseriesDay]]:
        if not worker_ids:
            return {}
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        builder = self._client.table("runs").select("worker_id,status,created_at")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = (
            builder
            .in_("worker_id", worker_ids)
            .gte("created_at", cutoff)
            .execute()
        )
        by_worker_day: dict[tuple[str, str], dict[str, int]] = defaultdict(
            lambda: {"total": 0, "completed": 0, "failed": 0}
        )
        for row in _response_rows(response):
            created_at = str(row.get("created_at") or "")
            day = created_at[:10]
            if not day:
                continue
            key = (str(row["worker_id"]), day)
            by_worker_day[key]["total"] += 1
            if row.get("status") == RunStatus.COMPLETED.value:
                by_worker_day[key]["completed"] += 1
            if row.get("status") == RunStatus.FAILED.value:
                by_worker_day[key]["failed"] += 1
        today = date.today()
        range_days = [
            (today - timedelta(days=idx)).isoformat()
            for idx in range(days - 1, -1, -1)
        ]
        result: dict[str, list[TimeseriesDay]] = {}
        for worker_id in worker_ids:
            items: list[TimeseriesDay] = []
            for day in range_days:
                bucket = by_worker_day.get((worker_id, day), {"total": 0, "completed": 0, "failed": 0})
                items.append(
                    TimeseriesDay(
                        date=day,
                        total=bucket["total"],
                        completed=bucket["completed"],
                        failed=bucket["failed"],
                    )
                )
            result[worker_id] = items
        return result

    def get_owner(self, *, worker_id: str) -> str | None:
        response = (
            self._client.table("workers")
            .select("user_id")
            .eq("id", worker_id)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        return str(row["user_id"]) if row else None

    def list_scheduled(self) -> list[dict[str, Any]]:
        response = (
            self._client.table("workers")
            .select("id,user_id,cron_expr,next_run_at")
            .eq("enabled", True)
            .eq("trigger_type", "schedule")
            .order("created_at")
            .order("id")
            .execute()
        )
        return [
            {
                "id": row["id"],
                "owner_id": row.get("user_id"),
                "cron_expr": row.get("cron_expr"),
                "next_run_at": row.get("next_run_at"),
            }
            for row in _response_rows(response)
        ]

    def get_schedule_state(self, *, worker_id: str) -> dict[str, Any] | None:
        response = (
            self._client.table("workers")
            .select("user_id,next_run_at,cron_expr")
            .eq("id", worker_id)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        if row is None:
            return None
        return {
            "owner_id": row.get("user_id"),
            "next_run_at": row.get("next_run_at"),
            "cron_expr": row.get("cron_expr"),
        }

    def set_next_run_at(self, *, worker_id: str, next_run_at: str | None) -> None:
        self._client.table("workers").update({"next_run_at": next_run_at}).eq(
            "id",
            worker_id,
        ).execute()

    def mark_scheduled_run(
        self,
        *,
        worker_id: str,
        last_scheduled_run_at: str,
        next_run_at: str | None,
    ) -> None:
        self._client.table("workers").update(
            {
                "last_scheduled_run_at": last_scheduled_run_at,
                "next_run_at": next_run_at,
            }
        ).eq("id", worker_id).execute()

    def list_active_run_ids(self, *, user_id: str, worker_id: str) -> list[str]:
        builder = self._client.table("runs").select("id")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = (
            builder
            .eq("worker_id", worker_id)
            .in_("status", [RunStatus.QUEUED.value, RunStatus.RUNNING.value])
            .order("created_at")
            .execute()
        )
        return [str(row["id"]) for row in _response_rows(response)]

    def get_skill_version_ref_count(self, *, skill_version_id: str | None) -> int:
        if not skill_version_id:
            return 0
        response = (
            self._client.table("workers")
            .select("id", count="exact")
            .eq("skill_version_id", skill_version_id)
            .execute()
        )
        return int(getattr(response, "count", 0) or 0)

    def delete_skill_version(self, *, skill_version_id: str) -> None:
        self._execute_skill_versions_scoped(
            lambda: self._client.table("skill_versions").delete().eq("id", skill_version_id)
        )

    def get_recipe(
        self,
        *,
        worker_id: str,
        user_id: str | None = None,
    ) -> dict[str, Any] | None:
        cache = _recipe_cache.get()
        # A populated recipe cache means we're inside a list/batch render: list()
        # pre-fetches every visible worker, and those callers want config metadata
        # for display, NOT the code files on disk. Single-worker resolves
        # (runs/scheduler) leave the cache empty and DO need materialization.
        batch_render = cache is not None and worker_id in cache
        if batch_render:
            worker, skill = cache[worker_id]
            skill_map = {worker.get("skill_version_id"): skill} if skill else {}
        else:
            rows = self._worker_rows(user_id=user_id, worker_id=worker_id)
            if not rows:
                return None
            worker = rows[0]
            skill_map = self._skill_versions_by_id([worker.get("skill_version_id")])
        skill = skill_map.get(worker.get("skill_version_id"))
        if not skill:
            return None

        # Work on a copy so we never mutate the Supabase response object.
        manifest_json = dict(_json_load(skill.get("manifest_json"), {}))
        # Self-heal a clobbered manifest (contract lost, recipe still in _files)
        # before stripping _files, so the run resolves the real recipe.
        manifest_json = _heal_manifest_contract(manifest_json, worker_id=worker_id)

        # Cloud: Supabase is the source of truth for worker code. If
        # _files is present in manifest_json, materialize them to
        # WORKERS_DIR so the engine's skill/e2b drivers find them at
        # the expected filesystem path. Strip _files before passing to
        # parse_worker_manifest so the config parser never sees it.
        embedded_files = manifest_json.pop("_files", None)
        # Skip the disk write on list/batch renders. Writing every worker's bundle
        # per /workers render (mkdir + write_text per file, x N workers) was the
        # dominant endpoint latency (~4s for 6 workers); the list never reads these
        # files. Runs/scheduler (batch_render=False) still materialize before exec.
        if embedded_files and isinstance(embedded_files, dict) and not batch_render:
            _materialize_worker_files(
                str(worker["id"]),
                _sanitize_worker_files(embedded_files),
                version_key=f"{worker['id']}::{skill.get('id')}",
            )

        config = _config_from_manifest(
            worker_id=str(worker["id"]),
            manifest_json=manifest_json,
            trigger_type=worker.get("trigger_type"),
            cron_expr=worker.get("cron_expr"),
            cron_timezone=worker.get("cron_timezone"),
            bundle_path=skill.get("bundle_path"),
        )
        return {
            "config": config,
            "grants": _json_load(worker.get("grants_json"), {}),
            "input_values": _json_load(worker.get("input_values_json"), {}),
            "enabled": bool(worker.get("enabled", True)),
            "owner_id": worker.get("user_id"),
            "bundle_path": skill.get("bundle_path"),
            "manifest_json": manifest_json,
        }

    def upsert_webhook_secret_hash(
        self,
        *,
        worker_id: str,
        secret_hash: bytes | str,
        created_at: str,
        rotated_at: str,
    ) -> None:
        _ = created_at
        _ = rotated_at
        if self.get_any(worker_id=worker_id) is None:
            raise ValueError(f"worker {worker_id} not found")
        self._client.table("workers").update(
            {"webhook_secret_hash": _bytea_literal(secret_hash)}
        ).eq("id", worker_id).execute()

    def get_webhook_secret_hash(self, *, worker_id: str) -> str | None:
        worker_response = (
            self._client.table("workers")
            .select("webhook_secret_hash")
            .eq("id", worker_id)
            .limit(1)
            .execute()
        )
        worker = _first_row(worker_response)
        return _bytea_hex(worker.get("webhook_secret_hash")) if worker else None

    def delete_webhook_secret(self, *, worker_id: str) -> bool:
        existed = self.get_webhook_secret_hash(worker_id=worker_id) is not None
        self._client.table("workers").update({"webhook_secret_hash": None}).eq(
            "id",
            worker_id,
        ).execute()
        return existed

    def get_by_clone_token(self, *, token_hash: str) -> dict[str, Any] | None:
        response = (
            self._client.table("workers")
            .select("*")
            .eq("clone_token_hash", token_hash)
            .limit(1)
            .execute()
        )
        rows = _response_rows(response)
        if not rows:
            return None
        row = rows[0]
        skill_map = self._skill_versions_by_id([row.get("skill_version_id")])
        return _worker_record_from_rows(row, skill_map.get(row.get("skill_version_id")))

    def set_visibility(self, *, worker_id: str, visibility: str) -> None:
        client = self._client
        existing = (
            client.table("workers")
            .select("published_at,visibility")
            .eq("id", worker_id)
            .limit(1)
            .execute()
        )
        row = _first_row(existing)
        current_published_at = row.get("published_at") if row else None
        update: dict[str, Any] = {"visibility": visibility}
        if visibility == "shared" and not current_published_at:
            update["published_at"] = datetime.now(timezone.utc).isoformat()
        client.table("workers").update(update).eq("id", worker_id).execute()

    def set_clone_token(self, *, worker_id: str, token_hash: str, expires_at: str) -> None:
        self._client.table("workers").update(
            {
                "clone_token_hash": token_hash,
                "clone_token_expires_at": expires_at,
            }
        ).eq("id", worker_id).execute()

    # -- worker_triggers (normalized multi-trigger rows) ---------------------
    #
    # Cloud mirror of the engine's SqliteWorkerRepository trigger methods
    # (engine/apps/api/db/sqlite.py). The engine scheduler.py + main.py webhook
    # path call these UNGUARDED, so the Supabase repo must implement them or
    # scheduled/webhook workers raise AttributeError in cloud mode.
    #
    # Row identity is DETERMINISTIC (id = trg_<worker_id>_<position>) so updating
    # a worker's triggers updates the same rows instead of churning them.
    # workspace_id is denormalized from the parent worker so the multi-tenant
    # scheduler/webhook path is tenant-correct without a request context.

    @staticmethod
    def _trigger_config_for(trigger: dict[str, Any]) -> dict[str, Any]:
        """Strip the redundant ``type`` key; keep the per-trigger config payload."""
        return {k: v for k, v in trigger.items() if k != "type" and v is not None}

    def reconcile_triggers(
        self,
        *,
        worker_id: str,
        triggers: list[dict[str, Any]],
        external_trigger_id: str | None = None,
        enabled: bool = True,
    ) -> list[dict[str, Any]]:
        """Sync worker_triggers rows to exactly match the declared triggers.

        One row per declared trigger; rows for removed triggers are deleted.
        Preserves next_run_at/last_fired_at across reconciles when a schedule
        trigger's config is unchanged, so the scheduler slot stays stable.
        Mirrors SqliteWorkerRepository.reconcile_triggers_conn.
        """
        client = self._client
        now = datetime.now(timezone.utc).isoformat()
        workspace_id = workspace_repo.workspace_id_for_worker(worker_id=worker_id)

        existing_rows = _response_rows(
            client.table("worker_triggers").select("*").eq("worker_id", worker_id).execute()
        )
        existing = {str(row.get("id")): row for row in existing_rows}

        kept_ids: list[str] = []
        for position, trigger in enumerate(triggers):
            if not isinstance(trigger, dict):
                continue
            t_type = str(trigger.get("type") or "manual").strip().lower()
            if t_type in {"cron", "scheduled"}:
                t_type = "schedule"
            if t_type == "composio":
                t_type = "composio_event"
            trigger_id = f"trg_{worker_id}_{position}"
            kept_ids.append(trigger_id)
            config_json = json.dumps(self._trigger_config_for(trigger))
            ext_id = external_trigger_id if t_type == "composio_event" else None
            webhook_path = worker_id if t_type == "webhook" else None

            prior = existing.get(trigger_id)
            next_run_at = None
            last_fired_at = None
            if prior:
                if t_type == "schedule" and prior.get("config_json") == config_json:
                    next_run_at = prior.get("next_run_at")
                last_fired_at = prior.get("last_fired_at")

            payload = {
                "id": trigger_id,
                "workspace_id": workspace_id,
                "worker_id": worker_id,
                "type": t_type,
                "config_json": config_json,
                "enabled": bool(enabled),
                "next_run_at": next_run_at,
                "external_trigger_id": ext_id,
                "webhook_path": webhook_path,
                "last_fired_at": last_fired_at,
                "position": position,
                "created_at": (prior or {}).get("created_at") or now,
                "updated_at": now,
            }
            # Upsert on the deterministic id (matches engine ON CONFLICT(id)).
            client.table("worker_triggers").upsert(payload, on_conflict="id").execute()

        # Delete rows for triggers that no longer exist.
        if kept_ids:
            stale = [tid for tid in existing if tid not in set(kept_ids)]
            for tid in stale:
                client.table("worker_triggers").delete().eq("id", tid).execute()
        else:
            client.table("worker_triggers").delete().eq("worker_id", worker_id).execute()

        return self.list_trigger_rows(worker_id=worker_id)

    def list_trigger_rows(self, *, worker_id: str) -> list[dict[str, Any]]:
        rows = _response_rows(
            self._client.table("worker_triggers")
            .select("*")
            .eq("worker_id", worker_id)
            .order("position")
            .order("id")
            .execute()
        )
        return rows

    def list_due_schedule_triggers(self, *, now_iso: str) -> list[dict[str, Any]]:
        """Return enabled schedule trigger rows joined to enabled workers.

        next_run_at due-comparison is done by the caller (the scheduler also
        handles NULL next_run_at). Each row carries ``owner_id`` (the worker's
        user_id) and ``workspace_id`` so the cloud scheduler fires each run
        under the correct tenant + owner. PostgREST cannot express the engine's
        JOIN+filter cleanly, so this resolves the owning workers in a second
        query and filters to enabled ones.
        """
        client = self._client
        trigger_rows = _response_rows(
            client.table("worker_triggers")
            .select("id,worker_id,workspace_id,config_json,next_run_at,last_fired_at")
            .eq("type", "schedule")
            .eq("enabled", True)
            .order("worker_id")
            .order("position")
            .order("id")
            .execute()
        )
        if not trigger_rows:
            return []

        worker_ids = list({str(r.get("worker_id")) for r in trigger_rows if r.get("worker_id")})
        worker_rows = _response_rows(
            client.table("workers")
            .select("id,user_id,enabled")
            .in_("id", worker_ids)
            .execute()
        )
        # enabled defaults to True when the column is absent/NULL (engine treats
        # a worker as enabled unless explicitly disabled).
        enabled_owner: dict[str, str | None] = {
            str(w.get("id")): w.get("user_id")
            for w in worker_rows
            if w.get("enabled") is None or bool(w.get("enabled"))
        }

        due: list[dict[str, Any]] = []
        for row in trigger_rows:
            wid = str(row.get("worker_id"))
            if wid not in enabled_owner:
                continue
            enriched = dict(row)
            enriched["owner_id"] = enabled_owner[wid]
            due.append(enriched)
        return due

    def set_trigger_next_run_at(self, *, trigger_id: str, next_run_at: str | None) -> None:
        self._client.table("worker_triggers").update(
            {"next_run_at": next_run_at, "updated_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", trigger_id).execute()

    def mark_trigger_fired(
        self,
        *,
        trigger_id: str,
        last_fired_at: str,
        next_run_at: str | None,
    ) -> None:
        self._client.table("worker_triggers").update(
            {
                "last_fired_at": last_fired_at,
                "next_run_at": next_run_at,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", trigger_id).execute()

    def find_trigger_by_external_id(
        self, *, external_trigger_id: str
    ) -> dict[str, Any] | None:
        return _first_row(
            self._client.table("worker_triggers")
            .select("*")
            .eq("external_trigger_id", external_trigger_id)
            .eq("enabled", True)
            .limit(1)
            .execute()
        )

    def find_trigger_for_webhook(self, *, worker_id: str) -> dict[str, Any] | None:
        rows = _response_rows(
            self._client.table("worker_triggers")
            .select("*")
            .eq("worker_id", worker_id)
            .eq("type", "webhook")
            .eq("enabled", True)
            .order("position")
            .order("id")
            .limit(1)
            .execute()
        )
        return rows[0] if rows else None

    def count_schedule_trigger_rows(self) -> int:
        """GLOBAL count of schedule trigger rows across all tenants.

        Gates whether the scheduler loop runs at all, so it must NOT be
        workspace-scoped (matches the engine's global COUNT). service_role
        bypasses RLS so this sees every tenant's rows.
        """
        response = (
            self._client.table("worker_triggers")
            .select("id", count="exact")
            .eq("type", "schedule")
            .execute()
        )
        count = getattr(response, "count", None)
        if count is not None:
            return int(count)
        return len(_response_rows(response))


class SupabaseRunRepository(_BaseSupabaseRepository):
    _COMPLETED_STATUSES = ("completed", "approved", "success", "succeeded")
    _FAILED_STATUSES = ("failed", "error", "cancelled", "rejected", "timeout")
    _OUTCOME_STATUSES = ("completed", "approved", "success")
    _TERMINAL_STATUSES = _COMPLETED_STATUSES + _FAILED_STATUSES
    _OVERVIEW_PAGE_SIZE = 1000

    @staticmethod
    def _parse_run_dt(value: Any) -> datetime | None:
        if not value:
            return None
        try:
            return _as_aware_utc(datetime.fromisoformat(str(value).replace("Z", "+00:00")))
        except (TypeError, ValueError):
            return None

    def _overview_run_rows(
        self,
        *,
        user_id: str,
        columns: str,
        since: str | None = None,
        until: str | None = None,
        statuses: Iterable[str] | None = None,
        worker_ids: Iterable[str] | None = None,
        order_created_desc: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        status_values = [str(status) for status in statuses or () if str(status)]
        worker_values = [str(worker_id) for worker_id in worker_ids or () if str(worker_id)]
        if statuses is not None and not status_values:
            return []
        if worker_ids is not None and not worker_values:
            return []

        rows: list[dict[str, Any]] = []
        offset = 0
        while limit is None or len(rows) < limit:
            page_size = self._OVERVIEW_PAGE_SIZE
            if limit is not None:
                page_size = min(page_size, max(0, limit - len(rows)))
            if page_size <= 0:
                break

            builder = self._client.table("runs").select(columns)
            builder = _scope_by_workspace(builder, user_id=user_id)
            if since:
                builder = builder.gte("created_at", since)
            if until:
                builder = builder.lte("created_at", until)
            if status_values:
                builder = builder.in_("status", status_values)
            if worker_values:
                builder = builder.in_("worker_id", worker_values)
            if order_created_desc:
                builder = builder.order("created_at", desc=True)

            page = _response_rows(builder.range(offset, offset + page_size - 1).execute())
            rows.extend(page)
            if len(page) < page_size:
                break
            offset += page_size
        return rows

    def overview_status_rollup(
        self,
        *,
        user_id: str,
        since: str,
        window_7d: str,
        today_start: str,
    ) -> list[RowDict]:
        window_7d_dt = self._parse_run_dt(window_7d)
        today_start_dt = self._parse_run_dt(today_start)
        grouped: dict[tuple[str, Any], dict[str, Any]] = {}
        rows = self._overview_run_rows(
            user_id=user_id,
            columns="worker_id,status,created_at",
            since=since,
        )
        for row in rows:
            worker_id = str(row.get("worker_id") or "")
            if not worker_id:
                continue
            status = row.get("status")
            created_at = self._parse_run_dt(row.get("created_at"))
            if created_at is None:
                continue
            key = (worker_id, status)
            bucket = grouped.setdefault(
                key,
                {
                    "worker_id": worker_id,
                    "status": status,
                    "count_7d": 0,
                    "count_previous_7d": 0,
                    "count_today": 0,
                },
            )
            if window_7d_dt is not None and created_at >= window_7d_dt:
                bucket["count_7d"] += 1
            elif window_7d_dt is not None:
                bucket["count_previous_7d"] += 1
            if today_start_dt is not None and created_at >= today_start_dt:
                bucket["count_today"] += 1
        return list(grouped.values())

    def overview_sparkline_buckets(
        self,
        *,
        user_id: str,
        since: str,
        until: str,
        bucket_seconds: int,
    ) -> list[RowDict]:
        bucket_seconds = max(1, int(bucket_seconds))
        since_dt = self._parse_run_dt(since)
        if since_dt is None:
            return []
        grouped: dict[tuple[int, Any], dict[str, Any]] = {}
        rows = self._overview_run_rows(
            user_id=user_id,
            columns="status,created_at",
            since=since,
            until=until,
        )
        for row in rows:
            created_at = self._parse_run_dt(row.get("created_at"))
            if created_at is None:
                continue
            bucket_index = int((created_at - since_dt).total_seconds() // bucket_seconds)
            key = (bucket_index, row.get("status"))
            bucket = grouped.setdefault(
                key,
                {"bucket": bucket_index, "status": row.get("status"), "total": 0},
            )
            bucket["total"] += 1
        return list(grouped.values())

    def overview_current_counts(
        self,
        *,
        user_id: str,
        statuses: list[str],
    ) -> dict[str, int]:
        if not statuses:
            return {}
        counts: dict[str, int] = {str(status): 0 for status in statuses}
        rows = self._overview_run_rows(
            user_id=user_id,
            columns="status",
            statuses=statuses,
        )
        for row in rows:
            status = str(row.get("status") or "")
            if status in counts:
                counts[status] += 1
        return {status: total for status, total in counts.items() if total}

    def overview_top_completed_by_worker(
        self,
        *,
        user_id: str,
        since: str,
        limit: int,
    ) -> list[RowDict]:
        rows = self._overview_run_rows(
            user_id=user_id,
            columns="worker_id,status,created_at",
            since=since,
            statuses=self._OUTCOME_STATUSES,
        )
        grouped: dict[str, dict[str, Any]] = {}
        for row in rows:
            worker_id = str(row.get("worker_id") or "")
            if not worker_id:
                continue
            bucket = grouped.setdefault(
                worker_id,
                {"worker_id": worker_id, "count": 0, "latest_created_at": ""},
            )
            bucket["count"] += 1
            created_at = str(row.get("created_at") or "")
            if created_at > str(bucket.get("latest_created_at") or ""):
                bucket["latest_created_at"] = created_at

        def _top_sort_key(item: dict[str, Any]) -> tuple[int, float, str]:
            latest = self._parse_run_dt(item.get("latest_created_at"))
            latest_ts = latest.timestamp() if latest is not None else 0.0
            return -int(item["count"] or 0), -latest_ts, str(item["worker_id"])

        ordered = sorted(grouped.values(), key=_top_sort_key)
        return [
            {"worker_id": row["worker_id"], "count": row["count"]}
            for row in ordered[: max(0, int(limit))]
        ]

    def overview_recent_visible_runs(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        limit: int,
    ) -> list[RowDict]:
        if not worker_ids:
            return []
        rows = self._overview_run_rows(
            user_id=user_id,
            columns="id,worker_id,status,trigger_source,created_at,started_at,completed_at,duration_ms,error,error_code",
            worker_ids=worker_ids,
            order_created_desc=True,
            limit=max(0, int(limit)),
        )
        worker_name_map = SupabaseWorkerRepository(self._client)._worker_name_map(
            row["worker_id"] for row in rows if row.get("worker_id")
        )
        for row in rows:
            worker_id = str(row.get("worker_id") or "")
            row["worker_name"] = worker_name_map.get(worker_id)
        return rows

    def overview_latest_failures_by_worker(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        since: str,
        limit: int,
    ) -> list[RowDict]:
        if not worker_ids:
            return []
        rows = self._overview_run_rows(
            user_id=user_id,
            columns="id,worker_id,status,trigger_source,created_at,started_at,completed_at,duration_ms,error,error_code",
            worker_ids=worker_ids,
            statuses=[RunStatus.FAILED.value],
            since=since,
        )
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            worker_id = str(row.get("worker_id") or "")
            if worker_id:
                grouped[worker_id].append(row)

        def _failure_sort_key(item: dict[str, Any]) -> tuple[datetime, datetime, str]:
            effective = (
                self._parse_run_dt(item.get("started_at"))
                or self._parse_run_dt(item.get("completed_at"))
                or self._parse_run_dt(item.get("created_at"))
                or datetime.min.replace(tzinfo=timezone.utc)
            )
            created = self._parse_run_dt(item.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc)
            return effective, created, str(item.get("id") or "")

        selected: list[dict[str, Any]] = []
        for worker_id, worker_rows in grouped.items():
            latest = max(worker_rows, key=_failure_sort_key)
            latest = dict(latest)
            latest["failure_count"] = len(worker_rows)
            latest["row_number"] = 1
            selected.append(latest)

        def _selected_sort_key(item: dict[str, Any]) -> tuple[int, float, str]:
            effective = (
                self._parse_run_dt(item.get("started_at"))
                or self._parse_run_dt(item.get("completed_at"))
                or self._parse_run_dt(item.get("created_at"))
                or datetime.min.replace(tzinfo=timezone.utc)
            )
            return (
                -int(item.get("failure_count") or 0),
                -effective.timestamp(),
                str(item.get("worker_id") or ""),
            )

        return sorted(selected, key=_selected_sort_key)[: max(0, int(limit))]

    def overview_terminal_runs(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        since: str,
    ) -> list[RowDict]:
        if not worker_ids:
            return []
        return self._overview_run_rows(
            user_id=user_id,
            columns="id,worker_id,status,trigger_source,created_at,started_at,completed_at,duration_ms,error,error_code",
            worker_ids=worker_ids,
            statuses=self._TERMINAL_STATUSES,
            since=since,
            order_created_desc=True,
        )

    def _resolve_trigger_member_emails(self, user_ids: list[str]) -> dict[str, str]:
        """Batch-look up emails for trigger_member_id values. Never raises."""
        if not user_ids:
            return {}
        result: dict[str, str] = {}
        try:
            svc = get_supabase_service_client()
            for uid in user_ids:
                try:
                    resp = svc.auth.admin.get_user_by_id(uid)
                    if resp and resp.user and resp.user.email:
                        result[uid] = resp.user.email
                except Exception:
                    # A single user lookup miss (deleted user, no email) is
                    # expected; attribution email is cosmetic. Keep at debug.
                    _repo_logger.debug(
                        "trigger member email lookup failed for user %s", uid, exc_info=True
                    )
        except Exception:
            # The whole batch failed (e.g. the service client / auth admin is
            # unavailable) — attribution degrades to blank, but that is a real
            # unexpected failure worth surfacing.
            _repo_logger.warning(
                "trigger member email batch resolution failed for %d user(s)",
                len(user_ids),
                exc_info=True,
            )
        return result

    def _decorate_run_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not rows:
            return []
        worker_name_map = SupabaseWorkerRepository(self._client)._worker_name_map(
            row["worker_id"] for row in rows
        )
        # Batch-resolve trigger_member emails for attribution display.
        member_ids = list({
            str(row["trigger_member_id"])
            for row in rows
            if row.get("trigger_member_id")
        })
        member_email_map = self._resolve_trigger_member_emails(member_ids)
        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            if "input_json" in item:
                item["input_json"] = _json_text(item.get("input_json"), {})
            if "output_json" in item:
                item["output_json"] = _json_text(item.get("output_json"), {})
            item["worker_name"] = worker_name_map.get(str(item["worker_id"]))
            mid = item.get("trigger_member_id")
            item["trigger_member_email"] = member_email_map.get(str(mid)) if mid else None
            result.append(item)
        return result

    def list_for_worker(
        self,
        *,
        user_id: str,
        worker_id: str,
        limit: int,
        offset: int,
    ) -> list[dict[str, Any]]:
        builder = self._client.table("runs").select(
            "id,worker_id,status,trigger_source,created_at,started_at,completed_at,duration_ms,error"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = (
            builder
            .eq("worker_id", worker_id)
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        return _response_rows(response)

    def list(
        self,
        *,
        user_id: str,
        worker_id: str | None = None,
        statuses: list[str] | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 50,
        offset: int = 0,
        include_total: bool = True,
    ) -> tuple[list[dict[str, Any]], int]:
        builder = self._client.table("runs").select(
            "id,worker_id,status,trigger_source,input_json,error,started_at,completed_at,duration_ms,created_at,trigger_member_id",
            count="exact" if include_total else None,
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        if worker_id:
            builder = builder.eq("worker_id", worker_id)
        if statuses:
            builder = builder.in_("status", statuses)
        if since:
            builder = builder.gte("created_at", since)
        if until:
            builder = builder.lte("created_at", until)
        response = builder.order("created_at", desc=True).range(
            offset,
            offset + limit - 1,
        ).execute()
        raw_rows = _response_rows(response)

        # Pre-populate recipe cache with visibility-scoped workers so the engine's
        # per-run _run_visible_to_api check (repos.workers.get per run) is a cache
        # hit instead of a separate DB round-trip. Use user_id so only workers
        # visible to this user are cached — members cannot see private workers of
        # other users even when those workers appear in the run list.
        unique_worker_ids = list({str(r["worker_id"]) for r in raw_rows if r.get("worker_id")})
        if unique_worker_ids:
            try:
                worker_repo = SupabaseWorkerRepository(self._client)
                w_rows = worker_repo._worker_rows(user_id=user_id, worker_ids=unique_worker_ids)
                sv_map = worker_repo._skill_versions_by_id(
                    r.get("skill_version_id") for r in w_rows if r.get("skill_version_id")
                )
                vis_cache: dict[str, tuple[dict, dict | None]] = {
                    str(r["id"]): (r, sv_map.get(r.get("skill_version_id")))
                    for r in w_rows
                    if r.get("id")
                }
                _recipe_cache.set(vis_cache)
            except Exception:
                # Prefill is a perf optimization; a failure only costs an extra
                # per-run DB round-trip later. Non-fatal, but log so a recurring
                # prefill failure (broken worker/skill read) is not invisible.
                _repo_logger.warning(
                    "run-list worker visibility prefill failed for user %s (%d workers)",
                    user_id,
                    len(unique_worker_ids),
                    exc_info=True,
                )

        rows = self._decorate_run_rows(raw_rows)
        total = (
            int(getattr(response, "count", 0) or 0)
            if include_total
            else offset + len(raw_rows) + (1 if len(raw_rows) >= limit else 0)
        )
        return rows, total

    def get(self, *, user_id: str, run_id: str) -> dict[str, Any] | None:
        builder = self._client.table("runs").select(
            "id,worker_id,status,trigger_source,runner,input_json,output_json,error,started_at,completed_at,duration_ms,created_at,cancel_requested,cancelled_at,bundle_snapshot_path,trigger_member_id"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("id", run_id).limit(1).execute()
        row = _first_row(response)
        if row is None:
            if not get_active_workspace_id():
                return None
            fallback = (
                self._client.table("runs")
                .select(
                    "id,worker_id,status,trigger_source,runner,input_json,output_json,error,started_at,completed_at,duration_ms,created_at,cancel_requested,cancelled_at,bundle_snapshot_path,trigger_member_id"
                )
                .eq("id", run_id)
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            row = _first_row(fallback)
            if row is None:
                return None
        return self._decorate_run_rows([row])[0]

    def get_any(self, *, run_id: str) -> dict[str, Any] | None:
        response = (
            self._client.table("runs")
            .select("*")
            .eq("id", run_id)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        if row is None:
            return None
        if "input_json" in row:
            row["input_json"] = _json_text(row.get("input_json"), {})
        if "output_json" in row:
            row["output_json"] = _json_text(row.get("output_json"), {})
        return row

    def count_child_runs(self, *, parent_run_id: str) -> int:
        # Child runs spawned via worker-to-worker calls carry the parent run id in
        # trigger_ref. Used to enforce the per-run fan-out cap at child creation
        # (engine run_token.MAX_WORKER_CALLS_PER_RUN).
        if not parent_run_id:
            return 0
        response = (
            self._client.table("runs")
            .select("id", count="exact")
            .eq("trigger_ref", parent_run_id)
            .execute()
        )
        return int(getattr(response, "count", 0) or 0)

    def create(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        worker_id = fields["worker_id"]
        # Pre-check: confirm the worker belongs to this user. We scope by
        # workspace_id (if contextvar is set) so a user can't trigger a
        # run on a worker in a workspace they aren't currently viewing.
        if worker_id in _SYSTEM_RUN_WORKER_IDS:
            _ensure_system_run_worker_row(self._client, worker_id=worker_id, user_id=user_id)
        elif worker_id in _public_stock_worker_ids():
            # Runnable-by-attribution carve-out: curated catalog/stock workers
            # ship with the product and may be run by ANY tenant. Their rows are
            # seeded under other demo users/workspaces, so the workspace-scoped
            # pre-check below would reject a fresh tenant. Skip the ownership
            # pre-check; the run row is still stamped with the CALLER's workspace
            # + user_id (via _resolve_workspace_id_for_write / the insert below),
            # so tenant isolation holds — only this curated set is widened.
            pass
        else:
            worker_builder = self._client.table("workers").select("id").eq("id", worker_id)
            worker_builder = _scope_by_workspace(worker_builder, user_id=user_id)
            worker = worker_builder.limit(1).execute()
            if _first_row(worker) is None:
                # Genuine cross-tenant ownership denial. Raise the typed error the
                # run endpoint catches for a clear 403 (instead of the opaque 400
                # "Invalid request" the global ValueError handler emits). Falls
                # back to ValueError if the engine pin predates the type.
                try:
                    from models import WorkerNotRunnableError  # noqa: PLC0415

                    raise WorkerNotRunnableError(
                        f"worker {worker_id} does not belong to {user_id}"
                    )
                except ImportError:
                    raise ValueError(f"worker {worker_id} does not belong to {user_id}")
        run_id = fields["run_id"]
        # Stamp workspace_id on the run row. For scheduler/webhook triggers
        # the contextvar is unset, so we fall back to the worker's
        # workspace_id (looked up from the DB).
        workspace_id = _resolve_workspace_id_for_write(
            user_id=user_id,
            explicit_workspace_id=fields.get("workspace_id"),
            worker_id=worker_id,
        )
        insert_row: dict[str, Any] = {
            "id": run_id,
            "user_id": user_id,
            "workspace_id": workspace_id,
            "worker_id": worker_id,
            "status": fields.get("status") or RunStatus.QUEUED.value,
            "trigger_source": fields.get("trigger_source") or "manual",
            "runner": fields.get("runner") or "local",
            "input_json": _json_storage_value(fields.get("input_json") or fields.get("inputs"), {}),
            "output_json": _json_storage_value(fields.get("output_json"), {}),
            "approval_status": fields.get("approval_status") or "not_required",
            "error": fields.get("error"),
            "started_at": fields.get("started_at"),
            "completed_at": fields.get("completed_at"),
            "duration_ms": fields.get("duration_ms"),
            "created_at": fields.get("created_at") or datetime.now(timezone.utc).isoformat(),
            "cancel_requested": bool(fields.get("cancel_requested", False)),
            "cancelled_at": fields.get("cancelled_at"),
            "bundle_snapshot_path": fields.get("bundle_snapshot_path"),
            "retry_of_run_id": fields.get("retry_of_run_id"),
            "retry_attempt": int(fields.get("retry_attempt") or 0),
        }
        if fields.get("trigger_member_id"):
            insert_row["trigger_member_id"] = fields["trigger_member_id"]
        self._client.table("runs").insert(insert_row).execute()
        created = self.get(user_id=user_id, run_id=run_id)
        if created is None:
            raise RuntimeError(f"failed to create run {run_id}")
        return created

    def update(self, *, user_id: str, run_id: str, **fields: Any) -> dict[str, Any] | None:
        payload: dict[str, Any] = {}
        for key in (
            "status",
            "trigger_source",
            "runner",
            "approval_status",
            "error",
            "error_code",
            "quality_warning",
            "artifacts_archived",
            "started_at",
            "completed_at",
            "duration_ms",
            "cancelled_at",
            "bundle_snapshot_path",
        ):
            if key in fields:
                payload[key] = fields[key]
        if "input_json" in fields:
            payload["input_json"] = _json_storage_value(fields["input_json"], {})
        if "output_json" in fields:
            payload["output_json"] = _json_storage_value(fields["output_json"], {})
        if "cancel_requested" in fields:
            payload["cancel_requested"] = bool(fields["cancel_requested"])
        # #271: same invariant as update_status — an errored run is failed, not
        # completed, and must not carry leaked (smoke) output as its result.
        if payload.get("status") == RunStatus.COMPLETED.value and str(fields.get("error") or "").strip():
            payload["status"] = RunStatus.FAILED.value
            payload["output_json"] = {}
        if payload:
            builder = self._client.table("runs").update(payload).eq("id", run_id)
            builder = _scope_by_workspace(builder, user_id=user_id)
            builder.execute()
        return self.get(user_id=user_id, run_id=run_id)

    def delete(self, *, user_id: str, run_id: str) -> bool:
        builder = self._client.table("runs").delete().eq("id", run_id)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.execute()
        return bool(_response_rows(response))

    def set_input_json(self, *, user_id: str, run_id: str, input_json: dict[str, Any]) -> None:
        self.update(user_id=user_id, run_id=run_id, input_json=input_json)

    def update_status(
        self,
        *,
        user_id: str,
        run_id: str,
        status: str,
        output_json: dict[str, Any] | None = None,
        error: str | None = None,
        error_code: str | None = None,
    ) -> None:
        run = self.get(user_id=user_id, run_id=run_id)
        if run is None:
            raise ValueError(f"run {run_id} not found for {user_id}")
        # #271: a run carrying a non-empty error is a FAILURE — never persist it
        # as "completed". The engine's smoke/gate finalization could mark a
        # runner error as completed AND leak smoke-test output into output_json
        # (failures masquerading as successes). Enforce the invariant at the
        # persistence boundary: coerce completed+error -> failed and drop the
        # (smoke/partial) output so a failed run never carries a fake result.
        if (error or "").strip() and status == RunStatus.COMPLETED.value:
            status = RunStatus.FAILED.value
            output_json = {}
        updates: dict[str, Any] = {"status": status}
        if output_json is not None:
            updates["output_json"] = output_json
        if error is not None:
            updates["error"] = error
        if error_code is not None:
            updates["error_code"] = error_code
        if status == RunStatus.RUNNING.value:
            updates["started_at"] = datetime.now(timezone.utc).isoformat()
        if status in {RunStatus.COMPLETED.value, RunStatus.FAILED.value}:
            completed_at = datetime.now(timezone.utc).isoformat()
            updates["completed_at"] = completed_at
            started_at = run.get("started_at")
            if started_at:
                try:
                    started = datetime.fromisoformat(str(started_at))
                    completed = datetime.fromisoformat(completed_at)
                    updates["duration_ms"] = int((completed - started).total_seconds() * 1000)
                except Exception:
                    pass
        builder = self._client.table("runs").update(updates).eq("id", run_id)
        builder = _scope_by_workspace(builder, user_id=user_id)
        builder.execute()
        if status == RunStatus.COMPLETED.value:
            updated_run = self.get(user_id=user_id, run_id=run_id) or {}
            capture_posthog_event(
                distinct_id=user_id,
                event_name="run_completed",
                properties={
                    "workspace_id": updated_run.get("workspace_id") or get_active_workspace_id(),
                    "run_id": run_id,
                    "worker_id": run.get("worker_id"),
                    "trigger_source": run.get("trigger_source"),
                    "duration_ms": updates.get("duration_ms"),
                },
            )

    def add_log(
        self,
        *,
        user_id: str,
        run_id: str,
        level: str,
        message: str,
        timestamp: str,
        trace_id: str | None = None,
    ) -> None:
        if self.get(user_id=user_id, run_id=run_id) is None:
            raise ValueError(f"run {run_id} not found for {user_id}")
        self._client.table("run_logs").insert(
            {
                "user_id": user_id,
                "run_id": run_id,
                "level": level,
                "message": message,
                "timestamp": timestamp,
                "trace_id": trace_id,
            }
        ).execute()

    def list_logs(
        self, *, user_id: str, run_id: str, limit: int | None = 10_000
    ) -> list[dict[str, Any]]:
        # #1470 perf: interface declares an optional ``limit`` (default 10_000).
        # Accept + apply it so this impl matches the engine's RunRepository
        # Protocol; no current router passes it, but a contract gap here would
        # TypeError the moment one does.
        if self.get(user_id=user_id, run_id=run_id) is None:
            return []
        builder = (
            self._client.table("run_logs")
            .select("level,message,timestamp,trace_id")
            .eq("user_id", user_id)
            .eq("run_id", run_id)
            .order("timestamp")
        )
        if limit is not None:
            try:
                bounded = int(limit)
            except (TypeError, ValueError):
                bounded = 10_000
            if bounded > 0:
                builder = builder.limit(bounded)
        return _response_rows(builder.execute())

    def list_logs_for_worker(
        self,
        *,
        user_id: str,
        worker_id: str,
        level: str | None = None,
        since: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """Cross-run logs for a worker via Supabase run_logs join."""
        q = (
            self._client.table("run_logs")
            .select("level,message,timestamp,trace_id,run_id")
            .eq("user_id", user_id)
        )
        if level:
            q = q.eq("level", level)
        if since:
            q = q.gte("timestamp", since)
        # Filter by worker via runs table join isn't directly possible in supabase-py,
        # so fetch recent logs and filter by runs that belong to this worker.
        runs_resp = (
            self._client.table("runs")
            .select("id")
            .eq("user_id", user_id)
            .eq("worker_id", worker_id)
            .order("created_at", desc=True)
            .limit(100)
            .execute()
        )
        run_ids = [r["id"] for r in _response_rows(runs_resp)]
        if not run_ids:
            return []
        q = q.in_("run_id", run_ids).order("timestamp", desc=True).limit(limit)
        response = q.execute()
        return _response_rows(response)

    def add_artifact(
        self,
        *,
        user_id: str,
        run_id: str,
        artifact_id: str,
        name: str,
        artifact_type: str | None,
        path: str,
        size_bytes: int | None,
        created_at: str,
    ) -> None:
        if self.get(user_id=user_id, run_id=run_id) is None:
            raise ValueError(f"run {run_id} not found for {user_id}")
        self._client.table("artifacts").insert(
            {
                "id": artifact_id,
                "user_id": user_id,
                "run_id": run_id,
                "name": name,
                "type": artifact_type,
                "path": path,
                "size_bytes": size_bytes,
                "created_at": created_at,
            }
        ).execute()

    def list_artifacts(
        self, *, user_id: str, run_id: str, limit: int | None = 1_000
    ) -> list[dict[str, Any]]:
        # #1470 perf: interface declares an optional ``limit`` (default 1_000).
        # Accept + apply so this impl matches the engine's RunRepository
        # Protocol.
        if self.get(user_id=user_id, run_id=run_id) is None:
            return []
        builder = (
            self._client.table("artifacts")
            .select("*")
            .eq("user_id", user_id)
            .eq("run_id", run_id)
            .order("created_at")
            .order("name")
        )
        if limit is not None:
            try:
                bounded = int(limit)
            except (TypeError, ValueError):
                bounded = 1_000
            if bounded > 0:
                builder = builder.limit(bounded)
        return _response_rows(builder.execute())

    def list_artifacts_for_runs(
        self,
        *,
        user_id: str,
        run_ids: list[str],
        limit_per_run: int | None = 1_000,
    ) -> dict[str, list[dict[str, Any]]]:
        # #1470 perf: batched artifact fetch for the approvals/run list so the
        # router avoids an N+1 of per-run list_artifacts(). The engine calls
        # this via getattr() (router falls back to per-run reads when absent),
        # so a missing impl degrades rather than 500s — but supplying it keeps
        # the cloud on the batched fast path. Returns {run_id: [artifacts...]}
        # for every requested run id (empty list when a run has none).
        unique_run_ids = list(dict.fromkeys(str(r) for r in run_ids if r))
        grouped: dict[str, list[dict[str, Any]]] = {rid: [] for rid in unique_run_ids}
        if not unique_run_ids:
            return grouped
        try:
            bounded = int(limit_per_run) if limit_per_run is not None else 1_000
        except (TypeError, ValueError):
            bounded = 1_000
        if bounded <= 0:
            bounded = 1_000
        # PostgREST has no SQL window function, so fetch all artifacts for the
        # (workspace-scoped) run set ordered deterministically, then cap each
        # run's list client-side to mirror the engine's per-run ROW_NUMBER cap.
        builder = (
            self._client.table("artifacts")
            .select("*")
            .eq("user_id", user_id)
            .in_("run_id", unique_run_ids)
            .order("run_id")
            .order("created_at")
            .order("name")
        )
        rows = _response_rows(builder.execute())
        for row in rows:
            rid = str(row.get("run_id") or "")
            bucket = grouped.get(rid)
            if bucket is None:
                continue
            if len(bucket) < bounded:
                bucket.append(row)
        return grouped

    def clear_all(self, *, user_id: str) -> int:
        run_ids = [row["id"] for row in self.list_all_ids(user_id=user_id)]
        if not run_ids:
            return 0
        # Delete by run_ids (already scoped to the active workspace via
        # list_all_ids) so we don't accidentally wipe runs across all
        # workspaces this user owns.
        self._client.table("runs").delete().in_("id", run_ids).execute()
        return len(run_ids)

    def list_all_ids(self, *, user_id: str) -> list[dict[str, Any]]:
        builder = self._client.table("runs").select("id")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.execute()
        return _response_rows(response)

    def cancel(self, *, user_id: str, run_id: str, cancelled_at: str) -> dict[str, Any] | None:
        return self.update(
            user_id=user_id,
            run_id=run_id,
            cancel_requested=True,
            cancelled_at=cancelled_at,
        )

    def fail_running(self, *, user_id: str, error: str, error_code: str | None = None) -> list[str]:
        """Mark every still-running run for this user as failed.

        Mirrors :meth:`SqliteRunRepository.fail_running` (engine
        ``apps/api/db/sqlite.py``). Used by
        ``fail_interrupted_runs_on_startup`` to clean up rows that were
        in flight when a prior API process exited. Only called from the
        engine's local-mode lifespan today, but kept on the cloud repo
        too so the interface contract holds for a future cloud-startup
        recovery sweep.
        """
        # Find all running runs scoped to this user (or active workspace,
        # if the contextvar happens to be set — unlikely at startup).
        builder = self._client.table("runs").select("id,started_at")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("status", RunStatus.RUNNING.value).execute()
        rows = _response_rows(response)
        if not rows:
            return []
        completed_at_str = datetime.now(timezone.utc).isoformat()
        completed_dt = datetime.fromisoformat(completed_at_str)
        failed_ids: list[str] = []
        for row in rows:
            run_id = str(row.get("id") or "")
            if not run_id:
                continue
            updates: dict[str, Any] = {
                "status": RunStatus.FAILED.value,
                "error": error,
                "error_code": error_code,
                "completed_at": completed_at_str,
            }
            started_at = row.get("started_at")
            if started_at:
                try:
                    started_dt = datetime.fromisoformat(str(started_at))
                    updates["duration_ms"] = int(
                        (completed_dt - started_dt).total_seconds() * 1000
                    )
                except Exception:
                    pass
            self.update(user_id=user_id, run_id=run_id, **updates)
            failed_ids.append(run_id)
        return failed_ids

    def fail_all_pending_approval(
        self,
        *,
        error: str,
        error_code: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fail ALL runs stuck in 'pending_approval' (system-wide startup sweep).

        Mirrors SqliteRunRepository.fail_all_pending_approval: a pending_approval
        row at boot has a dead in-process polling loop with no live executor to
        resume it, so fail them all immediately. Process-wide reaper (like
        fail_stale_running) — deliberately NOT scoped by workspace/user. Kept so
        the RunRepository Protocol contract holds for a cloud-startup recovery
        sweep (was missing -> AttributeError if ever called).
        """
        svc = get_supabase_service_client()
        rows = _response_rows(
            svc.table("runs").select("id,started_at,created_at").eq("status", "pending_approval").execute()
        )
        if not rows:
            return []
        completed_at_str = datetime.now(timezone.utc).isoformat()
        completed_dt = datetime.fromisoformat(completed_at_str)
        failed: list[dict[str, Any]] = []
        for row in rows:
            run_id = str(row.get("id") or "")
            if not run_id:
                continue
            updates: dict[str, Any] = {
                "status": RunStatus.FAILED.value,
                "error": error,
                "error_code": error_code,
                "completed_at": completed_at_str,
            }
            started_at = row.get("started_at") or row.get("created_at")
            if started_at:
                try:
                    started_dt = datetime.fromisoformat(str(started_at))
                    updates["duration_ms"] = int((completed_dt - started_dt).total_seconds() * 1000)
                except Exception:
                    pass
            svc.table("runs").update(updates).eq("id", run_id).execute()
            failed.append({**row, **updates})
        return failed

    def fail_stale_running(
        self,
        *,
        cutoff_iso: str,
        exclude_run_ids: Iterable[str] = (),
        error: str,
        error_code: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fail abandoned ``running`` runs older than *cutoff_iso*, across ALL owners.

        Mirrors :meth:`SqliteRunRepository.fail_stale_running` (engine
        ``apps/api/db/sqlite.py``). This is a process-wide reaper — deliberately
        NOT workspace/user scoped — because a server restart abandons every
        in-flight run regardless of owner. The engine's ``reap_abandoned_runs``
        calls it with the active-run ids excluded; the UPDATE is status-gated
        (``status='running'``) so a run that finishes between the SELECT and the
        UPDATE is not clobbered. PostgREST has no COALESCE filter, so the small
        running set is fetched and the cutoff applied in Python, matching the
        engine's ``COALESCE(started_at, created_at) < cutoff`` predicate.
        """
        excluded = {str(r) for r in exclude_run_ids if str(r)}
        try:
            cutoff_dt = _as_aware_utc(datetime.fromisoformat(cutoff_iso))
        except ValueError:
            return []
        response = (
            self._client.table("runs")
            .select("id,user_id,started_at,created_at")
            .eq("status", RunStatus.RUNNING.value)
            .execute()
        )
        rows = _response_rows(response)
        if not rows:
            return []
        completed_at_str = datetime.now(timezone.utc).isoformat()
        completed_dt = datetime.fromisoformat(completed_at_str)
        failed: list[dict[str, Any]] = []
        for row in rows:
            run_id = str(row.get("id") or "")
            if not run_id or run_id in excluded:
                continue
            effective = row.get("started_at") or row.get("created_at")
            if not effective:
                continue
            try:
                effective_dt = _as_aware_utc(datetime.fromisoformat(str(effective)))
            except ValueError:
                continue
            if effective_dt >= cutoff_dt:
                continue
            updates: dict[str, Any] = {
                "status": RunStatus.FAILED.value,
                "error": error,
                "error_code": error_code,
                "completed_at": completed_at_str,
            }
            started_at = row.get("started_at")
            if started_at:
                try:
                    started_dt = datetime.fromisoformat(str(started_at))
                    updates["duration_ms"] = int(
                        (completed_dt - _as_aware_utc(started_dt)).total_seconds() * 1000
                    )
                except Exception:
                    pass
            result = (
                self._client.table("runs")
                .update(updates)
                .eq("id", run_id)
                .eq("status", RunStatus.RUNNING.value)
                .execute()
            )
            if _response_rows(result):
                failed.append(
                    {
                        "id": run_id,
                        "run_id": run_id,
                        "user_id": row.get("user_id"),
                        "started_at": row.get("started_at"),
                        "created_at": row.get("created_at"),
                        "completed_at": completed_at_str,
                    }
                )
        return failed

    def count_running_for_worker(self, *, user_id: str, worker_id: str) -> int:
        # Scoped by workspace_id when called inside a web request; falls
        # back to user_id outside one (scheduler concurrency check).
        builder = self._client.table("runs").select("id", count="exact")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = (
            builder
            .eq("worker_id", worker_id)
            .eq("status", RunStatus.RUNNING.value)
            .execute()
        )
        return int(getattr(response, "count", 0) or 0)

    def set_bundle_snapshot_path(
        self,
        *,
        user_id: str,
        run_id: str,
        bundle_snapshot_path: str | None,
    ) -> None:
        self.update(
            user_id=user_id,
            run_id=run_id,
            bundle_snapshot_path=bundle_snapshot_path,
        )

    def get_bundle_snapshot_path(self, *, user_id: str, run_id: str) -> str | None:
        run = self.get(user_id=user_id, run_id=run_id)
        return str(run["bundle_snapshot_path"]) if run and run.get("bundle_snapshot_path") else None

    def get_queued(self, *, limit: int = 50) -> list[dict[str, Any]]:
        """Return queued runs ordered by created_at (FIFO) for the drain loop.

        Not scoped by workspace — the drain loop dispatches across all workspaces.
        Skips cancel_requested rows so cancelled-before-dispatch runs are ignored.
        Returns rows with run_id, worker_id, user_id, input_json keys matching
        the sqlite implementation expected by run_service._drain_one_batch().
        """
        response = (
            self._client.table("runs")
            .select("id,worker_id,user_id,input_json")
            .eq("status", "queued")
            .eq("cancel_requested", False)
            .order("created_at", desc=False)
            .limit(limit)
            .execute()
        )
        rows = _response_rows(response)
        result = []
        for row in rows:
            result.append({
                "run_id": row["id"],
                "worker_id": row["worker_id"],
                "user_id": row["user_id"],
                "input_json": _json_text(row.get("input_json"), {}),
            })
        return result

    def claim_queued(self, *, user_id: str, run_id: str, started_at: str) -> dict[str, Any] | None:
        """Atomically move one queued, uncancelled run to running.

        The drain loop may run in more than one API replica. Keep the status and
        cancellation filters in the update so only one drainer can win a queued
        row that multiple processes observed via get_queued().
        """
        response = (
            self._client.table("runs")
            .update({
                "status": RunStatus.RUNNING.value,
                "started_at": started_at,
                "error": None,
                "error_code": None,
            })
            .eq("id", run_id)
            .eq("user_id", user_id)
            .eq("status", RunStatus.QUEUED.value)
            .eq("cancel_requested", False)
            .execute()
        )
        row = _first_row(response)
        return row if row is not None else None

    def count_queued(self) -> int:
        """Return count of pending queued runs across all workspaces."""
        response = (
            self._client.table("runs")
            .select("id", count="exact")
            .eq("status", "queued")
            .eq("cancel_requested", False)
            .execute()
        )
        return int(getattr(response, "count", 0) or 0)


class SupabaseConnectionRepository(_BaseSupabaseRepository):
    # Columns selected on every read. MCP fields (engine PR #161 / 8136efc,
    # mirrored to Supabase via migration 0006) are part of every projection
    # so the engine's _public_connection_item() can read mcp_label/mcp_url/
    # mcp_auth_secret/mcp_allowed_tools_json + kind without per-call lookups.
    _CONNECTION_COLUMNS = (
        "id,app_name,composio_connection_id,composio_user_id,status,"
        "created_at,updated_at,scopes_json,account_label,last_checked_at,"
        "last_check_status,last_check_error,user_id,kind,mcp_label,mcp_url,"
        "mcp_transport,mcp_command,mcp_args_json,mcp_env_json,mcp_cwd,"
        "mcp_auth_secret,mcp_allowed_tools_json"
    )

    def _normalize_row(self, row: Mapping[str, Any]) -> dict[str, Any]:
        item = dict(row)
        item["scopes_json"] = _json_text(item.get("scopes_json"), [])
        # Engine's _public_connection_item() calls _parse_json_string_list()
        # on mcp_allowed_tools_json, which expects a JSON-text string (not a
        # Python list). Supabase returns the column as a Python list because
        # we declared it jsonb. Re-stringify so the engine parser succeeds.
        item["mcp_allowed_tools_json"] = _json_text(item.get("mcp_allowed_tools_json"), [])
        item["mcp_args_json"] = _json_text(item.get("mcp_args_json"), [])
        item["mcp_env_json"] = _json_text(item.get("mcp_env_json"), {})
        # Default kind for legacy rows where the column was added with a
        # default but the row predates the migration's default fill.
        item["kind"] = item.get("kind") or "composio"
        item["mcp_transport"] = item.get("mcp_transport") or "streamable_http"
        return item

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        builder = self._client.table("connections").select(self._CONNECTION_COLUMNS)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.order("app_name").execute()
        return [self._normalize_row(row) for row in _response_rows(response)]

    def get(self, *, user_id: str, composio_id: str) -> dict[str, Any] | None:
        builder = self._client.table("connections").select(self._CONNECTION_COLUMNS)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("id", composio_id).limit(1).execute()
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def get_by_composio_connection_id(self, *, composio_connection_id: str) -> dict[str, Any] | None:
        response = (
            self._client.table("connections")
            .select(self._CONNECTION_COLUMNS)
            .eq("composio_connection_id", composio_connection_id)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def find_by_app_account(
        self,
        *,
        user_id: str,
        app_name: str,
        account_label: str,
        exclude_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Return the canonical composio connection for an (app, account) pair.

        Dedupe key (engine N5-1): reconnecting the SAME app + SAME account (by
        normalized account_label) reuses the OLDEST matching row instead of
        spawning a duplicate. ``exclude_id`` skips the freshly created reconnect
        row so it is never matched against itself. Mirrors
        SqliteConnectionRepository.find_by_app_account; lower/trim matching is
        done in Python so the semantics are byte-identical to the engine.
        """
        label = (account_label or "").strip().lower()
        if not label:
            return None
        builder = self._client.table("connections").select(self._CONNECTION_COLUMNS)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.order("created_at").order("id").execute()
        for row in _response_rows(response):
            if str(row.get("user_id")) != str(user_id):
                continue
            if (row.get("app_name") or "").strip().lower() != (app_name or "").strip().lower():
                continue
            kind = row.get("kind")
            if kind not in (None, "composio"):
                continue
            if (str(row.get("account_label") or "")).strip().lower() != label:
                continue
            if exclude_id is not None and str(row.get("id")) == str(exclude_id):
                continue
            return self._normalize_row(row)
        return None

    def upsert(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        connection_id = fields["id"]
        created_at = fields.get("created_at") or datetime.now(timezone.utc).isoformat()
        updated_at = fields.get("updated_at") or created_at
        workspace_id = _resolve_workspace_id_for_write(
            user_id=user_id,
            explicit_workspace_id=fields.get("workspace_id"),
        )
        payload: dict[str, Any] = {
            "id": connection_id,
            "user_id": user_id,
            "workspace_id": workspace_id,
            "app_name": fields["app_name"],
            "composio_connection_id": fields["composio_connection_id"],
            "composio_user_id": fields.get("composio_user_id") or user_id,
            "status": fields.get("status") or "initiated",
            "created_at": created_at,
            "updated_at": updated_at,
            "scopes_json": _json_storage_value(fields.get("scopes_json"), []),
            "account_label": fields.get("account_label"),
            "last_checked_at": fields.get("last_checked_at"),
            "last_check_status": fields.get("last_check_status"),
            "last_check_error": fields.get("last_check_error"),
        }
        # MCP fields (engine PR #161). Engine passes kind="mcp" plus
        # mcp_label/mcp_url/mcp_auth_secret/mcp_allowed_tools_json when
        # creating an MCP connection; composio rows omit them and we let
        # the column defaults apply (kind='composio', tools='[]'::jsonb).
        if "kind" in fields:
            payload["kind"] = fields["kind"] or "composio"
        for key in (
            "mcp_label",
            "mcp_url",
            "mcp_transport",
            "mcp_command",
            "mcp_cwd",
            "mcp_auth_secret",
        ):
            if key in fields:
                payload[key] = fields[key]
        if "mcp_args_json" in fields:
            payload["mcp_args_json"] = _json_storage_value(fields["mcp_args_json"], [])
        if "mcp_env_json" in fields:
            payload["mcp_env_json"] = _json_storage_value(fields["mcp_env_json"], {})
        if "mcp_allowed_tools_json" in fields:
            payload["mcp_allowed_tools_json"] = _json_storage_value(
                fields["mcp_allowed_tools_json"], []
            )
        self._client.table("connections").upsert(payload, on_conflict="id").execute()
        item = self.get(user_id=user_id, composio_id=connection_id)
        if item is None:
            raise RuntimeError(f"failed to upsert connection {connection_id}")
        return item

    def update(self, *, user_id: str, composio_id: str, **fields: Any) -> dict[str, Any] | None:
        payload: dict[str, Any] = {}
        for key in (
            "app_name",
            "composio_connection_id",
            "status",
            "updated_at",
            "account_label",
            "last_checked_at",
            "last_check_status",
            "last_check_error",
            "kind",
            "mcp_label",
            "mcp_url",
            "mcp_transport",
            "mcp_command",
            "mcp_cwd",
            "mcp_auth_secret",
        ):
            if key in fields:
                payload[key] = fields[key]
        if "scopes_json" in fields:
            payload["scopes_json"] = _json_storage_value(fields["scopes_json"], [])
        if "mcp_args_json" in fields:
            payload["mcp_args_json"] = _json_storage_value(fields["mcp_args_json"], [])
        if "mcp_env_json" in fields:
            payload["mcp_env_json"] = _json_storage_value(fields["mcp_env_json"], {})
        if "mcp_allowed_tools_json" in fields:
            payload["mcp_allowed_tools_json"] = _json_storage_value(
                fields["mcp_allowed_tools_json"], []
            )
        if payload:
            builder = self._client.table("connections").update(payload).eq("id", composio_id)
            builder = _scope_by_workspace(builder, user_id=user_id)
            builder.execute()
        return self.get(user_id=user_id, composio_id=composio_id)

    def delete(self, *, user_id: str, composio_id: str) -> bool:
        builder = self._client.table("connections").delete().eq("id", composio_id)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.execute()
        return bool(_response_rows(response))

    def list_all(self) -> list[dict[str, Any]]:
        response = (
            self._client.table("connections")
            .select(self._CONNECTION_COLUMNS)
            .order("created_at")
            .order("id")
            .execute()
        )
        return [self._normalize_row(row) for row in _response_rows(response)]


class SupabaseSecretRepository(_BaseSupabaseRepository):
    """Secrets stored in Supabase Vault (pgsodium) for new writes.

    Migration strategy:
    - New secrets: stored via Vault (vault_secret_id set, value=NULL)
    - Legacy secrets: value blob (Fernet-encrypted), vault_secret_id=NULL
    - On next write of a legacy secret: migrated to Vault, Fernet blob cleared
    - On read: Vault takes priority; Fernet used as fallback for legacy rows
    """

    _SELECT = (
        "user_id,name,value,vault_secret_id,status,"
        "last_used_at,created_at,updated_at,last_checked_at,last_check_status,last_check_error"
    )

    def _decrypt_row(self, row: dict) -> dict:
        """Resolve plaintext from Vault or legacy Fernet blob. Strips raw fields."""
        vault_id = row.pop("vault_secret_id", None)
        ciphertext = _bytea_bytes(row.pop("value", None))
        if vault_id:
            try:
                from uuid import UUID
                row["value"] = vault_read_secret(self._client, UUID(str(vault_id)))
            except Exception as exc:
                _repo_logger.warning("vault_read_secret failed for %s: %s", row.get("name"), exc)
                row["value"] = None
        elif ciphertext is not None:
            try:
                row["value"] = decrypt_secret(ciphertext)
            except Exception:
                # Legacy Fernet decrypt failed (e.g. rotated/missing
                # WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY): the secret silently
                # reads back empty, so a worker that depends on it fails with a
                # confusing "missing credential". Surface it (name only — never
                # the ciphertext or plaintext).
                log_failure(
                    _repo_logger,
                    "legacy Fernet decrypt failed for secret %s; value unreadable",
                    row.get("name"),
                )
                row["value"] = None
        else:
            row["value"] = None
        return row

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        builder = self._client.table("secrets").select(self._SELECT)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.order("name").execute()
        return [self._decrypt_row(dict(item)) for item in _response_rows(response)]

    def get(self, *, user_id: str, name: str) -> dict[str, Any] | None:
        builder = self._client.table("secrets").select(self._SELECT)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("name", name).limit(1).execute()
        row = _first_row(response)
        return self._decrypt_row(dict(row)) if row is not None else None

    def set(self, *, user_id: str, name: str, value: str, status: str = "set", _retry: bool = True) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        workspace_id = _resolve_workspace_id_for_write(user_id=user_id)

        # Read existing row to find legacy vault_id or Fernet blob
        existing_builder = self._client.table("secrets").select("vault_secret_id,value")
        existing_builder = _scope_by_workspace(existing_builder, user_id=user_id)
        existing = _first_row(existing_builder.eq("name", name).limit(1).execute())

        vault_name = vault_secret_name(workspace_id, name)
        if existing is None:
            # New secret — store in Vault
            from uuid import UUID
            try:
                vault_id = vault_store_secret(self._client, value, vault_name)
                self._client.table("secrets").insert(
                    {
                        "user_id": user_id,
                        "workspace_id": workspace_id,
                        "name": name,
                        "value": None,
                        "vault_secret_id": str(vault_id),
                        "status": status,
                        "created_at": now,
                        "updated_at": now,
                    }
                ).execute()
            except Exception:
                # #281: a concurrent first-write of the same new secret collides
                # on the secrets PK (workspace_id,name) / vault UNIQUE(name).
                # The collision correctly prevents duplication, but surfaced as a
                # bare 500. If the row now exists, retry ONCE as an idempotent
                # update (last-write-wins); otherwise it's a real error -> raise.
                if _retry:
                    refetch = self._client.table("secrets").select("vault_secret_id")
                    refetch = _scope_by_workspace(refetch, user_id=user_id)
                    if _first_row(refetch.eq("name", name).limit(1).execute()) is not None:
                        return self.set(user_id=user_id, name=name, value=value, status=status, _retry=False)
                raise
        else:
            existing_vault_id = existing.get("vault_secret_id")
            if existing_vault_id:
                # Update existing Vault secret in place
                from uuid import UUID
                vault_update_secret(self._client, UUID(str(existing_vault_id)), value, vault_name)
                update_builder = self._client.table("secrets").update(
                    {"status": status, "updated_at": now}
                ).eq("name", name)
            else:
                # Migrate legacy Fernet secret → Vault on next write
                from uuid import UUID
                vault_id = vault_store_secret(self._client, value, vault_name)
                update_builder = self._client.table("secrets").update(
                    {
                        "value": None,
                        "vault_secret_id": str(vault_id),
                        "status": status,
                        "updated_at": now,
                    }
                ).eq("name", name)
            update_builder = _scope_by_workspace(update_builder, user_id=user_id)
            update_builder.execute()

        item = self.get(user_id=user_id, name=name)
        if item is None:
            raise RuntimeError(f"failed to set secret {name}")
        return item

    def delete(self, *, user_id: str, name: str) -> bool:
        # Fetch vault_secret_id before deleting the row
        fetch = self._client.table("secrets").select("vault_secret_id")
        fetch = _scope_by_workspace(fetch, user_id=user_id)
        row = _first_row(fetch.eq("name", name).limit(1).execute())
        if row and row.get("vault_secret_id"):
            from uuid import UUID
            vault_delete_secret(self._client, UUID(str(row["vault_secret_id"])))

        builder = self._client.table("secrets").delete().eq("name", name)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.execute()
        return bool(_response_rows(response))

    def read_value(self, *, user_id: str, name: str) -> str | None:
        builder = self._client.table("secrets").select("value,vault_secret_id")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("name", name).limit(1).execute()
        row = _first_row(response)
        if row is None:
            return None

        vault_id = row.get("vault_secret_id")
        if vault_id:
            from uuid import UUID
            plaintext = vault_read_secret(self._client, UUID(str(vault_id)))
        else:
            ciphertext = _bytea_bytes(row.get("value"))
            plaintext = decrypt_secret(ciphertext) if ciphertext is not None else None

        if plaintext is not None:
            used_builder = self._client.table("secrets").update(
                {"last_used_at": datetime.now(timezone.utc).isoformat()}
            ).eq("name", name)
            used_builder = _scope_by_workspace(used_builder, user_id=user_id)
            used_builder.execute()
        return plaintext

    def list_names(self, *, user_id: str) -> set[str]:
        builder = self._client.table("secrets").select("name")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.order("name").execute()
        return {str(item["name"]) for item in _response_rows(response)}

    def resolve(self, *, user_id: str, names: Iterable[str]) -> dict[str, str]:
        secrets: dict[str, str] = {}
        for name in names:
            value = self.read_value(user_id=user_id, name=name)
            if value:
                secrets[name] = value
        return secrets


class SupabaseCliAuthRepository(_BaseSupabaseRepository):
    _SECRET_PREFIX = "fernet:"

    @classmethod
    def _encode_secret(cls, value: Any) -> Any:
        if value is None:
            return None
        text = str(value)
        if not text or text.startswith(cls._SECRET_PREFIX):
            return value
        return cls._SECRET_PREFIX + encrypt_secret(text).decode("ascii")

    @classmethod
    def _decode_secret(cls, value: Any) -> Any:
        if value is None:
            return None
        text = str(value)
        if not text.startswith(cls._SECRET_PREFIX):
            # Legacy rows may contain a pending plaintext one-time token.
            return text
        return decrypt_secret(text.removeprefix(cls._SECRET_PREFIX).encode("ascii"))

    def _normalize_row(self, row: Mapping[str, Any]) -> dict[str, Any]:
        item = dict(row)
        item["scopes"] = _json_load(item.pop("scopes_json", None), [])
        item["secret"] = self._decode_secret(item.get("secret"))
        return item

    def create_device(self, *, user_id: str | None, **fields: Any) -> dict[str, Any]:
        # user_id can be None for cloud's pre-approval devices (see migration
        # 0007). The cloud cli-approve handler writes the real Supabase
        # user_id when the dashboard user claims the device.
        device_code = fields["device_code"]
        self._client.table("cli_auth_devices").insert(
            {
                "device_code": device_code,
                "user_id": user_id,
                "user_code": str(fields["user_code"]).strip().upper(),
                "status": fields.get("status") or "pending",
                "secret": self._encode_secret(fields.get("secret")),
                "client_name": fields["client_name"],
                "scopes_json": _json_storage_value(fields.get("scopes"), []),
                "created_ip": fields.get("created_ip"),
                "created_at": fields["created_at"],
                "expires_at": fields["expires_at"],
                "approved_at": fields.get("approved_at"),
            }
        ).execute()
        # Look up by device_code (unique PK) so we don't depend on user_id
        # being non-null. The OSS code path that passes a real user_id
        # still gets the same row back.
        item = self.get_by_device_code(device_code)
        if item is None:
            raise RuntimeError(f"failed to create cli auth device {device_code}")
        return item

    def count_pending(self, *, created_ip: str, now_ts: float) -> int:
        response = (
            self._client.table("cli_auth_devices")
            .select("device_code", count="exact")
            .eq("created_ip", created_ip)
            .eq("status", "pending")
            .gt("expires_at", now_ts)
            .execute()
        )
        return int(getattr(response, "count", 0) or 0)

    def verify_device(self, code: str) -> dict[str, Any] | None:
        response = (
            self._client.table("cli_auth_devices")
            .select(
                "device_code,user_id,user_code,status,secret,client_name,scopes_json,created_ip,created_at,expires_at,approved_at"
            )
            .eq("user_code", code.strip().upper())
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def consume(self, code: str) -> dict[str, Any] | None:
        response = (
            self._client.table("cli_auth_devices")
            .delete()
            .eq("device_code", code)
            .eq("status", "approved")
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        response = (
            self._client.table("cli_auth_devices")
            .select(
                "device_code,user_id,user_code,status,secret,client_name,scopes_json,created_ip,created_at,expires_at,approved_at"
            )
            .eq("user_id", user_id)
            .order("created_at")
            .order("device_code")
            .execute()
        )
        return [self._normalize_row(row) for row in _response_rows(response)]

    def get(self, *, user_id: str, device_code: str) -> dict[str, Any] | None:
        response = (
            self._client.table("cli_auth_devices")
            .select(
                "device_code,user_id,user_code,status,secret,client_name,scopes_json,created_ip,created_at,expires_at,approved_at"
            )
            .eq("user_id", user_id)
            .eq("device_code", device_code)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def get_by_device_code(self, device_code: str) -> dict[str, Any] | None:
        response = (
            self._client.table("cli_auth_devices")
            .select(
                "device_code,user_id,user_code,status,secret,client_name,scopes_json,created_ip,created_at,expires_at,approved_at"
            )
            .eq("device_code", device_code)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def update(self, *, device_code: str, **fields: Any) -> dict[str, Any] | None:
        payload: dict[str, Any] = {}
        for key in (
            "user_code",
            "status",
            "secret",
            "client_name",
            "created_ip",
            "created_at",
            "expires_at",
            "approved_at",
        ):
            if key in fields:
                payload[key] = fields[key]
        if "secret" in payload:
            payload["secret"] = self._encode_secret(payload["secret"])
        if "user_code" in payload:
            payload["user_code"] = str(payload["user_code"]).strip().upper()
        if "scopes_json" in fields:
            payload["scopes_json"] = _json_storage_value(fields["scopes_json"], [])
        if payload:
            self._client.table("cli_auth_devices").update(payload).eq(
                "device_code",
                device_code,
            ).execute()
        return self.get_by_device_code(device_code)

    def approve_pending(
        self,
        *,
        device_code: str,
        user_id: str,
        secret: str,
        approved_at: float,
    ) -> dict[str, Any] | None:
        payload = {
            "user_id": user_id,
            "status": "approved",
            "secret": self._encode_secret(secret),
            "approved_at": approved_at,
        }
        response = (
            self._client.table("cli_auth_devices")
            .update(payload)
            .eq("device_code", device_code)
            .eq("status", "pending")
            .or_(f"user_id.is.null,user_id.eq.{user_id}")
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def deny_pending(self, *, device_code: str) -> dict[str, Any] | None:
        response = (
            self._client.table("cli_auth_devices")
            .update({"status": "denied", "secret": None})
            .eq("device_code", device_code)
            .eq("status", "pending")
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def delete(self, *, device_code: str) -> bool:
        response = (
            self._client.table("cli_auth_devices")
            .delete()
            .eq("device_code", device_code)
            .execute()
        )
        return bool(_response_rows(response))

    def prune_expired(self, *, now_ts: float) -> list[str]:
        response = (
            self._client.table("cli_auth_devices")
            .select("device_code")
            .lte("expires_at", now_ts)
            .execute()
        )
        expired = [str(row["device_code"]) for row in _response_rows(response)]
        if expired:
            self._client.table("cli_auth_devices").delete().in_(
                "device_code",
                expired,
            ).execute()
        return expired


def _is_table_not_found(exc: Exception) -> bool:
    """Return True when a PostgREST error indicates the table does not exist yet."""
    msg = str(exc).lower()
    return "relation" in msg and "does not exist" in msg or "42p01" in msg


def _is_undefined_column(exc: Exception) -> bool:
    """Return True when a PostgREST error indicates a column does not exist yet.

    Used so signature-complete adapters can degrade gracefully on schemas that
    predate a column (e.g. approvals.expires_at before migration 0038) instead
    of 500ing a best-effort caller.
    """
    msg = str(exc).lower()
    return (
        ("column" in msg and "does not exist" in msg)
        or "42703" in msg
        or "could not find" in msg and "column" in msg
    )


class SupabaseApprovalRepository(_BaseSupabaseRepository):
    """Supabase-backed HITL approval repository.

    Methods degrade gracefully if the `approvals` table has not yet been
    created (migration 0011_approvals.sql pending). Read operations return
    empty results; write operations raise so callers see a clear error rather
    than a 500 crash.
    """

    _TABLE = "approvals"

    def create(self, *, owner_id: str, **fields: Any) -> dict[str, Any]:
        allowed = {
            "id", "run_id", "worker_id", "status", "label", "preview",
            "created_at", "decided_at", "reason", "expires_at",  # #798 BE-EXPIRY
            "decision_input_json", "edited_output_json", "follow_up_run_id",
            "annotations_json",
        }
        row: dict[str, Any] = {k: v for k, v in fields.items() if k in allowed}
        row["owner_id"] = owner_id
        workspace_id = get_active_workspace_id()
        if workspace_id:
            row["workspace_id"] = workspace_id
        self._client.table(self._TABLE).insert(row).execute()
        return self.get(owner_id=owner_id, approval_id=str(fields["id"])) or row  # type: ignore[return-value]

    def get(self, *, owner_id: str, approval_id: str) -> dict[str, Any] | None:
        try:
            response = (
                self._client.table(self._TABLE)
                .select("*")
                .eq("owner_id", owner_id)
                .eq("id", approval_id)
                .limit(1)
                .execute()
            )
            return _first_row(response)
        except Exception as exc:
            if _is_table_not_found(exc):
                return None
            raise

    def get_public(self, *, approval_id: str) -> dict[str, Any] | None:
        """Fetch one approval for signed public review links.

        The caller validates the HMAC token against id, run_id, and owner_id
        before returning any approval fields to the browser.
        """
        try:
            response = (
                self._client.table(self._TABLE)
                .select("*")
                .eq("id", approval_id)
                .limit(1)
                .execute()
            )
            return _first_row(response)
        except Exception as exc:
            if _is_table_not_found(exc):
                return None
            raise

    def get_by_run_id(self, *, run_id: str) -> dict[str, Any] | None:
        try:
            response = (
                self._client.table(self._TABLE)
                .select("*")
                .eq("run_id", run_id)
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            return _first_row(response)
        except Exception as exc:
            if _is_table_not_found(exc):
                return None
            raise

    def get_by_follow_up_run_id(self, *, follow_up_run_id: str) -> dict[str, Any] | None:
        # #418: authoritative EXECUTE-phase signal. Only approve_run sets
        # follow_up_run_id, so a matching approved row proves the engine
        # authorised this run's side effect (cannot be spoofed by inputs).
        try:
            response = (
                self._client.table(self._TABLE)
                .select("*")
                .eq("follow_up_run_id", follow_up_run_id)
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            return _first_row(response)
        except Exception as exc:
            if _is_table_not_found(exc):
                return None
            raise

    def list_pending(self, *, owner_id: str, limit: int = 100) -> list[dict[str, Any]]:
        # #1470 perf: the engine's GET /approvals route caps the pending list
        # and passes ``limit`` (interface.py: list_pending(*, owner_id, limit)).
        # This impl previously omitted the kwarg, so every cloud call raised
        # ``TypeError: list_pending() got an unexpected keyword argument
        # 'limit'`` -> 500 on /api/approvals. Accept + apply the bound; mirror
        # the engine's 1..200 clamp so a bad caller value cannot over-fetch.
        try:
            bounded = int(limit)
        except (TypeError, ValueError):
            bounded = 100
        bounded = max(1, min(bounded, 200))
        try:
            response = (
                self._client.table(self._TABLE)
                .select("*")
                .eq("owner_id", owner_id)
                .eq("status", "pending")
                .order("created_at")
                .limit(bounded)
                .execute()
            )
            return _response_rows(response)
        except Exception as exc:
            if _is_table_not_found(exc):
                return []
            raise

    def count_pending(self, *, owner_id: str) -> int:
        try:
            response = (
                self._client.table(self._TABLE)
                .select("id", count="exact")
                .eq("owner_id", owner_id)
                .eq("status", "pending")
                .execute()
            )
            return int(getattr(response, "count", 0) or 0)
        except Exception as exc:
            if _is_table_not_found(exc):
                return 0
            raise

    def expire_if_stale(self, *, approval_id: str, now_iso_str: str) -> bool:
        """#798 LAZY (BE-EXPIRY): atomically flip ONE pending approval past its
        ``expires_at`` to 'expired' and move its paused run off
        pending_approval. Returns True iff this call performed the flip.

        Mirrors SqliteApprovalRepository.expire_if_stale: the UPDATE is guarded
        by ``status='pending' AND expires_at < now`` so it is idempotent and
        race-safe (PostgREST returns the touched rows, so only the caller that
        actually flipped the row gets data back). If the deployed approvals
        table predates the ``expires_at`` column (migration 0038), the guard
        matches nothing and this is a safe no-op -> approvals simply never lazy-
        expire on that schema, matching prior cloud behaviour rather than 500ing
        the read/action path that calls this best-effort.
        """
        try:
            response = (
                self._client.table(self._TABLE)
                .update(
                    {
                        "status": "expired",
                        "decided_at": now_iso_str,
                    }
                )
                .eq("id", approval_id)
                .eq("status", "pending")
                .not_.is_("expires_at", "null")
                .lt("expires_at", now_iso_str)
                .execute()
            )
        except Exception as exc:
            # Table or expires_at column absent on this schema -> nothing to
            # expire. Never 500 the lazy/best-effort caller (router wraps this
            # in try/except, but be defensive here too).
            if _is_table_not_found(exc) or _is_undefined_column(exc):
                return False
            raise
        flipped_rows = getattr(response, "data", None) or []
        if not flipped_rows:
            return False
        # Move the paused run off pending_approval so it is not stuck forever.
        flipped = flipped_rows[0]
        run_id = flipped.get("run_id")
        owner_id = flipped.get("owner_id")
        if run_id and owner_id:
            try:
                self._client.table("runs").update(
                    {
                        "status": RunStatus.FAILED.value,
                        "error": "Approval expired before a decision was recorded.",
                        "error_code": "approval_expired",
                    }
                ).eq("id", run_id).eq(
                    "status", RunStatus.PENDING_APPROVAL.value
                ).execute()
            except Exception:
                # The approval is already flipped to 'expired' (the authoritative
                # signal); a run-status hiccup must not undo that or 500 the
                # caller. The hourly sweep / next read re-attempts run cleanup.
                _repo_logger.warning(
                    "expire_if_stale: run %s status flip failed (non-fatal)",
                    run_id,
                    exc_info=True,
                )
        return True

    def approve(
        self,
        *,
        owner_id: str,
        run_id: str,
        decided_at: str,
        edited_output_json: str | None = None,
        follow_up_run_id: str | None = None,
        annotations_json: str | None = None,
        reason: str | None = None,
    ) -> dict[str, Any] | None:
        # annotations_json + reason were missing here while the engine's
        # /approvals approve route passes them -> TypeError on every HITL
        # approve carrying annotations. Accept + persist (annotations_json
        # column added in migration 0034).
        #
        # #280: the conditional `eq("status", "pending")` UPDATE is the atomic
        # claim gate. The engine route only proceeds (spawns the follow-up run,
        # double-spends) when this returns a row, and 409s when it returns None.
        # Returning get_by_run_id() unconditionally defeated that: a race loser
        # got the now-approved/rejected row back, so `claimed is None` never
        # fired and concurrent approve+reject / double-approve both won. Postgres
        # re-evaluates `status='pending'` after the row lock, so only the call
        # that actually flipped the row gets data back -> return None otherwise.
        response = (
            self._client.table(self._TABLE)
            .update(
                {
                    "status": "approved",
                    "decided_at": decided_at,
                    "edited_output_json": edited_output_json,
                    "follow_up_run_id": follow_up_run_id,
                    "annotations_json": annotations_json,
                    "reason": reason,
                }
            )
            .eq("run_id", run_id)
            .eq("owner_id", owner_id)
            .eq("status", "pending")
            .or_(f"expires_at.is.null,expires_at.gte.{decided_at}")
            .execute()
        )
        if not (getattr(response, "data", None) or []):
            return None  # lost the claim — another decision already won
        return self.get_by_run_id(run_id=run_id)

    def attach_follow_up(
        self,
        *,
        owner_id: str,
        run_id: str,
        follow_up_run_id: str,
        edited_output_json: str | None = None,
    ) -> dict[str, Any] | None:
        # #280: approve() claims pending->approved atomically *before* the
        # follow-up run is spawned, so the spawned run id is recorded here in a
        # second step. Scoped to the already-approved row this owner just won.
        update: dict[str, Any] = {"follow_up_run_id": follow_up_run_id}
        if edited_output_json is not None:
            update["edited_output_json"] = edited_output_json
        self._client.table(self._TABLE).update(update).eq("run_id", run_id).eq(
            "owner_id", owner_id
        ).eq("status", "approved").execute()
        return self.get_by_run_id(run_id=run_id)

    def reject(
        self,
        *,
        owner_id: str,
        run_id: str,
        decided_at: str,
        reason: str | None = None,
        annotations_json: str | None = None,
    ) -> dict[str, Any] | None:
        # #280: same atomic-claim semantics as approve() — return None when the
        # conditional UPDATE flipped no pending row so the route's `claimed is
        # None` 409 guard fires instead of letting a race loser proceed.
        response = (
            self._client.table(self._TABLE)
            .update(
                {
                    "status": "rejected",
                    "decided_at": decided_at,
                    "reason": reason,
                    "annotations_json": annotations_json,
                }
            )
            .eq("run_id", run_id)
            .eq("owner_id", owner_id)
            .eq("status", "pending")
            .or_(f"expires_at.is.null,expires_at.gte.{decided_at}")
            .execute()
        )
        if not (getattr(response, "data", None) or []):
            return None  # lost the claim — another decision already won
        return self.get_by_run_id(run_id=run_id)


class SupabaseApiTokenRepository(_BaseSupabaseRepository):
    """PAT (Personal Access Token) storage.

    Raw token values are NEVER stored — only SHA-256 hashes.
    The caller is responsible for generating the raw token, hashing it,
    and showing the raw value to the user exactly once.
    """

    def create(
        self,
        *,
        user_id: str,
        name: str,
        token_hash: str,
        workspace_id: str | None = None,
    ) -> dict[str, Any]:
        # #225: _resolve_workspace_id_for_write trusts the raw
        # x-workeros-workspace contextvar without verifying it points at a real
        # workspace the caller can use; a stale/invalid header value then
        # FK-violates api_tokens.workspace_id (NOT NULL + FK -> workspaces) and
        # surfaces as a bare 500 on POST /auth/tokens. resolve_active_workspace
        # validates ownership/membership of the requested id (falling back to
        # the caller's default workspace, lazy-creating if none), guaranteeing a
        # real workspaces row for the FK.
        if workspace_id:
            resolved_workspace_id = workspace_id
        else:
            active = workspace_repo.resolve_active_workspace(
                user_id=user_id,
                email=None,
                requested_id=get_active_workspace_id(),
            )
            resolved_workspace_id = str(active["id"])
        self._client.table("api_tokens").insert(
            {
                "user_id": user_id,
                "workspace_id": resolved_workspace_id,
                "name": name,
                "token_hash": token_hash,
            }
        ).execute()
        row = self.get_by_hash(token_hash)
        if row is None:
            raise RuntimeError("failed to create api token")
        return row

    def get_by_hash(self, token_hash: str) -> dict[str, Any] | None:
        response = (
            self._client.table("api_tokens")
            .select("id,user_id,workspace_id,name,created_at,last_used_at")
            .eq("token_hash", token_hash)
            .limit(1)
            .execute()
        )
        return _first_row(response)

    def list_for_user(self, *, user_id: str) -> list[dict[str, Any]]:
        builder = (
            self._client.table("api_tokens")
            .select("id,user_id,workspace_id,name,created_at,last_used_at")
            .eq("user_id", user_id)
        )
        workspace_id = get_active_workspace_id()
        if workspace_id:
            builder = builder.eq("workspace_id", workspace_id)
        response = builder.order("created_at").execute()
        return _response_rows(response)

    def has_any(self, *, user_id: str) -> bool:
        builder = (
            self._client.table("api_tokens")
            .select("id", count="exact")
            .eq("user_id", user_id)
        )
        workspace_id = get_active_workspace_id()
        if workspace_id:
            builder = builder.eq("workspace_id", workspace_id)
        response = builder.limit(1).execute()
        return int(getattr(response, "count", 0) or 0) > 0

    def touch(self, *, token_id: str) -> None:
        self._client.table("api_tokens").update(
            {"last_used_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", token_id).execute()

    def delete(self, *, token_id: str, user_id: str) -> bool:
        # #275: capture the token_hash before deleting so we can evict the auth
        # provider's PAT cache — otherwise a revoked token keeps authenticating
        # for up to _PAT_TTL (60s).
        hash_row = _first_row(
            self._client.table("api_tokens")
            .select("token_hash")
            .eq("id", token_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        builder = (
            self._client.table("api_tokens")
            .delete()
            .eq("id", token_id)
            .eq("user_id", user_id)
        )
        workspace_id = get_active_workspace_id()
        if workspace_id:
            builder = builder.eq("workspace_id", workspace_id)
        response = builder.execute()
        deleted = bool(_response_rows(response))
        if deleted and hash_row and hash_row.get("token_hash"):
            try:
                from apps.api.auth.supabase_provider import evict_pat_cache
                evict_pat_cache(str(hash_row["token_hash"]))
            except Exception:
                _repo_logger.warning("PAT cache eviction failed for token %s", token_id, exc_info=True)
        return deleted


# ---------------------------------------------------------------------------
# Version repository
# ---------------------------------------------------------------------------

VISIBILITY_VALUES: frozenset[str] = frozenset({"private", "workspace", "specific_people"})
_ASSET_TABLES: dict[str, str] = {
    "worker": "workers",
    "brain_pack": "brain_packs",
    "assistant": "assistants",
}


class SupabaseAssetAccessRepository:
    """Cloud implementation of the engine AssetAccessRepository."""

    @property
    def _client(self) -> Client:
        return get_supabase_service_client()

    @staticmethod
    def _workspace_id(workspace_id: str | None, *, owner_id: str | None = None) -> str | None:
        active = get_active_workspace_id()
        if active:
            return active
        if workspace_id and workspace_id != "local-default":
            return workspace_id
        if owner_id:
            return _resolve_workspace_id_for_write(user_id=owner_id)
        return workspace_id

    def _asset_row(
        self,
        *,
        asset_type: str,
        asset_id: str,
        workspace_id: str | None = None,
    ) -> dict[str, Any] | None:
        table = _ASSET_TABLES.get(asset_type)
        if table is None:
            raise ValueError(f"unsupported asset_type {asset_type!r}")
        owner_col = "user_id" if asset_type == "worker" else "owner_id"
        builder = (
            self._client.table(table)
            .select(f"id,{owner_col},workspace_id,visibility")
            .eq("id", asset_id)
        )
        if asset_type in {"worker", "brain_pack", "assistant"}:
            effective_workspace_id = self._workspace_id(workspace_id)
            if effective_workspace_id:
                builder = builder.eq("workspace_id", effective_workspace_id)
        response = builder.limit(1).execute()
        row = _first_row(response)
        if row is None:
            return None
        row["owner_id"] = row.get(owner_col)
        visibility = str(row.get("visibility") or "private")
        row["visibility"] = "workspace" if visibility == "shared" else visibility
        return row

    @staticmethod
    def _role(*, workspace_id: str, user_id: str) -> str | None:
        ws = workspace_repo.get(workspace_id=workspace_id)
        if ws and str(ws.get("owner_user_id", "")) == str(user_id):
            return "owner"
        return workspace_repo.get_member_role(workspace_id=workspace_id, user_id=user_id)

    @staticmethod
    def _compute(
        *, owner_id: str | None, visibility: str, role: str | None, user_id: str
    ) -> dict[str, Any]:
        is_owner = bool(owner_id) and owner_id == user_id
        is_admin = role in {"owner", "admin"}
        is_member = role in {"owner", "admin", "member"}
        shared = visibility == "workspace"
        can_view = is_owner or (shared and is_member)
        return {
            "owner_id": owner_id,
            "visibility": visibility,
            "is_owner": is_owner,
            "role": role,
            "can_view": can_view,
            "can_edit": is_owner or (shared and is_admin),
            "can_delete": is_owner or (shared and is_admin),
            "can_run": can_view,
            "can_share": is_owner or (can_view and is_admin),
        }

    def ensure_brain_pack(
        self,
        *,
        pack_id: str,
        workspace_id: str,
        owner_id: str,
        name: str | None = None,
        default_visibility: str = "private",
    ) -> dict[str, Any]:
        if default_visibility not in VISIBILITY_VALUES:
            default_visibility = "private"
        workspace_id = self._workspace_id(workspace_id, owner_id=owner_id) or workspace_id
        now = datetime.now(timezone.utc).isoformat()
        existing = self._asset_row(
            asset_type="brain_pack",
            asset_id=pack_id,
            workspace_id=workspace_id,
        )
        if existing is not None:
            (
                self._client.table("brain_packs")
                .update({"owner_id": owner_id, "name": name or pack_id, "updated_at": now})
                .eq("workspace_id", workspace_id)
                .eq("id", pack_id)
                .execute()
            )
            return self._asset_row(
                asset_type="brain_pack",
                asset_id=pack_id,
                workspace_id=workspace_id,
            ) or {}
        insert_payload = {
            "id": pack_id,
            "workspace_id": workspace_id,
            "owner_id": owner_id,
            "visibility": default_visibility,
            "name": name or pack_id,
            "metadata_json": {},
            "created_at": now,
            "updated_at": now,
        }
        self._client.table("brain_packs").upsert(insert_payload, on_conflict="workspace_id,id").execute()
        return self._asset_row(
            asset_type="brain_pack",
            asset_id=pack_id,
            workspace_id=workspace_id,
        ) or {}

    def ensure_assistant(
        self,
        *,
        assistant_id: str,
        workspace_id: str,
        owner_id: str,
        name: str = "Workspace assistant",
        default_visibility: str = "workspace",
    ) -> dict[str, Any]:
        if default_visibility not in VISIBILITY_VALUES:
            default_visibility = "workspace"
        workspace_id = self._workspace_id(workspace_id, owner_id=owner_id) or workspace_id
        now = datetime.now(timezone.utc).isoformat()
        existing = self._asset_row(
            asset_type="assistant",
            asset_id=assistant_id,
            workspace_id=workspace_id,
        )
        if existing is not None:
            (
                self._client.table("assistants")
                .update({"owner_id": owner_id, "name": name, "updated_at": now})
                .eq("workspace_id", workspace_id)
                .eq("id", assistant_id)
                .execute()
            )
            return self._asset_row(
                asset_type="assistant",
                asset_id=assistant_id,
                workspace_id=workspace_id,
            ) or {}
        self._client.table("assistants").insert(
            {
                "id": assistant_id,
                "workspace_id": workspace_id,
                "owner_id": owner_id,
                "visibility": default_visibility,
                "name": name,
                "config_json": {},
                "instructions_md": None,
                "created_at": now,
                "updated_at": now,
            },
        ).execute()
        return self._asset_row(
            asset_type="assistant",
            asset_id=assistant_id,
            workspace_id=workspace_id,
        ) or {}

    def get_permissions(
        self, *, workspace_id: str, user_id: str, asset_type: str, asset_id: str
    ) -> dict[str, Any]:
        workspace_id = self._workspace_id(workspace_id, owner_id=user_id) or workspace_id
        asset = self._asset_row(
            asset_type=asset_type,
            asset_id=asset_id,
            workspace_id=workspace_id,
        )
        if asset is None:
            return self._compute(owner_id=None, visibility="private", role=None, user_id=user_id)
        asset_workspace_id = str(asset.get("workspace_id") or workspace_id)
        role = self._role(workspace_id=asset_workspace_id, user_id=user_id)
        return self._compute(
            owner_id=str(asset.get("owner_id") or ""),
            visibility=str(asset.get("visibility") or "private"),
            role=role,
            user_id=user_id,
        )

    def set_visibility(
        self,
        *,
        workspace_id: str,
        actor_id: str,
        asset_type: str,
        asset_id: str,
        visibility: str,
        actor_role: str | None = None,
    ) -> dict[str, Any] | None:
        # #266: the engine calls this with actor_role="admin" when auth.is_admin
        # (the cloud's authoritative admin determination). The param was missing
        # here, so the keyword raised TypeError — neither PermissionError nor
        # ValueError — which the engine route didn't catch, 500-ing every
        # PUT /workers/{id}/visibility (owner sharing their OWN worker included).
        if visibility not in VISIBILITY_VALUES:
            raise ValueError(f"invalid visibility {visibility!r}")
        table = _ASSET_TABLES.get(asset_type)
        if table is None:
            raise ValueError(f"unsupported asset_type {asset_type!r}")
        workspace_id = self._workspace_id(workspace_id, owner_id=actor_id) or workspace_id
        asset = self._asset_row(
            asset_type=asset_type,
            asset_id=asset_id,
            workspace_id=workspace_id,
        )
        if asset is None:
            return None
        asset_workspace_id = str(asset.get("workspace_id") or workspace_id)
        # Honor the engine-supplied admin signal; fall back to the DB role.
        role = actor_role if actor_role in {"owner", "admin"} else self._role(
            workspace_id=asset_workspace_id, user_id=actor_id
        )
        perms = self._compute(
            owner_id=str(asset.get("owner_id") or ""),
            visibility=str(asset.get("visibility") or "private"),
            role=role,
            user_id=actor_id,
        )
        if not perms["can_share"]:
            raise PermissionError("only the asset owner or a workspace admin can change visibility")
        stored_visibility = "shared" if asset_type == "worker" and visibility == "workspace" else visibility
        update_builder = self._client.table(table).update({"visibility": stored_visibility}).eq("id", asset_id)
        if asset_type in {"brain_pack", "assistant"}:
            update_builder = update_builder.eq("workspace_id", asset_workspace_id)
        update_builder.execute()
        return self.get_permissions(
            workspace_id=asset_workspace_id,
            user_id=actor_id,
            asset_type=asset_type,
            asset_id=asset_id,
        )

    def transfer_asset_owner(
        self, *, workspace_id: str, actor_id: str, asset_type: str, asset_id: str, new_owner_id: str
    ) -> dict[str, Any] | None:
        table = _ASSET_TABLES.get(asset_type)
        if table is None:
            raise ValueError(f"unsupported asset_type {asset_type!r}")
        workspace_id = self._workspace_id(workspace_id, owner_id=actor_id) or workspace_id
        asset = self._asset_row(
            asset_type=asset_type,
            asset_id=asset_id,
            workspace_id=workspace_id,
        )
        if asset is None:
            return None
        asset_workspace_id = str(asset.get("workspace_id") or workspace_id)
        role = self._role(workspace_id=asset_workspace_id, user_id=actor_id)
        is_owner = str(asset.get("owner_id") or "") == actor_id
        if not (is_owner or role in {"owner", "admin"}):
            raise PermissionError("only the asset owner or a workspace admin can transfer the asset")
        owner_col = "user_id" if asset_type == "worker" else "owner_id"
        update_builder = self._client.table(table).update({owner_col: new_owner_id}).eq("id", asset_id)
        if asset_type in {"brain_pack", "assistant"}:
            update_builder = update_builder.eq("workspace_id", asset_workspace_id)
        update_builder.execute()
        return self.get_permissions(
            workspace_id=asset_workspace_id,
            user_id=actor_id,
            asset_type=asset_type,
            asset_id=asset_id,
        )


class SupabaseVersionRepository:
    """Supabase implementation of VersionRepository."""

    @property
    def _client(self) -> Client:
        return get_supabase_service_client()

    def _scope(self, builder: Any) -> Any:
        workspace_id = get_active_workspace_id()
        if workspace_id:
            return builder.eq("workspace_id", workspace_id)
        return builder

    def create(
        self,
        *,
        asset_type: str,
        asset_id: str,
        user_id: str,
        snapshot_json: str,
        change_source: str,
    ) -> dict[str, Any]:
        import uuid as _uuid
        version_id = f"ver_{_uuid.uuid4().hex[:12]}"
        workspace_id = get_active_workspace_id()
        # Next version number
        version_query = (
            self._client.table("asset_versions")
            .select("version_number")
            .eq("asset_type", asset_type)
            .eq("asset_id", asset_id)
        )
        response = self._scope(version_query).order("version_number", desc=True).limit(1).execute()
        rows = _response_rows(response)
        next_version = (rows[0]["version_number"] + 1) if rows else 1
        payload = {
            "id": version_id,
            "workspace_id": workspace_id,
            "asset_type": asset_type,
            "asset_id": asset_id,
            "user_id": user_id,
            "version_number": next_version,
            "snapshot_json": snapshot_json,
            "change_source": change_source,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self._client.table("asset_versions").insert(payload).execute()
        return self.get(version_id=version_id) or {}

    def list(
        self,
        *,
        asset_type: str,
        asset_id: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        builder = (
            self._client.table("asset_versions")
            .select("id, asset_type, asset_id, user_id, version_number, change_source, created_at")
            .eq("asset_type", asset_type)
            .eq("asset_id", asset_id)
        )
        response = self._scope(builder).order("version_number", desc=True).limit(limit).execute()
        return _response_rows(response)

    def get(self, *, version_id: str) -> dict[str, Any] | None:
        builder = (
            self._client.table("asset_versions")
            .select("*")
            .eq("id", version_id)
        )
        response = self._scope(builder).limit(1).execute()
        return _first_row(response)

    def prune(self, *, asset_type: str, asset_id: str, keep: int = 50) -> int:
        builder = (
            self._client.table("asset_versions")
            .select("id")
            .eq("asset_type", asset_type)
            .eq("asset_id", asset_id)
        )
        response = self._scope(builder).order("version_number", desc=True).limit(keep).execute()
        keep_ids = [r["id"] for r in _response_rows(response)]
        if not keep_ids:
            return 0
        delete_builder = (
            self._client.table("asset_versions")
            .delete()
            .eq("asset_type", asset_type)
            .eq("asset_id", asset_id)
        )
        delete_resp = self._scope(delete_builder).not_.in_("id", keep_ids).execute()
        return len(_response_rows(delete_resp))

    def delete_for_asset(self, *, asset_type: str, asset_id: str) -> int:
        """Delete ALL versions for a single (asset_type, asset_id) pair.

        Called when the parent asset (worker, brain pack, brain file) is
        deleted, so its snapshot history does not linger as an orphan.
        Mirrors SqliteVersionRepository.delete_for_asset.
        """
        builder = (
            self._client.table("asset_versions")
            .delete()
            .eq("asset_type", asset_type)
            .eq("asset_id", asset_id)
        )
        response = self._scope(builder).execute()
        return len(_response_rows(response))

    def delete_for_context(self, *, name: str) -> int:
        """Delete every version row belonging to a context (brain pack).

        A context owns one brain_pack asset (asset_id == name) plus one
        brain_file asset per file (asset_id == f"{name}:{rel}"). Deleting the
        context must remove all of them. Mirrors
        SqliteVersionRepository.delete_for_context, but matches the prefix in
        Python (select candidates, filter on asset_id == name or
        startswith(name + ":")) to avoid PostgREST LIKE-wildcard mismatches on
        context names that legitimately contain '_' or '%'.
        """
        prefix = f"{name}:"
        deleted = 0
        for asset_type in ("brain_pack", "brain_file"):
            select_builder = (
                self._client.table("asset_versions")
                .select("id, asset_id")
                .eq("asset_type", asset_type)
            )
            rows = _response_rows(self._scope(select_builder).execute())
            target_ids = [
                str(r["id"])
                for r in rows
                if str(r.get("asset_id")) == name
                or str(r.get("asset_id")).startswith(prefix)
            ]
            if not target_ids:
                continue
            delete_builder = (
                self._client.table("asset_versions")
                .delete()
                .in_("id", target_ids)
            )
            resp = self._scope(delete_builder).execute()
            deleted += len(_response_rows(resp))
        return deleted


class SupabaseMcpToolRepository(_BaseSupabaseRepository):
    """Supabase implementation of McpToolRepository — workspace-scoped."""

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        builder = self._client.table("mcp_tools").select(
            "id,user_id,workspace_id,name,description,input_schema,worker_id,created_at,updated_at"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.order("created_at").execute()
        return _response_rows(response)

    def get(self, *, user_id: str, tool_id: str) -> dict[str, Any] | None:
        builder = self._client.table("mcp_tools").select("*")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("id", tool_id).limit(1).execute()
        return _first_row(response)

    def get_by_name(self, *, user_id: str, name: str) -> dict[str, Any] | None:
        builder = self._client.table("mcp_tools").select("*")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("name", name).limit(1).execute()
        return _first_row(response)

    def create(
        self,
        *,
        user_id: str,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        worker_id: str,
    ) -> dict[str, Any]:
        import uuid as _uuid
        workspace_id = _resolve_workspace_id_for_write(user_id=user_id)
        now = datetime.now(timezone.utc).isoformat()
        self._client.table("mcp_tools").insert({
            "id": str(_uuid.uuid4()),
            "user_id": user_id,
            "workspace_id": workspace_id,
            "name": name,
            "description": description,
            "input_schema": input_schema,
            "worker_id": worker_id,
            "created_at": now,
            "updated_at": now,
        }).execute()
        item = self.get_by_name(user_id=user_id, name=name)
        if item is None:
            raise RuntimeError(f"failed to create mcp_tool {name!r}")
        return item

    def update(self, *, user_id: str, tool_id: str, **fields: Any) -> dict[str, Any] | None:
        existing = self.get(user_id=user_id, tool_id=tool_id)
        if existing is None:
            return None
        allowed = {"name", "description", "input_schema", "worker_id"}
        updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
        if not updates:
            return existing
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        builder = self._client.table("mcp_tools").update(updates).eq("id", tool_id)
        builder = _scope_by_workspace(builder, user_id=user_id)
        builder.execute()
        return self.get(user_id=user_id, tool_id=tool_id)

    def delete(self, *, user_id: str, tool_id: str) -> bool:
        builder = self._client.table("mcp_tools").delete().eq("id", tool_id)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.execute()
        return bool(_response_rows(response))


class SupabaseAlertRepository(_BaseSupabaseRepository):
    """Supabase implementation of AlertRepository — workspace-scoped.

    Replaces SqliteAlertRepository in cloud. The engine's AlertRepository
    Protocol uses worker_id as the only scope key; in cloud we additionally
    filter by workspace_id from the active request context so tenants are
    fully isolated.
    """

    def _workspace_id(self) -> str | None:
        return get_active_workspace_id()

    def add(
        self,
        *,
        alert_id: str,
        worker_id: str,
        url: str | None,
        email_to: str | None,
        events: str,
        description: str | None,
        created_at: str,
    ) -> dict[str, Any]:
        workspace_id = self._workspace_id()
        if not workspace_id:
            raise RuntimeError("No active workspace_id — cannot create alert")
        row = {
            "id": alert_id,
            "workspace_id": workspace_id,
            "worker_id": worker_id,
            "url": url,
            "email_to": email_to,
            "events": events,
            "description": description,
            "created_at": created_at,
        }
        self._client.table("worker_alerts").insert(row).execute()
        return row

    def list(self, *, worker_id: str) -> list[dict[str, Any]]:
        builder = (
            self._client.table("worker_alerts")
            .select("id,workspace_id,worker_id,url,email_to,events,description,created_at")
            .eq("worker_id", worker_id)
        )
        workspace_id = self._workspace_id()
        if workspace_id:
            builder = builder.eq("workspace_id", workspace_id)
        return _response_rows(builder.order("created_at").execute())

    def get(self, *, alert_id: str) -> dict[str, Any] | None:
        builder = self._client.table("worker_alerts").select("*").eq("id", alert_id)
        workspace_id = self._workspace_id()
        if workspace_id:
            builder = builder.eq("workspace_id", workspace_id)
        return _first_row(builder.limit(1).execute())

    def delete(self, *, alert_id: str, worker_id: str) -> bool:
        builder = (
            self._client.table("worker_alerts")
            .delete()
            .eq("id", alert_id)
            .eq("worker_id", worker_id)
        )
        workspace_id = self._workspace_id()
        if workspace_id:
            builder = builder.eq("workspace_id", workspace_id)
        response = builder.execute()
        return bool(_response_rows(response))


class SupabaseFeedbackRepository(_BaseSupabaseRepository):
    """Supabase implementation of FeedbackRepository — workspace-scoped.

    Replaces SqliteFeedbackRepository in cloud. Per-worker feedback comments
    (SPEC §12). The engine's Protocol scopes by worker_id / feedback_id; in
    cloud we additionally filter by the active workspace_id so tenants are
    isolated. Without this repo wired in, the feedback routes return 503
    ("feedback not available") because repos.feedback is None.
    """

    _cols = "id,workspace_id,worker_id,author_id,author_name,content,created_at"

    def _workspace_id(self) -> str | None:
        return get_active_workspace_id()

    def add(
        self,
        *,
        feedback_id: str,
        worker_id: str,
        author_id: str,
        author_name: str | None,
        content: str,
        created_at: str,
    ) -> dict[str, Any]:
        workspace_id = self._workspace_id()
        if not workspace_id:
            raise RuntimeError("No active workspace_id — cannot create feedback")
        row = {
            "id": feedback_id,
            "workspace_id": workspace_id,
            "worker_id": worker_id,
            "author_id": author_id,
            "author_name": author_name,
            "content": content,
            "created_at": created_at,
        }
        self._client.table("worker_feedback").insert(row).execute()
        return row

    def list(self, *, worker_id: str) -> list[dict[str, Any]]:
        builder = (
            self._client.table("worker_feedback")
            .select(self._cols)
            .eq("worker_id", worker_id)
        )
        workspace_id = self._workspace_id()
        if workspace_id:
            builder = builder.eq("workspace_id", workspace_id)
        return _response_rows(builder.order("created_at").execute())

    def get(self, *, feedback_id: str) -> dict[str, Any] | None:
        builder = self._client.table("worker_feedback").select("*").eq("id", feedback_id)
        workspace_id = self._workspace_id()
        if workspace_id:
            builder = builder.eq("workspace_id", workspace_id)
        return _first_row(builder.limit(1).execute())

    def delete(self, *, feedback_id: str, worker_id: str) -> bool:
        builder = (
            self._client.table("worker_feedback")
            .delete()
            .eq("id", feedback_id)
            .eq("worker_id", worker_id)
        )
        workspace_id = self._workspace_id()
        if workspace_id:
            builder = builder.eq("workspace_id", workspace_id)
        response = builder.execute()
        return bool(_response_rows(response))
