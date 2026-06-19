"""Regression coverage for worker output-schema validation across ALL drivers.

Audit (docs/audits/worker-system-test-matrix.md, 2026-06-04, maintainer's P0):
the E2B script driver (.py/.sh/.js — the common case) NEVER ran
`_validate_output_schema`, so declared output `type` (json/csv/markdown/text),
CSV `columns`, and `json_required_keys` were silently unenforced. The fix routes
ALL three drivers (Agent / Skill / E2B) through ONE convergence point — the
output-schema gate in `run_service.execute_run` — and splits the E2B
result.json parse into distinct, actionable errors with a size cap.

These tests cover:
  * `_validate_output_schema` — the SHARED validator every driver now relies on.
  * `_read_result_json` — the E2B read/parse path (distinct errors + size cap
    + non-dict outputs).
  * The convergence point in `execute_run` (smoke: the gate is wired and a
    schema violation fails the run).
"""

from __future__ import annotations

import json

import pytest

from models import WorkerConfig, WorkerOutput, WorkerRuntime, WorkerTrigger
from runner_utils import _validate_output_schema
from runner_sandbox import e2b_driver
from models import WorkerResult


def _noop_log(*_args, **_kwargs) -> None:
    pass


def _config(outputs: list[WorkerOutput]) -> WorkerConfig:
    return WorkerConfig(
        id="parsefix-test",
        name="parsefix-test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="script", entrypoint="run.py", runner="e2b"),
        outputs=outputs,
    )


# ---------------------------------------------------------------------------
# _validate_output_schema — the shared validator (used by all 3 drivers)
# ---------------------------------------------------------------------------


def test_json_type_with_non_json_value_fails():
    cfg = _config([WorkerOutput(name="result", label="Result", type="json", required=True)])
    outputs = {"result": "this is not json at all {broken"}
    err = _validate_output_schema("w", outputs, _noop_log, config=cfg)
    assert err is not None
    assert "not valid JSON" in err


def test_json_type_with_valid_json_passes():
    cfg = _config([WorkerOutput(name="result", label="Result", type="json", required=True)])
    outputs = {"result": json.dumps({"a": 1})}
    assert _validate_output_schema("w", outputs, _noop_log, config=cfg) is None


def test_json_type_with_dict_value_passes():
    cfg = _config([WorkerOutput(name="result", label="Result", type="json", required=True)])
    outputs = {"result": {"a": 1}}
    assert _validate_output_schema("w", outputs, _noop_log, config=cfg) is None


def test_json_required_keys_missing_fails():
    cfg = _config([
        WorkerOutput(
            name="result",
            label="Result",
            type="json",
            required=True,
            json_required_keys=["required_field"],
        )
    ])
    outputs = {"result": {"other": 1}}  # valid JSON, missing the required key
    err = _validate_output_schema("w", outputs, _noop_log, config=cfg)
    assert err is not None
    assert "required_field" in err


def test_json_required_keys_present_passes():
    cfg = _config([
        WorkerOutput(
            name="result",
            label="Result",
            type="json",
            required=True,
            json_required_keys=["required_field"],
        )
    ])
    outputs = {"result": {"required_field": "x", "other": 1}}
    assert _validate_output_schema("w", outputs, _noop_log, config=cfg) is None


def test_csv_wrong_columns_fails():
    cfg = _config([
        WorkerOutput(
            name="table",
            label="Table",
            type="csv",
            required=True,
            columns=["name", "age"],
        )
    ])
    outputs = {"table": "foo,bar\n1,2\n"}  # wrong header
    err = _validate_output_schema("w", outputs, _noop_log, config=cfg)
    assert err is not None
    assert "column mismatch" in err


def test_csv_correct_columns_passes():
    cfg = _config([
        WorkerOutput(
            name="table",
            label="Table",
            type="csv",
            required=True,
            columns=["name", "age"],
        )
    ])
    outputs = {"table": "name,age\nalice,30\n"}
    assert _validate_output_schema("w", outputs, _noop_log, config=cfg) is None


def test_text_empty_fails():
    cfg = _config([WorkerOutput(name="note", label="Note", type="text", required=True)])
    assert _validate_output_schema("w", {"note": "   "}, _noop_log, config=cfg) is not None


def test_markdown_non_string_fails():
    cfg = _config([WorkerOutput(name="doc", label="Doc", type="markdown", required=True)])
    assert _validate_output_schema("w", {"doc": 42}, _noop_log, config=cfg) is not None


def test_missing_required_output_fails():
    cfg = _config([WorkerOutput(name="result", label="Result", type="json", required=True)])
    err = _validate_output_schema("w", {}, _noop_log, config=cfg)
    assert err is not None
    assert "Missing declared output" in err


def test_missing_optional_output_passes():
    cfg = _config([WorkerOutput(name="result", label="Result", type="json", required=False)])
    assert _validate_output_schema("w", {}, _noop_log, config=cfg) is None


def test_no_declared_outputs_skips():
    cfg = _config([])
    assert _validate_output_schema("w", {"anything": "goes"}, _noop_log, config=cfg) is None


def test_file_kind_output_is_skipped_by_schema_validator():
    """kind: file outputs are validated by _validate_run_outputs (file existence
    / emptiness / JSON parseability), NOT by the scalar-type contract. A file
    output's value is a path string (or absent), so the json/csv type check must
    NOT apply — otherwise legitimate file-mode workers (the majority of
    number-stats / median / sum-column / resume_helper on prod) would falsely fail.
    Regression guard for the behavior-change scan (15 false positives -> 0)."""
    cfg = _config([
        WorkerOutput(
            name="result",
            label="Result",
            type="json",
            kind="file",
            media_type="application/json",
            path="out/result.json",
            required=True,
        )
    ])
    # Output value is a relative path string, NOT JSON content — must pass here.
    assert _validate_output_schema("w", {"result": "out/result.json"}, _noop_log, config=cfg) is None
    # Even a bare number stored against a file output must not be rejected here.
    assert _validate_output_schema("w", {"result": 3.5}, _noop_log, config=cfg) is None


