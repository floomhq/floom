from __future__ import annotations

import pytest


def _create_worker(repos, manifest, *, user_id, worker_id, **fields):
    return repos.workers.create(
        user_id=user_id,
        worker_id=worker_id,
        name=worker_id,
        manifest_json=manifest(worker_id, worker_id),
        bundle_path=f"workers/{worker_id}",
        **fields,
    )


# ---------------------------------------------------------------------------
# Schema / defaults
# ---------------------------------------------------------------------------

def test_new_worker_defaults_private_and_workspace_id(repo_bundle):
    repos, _db, manifest = repo_bundle
    worker = _create_worker(repos, manifest, user_id="federico", worker_id="w1")
    assert worker["visibility"] == "private"
    assert worker["owner_id"] == "federico"
    # base user under default workspace
    assert worker["workspace_id"] == "local-default"


def test_derived_workspace_id_from_scoped_owner(repo_bundle):
    repos, _db, manifest = repo_bundle
    owner = "federico__ws_0123456789abcd"
    worker = _create_worker(repos, manifest, user_id=owner, worker_id="w2")
    assert worker["workspace_id"] == "ws_0123456789abcd"


def test_user_delete_refuses_to_orphan_owned_resources(repo_bundle):
    repos, _db, manifest = repo_bundle
    repos.users.create(
        user_id="owner-delete",
        username="owner-delete",
        display_name=None,
        password_hash="hash",
        role="member",
    )
    _create_worker(repos, manifest, user_id="owner-delete", worker_id="w-owned-delete")

    with pytest.raises(ValueError, match="resources still exist"):
        repos.users.delete(user_id="owner-delete")

    assert repos.users.get(user_id="owner-delete") is not None


# ---------------------------------------------------------------------------
# WorkspaceMemberRepository (single-owner degenerate)
# ---------------------------------------------------------------------------

def _seed_owner(db, workspace_id, user_id):
    with db.get_db() as conn:
        now = db.now_iso()
        conn.execute(
            """
            INSERT OR IGNORE INTO workspace_members
                (workspace_id, user_id, email, display_name, role, status,
                 invited_by, created_at, updated_at)
            VALUES (?, ?, NULL, NULL, 'owner', 'active', NULL, ?, ?)
            """,
            (workspace_id, user_id, now, now),
        )


def test_members_list_returns_single_owner(repo_bundle):
    repos, db, _manifest = repo_bundle
    _seed_owner(db, "local-default", "federico")
    members = repos.members.list(workspace_id="local-default")
    assert len(members) == 1
    assert members[0]["role"] == "owner"
    assert members[0]["user_id"] == "federico"


def test_one_active_owner_index_blocks_second_owner(repo_bundle):
    repos, db, _manifest = repo_bundle
    _seed_owner(db, "local-default", "federico")
    import sqlite3

    with pytest.raises(sqlite3.IntegrityError):
        with db.get_db() as conn:
            now = db.now_iso()
            conn.execute(
                """
                INSERT INTO workspace_members
                    (workspace_id, user_id, role, status, created_at, updated_at)
                VALUES ('local-default', 'someone-else', 'owner', 'active', ?, ?)
                """,
                (now, now),
            )


def test_invite_then_set_role_then_transfer(repo_bundle):
    repos, db, manifest = repo_bundle
    _seed_owner(db, "ws_aaaaaaaaaaaaaa", "owner-1")
    _create_worker(
        repos,
        manifest,
        user_id="owner-1",
        worker_id="w-transfer",
        workspace_id="ws_aaaaaaaaaaaaaa",
    )
    repos.runs.create(
        user_id="owner-1",
        run_id="run-transfer",
        worker_id="w-transfer",
        status="completed",
        trigger_source="manual",
        runner="e2b",
    )

    invited = repos.members.invite(
        workspace_id="ws_aaaaaaaaaaaaaa",
        email="member@example.com",
        role="member",
        invited_by="owner-1",
    )
    assert invited["status"] == "invited"
    assert invited["role"] == "member"

    member_uid = invited["user_id"]
    promoted = repos.members.set_role(
        workspace_id="ws_aaaaaaaaaaaaaa",
        actor_id="owner-1",
        user_id=member_uid,
        role="admin",
    )
    assert promoted is not None and promoted["role"] == "admin"

    # admin cannot change roles
    with pytest.raises(PermissionError):
        repos.members.set_role(
            workspace_id="ws_aaaaaaaaaaaaaa",
            actor_id=member_uid,
            user_id="owner-1",
            role="member",
        )

    # mark the invited member active so it can receive ownership
    with db.get_db() as conn:
        conn.execute(
            "UPDATE workspace_members SET status = 'active' WHERE user_id = ?",
            (member_uid,),
        )
    transferred = repos.members.transfer_owner(
        workspace_id="ws_aaaaaaaaaaaaaa",
        actor_id="owner-1",
        new_owner_id=member_uid,
    )
    assert transferred["role"] == "owner"
    old = repos.members.get(workspace_id="ws_aaaaaaaaaaaaaa", user_id="owner-1")
    assert old["role"] == "admin"
    worker = repos.workers.get(user_id=member_uid, worker_id="w-transfer")
    assert worker is not None
    assert worker["owner_id"] == member_uid
    run = repos.runs.get(user_id=member_uid, run_id="run-transfer")
    assert run is not None


