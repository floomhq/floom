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

import collections
import logging
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from fastapi import HTTPException, UploadFile
from pydantic import BaseModel

from core.config import (
    DEFAULT_CONTEXT_UPLOAD_LIMIT_BYTES,
    SYSTEM_CONTEXT_DESCRIPTIONS,
    SYSTEM_CONTEXT_PACKS,
    _is_cloud_deploy,
)
from secret_scan import scan_bytes

if TYPE_CHECKING:
    from db import Repositories

logger = logging.getLogger("floom.api")


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
    from models import SecretWarning

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
    from contexts import context_dir, iter_context_files

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


def _context_actor_user_id(user_id: str) -> str:
    """#957: map a request identity to the user id that actually owns the
    operator's context packs. On a legacy/default workspace the materialized
    pack dirs may be owned by a bootstrap id, so visibility/ownership checks must
    resolve against that effective id rather than the raw request id."""
    from contexts import effective_context_user_id

    return effective_context_user_id(user_id)


def _context_visible_to_user(
    name: str,
    *,
    user_id: str,
    metadata: dict[str, dict[str, Any]] | None = None,
    repos: Optional[Repositories] = None,
) -> bool:
    from contexts import context_owner_id, load_context_metadata, validate_context_name
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
    if repos is None or not owner_id:
        return None
    asset_access = getattr(repos, "asset_access", None)
    ensure = getattr(asset_access, "ensure_brain_pack", None)
    if ensure is None:
        return None
    try:
        return ensure(
            pack_id=name,
            workspace_id=_asset_workspace_id(owner_id),
            owner_id=owner_id,
            name=name,
        )
    except Exception:
        logger.debug("ensure brain_pack row failed for %s", name, exc_info=True)
        return None


def _asset_workspace_id(owner_id: str | None) -> str:
    """Workspace id for asset access rows.

    Cloud registers an active workspace resolver; local SQLite derives the
    workspace from its scoped owner id. Prefer the cloud resolver when present.
    """
    from db import derive_workspace_id

    try:
        import git_ops as _git_ops

        active = (_git_ops.get_active_workspace_id() or "").strip()
        if active:
            return active
    except Exception:
        pass
    return derive_workspace_id(owner_id)


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
    from models import AssetPermissions
    meta = metadata if metadata is not None else load_context_metadata()
    actor_user_id = _context_actor_user_id(user_id)
    owner_id = context_owner_id(name, meta)
    asset_access = getattr(repos, "asset_access", None) if repos is not None else None
    if asset_access is not None and owner_id:
        _ensure_brain_pack_row(name, owner_id=owner_id, repos=repos)
        try:
            perms = asset_access.get_permissions(
                workspace_id=_asset_workspace_id(owner_id),
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
    from contexts import context_dir, context_owner_id, context_tree_summary
    from models import AssetPermissions, ContextSummary
    root = context_dir(name)
    cached_summary = (metadata.get(name) or {}).get("summary")
    summary = cached_summary if isinstance(cached_summary, dict) else context_tree_summary(root)
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
        file_count=int(summary.get("file_count") or 0),
        total_size_bytes=int(summary.get("total_size_bytes") or 0),
        updated_at=summary.get("updated_at") or None,
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


def _ensure_assistant_row(
    *,
    user_id: str,
    repos,
) -> Optional[dict[str, Any]]:
    """Lazily upsert + return the workspace assistant's access mirror row.

    The assistant is one shared tool per workspace (default ``workspace``). The
    owner is the workspace owner; on the OSS single-owner engine that is the local
    user. Never raises.
    """
    from db import assistant_row_id

    if repos is None or not user_id:
        return None
    asset_access = getattr(repos, "asset_access", None)
    ensure = getattr(asset_access, "ensure_assistant", None)
    if ensure is None:
        return None
    workspace_id = _asset_workspace_id(user_id)
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
    repos,
) -> "tuple[Optional[str], str, Any]":
    """Resolve (owner_id, visibility, permissions) for the workspace assistant.

    Delegates to the AssetAccessRepository. Falls back to owner-permissive
    workspace defaults when no repo/row is available (OSS single-owner: the local
    user owns + can share the assistant). Never raises.
    """
    from db import assistant_row_id
    from models import AssetPermissions

    asset_access = getattr(repos, "asset_access", None) if repos is not None else None
    workspace_id = _asset_workspace_id(user_id)
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


