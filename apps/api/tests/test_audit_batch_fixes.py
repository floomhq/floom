"""Unit tests for the agent-interface audit batch fixes.

Issues covered:
  #595 — approvals.required auto-gate (synthesise approval when manifest flags it)
  #596 — MCP bin/workeros-mcp calls main() explicitly (no more silent exit)
  #598 — CLI respects FLOOM_API_TOKEN / Authorization header
  #599 — MCP connection test probes the server (not a canned "valid")
  #600 — Validation errors include full field path (not hardcoded "request")
  #601 — Auth endpoints are covered by rate-limit rules
  #602 — dead skill runtime driver removed from runner dispatch
  #603 — runner:local default replaced with e2b; hybrid mode removed
  #604 — CI pytest command includes -p no:warnings
  #605 — async_bridge.run_coro_sync extracted and used by AgentDriver

Run:
    cd apps/api && python -m pytest tests/test_audit_batch_fixes.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _api_source import api_source

MAIN_PY = API_DIR / "main.py"
# Backend-wide source corpus: invariants that used to live in main.py may now
# live in core/ or routers/ after modularization; check the whole backend.
MAIN_SRC = api_source()

RUN_SERVICE_PY = API_DIR / "run_service.py"
# Reload from disk so all edits are picked up at test-collection time
RUN_SVC_SRC = RUN_SERVICE_PY.read_text(encoding="utf-8")

MODELS_PY = API_DIR / "models.py"
MODELS_SRC = MODELS_PY.read_text(encoding="utf-8")

RUNNER_INIT = API_DIR / "runner_sandbox" / "__init__.py"
RUNNER_SRC = RUNNER_INIT.read_text(encoding="utf-8")

AGENT_DRIVER = API_DIR / "runner_sandbox" / "agent_driver.py"
AGENT_SRC = AGENT_DRIVER.read_text(encoding="utf-8")

CLI_PY = API_DIR.parent.parent / "cli" / "floom.py"
CLI_SRC = CLI_PY.read_text(encoding="utf-8") if CLI_PY.exists() else ""

MCP_BIN = API_DIR.parent / "mcp" / "bin" / "workeros-mcp"
MCP_BIN_SRC = MCP_BIN.read_text(encoding="utf-8") if MCP_BIN.exists() else ""

CI_YML = API_DIR.parent.parent / ".github" / "workflows" / "ci.yml"
CI_SRC = CI_YML.read_text(encoding="utf-8") if CI_YML.exists() else ""


# ---------------------------------------------------------------------------
# #595 — approvals.required auto-gate
# ---------------------------------------------------------------------------

def test_595_approvals_synthesised_when_manifest_requires_but_run_py_omits():
    """run_service must synthesise a decision_required payload when
    approvals.required is set in the manifest but run.py never emits one.
    Previously the run would silently complete — the manifest flag was a no-op."""
    assert "result.decision_required = {" in RUN_SVC_SRC or "result.decision_required=" in RUN_SVC_SRC, (
        "#595: run_service must synthesise result.decision_required when "
        "worker_needs_approval is true but run.py didn't emit the event"
    )


def test_595_synthesis_guarded_by_approval_flag():
    """The synthesis must only happen when approvals.required is true."""
    synth_idx = RUN_SVC_SRC.find("result.decision_required = {")
    if synth_idx == -1:
        synth_idx = RUN_SVC_SRC.find("result.decision_required=")
    assert synth_idx != -1, "Synthesis block not found in run_service.py"
    context = RUN_SVC_SRC[max(0, synth_idx - 400): synth_idx + 10]
    assert "worker_needs_approval" in context, "Synthesis must be gated on worker_needs_approval"
    assert "not result.decision_required" in context, "Synthesis must only fire when run.py didn't emit"


def test_595_cancelled_timeout_rejected_excluded():
    """Approval synthesis must NOT fire for cancelled, timeout, or rejected runs."""
    assert "_non_approval_terminal" in RUN_SVC_SRC, (
        "#595: a _non_approval_terminal set must exclude cancelled/timeout/rejected"
    )
    non_terminal_idx = RUN_SVC_SRC.find("_non_approval_terminal")
    block = RUN_SVC_SRC[non_terminal_idx: non_terminal_idx + 200]
    for status in ("cancelled", "timeout", "rejected"):
        assert status in block, (
            f"#595: '{status}' must be in _non_approval_terminal to prevent approval synthesis on terminal runs"
        )


def test_595_informational_log_on_synthesis():
    """An info log must be emitted when auto-synthesising so authors know
    they can add an explicit event for custom labels."""
    assert "synthesising approval gate" in RUN_SVC_SRC or "auto-synthesis" in RUN_SVC_SRC or "synthesise" in RUN_SVC_SRC, (
        "#595: run_service must log when it auto-synthesises the approval gate"
    )


# ---------------------------------------------------------------------------
# #596 — MCP bin/workeros-mcp calls main() explicitly
# ---------------------------------------------------------------------------

def test_596_bin_imports_main():
    """bin/workeros-mcp must import main from dist/server.js and call it."""
    assert MCP_BIN.exists(), "bin/workeros-mcp must exist"
    assert "import { main }" in MCP_BIN_SRC or 'import {main}' in MCP_BIN_SRC, (
        "#596: bin/workeros-mcp must explicitly import main from dist/server.js. "
        "Previously it only imported the module without calling main(), causing "
        "the process to exit before the MCP client could enumerate tools."
    )


def test_596_bin_calls_main():
    """The bin script must call main() with a .catch() handler."""
    assert "main()" in MCP_BIN_SRC, (
        "#596: bin/workeros-mcp must call main() to start the stdio transport"
    )
    assert ".catch" in MCP_BIN_SRC, (
        "#596: main() call must have a .catch() error handler"
    )


def test_596_old_bare_import_gone():
    """The bare import-only pattern must be replaced."""
    assert 'import "../dist/server.js";\n' not in MCP_BIN_SRC, (
        "#596: bare 'import \"../dist/server.js\"' without calling main() must be removed"
    )


# ---------------------------------------------------------------------------
# #598 — CLI respects FLOOM_API_TOKEN
# ---------------------------------------------------------------------------

def test_598_cli_has_secret_flag():
    """CLI must expose a --secret flag (the originally reported bug)."""
    assert "--secret" in CLI_SRC, (
        "#598: CLI must have a --secret flag so operators can pass the secret "
        "at call time without setting an env var"
    )


def test_598_cli_reads_api_token():
    """CLI must read FLOOM_API_TOKEN env var."""
    assert "FLOOM_API_TOKEN" in CLI_SRC, (
        "#598: CLI must read FLOOM_API_TOKEN so agents using PATs can authenticate"
    )


def test_598_cli_sends_bearer_header():
    """When FLOOM_API_TOKEN is set, CLI must send Authorization: Bearer header."""
    assert "Authorization" in CLI_SRC and "Bearer" in CLI_SRC, (
        "#598: CLI must send 'Authorization: Bearer <token>' when FLOOM_API_TOKEN is set"
    )


def test_598_cli_token_takes_precedence_over_secret():
    """Token must be sent instead of (not alongside) the secret."""
    # Find the _headers function and verify token is checked first
    headers_idx = CLI_SRC.find("def _headers()")
    assert headers_idx != -1, "_headers() function must exist in CLI"
    headers_body = CLI_SRC[headers_idx: headers_idx + 300]
    token_idx = headers_body.find("API_TOKEN")
    secret_idx = headers_body.find("API_SECRET")
    assert token_idx < secret_idx, (
        "#598: FLOOM_API_TOKEN must be checked before FLOOM_API_SECRET in _headers()"
    )


# ---------------------------------------------------------------------------
# #599 — MCP connection test probes the server
# ---------------------------------------------------------------------------

def test_599_mcp_test_probes_server_url():
    """The test_connection endpoint must attempt to reach the MCP server URL."""
    assert "probe_url" in MAIN_SRC or "mcp_url" in MAIN_SRC, (
        "#599: test_connection must probe the MCP server URL instead of "
        "immediately returning 'valid' without any network call"
    )


def test_599_mcp_test_returns_failed_on_bad_status():
    """test_connection must return status='failed' when the MCP server returns
    a non-2xx HTTP status."""
    assert '"failed"' in MAIN_SRC and "HTTP" in MAIN_SRC, (
        "#599: test_connection must report failure when the MCP server returns a bad HTTP status"
    )


def test_599_mcp_test_handles_connection_error():
    """test_connection must catch network errors and return status='failed'."""
    test_idx = MAIN_SRC.find("def test_connection(")
    assert test_idx != -1, "test_connection endpoint not found"
    next_endpoint_idx = MAIN_SRC.find("\n@app.", test_idx + 1)
    endpoint_src = MAIN_SRC[test_idx: next_endpoint_idx if next_endpoint_idx != -1 else None]
    assert "except Exception" in endpoint_src, "#599: must catch exceptions"
    assert "Could not reach MCP server" in endpoint_src or "reach" in endpoint_src, (
        "#599: must return helpful error when unreachable"
    )


def test_599_mcp_test_distinguishes_auth_vs_url_errors():
    """401/403 should say 'check credentials', not 'check URL'."""
    test_idx = MAIN_SRC.find("def test_connection(")
    endpoint_src = MAIN_SRC[test_idx: test_idx + 6000]
    assert "401" in endpoint_src and "403" in endpoint_src, (
        "#599: 401/403 must be handled separately from other HTTP errors"
    )
    assert "authentication failed" in endpoint_src or "credentials" in endpoint_src.lower(), (
        "#599: 401/403 must explain it's an auth failure, not a URL problem"
    )


def test_857_mcp_test_speaks_streamable_http():
    """#857: the probe must send the MCP streamable-HTTP Accept header
    (compliant servers reject without it, HTTP 406), parse SSE-framed
    JSON-RPC responses, and echo the server-assigned session id."""
    test_idx = MAIN_SRC.find("def test_connection(")
    endpoint_src = MAIN_SRC[test_idx: test_idx + 6000]
    assert "application/json, text/event-stream" in endpoint_src, (
        "#857: probe must send Accept: application/json, text/event-stream"
    )
    assert "_parse_mcp_response" in endpoint_src, (
        "#857: probe must parse SSE-framed JSON-RPC responses"
    )
    assert "mcp-session-id" in endpoint_src, (
        "#857: probe must echo the Mcp-Session-Id header on follow-up requests"
    )


def test_601_auth_me_rate_limited():
    """/auth/me must have a rate-limit rule (explicitly listed in the issue)."""
    rules_idx = MAIN_SRC.find("RATE_LIMIT_RULES = [")
    rules_block = MAIN_SRC[rules_idx: rules_idx + 900]
    assert "/auth/me" in rules_block, (
        "#601: /auth/me was explicitly listed in the issue as needing a rate limit. "
        "It is the primary identity probe used to test for auth bypass."
    )


# ---------------------------------------------------------------------------
# #600 — Validation errors include full field path
# ---------------------------------------------------------------------------

def test_600_validation_error_preserves_loc():
    """_redacted_validation_errors must preserve the actual field path, not
    hardcode 'request'."""
    func_idx = MAIN_SRC.find("def _redacted_validation_errors(")
    assert func_idx != -1
    func_body = MAIN_SRC[func_idx: func_idx + 600]
    assert '"loc": "request"' not in func_body, (
        '#600: _redacted_validation_errors must not hardcode loc="request". '
        "Agents need the real field path to self-repair."
    )


def test_600_loc_is_derived_from_error():
    """The loc field must be derived from the actual Pydantic error."""
    func_idx = MAIN_SRC.find("def _redacted_validation_errors(")
    func_body = MAIN_SRC[func_idx: func_idx + 600]
    assert "error.get(\"loc\")" in func_body or 'error.get("loc")' in func_body, (
        '#600: loc must be read from error["loc"], not hardcoded'
    )


def test_600_loc_joined_as_dot_path():
    """Tuple loc paths must be joined as dot-separated strings like 'exec.runner'."""
    func_idx = MAIN_SRC.find("def _redacted_validation_errors(")
    func_body = MAIN_SRC[func_idx: func_idx + 600]
    assert '".".join' in func_body or "join" in func_body, (
        '#600: loc tuple must be joined to a readable dot path (e.g. "exec.runner")'
    )


# ---------------------------------------------------------------------------
# #601 — Auth endpoints covered by rate-limit rules
# ---------------------------------------------------------------------------

def test_601_auth_login_rate_limited():
    """POST /auth/login must have a rate-limit rule."""
    assert "/auth/login" in MAIN_SRC, "#601: /auth/login must be in RATE_LIMIT_RULES"
    # Find it in the rules block
    rules_idx = MAIN_SRC.find("RATE_LIMIT_RULES = [")
    rules_block = MAIN_SRC[rules_idx: rules_idx + 800]
    assert "/auth/login" in rules_block, (
        "#601: /auth/login must appear in RATE_LIMIT_RULES — missing exposes "
        "the endpoint to brute-force credential attacks"
    )


def test_601_auth_setup_rate_limited():
    """/auth/setup must have a rate-limit rule."""
    rules_idx = MAIN_SRC.find("RATE_LIMIT_RULES = [")
    rules_block = MAIN_SRC[rules_idx: rules_idx + 800]
    assert "/auth/setup" in rules_block, "#601: /auth/setup must be in RATE_LIMIT_RULES"


def test_601_auth_tokens_rate_limited():
    """/auth/tokens must have a rate-limit rule (PAT brute-force prevention)."""
    rules_idx = MAIN_SRC.find("RATE_LIMIT_RULES = [")
    rules_block = MAIN_SRC[rules_idx: rules_idx + 800]
    assert "/auth/tokens" in rules_block, "#601: /auth/tokens must be in RATE_LIMIT_RULES"


def test_601_auth_magic_link_rate_limited():
    """/auth/magic-link must have a rate-limit rule."""
    rules_idx = MAIN_SRC.find("RATE_LIMIT_RULES = [")
    rules_block = MAIN_SRC[rules_idx: rules_idx + 800]
    assert "/auth/magic-link" in rules_block, "#601: /auth/magic-link must be in RATE_LIMIT_RULES"


# ---------------------------------------------------------------------------
# #602 — deleted skill runtime driver
# ---------------------------------------------------------------------------

DEAD_SKILL_DRIVER_CLASS = "Skill" + "RuntimeDriver"


def test_602_deleted_skill_runtime_not_imported():
    """runner_sandbox/__init__.py must not import the deleted skill runtime class."""
    deleted_module = "." + "skill" + "_driver"
    assert f"from {deleted_module} import {DEAD_SKILL_DRIVER_CLASS}" not in RUNNER_SRC, (
        "#602: deleted skill runtime class import must be removed from runner_sandbox/__init__.py"
    )


def test_602_deleted_skill_runtime_file_deleted():
    """Deleted skill runtime module file must not exist."""
    deleted_file = API_DIR / "runner_sandbox" / ("skill" + "_driver.py")
    assert not deleted_file.exists(), (
        "#602: deleted skill runtime module file must not exist. "
        "Zero workers use it and it was unreachable after removing the dispatch."
    )


def test_602_runner_key_has_no_skill_branch():
    """_runner_key() in run_service.py must not have a skill branch."""
    assert "startswith(\"skill\")" not in RUN_SVC_SRC, (
        "#602: _runner_key() must not check runtime_type.startswith('skill')"
    )


def test_602_skill_runner_dispatch_removed():
    """get_driver() must not import or dispatch to the deleted skill runtime class."""
    import_or_code = [
        l for l in RUNNER_SRC.splitlines()
        if DEAD_SKILL_DRIVER_CLASS in l
        and not l.strip().startswith("#")
        and not l.strip().startswith('"""')
        and not l.strip().startswith("(#")
        and "import" not in l.lower().replace(DEAD_SKILL_DRIVER_CLASS, "")
        and any(kw in l for kw in ("return", "import", f"{DEAD_SKILL_DRIVER_CLASS}()"))
    ]
    assert not import_or_code, (
        f"#602: deleted skill runtime class must not be imported or instantiated in "
        f"runner_sandbox/__init__.py: {import_or_code}"
    )


