"""Regression tests for #275 — auth caches not evicted on revoke.

A revoked PAT kept authenticating for up to _PAT_TTL (60s) and a removed/
demoted member kept their workspace/role for up to _WS_TTL (30s), because the
revoke paths never evicted the in-memory caches. They now evict immediately.
"""

from __future__ import annotations

from types import SimpleNamespace

import apps.api.auth.supabase_provider as sp
import apps.api.db.supabase_repos as sr
import apps.api.db.members as members_db
from apps.api.db.supabase_repos import SupabaseApiTokenRepository


# ---- eviction primitives ----

def test_evict_pat_cache():
    sp._pat_cache["h1"] = ("u1", "ws1", 123.0)
    sp.evict_pat_cache("h1")
    assert "h1" not in sp._pat_cache


def test_evict_workspace_cache_for_user_clears_only_that_user():
    sp._ws_cache["u1:wsA"] = ("wsA", "admin", 1.0)
    sp._ws_cache["u1:"] = ("wsB", "member", 1.0)
    sp._ws_cache["u2:wsC"] = ("wsC", "admin", 1.0)
    sp.evict_workspace_cache_for_user("u1")
    assert "u1:wsA" not in sp._ws_cache and "u1:" not in sp._ws_cache
    assert "u2:wsC" in sp._ws_cache  # other users untouched


# ---- PAT delete evicts the PAT cache ----

class _TokenClient:
    def __init__(self, token_hash, deleted=True):
        self._hash = token_hash
        self._deleted = deleted
        self._op = None

    def table(self, _n):
        return self

    def select(self, *a, **k):
        self._op = "select"
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def execute(self):
        if self._op == "select":
            return SimpleNamespace(data=[{"token_hash": self._hash}] if self._hash else [])
        return SimpleNamespace(data=[{"id": "t1"}] if self._deleted else [])


def test_repo_delete_evicts_pat_cache(monkeypatch):
    monkeypatch.setattr(sr, "get_active_workspace_id", lambda: None)
    sp._pat_cache["hash123"] = ("u1", "ws1", 999.0)
    repo = SupabaseApiTokenRepository(client=_TokenClient("hash123"))
    assert repo.delete(token_id="t1", user_id="u1") is True
    assert "hash123" not in sp._pat_cache  # revoked token can no longer auth from cache


def test_repo_delete_noop_eviction_when_nothing_deleted(monkeypatch):
    monkeypatch.setattr(sr, "get_active_workspace_id", lambda: None)
    sp._pat_cache["hashZ"] = ("u1", "ws1", 999.0)
    repo = SupabaseApiTokenRepository(client=_TokenClient("hashZ", deleted=False))
    assert repo.delete(token_id="t9", user_id="u1") is False
    # Not deleted -> cache left intact (don't evict on a no-op).
    assert "hashZ" in sp._pat_cache


# ---- member role-change / removal evicts the workspace cache ----

class _MembersClient:
    def table(self, _n):
        return self

    def update(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def execute(self):
        return SimpleNamespace(data=[{"user_id": "u1", "status": "removed"}])


def test_change_role_evicts_ws_cache(monkeypatch):
    sp._ws_cache["u1:wsX"] = ("wsX", "admin", 1.0)
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: _MembersClient())
    monkeypatch.setattr(members_db, "get_member", lambda **k: {"role": "member"})
    members_db.change_role(workspace_id="wsX", user_id="u1", new_role="member")
    assert "u1:wsX" not in sp._ws_cache  # demotion is immediate


def test_remove_member_evicts_ws_cache(monkeypatch):
    sp._ws_cache["u1:wsX"] = ("wsX", "admin", 1.0)
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: _MembersClient())
    assert members_db.remove_member(workspace_id="wsX", user_id="u1") is True
    assert "u1:wsX" not in sp._ws_cache  # removal is immediate
