from __future__ import annotations

import asyncio
import importlib
import sys
import types
from types import SimpleNamespace

import pytest


def _load_cloud_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    psycopg = types.ModuleType("psycopg")
    psycopg.Connection = object
    psycopg.connect = lambda *_args, **_kwargs: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)

    for name in [
        "apps.api.main",
        "main",
        "db",
        "models",
        "worker_registry",
        "run_service",
        "chat_service",
    ]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


class _FakeWorkers:
    def __init__(self, *, owner_id: str = "user_fede"):
        self.owner_id = owner_id
        self.manifest = {
            "id": "worker-archive-test",
            "name": "Worker Archive Test",
            "trigger": {"type": "manual"},
            "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
            "inputs": [],
            "outputs": [],
            "secrets": [],
            "connections": [],
        }
        self.updates: list[dict[str, object]] = []

    def get_any(self, *, worker_id: str):
        if worker_id != "worker-archive-test":
            return None
        return {
            "id": worker_id,
            "user_id": self.owner_id,
            "owner_id": self.owner_id,
            "workspace_id": "ws_1",
            "manifest": dict(self.manifest),
            "manifest_json": dict(self.manifest),
        }

    def get(self, *, user_id: str, worker_id: str):
        # Retained for callers that use workspace-scoped reads.
        row = self.get_any(worker_id=worker_id)
        if row is None:
            return None
        if str(row["user_id"]) != str(user_id):
            from apps.api.auth.workspace_context import get_active_member_role, get_active_workspace_id

            active_workspace_id = get_active_workspace_id()
            if active_workspace_id and str(row.get("workspace_id") or "") != str(active_workspace_id):
                return None
            if get_active_member_role() not in {"admin", "member"}:
                return None
        return row

    def update(self, *, user_id: str, worker_id: str, manifest_json: dict[str, object]):
        self.updates.append(
            {
                "user_id": user_id,
                "worker_id": worker_id,
                "manifest_json": dict(manifest_json),
            }
        )
        self.manifest = dict(manifest_json)
        return self.get(user_id=user_id, worker_id=worker_id)


class _VisibilityRequest:
    async def json(self):
        return {"visibility": "shared"}


class _VisibilityWorkers:
    def __init__(self):
        self.visibility_set: list[tuple[str, str]] = []

    def get(self, *, user_id: str, worker_id: str):
        assert user_id == "user_fede"
        assert worker_id == "foreign-worker"
        return None

    def get_any(self, *, worker_id: str):
        assert worker_id == "foreign-worker"
        return {
            "id": "foreign-worker",
            "user_id": "user_fede",
            "owner_id": "user_fede",
            "workspace_id": "ws_b",
            "visibility": "private",
        }

    def set_visibility(self, *, worker_id: str, visibility: str):
        self.visibility_set.append((worker_id, visibility))


class _CloneLinkWorkers:
    def __init__(self, *, row: dict[str, object] | None = None):
        self.row = row
        self.clone_tokens: list[tuple[str, str, str]] = []

    def get(self, *, user_id: str, worker_id: str):
        assert user_id == "user_fede"
        if self.row is None:
            assert worker_id == "foreign-worker"
            return None
        assert worker_id == self.row["id"]
        if str(self.row["user_id"]) != str(user_id):
            return None
        return dict(self.row)

    def get_any(self, *, worker_id: str):
        raise AssertionError("clone-link must not use global worker lookup")

    def set_clone_token(self, *, worker_id: str, token_hash: str, expires_at: str):
        self.clone_tokens.append((worker_id, token_hash, expires_at))


def _make_archive_request(
    monkeypatch,
    main,
    *,
    caller_user_id: str,
    caller_role: str | None = None,
    caller_workspace_id: str | None = "ws_1",
):
    """Wire common monkeypatches for _cloud_set_worker_archived tests."""
    async def verify(_self, _request):
        return SimpleNamespace(user_id=caller_user_id)

    def build_worker_detail(worker_id: str, *, user_id: str, repos):
        worker = repos.workers.get_any(worker_id=worker_id)
        return {
            "id": worker_id,
            "archived": bool(worker["manifest_json"].get("archived", False)),
            "archive_reason": worker["manifest_json"].get("archive_reason"),
        }

    monkeypatch.setattr("apps.api.auth.supabase_provider.SupabaseAuthProvider.verify", verify)
    monkeypatch.setattr(main.engine_main, "_raise_if_protected_worker_mutation", lambda _worker_id: None)
    monkeypatch.setattr(main.engine_main, "_build_worker_detail", build_worker_detail)

    if caller_role is not None:
        from apps.api.auth import workspace_context as _wsc
        monkeypatch.setattr(_wsc, "get_active_member_role", lambda: caller_role)
    if caller_workspace_id is not None:
        from apps.api.auth import workspace_context as _wsc
        monkeypatch.setattr(_wsc, "get_active_workspace_id", lambda: caller_workspace_id)


