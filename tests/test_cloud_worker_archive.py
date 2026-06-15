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
            "manifest": dict(self.manifest),
            "manifest_json": dict(self.manifest),
        }

    def get(self, *, user_id: str, worker_id: str):
        # Retained for other callers; archive/restore now uses get_any.
        row = self.get_any(worker_id=worker_id)
        if row is None or str(row["user_id"]) != str(user_id):
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


def _make_archive_request(monkeypatch, main, *, caller_user_id: str, caller_role: str | None = None):
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
