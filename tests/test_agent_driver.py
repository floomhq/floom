import sys
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

import runner_sandbox.agent_driver as agent_module
from models import WorkerConfig
from runner_sandbox.agent_driver import AgentDriver
from agent_driver_sdk_fakes import FakeStreamingResult, ScriptedAgentDriverMixin


class ScriptedAgentDriver(ScriptedAgentDriverMixin, AgentDriver):
    pass


def tool_response(name, args, call_id="call_1", tokens=10):
    return {"kind": "tool", "name": name, "args": args, "call_id": call_id, "tokens": tokens}


def final_response(tokens=5):
    return {"kind": "message", "text": "done", "tokens": tokens}


def make_config(
    tmp_path,
    *,
    limits=None,
    outputs=None,
    secrets=None,
    connections=None,
    model=None,
):
    workers_root = tmp_path / "workers"
    bundle = tmp_path / "bundle"
    artifacts = tmp_path / "artifacts"
    workers_root.mkdir()
    bundle.mkdir()
    artifacts.mkdir()
    (bundle / "SKILL.md").write_text("# Skill\n\nWrite the declared output.")
    (bundle / "notes.txt").write_text("bundle note")
    agent_module.WORKERS_DIR = workers_root
    agent_module.ARTIFACTS_DIR = artifacts
    return WorkerConfig(
        id="agent-test",
        name="Agent Test",
        trigger={"type": "manual"},
        runtime={
            "type": "python311",
            "entrypoint": "SKILL.md",
            "runner": "e2b",
            "mode": "agent",
            "model": model,
            "bundle_path": str(bundle),
            "system_prompt": "Override prompt.",
            "limits": limits or {
                "max_tool_iterations": 6,
                "max_output_tokens": 1024,
                "max_total_tokens": 50000,
                "timeout_seconds": 30,
            },
        },
        inputs=[],
        secrets=secrets or [],
        connections=connections or [],
        outputs=outputs
        or [{"name": "summary", "label": "Summary", "type": "markdown"}],
    )


def logs():
    entries = []

    def log_fn(message, level="info"):
        entries.append((level, message))

    return entries, log_fn


def test_skill_prompt_loading_and_tool_schema(tmp_path):
    config = make_config(tmp_path, connections=["gmail"])
    driver = ScriptedAgentDriver()
    driver.set_scripts([[tool_response("write_output", {"name": "summary", "content": "hello"}), final_response()]])
    log_entries, log_fn = logs()

    result = driver.run(
        "agent-test", "run_prompt", {"topic": "x"}, {}, log_fn, "trace", config=config
    )

    assert result.status == "success"
    assert result.outputs == {"summary": "hello"}
    first_call = driver.calls[0]
    assert "Override prompt." in first_call["agent"].instructions
    assert "# Skill" in first_call["agent"].instructions
    tool_names = {getattr(tool, "name", tool.__class__.__name__) for tool in first_call["agent"].tools}
    assert {
        "list_dir",
        "read_file",
        "write_output",
        "finish_with_outputs",
        "run_command",
        "invoke_worker",
        "log",
        "composio__gmail__execute",
    }.issubset(tool_names)
    # 79fdf03e: OpenAI's hosted WebSearchTool was replaced by the
    # provider-agnostic `web_search` FunctionTool (works on Bedrock/litellm).
    assert any(getattr(tool, "name", None) == "web_search" for tool in first_call["agent"].tools)
    assert log_entries


