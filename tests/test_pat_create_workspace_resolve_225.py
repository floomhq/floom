"""Regression test for #225 — POST /auth/tokens 500 (named PAT creation broken).

A live (non-destructive, rolled-back) repro against prod confirmed an
api_tokens insert with a VALID (owner, owned-workspace) succeeds — so the 500
came from `_resolve_workspace_id_for_write` returning a workspace_id that
violated the NOT NULL / FK -> workspaces (the unvalidated x-workeros-workspace
contextvar). `SupabaseApiTokenRepository.create` now resolves through
`resolve_active_workspace`, which validates ownership/membership of the
requested id and falls back to the caller's default — so a stale header can't
FK-violate.
"""

from __future__ import annotations

from types import SimpleNamespace

import apps.api.db.supabase_repos as supabase_repos
from apps.api.db.supabase_repos import SupabaseApiTokenRepository


class _Client:
    def __init__(self):
        self.payload = None

    def table(self, _name):
        return self

    def insert(self, payload):
        self.payload = payload
        return self

    def execute(self):
        return SimpleNamespace(data=[])


def _repo(monkeypatch, *, resolved_id="ws_valid"):
    client = _Client()
    repo = SupabaseApiTokenRepository(client=client)
    calls = {}

    def _resolve(*, user_id, email, requested_id):
        calls["requested_id"] = requested_id
        return {"id": resolved_id}

    monkeypatch.setattr(supabase_repos.workspace_repo, "resolve_active_workspace", _resolve)
    monkeypatch.setattr(
        repo, "get_by_hash",
        lambda token_hash: {"id": "t1", "user_id": "u1", "workspace_id": resolved_id, "name": "pentest"},
    )
    return repo, client, calls


def test_create_uses_validated_workspace_not_raw_contextvar(monkeypatch):
    # A stale/invalid x-workeros-workspace header must NOT be stamped directly.
    monkeypatch.setattr(supabase_repos, "get_active_workspace_id", lambda: "ws_stale_or_deleted")
    repo, client, calls = _repo(monkeypatch, resolved_id="ws_real_owned")

    row = repo.create(user_id="u1", name="pentest", token_hash="h1")

    # resolve_active_workspace was consulted with the (untrusted) header value...
    assert calls["requested_id"] == "ws_stale_or_deleted"
    # ...and the VALIDATED workspace it returned is what gets inserted.
    assert client.payload["workspace_id"] == "ws_real_owned"
    assert client.payload["user_id"] == "u1"
    assert row["workspace_id"] == "ws_real_owned"


def test_explicit_workspace_id_is_used_directly(monkeypatch):
    monkeypatch.setattr(supabase_repos, "get_active_workspace_id", lambda: "ws_ignored")
    repo, client, calls = _repo(monkeypatch)

    repo.create(user_id="u1", name="t", token_hash="h2", workspace_id="ws_explicit")

    # Explicit id wins; no resolve lookup needed.
    assert client.payload["workspace_id"] == "ws_explicit"
    assert "requested_id" not in calls
