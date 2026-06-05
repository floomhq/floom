from __future__ import annotations

import asyncio
import importlib
import sys
import types
from types import SimpleNamespace


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
    def __init__(self):
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

    def get(self, *, user_id: str, worker_id: str):
        if user_id != "user_fede" or worker_id != "worker-archive-test":
            return None
        return {
            "id": worker_id,
            "user_id": user_id,
            "manifest": dict(self.manifest),
            "manifest_json": dict(self.manifest),
        }

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


def test_cloud_archive_and_restore_write_supabase_manifest(monkeypatch, tmp_path):
    main = _load_cloud_main(monkeypatch, tmp_path)
    workers = _FakeWorkers()
    repos = SimpleNamespace(workers=workers)

    async def verify(_self, _request):
        return SimpleNamespace(user_id="user_fede")

    def build_worker_detail(worker_id: str, *, user_id: str, repos):
        worker = repos.workers.get(user_id=user_id, worker_id=worker_id)
        return {
            "id": worker_id,
            "archived": bool(worker["manifest_json"].get("archived", False)),
            "archive_reason": worker["manifest_json"].get("archive_reason"),
        }

    monkeypatch.setattr("apps.api.auth.supabase_provider.SupabaseAuthProvider.verify", verify)
    monkeypatch.setattr(main.engine_main, "_raise_if_protected_worker_mutation", lambda _worker_id: None)
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: repos)
    monkeypatch.setattr(main.engine_main, "_build_worker_detail", build_worker_detail)

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