def test_602_skill_not_in_all():
    """Deleted skill runtime class must not be in __all__."""
    assert f'"{DEAD_SKILL_DRIVER_CLASS}"' not in RUNNER_SRC, (
        '#602: deleted skill runtime class must be removed from __all__'
    )


# ---------------------------------------------------------------------------
# #603 — runner:local default replaced; hybrid mode removed
# ---------------------------------------------------------------------------

def test_603_runner_default_is_e2b():
    """run_service.py must default runner to 'e2b', not 'local'."""
    assert 'runner = "local"' not in RUN_SVC_SRC, (
        '#603: runner default must not be "local" — the local in-process runner '
        "was removed in the security audit. Default to e2b."
    )
    assert 'runner = "e2b"' in RUN_SVC_SRC, (
        '#603: run_service must default runner to "e2b"'
    )


def test_603_no_local_fallback_in_runner_config():
    """runtime.runner should not fall back to 'local'."""
    assert 'or "local"' not in RUN_SVC_SRC, (
        '#603: runner config must not fall back to "local" — use "e2b"'
    )


def test_603_hybrid_mode_removed_from_models():
    """models.py must not include 'hybrid' in Literal type definitions.
    A field_validator that coerces 'hybrid' is acceptable and expected."""
    # Only flag lines where hybrid appears in a Literal type annotation
    literal_lines = [
        l for l in MODELS_SRC.splitlines()
        if "hybrid" in l
        and "Literal[" in l
        and not l.strip().startswith("#")
    ]
    assert not literal_lines, (
        f"#603: 'hybrid' must not appear in Literal type definitions in models.py. "
        f"Found: {literal_lines}"
    )


