from __future__ import annotations

import asyncio
import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _contract_payload() -> dict[str, object]:
    return {
        "schema_version": "0.3",
        "name": "default-model-worker",
        "title": "Default Model Worker",
        "description": "Exercises default model wiring",
        "version": "0.1.0",
        "exec": {
            "command": "python run.py",
            "runtime": "python311",
            "runner": "e2b",
            "mode": "agent",
            "entry": "SKILL.md",
        },
    }


def test_worker_contract_default_model_is_real_api_model():
    from models import DEFAULT_WORKER_AGENT_MODEL, WorkerContract

    contract = WorkerContract(**_contract_payload())

    assert contract.model == DEFAULT_WORKER_AGENT_MODEL
    assert contract.model != "gpt-5-mini"


def test_worker_contract_projection_uses_default_agent_model():
    from models import DEFAULT_WORKER_AGENT_MODEL, WorkerContract, worker_contract_to_worker_config

    contract = WorkerContract(**_contract_payload())
    config = worker_contract_to_worker_config(contract, "default-model-worker")

    assert config.runtime.model == DEFAULT_WORKER_AGENT_MODEL
    assert config.runtime.model != "gpt-5-mini"


def test_worker_config_to_contract_uses_default_agent_model():
    from models import (
        DEFAULT_WORKER_AGENT_MODEL,
        WorkerConfig,
        WorkerRuntime,
        WorkerTrigger,
        worker_config_to_worker_contract,
    )

    config = WorkerConfig(
        id="default-model-worker",
        name="Default Model Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", runner="e2b", mode="agent", model=None),
        model=None,
    )

    contract = worker_config_to_worker_contract(config)

    assert contract.model == DEFAULT_WORKER_AGENT_MODEL
    assert contract.model != "gpt-5-mini"


def test_agent_driver_fallback_uses_default_agent_model(monkeypatch, tmp_path):
    from models import (
        DEFAULT_WORKER_AGENT_MODEL,
        WorkerConfig,
        WorkerRuntime,
        WorkerTrigger,
    )
    from runner_sandbox import agent_driver
    from runner_sandbox.agent_driver import AgentDriver
    import llm

    workers_dir = tmp_path / "workers"
    bundle_dir = workers_dir / "default-model-worker"
    bundle_dir.mkdir(parents=True)
    (bundle_dir / "SKILL.md").write_text("You are a test worker.", encoding="utf-8")
    monkeypatch.setattr(agent_driver, "WORKERS_DIR", workers_dir)
    monkeypatch.setattr(agent_driver, "ARTIFACTS_DIR", tmp_path / "artifacts")

    config = WorkerConfig(
        id="default-model-worker",
        name="Default Model Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="python311",
            entrypoint="SKILL.md",
            runner="e2b",
            mode="agent",
            model=None,
        ),
    )
    captured: dict[str, object] = {}
    driver = AgentDriver()

    async def _no_mcp(*_args, **_kwargs):
        return []

    async def _fake_run_streamed(*, agent, run_input, max_turns, run_config):
        captured["model"] = agent.model
        return object()

    async def _fake_consume(*_args, **_kwargs):
        return {
            "total_tokens": 0,
            "cancelled": False,
            "token_cap_exceeded": False,
        }

    monkeypatch.setattr(driver, "_connect_mcp_servers", _no_mcp)
    monkeypatch.setattr(driver, "_sdk_tools", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(driver, "_cancel_requested", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(driver, "_run_streamed", _fake_run_streamed)
    monkeypatch.setattr(driver, "_consume_streamed_result", _fake_consume)

    result = asyncio.run(
        driver._run_agent_inner(
            worker_id="default-model-worker",
            run_id="run-default-model",
            inputs={},
            secrets={},
            log_fn=lambda *_args, **_kwargs: None,
            trace_id="trace-default-model",
            timeout_seconds=30,
            config=config,
            connection_ids={},
            user_id="user-a",
        )
    )

    assert result.status == "success"
    assert captured["model"] == llm.agent_model(DEFAULT_WORKER_AGENT_MODEL)
    assert captured["model"] != "gpt-5-mini"
