from __future__ import annotations

import sys
from pathlib import Path

import pytest
from agents import Agent, ModelSettings, RunConfig, Runner

API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))
from runner_sandbox.loop_local_provider import _FallbackModel  # noqa: E402


class _FakeModel:
    def __init__(self, *, response=None, response_error=None, stream=()):
        self.response, self.response_error, self.stream = response, response_error, list(stream)
        self.response_calls = self.stream_calls = 0
        self.last_model_settings = None

    def get_retry_advice(self, _request):
        return None

    async def get_response(self, *args, **_kwargs):
        self.response_calls += 1
        self.last_model_settings = args[2]
        if self.response_error:
            raise self.response_error
        return self.response

    async def stream_response(self, *args, **_kwargs):
        self.stream_calls += 1
        self.last_model_settings = args[2]
        for item in self.stream:
            if isinstance(item, BaseException):
                raise item
            yield item


def _model(primary, fallback, *, fallback_extra_args=None):
    return _FallbackModel(
        primary=primary,
        fallback_factory=lambda: fallback,
        primary_name="gemini/test",
        fallback_name="bedrock/test",
        should_fallback=lambda exc: "429" in str(exc) or "authentication" in str(exc).lower(),
        fallback_extra_args=fallback_extra_args,
    )


ARGS = (None, [], None, [], None, [], None)
KWARGS = {"previous_response_id": None, "conversation_id": None, "prompt": None}


@pytest.mark.asyncio
async def test_non_streaming_fallback_is_sticky_and_uses_its_settings():
    primary = _FakeModel(response_error=RuntimeError("429 quota"))
    fallback = _FakeModel(response="fallback")
    model = _model(primary, fallback, fallback_extra_args={"fallback_only": True})
    args = (None, [], ModelSettings(extra_args={"primary_only": True}), [], None, [], None)
    for _ in range(2):
        assert await model.get_response(*args, **KWARGS) == "fallback"
    assert primary.response_calls == 1 and fallback.response_calls == 2
    assert fallback.last_model_settings.extra_args == {"fallback_only": True}


@pytest.mark.asyncio
async def test_successful_primary_does_not_resolve_fallback():
    resolutions = 0

    def resolve():
        nonlocal resolutions
        resolutions += 1
        return _FakeModel(response="fallback")

    model = _FallbackModel(
        primary=_FakeModel(response="primary"),
        fallback_factory=resolve,
        primary_name="primary",
        fallback_name="fallback",
        should_fallback=lambda _exc: True,
    )
    assert await model.get_response(*ARGS, **KWARGS) == "primary"
    assert resolutions == 0


@pytest.mark.asyncio
async def test_midstream_failure_discards_partial_primary_output():
    model = _model(
        _FakeModel(stream=["partial", RuntimeError("429 mid-stream")]),
        _FakeModel(stream=["fallback start", "fallback complete"]),
    )
    assert [event async for event in model.stream_response(*ARGS, **KWARGS)] == [
        "fallback start",
        "fallback complete",
    ]


@pytest.mark.asyncio
async def test_non_retryable_stream_error_does_not_call_fallback():
    fallback = _FakeModel(stream=["must not run"])
    model = _model(_FakeModel(stream=[RuntimeError("invalid response format")]), fallback)
    with pytest.raises(RuntimeError, match="invalid response format"):
        async for _ in model.stream_response(*ARGS, **KWARGS):
            pass
    assert fallback.stream_calls == 0


def _runner(model):
    class Provider:
        def get_model(self, _name):
            return model

    return Runner.run_streamed(
        Agent(name="Emily", instructions="test", model="primary"),
        input="hello",
        max_turns=1,
        run_config=RunConfig(model_provider=Provider(), tracing_disabled=True),
    )


@pytest.mark.asyncio
async def test_agents_runner_surfaces_safe_marker_when_both_streams_fail():
    result = _runner(
        _model(
            _FakeModel(stream=[RuntimeError("429 primary")]),
            _FakeModel(stream=[RuntimeError("authentication fallback")]),
        )
    )
    with pytest.raises(RuntimeError, match="chat model fallback exhausted"):
        async for _ in result.stream_events():
            pass


@pytest.mark.asyncio
async def test_fallback_construction_failure_resolves_once_and_keeps_safe_marker():
    resolutions = 0

    def broken():
        nonlocal resolutions
        resolutions += 1
        raise RuntimeError("credential construction detail")

    model = _FallbackModel(
        primary=_FakeModel(stream=[RuntimeError("429 primary")]),
        fallback_factory=broken,
        primary_name="primary",
        fallback_name="fallback",
        should_fallback=lambda exc: "429" in str(exc),
    )
    with pytest.raises(RuntimeError, match="chat model fallback exhausted"):
        async for _ in _runner(model).stream_events():
            pass
    assert resolutions == 1
