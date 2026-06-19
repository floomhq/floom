"""Members STEP 4-5: brain pack + assistant per-asset visibility (engine DB layer).

Mirrors test_workspace_members_and_visibility.py (workers) for the two newly
normalized assets: brain packs and the workspace assistant. The same generic
SqliteAssetAccessRepository now resolves permissions for asset_type
``brain_pack`` and ``assistant`` against the brain_packs / assistants mirror rows.
"""
from __future__ import annotations

import pytest


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


def _seed_member(db, workspace_id, user_id, role="member"):
    with db.get_db() as conn:
        now = db.now_iso()
        conn.execute(
            """
            INSERT OR IGNORE INTO workspace_members
                (workspace_id, user_id, role, status, created_at, updated_at)
            VALUES (?, ?, ?, 'active', ?, ?)
            """,
            (workspace_id, user_id, role, now, now),
        )


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def test_brain_packs_and_assistants_tables_exist(repo_bundle):
    _repos, db, _manifest = repo_bundle
    with db.get_db() as conn:
        names = {
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    assert "brain_packs" in names
    assert "assistants" in names


def test_asset_tables_registered(repo_bundle):
    _repos, _db, _manifest = repo_bundle
    from db.sqlite import _ASSET_TABLES

    assert _ASSET_TABLES["brain_pack"] == "brain_packs"
    assert _ASSET_TABLES["assistant"] == "assistants"


# ---------------------------------------------------------------------------
# Brain pack: ensure + default private + owner permissions
# ---------------------------------------------------------------------------

def test_ensure_brain_pack_defaults_private(repo_bundle):
    repos, _db, _manifest = repo_bundle
    row = repos.asset_access.ensure_brain_pack(
        pack_id="research", workspace_id="local-default", owner_id="local-user"
    )
    assert row["visibility"] == "private"
    assert row["owner_id"] == "local-user"


def test_ensure_brain_pack_is_idempotent_and_preserves_visibility(repo_bundle):
    repos, _db, _manifest = repo_bundle
    repos.asset_access.ensure_brain_pack(
        pack_id="kb", workspace_id="local-default", owner_id="local-user"
    )
    _seed_owner(_db := repo_bundle[1], "local-default", "local-user")
    repos.asset_access.set_visibility(
        workspace_id="local-default",
        actor_id="local-user",
        asset_type="brain_pack",
        asset_id="kb",
        visibility="workspace",
    )
    # Re-ensure must NOT downgrade an already-shared pack.
    again = repos.asset_access.ensure_brain_pack(
        pack_id="kb", workspace_id="local-default", owner_id="local-user"
    )
    assert again["visibility"] == "workspace"


def test_owner_has_full_brain_pack_permissions(repo_bundle):
    repos, db, _manifest = repo_bundle
    _seed_owner(db, "local-default", "local-user")
    repos.asset_access.ensure_brain_pack(
        pack_id="p1", workspace_id="local-default", owner_id="local-user"
    )
    perms = repos.asset_access.get_permissions(
        workspace_id="local-default",
        user_id="local-user",
        asset_type="brain_pack",
        asset_id="p1",
    )
    assert perms["is_owner"] is True
    assert perms["can_edit"] and perms["can_share"] and perms["can_run"]


def test_private_brain_pack_invisible_to_non_owner(repo_bundle):
    repos, db, _manifest = repo_bundle
    repos.asset_access.ensure_brain_pack(
        pack_id="secret", workspace_id="ws_aaaaaaaaaaaaaa", owner_id="owner-1"
    )
    _seed_owner(db, "ws_aaaaaaaaaaaaaa", "owner-1")
    _seed_member(db, "ws_aaaaaaaaaaaaaa", "member-1")
    perms = repos.asset_access.get_permissions(
        workspace_id="ws_aaaaaaaaaaaaaa",
        user_id="member-1",
        asset_type="brain_pack",
        asset_id="secret",
    )
    assert perms["can_view"] is False
    assert perms["can_edit"] is False


def test_shared_brain_pack_visible_runnable_not_editable_by_member(repo_bundle):
    repos, db, _manifest = repo_bundle
    repos.asset_access.ensure_brain_pack(
        pack_id="shared", workspace_id="ws_bbbbbbbbbbbbbb", owner_id="owner-1"
    )
    _seed_owner(db, "ws_bbbbbbbbbbbbbb", "owner-1")
    _seed_member(db, "ws_bbbbbbbbbbbbbb", "member-1")
    repos.asset_access.set_visibility(
        workspace_id="ws_bbbbbbbbbbbbbb",
        actor_id="owner-1",
        asset_type="brain_pack",
        asset_id="shared",
        visibility="workspace",
    )
    perms = repos.asset_access.get_permissions(
        workspace_id="ws_bbbbbbbbbbbbbb",
        user_id="member-1",
        asset_type="brain_pack",
        asset_id="shared",
    )
    assert perms["can_view"] is True
    assert perms["can_run"] is True
    # A plain member can read a shared pack but NOT edit/delete someone else's.
    assert perms["can_edit"] is False
    assert perms["can_delete"] is False


def test_non_owner_member_cannot_share_brain_pack(repo_bundle):
    repos, db, _manifest = repo_bundle
    repos.asset_access.ensure_brain_pack(
        pack_id="p", workspace_id="ws_cccccccccccccc", owner_id="owner-1"
    )
    _seed_owner(db, "ws_cccccccccccccc", "owner-1")
    _seed_member(db, "ws_cccccccccccccc", "member-1")
    with pytest.raises(PermissionError):
        repos.asset_access.set_visibility(
            workspace_id="ws_cccccccccccccc",
            actor_id="member-1",
            asset_type="brain_pack",
            asset_id="p",
            visibility="workspace",
        )


# ---------------------------------------------------------------------------
# Assistant: shared workspace tool, default workspace
# ---------------------------------------------------------------------------

def test_assistant_backfilled_per_local_workspace(repo_bundle):
    repos, db, _manifest = repo_bundle
    # Migration 54 backfills one assistant row per local_workspaces row. Seed a
    # local workspace and re-run migrations to exercise the backfill.
    with db.get_db() as conn:
        now = db.now_iso()
        conn.execute(
            "CREATE TABLE IF NOT EXISTS local_workspaces "
            "(id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT, created_at TEXT)"
        )
        conn.execute(
            "INSERT OR IGNORE INTO local_workspaces (id, owner_user_id, name, created_at) "
            "VALUES ('local-default', 'local-user', 'Default', ?)",
            (now,),
        )
    # Lazy upsert mirrors the backfill id + default.
    row = repos.asset_access.ensure_assistant(
        assistant_id="workspace-agent:local-default",
        workspace_id="local-default",
        owner_id="local-user",
    )
    assert row["visibility"] == "workspace"
    assert row["owner_id"] == "local-user"


def test_assistant_owner_can_make_private(repo_bundle):
    repos, db, _manifest = repo_bundle
    _seed_owner(db, "local-default", "local-user")
    repos.asset_access.ensure_assistant(
        assistant_id="workspace-agent:local-default",
        workspace_id="local-default",
        owner_id="local-user",
    )
    repos.asset_access.set_visibility(
        workspace_id="local-default",
        actor_id="local-user",
        asset_type="assistant",
        asset_id="workspace-agent:local-default",
        visibility="private",
    )
    perms = repos.asset_access.get_permissions(
        workspace_id="local-default",
        user_id="local-user",
        asset_type="assistant",
        asset_id="workspace-agent:local-default",
    )
    assert perms["visibility"] == "private"
    assert perms["is_owner"] is True


def test_shared_assistant_visible_to_member(repo_bundle):
    repos, db, _manifest = repo_bundle
    repos.asset_access.ensure_assistant(
        assistant_id="workspace-agent:ws_dddddddddddddd",
        workspace_id="ws_dddddddddddddd",
        owner_id="owner-1",
    )
    _seed_owner(db, "ws_dddddddddddddd", "owner-1")
    _seed_member(db, "ws_dddddddddddddd", "member-1")
    # Default workspace visibility => a member can see + run it.
    perms = repos.asset_access.get_permissions(
        workspace_id="ws_dddddddddddddd",
        user_id="member-1",
        asset_type="assistant",
        asset_id="workspace-agent:ws_dddddddddddddd",
    )
    assert perms["can_view"] is True
    assert perms["can_run"] is True
    # Members do not own the shared assistant, so cannot edit/share it.
    assert perms["can_edit"] is False
    assert perms["can_share"] is False
