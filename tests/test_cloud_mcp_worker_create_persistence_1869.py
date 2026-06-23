from __future__ import annotations

import importlib
import sys
import types
from types import SimpleNamespace


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
    for name in [
        "apps.api.startup",
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


def test_hosted_mcp_workers_create_persists_files_when_disk_is_cold(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    def fake_engine_create(arguments, auth, repos):
        return {"isError": False, "structuredContent": {"id": "mcp-worker"}}

    captured = {}
    main.engine_main._mcp_call_workers_create = fake_engine_create
    monkeypatch.setattr(main, "_read_worker_files_from_disk", lambda _worker_id: {})
    monkeypatch.setattr(
        main,
        "_cloud_persist_worker_files",
        lambda worker_id, files, repos: captured.update(
            {"worker_id": worker_id, "files": files, "repos": repos}
        ),
    )

    main._install_cloud_mcp_worker_create_persistence()
    repos = SimpleNamespace(name="repos")
    result = main.engine_main._mcp_call_workers_create(
        {
            "worker_yml": "id: mcp-worker\n",
            "run_py": "print('ok')\n",
            "skill_md": "# Tool notes\n",
        },
        SimpleNamespace(user_id="u1"),
        repos,
    )

    assert result["isError"] is False
    assert captured == {
        "worker_id": "mcp-worker",
        "files": {
            "worker.yml": "id: mcp-worker\n",
            "run.py": "print('ok')\n",
            "SKILL.md": "# Tool notes\n",
        },
        "repos": repos,
    }

