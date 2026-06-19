"""API-level tests for the workspace members endpoints (STEP 2).

Covers:
  GET    /workspace/members                  — list + my_role + my_user_id
  POST   /workspace/members                  — invite (owner/admin only)
  PATCH  /workspace/members/{user_id}        — set_role (owner only)
  DELETE /workspace/members/{user_id}        — remove (owner/admin)
  POST   /workspace/members/transfer-owner   — transfer (owner only)

Plus the OS single-owner degenerate case (the page renders the local user as
Owner even with zero workers) and the role-matrix HTTP mapping (403/400/404).

Runs against a real FastAPI TestClient backed by an isolated SQLite DB; no
network calls.
"""

from __future__ import annotations

import importlib
import platform
import sys
from pathlib import Path

import pytest

_LINUX_ONLY = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="SQLite db layer uses fcntl (Linux only); runs in CI on ubuntu-latest",
)

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "test-secret-members"
_USER_ID = "local-user"


@pytest.fixture
def client_and_repos(monkeypatch, tmp_path):
    """Spin up a full FastAPI TestClient with an isolated SQLite DB (no workers)."""
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", _USER_ID)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    (tmp_path / "workers").mkdir()
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
        sys.modules.pop(_rn, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": _SECRET})
    repos = db.get_repositories()
    yield client, repos, db
    db.get_repositories.cache_clear()


def _seed_member(db, workspace_id, user_id, role, status="active", email=None):
    with db.get_db() as conn:
        now = db.now_iso()
        conn.execute(
            """
            INSERT INTO workspace_members
                (workspace_id, user_id, email, display_name, role, status,
                 invited_by, created_at, updated_at)
            VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?)
            ON CONFLICT(workspace_id, user_id) DO UPDATE SET
                role = excluded.role, status = excluded.status,
                email = excluded.email, updated_at = excluded.updated_at
            """,
            (workspace_id, user_id, email, role, status, now, now),
        )


def _demote_caller_and_make_owner(db, new_owner_id, caller_role="member"):
    """Atomically demote the bootstrap caller (local-user) off owner and install a
    different owner, respecting the one-active-owner partial unique index."""
    with db.get_db() as conn:
        now = db.now_iso()
        # demote caller first so the index does not see two active owners
        conn.execute(
            "UPDATE workspace_members SET role=?, updated_at=? "
            "WHERE workspace_id='local-default' AND user_id=?",
            (caller_role, now, _USER_ID),
        )
        conn.execute(
            """
            INSERT INTO workspace_members
                (workspace_id, user_id, email, display_name, role, status,
                 invited_by, created_at, updated_at)
            VALUES ('local-default', ?, NULL, NULL, 'owner', 'active', NULL, ?, ?)
            ON CONFLICT(workspace_id, user_id) DO UPDATE SET
                role='owner', status='active', updated_at=excluded.updated_at
            """,
            (new_owner_id, now, now),
        )


# ---------------------------------------------------------------------------
# GET /workspace/members — list + degenerate owner
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestListMembers:
    def test_degenerate_owner_renders_with_no_workers(self, client_and_repos):
        """OS single-owner: the page MUST render the local user as Owner even
        though the workspace has no workers and no pre-seeded membership row."""
        client, _repos, _db = client_and_repos
        resp = client.get("/workspace/members")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["workspace_id"] == "local-default"
        assert body["my_user_id"] == _USER_ID
        assert body["my_role"] == "owner"
        assert len(body["members"]) == 1
        owner = body["members"][0]
        assert owner["user_id"] == _USER_ID
        assert owner["role"] == "owner"
        assert owner["status"] == "active"

    def test_lists_invited_and_active_sorted_owner_first(self, client_and_repos):
        client, _repos, db = client_and_repos
        # bootstrap the degenerate owner row
        client.get("/workspace/members")
        _seed_member(db, "local-default", "admin-1", "admin")
        _seed_member(db, "local-default", "invite:x@y.co", "member", status="invited")
        body = client.get("/workspace/members").json()
        roles = [m["role"] for m in body["members"]]
        assert roles[0] == "owner"  # owner sorts first
        assert "admin" in roles
        # removed members are not listed
        assert all(m["status"] != "removed" for m in body["members"])


# ---------------------------------------------------------------------------
# POST /workspace/members — invite
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestInvite:
    def test_owner_can_invite_member(self, client_and_repos):
        client, _repos, _db = client_and_repos
        resp = client.post("/workspace/members", json={"email": "new@team.co", "role": "member"})
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["email"] == "new@team.co"
        assert body["role"] == "member"
        assert body["status"] == "invited"

    def test_cannot_invite_owner_role(self, client_and_repos):
        client, _repos, _db = client_and_repos
        # pydantic rejects role='owner' (Literal admin|member) -> 422
        resp = client.post("/workspace/members", json={"email": "x@y.co", "role": "owner"})
        assert resp.status_code == 422

    def test_non_owner_admin_member_cannot_invite(self, client_and_repos):
        """A plain member inviting -> 403 (role matrix: only owner/admin invite)."""
        client, _repos, db = client_and_repos
        client.get("/workspace/members")  # bootstrap owner
        _demote_caller_and_make_owner(db, "real-owner", caller_role="member")
        resp = client.post("/workspace/members", json={"email": "z@y.co", "role": "member"})
        assert resp.status_code == 403, resp.text


# ---------------------------------------------------------------------------
# PATCH /workspace/members/{id} — set_role (owner only)
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestSetRole:
    def test_owner_promotes_member_to_admin(self, client_and_repos):
        client, _repos, db = client_and_repos
        client.get("/workspace/members")  # bootstrap owner=local-user
        _seed_member(db, "local-default", "m1", "member")
        resp = client.patch("/workspace/members/m1", json={"role": "admin"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["role"] == "admin"

    def test_set_role_unknown_member_404(self, client_and_repos):
        client, _repos, _db = client_and_repos
        client.get("/workspace/members")
        resp = client.patch("/workspace/members/ghost", json={"role": "admin"})
        assert resp.status_code == 404

    def test_admin_cannot_change_roles(self, client_and_repos):
        """Only the owner changes roles. An admin actor -> 403."""
        client, _repos, db = client_and_repos
        client.get("/workspace/members")
        _demote_caller_and_make_owner(db, "real-owner", caller_role="admin")
        _seed_member(db, "local-default", "m1", "member")
        resp = client.patch("/workspace/members/m1", json={"role": "admin"})
        assert resp.status_code == 403, resp.text


# ---------------------------------------------------------------------------
# DELETE /workspace/members/{id} — remove
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestRemove:
    def test_owner_removes_member(self, client_and_repos):
        client, _repos, db = client_and_repos
        client.get("/workspace/members")
        _seed_member(db, "local-default", "m1", "member")
        resp = client.delete("/workspace/members/m1")
        assert resp.status_code == 204, resp.text
        listing = client.get("/workspace/members").json()
        assert all(m["user_id"] != "m1" for m in listing["members"])

    def test_cannot_remove_owner(self, client_and_repos):
        client, _repos, _db = client_and_repos
        client.get("/workspace/members")
        resp = client.delete(f"/workspace/members/{_USER_ID}")
        # owner removal raises PermissionError -> 403
        assert resp.status_code == 403, resp.text

    def test_remove_unknown_404(self, client_and_repos):
        client, _repos, _db = client_and_repos
        client.get("/workspace/members")
        resp = client.delete("/workspace/members/ghost")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /workspace/members/transfer-owner
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestTransferOwner:
    def test_owner_transfers_to_active_member(self, client_and_repos):
        client, _repos, db = client_and_repos
        client.get("/workspace/members")  # bootstrap owner=local-user
        _seed_member(db, "local-default", "m1", "member")
        resp = client.post("/workspace/members/transfer-owner", json={"new_owner_id": "m1"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["user_id"] == "m1"
        assert resp.json()["role"] == "owner"
        # old owner is now admin, exactly one active owner remains
        listing = client.get("/workspace/members").json()
        owners = [m for m in listing["members"] if m["role"] == "owner"]
        assert len(owners) == 1
        assert owners[0]["user_id"] == "m1"

    def test_transfer_to_non_member_400(self, client_and_repos):
        client, _repos, _db = client_and_repos
        client.get("/workspace/members")
        resp = client.post("/workspace/members/transfer-owner", json={"new_owner_id": "stranger"})
        assert resp.status_code == 400, resp.text

    def test_non_owner_cannot_transfer(self, client_and_repos):
        client, _repos, db = client_and_repos
        client.get("/workspace/members")
        _demote_caller_and_make_owner(db, "real-owner", caller_role="admin")
        resp = client.post("/workspace/members/transfer-owner", json={"new_owner_id": "real-owner"})
        assert resp.status_code == 403, resp.text


# ---------------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------------

@_LINUX_ONLY
def test_members_require_auth(client_and_repos):
    client, _repos, _db = client_and_repos
    from fastapi.testclient import TestClient
    import main

    unauthed = TestClient(main.app)
    assert unauthed.get("/workspace/members").status_code in (401, 403)