def test_cloud_archive_and_restore_write_supabase_manifest(monkeypatch, tmp_path):
    main = _load_cloud_main(monkeypatch, tmp_path)
    workers = _FakeWorkers(owner_id="user_fede")
    repos = SimpleNamespace(workers=workers)

    _make_archive_request(monkeypatch, main, caller_user_id="user_fede", caller_role="admin")
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: repos)

    archived = asyncio.run(
        main._cloud_set_worker_archived("worker-archive-test", object(), archived=True)
    )

    assert archived["archived"] is True
    assert workers.updates[-1]["manifest_json"]["archived"] is True
    assert workers.updates[-1]["manifest_json"]["archive_reason"].startswith("Archived ")

    restored = asyncio.run(
        main._cloud_set_worker_archived("worker-archive-test", object(), archived=False)
    )

    assert restored == {
        "id": "worker-archive-test",
        "archived": False,
        "archive_reason": None,
    }
    assert "archived" not in workers.updates[-1]["manifest_json"]
    assert "archive_reason" not in workers.updates[-1]["manifest_json"]


def test_member_cannot_archive_shared_worker_they_do_not_own(monkeypatch, tmp_path):
    """#1165: a non-owner member must receive 403, not mutate the shared worker."""
    main = _load_cloud_main(monkeypatch, tmp_path)
    # Worker is owned by admin_user; attacker_member is a regular workspace member.
    workers = _FakeWorkers(owner_id="admin_user")
    repos = SimpleNamespace(workers=workers)

    _make_archive_request(monkeypatch, main, caller_user_id="attacker_member", caller_role="member")
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: repos)

    with pytest.raises(main.HTTPException) as exc_info:
        asyncio.run(
            main._cloud_set_worker_archived("worker-archive-test", object(), archived=True)
        )

    assert exc_info.value.status_code == 403
    assert workers.updates == [], "manifest must not have been modified"


def test_admin_can_archive_any_workspace_worker(monkeypatch, tmp_path):
    """#1165: workspace admin (not the owner) is allowed to archive a shared worker."""
    main = _load_cloud_main(monkeypatch, tmp_path)
    workers = _FakeWorkers(owner_id="owner_user")
    repos = SimpleNamespace(workers=workers)

    _make_archive_request(monkeypatch, main, caller_user_id="admin_user", caller_role="admin")
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: repos)

    result = asyncio.run(
        main._cloud_set_worker_archived("worker-archive-test", object(), archived=True)
    )

    assert result["archived"] is True
    assert len(workers.updates) == 1


def test_admin_cannot_archive_other_workspace_worker_by_id(monkeypatch, tmp_path):
    main = _load_cloud_main(monkeypatch, tmp_path)
    workers = _FakeWorkers(owner_id="owner_user")
    repos = SimpleNamespace(workers=workers)

    original_get_any = workers.get_any

    def get_any_other_workspace(*, worker_id: str):
        row = original_get_any(worker_id=worker_id)
        if row is not None:
            row["workspace_id"] = "ws_b"
        return row

    workers.get_any = get_any_other_workspace

    _make_archive_request(
        monkeypatch,
        main,
        caller_user_id="admin_user",
        caller_role="admin",
        caller_workspace_id="ws_a",
    )
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: repos)

    with pytest.raises(main.HTTPException) as exc_info:
        asyncio.run(
            main._cloud_set_worker_archived("worker-archive-test", object(), archived=True)
        )

    assert exc_info.value.status_code == 404
    assert workers.updates == []


def test_visibility_patch_hides_same_owner_other_workspace_worker(monkeypatch, tmp_path):
    main = _load_cloud_main(monkeypatch, tmp_path)
    workers = _VisibilityWorkers()
    repos = SimpleNamespace(workers=workers)

    async def verify(_self, _request):
        return SimpleNamespace(user_id="user_fede")

    monkeypatch.setattr("apps.api.auth.supabase_provider.SupabaseAuthProvider.verify", verify)
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: repos)

    with pytest.raises(main.HTTPException) as exc_info:
        asyncio.run(
            main.cloud_set_worker_visibility("foreign-worker", _VisibilityRequest())
        )

    assert exc_info.value.status_code == 404
    assert workers.visibility_set == []


def test_clone_link_hides_same_owner_other_workspace_worker(monkeypatch, tmp_path):
    main = _load_cloud_main(monkeypatch, tmp_path)
    workers = _CloneLinkWorkers()
    repos = SimpleNamespace(workers=workers)

    async def verify(_self, _request):
        return SimpleNamespace(user_id="user_fede")

    monkeypatch.setattr("apps.api.auth.supabase_provider.SupabaseAuthProvider.verify", verify)
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: repos)

    with pytest.raises(main.HTTPException) as exc_info:
        asyncio.run(
            main.cloud_generate_clone_link("foreign-worker", object())
        )

    assert exc_info.value.status_code == 404
    assert workers.clone_tokens == []


def test_clone_link_allows_same_workspace_owner(monkeypatch, tmp_path):
    main = _load_cloud_main(monkeypatch, tmp_path)
    workers = _CloneLinkWorkers(
        row={
            "id": "worker-same-workspace",
            "user_id": "user_fede",
            "owner_id": "user_fede",
            "workspace_id": "ws_a",
        }
    )
    repos = SimpleNamespace(workers=workers)

    async def verify(_self, _request):
        return SimpleNamespace(user_id="user_fede")

    monkeypatch.setattr("apps.api.auth.supabase_provider.SupabaseAuthProvider.verify", verify)
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: repos)

    result = asyncio.run(
        main.cloud_generate_clone_link("worker-same-workspace", object())
    )

    assert result["token"].startswith("wct_")
    assert len(workers.clone_tokens) == 1
    worker_id, token_hash, expires_at = workers.clone_tokens[0]
    assert worker_id == "worker-same-workspace"
    assert token_hash != result["token"]
    assert expires_at == result["expires_at"]
