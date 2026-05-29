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
    assert "/root/workeros" not in error_raw


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
    msg = "wrote /root/workeros/data/artifacts/run_x/out/sorted.csv"
    redacted = main._redact_public_log_message(msg)
    assert "/root/workeros" not in redacted


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
    assert "/root/workeros" not in out
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
