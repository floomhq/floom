"""E2B cloud sandbox driver for Workeros — uses e2b SDK 2.x.

Worker protocol: run.py in an E2B worker reads inputs from inputs.json and
MUST write result.json with:
  {"status": "success"|"error", "outputs": {...}, "error": null|"..."}
"""

import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .base import SandboxDriver
from models import WorkerConfig, WorkerResult
from worker_registry import WORKERS_DIR

logger = logging.getLogger("floom.runner_sandbox.e2b")


def _safe_path(base: Path, *parts: str) -> Path:
    target = base.joinpath(*parts).resolve()
    if not str(target).startswith(str(base)):
        raise ValueError(f"Path traversal attempt: {target}")
    return target


def _worker_dir_for_run(worker_id: str, config: Optional[WorkerConfig]) -> Path:
    bundle_path = config.runtime.bundle_path if config and config.runtime else None
    if bundle_path:
        raw_path = Path(bundle_path)
        target = raw_path if raw_path.is_absolute() else WORKERS_DIR.parent.joinpath(raw_path)
        resolved = target.resolve()
        allowed_root = WORKERS_DIR.parent.resolve()
        try:
            resolved.relative_to(allowed_root)
        except ValueError:
            raise ValueError(f"Path traversal attempt: {resolved}")
        return resolved
    return _safe_path(WORKERS_DIR, worker_id)


class E2BSandboxDriver(SandboxDriver):
    """Runs worker code in an E2B cloud sandbox (e2b SDK 2.x).

    The worker's run.py MUST:
    1. Read inputs from inputs.json
    2. Optionally read secrets from secrets.json
    3. Write result.json with {"status": ..., "outputs": {...}, "error": ...}
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
        try:
            return self._run_in_sandbox(
                worker_id, run_id, inputs, secrets, log_fn, trace_id, timeout_seconds, config
            )
        except Exception as exc:
            logger.exception(
                "E2B sandbox failed for worker %s run %s: %s", worker_id, run_id, exc
            )
            log_fn(f"E2B sandbox error: {exc}", "error")
            return WorkerResult(
                status="error",
                error=str(exc),
                error_code="e2b_sandbox_error",
                retryable=True,
            )

    def _run_in_sandbox(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int,
        config: Optional[WorkerConfig],
    ) -> WorkerResult:
        from e2b import Sandbox  # e2b 2.x

        api_key = os.environ.get("E2B_API_KEY")
        if not api_key:
            return WorkerResult(
                status="error",
                error="E2B_API_KEY is not configured",
                error_code="missing_e2b_key",
            )

        try:
            worker_dir = _worker_dir_for_run(worker_id, config)
        except ValueError as exc:
            return WorkerResult(
                status="error", error=str(exc), error_code="invalid_worker"
            )

        if not worker_dir.is_dir():
            return WorkerResult(
                status="error",
                error=f"Worker directory not found: {worker_dir}",
                error_code="worker_not_found",
            )

        log_fn(f"[e2b] Spawning sandbox for run {run_id}", "info")

        # e2b 2.x: use Sandbox.create()
        sandbox = Sandbox.create(
            api_key=api_key,
            timeout=max(timeout_seconds + 60, 180),
            envs={
                "FLOOM_RUN_ID": run_id,
                "FLOOM_TRACE_ID": trace_id,
            },
        )

        try:
            workdir = "/home/user/worker"
            sandbox.files.make_dir(workdir)

            # Upload worker files
            for fpath in worker_dir.iterdir():
                if fpath.is_file():
                    content = fpath.read_bytes()
                    sandbox.files.write(f"{workdir}/{fpath.name}", content)
                    log_fn(f"[e2b] Uploaded {fpath.name}", "debug")

            # Write inputs.json
            sandbox.files.write(
                f"{workdir}/inputs.json",
                json.dumps(inputs, indent=2),
            )

            # Write secrets.json (ephemeral — only visible inside sandbox)
            sandbox.files.write(
                f"{workdir}/secrets.json",
                json.dumps(secrets, indent=2),
            )

            # Install requirements if present and non-empty
            req_path = worker_dir / "requirements.txt"
            if req_path.exists() and req_path.read_text().strip():
                log_fn("[e2b] Installing requirements.txt...", "info")
                # e2b 2.x: commands.run() is synchronous — returns CommandResult directly
                install_result = sandbox.commands.run(
                    f"pip install -q -r {workdir}/requirements.txt",
                    timeout=180,
                )
                if install_result.exit_code != 0:
                    err = (
                        f"pip install failed (exit {install_result.exit_code}): "
                        f"{(install_result.stderr or '')[:500]}"
                    )
                    log_fn(f"[e2b] {err}", "error")
                    return WorkerResult(
                        status="error",
                        error=err,
                        error_code="install_failed",
                    )
                log_fn("[e2b] Requirements installed", "info")

            # Run the worker — commands.run() is sync, returns CommandResult directly
            command = "python run.py"
            if config and config.runtime and config.runtime.command:
                command = config.runtime.command
            log_fn(f"[e2b] Executing worker command: {command}", "info")
            proc = sandbox.commands.run(
                command,
                cwd=workdir,
                envs={
                    "FLOOM_RUN_ID": run_id,
                    "FLOOM_TRACE_ID": trace_id,
                },
                timeout=float(timeout_seconds),
            )

            # Capture logs
            if proc.stdout:
                for line in proc.stdout.splitlines():
                    line = line.strip()
                    if line:
                        log_fn(f"[e2b] {line}", "info")
            if proc.stderr:
                for line in proc.stderr.splitlines():
                    line = line.strip()
                    if line:
                        log_fn(f"[e2b] stderr: {line}", "warning")

            if proc.exit_code != 0:
                err = f"Worker exited with code {proc.exit_code}"
                stderr_snippet = (proc.stderr or "")[:200].strip()
                if stderr_snippet:
                    err += f": {stderr_snippet}"
                log_fn(f"[e2b] {err}", "error")
                return WorkerResult(
                    status="error",
                    error=err,
                    error_code="execution_error",
                    retryable=False,
                )

            # Read result.json
            try:
                result_raw = sandbox.files.read(f"{workdir}/result.json")
                result_data = json.loads(result_raw)
            except Exception as exc:
                log_fn(f"[e2b] Failed to read result.json: {exc}", "error")
                return WorkerResult(
                    status="error",
                    error=f"Worker did not produce result.json: {exc}",
                    error_code="missing_result",
                )

            log_fn("[e2b] Run completed successfully", "info")
            return WorkerResult(
                status=result_data.get("status", "success"),
                outputs=result_data.get("outputs", {}),
                artifacts=result_data.get("artifacts", []),
                error=result_data.get("error"),
                error_code=result_data.get("error_code"),
            )

        finally:
            try:
                # e2b 2.x: kill() may raise if the sandbox already exited.
                # We attempt gracefully; any exception is a warning, not a failure.
                sandbox.kill()
                log_fn("[e2b] Sandbox killed", "debug")
            except Exception as close_exc:
                # Sandbox may have self-terminated (timeout, OOM) — not an error.
                logger.debug("E2B sandbox already gone (kill suppressed): %s", close_exc)
