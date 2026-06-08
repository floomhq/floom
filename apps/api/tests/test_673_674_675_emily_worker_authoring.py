"""Tests for Emily worker-authoring quality fixes.

#673 — workers__create must reject invalid trigger.type and exec.runner values
        before persisting, returning an actionable error message.
#674 — Emily's system prompt must include explicit authoring rules for approvals,
        connections, exec mode, trigger types, and runner.
#675 — workers__create result must include saved_config (connections, approvals,
        trigger, exec_mode) so Emily can verify intent vs actual without a
        separate workers.get call.

Run:
    cd apps/api && python -m pytest tests/test_673_674_675_emily_worker_authoring.py -v
"""
from __future__ import annotations

import sys
import json
from pathlib import Path
from unittest.mock import patch, MagicMock
from typing import Any, Dict

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

CHAT_SRC = (API_DIR / "chat_service.py").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _call_create(yaml_text: str, *, mock_register=True, mock_smoke=True) -> Dict[str, Any]:
    """Call _tool_workers_create with heavy deps mocked so validation fires."""
    from chat_service import _tool_workers_create

    with (
        patch("chat_service._canonicalize_emily_exec_command", side_effect=lambda y, **kw: y),
        patch("chat_service._register_worker_from_files_via_import",
              return_value="test-worker", create=True),
        patch("chat_service._smoke_gate_emily_worker", return_value=("skipped", "test")),
    ):
        # Patch the imports inside the function body
        import db as _db
        mock_repos = MagicMock()
        with (
            patch.object(_db, "get_repositories", return_value=mock_repos),
        ):
            try:
                import main as _main
                with patch.object(_main, "_register_worker_from_files", return_value="test-worker"):
                    with patch("chat_service._smoke_gate_emily_worker", return_value=("skipped", "test")):
                        return _tool_workers_create({"yaml_text": yaml_text}, user_id="test-user")
            except Exception:
                # If main isn't importable just do direct validation test
                return _tool_workers_create({"yaml_text": yaml_text}, user_id="test-user")


def _minimal_yaml(*, trigger_type="manual", runner="e2b", extra="") -> str:
    return f"""
schema_version: "0.3"
name: test-worker
title: "Test Worker"
description: "Test description for a test worker."
version: "0.1.0"
exec:
  entry: run.py
  runtime: python311
  runner: {runner}
  mode: pure-script
trigger:
  type: {trigger_type}
{extra}
""".strip()


# ---------------------------------------------------------------------------
# #673 — invalid trigger.type rejected
# ---------------------------------------------------------------------------

def test_673_invalid_trigger_type_cron_rejected():
    """'cron' is not a valid WorkerOS trigger type — must be rejected."""
    result = _call_create(_minimal_yaml(trigger_type="cron"))
    assert result.get("ok") is False, (
        "#673: trigger.type='cron' must be rejected. "
        "Valid types are manual/schedule/webhook/event."
    )
    assert "cron" in result.get("error", "").lower() or "trigger" in result.get("error", "").lower()


def test_673_invalid_trigger_type_incoming_email_rejected():
    """'incoming_email' is not a valid trigger type."""
    result = _call_create(_minimal_yaml(trigger_type="incoming_email"))
    assert result.get("ok") is False, (
        "#673: trigger.type='incoming_email' must be rejected — it does not exist in WorkerOS."
    )
    assert "incoming_email" in result.get("error", "") or "trigger" in result.get("error", "").lower()


def test_673_valid_trigger_types_accepted():
    """All four valid trigger types must pass validation."""
    for t in ("manual", "schedule", "webhook", "event"):
        result = _call_create(_minimal_yaml(trigger_type=t))
        # ok=False is only acceptable for reasons OTHER than trigger type
        if result.get("ok") is False:
            assert "trigger" not in result.get("error", "").lower(), (
                f"#673: valid trigger type '{t}' must not be rejected by trigger validation, "
                f"got: {result.get('error')}"
            )


def test_673_invalid_runner_local_rejected():
    """runner='local' was removed and must be rejected."""
    result = _call_create(_minimal_yaml(runner="local"))
    assert result.get("ok") is False, (
        "#673: exec.runner='local' must be rejected — the local runner was removed."
    )
    assert "local" in result.get("error", "") or "runner" in result.get("error", "").lower()


