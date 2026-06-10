"""Emily environment-awareness: the engine persona stays identical for every
source, but a SHORT per-call environment note is injected so the assistant knows
whether it is reached via Slack, MCP, or the web assistant.

These tests assert:
  - the env note differs by source (slack vs mcp vs web),
  - the shared persona base is still present in all three,
  - unknown / unset source falls back to web,
  - the note is short.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import chat_service  # noqa: E402


PERSONA_MARKER = "SWARM-OF-WORKERS-PERSONA-MARKER"


@pytest.fixture
def fake_persona(monkeypatch):
    """Stand in for the shared persona base so the test does not depend on disk
    content. Same value for every source by construction."""

    def _fake_build(user_id: str, *, include_authoring_rules: bool = False) -> str:
        return f"# Workspace\n\n{PERSONA_MARKER}\nWarm, proactive, no em dashes."

    monkeypatch.setattr(chat_service, "_build_system_prompt", _fake_build)
    return PERSONA_MARKER


class TestEnvironmentNote:
    def test_each_source_has_a_distinct_note(self):
        slack = chat_service._environment_note("slack")
        mcp = chat_service._environment_note("mcp")
        web = chat_service._environment_note("web")
        assert slack != mcp != web
        assert slack != web
        assert "Slack" in slack
        assert "MCP" in mcp or "another AI agent" in mcp
        assert "web assistant" in web

    def test_unknown_source_falls_back_to_web(self):
        assert chat_service._environment_note("carrier-pigeon") == \
            chat_service._environment_note("web")

    def test_notes_are_short(self):
        # A few lines each; guard against personality creeping in here.
        for source in ("slack", "mcp", "web"):
            note = chat_service._environment_note(source)
            assert note.count("\n") <= 4, f"{source} note grew too long"


class TestBuildSystemPromptForSource:
    def test_persona_present_for_all_sources(self, fake_persona):
        for source in ("slack", "mcp", "web"):
            prompt = chat_service.build_system_prompt_for_source("u1", source)
            assert fake_persona in prompt, f"persona missing for source={source}"

    def test_env_note_differs_by_source(self, fake_persona):
        slack = chat_service.build_system_prompt_for_source("u1", "slack")
        mcp = chat_service.build_system_prompt_for_source("u1", "mcp")
        web = chat_service.build_system_prompt_for_source("u1", "web")

        # Same persona base in all three.
        assert fake_persona in slack and fake_persona in mcp and fake_persona in web

        # But the appended environment note is different.
        assert slack != mcp
        assert slack != web
        assert mcp != web
        assert "Slack" in slack and "Slack" not in mcp and "Slack" not in web
        assert ("MCP" in mcp or "another AI agent" in mcp) and "another AI agent" not in slack

    def test_default_source_is_web(self, fake_persona):
        default = chat_service.build_system_prompt_for_source("u1")
        web = chat_service.build_system_prompt_for_source("u1", "web")
        assert default == web
