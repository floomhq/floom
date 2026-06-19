"""Workspace operations: instructions/base-persona git commits, membership,
and the workspace-template export (zip build, share token, payload).

The active-workspace resolver, member projection + owner-membership guard, the
two workspace-markdown git-commit helpers, and the workspace-template export
subsystem (operator-worker filter, zip builder, share token/payload, safe zip
path). Backs the /workspace route group. Extracted verbatim from main.py.

Domain logic comes from the sibling services (context_access, worker_access,
worker_serialize, git_service); the contexts engine, db.now_iso/get_db, and the
git_ops module are imported lazily inside the functions (purged + re-imported by
fixtures). Never imports main.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import zipfile
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from fastapi import HTTPException, Request, Response

from auth.local_workspaces import DEFAULT_WORKSPACE_ID, requested_local_workspace_id
from core.config import (
    PROTECTED_STOCK_WORKER_IDS,
    PUBLIC_STOCK_WORKER_IDS,
    _is_cloud_deploy,
)
from services.context_access import _context_visible_to_user, _is_system_context_pack
from services.git_service import _ensure_git_workspace_ready, _git_ops_lock, _git_workspace
from services.worker_access import (
    _list_operator_workers,
    _worker_connection_slugs,
    _worker_required_secret_names,
)
from services.worker_serialize import _is_secret_bearing_export_path, _iter_worker_dir_files

if TYPE_CHECKING:
    from auth import AuthContext
    from db import Repositories

import logging

logger = logging.getLogger("floom.api")


def _member_out(row: Dict[str, Any]) -> "WorkspaceMemberOut":
    from models import WorkspaceMemberOut

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
    from db import get_db, now_iso

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


def _git_commit_workspace_md(
    *,
    message: str,
    author_name: str = "WorkerOS",
    author_email: str = "workeros@local",
) -> None:
    import git_ops as _git_ops

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
    import git_ops as _git_ops

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
    from contexts import current_contexts_root, ensure_contexts_dir, iter_context_files, load_context_metadata

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


def _active_workspace_id(request: Request) -> str:
    return requested_local_workspace_id(request) or DEFAULT_WORKSPACE_ID


# #1444: the per-workspace worker-call fan-out limit. The setting is stored in
# workspace_settings under "worker_call_fanout_limit"; the effective value is
# always clamped to [1, MAX_WORKER_CALLS_PER_RUN] so a workspace can only ever
# LOWER the limit below the hard ceiling, never raise it above it.
WORKER_CALL_FANOUT_SETTING_KEY = "worker_call_fanout_limit"


def resolve_workspace_fanout_limit(workspace_id: str) -> int:
    """Return the effective worker-call fan-out cap for a workspace.

    Defaults to the hard ceiling (run_token.MAX_WORKER_CALLS_PER_RUN) when the
    setting is unset, malformed, or the lookup fails. A configured value is
    clamped into [1, ceiling] so the workspace setting can only tighten, never
    loosen, the runaway/cost guard.
    """
    from run_token import MAX_WORKER_CALLS_PER_RUN

    ceiling = MAX_WORKER_CALLS_PER_RUN
    try:
        from db import get_db

        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ?",
                (workspace_id, WORKER_CALL_FANOUT_SETTING_KEY),
            ).fetchone()
    except Exception:
        return ceiling
    if not row:
        return ceiling
    try:
        value = int(str(row["value"]).strip())
    except (TypeError, ValueError):
        return ceiling
    if value < 1:
        return 1
    return min(value, ceiling)
