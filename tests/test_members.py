"""Unit tests for the members v1 system.

Tests are intentionally narrow: they monkeypatch Supabase clients so no
real network or database is needed. Coverage targets:

  - db/members.py: invite flow, accept_invitation (expired token), revoke
  - db/workspaces.py: list_member_workspaces, get_member_role, resolve_active_workspace
  - routes/workspaces.py: list_workspaces returns owned + member rows with role;
    select_workspace allows members
  - supabase_repos.py: _worker_rows visibility filter; admin access log in get()
  - workspace_context.py: set/get member role ContextVar
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import MagicMock, Mock, call, patch

import pytest


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _make_supabase_client(rows: list[dict] | dict | None = None) -> MagicMock:
    """Return a supabase-py-shaped mock that returns *rows* from .execute()."""
    client = MagicMock()
    resp = MagicMock()
    if rows is None:
        resp.data = []
    elif isinstance(rows, dict):
        resp.data = [rows]
    else:
        resp.data = rows
    # Chain: .table(...).select(...).eq(...).limit(...).execute() -> resp
    chain = MagicMock()
    chain.select.return_value = chain
    chain.insert.return_value = chain
    chain.update.return_value = chain
    chain.upsert.return_value = chain
    chain.delete.return_value = chain
    chain.eq.return_value = chain
    chain.or_.return_value = chain
    chain.in_.return_value = chain
    chain.order.return_value = chain
    chain.limit.return_value = chain
    chain.execute.return_value = resp
    client.table.return_value = chain
    client.rpc.return_value = chain
    return client


# ---------------------------------------------------------------------------
# workspace_context: ContextVar behaviour
# ---------------------------------------------------------------------------

def test_set_and_get_member_role():
    from apps.api.auth.workspace_context import get_active_member_role, set_active_member_role
    set_active_member_role("admin")
    assert get_active_member_role() == "admin"
    set_active_member_role("member")
    assert get_active_member_role() == "member"
    set_active_member_role(None)
    assert get_active_member_role() is None


def test_active_workspace_context_manager_resets_role():
    from apps.api.auth.workspace_context import active_workspace, get_active_member_role, set_active_member_role
    set_active_member_role("admin")
    with active_workspace("ws_test", role="member"):
        assert get_active_member_role() == "member"
    assert get_active_member_role() == "admin"


# ---------------------------------------------------------------------------
# db/workspaces.py: get_member_role, list_member_workspaces
# ---------------------------------------------------------------------------

def test_get_member_role_found(monkeypatch):
    import apps.api.db.workspaces as ws_repo
    client = _make_supabase_client({"role": "admin"})
    monkeypatch.setattr(ws_repo, "get_supabase_service_client", lambda: client)
    role = ws_repo.get_member_role(workspace_id="ws_1", user_id="user-1")
    assert role == "admin"


def test_get_member_role_not_found(monkeypatch):
    import apps.api.db.workspaces as ws_repo
    client = _make_supabase_client([])
    monkeypatch.setattr(ws_repo, "get_supabase_service_client", lambda: client)
    role = ws_repo.get_member_role(workspace_id="ws_1", user_id="user-1")
    assert role is None


def test_list_member_workspaces(monkeypatch):
    import apps.api.db.workspaces as ws_repo
    member_rows = [
        {
            "role": "member",
            "joined_at": "2026-01-01T00:00:00+00:00",
            "workspaces": {"id": "ws_2", "name": "Acme", "owner_user_id": "owner-id", "created_at": "2025-12-01"},
        }
    ]
    client = _make_supabase_client(member_rows)
    monkeypatch.setattr(ws_repo, "get_supabase_service_client", lambda: client)
    result = ws_repo.list_member_workspaces(user_id="user-1")
    assert len(result) == 1
    assert result[0]["id"] == "ws_2"
    assert result[0]["role"] == "member"


def test_resolve_active_workspace_prefers_member(monkeypatch):
    """If user is a member of requested workspace (not owner), it should be used."""
    import apps.api.db.workspaces as ws_repo
    requested_ws = {"id": "ws_member", "name": "Shared", "owner_user_id": "other-owner", "created_at": "2026-01-01"}
    monkeypatch.setattr(ws_repo, "get", lambda workspace_id: requested_ws if workspace_id == "ws_member" else None)
    monkeypatch.setattr(ws_repo, "get_member_role", lambda *, workspace_id, user_id: "member")
    monkeypatch.setattr(ws_repo, "list_for_owner", lambda *, owner_user_id: [])
    monkeypatch.setattr(ws_repo, "list_member_workspaces", lambda *, user_id: [])
    result = ws_repo.resolve_active_workspace(user_id="user-1", email=None, requested_id="ws_member")
    assert result["id"] == "ws_member"


def test_resolve_active_workspace_falls_back_to_member_workspace(monkeypatch):
    """With no owned workspace, falls back to first member workspace."""
    import apps.api.db.workspaces as ws_repo
    member_ws = {"id": "ws_shared", "name": "Shared", "owner_user_id": "other", "created_at": "2026-01-01", "role": "member"}
    monkeypatch.setattr(ws_repo, "get", lambda workspace_id: None)
    monkeypatch.setattr(ws_repo, "get_member_role", lambda *, workspace_id, user_id: None)
    monkeypatch.setattr(ws_repo, "list_for_owner", lambda *, owner_user_id: [])
    monkeypatch.setattr(ws_repo, "list_member_workspaces", lambda *, user_id: [member_ws])
    result = ws_repo.resolve_active_workspace(user_id="user-1", email=None, requested_id=None)
    assert result["id"] == "ws_shared"
    # role field is stripped from the returned workspace dict
    assert "role" not in result


# ---------------------------------------------------------------------------
# db/members.py: invite, accept, revoke
# ---------------------------------------------------------------------------

def test_invite_member_creates_row(monkeypatch):
    import apps.api.db.members as members_db
    saved_invite = {
        "id": "inv-1", "workspace_id": "ws_1", "email": "alice@example.com",
        "role": "member", "status": "pending", "created_at": "2026-01-01", "expires_at": "2026-01-08",
    }
    client = _make_supabase_client(saved_invite)
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: client)
    invite, raw_token = members_db.invite_member(
        workspace_id="ws_1",
        inviter_user_id="admin-user",
        email="alice@example.com",
    )
    assert invite["email"] == "alice@example.com"
    assert raw_token.startswith("wsi_")
    # Verify revoke-existing call was made (update .eq("status", "pending"))
    assert client.table.call_count >= 1


def test_accept_invitation_expired_raises(monkeypatch):
    import apps.api.db.members as members_db
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    invite = {
        "id": "inv-expired",
        "workspace_id": "ws_1",
        "role": "member",
        "created_at": "2026-01-01",
        "expires_at": past,
        "invited_by": "admin-user",
        "email": "alice@example.com",
    }
    monkeypatch.setattr(members_db, "get_invitation_by_token", lambda *, raw_token: invite)
    with pytest.raises(ValueError, match="expired"):
        members_db.accept_invitation(
            raw_token="wsi_test", accepting_user_id="alice", accepting_user_email="alice@example.com"
        )


def test_accept_invitation_not_found_raises(monkeypatch):
    import apps.api.db.members as members_db
    monkeypatch.setattr(members_db, "get_invitation_by_token", lambda *, raw_token: None)
    with pytest.raises(ValueError, match="not found"):
        members_db.accept_invitation(raw_token="wsi_invalid", accepting_user_id="alice")


def test_accept_invitation_success(monkeypatch):
    """Happy path: creates member row and mints a PAT."""
    import apps.api.db.members as members_db
    future = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    invite = {
        "id": "inv-ok",
        "workspace_id": "ws_1",
        "role": "member",
        "created_at": "2026-01-01",
        "expires_at": future,
        "invited_by": "admin-user",
        "email": "alice@example.com",
    }
    member_row = {"workspace_id": "ws_1", "user_id": "alice", "role": "member", "joined_at": "2026-01-02"}
    client = _make_supabase_client(member_row)
    monkeypatch.setattr(members_db, "get_invitation_by_token", lambda *, raw_token: invite)
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: client)
    result = members_db.accept_invitation(
        raw_token="wsi_ok", accepting_user_id="alice", accepting_user_email="alice@example.com"
    )
    assert "pat_token" in result
    assert result["pat_token"].startswith("floom_")
    assert result["member"]["workspace_id"] == "ws_1"


def test_accept_invitation_rejects_mismatched_email(monkeypatch):
    """#230: a token addressed to one email must not be accepted by another."""
    import apps.api.db.members as members_db
    future = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    invite = {
        "id": "inv-admin",
        "workspace_id": "ws_victim",
        "role": "admin",
        "created_at": "2026-01-01",
        "expires_at": future,
        "invited_by": "owner-user",
        "email": "someone-else@example.com",
    }
    monkeypatch.setattr(members_db, "get_invitation_by_token", lambda *, raw_token: invite)

    def _boom():
        raise AssertionError("must not touch Supabase on a rejected invite")

    monkeypatch.setattr(members_db, "get_supabase_service_client", _boom)

    with pytest.raises(PermissionError, match="different email"):
        members_db.accept_invitation(
            raw_token="wsi_leaked",
            accepting_user_id="attacker",
            accepting_user_email="attacker@evil.com",
        )


