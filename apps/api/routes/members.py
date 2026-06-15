"""HTTP surface for workspace member management.

Routes mounted under /workspaces (prefix applied in main.py):

  POST   /workspaces/{id}/members/invite          -> send invite (admin only)
  GET    /workspaces/{id}/members                 -> list active members (admin only)
  DELETE /workspaces/{id}/members/{user_id}       -> remove member (admin only)
  PATCH  /workspaces/{id}/members/{user_id}/role  -> change role (admin only)
  GET    /workspaces/{id}/invitations             -> list invitations (admin only)
  GET    /workspaces/{id}/invites/{token}         -> preview invite by token
  GET    /invites/{token}                         -> preview invite by token
  DELETE /workspaces/{id}/invitations/{inv_id}    -> revoke invite (admin only)
  POST   /workspaces/accept-invite                -> accept invitation (any auth user)
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from apps.api._engine import ensure_engine_api_path
from apps.api.db import members as members_db
from apps.api.db import workspaces as workspace_repo
from apps.api.email_service import build_workspace_invite_email, send_email
from apps.api.obs import get_logger, log_failure

ensure_engine_api_path()

from auth import AuthContext, get_auth_context  # noqa: E402


logger = get_logger(__name__)

router = APIRouter(tags=["members"])


def _email_domain(email: str | None) -> str:
    """Return only the domain of an email for logging (avoid logging the
    full address / local-part as PII)."""
    addr = str(email or "")
    return addr.rsplit("@", 1)[-1] if "@" in addr else "unknown"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _is_admin(auth: AuthContext, workspace_id: str) -> bool:
    """True if the caller owns or has admin role in the workspace."""
    ws = workspace_repo.get(workspace_id=workspace_id)
    if ws is None:
        return False
    if str(ws.get("owner_user_id", "")) == str(auth.user_id):
        return True
    role = workspace_repo.get_member_role(workspace_id=workspace_id, user_id=auth.user_id)
    return role == "admin"


def _require_admin(auth: AuthContext, workspace_id: str) -> dict:
    """Return the workspace row or raise 404/403.

    #236: don't leak workspace existence to non-members. Checking get()->404
    BEFORE the access check let a non-member probe arbitrary ``ws_...`` ids
    (real → 403, absent → 404). An actual member who merely lacks admin still
    gets 403 (they already know the workspace exists); everyone else — non-
    members AND nonexistent ids alike — gets an identical 404.
    """
    ws = workspace_repo.get(workspace_id=workspace_id)
    if ws is not None and str(ws.get("owner_user_id", "")) == str(auth.user_id):
        return ws
    role = (
        workspace_repo.get_member_role(workspace_id=workspace_id, user_id=auth.user_id)
        if ws is not None
        else None
    )
    if role == "admin":
        return ws
    if role is not None:
        # Caller is a member of an existing workspace, just not an admin.
        raise HTTPException(status_code=403, detail="admin access required")
    raise HTTPException(status_code=404, detail="workspace not found")


# ---------------------------------------------------------------------------
# schemas
# ---------------------------------------------------------------------------

class InviteMemberRequest(BaseModel):
    email: EmailStr
    role: str = Field(default="member", pattern="^(admin|member)$")


class ChangeRoleRequest(BaseModel):
    role: str = Field(..., pattern="^(admin|member)$")


class AcceptInviteRequest(BaseModel):
    token: str = Field(..., min_length=4)


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

@router.post("/workspaces/{workspace_id}/members/invite", status_code=201)
async def invite_member(
    workspace_id: str,
    payload: InviteMemberRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    ws = _require_admin(auth, workspace_id)
    invite, raw_token = members_db.invite_member(
        workspace_id=workspace_id,
        inviter_user_id=auth.user_id,
        email=str(payload.email),
        role=payload.role,
    )
    # Send email — non-fatal on failure so the invite row is still created.
    try:
        inviter_name = (auth.email or "").split("@")[0] or "A workspace admin"
        invite_url = f"https://workeros.floom.dev/app/join?invite={raw_token}"
        msg = build_workspace_invite_email(
            inviter_name=inviter_name,
            workspace_name=ws["name"],
            invite_url=invite_url,
        )
        send_email(to=str(payload.email), subject=msg["subject"], html=msg["html"])
    except Exception:
        # Non-fatal: the invite row is already created so the invitee can still
        # join via a link, but the email did not go out — make that visible so a
        # broken Resend/SMTP path is noticeable. Log domain only, never the token.
        logger.warning(
            "workspace invite email failed to send (invite row created, "
            "delivery skipped) workspace_id=%s invite_id=%s recipient_domain=%s",
            workspace_id,
            invite.get("id"),
            _email_domain(str(payload.email)),
            exc_info=True,
        )
    return {
        "id": invite.get("id"),
        "email": invite.get("email"),
        "role": invite.get("role"),
        "status": invite.get("status"),
        "expires_at": invite.get("expires_at"),
        "invite_url": invite_url,
    }


@router.get("/workspaces/{workspace_id}/members")
async def list_members(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    ws = workspace_repo.get(workspace_id=workspace_id)
    if ws is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    if not _is_admin(auth, workspace_id):
        raise HTTPException(status_code=403, detail="admin access required")
    members = members_db.list_members(workspace_id=workspace_id)
    # Owner is shown separately — exclude them from the members list to avoid duplication.
    owner_uid = str(ws["owner_user_id"])
    members = [m for m in members if str(m["user_id"]) != owner_uid]
    # Resolve emails for all members + owner in one batch.
    all_user_ids = [owner_uid] + [str(m["user_id"]) for m in members]
    emails = members_db.resolve_member_emails(all_user_ids)
    owner_entry = {
        "user_id": str(ws["owner_user_id"]),
        "role": "admin",
        "status": "active",
        "is_owner": True,
        "email": emails.get(str(ws["owner_user_id"]), ""),
    }
    for m in members:
        m["email"] = emails.get(str(m["user_id"]), "")
    return {
        "workspace_id": workspace_id,
        "owner": owner_entry,
        "members": members,
    }


@router.get("/workspaces/{workspace_id}/workers")
async def list_workspace_workers_admin(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> list:
    """Admin-only: all workers in the workspace, grouped by owner, with emails resolved."""
    _require_admin(auth, workspace_id)

    from apps.api.config import get_supabase_service_client
    import asyncio as _asyncio

    def _fetch():
        svc = get_supabase_service_client()
        rows = svc.table("workers").select("id,name,user_id,visibility").eq("workspace_id", workspace_id).execute()
        worker_rows = rows.data or []
        user_ids = list({r["user_id"] for r in worker_rows})
        emails = members_db.resolve_member_emails(user_ids)
        return [
            {
                "id": r["id"],
                "name": r.get("name") or r["id"],
                "visibility": r.get("visibility") or "private",
                "owner_id": r["user_id"],
                "owner_email": emails.get(r["user_id"], r["user_id"]),
            }
            for r in worker_rows
        ]

    return await _asyncio.to_thread(_fetch)


@router.delete("/workspaces/{workspace_id}/members/{user_id}")
async def remove_member(
    workspace_id: str,
    user_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    ws = _require_admin(auth, workspace_id)
    if str(ws.get("owner_user_id", "")) == user_id:
        raise HTTPException(status_code=400, detail="cannot remove workspace owner")
    removed = members_db.remove_member(workspace_id=workspace_id, user_id=user_id)
    if not removed:
        raise HTTPException(status_code=404, detail="member not found")
    return {"ok": True, "user_id": user_id}


@router.patch("/workspaces/{workspace_id}/members/{user_id}/role")
async def change_member_role(
    workspace_id: str,
    user_id: str,
    payload: ChangeRoleRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    ws = _require_admin(auth, workspace_id)
    if str(ws.get("owner_user_id", "")) == user_id:
        raise HTTPException(status_code=400, detail="cannot change workspace owner role")
    updated = members_db.change_role(
        workspace_id=workspace_id, user_id=user_id, new_role=payload.role
    )
    if not updated:
        raise HTTPException(status_code=404, detail="member not found")
    return updated


@router.get("/workspaces/{workspace_id}/invitations")
async def list_invitations(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    _require_admin(auth, workspace_id)
    invitations = members_db.list_invitations(workspace_id=workspace_id)
    return {"workspace_id": workspace_id, "invitations": invitations}


@router.get("/workspaces/{workspace_id}/invites/{token}")
async def preview_workspace_invitation(workspace_id: str, token: str) -> dict:
    preview = members_db.preview_invitation(raw_token=token, workspace_id=workspace_id)
    if not preview:
        raise HTTPException(status_code=404, detail="invitation not found or already used")
    if preview.get("expired"):
        raise HTTPException(status_code=410, detail="invitation has expired")
    return preview


@router.get("/invites/{token}")
async def preview_invitation(token: str) -> dict:
    preview = members_db.preview_invitation(raw_token=token)
    if not preview:
        raise HTTPException(status_code=404, detail="invitation not found or already used")
    if preview.get("expired"):
        raise HTTPException(status_code=410, detail="invitation has expired")
    return preview


@router.delete("/workspaces/{workspace_id}/invitations/{invitation_id}")
async def revoke_invitation(
    workspace_id: str,
    invitation_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    _require_admin(auth, workspace_id)
    revoked = members_db.revoke_invitation(
        invitation_id=invitation_id, workspace_id=workspace_id
    )
    if not revoked:
        raise HTTPException(status_code=404, detail="invitation not found or already accepted")
    return {"ok": True}


@router.post("/workspaces/accept-invite", status_code=201)
async def accept_invite(
    payload: AcceptInviteRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    """Accept a workspace invitation. Returns the new PAT (shown once)."""
    try:
        result = members_db.accept_invitation(
            raw_token=payload.token,
            accepting_user_id=auth.user_id,
            accepting_user_email=auth.email,
        )
    except PermissionError as exc:
        # #230: invite is bound to the invited email; mismatch is forbidden.
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        status = 410 if "expired" in str(exc) else 404
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    member = result["member"]
    return {
        "workspace_id": member.get("workspace_id"),
        "role": member.get("role"),
        "joined_at": member.get("joined_at"),
        "pat_token": result["pat_token"],
    }
