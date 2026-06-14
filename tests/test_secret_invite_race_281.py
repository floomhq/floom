"""Regression tests for #281 — concurrency hardening.

1. SupabaseSecretRepository.set: a concurrent first-write of a new secret used
   to 500 (collision on the PK / vault UNIQUE(name)). It now retries once as an
   idempotent update when the row already exists.
2. accept_invitation: the accept-mark is now a conditional pending->accepted
   claim, and only the claimer mints a PAT — so concurrent accepts can't
   double-mint tokens.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import apps.api.db.supabase_repos as sr
import apps.api.db.members as members_db
from apps.api.db.supabase_repos import SupabaseSecretRepository


# ---------------- #281 item 1: secret first-write retry ----------------

class _SecretsClient:
    """First existence-check returns None (new secret); after the simulated
    collision the row 'exists' so the retry takes the update path."""

    def __init__(self):
        self._select_calls = 0
        self.updated = False

    def table(self, _n):
        return self

    def select(self, *a, **k):
        self._op = "select"
        return self

    def update(self, *a, **k):
        self.updated = True
        self._op = "update"
        return self

    def eq(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def execute(self):
        if getattr(self, "_op", None) == "select":
            self._select_calls += 1
            # 1st select: no row (new secret). 2nd+ (refetch / retry): row exists.
            if self._select_calls == 1:
                return SimpleNamespace(data=[])
            return SimpleNamespace(data=[{"vault_secret_id": "00000000-0000-0000-0000-000000000001", "value": None}])
        return SimpleNamespace(data=[{}])


def test_secret_set_retries_on_concurrent_first_write(monkeypatch):
    monkeypatch.setattr(sr, "_resolve_workspace_id_for_write", lambda **k: "ws_1")
    monkeypatch.setattr(sr, "get_active_workspace_id", lambda: None)
    monkeypatch.setattr(sr, "vault_secret_name", lambda ws, name: f"{ws}/{name}")
    # New-secret path raises (collision); update path (retry) succeeds.
    def _store(*a, **k):
        raise Exception("duplicate key value violates unique constraint")
    monkeypatch.setattr(sr, "vault_store_secret", _store)
    monkeypatch.setattr(sr, "vault_update_secret", lambda *a, **k: None)

    repo = SupabaseSecretRepository(client=_SecretsClient())
    monkeypatch.setattr(repo, "get", lambda **k: {"name": "FOO", "value": "v"})

    # Must NOT raise (was a bare 500); returns the row via the retry update path.
    result = repo.set(user_id="u1", name="FOO", value="v")
    assert result == {"name": "FOO", "value": "v"}


def test_secret_set_reraises_when_row_absent(monkeypatch):
    # A genuine failure (row still absent on refetch) must propagate, not loop.
    class _AlwaysEmpty(_SecretsClient):
        def execute(self):
            if getattr(self, "_op", None) == "select":
                return SimpleNamespace(data=[])
            return SimpleNamespace(data=[{}])
    monkeypatch.setattr(sr, "_resolve_workspace_id_for_write", lambda **k: "ws_1")
    monkeypatch.setattr(sr, "get_active_workspace_id", lambda: None)
    monkeypatch.setattr(sr, "vault_secret_name", lambda ws, name: "vn")
    monkeypatch.setattr(sr, "vault_store_secret", lambda *a, **k: (_ for _ in ()).throw(Exception("boom")))
    repo = SupabaseSecretRepository(client=_AlwaysEmpty())
    with pytest.raises(Exception):
        repo.set(user_id="u1", name="FOO", value="v")


# ---------------- #281 item 2: invite accept conditional claim ----------------

class _InviteClient:
    def __init__(self, ctx):
        self.ctx = ctx

    def table(self, name):
        return _InviteTbl(name, self.ctx)


class _InviteTbl:
    def __init__(self, name, ctx):
        self.name = name
        self.ctx = ctx
        self.op = None

    def update(self, *a, **k):
        self.op = "update"
        return self

    def upsert(self, *a, **k):
        return self

    def insert(self, *a, **k):
        if self.name == "api_tokens":
            self.ctx["pat_inserted"] = True
        return self

    def select(self, *a, **k):
        self.op = "select"
        return self

    def eq(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def execute(self):
        if self.name == "workspace_invitations":
            return SimpleNamespace(data=self.ctx["claim_data"])
        if self.name == "workspace_members" and self.op == "select":
            return SimpleNamespace(data=[{"workspace_id": "ws_1", "user_id": "alice", "role": "member"}])
        return SimpleNamespace(data=[{}])


def _invite(future_iso):
    return {
        "id": "inv", "workspace_id": "ws_1", "role": "member", "expires_at": future_iso,
        "email": "alice@example.com", "created_at": "2026-01-01", "invited_by": "admin",
    }


def _future(monkeypatch):
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()


def test_accept_invitation_claimer_mints_pat(monkeypatch):
    monkeypatch.setattr(members_db, "get_invitation_by_token", lambda *, raw_token: _invite(_future(monkeypatch)))
    ctx = {"claim_data": [{"id": "inv"}], "pat_inserted": False}  # we won the claim
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: _InviteClient(ctx))
    res = members_db.accept_invitation(raw_token="t", accepting_user_id="alice", accepting_user_email="alice@example.com")
    assert res["pat_token"].startswith("floom_")
    assert ctx["pat_inserted"] is True


def test_accept_invitation_lost_claim_no_second_pat(monkeypatch):
    monkeypatch.setattr(members_db, "get_invitation_by_token", lambda *, raw_token: _invite(_future(monkeypatch)))
    ctx = {"claim_data": [], "pat_inserted": False}  # concurrent accept already claimed it
    monkeypatch.setattr(members_db, "get_supabase_service_client", lambda: _InviteClient(ctx))
    res = members_db.accept_invitation(raw_token="t", accepting_user_id="alice", accepting_user_email="alice@example.com")
    assert res["pat_token"] is None
    assert ctx["pat_inserted"] is False  # no double-mint
