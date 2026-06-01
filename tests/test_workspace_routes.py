from __future__ import annotations

import asyncio

from starlette.requests import Request

import apps.api.routes.workspaces as workspace_routes
from apps.api.auth.supabase_provider import ACTIVE_WORKSPACE_COOKIE, ACTIVE_WORKSPACE_HEADER
from auth.context import AuthContext


def _request(*, cookie: str | None = None, header: str | None = None) -> Request:
    raw_headers: list[tuple[bytes, bytes]] = []
    if cookie:
        raw_headers.append((b"cookie", f"{ACTIVE_WORKSPACE_COOKIE}={cookie}".encode()))
    if header is not None:
        raw_headers.append((ACTIVE_WORKSPACE_HEADER.encode(), header.encode()))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/workspaces",
            "headers": raw_headers,
        }
    )


def test_list_workspaces_uses_header_for_active_id(monkeypatch):
    rows = [
        {"id": "ws_a", "name": "A", "owner_user_id": "user-1", "created_at": "2026-01-01"},
        {"id": "ws_b", "name": "B", "owner_user_id": "user-1", "created_at": "2026-01-02"},
    ]
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "list_for_owner",
        lambda owner_user_id: rows,
    )

    result = asyncio.run(
        workspace_routes.list_workspaces(
            _request(cookie="ws_a", header="ws_b"),
            AuthContext(user_id="user-1", email="u@example.com", scopes=()),
        )
    )

    assert result.active_id == "ws_b"


def test_list_workspaces_falls_back_to_cookie_when_header_empty(monkeypatch):
    rows = [
        {"id": "ws_a", "name": "A", "owner_user_id": "user-1", "created_at": "2026-01-01"},
        {"id": "ws_b", "name": "B", "owner_user_id": "user-1", "created_at": "2026-01-02"},
    ]
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "list_for_owner",
        lambda owner_user_id: rows,
    )

    result = asyncio.run(
        workspace_routes.list_workspaces(
            _request(cookie="ws_b", header="   "),
            AuthContext(user_id="user-1", email="u@example.com", scopes=()),
        )
    )

    assert result.active_id == "ws_b"

