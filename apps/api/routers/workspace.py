"""Workspace route group: instructions + base-persona docs, members, settings,
template export/import, share link, and changelog.

The /workspace surface: get/put workspace instructions (+versions/rollback), the
base-persona doc (+state/versions/rollback/reset), workspace members CRUD +
owner transfer, settings get/put, the template export (zip + share link) and
import, and the changelog. Extracted verbatim from main.py.

Domain logic lives in services (workspace_ops, context_access, worker_access,
git_service, worker_registry_ops, worker_codegen); models are the request/response
shapes; db via Depends(get_repos). The contexts engine, db.get_db/now_iso, and the
git_ops module are imported lazily inside the handlers. list_contexts is reused
from routers.contexts (the changelog lists packs). Purged in lockstep with main.
"""

from __future__ import annotations

import collections
import hmac
import io
import json
import re
import urllib.parse
import zipfile
from typing import Any, Dict, List, Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

import logging

from auth import AuthContext, get_auth_context
from auth.guards import _require_admin, _require_workspace_write
from core.config import (
    WORKSPACE_IMPORT_BODY_LIMIT_BYTES,
    _MAX_IMPORT_ENTRIES,
    _MAX_IMPORT_UNCOMPRESSED_BYTES,
)
from core.urls import _public_api_base_url
from db import Repositories, get_repos
from models import (
    DraftFile,
    ChangelogEntry,
    VersionSummary,
    WorkspaceImportResponse,
    WorkspaceMemberInviteRequest,
    WorkspaceMemberOut,
    WorkspaceMemberRoleUpdate,
    WorkspaceMembersResponse,
    WorkspaceShareLinkResponse,
    WorkspaceTransferOwnerRequest,
    _WorkspaceSettingValue,
)
from routers.contexts import list_contexts
from services.context_access import _contexts_git_prefix, _write_context_file
from services.git_service import _git_author, _git_workspace, _workers_git_prefix
from services.worker_access import (
    _active_local_workspace_id,
    _list_visible_workers,
    _require_members_repo,
)
from services.worker_codegen import _enforce_draft_rate_limit
from services.worker_registry_ops import _register_worker_from_files
from services.workspace_ops import (
    _active_workspace_id,
    _build_workspace_template_zip,
    _ensure_owner_membership,
    _git_commit_workspace_base_md,
    _git_commit_workspace_md,
    _member_out,
    _safe_zip_rel,
    _workspace_share_token,
    _workspace_template_response,
)

_WORKSPACE_INSTRUCTIONS_ASSET_TYPE = "workspace_instructions"
_WORKSPACE_BASE_PERSONA_ASSET_TYPE = "workspace_base_persona"

logger = logging.getLogger("floom.api")

workspace_router = APIRouter()


@workspace_router.get("/workspace/members", response_model=WorkspaceMembersResponse)
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


@workspace_router.post("/workspace/members", response_model=WorkspaceMemberOut, status_code=201)
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


@workspace_router.patch("/workspace/members/{user_id}", response_model=WorkspaceMemberOut)
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


@workspace_router.delete("/workspace/members/{user_id}", status_code=204)
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


@workspace_router.post("/workspace/members/transfer-owner", response_model=WorkspaceMemberOut)
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


@workspace_router.get("/workspace/export")
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
    # #925: a full-workspace download is an admin capability — a compromised
    # member session must not be able to exfiltrate the whole workspace.
    _require_admin(auth)
    # #925/#948: every export is audit-logged with the actor — the structured
    # log (journalctl) AND a persistent, queryable audit row so a compromised-
    # admin exfiltration is reviewable after the fact.
    logger.info("workspace export by user=%s role=%s", auth.user_id, auth.role)
    try:
        import uuid as _uuid_mod
        from db import get_db, now_iso
        with get_db() as _conn:
            _conn.execute(
                "INSERT INTO workspace_export_audit (id, user_id, role, exported_at) "
                "VALUES (?, ?, ?, ?)",
                (f"export_{_uuid_mod.uuid4().hex[:12]}", auth.user_id, auth.role, now_iso()),
            )
    except Exception:
        logger.warning("workspace export audit row insert failed", exc_info=True)
    payload = _build_workspace_template_zip(
        user_id=auth.user_id, repos=repos, exported_at=exported_at
    )
    return _workspace_template_response(payload)


