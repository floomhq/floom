"""Batch J — operator-surface hygiene + path-scrub unit tests (2026-05-29).

Covers:
- P0-2: bare Python-exception messages (no class name) map to the calm CODE
  headline, never leak verbatim; clean structured messages still pass through.
- P2 / PATH-1: logs[].message and artifact paths never expose host/sandbox paths.
"""

import os
from pathlib import Path

import main


# --------------------------------------------------------------------------
# P0-2 — unclassified bare Python exception -> calm CODE headline
# --------------------------------------------------------------------------

def test_bare_typeerror_message_maps_to_code_headline() -> None:
    # The exact scorer-A leak: a TypeError stringified to its message only,
    # error_code=None. Must NOT pass through verbatim.
    raw = "unsupported operand type(s) for /: 'str' and 'float'"
    headline = main._operator_error_message(raw, None)
    assert headline == main._CODE_HEADLINE
    assert "unsupported operand" not in headline


def test_worker_traceback_with_timeout_code_maps_to_code_headline() -> None:
    raw = (
        "Traceback (most recent call last):\n"
        '  File "/home/user/worker/run.py", line 4, in run\n'
        "RuntimeError: user raised failure"
    )
    headline = main._operator_error_message(raw, "timeout")
    assert headline == main._CODE_HEADLINE


def test_other_bare_python_messages_map_to_code_headline() -> None:
    for raw in [
        "'NoneType' object is not subscriptable",
        "list index out of range",
        "division by zero",
        "could not convert string to float: 's'",
        "not enough values to unpack (expected 2, got 1)",
        "name 'foo' is not defined",
        "main() takes 0 positional arguments but 1 was given",
    ]:
        headline = main._operator_error_message(raw, None)
        assert headline == main._CODE_HEADLINE, raw
        assert raw not in headline


def test_clean_structured_message_passes_through() -> None:
    # Operator-clean messages must NOT be swallowed by the new bare-exc gate.
    raw = "Missing required inputs: prospect_name"
    headline = main._operator_error_message(raw, None)
    assert headline == raw


def test_invalid_value_enum_message_passes_through() -> None:
    raw = "Invalid value 'en'; expected one of: de, fr"
    headline = main._operator_error_message(raw, None)
    assert headline == raw


def test_bare_exc_message_with_custom_code_still_not_verbatim() -> None:
    # Even with an unrecognised error_code, a bare-exc message must not leak.
    raw = "object has no attribute 'foo'"
    headline = main._operator_error_message(raw, "some_future_code")
    assert raw not in (headline or "")


def test_error_raw_preserves_message_but_no_path() -> None:
    raw = (
        "Traceback (most recent call last):\n"
        '  File "/home/user/worker/run.py", line 12, in main\n'
        "TypeError: unsupported operand type(s) for /: 'str' and 'float'"
    )
    error_raw = main._run_error_raw(raw, "execution_error")
    assert error_raw is not None
    assert "/home/user" not in error_raw
    assert "/opt/workeros" not in error_raw


# --------------------------------------------------------------------------
# P2 / PATH-1 — log + artifact path scrubbing
# --------------------------------------------------------------------------

def test_log_message_strips_sandbox_path() -> None:
    # A traceback FRAME line is now collapsed to the calm note (Batch K) — it
    # carries no path AND no Python frame noise. The only invariant that matters
    # is that no host/sandbox path leaks.
    msg = 'File "/home/user/worker/run.py", line 12, in <module>'
    redacted = main._redact_public_log_message(msg)
    assert "/home/user" not in redacted
    assert ", line 12" not in redacted


def test_log_message_non_traceback_path_still_relativised() -> None:
    # A NON-traceback log line that happens to contain a sandbox path is still
    # scrubbed to [worker file] (not collapsed) so the line stays informative.
    msg = "reading inputs from /home/user/worker/inputs.json"
    redacted = main._redact_public_log_message(msg)
    assert "/home/user" not in redacted
    assert "[worker file]" in redacted


def test_log_message_strips_host_path() -> None:
    msg = "wrote /opt/workeros/data/artifacts/run_x/out/sorted.csv"
    redacted = main._redact_public_log_message(msg)
    assert "/opt/workeros" not in redacted