def _context_upload_limit_bytes() -> int:
    try:
        configured = int(os.environ.get("WORKEROS_CONTEXT_UPLOAD_MAX_BYTES", ""))
    except ValueError:
        configured = 0
    return configured if configured > 0 else DEFAULT_CONTEXT_UPLOAD_LIMIT_BYTES


def _contexts_git_prefix() -> str:
    """Relative path of the contexts dir within the workspace git root.

    OSS: git root is WORKERS_DIR.parent, contexts at 'contexts/'.
    Cloud: contexts live under CONTEXTS_DIR/workspace_id which may be outside the
    workers-scoped git root. If so, fall back to 'contexts' and note that contexts
    versioning in cloud requires a unified workspace dir (v2 cloud work).
    """
    import git_ops as _git_ops
    from services.git_service import _git_workspace
    from contexts import CONTEXTS_DIR

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
    from services.worker_registry_ops import _git_join
    from services.git_service import _git_workspace
    from contexts import context_dir

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
    import git_ops as _git_ops
    from services.git_service import _ensure_git_workspace_ready, _git_ops_lock, _git_workspace
    from contexts import is_context_sensitive

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


def _increment_file_ref_counts(file_ids: List[str]) -> None:
    """Increment file ref_counts in one short transaction tolerant of run bursts.

    Uses ``get_db()`` so the DB path is resolved dynamically from the configured
    ``WORKEROS_DB``/``FLOOM_DB`` env (the canonical resolution every other read
    path uses), instead of the module-import-time ``DB_PATH`` global. The stale
    global could diverge from the live path (deploy-dir swaps / test suites that
    re-pin the DB), silently writing ref_count updates to the wrong database.
    """
    from db import get_db

    if not file_ids:
        return
    counts = collections.Counter(file_ids)
    with get_db() as conn:
        for file_id, count in counts.items():
            conn.execute(
                "UPDATE files SET ref_count = ref_count + ? WHERE id = ?",
                (count, file_id),
            )


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
    from contexts import context_dir, load_context_metadata

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
    from contexts import context_dir, context_file_metadata, context_mount_names, iter_context_files, load_context_metadata
    from models import ContextDetail, ContextFileItem, ContextWorkerRef

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
    from contexts import context_dir, context_total_size, MAX_CONTEXT_BYTES

    total = context_total_size(context_dir(name))
    if total > MAX_CONTEXT_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Context exceeds 50MB total size limit ({total} bytes)",
        )


def _write_context_file(
    name: str,
    file_path: str,
    data: bytes,
    *,
    user_id: str,
    tags: List[str] | None = None,
    file_metadata: Dict[str, Any] | None = None,
    refresh_summary: bool = True,
) -> ContextFileItem:
    from contexts import context_dir, context_file_metadata, load_context_metadata, refresh_context_summary_metadata, set_context_file_metadata, set_context_file_secret_flag, set_context_metadata
    from models import ContextFileItem

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
    if refresh_summary:
        refresh_context_summary_metadata(name)
    pack_meta = load_context_metadata().get(name) or pack_meta
    item = ContextFileItem(**context_file_metadata(root, destination, pack_metadata=pack_meta))
    item.secret_warnings = secret_warnings
    item.has_secret_warning = bool(secret_warnings)
    return item


def _format_limit_mb(size_bytes: int) -> str:
    mb = size_bytes / (1024 * 1024)
    return f"{mb:.0f} MB" if mb.is_integer() else f"{mb:.1f} MB"


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
                detail=f"Brain upload is too large. Upload files up to {_format_limit_mb(_context_upload_limit_bytes())}.",
            )
    return bytes(data)