def test_file_kind_inferred_from_type_file_is_skipped():
    cfg = _config([
        WorkerOutput(name="doc", label="Doc", type="file", path="out/doc.pdf", required=True)
    ])
    assert _validate_output_schema("w", {"doc": "out/doc.pdf"}, _noop_log, config=cfg) is None


# ---------------------------------------------------------------------------
# _read_result_json — the E2B read/parse path (distinct errors, size cap)
# ---------------------------------------------------------------------------


class _FakeFiles:
    def __init__(self, content, raise_on_read=False):
        self._content = content
        self._raise = raise_on_read

    def read(self, _path):
        if self._raise:
            raise FileNotFoundError("no such file")
        return self._content


class _FakeSandbox:
    def __init__(self, content, raise_on_read=False):
        self.files = _FakeFiles(content, raise_on_read=raise_on_read)


def test_read_result_missing_file_distinct_error():
    sandbox = _FakeSandbox(None, raise_on_read=True)
    data, err = e2b_driver._read_result_json(sandbox, "/wd/result.json", _noop_log)
    assert data is None
    assert isinstance(err, WorkerResult)
    assert err.error_code == "missing_result"
    assert "did not write a result" in err.error


def test_read_result_missing_file_includes_worker_output():
    sandbox = _FakeSandbox(None, raise_on_read=True)
    data, err = e2b_driver._read_result_json(
        sandbox,
        "/wd/result.json",
        _noop_log,
        worker_stderr="Traceback (most recent call last):\nRuntimeError: import crashed\n",
    )
    assert data is None
    assert err.error_code == "missing_result"
    assert "Worker output:" in err.error
    assert "RuntimeError: import crashed" in err.error


def test_read_result_invalid_json_distinct_error():
    sandbox = _FakeSandbox("this is { not json")
    data, err = e2b_driver._read_result_json(sandbox, "/wd/result.json", _noop_log)
    assert data is None
    assert err.error_code == "invalid_result_json"
    assert "not valid JSON" in err.error


def test_read_result_non_object_toplevel_distinct_error():
    sandbox = _FakeSandbox(json.dumps([1, 2, 3]))  # JSON array, not object
    data, err = e2b_driver._read_result_json(sandbox, "/wd/result.json", _noop_log)
    assert data is None
    assert err.error_code == "invalid_result_json"
    assert "must be a JSON object" in err.error


def test_read_result_outputs_not_a_dict_fails_not_coerced():
    # The P1 bug: a worker returning a list/string for `outputs` was silently
    # coerced to {} and completed green. It must now FAIL with a clear error.
    sandbox = _FakeSandbox(json.dumps({"outputs": [1, 2, 3]}))
    data, err = e2b_driver._read_result_json(sandbox, "/wd/result.json", _noop_log)
    assert data is None
    assert err.error_code == "invalid_outputs_shape"
    assert "'outputs' must be a JSON object" in err.error


def test_read_result_size_cap_rejects_oversized(monkeypatch):
    monkeypatch.setattr(e2b_driver, "MAX_RESULT_JSON_BYTES", 100)
    big = json.dumps({"outputs": {"x": "y" * 500}})
    sandbox = _FakeSandbox(big)
    data, err = e2b_driver._read_result_json(sandbox, "/wd/result.json", _noop_log)
    assert data is None
    assert err.error_code == "output_too_large"
    assert "too large" in err.error


def test_read_result_valid_passes():
    sandbox = _FakeSandbox(json.dumps({"outputs": {"result": "ok"}, "status": "success"}))
    data, err = e2b_driver._read_result_json(sandbox, "/wd/result.json", _noop_log)
    assert err is None
    assert data == {"outputs": {"result": "ok"}, "status": "success"}


def test_read_result_bytes_content_passes():
    sandbox = _FakeSandbox(json.dumps({"outputs": {"r": 1}}).encode("utf-8"))
    data, err = e2b_driver._read_result_json(sandbox, "/wd/result.json", _noop_log)
    assert err is None
    assert data["outputs"] == {"r": 1}


# ---------------------------------------------------------------------------
# Convergence point — the gate in execute_run enforces the schema for every
# driver. We assert the gate code is wired to _validate_output_schema and that
# a declared-json / non-json output is what the gate would reject (using the
# SAME validator the gate calls).
# ---------------------------------------------------------------------------


def test_gate_uses_same_validator_e2b_output_now_enforced():
    """End-to-end intent: a .py/.sh/.js (E2B) worker that declares type:json but
    returns non-JSON used to COMPLETE with garbage. The gate now runs the same
    _validate_output_schema the Agent/Skill drivers used, so the identical
    outputs are rejected regardless of driver."""
    cfg = _config([
        WorkerOutput(
            name="result",
            label="Result",
            type="json",
            required=True,
            json_required_keys=["must_have_key"],
        )
    ])
    # Simulate what the E2B driver hands the gate (outputs dict from result.json)
    e2b_outputs = {"result": "this is not json at all {broken"}
    err = _validate_output_schema("parsefix-test", e2b_outputs, _noop_log, config=cfg)
    assert err is not None  # gate would FAIL this run (was COMPLETED before)


def test_gate_is_wired_in_run_service():
    """Guard against silent removal of the convergence point."""
    import inspect
    import run_service

    src = inspect.getsource(run_service.execute_run)
    assert "_validate_output_schema" in src
    assert "schema_violation" in src
