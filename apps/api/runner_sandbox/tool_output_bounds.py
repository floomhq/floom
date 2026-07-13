"""Bound agent tool outputs before they re-enter model context."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
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
TOOL_CONTEXT_MAX_CHARS = max(
    TOOL_RESULT_MAX_CHARS,
    _positive_int_from_env("WORKEROS_AGENT_TOOL_CONTEXT_MAX_CHARS", 131072),
)
TOOL_CONTEXT_MIN_RESULT_CHARS = max(
    512,
    _positive_int_from_env("WORKEROS_AGENT_TOOL_CONTEXT_MIN_RESULT_CHARS", 2048),
)
TOOL_RESULT_HEAD_PERCENT = min(
    90,
    max(10, _positive_int_from_env("WORKEROS_AGENT_TOOL_RESULT_HEAD_PERCENT", 50)),
)

RECOVERY_HINT = "rerun with a narrower query/filter or a larger output budget if available"
ARRAY_RECOVERY_HINT = "rerun with limit/page/filter"
CUMULATIVE_RECOVERY_HINT = "rerun with fewer fetch/read calls, narrower queries, or write intermediate data to outputs"


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


@dataclass
class ToolOutputContextBudget:
    """Soft cumulative cap for tool output text handed back to the Agents SDK."""

    max_chars: int = TOOL_CONTEXT_MAX_CHARS
    used_chars: int = 0

    @property
    def remaining_chars(self) -> int:
        return max(0, int(self.max_chars) - int(self.used_chars))

    def reserve_json(self, serialized: str, *, ok: bool = True, path: str = "$") -> str:
        if len(serialized) <= self.remaining_chars:
            self.used_chars += len(serialized)
            return serialized
        bounded = self._cumulative_fallback(serialized, ok=ok, path=path)
        self.used_chars += len(bounded)
        return bounded

    def _cumulative_fallback(self, serialized: str, *, ok: bool, path: str) -> str:
        room = self.remaining_chars
        target = min(
            TOOL_RESULT_MAX_CHARS,
            max(TOOL_CONTEXT_MIN_RESULT_CHARS, room),
        )
        metadata = {
            "path": path,
            "kept": 0,
            "total": len(serialized),
            "context_budget_chars": int(self.max_chars),
            "context_used_chars": int(self.used_chars),
            "hint": CUMULATIVE_RECOVERY_HINT,
        }
        if room <= TOOL_CONTEXT_MIN_RESULT_CHARS:
            return json.dumps(
                {
                    "ok": ok,
                    "_tool_output_bounds": [metadata],
                    "preview": (
                        "Tool output omitted because this run reached the cumulative "
                        "tool-output context budget."
                    ),
                },
                default=str,
            )

        preview_budget = max(64, target - 1024)
        preview = bound_text(serialized, preview_budget)
        metadata["kept"] = preview_budget
        metadata["returned_chars"] = len(preview)
        fallback = {
            "ok": ok,
            "_tool_output_bounds": [metadata],
            "preview": preview,
        }
        encoded = json.dumps(fallback, default=str)
        while len(encoded) > target and preview_budget > 64:
            overflow = len(encoded) - target
            preview_budget = max(64, preview_budget - overflow - 64)
            fallback["_tool_output_bounds"][0]["kept"] = preview_budget
            fallback["preview"] = bound_text(serialized, preview_budget)
            fallback["_tool_output_bounds"][0]["returned_chars"] = len(fallback["preview"])
            encoded = json.dumps(fallback, default=str)
        return encoded


def bounded_tool_output_json_with_budget(value: Any, budget: ToolOutputContextBudget | None) -> str:
    serialized = bounded_tool_output_json(value)
    if budget is None:
        return serialized
    ok = bool(value.get("ok")) if isinstance(value, dict) and "ok" in value else True
    return budget.reserve_json(serialized, ok=ok, path="$")


def bounded_mcp_tool_result(result: Any) -> Any:
    """Return an MCP CallToolResult with large text and structured fields capped."""

    metadata: list[dict[str, Any]] = []
    content = result.get("content") if isinstance(result, dict) else getattr(result, "content", None)
    if isinstance(content, list):
        bounded_content = []
        for index, item in enumerate(content[:TOOL_RESULT_MAX_ARRAY_ITEMS]):
            text = item.get("text") if isinstance(item, dict) else getattr(item, "text", None)
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

    structured = result.get("structuredContent") if isinstance(result, dict) else getattr(result, "structuredContent", None)
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
    if isinstance(result, dict):
        bounded_result = dict(result)
        bounded_result["content"] = bounded_content
        if bounded_structured is not None:
            bounded_result["structuredContent"] = bounded_structured
        return bounded_result
    if hasattr(result, "model_copy"):
        return result.model_copy(
            update={
                "content": bounded_content,
                "structuredContent": bounded_structured,
            }
        )
    return result


def _mcp_result_size(result: Any) -> int:
    try:
        if hasattr(result, "model_dump"):
            return len(json.dumps(result.model_dump(mode="json"), default=str))
        return len(json.dumps(result, default=str))
    except Exception:
        total = 0
        content = result.get("content") if isinstance(result, dict) else getattr(result, "content", None)
        if isinstance(content, list):
            for item in content:
                text = item.get("text") if isinstance(item, dict) else getattr(item, "text", None)
                if isinstance(text, str):
                    total += len(text)
        return total


def bounded_mcp_tool_result_with_budget(result: Any, budget: ToolOutputContextBudget | None) -> Any:
    bounded = bounded_mcp_tool_result(result)
    if budget is None:
        return bounded
    size = _mcp_result_size(bounded)
    if size <= budget.remaining_chars:
        budget.used_chars += size
        return bounded

    warning = (
        "Tool output omitted because this run reached the cumulative tool-output "
        f"context budget of {budget.max_chars} chars. {CUMULATIVE_RECOVERY_HINT}."
    )
    budget.used_chars += len(warning)
    content = bounded.get("content") if isinstance(bounded, dict) else getattr(bounded, "content", None)
    if isinstance(content, list) and content:
        first = content[0]
        if isinstance(first, dict):
            replacement = dict(first)
            replacement["text"] = warning
            new_content = [replacement]
        elif hasattr(first, "model_copy"):
            new_content = [first.model_copy(update={"text": warning})]
        else:
            new_content = content
    else:
        new_content = [{"type": "text", "text": warning}]
    structured = {
        "_tool_output_bounds": [
            {
                "path": "$",
                "kept": 0,
                "total": size,
                "context_budget_chars": int(budget.max_chars),
                "context_used_chars": int(budget.used_chars),
                "hint": CUMULATIVE_RECOVERY_HINT,
            }
        ]
    }
    if isinstance(bounded, dict):
        updated = dict(bounded)
        updated["content"] = new_content
        updated["structuredContent"] = structured
        return updated
    if hasattr(bounded, "model_copy"):
        return bounded.model_copy(update={"content": new_content, "structuredContent": structured})
    return bounded
