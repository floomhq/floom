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

import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError

from core.config import PROTECTED_STOCK_WORKER_IDS
from services.context_access import _context_visible_to_user, _is_system_context_pack
from services.worker_access import _normalize_trigger_type, _raise_if_protected_worker_mutation
from services.worker_serialize import _should_ignore_worker_file

logger = logging.getLogger("floom.api")

_SENSITIVE_FILE_NAMES = frozenset({".env", ".env.local", ".env.production", ".env.development"})
_SENSITIVE_FILE_SUFFIXES = frozenset({".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".p8", ".der", ".ppk"})

class DraftFile(BaseModel):
    """A single file in a skill bundle returned by draft-from-prompt."""
    path: str      # e.g. "worker.yml", "run.py", "SKILL.md", "lib/granola_client.py"
    content: str   # UTF-8 text content


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
