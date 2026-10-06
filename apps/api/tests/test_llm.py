"""Unit tests for the provider-agnostic LLM seam (apps/api/llm.py).

Covers model-id routing (OpenAI vs litellm providers), Agents-SDK model
normalization, Anthropic/Bedrock prompt-cache tagging, credential detection, and
the platform-key bridge, all without any network calls.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import llm  # noqa: E402


@pytest.mark.parametrize(
    "error",
    (
        "429 exceeded your current quota",
        "AuthenticationError: invalid API key",
        "ResourceExhaustedError: RESOURCE_EXHAUSTED",
        "PermissionDeniedError: 403 forbidden",
        "ExpiredTokenException: security token expired",
        "NoCredentialsError: unable to locate credentials",
    ),
)
def test_chat_model_fallback_retryable_provider_errors(error):
    assert llm.should_retry_chat_with_fallback(RuntimeError(error))


def test_chat_model_fallback_does_not_retry_application_errors():
    assert not llm.should_retry_chat_with_fallback(RuntimeError("invalid response format"))


@pytest.mark.parametrize(
    "error",
    (
        "litellm.InternalServerError: VertexAIException - 503 The model is overloaded",
        "litellm.ServiceUnavailableError: BedrockException - Service Unavailable",
        "BedrockException - Model has insufficient capacity, please retry",
        "AnthropicException - 529 overloaded_error",
        "OpenAIException - The engine is currently overloaded",
    ),
)
def test_chat_model_fallback_retries_server_side_capacity(error):
    """#2340: overload is as safe to retry on another model/key as a quota error."""
    assert llm.should_retry_chat_with_fallback(RuntimeError(error))


def test_is_litellm_model():
    assert llm.is_litellm_model("gpt-5.5") is False
    assert llm.is_litellm_model("gpt-5.4-mini") is False
    assert llm.is_litellm_model("openai/gpt-5.5") is False
    assert llm.is_litellm_model("bedrock/us.anthropic.claude-sonnet-4-6") is True
    assert llm.is_litellm_model("anthropic/claude-sonnet-4-6") is True


@pytest.mark.parametrize(
    ("model", "provider"),
    [
        ("gpt-5.5", "openai"),
        ("openai/gpt-5.5", "openai"),
        ("litellm/gemini/gemini-3.5-flash", "gemini"),
        ("bedrock/us.anthropic.claude-sonnet-4-6", "bedrock"),
        ("vertex_ai/gemini-3.5-flash", "vertex_ai"),
    ],
)
def test_model_provider_name(model, provider):
    assert llm.model_provider_name(model) == provider


def test_agent_model_normalization():
    # Bare / openai-prefixed run on the native OpenAI provider unchanged.
    assert llm.agent_model("gpt-5.5") == "gpt-5.5"
    assert llm.agent_model("openai/gpt-5.5") == "openai/gpt-5.5"
    # Non-OpenAI providers are routed through the SDK's litellm provider.
    assert (
        llm.agent_model("bedrock/us.anthropic.claude-sonnet-4-6")
        == "litellm/bedrock/us.anthropic.claude-sonnet-4-6"
    )
    # Idempotent.
    assert llm.agent_model("litellm/bedrock/x") == "litellm/bedrock/x"


