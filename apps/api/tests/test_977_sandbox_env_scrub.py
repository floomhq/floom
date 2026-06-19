"""#977 — worker execution must not leak internal infra env vars.

A worker that prints os.environ saw E2B_TEMPLATE_ID / E2B_SANDBOX_ID /
E2B_EVENTS_ADDRESS and WORKEROS_CODEGEN_MODEL. The first three let an
attacker probe/target our sandbox infra; the codegen model leaks an
architecture detail. Callback vars (WORKEROS_API_URL, WORKEROS_RUN_TOKEN,
FLOOM_RUN_ID/TRACE_ID) are by design and stay.

Run: cd apps/api && python -m pytest tests/test_977_sandbox_env_scrub.py -q
"""
from __future__ import annotations

import subprocess
import sys
import os
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from runner_sandbox.e2b_driver import (
    _E2B_INTERNAL_ENV_VARS,
    _WORKER_AUTHOR_ID,
    _scrub_internal_env_command,
)


class TestScrubCommandShape:
    def test_regular_worker_unsets_e2b_and_codegen(self):
        cmd = _scrub_internal_env_command("python run.py", "my-worker")
        for var in _E2B_INTERNAL_ENV_VARS:
            assert f"-u {var}" in cmd
        assert "-u WORKEROS_CODEGEN_MODEL" in cmd
        # original command preserved (quoted)
        assert "python run.py" in cmd

    def test_author_worker_keeps_codegen_model(self):
        cmd = _scrub_internal_env_command("python run.py", _WORKER_AUTHOR_ID)
        for var in _E2B_INTERNAL_ENV_VARS:
            assert f"-u {var}" in cmd
        assert "WORKEROS_CODEGEN_MODEL" not in cmd  # author needs it

    def test_callback_vars_never_unset(self):
        cmd = _scrub_internal_env_command("python run.py", "w")
        for keep in ("WORKEROS_API_URL", "WORKEROS_RUN_TOKEN", "FLOOM_RUN_ID"):
            assert f"-u {keep}" not in cmd

    def test_complex_command_is_preserved_intact(self):
        cmd = _scrub_internal_env_command("python run.py && echo done", "w")
        assert "python run.py && echo done" in cmd


@pytest.mark.skipif(os.name == "nt", reason="scrub command is POSIX shell syntax for the E2B runtime")
class TestScrubActuallyStripsEnv:
    """Execute the scrubbed command in a real shell and read the child env."""

    def _run(self, worker_id: str) -> dict[str, str]:
        probe = (
            "import os,json;"
            "print(json.dumps({k: os.environ.get(k, 'GONE') for k in "
            "['E2B_TEMPLATE_ID','WORKEROS_CODEGEN_MODEL','WORKEROS_API_URL']}))"
        )
        command = _scrub_internal_env_command(f"python3 -c {_q(probe)}", worker_id)
        env = {
            "E2B_TEMPLATE_ID": "secret-template",
            "WORKEROS_CODEGEN_MODEL": "gpt-5.5",
            "WORKEROS_API_URL": "https://internal",
            "PATH": __import__("os").environ.get("PATH", ""),
        }
        out = subprocess.run(["bash", "-c", command], capture_output=True, text=True, env=env, timeout=30)
        import json

        return json.loads(out.stdout.strip())

    def test_regular_worker_cannot_read_internal_vars(self):
        seen = self._run("regular-worker")
        assert seen["E2B_TEMPLATE_ID"] == "GONE"
        assert seen["WORKEROS_CODEGEN_MODEL"] == "GONE"
        assert seen["WORKEROS_API_URL"] == "https://internal"  # callback var kept

    def test_author_worker_keeps_codegen_model_at_runtime(self):
        seen = self._run(_WORKER_AUTHOR_ID)
        assert seen["E2B_TEMPLATE_ID"] == "GONE"
        assert seen["WORKEROS_CODEGEN_MODEL"] == "gpt-5.5"


def _q(s: str) -> str:
    import shlex

    return shlex.quote(s)
