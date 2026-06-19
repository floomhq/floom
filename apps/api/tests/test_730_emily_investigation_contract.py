"""#730 — Emily must investigate fully before replying; no partial status dumps.

Root causes fixed at the prompt layer:
  1. EMILY_BASE_PERSONA had a finish contract but no investigation contract, so
     on "find X" requests the model shipped partial status and asked the user
     to say "keep going" on read-only investigation.
  2. finish_with_outputs described itself as "call when you have the final
     reply ready", which legitimized finishing with a partial inventory.

These tests pin the investigation contract into the persona (all surfaces,
WhatsApp included — the reproduction channel) and the finish tool description.

Run: cd apps/api && python -m pytest tests/test_730_emily_investigation_contract.py -q
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import chat_service


class TestInvestigationContractInPersona:
    def test_persona_has_investigation_rule(self):
        persona = chat_service.EMILY_BASE_PERSONA.lower()
        assert "investigate fully" in persona, (
            "EMILY_BASE_PERSONA must contain the 'Investigate fully, reply once' rule"
        )

    def test_persona_forbids_keep_going_asks(self):
        persona = chat_service.EMILY_BASE_PERSONA.lower()
        assert "keep going" in persona and "never ask" in persona, (
            "persona must explicitly forbid asking the user to say 'keep going' "
            "on read-only investigation"
        )

    def test_persona_forbids_partial_status(self):
        persona = chat_service.EMILY_BASE_PERSONA.lower()
        assert "partial status" in persona, (
            "persona must forbid partial status replies on investigation tasks"
        )

    def test_persona_instructs_metachar_fallback(self):
        # Reproduction: Emily reported blocked pipes on readonly SSH as a finding
        # instead of retrying with allowed plain commands.
        persona = chat_service.EMILY_BASE_PERSONA.lower()
        assert "metacharacter" in persona or "no pipes" in persona, (
            "persona must tell Emily to fall back to allowed command patterns "
            "when shell metacharacters are blocked"
        )

    def test_blocked_reply_contract_names_exact_unblock(self):
        persona = chat_service.EMILY_BASE_PERSONA.lower()
        assert "unblock" in persona or "exact fix" in persona, (
            "persona must require naming the exact unblock when blocked"
        )


class TestContractReachesWhatsApp:
    def test_whatsapp_system_prompt_contains_investigation_rule(self, monkeypatch):
        monkeypatch.setattr(chat_service, "get_workspace_md", lambda: "")
        monkeypatch.setattr(
            chat_service, "_build_workspace_preamble", lambda uid: "## Workspace snapshot\n(none)"
        )
        monkeypatch.setattr(
            chat_service,
            "_build_capabilities_snapshot",
            lambda uid: "## What you can do here (capabilities snapshot)\n- Workers: 0",
        )
        prompt = chat_service.build_system_prompt_for_source("local-user", source="whatsapp")
        assert "Investigate fully, reply once" in prompt
        assert "## Current environment: WhatsApp" in prompt


class TestFinishToolDescription:
    def _finish_description(self) -> str:
        src = Path(chat_service.__file__).read_text(encoding="utf-8")
        match = re.search(
            r'name="finish_with_outputs",\s*description=\((.*?)\),\s*params_json_schema',
            src,
            flags=re.DOTALL,
        )
        assert match, "finish_with_outputs FunctionTool definition not found"
        return match.group(1)

    def test_finish_tool_requires_complete_investigation(self):
        desc = self._finish_description().lower()
        assert "only when" in desc and "complete" in desc

    def test_finish_tool_forbids_partial_status(self):
        desc = self._finish_description().lower()
        assert "partial status" in desc and "keep going" in desc
