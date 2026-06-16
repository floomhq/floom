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


def _extra_worker_roots() -> list[Path]:
    """Additional legitimate worker-source roots beyond FLOOM_WORKERS_DIR.

    Cloud historically materialized a class of seeded/example worker bundles
    under ``/opt/managed-deployment/var/workers`` (the ``var/workers`` dir the
    #1048 audit flagged) and stored their absolute path in
    ``skill_versions.bundle_path``. Those bundles live ONLY there, not under
    the deployed ``engine/workers`` tree, so a scheduled run must be allowed to
    resolve a stored absolute bundle_path under one of these explicitly-listed
    roots. Set ``FLOOM_EXTRA_WORKERS_DIRS`` to a colon-separated list to permit
    them; absent the env, behaviour is identical to before (single root).
    """
    raw = os.environ.get("FLOOM_EXTRA_WORKERS_DIRS", "")
    roots: list[Path] = []
    for part in raw.split(os.pathsep):
        part = part.strip()
        if part:
            roots.append(Path(part).resolve())
    return roots

DEFAULT_TIMEOUT_SECONDS = int(os.environ.get("FLOOM_RUN_TIMEOUT", "300"))

def _safe_path(base: Path, *parts: str) -> Path:
    """Join *parts* under *base*, rejecting traversal escapes.

    Containment is checked against the lexically-normalised path (not the
    symlink-followed realpath) so a symlinked deploy root (e.g. Railway's
    ``/opt/.../var`` -> ``/data/var``) does not falsely trip the guard on a
    valid ``<base>/<worker_id>`` path. Absolute parts and ``..`` segments are
    still rejected.
    """
    for part in parts:
        p = Path(part)
        if p.is_absolute() or ".." in p.parts:
            raise ValueError(f"Path traversal attempt: {base.joinpath(*parts)}")
    norm_base = Path(os.path.normpath(str(base)))
    target = Path(os.path.normpath(str(norm_base.joinpath(*parts))))
    try:
        target.relative_to(norm_base)
    except ValueError:
        raise ValueError(f"Path traversal attempt: {target}")
    # Defense-in-depth: after the lexical check passes, follow symlinks and
    # assert the *real* target stays under the *real* base. Callers pass an
    # already-resolved base (WORKERS_DIR/ARTIFACTS_DIR are ``.resolve()``d at
    # import), so a symlinked deploy root collapses consistently on both sides
    # and never false-positives. realpath of a not-yet-existing leaf resolves
    # the existing prefix, so creating new run/worker dirs is unaffected. This
    # catches a symlink *inside* the base that points outside it.
    real_base = os.path.realpath(str(norm_base))
    real_target = os.path.realpath(str(target))
    try:
        Path(real_target).relative_to(real_base)
    except ValueError:
        raise ValueError(f"Path traversal attempt (symlink escape): {target}")
    return target


def _assert_realpath_contained(resolved: Path, root: Path) -> Path:
    """Reject *resolved* if its symlink-followed realpath escapes *root*.

    A-05 parity fix: the accepted-absolute ``bundle_path`` branches of
    ``_resolve_worker_bundle_dir`` returned a path after only a ``relative_to``
    check, skipping the realpath/symlink-containment assert that ``_safe_path``
    applies on every other branch. A symlink *inside* an allowed root that
    points outside it (``<root>/foo -> /etc``) could therefore be honoured.
    This routes those branches through the same ``os.path.realpath`` containment
    guard ``_safe_path`` uses, so a symlink escape is rejected everywhere.
    """
    real_target = os.path.realpath(str(resolved))
    real_root = os.path.realpath(str(root))
    try:
        Path(real_target).relative_to(real_root)
    except ValueError:
        raise ValueError(
            f"Path traversal attempt (symlink escape): {resolved}"
        )
    return resolved


def _worker_dir_for_run(worker_id: str, config: Optional[WorkerConfig]) -> Path:
    return _resolve_worker_bundle_dir(WORKERS_DIR, worker_id, config, _safe_path)


