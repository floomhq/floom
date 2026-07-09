"""Bound agent tool outputs before they re-enter model context."""

from __future__ import annotations

import json
import os
from typing import Any


def _positive_int_from_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


TOOL_RESULT_MAX_CHARS = max(
    4096,
    _positive_int_from_env("WORKEROS_AGENT_TOOL_RESULT_MAX_CHARS", 32768),
)
TOOL_RESULT_MAX_STRING_CHARS = min(
    12000,
    max(1024, TOOL_RESULT_MAX_CHARS // 2),
)
TOOL_RESULT_MAX_ARRAY_ITEMS = 50
TOOL_RESULT_MAX_DEPTH = 10


def _truncation_marker(omitted_chars: int) -> str:
    return f"[output truncated, {omitted_chars} chars omitted]"


def _bounded_value(value: Any, *, depth: int = 0) -> tuple[Any, bool]:
    if depth > TOOL_RESULT_MAX_DEPTH:
        return {
            "_floom_truncated": True,
            "reason": "maximum nesting depth exceeded",
        }, True

    if isinstance(value, str):
        if len(value) <= TOOL_RESULT_MAX_STRING_CHARS:
            return value, False
        omitted = len(value) - TOOL_RESULT_MAX_STRING_CHARS
        return f"{value[:TOOL_RESULT_MAX_STRING_CHARS]}\n{_truncation_marker(omitted)}", True

    if isinstance(value, dict):
        truncated = False
        bounded: dict[Any, Any] = {}
        for key, item in value.items():
            bounded_item, item_truncated = _bounded_value(item, depth=depth + 1)
            bounded[key] = bounded_item
            truncated = truncated or item_truncated
        return bounded, truncated

    if isinstance(value, list):
        truncated = len(value) > TOOL_RESULT_MAX_ARRAY_ITEMS
        bounded_items = []
        for item in value[:TOOL_RESULT_MAX_ARRAY_ITEMS]:
            bounded_item, item_truncated = _bounded_value(item, depth=depth + 1)
            bounded_items.append(bounded_item)
            truncated = truncated or item_truncated
        if len(value) > TOOL_RESULT_MAX_ARRAY_ITEMS:
            bounded_items.append(
                {
                    "_floom_truncated": True,
                    "omitted_items": len(value) - TOOL_RESULT_MAX_ARRAY_ITEMS,
                }
            )
        return bounded_items, truncated

    return value, False


def _with_metadata(value: Any, *, original_chars: int, returned_chars: int, truncated: bool) -> Any:
    metadata = {
        "truncated": truncated,
        "original_chars": original_chars,
        "returned_chars": returned_chars,
        "omitted_chars": max(0, original_chars - returned_chars),
    }
    if isinstance(value, dict):
        enriched = dict(value)
        enriched["_floom_tool_output"] = metadata
        return enriched
    return {
        "ok": True,
        "_floom_tool_output": metadata,
        "value": value,
    }


def bounded_tool_output_json(value: Any) -> str:
    """Serialize a tool result to bounded JSON for the Agents SDK."""

    original = json.dumps(value, default=str)
    bounded, truncated = _bounded_value(value)
    serialized = json.dumps(bounded, default=str)
    if truncated:
        bounded = _with_metadata(
            bounded,
            original_chars=len(original),
            returned_chars=len(serialized),
            truncated=True,
        )
        serialized = json.dumps(bounded, default=str)
    if len(serialized) <= TOOL_RESULT_MAX_CHARS:
        return serialized

    preview_budget = max(1024, TOOL_RESULT_MAX_CHARS - 1024)
    preview = serialized[:preview_budget]
    fallback = {
        "ok": bool(value.get("ok")) if isinstance(value, dict) and "ok" in value else True,
        "_floom_tool_output": {
            "truncated": True,
            "original_chars": len(original),
            "returned_chars": len(preview),
            "omitted_chars": max(0, len(original) - len(preview)),
        },
        "preview": f"{preview}\n{_truncation_marker(max(0, len(serialized) - len(preview)))}",
    }
    encoded = json.dumps(fallback, default=str)
    if len(encoded) <= TOOL_RESULT_MAX_CHARS:
        return encoded
    overflow = len(encoded) - TOOL_RESULT_MAX_CHARS
    fallback["preview"] = fallback["preview"][: max(0, len(fallback["preview"]) - overflow - 32)]
    encoded = json.dumps(fallback, default=str)
    while len(encoded) > TOOL_RESULT_MAX_CHARS and fallback["preview"]:
        fallback["preview"] = fallback["preview"][:-128]
        encoded = json.dumps(fallback, default=str)
    return encoded


def bounded_mcp_tool_result(result: Any) -> Any:
    """Return an MCP CallToolResult with large text and structured fields capped."""

    truncated = False
    content = getattr(result, "content", None)
    if isinstance(content, list):
        bounded_content = []
        for item in content[:TOOL_RESULT_MAX_ARRAY_ITEMS]:
            text = getattr(item, "text", None)
            if isinstance(text, str):
                bounded_text, item_truncated = _bounded_value(text)
                truncated = truncated or item_truncated
                if item_truncated and hasattr(item, "model_copy"):
                    bounded_content.append(item.model_copy(update={"text": bounded_text}))
                elif item_truncated and isinstance(item, dict):
                    copied = dict(item)
                    copied["text"] = bounded_text
                    bounded_content.append(copied)
                else:
                    bounded_content.append(item)
            else:
                bounded_item, item_truncated = _bounded_value(item)
                bounded_content.append(bounded_item)
                truncated = truncated or item_truncated
        if len(content) > TOOL_RESULT_MAX_ARRAY_ITEMS:
            truncated = True
            try:
                from mcp.types import TextContent

                bounded_content.append(
                    TextContent(
                        type="text",
                        text=f"[output truncated, {len(content) - TOOL_RESULT_MAX_ARRAY_ITEMS} content items omitted]",
                    )
                )
            except Exception:
                bounded_content.append(
                    {
                        "type": "text",
                        "text": f"[output truncated, {len(content) - TOOL_RESULT_MAX_ARRAY_ITEMS} content items omitted]",
                    }
                )
    else:
        bounded_content = content

    structured = getattr(result, "structuredContent", None)
    bounded_structured = structured
    if structured is not None:
        bounded_structured, structured_truncated = _bounded_value(structured)
        truncated = truncated or structured_truncated

    if not truncated:
        return result
    if hasattr(result, "model_copy"):
        return result.model_copy(
            update={
                "content": bounded_content,
                "structuredContent": bounded_structured,
            }
        )
    return result