def test_log_message_clean_unchanged() -> None:
    msg = "Worker completed: 9 words, 44 characters"
    assert main._redact_public_log_message(msg) == msg


def test_public_artifact_path_relativises_host_path() -> None:
    from runner_utils import ARTIFACTS_DIR

    abs_path = str((ARTIFACTS_DIR / "run_abc" / "out" / "sorted.csv").resolve())
    rel = main._public_artifact_path(abs_path)
    assert rel == "run_abc/out/sorted.csv"
    assert "/root" not in rel
    assert not os.path.isabs(rel)


def test_public_artifact_path_outside_root_falls_back_to_basename() -> None:
    rel = main._public_artifact_path("/etc/passwd")
    assert rel == "passwd"
    assert "/etc" not in rel


def test_public_artifact_path_empty() -> None:
    assert main._public_artifact_path("") == ""
    assert main._public_artifact_path(None) == ""


# --------------------------------------------------------------------------
# Reliability — smoke placeholder is type-appropriate (no false-disable of
# list/number workers)
# --------------------------------------------------------------------------

def test_smoke_inputs_list_placeholder_is_a_list(tmp_path):
    import run_service
    from models import WorkerConfig

    config = WorkerConfig(
        id="t",
        name="t",
        trigger={"type": "manual"},
        runtime={"type": "python", "entrypoint": "run.py"},
        inputs=[{"name": "numbers", "type": "list", "required": True,
                 "kind": "scalar", "label": "Numbers"}],
        outputs=[],
    )
    out = run_service._build_smoke_inputs(config, {}, tmp_path)
    assert isinstance(out["numbers"], list), out
    # a numeric list so float()/sorted()/statistics work
    assert all(isinstance(x, (int, float)) for x in out["numbers"])


def test_smoke_inputs_string_placeholder_unchanged(tmp_path):
    import run_service
    from models import WorkerConfig

    config = WorkerConfig(
        id="t",
        name="t",
        trigger={"type": "manual"},
        runtime={"type": "python", "entrypoint": "run.py"},
        inputs=[{"name": "text", "type": "string", "required": True,
                 "kind": "scalar", "label": "Text"}],
        outputs=[],
    )
    out = run_service._build_smoke_inputs(config, {}, tmp_path)
    assert out["text"] == "sample"


def test_smoke_inputs_use_manifest_example_input(tmp_path):
    import run_service
    from models import WorkerConfig

    config = WorkerConfig(
        id="median-worker",
        name="Median Worker",
        trigger={"type": "manual"},
        runtime={"type": "python", "entrypoint": "run.py"},
        inputs=[
            {
                "name": "numbers",
                "type": "list",
                "required": True,
                "kind": "scalar",
                "label": "Numbers",
            }
        ],
        outputs=[],
    )
    bundle = {
        "worker_yml": (
            'schema_version: "0.3"\n'
            'name: "median-worker"\n'
            "example_input:\n"
            "  numbers: [3, 1, 2, 5, 4]\n"
        )
    }

    out = run_service._build_smoke_inputs(config, bundle, tmp_path)

    assert out["numbers"] == [3, 1, 2, 5, 4]


# --------------------------------------------------------------------------
# Batch K / G5 P1-A — smoke_reason humanization (draft-and-create + SSE) and
# the run "Recent logs" failure line must never leak raw exceptions/paths.
# --------------------------------------------------------------------------

def test_smoke_reason_strips_sandbox_path() -> None:
    # The exact scorer-B leak: KeyError with a /home/user sandbox path.
    reason = (
        "Command exited with code 1 ... "
        'File "/home/user/worker/run.py", line 42 ... '
        "KeyError: 'input_file' (error_code=e2b_sandbox_error)"
    )
    out = main.humanize_smoke_reason(reason)
    assert out is not None
    assert "/home/user" not in out
    assert "/opt/workeros" not in out
    assert "KeyError" not in out
    assert "Traceback" not in out


def test_smoke_reason_bare_exception_humanized() -> None:
    # The exact scorer-A leak class on the create surface.
    reason = "unsupported operand type(s) for /: 'str' and 'float' (error_code=execution_error)"
    out = main.humanize_smoke_reason(reason)
    assert out == main._CODE_HEADLINE
    assert "unsupported operand" not in out


