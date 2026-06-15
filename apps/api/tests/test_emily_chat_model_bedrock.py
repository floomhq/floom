"""Emily's chat model must inherit the worker-agent model when no chat-specific
override is set — so a single Bedrock config (WORKEROS_WORKER_AGENT_MODEL=
bedrock/us.anthropic.claude-sonnet-4-6) wires BOTH worker runs and Emily.

Before this fix, setting only the worker model left Emily on the OpenAI default
(gpt-5.4-mini) — dead/quota'd on a Bedrock-only deploy -> "Chat failed upstream".
"""
from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import chat_service
import llm

BEDROCK = "bedrock/us.anthropic.claude-sonnet-4-6"


def _clear(monkeypatch):
    monkeypatch.delenv("WORKEROS_CHAT_MODEL", raising=False)
    monkeypatch.delenv("WORKEROS_WORKER_AGENT_MODEL", raising=False)


def test_explicit_chat_override_wins(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("WORKEROS_CHAT_MODEL", BEDROCK)
    monkeypatch.setenv("WORKEROS_WORKER_AGENT_MODEL", "gpt-5.5")
    assert chat_service._default_chat_model() == BEDROCK


def test_emily_inherits_worker_model_when_no_chat_override(monkeypatch):
    # The real-world fix: only the worker model is set to Bedrock; Emily follows.
    _clear(monkeypatch)
    monkeypatch.setenv("WORKEROS_WORKER_AGENT_MODEL", BEDROCK)
    assert chat_service._default_chat_model() == BEDROCK


def test_oss_zero_config_fallback(monkeypatch):
    _clear(monkeypatch)
    assert chat_service._default_chat_model() == chat_service.DEFAULT_WORKSPACE_AGENT_MODEL


def test_bedrock_model_routes_through_litellm_for_the_agent_sdk():
    # The chat Agent uses llm.agent_model(...); Bedrock must be litellm-routed.
    assert llm.agent_model(BEDROCK) == f"litellm/{BEDROCK}"
    assert llm.is_litellm_model(BEDROCK) is True
