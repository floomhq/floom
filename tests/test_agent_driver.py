import sys
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

import runner_sandbox.agent_driver as agent_module
from models import WorkerConfig
from runner_sandbox.agent_driver import AgentDriver
from agent_driver_sdk_fakes import ScriptedAgentDriverMixin


class ScriptedAgentDriver(ScriptedAgentDriverMixin, AgentDriver):
    pass


def tool_response(name, args, call_id="call_1", tokens=10):
    return {"kind": "tool", "name": name, "args": args, "call_id": call_id, "tokens": tokens}


def final_response(tokens=5):
    return {"kind": "message", "text": "done", "tokens": tokens}


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
            "runner": "e2b",
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
    assert any(tool.__class__.__name__ == "WebSearchTool" for tool in first_call["agent"].tools)
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