def test_accept_invitation_rejects_missing_caller_email(monkeypatch):
    """#230: fail closed when the caller's email can't be verified."""
    import apps.api.db.members as members_db
    future = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    invite = {
        "id": "inv-x",
        "workspace_id": "ws_1",
        "role": "member",
        "expires_at": future,
        "email": "alice@example.com",
    }
    monkeypatch.setattr(members_db, "get_invitation_by_token", lambda *, raw_token: invite)
    monkeypatch.setattr(
        members_db, "get_supabase_service_client",
        lambda: (_ for _ in ()).throw(AssertionError("no DB on reject")),
    )
    with pytest.raises(PermissionError):
        members_db.accept_invitation(
            raw_token="wsi_x", accepting_user_id="alice", accepting_user_email=None
        )


def test_accept_invitation_email_match_is_case_insensitive(monkeypatch):
    """#230: matching is case-insensitive (and trims) so legit accepts still work."""
    import apps.api.db.members as members_db
    future = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    invite = {
        "id": "inv-ci",
        "workspace_id": "ws_1",
        "role": "member",
        "created_at": "2026-01-01",
        "expires_at": future,
        "invited_by": "admin-user",
        "email": "Alice@Example.com",
    }
    member_row = {"workspace_id": "ws_1", "user_id": "alice", "role": "member", "joined_at": "2026-01-02"}
    client = _make_supabase_client(member_row)
    monkeypatch.setattr(members_db, "get_invitation_by_token", lambda *, raw_token: invite)
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: client)
    result = members_db.accept_invitation(
        raw_token="wsi_ci", accepting_user_id="alice", accepting_user_email="  alice@example.com  "
    )
    assert result["pat_token"].startswith("floom_")


