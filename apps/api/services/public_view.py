"""Public-facing log/error redaction and SSE event shaping.

Extracted from main.py as a cohesive cluster (AST-verified closed). These helpers
strip internal jargon, sandbox paths, secrets and tracebacks from anything shown
to operators, derive operator-facing error headlines, and shape the public SSE
event / run-part payloads. Consumed by the run streaming + run-detail routes.

Pure text processing on stdlib + precompiled regex; get_db and the SSE
_TERMINAL_STATUSES set are imported lazily (main/db are reloaded between tests).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi.responses import JSONResponse

logger = logging.getLogger("floom.api")


def _public_noindex_headers() -> Dict[str, str]:
    return {
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "no-store",
    }


def _json_noindex(payload: Dict[str, Any], *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status_code, headers=_public_noindex_headers())


# ---------------------------------------------------------------------------
# Redaction patterns and operator-error rules (moved verbatim from main.py)
# ---------------------------------------------------------------------------

_INTERNAL_LOG_TOKEN_RE = re.compile(
    r"\b(?:trace_[A-Za-z0-9_.:-]+|(?:thread|step|run|call|msg|tool)_[A-Za-z0-9][A-Za-z0-9_-]{7,})\b"
)

_LOG_METADATA_RE = re.compile(r"\b(?:mode|runner)=[^\s,;]+", re.IGNORECASE)

_MISSING_SECRETS_RE = re.compile(r"Missing secrets?:\s*[A-Z0-9_, ]+", re.IGNORECASE)

_ENV_SECRET_CONFIG_RE = re.compile(
    r"\b[A-Z][A-Z0-9]{1,63}(?:_[A-Z0-9]{1,64})+\b(?:\s+is)?\s+(?:not set|not configured|missing)\b(?:\.[^\n]*)?",
    re.IGNORECASE,
)

_CALM_CODE_ERROR_LOG = "Worker code raised an error (see the Error card for details)."

_TRACEBACK_FRAME_LINE_RE = re.compile(r'File\s+"[^"]*",\s*line\s+\d+', re.IGNORECASE)

_TRACEBACK_HEADER_RE = re.compile(r"Traceback \(most recent call last\)", re.IGNORECASE)

_CARET_ONLY_RE = re.compile(r"^[\s~^|+]*[~^][\s~^|+]*$")

_COMMAND_EXIT_RE = re.compile(r"\bCommand exited with code\s+\d+\b", re.IGNORECASE)

_E2B_LOG_PREFIX_RE = re.compile(r"^\[e2b\](?:\s+stderr:)?\s*")

_SANDBOX_PATH_RE = re.compile(r"(?:/(?:home|root|tmp|usr|opt|app|workspace)\b[^\s\"']*)")

_ENV_VAR_NAME_RE = re.compile(r"\b[A-Z][A-Z0-9]{1,40}(?:_[A-Z0-9]{1,40}){1,8}\b")

_GIT_BRANCH_RE = re.compile(
    r"\b(?:lane|feat|feature|fix|hotfix|chore|recover|docs|polish|backend|land)/[A-Za-z0-9._/-]+"
)

_TIMEOUT_HEADLINE = "This worker took too long and was stopped. Try again, or simplify the input."

_RUNTIME_HEADLINE = (
    "This worker hit an internal error and stopped. Check the run logs, then edit or re-run the worker."
)

_CONNECTION_HEADLINE = "This worker needs an account connected before it can run. Connect it, then re-run."

_AUTH_HEADLINE = "A connected account or key was rejected. Reconnect the account this worker uses, then re-run."

_INPUT_HEADLINE = "This worker is missing a required input. Add it, then re-run."

_SECRET_HEADLINE = "This worker is missing a required credential. Add it in settings, then re-run."

_OUTPUT_HEADLINE = "This worker finished but its result didn't pass validation. Check the run logs, then re-run."

_CODE_HEADLINE = "This worker's code has an error and couldn't run. Edit the worker to fix it, or re-generate it."

_CANCELLED_HEADLINE = "This run was cancelled before it finished."

_SANDBOX_HEADLINE = "The sandbox could not start or stay connected. Try again, then check the E2B configuration if it repeats."

_OPERATOR_ERROR_CODE_HEADLINES: Dict[str, str] = {
    # Runtime / agent / sandbox internals (the residual G5 leak class).
    "agent_runtime_error": _RUNTIME_HEADLINE,
    "run_execution_exception": _RUNTIME_HEADLINE,
    "execution_error": _RUNTIME_HEADLINE,
    "skill_runtime_error": _RUNTIME_HEADLINE,
    "openai_call_failed": _RUNTIME_HEADLINE,
    "interrupted_by_restart": "This run was interrupted while the service restarted. Re-run the worker.",
    "context_mount_failed": _RUNTIME_HEADLINE,
    "mcp_connect_failed": _CONNECTION_HEADLINE,
    # Sandbox / timeout / resource.
    "e2b_sandbox_error": _SANDBOX_HEADLINE,
    "timeout": _TIMEOUT_HEADLINE,
    "sandbox_oom": "This worker ran out of memory and was stopped. Try simplifying the input.",
    "token_cap_exceeded": "This worker reached its output limit and was stopped. Try simplifying the task.",
    "tool_iteration_cap_exceeded": "This worker took too many steps and was stopped. Try simplifying the task.",
    "tool_loop_exhausted": "This worker took too many steps and was stopped. Try simplifying the task.",
    "missing_e2b_key": _RUNTIME_HEADLINE,
    # Setup / configuration.
    "missing_connection": _CONNECTION_HEADLINE,
    "missing_secret": _SECRET_HEADLINE,
    "missing_required_input": _INPUT_HEADLINE,
    "install_failed": "This worker is missing a required package. Add it to the worker's requirements and re-run.",
    "invalid_worker": _CODE_HEADLINE,
    "skill_not_found": _CODE_HEADLINE,
    "worker_not_found": "This worker no longer exists.",
    "worker_disabled": "This worker is paused. Turn it on to run it again.",
    "worker_deleted": "This worker was deleted while the run was still active.",
    "file_input_resolution_failed": "This worker needs a valid uploaded file for one of its inputs. Upload the file, then re-run.",
    # Output / result.
    "output_validation_failed": _OUTPUT_HEADLINE,
    "schema_violation": _OUTPUT_HEADLINE,
    "quality_gate_failed": "This worker's result didn't meet its quality bar. Check the run logs, then re-run.",
    "missing_result": "This worker finished but didn't produce a result. Check the run logs, then re-run.",
    # Cancellation (not a true failure; kept calm).
    "cancelled": _CANCELLED_HEADLINE,
    "cancelled_queued": _CANCELLED_HEADLINE,
    "cancelled_before_start": _CANCELLED_HEADLINE,
    "approval_expired": "This run waited for approval too long and expired. Re-run it to request a fresh approval.",
    "unknown_error": "This worker failed to run. Check the run logs for details, then edit or re-run the worker.",
}

_OPERATOR_ERROR_GENERIC = (
    "This worker failed to run. Check the run logs for details, then edit or re-run the worker."
)

_OPERATOR_ERROR_RULES: List[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bSyntaxError\b|\bIndentationError\b", re.IGNORECASE),
     _CODE_HEADLINE),
    (re.compile(r"\bModuleNotFoundError\b|\bImportError\b", re.IGNORECASE),
     "This worker is missing a required package. Add it to the worker's requirements and re-run."),
    (re.compile(r"\b(?:401|403|Unauthorized|Forbidden|invalid[_ ]?token|authentication)\b", re.IGNORECASE),
     _AUTH_HEADLINE),
    (re.compile(r"Event loop is closed|\basyncio\b|coroutine|RuntimeError", re.IGNORECASE),
     _RUNTIME_HEADLINE),
    (re.compile(
        r"\bKeyError\b|\bNameError\b|\bAttributeError\b|\bTypeError\b|\bValueError\b"
        r"|\bFileNotFoundError\b|\bUnboundLocalError\b|\bIndexError\b|\bOSError\b",
        re.IGNORECASE,
     ),
     _CODE_HEADLINE),
    (re.compile(r"\b(?:Timed?\s?out|timeout|deadline exceeded)\b", re.IGNORECASE),
     _TIMEOUT_HEADLINE),
    (re.compile(r"\b(?:Connection|Network|DNS|getaddrinfo|ECONN|socket)\b", re.IGNORECASE),
     "This worker couldn't reach an external service. Check the connection, then re-run."),
    (re.compile(r"SHA-256 reference|from /uploads", re.IGNORECASE),
     "This worker needs a file uploaded for one of its inputs. Upload the file, then re-run."),
]

_WORKER_CODE_TRACEBACK_RE = re.compile(
    r"\b(?:"
    r"NameError|FileNotFoundError|AttributeError|TypeError|ValueError|KeyError"
    r"|UnboundLocalError|IndexError|ZeroDivisionError|NotImplementedError|RuntimeError"
    r"|SyntaxError|IndentationError|TabError|RecursionError|AssertionError"
    r"|ModuleNotFoundError|ImportError|OSError|IOError|JSONDecodeError"
    r"|UnicodeDecodeError|UnicodeEncodeError"
    r")\b"
)

_BARE_PYTHON_EXC_MSG_RE = re.compile(
    r"(?i:"
    r"unsupported operand type\(s\)"
    r"|can't multiply sequence by non-int"
    r"|cannot multiply sequence by non-int"
    r"|object cannot be interpreted as an integer"
    r"|object is not (?:subscriptable|callable|iterable|reversible)"
    r"|object has no attribute"
    r"|object of type .* has no len"
    r"|(?:list|string|tuple|dict) index out of range"
    r"|index out of range"
    r"|division by zero"
    r"|float division by zero"
    r"|integer division or modulo by zero"
    r"|cannot unpack non-iterable"
    r"|(?:not enough|too many) values to unpack"
    r"|takes (?:no|exactly|at least|at most|from) .* argument"
    r"|missing \d+ required (?:positional|keyword-only) argument"
    r"|got an unexpected keyword argument"
    r"|positional argument(?:s)? but \d+ (?:was|were) given"
    r"|could not convert string to float"
    r"|invalid literal for int\(\) with base"
    r"|string indices must be integers"
    r"|'[^']*' is not defined"
    r"|name '[^']*' is not defined"
    r"|can only concatenate"
    r"|unhashable type"
    r"|'NoneType' object"
    r")"
)

_WORKER_CODE_ERROR_CODES = frozenset({"execution_error", "e2b_sandbox_error", "timeout"})

_SMOKE_REASON_CODE_RE = re.compile(r"\s*\(error_code=([A-Za-z0-9_]+)\)\s*$")

_SMOKE_REASON_LEADING_CODE_RE = re.compile(r"^([a-z][a-z0-9_]+):\s*")

_RUNTIME_JARGON_RE = re.compile(
    r"(?i:Event loop is closed"
    r"|context deadline exceeded"
    r"|process or directory watch"
    r"|use '0' to disable"
    r"|\basyncio\b"
    r"|\bcoroutine\b"
    r"|SHA-256 reference"
    r"|\bTraceback\b)"
    # Bare Python exception class names (RuntimeError, KeyError, …) are jargon
    # even without a traceback wrapper. CamelCase, case-sensitive, so we do NOT
    # eat the ordinary lowercase word "error" in a clean operator message.
    r"|\b[A-Z][A-Za-z0-9]*(?:Error|Exception)\b",
)


def _e2b_log_content(message: str) -> str:
    """Content of an e2b log row with the streaming channel prefix removed."""
    return _E2B_LOG_PREFIX_RE.sub("", str(message or "")).strip()


def _is_caret_marker_line(message: str) -> bool:
    content = _e2b_log_content(message)
    return bool(content) and bool(_CARET_ONLY_RE.match(content))


def _is_command_exit_line(message: str) -> bool:
    return bool(_COMMAND_EXIT_RE.search(_e2b_log_content(message)))


def _collapse_stderr_code_echo_rows(
    rows: List[Dict[str, Any]], message_key: str = "message"
) -> List[Dict[str, Any]]:
    """Drop the residual e2b stderr code-echo from an ORDERED list of RAW log-row
    dicts (call this BEFORE per-row redaction so the 'File ... line N' frame and
    caret anchors are still intact). Anchored on the two unambiguous traceback
    markers Python emits, so it is leak-proof with no false positives:

      - a 'File "...", line N' FRAME row -> the row DIRECTLY AFTER it is the
        echoed source line (Python prints frame then source); drop the echo,
      - a CARET row ('~~~^~~~') -> drop it AND the row directly above it (the
        echoed source line, when not already dropped),
      - a 'Command exited with code N' row -> drop it.

    The frame row / traceback header / exception line themselves are left in
    place — per-row redaction (run AFTER this) collapses them into the single
    calm 'Worker code raised an error' note. Clean rows ('Run started',
    'Worker completed: 9 words') never match these anchors, so they pass through.
    Preserves level/timestamp on surviving rows."""
    n = len(rows)
    drop = [False] * n
    msgs = [str(row.get(message_key) or "") for row in rows]
    for i, msg in enumerate(msgs):
        content = _e2b_log_content(msg)
        if _is_caret_marker_line(msg):
            drop[i] = True
            if i > 0 and not drop[i - 1]:
                drop[i - 1] = True
        elif _is_command_exit_line(msg):
            drop[i] = True
        elif _TRACEBACK_FRAME_LINE_RE.search(content):
            # The line Python prints directly under a frame is the echoed
            # source. Only drop it if it is itself a stderr/e2b row (so we never
            # eat an unrelated subsequent log line) and not already a frame.
            if i + 1 < n:
                nxt = msgs[i + 1]
                nxt_content = _e2b_log_content(nxt)
                is_e2b_row = _E2B_LOG_PREFIX_RE.match(nxt) is not None
                if (
                    is_e2b_row
                    and not _TRACEBACK_FRAME_LINE_RE.search(nxt_content)
                    and not _TRACEBACK_HEADER_RE.search(nxt_content)
                    and not _WORKER_CODE_TRACEBACK_RE.search(nxt_content)
                    and not _is_caret_marker_line(nxt)
                    and not _is_command_exit_line(nxt)
                ):
                    drop[i + 1] = True
    survivors = [row for i, row in enumerate(rows) if not drop[i]]
    # Dedupe CONSECUTIVE rows that per-row redaction will collapse into the same
    # calm note (the traceback header + each frame + the exception line each
    # become _CALM_CODE_ERROR_LOG), so the operator panel shows ONE calm note
    # for the whole traceback block, not five. Only collapses adjacent rows that
    # ALREADY redact to the calm note; unrelated rows are never merged.
    deduped: List[Dict[str, Any]] = []
    prev_calm = False
    for row in survivors:
        redacts_calm = (
            _redact_public_log_message(str(row.get(message_key) or "")) == _CALM_CODE_ERROR_LOG
        )
        if redacts_calm and prev_calm:
            continue
        deduped.append(row)
        prev_calm = redacts_calm
    return deduped


def _redact_runtime_jargon_in_log(message: str) -> str:
    """Collapse Python traceback frames + bare-exception jargon in an operator
    log line into a single calm note (G5 P1-A). The raw text stays available to
    engineers on the run's debug 'Raw' tab (error_raw); the operator-facing log
    surface must read like the calm Error card, never a Python traceback.

    Line-aware so a normal log line ('Worker completed: 9 words') is untouched."""
    if not message:
        return message
    lines = message.splitlines()
    if len(lines) <= 1:
        text = message.strip()
        # Single-line: only rewrite when it is unmistakably runtime jargon
        # (traceback header, a frame line, an exception class/message). A clean
        # operator log line never matches these.
        if (
            _TRACEBACK_HEADER_RE.search(text)
            or _TRACEBACK_FRAME_LINE_RE.search(text)
            or _WORKER_CODE_TRACEBACK_RE.search(text)
            or _BARE_PYTHON_EXC_MSG_RE.search(text)
        ):
            return _CALM_CODE_ERROR_LOG
        return message
    out: List[str] = []
    collapsed = False
    for line in lines:
        if (
            _TRACEBACK_HEADER_RE.search(line)
            or _TRACEBACK_FRAME_LINE_RE.search(line)
            or _WORKER_CODE_TRACEBACK_RE.search(line)
            or _BARE_PYTHON_EXC_MSG_RE.search(line)
        ):
            # Emit ONE calm note for the whole traceback block, drop the rest.
            if not collapsed:
                out.append(_CALM_CODE_ERROR_LOG)
                collapsed = True
            continue
        out.append(line)
    return "\n".join(out).strip() or _CALM_CODE_ERROR_LOG


def _redact_public_log_message(message: str) -> str:
    redacted = _MISSING_SECRETS_RE.sub("Missing required secrets", message or "")
    redacted = _ENV_SECRET_CONFIG_RE.sub("Required platform secret is not configured", redacted)
    redacted = _INTERNAL_LOG_TOKEN_RE.sub("[redacted-id]", redacted)
    redacted = _LOG_METADATA_RE.sub("[redacted-metadata]", redacted)
    # PATH-1 (2026-05-29): logs[].message still leaked host paths
    # (/root/workeros/...) and sandbox paths (/home/user/worker/run.py),
    # unlike error_raw which already strips them. Apply the SAME redaction so
    # the log surface never discloses the deploy dir or sandbox topology.
    redacted = _SANDBOX_PATH_RE.sub("[worker file]", redacted)
    # G5 P1-A (2026-05-29): the e2b driver streams the worker's raw stderr
    # (Traceback + 'TypeError: unsupported operand ...') into the run logs. The
    # "Recent logs" panel rendered that verbatim, undercutting the calm Error
    # card. Collapse runtime jargon/tracebacks into one calm note here — the
    # single chokepoint for every operator-facing log read.
    redacted = _redact_runtime_jargon_in_log(redacted)
    return redacted


def _public_artifact_path(raw_path: Optional[str]) -> str:
    """Return an artifact path safe to expose in an API response (PATH-1).

    The artifacts table stores the absolute host path
    (e.g. /root/workeros/data/artifacts/run_x/out/sorted.csv). Returning it
    discloses the deploy dir + storage layout. Strip the artifacts-root prefix
    so callers see only the relative path (run_x/out/sorted.csv). The download
    endpoint resolves the real on-disk path server-side from the artifact id,
    so relativising here does not break downloads.
    """
    raw = str(raw_path or "").strip()
    if not raw:
        return ""
    try:
        from runner_utils import ARTIFACTS_DIR

        resolved = Path(raw).resolve()
        rel = resolved.relative_to(ARTIFACTS_DIR.resolve())
        return rel.as_posix()
    except Exception:
        # Not under the artifacts root (or unresolvable) — never leak an
        # absolute path; fall back to the basename only.
        return Path(raw).name


def _looks_like_worker_code_error(text: str) -> bool:
    """True when the raw error text contains a Python exception class raised by
    the worker's own code (so the operator headline should be _CODE_HEADLINE).

    Also matches BARE exception messages that carry no class name (a stringified
    TypeError/ValueError message), which the class-name regex would otherwise
    miss and let leak verbatim to the operator surface."""
    if not text:
        return False
    return bool(
        _WORKER_CODE_TRACEBACK_RE.search(text)
        or _BARE_PYTHON_EXC_MSG_RE.search(text)
    )


def _has_internal_artifact(text: str) -> bool:
    """True when the string contains a traceback, sandbox path, env-var name,
    or git branch — anything that must never reach an operator surface."""
    if not text:
        return False
    if "Traceback (most recent call last)" in text:
        return True
    if _SANDBOX_PATH_RE.search(text):
        return True
    if _GIT_BRANCH_RE.search(text):
        return True
    if _ENV_VAR_NAME_RE.search(text):
        return True
    return False


def _operator_error_message(
    raw_error: Optional[str], error_code: Optional[str] = None
) -> Optional[str]:
    """Map a run error to a calm, operator-readable headline.

    Resolution order (so NO raw runtime/sandbox jargon ever reaches an operator,
    even when the raw string carries no traceback/path/env-var artifact):

    1. Structured ``error_code`` taxonomy (PRIMARY). The pipeline classifies
       every failure into a known code; we map the code to a fixed headline.
    2. A small set of operator-clean structured messages that are safe to show
       verbatim ("Missing required inputs: prospect_name", "Invalid value 'en';
       expected one of: …", etc.) pass through unchanged.
    3. Free-text rules (``_OPERATOR_ERROR_RULES``) for codeless errors.
    4. Generic fallback. Never the raw string when it looks like jargon.

    Returns None when raw_error is empty.
    """
    code = (error_code or "").strip().lower()

    # A worker's OWN code crash must read as a CODE error (fixable / re-generable),
    # not a platform "internal error" and never "took too long". When the raw text
    # carries a Python exception class AND the code is one that wraps worker
    # execution (execution_error / e2b_sandbox_error) or is absent, route to the
    # code headline before the generic taxonomy. Setup codes (missing_secret,
    # missing_connection, etc.) are unaffected — they never carry a traceback.
    if (not code or code in _WORKER_CODE_ERROR_CODES) and _looks_like_worker_code_error(str(raw_error or "")):
        return _CODE_HEADLINE

    if code and code in _OPERATOR_ERROR_CODE_HEADLINES:
        return _OPERATOR_ERROR_CODE_HEADLINES[code]

    if raw_error is None:
        # No raw text but an unrecognised code -> generic operator headline.
        return _OPERATOR_ERROR_GENERIC if code else None
    text = str(raw_error).strip()
    if not text:
        return _OPERATOR_ERROR_GENERIC if code else None

    # Light log redaction first (maps "Missing secrets: X" -> generic, etc.).
    redacted = _redact_public_log_message(text)

    # Operator-clean structured messages may pass through verbatim ONLY when
    # they carry no internal artifact AND are not raw runtime/sandbox jargon.
    if not _has_internal_artifact(redacted) and not _looks_like_runtime_jargon(redacted):
        return redacted

    # Free-text fallback for codeless / unrecognised-code errors.
    for pattern, message in _OPERATOR_ERROR_RULES:
        if pattern.search(text):
            return message
    return _OPERATOR_ERROR_GENERIC


def humanize_smoke_reason(reason: Optional[str]) -> Optional[str]:
    """Calm, operator-safe rendering of a smoke `reason` string.

    Splits off the trailing "(error_code=…)" the smoke pipeline appends, then
    routes the raw text + code through the SAME operator-headline/redaction path
    used for run errors. Guarantees no sandbox path or raw Python jargon escapes
    on the create/SSE surfaces (G5 P1-A)."""
    if reason is None:
        return None
    text = str(reason).strip()
    if not text:
        return None
    code: Optional[str] = None
    m = _SMOKE_REASON_CODE_RE.search(text)
    if m:
        code = m.group(1)
        if code.lower() in ("unknown", "none", ""):
            code = None
        text = _SMOKE_REASON_CODE_RE.sub("", text).strip()
    # No trailing code? The pipeline may instead prefix the reason as
    # "<code>: <raw error>" (e.g. "output_validation_failed: …"). Treat the
    # leading prefix as the code and strip it so it never reaches the operator
    # verbatim, then route through the same headline/redaction path.
    if code is None:
        lead = _SMOKE_REASON_LEADING_CODE_RE.match(text)
        if lead:
            lead_code = lead.group(1)
            if lead_code.lower() not in ("unknown", "none", ""):
                code = lead_code
            text = _SMOKE_REASON_LEADING_CODE_RE.sub("", text).strip()
    # A bare quoted token (e.g. "'name'") is a stripped KeyError arg — meaningless
    # to an operator. Treat it as a worker-code error rather than letting the bare
    # key pass through verbatim.
    if re.fullmatch(r"""['"][^'"]*['"]""", text):
        return _CODE_HEADLINE
    headline = _operator_error_message(text, code)
    if headline is None:
        # No raw text resolved to a headline; never return the raw string —
        # scrub any residual path/jargon defensively.
        return _redact_public_log_message(text) or _OPERATOR_ERROR_GENERIC
    return headline


def _looks_like_runtime_jargon(text: str) -> bool:
    """True for artifact-free strings that are still pure runtime/sandbox jargon
    (e.g. 'Event loop is closed', E2B deadline boilerplate). These must not pass
    through verbatim to the operator surface.

    Also true for bare Python exception MESSAGES with no class name
    ("unsupported operand type(s) for /: 'str' and 'float'") so they never leak
    verbatim when an error_code is missing or unrecognised (P0-2)."""
    if not text:
        return False
    return bool(
        _RUNTIME_JARGON_RE.search(text) or _BARE_PYTHON_EXC_MSG_RE.search(text)
    )


def _run_error_raw(
    raw_error: Optional[str], error_code: Optional[str] = None
) -> Optional[str]:
    """Redacted raw error for the debug 'Raw' tab. Returned only when the
    operator-facing headline differs from the raw text (i.e. we rewrote it),
    so engineers can still inspect what really happened. When the raw text is
    already operator-clean and shown verbatim, there is nothing extra to keep."""
    raw = str(raw_error or "").strip()
    if not raw:
        return None
    headline = _operator_error_message(raw, error_code)
    if headline is None or headline == raw:
        return None
    redacted = _redact_public_log_message(raw)
    # FIX 5 (2026-05-29): the debug 'Raw' tab still leaked real filesystem paths
    # (sandbox /home/user/worker/, server /root/workeros/...). error_raw must
    # never carry a real path. Strip them — the operator headline is unchanged.
    redacted = _SANDBOX_PATH_RE.sub("[worker file]", redacted)
    return redacted or None


def _public_error_field(raw_error: Any, error_code: Any = None) -> str:
    """Map a part/event 'error' field to the calm operator HEADLINE — the SAME
    text the Error card and GET /runs error show (G5 P1). Before this, the SSE
    finish 'error' was only path/traceback-scrubbed (_redact_public_log_message),
    so a bare 'ZeroDivisionError: division by zero' / 'Run failed: <raw>' read as
    jargon to a recruiter. Now it carries the headline, then the redactor as a
    belt-and-braces fallback so no internal artifact can ever slip through."""
    raw = str(raw_error or "")
    # A bare 'Command exited with code N' is the non-zero-exit signal of a
    # crashed worker — calm it like any other code error before mapping.
    if _COMMAND_EXIT_RE.search(_e2b_log_content(raw)) and not _looks_like_worker_code_error(raw):
        return _CODE_HEADLINE
    headline = _operator_error_message(raw, str(error_code) if error_code else None)
    redacted = _redact_public_log_message(headline or raw)
    # Final belt-and-braces: never let the exit boilerplate slip through.
    if _COMMAND_EXIT_RE.search(_e2b_log_content(redacted)):
        return _CODE_HEADLINE
    return redacted


def _run_event_metadata(run_id: Any) -> Dict[str, Any]:
    from db import get_db
    run_id_text = str(run_id or "").strip()
    if not run_id_text:
        return {}
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT r.worker_id, r.completed_at, r.duration_ms,
                       COALESCE(w.name, r.worker_id) AS worker_name
                FROM runs r
                LEFT JOIN workers w ON w.id = r.worker_id
                WHERE r.id = ?
                """,
                (run_id_text,),
            ).fetchone()
        return dict(row) if row else {}
    except Exception:
        return {}


