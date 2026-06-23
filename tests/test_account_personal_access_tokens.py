from __future__ import annotations

import asyncio
import importlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.supabase_provider import (
    ACTIVE_WORKSPACE_HEADER,
    PAT_HEADER,
    SupabaseAuthProvider,
)
import apps.api.auth.supabase_provider as supa_module
from apps.api.db.supabase_repos import (
    SupabasePersonalAccessTokenRepository,
    SupabaseUserRepository,
    SupabaseUserSessionRepository,
)

ensure_engine_api_path()

from auth.context import AuthContext  # noqa: E402
from auth.multi_member import _hash_token as _hash_pat  # noqa: E402
from db.factory import Repositories  # noqa: E402


MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
USER_ID = "00000000-0000-0000-0000-000000000001"


class _FakeResponse:
    def __init__(self, data, count: int | None = None):
        self.data = data
        self.count = count


class _FakeQuery:
    def __init__(self, client: "_FakeClient", table: str, *, rpc_args: dict | None = None):
        self.client = client
        self.table = table
        self.rpc_args = rpc_args
        self.filters: list[tuple[str, str, object]] = []
        self.limit_value: int | None = None
        self.order_keys: list[tuple[str, bool]] = []
        self.op = "select"
        self.payload: dict | None = None
        self.count_exact = False

    def select(self, *_args, **kwargs):
        self.op = "select" if self.op == "select" else self.op
        self.count_exact = kwargs.get("count") == "exact"
        return self

    def insert(self, payload):
        self.op = "insert"
        self.payload = dict(payload)
        return self

    def update(self, payload):
        self.op = "update"
        self.payload = dict(payload)
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def in_(self, key, values):
        self.filters.append(("in", key, set(values)))
        return self

    def lt(self, key, value):
        self.filters.append(("lt", key, value))
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def order(self, key, **kwargs):
        self.order_keys.append((key, bool(kwargs.get("desc"))))
        return self

    def execute(self):
        if self.rpc_args is not None:
            return self._execute_rpc()

        rows = self.client.rows.setdefault(self.table, [])
        matched = [row for row in rows if self._matches(row)]

        if self.op == "insert":
            rows.append(dict(self.payload or {}))
            return _FakeResponse([dict(self.payload or {})])

        if self.op == "update":
            updated = []
            for row in matched:
                row.update(self.payload or {})
                updated.append(dict(row))
            return _FakeResponse(updated)

        if self.op == "delete":
            deleted = []
            for row in list(matched):
                rows.remove(row)
                deleted.append(dict(row))
            return _FakeResponse(deleted)

        for key, desc in reversed(self.order_keys):
            matched.sort(key=lambda row: str(row.get(key) or ""), reverse=desc)
        count = len(matched) if self.count_exact else None
        if self.limit_value is not None:
            matched = matched[: self.limit_value]
        return _FakeResponse([dict(row) for row in matched], count=count)

    def _matches(self, row: dict) -> bool:
        for op, key, value in self.filters:
            if op == "eq" and row.get(key) != value:
                return False
            if op == "in" and row.get(key) not in value:
                return False
            if op == "lt" and not (str(row.get(key) or "") < str(value)):
                return False
        return True

    def _execute_rpc(self):
        if self.table != "create_user_session_if_enabled":
            raise AssertionError(f"unexpected rpc {self.table}")
        args = self.rpc_args or {}
        user = next(
            (
                row
                for row in self.client.rows.setdefault("users", [])
                if row["id"] == args["p_user_id"] and not row.get("disabled")
            ),
            None,
        )
        if user is None:
            return _FakeResponse([])
        session = {
            "id": args["p_session_id"],
            "user_id": args["p_user_id"],
            "expires_at": args["p_expires_at"],
            "created_at": args["p_created_at"],
        }
        self.client.rows.setdefault("user_sessions", []).append(session)
        return _FakeResponse([dict(session)])


class _FakeClient:
    def __init__(self, rows: dict[str, list[dict]] | None = None):
        self.rows = rows or {}

    def table(self, name):
        return _FakeQuery(self, name)

    def rpc(self, name, args):
        return _FakeQuery(self, name, rpc_args=dict(args))


