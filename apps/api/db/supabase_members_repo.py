"""Supabase-backed WorkspaceMemberRepository for the cloud deployment.

The OSS engine (engine/apps/api/main.py) serves the `/workspace/members`
surface that the dashboard's `api.members.*` calls. It resolves the repo via
`repos.members` and raises HTTP 501 ("Membership not available") when that field
is ``None``. The cloud's `_cloud_repositories()` factory historically left
`members` unset, so every authenticated owner hit a 501 and the Members panel
rendered "Couldn't load members" + the false "not Owner or Admin" notice
(FW-02). The control-plane membership (`apps/api/routes/members.py` +
`apps/api/db/members.py`) already worked, but the dashboard talks to the engine
surface, so the fix is to wire an engine-shaped repo here rather than re-point
the UI at the control-plane (different shape, admin-only listing, no `my_role`).

Shape contract (matches `engine/apps/api/main.py:_member_out` + the dashboard's
`WorkspaceMembersResponse`):

- ``list`` returns the workspace OWNER (role="owner", from
  ``workspaces.owner_user_id``) PLUS every active ``workspace_members`` row,
  emails resolved, owner deduped. The engine route does NOT add the owner
  separately, so the owner must appear here for the UI to show "you = Owner"
  and resolve ``my_role``.
- ``get`` returns the caller's row (owner -> synthesized owner row), used by the
  engine route to compute ``my_role``.
- Mutations take ``actor_id`` and enforce the permission matrix
  (owner/admin invite+remove; only owner changes roles / transfers; admins
  cannot target owner/admins). Errors map to PermissionError -> 403 and
  ValueError -> 400 in the engine route.

Workspace scope: the engine route passes a ``workspace_id`` derived from
``auth.user_id`` via ``_active_local_workspace_id`` — which is the single-tenant
OSS derivation and is WRONG on cloud (it yields the default workspace id, not
the active one). So, like every other cloud Supabase repo
(``apps/api/db/supabase_repos.py``), this adapter prefers the per-request
``get_active_workspace_id()`` contextvar and only falls back to the passed
value.
"""

from __future__ import annotations

from typing import Any

from apps.api.auth.workspace_context import get_active_workspace_id
from apps.api.config import get_supabase_service_client
from apps.api.db import members as members_db
from apps.api.db import workspaces as workspace_repo


def _scoped_workspace_id(workspace_id: str) -> str:
    """Prefer the per-request active workspace over the engine-passed value.

    The engine computes ``workspace_id`` from ``auth.user_id`` using the OSS
    single-tenant derivation, which is incorrect under multi-tenant cloud. The
    request's active-workspace contextvar is authoritative on cloud.
    """
    active = get_active_workspace_id()
    return active or workspace_id


def _owner_id(workspace_id: str) -> str | None:
    ws = workspace_repo.get(workspace_id=workspace_id)
    if ws is None:
        return None
    return str(ws.get("owner_user_id") or "") or None


def _role_for(*, workspace_id: str, user_id: str, owner_id: str | None) -> str | None:
    """Resolve a user's effective role: owner > member-row role > None."""
    if owner_id is not None and str(user_id) == owner_id:
        return "owner"
    return workspace_repo.get_member_role(workspace_id=workspace_id, user_id=user_id)


