"""Member management CRUD against Supabase.

Covers the full lifecycle: invite → accept → manage → remove.

Design rules:
- Workspace owner (workspaces.owner_user_id) is always admin and does NOT
  appear in workspace_members — ownership is authoritative.
- workspace_invitations keeps one pending row per (workspace, email); the
  unique constraint is deferrable so revoked/accepted rows coexist.
- Accepting an invitation adds a workspace_members row AND mints a PAT for
  the new member so they can authenticate immediately.
- remove_member soft-deletes (status='removed') so audit history is retained.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from apps.api.config import get_supabase_service_client


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row(response: Any) -> dict[str, Any] | None:
    data = getattr(response, "data", None)
    if not data:
        return None
    if isinstance(data, list):
        return dict(data[0]) if data else None
    return dict(data)


def _rows(response: Any) -> list[dict[str, Any]]:
    data = getattr(response, "data", None)
    if not data:
        return []
    if isinstance(data, list):
        return [dict(r) for r in data]
    return [dict(data)]


def _invite_token() -> tuple[str, str]:
    """Return (raw_token, sha256_hex_hash). Raw token is returned to caller once."""
    raw = "wsi_" + secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    return raw, token_hash


def _pat_token() -> tuple[str, str]:
    """Return (raw_token, sha256_hex_hash) for a workspace PAT."""
    raw = "floom_" + secrets.token_urlsafe(40)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    return raw, token_hash


# ---------------------------------------------------------------------------
# invitations
# ---------------------------------------------------------------------------

def invite_member(
    *,
    workspace_id: str,
    inviter_user_id: str,
    email: str,
    role: str = "member",
    expires_days: int = 7,
) -> tuple[dict[str, Any], str]:
    """Create or refresh a pending invitation for ``email``.

    Returns ``(invitation_row, raw_token)``. Raw token is shown once; store
    only the hash. If a pending invite already exists for this (workspace,
    email) it is revoked first so a fresh token is issued.
    """
    client = get_supabase_service_client()
    email = email.strip().lower()

    # Revoke any existing pending invite for this email in the workspace.
    client.table("workspace_invitations").update(
        {"status": "revoked"}
    ).eq("workspace_id", workspace_id).eq("email", email).eq("status", "pending").execute()

    raw_token, token_hash = _invite_token()
    expires_at = (datetime.now(timezone.utc) + timedelta(days=expires_days)).isoformat()
    row_id = str(uuid.uuid4())
    row = {
        "id": row_id,
        "workspace_id": workspace_id,
        "email": email,
        "role": role,
        "invited_by": inviter_user_id,
        "token_hash": token_hash,
        "status": "pending",
        "created_at": _now(),
        "expires_at": expires_at,
    }
    client.table("workspace_invitations").insert(row).execute()
    saved = _row(
        client.table("workspace_invitations").select("*").eq("id", row_id).limit(1).execute()
    )
    return saved or row, raw_token


def get_invitation_by_token(*, raw_token: str) -> dict[str, Any] | None:
    """Look up a pending invitation by its raw (unhashed) token."""
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    client = get_supabase_service_client()
    response = (
        client.table("workspace_invitations")
        .select("*")
        .eq("token_hash", token_hash)
        .eq("status", "pending")
        .limit(1)
        .execute()
    )
    return _row(response)


def preview_invitation(*, raw_token: str, workspace_id: str | None = None) -> dict[str, Any] | None:
    """Return non-secret invitation preview data for an accept page."""
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    client = get_supabase_service_client()
    query = (
        client.table("workspace_invitations")
        .select("id,workspace_id,email,role,invited_by,status,created_at,expires_at")
        .eq("token_hash", token_hash)
        .eq("status", "pending")
    )
    if workspace_id:
        query = query.eq("workspace_id", workspace_id)
    invite = _row(query.limit(1).execute())
    if not invite:
        return None

    expires_at_str = invite.get("expires_at") or ""
    expired = False
    if expires_at_str:
        try:
            exp = datetime.fromisoformat(str(expires_at_str).replace("Z", "+00:00"))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            expired = datetime.now(timezone.utc) > exp
        except (ValueError, TypeError):
            expired = True

    workspace = _row(
        client.table("workspaces")
        .select("id,name,owner_user_id")
        .eq("id", invite["workspace_id"])
        .limit(1)
        .execute()
    ) or {}
    # #236: this preview is served UNAUTHENTICATED (GET /api/invites/{token}),
    # so it must not disclose the inviter's email (PII) to anyone holding the
    # token. The join page only needs the workspace/role/invited-email; drop
    # inviter_email entirely (no frontend consumes it).
    return {
        "id": invite.get("id"),
        "workspace_id": invite.get("workspace_id"),
        "workspace_name": workspace.get("name") or "Workspace",
        "email": invite.get("email"),
        "role": invite.get("role") or "member",
        "inviter_user_id": invite.get("invited_by"),
        "expires_at": invite.get("expires_at"),
        "expired": expired,
    }


def accept_invitation(
    *,
    raw_token: str,
    accepting_user_id: str,
    accepting_user_email: str | None = None,
) -> dict[str, Any]:
    """Accept a pending invitation and onboard the member.

    Steps:
    0. Bind to the invited email (#230): the accepting user's verified email
       MUST match invite.email — possession of the token is not enough.
    1. Validate token (pending, not expired).
    2. Mark invitation accepted.
    3. Upsert workspace_members row (idempotent re-join).
    4. Mint a PAT for the new member scoped to the workspace.

    Returns ``{"member": {...}, "pat_token": "<raw>"}`` — caller must surface
    the PAT to the user exactly once. Raises ``PermissionError`` when the
    caller's email does not match the invitation (mapped to 403 by the route).
    """
    invite = get_invitation_by_token(raw_token=raw_token)
    if not invite:
        raise ValueError("invitation not found or already used")

    # #230: an invitation is bound to the email it was addressed to. Invite
    # URLs leak routinely (forwarded mail, link prefetch/preview, proxy/referer
    # logs, shared inboxes), so token possession alone must NOT admit an
    # unrelated account — otherwise a leaked admin invite is a cross-tenant
    # privilege escalation. Require the accepting user's *verified* email to
    # equal invite.email (case-insensitive), and fail closed when we can't
    # verify the caller's email (e.g. a non-session auth method with no email).
    invited_email = str(invite.get("email") or "").strip().lower()
    caller_email = str(accepting_user_email or "").strip().lower()
    if not caller_email:
        raise PermissionError("this invitation must be accepted from the invited account")
    if not invited_email or caller_email != invited_email:
        raise PermissionError("this invitation was issued to a different email address")

    now = datetime.now(timezone.utc)
    expires_at_str = invite.get("expires_at") or ""
    if expires_at_str:
        try:
            exp = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00"))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if now > exp:
                raise ValueError("invitation has expired")
        except (ValueError, TypeError) as exc:
            if "expired" in str(exc):
                raise
            raise ValueError("invalid invitation expiry") from exc

    client = get_supabase_service_client()
    now_iso = now.isoformat()

    # #281: claim the invite atomically (pending -> accepted). Only the request
    # that actually flips it mints a PAT, so concurrent accepts of the same
    # token can't double-mint tokens / double-fire side effects.
    claim = (
        client.table("workspace_invitations")
        .update(
            {
                "status": "accepted",
                "accepted_at": now_iso,
                "accepted_by_user_id": accepting_user_id,
            }
        )
        .eq("id", invite["id"])
        .eq("status", "pending")
        .execute()
    )
    claimed = bool(getattr(claim, "data", None))

    workspace_id = str(invite["workspace_id"])
    role = str(invite.get("role") or "member")

    # Upsert member row.
    member_id = str(uuid.uuid4())
    client.table("workspace_members").upsert(
        {
            "id": member_id,
            "workspace_id": workspace_id,
            "user_id": accepting_user_id,
            "role": role,
            "invited_by": invite.get("invited_by"),
            "invited_at": invite.get("created_at") or now_iso,
            "joined_at": now_iso,
            "status": "active",
        },
        on_conflict="workspace_id,user_id",
    ).execute()

    member = _row(
        client.table("workspace_members")
        .select("*")
        .eq("workspace_id", workspace_id)
        .eq("user_id", accepting_user_id)
        .limit(1)
        .execute()
    )

    # #281: only the request that won the pending->accepted claim mints a PAT.
    # A concurrent duplicate accept (lost claim) returns the idempotent member
    # row without a second token.
    if not claimed:
        return {"member": member or {}, "pat_token": None}

    # Mint a PAT scoped to the workspace.
    raw_pat, pat_hash = _pat_token()
    client.table("api_tokens").insert(
        {
            "id": str(uuid.uuid4()),
            "user_id": accepting_user_id,
            "workspace_id": workspace_id,
            "token_hash": pat_hash,
            "name": f"auto-{workspace_id[:8]}",
            "created_at": now_iso,
            "last_used_at": None,
        }
    ).execute()

    return {"member": member or {}, "pat_token": raw_pat}


def revoke_invitation(*, invitation_id: str, workspace_id: str) -> bool:
    """Revoke a pending invitation. Returns True if a row was updated."""
    client = get_supabase_service_client()
    response = (
        client.table("workspace_invitations")
        .update({"status": "revoked"})
        .eq("id", invitation_id)
        .eq("workspace_id", workspace_id)
        .eq("status", "pending")
        .execute()
    )
    return bool(_rows(response))


def list_invitations(*, workspace_id: str) -> list[dict[str, Any]]:
    """All invitations for a workspace (all statuses), newest-first."""
    client = get_supabase_service_client()
    response = (
        client.table("workspace_invitations")
        .select("id,workspace_id,email,role,invited_by,status,created_at,expires_at,accepted_at,accepted_by_user_id")
        .eq("workspace_id", workspace_id)
        .order("created_at", desc=True)
        .execute()
    )
    return _rows(response)


# ---------------------------------------------------------------------------
# members
# ---------------------------------------------------------------------------

def list_members(*, workspace_id: str) -> list[dict[str, Any]]:
    """All active members for a workspace, joined-at order."""
    client = get_supabase_service_client()
    response = (
        client.table("workspace_members")
        .select("id,workspace_id,user_id,role,invited_by,invited_at,joined_at,status")
        .eq("workspace_id", workspace_id)
        .eq("status", "active")
        .order("joined_at")
        .execute()
    )
    return _rows(response)


def get_member(*, workspace_id: str, user_id: str) -> dict[str, Any] | None:
    """Return the active member row or None."""
    client = get_supabase_service_client()
    response = (
        client.table("workspace_members")
        .select("*")
        .eq("workspace_id", workspace_id)
        .eq("user_id", user_id)
        .eq("status", "active")
        .limit(1)
        .execute()
    )
    return _row(response)


def _evict_ws_cache(user_id: str) -> None:
    """#275: clear the auth provider's cached workspace/role for a user so a
    role change or removal takes effect immediately (not within _WS_TTL ~30s)."""
    try:
        from apps.api.auth.supabase_provider import evict_workspace_cache_for_user
        evict_workspace_cache_for_user(user_id)
    except Exception:
        pass


def change_role(*, workspace_id: str, user_id: str, new_role: str) -> dict[str, Any] | None:
    """Change the role of an active member. Returns updated row or None."""
    client = get_supabase_service_client()
    client.table("workspace_members").update({"role": new_role}).eq(
        "workspace_id", workspace_id
    ).eq("user_id", user_id).eq("status", "active").execute()
    _evict_ws_cache(user_id)  # #275: demotion/promotion is immediate
    return get_member(workspace_id=workspace_id, user_id=user_id)


def resolve_member_emails(user_ids: list[str]) -> dict[str, str]:
    """Batch-look up emails for a list of user_ids via Supabase auth admin.

    Returns {user_id: email}. Missing or erroring users are silently omitted.
    """
    if not user_ids:
        return {}
    client = get_supabase_service_client()
    result: dict[str, str] = {}
    for uid in user_ids:
        try:
            resp = client.auth.admin.get_user_by_id(uid)
            if resp and resp.user and resp.user.email:
                result[uid] = resp.user.email
        except Exception:
            pass
    return result


def remove_member(*, workspace_id: str, user_id: str) -> bool:
    """Soft-delete a member (status='removed'). Returns True if found."""
    client = get_supabase_service_client()
    response = (
        client.table("workspace_members")
        .update({"status": "removed"})
        .eq("workspace_id", workspace_id)
        .eq("user_id", user_id)
        .eq("status", "active")
        .execute()
    )
    removed = bool(_rows(response))
    if removed:
        _evict_ws_cache(user_id)  # #275: removal is immediate
    return removed
