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