def test_revoke_invitation(monkeypatch):
    import apps.api.db.members as members_db
    updated_row = {"id": "inv-1", "status": "revoked"}
    client = _make_supabase_client([updated_row])
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: client)
    assert members_db.revoke_invitation(invitation_id="inv-1", workspace_id="ws_1") is True


def test_revoke_invitation_not_found(monkeypatch):
    import apps.api.db.members as members_db
    client = _make_supabase_client([])
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: client)
    assert members_db.revoke_invitation(invitation_id="gone", workspace_id="ws_1") is False


def test_preview_invitation_route_public(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from apps.api.routes.members import router
    import apps.api.db.members as members_db

    monkeypatch.setattr(
        members_db,
        "preview_invitation",
        lambda *, raw_token, workspace_id=None: {
            "workspace_id": workspace_id or "ws_1",
            "workspace_name": "Acme",
            "email": "alice@example.com",
            "role": "member",
            "expired": False,
        },
    )

    mini_app = FastAPI()
    mini_app.include_router(router)
    with TestClient(mini_app) as c:
        global_resp = c.get("/invites/wsi_test")
        scoped_resp = c.get("/workspaces/ws_1/invites/wsi_test")

    assert global_resp.status_code == 200
    assert global_resp.json()["workspace_name"] == "Acme"
    assert scoped_resp.status_code == 200
    assert scoped_resp.json()["workspace_id"] == "ws_1"


def test_remove_member(monkeypatch):
    import apps.api.db.members as members_db
    client = _make_supabase_client([{"id": "m-1"}])
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: client)
    assert members_db.remove_member(workspace_id="ws_1", user_id="alice") is True


