from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import run_service
from models import WorkerConfig, WorkerResult, WorkerRuntime, WorkerTrigger
from services import run_pause_policy


class _Runs:
    def __init__(self, rows):
        self.rows = list(rows)

    def get(self, *, user_id, run_id):
        return next((row for row in self.rows if row["id"] == run_id), None)

    def list(self, *, user_id, worker_id, limit, offset):
        rows = [row for row in self.rows if row["worker_id"] == worker_id]
        return rows[offset : offset + limit], len(rows)


class _Workers:
    def __init__(self, worker):
        self.worker = deepcopy(worker)
        self.updates = []

    def get(self, *, user_id, worker_id):
        return deepcopy(self.worker)

    def update(self, *, user_id, worker_id, **fields):
        self.updates.append(dict(fields))
        self.worker.update(fields)
        if "manifest_json" in fields:
            self.worker["manifest"] = deepcopy(fields["manifest_json"])
        return deepcopy(self.worker)


class _Repos:
    def __init__(self, error_codes):
        self.runs = _Runs(
            [
                {
                    "id": f"run-{index}",
                    "worker_id": "worker-1",
                    "trigger_source": "schedule",
                    "status": "failed",
                    "error_code": error_code,
                }
                for index, error_code in enumerate(error_codes, start=1)
            ]
        )
        self.workers = _Workers(
            {
                "id": "worker-1",
                "enabled": True,
                "manifest": {"name": "Config loop", "enabled": True},
            }
        )


def _apply(repos, error_code):
    return run_pause_policy._maybe_pause_scheduled_worker_after_setup_failure(
        worker_id="worker-1",
        run_id="run-1",
        user_id="owner-1",
        error_code=error_code,
        repos=repos,
    )


def test_missing_secret_pauses_once_after_configured_threshold(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_SCHEDULE_MISSING_SECRET_PAUSE_AFTER", "3")
    monkeypatch.setattr("worker_registry.WORKERS_DIR", tmp_path)
    repos = _Repos(["missing_secret", "missing_secret", "missing_secret"])
    worker_yml = (
        'schema_version: "0.3"\n'
        "name: worker-1\n"
        "enabled: yes\n"
    )
    worker_dir = tmp_path / "worker-1"
    worker_dir.mkdir()
    (worker_dir / "worker.yml").write_text(worker_yml, encoding="utf-8")
    repos.workers.worker["manifest"]["_files"] = {"worker.yml": worker_yml}

    assert _apply(repos, "missing_secret") is True
    assert repos.workers.worker["enabled"] is False
    assert repos.workers.worker["manifest"]["paused"] is True
    assert repos.workers.worker["manifest"]["enabled"] is False
    import yaml

    disk_manifest = yaml.safe_load((worker_dir / "worker.yml").read_text(encoding="utf-8"))
    embedded_manifest = yaml.safe_load(
        repos.workers.worker["manifest"]["_files"]["worker.yml"]
    )
    assert disk_manifest["paused"] is True
    assert disk_manifest["enabled"] is False
    assert embedded_manifest["paused"] is True
    assert embedded_manifest["enabled"] is False
    assert len(repos.workers.updates) == 1

    assert _apply(repos, "missing_secret") is False
    assert len(repos.workers.updates) == 1


def test_llm_model_not_configured_is_terminal(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_SCHEDULE_MISSING_SECRET_PAUSE_AFTER", "3")
    monkeypatch.setattr("worker_registry.WORKERS_DIR", tmp_path)
    repos = _Repos(
        [
            "llm_model_not_configured",
            "llm_model_not_configured",
            "llm_model_not_configured",
        ]
    )

    assert _apply(repos, "llm_model_not_configured") is True
    assert repos.workers.worker["enabled"] is False


def test_transient_failures_never_pause(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_SCHEDULE_MISSING_SECRET_PAUSE_AFTER", "3")
    monkeypatch.setattr("worker_registry.WORKERS_DIR", tmp_path)

    for error_code in (
        "timeout",
        "e2b_sandbox_error",
        "e2b_transport_error",
        "llm_provider_error",
        "provider_error",
    ):
        repos = _Repos([error_code, error_code, error_code])
        assert _apply(repos, error_code) is False
        assert repos.workers.worker["enabled"] is True
        assert repos.workers.updates == []


def test_failed_agent_result_invokes_pause_policy_after_status_persist(monkeypatch):
    config = WorkerConfig(
        id="model-gap-worker",
        name="Model gap worker",
        trigger=WorkerTrigger(type="schedule", cron="0 * * * *"),
        runtime=WorkerRuntime(type="python", runner="e2b", mode="pure-script"),
        inputs=[],
        outputs=[],
        secrets=[],
        connections=[],
    )
    events = []

    class _RunsForExecution:
        def get_any(self, *, run_id):
            return {"id": run_id, "status": "running", "trigger_source": "schedule"}

    repos = SimpleNamespace(
        runs=_RunsForExecution(),
        workers=SimpleNamespace(get_any=lambda **_kwargs: {"name": "Model gap worker"}),
    )

    class _Driver:
        def run(self, **_kwargs):
            return WorkerResult(
                status="error",
                error="The platform AI model is not configured.",
                error_code="llm_model_not_configured",
                retryable=False,
            )

    monkeypatch.setattr(
        run_service,
        "_load_worker_recipe",
        lambda *_args, **_kwargs: (None, config, {"enabled": True}),
    )
    monkeypatch.setattr(run_service, "_worker_owner_id", lambda *_args, **_kwargs: "owner-1")
    monkeypatch.setattr(run_service, "_is_engine_approved_execution_run", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(run_service, "add_log", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "publish_run_part", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "_publish_sse", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "_mark_active_run_stage", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "get_secrets_for_worker", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(run_service, "get_sandbox_driver", lambda *_args, **_kwargs: _Driver())
    monkeypatch.setattr(
        run_service,
        "update_run_status",
        lambda run_id, status, **kwargs: events.append(
            ("status", status, kwargs.get("error_code"))
        ),
    )
    monkeypatch.setattr(
        run_service,
        "_maybe_pause_scheduled_worker_after_setup_failure",
        lambda **kwargs: events.append(
            ("pause", kwargs["run_id"], kwargs["error_code"])
        )
        or True,
    )
    monkeypatch.setattr(
        run_service,
        "_schedule_retry_for_failed_run",
        lambda **_kwargs: False,
    )

    run_service.execute_run(
        "run-model-gap",
        "model-gap-worker",
        {},
        user_id="owner-1",
        repos=repos,
    )

    assert events[:2] == [
        ("status", "failed", "llm_model_not_configured"),
        ("pause", "run-model-gap", "llm_model_not_configured"),
    ]
