from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _worker_config(
    worker_id: str,
    *,
    name: str = "Worker",
    secrets: list[str] | None = None,
    inputs: list[object] | None = None,
):
    from models import WorkerConfig, WorkerRuntime, WorkerTrigger

    return WorkerConfig(
        id=worker_id,
        name=name,
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b", entrypoint="run.py"),
        inputs=inputs or [],
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


def test_worker_recipe_cache_is_scoped_by_run_owner_and_workspace(monkeypatch):
    run_service = _fresh_run_service(monkeypatch)
    calls = []

    class Workers:
        def get_recipe(self, *, worker_id, user_id=None, workspace_id=None):
            calls.append((user_id, workspace_id))
            if user_id != "owner-1" or workspace_id != "ws-716":
                return None
            return {
                "owner_id": "owner-1",
                "config": _worker_config(worker_id, name="Scoped Worker"),
                "grants": {},
                "input_values": {},
                "enabled": True,
            }

        def get_owner(self, *, worker_id):
            return "owner-1"

    repos = types.SimpleNamespace(workers=Workers())

    unscoped = run_service._load_worker_recipe("schedule-worker", repos=repos)
    scoped = run_service._load_worker_recipe(
        "schedule-worker",
        repos=repos,
        user_id="owner-1",
        workspace_id="ws-716",
    )

    assert unscoped is None
    assert scoped is not None
    assert scoped[1].name == "Scoped Worker"
    assert calls == [(None, None), ("owner-1", "ws-716")]


def test_scheduled_execute_run_uses_run_workspace_for_recipe_without_request_context(monkeypatch):
    run_service = _fresh_run_service(monkeypatch)
    from models import WorkerInput

    statuses = []

    class Workers:
        def get_recipe(self, *, worker_id, user_id=None, workspace_id=None):
            if user_id != "owner-1" or workspace_id != "ws-716":
                return None
            return {
                "owner_id": "owner-1",
                "config": _worker_config(
                    worker_id,
                    inputs=[
                        WorkerInput(
                            name="required_text",
                            label="Required text",
                            type="text",
                            required=True,
                        )
                    ],
                ),
                "grants": {},
                "input_values": {},
                "enabled": True,
            }

        def get_owner(self, *, worker_id):
            return "owner-1"

    class Runs:
        def get_any(self, *, run_id):
            return {
                "id": run_id,
                "worker_id": "schedule-worker",
                "user_id": "owner-1",
                "workspace_id": "ws-716",
                "status": "queued",
            }

    repos = types.SimpleNamespace(workers=Workers(), runs=Runs())

    monkeypatch.setattr(run_service, "add_log", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "publish_run_part", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "_mark_active_run_stage", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        run_service,
        "update_run_status",
        lambda run_id, status, **kwargs: statuses.append(
            {
                "run_id": run_id,
                "status": status,
                "error": kwargs.get("error"),
                "error_code": kwargs.get("error_code"),
            }
        ),
    )

    run_service.execute_run(
        "run-scheduled",
        "schedule-worker",
        {},
        user_id=None,
        repos=repos,
    )

    assert statuses[-1] == {
        "run_id": "run-scheduled",
        "status": "failed",
        "error": "Missing required input: required_text",
        "error_code": "missing_required_input",
    }
    assert all(item["error"] != "Worker config not found" for item in statuses)


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
            return {"API_KEY", "UNDECLARED_API_KEY"}

        def resolve(self, *, user_id, names):
            calls["resolve"] += 1
            assert set(names) == {"API_KEY"}
            return {
                "API_KEY": f"value-{calls['resolve']}",
                "UNDECLARED_API_KEY": "must-not-ship",
            }

    repos = types.SimpleNamespace(workers=Workers(), secrets=Secrets())

    first = run_service.get_secrets_for_worker("secret-worker", user_id="owner-1", repos=repos)
    second = run_service.get_secrets_for_worker("secret-worker", user_id="owner-1", repos=repos)

    assert calls["resolve"] == 1
    assert calls["list"] == 0
    assert first == {"API_KEY": "value-1"}
    assert second == {"API_KEY": "value-1"}

    run_service.invalidate_secret_run_cache("owner-1")
    third = run_service.get_secrets_for_worker("secret-worker", user_id="owner-1", repos=repos)

    assert calls["resolve"] == 2
    assert calls["list"] == 0
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
