"""Smoke tests for SupabaseAuthProvider.verify reading X-Workeros-Workspace.

These are lightweight assertions on resolve_active_workspace() invocation and
ownership-fallback semantics; they monkeypatch _verify_jwt + workspace_repo
to avoid a real Supabase round-trip.
"""

from __future__ import annotations

import asyncio
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import apps.api.auth.supabase_provider as supa_module
from apps.api.auth.supabase_provider import (
    ACTIVE_WORKSPACE_COOKIE,
    ACTIVE_WORKSPACE_HEADER,
    SupabaseAuthProvider,
)


def _request(*, cookie: str | None = None, header: str | None = None) -> Request:
    raw_headers: list[tuple[bytes, bytes]] = [(b"authorization", b"Bearer test-jwt")]
    if cookie:
        raw_headers.append((b"cookie", f"{ACTIVE_WORKSPACE_COOKIE}={cookie}".encode()))
    if header is not None:
        raw_headers.append((ACTIVE_WORKSPACE_HEADER.encode(), header.encode()))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/workers",
            "query_string": b"",
            "headers": raw_headers,
        }
    )


@pytest.fixture
def _patched(monkeypatch):
    monkeypatch.setattr(
        supa_module,
        "_verify_jwt",
        lambda token, supabase_url: {"sub": "user-1", "email": "u@example.com"},
    )
    monkeypatch.setattr(
        supa_module,
        "get_cloud_settings",
        lambda: type("S", (), {"supabase_url": "https://test.supabase.co"})(),
    )
    resolver = Mock(return_value={"id": "ws_default"})
    monkeypatch.setattr(supa_module.workspace_repo, "resolve_active_workspace", resolver)
    setter = Mock()
    monkeypatch.setattr(supa_module, "set_active_workspace_id", setter)
    return resolver, setter


def test_header_takes_precedence_over_cookie(_patched):
    resolver, setter = _patched
    provider = SupabaseAuthProvider()
    ctx = asyncio.run(provider.verify(_request(cookie="ws_cookie", header="ws_header")))
    resolver.assert_called_once_with(
        user_id="user-1",
        email="u@example.com",
        requested_id="ws_header",
    )
    setter.assert_called_once_with("ws_default")
    assert ctx.user_id == "user-1"


def test_cookie_used_when_header_absent(_patched):
    resolver, _ = _patched
    provider = SupabaseAuthProvider()
    asyncio.run(provider.verify(_request(cookie="ws_cookie_only", header=None)))
    resolver.assert_called_once_with(
        user_id="user-1",
        email="u@example.com",
        requested_id="ws_cookie_only",
    )


def test_empty_header_falls_back_to_cookie(_patched):
    resolver, _ = _patched
    provider = SupabaseAuthProvider()
    asyncio.run(provider.verify(_request(cookie="ws_cookie_only", header="   ")))
    resolver.assert_called_once_with(
        user_id="user-1",
        email="u@example.com",
        requested_id="ws_cookie_only",
    )


def test_no_header_or_cookie_passes_none(_patched):
    resolver, _ = _patched
    provider = SupabaseAuthProvider()
    asyncio.run(provider.verify(_request(cookie=None, header=None)))
    resolver.assert_called_once_with(
        user_id="user-1",
        email="u@example.com",
        requested_id=None,
    )


def test_resolver_exception_falls_back_to_none(monkeypatch):
    monkeypatch.setattr(
        supa_module,
        "_verify_jwt",
        lambda token, supabase_url: {"sub": "user-1", "email": None},
    )
    monkeypatch.setattr(
        supa_module,
        "get_cloud_settings",
        lambda: type("S", (), {"supabase_url": "https://test.supabase.co"})(),
    )
    monkeypatch.setattr(
        supa_module.workspace_repo,
        "resolve_active_workspace",
        Mock(side_effect=RuntimeError("supabase down")),
    )
    setter = Mock()
    monkeypatch.setattr(supa_module, "set_active_workspace_id", setter)

    provider = SupabaseAuthProvider()
    ctx = asyncio.run(provider.verify(_request(header="ws_x")))
    # When resolution fails, contextvar gets None and the request still succeeds.
    setter.assert_called_once_with(None)
    assert ctx.user_id == "user-1"


def test_missing_bearer_raises_401(monkeypatch):
    monkeypatch.setattr(
        supa_module,
        "get_cloud_settings",
        lambda: type("S", (), {"supabase_url": "https://test.supabase.co"})(),
    )
    provider = SupabaseAuthProvider()
    req = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/workers",
            "query_string": b"",
            "headers": [],
        }
    )
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(provider.verify(req))
    assert exc_info.value.status_code == 401
