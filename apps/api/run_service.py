"""Run orchestration service with structured logging, observability, and secret scrubbing."""

import os
import uuid
import json
import threading
import re
import logging
import shutil
import time
import queue
import sqlite3
from html import escape
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Any, Callable, Optional
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# Concurrency gate — E2B has a hard cap of 20 concurrent sandboxes.
# Default concurrency is 6 because executor prep is still Python/GIL-bound
# inside one worker process. Operators can raise it after measuring.
# ---------------------------------------------------------------------------

def _max_concurrent_runs() -> int:
    try:
        return max(1, int(os.environ.get("WORKEROS_MAX_CONCURRENT_RUNS", "6")))
    except ValueError:
        return 6

# Semaphore is initialised lazily on first use so that tests can override the
# env-var before importing this module.
_execution_semaphore: Optional[threading.Semaphore] = None
_semaphore_lock = threading.Lock()


def _get_semaphore() -> threading.Semaphore:
    global _execution_semaphore
    if _execution_semaphore is None:
        with _semaphore_lock:
            if _execution_semaphore is None:
                _execution_semaphore = threading.Semaphore(_max_concurrent_runs())
    return _execution_semaphore


def _semaphore_available_count() -> int:
    """Return an approximate count of free execution slots (best-effort)."""
    sem = _get_semaphore()
    # Semaphore._value is CPython internal but stable across 3.8-3.12.
    try:
        return max(0, sem._value)  # type: ignore[attr-defined]
    except AttributeError:
        return -1


# ---------------------------------------------------------------------------
# #1448: LLM-quota-aware scheduling. LLM calls happen INSIDE the E2B sandbox
# (worker code), so the engine cannot intercept them. The lever it does control
# is *run scheduling*: gate concurrent LLM-intensive runs under a shared
# provider-quota budget so a few judge-heavy workers do not stack and 429 the
# provider. A worker opts in via manifest `llm_intensive: true`; the budget is
# WORKEROS_MAX_CONCURRENT_LLM_RUNS (defaults to the main cap = effectively off).
# ---------------------------------------------------------------------------

def _max_concurrent_llm_runs() -> int:
    raw = os.environ.get("WORKEROS_MAX_CONCURRENT_LLM_RUNS", "")
    if not raw:
        return _max_concurrent_runs()
    try:
        return max(1, int(raw))
    except ValueError:
        return _max_concurrent_runs()


_llm_execution_semaphore: Optional[threading.Semaphore] = None
_llm_semaphore_lock = threading.Lock()


def _get_llm_semaphore() -> threading.Semaphore:
    global _llm_execution_semaphore
    if _llm_execution_semaphore is None:
        with _llm_semaphore_lock:
            if _llm_execution_semaphore is None:
                _llm_execution_semaphore = threading.Semaphore(_max_concurrent_llm_runs())
    return _llm_execution_semaphore


def _worker_is_llm_intensive(worker_id: str, repos: "Repositories") -> bool:
    """Whether a worker declares heavy LLM use (manifest `llm_intensive`).

    Reads the DB manifest (the source of truth the run was created against) so
    the gate is consistent regardless of the on-disk registry state.
    """
    try:
        rec = repos.workers.get_any(worker_id=worker_id)
    except Exception:
        return False
    if not rec:
        return False
    manifest = rec.get("manifest") or {}
    return bool(manifest.get("llm_intensive"))

from dotenv import load_dotenv

from contexts import context_scope_for_user, use_context_scope
from db.factory import Repositories, get_repositories
from runner_utils import ARTIFACTS_DIR, DEFAULT_TIMEOUT_SECONDS, _validate_output_schema
from worker_registry import WORKERS_DIR, get_worker_config
from runner_sandbox import get_driver as get_sandbox_driver
from models import (
    WorkerConfig,
    RunStatus,
    assert_safe_outbound_url,
    UnsafeOutboundUrlError,
    _allow_private_mcp_urls,
    _ip_is_disallowed,
    _resolve_host_ips,
)

import hashlib
import hmac
import http.client
import ipaddress
import socket as _socket
import urllib.parse
import urllib.request
import urllib.error
import contextlib

logger = logging.getLogger("floom.run_service")


class _RunPerfTimer:
    """Small stopwatch for cold-start attribution logs."""

    def __init__(self) -> None:
        self._start = time.monotonic()
        self._last = self._start
        self._marks: list[tuple[str, float, float]] = []

    def mark(self, label: str) -> None:
        now = time.monotonic()
        self._marks.append((label, (now - self._last) * 1000.0, (now - self._start) * 1000.0))
        self._last = now

    def log(self, log_fn: Callable[[str, str], None], label: str, *, level: str = "debug") -> None:
        if os.environ.get("WORKEROS_RUN_PERF_LOGS", "1").strip().lower() in {"0", "false", "no", "off"}:
            return
        if not self._marks:
            return
        total_ms = (time.monotonic() - self._start) * 1000.0
        segments = ", ".join(
            f"{name}={delta_ms:.1f}ms/{total_ms_at_mark:.1f}ms"
            for name, delta_ms, total_ms_at_mark in self._marks
        )
        log_fn(f"[perf] {label} total={total_ms:.1f}ms segments: {segments}", level)


def workeros_role() -> str:
    """Runtime role for process split.

    ``all`` preserves OSS/local behavior. Hosted deployments can run separate
    processes with ``WORKEROS_ROLE=web`` and ``WORKEROS_ROLE=worker`` against the
    same DB: web accepts requests and creates queued runs; worker drains and
    executes them.
    """
    raw = (os.environ.get("WORKEROS_ROLE") or os.environ.get("WORKEROS_PROCESS_ROLE") or "all").strip().lower()
    if raw in {"api", "web", "http"}:
        return "web"
    if raw in {"worker", "executor", "runner"}:
        return "worker"
    return "all"


def execution_role_enabled() -> bool:
    return workeros_role() in {"all", "worker"}

# Run notifications (failure email + SSRF-pinned alert webhooks) moved to
# services.run_notifications; re-imported for backward compatibility.
from services.run_notifications import (
    _resend_timeout_seconds,
    _resend_send_with_timeout,
    _NoRedirectHandler,
    _PinnedHTTPConnection,
    _PinnedHTTPSConnection,
    _make_pinned_handler,
    _open_pinned_webhook,
    _run_email_html,
    _send_email_notification,
    _fire_alert_webhooks,
    _dispatch_terminal_run_alerts,
)
UNKNOWN_RUN_ERROR_CODE = "unknown_error"
UNKNOWN_RUN_ERROR_MESSAGE = (
    "Run failed before the engine captured a specific failure reason. "
    "Check the run logs and retry."
)


# #1026: the drain loop executes each queued run in a fresh thread, which does
# NOT carry the contextvars set by the request that enqueued it (and the run is
# dequeued later anyway, after that request is gone). Single-tenant OSS needs
# nothing here. A multi-tenant host (cloud) registers a provider that, given a
# run_id, returns a context manager re-establishing that run's workspace/tenant
# scope for the duration of execution — reconstructed from the persisted run
# row, since there is no live context to copy. Default: no-op.
_run_execution_context_provider: Optional[Callable[[str], "contextlib.AbstractContextManager[Any]"]] = None
_scheduled_retry_keys: set[tuple[str, int, str]] = set()
_scheduled_retry_lock = threading.Lock()


def _cache_ttl_seconds(env_name: str, default: float) -> float:
    try:
        return max(0.0, float(os.environ.get(env_name, str(default))))
    except ValueError:
        return default


_recipe_cache_lock = threading.Lock()
_recipe_cache_by_worker: dict[str, tuple[float, Optional[tuple[str | None, WorkerConfig, Optional[Dict[str, Any]]]]]] = {}
_secret_cache_lock = threading.Lock()
_secret_cache_by_key: dict[tuple[str, str], tuple[float, Dict[str, str]]] = {}


@dataclass(frozen=True)
class _PendingLog:
    user_id: str
    run_id: str
    level: str
    message: str
    timestamp: str
    trace_id: str | None


_log_queue: "queue.Queue[_PendingLog | None]" = queue.Queue(maxsize=10000)
_log_flush_thread: Optional[threading.Thread] = None
_log_flush_lock = threading.Lock()
_log_flush_stop = threading.Event()


def _async_log_flush_enabled() -> bool:
    raw = (os.environ.get("WORKEROS_ASYNC_LOG_FLUSH") or "").strip().lower()
    if raw:
        return raw in {"1", "true", "yes", "on"}
    deploy = (
        os.environ.get("WORKEROS_DEPLOY")
        or os.environ.get("WORKEROS_DEPLOYMENT")
        or os.environ.get("WORKEROS_ENV")
        or ""
    ).strip().lower()
    if deploy in {"prod", "production", "cloud", "hosted"}:
        return True
    # Managed hosts should not block worker startup on cross-region log writes.
    return any(
        os.environ.get(name)
        for name in (
            "RAILWAY_ENVIRONMENT",
            "RAILWAY_PROJECT_ID",
            "FLY_APP_NAME",
            "K_SERVICE",
            "RENDER_SERVICE_ID",
        )
    )


def _log_flush_batch_size() -> int:
    try:
        return max(1, int(os.environ.get("WORKEROS_LOG_FLUSH_BATCH_SIZE", "100")))
    except ValueError:
        return 100


def _log_flush_interval_seconds() -> float:
    try:
        return max(0.01, float(os.environ.get("WORKEROS_LOG_FLUSH_INTERVAL_SECONDS", "0.25")))
    except ValueError:
        return 0.25


def invalidate_worker_run_cache(worker_id: str | None = None) -> None:
    """Drop per-process run hot-path caches after worker recipe mutations."""
    with _recipe_cache_lock:
        if worker_id:
            _recipe_cache_by_worker.pop(worker_id, None)
        else:
            _recipe_cache_by_worker.clear()
    if worker_id:
        with _secret_cache_lock:
            for key in [k for k in _secret_cache_by_key if k[0] == worker_id]:
                _secret_cache_by_key.pop(key, None)


def invalidate_secret_run_cache(user_id: str | None = None) -> None:
    """Drop per-process resolved secret caches after secret mutations."""
    with _secret_cache_lock:
        if user_id:
            for key in [k for k in _secret_cache_by_key if k[1] == user_id]:
                _secret_cache_by_key.pop(key, None)
        else:
            _secret_cache_by_key.clear()


def set_run_execution_context_provider(
    provider: Optional[Callable[[str], "contextlib.AbstractContextManager[Any]"]],
) -> None:
    """Register (or clear with None) the per-run execution context provider.

    Mirrors the engine's other host-extension hooks (e.g. the git workspace
    resolver). The provider is called as ``provider(run_id)`` on the run thread
    and must return a context manager; the run executes inside it.
    """
    global _run_execution_context_provider
    _run_execution_context_provider = provider


def _run_execution_context(run_id: str) -> "contextlib.AbstractContextManager[Any]":
    provider = _run_execution_context_provider
    if provider is None:
        return contextlib.nullcontext()
    try:
        ctx = provider(run_id)
    except Exception:
        logger.warning("run execution context provider failed for %s", run_id, exc_info=True)
        return contextlib.nullcontext()
    return ctx if ctx is not None else contextlib.nullcontext()



def _schedule_retry(
    *,
    original_run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    attempt: int,
    delay_seconds: int,
    user_id: str | None,
    repos: "Repositories",
    trigger_source: str = "retry",
) -> None:
    """Enqueue a retry run after *delay_seconds* in a daemon thread.

    trigger_source distinguishes the retry kind: "retry" for the worker retry
    policy, "restart_retry" for #1434 restart recovery (used to bound recovery to
    one attempt per lineage regardless of retry_attempt persistence).
    """
    retry_key = (original_run_id, int(attempt), trigger_source)
    with _scheduled_retry_lock:
        if retry_key in _scheduled_retry_keys:
            logger.info(
                "Retry #%d for run %s (%s) is already scheduled; skipping duplicate",
                attempt,
                original_run_id,
                trigger_source,
            )
            return
        _scheduled_retry_keys.add(retry_key)

    def _do_retry() -> None:
        if delay_seconds > 0:
            time.sleep(delay_seconds)
        try:
            retry_run_id = f"run_{uuid.uuid4().hex[:12]}"
            if user_id:
                repos.runs.create(
                    user_id=user_id,
                    run_id=retry_run_id,
                    worker_id=worker_id,
                    trigger_source=trigger_source,
                    retry_of_run_id=original_run_id,
                    retry_attempt=attempt,
                )
                start_run(retry_run_id, worker_id, inputs, user_id=user_id, repos=repos)
                logger.info(
                    "Retry #%d enqueued as run %s for worker %s (original: %s)",
                    attempt, retry_run_id, worker_id, original_run_id,
                )
        except Exception as exc:
            logger.warning(
                "Failed to schedule retry #%d for run %s: %s",
                attempt, original_run_id, exc,
            )
        finally:
            with _scheduled_retry_lock:
                _scheduled_retry_keys.discard(retry_key)

    t = threading.Thread(target=_do_retry, daemon=True, name=f"retry-{original_run_id}")
    t.start()


def _schedule_retry_for_failed_run(
    *,
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    owner_id: str | None,
    config: Any,
    result_retryable: bool,
    result_error_code: str | None,
    repos: "Repositories",
    log_fn,
) -> bool:
    """Schedule a retry for a failed run when policy and attempt budget allow it."""
    if not owner_id:
        return False

    retry_cfg = getattr(config, "retry", None) if config else None
    if not retry_cfg and not result_retryable:
        return False

    current_run_row = repos.runs.get_any(run_id=run_id)
    current_attempt = int((current_run_row or {}).get("retry_attempt") or 0)
    max_attempts = retry_cfg.max_attempts if retry_cfg else _retryable_driver_max_attempts(result_error_code)
    if current_attempt >= max_attempts - 1:
        return False

    base_delay_seconds = retry_cfg.delay_seconds if retry_cfg else 60
    delay_seconds = base_delay_seconds
    if result_retryable:
        delay_seconds = min(base_delay_seconds * (2**current_attempt), 3600)

    label = "retryable failure" if result_retryable and not retry_cfg else "retry"
    log_fn(
        f"Scheduling {label} {current_attempt + 1}/{max_attempts - 1} in {delay_seconds}s",
        level="info",
    )
    _schedule_retry(
        original_run_id=run_id,
        worker_id=worker_id,
        inputs=inputs,
        attempt=current_attempt + 1,
        delay_seconds=delay_seconds,
        user_id=owner_id,
        repos=repos,
    )
    return True


