from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any


class FakeUsage:
    def __init__(self, total_tokens: int = 0):
        self.total_tokens = total_tokens


class FakeStreamingResult:
    def __init__(self, agent: Any, events: list[dict[str, Any]], *, tokens: int = 0):
        self.agent = agent
        self.events = list(events)
        self.context_wrapper = SimpleNamespace(usage=FakeUsage(tokens))
        self.final_output = ""
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True

    def to_input_list(self) -> list[dict[str, Any]]:
        return []

    async def stream_events(self):
        for event in self.events:
            kind = event["kind"]
            if kind == "text":
                yield SimpleNamespace(
                    type="raw_response_event",
                    data=SimpleNamespace(type="response.output_text.delta", delta=event["text"]),
                )
            elif kind == "message":
                raw_item = SimpleNamespace(
                    content=[SimpleNamespace(text=event["text"])],
                )
                yield SimpleNamespace(
                    type="run_item_stream_event",
                    name="message_output_created",
                    item=SimpleNamespace(raw_item=raw_item),
                )
            elif kind == "tool":
                tool_name = event["name"]
                args = event.get("args") or {}
                call_id = event.get("call_id") or f"call_{tool_name}"
                raw_call = SimpleNamespace(
                    type="function_call",
                    name=tool_name,
                    arguments=json.dumps(args),
                    call_id=call_id,
                )
                yield SimpleNamespace(
                    type="run_item_stream_event",
                    name="tool_called",
                    item=SimpleNamespace(raw_item=raw_call, tool_origin=None),
                )
                tool = next(tool for tool in self.agent.tools if getattr(tool, "name", None) == tool_name)
                output = await tool.on_invoke_tool(None, json.dumps(args))
                yield SimpleNamespace(
                    type="run_item_stream_event",
                    name="tool_output",
                    item=SimpleNamespace(
                        raw_item=SimpleNamespace(type="function_call_output", call_id=call_id),
                        output=output,
                        tool_origin=None,
                    ),
                )
            elif kind == "raise":
                raise event["error"]


class ScriptedAgentDriverMixin:
    def set_scripts(self, scripts: list[list[dict[str, Any]]], *, tokens: list[int] | None = None) -> None:
        self.scripts = list(scripts)
        self.tokens = list(tokens or [0 for _ in scripts])
        self.calls = []

    async def _run_streamed(self, agent: Any, run_input: Any, max_turns: int, run_config: Any) -> FakeStreamingResult:
        self.calls.append(
            {
                "agent": agent,
                "run_input": run_input,
                "max_turns": max_turns,
                "run_config": run_config,
            }
        )
        if not self.scripts:
            raise AssertionError("Unexpected SDK run")
        events = self.scripts.pop(0)
        tokens = self.tokens.pop(0) if self.tokens else 0
        return FakeStreamingResult(agent, events, tokens=tokens)
