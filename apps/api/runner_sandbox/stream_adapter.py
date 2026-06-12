"""Shared SDK stream-event decoding (#605).

AgentDriver (worker runs) and chat_service.stream_chat (workspace chat) both
consume openai-agents SDK stream events and previously forked the decoding:
tool name/args/call-id extraction, text-delta detection, message-output text
assembly, and tool-error detection lived twice and drifted.

This module is the single source of truth for SDK event -> normalized
StreamItem. Consumers decorate items into their own part envelopes:
AgentDriver into transcript/run parts, stream_chat into versioned UI parts
with card metadata, sanitizers, and persistence. Surface-specific envelopes
(run step-start/finish vs chat finish with conversation ids) intentionally
stay with their consumers.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

__all__ = [
    "StreamItem",
    "decode_stream_event",
    "object_get",
    "maybe_json_loads",
    "tool_output_is_error",
    "message_item_text",
    "raw_tool_name",
    "raw_tool_args",
    "raw_tool_call_id",
    "tool_part_metadata",
]


@dataclass
class StreamItem:
    """Normalized view of one SDK stream event.

    kind is one of: text_delta, reasoning_delta, message_output, reasoning,
    tool_call, tool_output, mcp_approval, mcp_list_tools.
    """

    kind: str
    text: str = ""
    tool_name: str = ""
    call_id: str = ""
    args: Any = None
    output: Any = None
    is_error: bool = False
    server_label: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


def object_get(obj: Any, key: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def maybe_json_loads(value: Any) -> Any:
    if not isinstance(value, str):
        return value if value is not None else {}
    try:
        return json.loads(value)
    except Exception:
        return value


def tool_output_is_error(output: Any) -> bool:
    if isinstance(output, dict) and "ok" in output:
        return not bool(output.get("ok"))
    return False


def message_item_text(item: Any) -> str:
    # ItemHelpers understands real SDK items; it returns "" (not an error) for
    # other shapes, so fall back to raw content extraction whenever it comes
    # back empty. Pre-#605 the two consumers each had only ONE of these
    # strategies and drifted; the union covers both.
    try:
        from agents.items import ItemHelpers

        text = ItemHelpers.text_message_output(item)
        if text:
            return text
    except Exception:
        pass
    raw_item = getattr(item, "raw_item", None)
    content = object_get(raw_item, "content") or []
    parts: list[str] = []
    for entry in content:
        text = object_get(entry, "text")
        if text:
            parts.append(str(text))
    return "".join(parts)


def raw_tool_name(raw_item: Any, item: Any = None) -> str:
    server_label = object_get(raw_item, "server_label") or object_get(raw_item, "serverLabel")
    name = object_get(raw_item, "name")
    raw_type = object_get(raw_item, "type")
    if server_label and name:
        return f"{server_label}.{name}"
    if name:
        return str(name)
    if raw_type:
        return str(raw_type)
    title = getattr(item, "title", None)
    return str(title or "tool")


def raw_tool_args(raw_item: Any) -> Any:
    raw_args = (
        object_get(raw_item, "arguments")
        or object_get(raw_item, "input")
        or object_get(raw_item, "action")
    )
    return maybe_json_loads(raw_args)


def raw_tool_call_id(raw_item: Any) -> str:
    value = (
        object_get(raw_item, "call_id")
        or object_get(raw_item, "callId")
        or object_get(raw_item, "id")
    )
    return str(value or f"call_{uuid.uuid4().hex[:12]}")


def tool_part_metadata(raw_item: Any, item: Any = None) -> Dict[str, Any]:
    metadata: Dict[str, Any] = {}
    server_label = object_get(raw_item, "server_label") or object_get(raw_item, "serverLabel")
    tool_origin = getattr(item, "tool_origin", None)
    origin_server = getattr(tool_origin, "mcp_server_name", None)
    if server_label or origin_server:
        metadata["kind"] = "mcp"
        metadata["mcpServer"] = server_label or origin_server
    raw_type = object_get(raw_item, "type")
    if raw_type == "web_search_call":
        metadata["kind"] = "web_search"
    return metadata


def _decode_raw_response_event(data: Any) -> Optional[StreamItem]:
    data_type = str(getattr(data, "type", "") or "")
    delta = getattr(data, "delta", None)
    if delta and data_type.endswith("output_text.delta"):
        return StreamItem(kind="text_delta", text=str(delta))
    if delta and "reasoning" in data_type:
        return StreamItem(kind="reasoning_delta", text=str(delta))
    return None


def decode_stream_event(event: Any) -> Optional[StreamItem]:
    """Decode one SDK stream event into a StreamItem, or None if irrelevant.

    Pure: no gating on consumer state. Consumers decide e.g. whether a
    message_output is redundant because text deltas already streamed.
    """
    event_type = getattr(event, "type", None)
    if event_type == "raw_response_event":
        return _decode_raw_response_event(getattr(event, "data", None))

    if event_type != "run_item_stream_event":
        return None

    name = getattr(event, "name", None)
    item = getattr(event, "item", None)
    raw_item = getattr(item, "raw_item", None)

    if name == "message_output_created":
        return StreamItem(kind="message_output", text=message_item_text(item))

    if name == "reasoning_item_created":
        text = object_get(raw_item, "summary") or object_get(raw_item, "content")
        if isinstance(text, list):
            text = " ".join(str(part) for part in text)
        return StreamItem(kind="reasoning", text=str(text) if text else "")

    if name == "tool_called":
        return StreamItem(
            kind="tool_call",
            tool_name=raw_tool_name(raw_item, item),
            call_id=raw_tool_call_id(raw_item),
            args=raw_tool_args(raw_item),
            metadata=tool_part_metadata(raw_item, item),
        )

    if name == "tool_output":
        output = maybe_json_loads(getattr(item, "output", None))
        return StreamItem(
            kind="tool_output",
            call_id=raw_tool_call_id(raw_item),
            output=output,
            is_error=tool_output_is_error(output),
            metadata=tool_part_metadata(raw_item, item),
        )

    if name == "mcp_approval_requested":
        return StreamItem(
            kind="mcp_approval",
            tool_name=raw_tool_name(raw_item, item) or "mcp_approval_requested",
            call_id=raw_tool_call_id(raw_item),
            args=raw_tool_args(raw_item),
            metadata=tool_part_metadata(raw_item, item),
        )

    if name == "mcp_list_tools":
        server_label = object_get(raw_item, "server_label") or object_get(raw_item, "serverLabel")
        return StreamItem(
            kind="mcp_list_tools",
            call_id=raw_tool_call_id(raw_item),
            server_label=str(server_label) if server_label else None,
        )

    return None
