"""Unit tests for P0/P1 fixes — issues #607, #611b, #613.

Run:
    cd apps/api && python -m pytest tests/test_p0_p1_fixes.py -v
"""
from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

MAIN_PY = API_DIR / "main.py"
MAIN_SRC = MAIN_PY.read_text(encoding="utf-8")

AGENT_DRIVER_PY = API_DIR / "runner_sandbox" / "agent_driver.py"
AGENT_DRIVER_SRC = AGENT_DRIVER_PY.read_text(encoding="utf-8")

WORKER_GITHUB_DIGEST = Path(__file__).resolve().parents[3] / "workers" / "github-digest" / "worker.yml"
WORKER_GMAIL_INTAKE = Path(__file__).resolve().parents[3] / "workers" / "gmail_intake_brief" / "worker.yml"
WORKER_WHATSAPP = Path(__file__).resolve().parents[3] / "workers" / "whatsapp-listener" / "worker.yml"


# ---------------------------------------------------------------------------
# #607: cancel endpoint calls cancel_sandbox() for RUNNING E2B runs
# ---------------------------------------------------------------------------

class TestCancelSandboxOnRunningRun:
    def test_cancel_endpoint_calls_cancel_sandbox_for_e2b_runs(self):
        """cancel_run() must call cancel_sandbox() when the run is RUNNING with runner=e2b."""
        assert "cancel_sandbox" in MAIN_SRC, (
            "cancel_run must import and call cancel_sandbox from e2b_driver"
        )
        assert "_cancel_e2b_sandbox" in MAIN_SRC or "cancel_sandbox" in MAIN_SRC

    def test_cancel_endpoint_checks_runner_column(self):
        """cancel_run() must gate the sandbox kill on runner == 'e2b'."""
        assert 'runner == "e2b"' in MAIN_SRC or "runner == 'e2b'" in MAIN_SRC, (
            "cancel_run should only call cancel_sandbox when runner is e2b"
        )

    def test_cancel_sandbox_import_in_cancel_path(self):
        """The import of cancel_sandbox must be in the cancel endpoint, not just at module level."""
        fn_start = MAIN_SRC.find("def cancel_run")
        # Look from the function start through 6000 chars — the sandbox kill is after
        # the queued-run branch, so it can be 3-4k chars into the function body.
        fn_body = MAIN_SRC[fn_start: fn_start + 6000]
        assert "cancel_sandbox" in fn_body, (
            "cancel_sandbox call not found in cancel_run function body"
        )

    def test_cancel_sandbox_module_callable(self):
        """cancel_sandbox from e2b_driver must be importable and callable."""
        from runner_sandbox.e2b_driver import cancel_sandbox
        assert callable(cancel_sandbox)

    def test_cancel_sandbox_returns_false_for_unknown_run(self):
        """cancel_sandbox returns False when the run has no active sandbox (no-op)."""
        from runner_sandbox.e2b_driver import cancel_sandbox
        result = cancel_sandbox("run_nonexistent", reason="test")
        assert result is False


# ---------------------------------------------------------------------------
# #611b: _cancel_requested fails CLOSED (returns True) on DB error
# ---------------------------------------------------------------------------

class TestCancelFailClosed:
    def test_source_returns_true_on_exception(self):
        """_cancel_requested source must return True in the except block (fail-closed)."""
        # Find the _cancel_requested method body and confirm it returns True on error.
        method_start = AGENT_DRIVER_SRC.find("def _cancel_requested")
        assert method_start != -1
        # Grab the next ~50 lines of the method (return True is ~22 lines in)
        method_body = AGENT_DRIVER_SRC[method_start: method_start + 1500]
        assert "return True" in method_body, (
            "_cancel_requested must return True on exception (fail-closed), "
            "not False (fail-open)"
        )
        # The old fail-open code returned False — make sure that's gone from the except block
        except_idx = method_body.find("except Exception")
        assert except_idx != -1
        after_except = method_body[except_idx:]
        # First return after except must be True
        first_return = after_except.find("return ")
        assert after_except[first_return:first_return + 12] == "return True\n" or \
               "return True" in after_except[:after_except.find("\n    def ")], (
            "First return in except block of _cancel_requested must be True"
        )

    def test_cancel_requested_via_monkeypatch(self, monkeypatch):
        """_cancel_requested returns True when get_db raises."""
        import runner_sandbox.agent_driver as ad_module
        from runner_sandbox.agent_driver import AgentDriver

        driver = AgentDriver()

        # Inject a fake db module into the runner_sandbox.agent_driver namespace
        fake_db = types.ModuleType("db")
        fake_db.get_db = MagicMock(side_effect=RuntimeError("DB gone"))
        monkeypatch.setitem(sys.modules, "db", fake_db)

        result = driver._cancel_requested("run_nonexistent_xyz")
        assert result is True, "_cancel_requested must return True (fail-closed) when DB throws"

    def test_cancel_requested_false_when_not_set(self, monkeypatch):
        """_cancel_requested returns False when DB row has cancel_requested=0."""
        from runner_sandbox.agent_driver import AgentDriver
        driver = AgentDriver()

        fake_conn = MagicMock()
        fake_conn.__enter__ = lambda s: fake_conn
        fake_conn.__exit__ = MagicMock(return_value=False)
        fake_conn.execute.return_value.fetchone.return_value = {"cancel_requested": 0}

        fake_db = types.ModuleType("db")
        fake_db.get_db = MagicMock(return_value=fake_conn)
        monkeypatch.setitem(sys.modules, "db", fake_db)

        result = driver._cancel_requested("run_test")
        assert result is False


