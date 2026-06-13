"""#1000 — local subprocess runner can't be abused for shell injection.

The local-subprocess fallback (used when runner != e2b) ran
subprocess.run([cmd, *args]) with only an absolute-path check, so cmd="sh"
args=["-c", "cat /etc/passwd"] or cmd="../bin/sh" reached the host shell.
Now: PATH-only cmd (no slashes), interpreter -c/-e/-m rejected, and the
local path is refused entirely unless explicitly enabled (E2B-only engine).

Run: cd apps/api && python -m pytest tests/test_1000_local_runner_hardening.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import types

from runner_sandbox.agent_driver import AgentDriver


def _driver():
    return AgentDriver.__new__(AgentDriver)


def _config(runner="local"):
    # the model forbids runner != "e2b" (E2B-only engine); the local path is
    # only reachable with an unvalidated/legacy config, so simulate one to
    # exercise the #1000 hardening directly.
    return types.SimpleNamespace(
        runtime=types.SimpleNamespace(runner=runner),
        secrets=[],
        calls=[],
    )


def _run(args, tmp_path, monkeypatch, *, allow_local=False):
    if allow_local:
        monkeypatch.setenv("WORKEROS_ALLOW_LOCAL_RUNNER", "1")
    else:
        monkeypatch.delenv("WORKEROS_ALLOW_LOCAL_RUNNER", raising=False)
        monkeypatch.delenv("WORKEROS_DEV", raising=False)
    return _driver()._run_command(
        args, secrets={}, config=_config(runner="local"),
        bundle_dir=tmp_path, input_dir=tmp_path, output_dir=tmp_path,
        timeout_seconds=5,
    )


class TestCommandValidation:
    def test_absolute_path_rejected(self, tmp_path, monkeypatch):
        r = _run({"cmd": "/bin/sh", "args": []}, tmp_path, monkeypatch, allow_local=True)
        assert r["ok"] is False and "absolute" in r["error"]

    def test_traversal_slash_rejected(self, tmp_path, monkeypatch):
        r = _run({"cmd": "../bin/cat", "args": ["x"]}, tmp_path, monkeypatch, allow_local=True)
        assert r["ok"] is False and "PATH executable" in r["error"]

    def test_interpreter_dash_c_rejected(self, tmp_path, monkeypatch):
        for cmd, flag in [("sh", "-c"), ("bash", "-c"), ("python3", "-c"), ("node", "-e"), ("python", "-m")]:
            r = _run({"cmd": cmd, "args": [flag, "evil"]}, tmp_path, monkeypatch, allow_local=True)
            assert r["ok"] is False and "interpreter" in r["error"], f"{cmd} {flag} not blocked"


class TestLocalRunnerGate:
    def test_local_runner_refused_in_production(self, tmp_path, monkeypatch):
        # no WORKEROS_DEV / WORKEROS_ALLOW_LOCAL_RUNNER → refused
        r = _run({"cmd": "echo", "args": ["hi"]}, tmp_path, monkeypatch, allow_local=False)
        assert r["ok"] is False
        assert "disabled" in r["error"] and "E2B" in r["error"]

    def test_safe_command_runs_when_opted_in(self, tmp_path, monkeypatch):
        r = _run({"cmd": "echo", "args": ["hello"]}, tmp_path, monkeypatch, allow_local=True)
        # echo is a bare PATH name, not an interpreter — allowed to run
        assert r.get("ok") is True, r
        assert "hello" in (r.get("stdout") or "")
