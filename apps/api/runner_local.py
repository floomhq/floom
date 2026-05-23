"""Local Python runner — executes trusted worker code in-process.

SECURITY: This runner uses ``exec()`` and is intended **only for trusted
local code**.  For untrusted or user-submitted code, use the E2B sandbox
runner (future) or a subprocess-based runner.
"""

import os
import sys
import json
import uuid
import traceback
import logging
from typing import Dict, Any, Callable, Optional
from pathlib import Path

from models import WorkerContext, WorkerResult
from worker_registry import get_worker_entrypoint

logger = logging.getLogger("floom.runner_local")

WORKERS_DIR = Path(os.environ.get("FLOOM_WORKERS_DIR", "../../workers")).resolve()
ARTIFACTS_DIR = Path(os.environ.get("FLOOM_ARTIFACTS_DIR", "../../data/artifacts")).resolve()

DEFAULT_TIMEOUT_SECONDS = int(os.environ.get("FLOOM_RUN_TIMEOUT", "300"))


def _safe_path(base: Path, *parts: str) -> Path:
    target = base.joinpath(*parts).resolve()
    if not str(target).startswith(str(base)):
        raise ValueError(f"Path traversal attempt: {target}")
    return target


def make_context(
    run_id: str,
    worker_id: str,
    secrets: Dict[str, str],
    log_fn: Callable,
    trace_id: str,
) -> WorkerContext:
    artifact_dir = _safe_path(ARTIFACTS_DIR, run_id)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    return WorkerContext(
        run_id=run_id,
        worker_id=worker_id,
        secrets=secrets,
        artifact_dir=str(artifact_dir),
        trace_id=trace_id,
        log_fn=log_fn,
    )


def run_worker_local(
    worker_id: str,
    run_id: str,
    inputs: Dict[str, Any],
    secrets: Dict[str, str],
    log_fn: Callable,
    trace_id: str,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> WorkerResult:
    """Execute a worker's ``run.py`` in-process.

    Returns a :class:`WorkerResult` regardless of success or failure so the
    caller can always persist a terminal state.
    """
    try:
        worker_dir = _safe_path(WORKERS_DIR, worker_id)
    except ValueError as exc:
        logger.error("Invalid worker_id: %s", exc)
        return WorkerResult(status="error", error=str(exc), error_code="invalid_worker")

    entrypoint = get_worker_entrypoint(worker_id)
    try:
        run_file = _safe_path(worker_dir, entrypoint)
    except ValueError as exc:
        logger.error("Invalid entrypoint: %s", exc)
        return WorkerResult(status="error", error=str(exc), error_code="invalid_entrypoint")

    if not run_file.is_file():
        return WorkerResult(
            status="error",
            error=f"Entrypoint not found: {run_file}",
            error_code="entrypoint_not_found",
        )

    context = make_context(run_id, worker_id, secrets, log_fn, trace_id)

    # Compile and execute in a restricted namespace.
    # NOTE: ``exec()`` with restricted globals is *not* a security sandbox.
    # It only prevents accidental pollution of the global namespace.
    try:
        log_fn("Loading worker module", level="debug")
        source = run_file.read_text()
        code = compile(source, str(run_file), "exec")

        module_globals: Dict[str, Any] = {
            "__name__": "__worker__",
            "__file__": str(run_file),
        }
        exec(code, module_globals)

        if "run" not in module_globals:
            return WorkerResult(
                status="error",
                error="Worker does not expose a run() function",
                error_code="missing_run_function",
            )

        run_fn = module_globals["run"]
        log_fn("Executing worker run()", level="debug")

        # NOTE: In-process execution cannot enforce a true timeout via
        # signal/alarm because it runs inside the same thread.  For a
        # hard timeout, switch to the subprocess or E2B runner.
        result = run_fn(inputs, context)

        if not isinstance(result, dict):
            return WorkerResult(
                status="error",
                error="Worker run() must return a dict",
                error_code="invalid_return_type",
            )

        return WorkerResult(
            status=result.get("status", "error"),
            outputs=result.get("outputs", {}),
            artifacts=result.get("artifacts", []),
            error=result.get("error"),
            error_code=result.get("error_code"),
            retryable=result.get("retryable", False),
        )
    except Exception as exc:
        tb = traceback.format_exc()
        logger.exception("Worker execution failed: %s", exc)
        log_fn(f"Error during execution: {exc}", level="error")
        return WorkerResult(
            status="error",
            error=str(exc),
            error_code="execution_error",
            retryable=True,
        )
