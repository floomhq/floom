"""General /system + settings-surface routes.

``GET /system/platform-config`` (redacted required-env summary),
``GET /channels/email`` (email-channel status), ``GET /system/info``
(version/uptime, admin-gated detail), the three ``/system/workspace-agent``
routes (read-only agent view, per-user capability settings, visibility), and
``GET /system/alerts`` (open incidents). Extracted verbatim from main.py.
``/system/git*`` lives in routers/system_git.py; ``/system/overview``,
``/system/metrics`` and ``/system/sweep-connections`` stay in main until their
closures (overview serializers, rate-bucket state, connections sweep) move.

Platform-secret specs come from services.secrets_env, assistant access from
services.context_access (both never purged); chat_service/db are imported
lazily inside handlers (purged modules). The version string comes from
core.config.API_VERSION (also what main passes to FastAPI(version=...)), so
the handler keeps its original (auth-only) signature for direct-call tests.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from auth import AuthContext, get_auth_context
from core.config import API_VERSION, _PROCESS_STARTED_AT
from db import Repositories, get_repos
from services.context_access import _assistant_access, _ensure_assistant_row
from services.secrets_env import INFRA_PATH_SPECS, PLATFORM_SECRET_SPECS, PlatformSecretSpec

system_router = APIRouter()


class WorkspaceAgentSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    brain_read: Optional[bool] = None
    brain_write: Optional[bool] = None
    connections_read: Optional[bool] = None
    connections_use: Optional[bool] = None
    connections_add: Optional[bool] = None


class AssistantVisibilityUpdate(BaseModel):
    """Set the workspace assistant's visibility. ``specific_people`` reserved."""
    visibility: Literal["private", "workspace", "specific_people"]


class PlatformConfig(BaseModel):
    all_required_set: bool
    missing: List[str]
    set_count: int
    required_count: int


@system_router.get("/system/platform-config", response_model=PlatformConfig)
def platform_config(auth: AuthContext = Depends(get_auth_context)):
    """Return a redacted platform-config summary.

    PR S13: keep this minimal shape stable. The old settings page and the S12
    tabbed settings page both consume this response.
    """
    required_specs = [s for s in (PLATFORM_SECRET_SPECS + INFRA_PATH_SPECS) if s["required"]]

    def _spec_env_set(s: PlatformSecretSpec) -> bool:
        # A spec is satisfied if its env var is set, or its back-compat fallback
        # is (e.g. PLATFORM_OPENAI_API_KEY falls back to OPENAI_API_KEY).
        if (os.environ.get(s["name"]) or "").strip():
            return True
        fb = s.get("fallback")
        return bool(fb and (os.environ.get(fb) or "").strip())

    missing = [s["name"] for s in required_specs if not _spec_env_set(s)]
    required_count = len(required_specs)
    set_count = required_count - len(missing)
    return PlatformConfig(
        all_required_set=(len(missing) == 0),
        missing=missing,
        set_count=set_count,
        required_count=required_count,
    )


@system_router.get("/channels/email")
def channels_email_status(auth: AuthContext = Depends(get_auth_context)):
    """#799: email-channel connection status for Settings > Channels.

    OSS has no separate linked email identity; the channel is "connected"
    when the authenticated user has an email on file (the address run-failure
    notifications would go to). Returns { connected, email? }.
    """
    email = (auth.email or "").strip()
    return {"connected": bool(email), "email": email or None}


@system_router.get("/system/info")
def system_info(auth: AuthContext = Depends(get_auth_context)):
    # #837 RCA: python_version and started_at (process uptime) were returned to
    # every authenticated caller — recon data that maps the runtime for
    # interpreter-specific exploits and restart tracking. Admins keep the full
    # payload; everyone else gets version + runner only.
    info: Dict[str, Any] = {
        "version": API_VERSION,
        "runner": "e2b",
    }
    if auth.is_admin:
        info["started_at"] = _PROCESS_STARTED_AT
        info["python_version"] = sys.version.split()[0]
    return info


