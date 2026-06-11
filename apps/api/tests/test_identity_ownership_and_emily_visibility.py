"""Identity / ownership: claim-on-setup + Emily role-aware worker access.

Two related fixes for the OSS identity split (seed data is owned by the
bootstrap/local-default user; a freshly-created admin account owns nothing):

  1. claim-on-setup: /auth/setup transfers the bootstrap identity's workers,
     connections, and secrets to the new admin so they OWN (and can RUN) the
     seed workers. Replaces the manual DB re-own.
  2. Emily is role-aware (matches the /workers UI): an admin sees/addresses
     EVERY worker; a member sees own + workspace-shared; a non-owner non-admin
     cannot see another user's private worker.

Run: cd apps/api && python -m pytest tests/test_identity_ownership_and_emily_visibility.py -q
"""

import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _mk_workers_db(path: Path) -> None:
    c = sqlite3.connect(path)
    c.execute(
        "CREATE TABLE workers (id TEXT, name TEXT, trigger_type TEXT, enabled INTEGER, "
        "owner_id TEXT, visibility TEXT, workspace_id TEXT, skill_version_id TEXT)"
    )
    c.execute("CREATE TABLE skill_versions (id TEXT, manifest_json TEXT)")
    c.execute("CREATE TABLE users (id TEXT, role TEXT)")
    c.execute("CREATE TABLE composio_connections (id TEXT, user_id TEXT, app_name TEXT)")
    c.commit()
    c.close()


# ---------------------------------------------------------------------------
# claim-on-setup
# ---------------------------------------------------------------------------

def test_claim_on_setup_transfers_workers_and_connections(tmp_path, monkeypatch):
    db = tmp_path / "claim.db"
    _mk_workers_db(db)
    c = sqlite3.connect(db)
    c.executescript(
        "INSERT INTO workers (id, owner_id, name, visibility) VALUES "
        "  ('w1','boot','W1','private'),('w2','boot','W2','private');"
        "INSERT INTO composio_connections (id, user_id, app_name) VALUES ('c1','boot','gmail');"
    )
    c.commit(); c.close()
    monkeypatch.setenv("WORKEROS_DB", str(db))
    monkeypatch.setenv("FLOOM_DB", str(db))
    monkeypatch.setenv("WORKEROS_USER_ID", "boot")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")

    import main
    repos = MagicMock()
    repos.secrets.list_names.return_value = []
    summary = main._claim_bootstrap_assets_for_new_admin("admin-1", repos)

    assert summary["workers"] == 2
    assert summary["connections"] == 1
    c = sqlite3.connect(db)
    assert all(r[0] == "admin-1" for r in c.execute("SELECT owner_id FROM workers"))
    assert c.execute("SELECT user_id FROM composio_connections").fetchone()[0] == "admin-1"
    c.close()


def test_claim_on_setup_copies_bootstrap_secrets(tmp_path, monkeypatch):
    db = tmp_path / "claim2.db"
    _mk_workers_db(db)
    monkeypatch.setenv("WORKEROS_DB", str(db))
    monkeypatch.setenv("FLOOM_DB", str(db))
    monkeypatch.setenv("WORKEROS_USER_ID", "boot")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    import main
    repos = MagicMock()
    repos.secrets.list_names.return_value = ["OPENAI_API_KEY"]
    repos.secrets.get.side_effect = lambda user_id, name: (
        {"value": None} if user_id == "admin-1" else {"value": "sk-boot"}
    )
    summary = main._claim_bootstrap_assets_for_new_admin("admin-1", repos)
    # The bootstrap's OPENAI_API_KEY value is copied to the new admin (value-safe).
    repos.secrets.set.assert_any_call(
        user_id="admin-1", name="OPENAI_API_KEY", value="sk-boot",
        status=main.SecretStatus.SET.value,
    )
    assert summary["secrets"] >= 1


