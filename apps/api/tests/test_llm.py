"""Unit tests for the provider-agnostic LLM seam (apps/api/llm.py).

Covers model-id routing (OpenAI vs litellm providers), Agents-SDK model
normalization, Anthropic/Bedrock prompt-cache tagging, credential detection, and
the platform-key bridge, all without any network calls.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import llm  # noqa: E402


def test_is_litellm_model():
    assert llm.is_litellm_model("gpt-5.5") is False
    assert llm.is_litellm_model("gpt-5.4-mini") is False
    assert llm.is_litellm_model("openai/gpt-5.5") is False
    assert llm.is_litellm_model("bedrock/us.anthropic.claude-sonnet-4-6") is True
    assert llm.is_litellm_model("anthropic/claude-sonnet-4-6") is True


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
    assert llm.provider_credentials_present("bedrock/us.anthropic.claude-sonnet-4-6") is False
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    assert llm.provider_credentials_present("bedrock/us.anthropic.claude-sonnet-4-6") is True


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


def test_cache_control_extra_args():
    # Anthropic/Bedrock: inject a system-message cache breakpoint for litellm so the
    # static system prompt is cached across agent-loop turns.
    args = llm.cache_control_extra_args("litellm/bedrock/us.anthropic.claude-sonnet-4-6")
    assert args == {
        "cache_control_injection_points": [{"location": "message", "role": "system"}]
    }
    # OpenAI caches prefixes automatically -> no extra args.
    assert llm.cache_control_extra_args("gpt-5.5") is None
    assert llm.cache_control_extra_args("gpt-5.4-mini") is None
