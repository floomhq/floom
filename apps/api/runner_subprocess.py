"""Subprocess-based local runner — safe replacement for the in-process exec() runner.

Security improvements over runner_local.py (exec-based):
  - env-allowlist: child process receives ONLY PATH, HOME, LANG, LC_*, TZ,
    PYTHONPATH, and the worker's declared secrets. All host secrets (OPENAI,
    COMPOSIO, E2B, FLOOM_SECRET, etc.) are stripped unless the worker explicitly
    declares them in capabilities.secrets.
  - resource limits via resource.setrlimit (Linux only):
      RLIMIT_AS:    1 GB virtual memory cap
      RLIMIT_CPU:   timeout_seconds + 2 hard CPU seconds
      RLIMIT_FSIZE: 100 MB max output file size
      RLIMIT_NOFILE: 256 open file descriptors
  - real timeout: subprocess.run(timeout=) sends SIGKILL at deadline.
    No daemon threads left running after timeout.
  - symlink-safe: _safe_path_subprocess() uses lstat() to detect symlinks
    before Path.resolve() so a symlink pointing outside the base dir is
    rejected at the component level, not just at the final destination.
  - network egress enforcement (best-effort): when capabilities.network.egress
    is False the child env gets WORKEROS_NO_NETWORK=1 and PYTHONSTARTUP is set
    to a sitecustomize shim that monkey-patches socket.socket.connect. Workers
    using C extensions can still bypass this; the restriction is advisory.

The worker contract is unchanged:
    def run(inputs: dict, context) -> dict
where context is a SimpleNamespace whose attributes mirror WorkerContext.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import resource
import stat
import sys
import tempfile
import textwrap
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from models import WorkerConfig, WorkerContext, WorkerResult
from worker_registry import get_worker_entrypoint, get_worker_config, get_worker_contract

logger = logging.getLogger("floom.runner_subprocess")

WORKERS_DIR = Path(os.environ.get("FLOOM_WORKERS_DIR", "../../workers")).resolve()
ARTIFACTS_DIR = Path(os.environ.get("FLOOM_ARTIFACTS_DIR", "../../data/artifacts")).resolve()
DEFAULT_TIMEOUT_SECONDS = int(os.environ.get("FLOOM_RUN_TIMEOUT", "300"))

# Resource limits for the child process
_RLIMIT_AS_BYTES = 1 * 1024 * 1024 * 1024       # 1 GB virtual address space
_RLIMIT_FSIZE_BYTES = 100 * 1024 * 1024           # 100 MB max file write
_RLIMIT_NOFILE = 256                               # max open file descriptors

# Env vars always passed through to the child (no secrets in this set)
_PASSTHROUGH_ENV_PREFIXES = ("LC_",)
_PASSTHROUGH_ENV_KEYS = {"PATH", "HOME", "LANG", "TZ", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE"}

# sitecustomize shim that blocks socket.connect when WORKEROS_NO_NETWORK=1
_NETWORK_BLOCK_SHIM = textwrap.dedent("""\
    import os as _os
    if _os.environ.get("WORKEROS_NO_NETWORK") == "1":
        import socket as _socket
        _real_connect = _socket.socket.connect
        def _blocked_connect(self, address):
            raise PermissionError(
                f"Network egress is disabled for this worker. "
                f"Attempted connection to: {address}"
            )
        _socket.socket.connect = _blocked_connect
