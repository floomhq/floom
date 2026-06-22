from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi import Response
from starlette.requests import Request

import apps.api.routes.workspaces as workspace_routes
from apps.api.auth.workspace_context import active_workspace
from apps.api.auth.supabase_provider import ACTIVE_WORKSPACE_COOKIE, ACTIVE_WORKSPACE_HEADER
from apps.api.db import workspaces as workspace_repo
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
    # The members feature added a list_member_workspaces() call to the route;
    # patch it so the test does not hit live Supabase with a non-UUID user id.
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "list_member_workspaces",
        lambda user_id: [],
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
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "list_member_workspaces",
        lambda user_id: [],
    )

    result = asyncio.run(
        workspace_routes.list_workspaces(
            _request(cookie="ws_b", header="   "),
            AuthContext(user_id="user-1", email="u@example.com", scopes=()),
        )
    )

    assert result.active_id == "ws_b"


def test_list_workspaces_scoped_pat_only_returns_token_workspace(monkeypatch):
    rows = [
        {"id": "ws_a", "name": "A", "owner_user_id": "user-1", "created_at": "2026-01-01"},
        {"id": "ws_b", "name": "B", "owner_user_id": "user-1", "created_at": "2026-01-02"},
    ]
    monkeypatch.setattr(workspace_routes.workspace_repo, "list_for_owner", lambda owner_user_id: rows)
    monkeypatch.setattr(workspace_routes.workspace_repo, "list_member_workspaces", lambda user_id: [])

    with active_workspace("ws_a", "member"):
        result = asyncio.run(
            workspace_routes.list_workspaces(
                _request(),
                AuthContext(user_id="user-1", email="u@example.com", scopes=(), auth_method="pat"),
            )
        )

    assert result.active_id == "ws_a"
    assert [ws.id for ws in result.workspaces] == ["ws_a"]
    assert result.workspaces[0].role == "member"


def test_scoped_pat_cannot_select_other_workspace(monkeypatch):
    with active_workspace("ws_a", "admin"):
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(
                workspace_routes.select_workspace(
                    "ws_b",
                    AuthContext(user_id="user-1", email="u@example.com", scopes=(), auth_method="pat"),
                )
            )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "token is not valid for this workspace"


def test_pat_workspace_create_returns_replacement_token(monkeypatch):
    created = {
        "id": "ws_new",
        "name": "New workspace",
        "owner_user_id": "user-1",
        "created_at": "2026-01-01",
    }
    token_calls = []
    delete_calls = []
    events = []

    class FakeTokenRepo:
        def delete_cli_workspace_tokens_for_user(self, **kwargs):
            events.append("delete")
            delete_calls.append(kwargs)
            return 1

        def create(self, **kwargs):
            events.append("create")
            token_calls.append(kwargs)
            return {"id": "tok_1", **kwargs}

    monkeypatch.setattr(workspace_routes.workspace_repo, "create", lambda owner_user_id, name: created)
    monkeypatch.setattr(workspace_routes, "SupabaseApiTokenRepository", lambda: FakeTokenRepo())
    monkeypatch.setattr(workspace_routes, "_new_pat", lambda: "floom_replacement")
    monkeypatch.setattr(workspace_routes, "_hash_pat", lambda raw: f"hash:{raw}")

    response = asyncio.run(
        workspace_routes.create_workspace(
            workspace_routes.CreateWorkspaceRequest(name="New workspace"),
            Response(),
            AuthContext(user_id="user-1", email="u@example.com", scopes=(), auth_method="pat"),
        )
    )

    assert response.id == "ws_new"
    assert response.api_token == "floom_replacement"
    assert response.header == "x-floom-token"
    assert events == ["create", "delete"]
    assert delete_calls == [{"user_id": "user-1", "exclude_token_hash": "hash:floom_replacement"}]
    assert token_calls == [
        {
            "user_id": "user-1",
            "name": "CLI workspace: New workspace",
            "token_hash": "hash:floom_replacement",
            "workspace_id": "ws_new",
        }
    ]


