"""Operator-surface hygiene (G5): nothing internal ever reaches an operator.

Covers the pure mapping helpers added in lane/operator-surface-hygiene:
- _operator_error_message: raw tracebacks / sandbox paths / env-var names map
  to a calm operator headline; already-clean errors pass through.
- _sanitize_operator_text: archive reasons strip env-var names, git branches,
  sandbox paths, tracebacks.
- _has_internal_artifact: detector for the above.
- _is_system_context_pack: engine packs hidden from /contexts.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from test_round8_worker_authz import _load_api  # noqa: E402

# PR #1073 moved the operator-headline constants out of main.py into
# services.public_view; main re-exports its siblings (_TIMEOUT_HEADLINE,
# _RUNTIME_HEADLINE, _CODE_HEADLINE, ...) but the re-export list dropped
# _SANDBOX_HEADLINE. Read it from its real home so the test is robust to the
# re-export gap; the behavior (_operator_error_message mapping) is unchanged.
from services.public_view import _SANDBOX_HEADLINE  # noqa: E402


@pytest.fixture()
def api(monkeypatch, tmp_path):
    return _load_api(monkeypatch, tmp_path)


SYNTAX_TRACE = (
    "Command exited with code 1 and error: Traceback (most recent call last):\n"
    '  File "/home/user/worker/run.py", line 22\n'
    "    headers = {'Authorization': f'Bearer {os.getenv('GOOGLE_SHEETS_TOKEN')}'}\n"
    "SyntaxError: f-string: unmatched '('"
)

GENERIC_TRACE = (
    "Command exited with code 1 and error: Traceback (most recent call last):\n"
    '  File "/home/user/worker/run.py", line 14, in create_digest\n'
    "    digest += f\"- [{pr['title']}]\"\n"
    "KeyError: 'title'"
)


def test_internal_artifacts_detected(api):
    assert api._has_internal_artifact(SYNTAX_TRACE)
    assert api._has_internal_artifact("uses GOOGLE_SHEETS_TOKEN")
    assert api._has_internal_artifact("/home/user/worker/run.py")
    assert api._has_internal_artifact("fixed in lane/reliability-2026-05-29")
    assert not api._has_internal_artifact("Missing required inputs: prospect_name")
    assert not api._has_internal_artifact("This worker is no longer accepting input.")


def test_syntax_error_maps_to_operator_headline(api):
    msg = api._operator_error_message(SYNTAX_TRACE)
    assert "code" in msg.lower()
    # No leak of traceback, path, env-var, or "SyntaxError".
    assert "Traceback" not in msg
    assert "/home/user" not in msg
    assert "GOOGLE_SHEETS_TOKEN" not in msg
    assert "SyntaxError" not in msg
    assert "run.py" not in msg


def test_generic_traceback_maps_and_hides_internals(api):
    msg = api._operator_error_message(GENERIC_TRACE)
    assert msg
    assert "Traceback" not in msg
    assert "/home/user" not in msg
    assert "KeyError" not in msg


def test_clean_error_passes_through(api):
    clean = "Missing required inputs: prospect_name"
    assert api._operator_error_message(clean) == clean


def test_empty_error_returns_none(api):
    assert api._operator_error_message(None) is None
    assert api._operator_error_message("") is None
    assert api._operator_error_message("   ") is None


def test_sanitize_archive_reason_strips_internals(api):
    raw = (
        "APIFY_API_KEY free credits exhausted (locked until 2026-06-25). "
        "Worker code is correct; KeyError guard added in lane/reliability-2026-05-29."
    )
    cleaned = api._sanitize_operator_text(raw)
    assert "APIFY_API_KEY" not in cleaned
    assert "lane/reliability-2026-05-29" not in cleaned
    assert "lane/" not in cleaned
    assert cleaned.endswith(".")


def test_sanitize_clean_reason_unchanged(api):
    clean = "Paused — needs the customer's Slack and Notion accounts connected."
    assert api._sanitize_operator_text(clean) == clean


def test_sanitize_none(api):
    assert api._sanitize_operator_text(None) is None
    assert api._sanitize_operator_text("") is None


# ---------------------------------------------------------------------------
# G5 residual P1: artifact-free runtime/sandbox jargon must NOT leak verbatim.
# The two strings confirmed leaking live on prod + a generic-code fallback.
# ---------------------------------------------------------------------------

EVENT_LOOP_CLOSED = "Event loop is closed"
E2B_DEADLINE = (
    "context deadline exceeded: This error is likely due to exceeding 'timeout' "
    "— the total time a long running request (like process or directory watch) "
    "can be active. It can be modified by passing 'timeout' when making the "
    "request. Use '0' to disable the timeout."
)


def test_event_loop_closed_does_not_leak(api):
    # Confirmed live leak: run_12f326066d87, error_code agent_runtime_error.
    msg = api._operator_error_message(EVENT_LOOP_CLOSED, "agent_runtime_error")
    assert "Event loop is closed" not in msg
    assert msg == api._RUNTIME_HEADLINE
    # Even without the code, the free-text/jargon guard must catch it.
    msg_no_code = api._operator_error_message(EVENT_LOOP_CLOSED)
    assert "Event loop is closed" not in msg_no_code


def test_e2b_deadline_does_not_leak(api):
    # Confirmed live leak: run_279270f792f5, error_code e2b_sandbox_error.
    msg = api._operator_error_message(E2B_DEADLINE, "e2b_sandbox_error")
    assert "context deadline exceeded" not in msg
    assert "process or directory watch" not in msg
    assert "use '0'" not in msg.lower()
    assert msg == _SANDBOX_HEADLINE
    # Without the code, the jargon guard + free-text timeout rule still catch it.
    msg_no_code = api._operator_error_message(E2B_DEADLINE)
    assert "context deadline exceeded" not in msg_no_code
    assert "process or directory watch" not in msg_no_code
    assert msg_no_code == api._TIMEOUT_HEADLINE


def test_unknown_error_code_gets_generic_headline(api):
    # Any code not in the taxonomy must still yield a calm headline, never raw.
    msg = api._operator_error_message("some weird internal RuntimeError blob", "totally_new_code")
    assert msg
    assert "RuntimeError" not in msg
    assert msg in {api._RUNTIME_HEADLINE, api._OPERATOR_ERROR_GENERIC, api._CALM_CODE_ERROR_LOG}


def test_known_codes_map_to_calm_headlines(api):
    # Spot-check the taxonomy mapping is wired and headlines are operator-grade.
    assert api._operator_error_message(None, "missing_connection") == api._CONNECTION_HEADLINE
    assert api._operator_error_message(None, "missing_secret") == api._SECRET_HEADLINE
    assert api._operator_error_message(None, "output_validation_failed") == api._OUTPUT_HEADLINE
    assert api._operator_error_message(None, "timeout") == api._TIMEOUT_HEADLINE
    for headline in api._OPERATOR_ERROR_CODE_HEADLINES.values():
        assert "Traceback" not in headline
        assert "/home" not in headline
        assert "asyncio" not in headline.lower()


def test_file_input_sha_message_humanized(api):
    raw = "File input 'csv_file': value must be a SHA-256 reference from /uploads, got non-SHA value"
    msg = api._operator_error_message(raw, "missing_required_input")
    assert "SHA-256" not in msg
    assert "/uploads" not in msg
    msg_no_code = api._operator_error_message(raw)
    assert "SHA-256" not in msg_no_code
    assert "/uploads" not in msg_no_code


def test_clean_structured_error_still_passes_through(api):
    # Regression: operator-clean structured messages must still show verbatim.
    clean = "Invalid value 'en'; expected one of: english, french"
    assert api._operator_error_message(clean) == clean
    assert api._operator_error_message("Missing required inputs: prospect_name") == (
        "Missing required inputs: prospect_name"
    )


def test_run_error_raw_kept_only_when_rewritten(api):
    # Rewritten -> raw preserved for the debug tab.
    raw = api._run_error_raw(EVENT_LOOP_CLOSED, "agent_runtime_error")
    assert raw and "Event loop is closed" in raw
    # Clean passthrough -> nothing extra to keep.
    assert api._run_error_raw("Missing required inputs: prospect_name") is None
    assert api._run_error_raw(None) is None
    assert api._run_error_raw("") is None


def test_run_error_raw_strips_filesystem_paths(api):
    # FIX 5 (2026-05-29): error_raw must never carry a real filesystem path —
    # not the sandbox path nor the server path. The headline behavior is
    # unchanged; only the debug 'Raw' tab string is path-stripped.
    sandbox_raw = api._run_error_raw(SYNTAX_TRACE, "execution_error")
    assert sandbox_raw is not None
    assert "/home/user" not in sandbox_raw
    assert "/home/user/worker/run.py" not in sandbox_raw

    server_raw = api._run_error_raw(
        "Command exited with code 1 and error: Traceback (most recent call last):\n"
        '  File "/root/workeros/apps/api/run_service.py", line 10\n'
        "RuntimeError: boom",
        "run_execution_exception",
    )
    assert server_raw is not None
    assert "/root/workeros" not in server_raw


# ---------------------------------------------------------------------------
# Fix 4 (2026-05-29): a worker's OWN code crash must read as a CODE error the
# operator can fix/re-generate — NOT a platform "internal error", and NEVER
# "took too long". The E2B driver wraps such crashes as execution_error
# (non-zero exit) or e2b_sandbox_error with the exception class in the raw text.
# ---------------------------------------------------------------------------

NAMEERROR_CRASH = "Worker exited with code 1: NameError: name 'os' is not defined"
FILE_NOT_FOUND_CRASH = (
    "Worker exited with code 1: FileNotFoundError: [Errno 2] No such file or "
    "directory: 'inputs/text_block'"
)


def test_execution_error_with_nameerror_maps_to_code_headline(api):
    # Was the launch blocker: generated worker crashed with NameError but the
    # operator saw the generic "internal error" headline, not a code error.
    msg = api._operator_error_message(NAMEERROR_CRASH, "execution_error")
    assert msg == api._CODE_HEADLINE
    assert "NameError" not in msg
    assert "code" in msg.lower()


def test_filenotfound_crash_maps_to_code_headline(api):
    # FileNotFoundError (scalar input wrongly open()ed) — was unmatched/generic.
    msg = api._operator_error_message(FILE_NOT_FOUND_CRASH, "execution_error")
    assert msg == api._CODE_HEADLINE
    assert "FileNotFoundError" not in msg
    assert "inputs/text_block" not in msg


def test_worker_code_crash_not_shown_as_timeout(api):
    # A fast crash classified e2b_sandbox_error must NOT say "took too long".
    msg = api._operator_error_message(NAMEERROR_CRASH, "e2b_sandbox_error")
    assert msg == api._CODE_HEADLINE
    assert msg != api._TIMEOUT_HEADLINE
    assert "too long" not in msg.lower()


def test_real_timeout_still_maps_to_timeout(api):
    # The runner now classifies near-cap worker timeouts as error_code=timeout.
    msg = api._operator_error_message(E2B_DEADLINE, "timeout")
    assert msg == api._TIMEOUT_HEADLINE


def test_codeless_worker_traceback_maps_to_code_headline(api):
    # No error_code at all but a worker exception class in the raw -> code error.
    msg = api._operator_error_message(GENERIC_TRACE)  # KeyError traceback
    assert msg == api._CODE_HEADLINE


def test_setup_codes_unaffected_by_worker_code_detector(api):
    # missing_secret / missing_connection never carry a traceback; even if the
    # raw text mentioned an exception word, the setup headline must win.
    assert api._operator_error_message(None, "missing_secret") == api._SECRET_HEADLINE
    assert api._operator_error_message(None, "missing_connection") == api._CONNECTION_HEADLINE


def test_system_context_pack_hidden(api):
    assert api._is_system_context_pack("worker-author-style")
    assert not api._is_system_context_pack("my-operator-pack")


def test_system_context_pack_via_metadata(api):
    meta = {"some-pack": {"system": True}}
    assert api._is_system_context_pack("some-pack", meta)
    assert not api._is_system_context_pack("other-pack", meta)