""")

# The adapter script executed inside the child process.
# It reads a JSON payload from a temp file, calls run(inputs, context),
# and writes the result dict to stdout as JSON.
_ADAPTER_SCRIPT = textwrap.dedent("""\
    import json
    import sys
    import types
    import importlib.util
    from pathlib import Path

    payload_path = sys.argv[1]
    with open(payload_path) as _f:
        _payload = json.load(_f)

    _inputs = _payload["inputs"]
    _secrets = _payload["secrets"]
    _connections = _payload["connections"]
    _run_id = _payload["run_id"]
    _worker_id = _payload["worker_id"]
    _artifact_dir = _payload["artifact_dir"]
    _trace_id = _payload["trace_id"]
    _run_file = _payload["run_file"]

    # Reconstruct context as a namespace that mirrors WorkerContext
    class _ConnectionsNS:
        def __init__(self, ids):
            self._ids = ids
        def __getattr__(self, name):
            if name.startswith("_"):
                raise AttributeError(name)
            v = self._ids.get(name)
            if not v:
                raise AttributeError(f"Connection '{name}' is not active.")
            return v
        def get(self, name):
            return self._ids.get(name)
        def __contains__(self, name):
            return name in self._ids

    _logs = []
    def _log_fn(msg, level="info"):
        _logs.append({"level": level, "message": str(msg)})
        print(f"[{level.upper()}] {msg}", file=sys.stderr, flush=True)

    class _Context:
        def __init__(self):
            self.run_id = _run_id
            self.worker_id = _worker_id
            self._secrets = _secrets
            self.artifact_dir = _artifact_dir
            self.trace_id = _trace_id
            self._log_fn = _log_fn
            self.connections = _ConnectionsNS(_connections)

        def log(self, message, level="info"):
            _log_fn(message, level=level)

        @property
        def secrets(self):
            return self._secrets

        def get_secret(self, name):
            return self._secrets.get(name)

        def __getitem__(self, key):
            if key == "log": return self._log_fn
            if key == "secrets": return self._secrets
            if key == "run_id": return self.run_id
            if key == "worker_id": return self.worker_id
            if key == "artifact_dir": return self.artifact_dir
            if key == "trace_id": return self.trace_id
            if key == "connections": return self.connections
            raise KeyError(key)

        def __contains__(self, key):
            return key in {"log","secrets","run_id","worker_id","artifact_dir","trace_id","connections"}

    _ctx = _Context()

    # Load the worker module
    _spec = importlib.util.spec_from_file_location("__worker__", _run_file)
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)

    if not hasattr(_mod, "run"):
        result = {"status": "error", "error": "Worker does not expose a run() function", "error_code": "missing_run_function"}
    else:
        try:
            result = _mod.run(_inputs, _ctx)
            if not isinstance(result, dict):
                result = {"status": "error", "error": "Worker run() must return a dict", "error_code": "invalid_return_type"}
        except Exception as _exc:
            import traceback as _tb
            result = {"status": "error", "error": str(_exc), "error_code": "execution_error", "retryable": True}

    result["_logs"] = _logs
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
""")


def _is_symlink_safe(path: Path, base: Path) -> bool:
    """Return True if no component of path is a symlink escaping base.

    Uses lstat() at each path component to detect symlinks BEFORE resolving,
    so a symlink pointing outside base is caught even if the final resolved
    path happens to be inside base.
    """
    base_resolved = base.resolve()
    # Build the path incrementally and check each component
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            st = current.lstat()
        except (OSError, PermissionError):
            return True  # doesn't exist yet — no symlink risk
        if stat.S_ISLNK(st.st_mode):
            # It's a symlink. Check if the resolved target is inside base.
            try:
                resolved_target = current.resolve()
                resolved_target.relative_to(base_resolved)
                # Symlink target is inside base — acceptable.
                # But continue checking further components on the resolved path.
                current = resolved_target
            except ValueError:
                return False  # symlink escapes base
    return True


def _safe_path_subprocess(base: Path, *parts: str) -> Path:
    """Like runner_local._safe_path but also detects symlinks at each component."""
    candidate = base.joinpath(*parts)
    # First check absolute resolved path containment (existing check)
    try:
        resolved = candidate.resolve()
        resolved.relative_to(base.resolve())
    except ValueError:
        raise ValueError(f"Path traversal attempt: {candidate}")
    # Then check for symlink escape at each component
    if not _is_symlink_safe(candidate, base):
        raise ValueError(f"Symlink escape attempt: {candidate}")
    return resolved


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
        # Symlink check on bundle_path
        if not _is_symlink_safe(target, allowed_root):
            raise ValueError(f"Symlink escape in bundle_path: {target}")
        return resolved
    return _safe_path_subprocess(WORKERS_DIR, worker_id)


def _resolve_connections(
    worker_id: str,
    log_fn: Callable,
    config: Optional[WorkerConfig] = None,
) -> tuple[Dict[str, str], Optional[str]]:
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


def _validate_output_schema(
    worker_id: str,
    outputs: Dict[str, Any],
    log_fn: Callable,
    config: Optional[WorkerConfig] = None,
) -> Optional[str]:
    """Re-use runner_local's schema validation logic."""
    from runner_local import _validate_output_schema as _validate
    return _validate(worker_id, outputs, log_fn, config=config)