def test_with_prompt_cache_marks_system_for_anthropic():
    msgs = [{"role": "system", "content": "SYS"}, {"role": "user", "content": "hi"}]
    out = llm.with_prompt_cache(msgs, "bedrock/us.anthropic.claude-sonnet-4-6")
    assert out[0]["content"][0]["text"] == "SYS"
    assert out[0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert out[1] == {"role": "user", "content": "hi"}
    # Input is not mutated.
    assert msgs[0]["content"] == "SYS"


def test_with_prompt_cache_is_noop_for_openai():
    msgs = [{"role": "system", "content": "SYS"}]
    out = llm.with_prompt_cache(msgs, "gpt-5.5")
    assert out[0]["content"] == "SYS"


def test_provider_credentials_present(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("PLATFORM_OPENAI_API_KEY", raising=False)
    assert llm.provider_credentials_present("gpt-5.5") is False
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    assert llm.provider_credentials_present("gpt-5.5") is True

    for var in ("AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE"):
        monkeypatch.delenv(var, raising=False)
    for var in ("AWS_REGION_NAME", "AWS_REGION", "AWS_DEFAULT_REGION"):
        monkeypatch.delenv(var, raising=False)
    assert llm.provider_credentials_present("bedrock/us.anthropic.claude-sonnet-4-6") is False
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    assert llm.provider_credentials_present("bedrock/us.anthropic.claude-sonnet-4-6") is False
    monkeypatch.setenv("AWS_REGION_NAME", "us-east-1")
    assert llm.provider_credentials_present("bedrock/us.anthropic.claude-sonnet-4-6") is True
    monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("AWS_REGION_NAME", raising=False)
    monkeypatch.setenv("AWS_PROFILE", "bedrock-profile")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    assert llm.provider_credentials_present("bedrock/us.anthropic.claude-sonnet-4-6") is True

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY_FALLBACK", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY_FALLBACK", raising=False)
    assert llm.provider_credentials_present("gemini/gemini-3.5-flash") is False
    monkeypatch.setenv("GEMINI_API_KEY_FALLBACK", "fallback-gemini")
    assert llm.provider_credentials_present("gemini/gemini-3.5-flash") is True
    monkeypatch.delenv("GEMINI_API_KEY_FALLBACK", raising=False)
    assert llm.provider_credentials_present("vertex_ai/gemini-3.5-flash") is True


def test_completion_routes_to_litellm_and_caches_for_bedrock(monkeypatch):
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return "RESP"

    with patch("litellm.completion", side_effect=fake_completion):
        out = llm.completion(
            model="bedrock/us.anthropic.claude-sonnet-4-6",
            messages=[{"role": "system", "content": "S"}, {"role": "user", "content": "u"}],
            cache_prompt=True,
            max_tokens=10,
        )
    assert out == "RESP"
    assert captured["model"] == "bedrock/us.anthropic.claude-sonnet-4-6"
    # System turned into a cacheable block for Bedrock/Anthropic.
    assert captured["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    # Bedrock authenticates via AWS env creds, not an api_key.
    assert "api_key" not in captured


def test_completion_bridges_platform_key_for_openai(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("PLATFORM_OPENAI_API_KEY", "sk-platform")
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return "R"

    with patch("litellm.completion", side_effect=fake_completion):
        llm.completion(model="gpt-5.5", messages=[{"role": "user", "content": "u"}], max_tokens=5)
    # Reserved platform key name is bridged onto the standard key litellm reads.
    assert captured["api_key"] == "sk-platform"


def test_completion_retries_gemini_with_fallback_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "primary-gemini")
    monkeypatch.setenv("GEMINI_API_KEY_FALLBACK", "fallback-gemini")
    calls = []

    def fake_completion(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise RuntimeError("429 exceeded your current quota")
        return "R"

    with patch("litellm.completion", side_effect=fake_completion):
        out = llm.completion(
            model="gemini/gemini-3.5-flash",
            messages=[{"role": "user", "content": "u"}],
            max_tokens=5,
        )

    assert out == "R"
    assert [call["api_key"] for call in calls] == ["primary-gemini", "fallback-gemini"]


def test_completion_does_not_inject_gemini_key_for_vertex_gemini(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "primary-gemini")
    monkeypatch.setenv("GEMINI_API_KEY_FALLBACK", "fallback-gemini")
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return "R"

    with patch("litellm.completion", side_effect=fake_completion):
        out = llm.completion(
            model="vertex_ai/gemini-3.5-flash",
            messages=[{"role": "user", "content": "u"}],
            max_tokens=5,
        )

    assert out == "R"
    assert captured["model"] == "vertex_ai/gemini-3.5-flash"
    assert "api_key" not in captured


def test_completion_does_not_retry_gemini_non_key_error(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "primary-gemini")
    monkeypatch.setenv("GEMINI_API_KEY_FALLBACK", "fallback-gemini")

    with patch("litellm.completion", side_effect=RuntimeError("invalid response_format")) as mocked:
        try:
            llm.completion(
                model="gemini/gemini-3.5-flash",
                messages=[{"role": "user", "content": "u"}],
                max_tokens=5,
            )
        except RuntimeError:
            pass

    assert mocked.call_count == 1


def test_cache_control_extra_args():
    # Anthropic/Bedrock: inject a system-message cache breakpoint for litellm so the
    # static system prompt is cached across agent-loop turns.
    args = llm.cache_control_extra_args("litellm/bedrock/us.anthropic.claude-sonnet-4-6")
    assert args == {"cache_control_injection_points": [{"location": "message", "role": "system"}]}
    # OpenAI caches prefixes automatically -> no extra args.
    assert llm.cache_control_extra_args("gpt-5.5") is None
    assert llm.cache_control_extra_args("gpt-5.4-mini") is None


def test_safe_error_message_for_exhausted_chat_fallback():
    assert llm.safe_llm_error_message(
        RuntimeError("chat model fallback exhausted"), action="Chat"
    ) == ("Chat hit a temporary capacity issue after retrying another provider. Please try again.")
