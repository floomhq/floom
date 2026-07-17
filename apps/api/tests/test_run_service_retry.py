from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service


class _Runs:
    def __init__(self, retry_attempt: int = 0):
        self.retry_attempt = retry_attempt

    def get_any(self, *, run_id: str):
        return {"id": run_id, "retry_attempt": self.retry_attempt}


class _Repos:
    def __init__(self, retry_attempt: int = 0):
        self.runs = _Runs(retry_attempt=retry_attempt)


class _RetryConfig:
    max_attempts = 3
    delay_seconds = 60

    def __init__(self, on=None):
        self.on = on or ["all"]


def test_retryable_driver_failure_schedules_one_retry(monkeypatch):
    scheduled: list[dict] = []
    logs: list[tuple[str, str]] = []

    def _fake_schedule_retry(**kwargs):
        scheduled.append(kwargs)
        return True

    monkeypatch.setattr(run_service, "_schedule_retry", _fake_schedule_retry)

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={"x": 1},
        owner_id="user-a",
        config=None,
        result_retryable=True,
        result_error_code="worker_runtime_error",
        repos=_Repos(),
        log_fn=lambda msg, level="info": logs.append((msg, level)),
    )

    assert did_schedule is True
    assert len(scheduled) == 1
    assert scheduled[0]["original_run_id"] == "run-original"
    assert scheduled[0]["worker_id"] == "worker-a"
    assert scheduled[0]["inputs"] == {"x": 1}
    assert scheduled[0]["attempt"] == 1
    assert scheduled[0]["delay_seconds"] == 60
    assert scheduled[0]["user_id"] == "user-a"
    assert isinstance(scheduled[0]["repos"], _Repos)
    assert any("Scheduling retryable failure 1/1 in 60s" in msg for msg, _level in logs)


def test_worker_config_not_found_is_permanent_and_does_not_retry(monkeypatch):
    scheduled: list[dict] = []
    logs: list[tuple[str, str]] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=True,
        result_error_code="invalid_worker",
        result_error="Worker config not found",
        repos=_Repos(),
        log_fn=lambda msg, level="info": logs.append((msg, level)),
    )

    assert did_schedule is False
    assert scheduled == []
    assert any("Not retrying permanent config failure" in msg for msg, _level in logs)


def test_agent_token_cap_exceeded_is_permanent_and_does_not_retry(monkeypatch):
    scheduled: list[dict] = []
    logs: list[tuple[str, str]] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=True,
        result_error_code="token_cap_exceeded",
        result_error="Agent token cap exceeded",
        repos=_Repos(),
        log_fn=lambda msg, level="info": logs.append((msg, level)),
    )

    assert did_schedule is False
    assert scheduled == []
    assert any("Not retrying permanent resource failure" in msg for msg, _level in logs)


def test_transient_error_code_retries_even_without_driver_flag(monkeypatch):
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=False,
        result_error_code="run_claimed_without_dispatch",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert did_schedule is True
    assert scheduled[0]["attempt"] == 1


def test_transient_code_wins_over_broad_failure_category(monkeypatch):
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=False,
        result_error_code="context_mount_failed",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert did_schedule is True
    assert scheduled[0]["attempt"] == 1


def test_manifest_all_retry_does_not_override_permanent_failure(monkeypatch):
    scheduled: list[dict] = []
    config = type("Config", (), {"retry": _RetryConfig(on=["all"])})()
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=config,
        result_retryable=False,
        result_error_code="missing_secret",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert did_schedule is False
    assert scheduled == []


def test_manifest_exact_error_can_opt_into_permanent_failure_retry(monkeypatch):
    scheduled: list[dict] = []
    config = type("Config", (), {"retry": _RetryConfig(on=["missing_secret"])})()
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=config,
        result_retryable=False,
        result_error_code="missing_secret",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert did_schedule is True
    assert scheduled[0]["attempt"] == 1


def test_non_retryable_failure_without_policy_does_not_schedule(monkeypatch):
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=False,
        result_error_code="worker_reported_error",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert did_schedule is False
    assert scheduled == []


def test_infra_retryable_failure_allows_second_retry_by_default(monkeypatch):
    scheduled: list[dict] = []
    logs: list[tuple[str, str]] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=True,
        result_error_code="e2b_sandbox_error",
        repos=_Repos(retry_attempt=1),
        log_fn=lambda msg, level="info": logs.append((msg, level)),
    )

    assert did_schedule is True
    assert scheduled[0]["attempt"] == 2
    assert any("Scheduling retryable failure 2/2 in 120s" in msg for msg, _level in logs)


def test_agent_runtime_error_gets_infra_retry_budget(monkeypatch):
    scheduled: list[dict] = []
    logs: list[tuple[str, str]] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=False,
        result_error_code="agent_runtime_error",
        result_error="litellm.APIConnectionError: cannot schedule new futures after shutdown",
        repos=_Repos(retry_attempt=1),
        log_fn=lambda msg, level="info": logs.append((msg, level)),
    )

    assert did_schedule is True
    assert scheduled[0]["attempt"] == 2
    assert any("Scheduling retryable failure 2/2 in 60s" in msg for msg, _level in logs)


