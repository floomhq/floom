"""Internal platform routes for refreshing bundled system assets."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from auth import AuthContext, get_auth_context
from auth.guards import _require_admin
from db import Repositories, get_repos
from services.system_assets import refresh_system_assets

system_assets_router = APIRouter()


class SystemAssetsRefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workspace_id: Optional[str] = None
    all_workspaces: bool = False
    asset: Optional[str] = None


@system_assets_router.post("/internal/system-assets/refresh")
def refresh_system_assets_route(
    payload: SystemAssetsRefreshRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    _require_admin(auth)
    try:
        return refresh_system_assets(
            user_id=auth.user_id,
            repos=repos,
            asset=payload.asset,
            workspace_id=payload.workspace_id,
            all_workspaces=payload.all_workspaces,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
