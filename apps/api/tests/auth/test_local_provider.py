from __future__ import annotations

import asyncio
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from auth.local import SharedSecretAuthProvider


def _request(headers: dict[str, str] | None = None) -> Request:
    raw_headers = [
        (key.lower().encode("latin-1"), value.encode("latin-1"))
        for key, value in (headers or {}).items()
    ]
    return Request({"type": "http", "headers": raw_headers})


def test_valid_secret_returns_auth_context(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")

    provider = SharedSecretAuthProvider()

    ctx = asyncio.run(provider.verify(_request({"x-floom-secret": "test-secret"})))

    assert ctx.user_id == "federico"
    assert ctx.email is None
    assert ctx.scopes == ("admin",)


def test_configured_local_user_id(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "local-user")

    provider = SharedSecretAuthProvider()

    ctx = asyncio.run(provider.verify(_request({"x-floom-secret": "test-secret"})))

    assert ctx.user_id == "local-user"


def test_user_header_scope_is_opt_in(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")

    provider = SharedSecretAuthProvider()

    ctx = asyncio.run(
        provider.verify(
            _request({"x-floom-secret": "test-secret", "x-floom-user": "user-a"})
        )
    )

    assert ctx.user_id == "user-a"


def test_missing_header_returns_401(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")

    provider = SharedSecretAuthProvider()

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(provider.verify(_request()))

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "unauthorized"


def test_wrong_secret_returns_401(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")

    provider = SharedSecretAuthProvider()

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(provider.verify(_request({"x-floom-secret": "wrong-secret"})))

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "unauthorized"


def test_trailing_space_secret_returns_401(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")

    provider = SharedSecretAuthProvider()

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(provider.verify(_request({"x-floom-secret": "test-secret "})))

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "unauthorized"


def test_compare_digest_is_used(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    compare_digest = Mock(return_value=True)
    monkeypatch.setattr("auth.local.hmac.compare_digest", compare_digest)

    provider = SharedSecretAuthProvider()
    ctx = asyncio.run(provider.verify(_request({"x-floom-secret": "test-secret"})))

    compare_digest.assert_called_once_with(b"test-secret", b"test-secret")
    assert ctx.user_id == "federico"
