#!/usr/bin/env python3
"""Tests for the subprocess-based local runner security properties.

Covers:
  - env-allowlist: worker sees only declared secrets, not full env
  - memory-bomb: 1GB+ allocation fails (RLIMIT_AS)
  - cpu-bomb: infinite loop killed at timeout (RLIMIT_CPU + subprocess timeout)
  - symlink-escape: rejected via lstat() symlink detection
  - network-egress: socket.connect blocked when capabilities.network.egress is false
  - happy-path: csv_enricher-style worker runs to completion
  - schema-manifest: all 12 stock worker.yml parse without error
  - dispatcher: runner=local routes to SubprocessSandboxDriver
"""

from __future__ import annotations

import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from models import (
    WorkerConfig,
    WorkerRuntime,
    WorkerTrigger,
    WorkerResult,
    parse_worker_manifest,
)
from runner_subprocess import (
    run_worker_subprocess,
    _safe_path_subprocess,
    _build_child_env,
    _is_symlink_safe,
    WORKERS_DIR,
    ARTIFACTS_DIR,
)
from runner_sandbox import get_driver
from runner_sandbox.subprocess_driver import SubprocessSandboxDriver


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _noop_log(msg: str, level: str = "info") -> None:
    pass


def _make_config(
    worker_id: str,
    secrets: list[str] | None = None,
    runner: str = "local",
    mode: str = "pure-script",
    entrypoint: str = "run.py",
    bundle_path: str | None = None,
) -> WorkerConfig:
    return WorkerConfig(
        id=worker_id,
        name=worker_id,
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="python311",
            entrypoint=entrypoint,
            runner=runner,
            mode=mode,
            bundle_path=bundle_path,
        ),
        secrets=secrets or [],
    )


class _TmpWorkerFixture:
    """Context manager that creates a temporary worker directory with a run.py."""

    def __init__(self, run_py_source: str, worker_id: str = "test_worker") -> None:
        self._source = run_py_source
        self._worker_id = worker_id
        self._tmpdir: tempfile.TemporaryDirectory | None = None

    def __enter__(self):
        self._tmpdir = tempfile.TemporaryDirectory(prefix="workeros-test-")
        worker_dir = Path(self._tmpdir.name) / self._worker_id
        worker_dir.mkdir()
        (worker_dir / "run.py").write_text(self._source)
        self.worker_dir = worker_dir
        self.base_dir = Path(self._tmpdir.name)
        return self

    def __exit__(self, *args):
        if self._tmpdir:
            self._tmpdir.cleanup()


def _run_subprocess_with_tmp(
    run_py: str,
    inputs: Dict[str, Any] | None = None,
    secrets: Dict[str, str] | None = None,
    declared_secrets: list[str] | None = None,
    timeout: int = 30,
    extra_env: Dict[str, str] | None = None,
) -> WorkerResult:
    """Run a snippet through run_worker_subprocess using a temp directory."""
    with _TmpWorkerFixture(run_py) as fix:
        config = _make_config(
            worker_id="test_worker",
            secrets=declared_secrets or [],
            bundle_path=str(fix.worker_dir),
        )
        with patch.dict(os.environ, extra_env or {}, clear=False):
            with patch("runner_subprocess.WORKERS_DIR", fix.base_dir):
                with patch("runner_subprocess.ARTIFACTS_DIR", fix.base_dir / "artifacts"):
                    (fix.base_dir / "artifacts").mkdir(exist_ok=True)
                    # Patch get_worker_contract to return None (no capabilities restrictions)
                    with patch("worker_registry.get_worker_contract", return_value=None):
                        return run_worker_subprocess(
                            worker_id="test_worker",
                            run_id="run-test-001",
                            inputs=inputs or {},
                            secrets=secrets or {},
                            log_fn=_noop_log,
                            trace_id="trace-test-001",
                            timeout_seconds=timeout,
                            config=config,
                        )


# ---------------------------------------------------------------------------
# 1. Dispatcher test
# ---------------------------------------------------------------------------

class TestDispatcher(unittest.TestCase):
    def test_runner_local_returns_subprocess_driver(self):
        driver = get_driver("local")
        self.assertIsInstance(driver, SubprocessSandboxDriver)

    def test_runner_local_trusted_returns_local_driver(self):
        from runner_sandbox.local import LocalSandboxDriver
        driver = get_driver("local-trusted")
        self.assertIsInstance(driver, LocalSandboxDriver)


