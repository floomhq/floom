"""#711 — Emily prompt split: human persona vs worker-authoring rules.

Pins the acceptance criteria:
  - casual chat ("hi") gets NO worker-authoring constraints (neither the
    WORKER_AUTHORING_RULES block nor SKILL.md's worker.yml format section)
  - worker-creation intent gets the full authoring rules
  - the casual prompt stays within a token budget so authoring text cannot
    silently creep back into every conversation
  - bare-greeting contract is bounded (2-3 bullets + one ask, no snapshot dump)

Run: cd apps/api && python -m pytest tests/test_711_prompt_split.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import chat_service

# ~4 chars/token; budget asserts the ORDER OF MAGNITUDE, not an exact count.
# Casual prompt (persona + stripped SKILL.md + comms rules, snapshot stubbed)
# measured ~9.5k chars (~2.4k tokens) at fix time; 12k chars (~3k tokens) is
# the regression tripwire.
CASUAL_PROMPT_CHAR_BUDGET = 12_000


@pytest.fixture
def stubbed(monkeypatch):
    monkeypatch.setattr(chat_service, "get_workspace_md", lambda: "")
    monkeypatch.setattr(
        chat_service, "_build_workspace_preamble", lambda uid: "## Workspace snapshot\n(stub)"
    )
    monkeypatch.setattr(
        chat_service,
        "_build_capabilities_snapshot",
        lambda uid: "## What you can do here (capabilities snapshot)\n(stub)",
    )


def _casual(user="federico"):
    return chat_service.build_system_prompt_for_source(user, "web", message="hi")


def _authoring(user="federico"):
    return chat_service.build_system_prompt_for_source(
        user, "web", message="Create a worker that summarizes Gmail every morning"
    )


def test_bare_greeting_prompt_has_no_yaml_authoring_text(stubbed):
    casual = _casual()
    assert "## Worker authoring rules" not in casual
    assert "worker.yml format" not in casual
    assert "workers__create_from_prompt, NOT" not in casual


def test_authoring_intent_gets_full_rules(stubbed):
    authoring = _authoring()
    assert "## Worker authoring rules" in authoring
    assert "approvals" in authoring.lower()
    assert "exec.runner" in authoring or 'runner: "e2b"' in authoring


def test_casual_prompt_within_token_budget(stubbed):
    casual = _casual()
    assert len(casual) < CASUAL_PROMPT_CHAR_BUDGET, (
        f"casual system prompt grew to {len(casual)} chars "
        f"(budget {CASUAL_PROMPT_CHAR_BUDGET}); authoring text is leaking back "
        "into every conversation — keep it behind the intent gate (#711)"
    )


def test_split_is_material(stubbed):
    # the gate must remove a real amount of text, not be vestigial
    assert len(_authoring()) - len(_casual()) >= 2_000


def test_bare_greeting_contract_is_bounded():
    persona = chat_service.EMILY_BASE_PERSONA.lower()
    assert "2-3 bullets" in persona, "greeting contract must bound the reply shape"
    assert "snapshot" in persona, "greeting contract must forbid snapshot recitation"


def test_persona_itself_is_small():
    # the always-on identity stays well under the SKILL/tooling text
    assert len(chat_service.EMILY_BASE_PERSONA) < 6_000
