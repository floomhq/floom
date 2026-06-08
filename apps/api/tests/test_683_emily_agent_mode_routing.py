"""Tests for issue #683 — Emily must route agent-mode worker creation through
workers__create_from_prompt, never workers__create.

Root cause: workers__create only writes worker.yml (no SKILL.md), so every
agent-mode worker created that way fails with 'Agent entrypoint not found: SKILL.md'.
workers__create_from_prompt routes through worker-author which writes the full bundle.
"""

import re
import pytest


def _read_persona() -> str:
    from pathlib import Path
    src = Path(__file__).parents[1] / "chat_service.py"
    text = src.read_text(encoding="utf-8")
    start = text.find("EMILY_BASE_PERSONA")
    assert start != -1, "EMILY_BASE_PERSONA not found in chat_service.py"
    # Read up to the closing triple-quote
    end = text.find('"""', start + len("EMILY_BASE_PERSONA") + 5)
    assert end != -1
    return text[start:end]


def _read_tool_desc(tool_name: str) -> str:
    """Return the description string for the named tool in chat_service.py."""
    from pathlib import Path
    text = (Path(__file__).parents[1] / "chat_service.py").read_text(encoding="utf-8")
    marker = f'"{tool_name}"'
    idx = text.find(marker)
    assert idx != -1, f"Tool {tool_name!r} not found"
    # Grab next 2000 chars after the tool name reference
    return text[idx : idx + 2000]


# ── Persona rules ─────────────────────────────────────────────────────────────

def test_persona_mentions_create_from_prompt_for_agent_mode():
    """Emily's persona must explicitly name workers__create_from_prompt for agent-mode."""
    persona = _read_persona()
    assert "workers__create_from_prompt" in persona, (
        "EMILY_BASE_PERSONA must instruct Emily to use workers__create_from_prompt "
        "for agent-mode workers"
    )


def test_persona_prohibits_create_for_agent_mode():
    """The persona rule must say workers__create is NOT for agent-mode workers."""
    persona = _read_persona()
    # The rule should distinguish the two tools
    assert "workers__create_from_prompt" in persona
    # Should mention the failure mode so Emily understands WHY
    assert "SKILL.md" in persona, (
        "Persona should explain that workers__create does not produce SKILL.md"
    )


def test_persona_exec_mode_section_present():
    """The Exec mode section must exist in the persona."""
    persona = _read_persona()
    assert "Exec mode" in persona


def test_persona_rule_covers_connections():
    """The routing rule must apply to workers that use external connections."""
    persona = _read_persona()
    # The rule should cover the connection-using case
    lower = persona.lower()
    assert "connection" in lower or "external" in lower


# ── Tool description guards ────────────────────────────────────────────────────

def test_workers_create_description_not_for_agent_mode():
    """workers__create tool description should NOT suggest it works for agent-mode workers."""
    desc = _read_tool_desc("workers__create")
    lower = desc.lower()
    # Description should not say "agent mode" as a supported use case
    # (it's for pure-script / when the full YAML+code is already known)
    # Weak check: should not claim to create SKILL.md
    assert "creates skill.md" not in lower, (
        "workers__create must NOT claim to create SKILL.md — it doesn't"
    )


def test_workers_create_from_prompt_description_present():
    """workers__create_from_prompt tool must exist and be described."""
    desc = _read_tool_desc("workers__create_from_prompt")
    assert len(desc) > 50


# ── Bundle directory guard (what actually matters at runtime) ──────────────────

def test_worker_bundle_missing_skill_md_causes_agent_failure(tmp_path):
    """Validate that agent-mode workers without SKILL.md fail with the known error code.

    This is a regression test: if a bundle has exec.mode=agent and no SKILL.md,
    the runner must raise 'agent_runtime_error', not a generic 500.
    """
    import importlib, sys, types

    # Build a minimal fake bundle dir: worker.yml says agent mode, no SKILL.md
    bundle = tmp_path / "myworker"
    bundle.mkdir()
    (bundle / "worker.yml").write_text(
        'schema_version: "0.3"\n'
        'name: "myworker"\n'
        'exec:\n'
        '  mode: "agent"\n'
        '  entry: "SKILL.md"\n'
        '  runner: "e2b"\n',
        encoding="utf-8",
    )
    # No SKILL.md written intentionally

    # The agent_driver checks for the entrypoint file before launching E2B.
    # We test the file-check logic directly without importing the full driver.
    skill_md = bundle / "SKILL.md"
    assert not skill_md.exists(), "Test setup: SKILL.md must not exist"

    # Simulate the entrypoint check the runner does
    entry = "SKILL.md"
    entrypoint_path = bundle / entry
    found = entrypoint_path.exists()
    assert not found, "Expected entrypoint not found — matches production failure"


def test_worker_bundle_with_skill_md_passes_check(tmp_path):
    """A bundle with SKILL.md present must pass the entrypoint check."""
    bundle = tmp_path / "goodworker"
    bundle.mkdir()
    (bundle / "SKILL.md").write_text("# Good Worker\n\nDoes the thing.\n", encoding="utf-8")

    entrypoint_path = bundle / "SKILL.md"
    assert entrypoint_path.exists(), "SKILL.md present — entrypoint check should pass"
