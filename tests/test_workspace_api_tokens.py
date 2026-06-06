from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import apps.api.auth.supabase_provider as supa_module
from apps.api.auth.supabase_provider import (
    ACTIVE_WORKSPACE_HEADER,
    PAT_HEADER,
    SupabaseAuthProvider,
)


MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "supabase" / "migrations"


def _pat_request(*, token: str = "floom_test", workspace: str | None = None) -> Request:
    headers: list[tuple[bytes, bytes]] = [(PAT_HEADER.encode(), token.encode())]
    if workspace is not None:
        headers.append((ACTIVE_WORKSPACE_HEADER.encode(), workspace.encode()))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/workers",
            "query_string": b"",
            "headers": headers,
        }
    )


class _Repo:
    def __init__(self) -> None:
        self.touch = Mock()

    def get_by_hash(self, token_hash: str):
        return {
            "id": "tok_1",
            "user_id": "user-1",
            "workspace_id": "ws_token",
            "name": "default",
        }


def test_pat_auth_scopes_request_to_token_workspace(monkeypatch):
    repo = _Repo()
    monkeypatch.setattr(
        "apps.api.db.supabase_repos.SupabaseApiTokenRepository",
        lambda: repo,
    )
    setter = Mock()
    monkeypatch.setattr(supa_module, "set_active_workspace_id", setter)
    # _resolve_role() now runs for PATs; stub the workspace lookups so the
    # provider does not reach live Supabase with the non-UUID test user id.
    monkeypatch.setattr(
        supa_module.workspace_repo,
        "get",
        lambda *, workspace_id: {"id": workspace_id, "owner_user_id": "user-1"},
    )
    monkeypatch.setattr(
        supa_module.workspace_repo,
        "get_member_role",
        lambda *, workspace_id, user_id: None,
    )

    provider = SupabaseAuthProvider()
    ctx = asyncio.run(provider.verify(_pat_request()))

    assert ctx.user_id == "user-1"
    assert ctx.scopes == ("api",)
    setter.assert_called_once_with("ws_token")
    repo.touch.assert_called_once_with(token_id="tok_1")


def test_pat_auth_rejects_different_requested_workspace(monkeypatch):
    monkeypatch.setattr(
        "apps.api.db.supabase_repos.SupabaseApiTokenRepository",
        lambda: _Repo(),
    )

    provider = SupabaseAuthProvider()
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(provider.verify(_pat_request(workspace="ws_other")))

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "token is not valid for this workspace"


def test_workspace_api_token_migration_adds_workspace_scope():
    text = (MIGRATIONS_DIR / "0015_workspace_api_tokens.sql").read_text()

    assert "add column if not exists workspace_id" in text
    assert "alter table public.api_tokens alter column workspace_id set not null" in text
    assert "api_tokens_workspace_id_idx" in text
    assert "Users manage own workspace tokens" in text
