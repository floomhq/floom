"""Regression test for #266 sub-bug 1 — PUT /workers/{id}/visibility 500.

The engine calls `asset_access.set_visibility(..., actor_role="admin" if
auth.is_admin else None)`, but the cloud `SupabaseAssetAccessRepository.
set_visibility` didn't accept `actor_role` → TypeError (neither PermissionError
nor ValueError) → unhandled 500 on every visibility change, including an owner
sharing their OWN worker. These tests prove the kwarg is accepted and the
owner/admin permission paths behave.
"""

from __future__ import annotations

import pytest

import apps.api.db.supabase_repos as supabase_repos
from apps.api.db.supabase_repos import SupabaseAssetAccessRepository


class _UpdClient:
    """Trivial client for the .update(...).eq(...).execute() write path."""

    def table(self, _name):
        return self

    def update(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def execute(self):
        return type("R", (), {"data": []})()


def _repo(monkeypatch, *, owner_id: str, asset_visibility: str, db_role=None):
    repo = SupabaseAssetAccessRepository()
    monkeypatch.setattr(supabase_repos, "get_active_workspace_id", lambda: None)
    monkeypatch.setattr(supabase_repos, "get_supabase_service_client", lambda: _UpdClient())
    monkeypatch.setattr(
        repo, "_asset_row",
        lambda **k: {"id": k["asset_id"], "owner_id": owner_id, "workspace_id": "ws_1", "visibility": asset_visibility},
    )
    # _role() falls back to the DB when actor_role isn't admin/owner.
    monkeypatch.setattr(supabase_repos.workspace_repo, "get", lambda **k: None)
    monkeypatch.setattr(supabase_repos.workspace_repo, "get_member_role", lambda **k: db_role)
    monkeypatch.setattr(repo, "get_permissions", lambda **k: {"visibility": "workspace", "can_share": True})
    return repo


def test_owner_can_share_own_worker_with_actor_role_none(monkeypatch):
    # The #266 repro: owner sharing their OWN (private) worker. actor_role=None.
    repo = _repo(monkeypatch, owner_id="user-1", asset_visibility="private")
    result = repo.set_visibility(
        workspace_id="ws_1", actor_id="user-1", asset_type="worker",
        asset_id="w1", visibility="workspace", actor_role=None,
    )
    assert result == {"visibility": "workspace", "can_share": True}  # no TypeError, succeeds


def test_admin_actor_role_elevates_on_shared_worker(monkeypatch):
    # Non-owner admin (actor_role="admin") sharing an already-workspace worker.
    repo = _repo(monkeypatch, owner_id="user-2", asset_visibility="workspace")
    result = repo.set_visibility(
        workspace_id="ws_1", actor_id="user-1", asset_type="worker",
        asset_id="w1", visibility="workspace", actor_role="admin",
    )
    assert result == {"visibility": "workspace", "can_share": True}


def test_non_owner_non_admin_is_permission_error_not_typeerror(monkeypatch):
    # A non-owner, non-admin on a private worker is denied — and the denial is a
    # PermissionError (engine -> 403), NOT a TypeError (engine -> 500).
    repo = _repo(monkeypatch, owner_id="user-2", asset_visibility="private", db_role=None)
    with pytest.raises(PermissionError):
        repo.set_visibility(
            workspace_id="ws_1", actor_id="user-1", asset_type="worker",
            asset_id="w1", visibility="workspace", actor_role=None,
        )


def test_actor_role_param_is_accepted_signature(monkeypatch):
    # Explicit guard: the keyword must exist (the exact 500 cause).
    import inspect
    sig = inspect.signature(SupabaseAssetAccessRepository.set_visibility)
    assert "actor_role" in sig.parameters