API_ENV_PATH = Path("/etc/workeros/api.env")


# --- authored-worker registration + smoke/gate (services/run_authoring.py) ---
# Extracted for module size; re-imported for backward compatibility.
from services.run_authoring import (  # noqa: E402,F401
    InsufficientDiskSpaceError,
    _minimum_free_disk_bytes,
    _WORKER_AUTHOR_WORKER_ID,
    _find_bundle_artifact,
    _read_authored_bundle,
    _normalize_authored_worker_yml,
    _backfill_example_input,
    _synthesize_example_input_from_schema,
    _register_authored_worker,
    _MAX_SMOKE_REPAIRS,
    _PLACEHOLDER_RUN_PY_MARKER,
    _SMOKE_CODE_FAILURE_CODES,
    _SMOKE_REPAIR_SYSTEM_PROMPT,
    _strip_code_fences,
    _build_smoke_inputs,
    _repair_run_py,
    _smoke_and_repair_generated_worker,
    _mark_worker_paused_on_disk,
    smoke_and_gate_generated_worker,
)


# ---------------------------------------------------------------------------
# SSE event publisher hook
# ---------------------------------------------------------------------------
# Populated by main.py at startup to avoid circular imports.
# Signature: (run_id: str, event: dict) -> None
_sse_publish_fn: Optional[Callable[[str, dict], None]] = None
_part_publish_fn: Optional[Callable[[str, dict], None]] = None


def register_sse_publisher(fn: Callable[[str, dict], None]) -> None:
    """Called from main.py to wire up the SSE event publisher."""
    global _sse_publish_fn
    _sse_publish_fn = fn


def register_part_publisher(fn: Callable[[str, dict], None]) -> None:
    """Called from main.py to wire up the AI SDK part publisher."""
    global _part_publish_fn
    _part_publish_fn = fn


def _publish_sse(run_id: str, event: dict) -> None:
    if _sse_publish_fn is not None:
        try:
            _sse_publish_fn(run_id, event)
        except Exception as exc:
            logger.warning("SSE publish failed for run %s: %s", run_id, exc)


def publish_run_part(run_id: str, part: dict) -> None:
    if _part_publish_fn is not None:
        try:
            _part_publish_fn(run_id, part)
        except Exception as exc:
            logger.warning("Part publish failed for run %s: %s", run_id, exc)


# ---------------------------------------------------------------------------
# Secret scrubbing
# ---------------------------------------------------------------------------

SECRET_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*[=:]\s*[^\s'\"]+"),
    re.compile(r"\b(?:sk|pk)_(?:live|test|proj|sec)_[a-zA-Z0-9_-]+\b"),
]


def scrub_secrets(text: str, secrets: Dict[str, str]) -> str:
    """Replace secret values with redacted markers in log messages."""
    if not text:
        return text
    for name, value in secrets.items():
        if value and len(value) > 3:
            text = text.replace(value, f"<REDACTED:{name}>")
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("<REDACTED>", text)
    return text


def scrub_secret_values(value: Any, secrets: Dict[str, str]) -> Any:
    """Recursively redact secret values from persisted run outputs."""
    if isinstance(value, str):
        return scrub_secrets(value, secrets)
    if isinstance(value, list):
        return [scrub_secret_values(item, secrets) for item in value]
    if isinstance(value, tuple):
        return [scrub_secret_values(item, secrets) for item in value]
    if isinstance(value, dict):
        return {
            str(key): scrub_secret_values(item, secrets)
            for key, item in value.items()
        }
    return value


def _scrub_run_output(
    output: Optional[Dict[str, Any]],
    *,
    worker_id: str,
    owner_id: str,
    repos: Repositories,
) -> Optional[Dict[str, Any]]:
    if output is None:
        return None
    try:
        run_secrets = get_secrets_for_worker(worker_id, user_id=owner_id, repos=repos)
    except Exception:
        logger.warning("Could not resolve secrets while scrubbing output for worker %s", worker_id, exc_info=True)
        run_secrets = {}
    safe = scrub_secret_values(output, run_secrets)
    return safe if isinstance(safe, dict) else {}


# ---------------------------------------------------------------------------
# Run lifecycle
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _configured_db_path() -> Path:
    configured = os.environ.get("WORKEROS_DB") or os.environ.get("FLOOM_DB")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[2] / "data" / "floom.db"


def _existing_disk_usage_path(path: Path) -> Path:
    candidate = path if path.suffix == "" else path.parent
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    return candidate


def _ensure_prerun_disk_space() -> None:
    minimum = _minimum_free_disk_bytes()
    if minimum <= 0:
        return
    checks = {
        "database": _existing_disk_usage_path(_configured_db_path()),
        "artifacts": _existing_disk_usage_path(ARTIFACTS_DIR),
    }
    failures: list[str] = []
    for label, path in checks.items():
        free = shutil.disk_usage(path).free
        if free < minimum:
            failures.append(f"{label} path {path} has {free} bytes free, minimum {minimum}")
    if failures:
        raise InsufficientDiskSpaceError("; ".join(failures))


def _repos(repos: Repositories | None = None) -> Repositories:
    return repos or get_repositories()


def _worker_owner_id(worker_id: str, repos: Repositories | None = None) -> str | None:
    return _repos(repos).workers.get_owner(worker_id=worker_id)


def _run_scope(run_id: str, repos: Repositories | None = None) -> tuple[str, str] | None:
    repos_obj = _repos(repos)
    run_row = repos_obj.runs.get_any(run_id=run_id)
    if run_row is None:
        return None
    owner_id = repos_obj.workers.get_owner(worker_id=run_row["worker_id"])
    if not owner_id:
        return None
    return owner_id, run_row["worker_id"]


def _load_worker_recipe(
    worker_id: str,
    repos: Repositories | None = None,
) -> Optional[tuple[str | None, WorkerConfig, Optional[Dict[str, Any]]]]:
    """Load the executable recipe from the repository layer plus instance row."""
    ttl = _cache_ttl_seconds("WORKEROS_RUN_RECIPE_CACHE_TTL_SECONDS", 10.0)
    if ttl > 0:
        now = time.monotonic()
        with _recipe_cache_lock:
            cached = _recipe_cache_by_worker.get(worker_id)
            if cached is not None and cached[0] > now:
                return cached[1]

    repos_obj = _repos(repos)
    loaded: Optional[tuple[str | None, WorkerConfig, Optional[Dict[str, Any]]]] = None
    try:
        recipe = repos_obj.workers.get_recipe(worker_id=worker_id)
        if recipe:
            config = recipe.get("config")
            if isinstance(config, WorkerConfig):
                # WorkerContract (schema 0.3) has no `calls` field, so the manifest
                # round-trip through DB drops it. Re-hydrate from the filesystem
                # registry when the DB config has an empty calls list so that
                # worker-to-worker call capability survives DB persistence.
                if not config.calls:
                    fs_config = get_worker_config(worker_id)
                    if fs_config and fs_config.calls:
                        config = config.model_copy(update={"calls": fs_config.calls})
                loaded = (
                    recipe.get("owner_id"),
                    config,
                    {
                        "grants": recipe.get("grants") or {},
                        "input_values": recipe.get("input_values") or {},
                        "enabled": bool(recipe.get("enabled", True)),
                    },
                )
                if ttl > 0:
                    with _recipe_cache_lock:
                        _recipe_cache_by_worker[worker_id] = (time.monotonic() + ttl, loaded)
                return loaded
    except Exception:
        logger.exception("Failed to load worker recipe from database for %s", worker_id)

    config = get_worker_config(worker_id)
    if not config:
        if ttl > 0:
            with _recipe_cache_lock:
                _recipe_cache_by_worker[worker_id] = (time.monotonic() + ttl, None)
        return None
    loaded = (_worker_owner_id(worker_id, repos_obj), config, None)
    if ttl > 0:
        with _recipe_cache_lock:
            _recipe_cache_by_worker[worker_id] = (time.monotonic() + ttl, loaded)
    return loaded


def _get_worker_config_for_run(
    worker_id: str,
    repos: Repositories | None = None,
) -> Optional[WorkerConfig]:
    loaded = _load_worker_recipe(worker_id, repos=repos)
    return loaded[1] if loaded else None


def get_worker_config_for_run(worker_id: str) -> Optional[WorkerConfig]:
    """Return the DB-resolved worker recipe used for run execution."""
    return _get_worker_config_for_run(worker_id)