def test_browser_workspace_create_does_not_return_raw_token(monkeypatch):
    created = {
        "id": "ws_new",
        "name": "New workspace",
        "owner_user_id": "user-1",
        "created_at": "2026-01-01",
    }

    monkeypatch.setattr(workspace_routes.workspace_repo, "create", lambda owner_user_id, name: created)

    response = asyncio.run(
        workspace_routes.create_workspace(
            workspace_routes.CreateWorkspaceRequest(name="New workspace"),
            Response(),
            AuthContext(user_id="user-1", email="u@example.com", scopes=(), auth_method="jwt"),
        )
    )

    assert response.id == "ws_new"
    assert response.api_token is None
    assert response.header is None


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


def test_transfer_workspace_hides_non_owner_workspace(monkeypatch):
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "get",
        lambda workspace_id: {
            "id": workspace_id,
            "name": "Team",
            "owner_user_id": "owner-2",
            "created_at": "2026-01-01",
        },
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            workspace_routes.transfer_workspace(
                "ws_a",
                workspace_routes.TransferWorkspaceRequest(
                    recipient_email="new@example.com",
                    confirmation="TRANSFER Team",
                ),
                AuthContext(user_id="owner-1", email="owner@example.com", scopes=()),
            )
        )

    assert exc_info.value.status_code == 404


def test_transfer_workspace_requires_existing_recipient(monkeypatch):
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "get",
        lambda workspace_id: {
            "id": workspace_id,
            "name": "Team",
            "owner_user_id": "owner-1",
            "created_at": "2026-01-01",
        },
    )
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "resolve_transfer_recipient",
        lambda **_kwargs: None,
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            workspace_routes.transfer_workspace(
                "ws_a",
                workspace_routes.TransferWorkspaceRequest(
                    recipient_email="missing@example.com",
                    confirmation="TRANSFER Team",
                ),
                AuthContext(user_id="owner-1", email="owner@example.com", scopes=()),
            )
        )

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "recipient not found"


def test_transfer_workspace_requires_exact_confirmation(monkeypatch):
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "get",
        lambda workspace_id: {
            "id": workspace_id,
            "name": "Team Alpha",
            "owner_user_id": "owner-1",
            "created_at": "2026-01-01",
        },
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            workspace_routes.transfer_workspace(
                "ws_a",
                workspace_routes.TransferWorkspaceRequest(
                    recipient_user_id="owner-2",
                    confirmation="TRANSFER Team",
                ),
                AuthContext(user_id="owner-1", email="owner@example.com", scopes=()),
            )
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail["required"] == "TRANSFER Team Alpha"


def test_transfer_workspace_requires_active_member_recipient(monkeypatch):
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "get",
        lambda workspace_id: {
            "id": workspace_id,
            "name": "Team",
            "owner_user_id": "owner-1",
            "created_at": "2026-01-01",
        },
    )
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "resolve_transfer_recipient",
        lambda **_kwargs: {"id": "owner-2", "email": "new@example.com"},
    )
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "get_member_role",
        lambda *, workspace_id, user_id: None,
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            workspace_routes.transfer_workspace(
                "ws_a",
                workspace_routes.TransferWorkspaceRequest(
                    recipient_email="new@example.com",
                    confirmation="TRANSFER Team",
                ),
                AuthContext(user_id="owner-1", email="owner@example.com", scopes=()),
            )
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "recipient must be an active workspace member"


