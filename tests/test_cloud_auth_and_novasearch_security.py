from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from apps.api.auth import supabase_provider
from apps.api.auth.supabase_provider import SupabaseAuthProvider
from apps.api.auth.workspace_context import active_workspace
from apps.api.routes import novasearch


def _request(headers: dict[str, str] | None = None) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
            "query_string": b"",
        }
    )


def test_workspace_bound_pat_is_rejected_when_member_role_cannot_be_proven(monkeypatch):
    provider = object.__new__(SupabaseAuthProvider)
    monkeypatch.setattr(supabase_provider, "_resolve_role", lambda **_kwargs: None)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            provider._build_pat_context(
                user_id="user_removed",
                workspace_id="ws_a",
                request=_request(),
            )
        )

    assert exc.value.status_code == 403


def test_workspace_bound_pat_uses_resolved_role(monkeypatch):
    provider = object.__new__(SupabaseAuthProvider)
    monkeypatch.setattr(supabase_provider, "_resolve_role", lambda **_kwargs: "member")

    ctx = asyncio.run(
        provider._build_pat_context(
            user_id="user_member",
            workspace_id="ws_a",
            request=_request(),
        )
    )

    assert ctx.user_id == "user_member"
    assert ctx.role == "member"


def test_novasearch_match_result_rejects_other_workspace_or_user():
    novasearch._MATCH_JOBS.clear()
    novasearch._MATCH_JOBS["job_a"] = {
        "status": "done",
        "created_at": time.time(),
        "workspace_id": "ws_a",
        "user_id": "user_a",
        "result": {"rows": []},
        "error": None,
    }

    with active_workspace("ws_b", "admin"):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                novasearch.match_candidates_result(
                    "job_a",
                    auth=SimpleNamespace(user_id="user_a"),
                )
            )

    assert exc.value.status_code == 404

    with active_workspace("ws_a", "admin"):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                novasearch.match_candidates_result(
                    "job_a",
                    auth=SimpleNamespace(user_id="user_b"),
                )
            )

    assert exc.value.status_code == 404


def test_novasearch_match_result_allows_owner():
    novasearch._MATCH_JOBS.clear()
    novasearch._MATCH_JOBS["job_a"] = {
        "status": "done",
        "created_at": time.time(),
        "workspace_id": "ws_a",
        "user_id": "user_a",
        "result": {"rows": [1]},
        "error": None,
    }

    with active_workspace("ws_a", "admin"):
        result = asyncio.run(
            novasearch.match_candidates_result(
                "job_a",
                auth=SimpleNamespace(user_id="user_a"),
            )
        )

    assert result == {"status": "done", "result": {"rows": [1]}}


def test_novasearch_empty_write_response_returns_controlled_400():
    with pytest.raises(HTTPException) as exc:
        novasearch._first_write_row(SimpleNamespace(data=[]), operation="memory insert")

    assert exc.value.status_code == 400
    assert "memory insert" in str(exc.value.detail)