def test_673_runner_e2b_accepted():
    """runner='e2b' is the only valid runner and must not be rejected."""
    result = _call_create(_minimal_yaml(runner="e2b"))
    if result.get("ok") is False:
        assert "runner" not in result.get("error", "").lower(), (
            f"#673: runner='e2b' must not be rejected by runner validation, got: {result.get('error')}"
        )


def test_673_error_message_is_actionable():
    """Error message for invalid trigger type must tell Emily what the valid values are."""
    result = _call_create(_minimal_yaml(trigger_type="incoming_email"))
    error = result.get("error", "")
    assert "schedule" in error or "manual" in error or "valid" in error.lower(), (
        "#673: error message must tell Emily the valid trigger types so she can self-correct"
    )


def test_673_tool_description_includes_valid_trigger_types():
    """The workers__create tool description must enumerate valid trigger types."""
    # Find the _make_tool call for workers__create — search for the description string
    # which is unique and directly in the tool registration.
    assert "\"manual\" | \"schedule\" | \"webhook\" | \"event\"" in CHAT_SRC or \
           "manual.*schedule.*webhook.*event" in CHAT_SRC or \
           ('schedule' in CHAT_SRC and 'webhook' in CHAT_SRC and 'event' in CHAT_SRC and
            '"workers__create"' in CHAT_SRC), (
        "#673: workers__create tool description must list valid trigger types"
    )
    # Specifically check that the invalid ones are called out
    assert "incoming_email" in CHAT_SRC, (
        "#673: 'incoming_email' must be called out as invalid in the workers__create tool description"
    )
    # Find tool description block specifically
    desc_idx = CHAT_SRC.find("FIELD RULES — these are non-negotiable")
    assert desc_idx != -1, (
        "#673: tool description must contain 'FIELD RULES' section with valid values"
    )
    block = CHAT_SRC[desc_idx: desc_idx + 1500]
    for valid_type in ("schedule", "webhook", "event", "manual"):
        assert valid_type in block, (
            f"#673: '{valid_type}' must be listed as a valid trigger type in the FIELD RULES section"
        )


def test_673_tool_description_specifies_e2b_runner():
    """The tool description must state that e2b is the only valid runner."""
    desc_idx = CHAT_SRC.find("FIELD RULES — these are non-negotiable")
    assert desc_idx != -1
    block = CHAT_SRC[desc_idx: desc_idx + 1500]
    assert "e2b" in block, "#673: FIELD RULES must say exec.runner must be 'e2b'"


# ---------------------------------------------------------------------------
# #674 — Emily's system prompt contains authoring rules
# ---------------------------------------------------------------------------

def test_674_system_prompt_has_approval_mapping():
    """Emily's system prompt must map approval intent to approvals.required: true."""
    authoring_idx = CHAT_SRC.find("## Worker authoring rules")
    assert authoring_idx != -1, "#674: Worker authoring rules section must exist"
    block = CHAT_SRC[authoring_idx: authoring_idx + 2000]
    assert "approvals" in block and "required: true" in block, (
        "#674: authoring rules must state that 'ask for approval' maps to approvals: {required: true}"
    )


def test_674_system_prompt_has_connections_rule():
    """Emily's system prompt must say to add all external services to connections list."""
    authoring_idx = CHAT_SRC.find("## Worker authoring rules")
    assert authoring_idx != -1
    block = CHAT_SRC[authoring_idx: authoring_idx + 2000]
    assert "connections" in block, (
        "#674: authoring rules must include a rule about declaring connections"
    )
    assert "[]" in block or "cannot" in block.lower() or "empty" in block.lower(), (
        "#674: authoring rules must warn that connections: [] means no external service access"
    )


def test_674_system_prompt_has_exec_mode_guidance():
    """Emily's system prompt must explain when to use agent vs pure-script mode."""
    # The authoring rules section is appended after EMILY_BASE_PERSONA — search for it directly
    authoring_idx = CHAT_SRC.find("## Worker authoring rules")
    assert authoring_idx != -1, (
        "#674: Emily's base persona must include a '## Worker authoring rules' section"
    )
    authoring_block = CHAT_SRC[authoring_idx: authoring_idx + 2000]
    assert "agent" in authoring_block, (
        "#674: Worker authoring rules must mention agent mode"
    )
    assert "pure-script" in authoring_block, (
        "#674: Worker authoring rules must mention pure-script mode"
    )
    assert "connection" in authoring_block.lower(), (
        "#674: authoring rules must say to use agent mode when calling external services via connections"
    )


