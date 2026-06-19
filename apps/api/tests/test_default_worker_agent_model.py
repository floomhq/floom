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


# ---------------------------------------------------------------------------
# Cloud regression: WORKEROS_WORKER_AGENT_MODEL arrives AFTER `from models import`
# (load_dotenv in main.py runs after the import block). A frozen module-level
# constant would stay "gpt-5.5" (→ OpenAI, dead key, "exceeded your current
# quota") while Emily, which reads WORKEROS_CHAT_MODEL lazily, works. These tests
# pin the lazy resolution so workers route to Bedrock like Emily.
# ---------------------------------------------------------------------------

_BEDROCK = "bedrock/us.anthropic.claude-sonnet-4-6"


def test_default_worker_agent_model_resolves_bedrock_when_env_set(monkeypatch):
    """Env set after import must win — proves no import-time freeze."""
    from models import default_worker_agent_model

    monkeypatch.setenv("WORKEROS_WORKER_AGENT_MODEL", _BEDROCK)
    assert default_worker_agent_model() == _BEDROCK


def test_default_worker_agent_model_falls_back_to_openai_when_unset(monkeypatch):
    from models import default_worker_agent_model

    monkeypatch.delenv("WORKEROS_WORKER_AGENT_MODEL", raising=False)
    assert default_worker_agent_model() == "gpt-5.5"


def test_worker_contract_picks_up_bedrock_env_after_import(monkeypatch):
    """A freshly built contract with no explicit model resolves to the live env
    value, not the import-time snapshot. This is the exact hosted path."""
    from models import WorkerContract, worker_contract_to_worker_config

    monkeypatch.setenv("WORKEROS_WORKER_AGENT_MODEL", _BEDROCK)
    contract = WorkerContract(**_contract_payload())
    assert contract.model == _BEDROCK

    config = worker_contract_to_worker_config(contract, "default-model-worker")
    assert config.runtime.model == _BEDROCK


def test_explicit_worker_model_choice_is_preserved(monkeypatch):
    """A worker that intentionally pins a model keeps it even when the env
    default points elsewhere."""
    from models import WorkerContract, worker_contract_to_worker_config

    monkeypatch.setenv("WORKEROS_WORKER_AGENT_MODEL", _BEDROCK)
    payload = _contract_payload()
    payload["model"] = "gpt-5.5"
    contract = WorkerContract(**payload)
    assert contract.model == "gpt-5.5"

    config = worker_contract_to_worker_config(contract, "default-model-worker")
    assert config.runtime.model == "gpt-5.5"