def _public_sse_event(event: Dict[str, Any]) -> Dict[str, Any]:
    from main import _TERMINAL_STATUSES  # SSE terminal-status set still in main
    public_event = dict(event)
    run_id = public_event.get("run_id")
    run_meta = _run_event_metadata(run_id)
    if run_meta:
        public_event.setdefault("worker_id", run_meta.get("worker_id"))
        public_event.setdefault("worker_name", run_meta.get("worker_name"))
        if public_event.get("type") == "status" and public_event.get("status") in _TERMINAL_STATUSES:
            public_event.setdefault("completed_at", run_meta.get("completed_at"))
            public_event.setdefault("duration_ms", run_meta.get("duration_ms"))
    artifact = public_event.get("artifact")
    if isinstance(artifact, dict) and run_id:
        artifact_id = artifact.get("id")
        if artifact_id:
            artifact.setdefault(
                "download_url",
                f"/runs/{run_id}/artifacts/{artifact_id}/download",
            )
        if run_meta:
            artifact.setdefault("worker_id", run_meta.get("worker_id"))
            artifact.setdefault("worker_name", run_meta.get("worker_name"))
    if "message" in public_event:
        public_event["message"] = _redact_public_log_message(str(public_event.get("message") or ""))
    if public_event.get("error") is not None:
        public_event["error"] = _public_error_field(
            public_event["error"], public_event.get("error_code")
        )
    public_event.pop("trace_id", None)
    return public_event


