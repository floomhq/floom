from __future__ import annotations

import asyncio
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerConfig, WorkerLimits, WorkerRuntime, WorkerTrigger  # noqa: E402
from runner_sandbox.agent_driver import (  # noqa: E402
    AgentDriver,
    _classify_llm_provider_error,
    _llm_error_message,
    _resolve_agent_timeout_seconds,
    _resolve_max_tool_iterations,
    _resolve_max_total_tokens,
)


def _config(*, trigger_type: str = "manual", limits: WorkerLimits | None = None) -> WorkerConfig:
    return WorkerConfig(
        id="issue-983-worker",
        name="Issue 983 Worker",
        trigger=WorkerTrigger(type=trigger_type, cron="*/15 * * * *" if trigger_type == "cron" else None),
        runtime=WorkerRuntime(
            type="python311",
            entrypoint="SKILL.md",
            runner="e2b",
            mode="agent",
            model="bedrock/us.anthropic.claude-sonnet-4-6",
            limits=limits or WorkerLimits(),
        ),
    )


def test_provider_errors_are_classified_and_redacted(monkeypatch):
    driver = AgentDriver()
    logs: list[tuple[str, str]] = []
    raw_error = (
        "openai.AuthenticationError: Error code: 401 - Incorrect API key provided: "
        "sk-thisisasecret123"
    )

    def _raise(coro):
        coro.close()
        raise RuntimeError(raw_error)

    monkeypatch.setattr(driver, "_run_coro_sync", _raise)

    result = driver.run(
        worker_id="issue-983-worker",
        run_id="run-983-auth",
        inputs={},
        secrets={"OPENAI_API_KEY": "sk-thisisasecret123"},
        log_fn=lambda msg, level="info": logs.append((msg, level)),
        trace_id="trace-983",
    )

    assert result.status == "error"
    assert result.error_code == "llm_auth_error"
    assert result.retryable is False
    assert "sk-thisisasecret123" not in "\n".join(msg for msg, _level in logs)
    assert "LLM provider error (llm_auth_error)" in logs[0][0]


def test_provider_rate_limit_quota_and_generic_provider_errors_have_distinct_codes(monkeypatch):
    driver = AgentDriver()
    cases = [
        ("litellm.RateLimitError: 429", "llm_rate_limited", True),
        (
            "google.api_core.exceptions.ResourceExhausted: 429 billing account has exceeded its monthly spending cap",
            "llm_provider_capacity",
            True,
        ),
        ("litellm.APIConnectionError: bedrock upstream connection failed", "llm_provider_error", True),
    ]

    for raw_error, expected_code, expected_retryable in cases:
        def _raise(coro, raw_error=raw_error):
            coro.close()
            raise RuntimeError(raw_error)

        monkeypatch.setattr(
            driver,
            "_run_coro_sync",
            _raise,
        )
        result = driver.run(
            worker_id="issue-983-worker",
            run_id=f"run-983-{expected_code}",
            inputs={},
            secrets={},
            log_fn=lambda *_args, **_kwargs: None,
            trace_id="trace-983",
        )
        assert result.error_code == expected_code
        assert result.retryable is expected_retryable


def test_llm_classifier_prefers_explicit_auth_over_quota_hint():
    assert (
        _classify_llm_provider_error(
            "openai.AuthenticationError: 401 incorrect API key; check quota dashboard if this persists"
        )
        == "llm_auth_error"
    )
    assert _classify_llm_provider_error("bedrock returned 403 quota exceeded") == "llm_provider_capacity"
    assert _classify_llm_provider_error("openai returned 429") == "llm_rate_limited"
    assert _classify_llm_provider_error("retry-after header present") == "llm_rate_limited"
    assert _classify_llm_provider_error("pydantic model validation failed") is None


def test_shared_provider_insufficient_quota_is_platform_capacity():
    raw = "RESOURCE_EXHAUSTED 429 insufficient_quota: billing account exceeded its monthly spending cap"

    assert _classify_llm_provider_error(raw) == "llm_provider_capacity"
    assert (
        _llm_error_message("llm_provider_capacity")
        == "Temporary model capacity issue on our side. Your worker will retry automatically."
    )


def test_per_user_provider_quota_keeps_user_budget_code():
    raw = "openai.RateLimitError: 429 insufficient_quota"

    assert _classify_llm_provider_error(raw, shared_credentials=False) == "llm_quota_exceeded"
    assert "your AI provider" in _llm_error_message("llm_quota_exceeded")