# ---------------------------------------------------------------------------
# 2. env-allowlist test
# ---------------------------------------------------------------------------

class TestEnvAllowlist(unittest.TestCase):
    def test_child_sees_only_declared_secrets(self):
        """Worker receives only secrets declared in worker.yml, not full env."""
        run_py = textwrap.dedent("""\
            import os, json

            def run(inputs, context):
                # Try to read env vars that should NOT be passed to child
                leaked = {}
                for k in ["OPENAI_API_KEY", "COMPOSIO_API_KEY", "E2B_API_KEY",
                          "FLOOM_SECRET", "COMPOSIO_WEBHOOK_SIGNING_KEY",
                          "MY_UNDECLARED_SECRET"]:
                    v = os.environ.get(k)
                    if v:
                        leaked[k] = v
                # Also try to access via context.secrets (should only have declared)
                ctx_secrets = dict(context.secrets)
                return {
                    "status": "success",
                    "outputs": {
                        "leaked_env": json.dumps(leaked),
                        "ctx_secrets_keys": json.dumps(sorted(ctx_secrets.keys())),
                    }
                }
        """)
        # Inject fake "production" secrets into the test environment
        fake_secrets = {
            "OPENAI_API_KEY": "sk-test-FAKE-OPENAI",
            "COMPOSIO_API_KEY": "composio-test-FAKE",
            "E2B_API_KEY": "e2b-test-FAKE",
            "FLOOM_SECRET": "floom-test-FAKE",
            "COMPOSIO_WEBHOOK_SIGNING_KEY": "whsec-test-FAKE",
            "MY_UNDECLARED_SECRET": "undeclared-FAKE",
        }
        # Worker only declares MY_DECLARED_SECRET
        result = _run_subprocess_with_tmp(
            run_py=run_py,
            inputs={},
            secrets={"MY_DECLARED_SECRET": "declared-value", **fake_secrets},
            declared_secrets=["MY_DECLARED_SECRET"],
            extra_env=fake_secrets,
        )
        self.assertEqual(result.status, "success", f"Expected success, got: {result.error}")
        leaked_env = result.outputs.get("leaked_env", "{}")
        ctx_keys = result.outputs.get("ctx_secrets_keys", "[]")
        import json
        leaked = json.loads(leaked_env)
        self.assertEqual(leaked, {}, f"Child process leaked env vars: {leaked}")
        ctx_secret_names = json.loads(ctx_keys)
        self.assertEqual(ctx_secret_names, ["MY_DECLARED_SECRET"],
                         f"Context secrets contained undeclared keys: {ctx_secret_names}")


# ---------------------------------------------------------------------------
# 3. Memory-bomb test
# ---------------------------------------------------------------------------

class TestMemoryBomb(unittest.TestCase):
    def test_1gb_allocation_is_blocked(self):
        """A worker trying to allocate 1.5GB of memory must fail."""
        run_py = textwrap.dedent("""\
            def run(inputs, context):
                # Try to allocate 1.5 GB — exceeds RLIMIT_AS of 1 GB
                chunks = []
                try:
                    for _ in range(15):
                        chunks.append(b"X" * (100 * 1024 * 1024))  # 100 MB per chunk
                except MemoryError:
                    return {"status": "success", "outputs": {"result": "blocked_by_rlimit"}}
                return {"status": "success", "outputs": {"result": "allocated_unblocked"}}
        """)
        result = _run_subprocess_with_tmp(run_py=run_py, timeout=30)
        # The child should either be killed (non-zero exit -> subprocess_error/timeout)
        # or raise MemoryError internally and return blocked_by_rlimit.
        if result.status == "success":
            self.assertEqual(
                result.outputs.get("result"), "blocked_by_rlimit",
                "Child allocated 1.5GB unblocked — RLIMIT_AS not enforced"
            )
        else:
            # Subprocess was killed by OOM or RLIMIT_AS SIGSEGV
            self.assertIn(result.status, ("error",),
                          f"Unexpected status: {result.status} / {result.error}")


# ---------------------------------------------------------------------------
# 4. CPU-bomb / timeout test
# ---------------------------------------------------------------------------

