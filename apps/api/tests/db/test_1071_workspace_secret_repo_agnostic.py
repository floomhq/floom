"""#1071 — workspace-secret writes crossed the Repositories boundary with a
SQLite-encoded synthetic actor id (db.sqlite.workspace_actor_id), which 500s
under the cloud Supabase repo. The repo now owns workspace scoping via
set/get/list/delete_workspace_secret.

These exercise the SQLite implementation: it must keep storing workspace secrets
under the synthetic workspace actor (backward compatible) while exposing the
repo-agnostic methods the route now calls.
"""
from __future__ import annotations


def test_workspace_secret_roundtrip_and_actor_compat(repo_bundle):
    repos, db, _manifest = repo_bundle
    from db.sqlite import workspace_actor_id

    repos.secrets.set_workspace_secret(
        workspace_id="ws-1", actor_id="real-user-uuid", name="SHARED_KEY", value="v1"
    )

    got = repos.secrets.get_workspace_secret(workspace_id="ws-1", name="SHARED_KEY")
    assert got is not None and got["value"] == "v1"

    names = [r["name"] for r in repos.secrets.list_workspace_secrets(workspace_id="ws-1")]
    assert names == ["SHARED_KEY"]

    # Backward compat: stored under the synthetic workspace actor, so existing
    # rows / readers keyed on it still resolve.
    legacy = repos.secrets.get(user_id=workspace_actor_id("ws-1"), name="SHARED_KEY")
    assert legacy is not None and legacy["value"] == "v1"

    # The real admin user_id is NOT used as the storage key (no personal row).
    assert repos.secrets.get(user_id="real-user-uuid", name="SHARED_KEY") is None


def test_workspace_secrets_isolated_per_workspace(repo_bundle):
    repos, _db, _manifest = repo_bundle
    repos.secrets.set_workspace_secret(
        workspace_id="ws-a", actor_id="admin-a", name="API_KEY", value="a"
    )
    repos.secrets.set_workspace_secret(
        workspace_id="ws-b", actor_id="admin-b", name="API_KEY", value="b"
    )
    assert repos.secrets.get_workspace_secret(workspace_id="ws-a", name="API_KEY")["value"] == "a"
    assert repos.secrets.get_workspace_secret(workspace_id="ws-b", name="API_KEY")["value"] == "b"


def test_workspace_secret_delete(repo_bundle):
    repos, _db, _manifest = repo_bundle
    repos.secrets.set_workspace_secret(
        workspace_id="ws-1", actor_id="admin", name="TO_DELETE", value="x"
    )
    assert repos.secrets.delete_workspace_secret(workspace_id="ws-1", name="TO_DELETE") is True
    assert repos.secrets.get_workspace_secret(workspace_id="ws-1", name="TO_DELETE") is None