def _seed_client() -> _FakeClient:
    return _FakeClient(
        {
            "users": [
                {
                    "id": USER_ID,
                    "email": "alice@example.com",
                    "username": "alice",
                    "display_name": "Alice",
                    "password_hash": "hash",
                    "role": "admin",
                    "disabled": False,
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00",
                }
            ],
            "personal_access_tokens": [],
            "user_sessions": [],
        }
    )


def test_supabase_user_repository_matches_engine_contract():
    client = _FakeClient({"users": []})
    repo = SupabaseUserRepository(client=client)

    created = repo.create(
        user_id=USER_ID,
        username="alice@example.com",
        display_name="Alice",
        password_hash="pw-hash",
        role="admin",
    )

    assert created["id"] == USER_ID
    assert created["username"] == "alice@example.com"
    assert repo.count() == 1
    assert repo.get(user_id=USER_ID)["role"] == "admin"
    assert repo.get_by_username(username="alice@example.com")["password_hash"] == "pw-hash"
    assert len(repo.list()) == 1
    assert repo.update(user_id=USER_ID, disabled=True)["disabled"] is True
    assert repo.delete(user_id=USER_ID) is True
    assert repo.count() == 0


def test_supabase_personal_access_token_repository_lifecycle():
    client = _seed_client()
    repo = SupabasePersonalAccessTokenRepository(client=client)

    created = repo.create(
        token_id="pat_1",
        user_id=USER_ID,
        name="cli",
        token_hash="hash_1",
        expires_at="2026-12-31T00:00:00+00:00",
    )
    assert created["id"] == "pat_1"
    assert created["last_used_at"] is None

    by_hash = repo.get_by_hash(token_hash="hash_1")
    assert by_hash["user_id"] == USER_ID
    assert by_hash["username"] == "alice"
    assert by_hash["role"] == "admin"
    assert repo.list(user_id=USER_ID)[0]["id"] == "pat_1"

    repo.touch_last_used(token_id="pat_1", last_used_at="2026-01-02T00:00:00+00:00")
    assert repo.get_by_hash(token_hash="hash_1")["last_used_at"] == "2026-01-02T00:00:00+00:00"

    rotated = repo.rotate(token_id="pat_1", user_id=USER_ID, token_hash="hash_2")
    assert rotated["id"] == "pat_1"
    assert rotated["last_used_at"] is None
    assert repo.get_by_hash(token_hash="hash_1") is None
    assert repo.get_by_hash(token_hash="hash_2")["id"] == "pat_1"

    assert repo.delete(token_id="pat_1", user_id=USER_ID) is True
    assert repo.list(user_id=USER_ID) == []


def test_supabase_user_session_repository_hashes_and_prunes_sessions():
    client = _seed_client()
    repo = SupabaseUserSessionRepository(client=client)

    created = repo.create(
        session_id="raw-session",
        user_id=USER_ID,
        expires_at="2026-12-31T00:00:00+00:00",
    )
    assert created["id"] == "raw-session"
    stored_id = client.rows["user_sessions"][0]["id"]
    assert stored_id == _hash_pat("raw-session")

    loaded = repo.get(session_id="raw-session")
    assert loaded["user_id"] == USER_ID
    assert loaded["username"] == "alice"

    client.rows["user_sessions"].append(
        {
            "id": "expired",
            "user_id": USER_ID,
            "expires_at": "2020-01-01T00:00:00+00:00",
            "created_at": "2020-01-01T00:00:00+00:00",
        }
    )
    assert repo.prune_expired(now_iso="2026-01-01T00:00:00+00:00") == 1
    assert repo.delete(session_id="raw-session") is True

    client.rows["users"][0]["disabled"] = True
    with pytest.raises(ValueError):
        repo.create(
            session_id="blocked",
            user_id=USER_ID,
            expires_at="2026-12-31T00:00:00+00:00",
        )


def test_cloud_factory_wires_account_repositories(monkeypatch):
    from apps.api import startup
    import apps.api.db.supabase_repos as supabase_repos

    monkeypatch.setattr(supabase_repos, "get_supabase_service_client", lambda: _FakeClient())

    repos = startup._cloud_repositories()

    assert isinstance(repos.users, SupabaseUserRepository)
    assert isinstance(repos.tokens, SupabasePersonalAccessTokenRepository)
    assert isinstance(repos.sessions, SupabaseUserSessionRepository)


