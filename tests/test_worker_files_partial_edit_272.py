"""Regression test for #272 item 2 — PUT /workers/{id}/files partial edit.

Editing only run.py (no worker.yml) returned 400 "worker.yml did not parse to
a dict" because the cloud route validated worker.yml unconditionally
(safe_load("") -> None). And the persist step wrote only the submitted subset
into _files, dropping the other files. Now: worker.yml is validated only when
included, and the FULL post-edit on-disk set is persisted.
"""

from __future__ import annotations

import asyncio
import importlib
import sys
import types
from types import SimpleNamespace

import pytest


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_URL", "https://test-project.supabase.co")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_ANON_KEY", "test-anon-key")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
    from cryptography.fernet import Fernet
    monkeypatch.setenv("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.delenv("WORKEROS_RATE_LIMIT_DEV", raising=False)
    psycopg = types.ModuleType("psycopg")
    psycopg.Connection = object
    psycopg.connect = lambda *_a, **_k: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)
    for name in ["apps.api.startup", "apps.api.main", "main", "db", "models",
                 "worker_registry", "run_service", "chat_service"]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


class _Req:
    def __init__(self, body):
        self._b = body
        self.headers = {}

    async def json(self):
        return self._b


def _setup(monkeypatch, main, *, disk_files):
    import apps.api.auth.supabase_provider as sp
    import apps.api.db.supabase_repos as repos_mod

    async def _verify(self, request):
        return SimpleNamespace(user_id="u1", email="e@x.com", scopes=(), role="member", auth_method="pat")

    monkeypatch.setattr(sp.SupabaseAuthProvider, "verify", _verify)
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: SimpleNamespace())
    monkeypatch.setattr(main.engine_main, "update_worker_files", lambda *a, **k: {"ok": True})
    monkeypatch.setattr(repos_mod, "_read_worker_files_from_disk", lambda wid: dict(disk_files))
    captured: dict = {}
    monkeypatch.setattr(main, "_cloud_persist_worker_files",
                        lambda wid, files, repos: captured.update({"files": files}))
    return captured


def test_partial_edit_without_worker_yml_succeeds_and_persists_full_set(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    captured = _setup(monkeypatch, main, disk_files={"run.py": "new", "worker.yml": "name: w"})
    req = _Req({"files": [{"path": "run.py", "content": "new"}]})
    result = asyncio.run(main.cloud_update_worker_files("w1", req))
    assert result == {"ok": True}  # no 400 on the partial edit
    # persisted the FULL on-disk set, not just the submitted run.py
    assert captured["files"] == {"run.py": "new", "worker.yml": "name: w"}


def test_invalid_worker_yml_when_submitted_still_400(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    _setup(monkeypatch, main, disk_files={})
    req = _Req({"files": [{"path": "worker.yml", "content": "just a string"}]})
    with pytest.raises(main.HTTPException) as ei:
        asyncio.run(main.cloud_update_worker_files("w1", req))
    assert ei.value.status_code == 400
    assert "worker.yml" in str(ei.value.detail)


def test_valid_full_edit_succeeds(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    captured = _setup(monkeypatch, main, disk_files={"worker.yml": "name: w", "run.py": "x"})
    req = _Req({"files": [{"path": "worker.yml", "content": "name: w"}, {"path": "run.py", "content": "x"}]})
    assert asyncio.run(main.cloud_update_worker_files("w1", req)) == {"ok": True}


def test_empty_files_list_400(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    _setup(monkeypatch, main, disk_files={})
    with pytest.raises(main.HTTPException) as ei:
        asyncio.run(main.cloud_update_worker_files("w1", _Req({"files": []})))
    assert ei.value.status_code == 400
