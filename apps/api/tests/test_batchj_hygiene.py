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
    msg = 'File "/home/user/worker/run.py", line 12, in <module>'
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