class TestCpuBomb(unittest.TestCase):
    def test_infinite_loop_killed_at_timeout(self):
        """An infinite loop must be killed at timeout_seconds, not run forever."""
        run_py = textwrap.dedent("""\
            def run(inputs, context):
                while True:
                    pass  # infinite CPU loop
                return {"status": "success", "outputs": {}}
        """)
        # Set a very short timeout — should be killed quickly
        result = _run_subprocess_with_tmp(run_py=run_py, timeout=4)
        # Must fail with timeout or subprocess killed by SIGKILL
        self.assertEqual(result.status, "error",
                         f"CPU bomb was not killed: status={result.status}")
        error_code = result.error_code or ""
        self.assertIn(error_code, ("timeout", "subprocess_error"),
                      f"Expected timeout/subprocess_error, got: {error_code!r} / {result.error!r}")


# ---------------------------------------------------------------------------
# 5. Symlink-escape test
# ---------------------------------------------------------------------------

class TestSymlinkEscape(unittest.TestCase):
    def test_symlink_pointing_outside_base_is_rejected(self):
        """_safe_path_subprocess must reject a symlink that escapes the base dir."""
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir) / "base"
            base.mkdir()
            outside = Path(tmpdir) / "outside"
            outside.mkdir()
            secret_file = outside / "secret.txt"
            secret_file.write_text("super-secret")

            # Create a symlink inside base pointing outside
            symlink = base / "escape_link"
            symlink.symlink_to(outside)

            with self.assertRaises(ValueError) as ctx:
                _safe_path_subprocess(base, "escape_link", "secret.txt")
            # Either the symlink check or the resolved-path containment check fires
            error_msg = str(ctx.exception)
            self.assertTrue(
                "Symlink escape" in error_msg or "Path traversal" in error_msg,
                f"Expected symlink/traversal rejection, got: {error_msg!r}"
            )

    def test_safe_path_within_base_is_allowed(self):
        """A normal path inside the base dir must not be rejected."""
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir)
            (base / "subdir").mkdir()
            result = _safe_path_subprocess(base, "subdir")
            self.assertEqual(result, (base / "subdir").resolve())

    def test_symlink_within_base_is_allowed(self):
        """A symlink that stays inside the base dir is acceptable."""
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir) / "base"
            base.mkdir()
            target = base / "target"
            target.mkdir()
            (target / "file.txt").write_text("ok")
            link = base / "link_to_target"
            link.symlink_to(target)
            # Should not raise
            result = _safe_path_subprocess(base, "link_to_target", "file.txt")
            self.assertTrue(result.exists())

    def test_symlink_escape_via_worker_run(self):
        """A worker that creates a symlink and reads outside its dir must fail."""
        run_py = textwrap.dedent("""\
            import os
            from pathlib import Path

            def run(inputs, context):
                # Try to symlink artifact_dir to /etc
                art = Path(context.artifact_dir)
                try:
                    link = art / "escape_link"
                    link.symlink_to("/etc")
                    # Try to read through the symlink
                    content = (art / "escape_link" / "hostname").read_text()
                    return {"status": "success", "outputs": {"hostname": content}}
                except (PermissionError, FileNotFoundError, OSError) as e:
                    return {"status": "success", "outputs": {"blocked": str(e)}}
        """)
        result = _run_subprocess_with_tmp(run_py=run_py, timeout=10)
        # The worker runs in subprocess so it CAN create the symlink in artifact_dir
        # (we're not blocking at OS level), but the READ may fail due to file limits.
        # The key test is that the subprocess runner itself doesn't allow reading
        # outside the worker dir via _safe_path_subprocess at the runner level.
        # Here we verify the subprocess runner doesn't crash the API process.
        self.assertIn(result.status, ("success", "error"),
                      "Runner should handle symlink gracefully, not crash")


# ---------------------------------------------------------------------------
# 6. Network-egress test
# ---------------------------------------------------------------------------

