from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

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
            "headers": headers,
        }
    )


def test_verify_accepts_valid_supabase_jwt():
    fake_user = SimpleNamespace(
        id="user-123",
        email="user@example.com",
        app_metadata={"scopes": ["workers:read", "workers:write"]},
    )
    get_user = Mock(return_value=SimpleNamespace(user=fake_user))
    fake_client = SimpleNamespace(auth=SimpleNamespace(get_user=get_user))

    provider = SupabaseAuthProvider(client=fake_client)
    context = asyncio.run(provider.verify(_request("Bearer valid-jwt")))

    get_user.assert_called_once_with("valid-jwt")
    assert context.user_id == "user-123"
    assert context.email == "user@example.com"
    assert context.scopes == ("workers:read", "workers:write")


def test_verify_rejects_invalid_supabase_jwt():
    get_user = Mock(side_effect=RuntimeError("jwt invalid"))
    fake_client = SimpleNamespace(auth=SimpleNamespace(get_user=get_user))
    provider = SupabaseAuthProvider(client=fake_client)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(provider.verify(_request("Bearer invalid-jwt")))

    get_user.assert_called_once_with("invalid-jwt")
    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "unauthorized"
