from __future__ import annotations

import asyncio

import pytest

from models import WorkerConfig, WorkerLimits, WorkerRuntime, WorkerTrigger
from runner_sandbox import agent_driver
from services.worker_timeout_guidance import low_agent_timeout_warning


def _config(*, entrypoint: str, mode: str, timeout_seconds: int) -> WorkerConfig:
    return WorkerConfig(
        id="timeout-worker",
        name="Timeout Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type=mode,
            entrypoint=entrypoint,
            mode=mode,
            limits=WorkerLimits(timeout_seconds=timeout_seconds),
        ),
    )


def test_low_agent_timeout_warning_threshold_and_mode():
    warning = low_agent_timeout_warning(
        _config(entrypoint="SKILL.md", mode="agent", timeout_seconds=599)
    )
    assert warning is not None
    assert "set limits.timeout_seconds to 1800-3600" in warning
    assert low_agent_timeout_warning(
        _config(entrypoint="SKILL.md", mode="agent", timeout_seconds=600)
    ) is None
    assert low_agent_timeout_warning(
        _config(entrypoint="run.py", mode="pure-script", timeout_seconds=300)
    ) is None


@pytest.mark.asyncio
async def test_agent_timeout_error_includes_manifest_remedy(monkeypatch):
    driver = agent_driver.AgentDriver()
    config = _config(entrypoint="SKILL.md", mode="agent", timeout_seconds=300)

    async def _raise_timeout(coro, *, timeout):
        coro.close()
        raise asyncio.TimeoutError

    monkeypatch.setattr(agent_driver.asyncio, "wait_for", _raise_timeout)
    monkeypatch.setattr(
        agent_driver,
        "_resolve_agent_timeout_seconds",
        lambda requested, limits, worker_config: requested,
    )

    result = await driver._run_agent_async(
        worker_id=config.id,
        run_id="run-timeout",
        inputs={},
        secrets={},
        log_fn=lambda message, level: None,
        trace_id="trace-timeout",
        timeout_seconds=300,
        config=config,
        connection_ids={},
        user_id=None,
    )

    assert result.error_code == "timeout"
    assert result.error == (
        "Agent run exceeded timeout of 300s. "
        "Raise limits.timeout_seconds in worker.yml (max 3600)."
    )