def test_smoke_reason_typeerror_no_int_multiply() -> None:
    reason = "can't multiply sequence by non-int of type 'float' (error_code=unknown)"
    out = main.humanize_smoke_reason(reason)
    assert out is not None
    assert "multiply sequence" not in out
    assert out == main._CODE_HEADLINE


def test_smoke_reason_missing_input_passes_through_calm() -> None:
    # A clean structured reason should remain readable, not be over-scrubbed.
    reason = "Missing required inputs: csv_data (error_code=missing_required_input)"
    out = main.humanize_smoke_reason(reason)
    assert out is not None
    assert "/home" not in out
    assert "error_code=" not in out


def test_smoke_reason_none_and_empty() -> None:
    assert main.humanize_smoke_reason(None) is None
    assert main.humanize_smoke_reason("") is None
    assert main.humanize_smoke_reason("   ") is None


def test_smoke_reason_never_carries_error_code_marker() -> None:
    reason = "boom (error_code=execution_error)"
    out = main.humanize_smoke_reason(reason)
    assert out is not None
    assert "error_code=" not in out


# --------------------------------------------------------------------------
# Batch K / G5 P1-A — operator "Recent logs" panel must not render raw
# Python tracebacks or bare-exception jargon (the e2b stderr leak). The calm
# Error card is the operator surface; raw stays on the debug Raw tab.
# --------------------------------------------------------------------------

def test_log_e2b_stderr_exception_line_collapsed() -> None:
    msg = "[e2b] stderr: TypeError: unsupported operand type(s) for /: 'str' and 'float'"
    out = main._redact_public_log_message(msg)
    assert "unsupported operand" not in out
    assert "TypeError" not in out
    assert "error" in out.lower()


def test_log_traceback_frame_line_collapsed() -> None:
    msg = '[e2b] stderr: File "[worker file]", line 9, in main'
    out = main._redact_public_log_message(msg)
    assert ", line 9" not in out
    assert "[worker file]" not in out


def test_log_traceback_header_collapsed() -> None:
    out = main._redact_public_log_message("Traceback (most recent call last):")
    assert "Traceback" not in out


def test_log_multiline_traceback_block_collapsed_once() -> None:
    block = (
        "E2B sandbox error: Command exited with code 1 and error:\n"
        "Traceback (most recent call last):\n"
        '  File "[worker file]", line 9, in main\n'
        "    main()\n"
        "TypeError: unsupported operand type(s) for /: 'str' and 'float'"
    )
    out = main._redact_public_log_message(block)
    assert "Traceback" not in out
    assert "unsupported operand" not in out
    assert "TypeError" not in out
    # The non-jargon prefix line survives.
    assert "E2B sandbox error" in out
    # One calm note, not five.
    assert out.count("Worker code raised an error") == 1


def test_log_clean_lines_unchanged() -> None:
    for clean in [
        "Run started",
        "Worker completed: 9 words, 44 characters",
        "[e2b] Executing worker command: python run.py",
        "[e2b] Uploaded run.py",
        "Output generated",
    ]:
        assert main._redact_public_log_message(clean) == clean, clean


def test_smoke_reason_bare_keyerror_token_humanized() -> None:
    # A stripped KeyError arg ("'name'") must not leak verbatim on the smoke
    # create surface — it's meaningless to an operator.
    for raw in ["'name'", '"input_file"', "'name' (error_code=execution_error)"]:
        out = main.humanize_smoke_reason(raw)
        assert out == main._CODE_HEADLINE, raw


def test_smoke_reason_strips_leading_code_prefix() -> None:
    # G5-B: the pipeline may build a reason as "<code>: <raw error>" with NO
    # trailing (error_code=…). The leading prefix must be stripped and routed
    # to the calm headline, never leaked verbatim.
    reason = (
        "output_validation_failed: worker reported success "
        "but produced no real output"
    )
    out = main.humanize_smoke_reason(reason)
    assert out == main._OUTPUT_HEADLINE
    assert "output_validation_failed" not in out
    assert "output_validation_failed:" not in out
    assert "produced no real output" not in out


# --------------------------------------------------------------------------
# Batch L / G5 P1 — the residual e2b stderr CODE-ECHO leak. Each stderr line is
# stored as a SEPARATE log row, so the source-line echo, the caret marker
# (~~~^~~~), and the 'Command exited with code N' boilerplate slipped past the
# per-row traceback collapse. _collapse_stderr_code_echo_rows drops them on the
# ordered RAW rows; then per-row redaction calms the frame/header/exception
# rows into ONE note. SSE 'error' now carries the calm Error-card headline.
# --------------------------------------------------------------------------