# ---------------------------------------------------------------------------
# #613: Legacy Composio connections migrated to structured allowlists
# ---------------------------------------------------------------------------

class TestLegacyConnectionsMigrated:
    def _load_yml(self, path: Path) -> str:
        return path.read_text(encoding="utf-8")

    def test_github_digest_has_structured_connection(self):
        content = self._load_yml(WORKER_GITHUB_DIGEST)
        assert "app: " in content or "app:" in content, (
            "github-digest must use structured connection spec with app: key"
        )
        assert "allowed_tools:" in content, (
            "github-digest must declare allowed_tools — bare '- github' is unrestricted"
        )
        # Bare string form must be gone
        import re
        bare = re.search(r"^- github\s*$", content, re.MULTILINE)
        assert bare is None, "github-digest still has bare legacy '- github' connection"

    def test_gmail_intake_brief_has_structured_connection(self):
        content = self._load_yml(WORKER_GMAIL_INTAKE)
        assert "app: " in content or "app:" in content
        assert "allowed_tools:" in content, (
            "gmail_intake_brief must declare allowed_tools"
        )
        # Only check the connections section — tags may legitimately contain "- gmail"
        import re
        conn_match = re.search(r"connections:(.*?)(?=\n\w|\Z)", content, re.DOTALL)
        conn_section = conn_match.group(0) if conn_match else ""
        bare = re.search(r"^- gmail\s*$", conn_section, re.MULTILINE)
        assert bare is None, "gmail_intake_brief still has bare legacy '- gmail' in connections"

    def test_whatsapp_listener_has_structured_connection(self):
        content = self._load_yml(WORKER_WHATSAPP)
        assert "app: " in content or "app:" in content
        assert "allowed_tools:" in content, (
            "whatsapp-listener must declare allowed_tools"
        )
        import re
        bare = re.search(r"^  - whatsapp\s*$", content, re.MULTILINE)
        assert bare is None, "whatsapp-listener still has bare legacy '- whatsapp' connection"

    def test_gmail_intake_brief_tools_are_read_only(self):
        content = self._load_yml(WORKER_GMAIL_INTAKE)
        # gmail_intake_brief is a read-only ingestion worker — must not have send access
        assert "GMAIL_SEND_EMAIL" not in content, (
            "gmail_intake_brief should not have GMAIL_SEND_EMAIL in its allowlist (read-only worker)"
        )
        assert "GMAIL_FETCH_EMAILS" in content, "GMAIL_FETCH_EMAILS must be in allowlist"

    def test_whatsapp_allowed_tools_match_actual_usage(self):
        content = self._load_yml(WORKER_WHATSAPP)
        assert "WHATSAPP_GET_MESSAGES" in content
        assert "WHATSAPP_SEND_MESSAGE" in content


# ---------------------------------------------------------------------------
# #607/#611c: runs.runner metadata is dispatch-accurate
# ---------------------------------------------------------------------------

class TestRunnerMetadata:
    def test_runner_key_defaults_to_e2b(self):
        """_runner_key returns 'e2b' when config has no runtime."""
        from run_service import _runner_key
        assert _runner_key(None) == "e2b"

    def test_runner_key_reads_from_config(self):
        """_runner_key returns the runner from config.runtime."""
        from models import WorkerConfig
        config = WorkerConfig(
            id="test",
            name="Test",
            trigger={"type": "manual"},
            runtime={"runner": "e2b", "type": "python311", "entrypoint": "run.py", "mode": "pure-script"},
            inputs=[],
            secrets=[],
            connections=[],
            outputs=[],
        )
        from run_service import _runner_key
        assert _runner_key(config) == "e2b"
