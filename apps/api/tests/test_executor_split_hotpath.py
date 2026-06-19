from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _worker_config(worker_id: str, *, name: str = "Worker", secrets: list[str] | None = None):
    from models import WorkerConfig, WorkerRuntime, WorkerTrigger

    return WorkerConfig(
        id=worker_id,
        name=name,
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b", entrypoint="run.py"),
        secrets=secrets or [],
    )


def _fresh_run_service(monkeypatch):
    for name in ["run_service", "services.run_secrets"]:
        sys.modules.pop(name, None)
    monkeypatch.setenv("WORKEROS_RUN_RECIPE_CACHE_TTL_SECONDS", "60")
    monkeypatch.setenv("WORKEROS_RUN_SECRET_CACHE_TTL_SECONDS", "60")
    return importlib.import_module("run_service")


def test_workeros_role_web_disables_executor_loops(monkeypatch):
    run_service = _fresh_run_service(monkeypatch)
    monkeypatch.setenv("WORKEROS_ROLE", "web")

    assert run_service.workeros_role() == "web"
    assert run_service.execution_role_enabled() is False

    run_service.start_drain_loop()
    run_service.start_run_reaper_loop()

    assert run_service._drain_thread is None
    assert run_service._run_reaper_thread is None


def test_worker_recipe_cache_hits_and_invalidates(monkeypatch):
    run_service = _fresh_run_service(monkeypatch)
    calls = {"count": 0}

    class Workers:
        def get_recipe(self, *, worker_id, user_id=None):
            calls["count"] += 1
            return {
                "owner_id": "owner-1",
                "config": _worker_config(worker_id, name=f"Worker {calls['count']}"),
                "grants": {},
                "input_values": {},
                "enabled": True,
            }

    repos = types.SimpleNamespace(workers=Workers())

    first = run_service._load_worker_recipe("cache-worker", repos=repos)
    second = run_service._load_worker_recipe("cache-worker", repos=repos)

    assert calls["count"] == 1
    assert first[1].name == "Worker 1"
    assert second[1].name == "Worker 1"

    run_service.invalidate_worker_run_cache("cache-worker")
    third = run_service._load_worker_recipe("cache-worker", repos=repos)

    assert calls["count"] == 2
    assert third[1].name == "Worker 2"


def test_secret_cache_hits_and_invalidates(monkeypatch):
    run_service = _fresh_run_service(monkeypatch)
    calls = {"resolve": 0, "list": 0}

    class Workers:
        def get_owner(self, *, worker_id):
            return "owner-1"

        def get_recipe(self, *, worker_id, user_id=None):
            return {
                "owner_id": "owner-1",
                "config": _worker_config(worker_id, secrets=["API_KEY"]),
                "grants": {},
                "input_values": {},
                "enabled": True,
            }

    class Secrets:
        def list_names(self, *, user_id):
            calls["list"] += 1
            return {"API_KEY"}

        def resolve(self, *, user_id, names):
            calls["resolve"] += 1
            return {"API_KEY": f"value-{calls['resolve']}"}

    repos = types.SimpleNamespace(workers=Workers(), secrets=Secrets())

    first = run_service.get_secrets_for_worker("secret-worker", user_id="owner-1", repos=repos)
    second = run_service.get_secrets_for_worker("secret-worker", user_id="owner-1", repos=repos)

    assert calls["resolve"] == 1
    assert first == {"API_KEY": "value-1"}
    assert second == {"API_KEY": "value-1"}

    run_service.invalidate_secret_run_cache("owner-1")
    third = run_service.get_secrets_for_worker("secret-worker", user_id="owner-1", repos=repos)

    assert calls["resolve"] == 2
    assert third == {"API_KEY": "value-2"}


def test_async_log_flush_uses_bulk_repository(monkeypatch):
    run_service = _fresh_run_service(monkeypatch)
    monkeypatch.setenv("WORKEROS_ASYNC_LOG_FLUSH", "1")
    monkeypatch.setenv("WORKEROS_LOG_FLUSH_BATCH_SIZE", "10")
    monkeypatch.setenv("WORKEROS_LOG_FLUSH_INTERVAL_SECONDS", "0.01")

    batches: list[list[dict[str, object]]] = []

    class Runs:
        def add_logs(self, *, rows):
            batches.append(list(rows))

        def add_log(self, **_kwargs):
            raise AssertionError("single-row add_log should not be used when add_logs exists")

    repos = types.SimpleNamespace(runs=Runs())
    run_service._persist_log_batch(
        [
            run_service._PendingLog("owner-1", "run-1", "info", "one", "2026-01-01T00:00:00+00:00", None),
            run_service._PendingLog("owner-1", "run-1", "debug", "two", "2026-01-01T00:00:01+00:00", "trace"),
        ],
        repos=repos,
    )

    assert len(batches) == 1
    assert [row["message"] for row in batches[0]] == ["one", "two"]
