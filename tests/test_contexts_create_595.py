from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient


_FERNET_KEY = "IImexS_KvooCeAYzCQ9qVQb_cZ3u7k8euZ8HK-dteOg="
_WORKSPACE_ID = "ws_0123456789abcd"


class _FakeStorageBucket:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def upload(self, *, path: str, file: bytes, file_options: dict | None = None) -> None:
        self.objects[path] = file

    def update(self, path: str, file: bytes, file_options: dict | None = None) -> None:
        self.objects[path] = file

    def download(self, path: str) -> bytes:
        if path not in self.objects:
            raise KeyError(path)
        return self.objects[path]

    def list(self, prefix: str) -> list[dict[str, Any]]:
        prefix = prefix.strip("/")
        root = prefix + "/" if prefix else ""
        seen: dict[str, bool] = {}
        for path in self.objects:
            if not path.startswith(root):
                continue
            rest = path[len(root):]
            if not rest:
                continue
            name, _, remainder = rest.partition("/")
            seen[name] = seen.get(name, False) or not bool(remainder)
        return [
            {
                "name": name,
                "id": f"id-{name}" if is_file else None,
                "metadata": {"size": 1} if is_file else None,
            }
            for name, is_file in seen.items()
        ]

    def remove(self, paths: list[str]) -> None:
        for path in paths:
            self.objects.pop(path, None)


class _FakeStorage:
    def __init__(self) -> None:
        self.bucket = _FakeStorageBucket()

    def create_bucket(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def from_(self, _bucket: str) -> _FakeStorageBucket:
        return self.bucket


class _FakeSupabase:
    def __init__(self) -> None:
        self.storage = _FakeStorage()


def _load_cloud_main(monkeypatch, tmp_path, fake_supabase):
    (tmp_path / "workers").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_ANON_KEY", "test-anon")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", "test-service")
    monkeypatch.setenv("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY", _FERNET_KEY)
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    psycopg = types.ModuleType("psycopg")
    psycopg.Connection = object
    psycopg.connect = lambda *_args, **_kwargs: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)

    import apps.api.config as cloud_config

    monkeypatch.setattr(cloud_config, "get_supabase_service_client", lambda: fake_supabase)

    for name in list(sys.modules):
        if (
            name
            in {
                "apps.api._engine",
                "apps.api.cloud_git",
                "apps.api.cloud_git_local",
                "apps.api.main",
                "apps.api.startup",
                "main",
                "db",
                "contexts",
                "auth",
            }
            or name.startswith(("routers", "services", "auth.", "db."))
        ):
            sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


def _wire_cloud_auth_and_repos(monkeypatch, main, tmp_path, workspace_id: str = _WORKSPACE_ID):
    import apps.api.auth.supabase_provider as supabase_provider
    from apps.api.auth.workspace_context import set_active_member_role, set_active_workspace_id
    import db
    import worker_registry
    from db.factory import _local_repositories

    db.init_db()
    db.register_repositories("cloud", _local_repositories)
    repos = db.get_repositories()
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", tmp_path / "workers")

    async def verify(_self, _request):
        set_active_workspace_id(workspace_id)
        set_active_member_role("admin")
        return SimpleNamespace(
            user_id="u1",
            email="u1@test.dev",
            scopes=(),
            role="admin",
            auth_method="pat",
        )

    monkeypatch.setattr(supabase_provider.SupabaseAuthProvider, "verify", verify)
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: repos)
    monkeypatch.setattr(main, "_cloud_persist_worker_files", lambda *_args, **_kwargs: None)
    return repos


def test_cloud_context_create_write_list_and_worker_push_source_local(monkeypatch, tmp_path):
    fake_supabase = _FakeSupabase()
    # Simulate a Storage-known pack with missing metadata. The regressed create
    # path hydrated this before setting owner metadata, then returned 404.
    fake_supabase.storage.bucket.objects[f"{_WORKSPACE_ID}/fede-crm/stale.csv"] = b"stale\n"

    main = _load_cloud_main(monkeypatch, tmp_path, fake_supabase)
    _wire_cloud_auth_and_repos(monkeypatch, main, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=False)

    created = client.post(
        "/contexts/fede-crm",
        json={"writeable": True, "sensitive": False, "category": "data"},
        headers={"x-workeros-workspace": _WORKSPACE_ID},
    )
    assert created.status_code == 200, created.text
    assert created.json()["name"] == "fede-crm"
    assert created.json()["files"] == []

    wrote = client.put(
        "/contexts/fede-crm/files/crm.csv",
        json={"content": "company,email\nAcme,ops@acme.test\n"},
        headers={"x-workeros-workspace": _WORKSPACE_ID},
    )
    assert wrote.status_code == 200, wrote.text
    assert wrote.json()["path"] == "crm.csv"

    listed = client.get("/contexts", headers={"x-workeros-workspace": _WORKSPACE_ID})
    assert listed.status_code == 200, listed.text
    packs = {item["name"]: item for item in listed.json()}
    assert packs["fede-crm"]["file_count"] == 1

    worker_yml = """\
schema_version: "0.3"
name: "crm-reader"
title: "CRM Reader"
description: "Reads CRM context"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections: []
contexts:
  - name: "fede-crm"
    source: "local"
"""
    pushed = client.post(
        "/workers",
        json={"worker_yml": worker_yml, "run_py": "def run(inputs, context):\n    return {'ok': True}\n"},
        headers={"x-workeros-workspace": _WORKSPACE_ID, "x-floom-workspace": _WORKSPACE_ID},
    )
    assert pushed.status_code == 200, pushed.text
    contexts = {
        item["name"]: item
        for item in pushed.json()["config"]["contexts"]
    }
    assert contexts["fede-crm"]["source"] == "local"
    assert contexts["fede-crm"]["writeable"] is False

    again = client.post(
        "/api/contexts/fede-crm",
        json={"writeable": True, "sensitive": False},
        headers={"x-workeros-workspace": _WORKSPACE_ID},
    )
    assert again.status_code == 200, again.text