@workspace_router.get("/workspace/export/audit")
def list_workspace_export_audit(
    limit: int = Query(50, ge=1, le=500),
    auth: AuthContext = Depends(get_auth_context),
) -> List[Dict[str, Any]]:
    """#925: admin-only review of the workspace-export audit trail."""
    from db import get_db
    _require_admin(auth)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, user_id, role, exported_at FROM workspace_export_audit "
            "ORDER BY exported_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


@workspace_router.get("/workspace/share-link", response_model=WorkspaceShareLinkResponse)
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


@workspace_router.get("/workspace/template/{token}")
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


@workspace_router.post("/workspace/import", response_model=WorkspaceImportResponse)
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
    from contexts import context_dir, load_context_metadata, set_context_metadata, validate_context_name

    if request is not None:
        _enforce_draft_rate_limit(request)

    raw_bytes = await bundle.read()
    if len(raw_bytes) > WORKSPACE_IMPORT_BODY_LIMIT_BYTES:
        raise HTTPException(status_code=413, detail="Workspace template too large")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail=f"Not a valid zip file: {exc}")

    # #931: zip-bomb guards, mirroring POST /workers/from-bundle. The 50 MB
    # compressed cap alone let a highly-compressed archive expand to gigabytes
    # in memory. Enforce entry count + declared uncompressed size up front,
    # then re-guard the running total during extraction (lying headers).
    infolist = zf.infolist()
    if len(infolist) > _MAX_IMPORT_ENTRIES:
        raise HTTPException(
            status_code=413,
            detail=f"Template has too many entries ({len(infolist)} > {_MAX_IMPORT_ENTRIES})",
        )
    declared_total = 0
    for info in infolist:
        # Reject symlink members (security).
        file_type = (info.external_attr >> 16) & 0o170000
        if file_type == 0o120000:
            raise HTTPException(
                status_code=400,
                detail=f"Template contains unsupported symlink: {info.filename!r}",
            )
        declared_total += info.file_size
        if declared_total > _MAX_IMPORT_UNCOMPRESSED_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Template too large: uncompressed size exceeds "
                    f"{_MAX_IMPORT_UNCOMPRESSED_BYTES // (1024 * 1024)} MB"
                ),
            )
    extracted_total = 0

    def _read_member_guarded(member_name: str) -> bytes:
        nonlocal extracted_total
        data = zf.read(member_name)
        extracted_total += len(data)
        if extracted_total > _MAX_IMPORT_UNCOMPRESSED_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Template too large: uncompressed size exceeds "
                    f"{_MAX_IMPORT_UNCOMPRESSED_BYTES // (1024 * 1024)} MB"
                ),
            )
        return data

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
                content = _read_member_guarded(name).decode("utf-8")
            except UnicodeDecodeError:
                raise HTTPException(
                    status_code=400,
                    detail=f"Worker file {rel!r} is not valid UTF-8 text",
                )
            worker_files.setdefault(wid, []).append(DraftFile(path=inner, content=content))
        elif parts[0] == "contexts" and len(parts) >= 3:
            cname = parts[1]
            inner = "/".join(parts[2:])
            context_files.setdefault(cname, []).append((inner, _read_member_guarded(name)))
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


@workspace_router.get("/workspace")
async def get_workspace(auth: AuthContext = Depends(get_auth_context)) -> PlainTextResponse:
    """Return the current workspace.md content."""
    from chat_service import get_workspace_md
    return PlainTextResponse(get_workspace_md(), media_type="text/markdown")


@workspace_router.get("/workspace/base")
async def get_workspace_base_persona(auth: AuthContext = Depends(get_auth_context)) -> PlainTextResponse:
    """Return the resolved editable base persona.

    If no override has been saved, this returns the built-in Emily base persona.
    Workspace custom instructions remain on /workspace.
    """
    from chat_service import get_workspace_base_persona

    return PlainTextResponse(get_workspace_base_persona(), media_type="text/markdown")


@workspace_router.get("/workspace/base/state")
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


@workspace_router.delete("/workspace/base", status_code=204)
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