# ---------------------------------------------------------------------------
# #604 — CI pytest command
# ---------------------------------------------------------------------------

def test_604_ci_pytest_no_warnings():
    """CI pytest command must include -p no:warnings for clean output."""
    assert "-p no:warnings" in CI_SRC, (
        "#604: CI pytest command must include '-p no:warnings'"
    )


def test_604_ci_tsx_tests_run():
    """CI must run the tsx-style frontend test files."""
    assert "tsx" in CI_SRC and "fl-" in CI_SRC, (
        "#604: CI must run tsx-based test files (fl-*.test.ts) in addition to vitest"
    )


def test_604_root_runtime_tests_in_ci():
    """CI must have a job that runs the root-level tests/ directory."""
    assert "runtime-tests" in CI_SRC or ("root" in CI_SRC and "pytest" in CI_SRC), (
        "#604: CI must have a job running root-level tests/ (66 runtime test files). "
        "These were the main ask — apps/api/tests/ is separate from tests/."
    )


# ---------------------------------------------------------------------------
# #605 — async_bridge module exists and AgentDriver uses it
# ---------------------------------------------------------------------------

def test_605_async_bridge_module_exists():
    """async_bridge.py must exist at the API root."""
    bridge = API_DIR / "async_bridge.py"
    assert bridge.exists(), "#605: async_bridge.py must be created at apps/api/async_bridge.py"


