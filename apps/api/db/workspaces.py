"""Workspace CRUD against Supabase.

Pure data-access layer; the HTTP surface lives in
``apps.api.routes.workspaces``. The auth provider
(``apps.api.auth.supabase_provider``) also calls into here for the
lazy-bootstrap path when a brand-new user issues their first
authenticated request.
"""

from __future__ import annotations

import uuid
import hashlib
import secrets
from datetime import datetime, timezone
from typing import Any, Mapping

from apps.api.config import get_supabase_service_client


def ensure_user_row(*, user_id: str, email: str | None) -> None:
    """Idempotently upsert the ``public.users`` row for an authenticated user.

    ``workspaces.owner_user_id`` has an FK to ``public.users(id)``. The normal
    OAuth/magic-link path upserts this row in ``/auth/callback``
    (``routes.auth._upsert_user_row``), but a partial write — or a JWT minted
    out-of-band (admin API, tests) — can strand a real ``auth.users`` user with
    no ``public.users`` row. In that state the lazy workspace bootstrap's INSERT
    violates the FK and 500s a validly-authenticated user.

    This mirrors the shape of ``routes.auth._upsert_user_row`` (id=sub,
    email, updated_at) so both paths converge on the same row. Safe to call on
    every resolution: ``on_conflict="id"`` makes it a no-op when the row exists.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    get_supabase_service_client().table("users").upsert(
        {
            "id": str(user_id),
            "email": email,
            "updated_at": now_iso,
        },
        on_conflict="id",
    ).execute()


def _new_workspace_id() -> str:
    """Generate a short workspace id of the form ``ws_<14 hex chars>``.

    Matches the format used by the SQL backfill in 0005_workspaces.sql,
    so backfilled and runtime-created ids look identical.
    """
    return "ws_" + uuid.uuid4().hex[:14]


def _new_share_link_id() -> str:
    return "wsl_" + uuid.uuid4().hex[:18]


def new_share_token() -> str:
    return "wst_" + secrets.token_urlsafe(32)


def share_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _email_prefix(email: str | None) -> str:
    if not email:
        return "workspace"
    local = email.split("@", 1)[0].strip()
    return local or "workspace"


def _row(response: Any) -> Mapping[str, Any] | None:
    data = getattr(response, "data", None)
    if not data:
        return None
    if isinstance(data, list):
        return data[0] if data else None
    return data


def _rows(response: Any) -> list[Mapping[str, Any]]:
    data = getattr(response, "data", None)
    if not data:
        return []
    if isinstance(data, list):
        return data
    return [data]


def list_for_owner(*, owner_user_id: str) -> list[dict[str, Any]]:
    """All workspaces owned by this user, oldest-first."""
    client = get_supabase_service_client()
    response = (
        client.table("workspaces")
        .select("id,name,owner_user_id,created_at")
        .eq("owner_user_id", owner_user_id)
        .order("created_at")
        .execute()
    )
    return [dict(row) for row in _rows(response)]


def get(*, workspace_id: str) -> dict[str, Any] | None:
    client = get_supabase_service_client()
    response = (
        client.table("workspaces")
        .select("id,name,owner_user_id,created_at")
        .eq("id", workspace_id)
        .limit(1)
        .execute()
    )
    row = _row(response)
    return dict(row) if row else None


def create(*, owner_user_id: str, name: str) -> dict[str, Any]:
    """Create a workspace owned by this user.

    Names are NOT unique per owner; brutally-simple v1 allows duplicates.
    """
    workspace_id = _new_workspace_id()
    client = get_supabase_service_client()
    client.table("workspaces").insert(
        {
            "id": workspace_id,
            "owner_user_id": owner_user_id,
            "name": (name or "").strip() or "Untitled",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
    ).execute()
    created = get(workspace_id=workspace_id)
    if created is None:
        raise RuntimeError(f"failed to create workspace {workspace_id}")
    return created


def create_share_link(
    *,
    owner_user_id: str,
    workspace_id: str,
    expires_at: str | None,
    max_uses: int | None,
) -> tuple[dict[str, Any], str]:
    workspace = get(workspace_id=workspace_id)
    if workspace is None or str(workspace.get("owner_user_id")) != str(owner_user_id):
        raise PermissionError("workspace not found")
    raw_token = new_share_token()
    row = {
        "id": _new_share_link_id(),
        "workspace_id": workspace_id,
        "token_hash": share_token_hash(raw_token),
        "created_by_user_id": owner_user_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": expires_at,
        "max_uses": max_uses,
        "use_count": 0,
    }
    client = get_supabase_service_client()
    client.table("workspace_share_links").insert(row).execute()
    return {key: value for key, value in row.items() if key != "token_hash"}, raw_token


def revoke_share_link(*, owner_user_id: str, workspace_id: str, link_id: str) -> bool:
    workspace = get(workspace_id=workspace_id)
    if workspace is None or str(workspace.get("owner_user_id")) != str(owner_user_id):
        raise PermissionError("workspace not found")
    response = (
        get_supabase_service_client()
        .table("workspace_share_links")
        .update({"revoked_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", link_id)
        .eq("workspace_id", workspace_id)
        .execute()
    )
    return bool(_rows(response))


def resolve_share_token(*, token: str) -> dict[str, Any] | None:
    token_hash = share_token_hash(token)
    response = (
        get_supabase_service_client()
        .table("workspace_share_links")
        .select("id,workspace_id,created_by_user_id,created_at,expires_at,revoked_at,max_uses,use_count")
        .eq("token_hash", token_hash)
        .limit(1)
        .execute()
    )
    row = _row(response)
    if not row:
        return None
    link = dict(row)
    workspace = get(workspace_id=str(link["workspace_id"]))
    if workspace is None:
        return None
    link["workspace"] = workspace
    return link


def increment_share_use(*, link_id: str, use_count: int) -> None:
    get_supabase_service_client().table("workspace_share_links").update(
        {"use_count": int(use_count) + 1}
    ).eq("id", link_id).execute()


def resolve_active_workspace(*, user_id: str, email: str | None, requested_id: str | None) -> dict[str, Any]:
    """Pick the workspace to scope a request by.

    Priority:
      1. If ``requested_id`` is set and the caller owns it -> use it.
      2. Otherwise, oldest workspace owned by the caller.
      3. Otherwise (brand-new user), lazy-bootstrap one named after the
         email prefix and return it.

    Returns the full workspace row.
    """
    if requested_id:
        candidate = get(workspace_id=requested_id)
        if candidate and str(candidate.get("owner_user_id")) == str(user_id):
            return candidate
        # Requested id doesn't exist or doesn't belong to this user; fall
        # through to default. Don't raise — a stale cookie shouldn't 401
        # the user out.

    owned = list_for_owner(owner_user_id=user_id)
    if owned:
        return dict(owned[0])

    # Bootstrap: brand-new user, no rows yet. Guarantee the public.users row
    # exists first so the workspaces FK can't 500 a validly-authenticated user
    # whose users row was never written (partial /auth/callback, admin-minted
    # JWT, etc.). Idempotent — no-op when the row already exists.
    ensure_user_row(user_id=user_id, email=email)
    return create(owner_user_id=user_id, name=_email_prefix(email))


def workspace_id_for_worker(*, worker_id: str) -> str | None:
    """Look up the workspace_id a worker belongs to.

    Used by the scheduler / webhook code paths that don't have an active
    HTTP request (and therefore no contextvar) but need to write a run
    row with the correct workspace_id.
    """
    client = get_supabase_service_client()
    response = (
        client.table("workers")
        .select("workspace_id")
        .eq("id", worker_id)
        .limit(1)
        .execute()
    )
    row = _row(response)
    return str(row.get("workspace_id")) if row and row.get("workspace_id") else None
