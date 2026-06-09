"""Worker runtime utilities (helpers only, not an executor).

This module used to host an in-process worker executor (`run_worker_local`).
That executor was REMOVED in PR #28 when the platform switched to E2B-only
execution. Only utility helpers remain, used by the E2B sandbox drivers and
the API server:

  - ARTIFACTS_DIR, WORKERS_DIR, DEFAULT_TIMEOUT_SECONDS constants
  - _validate_output_schema, _safe_path, _resolve_connections helpers
  - make_context: builds a WorkerContext (used by the E2B driver to prepare
    the inputs/secrets/connections payload that gets serialized into the
    sandbox).

DO NOT add a workers-execute-in-process path to this module. Workers must
run inside E2B sandbox microVMs via `runner_sandbox.E2BSandboxDriver`. See
ARCHITECTURE.md at the repo root.

(Renamed from `runner_local.py` to `runner_utils.py` to remove the misleading
name; auditors had assumed the file still executed workers locally and
fabricated catastrophic findings based on that assumption.)
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

from models import WorkerConfig, WorkerContext, WorkerResult, declared_composio_connections
from worker_registry import get_worker_config

logger = logging.getLogger("floom.runner_utils")

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
    user_id: Optional[str] = None,
) -> tuple[Dict[str, str], Optional[str]]:
    """Look up active Composio connections for the worker's declared apps.

    Returns (connection_ids dict, error_string_or_None).
    error_string is set if any declared connection is missing/inactive.
    """
    config = config or get_worker_config(worker_id)
    declared = declared_composio_connections(config)
    if not declared:
        return {}, None

    from db import get_db

    missing = []
    connection_ids: Dict[str, str] = {}

    with get_db() as conn:
        cursor = conn.cursor()
        for app_name in declared:
            if user_id:
                cursor.execute(
                    """
                    SELECT composio_connection_id, status
                    FROM composio_connections
                    WHERE app_name = ? AND user_id = ? AND status = 'active'
                    ORDER BY updated_at DESC
                    LIMIT 1
                    """,
                    (app_name.lower(), user_id),
                )
            else:
                cursor.execute(
                    """
                    SELECT composio_connection_id, status
                    FROM composio_connections
                    WHERE app_name = ? AND status = 'active'
                    ORDER BY updated_at DESC
                    LIMIT 1
                    """,
                    (app_name.lower(),),
                )
            row = cursor.fetchone()
            if row:
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
        return None  # No schema declared, skip validation

    for declared in config.outputs:
        name = declared.name
        output_type = declared.type

        # File-backed outputs (kind: file) are validated by _validate_run_outputs
        # (the run-outputs gate): it checks the actual file exists, is non-empty,
        # and — for application/json media — parses. The scalar `type` contract
        # below does NOT apply: a file output's value is a path string or absent,
        # not the JSON/CSV content itself. Skip them here so we don't reject
        # legitimate file-mode workers (e.g. `kind: file, media_type:
        # application/json, path: out/result.json`) that store a path in the
        # output value. The two validators are mutually exclusive by `kind`.
        kind = declared.kind or ("file" if output_type == "file" else "scalar")
        if kind == "file":
            continue

        if name not in outputs:
            if declared.required:
                return f"Missing declared output '{name}'"
            continue

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



# run_worker_local() removed 2026-05-26: the in-process local runner was
# deleted because it gave worker code full host access (malicious-bundle
# audit landed at 45/100). The helpers above remain because runtime drivers
# and main.py still use ARTIFACTS_DIR, _validate_output_schema, _safe_path,
# and related context utilities.
