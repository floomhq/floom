from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerConfig, WorkerLimits, WorkerOutput, WorkerRuntime, WorkerTrigger  # noqa: E402
from runner_sandbox.agent_driver import (  # noqa: E402
    AgentDriver,
    _AgentRunState,
    _TOOL_RESULT_MAX_CHARS,
)
from runner_sandbox.tool_output_bounds import bounded_mcp_tool_result  # noqa: E402


def _config() -> WorkerConfig:
    return WorkerConfig(
        id="tool-output-bounds",
        name="Tool Output Bounds",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="python311",
            entrypoint="SKILL.md",
            runner="e2b",
            mode="agent",
            limits=WorkerLimits(),
        ),
        outputs=[
            WorkerOutput(
                name="summary",
                label="Summary",
                type="markdown",
                required=True,
                kind="file",
                media_type="text/markdown",
                path="outputs/summary.md",
            )
        ],
    )


def _state(tmp_path: Path, config: WorkerConfig) -> _AgentRunState:
    bundle_dir = tmp_path / "bundle"
    input_dir = tmp_path / "inputs"
    output_dir = tmp_path / "outputs"
    context_dir = tmp_path / "context"
    for path in (bundle_dir, input_dir, output_dir, context_dir):
        path.mkdir()
    return _AgentRunState(
        worker_id=config.id,
        run_id="run-tool-output-bounds",
        inputs={},
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace-tool-output-bounds",
        config=config,
        bundle_dir=bundle_dir,
        input_dir=input_dir,
        output_dir=output_dir,
        context_dir=context_dir,
        outputs={},
        artifacts=[],
        timeout_seconds=60,
        connection_ids={},
        user_id="user-tool-output-bounds",
    )


def test_large_read_file_tool_output_is_bounded_before_sdk_context(tmp_path):
    config = _config()
    state = _state(tmp_path, config)
    large_text = "NEWS ITEM " + ("x" * (_TOOL_RESULT_MAX_CHARS * 3))
    (state.bundle_dir / "article.html").write_text(large_text, encoding="utf-8")

    read_file_tool = next(tool for tool in AgentDriver()._sdk_tools(config, state) if tool.name == "read_file")
    raw_output = asyncio.run(read_file_tool.on_invoke_tool(None, json.dumps({"path": "article.html"})))
    decoded = json.loads(raw_output)

    assert len(raw_output) <= _TOOL_RESULT_MAX_CHARS
    assert decoded["ok"] is True
    assert decoded["content"].startswith("NEWS ITEM ")
    assert "[output truncated" in decoded["content"]
    assert decoded["_floom_tool_output"]["truncated"] is True


def test_finish_with_outputs_tool_result_does_not_echo_full_output_content(tmp_path):
    config = _config()
    state = _state(tmp_path, config)
    large_summary = "# Daily News\n\n" + ("story\n" * (_TOOL_RESULT_MAX_CHARS // 2))

    finish_tool = next(tool for tool in AgentDriver()._sdk_tools(config, state) if tool.name == "finish_with_outputs")
    raw_output = asyncio.run(finish_tool.on_invoke_tool(None, json.dumps({"summary": large_summary})))
    decoded = json.loads(raw_output)

    assert len(raw_output) < 1000
    assert decoded == {"ok": True, "finished": True, "outputs": ["summary"]}
    assert state.outputs["summary"] == large_summary


def test_mcp_text_tool_result_is_bounded_before_sdk_context():
    from mcp.types import CallToolResult, TextContent

    large_text = "ARTICLE " + ("z" * (_TOOL_RESULT_MAX_CHARS * 2))
    result = CallToolResult(
        content=[
            TextContent(type="text", text=large_text),
        ],
        isError=False,
    )

    bounded = bounded_mcp_tool_result(result)
    text = bounded.content[0].text

    assert len(text) < len(large_text)
    assert text.startswith("ARTICLE ")
    assert "[output truncated" in text
    assert "z" * _TOOL_RESULT_MAX_CHARS not in text
