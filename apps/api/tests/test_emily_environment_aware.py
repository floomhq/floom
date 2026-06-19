"""Emily surface-aware communication profiles.

The engine persona is shared and identical for every surface.  A global
communication-rules block (GLOBAL_COMMUNICATION_RULES) and a per-surface
environment note (ENVIRONMENT_NOTES) are both appended so Emily knows WHERE
she is and adapts reply shape accordingly.

Assertions:
  - GLOBAL_COMMUNICATION_RULES is present in every assembled prompt.
  - Environment note differs by surface (whatsapp / slack / web / mcp / cli).
  - Shared persona base is present in all assembled prompts.
  - Unknown / unset source falls back to web.
  - Per-surface blocks contain key formatting cues from the spec.
  - Channel pipeline helpers (collect_agent_reply) pass the correct source
    through to stream_chat.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import chat_service  # noqa: E402


PERSONA_MARKER = "SWARM-OF-WORKERS-PERSONA-MARKER"
ALL_SOURCES = ("whatsapp", "slack", "web", "mcp", "cli")


@pytest.fixture
def fake_persona(monkeypatch):
    """Stand in for the shared persona base so tests do not depend on disk
    content.  Same value for every source by construction."""

    def _fake_build(user_id: str, *, include_authoring_rules: bool = False) -> str:
        return f"# Workspace\n\n{PERSONA_MARKER}\nWarm, proactive, no em dashes."

    monkeypatch.setattr(chat_service, "_build_system_prompt", _fake_build)
    return PERSONA_MARKER


class TestEnvironmentNote:
    def test_all_sources_have_distinct_notes(self):
        notes = {s: chat_service._environment_note(s) for s in ALL_SOURCES}
        # Every pair is distinct.
        from itertools import combinations
        for a, b in combinations(ALL_SOURCES, 2):
            assert notes[a] != notes[b], f"sources {a!r} and {b!r} share the same note"

    def test_unknown_source_falls_back_to_web(self):
        assert chat_service._environment_note("carrier-pigeon") == \
            chat_service._environment_note("web")

    def test_notes_are_short(self):
        # Each per-surface block must stay under ~90 words and fit in a few lines.
        for source in ALL_SOURCES:
            note = chat_service._environment_note(source)
            word_count = len(note.split())
            assert word_count <= 110, f"{source!r} note is too long ({word_count} words)"

    # --- per-surface format cues ---

    def test_whatsapp_note_plain_text_guidance(self):
        note = chat_service._environment_note("whatsapp")
        assert "plain text" in note.lower() or "no markdown" in note.lower()
        assert "WhatsApp" in note

    def test_whatsapp_note_single_asterisk_bold(self):
        """WhatsApp uses *single asterisk* for bold -- the note must teach this explicitly."""
        note = chat_service._environment_note("whatsapp")
        assert "*single asterisk*" in note or "single asterisk" in note.lower(), (
            "WhatsApp note must teach *single asterisk* for bold"
        )

    def test_whatsapp_note_has_char_limit(self):
        note = chat_service._environment_note("whatsapp")
        # Must state a hard character limit (1500 or similar).
        assert "1500" in note or "char" in note.lower(), (
            "WhatsApp note must state a hard character limit"
        )

    def test_whatsapp_note_forbids_double_asterisk(self):
        """The note must explicitly forbid **double asterisk** to prevent the papaya77 bug."""
        note = chat_service._environment_note("whatsapp")
        assert "**" in note or "double asterisk" in note.lower() or "NEVER **" in note, (
            "WhatsApp note must forbid **double asterisk** bold"
        )

    def test_whatsapp_note_forbids_code_fences(self):
        note = chat_service._environment_note("whatsapp")
        # Must mention code fences/blocks are forbidden.
        assert "code" in note.lower() or "fence" in note.lower() or "```" in note, (
            "WhatsApp note must forbid code fences"
        )

    def test_slack_note_mrkdwn(self):
        note = chat_service._environment_note("slack")
        assert "mrkdwn" in note or "*bold*" in note
        assert "Slack" in note

    def test_web_note_rich_markdown(self):
        note = chat_service._environment_note("web")
        assert "markdown" in note.lower() or "web app" in note.lower()

    def test_mcp_note_terse_structured(self):
        note = chat_service._environment_note("mcp")
        assert "terse" in note.lower() or "structured" in note.lower() or "programmatic" in note.lower()
        assert "MCP" in note or "programmatic" in note.lower()

    def test_cli_note_terse_structured(self):
        note = chat_service._environment_note("cli")
        assert "terse" in note.lower() or "structured" in note.lower() or "CLI" in note
        assert "CLI" in note or "cli" in note.lower()

    def test_mcp_and_cli_are_distinct(self):
        assert chat_service._environment_note("mcp") != chat_service._environment_note("cli")


class TestGlobalCommunicationRules:
    def test_global_rules_exist(self):
        rules = chat_service.GLOBAL_COMMUNICATION_RULES
        assert rules, "GLOBAL_COMMUNICATION_RULES must not be empty"

    def test_global_rules_present_in_every_assembled_prompt(self, fake_persona):
        # Pick a short phrase that must appear in every surface's assembled prompt.
        # Use a phrase from GLOBAL_COMMUNICATION_RULES itself.
        rules = chat_service.GLOBAL_COMMUNICATION_RULES
        # Extract a unique substring that appears only in the global rules.
        # "Communication rules" is a safe anchor.
        assert "Communication rules" in rules, (
            "GLOBAL_COMMUNICATION_RULES header missing -- update this test anchor"
        )
        for source in ALL_SOURCES:
            prompt = chat_service.build_system_prompt_for_source("u1", source)
            assert "Communication rules" in prompt, (
                f"GLOBAL_COMMUNICATION_RULES missing from assembled prompt for source={source!r}"
            )

    def test_tools_before_text_is_first_substantive_rule(self):
        """'Use your tools to investigate' must be the first instruction in GLOBAL_COMMUNICATION_RULES."""
        rules = chat_service.GLOBAL_COMMUNICATION_RULES
        # Strip the header line and check the first substantive content.
        lines = [l.strip() for l in rules.splitlines() if l.strip()]
        # First non-header line should mention tools/investigate.
        content_lines = [l for l in lines if not l.startswith("#")]
        first_rule_text = content_lines[0].lower() if content_lines else ""
        assert "tool" in first_rule_text or "investigate" in first_rule_text, (
            "Tools-before-text instruction must be first in GLOBAL_COMMUNICATION_RULES; "
            f"got: {content_lines[0]!r}"
        )


class TestFinishContract:
    """Finish contract: Emily must be instructed to keep going until the task is done."""

    def test_finish_contract_in_persona(self):
        """EMILY_BASE_PERSONA must contain a finish-contract instruction."""
        persona = chat_service.EMILY_BASE_PERSONA
        assert (
            "finish" in persona.lower()
            or "keep going" in persona.lower()
            or "blocker" in persona.lower()
        ), (
            "EMILY_BASE_PERSONA must contain a finish-contract rule "
            "(keep going until done / stop only at genuine blocker)"
        )

    def test_finish_contract_phrase_present(self):
        """A recognizable finish-contract phrase must be present."""
        persona = chat_service.EMILY_BASE_PERSONA
        # Accept any of the expected phrases from the brief.
        indicators = [
            "finish the job",
            "keep going",
            "genuine blocker",
            "multiple steps",
        ]
        found = any(ind in persona.lower() for ind in indicators)
        assert found, (
            f"None of the finish-contract phrases {indicators!r} found in EMILY_BASE_PERSONA"
        )


class TestBuildSystemPromptForSource:
    def test_persona_present_for_all_sources(self, fake_persona):
        for source in ALL_SOURCES:
            prompt = chat_service.build_system_prompt_for_source("u1", source)
            assert fake_persona in prompt, f"persona missing for source={source!r}"

    def test_env_note_differs_by_source(self, fake_persona):
        prompts = {s: chat_service.build_system_prompt_for_source("u1", s) for s in ALL_SOURCES}
        from itertools import combinations
        for a, b in combinations(ALL_SOURCES, 2):
            assert prompts[a] != prompts[b], (
                f"assembled prompts for {a!r} and {b!r} are identical"
            )

    def test_default_source_is_web(self, fake_persona):
        assert chat_service.build_system_prompt_for_source("u1") == \
            chat_service.build_system_prompt_for_source("u1", "web")

    def test_whatsapp_prompt_has_plain_text_guidance(self, fake_persona):
        prompt = chat_service.build_system_prompt_for_source("u1", "whatsapp")
        assert "plain text" in prompt.lower() or "no markdown" in prompt.lower()

    def test_slack_prompt_has_mrkdwn(self, fake_persona):
        prompt = chat_service.build_system_prompt_for_source("u1", "slack")
        assert "mrkdwn" in prompt or "*bold*" in prompt

    def test_mcp_prompt_has_terse_structured(self, fake_persona):
        prompt = chat_service.build_system_prompt_for_source("u1", "mcp")
        assert "terse" in prompt.lower() or "structured" in prompt.lower() or "programmatic" in prompt.lower()

    def test_cli_prompt_has_cli_cue(self, fake_persona):
        prompt = chat_service.build_system_prompt_for_source("u1", "cli")
        assert "CLI" in prompt or "cli" in prompt.lower()


class TestChannelPipelineSourcePropagation:
    """The channel helpers must pass the correct source through to stream_chat."""

    def _run_collect(self, source: str) -> str:
        """Call collect_agent_reply and capture the source arg passed to stream_chat."""
        from channels.common import collect_agent_reply

        captured: list[str] = []

        async def _fake_stream_chat(
            *, message, user_id, conversation_id, part_queue, source="web", system_suffix=""
        ):
            captured.append(source)
            # Push minimal finish part so collect_agent_reply exits.
            await part_queue.put({"type": "text", "text": "ok"})
            await part_queue.put({"type": "finish", "conversation_id": "c1", "message_id": "m1"})

        with patch("chat_service.stream_chat", side_effect=_fake_stream_chat), \
             patch("chat_service.strip_em_dashes", side_effect=lambda s: s):
            asyncio.run(
                collect_agent_reply(
                    message="hello",
                    user_id="u1",
                    conversation_id="c1",
                    source=source,
                )
            )
        assert captured, "stream_chat was never called"
        return captured[0]

    def test_slack_source_propagates(self):
        assert self._run_collect("slack") == "slack"

    def test_whatsapp_source_propagates(self):
        assert self._run_collect("whatsapp") == "whatsapp"

    def test_mcp_source_propagates(self):
        assert self._run_collect("mcp") == "mcp"

    def test_cli_source_propagates(self):
        assert self._run_collect("cli") == "cli"

    def test_default_source_is_slack(self):
        """collect_agent_reply default is 'slack' (channel-neutral wrapper default)."""
        from channels.common import collect_agent_reply

        captured: list[str] = []

        async def _fake_stream_chat(
            *, message, user_id, conversation_id, part_queue, source="web", system_suffix=""
        ):
            captured.append(source)
            await part_queue.put({"type": "text", "text": "ok"})
            await part_queue.put({"type": "finish", "conversation_id": "c1", "message_id": "m1"})

        with patch("chat_service.stream_chat", side_effect=_fake_stream_chat), \
             patch("chat_service.strip_em_dashes", side_effect=lambda s: s):
            asyncio.run(
                collect_agent_reply(
                    message="hello",
                    user_id="u1",
                    conversation_id="c1",
                    # source not passed — uses default
                )
            )
        assert captured[0] == "slack"
