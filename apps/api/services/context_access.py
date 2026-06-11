"""Context (knowledge-pack) access-control and serialization helpers.

Extracted from main.py as a cohesive cluster (AST-verified closed). These helpers
resolve which contexts a request may see, validate context file paths, and build
the operator-facing context summaries. Consumed by the /contexts route group.

contexts, db and models names used at runtime are imported lazily inside each
function: the test suite pops and re-imports those modules (with a temp
CONTEXTS_DIR / DB) between cases, so binding them at module load would pin this
(non-purged) module to a stale directory/connection.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from fastapi import HTTPException

from core.config import (
    SYSTEM_CONTEXT_DESCRIPTIONS,
    SYSTEM_CONTEXT_PACKS,
    _is_cloud_deploy,
)

if TYPE_CHECKING:
    from db import Repositories

logger = logging.getLogger("floom.api")


def _system_context_description(name: str) -> Optional[str]:
    from contexts import validate_context_name
    try:
        safe_name = validate_context_name(name)
    except ValueError:
        return None
    return SYSTEM_CONTEXT_DESCRIPTIONS.get(safe_name)


def _context_name_or_400(name: str) -> str:
    from contexts import validate_context_name
    try:
        return validate_context_name(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _context_file_path_or_400(path: str) -> str:
    from contexts import normalize_context_file_path
    try:
        return normalize_context_file_path(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _safe_context_file_or_400(name: str, path: str) -> Path:
    from contexts import safe_context_file_path
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
    from contexts import load_context_metadata, validate_context_name
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
    from contexts import context_owner_id, load_context_metadata, validate_context_name
    safe_name = validate_context_name(name)
    meta = metadata if metadata is not None else load_context_metadata()
    # Engine/system packs are internal config, never operator-facing.
    if _is_system_context_pack(safe_name, meta):
        return False
    owner_id = context_owner_id(safe_name, meta)
    if owner_id:
        if owner_id == user_id:
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
    from contexts import context_dir, context_owner_id, load_context_metadata
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


def _context_worker_counts(repos: Optional[Repositories], user_id: str) -> dict[str, int]:
    """Map context-pack name -> number of workers that mount it.

    Computed from a single ``workers.list`` call so the LIST endpoint stays
    O(workers) instead of O(packs * workers). Mirrors the per-pack ``used_by``
    computation in ``_context_detail`` so list == detail.
    """
    from contexts import context_mount_names
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
    from db import derive_workspace_id
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
    from contexts import context_owner_id, load_context_metadata
    from db import derive_workspace_id
    from models import AssetPermissions
    meta = metadata if metadata is not None else load_context_metadata()
    owner_id = context_owner_id(name, meta)
    asset_access = getattr(repos, "asset_access", None) if repos is not None else None
    if asset_access is not None and owner_id:
        _ensure_brain_pack_row(name, owner_id=owner_id, repos=repos)
        try:
            perms = asset_access.get_permissions(
                workspace_id=derive_workspace_id(owner_id),
                user_id=user_id,
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
    is_owner = (not owner_id) or owner_id == user_id
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
    from contexts import context_owner_id, load_context_metadata
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


def _context_summary(
    name: str,
    metadata: dict[str, dict[str, Any]],
    *,
    worker_count: int = 0,
    repos: Optional[Repositories] = None,
    user_id: Optional[str] = None,
) -> "ContextSummary":
    from contexts import context_dir, context_owner_id, context_updated_at, iter_context_files
    from models import AssetPermissions
    # ContextSummary is a response model still defined in main (pydantic). Imported
    # lazily so this module resolves the live (test-reloaded) main, never a stale one.
    # TODO(open-source): move the /contexts response models into models.py.
    from main import ContextSummary
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


def _workers_referencing_context(name: str, *, user_id: str, repos: Repositories) -> List[str]:
    from contexts import context_mount_names
    referenced_by: List[str] = []
    for worker in repos.workers.list(user_id=user_id):
        try:
            contexts = (worker.get("config") or {}).get("contexts") or []
            if name in context_mount_names(contexts):
                referenced_by.append(str(worker["id"]))
        except Exception:
            continue
    return sorted(set(referenced_by))