@workspace_router.get("/workspace/base/versions", response_model=List[VersionSummary])
def list_workspace_base_persona_versions(
    request: Request,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[VersionSummary]:
    """List git commit history for workspace.base.md (newest first)."""
    import git_ops as _git_ops

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


@workspace_router.get("/workspace/base/versions/{sha}")
def get_workspace_base_persona_version(
    sha: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return workspace.base.md content at a specific git commit."""
    import git_ops as _git_ops

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


@workspace_router.post("/workspace/base/rollback/{sha}")
async def rollback_workspace_base_persona(
    sha: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> PlainTextResponse:
    """Restore workspace.base.md to its state at a given git commit SHA."""
    import git_ops as _git_ops

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


@workspace_router.put("/workspace/base", status_code=204)
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


@workspace_router.get("/workspace/versions", response_model=List[VersionSummary])
def list_workspace_versions(
    request: Request,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[VersionSummary]:
    """List git commit history for workspace.md (newest first)."""
    import git_ops as _git_ops

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


@workspace_router.get("/workspace/changelog", response_model=List[ChangelogEntry])
def workspace_changelog(
    limit: int = 50,
    asset_types: str = "worker,context,workspace_instructions",
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[ChangelogEntry]:
    """#772: unified workspace changelog — merges the git history of all
    workers, brain packs, and the workspace prompt into one timeline (newest
    first). Each asset's log is bounded and the merged result is capped."""
    import git_ops as _git_ops

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


@workspace_router.get("/workspace/versions/{sha}")
def get_workspace_version(
    sha: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return workspace.md content at a specific git commit."""
    import git_ops as _git_ops

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


@workspace_router.post("/workspace/rollback/{sha}")
async def rollback_workspace_instructions(
    sha: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> PlainTextResponse:
    """Restore workspace.md to its state at a given git commit SHA."""
    import git_ops as _git_ops

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


@workspace_router.put("/workspace", status_code=204)
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
# Workspace API tokens — admin-minted; authenticate as the synthetic workspace
# actor (member role): read+run on workspace-shared workers ONLY, no private
# workers (including the minter's own), no mutations (middleware-gated).
# ---------------------------------------------------------------------------

class _WorkspaceTokenOut(BaseModel):
    id: str
    name: str
    created_by: str
    created_at: str
    last_used_at: Optional[str] = None
    expires_at: Optional[str] = None
    revoked_at: Optional[str] = None


class _WorkspaceTokenCreateRequest(BaseModel):
    name: str
    expires_at: Optional[str] = None


class _WorkspaceTokenCreateResponse(BaseModel):
    id: str
    name: str
    token: str  # shown ONCE; only the hash is stored
    expires_at: Optional[str] = None


def _require_workspace_admin(auth: AuthContext) -> None:
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="workspace tokens are admin-only")


@workspace_router.get("/workspace/tokens", response_model=List[_WorkspaceTokenOut])
def list_workspace_tokens(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> List[_WorkspaceTokenOut]:
    from db import get_db

    _require_workspace_admin(auth)
    workspace_id = _active_workspace_id(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, created_by, created_at, last_used_at, expires_at, revoked_at "
            "FROM workspace_api_tokens WHERE workspace_id = ? ORDER BY created_at DESC",
            (workspace_id,),
        ).fetchall()
    return [_WorkspaceTokenOut(**dict(r)) for r in rows]


@workspace_router.post("/workspace/tokens", response_model=_WorkspaceTokenCreateResponse, status_code=201)
def create_workspace_token(
    payload: _WorkspaceTokenCreateRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> _WorkspaceTokenCreateResponse:
    import secrets as _secrets_mod
    import uuid as _uuid_mod
    from db import get_db, now_iso
    from auth.multi_member import _hash_token as _hash_pat
    from services.auth_ops import _enforce_token_ttl_cap

    _require_workspace_admin(auth)
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="token name required")
    expires_at = _enforce_token_ttl_cap(payload.expires_at)
    workspace_id = _active_workspace_id(request)
    raw = "wst_" + _secrets_mod.token_urlsafe(32)
    token_id = str(_uuid_mod.uuid4())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO workspace_api_tokens "
            "(id, workspace_id, name, token_hash, created_by, created_at, expires_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (token_id, workspace_id, name, _hash_pat(raw), auth.user_id, now_iso(), expires_at),
        )
    logger.info(
        "workspace token created: workspace=%s name=%r by=%s expires_at=%s",
        workspace_id, name, auth.user_id, expires_at,
    )
    return _WorkspaceTokenCreateResponse(id=token_id, name=name, token=raw, expires_at=expires_at)


@workspace_router.delete("/workspace/tokens/{token_id}", status_code=204, response_class=Response)
def revoke_workspace_token(
    token_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> Response:
    from db import get_db, now_iso

    _require_workspace_admin(auth)
    workspace_id = _active_workspace_id(request)
    with get_db() as conn:
        updated = conn.execute(
            "UPDATE workspace_api_tokens SET revoked_at = ? "
            "WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL",
            (now_iso(), token_id, workspace_id),
        ).rowcount
    if not updated:
        raise HTTPException(status_code=404, detail="token not found")
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Workspace secrets — admin-set credential rows stored under the synthetic
# workspace actor; workspace-shared (donated) workers resolve against these.
# ---------------------------------------------------------------------------

@workspace_router.get("/workspace/secrets")
def list_workspace_secrets(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[Dict[str, Any]]:
    _require_workspace_admin(auth)
    workspace_id = _active_workspace_id(request)
    list_ws = getattr(repos.secrets, "list_workspace_secrets", None)
    if list_ws is not None:
        rows = list_ws(workspace_id=workspace_id)
    else:
        # Legacy fallback for repos without the workspace-scoped method.
        from db.sqlite import workspace_actor_id

        rows = repos.secrets.list(user_id=workspace_actor_id(workspace_id))
    # names + status only, never values
    return [{"name": r.get("name"), "status": r.get("status"), "updated_at": r.get("updated_at")} for r in rows]


class _WorkspaceSecretWrite(BaseModel):
    value: str


@workspace_router.post("/workspace/secrets/{name}", status_code=200)
def set_workspace_secret(
    name: str,
    payload: _WorkspaceSecretWrite,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    _require_workspace_admin(auth)
    workspace_id = _active_workspace_id(request)
    # #1071 — route through the repo-agnostic seam with the REAL authenticated
    # actor + workspace_id instead of importing the SQLite-specific
    # workspace_actor_id. Under the cloud Supabase repo, user_id must be a real
    # auth.users UUID, so passing a synthetic SQLite actor id 500'd.
    set_ws = getattr(repos.secrets, "set_workspace_secret", None)
    if set_ws is not None:
        set_ws(
            workspace_id=workspace_id,
            actor_id=auth.user_id,
            name=name,
            value=payload.value,
        )
    else:
        from db.sqlite import workspace_actor_id

        repos.secrets.set(
            user_id=workspace_actor_id(workspace_id), name=name, value=payload.value
        )
    logger.info("workspace secret %r set by %s (value not logged)", name, auth.user_id)
    return {"ok": True, "name": name}


@workspace_router.delete("/workspace/secrets/{name}", status_code=204, response_class=Response)
def delete_workspace_secret(
    name: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    _require_workspace_admin(auth)
    workspace_id = _active_workspace_id(request)
    delete_ws = getattr(repos.secrets, "delete_workspace_secret", None)
    if delete_ws is not None:
        delete_ws(workspace_id=workspace_id, name=name)
        return Response(status_code=204)
    from db.sqlite import workspace_actor_id

    delete = getattr(repos.secrets, "delete", None)
    if delete is None:
        raise HTTPException(status_code=501, detail="secret delete not available")
    delete(user_id=workspace_actor_id(workspace_id), name=name)
    return Response(status_code=204)


@workspace_router.get("/workspace/settings")
def get_workspace_settings(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, str]:
    """#794/#797: workspace behaviour toggles + model defaults (key→value map).

    Also surfaces the read-only `current_month_spend_usd` (#797) so the Settings
    System tab can render spend-against-cap without a separate fetch.
    """
    from db import get_db

    ws = _active_workspace_id(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT key, value FROM workspace_settings WHERE workspace_id = ?", (ws,)
        ).fetchall()
    out = {str(r["key"]): str(r["value"]) for r in rows}
    try:
        from run_service import _workspace_month_to_date_cost_usd

        out["current_month_spend_usd"] = f"{_workspace_month_to_date_cost_usd():.4f}"
    except Exception:
        pass
    return out


@workspace_router.put("/workspace/settings/{key}", status_code=204, response_class=Response)
def put_workspace_setting(
    key: str,
    body: _WorkspaceSettingValue,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> Response:
    """#794/#797: upsert a workspace setting. Admin-guarded (the #804 model:
    members must not change workspace behaviour, enforced server-side)."""
    from db import get_db, now_iso

    _require_workspace_write(auth)
    value = _validate_workspace_setting(key, body.value)
    ws = _active_workspace_id(request)
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO workspace_settings (workspace_id, key, value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (ws, key, value, now_iso()),
        )
    return Response(status_code=204)


_WORKSPACE_SETTING_BOOL_KEYS = {
    "auto_pause",
    "auto_pause_enabled",
    "failure_email_enabled",
}
_WORKSPACE_SETTING_ALLOWED_KEYS = _WORKSPACE_SETTING_BOOL_KEYS | {
    "approval_default",
    "failure_email_to",
    "monthly_spend_cap_usd",
    "default_model",
    "default_timeout_seconds",
    "max_output_tokens",
    "region",
    "timezone",
    "company_domain",
    "worker_call_fanout_limit",  # #1444: per-workspace fan-out cap (<= hard ceiling)
}
_WORKSPACE_SETTING_READ_ONLY_KEYS = {"current_month_spend_usd"}
_BOOL_SETTING_VALUES = {"true", "false", "1", "0", "yes", "no", "on", "off"}
_EMAIL_RE = re.compile(r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$")
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_REGION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}$"
)


def _setting_error(message: str) -> None:
    raise HTTPException(status_code=422, detail=message)


def _validate_workspace_setting(key: str, value: str) -> str:
    if not key or len(key) > 64:
        _setting_error("invalid setting key")
    if key in _WORKSPACE_SETTING_READ_ONLY_KEYS:
        _setting_error(f"workspace setting {key!r} is read-only")
    if key not in _WORKSPACE_SETTING_ALLOWED_KEYS:
        _setting_error(f"unknown workspace setting {key!r}")

    raw = str(value or "").strip()
    lowered = raw.lower()

    if key in _WORKSPACE_SETTING_BOOL_KEYS:
        if lowered not in _BOOL_SETTING_VALUES:
            _setting_error(f"workspace setting {key!r} must be a boolean string")
        return raw

    if key == "approval_default":
        if lowered not in {"always", "required", "never", "off"}:
            _setting_error("approval_default must be one of always, required, never, off")
        return raw

    if key == "failure_email_to":
        if not raw:
            return raw
        emails = [part.strip() for part in raw.split(",")]
        if any(not part or not _EMAIL_RE.fullmatch(part) for part in emails):
            _setting_error("failure_email_to must be a comma-separated email list")
        return raw

    if key == "monthly_spend_cap_usd":
        try:
            amount = float(raw)
        except ValueError:
            _setting_error("monthly_spend_cap_usd must be a non-negative number")
        if amount < 0 or amount > 1_000_000:
            _setting_error("monthly_spend_cap_usd must be between 0 and 1000000")
        return raw

    if key in {"default_timeout_seconds", "max_output_tokens"}:
        try:
            parsed = int(raw)
        except ValueError:
            _setting_error(f"{key} must be an integer")
        upper = 86_400 if key == "default_timeout_seconds" else 1_000_000
        if parsed < 1 or parsed > upper:
            _setting_error(f"{key} must be between 1 and {upper}")
        return raw

    if key == "worker_call_fanout_limit":
        # #1444: a workspace may LOWER its worker-call fan-out cap below the hard
        # ceiling, never raise it above. Reject out-of-range rather than silently
        # clamping, so the UI surfaces the real bound.
        from run_token import MAX_WORKER_CALLS_PER_RUN

        try:
            parsed = int(raw)
        except ValueError:
            _setting_error("worker_call_fanout_limit must be an integer")
        if parsed < 1 or parsed > MAX_WORKER_CALLS_PER_RUN:
            _setting_error(
                f"worker_call_fanout_limit must be between 1 and {MAX_WORKER_CALLS_PER_RUN}"
            )
        return str(parsed)

    if key == "default_model":
        if not raw:
            return raw
        if not _MODEL_ID_RE.fullmatch(raw) or "://" in raw or ".." in raw:
            _setting_error("default_model must be a safe model id")
        return raw

    if key == "region":
        if raw and not _REGION_RE.fullmatch(raw):
            _setting_error("region must be a safe region id")
        return raw

    if key == "timezone":
        if not raw:
            return raw
        try:
            from zoneinfo import ZoneInfo

            ZoneInfo(raw)
        except Exception:
            _setting_error("timezone must be a valid IANA timezone")
        return raw

    if key == "company_domain":
        if raw and not _DOMAIN_RE.fullmatch(raw):
            _setting_error("company_domain must be a valid domain")
        return raw

    _setting_error(f"unknown workspace setting {key!r}")