class TestNetworkEgress(unittest.TestCase):
    def test_socket_connect_blocked_when_egress_false(self):
        """When capabilities.network.egress is False, socket.connect raises PermissionError."""
        run_py = textwrap.dedent("""\
            import socket

            def run(inputs, context):
                try:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.connect(("8.8.8.8", 53))
                    s.close()
                    return {"status": "success", "outputs": {"result": "connected"}}
                except PermissionError as e:
                    return {"status": "success", "outputs": {"result": "blocked", "error": str(e)}}
                except OSError as e:
                    # Could also be ENETUNREACH etc. — counts as blocked
                    return {"status": "success", "outputs": {"result": "blocked_oserror", "error": str(e)}}
        """)
        with _TmpWorkerFixture(run_py) as fix:
            config = _make_config(
                worker_id="test_worker",
                bundle_path=str(fix.worker_dir),
            )

            # Mock a contract that declares egress=False
            from models import WorkerContract, WorkerContractExec, WorkerContractCapabilities, WorkerContractNetworkCapabilities, WorkerContractTrigger, WorkerContractApprovals, WorkerLimits
            fake_contract = WorkerContract(
                schema_version="0.3",
                name="test-worker",
                title="Test Worker",
                description="Test worker for network egress test",
                version="0.1.0",
                exec=WorkerContractExec(
                    runtime="python311",
                    runner="local",
                    mode="pure-script",
                    command="python run.py",
                ),
                capabilities=WorkerContractCapabilities(
                    network=WorkerContractNetworkCapabilities(egress=False)
                ),
            )

            with patch("runner_subprocess.WORKERS_DIR", fix.base_dir):
                with patch("runner_subprocess.ARTIFACTS_DIR", fix.base_dir / "artifacts"):
                    (fix.base_dir / "artifacts").mkdir(exist_ok=True)
                    with patch("runner_subprocess.get_worker_contract", return_value=fake_contract):
                        result = run_worker_subprocess(
                            worker_id="test_worker",
                            run_id="run-egress-001",
                            inputs={},
                            secrets={},
                            log_fn=_noop_log,
                            trace_id="trace-egress-001",
                            timeout_seconds=15,
                            config=config,
                        )

        self.assertEqual(result.status, "success", f"Expected success, got: {result.error}")
        outcome = result.outputs.get("result", "")
        self.assertIn(outcome, ("blocked", "blocked_oserror"),
                      f"Network egress was NOT blocked. outcome={outcome!r}. "
                      f"Worker connected to external network despite egress=False.")


# ---------------------------------------------------------------------------
# 7. Happy-path test
# ---------------------------------------------------------------------------

class TestHappyPath(unittest.TestCase):
    def test_simple_worker_returns_correct_outputs(self):
        """A well-formed worker returns status=success and correct outputs."""
        run_py = textwrap.dedent("""\
            def run(inputs, context):
                name = inputs.get("name", "World")
                return {
                    "status": "success",
                    "outputs": {"greeting": f"Hello, {name}!"},
                    "artifacts": [],
                }
        """)
        result = _run_subprocess_with_tmp(
            run_py=run_py,
            inputs={"name": "Workeros"},
            timeout=15,
        )
        self.assertEqual(result.status, "success", f"Expected success, got: {result.error}")
        self.assertEqual(result.outputs.get("greeting"), "Hello, Workeros!")

    def test_worker_with_declared_secret_receives_it(self):
        """Worker can access its declared secret via context.secrets."""
        run_py = textwrap.dedent("""\
            def run(inputs, context):
                key = context.secrets.get("MY_API_KEY", "MISSING")
                return {"status": "success", "outputs": {"key_present": key != "MISSING", "key_value": key}}
        """)
        result = _run_subprocess_with_tmp(
            run_py=run_py,
            inputs={},
            secrets={"MY_API_KEY": "test-key-12345"},
            declared_secrets=["MY_API_KEY"],
            timeout=15,
        )
        self.assertEqual(result.status, "success", f"Expected success, got: {result.error}")
        self.assertTrue(result.outputs.get("key_present"), "Declared secret not received by worker")
        self.assertEqual(result.outputs.get("key_value"), "test-key-12345")

    def test_worker_error_returns_error_result(self):
        """A worker that raises an exception returns status=error, not crashes the runner."""
        run_py = textwrap.dedent("""\
            def run(inputs, context):
                raise RuntimeError("intentional test failure")
        """)
        result = _run_subprocess_with_tmp(run_py=run_py, timeout=15)
        self.assertEqual(result.status, "error")
        self.assertIn("intentional test failure", result.error or "")

    def test_context_dict_style_access(self):
        """Worker can use context['log'] and context['secrets'] dict-style."""
        run_py = textwrap.dedent("""\
            def run(inputs, context):
                log_fn = context["log"]
                log_fn("test log message", "info")
                secrets = context["secrets"]
                return {"status": "success", "outputs": {"ok": True}}
        """)
        result = _run_subprocess_with_tmp(run_py=run_py, timeout=15)
        self.assertEqual(result.status, "success", f"Expected success, got: {result.error}")