def test_605_async_bridge_has_run_coro_sync():
    """async_bridge must export run_coro_sync()."""
    bridge_src = (API_DIR / "async_bridge.py").read_text(encoding="utf-8")
    assert "def run_coro_sync(" in bridge_src, (
        "#605: async_bridge must define run_coro_sync()"
    )


def test_605_async_bridge_handles_no_running_loop():
    """run_coro_sync must use asyncio.run() when no loop is running."""
    bridge_src = (API_DIR / "async_bridge.py").read_text(encoding="utf-8")
    assert "asyncio.run(coro)" in bridge_src, (
        "#605: run_coro_sync must call asyncio.run() when no loop is active"
    )


def test_605_async_bridge_handles_running_loop():
    """run_coro_sync must use a thread when a loop is already running."""
    bridge_src = (API_DIR / "async_bridge.py").read_text(encoding="utf-8")
    assert "threading.Thread" in bridge_src, (
        "#605: run_coro_sync must spawn a thread when inside a running event loop"
    )


def test_605_agent_driver_uses_async_bridge():
    """AgentDriver._run_coro_sync must delegate to async_bridge.run_coro_sync."""
    assert "from async_bridge import run_coro_sync" in AGENT_SRC or "async_bridge" in AGENT_SRC, (
        "#605: AgentDriver must import from async_bridge instead of duplicating "
        "the async/thread pattern inline"
    )


def test_605_run_coro_sync_functional():
    """run_coro_sync must actually run a coroutine and return its result."""
    import asyncio as _asyncio
    from async_bridge import run_coro_sync

    async def _add(a: int, b: int) -> int:
        return a + b

    result = run_coro_sync(_add(2, 3))
    assert result == 5, f"run_coro_sync must return coroutine result, got {result!r}"
