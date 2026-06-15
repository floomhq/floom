"""E2B cloud sandbox driver for Workeros — uses e2b SDK 2.x.

Worker protocol: run.py in an E2B worker reads inputs from inputs.json and
MUST write result.json with:
  {"status": "success"|"error", "outputs": {...}, "error": null|"..."}
"""

import json
import logging
import os
import io
import shlex
import shutil
import tarfile
import threading
import time
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, Callable, Dict, Optional

from .base import SandboxDriver
from .memory_context import ensure_memory_context_pack
from models import WorkerConfig, WorkerResult
import contexts as _contexts_module
from contexts import CONTEXTS_DIR, context_scope_for_user, normalize_context_mount, use_context_scope
from runner_utils import ARTIFACTS_DIR
from runtime_limits import (
    DEFAULT_RUN_TIMEOUT_SECONDS,
    E2B_MAX_SANDBOX_LIFETIME_SECONDS,
    MAX_RUN_TIMEOUT_SECONDS,
    MIN_INSTALL_TIMEOUT_SECONDS,
    SANDBOX_LIFETIME_BUFFER_SECONDS,
)
from worker_registry import WORKERS_DIR

logger = logging.getLogger("floom.runner_sandbox.e2b")

MAX_E2B_SANDBOX_LIFETIME_SECONDS = E2B_MAX_SANDBOX_LIFETIME_SECONDS
# Hard cap on the raw result.json the worker writes. Read + json.loads +
# persist into the run `output_json` DB column all happen on this blob, so an
# unbounded multi-MB output bloats the DB row and the run-detail response.
# Reject above this with a clear error instead of silently ingesting it.
MAX_RESULT_JSON_BYTES = 5 * 1024 * 1024  # 5 MiB
# #1041 — bound writeback-tar extraction so a sandboxed worker cannot OOM the
# API host with an arbitrarily large context file. Each member is read fully
# into memory (extracted.read()), so cap both per-member and total bytes.
MAX_CONTEXT_TAR_MEMBER_BYTES = 100 * 1024 * 1024  # 100 MiB per member
MAX_CONTEXT_TAR_TOTAL_BYTES = 250 * 1024 * 1024  # 250 MiB total per extraction
_OOM_EXIT_CODES = {137, -9}
_OOM_MARKERS = (
    "code 137",
    "exit 137",
    "exit code 137",
    "exited with code 137",
    "memoryerror",
    "out of memory",
    "oom-kill",
    "oom killed",
    "memory cgroup out of memory",
    "killed process",
)
_active_sandboxes: dict[str, Any] = {}
_active_sandboxes_lock = threading.Lock()


class E2BKeyExhaustedError(RuntimeError):
    """Raised when every configured E2B key is quota/rate-limit exhausted."""


_WORKER_AUTHOR_ID = "worker-author"
_WORKER_AUTHOR_PROVIDER_ENV_VARS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION_NAME",
    "AWS_DEFAULT_REGION",
    "AWS_BEARER_TOKEN_BEDROCK",
    "ANTHROPIC_API_KEY",
    "PLATFORM_OPENAI_API_KEY",
    "OPENAI_API_KEY",
)

# #977: internal vars the WORKER process must never see. The worker-author
# meta-worker legitimately needs the codegen model; everything else here is
# infrastructure detail (E2B sandbox/template ids, events address) that lets
# an attacker who can run a worker probe or target our infra. Callback vars
# (WORKEROS_API_URL, WORKEROS_RUN_TOKEN, FLOOM_RUN_ID/TRACE_ID) are by design
# and intentionally NOT scrubbed.
_E2B_INTERNAL_ENV_VARS = (
    "E2B_TEMPLATE_ID",
    "E2B_SANDBOX_ID",
    "E2B_EVENTS_ADDRESS",
)


def _scrub_internal_env_command(command: str, worker_id: str | None) -> str:
    """Wrap the worker command so internal infra env vars are unset for it.

    Uses `env -u` so the worker's `os.environ` never carries the E2B sandbox/
    template ids or the codegen model (except for the worker-author worker,
    which needs the model). Idempotent and shell-safe: the original command is
    passed through `sh -c` unchanged.
    """
    to_unset = list(_E2B_INTERNAL_ENV_VARS)
    if worker_id != _WORKER_AUTHOR_ID:
        to_unset.append("WORKEROS_CODEGEN_MODEL")
    unset_flags = " ".join(f"-u {name}" for name in to_unset)
    return f"env {unset_flags} sh -c {shlex.quote(command)}"


def _worker_author_platform_env() -> dict[str, str]:
    """Platform LLM env allowed only for the first-party worker-author."""
    env: dict[str, str] = {}
    try:
        from codegen_model import codegen_model

        model = codegen_model()
    except Exception:
        model = (os.environ.get("WORKEROS_CODEGEN_MODEL") or os.environ.get("WORKEROS_CHAT_MODEL") or "").strip()
    if model:
        env["WORKEROS_CODEGEN_MODEL"] = model
    for name in _WORKER_AUTHOR_PROVIDER_ENV_VARS:
        value = (os.environ.get(name) or "").strip()
        if value:
            env[name] = value
    return env