def test_engine_auth_tokens_route_returns_wos_token_with_cloud_repos():
    client = _seed_client()
    repos = Repositories(
        workers=object(),
        runs=object(),
        connections=object(),
        secrets=object(),
        cli_auth=object(),
        approvals=object(),
        alerts=object(),
        mcp_tools=object(),
        users=SupabaseUserRepository(client=client),
        tokens=SupabasePersonalAccessTokenRepository(client=client),
        sessions=SupabaseUserSessionRepository(client=client),
    )

    engine_auth = importlib.import_module("routers.auth")
    app = FastAPI()
    app.include_router(engine_auth.auth_router)
    app.dependency_overrides[engine_auth.get_auth_context] = lambda: AuthContext(
        user_id=USER_ID,
        role="admin",
        auth_method="supabase",
    )
    app.dependency_overrides[engine_auth.get_repos] = lambda: repos

    response = TestClient(app).post("/auth/tokens", json={"name": "cli"})

    assert response.status_code == 201
    body = response.json()
    assert body["token"].startswith("wos_")
    assert body["pat"]["name"] == "cli"
    stored = client.rows["personal_access_tokens"][0]
    assert stored["user_id"] == USER_ID
    assert stored["token_hash"] == _hash_pat(body["token"])


def test_wos_token_auth_resolves_requested_workspace(monkeypatch):
    repo = Mock()
    repo.get_by_hash.return_value = {
        "id": "pat_1",
        "user_id": USER_ID,
        "name": "cli",
        "expires_at": None,
        "disabled": False,
    }
    monkeypatch.setattr(
        "apps.api.db.supabase_repos.SupabasePersonalAccessTokenRepository",
        lambda: repo,
    )
    monkeypatch.setattr(
        supa_module,
        "get_cloud_settings",
        lambda: SimpleNamespace(supabase_url="https://example.supabase.co"),
    )
    monkeypatch.setattr(
        supa_module.workspace_repo,
        "resolve_active_workspace",
        lambda *, user_id, email, requested_id: {
            "id": requested_id,
            "owner_user_id": user_id,
        },
    )
    workspace_setter = Mock()
    monkeypatch.setattr(supa_module, "set_active_workspace_id", workspace_setter)

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/workspaces",
            "query_string": b"",
            "headers": [
                (PAT_HEADER.encode(), b"wos_test"),
                (ACTIVE_WORKSPACE_HEADER.encode(), b"ws_second"),
            ],
        }
    )

    ctx = asyncio.run(SupabaseAuthProvider().verify(request))

    assert ctx.user_id == USER_ID
    assert ctx.scopes == ("api",)
    workspace_setter.assert_called_once_with("ws_second")
    repo.get_by_hash.assert_called_once_with(token_hash=_hash_pat("wos_test"))
    repo.touch_last_used.assert_called_once()


def test_account_pat_migration_adds_engine_tables_and_rls():
    text = (MIGRATIONS_DIR / "0049_account_personal_access_tokens.sql").read_text()

    assert "create table if not exists public.personal_access_tokens" in text
    assert "create table if not exists public.user_sessions" in text
    assert "add column if not exists username" in text
    assert "create_user_session_if_enabled" in text
    assert "alter table public.personal_access_tokens force row level security" in text


def test_cloud_blocks_engine_local_user_admin_routes_before_mounts():
    import apps.api.main as cloud_main

    routes = list(cloud_main.app.routes)
    paths = [getattr(route, "path", None) for route in routes]

    for prefix in ("", "/api", "/v1", "/api/v1"):
        mount_index = paths.index(prefix or "")
        for blocked in (
            f"{prefix}/auth/setup",
            f"{prefix}/auth/login",
            f"{prefix}/auth/magic-link",
            f"{prefix}/auth/magic/{{_path:path}}",
            f"{prefix}/users",
            f"{prefix}/users/{{_path:path}}",
        ):
            assert blocked in paths
            assert paths.index(blocked) < mount_index
