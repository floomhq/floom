from __future__ import annotations

import asyncio
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerConfig, WorkerLimits, WorkerRuntime, WorkerTrigger  # noqa: E402
from runner_sandbox.agent_driver import (  # noqa: E402
    AgentDriver,
    _classify_llm_provider_error,
    _resolve_agent_timeout_seconds,
    _resolve_max_tool_iterations,
    _resolve_max_total_tokens,
)


def _config(*, trigger_type: str = "manual", limits: WorkerLimits | None = None) -> WorkerConfig:
    return WorkerConfig(
        id="issue-983-worker",
        name="Issue 983 Worker",
        trigger=WorkerTrigger(type=trigger_type, cron="*/15 * * * *" if trigger_type == "cron" else None),
        runtime=WorkerRuntime(
            type="python311",
            entrypoint="SKILL.md",
            runner="e2b",
            mode="agent",
            model="bedrock/us.anthropic.claude-sonnet-4-6",
            limits=limits or WorkerLimits(),
        ),
    )


def test_provider_errors_are_classified_and_redacted(monkeypatch):
    driver = AgentDriver()
    logs: list[tuple[str, str]] = []
    raw_error = (
        "openai.AuthenticationError: Error code: 401 - Incorrect API key provided: "
        "sk-thisisasecret123"
    )

    def _raise(coro):
        coro.close()
        raise RuntimeError(raw_error)

    monkeypatch.setattr(driver, "_run_coro_sync", _raise)

    result = driver.run(
        worker_id="issue-983-worker",
        run_id="run-983-auth",
        inputs={},
        secrets={"OPENAI_API_KEY": "sk-thisisasecret123"},
        log_fn=lambda msg, level="info": logs.append((msg, level)),
        trace_id="trace-983",
    )

    assert result.status == "error"
    assert result.error_code == "llm_auth_error"
    assert result.retryable is False
    assert "sk-thisisasecret123" not in "\n".join(msg for msg, _level in logs)
    assert "LLM provider error (llm_auth_error)" in logs[0][0]


def test_provider_quota_and_generic_provider_errors_have_distinct_codes(monkeypatch):
    driver = AgentDriver()
    cases = [
        ("litellm.RateLimitError: 429 insufficient_quota", "llm_quota_exceeded", False),
        ("litellm.APIConnectionError: bedrock upstream connection failed", "llm_provider_error", True),
    ]

    for raw_error, expected_code, expected_retryable in cases:
        def _raise(coro, raw_error=raw_error):
            coro.close()
            raise RuntimeError(raw_error)

        monkeypatch.setattr(
            driver,
            "_run_coro_sync",
            _raise,
        )
        result = driver.run(
            worker_id="issue-983-worker",
            run_id=f"run-983-{expected_code}",
            inputs={},
            secrets={},
            log_fn=lambda *_args, **_kwargs: None,
            trace_id="trace-983",
        )
        assert result.error_code == expected_code
        assert result.retryable is expected_retryable


def test_llm_classifier_prefers_explicit_auth_over_quota_hint():
    assert (
        _classify_llm_provider_error(
            "openai.AuthenticationError: 401 incorrect API key; check quota dashboard if this persists"
        )
        == "llm_auth_error"
    )
    assert _classify_llm_provider_error("bedrock returned 403 quota exceeded") == "llm_quota_exceeded"
    assert _classify_llm_provider_error("pydantic model validation failed") is None


def test_agent_model_preflight_fails_missing_bedrock_env(monkeypatch):
    for key in (
        "AWS_ACCESS_KEY_ID",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_PROFILE",
        "AWS_REGION_NAME",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
    ):
        monkeypatch.delenv(key, raising=False)

    result = asyncio.run(
        AgentDriver()._run_agent_inner(
            worker_id="issue-983-worker",
            run_id="run-983-preflight",
            inputs={},
            secrets={},
            log_fn=lambda *_args, **_kwargs: None,
            trace_id="trace-983",
            timeout_seconds=30,
            config=_config(),
            connection_ids={},
            user_id="user-983",
        )
    )

    assert result.status == "error"
    assert result.error_code == "llm_model_not_configured"
    assert "platform AI model" in result.error


def test_scheduled_agent_caps_get_sane_floors_with_hard_ceilings(monkeypatch):
    scheduled = _config(
        trigger_type="cron",
        limits=WorkerLimits(
            max_tool_iterations=10,
            max_total_tokens=50_000,
            timeout_seconds=120,
        ),
    )
    manual = _config(
        trigger_type="manual",
        limits=WorkerLimits(
            max_tool_iterations=10,
            max_total_tokens=50_000,
            timeout_seconds=120,
        ),
    )

    assert _resolve_max_tool_iterations(scheduled.runtime.limits, scheduled) == 80
    assert _resolve_max_total_tokens(scheduled.runtime.limits, scheduled) == 1_000_000
    assert _resolve_agent_timeout_seconds(120, scheduled.runtime.limits, scheduled) == 1800

    assert _resolve_max_tool_iterations(manual.runtime.limits, manual) == 10
    assert _resolve_max_total_tokens(manual.runtime.limits, manual) == 50_000
    assert _resolve_agent_timeout_seconds(120, manual.runtime.limits, manual) == 120


def test_manual_agent_tool_iteration_cap_does_not_drop_existing_manifest_budget(monkeypatch):
    manual = _config(
        trigger_type="manual",
        limits=WorkerLimits(max_tool_iterations=500, max_total_tokens=50_000, timeout_seconds=120),
    )

    assert _resolve_max_tool_iterations(manual.runtime.limits, manual) == 500
