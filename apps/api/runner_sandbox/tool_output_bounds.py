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
    max(
        1024,
        _positive_int_from_env(
            "WORKEROS_AGENT_TOOL_RESULT_MAX_STRING_CHARS",
            TOOL_RESULT_MAX_CHARS // 2,
        ),
    ),
)
TOOL_RESULT_MAX_ARRAY_ITEMS = _positive_int_from_env(
    "WORKEROS_AGENT_TOOL_RESULT_MAX_ARRAY_ITEMS",
    50,
)
TOOL_RESULT_MAX_DEPTH = 10
TOOL_RESULT_HEAD_PERCENT = min(
    90,
    max(10, _positive_int_from_env("WORKEROS_AGENT_TOOL_RESULT_HEAD_PERCENT", 50)),
)

RECOVERY_HINT = "rerun with a narrower query/filter or a larger output budget if available"
ARRAY_RECOVERY_HINT = "rerun with limit/page/filter"


def _path_child(path: str, key: Any) -> str:
    if isinstance(key, str) and key.replace("_", "").isalnum() and not key[:1].isdigit():
        return f"{path}.{key}"
    return f"{path}[{json.dumps(str(key))}]"


def _path_index(path: str, index: int) -> str:
    return f"{path}[{index}]"


def _retained_counts(cap: int) -> tuple[int, int]:
    head = max(1, min(cap - 1, int(cap * TOOL_RESULT_HEAD_PERCENT / 100)))
    tail = max(1, cap - head)
    return head, tail


def truncation_marker(original_chars: int, head_chars: int, tail_chars: int) -> str:
    omitted_chars = max(0, original_chars - head_chars - tail_chars)
    return (
        f"[truncated {omitted_chars} of {original_chars} chars; "
        f"kept first {head_chars} and last {tail_chars}; {RECOVERY_HINT}]"
    )


def bound_text(value: str, cap: int = TOOL_RESULT_MAX_STRING_CHARS) -> str:
    """Return a recoverably bounded string with head and tail retained."""

    if len(value) <= cap:
        return value
    head_chars, tail_chars = _retained_counts(cap)
    marker = truncation_marker(len(value), head_chars, tail_chars)
    return f"{value[:head_chars]}\n{marker}\n{value[-tail_chars:]}"


def _string_bound_metadata(path: str, value: str, bounded: str) -> dict[str, Any]:
    head_chars, tail_chars = _retained_counts(TOOL_RESULT_MAX_STRING_CHARS)
    return {
        "path": path,
        "kept": head_chars + tail_chars,
        "total": len(value),
        "returned_chars": len(bounded),
        "hint": RECOVERY_HINT,
    }


def _bounded_value(value: Any, *, path: str = "$", depth: int = 0) -> tuple[Any, list[dict[str, Any]]]:
    if depth > TOOL_RESULT_MAX_DEPTH:
        return {
            "_tool_output_truncated": True,
            "reason": "maximum nesting depth exceeded",
        }, [{"path": path, "kept": 0, "total": 1, "hint": "reduce nesting depth"}]

    if isinstance(value, str):
        if len(value) <= TOOL_RESULT_MAX_STRING_CHARS:
            return value, []
        bounded = bound_text(value, TOOL_RESULT_MAX_STRING_CHARS)
        return bounded, [_string_bound_metadata(path, value, bounded)]

    if isinstance(value, dict):
        bounded: dict[Any, Any] = {}
        metadata: list[dict[str, Any]] = []
        for key, item in value.items():
            bounded_item, item_metadata = _bounded_value(
                item,
                path=_path_child(path, key),
                depth=depth + 1,
            )
            bounded[key] = bounded_item
            metadata.extend(item_metadata)
        return bounded, metadata

    if isinstance(value, list):
        bounded_items = []
        metadata: list[dict[str, Any]] = []
        for item in value[:TOOL_RESULT_MAX_ARRAY_ITEMS]:
            bounded_item, item_metadata = _bounded_value(
                item,
                path=_path_index(path, len(bounded_items)),
                depth=depth + 1,
            )
            bounded_items.append(bounded_item)
            metadata.extend(item_metadata)
        if len(value) > TOOL_RESULT_MAX_ARRAY_ITEMS:
            metadata.append(
                {
                    "path": path,
                    "kept": TOOL_RESULT_MAX_ARRAY_ITEMS,
                    "total": len(value),
                    "hint": ARRAY_RECOVERY_HINT,
                }
            )
        return bounded_items, metadata

    return value, []