def test_claim_on_setup_noop_when_admin_is_bootstrap(tmp_path, monkeypatch):
    db = tmp_path / "claim3.db"
    _mk_workers_db(db)
    monkeypatch.setenv("WORKEROS_DB", str(db))
    monkeypatch.setenv("FLOOM_DB", str(db))
    monkeypatch.setenv("WORKEROS_USER_ID", "admin-1")  # bootstrap IS the admin
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    import main
    assert main._claim_bootstrap_assets_for_new_admin("admin-1", MagicMock()) == {
        "workers": 0, "connections": 0, "secrets": 0,
    }


def test_claim_on_setup_noop_in_cloud(tmp_path, monkeypatch):
    db = tmp_path / "claim4.db"
    _mk_workers_db(db)
    c = sqlite3.connect(db)
    c.execute("INSERT INTO workers (id, owner_id) VALUES ('w1','boot')")
    c.commit(); c.close()
    monkeypatch.setenv("WORKEROS_DB", str(db))
    monkeypatch.setenv("FLOOM_DB", str(db))
    monkeypatch.setenv("WORKEROS_USER_ID", "boot")
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")  # multi-tenant: no single owner to claim
    import main
    assert main._claim_bootstrap_assets_for_new_admin("admin-1", MagicMock()) == {
        "workers": 0, "connections": 0, "secrets": 0,
    }
    c = sqlite3.connect(db)
    assert c.execute("SELECT owner_id FROM workers").fetchone()[0] == "boot"  # untouched
    c.close()


# ---------------------------------------------------------------------------
# Emily role-aware worker access (list + view), with isolation preserved
# ---------------------------------------------------------------------------

def _seed_visibility_db(path: Path) -> None:
    _mk_workers_db(path)
    c = sqlite3.connect(path)
    c.executescript(
        "INSERT INTO users (id, role) VALUES ('admin-1','admin'),('member-1','member');"
        "INSERT INTO workers (id, name, owner_id, visibility, workspace_id) VALUES "
        "  ('w-admin','A','admin-1','private','local-default'),"
        "  ('w-member','M','member-1','private','local-default'),"
        "  ('w-seed','S','ghost','private','local-default'),"
        "  ('w-shared','Sh','ghost','workspace','local-default');"
    )
    c.commit(); c.close()


def test_emily_list_admin_sees_all(tmp_path, monkeypatch):
    db = tmp_path / "vis1.db"
    _seed_visibility_db(db)
    monkeypatch.setenv("WORKEROS_DB", str(db))
    monkeypatch.setenv("FLOOM_DB", str(db))
    import chat_service
    res = chat_service._tool_workers_list_all({}, "admin-1")
    ids = {w["id"] for w in res["workers"]}
    assert ids == {"w-admin", "w-member", "w-seed", "w-shared"}, ids


def test_emily_list_member_sees_own_and_shared_only(tmp_path, monkeypatch):
    db = tmp_path / "vis2.db"
    _seed_visibility_db(db)
    monkeypatch.setenv("WORKEROS_DB", str(db))
    monkeypatch.setenv("FLOOM_DB", str(db))
    import chat_service
    res = chat_service._tool_workers_list_all({}, "member-1")
    ids = {w["id"] for w in res["workers"]}
    assert "w-member" in ids        # own
    assert "w-shared" in ids        # workspace-shared
    assert "w-seed" not in ids      # another user's private
    assert "w-admin" not in ids     # another user's private


def test_worker_can_view_admin_vs_isolated_member(tmp_path, monkeypatch):
    db = tmp_path / "vis3.db"
    _seed_visibility_db(db)
    monkeypatch.setenv("WORKEROS_DB", str(db))
    monkeypatch.setenv("FLOOM_DB", str(db))
    # Simulate multi-user mode so filesystem fallback is disabled and an
    # unknown worker ID correctly returns False instead of True.
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    import chat_service
    from db import get_db
    with get_db() as conn:
        # Admin can view a private worker it does not own.
        assert chat_service._worker_can_view(conn, "w-seed", "admin-1") is True
        # A non-owner member cannot view someone else's private worker.
        assert chat_service._worker_can_view(conn, "w-seed", "member-1") is False
        # Owner can view their own.
        assert chat_service._worker_can_view(conn, "w-member", "member-1") is True
        # Non-existent worker -> not found (no existence leak).
        assert chat_service._worker_can_view(conn, "w-missing", "admin-1") is False
