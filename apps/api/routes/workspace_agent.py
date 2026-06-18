from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.workspace_context import get_active_member_role, get_active_workspace_id
from apps.api.cloud_workspace_agent import (
    delete_slack_binding,
    get_slack_binding,
    upsert_slack_binding,
)

ensure_engine_api_path()

from auth import AuthContext, get_auth_context  # noqa: E402


router = APIRouter(prefix="/system/workspace-agent", tags=["workspace-agent"])


class SlackBindingPayload(BaseModel):
    external_channel_id: str = Field(..., min_length=1, max_length=80)
    external_channel_name: str | None = Field(default=None, max_length=120)
    external_team_id: str | None = Field(default=None, max_length=80)
    enabled: bool = True

    @field_validator("external_channel_id", "external_channel_name", "external_team_id")
    @classmethod
    def _trim(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed or None


def _workspace_id_or_500() -> str:
    workspace_id = get_active_workspace_id()
    if not workspace_id:
        raise HTTPException(status_code=500, detail="active workspace is not available")
    return workspace_id


def _require_workspace_admin() -> None:
    if get_active_member_role() != "admin":
        raise HTTPException(status_code=403, detail="workspace admin required")


@router.get("/channels/slack")
async def read_slack_binding(
    _auth: AuthContext = Depends(get_auth_context),
) -> dict:
    workspace_id = _workspace_id_or_500()
    return {"binding": get_slack_binding(workspace_id=workspace_id)}


@router.put("/channels/slack")
async def save_slack_binding(
    payload: SlackBindingPayload,
    _auth: AuthContext = Depends(get_auth_context),
) -> dict:
    _require_workspace_admin()
    workspace_id = _workspace_id_or_500()
    row = upsert_slack_binding(
        workspace_id=workspace_id,
        external_channel_id=payload.external_channel_id,
        external_channel_name=payload.external_channel_name,
        external_team_id=payload.external_team_id,
        enabled=payload.enabled,
    )
    return {"binding": row}


@router.delete("/channels/slack")
async def remove_slack_binding(
    _auth: AuthContext = Depends(get_auth_context),
) -> dict:
    _require_workspace_admin()
    workspace_id = _workspace_id_or_500()
    return {"deleted": delete_slack_binding(workspace_id=workspace_id)}
