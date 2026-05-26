import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

import runner_sandbox.agent_driver as agent_module
from models import WorkerConfig
from runner_sandbox.agent_driver import AgentDriver


class FakeCompletions:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("Unexpected model call")
        return self.responses.pop(0)


class FakeClient:
    def __init__(self, responses):
        self.chat = type("Chat", (), {})()
        self.chat.completions = FakeCompletions(responses)


def tool_response(name, args, call_id="call_1", tokens=10):
    return {
        "choices": [
            {
                "message": {
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)},
                        }
                    ],
                }
            }
        ],
        "usage": {"total_tokens": tokens},
    }


def final_response(tokens=5):
    return {
        "choices": [{"message": {"content": "done", "tool_calls": []}}],
        "usage": {"total_tokens": tokens},
    }


def make_config(tmp_path, *, limits=None, outputs=None, secrets=None, connections=None):
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
            "runner": "local",
            "mode": "agent",
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
    client = FakeClient(
        [
            tool_response("write_output", {"name": "summary", "content": "hello"}),
            final_response(),
        ]
    )
    log_entries, log_fn = logs()

    result = AgentDriver(openai_client=client).run(
        "agent-test", "run_prompt", {"topic": "x"}, {}, log_fn, "trace", config=config
    )

    assert result.status == "success"
    assert result.outputs == {"summary": "hello"}
    first_call = client.chat.completions.calls[0]
    assert "Override prompt." in first_call["messages"][0]["content"]
    assert "# Skill" in first_call["messages"][0]["content"]
    tool_names = {tool["function"]["name"] for tool in first_call["tools"]}
    assert {
        "list_dir",
        "read_file",
        "write_output",
        "run_command",
        "invoke_worker",
        "log",
        "composio__gmail__execute",
    }.issubset(tool_names)
    assert log_entries


def test_multi_iteration_tool_loop_reads_file_then_writes_output(tmp_path):
    config = make_config(tmp_path)
    client = FakeClient(
        [
            tool_response("read_file", {"path": "notes.txt"}, "call_read"),
            tool_response("write_output", {"name": "summary", "content": "from notes"}, "call_write"),
            final_response(),
        ]
    )
    _entries, log_fn = logs()

    result = AgentDriver(openai_client=client).run(
        "agent-test", "run_loop", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "success"
    assert result.outputs["summary"] == "from notes"
    assert len(client.chat.completions.calls) == 3
    second_call_messages = client.chat.completions.calls[1]["messages"]
    assert any("bundle note" in (message.get("content") or "") for message in second_call_messages)


def test_cost_caps_stop_agent_loop(tmp_path):
    config = make_config(
        tmp_path,
        limits={
            "max_tool_iterations": 1,
            "max_output_tokens": 1024,
            "max_total_tokens": 50000,
            "timeout_seconds": 30,
        },
    )
    client = FakeClient([tool_response("read_file", {"path": "notes.txt"})])
    _entries, log_fn = logs()

    result = AgentDriver(openai_client=client).run(
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
    client = FakeClient([final_response(tokens=21)])
    _entries, log_fn = logs()

    result = AgentDriver(openai_client=client).run(
        "agent-test", "run_token_cap", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "error"
    assert result.error_code == "token_cap_exceeded"


def test_run_command_containment_and_env_allowlist(tmp_path):
    config = make_config(tmp_path, secrets=["TOKEN"])
    _entries, log_fn = logs()
    driver = AgentDriver(openai_client=FakeClient([]))
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
    )
    assert allowed_env["ok"] is True
    assert "supersecret" not in allowed_env["stdout"]
    assert "<REDACTED:TOKEN>" in allowed_env["stdout"]


def test_declared_output_validation(tmp_path):
    config = make_config(tmp_path)
    client = FakeClient([final_response()])
    _entries, log_fn = logs()

    result = AgentDriver(openai_client=client).run(
        "agent-test", "run_missing_output", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "failed"
    assert result.error_code == "schema_violation"
    assert "Missing declared output" in result.error

    driver = AgentDriver(openai_client=FakeClient([]))
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
