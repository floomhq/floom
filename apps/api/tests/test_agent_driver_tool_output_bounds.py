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
    _STDOUT_CAP,
    _TOOL_RESULT_MAX_CHARS,
    _truncate,
)
from runner_sandbox.tool_output_bounds import (  # noqa: E402
    TOOL_RESULT_MAX_ARRAY_ITEMS,
    TOOL_RESULT_MAX_STRING_CHARS,
    bounded_mcp_tool_result,
    bounded_tool_output_json,
)


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
    assert decoded["content"].endswith("x" * (TOOL_RESULT_MAX_STRING_CHARS // 2))
    assert f"of {len(large_text)} chars" in decoded["content"]
    assert "kept first" in decoded["content"]
    assert "and last" in decoded["content"]
    assert "rerun with a narrower query/filter" in decoded["content"]
    assert decoded["_tool_output_bounds"][0]["path"] == "$.content"


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
    assert text.endswith("z" * (TOOL_RESULT_MAX_STRING_CHARS // 2))
    assert f"of {len(large_text)} chars" in text
    assert "z" * _TOOL_RESULT_MAX_CHARS not in text
    assert bounded.structuredContent["_tool_output_bounds"][0]["path"] == "$.content[0].text"


def test_long_string_bounds_keep_head_tail_and_recovery_marker():
    large_text = "HEAD-" + ("m" * (TOOL_RESULT_MAX_STRING_CHARS * 2)) + "-TAIL"
    raw_output = bounded_tool_output_json({"ok": True, "content": large_text})
    decoded = json.loads(raw_output)

    assert len(raw_output) <= _TOOL_RESULT_MAX_CHARS
    assert decoded["content"].startswith("HEAD-")
    assert decoded["content"].endswith("-TAIL")
    assert f"of {len(large_text)} chars" in decoded["content"]
    assert (
        f"kept first {TOOL_RESULT_MAX_STRING_CHARS // 2} "
        f"and last {TOOL_RESULT_MAX_STRING_CHARS // 2}"
    ) in decoded["content"]
    assert "rerun with a narrower query/filter or a larger output budget if available" in decoded["content"]


def test_array_truncation_keeps_item_types_and_external_metadata():
    messages = [{"id": i, "body": f"message-{i}"} for i in range(TOOL_RESULT_MAX_ARRAY_ITEMS + 7)]
    raw_output = bounded_tool_output_json({"ok": True, "messages": messages})
    decoded = json.loads(raw_output)

    assert len(decoded["messages"]) == TOOL_RESULT_MAX_ARRAY_ITEMS
    assert all(set(item) == {"id", "body"} for item in decoded["messages"])
    bounds = decoded["_tool_output_bounds"]
    assert bounds == [
        {
            "path": "$.messages",
            "kept": TOOL_RESULT_MAX_ARRAY_ITEMS,
            "total": len(messages),
            "hint": "rerun with limit/page/filter",
        }
    ]


def test_top_level_array_is_wrapped_with_external_metadata():
    values = list(range(TOOL_RESULT_MAX_ARRAY_ITEMS + 3))
    raw_output = bounded_tool_output_json(values)
    decoded = json.loads(raw_output)

    assert decoded["result"] == values[:TOOL_RESULT_MAX_ARRAY_ITEMS]
    assert decoded["_tool_output_bounds"][0]["path"] == "$"
    assert decoded["_tool_output_bounds"][0]["kept"] == TOOL_RESULT_MAX_ARRAY_ITEMS
    assert decoded["_tool_output_bounds"][0]["total"] == len(values)


def test_nested_dict_array_truncation_records_nested_path():
    payload = {"ok": True, "payload": {"messages": list(range(TOOL_RESULT_MAX_ARRAY_ITEMS + 5))}}
    raw_output = bounded_tool_output_json(payload)
    decoded = json.loads(raw_output)

    assert decoded["payload"]["messages"] == list(range(TOOL_RESULT_MAX_ARRAY_ITEMS))
    assert decoded["_tool_output_bounds"][0]["path"] == "$.payload.messages"
    assert decoded["_tool_output_bounds"][0]["total"] == TOOL_RESULT_MAX_ARRAY_ITEMS + 5


def test_command_stdout_truncation_uses_recoverable_head_tail_marker():
    stdout = "OUT-" + ("s" * (_STDOUT_CAP * 2)) + "-DONE"
    bounded = _truncate(stdout, _STDOUT_CAP)

    assert bounded.startswith("OUT-")
    assert bounded.endswith("-DONE")
    assert f"of {len(stdout)} chars" in bounded
    assert f"kept first {_STDOUT_CAP // 2} and last {_STDOUT_CAP // 2}" in bounded
    assert "rerun with a narrower query/filter or a larger output budget if available" in bounded
