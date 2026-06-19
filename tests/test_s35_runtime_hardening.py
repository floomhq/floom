from __future__ import annotations

import concurrent.futures
import importlib
import os
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

AUTH_HEADER = {"x-floom-secret": "test-secret-s35"}


def _load_api(monkeypatch, tmp_path, *, run_create_rate_limit: int = 30):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_SECRET", AUTH_HEADER["x-floom-secret"])
    monkeypatch.setenv("WORKEROS_RUN_CREATE_RATE_LIMIT", str(run_create_rate_limit))
    monkeypatch.setenv("WORKEROS_RUN_CREATE_RATE_WINDOW_SECONDS", "60")
    monkeypatch.delenv("WORKEROS_RATE_LIMIT_DEV", raising=False)

    reset_prefixes = ("auth.", "db.", "routers")
    reset_exact = {
        "main",
        "auth",
        "db",
        "files",
        "models",
        "worker_registry",
        "run_service",
        "runner_utils",
        "composio_client",
        "scheduler",
    }
    for name in list(sys.modules):
        if name in reset_exact or name.startswith(reset_prefixes):
            sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
        scheduler_status=lambda: {"ok": True, "enabled": False, "deploy": "local"},
    )
    main = importlib.import_module("main")
    main.get_auth_provider.cache_clear()
    return main


def _insert_minimal_worker(main, worker_id: str) -> None:
    now = main.now_iso()
    manifest = {
        "id": worker_id,
        "name": worker_id,
        "description": "S35 concurrency test worker",
        "title": worker_id,
        "version": "0.1.0",
        "runtime": {"type": "python311", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
        "trigger": {"type": "manual"},
    }
    with main.get_db() as conn:
        conn.execute(
            """
            INSERT INTO skill_versions
                (id, name, version, manifest_json, bundle_path, created_at)
            VALUES (?, ?, '0.1.0', ?, ?, ?)
            """,
            (
                f"sv_{worker_id}",
                worker_id,
                main.json.dumps(manifest),
                f"workers/{worker_id}",
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO workers
                (id, skill_version_id, name, trigger_type, grants_json,
                 input_values_json, enabled, created_at, owner_id)
            VALUES (?, ?, ?, 'manual', '{}', '{}', 1, ?, 'local-user')
            """,
            (worker_id, f"sv_{worker_id}", worker_id, now),
        )


def test_sqlite_connections_enable_wal_normal_sync_and_foreign_keys(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    settings = main.sqlite_runtime_settings()

    assert settings["journal_mode"] == "wal"
    assert settings["synchronous"] == 1
    assert settings["foreign_keys"] == 1
    assert settings["busy_timeout"] >= 1000


def test_run_creation_quota_is_global_per_user_not_ip_scoped(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, run_create_rate_limit=1)
    monkeypatch.setattr(main, "start_run", lambda *args, **kwargs: None)
    client = TestClient(main.app)
    worker_a = "s35-quota-a"
    worker_b = "s35-quota-b"
    _insert_minimal_worker(main, worker_a)
    _insert_minimal_worker(main, worker_b)

    first = client.post(
        f"/workers/{worker_a}/runs",
        headers={**AUTH_HEADER, "x-forwarded-for": "203.0.113.10"},
        json={"inputs": {}, "trigger_source": "manual"},
    )
    second_same_worker = client.post(
        f"/workers/{worker_a}/runs",
        headers={**AUTH_HEADER, "x-forwarded-for": "203.0.113.11"},
        json={"inputs": {}, "trigger_source": "manual"},
    )
    other_worker = client.post(
        f"/workers/{worker_b}/runs",
        headers={**AUTH_HEADER, "x-forwarded-for": "203.0.113.12"},
        json={"inputs": {}, "trigger_source": "manual"},
    )

    assert first.status_code == 200, first.text
    assert second_same_worker.status_code == 429, second_same_worker.text
    assert other_worker.status_code == 429, other_worker.text


def test_twenty_concurrent_run_creates_do_not_lock_sqlite(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, run_create_rate_limit=30)
    monkeypatch.setattr(main, "start_run", lambda *args, **kwargs: None)
    worker_id = "s35-concurrent-run-create"
    _insert_minimal_worker(main, worker_id)

    def post_run(index: int) -> tuple[int, str]:
        client = TestClient(main.app)
        response = client.post(
            f"/workers/{worker_id}/runs",
            headers=AUTH_HEADER,
            json={"inputs": {}, "trigger_source": f"s35_{index}"},
        )
        return response.status_code, response.text

    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(post_run, range(20)))

    assert [status for status, _body in results] == [200] * 20
    assert all("database is locked" not in body.lower() for _status, body in results)