def _split_env_values(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []
    return [item.strip() for item in raw_value.split(",") if item.strip()]


def _configured_e2b_api_keys() -> list[str]:
    """Return E2B keys in use order without logging or exposing values."""
    raw_keys: list[str] = []
    raw_keys.extend(_split_env_values(os.environ.get("E2B_API_KEYS")))
    raw_keys.extend(_split_env_values(os.environ.get("E2B_API_KEY")))
    raw_keys.extend(_split_env_values(os.environ.get("E2B_API_KEY_FALLBACK")))

    keys: list[str] = []
    seen: set[str] = set()
    for key in raw_keys:
        if key in seen:
            continue
        seen.add(key)
        keys.append(key)
    return keys


def _status_code_from_exception(exc: Exception) -> int | None:
    for attr in ("status_code", "status", "http_status", "http_status_code"):
        value = getattr(exc, attr, None)
        try:
            if value is not None:
                return int(value)
        except (TypeError, ValueError):
            pass

    response = getattr(exc, "response", None)
    if response is not None:
        value = getattr(response, "status_code", None) or getattr(response, "status", None)
        try:
            if value is not None:
                return int(value)
        except (TypeError, ValueError):
            pass
    return None


def _is_e2b_quota_or_rate_limit_error(exc: Exception) -> bool:
    """True when another configured E2B key may succeed (quota, rate limit, billing block)."""
    status_code = _status_code_from_exception(exc)
    if status_code in {402, 429}:
        return True

    parts = [
        exc.__class__.__name__,
        str(getattr(exc, "code", "")),
        str(getattr(exc, "type", "")),
        str(exc),
    ]
    text = " ".join(parts).lower()
    markers = (
        "rate limit",
        "ratelimit",
        "too many requests",
        "quota",
        "exhausted",
        "insufficient credits",
        "payment required",
        "missing payment method",
        "team is blocked",
        "usage limit",
        "limit exceeded",
        "billing limit",
    )
    if any(marker in text for marker in markers):
        return True
    if status_code == 403:
        message = str(exc).lower()
        return any(token in message for token in ("billing", "payment", "blocked", "quota"))
    return False


def _exception_text(exc: Exception) -> str:
    parts = [
        exc.__class__.__name__,
        str(getattr(exc, "code", "")),
        str(getattr(exc, "type", "")),
        str(exc),
    ]
    stdout = getattr(exc, "stdout", None)
    stderr = getattr(exc, "stderr", None)
    if stdout:
        parts.append(str(stdout))
    if stderr:
        parts.append(str(stderr))
    return " ".join(part for part in parts if part).strip()


def _looks_like_timeout_exception(exc: Exception) -> bool:
    text = _exception_text(exc).lower()
    return any(
        marker in text
        for marker in (
            "timeout",
            "timed out",
            "deadline exceeded",
            "context deadline",
            "took too long",
        )
    )


def _timeout_elapsed_near_cap(elapsed_seconds: float, timeout_seconds: int) -> bool:
    try:
        cap = float(timeout_seconds)
    except (TypeError, ValueError):
        cap = 300.0
    if cap <= 0:
        return False
    return elapsed_seconds >= max(1.0, cap * 0.9)


def _sandbox_exception_result(
    exc: Exception,
    *,
    elapsed_seconds: float,
    timeout_seconds: int,
) -> WorkerResult:
    detail = str(exc).strip() or exc.__class__.__name__
    if _looks_like_timeout_exception(exc) and _timeout_elapsed_near_cap(elapsed_seconds, timeout_seconds):
        return WorkerResult(
            status="error",
            error=f"Worker exceeded its {timeout_seconds}s timeout and was stopped.",
            error_code="timeout",
            retryable=True,
        )
    return WorkerResult(
        status="error",
        error=f"E2B sandbox failed before the worker timeout was reached: {detail}",
        error_code="e2b_sandbox_error",
        retryable=True,
    )


def _worker_result_failure_fields(result_data: dict[str, Any]) -> tuple[Any, Any]:
    result_status = result_data.get("status", "success")
    if result_status not in ("error", "failed"):
        return result_data.get("error"), result_data.get("error_code")
    result_error = str(result_data.get("error") or "").strip()
    result_error_code = str(result_data.get("error_code") or "").strip()
    if not result_error:
        result_error = "Worker reported failure without an error message."
    if not result_error_code:
        result_error_code = "worker_reported_error"
    return result_error, result_error_code


def _create_sandbox_with_key_fallback(
    sandbox_cls: Any,
    *,
    api_keys: list[str],
    timeout: int,
    envs: dict[str, str],
    log_fn: Callable[[str, str], None],
) -> Any:
    last_quota_error: Exception | None = None
    total = len(api_keys)

    for index, api_key in enumerate(api_keys, start=1):
        try:
            return sandbox_cls.create(
                api_key=api_key,
                timeout=timeout,
                envs=envs,
            )
        except Exception as exc:
            if not _is_e2b_quota_or_rate_limit_error(exc):
                raise
            last_quota_error = exc
            if index < total:
                log_fn(
                    f"[e2b] E2B key {index}/{total} hit a quota/billing/rate limit; "
                    "retrying with the next configured key",
                    "warning",
                )
                continue
            raise E2BKeyExhaustedError(
                "All configured E2B API keys are rate-limited or quota-exhausted "
                f"({total} key(s) tried)."
            ) from last_quota_error

    raise E2BKeyExhaustedError("No E2B API keys are configured.")


def _read_result_json(
    sandbox: Any,
    result_path: str,
    log_fn: Callable,
) -> "tuple[Optional[Dict[str, Any]], Optional[WorkerResult]]":
    """Read and parse the worker's result.json from the sandbox.

    Returns ``(result_data, None)`` on success, or ``(None, WorkerResult)`` with
    a distinct, actionable error when the read/parse fails. Each failure mode is
    a separate branch (audit P1) instead of one generic "didn't produce a
    result" message:

      * missing file        -> ``missing_result``
      * oversized           -> ``output_too_large`` (size cap before parse+persist)
      * invalid/undecodable -> ``invalid_result_json``
      * non-object top-level-> ``invalid_result_json``
      * non-dict ``outputs``-> ``invalid_outputs_shape`` (was silently coerced to {})

    Operator detail (full sandbox path) is logged; user-facing messages never
    leak the sandbox internal path.
    """
    # 1. Read. A read failure means the worker exited 0 but never wrote the file.
    try:
        result_raw = sandbox.files.read(result_path)
    except Exception as exc:
        log_fn(f"[e2b] No result.json at {result_path}: {exc}", "error")
        return None, WorkerResult(
            status="error",
            error=(
                "Worker did not write a result. Check run.py wrote "
                "result.json before exiting (the file is missing)."
            ),
            error_code="missing_result",
        )

    # 2. Size cap BEFORE json.loads + persist, to protect the DB row and the
    #    run-detail response from multi-MB outputs.
    raw_bytes = (
        result_raw
        if isinstance(result_raw, (bytes, bytearray))
        else str(result_raw).encode("utf-8", errors="ignore")
    )
    if len(raw_bytes) > MAX_RESULT_JSON_BYTES:
        log_fn(
            f"[e2b] result.json at {result_path} is {len(raw_bytes)} bytes "
            f"(> {MAX_RESULT_JSON_BYTES} cap)",
            "error",
        )
        return None, WorkerResult(
            status="error",
            error=(
                f"Worker output is too large ({len(raw_bytes) // 1024} KiB). "
                f"result.json must be under "
                f"{MAX_RESULT_JSON_BYTES // (1024 * 1024)} MiB. Write large data "
                "to an artifact file instead."
            ),
            error_code="output_too_large",
        )

    # 3. Parse. A failure here means a file WAS written but is not valid JSON
    #    (or wrong encoding) — distinct from "no file written".
    try:
        result_data = json.loads(raw_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        log_fn(f"[e2b] result.json at {result_path} is not valid JSON: {exc}", "error")
        return None, WorkerResult(
            status="error",
            error=(
                "Worker wrote a result.json that is not valid JSON: "
                f"{exc}. Ensure run.py serializes a JSON object."
            ),
            error_code="invalid_result_json",
        )

    # 4. Top-level must be an object.
    if not isinstance(result_data, dict):
        log_fn(
            f"[e2b] result.json at {result_path} top-level is "
            f"{type(result_data).__name__}, expected object",
            "error",
        )
        return None, WorkerResult(
            status="error",
            error=(
                "Worker result.json must be a JSON object, got "
                f"{type(result_data).__name__}. Wrap your data in an "
                '"outputs" object.'
            ),
            error_code="invalid_result_json",
        )

    # 5. `outputs` must be a dict. A worker returning a list/string/number was
    #    previously coerced to {} and silently completed green (audit P1).
    outputs = result_data.get("outputs", {})
    if not isinstance(outputs, dict):
        log_fn(
            f"[e2b] result.json 'outputs' is {type(outputs).__name__}, "
            "expected object",
            "error",
        )
        return None, WorkerResult(
            status="error",
            error=(
                "Worker 'outputs' must be a JSON object, got "
                f"{type(outputs).__name__}. Return outputs as a mapping, e.g. "
                '{"outputs": {"name": value}}.'
            ),
            error_code="invalid_outputs_shape",
        )

    return result_data, None

def _register_sandbox(run_id: str, sandbox: Any) -> None:
    with _active_sandboxes_lock:
        _active_sandboxes[run_id] = sandbox


def _unregister_sandbox(run_id: str, sandbox: Any) -> None:
    with _active_sandboxes_lock:
        if _active_sandboxes.get(run_id) is sandbox:
            _active_sandboxes.pop(run_id, None)


def active_sandbox_count() -> int:
    with _active_sandboxes_lock:
        return len(_active_sandboxes)


def cancel_sandbox(run_id: str, *, reason: str | None = None) -> bool:
    with _active_sandboxes_lock:
        sandbox = _active_sandboxes.get(run_id)
    if sandbox is None:
        return False
    try:
        sandbox.kill()
        logger.warning("Killed active E2B sandbox for run %s: %s", run_id, reason or "cancel requested")
        return True
    except Exception as exc:
        logger.warning("Failed to kill active E2B sandbox for run %s: %s", run_id, exc)
        return False
    finally:
        _unregister_sandbox(run_id, sandbox)


def _looks_like_sandbox_oom(exit_code: int | None, stdout: str | None, stderr: str | None) -> bool:
    try:
        normalized_exit_code = int(exit_code) if exit_code is not None else None
    except (TypeError, ValueError):
        normalized_exit_code = None
    if normalized_exit_code in _OOM_EXIT_CODES:
        return True
    text = f"{stdout or ''}\n{stderr or ''}".lower()
    return any(marker in text for marker in _OOM_MARKERS)


def _emit_command_output(raw: str, level: str, prefix: str, log_fn: Callable[[str, str], None]) -> None:
    for line in str(raw or "").splitlines():
        line = line.strip()
        if line:
            log_fn(f"{prefix}{line}", level)


def _format_env_line(key: str, value: str) -> str:
    """Format a single KEY=value line for .env.local.

    Values containing double-quotes, backslashes, newlines, carriage-returns, or
    null bytes are wrapped in double quotes with those characters escaped.
    Plain values that need no escaping are written unquoted (safer for most
    shell parsers and python-dotenv alike).
    """
    needs_quoting = any(c in value for c in ('"', '\\', '\n', '\r', '\0'))
    if needs_quoting:
        escaped = (
            value
            .replace('\\', '\\\\')
            .replace('"', '\\"')
            .replace('\n', '\\n')
            .replace('\r', '\\r')
            .replace('\0', '\\0')
        )
        return f'{key}="{escaped}"'
    return f'{key}={value}'


def _safe_path(base: Path, *parts: str) -> Path:
    target = base.joinpath(*parts).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        raise ValueError(f"Path traversal attempt: {target}")
    return target


def _install_timeout_for_run(timeout_seconds: int) -> int:
    """Give large real-engine bundles enough time to install dependencies."""
    return max(MIN_INSTALL_TIMEOUT_SECONDS, min(int(timeout_seconds), 900))


def _sandbox_lifetime_timeout(timeout_seconds: int, install_timeout: int) -> int:
    """Sandbox lifetime must cover dependency install plus worker execution."""
    requested_timeout = max(
        int(timeout_seconds) + int(install_timeout) + SANDBOX_LIFETIME_BUFFER_SECONDS,
        MIN_INSTALL_TIMEOUT_SECONDS,
    )
    return min(requested_timeout, MAX_E2B_SANDBOX_LIFETIME_SECONDS)


def _effective_run_timeout(timeout_seconds: int) -> int:
    """Enforce the runtime ceiling for direct driver callers as a final guard."""
    return max(1, min(int(timeout_seconds), MAX_RUN_TIMEOUT_SECONDS))


def _refresh_sandbox_lifetime(
    sandbox: Any,
    *,
    timeout: int,
    log_fn: Callable[[str, str], None],
) -> None:
    set_timeout = getattr(sandbox, "set_timeout", None)
    if not callable(set_timeout):
        logger.debug("E2B sandbox object does not expose set_timeout(); skipping lifetime refresh")
        return
    try:
        set_timeout(timeout)
        log_fn(f"[e2b] Refreshed sandbox lifetime to {timeout}s before worker command", "debug")
    except Exception as exc:
        log_fn(
            "[e2b] Failed to refresh sandbox lifetime to "
            f"{timeout}s before worker command: {exc}. "
            "E2B may enforce a lower maximum for this account or plan.",
            "error",
        )
        raise


def _sandbox_api_url() -> str:
    """API base URL used by code running inside E2B sandboxes."""
    for name in (
        "WORKEROS_SANDBOX_API_URL",
        "WORKEROS_E2B_API_URL",
        "WORKEROS_INTERNAL_API_URL",
        "WORKEROS_API_URL",
        "WORKEROS_API_BASE",
        "WORKERS_API_URL",
    ):
        value = (os.environ.get(name) or "").strip()
        if value:
            return value.rstrip("/")
    return "http://localhost:8000"


def _normalize_sandbox_relative_path(raw_path: str) -> str:
    path = PurePosixPath(str(raw_path).strip())
    if not str(path) or str(path) == ".":
        raise ValueError("artifact path is required")
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"invalid artifact path: {raw_path!r}")
    return path.as_posix()


def _artifact_type_for_output(output: Any) -> str:
    if output and output.media_type:
        return output.media_type
    if output and output.type == "markdown":
        return "text/markdown"
    if output and output.type == "csv":
        return "text/csv"
    if output and output.type == "json":
        return "application/json"
    return "application/octet-stream"


def _default_output_path(output: Any) -> str:
    extension_by_type = {
        "markdown": "md",
        "csv": "csv",
        "json": "json",
        "text": "txt",
        "file": "bin",
    }
    extension = extension_by_type.get(getattr(output, "type", ""), "bin")
    return f"out/{output.name}.{extension}"


def _artifact_specs_from_result(result_artifacts: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    specs: list[Dict[str, Any]] = []
    for artifact in result_artifacts:
        if not isinstance(artifact, dict):
            continue
        raw_path = artifact.get("relative_path") or artifact.get("path")
        if not raw_path:
            continue
        specs.append({
            "name": artifact.get("name") or raw_path,
            "path": raw_path,
            "type": artifact.get("type") or "application/octet-stream",
        })
    return specs


def _artifact_specs_from_declared_outputs(config: Optional[WorkerConfig]) -> list[Dict[str, Any]]:
    if not config:
        return []
    specs: list[Dict[str, Any]] = []
    for output in config.outputs:
        if output.kind and output.kind != "file":
            continue
        raw_path = output.path or _default_output_path(output)
        specs.append({
            "output_name": output.name,
            "name": raw_path,
            "path": raw_path,
            "type": _artifact_type_for_output(output),
            "required": bool(output.required),
        })
    return specs


def _merge_artifacts(
    result_artifacts: list[Dict[str, Any]],
    collected_artifacts: list[Dict[str, Any]],
) -> list[Dict[str, Any]]:
    merged: list[Dict[str, Any]] = []
    replaced: set[str] = {
        str(artifact.get("relative_path") or artifact.get("name") or artifact.get("path"))
        for artifact in collected_artifacts
    }
    for artifact in result_artifacts:
        key = str(artifact.get("relative_path") or artifact.get("name") or artifact.get("path"))
        if key and key in replaced:
            continue
        merged.append(artifact)
    merged.extend(collected_artifacts)
    return merged


def _safe_context_tar_member(member_name: str) -> PurePosixPath:
    path = PurePosixPath(member_name)
    if str(path) in {"", "."}:
        raise ValueError("empty tar path")
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"invalid context tar path: {member_name!r}")
    return path


def _extract_context_tar(raw_tar: bytes, target_dir: Path) -> None:
    """Merge the sandbox's writeback snapshot onto the live context dir.

    #1020: this used to extract to a tmp dir, ``rmtree(target_dir)``, then swap
    the whole tree in. But the sandbox snapshot is frozen at run START, so any
    file written to the LIVE store DURING the run — e.g. feedback captured by
    Emily while a `distill` worker was running — was erased on completion.
    Feedback was silently lost, breaking the whole loop.

    We now OVERLAY instead of replace: every file in the tar is written over its
    counterpart in ``target_dir`` (atomically, per file), and files already in
    ``target_dir`` that are NOT in the tar are left untouched. The worker still
    fully controls the files it writes; it just can no longer clobber a sibling
    it never saw. Deletions made inside the sandbox intentionally do NOT
    propagate — correct for the accumulate-style stores this path serves
    (feedback, memory). Path-traversal members are skipped as before.
    """
    target_dir.mkdir(parents=True, exist_ok=True)
    target_root = target_dir.resolve()
    extracted_total = 0
    with tarfile.open(fileobj=io.BytesIO(raw_tar), mode="r:*") as archive:
        for member in archive.getmembers():
            try:
                rel = _safe_context_tar_member(member.name)
            except ValueError:
                continue
            if member.isdir():
                (target_dir / rel.as_posix()).mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                continue
            # #1041 — enforce size caps from tar metadata BEFORE reading the
            # member into memory; skip (don't raise) so the rest of the
            # writeback still lands, matching the path-traversal skip above.
            if member.size > MAX_CONTEXT_TAR_MEMBER_BYTES:
                logger.warning(
                    "[context-tar] skipping oversized member %r: %d bytes > %d cap",
                    member.name,
                    member.size,
                    MAX_CONTEXT_TAR_MEMBER_BYTES,
                )
                continue
            if extracted_total + member.size > MAX_CONTEXT_TAR_TOTAL_BYTES:
                logger.warning(
                    "[context-tar] total extraction cap %d reached; skipping "
                    "remaining members starting at %r",
                    MAX_CONTEXT_TAR_TOTAL_BYTES,
                    member.name,
                )
                break
            extracted_total += member.size
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            destination = (target_dir / rel.as_posix()).resolve()
            try:
                destination.relative_to(target_root)
            except ValueError:
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            # Atomic per-file replace: a concurrent reader never sees a
            # half-written file, and a mid-merge failure leaves the files
            # written so far (and every untouched sibling) intact.
            tmp_file = destination.parent / (
                f".{destination.name}.tmp.{os.getpid()}.{threading.get_ident()}"
            )
            try:
                tmp_file.write_bytes(extracted.read())
                os.replace(tmp_file, destination)
            finally:
                if tmp_file.exists():
                    tmp_file.unlink()


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
    2. Optionally read secrets from secrets.json (declared secrets dict)
    3. Optionally read connections.json (Composio app slug -> connection_id)
    4. Write result.json with {"status": ..., "outputs": {...}, "error": ...}
    """

    def run(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int = DEFAULT_RUN_TIMEOUT_SECONDS,
        config: Optional[WorkerConfig] = None,
        connection_ids: Optional[Dict[str, str]] = None,
        user_id: str | None = None,
    ) -> WorkerResult:
        started_monotonic = time.monotonic()
        effective_timeout_seconds = _effective_run_timeout(timeout_seconds)
        if effective_timeout_seconds < int(timeout_seconds):
            log_fn(
                "[e2b] Capping worker command timeout at "
                f"{effective_timeout_seconds}s (WORKEROS_MAX_RUN_TIMEOUT)",
                "warning",
            )
        try:
            return self._run_in_sandbox(
                worker_id, run_id, inputs, secrets, log_fn, trace_id,
                effective_timeout_seconds, config, connection_ids or {}, user_id,
            )
        except E2BKeyExhaustedError as exc:
            logger.warning(
                "E2B sandbox quota exhausted for worker %s run %s: %s",
                worker_id,
                run_id,
                exc,
            )
            log_fn(f"E2B sandbox quota exhausted: {exc}", "error")
            return WorkerResult(
                status="error",
                error=str(exc),
                error_code="e2b_quota_exhausted",
                retryable=True,
            )
        except Exception as exc:
            # #607: if the sandbox was killed because the user clicked cancel,
            # surface "cancelled" instead of "error" so the UI shows the right
            # terminal state. check_requested is the canonical flag; read it
            # before logging so we don't misclassify a real crash.
            try:
                from db import get_db
                with get_db() as _conn:
                    _row = _conn.execute(
                        "SELECT cancel_requested FROM runs WHERE id = ?", (run_id,)
                    ).fetchone()
                if _row and _row["cancel_requested"]:
                    logger.info("E2B sandbox terminated by user cancel for run %s", run_id)
                    log_fn("[e2b] Sandbox terminated — run cancelled by user", "info")
                    return WorkerResult(
                        status="cancelled",
                        error="Cancelled by user",
                        error_code="user_cancel",
                    )
            except Exception:
                pass  # DB unavailable — fall through to generic error handling

            exc_stdout = getattr(exc, "stdout", None)
            exc_stderr = getattr(exc, "stderr", None)
            exc_exit_code = getattr(exc, "exit_code", None)
            if _looks_like_sandbox_oom(exc_exit_code, exc_stdout, f"{exc_stderr or ''}\n{exc}"):
                logger.exception(
                    "E2B sandbox OOM for worker %s run %s: %s", worker_id, run_id, exc
                )
                log_fn(f"E2B sandbox OOM: {exc}", "error")
                return WorkerResult(
                    status="error",
                    error=str(exc),
                    error_code="sandbox_oom",
                    retryable=False,
                )
            logger.exception(
                "E2B sandbox failed for worker %s run %s: %s", worker_id, run_id, exc
            )
            elapsed_seconds = time.monotonic() - started_monotonic
            result = _sandbox_exception_result(
                exc,
                elapsed_seconds=elapsed_seconds,
                timeout_seconds=effective_timeout_seconds,
            )
            log_fn(f"E2B sandbox error after {elapsed_seconds:.3f}s: {result.error}", "error")
            return result

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
        connection_ids: Dict[str, str],
        user_id: str | None,
    ) -> WorkerResult:
        from e2b import Sandbox  # e2b 2.x

        api_keys = _configured_e2b_api_keys()
        if not api_keys:
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

        effective_timeout_seconds = _effective_run_timeout(timeout_seconds)
        if effective_timeout_seconds < int(timeout_seconds):
            log_fn(
                "[e2b] Capping worker command timeout at "
                f"{effective_timeout_seconds}s (WORKEROS_MAX_RUN_TIMEOUT)",
                "warning",
            )

        log_fn(f"[e2b] Spawning sandbox for run {run_id}", "info")
        install_timeout = _install_timeout_for_run(effective_timeout_seconds)
        sandbox_timeout = _sandbox_lifetime_timeout(effective_timeout_seconds, install_timeout)
        requested_sandbox_timeout = max(
            effective_timeout_seconds + install_timeout + SANDBOX_LIFETIME_BUFFER_SECONDS,
            MIN_INSTALL_TIMEOUT_SECONDS,
        )
        if sandbox_timeout < requested_sandbox_timeout:
            log_fn(
                "[e2b] Capping sandbox lifetime at "
                f"{sandbox_timeout}s, the configured E2B maximum; worker command "
                f"timeout remains {effective_timeout_seconds}s and the lifetime "
                "will be refreshed before execution",
                "warning",
            )

        # e2b 2.x: use Sandbox.create()
        from run_token import make_run_token  # noqa: PLC0415
        _sandbox_api_url_val = _sandbox_api_url()
        # If the worker declares calls:, issue a wrt_ token so call_worker()
        # inside run.py can spawn child runs. The simple make_run_token is kept
        # for backwards-compat (composio-execute and run-status callbacks) but
        # is NOT sufficient for worker-to-worker calling.
        _worker_call_token: str | None = None
        if config and config.calls and user_id:
            from run_token import issue_worker_call_token, parse_call_depth  # noqa: PLC0415
            # #994: token carries this run's depth so the chain's cap accumulates.
            _self_depth = 0
            try:
                from db import get_repositories  # noqa: PLC0415
                _row = get_repositories().runs.get_any(run_id=run_id)
                _self_depth = parse_call_depth((_row or {}).get("trigger_source"))
            except Exception:
                _self_depth = 0
            _worker_call_token = issue_worker_call_token(
                user_id=user_id,
                parent_run_id=run_id,
                callable_workers=list(config.calls),
                depth=_self_depth,
            )
        _sandbox_envs = {
            "FLOOM_RUN_ID": run_id,
            "FLOOM_TRACE_ID": trace_id,
            "WORKEROS_API_URL": _sandbox_api_url_val,
            # Scoped capability token — valid only for /runs/{run_id}/composio-execute/*
            # Never inject the full FLOOM_SECRET into sandboxes (it grants full API access).
            "WORKEROS_RUN_TOKEN": _worker_call_token if _worker_call_token else make_run_token(run_id),
            **({"WORKEROS_CALL_DEPTH": str(_self_depth)} if _worker_call_token else {}),  # #994
        }
        # #1137: worker-author is first-party code that generates the bundle
        # inside E2B, so it needs the platform LLM provider env. Regular workers
        # still receive only declared user secrets plus callback vars.
        _worker_author_env = _worker_author_platform_env() if worker_id == _WORKER_AUTHOR_ID else {}
        _sandbox_envs.update(_worker_author_env)
        sandbox = _create_sandbox_with_key_fallback(
            Sandbox,
            api_keys=api_keys,
            timeout=sandbox_timeout,
            envs=_sandbox_envs,
            log_fn=log_fn,
        )
        _register_sandbox(run_id, sandbox)

        try:
            workdir = "/home/user/worker"
            sandbox.files.make_dir(workdir)

            # Upload bundle files (read-only worker code; never contains inputs/).
            made_dirs = {workdir}
            for fpath in worker_dir.rglob("*"):
                rel = fpath.relative_to(worker_dir)
                # #995: never follow symlinks — a crafted bundle could symlink
                # `x -> /etc/passwd` / the host api.env and exfiltrate host
                # files into the sandbox. Skip the link entirely.
                if fpath.is_symlink():
                    log_fn(f"[e2b] Skipping symlink in bundle: {rel.as_posix()}", "warning")
                    continue
                # Skip any stale inputs/ dir that may exist in older bundles.
                if rel.parts and rel.parts[0] == "inputs":
                    continue
                if (
                    "__pycache__" in rel.parts
                    or rel.suffix == ".pyc"
                    or (rel.parts and rel.parts[0] in {".pytest_cache", ".ruff_cache"})
                ):
                    continue
                dest = f"{workdir}/{rel.as_posix()}"
                if fpath.is_dir():
                    if dest not in made_dirs:
                        sandbox.files.make_dir(dest)
                        made_dirs.add(dest)
                    continue
                parent = f"{workdir}/{rel.parent.as_posix()}" if rel.parent.as_posix() != "." else workdir
                if parent not in made_dirs:
                    sandbox.files.make_dir(parent)
                    made_dirs.add(parent)
                content = fpath.read_bytes()
                sandbox.files.write(dest, content)
                log_fn(f"[e2b] Uploaded {rel.as_posix()}", "debug")

            # Write workeros.py into the workdir so workers with calls: can do
            # `from workeros import call_worker`. Only uploaded when the worker
            # declares calls: — keeps the sandbox clean for workers that don't need it.
            if _worker_call_token:
                from runner_sandbox.workeros_helper import WORKEROS_PY_CONTENT  # noqa: PLC0415
                sandbox.files.write(f"{workdir}/workeros.py", WORKEROS_PY_CONTENT.encode())
                log_fn("[e2b] Uploaded workeros.py (worker-to-worker calling enabled)", "info")

            context_error = self._upload_contexts_to_sandbox(
                sandbox=sandbox,
                workdir=workdir,
                config=config,
                made_dirs=made_dirs,
                log_fn=log_fn,
                user_id=user_id,
            )
            if context_error:
                return WorkerResult(
                    status="error",
                    error=context_error,
                    error_code="context_mount_failed",
                    retryable=True,
                )

            # Upload per-run file inputs from their isolated staging paths.
            # Inputs dict values for file inputs are absolute local paths.
            e2b_inputs_dir = f"{workdir}/inputs"
            e2b_inputs_made = False
            e2b_inputs: dict[str, str] = {}
            for key, value in inputs.items():
                if not isinstance(value, str):
                    continue
                local_path = Path(value)
                if local_path.is_absolute() and local_path.is_file():
                    if not e2b_inputs_made:
                        sandbox.files.make_dir(e2b_inputs_dir)
                        made_dirs.add(e2b_inputs_dir)
                        e2b_inputs_made = True
                    remote_name = local_path.name
                    remote_path = f"{e2b_inputs_dir}/{remote_name}"
                    sandbox.files.write(remote_path, local_path.read_bytes())
                    log_fn(f"[e2b] Uploaded input file {remote_name}", "debug")
                    # Remap to the relative path the worker expects inside the sandbox.
                    e2b_inputs[key] = f"inputs/{remote_name}"
            # Build sandbox-local inputs dict with remapped file paths.
            sandbox_inputs = {k: e2b_inputs.get(k, v) for k, v in inputs.items()}

            # Write inputs.json with sandbox-local (relative) file paths.
            sandbox.files.write(
                f"{workdir}/inputs.json",
                json.dumps(sandbox_inputs, indent=2),
            )

            # Write .env.local — industry-standard convention; workers load via
            # python-dotenv's load_dotenv(".env.local") + os.environ.
            env_local_lines = [_format_env_line(k, v) for k, v in secrets.items()]
            sandbox.files.write(
                f"{workdir}/.env.local",
                "\n".join(env_local_lines) + ("\n" if env_local_lines else ""),
            )

            # Write secrets.json — kept for ONE release as backward-compat with
            # user-uploaded workers still using json.load(open("secrets.json")).
            # Will be removed in PR S11.
            sandbox.files.write(
                f"{workdir}/secrets.json",
                json.dumps(secrets, indent=2),
            )

            # Write connections.json: Composio app slug -> connection_id mapping.
            # Workers that declare connections: [...] in worker.yml read this to
            # find the authenticated connection ID for each app.
            sandbox.files.write(
                f"{workdir}/connections.json",
                json.dumps(connection_ids, indent=2),
            )

            # Install dependencies if present.
            #
            # Python: requirements.txt -> `pip install -r`.
            # Node:   package.json     -> `npm install --omit=dev --no-audit --no-fund`
            #         (uses package-lock.json when present for reproducibility).
            #
            # We hit this Node gap shipping a Node worker that needed
            # google-auth-library: E2B can run any language; we just had no
            # install hook for non-Python bundles.
            req_path = worker_dir / "requirements.txt"
            if req_path.exists() and req_path.read_text().strip():
                log_fn("[e2b] Installing requirements.txt...", "info")
                install_result = sandbox.commands.run(
                    f"pip install -q -r {workdir}/requirements.txt",
                    timeout=install_timeout,
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

            pkg_path = worker_dir / "package.json"
            if pkg_path.exists() and pkg_path.read_text().strip():
                log_fn("[e2b] Installing package.json (npm)...", "info")
                npm_install_result = sandbox.commands.run(
                    f"cd {workdir} && npm install --omit=dev --no-audit --no-fund --loglevel=error",
                    timeout=install_timeout,
                )
                if npm_install_result.exit_code != 0:
                    err = (
                        f"npm install failed (exit {npm_install_result.exit_code}): "
                        f"{(npm_install_result.stderr or npm_install_result.stdout or '')[:500]}"
                    )
                    log_fn(f"[e2b] {err}", "error")
                    return WorkerResult(
                        status="error",
                        error=err,
                        error_code="install_failed",
                    )
                log_fn("[e2b] npm install complete", "info")

            _refresh_sandbox_lifetime(
                sandbox,
                timeout=sandbox_timeout,
                log_fn=log_fn,
            )

            # Run the worker — commands.run() is sync, returns CommandResult directly
            command = "python run.py"
            if config and config.runtime and config.runtime.command:
                command = config.runtime.command
            # #977: strip E2B sandbox/template ids (and the codegen model for
            # non-author workers) from the worker process environment.
            command = _scrub_internal_env_command(command, worker_id)
            log_fn(f"[e2b] Executing worker command: {command}", "info")
            streamed_stdout: list[str] = []
            streamed_stderr: list[str] = []

            def on_stdout(chunk: str) -> None:
                streamed_stdout.append(chunk)
                _emit_command_output(chunk, "info", "[e2b] ", log_fn)

            def on_stderr(chunk: str) -> None:
                streamed_stderr.append(chunk)
                _emit_command_output(chunk, "warning", "[e2b] stderr: ", log_fn)

            _cmd_envs: dict[str, str] = {
                **_worker_author_env,
                **secrets,
                "FLOOM_RUN_ID": run_id,
                "FLOOM_TRACE_ID": trace_id,
                "WORKEROS_API_URL": _sandbox_envs["WORKEROS_API_URL"],
            }
            if _worker_call_token:
                _cmd_envs["WORKEROS_RUN_TOKEN"] = _worker_call_token
                _cmd_envs["WORKEROS_CALL_DEPTH"] = str(_self_depth)  # #994
            proc = sandbox.commands.run(
                command,
                cwd=workdir,
                envs=_cmd_envs,
                on_stdout=on_stdout,
                on_stderr=on_stderr,
                timeout=float(effective_timeout_seconds),
            )

            # E2B streams stdout/stderr through callbacks while the process is
            # running. Keep the fallback for SDKs or test doubles that only
            # return aggregate stdout/stderr after process exit.
            if proc.stdout and not streamed_stdout:
                _emit_command_output(proc.stdout, "info", "[e2b] ", log_fn)
            if proc.stderr and not streamed_stderr:
                _emit_command_output(proc.stderr, "warning", "[e2b] stderr: ", log_fn)

            if proc.exit_code != 0:
                if _looks_like_sandbox_oom(proc.exit_code, proc.stdout, proc.stderr):
                    err = "Sandbox ran out of memory"
                    stderr_snippet = (proc.stderr or proc.stdout or "")[:200].strip()
                    if stderr_snippet:
                        err += f": {stderr_snippet}"
                    log_fn(f"[e2b] {err}", "error")
                    return WorkerResult(
                        status="error",
                        error=err,
                        error_code="sandbox_oom",
                        retryable=False,
                    )
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

            # Read + parse result.json. Distinct, actionable errors for each
            # failure mode (missing file / oversized / invalid JSON / not-a-dict
            # / non-dict outputs) — see _read_result_json (audit P1).
            result_path = f"{workdir}/result.json"
            result_data, parse_error = _read_result_json(sandbox, result_path, log_fn)
            if parse_error is not None:
                return parse_error

            outputs = result_data.get("outputs", {})
            result_status = result_data.get("status", "success")
            result_error, result_error_code = _worker_result_failure_fields(result_data)
            result_artifacts = result_data.get("artifacts", [])
            if not isinstance(result_artifacts, list):
                result_artifacts = []
            collected_artifacts = self._collect_sandbox_artifacts(
                sandbox=sandbox,
                workdir=workdir,
                run_id=run_id,
                result_artifacts=result_artifacts,
                config=config,
                outputs=outputs,
                log_fn=log_fn,
            )
            artifacts = _merge_artifacts(result_artifacts, collected_artifacts)
            if result_status not in ("error", "failed"):
                self._persist_writeable_contexts(
                    sandbox=sandbox,
                    workdir=workdir,
                    run_id=run_id,
                    config=config,
                    log_fn=log_fn,
                    user_id=user_id,
                )

            log_fn("[e2b] Run completed successfully", "info")
            decision_required = result_data.get("decision_required")
            if not isinstance(decision_required, dict):
                decision_required = None
            return WorkerResult(
                status=result_status,
                outputs=outputs,
                artifacts=artifacts,
                error=result_error,
                error_code=result_error_code,
                decision_required=decision_required,
            )

        finally:
            _unregister_sandbox(run_id, sandbox)
            try:
                # e2b 2.x: kill() may raise if the sandbox already exited.
                # We attempt gracefully; any exception is a warning, not a failure.
                sandbox.kill()
                log_fn("[e2b] Sandbox killed", "debug")
            except Exception as close_exc:
                # Sandbox may have self-terminated (timeout, OOM) — not an error.
                logger.debug("E2B sandbox already gone (kill suppressed): %s", close_exc)

    def _upload_contexts_to_sandbox(
        self,
        *,
        sandbox: Any,
        workdir: str,
        config: Optional[WorkerConfig],
        made_dirs: set[str],
        log_fn: Callable[[str, str], None],
        user_id: str | None = None,
    ) -> str | None:
        if not config or not config.contexts:
            return None

        contexts_root = f"{workdir}/context"
        if contexts_root not in made_dirs:
            sandbox.files.make_dir(contexts_root)
            made_dirs.add(contexts_root)

        with use_context_scope(context_scope_for_user(user_id)):
            ensure_memory_context_pack(config=config, user_id=user_id, log_fn=log_fn)
            for raw_context in config.contexts:
                try:
                    context = normalize_context_mount(raw_context)
                except ValueError as exc:
                    return f"Invalid context declaration: {exc}"

                name = context["name"]
                source = context["source"]
                sandbox_target = f"{contexts_root}/{name}"
                sandbox.files.make_dir(sandbox_target)
                made_dirs.add(sandbox_target)

                if source.startswith("git+"):
                    repo_url = source.removeprefix("git+")
                    log_fn(f"[e2b] Cloning git context {name!r}", "info")
                    result = sandbox.commands.run(
                        "git clone --depth 1 "
                        f"{shlex.quote(repo_url)} {shlex.quote(sandbox_target)}",
                        timeout=180,
                    )
                    if result.exit_code != 0:
                        return (
                            f"git context {name!r} clone failed "
                            f"(exit {result.exit_code}): {(result.stderr or result.stdout or '')[:500]}"
                        )
                    continue

                local_dir = _contexts_module.context_dir(name)
                if not local_dir.is_dir():
                    log_fn(f"[e2b] context {name!r} not found locally", "warning")
                    continue

                for fpath in local_dir.rglob("*"):
                    if "__pycache__" in fpath.parts or fpath.is_symlink():
                        continue
                    rel = fpath.relative_to(local_dir)
                    dest = f"{sandbox_target}/{rel.as_posix()}"
                    if fpath.is_dir():
                        if dest not in made_dirs:
                            sandbox.files.make_dir(dest)
                            made_dirs.add(dest)
                        continue
                    parent = f"{sandbox_target}/{rel.parent.as_posix()}" if rel.parent.as_posix() != "." else sandbox_target
                    if parent not in made_dirs:
                        sandbox.files.make_dir(parent)
                        made_dirs.add(parent)
                    sandbox.files.write(dest, fpath.read_bytes())
                    log_fn(f"[e2b] Uploaded context {name}/{rel.as_posix()}", "debug")
        return None

    def _persist_writeable_contexts(
        self,
        *,
        sandbox: Any,
        workdir: str,
        run_id: str,
        config: Optional[WorkerConfig],
        log_fn: Callable[[str, str], None],
        user_id: str | None = None,
    ) -> None:
        if not config or not config.contexts:
            return

        with use_context_scope(context_scope_for_user(user_id)):
            for raw_context in config.contexts:
                try:
                    context = normalize_context_mount(raw_context)
                except ValueError as exc:
                    log_fn(f"[e2b] Skipping invalid writeable context: {exc}", "warning")
                    continue
                if not context["writeable"]:
                    continue
                if context["source"] != "local":
                    log_fn(
                        f"[e2b] Skipping writeback for git context {context['name']!r}",
                        "warning",
                    )
                    continue

                name = context["name"]
                sandbox_source = f"{workdir}/context/{name}"
                try:
                    if not sandbox.files.exists(sandbox_source, request_timeout=30):
                        log_fn(f"[e2b] Writeable context {name!r} missing in sandbox", "warning")
                        continue
                except Exception as exc:
                    log_fn(f"[e2b] Failed to inspect writeable context {name!r}: {exc}", "warning")
                    continue

                tar_path = f"/tmp/{run_id}-{name}.tar"
                result = sandbox.commands.run(
                    f"cd {shlex.quote(sandbox_source)} && tar -cf {shlex.quote(tar_path)} .",
                    timeout=120,
                )
                if result.exit_code != 0:
                    log_fn(
                        f"[e2b] Failed to archive writeable context {name!r}: "
                        f"{(result.stderr or result.stdout or '')[:300]}",
                        "warning",
                    )
                    continue
                try:
                    raw_tar = sandbox.files.read(tar_path, format="bytes", request_timeout=120)
                    _extract_context_tar(bytes(raw_tar), _contexts_module.context_dir(name))
                    log_fn(f"[e2b] Persisted writeable context {name!r}", "info")
                except Exception as exc:
                    log_fn(f"[e2b] Failed to persist writeable context {name!r}: {exc}", "warning")

    def _collect_sandbox_artifacts(
        self,
        *,
        sandbox: Any,
        workdir: str,
        run_id: str,
        result_artifacts: list[Dict[str, Any]],
        config: Optional[WorkerConfig],
        outputs: Dict[str, Any],
        log_fn: Callable[[str, str], None],
    ) -> list[Dict[str, Any]]:
        specs = _artifact_specs_from_result(result_artifacts)
        specs.extend(_artifact_specs_from_declared_outputs(config))

        artifact_dir = _safe_path(ARTIFACTS_DIR, run_id)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        collected: list[Dict[str, Any]] = []
        seen: set[str] = set()

        for spec in specs:
            try:
                relative_path = _normalize_sandbox_relative_path(str(spec["path"]))
            except (KeyError, ValueError) as exc:
                log_fn(f"[e2b] Skipping invalid artifact path: {exc}", "warning")
                continue
            if relative_path in seen:
                continue
            seen.add(relative_path)

            remote_path = f"{workdir}/{relative_path}"
            try:
                if not sandbox.files.exists(remote_path, request_timeout=30):
                    if spec.get("required"):
                        log_fn(f"[e2b] Required output artifact missing: {relative_path}", "warning")
                    continue
                raw_content = sandbox.files.read(
                    remote_path,
                    format="bytes",
                    request_timeout=120,
                )
            except Exception as exc:
                log_fn(f"[e2b] Failed to download artifact {relative_path}: {exc}", "warning")
                continue

            local_path = _safe_path(artifact_dir, *PurePosixPath(relative_path).parts)
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(bytes(raw_content))
            artifact = {
                "name": spec.get("name") or relative_path,
                "type": spec.get("type") or "application/octet-stream",
                "path": str(local_path),
                "relative_path": relative_path,
                "size_bytes": local_path.stat().st_size,
            }
            output_name = spec.get("output_name")
            if output_name and output_name not in outputs:
                outputs[str(output_name)] = relative_path
            collected.append(artifact)
            log_fn(
                f"[e2b] Downloaded artifact {relative_path} ({artifact['size_bytes']} bytes)",
                "debug",
            )

        return collected
