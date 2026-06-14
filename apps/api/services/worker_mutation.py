"""Worker mutation helpers: workspace-write guard, enable/archive/star toggles,
worker.yml field patching, context attach/detach, reload.

Small shared helpers behind the worker lifecycle routes (visibility, pause/
resume, archive/restore, star, contexts, files, delete, reload). Extracted from
main.py.

services deps (worker_access, worker_serialize, worker_registry_ops, context_access)
are module-level; db/worker_registry/models/auth.local_workspaces are lazy inside
functions (purged). core.config is reload-safe. Never imports main.
"""

from __future__ import annotations

import logging
import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Request

from core.config import _is_cloud_deploy
from services.worker_access import (
    _canonical_worker_id,
    _get_visible_worker,
    _raise_if_protected_worker_mutation,
)
from services.worker_serialize import _build_worker_detail

logger = logging.getLogger("floom.api")

def _require_worker_write_workspace_context(request: Request) -> None:
    from auth.local_workspaces import requested_local_workspace_id
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
    from models import WorkerDetail
    from worker_registry import invalidate_worker_cache
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


def _patch_worker_yml_field(worker_id: str, field: str, value: Any) -> None:
    """Write a single field into worker.yml on disk without disturbing other fields."""
    from worker_registry import WORKERS_DIR
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


def _raw_worker_id_from_worker_yml(worker_yml: str) -> str:
    import yaml as pyyaml

    try:
        raw = pyyaml.safe_load(worker_yml)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="worker_yml must contain a YAML mapping")
    return str(raw.get("id") or raw.get("name") or "").strip()


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


def _toggle_worker_star(user_id: str, worker_id: str) -> bool:
    """#782: flip the star for (user, worker); returns the new state."""
    from db import get_db, now_iso
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


def _reload_workers_for_user(user_id: str) -> ReloadResponse:
    from db import get_db
    from models import ReloadResponse
    from services.worker_registry_ops import _persist_discovered_workers
    from worker_registry import discover_workers, invalidate_worker_cache
    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        try:
            loaded, skipped = _persist_discovered_workers(conn, workers, user_id=user_id)
        except RuntimeError as exc:
            # A systemic failure (e.g. the whole transaction is broken). Per-worker
            # failures are isolated inside _persist_discovered_workers and never
            # reach here — they are skipped + logged.
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    if skipped:
        logger.warning(
            "Worker reload for %s: %d loaded, %d skipped (unloadable)",
            user_id, loaded, skipped,
        )
    return ReloadResponse(status="success", workers_loaded=loaded)


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
    from models import WorkerDetail
    from worker_registry import WORKERS_DIR, invalidate_worker_cache
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
