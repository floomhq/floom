from __future__ import annotations

from copy import deepcopy

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

    assert _apply(repos, "missing_secret") is True
    assert repos.workers.worker["enabled"] is False
    assert repos.workers.worker["manifest"]["paused"] is True
    assert repos.workers.worker["manifest"]["enabled"] is False
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