def test_674_system_prompt_has_trigger_type_rules():
    """Emily's system prompt must enumerate valid trigger types."""
    authoring_idx = CHAT_SRC.find("## Worker authoring rules")
    assert authoring_idx != -1
    block = CHAT_SRC[authoring_idx: authoring_idx + 2000]
    assert "schedule" in block, "#674: 'schedule' trigger type must be in Emily's authoring rules"
    assert "incoming_email" in block or "cron" in block, (
        "#674: Emily's rules must explicitly call out invalid trigger type values"
    )


def test_674_system_prompt_says_verify_after_create():
    """Emily's system prompt must instruct her to verify saved config after creation."""
    authoring_idx = CHAT_SRC.find("## Worker authoring rules")
    assert authoring_idx != -1
    block = CHAT_SRC[authoring_idx: authoring_idx + 2000]
    assert "saved" in block.lower() or "re-read" in block.lower() or "confirm" in block.lower(), (
        "#674: authoring rules must tell Emily to verify what was actually saved "
        "after creating/updating a worker"
    )


# ---------------------------------------------------------------------------
# #675 — create result includes saved_config
# ---------------------------------------------------------------------------

def test_675_create_result_includes_saved_config():
    """workers__create result must include saved_config with connections, approvals,
    trigger, and exec_mode so Emily can verify intent vs actual."""
    yaml_with_approval = _minimal_yaml(extra="approvals:\n  required: true\nconnections:\n  - gmail")
    result = _call_create(yaml_with_approval)

    if result.get("ok") is not False:
        assert "saved_config" in result, (
            "#675: successful create must include 'saved_config' in the result "
            "so Emily can verify what was actually saved"
        )
        cfg = result.get("saved_config", {})
        assert "connections" in cfg, "#675: saved_config must include 'connections'"
        assert "approvals_required" in cfg, "#675: saved_config must include 'approvals_required'"
        assert "trigger_type" in cfg, "#675: saved_config must include 'trigger_type'"
        assert "exec_mode" in cfg, "#675: saved_config must include 'exec_mode'"


def test_675_saved_config_reflects_actual_manifest():
    """saved_config must reflect what the YAML actually contained."""
    yaml_text = _minimal_yaml(extra="approvals:\n  required: true\nconnections:\n  - gmail\n  - googlecalendar")
    result = _call_create(yaml_text)

    if result.get("ok") is not False and "saved_config" in result:
        cfg = result["saved_config"]
        assert cfg.get("approvals_required") is True, (
            "#675: saved_config.approvals_required must reflect approvals.required: true from the YAML"
        )
        assert "gmail" in cfg.get("connections", []), (
            "#675: saved_config.connections must include 'gmail'"
        )
        assert "googlecalendar" in cfg.get("connections", []), (
            "#675: saved_config.connections must include 'googlecalendar'"
        )


def test_675_saved_config_shows_empty_connections():
    """saved_config must show empty connections list so Emily notices the gap."""
    result = _call_create(_minimal_yaml())  # no connections declared
    if result.get("ok") is not False and "saved_config" in result:
        cfg = result["saved_config"]
        assert cfg.get("connections") == [], (
            "#675: saved_config.connections must be [] when no connections declared — "
            "Emily must see this and ask if the user expected external service access"
        )


def test_675_saved_config_in_source():
    """saved_config must be built from the manifest in _tool_workers_create source."""
    # Search for the saved_config assignment directly rather than inside a function window
    assert "saved_config" in CHAT_SRC, (
        "#675: 'saved_config' must appear in chat_service.py"
    )
    # Find it near _tool_workers_create
    create_idx = CHAT_SRC.find("def _tool_workers_create(")
    update_idx = CHAT_SRC.find("def _tool_workers_update(")
    assert create_idx != -1
    func_body = CHAT_SRC[create_idx: update_idx if update_idx > create_idx else create_idx + 8000]
    assert "saved_config" in func_body, (
        "#675: _tool_workers_create must return 'saved_config' key in its result dict"
    )
    assert "approvals_required" in func_body, (
        "#675: saved_config must include 'approvals_required' derived from the manifest"
    )