def _with_bounds_metadata(value: Any, metadata: list[dict[str, Any]]) -> Any:
    if not metadata:
        return value
    if isinstance(value, dict):
        enriched = dict(value)
        existing = enriched.get("_tool_output_bounds")
        if isinstance(existing, list):
            enriched["_tool_output_bounds"] = [*existing, *metadata]
        else:
            enriched["_tool_output_bounds"] = metadata
        return enriched
    return {
        "result": value,
        "_tool_output_bounds": metadata,
    }


def bounded_tool_output_json(value: Any) -> str:
    """Serialize a tool result to bounded JSON for the Agents SDK."""

    bounded, metadata = _bounded_value(value)
    bounded = _with_bounds_metadata(bounded, metadata)
    serialized = json.dumps(bounded, default=str)
    if len(serialized) <= TOOL_RESULT_MAX_CHARS:
        return serialized

    preview_budget = max(1024, TOOL_RESULT_MAX_CHARS - 1024)
    preview = bound_text(serialized, preview_budget)
    fallback = {
        "ok": bool(value.get("ok")) if isinstance(value, dict) and "ok" in value else True,
        "_tool_output_bounds": [
            *metadata,
            {
                "path": "$",
                "kept": preview_budget,
                "total": len(serialized),
                "returned_chars": len(preview),
                "hint": RECOVERY_HINT,
            },
        ],
        "preview": preview,
    }
    encoded = json.dumps(fallback, default=str)
    if len(encoded) <= TOOL_RESULT_MAX_CHARS:
        return encoded
    while len(encoded) > TOOL_RESULT_MAX_CHARS and preview_budget > 128:
        overflow = len(encoded) - TOOL_RESULT_MAX_CHARS
        preview_budget = max(128, preview_budget - overflow - 128)
        fallback["_tool_output_bounds"][-1]["kept"] = preview_budget
        fallback["preview"] = bound_text(serialized, preview_budget)
        encoded = json.dumps(fallback, default=str)
    if len(encoded) > TOOL_RESULT_MAX_CHARS:
        fallback["_tool_output_bounds"] = [fallback["_tool_output_bounds"][-1]]
        encoded = json.dumps(fallback, default=str)
        while len(encoded) > TOOL_RESULT_MAX_CHARS and preview_budget > 64:
            overflow = len(encoded) - TOOL_RESULT_MAX_CHARS
            preview_budget = max(64, preview_budget - overflow - 64)
            fallback["_tool_output_bounds"][0]["kept"] = preview_budget
            fallback["preview"] = bound_text(serialized, preview_budget)
            encoded = json.dumps(fallback, default=str)
    return encoded


def bounded_mcp_tool_result(result: Any) -> Any:
    """Return an MCP CallToolResult with large text and structured fields capped."""

    metadata: list[dict[str, Any]] = []
    content = getattr(result, "content", None)
    if isinstance(content, list):
        bounded_content = []
        for index, item in enumerate(content[:TOOL_RESULT_MAX_ARRAY_ITEMS]):
            text = getattr(item, "text", None)
            if isinstance(text, str):
                bounded_text = bound_text(text, TOOL_RESULT_MAX_STRING_CHARS)
                if bounded_text != text:
                    metadata.append(
                        _string_bound_metadata(
                            _path_child(_path_index("$.content", index), "text"),
                            text,
                            bounded_text,
                        )
                    )
                if bounded_text != text and hasattr(item, "model_copy"):
                    bounded_content.append(item.model_copy(update={"text": bounded_text}))
                elif bounded_text != text and isinstance(item, dict):
                    copied = dict(item)
                    copied["text"] = bounded_text
                    bounded_content.append(copied)
                else:
                    bounded_content.append(item)
            else:
                bounded_item, item_metadata = _bounded_value(item, path=_path_index("$.content", index))
                bounded_content.append(bounded_item)
                metadata.extend(item_metadata)
        if len(content) > TOOL_RESULT_MAX_ARRAY_ITEMS:
            metadata.append(
                {
                    "path": "$.content",
                    "kept": TOOL_RESULT_MAX_ARRAY_ITEMS,
                    "total": len(content),
                    "hint": ARRAY_RECOVERY_HINT,
                }
            )
    else:
        bounded_content = content

    structured = getattr(result, "structuredContent", None)
    bounded_structured = structured
    if structured is not None:
        bounded_structured, structured_metadata = _bounded_value(structured, path="$.structuredContent")
        metadata.extend(structured_metadata)
    if metadata:
        if structured is None:
            bounded_structured = {"_tool_output_bounds": metadata}
        else:
            bounded_structured = _with_bounds_metadata(bounded_structured, metadata)

    if not metadata:
        return result
    if hasattr(result, "model_copy"):
        return result.model_copy(
            update={
                "content": bounded_content,
                "structuredContent": bounded_structured,
            }
        )
    return result