def test_change_role(monkeypatch):
    import apps.api.db.members as members_db
    member = {"workspace_id": "ws_1", "user_id": "alice", "role": "admin", "status": "active"}
    client = _make_supabase_client(member)
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: client)
    updated = members_db.change_role(workspace_id="ws_1", user_id="alice", new_role="admin")
    assert updated["role"] == "admin"


# ---------------------------------------------------------------------------
# routes/workspaces.py: list_workspaces includes member workspaces
# ---------------------------------------------------------------------------

def test_list_workspaces_includes_member_rows(monkeypatch):
    import apps.api.db.workspaces as ws_repo
    owned = [{"id": "ws_own", "name": "Mine", "owner_user_id": "user-1", "created_at": "2026-01-01"}]
    member = [{"id": "ws_shared", "name": "Acme", "owner_user_id": "other", "created_at": "2026-01-01", "role": "member"}]
    monkeypatch.setattr(ws_repo, "list_for_owner", lambda *, owner_user_id: owned)
    monkeypatch.setattr(ws_repo, "list_member_workspaces", lambda *, user_id: member)
    monkeypatch.setattr(ws_repo, "resolve_active_workspace", lambda **kw: owned[0])

    from fastapi.testclient import TestClient
    from apps.api.routes.workspaces import router
    from fastapi import FastAPI
    from apps.api._engine import ensure_engine_api_path
    ensure_engine_api_path()
    from auth import AuthContext

    mini_app = FastAPI()

    async def fake_auth():
        return AuthContext(user_id="user-1", email="u@example.com", scopes=())

    mini_app.include_router(router, dependencies=[])

    # Override the auth dep
    from apps.api.routes.workspaces import router as ws_router
    from auth import get_auth_context
    mini_app.dependency_overrides[get_auth_context] = fake_auth
    mini_app.include_router(ws_router)

    with TestClient(mini_app) as c:
        resp = c.get("/workspaces")
    assert resp.status_code == 200
    data = resp.json()
    ids = [w["id"] for w in data["workspaces"]]
    assert "ws_own" in ids
    assert "ws_shared" in ids
    own_entry = next(w for w in data["workspaces"] if w["id"] == "ws_own")
    shared_entry = next(w for w in data["workspaces"] if w["id"] == "ws_shared")
    assert own_entry["role"] == "admin"
    assert shared_entry["role"] == "member"


# ---------------------------------------------------------------------------
# routes/workspaces.py: select_workspace allows members
# ---------------------------------------------------------------------------

def test_select_workspace_allows_member(monkeypatch):
    import apps.api.db.workspaces as ws_repo
    workspace = {"id": "ws_other", "name": "Acme", "owner_user_id": "other-owner", "created_at": "2026-01-01"}
    monkeypatch.setattr(ws_repo, "get", lambda *, workspace_id: workspace)
    monkeypatch.setattr(ws_repo, "get_member_role", lambda *, workspace_id, user_id: "member")

    from fastapi.testclient import TestClient
    from fastapi import FastAPI
    from apps.api.routes.workspaces import router as ws_router
    from apps.api._engine import ensure_engine_api_path
    ensure_engine_api_path()
    from auth import AuthContext, get_auth_context

    mini_app = FastAPI()
    mini_app.include_router(ws_router)
    mini_app.dependency_overrides[get_auth_context] = lambda: AuthContext(
        user_id="user-1", email=None, scopes=()
    )
    with TestClient(mini_app) as c:
        resp = c.post("/workspaces/ws_other/select")
    assert resp.status_code == 200
    assert resp.json()["role"] == "member"