def test_multi_iteration_tool_loop_reads_file_then_writes_output(tmp_path):
    config = make_config(tmp_path)
    driver = ScriptedAgentDriver()
    driver.set_scripts([[
        tool_response("read_file", {"path": "notes.txt"}, "call_read"),
        tool_response("write_output", {"name": "summary", "content": "from notes"}, "call_write"),
        final_response(),
    ]])
    _entries, log_fn = logs()

    result = driver.run(
        "agent-test", "run_loop", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "success"
    assert result.outputs["summary"] == "from notes"
    assert len(driver.calls) == 1


class _ProviderModel:
    def __init__(self, *, error=None, response=None, stream_events=None):
        self.error = error
        self.response = response
        self.stream_events = list(stream_events or [])
        self.calls = 0
        self.last_model_settings = None

    def get_retry_advice(self, _request):
        return None

    async def get_response(self, *_args, **_kwargs):
        self.calls += 1
        self.last_model_settings = _args[2]
        if self.error is not None:
            raise self.error
        return self.response

    async def stream_response(self, *_args, **_kwargs):
        self.calls += 1
        self.last_model_settings = _args[2]
        for event in self.stream_events:
            yield event
        if self.error is not None:
            raise self.error
        if self.response is not None:
            yield self.response


class _ProviderExercisingAgentDriver(AgentDriver):
    def __init__(self):
        super().__init__()
        self.seen_events = []
        self.stream_runs = 0

    async def _run_streamed(self, agent, run_input, max_turns, run_config):
        self.stream_runs += 1
        model = run_config.model_provider.get_model(agent.model)
        async for event in model.stream_response(
            None, [], agent.model_settings, [], None, [], None
        ):
            self.seen_events.append(event)
        return FakeStreamingResult(
            agent,
            [
                tool_response(
                    "finish_with_outputs",
                    {"summary": "completed on fallback"},
                ),
                final_response(),
            ],
        )


class _WorkerErrorAgentDriver(AgentDriver):
    async def _run_streamed(self, agent, run_input, max_turns, run_config):
        raise ValueError("invalid worker output")


def _install_fake_multi_provider(monkeypatch, models):
    class FakeMultiProvider:
        def __init__(self, **_kwargs):
            pass

        def get_model(self, model_name):
            return models[model_name]

    import agents.models.multi_provider as multi_provider

    monkeypatch.setattr(multi_provider, "MultiProvider", FakeMultiProvider)
    monkeypatch.setattr(agent_module._llm, "provider_credentials_present", lambda _model: True)


def _three_provider_models(*, primary, first_fallback, second_fallback):
    return {
        "litellm/bedrock/us.anthropic.claude-sonnet-4-6": primary,
        "litellm/gemini/gemini-3.5-flash": first_fallback,
        "openai/gpt-5.5": second_fallback,
    }


def _three_provider_config(tmp_path):
    return make_config(
        tmp_path,
        model="bedrock/us.anthropic.claude-sonnet-4-6",
        limits={
            "max_tool_iterations": 6,
            "max_output_tokens": 1_000_000,
            "max_total_tokens": 1_000_000,
            "timeout_seconds": 30,
        },
    )


def _configure_three_provider_chain(monkeypatch):
    monkeypatch.setenv(
        "WORKEROS_AGENT_FALLBACK_MODEL",
        "gemini/gemini-3.5-flash, openai/gpt-5.5",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-only")


def test_agent_fallback_models_preserve_scalar_configuration(monkeypatch):
    monkeypatch.setattr(agent_module._llm, "provider_credentials_present", lambda _model: True)
    monkeypatch.setenv("WORKEROS_AGENT_FALLBACK_MODEL", " gemini/gemini-3.5-flash ")

    assert agent_module._resolve_agent_fallback_models(
        "bedrock/us.anthropic.claude-sonnet-4-6"
    ) == ["gemini/gemini-3.5-flash"]
    assert (
        agent_module._resolve_agent_fallback_model(
            "bedrock/us.anthropic.claude-sonnet-4-6"
        )
        == "gemini/gemini-3.5-flash"
    )


def test_empty_agent_fallback_env_preserves_default_fallback(monkeypatch):
    monkeypatch.setattr(agent_module._llm, "provider_credentials_present", lambda _model: True)
    monkeypatch.setenv("WORKEROS_AGENT_FALLBACK_MODEL", "")

    assert agent_module._resolve_agent_fallback_models(
        "gemini/gemini-3.5-flash"
    ) == [agent_module._DEFAULT_AGENT_FALLBACK_MODEL]


def test_agent_fallback_models_parse_validate_and_dedupe_ordered_chain(monkeypatch):
    configured = {
        "gemini/gemini-3.5-flash",
        "gemini/gemini-3.5-return",
        "openai/gpt-5.5",
    }
    monkeypatch.setattr(
        agent_module._llm,
        "provider_credentials_present",
        lambda model: model in configured,
    )
    monkeypatch.setenv(
        "WORKEROS_AGENT_FALLBACK_MODEL",
        ", ".join(
            [
                "bedrock/us.anthropic.claude-sonnet-4-6",
                "gemini/gemini-3.5-flash",
                "gemini/gemini-3.5-pro",
                "gemini/gemini-3.5-flash",
                "anthropic/claude-sonnet-4-6",
                "openai/gpt-5.5",
                "gemini/gemini-3.5-return",
                "openai/gpt-5.5",
            ]
        ),
    )

    assert agent_module._resolve_agent_fallback_models(
        "bedrock/us.anthropic.claude-sonnet-4-6"
    ) == [
        "gemini/gemini-3.5-flash",
        "openai/gpt-5.5",
    ]


def test_first_fallback_success_does_not_call_third_provider(tmp_path, monkeypatch):
    primary = _ProviderModel(error=RuntimeError("429 bedrock throttling"))
    first_fallback = _ProviderModel(response="gemini response")
    second_fallback = _ProviderModel(response="must not be called")
    _install_fake_multi_provider(
        monkeypatch,
        _three_provider_models(
            primary=primary,
            first_fallback=first_fallback,
            second_fallback=second_fallback,
        ),
    )
    _configure_three_provider_chain(monkeypatch)
    entries, log_fn = logs()

    result = _ProviderExercisingAgentDriver().run(
        "agent-test",
        "run_first_fallback",
        {},
        {},
        log_fn,
        "trace",
        config=_three_provider_config(tmp_path),
    )

    assert result.status == "success"
    assert [primary.calls, first_fallback.calls, second_fallback.calls] == [1, 1, 0]
    assert sum("retrying model call" in message.lower() for _level, message in entries) == 1


def test_second_fallback_success_completes_without_whole_run_replay(tmp_path, monkeypatch):
    primary = _ProviderModel(error=RuntimeError("429 bedrock throttling"))
    first_fallback = _ProviderModel(error=RuntimeError("RESOURCE_EXHAUSTED"))
    second_fallback = _ProviderModel(response="openai response")
    _install_fake_multi_provider(
        monkeypatch,
        _three_provider_models(
            primary=primary,
            first_fallback=first_fallback,
            second_fallback=second_fallback,
        ),
    )
    _configure_three_provider_chain(monkeypatch)
    entries, log_fn = logs()
    driver = _ProviderExercisingAgentDriver()

    result = driver.run(
        "agent-test",
        "run_second_fallback",
        {},
        {},
        log_fn,
        "trace",
        config=_three_provider_config(tmp_path),
    )

    assert result.status == "success"
    assert [primary.calls, first_fallback.calls, second_fallback.calls] == [1, 1, 1]
    assert driver.stream_runs == 1
    assert sum("retrying model call" in message.lower() for _level, message in entries) == 2


def test_all_fallbacks_exhaust_once_without_leaking_partial_streams(tmp_path, monkeypatch):
    primary = _ProviderModel(
        stream_events=["partial-bedrock"],
        error=RuntimeError("429 bedrock throttling"),
    )
    first_fallback = _ProviderModel(
        stream_events=["partial-gemini"],
        error=RuntimeError("RESOURCE_EXHAUSTED"),
    )
    second_fallback = _ProviderModel(
        stream_events=["partial-openai"],
        error=RuntimeError("429 openai throttling"),
    )
    _install_fake_multi_provider(
        monkeypatch,
        _three_provider_models(
            primary=primary,
            first_fallback=first_fallback,
            second_fallback=second_fallback,
        ),
    )
    _configure_three_provider_chain(monkeypatch)
    _entries, log_fn = logs()
    driver = _ProviderExercisingAgentDriver()

    result = driver.run(
        "agent-test",
        "run_fallbacks_exhausted",
        {},
        {},
        log_fn,
        "trace",
        config=_three_provider_config(tmp_path),
    )

    assert result.status == "error"
    assert result.error_code == "llm_provider_capacity"
    assert result.retryable is True
    assert [primary.calls, first_fallback.calls, second_fallback.calls] == [1, 1, 1]
    assert driver.stream_runs == 1
    assert driver.seen_events == []


def test_non_capacity_error_stops_ordered_fallback_chain(tmp_path, monkeypatch):
    primary = _ProviderModel(error=RuntimeError("429 bedrock throttling"))
    first_fallback = _ProviderModel(error=RuntimeError("Gemini API connection reset"))
    second_fallback = _ProviderModel(response="must not be called")
    _install_fake_multi_provider(
        monkeypatch,
        _three_provider_models(
            primary=primary,
            first_fallback=first_fallback,
            second_fallback=second_fallback,
        ),
    )
    _configure_three_provider_chain(monkeypatch)
    _entries, log_fn = logs()

    result = _ProviderExercisingAgentDriver().run(
        "agent-test",
        "run_non_capacity_stop",
        {},
        {},
        log_fn,
        "trace",
        config=_three_provider_config(tmp_path),
    )

    assert result.status == "error"
    assert result.error_code == "llm_provider_error"
    assert [primary.calls, first_fallback.calls, second_fallback.calls] == [1, 1, 0]


def test_openai_fallback_explicitly_clears_bedrock_max_tokens(tmp_path, monkeypatch):
    primary = _ProviderModel(error=RuntimeError("429 bedrock throttling"))
    first_fallback = _ProviderModel(error=RuntimeError("RESOURCE_EXHAUSTED"))
    second_fallback = _ProviderModel(response="openai response")
    _install_fake_multi_provider(
        monkeypatch,
        _three_provider_models(
            primary=primary,
            first_fallback=first_fallback,
            second_fallback=second_fallback,
        ),
    )
    _configure_three_provider_chain(monkeypatch)
    _entries, log_fn = logs()

    result = _ProviderExercisingAgentDriver().run(
        "agent-test",
        "run_openai_token_clear",
        {},
        {},
        log_fn,
        "trace",
        config=_three_provider_config(tmp_path),
    )

    assert result.status == "success"
    assert primary.last_model_settings.max_tokens == agent_module._BEDROCK_MAX_OUTPUT_CAP
    assert second_fallback.last_model_settings.max_tokens is None


def test_agent_driver_does_not_replay_whole_run_after_capacity_failure(monkeypatch):
    class _RunCountingDriver(AgentDriver):
        def __init__(self):
            super().__init__()
            self.async_runs = 0

        async def _run_agent_async(self, **_kwargs):
            self.async_runs += 1
            raise RuntimeError("429 provider throttling")

    monkeypatch.setenv(
        "WORKEROS_AGENT_FALLBACK_MODEL",
        "gemini/gemini-3.5-flash,openai/gpt-5.5",
    )
    config = type("Config", (), {"runtime": type("Runtime", (), {"model": "bedrock/test"})()})()
    _entries, log_fn = logs()
    driver = _RunCountingDriver()

    result = driver.run("agent-test", "run_once", {}, {}, log_fn, "trace", config=config)

    assert result.status == "error"
    assert result.error_code == "llm_rate_limited"
    assert driver.async_runs == 1


def test_gemini_agent_capacity_error_completes_on_bedrock_fallback(tmp_path, monkeypatch):
    primary_name = "litellm/gemini/gemini-3.5-flash"
    fallback_name = "litellm/bedrock/us.anthropic.claude-sonnet-4-6"
    primary = _ProviderModel(error=RuntimeError("RESOURCE_EXHAUSTED: quota exceeded"))
    fallback = _ProviderModel(response="bedrock response")
    _install_fake_multi_provider(
        monkeypatch,
        {primary_name: primary, fallback_name: fallback},
    )
    monkeypatch.delenv("WORKEROS_AGENT_FALLBACK_MODEL", raising=False)
    config = make_config(
        tmp_path,
        model="gemini/gemini-3.5-flash",
        limits={
            "max_tool_iterations": 6,
            "max_output_tokens": 1_000_000,
            "max_total_tokens": 1_000_000,
            "timeout_seconds": 30,
        },
    )
    entries, log_fn = logs()

    result = _ProviderExercisingAgentDriver().run(
        "agent-test", "run_capacity_fallback", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "success"
    assert result.error_code is None
    assert result.outputs == {"summary": "completed on fallback"}
    assert primary.calls == 1
    assert fallback.calls == 1
    assert fallback.last_model_settings.max_tokens == agent_module._BEDROCK_MAX_OUTPUT_CAP
    assert any("retrying model call" in message.lower() for _level, message in entries)


def test_genuine_worker_error_does_not_use_cross_provider_fallback(tmp_path, monkeypatch):
    primary_name = "litellm/gemini/gemini-3.5-flash"
    fallback_name = "litellm/bedrock/us.anthropic.claude-sonnet-4-6"
    primary = _ProviderModel(response="must not be called")
    fallback = _ProviderModel(response="must not be called")
    _install_fake_multi_provider(
        monkeypatch,
        {primary_name: primary, fallback_name: fallback},
    )
    config = make_config(tmp_path, model="gemini/gemini-3.5-flash")
    _entries, log_fn = logs()

    result = _WorkerErrorAgentDriver().run(
        "agent-test", "run_worker_error", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "error"
    assert result.error_code == "agent_runtime_error"
    assert primary.calls == 0
    assert fallback.calls == 0


def test_non_capacity_provider_error_keeps_existing_behavior(tmp_path, monkeypatch):
    primary_name = "litellm/gemini/gemini-3.5-flash"
    fallback_name = "litellm/bedrock/us.anthropic.claude-sonnet-4-6"
    primary = _ProviderModel(error=RuntimeError("Gemini API connection reset"))
    fallback = _ProviderModel(response="must not be called")
    _install_fake_multi_provider(
        monkeypatch,
        {primary_name: primary, fallback_name: fallback},
    )
    config = make_config(tmp_path, model="gemini/gemini-3.5-flash")
    _entries, log_fn = logs()

    result = _ProviderExercisingAgentDriver().run(
        "agent-test", "run_provider_error", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "error"
    assert result.error_code == "llm_provider_error"
    assert primary.calls == 1
    assert fallback.calls == 0


@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("RESOURCE_EXHAUSTED"),
        RuntimeError("quota exceeded"),
        RuntimeError("429 too many requests"),
        RuntimeError("provider throttling"),
    ],
)
def test_agent_capacity_classifier_allows_cross_provider_fallback(error):
    assert agent_module._should_retry_agent_with_fallback(error)


def test_agent_capacity_classifier_uses_structured_429_status():
    class EmptyRateLimitError(RuntimeError):
        status_code = 429

    assert agent_module._should_retry_agent_with_fallback(EmptyRateLimitError())


def test_lone_rate_limit_remains_rate_limited():
    assert (
        agent_module._classify_llm_provider_error(RuntimeError("429 provider throttling"))
        == "llm_rate_limited"
    )


@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("Gemini API connection reset"),
        RuntimeError("authentication failed"),
        ValueError("invalid worker output"),
    ],
)
def test_agent_non_capacity_classifier_blocks_cross_provider_fallback(error):
    assert not agent_module._should_retry_agent_with_fallback(error)


def test_agent_fallback_model_is_configurable_and_never_retries_same_model(monkeypatch):
    monkeypatch.setattr(agent_module._llm, "provider_credentials_present", lambda _model: True)
    monkeypatch.setenv("WORKEROS_AGENT_FALLBACK_MODEL", " anthropic/claude-test ")
    assert (
        agent_module._resolve_agent_fallback_model("gemini/gemini-3.5-flash")
        == "anthropic/claude-test"
    )
    assert agent_module._resolve_agent_fallback_model("anthropic/claude-test") is None

    monkeypatch.setenv("WORKEROS_AGENT_FALLBACK_MODEL", "gemini/gemini-other")
    assert agent_module._resolve_agent_fallback_model("gemini/gemini-3.5-flash") is None


def test_cost_caps_stop_agent_loop(tmp_path):
    from agents.exceptions import MaxTurnsExceeded

    config = make_config(
        tmp_path,
        limits={
            "max_tool_iterations": 1,
            "max_output_tokens": 1024,
            "max_total_tokens": 50000,
            "timeout_seconds": 30,
        },
    )
    driver = ScriptedAgentDriver()
    driver.set_scripts([[{"kind": "raise", "error": MaxTurnsExceeded("max turns exceeded")}]])
    _entries, log_fn = logs()

    result = driver.run(
        "agent-test", "run_cap", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "error"
    assert result.error_code == "tool_iteration_cap_exceeded"


def test_total_token_cap_is_enforced(tmp_path):
    config = make_config(
        tmp_path,
        limits={
            "max_tool_iterations": 3,
            "max_output_tokens": 1024,
            "max_total_tokens": 20,
            "timeout_seconds": 30,
        },
    )
    driver = ScriptedAgentDriver()
    driver.set_scripts([[final_response(tokens=21)]], tokens=[21])
    _entries, log_fn = logs()

    result = driver.run(
        "agent-test", "run_token_cap", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "error"
    assert result.error_code == "token_cap_exceeded"


def test_run_command_containment_and_env_allowlist(tmp_path, monkeypatch):
    config = make_config(tmp_path, secrets=["TOKEN"])
    _entries, log_fn = logs()
    driver = AgentDriver()
    captured_e2b = {}

    def fake_run_command_e2b(**kwargs):
        captured_e2b.update(kwargs)
        return {
            "ok": True,
            "exit_code": 0,
            "stdout": "<REDACTED:TOKEN>\n",
            "stderr": "",
        }

    monkeypatch.setattr(driver, "_run_command_e2b", fake_run_command_e2b)
    bundle_dir = Path(config.runtime.bundle_path)
    input_dir = tmp_path / "artifacts" / "run_tools" / "inputs"
    output_dir = tmp_path / "artifacts" / "run_tools" / "outputs"
    input_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)

    escaped = driver._handle_tool(
        "run_command",
        {"cmd": "python3", "args": ["-c", "print(1)"], "cwd": "../../"},
        "agent-test",
        "run_tools",
        {},
        {},
        log_fn,
        "trace",
        config,
        bundle_dir,
        input_dir,
        output_dir,
        {},
        [],
        30,
        bundle_dir,
    )
    assert escaped["ok"] is False
    assert "Path traversal" in escaped["error"]

    undeclared_env = driver._handle_tool(
        "run_command",
        {"cmd": "python3", "args": ["-c", "print(1)"], "env": {"OTHER": "x"}},
        "agent-test",
        "run_tools",
        {},
        {"TOKEN": "supersecret"},
        log_fn,
        "trace",
        config,
        bundle_dir,
        input_dir,
        output_dir,
        {},
        [],
        30,
        bundle_dir,
    )
    assert undeclared_env["ok"] is False
    assert "not declared secrets" in undeclared_env["error"]

    allowed_env = driver._handle_tool(
        "run_command",
        {
            "cmd": "python3",
            "args": ["-c", "import os; print(os.environ['TOKEN'])"],
            "env": {"TOKEN": "ignored"},
        },
        "agent-test",
        "run_tools",
        {},
        {"TOKEN": "supersecret"},
        log_fn,
        "trace",
        config,
        bundle_dir,
        input_dir,
        output_dir,
        {},
        [],
        30,
        bundle_dir,
    )
    assert allowed_env["ok"] is True
    assert "supersecret" not in allowed_env["stdout"]
    assert "<REDACTED:TOKEN>" in allowed_env["stdout"]
    assert captured_e2b["env"]["TOKEN"] == "supersecret"


def test_missing_declared_output_fails_before_completion_gate(tmp_path):
    config = make_config(tmp_path)
    driver = ScriptedAgentDriver()
    driver.set_scripts([[final_response()], [final_response()]])
    _entries, log_fn = logs()

    result = driver.run(
        "agent-test", "run_missing_output", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "failed"
    assert result.error == "Output schema violation: Missing declared output 'summary'"
    assert result.outputs == {}

    driver = AgentDriver()
    output_dir = tmp_path / "artifacts" / "run_missing_output" / "outputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    response = driver._write_output(
        {"name": "other", "content": "bad"},
        output_dir,
        {},
        [],
        config,
    )
    assert response["ok"] is False
    assert "Undeclared output" in response["error"]


def test_composio_execute_uses_run_owner_and_resolved_connection(tmp_path, monkeypatch):
    config = make_config(
        tmp_path,
        connections=[{"app": "gmail", "allowed_tools": ["GMAIL_SEND_EMAIL"]}],
    )
    driver = AgentDriver()
    _entries, log_fn = logs()
    captured = {}

    class FakeResponse:
        status_code = 200
        text = "{}"

        def json(self):
            return {"data": {"ok": True}}

    def fake_post(url, *, headers, json, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")
    monkeypatch.setattr(requests, "post", fake_post)

    result = driver._handle_tool(
        "composio__gmail__execute",
        {"tool": "GMAIL_SEND_EMAIL", "arguments": {"to": "test@example.com"}},
        "agent-test",
        "run_composio",
        {},
        {},
        log_fn,
        "trace",
        config,
        Path(config.runtime.bundle_path),
        tmp_path / "inputs",
        tmp_path / "outputs",
        {},
        [],
        30,
        Path(config.runtime.bundle_path),
        connection_ids={"gmail": "conn-owner-a"},
        user_id="owner-a",
    )

    assert result["ok"] is True
    assert captured["json"]["connected_account_id"] == "conn-owner-a"
    assert captured["json"]["entity_id"] == "owner-a"
    assert captured["json"]["arguments"] == {"to": "test@example.com"}


def test_composio_execute_requires_scoped_active_connection(tmp_path, monkeypatch):
    config = make_config(tmp_path, connections=["gmail"])
    driver = AgentDriver()
    _entries, log_fn = logs()
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")

    result = driver._handle_tool(
        "composio__gmail__execute",
        {"tool": "GMAIL_FETCH_EMAILS", "arguments": {}},
        "agent-test",
        "run_composio_missing",
        {},
        {},
        log_fn,
        "trace",
        config,
        Path(config.runtime.bundle_path),
        tmp_path / "inputs",
        tmp_path / "outputs",
        {},
        [],
        30,
        Path(config.runtime.bundle_path),
        connection_ids={},
        user_id=None,
    )

    assert result["ok"] is False
    assert "Missing active Composio connection for gmail" in result["error"]


def test_invoke_worker_requires_authenticated_owner(tmp_path):
    config = make_config(tmp_path)
    driver = AgentDriver()
    _entries, log_fn = logs()

    result = driver._handle_tool(
        "invoke_worker",
        {"id": "other-worker", "inputs": {}},
        "agent-test",
        "run_invoke",
        {},
        {},
        log_fn,
        "trace",
        config,
        Path(config.runtime.bundle_path),
        tmp_path / "inputs",
        tmp_path / "outputs",
        {},
        [],
        30,
        Path(config.runtime.bundle_path),
    )

    assert result["ok"] is False
    assert "authenticated owner" in result["error"]