def test_transfer_workspace_flips_owner_access_and_reports_revoked_pats(monkeypatch):
    state = {
        "workspace": {
            "id": "ws_a",
            "name": "Team",
            "owner_user_id": "owner-1",
            "created_at": "2026-01-01",
        }
    }

    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "get",
        lambda workspace_id: dict(state["workspace"]) if workspace_id == "ws_a" else None,
    )
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "resolve_transfer_recipient",
        lambda **_kwargs: {"id": "owner-2", "email": "new@example.com"},
    )

    def transfer_ownership(**kwargs):
        assert kwargs["owner_user_id"] == "owner-1"
        assert kwargs["workspace_id"] == "ws_a"
        assert kwargs["recipient_user_id"] == "owner-2"
        state["workspace"]["owner_user_id"] = "owner-2"
        return {
            "workspace": dict(state["workspace"]),
            "previous_owner_user_id": "owner-1",
            "new_owner_user_id": "owner-2",
            "revoked_api_tokens": 2,
            "retained_authority": list(kwargs["retained_authority"]),
            "audit_event_id": "wte_1",
        }

    monkeypatch.setattr(workspace_routes.workspace_repo, "transfer_ownership", transfer_ownership)
    # After transfer, select_workspace() checks membership for the now-former
    # owner (no longer the owner_user_id), which would otherwise hit live
    # Supabase. The old owner is not a member, so it resolves to None.
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "get_member_role",
        lambda *, workspace_id, user_id: "admin" if user_id == "owner-2" else None,
    )

    result = asyncio.run(
        workspace_routes.transfer_workspace(
            "ws_a",
            workspace_routes.TransferWorkspaceRequest(
                recipient_email="new@example.com",
                confirmation="TRANSFER Team",
            ),
            AuthContext(user_id="owner-1", email="owner@example.com", scopes=()),
        )
    )

    assert result.workspace.owner_user_id == "owner-2"
    assert result.revoked_api_tokens == 2
    assert "secrets" in result.retained_authority
    with pytest.raises(HTTPException) as old_owner_exc:
        asyncio.run(
            workspace_routes.select_workspace(
                "ws_a",
                AuthContext(user_id="owner-1", email="owner@example.com", scopes=()),
            )
        )
    assert old_owner_exc.value.status_code == 404

    response = asyncio.run(
        workspace_routes.select_workspace(
            "ws_a",
            AuthContext(user_id="owner-2", email="new@example.com", scopes=()),
        )
    )
    assert response.status_code == 200


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
        lambda **kwargs: calls.append(("increment", kwargs)) or True,
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

    assert calls[0] == ("increment", {"link_id": "wsl_1", "use_count": 0, "max_uses": None})
    assert calls[1] == ("export", "owner-1")
    assert calls[2] == ("import", "workspace-template.zip", "user-2")
    assert result.source_workspace_id == "ws_source"
    assert result.target_workspace_id == "ws_target"
    assert result.workers_imported == ["worker-a"]
    assert result.required_connections == ["gmail"]


def test_import_share_rejects_when_use_reservation_loses_race(monkeypatch):
    monkeypatch.setattr(workspace_routes, "get_active_workspace_id", lambda: "ws_target")
    monkeypatch.setattr(
        workspace_routes.workspace_repo,
        "resolve_share_token",
        lambda token: {
            "id": "wsl_1",
            "workspace_id": "ws_source",
            "created_by_user_id": "owner-1",
            "created_at": "2026-01-01T00:00:00+00:00",
            "use_count": 0,
            "max_uses": 1,
            "workspace": {
                "id": "ws_source",
                "name": "Shared",
                "owner_user_id": "owner-1",
                "created_at": "2026-01-01",
            },
        },
    )
    monkeypatch.setattr(workspace_routes.workspace_repo, "increment_share_use", lambda **_kwargs: False)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            workspace_routes.import_share(
                "wst_raw",
                AuthContext(user_id="user-2", email="u2@example.com", scopes=()),
            )
        )

    assert exc_info.value.status_code == 410
    assert exc_info.value.detail == "share link exhausted"