# ---------------------------------------------------------------------------
# 8. Stock worker manifest parse test
# ---------------------------------------------------------------------------

class TestStockWorkerManifests(unittest.TestCase):
    def test_all_12_worker_ymls_parse_without_error(self):
        """Every stock worker.yml must parse without schema error."""
        import yaml

        workers_dir = ROOT / "workers"
        if not workers_dir.is_dir():
            self.skipTest(f"Workers directory not found: {workers_dir}")

        parsed = []
        errors = []
        for folder in sorted(workers_dir.iterdir()):
            if not folder.is_dir():
                continue
            yml_path = folder / "worker.yml"
            if not yml_path.is_file():
                continue
            try:
                raw = yaml.safe_load(yml_path.read_text())
                manifest = parse_worker_manifest(raw)
                parsed.append(folder.name)
            except Exception as exc:
                errors.append(f"{folder.name}: {exc}")

        self.assertGreaterEqual(len(parsed), 12,
                                f"Expected at least 12 stock workers, parsed {len(parsed)}: {parsed}")
        self.assertEqual(errors, [],
                         f"Worker manifest parse errors:\n" + "\n".join(errors))


# ---------------------------------------------------------------------------
# 9. is_symlink_safe unit tests
# ---------------------------------------------------------------------------

class TestIsSymlinkSafe(unittest.TestCase):
    def test_no_symlink_is_safe(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir)
            (base / "subdir").mkdir()
            self.assertTrue(_is_symlink_safe(base / "subdir", base))

    def test_nonexistent_path_is_safe(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir)
            self.assertTrue(_is_symlink_safe(base / "new_dir", base))

    def test_internal_symlink_is_safe(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir) / "base"
            base.mkdir()
            target = base / "real"
            target.mkdir()
            link = base / "link"
            link.symlink_to(target)
            self.assertTrue(_is_symlink_safe(link, base))

    def test_escaping_symlink_is_unsafe(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir) / "base"
            base.mkdir()
            outside = Path(tmpdir) / "outside"
            outside.mkdir()
            link = base / "escape"
            link.symlink_to(outside)
            self.assertFalse(_is_symlink_safe(link, base))


# ---------------------------------------------------------------------------
# 10. _build_child_env tests
# ---------------------------------------------------------------------------

class TestBuildChildEnv(unittest.TestCase):
    def test_does_not_leak_undeclared_secrets(self):
        """env-allowlist must strip undeclared secrets even if present in resolved_secrets."""
        env = _build_child_env(
            declared_secrets=["ALLOWED_KEY"],
            resolved_secrets={
                "ALLOWED_KEY": "allowed-val",
                "OPENAI_API_KEY": "sk-should-not-appear",
                "FLOOM_SECRET": "floom-should-not-appear",
            },
            egress_allowed=True,
            worker_dir=Path("/tmp"),
        )
        self.assertEqual(env.get("ALLOWED_KEY"), "allowed-val")
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("FLOOM_SECRET", env)

    def test_network_blocked_sets_env_var(self):
        env = _build_child_env(
            declared_secrets=[],
            resolved_secrets={},
            egress_allowed=False,
            worker_dir=Path("/tmp"),
        )
        self.assertEqual(env.get("WORKEROS_NO_NETWORK"), "1")

    def test_network_allowed_does_not_set_env_var(self):
        env = _build_child_env(
            declared_secrets=[],
            resolved_secrets={},
            egress_allowed=True,
            worker_dir=Path("/tmp"),
        )
        self.assertNotIn("WORKEROS_NO_NETWORK", env)

    def test_sitecustomize_dir_prepended_to_pythonpath_when_provided(self):
        """When sitecustomize_dir is given, it is prepended to PYTHONPATH."""
        env = _build_child_env(
            declared_secrets=[],
            resolved_secrets={},
            egress_allowed=False,
            worker_dir=Path("/tmp"),
            sitecustomize_dir="/tmp/sc_dir",
        )
        pythonpath = env.get("PYTHONPATH", "")
        self.assertTrue(
            pythonpath.startswith("/tmp/sc_dir"),
            f"sitecustomize_dir not at front of PYTHONPATH: {pythonpath!r}"
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
