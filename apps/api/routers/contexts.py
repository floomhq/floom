"""Context (knowledge-pack / "brain") route group.

The full /contexts surface: list/create/get/delete packs, file CRUD (read/write/
delete/move), per-file and per-pack version history + restore/rollback, secret
scan, category/visibility/sensitive toggles, the sqlite viewer, and multi-file
upload. Extracted verbatim from main.py.

Domain logic lives in services.context_access (access-control, serialization,
git-commit, file write, quota); models are the /contexts response/request shapes;
db via Depends(get_repos). The `contexts` engine module, db.now_iso/derive_workspace_id,
and the git_ops module are imported lazily inside the handlers (purged + re-imported
by fixtures). The router is purged in lockstep with main by the test fixtures.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import (
    APIRouter,
    Body,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import FileResponse

from auth import AuthContext, get_auth_context
from core.config import _is_cloud_deploy, _user_scoped_local_mode
from db import Repositories, get_repos
from models import (
    ContextCategoryRequest,
    ContextCreateRequest,
    ContextDeleteResponse,
    ContextDetail,
    ContextFileItem,
    ContextFileMoveRequest,
    ContextSecretScanFile,
    ContextSecretScanResponse,
    ContextSensitiveRequest,
    ContextSummary,
    ContextTextWriteRequest,
    ContextUploadResponse,
    ContextVisibilityUpdate,
    SecretWarning,
    VersionSummary,
    _SqliteView,
)
from secret_scan import scan_bytes
from services.context_access import (
    _context_detail,
    _context_file_path_or_400,
    _context_git_path,
    _context_name_or_400,
    _context_summary,
    _context_upload_limit_bytes,
    _context_visible_to_user,
    _context_worker_counts,
    _ensure_brain_pack_row,
    _git_commit_context,
    _is_system_context_pack,
    _read_context_upload_bytes,
    _require_context_for_user,
    _require_readable_context_for_user,
    _safe_context_file_or_400,
    _workers_referencing_context,
    _write_context_file,
)
from services.git_service import _git_author, _git_workspace

contexts_router = APIRouter()


@contexts_router.get("/contexts/{name}/versions", response_model=List[VersionSummary])
def list_context_versions(
    name: str,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[VersionSummary]:
    """List git commit history for a brain pack (newest first)."""
    import git_ops as _git_ops

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


@contexts_router.get("/contexts/{name}/versions/{sha}")
def get_context_version(
    name: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return the file tree for a brain pack at a specific git commit."""
    import git_ops as _git_ops

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


@contexts_router.get("/contexts/{name}/files/{file_path:path}/versions", response_model=List[VersionSummary])
def list_context_file_versions(
    name: str,
    file_path: str,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[VersionSummary]:
    """List git commits that touched one brain-pack file (newest first)."""
    import git_ops as _git_ops

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


@contexts_router.get("/contexts/{name}/files/{file_path:path}/versions/{sha}")
def get_context_file_version(
    name: str,
    file_path: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return file content at a specific git commit for one brain-pack file."""
    from contexts import guess_mime_type, is_binary_file
    import git_ops as _git_ops

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


@contexts_router.post("/contexts/{name}/files/{file_path:path}/restore/{sha}", response_model=ContextFileItem)
def restore_context_file_version(
    name: str,
    file_path: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextFileItem:
    """Restore one brain-pack file to its state at a given git commit SHA."""
    from contexts import context_file_display_type, guess_mime_type, is_binary_file, safe_context_file_path
    from db import now_iso
    import git_ops as _git_ops

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


@contexts_router.post("/contexts/{name}/rollback/{sha}")
def rollback_context(
    name: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Restore a brain pack to its state at a given git commit SHA."""
    from contexts import set_context_metadata
    import git_ops as _git_ops

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


@contexts_router.get("/contexts", response_model=List[ContextSummary])
def list_contexts(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[ContextSummary]:
    from contexts import current_contexts_root, ensure_contexts_dir, load_context_metadata

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


@contexts_router.post("/contexts/{name}", response_model=ContextDetail)
def create_context(
    name: str,
    payload: Optional[ContextCreateRequest] = Body(default=None),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    from contexts import context_dir, load_context_metadata, set_context_metadata

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


@contexts_router.put("/contexts/{name}/category", response_model=ContextDetail)
def set_context_category(
    name: str,
    payload: ContextCategoryRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    """#780: set/clear a brain pack's content-category tag (marketing,
    accounting, research, data, ...). Empty/null clears it."""
    from contexts import set_context_metadata

    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    set_context_metadata(safe_name, category=(payload.category or ""))
    return _context_detail(safe_name, repos=repos, user_id=auth.user_id)


@contexts_router.get("/contexts/{name}", response_model=ContextDetail)
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


@contexts_router.put("/contexts/{name}/visibility", response_model=ContextDetail)
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
    from contexts import context_owner_id
    from db import derive_workspace_id

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


@contexts_router.patch("/contexts/{name}/sensitive")
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
    from contexts import set_context_metadata

    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    set_context_metadata(safe_name, sensitive=body.sensitive)
    return {"name": safe_name, "sensitive": body.sensitive}


@contexts_router.delete("/contexts/{name}", response_model=ContextDeleteResponse)
def delete_context(
    name: str,
    force: bool = Query(False),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDeleteResponse:
    from contexts import context_dir, delete_context_metadata

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


@contexts_router.get("/contexts/{name}/files/{file_path:path}")
def get_context_file(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
):
    from contexts import guess_mime_type, is_active_markup, is_binary_file

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


@contexts_router.put("/contexts/{name}/files/{file_path:path}", response_model=ContextFileItem)
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


@contexts_router.delete("/contexts/{name}/files/{file_path:path}", response_model=ContextDetail)
def delete_context_file(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ContextDetail:
    from contexts import context_dir, set_context_file_metadata

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


@contexts_router.get("/contexts/{name}/sqlite/{file_path:path}", response_model=_SqliteView)
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


@contexts_router.post("/contexts/{name}/files/{file_path:path}/move", response_model=ContextFileItem)
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
    from contexts import context_dir, context_file_metadata, load_context_metadata, set_context_file_metadata

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


@contexts_router.post("/contexts/{name}/upload", response_model=ContextUploadResponse)
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
    from contexts import context_dir, context_total_size, set_context_metadata

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


@contexts_router.get("/contexts/{name}/secret-scan", response_model=ContextSecretScanResponse)
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
    from contexts import context_dir, guess_mime_type, is_binary_file, iter_context_files, set_context_file_secret_flag

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
