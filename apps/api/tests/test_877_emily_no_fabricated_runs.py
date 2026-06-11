"""Tests for #877 (P0 trust hazard) — Emily fabricates "I ran the worker /
here's the result" when no run actually executed.

Two-part fix:

PART A (prompt rule): EMILY_BASE_PERSONA + GLOBAL_COMMUNICATION_RULES carry a
hard rule that the model must never claim an action was performed (ran a worker,
sent a message, created/updated something) unless a tool call actually returned
success with a concrete id/result, and must never invent a run id, status, or
output. This rule must be present in the assembled system prompt across surfaces.

PART B (tool-result grounding): _tool_workers_run returns an explicit,
unambiguous structure the model cannot misread a failure as success:
  - success -> {ok: true, run_id, status} (status is the real "queued"); no field
    that looks like a finished result/output.
  - failure (not-found / blocked / error / missing inputs) -> {ok: false, error}
    with NO run_id, status, message, or any success-looking field.

Run:
    cd apps/api && python -m pytest tests/test_877_emily_no_fabricated_runs.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import patch, MagicMock

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Helpers — mirror test_627's minimal WorkerConfig + mocked tool invocation
# ---------------------------------------------------------------------------

class _FakeInput:
    def __init__(self, name: str, required: bool = False, label: str = "", description: str = ""):
        self.name = name
        self.required = required
        self.label = label
        self.description = description


class _FakeConfig:
    def __init__(self, inputs: list):
        self.inputs = inputs


def _run_tool(
    args: Dict[str, Any],
    config: Optional[_FakeConfig],
    *,
    can_view: bool = True,
) -> Dict[str, Any]:
    """Call _tool_workers_run with all heavy dependencies mocked out."""
    import main as _main
    import run_service as _rs
    import db as _db
    import chat_service as _cs

    from chat_service import _tool_workers_run

    with (
        patch.object(_cs, "_worker_can_view", return_value=can_view),
        patch.object(_main, "_canonical_worker_id", side_effect=lambda x: x),
        patch.object(_rs, "get_worker_config_for_run", return_value=config),
        patch.object(_rs, "create_run", return_value="run_test_123"),
        patch.object(_rs, "start_run", return_value=None),
        patch.object(_db, "get_repositories", return_value=MagicMock()),
    ):
        return _tool_workers_run(args, user_id="test-user")


# Fields that would let the model narrate a started/finished run. None of these
# may appear on a FAILED tool result.
_SUCCESS_LOOKING_FIELDS = ("run_id", "status", "message", "outputs", "output", "result")


# ---------------------------------------------------------------------------
# PART B — tool-result grounding
# ---------------------------------------------------------------------------

def test_877_not_found_returns_only_error_no_success_fields():
    """When the worker is not viewable (#856/#748 guard), the tool result the
    model sees must be ok:false + a clear error and NOTHING that looks like a
    started or finished run."""
    result = _run_tool({"id": "ghost-worker", "inputs_json": "{}"}, config=None, can_view=False)

    assert result["ok"] is False
    assert "not found" in result["error"].lower()
    for field in _SUCCESS_LOOKING_FIELDS:
        assert field not in result, (
            f"Failed (not-found) run result must not contain {field!r} — "
            "the model could misread it as a started/finished run"
        )


def test_877_missing_inputs_failure_has_no_run_id_or_status():
    """A blocked run (missing required inputs) must not carry run_id/status/output."""
    config = _FakeConfig(inputs=[_FakeInput("notes", required=True, label="Notes")])
    result = _run_tool({"id": "weekly-update", "inputs_json": "{}"}, config)

    assert result["ok"] is False
    assert "run_id" not in result
    assert "status" not in result
    assert "outputs" not in result and "output" not in result and "result" not in result


def test_877_exec_failure_returns_only_error():
    """If create_run/start_run raises, the result must be ok:false + error only,
    with no run_id/status/message the model could narrate as success."""
    import main as _main
    import run_service as _rs
    import db as _db
    import chat_service as _cs
    from chat_service import _tool_workers_run

    with (
        patch.object(_cs, "_worker_can_view", return_value=True),
        patch.object(_main, "_canonical_worker_id", side_effect=lambda x: x),
        patch.object(_rs, "get_worker_config_for_run", return_value=None),
        patch.object(_rs, "create_run", side_effect=RuntimeError("e2b unavailable")),
        patch.object(_rs, "start_run", return_value=None),
        patch.object(_db, "get_repositories", return_value=MagicMock()),
    ):
        result = _tool_workers_run({"id": "some-worker", "inputs_json": "{}"}, "test-user")

    assert result["ok"] is False
    assert "e2b unavailable" in result["error"]
    for field in _SUCCESS_LOOKING_FIELDS:
        assert field not in result, (
            f"Failed (exec error) run result must not contain {field!r}"
        )


def test_877_success_reports_real_run_id_and_queued_status_not_output():
    """A real, started run returns ok:true with the real run_id and a 'queued'
    status. It must NOT carry a finished-output field — the run hasn't run yet,
    so the model has nothing to narrate as a result."""
    result = _run_tool({"id": "some-worker", "inputs_json": "{}"}, config=None)

    assert result["ok"] is True
    assert result["run_id"] == "run_test_123"
    assert result["status"] == "queued", "Status must reflect the real enqueued state"
    # No finished-output field on a freshly-queued run.
    for field in ("outputs", "output", "result"):
        assert field not in result, (
            f"A queued run must not carry {field!r} — the run has not finished"
        )


# ---------------------------------------------------------------------------
# PART A — prompt rule present across surfaces
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("source", ["web", "whatsapp", "slack", "mcp", "cli"])
def test_877_no_fabricated_action_rule_in_system_prompt(source):
    """The assembled system prompt for every surface must carry the rule that
    Emily never claims an un-performed action and never invents a run id."""
    import chat_service as _cs

    with (
        patch.object(_cs, "_build_system_prompt", return_value="BASE"),
        patch.object(_cs, "_build_capabilities_snapshot", return_value="SNAPSHOT"),
    ):
        prompt = _cs.build_system_prompt_for_source("test-user", source=source)

    low = prompt.lower()
    assert "never invent a run id" in low, (
        f"[{source}] system prompt must forbid inventing run ids"
    )
    # The rule must forbid claiming un-performed actions.
    assert "never claim un-performed actions" in low or "never claim what i didn't do" in low or (
        "unless a tool call actually returned success" in low
    ), f"[{source}] system prompt must forbid claiming un-performed actions"


def test_877_rule_present_in_global_communication_rules_constant():
    """Structural: the cross-surface GLOBAL_COMMUNICATION_RULES constant itself
    carries the no-fabrication rule, so every caller inherits it."""
    from chat_service import GLOBAL_COMMUNICATION_RULES

    low = GLOBAL_COMMUNICATION_RULES.lower()
    assert "never invent a run id" in low
    assert "never claim un-performed actions" in low


def test_877_rule_present_in_base_persona_constant():
    """Structural: EMILY_BASE_PERSONA (applied on every surface) carries the rule
    even when worker-authoring rules are not appended."""
    from chat_service import EMILY_BASE_PERSONA

    low = EMILY_BASE_PERSONA.lower()
    assert "never claim what i didn't do" in low
    assert "never invent a run id" in low