def _resolve_worker_bundle_dir(
    workers_dir: Path,
    worker_id: str,
    config: Optional["WorkerConfig"],
    safe_path: Callable[..., Path],
) -> Path:
    """Resolve a worker's bundle dir under the *configured* WORKERS_DIR.

    Fixes the ``var/workers`` vs ``engine/workers`` drift (#1048 follow-up):
    a worker's ``runtime.bundle_path`` can be a STALE ABSOLUTE path baked at
    registration time from an older ``FLOOM_WORKERS_DIR`` (e.g.
    ``/opt/managed-deployment/var/workers/job-digest``). At run time
    ``FLOOM_WORKERS_DIR`` points at ``.../engine/workers``, so the stale
    absolute path resolves outside the current root and the traversal guard
    rejected a legitimate scheduled run.

    Resolution order, traversal guard intact throughout:
      1. If a relative bundle_path is stored as ``workers/<id>``, join it under
         ``WORKERS_DIR.parent`` (the historical contract). If it is a bare
         worker id, resolve it under the configured ``WORKERS_DIR``.
      2. Otherwise (or if an absolute bundle_path escapes the current root —
         the drift case), resolve the worker by its basename under the
         *current* ``WORKERS_DIR`` via ``safe_path`` (which still rejects
         ``..`` and symlink escapes).
    """
    bundle_path = config.runtime.bundle_path if config and config.runtime else None
    allowed_root = workers_dir.parent.resolve()
    if bundle_path:
        raw_path = Path(bundle_path)
        if not raw_path.is_absolute():
            parts = raw_path.parts
            relative_root = workers_dir.parent if parts and parts[0] == workers_dir.name else workers_dir
            resolved = relative_root.joinpath(raw_path).resolve()
            try:
                resolved.relative_to(relative_root.resolve())
            except ValueError:
                # Relative path escaped the root (genuine traversal): reject.
                raise ValueError(f"Path traversal attempt: {resolved}")
            return resolved
        # Absolute bundle_path. Accept it if it lives under the current allowed
        # root OR under an explicitly-allowed extra worker root (e.g. cloud's
        # var/workers) AND the directory actually exists. Otherwise treat it as
        # registration-time drift and fall back to basename resolution under the
        # configured dir. The traversal guard is preserved throughout: only
        # explicitly-listed roots are ever honoured.
        resolved = raw_path.resolve()
        under_allowed_root = False
        try:
            resolved.relative_to(allowed_root)
            under_allowed_root = True
        except ValueError:
            pass
        if under_allowed_root:
            # A-05 parity: assert realpath containment (symlink-escape guard)
            # before honouring the absolute path, matching _safe_path. A symlink
            # under allowed_root that escapes it must reject, not fall through.
            return _assert_realpath_contained(resolved, allowed_root)
        for extra in _extra_worker_roots():
            try:
                resolved.relative_to(extra)
            except ValueError:
                continue
            if resolved.is_dir():
                # A-05 parity: same realpath-containment assert for the
                # explicitly-allowed extra-root case.
                return _assert_realpath_contained(resolved, extra)
        logger.warning(
            "worker %s bundle_path %s is outside WORKERS_DIR %s and all extra "
            "worker roots (registration-time drift); resolving by basename "
            "under configured dir",
            worker_id,
            bundle_path,
            workers_dir,
        )
        return safe_path(workers_dir, Path(bundle_path).name)
    return safe_path(workers_dir, worker_id)


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
                sql = (
                    "SELECT composio_connection_id FROM composio_connections"
                    " WHERE app_name = ? AND user_id = ? AND status = 'active'"
                    " ORDER BY updated_at DESC LIMIT 1"
                )
                params: tuple = (app_name.lower(), user_id)
            else:
                sql = (
                    "SELECT composio_connection_id FROM composio_connections"
                    " WHERE app_name = ? AND status = 'active'"
                    " ORDER BY updated_at DESC LIMIT 1"
                )
                params = (app_name.lower(),)
            row = cursor.execute(sql, params).fetchone()
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
