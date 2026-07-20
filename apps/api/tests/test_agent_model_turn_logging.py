from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from agents import function_tool
from agents.items import ModelResponse, TResponseStreamEvent
from agents.models.interface import Model
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseUsage,
)
from openai.types.responses.response_usage import InputTokensDetails, OutputTokensDetails

from models import WorkerConfig, WorkerRuntime, WorkerTrigger
from runner_sandbox import agent_driver
from runner_sandbox.agent_driver import AgentDriver


@function_tool(name_override="continue_turn")
async def _continue_turn() -> str:
    """Return a tool result that makes the SDK start another model turn."""

    return "continue"


class _ThreeTurnModel(Model):
    def __init__(self) -> None:
        self.turn = 0

    async def get_response(self, *_args: Any, **_kwargs: Any) -> ModelResponse:
        raise AssertionError("The streamed runner must use stream_response")

    async def stream_response(
        self,
        *_args: Any,
        **_kwargs: Any,
    ) -> AsyncIterator[TResponseStreamEvent]:
        self.turn += 1
        if self.turn <= 2:
            output = [
                ResponseFunctionToolCall(
                    arguments="{}",
                    call_id=f"call_{self.turn}",
                    name="continue_turn",
                    status="completed",
                    type="function_call",
                )
            ]
        else:
            output = [
                ResponseOutputMessage(
                    id="message_3",
                    content=[
                        ResponseOutputText(
                            annotations=[],
                            text="done",
                            type="output_text",
                        )
                    ],
                    role="assistant",
                    status="completed",
                    type="message",
                )
            ]

        usage = ResponseUsage(
            input_tokens=self.turn * 10,
            input_tokens_details=InputTokensDetails(cached_tokens=0),
            output_tokens=self.turn * 5,
            output_tokens_details=OutputTokensDetails(reasoning_tokens=0),
            total_tokens=self.turn * 15,
        )
        response = Response(
            id=f"response_{self.turn}",
            created_at=0.0,
            model="three-turn-model",
            object="response",
            output=output,
            parallel_tool_calls=False,
            tool_choice="auto",
            tools=[],
            usage=usage,
        )
        yield ResponseCompletedEvent(
            response=response,
            sequence_number=0,
            type="response.completed",
        )


def _run_three_turn_worker(monkeypatch, tmp_path, log_fn):
    workers_dir = tmp_path / "workers"
    bundle_dir = workers_dir / "model-turn-worker"
    bundle_dir.mkdir(parents=True)
    (bundle_dir / "SKILL.md").write_text("You are a test worker.", encoding="utf-8")
    monkeypatch.setattr(agent_driver, "WORKERS_DIR", workers_dir)
    monkeypatch.setattr(agent_driver, "ARTIFACTS_DIR", tmp_path / "artifacts")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("AWS_REGION_NAME", "us-east-1")

    config = WorkerConfig(
        id="model-turn-worker",
        name="Model Turn Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="python311",
            entrypoint="SKILL.md",
            runner="e2b",
            mode="agent",
            model="bedrock/us.anthropic.claude-sonnet-4-6",
        ),
    )
    model = _ThreeTurnModel()
    driver = AgentDriver()

    async def _no_mcp(*_args, **_kwargs):
        return []

    monkeypatch.setattr(agent_driver._llm, "agent_model", lambda _model: model)
    monkeypatch.setattr(agent_driver._llm, "cache_control_extra_args", lambda _model: None)
    monkeypatch.setattr(driver, "_connect_mcp_servers", _no_mcp)
    monkeypatch.setattr(driver, "_sdk_tools", lambda *_args, **_kwargs: [_continue_turn])
    monkeypatch.setattr(driver, "_cancel_requested", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(driver, "_emit_part", lambda *_args, **_kwargs: None)

    result = asyncio.run(
        driver._run_agent_inner(
            worker_id="model-turn-worker",
            run_id="run-model-turns",
            inputs={},
            secrets={},
            log_fn=log_fn,
            trace_id="trace-model-turns",
            timeout_seconds=30,
            config=config,
            connection_ids={},
            user_id="user-model-turns",
        )
    )
    return result, model


def test_three_sdk_model_turns_emit_ordered_start_logs(monkeypatch, tmp_path):
    logs: list[tuple[str, str]] = []

    result, model = _run_three_turn_worker(
        monkeypatch,
        tmp_path,
        lambda message, level="info": logs.append((message, level)),
    )

    assert result.status == "success"
    assert model.turn == 3
    assert [message for message, _level in logs if message.endswith(" started")] == [
        "Model call 1 started",
        "Model call 2 started",
        "Model call 3 started",
    ]
    finished = [message for message, _level in logs if " finished (" in message]
    assert len(finished) == 3
    assert finished[0].endswith(", 15 tokens)")
    assert finished[1].endswith(", 30 tokens)")
    assert finished[2].endswith(", 45 tokens)")
    lifecycle_logs = [
        message
        for message, _level in logs
        if message.startswith(("Model call ", "Tool call:", "Tool finished:"))
    ]
    assert lifecycle_logs == [
        "Model call 1 started",
        finished[0],
        "Tool call: continue_turn",
        "Tool finished: continue_turn",
        "Model call 2 started",
        finished[1],
        "Tool call: continue_turn",
        "Tool finished: continue_turn",
        "Model call 3 started",
        finished[2],
    ]


def test_model_turn_log_failure_does_not_fail_run(monkeypatch, tmp_path):
    attempted_model_logs: list[str] = []

    def _failing_model_log(message: str, level: str = "info") -> None:
        if message.startswith("Model call "):
            attempted_model_logs.append(message)
            raise RuntimeError("run log storage unavailable")

    result, model = _run_three_turn_worker(monkeypatch, tmp_path, _failing_model_log)

    assert result.status == "success"
    assert model.turn == 3
    assert len(attempted_model_logs) == 6