def _merge_instance_inputs(instance: Optional[Dict[str, Any]], inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Apply saved instance input defaults, with per-run inputs taking precedence."""
    if not instance:
        return dict(inputs)
    defaults = instance.get("input_values") or {}
    if not isinstance(defaults, dict):
        return dict(inputs)
    return {**defaults, **inputs}


def _apply_config_input_defaults(
    config: Optional[WorkerConfig],
    inputs: Dict[str, Any],
) -> Dict[str, Any]:
    """Apply worker.yml input defaults after instance defaults and run inputs."""
    if not config:
        return dict(inputs)
    effective = dict(inputs)
    for inp in config.inputs:
        if inp.default is None:
            continue
        if inp.name not in effective:
            effective[inp.name] = inp.default
    return effective


def _runner_key(config: Optional[WorkerConfig]) -> str:
    if config and config.runtime:
        return config.runtime.runner or "e2b"
    return "e2b"


def _worker_dir_for_run(worker_id: str, config: Optional[WorkerConfig]) -> Path:
    # Delegate to the canonical resolver so the var/workers vs engine/workers
    # bundle_path drift (#1048 follow-up) is handled identically everywhere.
    from runner_utils import _resolve_worker_bundle_dir, _safe_path

    return _resolve_worker_bundle_dir(WORKERS_DIR, worker_id, config, _safe_path)


def _snapshot_worker_bundle(run_id: str, worker_id: str, config: Optional[WorkerConfig]) -> Optional[str]:
    """Best-effort copy of the worker bundle for run reproducibility."""
    data_dir = _configured_db_path().resolve().parent
    snapshot_dir = data_dir / "run-bundles" / run_id
    try:
        worker_dir = _worker_dir_for_run(worker_id, config)
        if not worker_dir.is_dir():
            raise FileNotFoundError(f"worker directory not found: {worker_dir}")
        snapshot_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            worker_dir,
            snapshot_dir,
            ignore=shutil.ignore_patterns("__pycache__", ".git", "node_modules"),
        )
        return snapshot_dir.relative_to(data_dir).as_posix()
    except Exception as exc:
        logger.warning("Run %s bundle snapshot failed for worker %s: %s", run_id, worker_id, exc)
        return None


def _snapshot_worker_bundle_background(
    run_id: str,
    worker_id: str,
    config: Optional[WorkerConfig],
    *,
    owner_id: str | None,
) -> None:
    if not owner_id:
        return

    def _run() -> None:
        bundle_snapshot_path = _snapshot_worker_bundle(run_id, worker_id, config)
        try:
            _repos(None).runs.set_bundle_snapshot_path(
                user_id=owner_id,
                run_id=run_id,
                bundle_snapshot_path=bundle_snapshot_path,
            )
        except Exception as exc:
            logger.warning("Run %s bundle snapshot persist failed: %s", run_id, exc)

    threading.Thread(
        target=_run,
        daemon=True,
        name=f"workeros-bundle-snapshot-{run_id}",
    ).start()


# --- run cost accounting + spend caps (services/run_cost.py) ---
# Extracted for module size; re-imported for backward compatibility.
from services.run_cost import (  # noqa: E402,F401
    SpendCapExceeded,
    _persist_run_cost,
    _worker_month_to_date_cost_usd,
    _spend_cap_for_config,
    _workspace_monthly_spend_cap_usd,
    _workspace_month_to_date_cost_usd,
)
def create_run(
    worker_id: str,
    inputs: Dict[str, Any],
    trigger_source: str = "manual",
    *,
    status: str | None = None,
    user_id: str | None = None,
    trigger_ref: str | None = None,
    repos: Repositories | None = None,
) -> str:
    repos_obj = _repos(repos)
    _ensure_prerun_disk_space()
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    loaded = _load_worker_recipe(worker_id, repos=repos_obj)
    owner_id = user_id or (loaded[0] if loaded else None) or _worker_owner_id(worker_id, repos_obj)
    if not owner_id:
        raise ValueError(f"Worker {worker_id} owner not found")
    config = loaded[1] if loaded else None
    # #793: refuse dispatch when the worker has already spent its monthly cap.
    _cap = _spend_cap_for_config(config)
    if _cap is not None:
        _spent = _worker_month_to_date_cost_usd(worker_id)
        if _spent >= _cap:
            raise SpendCapExceeded(
                f"Worker {worker_id} has reached its monthly spend cap "
                f"(${_spent:.2f} of ${_cap:.2f}). Raise the cap or wait for next month."
            )
    # #797: workspace-level monthly spend cap — aggregate ALL workers' month-to-
    # date cost against the workspace budget.
    _ws_cap = _workspace_monthly_spend_cap_usd()
    if _ws_cap is not None:
        _ws_spent = _workspace_month_to_date_cost_usd()
        if _ws_spent >= _ws_cap:
            raise SpendCapExceeded(
                f"Workspace has reached its monthly spend cap "
                f"(${_ws_spent:.2f} of ${_ws_cap:.2f}). Raise it in Settings or wait for next month."
            )
    instance = loaded[2] if loaded else None
    if instance and not instance.get("enabled", True):
        raise ValueError(f"Worker {worker_id} is disabled")
    effective_inputs = _apply_config_input_defaults(
        config,
        _merge_instance_inputs(instance, inputs),
    )
    # Determine runner from config; script workers default to E2B.
    runner = _runner_key(config)
    last_exc: Exception | None = None
    for attempt in range(6):
        try:
            repos_obj.runs.create(
                user_id=owner_id,
                run_id=run_id,
                worker_id=worker_id,
                status=status or RunStatus.QUEUED.value,
                trigger_source=trigger_source,
                runner=runner,
                input_json=effective_inputs,
                created_at=_now_iso(),
                trigger_ref=trigger_ref,
            )
            last_exc = None
            break
        except sqlite3.OperationalError as exc:
            if "database is locked" not in str(exc).lower() or attempt == 5:
                raise
            last_exc = exc
            time.sleep(0.05 * (attempt + 1))
    if last_exc is not None:
        raise last_exc
    logger.info("Created run %s for worker %s (runner=%s)", run_id, worker_id, runner)
    return run_id


def _persist_log_batch(batch: list[_PendingLog], repos: Repositories | None = None) -> None:
    if not batch:
        return
    repos_obj = _repos(repos)
    add_logs = getattr(repos_obj.runs, "add_logs", None)
    if callable(add_logs):
        add_logs(rows=[
            {
                "user_id": item.user_id,
                "run_id": item.run_id,
                "level": item.level,
                "message": item.message,
                "timestamp": item.timestamp,
                "trace_id": item.trace_id,
            }
            for item in batch
        ])
        return
    for item in batch:
        repos_obj.runs.add_log(
            user_id=item.user_id,
            run_id=item.run_id,
            level=item.level,
            message=item.message,
            timestamp=item.timestamp,
            trace_id=item.trace_id,
        )


def _log_flush_loop() -> None:
    logger.info("Async run-log flush loop started")
    batch_size = _log_flush_batch_size()
    interval = _log_flush_interval_seconds()
    pending: list[_PendingLog] = []
    while not _log_flush_stop.is_set():
        try:
            item = _log_queue.get(timeout=interval)
        except queue.Empty:
            item = None
        if item is None:
            if pending:
                try:
                    _persist_log_batch(pending)
                except Exception as exc:
                    logger.warning("Async run-log flush failed for %d row(s): %s", len(pending), exc)
                pending = []
            _log_queue.task_done()
            continue
        pending.append(item)
        _log_queue.task_done()
        if len(pending) >= batch_size:
            try:
                _persist_log_batch(pending)
            except Exception as exc:
                logger.warning("Async run-log flush failed for %d row(s): %s", len(pending), exc)
            pending = []

    # Final best-effort drain on shutdown.
    while True:
        try:
            item = _log_queue.get_nowait()
        except queue.Empty:
            break
        if item is not None:
            pending.append(item)
        _log_queue.task_done()
        if len(pending) >= batch_size:
            try:
                _persist_log_batch(pending)
            except Exception as exc:
                logger.warning("Async run-log shutdown flush failed for %d row(s): %s", len(pending), exc)
            pending = []
    if pending:
        try:
            _persist_log_batch(pending)
        except Exception as exc:
            logger.warning("Async run-log shutdown flush failed for %d row(s): %s", len(pending), exc)


def start_log_flush_loop() -> None:
    global _log_flush_thread
    if not _async_log_flush_enabled():
        return
    with _log_flush_lock:
        if _log_flush_thread is not None and _log_flush_thread.is_alive():
            return
        _log_flush_stop.clear()
        _log_flush_thread = threading.Thread(
            target=_log_flush_loop,
            daemon=True,
            name="workeros-log-flush",
        )
        _log_flush_thread.start()


def stop_log_flush_loop(timeout: float = 5.0) -> None:
    global _log_flush_thread
    _log_flush_stop.set()
    try:
        _log_queue.put_nowait(None)
    except queue.Full:
        pass
    with _log_flush_lock:
        thread = _log_flush_thread
    if thread is not None:
        thread.join(timeout=timeout)


def flush_run_logs(run_id: str | None = None, *, timeout: float = 2.0) -> None:
    """Best-effort barrier for tests/terminal transitions when async logging is on."""
    if not _async_log_flush_enabled():
        return
    start_log_flush_loop()
    try:
        _log_queue.put_nowait(None)
    except queue.Full:
        pass
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _log_queue.unfinished_tasks == 0:
            return
        time.sleep(0.01)


def add_log(
    run_id: str,
    message: str,
    level: str = "info",
    trace_id: Optional[str] = None,
    attributes: Optional[Dict[str, Any]] = None,
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    repos_obj = _repos(repos)
    owner_id = user_id
    if owner_id is None:
        scope = _run_scope(run_id, repos_obj)
        if scope is None:
            return
        owner_id, _worker_id = scope
    ts = _now_iso()
    if _async_log_flush_enabled():
        start_log_flush_loop()
        try:
            _log_queue.put_nowait(_PendingLog(
                user_id=owner_id,
                run_id=run_id,
                level=level,
                message=message,
                timestamp=ts,
                trace_id=trace_id,
            ))
        except queue.Full:
            logger.warning("Async run-log queue full; writing log synchronously for run %s", run_id)
            repos_obj.runs.add_log(
                user_id=owner_id,
                run_id=run_id,
                level=level,
                message=message,
                timestamp=ts,
                trace_id=trace_id,
            )
    else:
        repos_obj.runs.add_log(
            user_id=owner_id,
            run_id=run_id,
            level=level,
            message=message,
            timestamp=ts,
            trace_id=trace_id,
        )
    _publish_sse(run_id, {
        "type": "log",
        "run_id": run_id,
        "level": level,
        "message": message,
        "timestamp": ts,
        "trace_id": trace_id,
    })


# ---------------------------------------------------------------------------
# PostHog product-analytics emission (server is the source of truth for run
# OUTCOMES). All four run-lifecycle events emit from the single terminal point
# (update_run_status) so there is exactly one event per state transition and the
# failure category is computed from the SAME classify_failure() the runs API
# uses. Fail-soft + no-op when POSTHOG_API_KEY is unset; never blocks/raises.
# ---------------------------------------------------------------------------

# status value -> PostHog event name. running/completed/failed/cancelled only;
# pending_approval is emitted separately as approval_requested at its set point.
_RUN_STATUS_EVENT = {
    RunStatus.RUNNING.value: "run_started",
    RunStatus.COMPLETED.value: "run_completed",
    RunStatus.FAILED.value: "run_failed",
    RunStatus.CANCELLED.value: "run_cancelled",
}


def _json_byte_len(value: Any) -> Optional[int]:
    """UTF-8 byte length of a JSON-serializable value (dict OR pre-serialized
    str). Returns None when absent; never raises."""
    if value is None:
        return None
    try:
        if isinstance(value, (bytes, bytearray)):
            return len(value)
        if isinstance(value, str):
            return len(value.encode("utf-8"))
        return len(json.dumps(value, default=str).encode("utf-8"))
    except Exception:
        return None


def _run_duration_ms(run_row: Optional[Dict[str, Any]]) -> Optional[int]:
    """Best-effort run duration in ms: prefer the persisted duration_ms; else
    compute started_at -> now. Returns None when no start time is known."""
    if not run_row:
        return None
    persisted = run_row.get("duration_ms")
    if persisted is not None:
        try:
            return int(persisted)
        except (TypeError, ValueError):
            pass
    started_raw = run_row.get("started_at")
    if not started_raw:
        return None
    try:
        started = datetime.fromisoformat(str(started_raw).replace("Z", "+00:00"))
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - started
        return max(0, int(delta.total_seconds() * 1000))
    except Exception:
        return None


def _emit_run_lifecycle_event(
    *,
    run_id: str,
    status: str,
    worker_id: str,
    owner_id: Optional[str],
    error: Optional[str],
    error_code: Optional[str],
    run_row: Optional[Dict[str, Any]],
    repos: Repositories,
) -> None:
    """Emit the run_started/completed/failed/cancelled PostHog event for a
    terminal (or running) transition. Pure side effect; swallows all errors so
    analytics can never break a run."""
    try:
        from services import analytics_posthog
        from services import run_metrics
    except Exception:  # pragma: no cover - analytics module import guard
        return
    if not analytics_posthog.is_enabled():
        return

    event = _RUN_STATUS_EVENT.get(status)
    if event is None:
        return

    try:
        # workspace group: prefer an explicit workspace_id from the row (cloud
        # backend); else derive from the owner id (engine convention).
        from db import derive_workspace_id

        workspace_id = ""
        if run_row:
            workspace_id = str(run_row.get("workspace_id") or "").strip()
        if not workspace_id:
            workspace_id = derive_workspace_id(owner_id)

        trigger_source = str((run_row or {}).get("trigger_source") or "").strip() or None
        runner = str((run_row or {}).get("runner") or "").strip() or None
        input_bytes = _json_byte_len((run_row or {}).get("input_json"))
        output_bytes = _json_byte_len((run_row or {}).get("output_json"))

        props: Dict[str, Any] = {
            "run_id": run_id,
            "worker_id": worker_id or None,
            "status": status,
            "trigger_source": trigger_source,
            "runner": runner,
        }

        if event == "run_started":
            props.update(
                {
                    "input_bytes": input_bytes,
                    "input_present": bool(input_bytes),
                }
            )
        else:
            # terminal: attach duration + cost + tokens (cost persisted just
            # before this call). tokens/cost are computed from the transcript so
            # they are correct regardless of the backend's run-row columns.
            duration_ms = _run_duration_ms(run_row)
            total_tokens: Optional[int] = None
            total_cost_usd: Optional[float] = None
            try:
                from cost import (
                    resolved_cost_usd_from_transcript,
                    total_tokens_from_transcript,
                )

                total_tokens = total_tokens_from_transcript(run_id)
                # Trace-derived cost (Track A §A2) when available, else blended
                # estimate — the SAME source the persisted run row uses, so the
                # PostHog event and the runs API never disagree on cost.
                total_cost_usd = resolved_cost_usd_from_transcript(run_id)
            except Exception:
                total_tokens = None
                total_cost_usd = None
            props.update(
                {
                    "duration_ms": duration_ms,
                    "total_tokens": total_tokens,
                    "total_cost_usd": total_cost_usd,
                }
            )
            if event == "run_completed":
                props["output_bytes"] = output_bytes
            elif event == "run_failed":
                # error_category is computed from the SAME classify_failure the
                # runs API uses — NEVER a hand-typed string (taxonomy parity).
                props["error_category"] = run_metrics.classify_failure(
                    error_code=error_code, error=error
                )
                props["error_code"] = error_code or None
            elif event == "run_cancelled":
                # cancelled is its own category; keep it off the failure funnel.
                props["error_category"] = "cancelled"
                props["error_code"] = error_code or None

        analytics_posthog.capture_event(
            distinct_id=owner_id or "",
            event=event,
            properties=props,
            groups={"workspace": workspace_id} if workspace_id else None,
        )
    except Exception:  # pragma: no cover - belt-and-suspenders
        logger.debug("PostHog run-lifecycle emit failed for %s", run_id, exc_info=True)


def _emit_run_exception(
    *,
    exc: BaseException,
    run_id: str,
    worker_id: str,
    owner_id: Optional[str],
    trace_id: Optional[str] = None,
    error_code: Optional[str] = None,
) -> None:
    """Capture a PostHog ``$exception`` for a crashed run (Track A §A4).

    Groups crashes into issues with type + stack trace, attaching the run /
    worker / workspace / trace id + the run_metrics error_category. Pure side
    effect; swallows everything so it can never break a run."""
    try:
        from services import ai_observability as ai_obs
        from services import run_metrics
        from db import derive_workspace_id
    except Exception:  # pragma: no cover
        return
    if not ai_obs.is_enabled():
        return
    try:
        category = run_metrics.classify_failure(error_code=error_code, error=str(exc))
        ai_obs.capture_exception(
            owner_id=owner_id or "",
            exc=exc,
            run_id=run_id,
            worker_id=worker_id or "",
            workspace_id=derive_workspace_id(owner_id),
            trace_id=trace_id,
            error_code=error_code,
            error_category=category,
        )
    except Exception:  # pragma: no cover - belt-and-suspenders
        logger.debug("PostHog $exception emit failed for %s", run_id, exc_info=True)


def _emit_approval_requested(
    *,
    approval_id: str,
    run_id: str,
    worker_id: str,
    owner_id: Optional[str],
    tool_name: Optional[str] = None,
    risk_level: Optional[str] = None,
) -> None:
    """Emit the approval_requested PostHog event when a run parks awaiting
    approval. Single point (the pending_approval set). Swallows all errors."""
    try:
        from services import analytics_posthog
        from db import derive_workspace_id
    except Exception:  # pragma: no cover
        return
    if not analytics_posthog.is_enabled():
        return
    try:
        analytics_posthog.capture_event(
            distinct_id=owner_id or "",
            event="approval_requested",
            properties={
                "approval_id": approval_id,
                "run_id": run_id,
                "worker_id": worker_id or None,
                "tool_name": tool_name or None,
                "risk_level": risk_level or None,
            },
            groups={"workspace": derive_workspace_id(owner_id)},
        )
    except Exception:  # pragma: no cover
        logger.debug("PostHog approval_requested emit failed for %s", run_id, exc_info=True)


def update_run_status(
    run_id: str,
    status: str,
    output: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
    error_code: Optional[str] = None,
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    repos_obj = _repos(repos)
    owner_id = user_id
    if owner_id is None:
        scope = _run_scope(run_id, repos_obj)
        if scope is None:
            return
        owner_id, _worker_id = scope
    run_row = repos_obj.runs.get(user_id=owner_id, run_id=run_id)
    worker_id = str((run_row or {}).get("worker_id") or "")
    if output is not None and worker_id:
        output = _scrub_run_output(output, worker_id=worker_id, owner_id=owner_id, repos=repos_obj)
    previous_error = (run_row or {}).get("error")
    previous_error_code = (run_row or {}).get("error_code")
    if status == RunStatus.FAILED.value:
        normalized_error = str(error).strip() if error is not None else ""
        normalized_error_code = str(error_code).strip() if error_code is not None else ""
        if not normalized_error:
            normalized_error = str(previous_error).strip() if previous_error else ""
        if not normalized_error_code:
            normalized_error_code = str(previous_error_code).strip() if previous_error_code else ""
        if not normalized_error:
            normalized_error = UNKNOWN_RUN_ERROR_MESSAGE
            logger.error(
                "Run %s reached failed status without an error message; applying fallback",
                run_id,
                stack_info=True,
            )
        if not normalized_error_code:
            normalized_error_code = UNKNOWN_RUN_ERROR_CODE
            logger.error(
                "Run %s reached failed status without an error_code; applying fallback",
                run_id,
                stack_info=True,
            )
        error = normalized_error
        error_code = normalized_error_code
    repos_obj.runs.update_status(
        user_id=owner_id,
        run_id=run_id,
        status=status,
        output_json=output,
        error=error,
        error_code=error_code,
    )
    if status in {
        RunStatus.COMPLETED.value,
        RunStatus.FAILED.value,
        RunStatus.CANCELLED.value,
        RunStatus.PENDING_APPROVAL.value,
    }:
        flush_run_logs(run_id)

    if worker_id and status in {RunStatus.COMPLETED.value, RunStatus.FAILED.value}:
        # #793/#795: persist per-run cost at terminal status (best-effort) so
        # the monthly-spend aggregate and approval cost-so-far don't have to
        # re-read transcripts later. Never let cost accounting break a run.
        try:
            # Route through the repo so the write lands in whatever backend the
            # deployment uses (sqlite single-tenant OR cloud Supabase). The old
            # raw get_db() write went only to local sqlite, leaving cloud runs
            # with null total_tokens/total_cost_usd.
            _persist_run_cost(run_id, user_id=owner_id, repos=repos_obj)
        except Exception:
            logger.debug("run cost persistence failed for %s", run_id, exc_info=True)
        _dispatch_terminal_run_alerts(
            run_id=run_id,
            worker_id=worker_id,
            status=status,
            error=error if error is not None else previous_error,
            user_id=owner_id,
            repos=repos_obj,
        )

    # Publish SSE event for the status change
    _publish_sse(run_id, {
        "type": "status",
        "run_id": run_id,
        "status": status,
        "error": error,
        "error_code": error_code,
    })

    # PostHog: emit the run-lifecycle outcome event from this single terminal
    # point (one event per running/completed/failed/cancelled transition). The
    # cost row was just persisted above so total_tokens/total_cost_usd are read
    # from the same transcript. No-op + never raises when analytics is disabled.
    if status in _RUN_STATUS_EVENT:
        _emit_run_lifecycle_event(
            run_id=run_id,
            status=status,
            worker_id=worker_id,
            owner_id=owner_id,
            error=error if error is not None else previous_error,
            error_code=error_code,
            run_row=run_row,
            repos=repos_obj,
        )


# --- run output storage + validation (services/run_outputs.py) ---
# Extracted for module size; re-imported for backward compatibility.
from services.run_outputs import (  # noqa: E402,F401
    _PLACEHOLDER_MARKERS,
    _PATH_VALUE_RE,
    _store_run_artifacts,
    _looks_like_relative_path,
    _placeholder_warning,
    _output_artifact,
    _candidate_output_path,
    _safe_artifact_path,
    _materialize_declared_file_outputs,
    _validate_run_outputs,
    _smoke_empty_output_error,
    _parse_expected_example_output,
    _expected_example_output_from_bundle,
    _normalize_example_value,
    _example_values_equal,
    _actual_example_outputs,
    _validate_example_output,
)
# --- secret resolution (services/run_secrets.py) ---
# Extracted for module size; re-imported for backward compatibility.
from services.run_secrets import (  # noqa: E402,F401
    _PLATFORM_SECRET_NAMES,
    _load_runtime_env_files,
    _env_keys_from_file,
    _secret_names_from_db,
    get_secrets_for_worker,
)
# ---------------------------------------------------------------------------
# Execution orchestration
# ---------------------------------------------------------------------------

INTERRUPTED_RUN_ERROR = "Run was interrupted by an API restart before completion."
INTERRUPTED_RUN_ERROR_CODE = "interrupted_by_restart"
ABANDONED_RUN_ERROR = "run abandoned (server restarted): no active executor after timeout window"
ABANDONED_RUN_ERROR_CODE = "run_abandoned_server_restart"
DISPATCH_ORPHAN_ERROR = "run abandoned before sandbox dispatch: claimed by queue drain but no executor reached sandbox startup"
DISPATCH_ORPHAN_ERROR_CODE = "run_claimed_without_dispatch"
WORKER_DELETED_RUN_ERROR = "Worker deleted before run completed."
_SCHEDULE_MISSING_SECRET_PAUSE_AFTER = 3
_RUN_REAPER_DEFAULT_GRACE_SECONDS = 60
_RUN_REAPER_DEFAULT_INTERVAL_SECONDS = 180


@dataclass
class _ActiveRun:
    run_id: str
    worker_id: str
    user_id: str | None
    thread: threading.Thread
    started_monotonic: float = field(default_factory=time.monotonic)
    stage: str = "claimed"


_active_runs: dict[str, _ActiveRun] = {}
_active_runs_lock = threading.Lock()
_shutdown_cancelled_runs: set[str] = set()


def _register_active_run(active_run: _ActiveRun) -> None:
    with _active_runs_lock:
        _active_runs[active_run.run_id] = active_run


def _unregister_active_run(run_id: str) -> None:
    with _active_runs_lock:
        _active_runs.pop(run_id, None)
        _shutdown_cancelled_runs.discard(run_id)


def _mark_active_run_stage(run_id: str, stage: str) -> None:
    with _active_runs_lock:
        active = _active_runs.get(run_id)
        if active is not None:
            active.stage = stage


def _active_run_ids_excluding_stale_pre_sandbox(timeout_seconds: int) -> set[str]:
    """Active ids that should still protect rows from dispatch-orphan reaping.

    A live thread before sandbox startup can be the bug: it may be blocked in
    run-context setup, DB recipe/secret loading, or another pre-driver step. Do
    not let that active handle hide the row forever once it has exceeded the
    dispatch-orphan timeout. Runs that reached sandbox startup are already
    protected by the repository's sandbox-log predicate.
    """
    cutoff = time.monotonic() - max(0, int(timeout_seconds))
    pre_sandbox = {"claimed", "thread_entry", "context_entered", "execute_start", "pre_sandbox"}
    with _active_runs_lock:
        return {
            run_id
            for run_id, active in _active_runs.items()
            if active.stage not in pre_sandbox or active.started_monotonic >= cutoff
        }


def _schedule_missing_secret_pause_threshold() -> int:
    raw = os.environ.get("WORKEROS_SCHEDULE_MISSING_SECRET_PAUSE_AFTER", "")
    if not raw:
        return _SCHEDULE_MISSING_SECRET_PAUSE_AFTER
    try:
        return max(0, int(raw))
    except ValueError:
        return _SCHEDULE_MISSING_SECRET_PAUSE_AFTER


# --- worker pause + workspace alerting policy (services/run_pause_policy.py) ---
# Extracted for module size; re-imported for backward compatibility.
from services.run_pause_policy import (  # noqa: E402,F401
    _persist_worker_paused_flag,
    _maybe_pause_scheduled_worker_after_setup_failure,
    _FALSEY,
    _workspace_setting,
    _workspace_toggle,
    _workspace_failure_email_recipients,
    _auto_pause_on_consecutive_failures_enabled,
    _alert_consecutive_failure_threshold,
    _maybe_pause_worker_after_consecutive_failures,
)
def _resolved_worker_timeout_seconds(config: Optional["WorkerConfig"]) -> int:
    """Resolve the effective run timeout for a worker dispatch.

    Policy (#1127/#1314):
    - Default: ``config.runtime.limits.timeout_seconds`` (per-worker, default 300 s).
    - Workspace ``default_timeout_seconds`` overrides the per-worker value when
      set, enabling opt-in runs up to MAX_RUN_TIMEOUT_SECONDS (3600 s = 1 hour).
    - Absolute ceiling: MAX_RUN_TIMEOUT_SECONDS (never exceeds 3600 s).

    Examples:
      worker limits=300, ws unset   → 300   (existing behaviour unchanged)
      worker limits=300, ws=3600    → 3600  (workspace opt-in to 1 h)
    """
    from runtime_limits import MAX_RUN_TIMEOUT_SECONDS

    if config and config.runtime and config.runtime.limits:
        per_worker = config.runtime.limits.timeout_seconds
    else:
        per_worker = DEFAULT_TIMEOUT_SECONDS

    raw = (_workspace_setting("default_timeout_seconds") or "").strip()
    ws_timeout: Optional[int] = None
    if raw:
        try:
            n = int(float(raw))
            if n > 0:
                ws_timeout = n
        except (ValueError, TypeError):
            pass

    effective = ws_timeout if ws_timeout is not None else per_worker
    return min(effective, MAX_RUN_TIMEOUT_SECONDS)


def active_run_count() -> int:
    with _active_runs_lock:
        return len(_active_runs)


def _active_run_ids() -> set[str]:
    with _active_runs_lock:
        return set(_active_runs)


def was_shutdown_cancelled(run_id: str) -> bool:
    with _active_runs_lock:
        return run_id in _shutdown_cancelled_runs


def _run_reaper_grace_seconds() -> int:
    raw = os.environ.get("WORKEROS_RUN_REAPER_GRACE_SECONDS", "")
    if not raw:
        return _RUN_REAPER_DEFAULT_GRACE_SECONDS
    try:
        return max(0, int(raw))
    except ValueError:
        return _RUN_REAPER_DEFAULT_GRACE_SECONDS


def _run_reaper_interval_seconds() -> int:
    raw = os.environ.get("WORKEROS_RUN_REAPER_INTERVAL_SECONDS", "")
    if not raw:
        return _RUN_REAPER_DEFAULT_INTERVAL_SECONDS
    try:
        return max(30, int(raw))
    except ValueError:
        return _RUN_REAPER_DEFAULT_INTERVAL_SECONDS


# #1434: auto-requeue config. A deploy/restart severs the in-process executor
# thread, so in-flight runs are reaped as "abandoned". Instead of surfacing a
# hard failure, auto-retry them a bounded number of times (the parent run still
# records the abandonment; a fresh retry run carries the work to completion).
def _auto_requeue_abandoned_enabled() -> bool:
    return os.environ.get("WORKEROS_AUTO_REQUEUE_ABANDONED_RUNS", "1") not in _FALSEY


def _max_restart_retries() -> int:
    raw = os.environ.get("WORKEROS_MAX_RESTART_RETRIES", "")
    if not raw:
        return 1
    try:
        return max(0, int(raw))
    except ValueError:
        return 1


def _dispatch_orphan_timeout_seconds() -> int:
    raw = os.environ.get("WORKEROS_DISPATCH_ORPHAN_TIMEOUT_SECONDS", "")
    if not raw:
        return 120
    try:
        return max(30, int(raw))
    except ValueError:
        return 120


def _is_infra_retry_error_code(error_code: str | None) -> bool:
    return (error_code or "").strip().lower() in {
        "e2b_sandbox_error",
        "e2b_quota_exhausted",
        "run_claimed_without_dispatch",
    }


def _retryable_driver_max_attempts(error_code: str | None) -> int:
    raw = os.environ.get("WORKEROS_INFRA_RETRY_MAX_ATTEMPTS", "")
    default = 3 if _is_infra_retry_error_code(error_code) else 2
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


def _fail_stale_running_rows(
    repos_obj: Repositories,
    *,
    timeout: int,
    grace: int,
    now_dt: datetime,
) -> list[dict[str, Any]]:
    """Status-gated fail of stale `running` rows; returns the rows it failed."""
    cutoff_iso = (now_dt - timedelta(seconds=timeout + grace)).isoformat()
    active_ids = _active_run_ids()

    failed = repos_obj.runs.fail_stale_running(
        cutoff_iso=cutoff_iso,
        exclude_run_ids=active_ids,
        error=ABANDONED_RUN_ERROR,
        error_code=ABANDONED_RUN_ERROR_CODE,
    )
    for row in failed:
        run_id = str(row.get("run_id") or row.get("id") or "")
        user_id = row.get("user_id")
        if not run_id or not user_id:
            continue
        try:
            repos_obj.runs.add_log(
                user_id=str(user_id),
                run_id=run_id,
                level="error",
                message=ABANDONED_RUN_ERROR,
                timestamp=datetime.now(timezone.utc).isoformat(),
                trace_id=None,
            )
        except Exception as exc:
            logger.warning("Failed to add abandoned-run log for %s: %s", run_id, exc)
    if failed:
        logger.warning(
            "Reaped %d abandoned running run(s) older than %ss + %ss grace",
            len(failed),
            timeout,
            grace,
        )
    return failed


def _fail_dispatch_orphan_rows(
    repos_obj: Repositories,
    *,
    now_dt: datetime,
) -> list[dict[str, Any]]:
    timeout = _dispatch_orphan_timeout_seconds()
    cutoff_iso = (now_dt - timedelta(seconds=timeout)).isoformat()
    active_ids = _active_run_ids_excluding_stale_pre_sandbox(timeout)
    fail_method = getattr(repos_obj.runs, "fail_stale_running_without_sandbox_logs", None)
    if not callable(fail_method):
        return []
    failed = fail_method(
        cutoff_iso=cutoff_iso,
        exclude_run_ids=active_ids,
        error=DISPATCH_ORPHAN_ERROR,
        error_code=DISPATCH_ORPHAN_ERROR_CODE,
    )
    for row in failed:
        run_id = str(row.get("run_id") or row.get("id") or "")
        user_id = row.get("user_id")
        if not run_id or not user_id:
            continue
        try:
            repos_obj.runs.add_log(
                user_id=str(user_id),
                run_id=run_id,
                level="error",
                message=DISPATCH_ORPHAN_ERROR,
                timestamp=datetime.now(timezone.utc).isoformat(),
                trace_id=None,
            )
        except Exception as exc:
            logger.warning("Failed to add dispatch-orphan log for %s: %s", run_id, exc)
    if failed:
        logger.warning(
            "Reaped %d claimed-without-dispatch run(s) older than %ss",
            len(failed),
            timeout,
        )
    return failed


def _resolve_reaper_window(
    timeout_seconds: int | None,
    grace_seconds: int | None,
    now: datetime | None,
) -> tuple[int, int, datetime]:
    timeout = DEFAULT_TIMEOUT_SECONDS if timeout_seconds is None else max(0, int(timeout_seconds))
    grace = _run_reaper_grace_seconds() if grace_seconds is None else max(0, int(grace_seconds))
    now_dt = now or datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    return timeout, grace, now_dt


def reap_abandoned_runs(
    *,
    repos: Repositories | None = None,
    now: datetime | None = None,
    timeout_seconds: int | None = None,
    grace_seconds: int | None = None,
) -> int:
    """Fail stale `running` rows that no longer have a live executor.

    This is intentionally conservative: a row must be older than the normal run
    timeout plus a grace margin, and its run id must not be present in the
    current process' active execution registry. The repository update is also
    status-gated, so repeated sweeps are harmless.
    """
    repos_obj = _repos(repos)
    timeout, grace, now_dt = _resolve_reaper_window(timeout_seconds, grace_seconds, now)
    return len(_fail_stale_running_rows(repos_obj, timeout=timeout, grace=grace, now_dt=now_dt))


def _requeue_abandoned_run(repos_obj: Repositories, row: dict[str, Any]) -> bool:
    """Schedule a fresh retry for one reaped-abandoned run, if within budget.

    Returns True if a retry was enqueued. Reuses the existing retry plumbing
    (a new run with retry_of_run_id set), so it works identically on the SQLite
    and Supabase repositories and is bounded by retry_attempt to avoid loops on a
    worker that crashes the process on every boot.
    """
    run_id = str(row.get("run_id") or row.get("id") or "")
    user_id = row.get("user_id")
    if not run_id or not user_id:
        return False
    try:
        run = repos_obj.runs.get_any(run_id=run_id)
    except Exception:
        run = None
    if not run:
        return False
    worker_id = str(run.get("worker_id") or "")
    if not worker_id:
        return False
    max_restart = _max_restart_retries()
    if max_restart <= 0:
        return False
    # Bound recovery to one attempt per lineage. The retry run is tagged
    # trigger_source="restart_retry"; if it too gets abandoned we do NOT recover
    # it again. This is robust even though create() does not persist
    # retry_attempt, so a misconfigured worker cannot loop the executor forever.
    trigger_source = str(run.get("trigger_source") or "")
    if trigger_source.startswith("restart_retry"):
        return False
    attempt = int(run.get("retry_attempt") or 0)
    inputs = run.get("input_json")
    if isinstance(inputs, str):
        try:
            inputs = json.loads(inputs or "{}")
        except Exception:
            inputs = {}
    if not isinstance(inputs, dict):
        inputs = {}
    try:
        _schedule_retry(
            original_run_id=run_id,
            worker_id=worker_id,
            inputs=inputs,
            attempt=attempt + 1,
            delay_seconds=0,
            user_id=str(user_id),
            repos=repos_obj,
            trigger_source="restart_retry",
        )
        repos_obj.runs.add_log(
            user_id=str(user_id),
            run_id=run_id,
            level="info",
            message=(
                f"Auto-retrying after server restart (attempt {attempt + 1} of "
                f"{max_restart}); a new run was enqueued to finish the work."
            ),
            timestamp=datetime.now(timezone.utc).isoformat(),
            trace_id=None,
        )
        return True
    except Exception as exc:
        logger.warning("Failed to auto-requeue abandoned run %s: %s", run_id, exc)
        return False


def recover_abandoned_runs(
    *,
    repos: Repositories | None = None,
    now: datetime | None = None,
    timeout_seconds: int | None = None,
    grace_seconds: int | None = None,
) -> dict[str, int]:
    """Reap stale `running` rows AND auto-requeue the ones within retry budget.

    #1434: a deploy/restart kills the executor thread, so in-flight runs would
    otherwise hard-fail ("abandoned"). This reaps them (so the orphaned row
    leaves `running`) and then enqueues a bounded retry so the user's work
    completes instead of dying on every deploy. Returns {"failed", "requeued"}.
    """
    repos_obj = _repos(repos)
    timeout, grace, now_dt = _resolve_reaper_window(timeout_seconds, grace_seconds, now)
    failed = _fail_dispatch_orphan_rows(repos_obj, now_dt=now_dt)
    failed.extend(_fail_stale_running_rows(repos_obj, timeout=timeout, grace=grace, now_dt=now_dt))
    requeued = 0
    if failed and _auto_requeue_abandoned_enabled():
        for row in failed:
            if _requeue_abandoned_run(repos_obj, row):
                requeued += 1
        if requeued:
            logger.warning(
                "Auto-requeued %d of %d abandoned run(s) after restart",
                requeued,
                len(failed),
            )
            _wake_drain()
    return {"failed": len(failed), "requeued": requeued}

# ---------------------------------------------------------------------------
# Queue drain loop
# ---------------------------------------------------------------------------
# The drain loop is a background daemon thread that wakes on a threading.Event,
# polls the DB for queued runs (FIFO), and dispatches each one by acquiring the
# execution semaphore.  This means run-create is always instant (returns
# "queued") and the concurrency gate sits at the sandbox spawn boundary.

_drain_event = threading.Event()
_drain_stop = threading.Event()
_drain_thread: Optional[threading.Thread] = None
_drain_lock = threading.Lock()

_DRAIN_POLL_INTERVAL = 0.5  # seconds between polls when runs are queued

_run_reaper_stop = threading.Event()
_run_reaper_thread: Optional[threading.Thread] = None
_run_reaper_lock = threading.Lock()


def _wake_drain() -> None:
    """Signal the drain loop that new queued work may be available."""
    _drain_event.set()


def _drain_loop() -> None:
    """Background thread: drain the queued-runs table as execution slots free up."""
    logger.info("Queue drain loop started (max_concurrent=%d)", _max_concurrent_runs())
    while not _drain_stop.is_set():
        # Wait for a wake signal or the poll interval, then clear the event.
        _drain_event.wait(timeout=_DRAIN_POLL_INTERVAL)
        _drain_event.clear()
        if _drain_stop.is_set():
            break
        _drain_one_batch()


def _drain_one_batch() -> None:
    """Pick up all drainable queued runs (up to semaphore count) and dispatch them."""
    try:
        repos_obj = get_repositories()
        queued = repos_obj.runs.get_queued(limit=50)
    except Exception as exc:
        logger.warning("Queue drain: DB poll failed: %s", exc)
        return

    for row in queued:
        if _drain_stop.is_set():
            break
        run_id = row["run_id"]
        worker_id = row["worker_id"]
        user_id = row["user_id"]
        try:
            input_json = row.get("input_json") or "{}"
            inputs = json.loads(input_json) if isinstance(input_json, str) else input_json
        except Exception:
            inputs = {}

        # Try to grab a slot non-blockingly; if none is free, stop for now.
        # The drain loop will retry on the next wake (semaphore release calls
        # _wake_drain via the run-thread finally block).
        acquired = _get_semaphore().acquire(blocking=False)
        if not acquired:
            # No free slots right now — stop this batch; wake will come when
            # a run completes (_run_thread_entry calls _wake_drain on exit).
            logger.debug("Queue drain: no free execution slots, pausing")
            break

        # #1448: LLM-intensive runs additionally take an LLM-budget slot so a
        # burst of judge-heavy workers cannot stack and 429 the shared provider
        # quota. If that budget is full, leave THIS run queued, free the main
        # slot, and keep draining other (non-heavy) runs - the heavy run is
        # picked up when an LLM slot frees (releasing it wakes the drain).
        llm_slot = False
        if _worker_is_llm_intensive(worker_id, repos_obj):
            llm_slot = _get_llm_semaphore().acquire(blocking=False)
            if not llm_slot:
                logger.debug(
                    "Queue drain: LLM budget full, deferring llm-intensive run %s", run_id
                )
                _get_semaphore().release()
                continue

        try:
            dispatch_perf = _RunPerfTimer()
            # Claim the run before spawning a worker thread so subsequent drain
            # passes cannot dispatch the same queued row twice. The repository
            # performs this as a conditional update so separate API replicas
            # cannot both win the same queued run.
            claimed = repos_obj.runs.claim_queued(
                user_id=user_id,
                run_id=run_id,
                started_at=_now_iso(),
            )
            dispatch_perf.mark("claim_queued")
            if claimed is None:
                logger.info("Queue drain: skipped run %s because another drainer claimed it", run_id)
                _get_semaphore().release()
                if llm_slot:
                    _get_llm_semaphore().release()
                continue

            # Slot acquired — dispatch the run in a thread.
            try:
                add_log(
                    run_id,
                    "Queue drain claimed run; dispatching executor thread.",
                    level="info",
                    user_id=user_id,
                    repos=repos_obj,
                    trace_id=None,
                )
                dispatch_perf.mark("claim_log")
            except Exception as log_exc:
                logger.warning("Queue drain: failed to log claim for run %s: %s", run_id, log_exc)
                dispatch_perf.mark("claim_log_error")

            # The semaphore is released inside _run_thread_entry_with_semaphore.
            thread = threading.Thread(
                target=_run_thread_entry_with_semaphore,
                args=(run_id, worker_id, inputs, user_id, None, llm_slot),
                daemon=True,
                name=f"workeros-run-{run_id}",
            )
            dispatch_perf.mark("thread_object")
            active_run = _ActiveRun(run_id=run_id, worker_id=worker_id, user_id=user_id, thread=thread)
            _register_active_run(active_run)
            dispatch_perf.mark("register_active")
            try:
                thread.start()
                dispatch_perf.mark("thread_start")
            except Exception:
                _unregister_active_run(run_id)
                raise
            try:
                dispatch_perf.log(
                    lambda msg, level: add_log(
                        run_id,
                        msg,
                        level=level,
                        trace_id=None,
                        user_id=user_id,
                        repos=repos_obj,
                    ),
                    "queue.dispatch",
                )
            except Exception:
                logger.debug("Queue drain: failed to persist perf log for run %s", run_id, exc_info=True)
            logger.info("Queue drain: dispatched run %s for worker %s", run_id, worker_id)
        except Exception as exc:
            logger.warning("Queue drain: failed to dispatch run %s: %s", run_id, exc)
            _unregister_active_run(run_id)
            try:
                repos_obj.runs.update(
                    user_id=user_id,
                    run_id=run_id,
                    status=RunStatus.QUEUED.value,
                    started_at=None,
                )
            except Exception as rollback_exc:
                logger.warning(
                    "Queue drain: failed to restore queued status for %s: %s",
                    run_id,
                    rollback_exc,
                )
            _get_semaphore().release()
            if llm_slot:
                _get_llm_semaphore().release()


def start_drain_loop() -> None:
    """Start the background queue drain thread (idempotent)."""
    global _drain_thread
    if not execution_role_enabled():
        logger.info("Skipping queue drain loop start because WORKEROS_ROLE=%s", workeros_role())
        return
    with _drain_lock:
        if _drain_thread is not None and _drain_thread.is_alive():
            return
        _drain_stop.clear()
        _drain_thread = threading.Thread(
            target=_drain_loop,
            daemon=True,
            name="workeros-queue-drain",
        )
        _drain_thread.start()


def stop_drain_loop(timeout: float = 5.0) -> None:
    """Signal the drain loop to stop and wait for it to exit."""
    global _drain_thread
    _drain_stop.set()
    _wake_drain()
    with _drain_lock:
        t = _drain_thread
    if t is not None:
        t.join(timeout=timeout)


def _run_reaper_loop() -> None:
    """Background thread: periodically reconcile abandoned running rows."""
    interval = _run_reaper_interval_seconds()
    logger.info("Run reaper loop started (interval=%ss)", interval)
    while not _run_reaper_stop.wait(timeout=interval):
        try:
            # #1434: recover (reap + bounded auto-requeue) instead of a bare reap,
            # so a run orphaned by a restart is retried rather than hard-failed.
            recover_abandoned_runs()
        except Exception as exc:
            logger.warning("Run reaper sweep failed: %s", exc)


def start_run_reaper_loop() -> None:
    """Start the abandoned-run reaper thread (idempotent)."""
    global _run_reaper_thread
    if not execution_role_enabled():
        logger.info("Skipping run reaper loop start because WORKEROS_ROLE=%s", workeros_role())
        return
    with _run_reaper_lock:
        if _run_reaper_thread is not None and _run_reaper_thread.is_alive():
            return
        _run_reaper_stop.clear()
        _run_reaper_thread = threading.Thread(
            target=_run_reaper_loop,
            daemon=True,
            name="workeros-run-reaper",
        )
        _run_reaper_thread.start()


def stop_run_reaper_loop(timeout: float = 5.0) -> None:
    """Stop the abandoned-run reaper thread."""
    global _run_reaper_thread
    _run_reaper_stop.set()
    with _run_reaper_lock:
        t = _run_reaper_thread
    if t is not None:
        t.join(timeout=timeout)


def queued_run_position(run_id: str) -> int:
    """Return 1-based queue position of a queued run, or 0 if not found."""
    try:
        repos_obj = get_repositories()
        queued = repos_obj.runs.get_queued(limit=200)
        for i, row in enumerate(queued, start=1):
            if row["run_id"] == run_id:
                return i
    except Exception:
        pass
    return 0

def _cancel_active_runs(
    active: list[_ActiveRun],
    *,
    repos: Repositories,
    timeout_seconds: float,
    reason: str,
    mark_shutdown_cancelled: bool,
) -> list[str]:
    if mark_shutdown_cancelled:
        with _active_runs_lock:
            _shutdown_cancelled_runs.update(run.run_id for run in active)

    try:
        from runner_sandbox.e2b_driver import cancel_sandbox
    except Exception:
        cancel_sandbox = None

    cancelled_at = _now_iso()
    for run in active:
        if run.user_id:
            try:
                repos.runs.cancel(
                    user_id=run.user_id,
                    run_id=run.run_id,
                    cancelled_at=cancelled_at,
                )
                repos.runs.add_log(
                    user_id=run.user_id,
                    run_id=run.run_id,
                    level="error",
                    message=reason,
                    timestamp=cancelled_at,
                    trace_id=None,
                )
            except Exception as exc:
                logger.warning("Failed to mark run %s cancelled: %s", run.run_id, exc)
        if cancel_sandbox is not None:
            try:
                cancel_sandbox(run.run_id, reason=reason)
            except Exception:
                logger.debug("E2B cancel failed for run %s", run.run_id, exc_info=True)

    deadline = time.monotonic() + max(0.0, timeout_seconds)
    for run in active:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        run.thread.join(timeout=remaining)

    with _active_runs_lock:
        active_ids = {run.run_id for run in active}
        return [run_id for run_id in _active_runs if run_id in active_ids]


def _requeue_interrupted_run_in_place(
    repos_obj: Repositories, run_id: str, user_id: str | None
) -> bool:
    """#1434: on a graceful (SIGTERM) shutdown, set an interrupted run back to
    `queued` IN PLACE so the next process boot re-runs it, instead of leaving the
    user with a hard "interrupted by restart" failure.

    Called AFTER the run thread has been joined (race-free: this DB write is the
    final state). Bounded via trigger_source="restart_retry" so a run that keeps
    spanning deploys is retried at most once and cannot loop. user_id is the run
    owner (the raw runs row has no owner column - it lives on the workers join).
    """
    if not _auto_requeue_abandoned_enabled() or _max_restart_retries() <= 0:
        return False
    if not user_id:
        return False
    try:
        run = repos_obj.runs.get_any(run_id=run_id)
        if not run:
            return False
        if str(run.get("trigger_source") or "").startswith("restart_retry"):
            return False  # already a restart retry - do not loop across deploys
        repos_obj.runs.update(
            user_id=str(user_id),
            run_id=run_id,
            status=RunStatus.QUEUED.value,
            started_at=None,
            completed_at=None,
            error=None,
            error_code=None,
            trigger_source="restart_retry",
        )
        return True
    except Exception as exc:
        logger.warning("Failed to requeue interrupted run %s on shutdown: %s", run_id, exc)
        return False


def request_active_run_shutdown(
    *,
    repos: Repositories | None = None,
    timeout_seconds: float = 30.0,
) -> int:
    """Ask active worker threads to stop before the API process exits."""
    repos_obj = _repos(repos)
    with _active_runs_lock:
        active = list(_active_runs.values())
    if not active:
        return 0

    logger.warning("Shutdown requested; cancelling %d active run(s)", len(active))
    remaining_ids = _cancel_active_runs(
        active,
        repos=repos_obj,
        timeout_seconds=timeout_seconds,
        reason=INTERRUPTED_RUN_ERROR,
        mark_shutdown_cancelled=True,
    )
    if remaining_ids:
        logger.warning("Shutdown timed out waiting for active runs: %s", ", ".join(sorted(remaining_ids)))
    # #1434: requeue the runs we actually stopped (threads joined) so a deploy
    # does not kill them. Runs that did NOT stop in time (remaining_ids) are left
    # `running` and recovered by the next boot's startup recovery instead.
    requeued = 0
    for run in active:
        if run.run_id in remaining_ids:
            continue
        if _requeue_interrupted_run_in_place(repos_obj, run.run_id, run.user_id):
            requeued += 1
    if requeued:
        logger.warning("Requeued %d interrupted run(s) for retry after restart", requeued)
    return len(active)


def request_worker_run_shutdown(
    *,
    worker_id: str,
    user_id: str,
    repos: Repositories | None = None,
    timeout_seconds: float = 30.0,
) -> list[str]:
    repos_obj = _repos(repos)
    with _active_runs_lock:
        active = [
            run for run in _active_runs.values()
            if run.worker_id == worker_id and run.user_id == user_id
        ]
    if not active:
        return []

    logger.warning(
        "Worker deletion requested; cancelling %d active run(s) for %s",
        len(active),
        worker_id,
    )
    remaining_ids = _cancel_active_runs(
        active,
        repos=repos_obj,
        timeout_seconds=timeout_seconds,
        reason=WORKER_DELETED_RUN_ERROR,
        mark_shutdown_cancelled=False,
    )
    if remaining_ids:
        logger.warning(
            "Worker %s deletion timed out waiting for active runs: %s",
            worker_id,
            ", ".join(sorted(remaining_ids)),
        )
    return remaining_ids


def fail_interrupted_runs_on_startup(
    *,
    user_id: str,
    repos: Repositories | None = None,
) -> int:
    """Fail old runs left in-flight by a prior API process.

    Worker execution currently runs in process-local threads. A service restart
    terminates those threads, so a sufficiently old `running` row with no live
    active-run handle is abandoned.

    Runs in status=`queued` are NOT failed here — they are re-enqueued by
    re_enqueue_queued_runs_on_startup so they resume draining after boot.

    The user_id parameter is kept for compatibility with older callers; the
    reaper operates across owners because server restarts are process-wide.

    #1434: at process startup there is no live executor for ANY `running` row
    (the active-run registry is empty), so recover immediately (timeout=0,
    grace=0) rather than waiting out the timeout+grace window the periodic reaper
    uses to avoid racing live runs. recover_abandoned_runs also auto-requeues the
    orphaned runs within retry budget so a deploy does not silently kill them.
    Returns the count failed (for back-compat with callers that expect an int).
    """
    return recover_abandoned_runs(repos=repos, timeout_seconds=0, grace_seconds=0)["failed"]


_PENDING_APPROVAL_RESTART_ERROR = (
    "Run interrupted: server restarted while awaiting operator approval. "
    "Re-run the worker to restart."
)


def reap_abandoned_pending_approval_runs(
    *,
    repos: Repositories | None = None,
) -> int:
    """Fail all runs stuck in pending_approval on process startup.

    pending_approval runs have an in-process polling loop in agent_driver that
    dies when the server restarts. Unlike running runs (which use a
    timeout+grace window to avoid false positives), ALL pending_approval rows
    at boot are definitively abandoned — there is no live loop to resume them.

    Also rejects their pending approval records so they disappear from the
    Approvals UI immediately.
    """
    repos_obj = _repos(repos)
    now = datetime.now(timezone.utc).isoformat()
    failed = repos_obj.runs.fail_all_pending_approval(
        error=_PENDING_APPROVAL_RESTART_ERROR,
        error_code="approval_loop_killed",
    )
    for item in failed:
        run_id = str(item.get("run_id") or item.get("id") or "")
        user_id = str(item.get("user_id") or "")
        if not run_id or not user_id:
            continue
        try:
            repos_obj.approvals.reject(
                owner_id=user_id,
                run_id=run_id,
                decided_at=now,
                reason="Server restarted — approval polling loop killed",
            )
        except Exception as exc:
            logger.warning("Failed to reject approval for interrupted run %s: %s", run_id, exc)
        try:
            repos_obj.runs.add_log(
                user_id=user_id,
                run_id=run_id,
                level="error",
                message=_PENDING_APPROVAL_RESTART_ERROR,
                timestamp=now,
                trace_id=None,
            )
        except Exception as exc:
            logger.warning("Failed to add log for interrupted pending-approval run %s: %s", run_id, exc)
    if failed:
        logger.warning(
            "Reaped %d abandoned pending_approval run(s) on startup",
            len(failed),
        )
    return len(failed)


def re_enqueue_queued_runs_on_startup(
    *,
    repos: Repositories | None = None,
) -> int:
    """Wake the queue drain loop for runs left in status=queued by a prior process.

    Queued runs already have the right DB state; we just need to ensure the
    drain loop wakes and picks them up.  Returns the count of queued runs found.
    """
    repos_obj = _repos(repos)
    count = repos_obj.runs.count_queued()
    if count:
        logger.info("Found %d queued run(s) on startup — drain loop will pick them up", count)
        _wake_drain()
    return count


# Reserved engine-controlled approval-phase keys. These are ALWAYS set by the
# engine for an approvals.required worker and must never be trusted from inputs.
_APPROVAL_DECISION_KEY = "decision"
_APPROVAL_PHASE_KEY = "_workeros_approval_phase"
_APPROVAL_OUTPUT_KEY = "approved_output"
# How far we walk the retry_of_run_id chain when resolving the approval root.
# A bounded walk prevents a malformed/cyclic chain from looping forever.
_APPROVAL_RETRY_CHAIN_MAX = 20


def _is_engine_approved_execution_run(run_id: str, repos: Repositories) -> bool:
    """#418: authoritative test for "this run is the post-approval EXECUTE phase".

    A run is an approved-execution run iff an APPROVED approval row records it
    (or the root of its retry chain) as the ``follow_up_run_id``. Only
    ``approve_run`` ever writes ``follow_up_run_id``, so this signal cannot be
    spoofed by a caller-supplied ``decision`` input or ``trigger_source`` — both
    of which ARE caller-controllable on the public run-create endpoint.

    Walks the ``retry_of_run_id`` chain (bounded) so a retry descended from an
    approved follow-up run is still recognised as the execute phase; a retry of
    a PROPOSE-phase run is not.
    """
    seen: set[str] = set()
    current = run_id
    for _ in range(_APPROVAL_RETRY_CHAIN_MAX):
        if not current or current in seen:
            break
        seen.add(current)
        try:
            approval = repos.approvals.get_by_follow_up_run_id(follow_up_run_id=current)
        except Exception:
            logger.exception("approval follow-up lookup failed for run %s", current)
            approval = None
        if approval and approval.get("status") == "approved":
            return True
        run_row = repos.runs.get_any(run_id=current)
        parent = (run_row or {}).get("retry_of_run_id")
        if not parent:
            break
        current = str(parent)
    return False


def _apply_approval_phase_inputs(
    effective_inputs: Dict[str, Any],
    run_id: str,
    config: Optional[WorkerConfig],
    repos: Repositories,
) -> Dict[str, Any]:
    """#418: for an ``approvals.required`` worker, stamp the run's approval phase
    onto the inputs the worker sees — authoritatively, BEFORE execution.

    - PROPOSE phase (every run that is NOT an engine-approved execution run):
      force ``decision = "proposed"`` and strip any caller-supplied
      ``approved_output`` so a worker cannot be tricked into acting. This is what
      makes the two-phase contract a HARD engine guarantee instead of relying on
      the absence of a key.
    - EXECUTE phase (the engine-spawned follow-up run for an approved decision):
      force ``decision = "approved"``. ``approved_output`` was already merged in
      by ``approve_run``.

    Non-approval workers are returned unchanged (no injection).
    """
    needs_approval = bool(
        config and getattr(config, "approvals", None) and config.approvals.required
    )
    if not needs_approval:
        return effective_inputs

    out = dict(effective_inputs)
    if _is_engine_approved_execution_run(run_id, repos):
        out[_APPROVAL_DECISION_KEY] = "approved"
        out[_APPROVAL_PHASE_KEY] = "execute"
    else:
        out[_APPROVAL_DECISION_KEY] = "proposed"
        out[_APPROVAL_PHASE_KEY] = "propose"
        out.pop(_APPROVAL_OUTPUT_KEY, None)
    return out


def execute_run(
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    perf = _RunPerfTimer()
    _mark_active_run_stage(run_id, "execute_start")
    repos_obj = _repos(repos)
    perf.mark("repos")
    owner_id = user_id or _worker_owner_id(worker_id, repos_obj)
    perf.mark("owner")
    trace_id = f"trace_{uuid.uuid4().hex[:16]}"
    loaded = _load_worker_recipe(worker_id, repos_obj)
    perf.mark("load_recipe")
    config = loaded[1] if loaded else None
    instance = loaded[2] if loaded else None
    effective_inputs = _apply_config_input_defaults(
        config,
        _merge_instance_inputs(instance, inputs),
    )
    perf.mark("merge_inputs")
    # #418: stamp the authoritative approval phase onto the inputs BEFORE the
    # worker runs, so an approvals.required worker can never fire a side effect
    # in the propose phase (and a caller cannot spoof approval via inputs).
    effective_inputs = _apply_approval_phase_inputs(
        effective_inputs, run_id, config, repos_obj
    )
    perf.mark("approval_inputs")
    run_secrets = get_secrets_for_worker(worker_id, user_id=owner_id, repos=repos_obj)
    perf.mark("secrets")

    def log_fn(msg: str, level: str = "info") -> None:
        safe_msg = scrub_secrets(msg, run_secrets)
        add_log(
            run_id,
            safe_msg,
            level=level,
            trace_id=trace_id,
            user_id=owner_id,
            repos=repos_obj,
        )

    try:
        current_run = repos_obj.runs.get_any(run_id=run_id)
        perf.mark("status_fetch")
        current_status = (current_run or {}).get("status")
        if current_status in {
            RunStatus.COMPLETED.value,
            RunStatus.FAILED.value,
            RunStatus.CANCELLED.value,
            RunStatus.PENDING_APPROVAL.value,
        }:
            logger.warning(
                "Run %s executor entered after terminal/non-running status %s; skipping",
                run_id,
                current_status,
            )
            return
        if current_status != RunStatus.RUNNING.value:
            update_run_status(run_id, RunStatus.RUNNING.value, user_id=owner_id, repos=repos_obj)
            perf.mark("status_update")
        log_fn("Run started")
        perf.mark("run_started_log")
        log_fn("Validating inputs", level="debug")
        perf.mark("validating_log")

        if not config:
            err = "Worker config not found"
            update_run_status(run_id, RunStatus.FAILED.value, error=err, error_code="invalid_worker", user_id=owner_id, repos=repos_obj)
            publish_run_part(run_id, {"type": "finish", "status": "failed", "error": err})
            log_fn(err, level="error")
            return

        if instance and not instance.get("enabled", True):
            err = "Worker is disabled"
            update_run_status(run_id, RunStatus.FAILED.value, error=err, error_code="worker_disabled", user_id=owner_id, repos=repos_obj)
            publish_run_part(run_id, {"type": "finish", "status": "failed", "error": err})
            log_fn(err, level="error")
            return

        # Validate required inputs
        for inp in config.inputs:
            if inp.required and (inp.name not in effective_inputs or effective_inputs[inp.name] in (None, "")):
                err = f"Missing required input: {inp.name}"
                update_run_status(run_id, RunStatus.FAILED.value, error=err, error_code="missing_required_input", user_id=owner_id, repos=repos_obj)
                publish_run_part(run_id, {"type": "finish", "status": "failed", "error": err})
                log_fn(err, level="error")
                return
        perf.mark("validate_inputs")

        log_fn("Loading secrets", level="debug")
        perf.mark("loading_secrets_log")
        secrets = run_secrets
        missing = [s for s in config.secrets if s not in secrets]
        if missing:
            err = f"Missing secrets: {', '.join(missing)}"
            update_run_status(run_id, RunStatus.FAILED.value, error=err, error_code="missing_secret", user_id=owner_id, repos=repos_obj)
            publish_run_part(run_id, {"type": "finish", "status": "failed", "error": err})
            log_fn(err, level="error")
            if _maybe_pause_scheduled_worker_after_setup_failure(
                worker_id=worker_id,
                run_id=run_id,
                user_id=owner_id,
                error_code="missing_secret",
                repos=repos_obj,
            ):
                log_fn(
                    "Paused scheduled worker after repeated missing-secret setup failures",
                    level="warning",
                )
            return
        perf.mark("check_secrets")

        # Resolve Composio connections declared in worker.yml.
        connection_ids: Dict[str, str] = {}
        if config.connections:
            log_fn("Resolving connections", level="debug")
            from runner_utils import _resolve_connections
            connection_ids, conn_err = _resolve_connections(worker_id, log_fn, config, user_id=owner_id)
            perf.mark("resolve_connections")
            if conn_err:
                update_run_status(run_id, RunStatus.FAILED.value, error=conn_err, error_code="missing_connection", user_id=owner_id, repos=repos_obj)
                publish_run_part(run_id, {"type": "finish", "status": "failed", "error": conn_err})
                log_fn(conn_err, level="error")
                return
        else:
            perf.mark("resolve_connections_skip")

        # Re-materialize worker files from DB if the dir is missing or empty
        # (empty dir can occur if a previous re-materialization was interrupted).
        try:
            _wdir = WORKERS_DIR / worker_id
            if not _wdir.is_dir() or not any(_wdir.iterdir()):
                import main as _main
                if _main.rematerialize_worker_from_db(worker_id):
                    log_fn("Re-materialized worker files from DB", level="info")
            perf.mark("rematerialize_check")
        except Exception as _rmat_exc:
            logger.warning("Worker re-materialization failed for %s: %s", worker_id, _rmat_exc)
            perf.mark("rematerialize_error")

        _snapshot_worker_bundle_background(run_id, worker_id, config, owner_id=owner_id)
        perf.mark("bundle_snapshot_dispatch")

        # Dispatch to the appropriate sandbox driver based on worker config.
        # #603: default to "e2b" — "local" (in-process) runner was removed in
        # the security audit; all workers run inside E2B sandboxes.
        runner = "e2b"
        if config and config.runtime:
            runner = config.runtime.runner or "e2b"
        mode = config.runtime.mode if config and config.runtime else "pure-script"
        # #1127/#1314: resolve effective timeout — workspace default_timeout_seconds
        # can raise the ceiling up to MAX_RUN_TIMEOUT_SECONDS (3600 s = 1 hour).
        timeout_seconds = _resolved_worker_timeout_seconds(config)
        perf.mark("resolve_timeout")
        log_fn(f"Executing worker (mode={mode}, runner={runner})", level="debug")
        perf.mark("executing_log")
        _mark_active_run_stage(run_id, "pre_sandbox")
        latest_run = repos_obj.runs.get_any(run_id=run_id)
        perf.mark("pre_sandbox_status_fetch")
        if (latest_run or {}).get("status") != RunStatus.RUNNING.value:
            logger.warning(
                "Run %s left running before sandbox dispatch (status=%s); skipping stale executor",
                run_id,
                (latest_run or {}).get("status"),
            )
            return
        driver = get_sandbox_driver(runner, config=config)
        perf.mark("driver_lookup")
        perf.log(log_fn, "run_service.pre_sandbox")
        _mark_active_run_stage(run_id, "driver_run")
        with use_context_scope(context_scope_for_user(owner_id)):
            result = driver.run(
                worker_id=worker_id,
                run_id=run_id,
                inputs=effective_inputs,
                secrets=secrets,
                log_fn=log_fn,
                trace_id=trace_id,
                timeout_seconds=timeout_seconds,
                config=config,
                connection_ids=connection_ids,
                user_id=owner_id,
            )

        if was_shutdown_cancelled(run_id):
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error=INTERRUPTED_RUN_ERROR,
                error_code=INTERRUPTED_RUN_ERROR_CODE,
                user_id=owner_id,
                repos=repos_obj,
            )
            publish_run_part(
                run_id,
                {"type": "finish", "status": "failed", "error": INTERRUPTED_RUN_ERROR},
            )
            log_fn(INTERRUPTED_RUN_ERROR, level="error")
            return

        # #607: E2B driver returns status="cancelled" when the sandbox was killed
        # by a user cancel (cancel_requested flag set). Mark the run cancelled and
        # emit a finish event — do NOT fall through to schema validation or
        # completion logic.
        if result.status == "cancelled":
            update_run_status(
                run_id,
                "cancelled",
                error=result.error or "Cancelled by user",
                error_code=result.error_code or "user_cancel",
                user_id=owner_id,
                repos=repos_obj,
            )
            publish_run_part(
                run_id,
                {"type": "finish", "status": "cancelled"},
            )
            log_fn("Run cancelled by user", level="info")
            return

        outputs = result.outputs
        artifacts = result.artifacts
        _materialize_declared_file_outputs(run_id, config, outputs, artifacts)
        _store_run_artifacts(run_id, artifacts, log_fn, user_id=owner_id, repos=repos_obj)

        # #595: approvals.required auto-gate.
        # Previously, `approvals.required: true` in the manifest only worked if
        # run.py also explicitly emitted a `decision_required` event. Workers
        # that declared the flag but omitted the event would silently complete,
        # making the manifest flag a no-op.
        #
        # Fix: synthesise a decision_required payload from the run outputs when
        # the manifest declares approvals.required but run.py didn't emit one.
        # This makes the manifest flag sufficient for simple "always pause before
        # completing" use cases without requiring boilerplate in every run.py.
        worker_needs_approval = bool(
            config and getattr(config, "approvals", None) and config.approvals.required
        )
        # #418: an EXECUTE-phase run (the engine-spawned post-approval follow-up,
        # or a retry of it) must NEVER re-gate — it is the authorised execution.
        # Resolve this authoritatively from the approvals table (follow_up_run_id),
        # NOT the caller-controllable trigger_source, which could be spoofed to
        # suppress the gate on a fresh run.
        approval_follow_up = (
            worker_needs_approval
            and _is_engine_approved_execution_run(run_id, repos_obj)
        )
        _non_approval_terminal = {"error", "failed", "cancelled", "timeout", "rejected"}
        if (
            worker_needs_approval
            and not approval_follow_up
            and not result.decision_required
            and result.status not in _non_approval_terminal
        ):
            approval_label = (
                config.approvals.label
                if config and config.approvals and config.approvals.label
                else "Approve to complete"
            )
            result.decision_required = {
                "label": approval_label,
                "preview": json.dumps(result.outputs, indent=2)[:2000] if result.outputs else "",
            }
            log_fn(
                "approvals.required: synthesising approval gate from manifest "
                "(run.py did not emit decision_required). Add an explicit "
                "decision_required event to customise the label and preview.",
                level="info",
            )

        # Both "error" and "failed" terminal statuses map to a failed run
        if result.status in ("error", "failed"):
            result_error = result.error
            result_error_code = result.error_code
            if was_shutdown_cancelled(run_id):
                result_error = INTERRUPTED_RUN_ERROR
                result_error_code = INTERRUPTED_RUN_ERROR_CODE
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error=result_error,
                error_code=result_error_code,
                user_id=owner_id,
                repos=repos_obj,
            )
            finish_status = "timeout" if (result.error_code or "").lower().find("timeout") >= 0 else "failed"
            publish_run_part(
                run_id,
                {"type": "finish", "status": finish_status, "error": result_error or "Run failed"},
            )
            # G5 P1-A: the "Recent logs" panel renders this line verbatim, so it
            # must match the calm Error card — never the raw exception/path. Run
            # the error through the SAME operator-headline path used for the
            # Error card before logging.
            _log_failure_line = f"Run failed: {result_error}"
            try:
                import main as _main

                _calm = _main._operator_error_message(result_error, result_error_code)
                if _calm:
                    _log_failure_line = f"Run failed: {_calm}"
            except Exception:
                _log_failure_line = "Run failed."
            log_fn(_log_failure_line, level="error")

            _schedule_retry_for_failed_run(
                run_id=run_id,
                worker_id=worker_id,
                inputs=effective_inputs,
                owner_id=owner_id,
                config=config,
                result_retryable=bool(getattr(result, "retryable", False)),
                result_error_code=result_error_code,
                repos=repos_obj,
                log_fn=log_fn,
            )
            return

        # S47 HITL: if the worker emitted decision_required AND the worker declares
        # approvals.required, land this run as PENDING_APPROVAL and create an
        # approvals row.  Do NOT mark COMPLETED — execution halts here.
        decision_required = result.decision_required
        worker_needs_approval = bool(config and getattr(config, "approvals", None) and config.approvals.required)
        # #418: never re-gate the execute-phase run. If a (misbehaving) worker
        # emits decision_required again AFTER approval, ignore it — re-gating
        # would spawn a second approval + follow-up and fire the side effect
        # twice. The execute run is already authorised; let it complete once.
        if decision_required and worker_needs_approval and not approval_follow_up and result.status not in _non_approval_terminal:
            approval_id = f"apr_{uuid.uuid4().hex[:12]}"
            label = decision_required.get("label") or (config.approvals.label if config and config.approvals else "Approve action")
            preview = decision_required.get("preview") or ""
            # #418: persist the ORIGINAL inputs (without the engine-injected
            # propose-phase markers) so approve_run rebuilds clean execute-phase
            # inputs; the execute run re-derives its phase authoritatively.
            _original_inputs = {
                k: v for k, v in effective_inputs.items()
                if k not in (_APPROVAL_DECISION_KEY, _APPROVAL_PHASE_KEY)
            }
            decision_input_json = json.dumps(_original_inputs)
            now_ts = _now_iso()
            # #798: pending approvals auto-expire after APPROVAL_TTL_HOURS (24h
            # default) so a run never sits pending forever. #792: a worker may
            # declare a typed preview (email/records/tasks) for a rich render.
            try:
                _ttl_hours = float(os.environ.get("APPROVAL_TTL_HOURS", "24") or "24")
            except ValueError:
                _ttl_hours = 24.0
            from datetime import datetime as _dt, timedelta as _td, timezone as _tz
            expires_at = (_dt.now(_tz.utc) + _td(hours=_ttl_hours)).isoformat()
            preview_type = decision_required.get("preview_type") or decision_required.get("type")
            preview_payload = decision_required.get("preview_payload")
            preview_payload_json = json.dumps(preview_payload) if isinstance(preview_payload, (dict, list)) else None
            # #795: snapshot the run's cost-so-far onto the approval so the
            # Run tab renders "1.2k tok · $0.01" without a separate run fetch.
            # Best-effort estimate from whatever the transcript has at pause.
            try:
                from cost import estimate_cost_usd, total_tokens_from_transcript

                _tokens_so_far = total_tokens_from_transcript(run_id)
                _cost_so_far = estimate_cost_usd(_tokens_so_far)
            except Exception:
                _tokens_so_far, _cost_so_far = None, None
            try:
                repos_obj.approvals.create(
                    owner_id=owner_id,
                    id=approval_id,
                    run_id=run_id,
                    worker_id=worker_id,
                    status="pending",
                    label=label,
                    preview=preview,
                    created_at=now_ts,
                    expires_at=expires_at,
                    preview_type=(str(preview_type) if preview_type else None),
                    preview_payload_json=preview_payload_json,
                    decision_input_json=decision_input_json,
                    tokens_so_far=_tokens_so_far,
                    cost_usd_so_far=_cost_so_far,
                )
            except Exception as exc:
                logger.error("Failed to create approval row for run %s: %s", run_id, exc)
            # Store the proposed outputs on the run so the approval page can show
            # them. Persist via the repo directly (not update_run_status) so we
            # emit exactly ONE pending_approval status SSE event below — the
            # richer one carrying approval_id + label. Calling update_run_status
            # here would publish a second, leaner status event (duplicate).
            safe_outputs = _scrub_run_output(
                outputs,
                worker_id=worker_id,
                owner_id=owner_id,
                repos=repos_obj,
            )
            repos_obj.runs.update_status(
                user_id=owner_id,
                run_id=run_id,
                status=RunStatus.PENDING_APPROVAL.value,
                output_json=safe_outputs,
            )
            _publish_sse(run_id, {
                "type": "status",
                "run_id": run_id,
                "status": RunStatus.PENDING_APPROVAL.value,
                "approval_id": approval_id,
                "label": label,
            })
            publish_run_part(run_id, {"type": "finish", "status": "pending_approval"})
            # PostHog: run paused awaiting approval (single emit point). No-op
            # when analytics is disabled; never raises.
            _emit_approval_requested(
                approval_id=approval_id,
                run_id=run_id,
                worker_id=worker_id,
                owner_id=owner_id,
                tool_name=decision_required.get("tool_name") or decision_required.get("tool"),
                risk_level=decision_required.get("risk_level") or decision_required.get("risk"),
            )
            log_fn(f"Run awaiting approval: {label}")
            # Fan-out: notify the run owner over WhatsApp if they have an active binding.
            try:
                from channels.common import notify_pending_approval_via_whatsapp
                _worker_name_for_notify = worker_id
                try:
                    _w_row = repos_obj.workers.get_any(worker_id=worker_id)
                    _worker_name_for_notify = (_w_row or {}).get("name") or worker_id
                except Exception:
                    pass
                notify_pending_approval_via_whatsapp(
                    owner_id=owner_id,
                    run_id=run_id,
                    worker_name=_worker_name_for_notify,
                    label=label,
                    approval_id=approval_id,
                )
            except Exception:
                logger.warning("WhatsApp approval notify failed for run %s", run_id, exc_info=True)
            # Fan-out: notify the run owner over Slack if they have an active binding.
            try:
                from channels.common import notify_pending_approval_via_slack
                notify_pending_approval_via_slack(
                    owner_id=owner_id,
                    run_id=run_id,
                    worker_name=_worker_name_for_notify,
                    label=label,
                    approval_id=approval_id,
                )
            except Exception:
                logger.warning("Slack approval notify failed for run %s", run_id, exc_info=True)
            return

        # Output-schema enforcement — the SINGLE convergence point for ALL
        # three drivers (Agent / Skill / E2B script). Previously only the Agent
        # and Skill drivers called _validate_output_schema internally; the E2B
        # script driver (.py/.sh/.js — the common case) skipped it entirely, so
        # declared output `type` (json/csv/markdown/text), CSV `columns`, and
        # `json_required_keys` were silently unenforced (maintainer's P0). Validating
        # here, on the path every driver flows through, makes the contract
        # enforcement DRY and uniform. A hard type/column/key mismatch FAILS the
        # run (the whole point) rather than surfacing garbage as COMPLETED.
        schema_error = _validate_output_schema(worker_id, outputs, log_fn, config=config)
        if schema_error:
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error=f"Output schema violation: {schema_error}",
                error_code="schema_violation",
                user_id=owner_id,
                repos=repos_obj,
            )
            publish_run_part(
                run_id,
                {"type": "finish", "status": "failed", "error": f"Output schema violation: {schema_error}"},
            )
            log_fn(f"Output schema violation: {schema_error}", level="error")
            return

        quality_error, quality_warnings = _validate_run_outputs(run_id, config, outputs, artifacts)
        if quality_error:
            update_run_status(run_id, RunStatus.FAILED.value, error=quality_error, error_code="quality_gate_failed", user_id=owner_id, repos=repos_obj)
            publish_run_part(run_id, {"type": "finish", "status": "failed", "error": quality_error})
            log_fn(quality_error, level="error")
            return

        # Wedge fix (2026-05-29): the prompt-to-worker flow runs the
        # worker-author meta-worker, which drafts a bundle.json but cannot
        # register a worker from inside its sandbox. Register it here, on the
        # backend, the moment the author run completes — using the SAME
        # registration path /workers/draft-and-create uses — so the operator
        # gets a REAL, editable, runnable worker instead of a dead-end bundle.
        # The new worker id is stored on the run output AND broadcast via SSE
        # so /workers/new can navigate to /workers/<id>?edit=1.
        if worker_id == _WORKER_AUTHOR_WORKER_ID or (
            isinstance(outputs, dict) and "bundle" in outputs
        ):
            log_fn(
                "worker-author registration gate: "
                f"worker_id={worker_id!r} expected={_WORKER_AUTHOR_WORKER_ID!r} "
                f"outputs_keys={sorted(outputs.keys()) if isinstance(outputs, dict) else type(outputs).__name__} "
                f"artifact_count={len(artifacts or [])}",
                level="debug",
            )
        if worker_id == _WORKER_AUTHOR_WORKER_ID:
            try:
                created_worker_id = _register_authored_worker(
                    run_id,
                    outputs,
                    artifacts,
                    user_id=owner_id,
                    repos=repos_obj,
                    log_fn=log_fn,
                )
                if created_worker_id:
                    # Persist on the run output so a client that reconnects to an
                    # already-terminal run can still read the new worker id from
                    # GET /runs/{id}.output.created_worker_id (the minimal
                    # already-terminal SSE event does not carry custom fields).
                    outputs = dict(outputs or {})
                    outputs["created_worker_id"] = created_worker_id

                    # Wedge safety net: prove the generated SCRIPT-mode worker
                    # actually RUNS (and bounded-repair it if not) before telling
                    # the operator it is ready. Inline on this run's execution
                    # slot — no extra concurrency. Never fails the author run.
                    try:
                        smoke_bundle = _read_authored_bundle(run_id, artifacts)
                        smoke = smoke_and_gate_generated_worker(
                            created_worker_id,
                            smoke_bundle or {},
                            user_id=owner_id,
                            repos=repos_obj,
                            log_fn=log_fn,
                        )
                        outputs["smoke"] = smoke
                    except Exception as smoke_exc:
                        logger.exception(
                            "Smoke check failed for generated worker %s", created_worker_id
                        )
                        log_fn(
                            f"Could not smoke-test the generated worker: {smoke_exc}",
                            level="warning",
                        )
                else:
                    # Registration failed (see run logs for gate that fired).
                    # Store flag so the create-flow frontend can show an error
                    # instead of the misleading "Worker drafted" fallback.
                    outputs = dict(outputs or {})
                    outputs["worker_creation_failed"] = True
            except Exception as exc:
                # Never fail the run on registration trouble — the bundle is
                # still viewable. Log so the operator/engineer can see why.
                logger.exception("worker-author registration failed for run %s", run_id)
                log_fn(f"Could not auto-register the drafted worker: {exc}", level="warning")
                outputs = dict(outputs or {})
                outputs["worker_creation_failed"] = True

        update_run_status(run_id, RunStatus.COMPLETED.value, output=outputs, user_id=owner_id, repos=repos_obj)

        # Feature #1386: fan-out a worker-created card to the owner's channel
        # bindings (Slack Block Kit DM + WhatsApp formatted message) when the
        # worker-author run completes with a real created_worker_id.
        if worker_id == _WORKER_AUTHOR_WORKER_ID and isinstance(outputs, dict) and outputs.get("created_worker_id"):
            _new_worker_id = str(outputs["created_worker_id"])
            try:
                _nw_row = repos_obj.workers.get_any(worker_id=_new_worker_id)
                _new_worker_name = (_nw_row or {}).get("name") or _new_worker_id
            except Exception:
                _new_worker_name = _new_worker_id
            try:
                from channels.common import notify_worker_created_via_slack, notify_worker_created_via_whatsapp
                notify_worker_created_via_slack(
                    owner_id=owner_id,
                    worker_id=_new_worker_id,
                    worker_name=_new_worker_name,
                )
            except Exception:
                logger.warning("Slack worker-created card failed for run %s", run_id, exc_info=True)
            try:
                from channels.common import notify_worker_created_via_whatsapp
                notify_worker_created_via_whatsapp(
                    owner_id=owner_id,
                    worker_id=_new_worker_id,
                    worker_name=_new_worker_name,
                )
            except Exception:
                logger.warning("WhatsApp worker-created message failed for run %s", run_id, exc_info=True)

        # Broadcast the new worker id on the live stream so the create flow can
        # navigate straight to the editor without a follow-up fetch.
        if worker_id == _WORKER_AUTHOR_WORKER_ID and isinstance(outputs, dict) and outputs.get("created_worker_id"):
            _smoke_event = outputs.get("smoke") if isinstance(outputs.get("smoke"), dict) else None
            _sse_event = {
                "type": "status",
                "run_id": run_id,
                "status": RunStatus.COMPLETED.value,
                "created_worker_id": outputs["created_worker_id"],
            }
            if _smoke_event:
                # Surface the smoke verdict so the create flow can tell the
                # operator "generated, but its first test run failed: <reason>"
                # instead of presenting a gated worker as ready.
                _sse_event["smoke_status"] = _smoke_event.get("status")
                # G5 P1-A: the smoke reason can carry a sandbox path
                # (/home/user/worker/run.py) or a bare Python exception. Route
                # it through the operator-headline/redaction path before it
                # leaves the backend on the SSE stream.
                try:
                    import main as _main

                    _sse_event["smoke_reason"] = _main.humanize_smoke_reason(
                        _smoke_event.get("reason")
                    )
                except Exception:
                    _sse_event["smoke_reason"] = None
            _publish_sse(run_id, _sse_event)
        if quality_warnings and owner_id:
            repos_obj.runs.update(
                user_id=owner_id,
                run_id=run_id,
                quality_warning="; ".join(quality_warnings),
            )
            log_fn(f"Quality warning: {'; '.join(quality_warnings)}", level="warning")
        publish_run_part(run_id, {"type": "finish", "status": "completed"})
        log_fn("Output generated")
        log_fn("Run completed")

    except Exception as exc:
        logger.exception("Run %s crashed for worker %s", run_id, worker_id)
        error_message = str(exc) or exc.__class__.__name__
        # PostHog Error Tracking (Track A §A4): capture the real exception with
        # type + stack trace so crashes group into debuggable issues, beyond the
        # flat run_failed.error_category label. No-op + never raises when
        # analytics is disabled. Stack text carries no prompt/completion bodies.
        _emit_run_exception(
            exc=exc,
            run_id=run_id,
            worker_id=worker_id,
            owner_id=owner_id,
            trace_id=trace_id,
            error_code="run_execution_exception",
        )
        try:
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error=error_message,
                error_code="run_execution_exception",
                user_id=owner_id,
                repos=repos_obj,
            )
        except Exception:
            logger.exception("Failed to mark run %s as failed after crash", run_id)
        try:
            publish_run_part(
                run_id,
                {"type": "finish", "status": "failed", "error": error_message},
            )
        except Exception:
            logger.exception("Failed to publish crash event for run %s", run_id)
        try:
            log_fn(f"Run crashed: {error_message}", level="error")
        except Exception:
            logger.exception("Failed to persist crash log for run %s", run_id)
        return


def start_run(
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    """Enqueue a run for execution.

    The run row already has status=queued (set by create_run).  We wake the
    drain loop which will acquire an execution semaphore slot and dispatch the
    run as soon as capacity is available.  This call is always instant.
    """
    _wake_drain()


def _run_thread_entry(
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    try:
        execute_run(run_id, worker_id, inputs, user_id=user_id, repos=repos)
    finally:
        _unregister_active_run(run_id)


def _run_thread_entry_with_semaphore(
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    user_id: str | None = None,
    repos: Repositories | None = None,
    llm_slot: bool = False,
) -> None:
    """Thread entry point used by the drain loop.

    The semaphore is already acquired before this thread is created.  We
    release it in the finally block so the next queued run can be dispatched.
    #1448: llm_slot is True when this run also holds an LLM-budget slot
    (llm-intensive worker); it is released alongside the main slot.
    """
    perf = _RunPerfTimer()
    try:
        _mark_active_run_stage(run_id, "thread_entry")
        try:
            add_log(
                run_id,
                "Executor thread entered; preparing run context.",
                level="debug",
                user_id=user_id,
                repos=repos,
            )
            perf.mark("thread_entry_log")
        except Exception:
            logger.debug("Failed to persist executor entry log for run %s", run_id, exc_info=True)
            perf.mark("thread_entry_log_error")
        # #1026: re-establish the run's tenant/workspace scope on this thread
        # (no-op in single-tenant OSS; cloud reconstructs it from the run row).
        with _run_execution_context(run_id):
            _mark_active_run_stage(run_id, "context_entered")
            perf.mark("context_entered")
            # Check for pre-dispatch cancellation (cancelled while queued).
            repos_obj = _repos(repos)
            run_row = repos_obj.runs.get_any(run_id=run_id)
            perf.mark("cancel_status_fetch")
            if run_row and run_row.get("cancel_requested"):
                owner_id = user_id or run_row.get("user_id")
                cancelled_at = _now_iso()
                cancel_error = "Run was cancelled before execution started."
                logger.info("Run %s cancelled before dispatch — skipping execution", run_id)
                try:
                    update_run_status(
                        run_id,
                        RunStatus.FAILED.value,
                        error=cancel_error,
                        error_code="cancelled_before_start",
                        user_id=owner_id,
                        repos=repos_obj,
                    )
                    _publish_sse(run_id, {
                        "type": "status",
                        "run_id": run_id,
                        "status": RunStatus.FAILED.value,
                        "error": cancel_error,
                    })
                except Exception as exc:
                    logger.warning("Failed to mark pre-dispatch cancellation for run %s: %s", run_id, exc)
                return
            try:
                owner_id = user_id or (run_row or {}).get("user_id")
                perf.log(
                    lambda msg, level: add_log(
                        run_id,
                        msg,
                        level=level,
                        user_id=owner_id,
                        repos=repos_obj,
                    ),
                    "queue.thread_startup",
                )
            except Exception:
                logger.debug("Failed to persist executor startup perf log for run %s", run_id, exc_info=True)
            execute_run(run_id, worker_id, inputs, user_id=user_id, repos=repos)
    except Exception as exc:
        logger.exception("Executor thread crashed before completing dispatch for run %s", run_id)
        try:
            repos_obj = _repos(repos)
            row = repos_obj.runs.get_any(run_id=run_id)
            owner_id = user_id or (row or {}).get("user_id")
            message = (
                "Executor thread crashed before sandbox startup: "
                f"{exc.__class__.__name__}"
            )
            if owner_id and (row or {}).get("status") == RunStatus.RUNNING.value:
                repos_obj.runs.add_log(
                    user_id=str(owner_id),
                    run_id=run_id,
                    level="error",
                    message=message,
                    timestamp=_now_iso(),
                    trace_id=None,
                )
                repos_obj.runs.update_status(
                    user_id=str(owner_id),
                    run_id=run_id,
                    status=RunStatus.FAILED.value,
                    error=message,
                    error_code="executor_thread_pre_sandbox_exception",
                )
                trigger_source = str((row or {}).get("trigger_source") or "")
                if _auto_requeue_abandoned_enabled() and _max_restart_retries() > 0 and not trigger_source.startswith("restart_retry"):
                    _schedule_retry(
                        original_run_id=run_id,
                        worker_id=worker_id,
                        inputs=inputs if isinstance(inputs, dict) else {},
                        attempt=int((row or {}).get("retry_attempt") or 0) + 1,
                        delay_seconds=0,
                        user_id=str(owner_id),
                        repos=repos_obj,
                        trigger_source="restart_retry",
                    )
                    _wake_drain()
        except Exception:
            logger.exception("Failed to persist executor-thread crash for run %s", run_id)
    finally:
        _unregister_active_run(run_id)
        _get_semaphore().release()
        if llm_slot:
            # #1448: free the LLM-budget slot so a deferred llm-intensive run can run.
            _get_llm_semaphore().release()
        # Wake the drain loop so the next queued run can fill the freed slot.
        _wake_drain()
