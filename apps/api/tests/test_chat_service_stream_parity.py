"""#605 — shared stream adapter parity: agent_driver and chat_service must
decode SDK stream events through the same single source of truth.

Covers:
  - stream_adapter.decode_stream_event normalizes text deltas, message
    output, tool call/result pairs (incl. MCP server-prefixed names and
    web_search metadata), and error mapping (ok:false -> isError)
  - AgentDriver._agent_event_to_part preserves the normalized tool metadata
    (toolName / callId / args / isError) exactly
  - chat_service.stream_chat is wired through decode_stream_event and keeps
    no inline fork of the SDK event decoding

Run: cd apps/api && python -m pytest tests/test_chat_service_stream_parity.py -q
"""
from __future__ import annotations

import inspect
import json
import sys
from pathlib import Path
from types import SimpleNamespace

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from runner_sandbox.stream_adapter import decode_stream_event


def _text_delta_event(text: str):
    return SimpleNamespace(
        type="raw_response_event",
        data=SimpleNamespace(type="response.output_text.delta", delta=text),
    )


def _message_event(text: str):
    return SimpleNamespace(
        type="run_item_stream_event",
        name="message_output_created",
        item=SimpleNamespace(raw_item=SimpleNamespace(content=[SimpleNamespace(text=text)])),
    )


def _tool_called_event(name="workers__list_all", args=None, call_id="call_1", server_label=None):
    raw = SimpleNamespace(
        type="function_call",
        name=name,
        arguments=json.dumps(args or {}),
        call_id=call_id,
        server_label=server_label,
    )
    return SimpleNamespace(
        type="run_item_stream_event",
        name="tool_called",
        item=SimpleNamespace(raw_item=raw, tool_origin=None),
    )


def _tool_output_event(output, call_id="call_1"):
    return SimpleNamespace(
        type="run_item_stream_event",
        name="tool_output",
        item=SimpleNamespace(
            raw_item=SimpleNamespace(type="function_call_output", call_id=call_id),
            output=output,
            tool_origin=None,
        ),
    )


class TestDecode:
    def test_text_delta(self):
        item = decode_stream_event(_text_delta_event("hel"))
        assert item.kind == "text_delta" and item.text == "hel"

    def test_message_output(self):
        item = decode_stream_event(_message_event("final reply"))
        assert item.kind == "message_output" and item.text == "final reply"

    def test_tool_call_args_parsed(self):
        item = decode_stream_event(_tool_called_event(args={"q": "x"}, call_id="call_9"))
        assert item.kind == "tool_call"
        assert item.tool_name == "workers__list_all"
        assert item.call_id == "call_9"
        assert item.args == {"q": "x"}

    def test_mcp_tool_name_is_server_prefixed(self):
        item = decode_stream_event(
            _tool_called_event(name="search", server_label="linear")
        )
        assert item.tool_name == "linear.search"
        assert item.metadata.get("kind") == "mcp"
        assert item.metadata.get("mcpServer") == "linear"

    def test_tool_output_ok_false_is_error(self):
        item = decode_stream_event(_tool_output_event(json.dumps({"ok": False, "error": "nope"})))
        assert item.kind == "tool_output"
        assert item.output == {"ok": False, "error": "nope"}
        assert item.is_error is True

    def test_tool_output_ok_true_not_error(self):
        item = decode_stream_event(_tool_output_event(json.dumps({"ok": True})))
        assert item.is_error is False

    def test_irrelevant_event_is_none(self):
        assert decode_stream_event(SimpleNamespace(type="agent_updated_stream_event")) is None


class TestAgentDriverParity:
    def _driver(self):
        from runner_sandbox.agent_driver import AgentDriver

        return AgentDriver.__new__(AgentDriver)  # decoding needs no driver state

    def test_tool_call_part_matches_decoded(self):
        event = _tool_called_event(args={"a": 1}, call_id="call_7")
        decoded = decode_stream_event(event)
        part, _ = self._driver()._agent_event_to_part(event, False)
        assert part["type"] == "tool-call"
        assert part["toolName"] == decoded.tool_name
        assert part["callId"] == decoded.call_id
        assert part["args"] == decoded.args

    def test_tool_result_part_matches_decoded(self):
        event = _tool_output_event(json.dumps({"ok": False}), call_id="call_7")
        decoded = decode_stream_event(event)
        part, _ = self._driver()._agent_event_to_part(event, False)
        assert part["type"] == "tool-result"
        assert part["callId"] == decoded.call_id
        assert part["result"] == decoded.output
        assert part["isError"] is decoded.is_error is True

    def test_text_delta_sets_emitted_flag(self):
        part, emitted = self._driver()._agent_event_to_part(_text_delta_event("x"), False)
        assert part == {"type": "text", "text": "x"} and emitted is True

    def test_message_output_suppressed_after_deltas(self):
        part, _ = self._driver()._agent_event_to_part(_message_event("dup"), True)
        assert part is None


class TestChatServiceWiring:
    def test_stream_chat_uses_shared_adapter(self):
        import chat_service

        src = inspect.getsource(chat_service.stream_chat)
        assert "decode_stream_event" in src, (
            "stream_chat must decode SDK events via runner_sandbox.stream_adapter (#605)"
        )

    def test_chat_service_has_no_inline_event_decoding_fork(self):
        import chat_service

        src = inspect.getsource(chat_service.stream_chat)
        for forked in ("raw_response_event", "run_item_stream_event", "message_output_created"):
            assert forked not in src, (
                f"stream_chat re-grew an inline decoder branch for {forked!r}; "
                "extend stream_adapter instead (#605)"
            )
