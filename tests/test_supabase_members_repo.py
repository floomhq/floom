"""Unit tests for the cloud engine-shaped membership repo (FW-02).

The adapter (apps/api/db/supabase_members_repo.py) plugs into the OSS engine's
`repos.members` slot so the dashboard's `/workspace/members` surface stops
returning HTTP 501 on cloud. These tests monkeypatch the high-level db helpers
the adapter composes (no Supabase / network), covering:

  - list(): owner is injected with role="owner" and deduped from member rows;
    member rows carry role + resolved email; scoping prefers the active
    workspace contextvar over the (wrong-on-cloud) engine-passed workspace_id.
  - get(): owner -> synthesized owner row; member -> member row; missing -> None.
  - permission matrix: invite/remove require admin; set_role/transfer require
    owner; admins cannot remove admins; owner cannot be removed/role-changed.
"""

from __future__ import annotations

import pytest

import apps.api.db.supabase_members_repo as repo_mod
from apps.api.auth.workspace_context import active_workspace
from apps.api.db.supabase_members_repo import SupabaseWorkspaceMemberRepository

OWNER = "owner-uid"
ADMIN = "admin-uid"
MEMBER = "member-uid"
WS = "ws-active"


@pytest.fixture
def wired(monkeypatch):
    """Wire the adapter against in-memory fakes."""
    state = {
        "owner": OWNER,
        "members": [
            {"user_id": ADMIN, "role": "admin", "status": "active",
             "invited_by": OWNER, "invited_at": "t0", "joined_at": "t1"},
            {"user_id": MEMBER, "role": "member", "status": "active",
             "invited_by": OWNER, "invited_at": "t0", "joined_at": "t1"},
        ],
    }

    monkeypatch.setattr(
        repo_mod.workspace_repo, "get",
        lambda *, workspace_id: {"id": workspace_id, "name": "Acme",
                                 "owner_user_id": state["owner"]},
    )

    def _member_role(*, workspace_id, user_id):
        for m in state["members"]:
            if m["user_id"] == user_id and m["status"] == "active":
                return m["role"]
        return None

    monkeypatch.setattr(repo_mod.workspace_repo, "get_member_role", _member_role)
    monkeypatch.setattr(
        repo_mod.members_db, "list_members",
        lambda *, workspace_id: [m for m in state["members"] if m["status"] == "active"],
    )
    monkeypatch.setattr(
        repo_mod.members_db, "get_member",
        lambda *, workspace_id, user_id: next(
            (m for m in state["members"]
             if m["user_id"] == user_id and m["status"] == "active"), None),
    )
    monkeypatch.setattr(
        repo_mod.members_db, "resolve_member_emails",
        lambda ids: {uid: f"{uid}@acme.test" for uid in ids},
    )
    return state


def test_list_injects_owner_and_dedupes(wired):
    repo = SupabaseWorkspaceMemberRepository()
    with active_workspace(WS, "owner"):
        rows = repo.list(workspace_id="WRONG-engine-derived-id")

    by_uid = {r["user_id"]: r for r in rows}
    assert by_uid[OWNER]["role"] == "owner"
    assert by_uid[OWNER]["email"] == f"{OWNER}@acme.test"
    assert by_uid[ADMIN]["role"] == "admin"
    assert by_uid[MEMBER]["role"] == "member"
    # Owner appears exactly once even if a stale member row existed.
    assert sum(1 for r in rows if r["user_id"] == OWNER) == 1
    # Every row is scoped to the ACTIVE workspace, not the engine-passed id.
    assert all(r["workspace_id"] == WS for r in rows)


def test_list_dedupes_owner_from_member_rows(wired, monkeypatch):
    # Owner also has a stale member row — must still show once, as owner.
    wired["members"].append(
        {"user_id": OWNER, "role": "member", "status": "active",
         "invited_by": OWNER, "invited_at": "t0", "joined_at": "t1"})
    repo = SupabaseWorkspaceMemberRepository()
    with active_workspace(WS, "owner"):
        rows = repo.list(workspace_id=WS)
    owner_rows = [r for r in rows if r["user_id"] == OWNER]
    assert len(owner_rows) == 1
    assert owner_rows[0]["role"] == "owner"


