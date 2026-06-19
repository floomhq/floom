"""#1448: LLM-quota-aware run scheduling.

LLM calls run inside the E2B sandbox, so the engine cannot intercept them; the
lever it controls is run scheduling. A worker that declares manifest
`llm_intensive: true` takes an extra "LLM budget" slot
(WORKEROS_MAX_CONCURRENT_LLM_RUNS) when it is dispatched, so a burst of
judge-heavy runs cannot stack and 429 the shared provider quota. Non-intensive
runs are not gated.
"""

from __future__ import annotations

from models import RunStatus


def _manifest_llm(worker_id: str, name: str, *, llm_intensive: bool) -> dict:
    return {
        "id": worker_id,
        "name": name,
        "llm_intensive": llm_intensive,
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
    }


def test_worker_config_llm_intensive_field_defaults_false():
    from models import WorkerConfig

    cfg = WorkerConfig.model_validate(_manifest_llm("w", "W", llm_intensive=True))
    assert cfg.llm_intensive is True
    cfg_default = WorkerConfig.model_validate(
        {k: v for k, v in _manifest_llm("w", "W", llm_intensive=False).items() if k != "llm_intensive"}
    )
    assert cfg_default.llm_intensive is False


def test_llm_intensive_flag_read_from_db_manifest(repo_bundle):
    import run_service

    repos, _db, _manifest = repo_bundle
    repos.workers.create(
        user_id="user-a",
        worker_id="heavy",
        name="Heavy",
        manifest_json=_manifest_llm("heavy", "Heavy", llm_intensive=True),
        bundle_path="workers/heavy",
    )
    repos.workers.create(
        user_id="user-a",
        worker_id="light",
        name="Light",
        manifest_json=_manifest_llm("light", "Light", llm_intensive=False),
        bundle_path="workers/light",
    )
    assert run_service._worker_is_llm_intensive("heavy", repos) is True
    assert run_service._worker_is_llm_intensive("light", repos) is False
    assert run_service._worker_is_llm_intensive("missing", repos) is False


def test_max_concurrent_llm_runs_config(monkeypatch):
    import run_service

    monkeypatch.delenv("WORKEROS_MAX_CONCURRENT_LLM_RUNS", raising=False)
    # Unset -> falls back to the main run cap (i.e. no extra gating).
    assert run_service._max_concurrent_llm_runs() == run_service._max_concurrent_runs()
    monkeypatch.setenv("WORKEROS_MAX_CONCURRENT_LLM_RUNS", "2")
    assert run_service._max_concurrent_llm_runs() == 2
    monkeypatch.setenv("WORKEROS_MAX_CONCURRENT_LLM_RUNS", "garbage")
    assert run_service._max_concurrent_llm_runs() == run_service._max_concurrent_runs()


def test_drain_defers_llm_intensive_run_when_budget_full(repo_bundle, monkeypatch):
    """With the LLM budget exhausted, an llm-intensive queued run is left queued
    while a non-intensive run is still dispatched."""
    import run_service

    repos, _db, _manifest = repo_bundle
    repos.workers.create(
        user_id="user-a", worker_id="heavy", name="Heavy",
        manifest_json=_manifest_llm("heavy", "Heavy", llm_intensive=True),
        bundle_path="workers/heavy",
    )
    repos.workers.create(
        user_id="user-a", worker_id="light", name="Light",
        manifest_json=_manifest_llm("light", "Light", llm_intensive=False),
        bundle_path="workers/light",
    )
    repos.runs.create(user_id="user-a", run_id="run-heavy", worker_id="heavy",
                      status=RunStatus.QUEUED.value, trigger_source="manual", runner="e2b")
    repos.runs.create(user_id="user-a", run_id="run-light", worker_id="light",
                      status=RunStatus.QUEUED.value, trigger_source="manual", runner="e2b")

    # Budget of 1, fully consumed by a simulated in-flight heavy run.
    monkeypatch.setenv("WORKEROS_MAX_CONCURRENT_LLM_RUNS", "1")
    monkeypatch.setenv("WORKEROS_MAX_CONCURRENT_RUNS", "18")
    run_service._execution_semaphore = None
    run_service._llm_execution_semaphore = None
    assert run_service._get_llm_semaphore().acquire(blocking=False) is True  # consume the only slot

    dispatched: list[str] = []
    monkeypatch.setattr(
        run_service,
        "_run_thread_entry_with_semaphore",
        lambda *a, **k: dispatched.append(a[0]),
    )

    try:
        run_service._drain_one_batch()
    finally:
        # Restore semaphores so other tests start clean.
        run_service._execution_semaphore = None
        run_service._llm_execution_semaphore = None

    # The non-intensive run was dispatched; the llm-intensive one stayed queued.
    assert "run-light" in dispatched
    assert "run-heavy" not in dispatched
    assert repos.runs.get(user_id="user-a", run_id="run-heavy")["status"] == RunStatus.QUEUED.value
    assert repos.runs.get(user_id="user-a", run_id="run-light")["status"] == RunStatus.RUNNING.value
