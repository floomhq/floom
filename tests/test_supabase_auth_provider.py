from __future__ import annotations

import asyncio
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from apps.api.auth import supabase_provider
from apps.api.auth.supabase_provider import SupabaseAuthProvider


def _request(authorization: str | None) -> Request:
    headers = []
    if authorization is not None:
        headers.append((b"authorization", authorization.encode()))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/workers",
            "query_string": b"",
            "headers": headers,
        }
    )


def test_verify_accepts_valid_supabase_jwt(monkeypatch):
    def fake_verify_jwt(token: str, supabase_url: str) -> dict:
        assert token == "valid-jwt"
        assert supabase_url
        return {
            "sub": "user-123",
            "email": "user@example.com",
            "app_metadata": {"scopes": ["workers:read", "workers:write"]},
        }

    monkeypatch.setattr(supabase_provider, "_verify_jwt", fake_verify_jwt)
    monkeypatch.setattr(
        supabase_provider.workspace_repo,
        "resolve_active_workspace",
        lambda **_: {"id": "ws_user123"},
    )

    provider = SupabaseAuthProvider()
    context = asyncio.run(provider.verify(_request("Bearer valid-jwt")))

    assert context.user_id == "user-123"
    assert context.email == "user@example.com"
    assert context.scopes == ("workers:read", "workers:write")


def test_verify_rejects_invalid_supabase_jwt(monkeypatch):
    def fake_verify_jwt(token: str, supabase_url: str) -> dict:
        assert token == "invalid-jwt"
        assert supabase_url
        raise HTTPException(status_code=401, detail="unauthorized")

    monkeypatch.setattr(supabase_provider, "_verify_jwt", fake_verify_jwt)
    provider = SupabaseAuthProvider()

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(provider.verify(_request("Bearer invalid-jwt")))

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "unauthorized"


# ---------------------------------------------------------------------------
# SECURITY REGRESSION (A-03): non-admin members must NOT inherit admin.
#
# The engine AuthContext.role DEFAULTS to "admin" and engine admin gates read
# auth.is_admin off the returned context. If the cloud provider omits role on
# its real-auth return paths, every member is silently treated as admin. These
# tests pin role/is_admin on the returned context for both the JWT and PAT
# paths so the bypass cannot regress.
# ---------------------------------------------------------------------------


def test_verify_member_jwt_is_not_admin(monkeypatch):
    """A non-owner workspace member resolves to role='member', is_admin=False."""

    def fake_verify_jwt(token: str, supabase_url: str) -> dict:
        return {"sub": "member-1", "email": "member@example.com"}

    monkeypatch.setattr(supabase_provider, "_verify_jwt", fake_verify_jwt)
    # Workspace is owned by a DIFFERENT user, caller is a plain member.
    monkeypatch.setattr(
        supabase_provider.workspace_repo,
        "resolve_active_workspace",
        lambda **_: {"id": "ws_owned_by_other", "owner_user_id": "owner-9"},
    )
    monkeypatch.setattr(
        supabase_provider.workspace_repo,
        "get_member_role",
        lambda **_: "member",
    )

    provider = SupabaseAuthProvider()
    ctx = asyncio.run(provider.verify(_request("Bearer valid-jwt")))

    assert ctx.role == "member"
    assert ctx.is_admin is False


def test_verify_owner_jwt_is_admin(monkeypatch):
    """The workspace owner resolves to role='admin', is_admin=True."""

    def fake_verify_jwt(token: str, supabase_url: str) -> dict:
        return {"sub": "owner-9", "email": "owner@example.com"}

    monkeypatch.setattr(supabase_provider, "_verify_jwt", fake_verify_jwt)
    monkeypatch.setattr(
        supabase_provider.workspace_repo,
        "resolve_active_workspace",
        lambda **_: {"id": "ws_owned", "owner_user_id": "owner-9"},
    )

    provider = SupabaseAuthProvider()
    ctx = asyncio.run(provider.verify(_request("Bearer valid-jwt")))

    assert ctx.role == "admin"
    assert ctx.is_admin is True


def test_verify_jwt_role_fails_closed_to_member_on_resolve_error(monkeypatch):
    """If workspace/role resolution fails, fail closed to member (never admin)."""

    def fake_verify_jwt(token: str, supabase_url: str) -> dict:
        return {"sub": "user-x", "email": "x@example.com"}

    def boom(**_):
        raise RuntimeError("transient supabase error")

    monkeypatch.setattr(supabase_provider, "_verify_jwt", fake_verify_jwt)
    monkeypatch.setattr(
        supabase_provider.workspace_repo, "resolve_active_workspace", boom
    )

    provider = SupabaseAuthProvider()
    ctx = asyncio.run(provider.verify(_request("Bearer valid-jwt")))

    assert ctx.role == "member"
    assert ctx.is_admin is False


def _pat_request(workspace_header: str | None = None) -> Request:
    headers = [(b"x-floom-token", b"floom_membertoken")]
    if workspace_header is not None:
        headers.append((b"x-workeros-workspace", workspace_header.encode()))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/workers",
            "query_string": b"",
            "headers": headers,
        }
    )


def test_verify_member_pat_is_not_admin(monkeypatch):
    """A workspace-scoped PAT for a non-owner member must not be admin."""
    # Seed the PAT cache so no DB lookup is needed: hash -> (user_id, ws, ts).
    import time as _time

    token_hash = supabase_provider._hash_token("floom_membertoken")
    with supabase_provider._cache_lock:
        supabase_provider._pat_cache[token_hash] = (
            "member-1",
            "ws_owned_by_other",
            _time.time(),
        )
    # _resolve_role: workspace owned by someone else, caller is a member.
    monkeypatch.setattr(
        supabase_provider.workspace_repo,
        "get",
        lambda **_: {"id": "ws_owned_by_other", "owner_user_id": "owner-9"},
    )
    monkeypatch.setattr(
        supabase_provider.workspace_repo,
        "get_member_role",
        lambda **_: "member",
    )

    provider = SupabaseAuthProvider()
    ctx = asyncio.run(provider.verify(_pat_request(workspace_header="ws_owned_by_other")))

    assert ctx.role == "member"
    assert ctx.is_admin is False
    assert ctx.auth_method == "pat"
