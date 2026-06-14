from __future__ import annotations

import asyncio
import hashlib
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
    def __init__(self, *, source: dict | None, expected_token: str | None = None):
        self.source = source
        self.expected_hash = hashlib.sha256(expected_token.encode()).hexdigest() if expected_token else None
        self.queries: list[str] = []

    def get_by_clone_token(self, *, token_hash: str):
        self.queries.append(token_hash)
        if self.expected_hash is None or token_hash == self.expected_hash:
            return dict(self.source) if self.source else None
        return None


class _FakeTable:
    def __init__(self, client, name: str):
        self.client = client
        self.name = name
        self.filters: list[tuple[str, object]] = []
        self.payload = None

    def select(self, *_args, **_kwargs):
        return self

    def insert(self, payload):
        self.payload = payload
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        if self.payload is not None:
            self.client.inserted.setdefault(self.name, []).append(self.payload)
            return SimpleNamespace(data=[self.payload])
        rows = list(self.client.rows.get(self.name, []))
        for key, value in self.filters:
            rows = [row for row in rows if row.get(key) == value]
        return SimpleNamespace(data=rows)


class _FakeSupabase:
    def __init__(self, rows: dict[str, list[dict]]):
        self.rows = rows
        self.inserted: dict[str, list[dict]] = {}

    def table(self, name: str):
        return _FakeTable(self, name)


def _source_worker():
    return {
        "id": "victim-worker",
        "owner_id": "victim-user",
        "user_id": "victim-user",
        "workspace_id": "ws-victim",
        "skill_version_id": "sv-secret",
        "clone_token_expires_at": "2999-01-01T00:00:00+00:00",
    }


def _wire_clone(monkeypatch, main, *, workers, service):
    async def verify(_self, _request):
        return SimpleNamespace(
            user_id="attacker-user",
            email="attacker@test.dev",
            scopes=(),
            role="member",
            auth_method="jwt",
        )

    monkeypatch.setattr(
        "apps.api.auth.supabase_provider.SupabaseAuthProvider.verify",
        verify,
    )
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: SimpleNamespace(workers=workers))
    monkeypatch.setattr(main.engine_main, "DraftFile", SimpleNamespace)
    monkeypatch.setattr(main, "_read_worker_files_from_disk", lambda _worker_id: {})
    monkeypatch.setattr(main, "_cloud_persist_worker_files", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("apps.api.config.get_supabase_service_client", lambda: service)


def test_clone_rejects_derivable_non_share_token_before_file_read(monkeypatch, tmp_path):
    main = _load_cloud_main(monkeypatch, tmp_path)
    workers = _FakeWorkers(source=_source_worker())
    service = _FakeSupabase(
        {
            "skill_versions": [
                {
                    "id": "sv-secret",
                    "manifest_json": {"_files": {"worker.yml": "id: victim\n"}},
                }
            ]
        }
    )
    _wire_clone(monkeypatch, main, workers=workers, service=service)

    def must_not_register(*_args, **_kwargs):
        raise AssertionError("invalid clone token must not register worker")

    monkeypatch.setattr(main.engine_main, "_register_worker_from_files", must_not_register)

    with pytest.raises(main.HTTPException) as exc:
        asyncio.run(main.cloud_clone_worker("victim-worker", object()))

    assert exc.value.status_code == 404
    assert workers.queries == []
    assert service.inserted == {}


def test_public_clone_link_cross_tenant_clone_is_audited(monkeypatch, tmp_path):
    main = _load_cloud_main(monkeypatch, tmp_path)
    token = "wct_" + ("A" * 43)
    workers = _FakeWorkers(source=_source_worker(), expected_token=token)
    service = _FakeSupabase(
        {
            "skill_versions": [
                {
                    "id": "sv-secret",
                    "manifest_json": {
                        "_files": {
                            "worker.yml": "id: victim\nname: Victim\n",
                            "run.py": "print('secret workflow')\n",
                        }
                    },
                }
            ]
        }
    )
    _wire_clone(monkeypatch, main, workers=workers, service=service)

    register_calls = []

    def fake_register(draft_files, *, user_id, repos=None, dedupe_id=False):
        register_calls.append(
            {
                "user_id": user_id,
                "dedupe_id": dedupe_id,
                "paths": sorted(file.path for file in draft_files),
            }
        )
        return "cloned-worker"

    monkeypatch.setattr(main.engine_main, "_register_worker_from_files", fake_register)

    result = asyncio.run(main.cloud_clone_worker(token, object()))

    assert result["worker_id"] == "cloned-worker"
    assert result["cloned_from"] == "victim-worker"
    assert register_calls == [
        {
            "user_id": "attacker-user",
            "dedupe_id": True,
            "paths": ["run.py", "worker.yml"],
        }
    ]
    assert service.inserted["admin_access_log"] == [
        {
            "workspace_id": "ws-victim",
            "admin_user_id": "attacker-user",
            "target_user_id": "victim-user",
            "resource_type": "worker_clone_link",
            "resource_id": "victim-worker",
        }
    ]