def test_agent_model_preflight_fails_missing_bedrock_env(monkeypatch):
    for key in (
        "AWS_ACCESS_KEY_ID",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_PROFILE",
        "AWS_REGION_NAME",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
    ):
        monkeypatch.delenv(key, raising=False)

    result = asyncio.run(
        AgentDriver()._run_agent_inner(
            worker_id="issue-983-worker",
            run_id="run-983-preflight",
            inputs={},
            secrets={},
            log_fn=lambda *_args, **_kwargs: None,
            trace_id="trace-983",
            timeout_seconds=30,
            config=_config(),
            connection_ids={},
            user_id="user-983",
        )
    )

    assert result.status == "error"
    assert result.error_code == "llm_model_not_configured"
    assert "platform AI model" in result.error


def test_scheduled_agent_caps_get_sane_floors_with_hard_ceilings(monkeypatch):
    scheduled = _config(
        trigger_type="cron",
        limits=WorkerLimits(
            max_tool_iterations=10,
            max_total_tokens=50_000,
            timeout_seconds=120,
        ),
    )
    manual = _config(
        trigger_type="manual",
        limits=WorkerLimits(
            max_tool_iterations=10,
            max_total_tokens=50_000,
            timeout_seconds=120,
        ),
    )

    assert _resolve_max_tool_iterations(scheduled.runtime.limits, scheduled) == 80
    assert _resolve_max_total_tokens(scheduled.runtime.limits, scheduled) == 1_000_000
    assert _resolve_agent_timeout_seconds(120, scheduled.runtime.limits, scheduled) == 1800

    assert _resolve_max_tool_iterations(manual.runtime.limits, manual) == 10
    assert _resolve_max_total_tokens(manual.runtime.limits, manual) == 50_000
    assert _resolve_agent_timeout_seconds(120, manual.runtime.limits, manual) == 120


def test_manual_agent_tool_iteration_cap_does_not_drop_existing_manifest_budget(monkeypatch):
    manual = _config(
        trigger_type="manual",
        limits=WorkerLimits(max_tool_iterations=500, max_total_tokens=50_000, timeout_seconds=120),
    )

    assert _resolve_max_tool_iterations(manual.runtime.limits, manual) == 500


# --- #2340: server-side capacity/overload must engage the fallback chain -------
#
# Before this, only quota/billing wording (_QUOTA_ERROR_RE) or a 429 produced a
# retryable capacity code. Genuine provider overload (Gemini 503 UNAVAILABLE,
# Bedrock "insufficient capacity", Anthropic 529, OpenAI 500 "overloaded")
# fell through to llm_provider_error, which is NOT in the cross-provider
# fallback set, so the run died terminally on a transient platform condition.


class _StubExc(Exception):
    """Mirrors production: our code re-raises provider text from a plain error.

    ``__module__`` is pinned to a neutral value so the assertions exercise the
    provider text itself, not this test file's name (the classifier folds the
    exception's module into the text it inspects).
    """

    __module__ = "builtins"

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


_CAPACITY_SHAPES = [
    (
        'litellm.InternalServerError: VertexAIException - {"error":{"code":503,'
        '"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}',
        503,
    ),
    ("litellm.ServiceUnavailableError: BedrockException - Service Unavailable", 503),
    (
        "litellm.InternalServerError: BedrockException - Model has insufficient "
        "capacity, please retry",
        None,
    ),
    (
        'litellm.InternalServerError: AnthropicException - {"type":"overloaded_error"}',
        529,
    ),
    (
        "litellm.InternalServerError: OpenAIException - The engine is currently "
        "overloaded, please try again later",
        500,
    ),
]


def test_provider_overload_is_capacity_not_generic_provider_error():
    for message, status in _CAPACITY_SHAPES:
        assert (
            _classify_llm_provider_error(_StubExc(message, status))
            == "llm_provider_capacity"
        ), message


def test_provider_overload_engages_cross_provider_fallback():
    from runner_sandbox.agent_driver import _should_retry_agent_with_fallback

    for message, status in _CAPACITY_SHAPES:
        assert _should_retry_agent_with_fallback(_StubExc(message, status)), message


def test_real_incident_billing_cap_still_classified_as_capacity():
    """Verbatim provider text from the Jul-2026 capacity incident run logs."""
    raw = (
        "litellm.MidStreamFallbackError: litellm.RateLimitError: litellm.RateLimitError: "
        'Vertex_ai_betaException - {"error": {"code": 429, "message": "Your billing '
        'account has exceeded its monthly spending cap."}}'
    )
    assert _classify_llm_provider_error(_StubExc(raw, 429)) == "llm_provider_capacity"


