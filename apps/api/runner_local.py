"""Local Python runner — executes trusted worker code in-process.

SECURITY: This runner uses ``exec()`` and is intended **only for trusted
local code**.  For untrusted or user-submitted code, use the E2B sandbox
runner (future) or a subprocess-based runner.
"""

import csv
import io
import os
import sys
import json
import uuid
import traceback
import logging
from typing import Dict, Any, Callable, List, Optional
from pathlib import Path

from models import WorkerConfig, WorkerContext, WorkerResult
from worker_registry import get_worker_entrypoint, get_worker_config

logger = logging.getLogger("floom.runner_local")

WORKERS_DIR = Path(os.environ.get("FLOOM_WORKERS_DIR", "../../workers")).resolve()
ARTIFACTS_DIR = Path(os.environ.get("FLOOM_ARTIFACTS_DIR", "../../data/artifacts")).resolve()

DEFAULT_TIMEOUT_SECONDS = int(os.environ.get("FLOOM_RUN_TIMEOUT", "300"))


def _safe_path(base: Path, *parts: str) -> Path:
    target = base.joinpath(*parts).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
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


def _resolve_connections(
    worker_id: str,
    log_fn: Callable,
    config: Optional[WorkerConfig] = None,
) -> tuple[Dict[str, str], Optional[str]]:
    """Look up active Composio connections for the worker's declared apps.

    Returns (connection_ids dict, error_string_or_None).
    error_string is set if any declared connection is missing/inactive.
    """
    config = config or get_worker_config(worker_id)
    if not config or not config.connections:
        return {}, None

    from db import get_db

    missing = []
    connection_ids: Dict[str, str] = {}

    with get_db() as conn:
        cursor = conn.cursor()
        for app_name in config.connections:
            cursor.execute(
                "SELECT composio_connection_id, status FROM composio_connections WHERE app_name = ?",
                (app_name.lower(),),
            )
            row = cursor.fetchone()
            if row and row["status"] == "active":
                connection_ids[app_name.lower()] = row["composio_connection_id"]
            else:
                missing.append(app_name)

    if missing:
        log_fn(f"Missing connections: {', '.join(missing)}", level="error")
        return {}, f"missing_connection: {', '.join(missing)}"

    return connection_ids, None


def make_context(
    run_id: str,
    worker_id: str,
    secrets: Dict[str, str],
    log_fn: Callable,
    trace_id: str,
    connection_ids: Optional[Dict[str, str]] = None,
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
        connection_ids=connection_ids or {},
    )


def _validate_output_schema(
    worker_id: str,
    outputs: Dict[str, Any],
    log_fn: Callable,
    config: Optional[WorkerConfig] = None,
) -> Optional[str]:
    """Validate worker outputs against the declared schema in worker.yml.

    Returns an error string if validation fails, or None if outputs are valid.
    """
    config = config or get_worker_config(worker_id)
    if not config or not config.outputs:
        return None  # No schema declared — skip validation

    for declared in config.outputs:
        name = declared.name
        output_type = declared.type

        if name not in outputs:
            return f"Missing declared output '{name}'"

        value = outputs[name]

        # None is only allowed for optional outputs; treat as error if declared
        if value is None:
            return f"Declared output '{name}' is None"

        # Type-specific validation
        if output_type == "csv":
            if not isinstance(value, str) or not value.strip():
                return f"Output '{name}' (type: csv) must be a non-empty string"
            try:
                reader = csv.reader(io.StringIO(value))
                rows = list(reader)
                if len(rows) < 1:
                    return f"Output '{name}' (type: csv) parsed as empty CSV"
                # Column contract enforcement: if worker.yml declares columns, validate header
                if declared.columns:
                    actual_header = [c.strip() for c in rows[0]]
                    expected_header = list(declared.columns)
                    if actual_header != expected_header:
                        return (
                            f"schema_violation_columns: Output '{name}' column mismatch. "
                            f"Expected: {expected_header}, got: {actual_header}"
                        )
            except Exception as exc:
                return f"Output '{name}' (type: csv) failed CSV parse: {exc}"

        elif output_type == "json":
            parsed_json = None
            if isinstance(value, str):
                try:
                    parsed_json = json.loads(value)
                except json.JSONDecodeError as exc:
                    return f"Output '{name}' (type: json) is not valid JSON: {exc}"
            elif isinstance(value, (dict, list)):
                parsed_json = value
            else:
                return f"Output '{name}' (type: json) must be a JSON string or dict/list"
            # Required key contract enforcement
            if declared.json_required_keys and isinstance(parsed_json, dict):
                missing_keys = [k for k in declared.json_required_keys if k not in parsed_json]
                if missing_keys:
                    return (
                        f"schema_violation_columns: Output '{name}' (type: json) missing required keys: "
                        f"{missing_keys}"
                    )

        elif output_type in ("markdown", "text"):
            if not isinstance(value, str) or not value.strip():
                return f"Output '{name}' (type: {output_type}) must be a non-empty string"

    return None


def run_worker_local(
    worker_id: str,
    run_id: str,
    inputs: Dict[str, Any],
    secrets: Dict[str, str],
    log_fn: Callable,
    trace_id: str,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    config: Optional[WorkerConfig] = None,
) -> WorkerResult:
    """Execute a worker's ``run.py`` in-process.

    Returns a :class:`WorkerResult` regardless of success or failure so the
    caller can always persist a terminal state.
    """
    try:
        worker_dir = _worker_dir_for_run(worker_id, config)
    except ValueError as exc:
        logger.error("Invalid worker_id: %s", exc)
        return WorkerResult(status="error", error=str(exc), error_code="invalid_worker")

    entrypoint = config.runtime.entrypoint if config and config.runtime else get_worker_entrypoint(worker_id)
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

    # Resolve Composio connections — fail fast if any required connection is missing
    connection_ids, conn_error = _resolve_connections(worker_id, log_fn, config=config)
    if conn_error:
        return WorkerResult(
            status="error",
            error=conn_error,
            error_code="missing_connection",
        )

    context = make_context(run_id, worker_id, secrets, log_fn, trace_id, connection_ids=connection_ids)

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
        previous_cwd = os.getcwd()
        try:
            os.chdir(worker_dir)
            result = run_fn(inputs, context)
        finally:
            os.chdir(previous_cwd)

        if not isinstance(result, dict):
            return WorkerResult(
                status="error",
                error="Worker run() must return a dict",
                error_code="invalid_return_type",
            )

        # --- Schema enforcement ---
        # Only validate on successful runs; error results skip validation.
        if result.get("status") == "success":
            schema_error = _validate_output_schema(
                worker_id,
                result.get("outputs", {}),
                log_fn,
                config=config,
            )
            if schema_error:
                log_fn(f"Schema validation failed: {schema_error}", level="error")
                return WorkerResult(
                    status="failed",
                    error=f"Output schema violation: {schema_error}",
                    error_code="schema_violation",
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