@system_router.get("/system/workspace-agent")
def system_workspace_agent(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Read-only view of the workspace agent that powers /chat.

    GAP #5: operators had no way to see the assistant's system instructions or
    which management tools it can call. Returns the resolved system prompt
    (workspace.md + engine SKILL.md + live workspace snapshot) and the tool
    names + one-line descriptions. Never returns secret values.
    """
    from chat_service import workspace_agent_info

    info = workspace_agent_info(auth.user_id)
    owner_id, visibility, permissions = _assistant_access(
        user_id=auth.user_id, repos=repos
    )
    return {
        "agent_id": info["agent_id"],
        "model": info["model"],
        "base_persona": info.get("base_persona"),
        "worker_authoring_rules": info.get("worker_authoring_rules"),
        "system_prompt": info["system_prompt"],
        "tools": info["tools"],
        "settings": info.get("settings") or {},
        "channels": info["channels"],
        # Members STEP 5: ownership + per-asset visibility + computed permissions.
        # The assistant is a shared workspace tool — default visibility=workspace.
        "owner_id": owner_id,
        "visibility": visibility,
        "permissions": permissions.model_dump(),
    }


@system_router.put("/system/workspace-agent/settings")
def update_workspace_agent_settings(
    payload: WorkspaceAgentSettingsUpdate,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    """Update per-user workspace-agent capability flags."""
    from chat_service import set_workspace_agent_settings

    settings = set_workspace_agent_settings(
        auth.user_id,
        payload.model_dump(exclude_unset=True),
    )
    return {"settings": settings}


@system_router.put("/system/workspace-agent/visibility")
def set_workspace_agent_visibility(
    payload: AssistantVisibilityUpdate,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Set the workspace assistant's visibility (Private <-> Shared with workspace).

    Owner/admin only (AssetAccessRepository enforces ``can_share`` + the enum).
    The assistant defaults to ``workspace`` (a shared tool); an owner can make it
    private. On the OSS single-owner engine the local user owns it, so this always
    succeeds. Returns the refreshed assistant view.
    """
    from db import assistant_row_id, derive_workspace_id

    asset_access = getattr(repos, "asset_access", None)
    if asset_access is None or not hasattr(asset_access, "set_visibility"):
        raise HTTPException(status_code=501, detail="Visibility control not available")
    owner_id = auth.user_id
    workspace_id = derive_workspace_id(owner_id)
    aid = assistant_row_id(workspace_id)
    _ensure_assistant_row(user_id=owner_id, repos=repos)
    try:
        result = asset_access.set_visibility(
            workspace_id=workspace_id,
            actor_id=owner_id,
            asset_type="assistant",
            asset_id=aid,
            visibility=payload.visibility,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Assistant not found")
    return system_workspace_agent(auth=auth, repos=repos)


@system_router.get("/system/alerts")
def system_alerts(auth: AuthContext = Depends(get_auth_context)):
    """Return open (unresolved) alert incidents.

    Returns a list of {worker_id, incident_key, reason, details, fired_at} for
    incidents that have not yet been resolved.  Used for diagnostics and the
    test harness.
    """
    from db import get_db

    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT ai.id, ai.worker_id, ai.incident_key, ai.reason, ai.details, ai.fired_at, ai.resolved_at
                FROM alert_incidents ai
                JOIN workers w ON w.id = ai.worker_id
                WHERE w.owner_id = ?
                ORDER BY ai.fired_at DESC
                LIMIT 200
                """,
                (auth.user_id,),
            ).fetchall()
    except Exception:
        # Table may not exist yet if migrations haven't run (e.g., test env)
        return {"incidents": []}
    return {
        "incidents": [
            {
                "id": row["id"],
                "worker_id": row["worker_id"],
                "incident_key": row["incident_key"],
                "reason": row["reason"],
                "details": row["details"],
                "fired_at": row["fired_at"],
                "resolved_at": row["resolved_at"],
                "open": row["resolved_at"] is None,
            }
            for row in rows
        ]
    }