def _div_by_zero_log_rows() -> list[dict]:
    # The exact verbatim stderr a div-by-zero worker produces, one row per line
    # (e2b_driver._emit_command_output splits + prefixes each line).
    return [
        {"level": "info", "message": "Run started"},
        {"level": "info", "message": "[e2b] Executing worker command: python run.py"},
        {"level": "warning", "message": "[e2b] stderr: Traceback (most recent call last):"},
        {"level": "warning", "message": '[e2b] stderr:   File "/home/user/worker/run.py", line 8, in <module>'},
        {"level": "warning", "message": "[e2b] stderr:     main()"},
        {"level": "warning", "message": '[e2b] stderr:   File "/home/user/worker/run.py", line 4, in main'},
        {"level": "warning", "message": "[e2b] stderr:     quotient = number1 / number2"},
        {"level": "warning", "message": "[e2b] stderr:                ~~~~~~~~^~~~~~~~~"},
        {"level": "warning", "message": "[e2b] stderr: ZeroDivisionError: division by zero"},
        {"level": "warning", "message": "[e2b] stderr: Command exited with code 1"},
    ]


def test_stderr_code_echo_collapsed_and_grep_clean() -> None:
    rows = _div_by_zero_log_rows()
    collapsed = main._collapse_stderr_code_echo_rows(rows)
    final = [main._redact_public_log_message(r["message"]) for r in collapsed]
    joined = "\n".join(final)
    for token in ["~~~", "^~", "quotient", "number1 / number2", "main()", "Command exited", "division by zero", "/home/user"]:
        assert joined.count(token) == 0, f"leaked {token!r}: {joined!r}"
    # The whole traceback block reads as exactly ONE calm note.
    assert joined.count("Worker code raised an error") == 1, joined


def test_stderr_caret_only_line_dropped() -> None:
    rows = [{"message": "[e2b] stderr:                ~~~~~~~~^~~~~~~~~"}]
    assert main._collapse_stderr_code_echo_rows(rows) == []


def test_stderr_command_exit_line_dropped() -> None:
    rows = [{"message": "[e2b] stderr: Command exited with code 1"}]
    assert main._collapse_stderr_code_echo_rows(rows) == []


def test_stderr_collapse_leaves_clean_rows_untouched() -> None:
    clean = [
        {"message": "Run started"},
        {"message": "Worker completed: 9 words, 44 characters"},
        {"message": "[e2b] Executing worker command: python run.py"},
        {"message": "[e2b] Uploaded run.py"},
        {"message": "Output generated"},
    ]
    out = main._collapse_stderr_code_echo_rows([dict(r) for r in clean])
    assert [r["message"] for r in out] == [r["message"] for r in clean]


def test_sse_error_field_maps_to_calm_headline() -> None:
    # SSE finish 'error' must carry the calm Error-card headline, never raw
    # stderr/source/exception/exit boilerplate (G5 P1 SSE leg).
    cases = [
        ("ZeroDivisionError: division by zero", None),
        ("Run failed: division by zero", None),
        ("unsupported operand type(s) for /: 'str' and 'float'", "execution_error"),
        ("Command exited with code 1", None),
        ("[e2b] stderr: Command exited with code 1", None),
        ('E2B sandbox error: KeyError: \'name\' at /home/user/worker/run.py', "e2b_sandbox_error"),
    ]
    for raw, code in cases:
        part = {"type": "finish", "status": "failed", "error": raw, "error_code": code}
        out = main._public_run_part(part)["error"]
        for bad in ["~~~", "^~", "/home/user", "/opt/workeros", "Traceback", "ZeroDivision", "unsupported operand", "Command exited"]:
            assert bad not in out, f"SSE error leaked {bad!r}: {out!r}"


def test_sse_error_field_keeps_clean_input_friendly() -> None:
    # A clean structured failure (missing input) keeps its friendly headline,
    # is NOT over-collapsed into the generic code headline.
    part = {"type": "finish", "status": "failed", "error": "Missing required input: text", "error_code": "missing_required_input"}
    out = main._public_run_part(part)["error"]
    assert "input" in out.lower()
    assert out != main._CODE_HEADLINE


