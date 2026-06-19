import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

import runner_sandbox.agent_driver as agent_module
from models import WorkerConfig
from runner_sandbox.agent_driver import AgentDriver
from agent_driver_sdk_fakes import ScriptedAgentDriverMixin


class ScriptedAgentDriver(ScriptedAgentDriverMixin, AgentDriver):
    pass


def final_response(content="done", tokens=5):
    return {"kind": "message", "text": content, "tokens": tokens}


def tool_response(name, args, call_id="call_1", tokens=10):
    return {"kind": "tool", "name": name, "args": args, "call_id": call_id, "tokens": tokens}


def make_config(tmp_path, outputs=None, limits=None):
    bundle = tmp_path / "bundle"
    workers_root = tmp_path / "workers"
    artifacts = tmp_path / "artifacts"
    bundle.mkdir()
    workers_root.mkdir()
    artifacts.mkdir()
    (bundle / "SKILL.md").write_text("# Skill\n\nProduce the declared outputs.")
    agent_module.WORKERS_DIR = workers_root
    agent_module.ARTIFACTS_DIR = artifacts
    return WorkerConfig(
        id="agent-contract-test",
        name="Agent Contract Test",
        trigger={"type": "manual"},
        runtime={
            "type": "skill",
            "entrypoint": "SKILL.md",
            "runner": "local",
            "mode": "agent",
            "bundle_path": str(bundle),
            "limits": limits
            or {
                "max_tool_iterations": 4,
                "max_output_tokens": 1024,
                "max_total_tokens": 50000,
                "timeout_seconds": 30,
            },
        },
        inputs=[],
        outputs=outputs
        or [
            {
                "name": "brief",
                "label": "Brief",
                "type": "markdown",
                "required": True,
                "kind": "file",
                "media_type": "text/markdown",
                "path": "out/brief.md",
            },
            {
                "name": "metadata",
                "label": "Metadata",
                "type": "json",
                "required": False,
                "kind": "file",
                "media_type": "application/json",
                "path": "out/metadata.json",
                "json_required_keys": ["title"],
            },
        ],
    )


def logs():
    entries = []

    def log_fn(message, level="info"):
        entries.append((level, message))

    return entries, log_fn


def tool_by_name(tools, name):
    return next(tool for tool in tools if (tool.get("function") or {}).get("name") == name)


def test_system_prompt_includes_outputs_block(tmp_path):
    config = make_config(tmp_path)
    driver = AgentDriver()

    prompt = driver._load_system_prompt(Path(config.runtime.bundle_path), config)

    assert "## Required outputs" in prompt
    assert prompt.index("## Required outputs") < prompt.index("# Skill")
    assert "name: brief" in prompt
    assert "type: markdown" in prompt
    assert "required: true" in prompt
    assert "path: out/brief.md" in prompt
    assert "media_type: text/markdown" in prompt
    assert "kind: file" in prompt
    assert "name: metadata" in prompt
    assert "type: json" in prompt
    assert "required: false" in prompt
    assert 'json_keys: ["title"]' in prompt


def test_finish_with_outputs_tool_schema(tmp_path):
    config = make_config(tmp_path)
    schema = tool_by_name(AgentDriver()._tool_schemas(config), "finish_with_outputs")["function"]["parameters"]

    assert schema["type"] == "object"
    assert set(schema["properties"]) == {"brief", "metadata"}
    assert schema["properties"]["brief"] == {"type": "string"}
    assert schema["properties"]["metadata"]["type"] == "object"
    assert schema["properties"]["metadata"]["required"] == ["title"]
    assert schema["required"] == ["brief"]
    assert schema["additionalProperties"] is False


def test_write_output_enum_rejects_wrong_name(tmp_path):
    config = make_config(tmp_path)
    driver = AgentDriver()
    write_schema = tool_by_name(driver._tool_schemas(config), "write_output")["function"]["parameters"]
    assert write_schema["properties"]["name"]["enum"] == ["brief", "metadata"]

    output_dir = tmp_path / "artifacts" / "run_wrong_name" / "outputs"
    output_dir.mkdir(parents=True)
    result = driver._write_output(
        {"name": "wrong", "content": "bad"},
        output_dir,
        {},
        [],
        config,
    )

    assert result["ok"] is False
    assert "Undeclared output: wrong" in result["error"]


def test_corrective_retry_on_missing_output(tmp_path):
    config = make_config(tmp_path)
    driver = ScriptedAgentDriver()
    driver.set_scripts([
        [final_response("I wrote the brief in prose only.")],
        [tool_response("finish_with_outputs", {"brief": "# Brief\n\nDone."})],
    ])
    _entries, log_fn = logs()

    result = driver.run(
        "agent-contract-test", "run_corrective", {}, {}, log_fn, "trace", config=config
    )

    assert result.status == "success"
    assert result.outputs == {"brief": "# Brief\n\nDone."}
    assert len(driver.calls) == 2
    assert driver.calls[1]["agent"].model_settings.tool_choice == "finish_with_outputs"


def test_transcript_persisted_on_failure(tmp_path):
    outputs = [
        {
            "name": "X",
            "label": "X",
            "type": "markdown",
            "required": True,
            "path": "out/x.md",
            "kind": "file",
            "media_type": "text/markdown",
        }
    ]
    config = make_config(tmp_path, outputs=outputs)
    driver = ScriptedAgentDriver()
    driver.set_scripts([[final_response("no output")], [final_response("still no output")]])
    _entries, log_fn = logs()

    result = driver.run(
        "agent-contract-test", "run_failure", {}, {}, log_fn, "trace", config=config
    )

    transcript = next(artifact for artifact in result.artifacts if artifact["name"] == "transcript.jsonl")
    assert result.status == "failed"
    assert result.error == "Output schema violation: Missing declared output 'X'"
    assert Path(transcript["path"]).is_file()


def test_declared_path_honored(tmp_path):
    config = make_config(
        tmp_path,
        outputs=[
            {
                "name": "brief",
                "label": "Brief",
                "type": "markdown",
                "required": True,
                "kind": "file",
                "media_type": "text/markdown",
                "path": "out/brief.md",
            }
        ],
    )
    driver = ScriptedAgentDriver()
    driver.set_scripts([[tool_response("finish_with_outputs", {"brief": "# Brief"})]])
    _entries, log_fn = logs()

    result = driver.run(
        "agent-contract-test", "run_declared_path", {}, {}, log_fn, "trace", config=config
    )

    artifact_root = agent_module.ARTIFACTS_DIR / "run_declared_path"
    brief_artifact = next(artifact for artifact in result.artifacts if artifact["name"] == "out/brief.md")
    assert result.status == "success"
    assert brief_artifact["relative_path"] == "out/brief.md"
    assert Path(brief_artifact["path"]).relative_to(artifact_root).as_posix() == "out/brief.md"
    assert not (artifact_root / "outputs" / "brief.txt").exists()
