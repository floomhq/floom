"""HTTP surface for workspace switching.

Mounted under /api by main.py:

  GET  /api/workspaces            -> list user's workspaces + active
  POST /api/workspaces            -> create a new workspace
  POST /api/workspaces/{id}/select-> set active workspace cookie

v1 is intentionally minimal: no invites, no roles, no rename, no delete.
"""

from __future__ import annotations

from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.supabase_provider import ACTIVE_WORKSPACE_COOKIE, ACTIVE_WORKSPACE_HEADER
from apps.api.config import get_cloud_settings
from apps.api.db import workspaces as workspace_repo

ensure_engine_api_path()

from auth import AuthContext, get_auth_context  # noqa: E402


router = APIRouter(prefix="/workspaces", tags=["workspaces"])


# 30 days, matching the brief.
_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 3600


class CreateWorkspaceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


class WorkspaceOut(BaseModel):
    id: str
    name: str
    owner_user_id: str
    created_at: str


class WorkspaceListResponse(BaseModel):
    workspaces: list[WorkspaceOut]
    active_id: str | None


def _cookie_domain() -> str | None:
    """Mirror the eTLD+1 logic from routes/auth.py so the active-workspace
    cookie lives on the same scope as the session cookie."""
    settings = get_cloud_settings()
    hostname = urlparse(settings.frontend_url).hostname or urlparse(settings.api_base).hostname
    if not hostname or hostname in {"localhost", "127.0.0.1"}:
        return None
    if hostname.replace(".", "").isdigit():
        return None
    parts = hostname.split(".")
    if len(parts) < 2:
        return None
    return "." + ".".join(parts[-2:])


def _set_active_cookie(response: JSONResponse, workspace_id: str) -> None:
    response.set_cookie(
        key=ACTIVE_WORKSPACE_COOKIE,
        value=workspace_id,
        max_age=_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
        domain=_cookie_domain(),
    )


def _to_out(row: dict) -> WorkspaceOut:
    return WorkspaceOut(
        id=str(row["id"]),
        name=str(row["name"]),
        owner_user_id=str(row["owner_user_id"]),
        created_at=str(row["created_at"]),
    )


@router.get("", response_model=WorkspaceListResponse)
async def list_workspaces(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceListResponse:
    rows = workspace_repo.list_for_owner(owner_user_id=auth.user_id)
    if not rows:
        # Lazy-bootstrap a default workspace for brand-new users who
        # somehow bypassed the auth-provider bootstrap (e.g. they hit
        # /workspaces before any data-fetching endpoint).
        rows = [
            workspace_repo.resolve_active_workspace(
                user_id=auth.user_id,
                email=auth.email,
                requested_id=None,
            )
        ]
    requested = (
        (request.headers.get(ACTIVE_WORKSPACE_HEADER) or "").strip()
        or request.cookies.get(ACTIVE_WORKSPACE_COOKIE)
    )
    active_id: str | None = None
    for row in rows:
        if requested and str(row["id"]) == requested:
            active_id = requested
            break
    if active_id is None:
        active_id = str(rows[0]["id"])
    return WorkspaceListResponse(
        workspaces=[_to_out(row) for row in rows],
        active_id=active_id,
    )


@router.post("", response_model=WorkspaceOut)
async def create_workspace(
    payload: CreateWorkspaceRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceOut:
    created = workspace_repo.create(owner_user_id=auth.user_id, name=payload.name)
    return _to_out(created)


@router.post("/{workspace_id}/select")
async def select_workspace(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> JSONResponse:
    workspace = workspace_repo.get(workspace_id=workspace_id)
    if workspace is None or str(workspace["owner_user_id"]) != auth.user_id:
        # Don't leak existence to non-owners.
        raise HTTPException(status_code=404, detail="workspace not found")
    response = JSONResponse(_to_out(workspace).model_dump())
    _set_active_cookie(response, workspace_id)
    return response