# --------------------------------------------------------------------------
# Batch L / gen-quality — the scalar-vs-file OUTPUT contract. A generated worker
# that writes a PATH into a SCALAR output is a code bug; it must (a) fail
# validation with the explicit reason, (b) route into the bounded smoke-repair
# loop (output_validation_failed in _SMOKE_CODE_FAILURE_CODES), and (c) the
# repair prompt + template must teach scalar=literal-value / file=out/path.
# --------------------------------------------------------------------------

def test_scalar_output_path_string_fails_validation() -> None:
    import run_service as rs
    from models import WorkerConfig

    config = WorkerConfig(
        id="t", name="t", trigger={"type": "manual"},
        runtime={"type": "python", "entrypoint": "run.py"},
        inputs=[],
        outputs=[{"name": "reversed", "type": "string", "kind": "scalar", "required": True, "label": "R"}],
    )
    err, _ = rs._validate_run_outputs("rid", config, {"reversed": "out/reversed.txt"}, [])
    assert err is not None and "scalar output leaked a path string" in err


def test_scalar_output_literal_value_passes_validation() -> None:
    import run_service as rs
    from models import WorkerConfig

    config = WorkerConfig(
        id="t", name="t", trigger={"type": "manual"},
        runtime={"type": "python", "entrypoint": "run.py"},
        inputs=[],
        outputs=[{"name": "reversed", "type": "string", "kind": "scalar", "required": True, "label": "R"}],
    )
    err, _ = rs._validate_run_outputs("rid", config, {"reversed": "olleh"}, [])
    assert err is None


def test_output_validation_failed_routes_to_repair() -> None:
    import run_service as rs

    # The smoke loop treats output_validation_failed as a code-class failure so
    # the generator gets a bounded chance to fix the scalar-vs-file contract,
    # instead of gating on the first try.
    assert "output_validation_failed" in rs._SMOKE_CODE_FAILURE_CODES


def test_smoke_example_output_detects_wrong_median() -> None:
    import run_service as rs
    from models import WorkerConfig, WorkerOutput, WorkerRuntime, WorkerTrigger

    config = WorkerConfig(
        id="median-worker",
        name="Median Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="pure-script", entrypoint="run.py", runner="e2b", mode="pure-script"),
        outputs=[WorkerOutput(name="median", label="Median", type="number", required=True)],
    )
    err = rs._validate_example_output(
        "run_test",
        config,
        {"example_output": "3"},
        {"median": 0.0},
        [],
    )
    assert err is not None
    assert "example_output mismatch" in err
    assert "expected 3" in err


def test_smoke_example_output_accepts_matching_json_object() -> None:
    import run_service as rs
    from models import WorkerConfig, WorkerOutput, WorkerRuntime, WorkerTrigger

    config = WorkerConfig(
        id="stats-worker",
        name="Stats Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="pure-script", entrypoint="run.py", runner="e2b", mode="pure-script"),
        outputs=[
            WorkerOutput(name="median", label="Median", type="number", required=True),
            WorkerOutput(name="count", label="Count", type="number", required=True),
        ],
    )
    err = rs._validate_example_output(
        "run_test",
        config,
        {"example_output": '{"median": 3, "count": 5}'},
        {"median": 3.0, "count": 5},
        [],
    )
    assert err is None


def test_smoke_repair_prompt_teaches_scalar_vs_file_output_contract() -> None:
    import run_service as rs

    prompt = rs._SMOKE_REPAIR_SYSTEM_PROMPT
    assert "scalar output leaked a path string" in prompt
    assert "SCALAR output" in prompt and "FILE output" in prompt
    # Teaches the literal-value rule for scalar outputs.
    assert "LITERAL VALUE" in prompt


def test_template_teaches_scalar_vs_file_output_contract() -> None:
    from pathlib import Path

    api_dir = Path(main.__file__).resolve().parent
    template = (api_dir.parents[1] / "contexts" / "worker-author-style" / "RUN_PY_TEMPLATE.py").read_text()
    assert "OUTPUT CONTRACT" in template
    assert "scalar output leaked a path string" in template
    assert 'outputs={"reversed": "olleh"}' in template
