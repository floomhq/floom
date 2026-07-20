import os
import importlib
import pytest


def _mod():
    return importlib.import_module("runner_sandbox.agent_driver")


def test_force_override_wins_over_worker_pin(monkeypatch):
    m = _mod()
    monkeypatch.setenv("WORKEROS_FORCE_AGENT_MODEL", "bedrock/us.anthropic.claude-sonnet-4-6")

    class _RT: model = "gemini/gemini-3.5-flash"
    class _Cfg: runtime = _RT()
    assert m._resolve_agent_model(_Cfg()) == "bedrock/us.anthropic.claude-sonnet-4-6"


def test_no_override_preserves_worker_pin(monkeypatch):
    m = _mod()
    monkeypatch.delenv("WORKEROS_FORCE_AGENT_MODEL", raising=False)

    class _RT: model = "gemini/gemini-3.5-flash"
    class _Cfg: runtime = _RT()
    assert m._resolve_agent_model(_Cfg()) == "gemini/gemini-3.5-flash"


def test_fallback_model_env(monkeypatch):
    m = _mod()
    monkeypatch.setenv("WORKEROS_AGENT_FALLBACK_MODEL", "gemini/gemini-3.5-flash")
    assert m._agent_fallback_model("bedrock/us.anthropic.claude-sonnet-4-6") == "gemini/gemini-3.5-flash"
    # identical -> nothing to swap to
    assert m._agent_fallback_model("gemini/gemini-3.5-flash") is None
    monkeypatch.delenv("WORKEROS_AGENT_FALLBACK_MODEL", raising=False)
    assert m._agent_fallback_model("bedrock/x") is None
