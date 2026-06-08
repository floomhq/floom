"""Tests for #627 — Emily fires worker runs without validating required inputs.

Root cause: _tool_workers_run in chat_service.py called create_run/start_run
immediately with whatever inputs the LLM provided. If required inputs were
absent the run launched, failed at execution time, and Emily reported the
failure — instead of asking the user for the missing input upfront.

Fix: _tool_workers_run now loads the worker's declared input schema via
get_worker_config_for_run, diffs against the provided inputs, and returns a
structured {"ok": false, "missing_inputs": [...]} error before creating a run
row. Emily receives the field names and labels and can ask the user intelligently.

Run:
    cd apps/api && python -m pytest tests/test_627_emily_input_validation.py -v
"""
from __future__ import annotations

import sys
import json
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import patch, MagicMock

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Helpers — build minimal WorkerConfig-like objects for mocking
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


def _run_tool(args: Dict[str, Any], config: Optional[_FakeConfig]) -> Dict[str, Any]:
    """Call _tool_workers_run with all heavy dependencies mocked out."""
    import main as _main
    import run_service as _rs
    import db as _db

    from chat_service import _tool_workers_run

    with (
        patch.object(_main, "_canonical_worker_id", side_effect=lambda x: x),
        patch.object(_rs, "get_worker_config_for_run", return_value=config),
        patch.object(_rs, "create_run", return_value="run_test_123"),
        patch.object(_rs, "start_run", return_value=None),
        patch.object(_db, "get_repositories", return_value=MagicMock()),
    ):
        return _tool_workers_run(args, user_id="test-user")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_627_missing_required_input_returns_error():
    """When a required input is absent, _tool_workers_run must return ok=False
    with an error listing the missing field — before creating any run row."""
    config = _FakeConfig(inputs=[
        _FakeInput("notes", required=True, label="Weekly notes"),
        _FakeInput("recipients", required=False),
    ])
    result = _run_tool({"id": "weekly-update", "inputs_json": "{}"}, config)

    assert result["ok"] is False, "Must return ok=False when required input is missing"
    assert "notes" in result["error"], "Error must name the missing field"
    assert "missing_inputs" in result, "Must include missing_inputs list for structured handling"
    assert "notes" in result["missing_inputs"]


def test_627_missing_input_includes_label_in_error():
    """The error message must include the human-readable label so Emily can
    phrase the follow-up question without using raw field names."""
    config = _FakeConfig(inputs=[
        _FakeInput("notes", required=True, label="Notes for the weekly update"),
    ])
    result = _run_tool({"id": "weekly-update", "inputs_json": "{}"}, config)

    assert "Notes for the weekly update" in result["error"], (
        "Error must include the field label so Emily can ask the user clearly"
    )


def test_627_multiple_missing_inputs_all_listed():
    """All missing required inputs must be listed in one error, not just the first."""
    config = _FakeConfig(inputs=[
        _FakeInput("topic", required=True, label="Topic"),
        _FakeInput("audience", required=True, label="Target audience"),
        _FakeInput("tone", required=False),
    ])
    result = _run_tool({"id": "blog-writer", "inputs_json": "{}"}, config)

    assert result["ok"] is False
    assert "topic" in result["missing_inputs"]
    assert "audience" in result["missing_inputs"]
    assert "tone" not in result.get("missing_inputs", []), "Optional fields must not appear in missing_inputs"


def test_627_run_not_created_when_inputs_missing():
    """create_run must NOT be called when required inputs are absent.
    Previously a run row was created and then failed at execution time."""
    config = _FakeConfig(inputs=[_FakeInput("notes", required=True)])

    import main as _main
    import run_service as _rs
    import db as _db
    from chat_service import _tool_workers_run

    with (
        patch.object(_main, "_canonical_worker_id", side_effect=lambda x: x),
        patch.object(_rs, "get_worker_config_for_run", return_value=config),
        patch.object(_rs, "create_run", return_value="run_test_123") as mock_create,
        patch.object(_rs, "start_run", return_value=None) as mock_start,
        patch.object(_db, "get_repositories", return_value=MagicMock()),
    ):
        result = _tool_workers_run({"id": "weekly-update", "inputs_json": "{}"}, "test-user")

    assert result["ok"] is False
    mock_create.assert_not_called(), "create_run must not be called when required inputs are absent"
    mock_start.assert_not_called(), "start_run must not be called when required inputs are absent"