def _build_child_env(
    declared_secrets: list[str],
    resolved_secrets: Dict[str, str],
    egress_allowed: bool,
    worker_dir: Path,
    sitecustomize_dir: Optional[str] = None,
) -> Dict[str, str]:
    """Build a minimal environment dict for the child subprocess.

    Only passes through safe env vars and the worker's declared secrets.
    Strips all other host env vars (no OPENAI_API_KEY, COMPOSIO_API_KEY,
    FLOOM_SECRET, E2B_API_KEY, etc. unless explicitly declared).

    Network blocking: when egress_allowed is False, a sitecustomize.py shim
    is written to sitecustomize_dir and that dir is prepended to PYTHONPATH.
    Python automatically imports sitecustomize at startup when it finds it on
    sys.path, so the socket.connect monkey-patch fires before any worker code.
    (PYTHONSTARTUP is only honored in interactive Python sessions; it does not
    work for subprocess non-interactive invocations.)
    """
    env: Dict[str, str] = {}

    # 1. Safe passthrough keys
    host_env = os.environ
    for key in _PASSTHROUGH_ENV_KEYS:
        if key in host_env:
            env[key] = host_env[key]

    # 2. LC_* prefix passthrough
    for key, val in host_env.items():
        for prefix in _PASSTHROUGH_ENV_PREFIXES:
            if key.startswith(prefix):
                env[key] = val
                break

    # 3. Worker's declared secrets only
    for secret_name in declared_secrets:
        if secret_name in resolved_secrets:
            env[secret_name] = resolved_secrets[secret_name]

    # 4. Network egress enforcement
    if not egress_allowed:
        env["WORKEROS_NO_NETWORK"] = "1"

    # 5. Prepend sitecustomize dir to PYTHONPATH so shim is auto-imported
    if sitecustomize_dir:
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = f"{sitecustomize_dir}:{existing}" if existing else sitecustomize_dir

    # 6. Force unbuffered output so we can read results reliably
    env["PYTHONUNBUFFERED"] = "1"

    return env


def _set_resource_limits(timeout_seconds: int) -> None:
    """Called as preexec_fn in the child process to set resource limits."""
    try:
        # Virtual memory cap: 1 GB
        resource.setrlimit(resource.RLIMIT_AS, (_RLIMIT_AS_BYTES, _RLIMIT_AS_BYTES))
    except (ValueError, resource.error):
        pass  # May fail on some kernels; non-fatal

    try:
        # CPU time cap: timeout + 2 seconds hard limit
        cpu_limit = timeout_seconds + 2
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_limit, cpu_limit))
    except (ValueError, resource.error):
        pass

    try:
        # Max file write size: 100 MB
        resource.setrlimit(resource.RLIMIT_FSIZE, (_RLIMIT_FSIZE_BYTES, _RLIMIT_FSIZE_BYTES))
    except (ValueError, resource.error):
        pass

    try:
        # Max open files: 256
        resource.setrlimit(resource.RLIMIT_NOFILE, (_RLIMIT_NOFILE, _RLIMIT_NOFILE))
    except (ValueError, resource.error):
        pass


