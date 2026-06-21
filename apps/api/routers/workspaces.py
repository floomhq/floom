"""Current-user + local OSS workspace routes.

``GET /me`` (the caller's identity/role for the web UI) and the ``/workspaces``
CRUD surface for local OSS multi-workspace mode (list/create/rename/select/
delete/duplicate). Extracted verbatim from main.py into an APIRouter.

Following the channels/* convention, ``auth.local_workspaces`` helpers are
imported lazily inside the handlers (the test suite purges ``auth.*`` and
re-imports it between cases). ``AuthContext``/``get_auth_context`` appear in
route signatures, so they are real module-level imports; the workspace test
fixtures purge ``routers.*`` alongside ``main``/``auth`` so this router
rebuilds with fresh deps.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import AuthContext, get_auth_context
from core.config import _is_cloud_deploy
from services.worker_access import _active_local_workspace_id

workspaces_router = APIRouter()

# #1745 — a bare UUID must NEVER surface as a human display_name (the Emily
# greeting interpolates /me.display_name directly, so "Good morning,
# 9b1a5065-..." leaked the raw user id). Emit a real label (email/username) only;
# otherwise None so the client resolves its own fallback ("there"/"Local user").
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def _human_display_name(*candidates: Optional[str], user_id: str) -> Optional[str]:
    for candidate in candidates:
        if (
            isinstance(candidate, str)
            and candidate.strip()
            and candidate != user_id
            and not _UUID_RE.match(candidate.strip())
        ):
            return candidate
    return None


class LocalWorkspaceCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


class LocalWorkspaceRenameRequest(BaseModel):
    # #791: name optional so region/timezone can be updated alone.
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    region: Optional[str] = None
    timezone: Optional[str] = None


class LocalWorkspaceOut(BaseModel):
    id: str
    name: str
    owner_user_id: str
    created_at: str
    region: Optional[str] = None  # #791
    timezone: Optional[str] = None  # #791


class LocalWorkspaceListResponse(BaseModel):
    workspaces: List[LocalWorkspaceOut]
    active_id: str


class CurrentUserResponse(BaseModel):
    user_id: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    workspace_id: Optional[str] = None
    scopes: List[str] = []
    role: str = "admin"
    username: Optional[str] = None


def _local_workspace_out(row: Dict[str, Any]) -> LocalWorkspaceOut:
    return LocalWorkspaceOut(
        id=str(row["id"]),
        name=str(row["name"]),
        owner_user_id=str(row["owner_user_id"]),
        created_at=str(row["created_at"]),
        region=(row.get("region") if isinstance(row, dict) else None) or None,  # #791
        timezone=(row.get("timezone") if isinstance(row, dict) else None) or None,  # #791
    )


def _require_local_workspace_mode() -> None:
    if _is_cloud_deploy():
        raise HTTPException(status_code=404, detail="not found")


@workspaces_router.get("/me", response_model=CurrentUserResponse)
def get_current_user(auth: AuthContext = Depends(get_auth_context)) -> CurrentUserResponse:
    return CurrentUserResponse(
        user_id=auth.user_id,
        email=auth.email,
        display_name=_human_display_name(auth.email, auth.username, user_id=auth.user_id),
        workspace_id=_active_local_workspace_id(auth) if not _is_cloud_deploy() else None,
        scopes=list(auth.scopes or ()),
        role=auth.role,
        username=auth.username,
    )


@workspaces_router.get("/workspaces", response_model=LocalWorkspaceListResponse)
def list_workspaces(auth: AuthContext = Depends(get_auth_context)) -> LocalWorkspaceListResponse:
    """List local OSS workspaces for the single-user dashboard."""
    from auth.local_workspaces import list_local_workspaces, local_workspace_base_user_id

    _require_local_workspace_mode()
    base_user_id = local_workspace_base_user_id(auth.user_id)
    rows = list_local_workspaces(base_user_id)
    return LocalWorkspaceListResponse(
        workspaces=[_local_workspace_out(row) for row in rows],
        active_id=_active_local_workspace_id(auth),
    )


@workspaces_router.post("/workspaces", response_model=LocalWorkspaceOut)
def create_workspace(
    payload: LocalWorkspaceCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> LocalWorkspaceOut:
    """Create a local OSS workspace.

    Selection is client-side for OSS: the web app stores the active workspace id
    and sends it as x-workeros-workspace on every proxied request.
    """
    from auth.local_workspaces import create_local_workspace, local_workspace_base_user_id

    _require_local_workspace_mode()
    base_user_id = local_workspace_base_user_id(auth.user_id)
    try:
        created = create_local_workspace(base_user_id, payload.name)
    except ValueError as exc:
        # #1738 — duplicate workspace name for this account.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _local_workspace_out(created)


@workspaces_router.patch("/workspaces/{workspace_id}", response_model=LocalWorkspaceOut)
def rename_workspace(
    workspace_id: str,
    payload: LocalWorkspaceRenameRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> LocalWorkspaceOut:
    """#791: update a local OSS workspace's name/region/timezone (owner-scoped)."""
    from auth.local_workspaces import local_workspace_base_user_id, update_local_workspace

    _require_local_workspace_mode()
    if payload.name is None and payload.region is None and payload.timezone is None:
        raise HTTPException(status_code=422, detail="nothing to update")
    base_user_id = local_workspace_base_user_id(auth.user_id)
    try:
        updated = update_local_workspace(
            base_user_id, workspace_id,
            name=payload.name, region=payload.region, timezone=payload.timezone,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    return _local_workspace_out(updated)


@workspaces_router.post("/workspaces/{workspace_id}/select", response_model=LocalWorkspaceOut)
def select_workspace(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> LocalWorkspaceOut:
    """Validate and echo a local OSS workspace selection."""
    from auth.local_workspaces import get_local_workspace, local_workspace_base_user_id

    _require_local_workspace_mode()
    base_user_id = local_workspace_base_user_id(auth.user_id)
    workspace = get_local_workspace(base_user_id, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    return _local_workspace_out(workspace)


@workspaces_router.delete("/workspaces/{workspace_id}")
def delete_workspace(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, bool]:
    """#805: delete a local OSS workspace (Settings > Danger).

    Owner-scoped (404 for another owner's / unknown workspace). The default
    workspace cannot be deleted (409) — there must always be one. On this
    single-tenant engine workers/knowledge live in a shared on-disk pool, so
    deleting a workspace removes only the workspace row + its selection, not
    the shared assets.
    """
    from auth.local_workspaces import (
        DEFAULT_WORKSPACE_ID,
        delete_local_workspace,
        get_local_workspace,
        local_workspace_base_user_id,
    )

    _require_local_workspace_mode()
    if workspace_id == DEFAULT_WORKSPACE_ID:
        raise HTTPException(status_code=409, detail="The default workspace cannot be deleted")
    base_user_id = local_workspace_base_user_id(auth.user_id)
    if get_local_workspace(base_user_id, workspace_id) is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    delete_local_workspace(base_user_id, workspace_id)
    return {"deleted": True}


def _duplicate_workspace_name(name: str) -> str:
    """``"Acme"`` -> ``"Acme (copy)"`` (clamped to the 80-char name limit)."""
    base = (name or "").strip() or "Untitled"
    suffix = " (copy)"
    if len(base) + len(suffix) > 80:
        base = base[: 80 - len(suffix)].rstrip()
    return f"{base}{suffix}"


@workspaces_router.post("/workspaces/{workspace_id}/duplicate", response_model=LocalWorkspaceOut)
def duplicate_workspace(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> LocalWorkspaceOut:
    """Duplicate a local OSS workspace into a new ``"<name> (copy)"`` sibling.

    Owner-scoped: the source workspace must belong to the caller's local base
    user, otherwise 404. On this single-tenant OSS instance, workers and
    knowledge packs live in a shared on-disk pool (not per-workspace storage),
    so duplication mints a new workspace row that surfaces the same worker pool.
    Use Export → Import (the template round-trip) to move workers between
    instances.
    """
    from auth.local_workspaces import (
        create_local_workspace,
        get_local_workspace,
        local_workspace_base_user_id,
    )

    _require_local_workspace_mode()
    base_user_id = local_workspace_base_user_id(auth.user_id)
    source = get_local_workspace(base_user_id, workspace_id)
    if source is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    created = create_local_workspace(
        base_user_id, _duplicate_workspace_name(source.get("name") or "")
    )
    return _local_workspace_out(created)