def test_get_owner_and_member_and_missing(wired):
    repo = SupabaseWorkspaceMemberRepository()
    with active_workspace(WS, "owner"):
        assert repo.get(workspace_id=WS, user_id=OWNER)["role"] == "owner"
        assert repo.get(workspace_id=WS, user_id=ADMIN)["role"] == "admin"
        assert repo.get(workspace_id=WS, user_id="ghost") is None


def test_invite_requires_admin(wired, monkeypatch):
    monkeypatch.setattr(
        repo_mod.members_db, "invite_member",
        lambda **kw: ({"id": "inv-1", "created_at": "t"}, "wsi_raw"))
    # Suppress email send.
    monkeypatch.setattr(repo_mod.members_db, "resolve_member_emails",
                        lambda ids: {})
    repo = SupabaseWorkspaceMemberRepository()
    with active_workspace(WS, "member"):
        # Member cannot invite.
        with pytest.raises(PermissionError):
            repo.invite(workspace_id=WS, email="x@y.com", role="member",
                        invited_by=MEMBER)
        # Admin can.
        row = repo.invite(workspace_id=WS, email="x@y.com", role="member",
                          invited_by=ADMIN)
        assert row["status"] == "invited"
        assert row["email"] == "x@y.com"


def test_set_role_owner_only_and_owner_protected(wired, monkeypatch):
    def _change_role(**kw):
        # Mutate the in-memory state so the adapter's re-read (get_member)
        # reflects the new role, mirroring real Supabase behavior.
        for m in wired["members"]:
            if m["user_id"] == kw["user_id"]:
                m["role"] = kw["new_role"]
                return m
        return None

    monkeypatch.setattr(repo_mod.members_db, "change_role", _change_role)
    repo = SupabaseWorkspaceMemberRepository()
    with active_workspace(WS, "admin"):
        # Admin cannot change roles.
        with pytest.raises(PermissionError):
            repo.set_role(workspace_id=WS, actor_id=ADMIN, user_id=MEMBER,
                          role="admin")
    with active_workspace(WS, "owner"):
        # Owner can promote a member.
        out = repo.set_role(workspace_id=WS, actor_id=OWNER, user_id=MEMBER,
                            role="admin")
        assert out["role"] == "admin"
        # Owner role itself cannot be changed here.
        with pytest.raises(ValueError):
            repo.set_role(workspace_id=WS, actor_id=OWNER, user_id=OWNER,
                          role="member")


def test_remove_matrix(wired, monkeypatch):
    monkeypatch.setattr(repo_mod.members_db, "remove_member",
                        lambda **kw: True)
    repo = SupabaseWorkspaceMemberRepository()
    with active_workspace(WS, "admin"):
        # Admin cannot remove the owner.
        with pytest.raises(ValueError):
            repo.remove(workspace_id=WS, actor_id=ADMIN, user_id=OWNER)
        # Admin cannot remove another admin.
        wired["members"].append(
            {"user_id": "admin2", "role": "admin", "status": "active",
             "invited_by": OWNER, "invited_at": "t0", "joined_at": "t1"})
        with pytest.raises(PermissionError):
            repo.remove(workspace_id=WS, actor_id=ADMIN, user_id="admin2")
        # Admin can remove an ordinary member.
        assert repo.remove(workspace_id=WS, actor_id=ADMIN, user_id=MEMBER) is True


def test_transfer_owner_owner_only(wired, monkeypatch):
    calls = {"update": []}

    class _Chain:
        def table(self, *_a):
            return self
        def update(self, payload):
            calls["update"].append(payload)
            return self
        def upsert(self, *a, **k):
            return self
        def eq(self, *_a):
            return self
        def execute(self):
            return None

    monkeypatch.setattr(repo_mod, "get_supabase_service_client", lambda: _Chain())
    repo = SupabaseWorkspaceMemberRepository()
    with active_workspace(WS, "admin"):
        # Non-owner cannot transfer.
        with pytest.raises(PermissionError):
            repo.transfer_owner(workspace_id=WS, actor_id=ADMIN,
                                new_owner_id=MEMBER)
    with active_workspace(WS, "owner"):
        out = repo.transfer_owner(workspace_id=WS, actor_id=OWNER,
                                  new_owner_id=MEMBER)
        # workspaces.owner_user_id flipped to the new owner.
        assert {"owner_user_id": MEMBER} in calls["update"]
        assert out["user_id"] == MEMBER