def test_overload_is_never_blamed_on_a_user_quota():
    """Overload is a provider condition, so user-supplied keys are not blamed."""
    exc = _StubExc("VertexAIException - 503 model is overloaded", 503)
    assert (
        _classify_llm_provider_error(exc, shared_credentials=False)
        == "llm_provider_capacity"
    )


def test_capacity_classification_does_not_swallow_other_failures():
    """Auth, config and rate-limit keep priority; worker-side 503s stay unclassified."""
    cases = [
        (
            _StubExc(
                "openai.AuthenticationError: Error code: 401 - Incorrect API key provided",
                401,
            ),
            "llm_auth_error",
        ),
        (
            _StubExc("litellm.BadRequestError: LLM Provider unknown model gpt-nope"),
            "llm_model_not_configured",
        ),
        (
            _StubExc(
                "litellm.RateLimitError: BedrockException - ThrottlingException: "
                "Too many requests",
                429,
            ),
            "llm_rate_limited",
        ),
        (
            _StubExc("litellm.APIError: OpenAIException - Internal server error"),
            "llm_provider_error",
        ),
        (_StubExc("ValueError: bad input row 7"), None),
    ]
    for exc, expected in cases:
        assert _classify_llm_provider_error(exc) == expected, str(exc)


class _WorkerToolExc(Exception):
    """A worker's own outbound HTTP failure, as raised by requests/httpx."""

    __module__ = "requests.exceptions"

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


def test_worker_side_503_is_not_reported_as_platform_capacity():
    """A third-party API 503 inside a worker must not trigger a platform retry.

    This is the blast radius that matters: misreading it as our capacity would
    put the run into the 30-minute capacity backoff and mask a worker-side bug.
    """
    exc = _WorkerToolExc(
        "HTTPError: 503 Server Error: Service Unavailable for url: "
        "https://news.example.com/api/latest",
        503,
    )
    assert _classify_llm_provider_error(exc) is None


def test_worker_error_merely_naming_a_provider_is_not_capacity():
    """Mentioning a provider in worker text is not proof our provider failed."""
    exc = _WorkerToolExc(
        "HTTPError: 503 Server Error for url: https://status.openai.com/health",
        503,
    )
    assert _classify_llm_provider_error(exc) != "llm_provider_capacity"


def _capacity_error() -> Exception:
    return _StubExc(
        'VertexAIException - {"code":503,"message":"The model is overloaded.",'
        '"status":"UNAVAILABLE"}',
        503,
    )


def test_fallback_model_restarts_stream_on_capacity_and_reports_served_model():
    """Capacity mid-stream restarts on the fallback model with no partial output."""
    from runner_sandbox.agent_driver import _should_retry_agent_with_fallback
    from runner_sandbox.loop_local_provider import _FallbackModel

    class _Primary:
        async def stream_response(self, *_args, **_kwargs):
            yield "primary-partial"
            raise _capacity_error()

    class _Fallback:
        async def stream_response(self, *_args, **_kwargs):
            yield "fallback-1"
            yield "fallback-2"

    switched: list[tuple[str, str]] = []
    model = _FallbackModel(
        primary=_Primary(),
        fallback_factory=_Fallback,
        primary_name="bedrock/claude",
        fallback_name="gemini/gemini-3.5-flash",
        should_fallback=_should_retry_agent_with_fallback,
        on_fallback=lambda p, f: switched.append((p, f)),
    )

    async def _drain():
        return [event async for event in model.stream_response()]

    events = asyncio.run(_drain())

    # The partial primary output is discarded, not leaked to the caller.
    assert events == ["fallback-1", "fallback-2"]
    assert switched == [("bedrock/claude", "gemini/gemini-3.5-flash")]
    assert model.served_model_name == "gemini/gemini-3.5-flash"


def test_fallback_model_does_not_switch_on_application_errors():
    from runner_sandbox.agent_driver import _should_retry_agent_with_fallback
    from runner_sandbox.loop_local_provider import _FallbackModel

    class _Primary:
        async def stream_response(self, *_args, **_kwargs):
            raise ValueError("worker produced malformed output")
            yield  # pragma: no cover

    def _fallback_factory():
        raise AssertionError("fallback must not be built for application errors")

    model = _FallbackModel(
        primary=_Primary(),
        fallback_factory=_fallback_factory,
        primary_name="bedrock/claude",
        fallback_name="gemini/gemini-3.5-flash",
        should_fallback=_should_retry_agent_with_fallback,
    )

    async def _drain():
        return [event async for event in model.stream_response()]

    try:
        asyncio.run(_drain())
    except ValueError:
        pass
    else:  # pragma: no cover
        raise AssertionError("application error must propagate")

    assert model.served_model_name == "bedrock/claude"