def test_llm_setup_errors_do_not_retry_and_provider_error_retries(monkeypatch):
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    for code in ("llm_auth_error", "llm_quota_exceeded", "llm_model_not_configured"):
        did_schedule = run_service._schedule_retry_for_failed_run(
            run_id=f"run-{code}",
            worker_id="worker-a",
            inputs={},
            owner_id="user-a",
            config=None,
            result_retryable=True,
            result_error_code=code,
            repos=_Repos(),
            log_fn=lambda *_args, **_kwargs: None,
        )
        assert did_schedule is False

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-llm-rate-limited",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=False,
        result_error_code="llm_rate_limited",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )
    assert did_schedule is True
    assert scheduled[-1]["attempt"] == 1

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-llm-provider",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=False,
        result_error_code="llm_provider_error",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )
    assert did_schedule is True
    assert scheduled[-1]["attempt"] == 1


def test_llm_provider_capacity_uses_spaced_bounded_retries(monkeypatch):
    scheduled: list[dict] = []
    monkeypatch.delenv("WORKEROS_LLM_CAPACITY_RETRY_MAX_ATTEMPTS", raising=False)
    monkeypatch.delenv("WORKEROS_LLM_CAPACITY_RETRY_BASE_SECONDS", raising=False)
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    for retry_attempt, expected_delay in ((0, 1800), (1, 3600)):
        did_schedule = run_service._schedule_retry_for_failed_run(
            run_id=f"run-capacity-{retry_attempt}",
            worker_id="worker-a",
            inputs={},
            owner_id="user-a",
            config=None,
            result_retryable=True,
            result_error_code="llm_provider_capacity",
            repos=_Repos(retry_attempt=retry_attempt),
            log_fn=lambda *_args, **_kwargs: None,
        )
        assert did_schedule is True
        assert scheduled[-1]["attempt"] == retry_attempt + 1
        assert scheduled[-1]["delay_seconds"] == expected_delay

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-capacity-exhausted",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=True,
        result_error_code="llm_provider_capacity",
        repos=_Repos(retry_attempt=2),
        log_fn=lambda *_args, **_kwargs: None,
    )
    assert did_schedule is False
    assert len(scheduled) == 2


def test_llm_provider_capacity_exhaustion_has_honest_terminal_failure(monkeypatch):
    monkeypatch.delenv("WORKEROS_LLM_CAPACITY_RETRY_MAX_ATTEMPTS", raising=False)

    error, error_code = run_service._terminal_retry_failure(
        run_id="run-capacity-exhausted",
        config=None,
        error="Temporary model capacity issue on our side. Your worker will retry automatically.",
        error_code="llm_provider_capacity",
        repos=_Repos(retry_attempt=2),
    )

    assert error_code == "llm_provider_capacity_retry_exhausted"
    assert error == "Model capacity is still unavailable on our side after automatic retries. Try again later."
    assert run_service._classify_retry_failure(error_code=error_code).retryable is False
    explicit_retry = run_service._classify_retry_failure(
        error_code=error_code,
        retry_cfg=_RetryConfig(on=[error_code]),
    )
    assert explicit_retry.retryable is False
    assert explicit_retry.reason == "retry_exhausted"


def test_schedule_retry_is_idempotent_for_same_original_attempt(monkeypatch):
    created: list[dict] = []
    started: list[str] = []

    class Runs:
        def create(self, **kwargs):
            created.append(kwargs)

    class Repos:
        runs = Runs()

    monkeypatch.setattr(run_service, "start_run", lambda run_id, *_args, **_kwargs: started.append(run_id))

    # Hold the key as if another scheduler thread already claimed it.
    retry_key = ("run-original", 1, "retry")
    with run_service._scheduled_retry_lock:
        run_service._scheduled_retry_keys.add(retry_key)
    try:
        assert run_service._schedule_retry(
            original_run_id="run-original",
            worker_id="worker-a",
            inputs={},
            attempt=1,
            delay_seconds=0,
            user_id="user-a",
            repos=Repos(),
        ) is True
    finally:
        with run_service._scheduled_retry_lock:
            run_service._scheduled_retry_keys.discard(retry_key)

    assert created == []
    assert started == []

    assert run_service._schedule_retry(
        original_run_id="run-original",
        worker_id="worker-a",
        inputs={},
        attempt=1,
        delay_seconds=1800,
        user_id="user-a",
        repos=Repos(),
    ) is True

    assert len(created) == 1
    assert started == [created[0]["run_id"]]
    assert created[0]["status"] == "queued"
    assert created[0]["trigger_source"] == "retry"
    assert created[0]["retry_of_run_id"] == "run-original"
    assert created[0]["retry_attempt"] == 1
    assert created[0]["trigger_ref"]


def test_schedule_retry_reports_repository_insert_failure():
    class Runs:
        def create(self, **_kwargs):
            raise RuntimeError("repository unavailable")

    class Repos:
        runs = Runs()

    assert run_service._schedule_retry(
        original_run_id="run-original",
        worker_id="worker-a",
        inputs={},
        attempt=1,
        delay_seconds=60,
        user_id="user-a",
        repos=Repos(),
    ) is False


def test_failed_retry_persistence_is_not_reported_as_scheduled(monkeypatch):
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **_kwargs: False)

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=True,
        result_error_code="transient_network_error",
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert did_schedule is False
