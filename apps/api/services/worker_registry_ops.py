"""Worker registration operations: manifest parsing, id allocation, file
embedding, skill-version + git-commit + DB persistence.

The subsystem that turns uploaded/drafted worker files into persisted workers,
shared by the worker create/from-bundle/patch/files/rollback routes and by
chat_service/run_service (worker authoring). Extracted from main.py in
dependency-order slices; this first slice holds the leaf helpers (manifest
parse, id rewrite/alloc, trigger extraction, file-embed predicate, validation
redaction).

Pure/leaf + services deps only: services.worker_access (id guards, trigger
normalize), services.context_access (context visibility), services.worker_serialize
(file-ignore predicate); models/db/worker_registry lazy. Never imports main.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError

from core.config import PROTECTED_STOCK_WORKER_IDS
from services.context_access import _context_visible_to_user, _is_system_context_pack
from services.worker_access import _normalize_trigger_type, _raise_if_protected_worker_mutation
from services.composio import (
    _config_from_manifest_for_worker,
    _existing_composio_state,
    _sync_composio_registration,
)
from services.git_service import (
    _ensure_git_workspace_ready,
    _git_ops_lock,
    _git_workspace,
    _workers_git_prefix,
)
from services.worker_serialize import _DEFAULT_RUN_PY_STUB, _should_ignore_worker_file

logger = logging.getLogger("floom.api")

_SENSITIVE_FILE_NAMES = frozenset({".env", ".env.local", ".env.production", ".env.development"})
_SENSITIVE_FILE_SUFFIXES = frozenset({".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".p8", ".der", ".ppk"})

from models import DraftFile  # re-export: DraftFile now lives in models.py


def _git_join(*parts: str) -> str:
    """Join path parts, skipping empty segments (handles empty prefix in cloud mode)."""
    return "/".join(p for p in parts if p)


def _skill_version_id(worker_id: str, manifest: Dict[str, Any]) -> str:
    version = str(manifest.get("version") or "0.1.0")
    safe_version = version.replace(".", "_").replace("-", "_")
    return f"sv_{worker_id}_{safe_version}"


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


def _should_embed_file(rel_path: str) -> bool:
    if _should_ignore_worker_file(rel_path):
        return False
    name = Path(rel_path).name
    if name in _SENSITIVE_FILE_NAMES or name.startswith(".env"):
        return False
    if Path(rel_path).suffix.lower() in _SENSITIVE_FILE_SUFFIXES:
        return False
    return True


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


def _parse_worker_payload(
    worker_yml: str,
    *,
    user_id: str | None = None,
    allow_protected_worker_id: bool = False,
) -> tuple[str, WorkerConfig]:
    from contexts import context_dir, context_scope_for_user, load_context_metadata, normalize_context_mount, use_context_scope
    from models import WorkerConfig
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
        from models import memory_context_mount_for_worker
        memory_mount = memory_context_mount_for_worker(config.id, config.memory)
        memory_context_name = (memory_mount or {}).get("name")
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
                if memory_context_name and context_name == memory_context_name:
                    continue
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


def _git_commit_worker(
    worker_id: str,
    *,
    message: str,
    author_name: str = "WorkerOS",
    author_email: str = "workeros@local",
) -> None:
    import git_ops as _git_ops
    try:
        workspace = _git_workspace()
        with _git_ops_lock:
            _ensure_git_workspace_ready(workspace)
            rel = _git_join(_workers_git_prefix(), worker_id)
            _git_ops.commit_paths(workspace, [rel], message, author_name, author_email)
            _git_ops.push_background(workspace)
    except Exception as exc:
        logger.warning("git commit failed for worker %s: %s", worker_id, exc)


def _embed_files_in_skill_version(worker_id: str, worker_dir: Path) -> None:
    """Store all text worker files into manifest_json._files so they survive container redeploys."""
    from db import get_db
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
    from db import get_db
    from worker_registry import discover_workers, invalidate_worker_cache
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


def _persist_discovered_workers(
    conn: sqlite3.Connection,
    workers: List[Dict[str, Any]],
    *,
    user_id: str,
    raise_on_skip: bool = False,
) -> Tuple[int, int]:
    """Persist each discovered worker, isolated so one bad worker cannot poison
    the rest.

    A single malformed or foreign worker (e.g. a dangling skill_version FK, an
    invalid manifest enum, or a non-worker backup dir that happens to carry a
    worker.yml) used to raise out of this loop uncaught — which crashed API
    startup and triggered a 502 crash-loop. Each worker is now wrapped in its
    own SQLite SAVEPOINT: on any exception we roll back ONLY that worker's
    partial writes (so the outer transaction is not poisoned), log a warning,
    and continue. Returns ``(loaded, skipped)``.

    ``raise_on_skip=True`` re-raises after rolling back the failing worker. The
    single-worker save/create endpoints pass this so a user who saves exactly
    one worker still gets a hard error instead of a silent "success" with no
    row persisted. Bulk reloads + the startup path use the default (False) so
    one bad worker never blocks the whole set or crashes the process.
    """
    from db import now_iso
    now = now_iso()
    loaded = 0
    skipped = 0
    for w in workers:
        worker_id = w.get("id", "<unknown>")
        # Per-worker SAVEPOINT so a failing worker's partial INSERTs roll back
        # cleanly without aborting the whole transaction (SQLite leaves a failed
        # statement's transaction open; ROLLBACK TO SAVEPOINT is the safe undo).
        savepoint = f"persist_worker_{loaded + skipped}"
        conn.execute(f"SAVEPOINT {savepoint}")
        try:
            _persist_one_worker(conn, w, user_id=user_id, now=now)
        except Exception as exc:
            conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            skipped += 1
            logger.warning("Skipping unloadable worker %s: %s", worker_id, exc)
            if raise_on_skip:
                raise
            continue
        conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        loaded += 1
    return loaded, skipped


def _persist_one_worker(
    conn: sqlite3.Connection,
    w: Dict[str, Any],
    *,
    user_id: str,
    now: str,
) -> None:
    from models import WorkerConfig
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
    # local-owned, so a fresh member hit "worker <id> does not belong to
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


def _ensure_worker_row_for_rotation(
    *,
    worker_id: str,
    worker: Dict[str, Any],
    config: Optional[WorkerConfig],
    auth: AuthContext,
    repos: Repositories,
) -> None:
    """Persist a filesystem-registry worker before storing FK-backed webhook state."""
    from models import WorkerConfig  # noqa: F401
    from worker_registry import WORKERS_DIR
    from services.worker_access import _get_db_worker
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