def _public_run_part(part: Dict[str, Any]) -> Dict[str, Any]:
    from services.chat_tool_cards import build_args_preview

    public_part = dict(part)
    part_type = public_part.get("type")
    if part_type == "tool-call" and "args" in public_part:
        tool_name = str(public_part.get("toolName") or "tool")
        args_preview = build_args_preview(tool_name, public_part.get("args"))
        public_part["args"] = args_preview
        public_part["args_preview"] = args_preview
    if part_type == "tool-result" and "result" in public_part:
        result_preview = build_args_preview("tool-result", public_part.get("result"))
        public_part["result"] = result_preview
        public_part["result_preview"] = result_preview
    if "message" in public_part:
        public_part["message"] = _redact_public_log_message(str(public_part.get("message") or ""))
    if public_part.get("error") is not None:
        public_part["error"] = _public_error_field(
            public_part["error"], public_part.get("error_code")
        )
    return public_part


def _sanitize_operator_text(text: Optional[str]) -> Optional[str]:
    """Strip internal artifacts from a short operator-facing string (archive
    reasons, status notes). Never alters strings that are already clean."""
    if text is None:
        return None
    value = str(text).strip()
    if not value:
        return None
    if not _has_internal_artifact(value):
        return value
    value = _GIT_BRANCH_RE.sub("an internal change", value)
    value = _SANDBOX_PATH_RE.sub("the worker's files", value)
    value = _ENV_VAR_NAME_RE.sub("a required credential", value)
    value = re.sub(r"\bTraceback \(most recent call last\):.*", "", value, flags=re.DOTALL)
    value = re.sub(r"\s{2,}", " ", value).strip(" .,;:") + "."
    return value