def test_admin_cannot_remove_other_admin(repo_bundle):
    repos, db, _manifest = repo_bundle
    _seed_owner(db, "ws_bbbbbbbbbbbbbb", "owner-1")
    now = db.now_iso()
    with db.get_db() as conn:
        for uid in ("admin-1", "admin-2"):
            conn.execute(
                """
                INSERT INTO workspace_members
                    (workspace_id, user_id, role, status, created_at, updated_at)
                VALUES ('ws_bbbbbbbbbbbbbb', ?, 'admin', 'active', ?, ?)
                """,
                (uid, now, now),
            )
    with pytest.raises(PermissionError):
        repos.members.remove(
            workspace_id="ws_bbbbbbbbbbbbbb", actor_id="admin-1", user_id="admin-2"
        )
    # but owner can remove an admin
    assert repos.members.remove(
        workspace_id="ws_bbbbbbbbbbbbbb", actor_id="owner-1", user_id="admin-2"
    ) is True


# ---------------------------------------------------------------------------
# AssetAccessRepository: permission resolution
# ---------------------------------------------------------------------------

def test_owner_has_full_permissions(repo_bundle):
    repos, db, manifest = repo_bundle
    _create_worker(repos, manifest, user_id="federico", worker_id="w-own")
    _seed_owner(db, "local-default", "federico")
    perms = repos.asset_access.get_permissions(
        workspace_id="local-default", user_id="federico", asset_type="worker", asset_id="w-own"
    )
    assert perms["is_owner"] is True
    assert all(perms[k] for k in ("can_view", "can_edit", "can_run", "can_delete", "can_share"))


def test_private_worker_invisible_to_non_owner(repo_bundle):
    repos, db, manifest = repo_bundle
    _create_worker(repos, manifest, user_id="owner-1", worker_id="w-priv")
    # both in the same workspace
    now = db.now_iso()
    with db.get_db() as conn:
        conn.execute(
            "UPDATE workers SET workspace_id = 'ws_cccccccccccccc' WHERE id = 'w-priv'"
        )
        for uid, role in (("owner-1", "owner"), ("member-1", "member")):
            conn.execute(
                """
                INSERT INTO workspace_members
                    (workspace_id, user_id, role, status, created_at, updated_at)
                VALUES ('ws_cccccccccccccc', ?, ?, 'active', ?, ?)
                """,
                (uid, role, now, now),
            )
    perms = repos.asset_access.get_permissions(
        workspace_id="ws_cccccccccccccc", user_id="member-1", asset_type="worker", asset_id="w-priv"
    )
    assert perms["is_owner"] is False
    assert perms["can_view"] is False
    assert perms["can_run"] is False
    assert perms["can_edit"] is False


def test_set_visibility_shares_to_workspace(repo_bundle):
    repos, db, manifest = repo_bundle
    _create_worker(repos, manifest, user_id="owner-1", worker_id="w-share")
    now = db.now_iso()
    with db.get_db() as conn:
        conn.execute(
            "UPDATE workers SET workspace_id = 'ws_dddddddddddddd' WHERE id = 'w-share'"
        )
        for uid, role in (("owner-1", "owner"), ("member-1", "member")):
            conn.execute(
                """
                INSERT INTO workspace_members
                    (workspace_id, user_id, role, status, created_at, updated_at)
                VALUES ('ws_dddddddddddddd', ?, ?, 'active', ?, ?)
                """,
                (uid, role, now, now),
            )
    # member cannot view while private
    before = repos.asset_access.get_permissions(
        workspace_id="ws_dddddddddddddd", user_id="member-1", asset_type="worker", asset_id="w-share"
    )
    assert before["can_view"] is False

    repos.asset_access.set_visibility(
        workspace_id="ws_dddddddddddddd",
        actor_id="owner-1",
        asset_type="worker",
        asset_id="w-share",
        visibility="workspace",
    )
    after = repos.asset_access.get_permissions(
        workspace_id="ws_dddddddddddddd", user_id="member-1", asset_type="worker", asset_id="w-share"
    )
    assert after["can_view"] is True
    assert after["can_run"] is True
    # member is not owner/admin: cannot edit/delete/share
    assert after["can_edit"] is False
    assert after["can_share"] is False


def test_non_owner_member_cannot_set_visibility(repo_bundle):
    repos, db, manifest = repo_bundle
    _create_worker(repos, manifest, user_id="owner-1", worker_id="w-x")
    now = db.now_iso()
    with db.get_db() as conn:
        conn.execute("UPDATE workers SET workspace_id = 'ws_eeeeeeeeeeeeee' WHERE id = 'w-x'")
        for uid, role in (("owner-1", "owner"), ("member-1", "member")):
            conn.execute(
                """
                INSERT INTO workspace_members
                    (workspace_id, user_id, role, status, created_at, updated_at)
                VALUES ('ws_eeeeeeeeeeeeee', ?, ?, 'active', ?, ?)
                """,
                (uid, role, now, now),
            )
    with pytest.raises(PermissionError):
        repos.asset_access.set_visibility(
            workspace_id="ws_eeeeeeeeeeeeee",
            actor_id="member-1",
            asset_type="worker",
            asset_id="w-x",
            visibility="workspace",
        )


def test_set_visibility_rejects_invalid_value(repo_bundle):
    repos, db, manifest = repo_bundle
    _create_worker(repos, manifest, user_id="federico", worker_id="w-inv")
    _seed_owner(db, "local-default", "federico")
    with pytest.raises(ValueError):
        repos.asset_access.set_visibility(
            workspace_id="local-default",
            actor_id="federico",
            asset_type="worker",
            asset_id="w-inv",
            visibility="public",
        )