def test_select_workspace_rejects_non_member(monkeypatch):
    import apps.api.db.workspaces as ws_repo
    workspace = {"id": "ws_other", "name": "Acme", "owner_user_id": "other-owner", "created_at": "2026-01-01"}
    monkeypatch.setattr(ws_repo, "get", lambda *, workspace_id: workspace)
    monkeypatch.setattr(ws_repo, "get_member_role", lambda *, workspace_id, user_id: None)

    from fastapi.testclient import TestClient
    from fastapi import FastAPI
    from apps.api.routes.workspaces import router as ws_router
    from apps.api._engine import ensure_engine_api_path
    ensure_engine_api_path()
    from auth import AuthContext, get_auth_context

    mini_app = FastAPI()
    mini_app.include_router(ws_router)
    mini_app.dependency_overrides[get_auth_context] = lambda: AuthContext(
        user_id="user-1", email=None, scopes=()
    )
    with TestClient(mini_app) as c:
        resp = c.post("/workspaces/ws_other/select")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# supabase_repos.py: visibility filter in _worker_rows
# ---------------------------------------------------------------------------

def test_worker_rows_applies_visibility_filter_for_member(monkeypatch):
    """Non-admin member gets OR filter: own workers + shared."""
    import apps.api.db.supabase_repos as repos_mod
    import apps.api.auth.workspace_context as ctx

    ctx.set_active_workspace_id("ws_1")
    ctx.set_active_member_role("member")

    chain = MagicMock()
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.or_.return_value = chain
    chain.order.return_value = chain
    resp = MagicMock()
    resp.data = []
    chain.execute.return_value = resp

    client = MagicMock()
    client.table.return_value = chain
    monkeypatch.setattr(repos_mod, "get_supabase_service_client", lambda: client)

    repo = repos_mod.SupabaseWorkerRepository(client=client)
    repo._worker_rows(user_id="user-1")

    # Confirm .or_() was called with the visibility filter
    chain.or_.assert_called_once()
    filter_arg = chain.or_.call_args[0][0]
    assert "user_id.eq.user-1" in filter_arg
    assert "visibility.eq.shared" in filter_arg

    # cleanup
    ctx.set_active_workspace_id(None)
    ctx.set_active_member_role(None)


def test_worker_rows_keeps_can_view_filter_for_admin(monkeypatch):
    """Admin inventory is separate; worker read APIs stay can_view-scoped."""
    import apps.api.db.supabase_repos as repos_mod
    import apps.api.auth.workspace_context as ctx

    ctx.set_active_workspace_id("ws_1")
    ctx.set_active_member_role("admin")

    chain = MagicMock()
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.or_.return_value = chain
    chain.order.return_value = chain
    resp = MagicMock()
    resp.data = []
    chain.execute.return_value = resp

    client = MagicMock()
    client.table.return_value = chain
    monkeypatch.setattr(repos_mod, "get_supabase_service_client", lambda: client)

    repo = repos_mod.SupabaseWorkerRepository(client=client)
    repo._worker_rows(user_id="admin-user")

    chain.or_.assert_called_once()
    filter_arg = chain.or_.call_args[0][0]
    assert "user_id.eq.admin-user" in filter_arg
    assert "visibility.eq.shared" in filter_arg

    ctx.set_active_workspace_id(None)
    ctx.set_active_member_role(None)


