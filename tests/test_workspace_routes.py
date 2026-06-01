from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import apps.api.routes.workspaces as workspace_routes
from apps.api.auth.workspace_context import active_workspace
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


def test_create_share_link_returns_token_once(monkeypatch):
    captured = {}

    def create_share_link(**kwargs):
        captured.update(kwargs)
        return (
            {
                "id": "wsl_1",
                "workspace_id": "ws_a",
                "created_at": "2026-01-01T00:00:00+00:00",
                "expires_at": "2026-01-08T00:00:00+00:00",
                "max_uses": 3,
                "use_count": 0,
            },
            "wst_raw",
        )

    monkeypatch.setattr(workspace_routes.workspace_repo, "create_share_link", create_share_link)
    monkeypatch.setattr(
        workspace_routes,
        "get_cloud_settings",
        lambda: SimpleNamespace(frontend_url="https://workeros.floom.dev/app"),
    )

    result = asyncio.run(
        workspace_routes.create_share_link(
            "ws_a",
            workspace_routes.CreateShareLinkRequest(expires_in_days=7, max_uses=3),
            AuthContext(user_id="user-1", email="u@example.com", scopes=()),
        )
    )

    assert captured["owner_user_id"] == "user-1"
    assert captured["workspace_id"] == "ws_a"
    assert result.token == "wst_raw"
    assert result.url == "https://workeros.floom.dev/app/workspace/share/wst_raw"


def test_create_share_link_hides_non_owner_workspace(monkeypatch):
    def create_share_link(**_kwargs):
        raise PermissionError("workspace not found")

    monkeypatch.setattr(workspace_routes.workspace_repo, "create_share_link", create_share_link)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            workspace_routes.create_share_link(
                "ws_other",
                workspace_routes.CreateShareLinkRequest(),
                AuthContext(user_id="user-1", email="u@example.com", scopes=()),
            )
        )

    assert exc_info.value.status_code == 404


def test_preview_share_rejects_revoked_link(monkeypatch):
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "resolve_share_token",
        lambda token: {
            "id": "wsl_1",
            "workspace_id": "ws_a",
            "created_at": "2026-01-01T00:00:00+00:00",
            "revoked_at": "2026-01-02T00:00:00+00:00",
            "workspace": {
                "id": "ws_a",
                "name": "Shared",
                "owner_user_id": "owner-1",
                "created_at": "2026-01-01",
            },
        },
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(workspace_routes.preview_share("wst_raw"))

    assert exc_info.value.status_code == 410
    assert exc_info.value.detail == "share link revoked"


def test_import_share_uses_existing_engine_template_pipeline(monkeypatch):
    calls = []

    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "resolve_share_token",
        lambda token: {
            "id": "wsl_1",
            "workspace_id": "ws_source",
            "created_by_user_id": "owner-1",
            "created_at": "2026-01-01T00:00:00+00:00",
            "use_count": 0,
            "workspace": {
                "id": "ws_source",
                "name": "Shared",
                "owner_user_id": "owner-1",
                "created_at": "2026-01-01",
            },
        },
    )
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "increment_share_use",
        lambda **kwargs: calls.append(("increment", kwargs)),
    )

    def export_workspace(*, auth, repos):
        calls.append(("export", auth.user_id))
        return SimpleNamespace(body=b"zip-bytes")

    async def import_workspace(*, bundle, request, auth, repos):
        calls.append(("import", bundle.filename, auth.user_id))
        return SimpleNamespace(
            workers_imported=["worker-a"],
            contexts_imported=["brain-a"],
            skipped=[],
            id_remaps={},
            required_secrets=["OPENAI_API_KEY"],
            required_connections=["gmail"],
            workspace_md_present=True,
        )

    monkeypatch.setitem(
        sys.modules,
        "main",
        SimpleNamespace(
            export_workspace=export_workspace,
            import_workspace=import_workspace,
            get_repositories=lambda: object(),
        ),
    )

    with active_workspace("ws_target"):
        result = asyncio.run(
            workspace_routes.import_share(
                "wst_raw",
                AuthContext(user_id="user-2", email="u2@example.com", scopes=()),
            )
        )

    assert calls[0] == ("export", "owner-1")
    assert calls[1] == ("import", "workspace-template.zip", "user-2")
    assert calls[2] == ("increment", {"link_id": "wsl_1", "use_count": 0})
    assert result.source_workspace_id == "ws_source"
    assert result.target_workspace_id == "ws_target"
    assert result.workers_imported == ["worker-a"]
    assert result.required_connections == ["gmail"]