def test_increment_share_use_compares_current_count_and_max(monkeypatch):
    client = _FakeSupabaseClient()
    client.rows["workspace_share_links"] = [
        {"id": "wsl_1", "workspace_id": "ws_a", "use_count": 0, "max_uses": 1},
    ]
    monkeypatch.setattr(workspace_routes.workspace_repo, "get_supabase_service_client", lambda: client)

    assert workspace_routes.workspace_repo.increment_share_use(
        link_id="wsl_1",
        use_count=0,
        max_uses=1,
    ) is True
    assert client.rows["workspace_share_links"][0]["use_count"] == 1
    assert workspace_routes.workspace_repo.increment_share_use(
        link_id="wsl_1",
        use_count=0,
        max_uses=1,
    ) is False


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    def __init__(self, client, table_name: str):
        self.client = client
        self.table_name = table_name
        self.filters = []
        self.operation = "select"
        self.payload = None
        self.limit_count = None

    def select(self, *_args, **_kwargs):
        self.operation = "select"
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def lt(self, key, value):
        self.filters.append((key, ("lt", value)))
        return self

    def limit(self, count):
        self.limit_count = count
        return self

    def update(self, payload):
        self.operation = "update"
        self.payload = payload
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def insert(self, payload):
        self.operation = "insert"
        self.payload = payload
        return self

    def _matches(self, row):
        for key, value in self.filters:
            if isinstance(value, tuple) and value[0] == "lt":
                if not int(row.get(key) or 0) < int(value[1]):
                    return False
                continue
            if str(row.get(key)) != str(value):
                return False
        return True

    def execute(self):
        rows = self.client.rows[self.table_name]
        if self.operation == "insert":
            inserted = dict(self.payload)
            rows.append(inserted)
            return _FakeResponse([dict(inserted)])

        matched = [row for row in rows if self._matches(row)]
        if self.limit_count is not None:
            matched = matched[: self.limit_count]

        if self.operation == "select":
            return _FakeResponse([dict(row) for row in matched])
        if self.operation == "update":
            for row in matched:
                row.update(self.payload)
            return _FakeResponse([dict(row) for row in matched])
        if self.operation == "delete":
            deleted = [dict(row) for row in rows if self._matches(row)]
            self.client.rows[self.table_name] = [row for row in rows if not self._matches(row)]
            return _FakeResponse(deleted)
        raise AssertionError(f"unsupported operation: {self.operation}")


class _FakeSupabaseClient:
    def __init__(self):
        self.rows = {
            "users": [
                {"id": "owner-1", "email": "owner@example.com"},
                {"id": "owner-2", "email": "new@example.com"},
            ],
            "workspaces": [
                {
                    "id": "ws_a",
                    "name": "Team",
                    "owner_user_id": "owner-1",
                    "created_at": "2026-01-01",
                }
            ],
            "workspace_members": [
                {"workspace_id": "ws_a", "user_id": "owner-2", "role": "admin", "status": "active"},
                {"workspace_id": "ws_other", "user_id": "owner-2", "role": "admin", "status": "active"},
            ],
            "asset_versions": [
                {"id": "av_1", "workspace_id": "ws_a", "user_id": "owner-1"},
                {"id": "av_other", "workspace_id": "ws_other", "user_id": "owner-1"},
            ],
            "mcp_tools": [
                {"id": "mcp_1", "workspace_id": "ws_a", "user_id": "owner-1"},
                {"id": "mcp_other", "workspace_id": "ws_other", "user_id": "owner-1"},
            ],
            "api_tokens": [
                {"id": "tok_1", "workspace_id": "ws_a"},
                {"id": "tok_2", "workspace_id": "ws_a"},
                {"id": "tok_other", "workspace_id": "ws_other"},
            ],
            "workspace_share_links": [
                {"id": "wsl_1", "workspace_id": "ws_a", "revoked_at": None},
                {"id": "wsl_other", "workspace_id": "ws_other", "revoked_at": None},
            ],
            "workspace_transfer_events": [],
        }

    def table(self, table_name: str):
        return _FakeTable(self, table_name)

    def rpc(self, fn_name: str, params: dict):
        assert fn_name == "transfer_workspace_ownership"
        return _FakeTransferRpc(self, params)