def test_627_run_proceeds_when_all_required_inputs_provided():
    """When all required inputs are present, the run must proceed normally."""
    config = _FakeConfig(inputs=[
        _FakeInput("notes", required=True, label="Notes"),
        _FakeInput("tone", required=False),
    ])
    result = _run_tool(
        {"id": "weekly-update", "inputs_json": '{"notes": "Q2 update"}'},
        config,
    )

    assert result["ok"] is True, f"Run must proceed when all required inputs are provided: {result}"
    assert "run_id" in result


def test_627_optional_inputs_never_block_run():
    """Optional inputs must never block a run even when absent."""
    config = _FakeConfig(inputs=[
        _FakeInput("topic", required=True, label="Topic"),
        _FakeInput("tone", required=False, label="Writing tone"),
        _FakeInput("length", required=False, label="Desired length"),
    ])
    result = _run_tool(
        {"id": "blog-writer", "inputs_json": '{"topic": "AI trends"}'},
        config,
    )
    assert result["ok"] is True


def test_627_null_and_empty_string_treated_as_missing():
    """Providing null or empty string for a required input must still trigger
    the validation error — they are semantically equivalent to 'not provided'."""
    config = _FakeConfig(inputs=[_FakeInput("notes", required=True, label="Notes")])

    for bad_value in [None, ""]:
        result = _run_tool(
            {"id": "weekly-update", "inputs_json": json.dumps({"notes": bad_value})},
            config,
        )
        assert result["ok"] is False, (
            f"notes={bad_value!r} must be treated as missing (got ok=True)"
        )
        assert "notes" in result.get("missing_inputs", [])


def test_627_no_worker_config_does_not_block_run():
    """When get_worker_config_for_run returns None (worker not found or config
    unavailable), the run must still proceed — validation is best-effort only
    and must not block runs for unconfigured workers."""
    result = _run_tool({"id": "some-worker", "inputs_json": "{}"}, config=None)
    # Should either succeed or fail with a real run error, NOT an input error
    assert "missing_inputs" not in result, (
        "Missing-input gate must not fire when worker config is unavailable"
    )


def test_627_error_message_instructs_emily_to_ask_user():
    """The error message must explicitly tell Emily to ask the user for the
    missing inputs before retrying — not just report failure."""
    config = _FakeConfig(inputs=[_FakeInput("notes", required=True, label="Notes")])
    result = _run_tool({"id": "weekly-update", "inputs_json": "{}"}, config)

    assert result["ok"] is False
    error = result.get("error", "")
    assert "ask" in error.lower() or "provide" in error.lower() or "retry" in error.lower(), (
        "Error message must instruct Emily to ask the user and retry, not just list the failure"
    )


def test_627_source_code_has_validation_before_create_run():
    """Structural check: the input validation block must appear BEFORE the
    create_run call in the source, not after."""
    src = (API_DIR / "chat_service.py").read_text(encoding="utf-8")

    tool_idx = src.find("def _tool_workers_run(")
    assert tool_idx != -1, "_tool_workers_run not found in chat_service.py"

    func_body = src[tool_idx: tool_idx + 3000]

    validation_idx = func_body.find("missing_inputs")
    create_run_idx = func_body.find("create_run(")

    assert validation_idx != -1, "missing_inputs check must exist in _tool_workers_run"
    assert create_run_idx != -1, "create_run must exist in _tool_workers_run"
    assert validation_idx < create_run_idx, (
        "Input validation (missing_inputs) must appear BEFORE the create_run call — "
        "otherwise a run row is created before the validation fires"
    )
