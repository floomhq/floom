"""Subprocess sandbox driver — routes runner=local to the subprocess runner."""

from typing import Any, Callable, Dict, Optional

from runner_subprocess import run_worker_subprocess
from .base import SandboxDriver
from models import WorkerConfig, WorkerResult


class SubprocessSandboxDriver(SandboxDriver):
    """Runs worker code as an isolated child subprocess.

    Replaces LocalSandboxDriver for runner=local.  Provides:
      - env-allowlist (declared secrets only)
      - resource limits (memory, CPU, file size, open files)
      - real timeout via subprocess.run(timeout=) + SIGKILL
      - symlink-safe path checks
      - best-effort network egress enforcement
    """

    def run(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int = 300,
        config: Optional[WorkerConfig] = None,
    ) -> WorkerResult:
        return run_worker_subprocess(
            worker_id=worker_id,
            run_id=run_id,
            inputs=inputs,
            secrets=secrets,
            log_fn=log_fn,
            trace_id=trace_id,
            timeout_seconds=timeout_seconds,
            config=config,
        )