class SupabaseWorkspaceMemberRepository:
    """Cloud (Supabase + RLS) implementation of the engine's
    ``WorkspaceMemberRepository`` protocol."""

    # ------------------------------------------------------------------
    # reads
    # ------------------------------------------------------------------

    def list(self, *, workspace_id: str) -> list[dict[str, Any]]:
        ws_id = _scoped_workspace_id(workspace_id)
        owner_id = _owner_id(ws_id)
        members = members_db.list_members(workspace_id=ws_id)
        # Owner is authoritative via workspaces.owner_user_id and is NOT stored
        # in workspace_members; drop any stale member row for the owner so it is
        # never duplicated or shown with a non-owner role.
        members = [m for m in members if str(m.get("user_id")) != (owner_id or "")]

        user_ids: list[str] = []
        if owner_id:
            user_ids.append(owner_id)
        user_ids.extend(str(m["user_id"]) for m in members)
        emails = members_db.resolve_member_emails(user_ids)

        rows: list[dict[str, Any]] = []
        if owner_id:
            rows.append(
                {
                    "workspace_id": ws_id,
                    "user_id": owner_id,
                    "email": emails.get(owner_id, ""),
                    "role": "owner",
                    "status": "active",
                }
            )
        for m in members:
            rows.append(
                {
                    "workspace_id": ws_id,
                    "user_id": str(m["user_id"]),
                    "email": emails.get(str(m["user_id"]), ""),
                    "role": str(m.get("role") or "member"),
                    "status": str(m.get("status") or "active"),
                    "invited_by": m.get("invited_by"),
                    "created_at": m.get("invited_at"),
                    "updated_at": m.get("joined_at"),
                }
            )
        return rows

    def get(self, *, workspace_id: str, user_id: str) -> dict[str, Any] | None:
        ws_id = _scoped_workspace_id(workspace_id)
        owner_id = _owner_id(ws_id)
        if owner_id is not None and str(user_id) == owner_id:
            emails = members_db.resolve_member_emails([owner_id])
            return {
                "workspace_id": ws_id,
                "user_id": owner_id,
                "email": emails.get(owner_id, ""),
                "role": "owner",
                "status": "active",
            }
        member = members_db.get_member(workspace_id=ws_id, user_id=user_id)
        if member is None:
            return None
        emails = members_db.resolve_member_emails([str(user_id)])
        return {
            "workspace_id": ws_id,
            "user_id": str(member["user_id"]),
            "email": emails.get(str(user_id), ""),
            "role": str(member.get("role") or "member"),
            "status": str(member.get("status") or "active"),
            "invited_by": member.get("invited_by"),
            "created_at": member.get("invited_at"),
            "updated_at": member.get("joined_at"),
        }

    # ------------------------------------------------------------------
    # mutations (actor_id enforces the permission matrix)
    # ------------------------------------------------------------------

    def _require_admin(self, *, workspace_id: str, actor_id: str) -> str | None:
        """Raise PermissionError unless actor is owner or admin. Returns owner id."""
        owner_id = _owner_id(workspace_id)
        actor_role = _role_for(
            workspace_id=workspace_id, user_id=actor_id, owner_id=owner_id
        )
        if actor_role not in ("owner", "admin"):
            raise PermissionError("admin access required")
        return owner_id

    def invite(
        self, *, workspace_id: str, email: str, role: str, invited_by: str
    ) -> dict[str, Any]:
        ws_id = _scoped_workspace_id(workspace_id)
        self._require_admin(workspace_id=ws_id, actor_id=invited_by)
        email = (email or "").strip().lower()
        if not email:
            raise ValueError("email is required")
        if role not in ("admin", "member"):
            raise ValueError("role must be admin or member")
        invite, raw_token = members_db.invite_member(
            workspace_id=ws_id,
            inviter_user_id=invited_by,
            email=email,
            role=role,
        )
        # Best-effort invite email; never block invite creation on send failure.
        invite_url = f"https://workeros.floom.dev/app/join?invite={raw_token}"
        try:
            from apps.api.email_service import (
                build_workspace_invite_email,
                send_email,
            )

            ws = workspace_repo.get(workspace_id=ws_id) or {}
            inviter_emails = members_db.resolve_member_emails([str(invited_by)])
            inviter_name = (
                (inviter_emails.get(str(invited_by)) or "").split("@")[0]
                or "A workspace admin"
            )
            msg = build_workspace_invite_email(
                inviter_name=inviter_name,
                workspace_name=ws.get("name") or "Workspace",
                invite_url=invite_url,
            )
            send_email(to=email, subject=msg["subject"], html=msg["html"])
        except Exception:
            pass
        # The invitee has no user_id until they accept; surface an invited row in
        # the shape the engine expects.
        return {
            "workspace_id": ws_id,
            "user_id": str(invite.get("id") or email),
            "email": email,
            "role": role,
            "status": "invited",
            "invited_by": invited_by,
            "created_at": invite.get("created_at"),
        }

    def set_role(
        self, *, workspace_id: str, actor_id: str, user_id: str, role: str
    ) -> dict[str, Any] | None:
        ws_id = _scoped_workspace_id(workspace_id)
        owner_id = _owner_id(ws_id)
        actor_role = _role_for(
            workspace_id=ws_id, user_id=actor_id, owner_id=owner_id
        )
        # Only the owner promotes/demotes (matches engine semantics + the UI,
        # which gates the affordance on isOwner).
        if actor_role != "owner":
            raise PermissionError("only the owner can change roles")
        if role not in ("admin", "member"):
            raise ValueError("role must be admin or member")
        if owner_id is not None and str(user_id) == owner_id:
            raise ValueError("the owner role is changed via transfer-owner")
        updated = members_db.change_role(
            workspace_id=ws_id, user_id=user_id, new_role=role
        )
        if updated is None:
            return None
        return self.get(workspace_id=ws_id, user_id=user_id)

    def remove(self, *, workspace_id: str, actor_id: str, user_id: str) -> bool:
        ws_id = _scoped_workspace_id(workspace_id)
        owner_id = self._require_admin(workspace_id=ws_id, actor_id=actor_id)
        if owner_id is not None and str(user_id) == owner_id:
            raise ValueError("cannot remove the workspace owner")
        actor_role = _role_for(
            workspace_id=ws_id, user_id=actor_id, owner_id=owner_id
        )
        target_role = _role_for(
            workspace_id=ws_id, user_id=user_id, owner_id=owner_id
        )
        # An admin cannot remove another admin; only the owner can.
        if actor_role == "admin" and target_role == "admin":
            raise PermissionError("admins cannot remove other admins")
        return members_db.remove_member(workspace_id=ws_id, user_id=user_id)

    def transfer_owner(
        self, *, workspace_id: str, actor_id: str, new_owner_id: str
    ) -> dict[str, Any]:
        ws_id = _scoped_workspace_id(workspace_id)
        owner_id = _owner_id(ws_id)
        if owner_id is None or str(actor_id) != owner_id:
            raise PermissionError("only the owner can transfer ownership")
        if str(new_owner_id) == owner_id:
            raise ValueError("new owner is already the owner")
        # New owner must be an active member of the workspace.
        target = members_db.get_member(workspace_id=ws_id, user_id=new_owner_id)
        if target is None:
            raise ValueError("new owner must be an active member")

        client = get_supabase_service_client()
        # Flip ownership on the authoritative workspaces row.
        client.table("workspaces").update({"owner_user_id": new_owner_id}).eq(
            "id", ws_id
        ).execute()
        # Demote the previous owner to an admin member row so they remain in the
        # workspace (the owner was not previously in workspace_members).
        client.table("workspace_members").upsert(
            {
                "workspace_id": ws_id,
                "user_id": owner_id,
                "role": "admin",
                "status": "active",
            },
            on_conflict="workspace_id,user_id",
        ).execute()
        # The new owner no longer needs a member row (ownership is authoritative);
        # remove theirs so list() shows them once, as owner.
        client.table("workspace_members").update({"status": "removed"}).eq(
            "workspace_id", ws_id
        ).eq("user_id", new_owner_id).execute()

        result = self.get(workspace_id=ws_id, user_id=new_owner_id)
        return result or {
            "workspace_id": ws_id,
            "user_id": str(new_owner_id),
            "role": "owner",
            "status": "active",
        }