class _FakeTransferRpc:
    def __init__(self, client: _FakeSupabaseClient, params: dict):
        self.client = client
        self.params = params

    def execute(self):
        workspace_id = self.params["p_workspace_id"]
        current_owner = self.params["p_current_owner"]
        new_owner = self.params["p_new_owner"]
        workspace = next(
            row
            for row in self.client.rows["workspaces"]
            if row["id"] == workspace_id and row["owner_user_id"] == current_owner
        )
        revoked_api_tokens = len(
            [row for row in self.client.rows["api_tokens"] if row["workspace_id"] == workspace_id]
        )
        self.client.rows["api_tokens"] = [
            row for row in self.client.rows["api_tokens"] if row["workspace_id"] != workspace_id
        ]
        revoked_share_links = 0
        for row in self.client.rows["workspace_share_links"]:
            if row["workspace_id"] == workspace_id and row["revoked_at"] is None:
                row["revoked_at"] = "2026-01-01T00:00:00+00:00"
                revoked_share_links += 1
        for row in self.client.rows["workspace_members"]:
            if row["workspace_id"] == workspace_id and row["user_id"] == current_owner:
                row["role"] = "admin"
                row["status"] = "active"
            if row["workspace_id"] == workspace_id and row["user_id"] == new_owner:
                row["status"] = "removed"
        if not any(
            row["workspace_id"] == workspace_id and row["user_id"] == current_owner
            for row in self.client.rows["workspace_members"]
        ):
            self.client.rows["workspace_members"].append(
                {"workspace_id": workspace_id, "user_id": current_owner, "role": "admin", "status": "active"}
            )
        for table_name in ("asset_versions", "mcp_tools"):
            for row in self.client.rows[table_name]:
                if row["workspace_id"] == workspace_id and row["user_id"] == current_owner:
                    row["user_id"] = new_owner
        workspace["owner_user_id"] = new_owner
        event = {
            "id": self.params["p_event_id"],
            "workspace_id": workspace_id,
            "previous_owner_user_id": current_owner,
            "new_owner_user_id": new_owner,
            "actor_user_id": self.params["p_actor_user_id"],
            "revoked_api_tokens": revoked_api_tokens,
            "retained_authority": list(self.params["p_retained_authority"]),
        }
        self.client.rows["workspace_transfer_events"].append(event)
        return _FakeResponse(
            {
                "workspace": dict(workspace),
                "previous_owner_user_id": current_owner,
                "new_owner_user_id": new_owner,
                "revoked_api_tokens": revoked_api_tokens,
                "revoked_share_links": revoked_share_links,
                "retained_authority": list(self.params["p_retained_authority"]),
                "audit_event_id": event["id"],
            }
        )


def test_transfer_ownership_revokes_workspace_pats_and_records_audit(monkeypatch):
    fake_client = _FakeSupabaseClient()
    monkeypatch.setattr(workspace_repo, "get_supabase_service_client", lambda: fake_client)

    recipient = workspace_repo.resolve_transfer_recipient(
        recipient_user_id=None,
        recipient_email="new@example.com",
    )
    result = workspace_repo.transfer_ownership(
        owner_user_id="owner-1",
        workspace_id="ws_a",
        recipient_user_id=str(recipient["id"]),
        retained_authority=["connections", "secrets"],
    )

    assert result["workspace"]["owner_user_id"] == "owner-2"
    assert result["revoked_api_tokens"] == 2
    assert result["revoked_share_links"] == 1
    assert [row["id"] for row in fake_client.rows["api_tokens"]] == ["tok_other"]
    assert fake_client.rows["workspace_share_links"][0]["revoked_at"] is not None
    assert fake_client.rows["workspace_share_links"][1]["revoked_at"] is None
    assert {
        (row["workspace_id"], row["user_id"], row["role"], row["status"])
        for row in fake_client.rows["workspace_members"]
        if row["workspace_id"] == "ws_a"
    } == {
        ("ws_a", "owner-1", "admin", "active"),
        ("ws_a", "owner-2", "admin", "removed"),
    }
    assert fake_client.rows["asset_versions"][0]["user_id"] == "owner-2"
    assert fake_client.rows["asset_versions"][1]["user_id"] == "owner-1"
    assert fake_client.rows["mcp_tools"][0]["user_id"] == "owner-2"
    assert fake_client.rows["mcp_tools"][1]["user_id"] == "owner-1"
    assert fake_client.rows["workspace_transfer_events"][0]["previous_owner_user_id"] == "owner-1"
    assert fake_client.rows["workspace_transfer_events"][0]["new_owner_user_id"] == "owner-2"
    assert fake_client.rows["workspace_transfer_events"][0]["retained_authority"] == [
        "connections",
        "secrets",
    ]
