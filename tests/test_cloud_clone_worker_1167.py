"""Regression tests for #1167: cloud clone endpoint correct signature + return type.

_register_worker_from_files has keyword-only args (user_id, repos, dedupe_id) and
returns a str (worker id), not a dict. The cloud clone route must call it with the
correct contract and use the string return value directly.
"""
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

    for name in ["apps.api.main", "main", "db", "models", "worker_registry", "run_service", "chat_service"]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


def _valid_token() -> str:
    return "wct_" + ("B" * 43)


def _wire_clone(monkeypatch, main, *, token: str, register_return: object):
    """Set up monkeypatches for cloud_clone_worker. register_return is what
    _register_worker_from_files returns — tests pass a str or a dict to verify
    the route handles both correctly."""
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    source = {
        "id": "src-worker",
        "owner_id": "owner-user",
        "user_id": "owner-user",
        "workspace_id": "ws-src",
        "skill_version_id": "sv-1",
        "clone_token_expires_at": "2999-01-01T00:00:00+00:00",
    }

    class _FakeWorkers:
        def get_by_clone_token(self, *, token_hash: str):
            return source

    async def verify(_self, _request):
        return SimpleNamespace(
            user_id="clone-user",
            email="clone@test.dev",
            scopes=(),
            role="member",
            auth_method="jwt",
        )

    register_calls = []

    def fake_register(draft_files, *, user_id, repos=None, dedupe_id=False):
        register_calls.append({"user_id": user_id, "dedupe_id": dedupe_id})
        return register_return

    monkeypatch.setattr("apps.api.auth.supabase_provider.SupabaseAuthProvider.verify", verify)
    monkeypatch.setattr(
        main.engine_main, "get_repositories",
        lambda: SimpleNamespace(workers=_FakeWorkers()),
    )
    monkeypatch.setattr(main.engine_main, "DraftFile", SimpleNamespace)
    monkeypatch.setattr(main.engine_main, "_register_worker_from_files", fake_register)
    monkeypatch.setattr(main, "_read_worker_files_from_disk", lambda _: {})
    monkeypatch.setattr(main, "_cloud_persist_worker_files", lambda *_a, **_kw: None)
    monkeypatch.setattr(main, "_audit_public_clone_link_use", lambda **_kw: None)

    # Supabase: skill_versions has the source worker's files.
    class _FakeTable:
        def select(self, *_, **__): return self
        def eq(self, *_, **__): return self
        def limit(self, *_, **__): return self
        def execute(self): return SimpleNamespace(data=[{"id": "sv-1", "manifest_json": {"_files": {"worker.yml": "id: src\n"}}}])

    class _FakeSvc:
        def table(self, _name): return _FakeTable()
        def storage(self): return None

    monkeypatch.setattr("apps.api.config.get_supabase_service_client", lambda: _FakeSvc())

    return register_calls


def test_clone_calls_register_with_keyword_args_and_returns_worker_id(monkeypatch, tmp_path):
    """#1167: _register_worker_from_files must be called with keyword-only args."""
    main = _load_cloud_main(monkeypatch, tmp_path)
    token = _valid_token()
    register_calls = _wire_clone(monkeypatch, main, token=token, register_return="new-worker-id")

    result = asyncio.run(main.cloud_clone_worker(token, object()))

    # Route must use the string return value directly, not call .get() on it.
    assert result["worker_id"] == "new-worker-id"
    assert result["cloned_from"] == "src-worker"
    assert len(register_calls) == 1
    call = register_calls[0]
    assert call["user_id"] == "clone-user"
    assert call["dedupe_id"] is True  # deduplication must be enabled for clone


def test_clone_handles_string_return_from_register(monkeypatch, tmp_path):
    """#1167: route must not call .get() on the str return value from the helper."""
    main = _load_cloud_main(monkeypatch, tmp_path)
    token = _valid_token()
    # If the route did new_worker.get("id") on a str, it would raise AttributeError.
    _wire_clone(monkeypatch, main, token=token, register_return="string-worker-id")

    # Must not raise AttributeError / TypeError.
    result = asyncio.run(main.cloud_clone_worker(token, object()))
    assert result["worker_id"] == "string-worker-id"