def test_asset_access_worker_lookup_is_workspace_scoped(monkeypatch):
    """Permission lookup cannot resolve a worker outside the active workspace."""
    import apps.api.db.supabase_repos as repos_mod
    import apps.api.auth.workspace_context as ctx

    ctx.set_active_workspace_id("ws_current")
    ctx.set_active_member_role("member")

    client = _make_supabase_client(
        {
            "id": "private-other-workspace",
            "user_id": "other-user",
            "workspace_id": "ws_other",
            "visibility": "private",
        }
    )
    monkeypatch.setattr(repos_mod, "get_supabase_service_client", lambda: client)

    repo = repos_mod.SupabaseAssetAccessRepository()
    repo._asset_row(asset_type="worker", asset_id="private-other-workspace", workspace_id="ws_current")

    chain = client.table.return_value
    assert call("workspace_id", "ws_current") in chain.eq.call_args_list

    ctx.set_active_workspace_id(None)
    ctx.set_active_member_role(None)


def test_asset_access_private_cross_owner_admin_cannot_share_without_view():
    from apps.api.db.supabase_repos import SupabaseAssetAccessRepository

    perms = SupabaseAssetAccessRepository._compute(
        owner_id="member-user",
        visibility="private",
        role="admin",
        user_id="admin-user",
    )

    assert perms["can_view"] is False
    assert perms["can_share"] is False


# ---------------------------------------------------------------------------
# supabase_repos.py: admin access log in get()
# ---------------------------------------------------------------------------

def test_admin_access_log_written_for_private_member_worker(monkeypatch):
    """get() with admin role + private worker not owned by admin → log row inserted."""
    import apps.api.db.supabase_repos as repos_mod
    import apps.api.auth.workspace_context as ctx

    ctx.set_active_workspace_id("ws_1")
    ctx.set_active_member_role("admin")

    private_worker_row = {
        "id": "wkr-member",
        "user_id": "member-user",  # NOT the admin
        "name": "Secret Worker",
        "visibility": "private",
        "skill_version_id": None,
        "trigger_type": "manual",
        "workspace_id": "ws_1",
    }
    dummy_record = {"id": "wkr-member", "name": "Secret Worker", "visibility": "private"}

    client = MagicMock()
    monkeypatch.setattr(repos_mod, "get_supabase_service_client", lambda: client)
    # Patch _worker_record_from_rows so manifest parsing is bypassed.
    monkeypatch.setattr(repos_mod, "_worker_record_from_rows", lambda row, sv: dummy_record)

    repo = repos_mod.SupabaseWorkerRepository(client=client)
    repo._worker_rows = lambda **kw: [private_worker_row]
    repo._skill_versions_by_id = lambda ids: {}

    repo.get(user_id="admin-user", worker_id="wkr-member")

    # admin_access_log insert: client.table("admin_access_log").insert(...).execute()
    table_calls = [c[0][0] for c in client.table.call_args_list]
    assert "admin_access_log" in table_calls

    ctx.set_active_workspace_id(None)
    ctx.set_active_member_role(None)


def test_admin_access_log_not_written_for_owned_worker(monkeypatch):
    """get() with admin role but admin IS the owner → no log."""
    import apps.api.db.supabase_repos as repos_mod
    import apps.api.auth.workspace_context as ctx

    ctx.set_active_workspace_id("ws_1")
    ctx.set_active_member_role("admin")

    own_worker_row = {
        "id": "wkr-own",
        "user_id": "admin-user",  # same as caller
        "name": "My Worker",
        "visibility": "private",
        "skill_version_id": None,
        "trigger_type": "manual",
        "workspace_id": "ws_1",
    }
    dummy_record = {"id": "wkr-own", "name": "My Worker", "visibility": "private"}

    client = MagicMock()
    monkeypatch.setattr(repos_mod, "get_supabase_service_client", lambda: client)
    monkeypatch.setattr(repos_mod, "_worker_record_from_rows", lambda row, sv: dummy_record)

    repo = repos_mod.SupabaseWorkerRepository(client=client)
    repo._worker_rows = lambda **kw: [own_worker_row]
    repo._skill_versions_by_id = lambda ids: {}

    repo.get(user_id="admin-user", worker_id="wkr-own")

    table_calls = [c[0][0] for c in client.table.call_args_list]
    assert "admin_access_log" not in table_calls

    ctx.set_active_workspace_id(None)
    ctx.set_active_member_role(None)
