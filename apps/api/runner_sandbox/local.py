"""Local in-process sandbox driver — wraps runner_local.run_worker_local."""

from typing import Any, Callable, Dict

from runner_local import run_worker_local
from .base import SandboxDriver
from models import WorkerResult


class LocalSandboxDriver(SandboxDriver):
    """Runs worker code in-process. Trusted local code only."""

    def run(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int = 300,
    ) -> WorkerResult:
        return run_worker_local(
            worker_id=worker_id,
            run_id=run_id,
            inputs=inputs,
            secrets=secrets,
            log_fn=log_fn,
            trace_id=trace_id,
            timeout_seconds=timeout_seconds,
        )