def run_worker_subprocess(
    worker_id: str,
    run_id: str,
    inputs: Dict[str, Any],
    secrets: Dict[str, str],
    log_fn: Callable,
    trace_id: str,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    config: Optional[WorkerConfig] = None,
) -> WorkerResult:
    """Execute a worker's run.py as a child subprocess with full isolation.

    Returns a WorkerResult regardless of success or failure.
    """
    import subprocess

    try:
        worker_dir = _worker_dir_for_run(worker_id, config)
    except ValueError as exc:
        logger.error("Invalid worker path: %s", exc)
        return WorkerResult(status="error", error=str(exc), error_code="invalid_worker")

    entrypoint = config.runtime.entrypoint if config and config.runtime else get_worker_entrypoint(worker_id)
    try:
        run_file = _safe_path_subprocess(worker_dir, entrypoint)
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

    # Determine egress policy from the WorkerContract capabilities field.
    # WorkerContract has .capabilities.network.egress; WorkerConfig does not.
    egress_allowed = True
    try:
        contract = get_worker_contract(worker_id)
        if contract is not None and hasattr(contract, "capabilities"):
            egress_allowed = contract.capabilities.network.egress
    except Exception:
        # Fall back to permissive — better to allow than block a legitimate worker
        egress_allowed = True

    # Build artifact dir (symlink-safe)
    try:
        artifact_dir = _safe_path_subprocess(ARTIFACTS_DIR, run_id)
        artifact_dir.mkdir(parents=True, exist_ok=True)
    except ValueError as exc:
        return WorkerResult(status="error", error=str(exc), error_code="invalid_artifact_dir")

    # Determine declared secrets from config
    declared_secrets: list[str] = []
    if config:
        declared_secrets = list(config.secrets)

    with tempfile.TemporaryDirectory(prefix="workeros-run-") as tmpdir:
        tmpdir_path = Path(tmpdir)

        # Write sitecustomize shim for network blocking.
        # Placed in a dedicated subdir so it doesn't conflict with any other
        # sitecustomize.py in the existing PYTHONPATH.
        sitecustomize_dir: Optional[str] = None
        if not egress_allowed:
            sc_dir = tmpdir_path / "sc"
            sc_dir.mkdir()
            (sc_dir / "sitecustomize.py").write_text(_NETWORK_BLOCK_SHIM)
            sitecustomize_dir = str(sc_dir)

        # Write the adapter script
        adapter_file = tmpdir_path / "_adapter.py"
        adapter_file.write_text(_ADAPTER_SCRIPT)

        # Write the payload JSON
        payload = {
            "inputs": inputs,
            "secrets": {k: v for k, v in secrets.items() if k in declared_secrets},
            "connections": connection_ids,
            "run_id": run_id,
            "worker_id": worker_id,
            "artifact_dir": str(artifact_dir),
            "trace_id": trace_id,
            "run_file": str(run_file),
        }
        payload_file = tmpdir_path / "payload.json"
        payload_file.write_text(json.dumps(payload))

        # Build child environment (allowlist-only).
        # sitecustomize_dir (if set) is prepended to PYTHONPATH inside _build_child_env.
        child_env = _build_child_env(
            declared_secrets=declared_secrets,
            resolved_secrets=secrets,
            egress_allowed=egress_allowed,
            worker_dir=worker_dir,
            sitecustomize_dir=sitecustomize_dir,
        )

        # Append worker dir and apps/api dir to PYTHONPATH for worker imports.
        # We append (not prepend) to preserve the sitecustomize_dir at the front
        # so that the network-block shim loads before any worker code.
        apps_api_dir = str(Path(__file__).parent)
        existing_pythonpath = child_env.get("PYTHONPATH", "")
        child_env["PYTHONPATH"] = (
            f"{existing_pythonpath}:{worker_dir}:{apps_api_dir}"
            if existing_pythonpath
            else f"{worker_dir}:{apps_api_dir}"
        )

        timeout_seconds = max(1, timeout_seconds)
        preexec = lambda: _set_resource_limits(timeout_seconds)

        log_fn(f"Launching subprocess runner for {worker_id}", level="debug")
        try:
            proc = subprocess.run(
                [sys.executable, str(adapter_file), str(payload_file)],
                cwd=str(worker_dir),
                env=child_env,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                preexec_fn=preexec,
            )
        except subprocess.TimeoutExpired:
            log_fn(f"Worker exceeded subprocess timeout of {timeout_seconds}s", level="error")
            return WorkerResult(
                status="error",
                error=f"Worker exceeded timeout of {timeout_seconds}s",
                error_code="timeout",
            )
        except Exception as exc:
            logger.exception("Failed to launch worker subprocess: %s", exc)
            return WorkerResult(
                status="error",
                error=f"Failed to launch subprocess: {exc}",
                error_code="subprocess_launch_error",
            )

    # Parse child output
    if proc.returncode != 0 and not proc.stdout.strip():
        stderr_snippet = proc.stderr[:500] if proc.stderr else "<no stderr>"
        log_fn(f"Worker subprocess exited with code {proc.returncode}: {stderr_snippet}", level="error")
        return WorkerResult(
            status="error",
            error=f"Worker subprocess failed (exit {proc.returncode}): {stderr_snippet}",
            error_code="subprocess_error",
        )

    try:
        result = json.loads(proc.stdout.strip())
    except json.JSONDecodeError as exc:
        snippet = proc.stdout[:200] if proc.stdout else "<empty>"
        logger.error("Worker subprocess produced invalid JSON: %s — stdout: %s", exc, snippet)
        return WorkerResult(
            status="error",
            error=f"Worker output is not valid JSON: {exc}",
            error_code="invalid_output",
        )

    # Replay child logs into the parent log_fn
    for log_entry in result.pop("_logs", []):
        try:
            log_fn(log_entry["message"], level=log_entry.get("level", "info"))
        except Exception:
            pass

    if not isinstance(result, dict):
        return WorkerResult(
            status="error",
            error="Worker run() must return a dict",
            error_code="invalid_return_type",
        )

    # Schema validation on success
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
