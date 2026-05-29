"""Run orchestration service with structured logging, observability, and secret scrubbing."""

import os
import uuid
import json
import threading
import re
import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Any, Callable, Optional
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Concurrency gate — E2B has a hard cap of 20 concurrent sandboxes.
# We cap at WORKEROS_MAX_CONCURRENT_RUNS (default 18) to leave headroom for
# the workspace-agent /chat lane and manual smokes.
# ---------------------------------------------------------------------------

def _max_concurrent_runs() -> int:
    try:
        return max(1, int(os.environ.get("WORKEROS_MAX_CONCURRENT_RUNS", "18")))
    except ValueError:
        return 18

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

from dotenv import load_dotenv

from contexts import context_scope_for_user, use_context_scope
from db.factory import Repositories, get_repositories
from runner_utils import ARTIFACTS_DIR
from worker_registry import WORKERS_DIR, get_worker_config
from runner_sandbox import get_driver as get_sandbox_driver
from models import (
    WorkerConfig,
    RunStatus,
)

logger = logging.getLogger("floom.run_service")

API_ENV_PATH = Path("/root/.config/workeros/api.env")
LOCAL_ENV_PATH = Path(__file__).resolve().parent / ".env"
MIN_OUTPUT_BYTES = int(os.environ.get("WORKEROS_MIN_OUTPUT_BYTES", "100"))
_PLACEHOLDER_MARKERS = (
    "i don't have access",
    "i cannot fetch",
    "i can't fetch",
    "please provide an api key",
    "placeholder",
)
_PATH_VALUE_RE = re.compile(r"^(?:\.?/)?(?:out|outputs|output|artifacts|inputs)/[A-Za-z0-9._/@ -]+$")


class InsufficientDiskSpaceError(RuntimeError):
    """Raised when the API refuses run creation because local disk is too full."""


def _minimum_free_disk_bytes() -> int:
    raw = os.environ.get("WORKEROS_MIN_FREE_DISK_BYTES", str(1024 * 1024 * 1024))
    try:
        return max(0, int(raw))
    except ValueError:
        return 1024 * 1024 * 1024


# The meta-worker whose completed runs auto-register the worker they drafted.
# Mirrors main._WORKER_AUTHOR_ID (asserted equal in tests).
_WORKER_AUTHOR_WORKER_ID = "worker-author"


def _find_bundle_artifact(run_id: str, artifacts: list[Dict[str, Any]]) -> Optional[Path]:
    """Locate the worker-author bundle.json on local disk.

    The E2B driver downloads ``out/bundle.json`` into
    ``ARTIFACTS_DIR/<run_id>/out/bundle.json`` and records the artifact with
    ``relative_path == "out/bundle.json"`` and an absolute ``path``. Fall back
    to the conventional location if the artifact list is unexpectedly empty.
    """
    for art in artifacts or []:
        rel = str(art.get("relative_path") or "")
        name = str(art.get("name") or "")
        if rel == "out/bundle.json" or name == "bundle.json" or rel.endswith("/bundle.json"):
            candidate = art.get("path")
            if candidate and Path(candidate).is_file():
                return Path(candidate)
    fallback = (ARTIFACTS_DIR / run_id / "out" / "bundle.json")
    return fallback if fallback.is_file() else None


def _register_authored_worker(
    run_id: str,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
    *,
    user_id: str | None,
    repos: Repositories | None,
    log_fn: Callable[..., None],
) -> Optional[str]:
    """Register the worker drafted by a completed worker-author run.

    Reads the run's ``bundle.json`` artifact (produced by
    ``workers/worker-author/run.py``), assembles the worker bundle files
    (worker.yml + SKILL.md or run.py + requirements.txt), and registers them
    through the shared ``main._register_worker_from_files`` path. Returns the
    new ``worker_id`` (or None if the bundle is missing / invalid — in which
    case the run still completes and the bundle stays viewable).

    Idempotency: if the run output already carries a ``created_worker_id``
    (e.g. a resumed/re-executed run), no second worker is created.
    """
    if isinstance(outputs, dict) and outputs.get("created_worker_id"):
        return str(outputs["created_worker_id"])  # already registered

    bundle_path = _find_bundle_artifact(run_id, artifacts)
    if bundle_path is None:
        log_fn("worker-author produced no bundle.json — nothing to register", level="warning")
        return None

    try:
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log_fn(f"worker-author bundle.json unreadable: {exc}", level="warning")
        return None
    if not isinstance(bundle, dict):
        log_fn("worker-author bundle.json is not an object", level="warning")
        return None

    # If the author could not produce valid YAML after its retries it embeds an
    # `error`. Don't register a broken worker; leave the run viewable so the
    # operator sees the drafted (broken) bundle. This is the rare degenerate
    # case (LLM retries 3x first).
    if bundle.get("error"):
        log_fn(
            f"worker-author bundle has a validation error, not auto-registering: {bundle['error']}",
            level="warning",
        )
        return None

    worker_yml = (bundle.get("worker_yml") or "").strip()
    if not worker_yml:
        log_fn("worker-author bundle missing worker_yml — nothing to register", level="warning")
        return None

    skill_md = bundle.get("skill_md")
    run_code = bundle.get("run_code")
    requirements_txt = bundle.get("requirements_txt")

    # Lazy import: main imports run_service at startup, so importing main here
    # (at run-completion time, long after startup) avoids the circular import.
    import main as _main

    files = [_main.DraftFile(path="worker.yml", content=worker_yml)]
    if isinstance(skill_md, str) and skill_md.strip():
        files.append(_main.DraftFile(path="SKILL.md", content=skill_md))
    if isinstance(run_code, str) and run_code.strip():
        files.append(_main.DraftFile(path="run.py", content=run_code))
    if isinstance(requirements_txt, str) and requirements_txt.strip():
        files.append(_main.DraftFile(path="requirements.txt", content=requirements_txt))

    worker_id = _main._register_worker_from_files(
        files,
        user_id=user_id,
        repos=repos,
        dedupe_id=True,
    )
    log_fn(f"Registered worker {worker_id!r} from drafted bundle")
    return worker_id

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
    repos_obj = _repos(repos)
    try:
        recipe = repos_obj.workers.get_recipe(worker_id=worker_id)
        if recipe:
            config = recipe.get("config")
            if isinstance(config, WorkerConfig):
                return (
                    recipe.get("owner_id"),
                    config,
                    {
                        "grants": recipe.get("grants") or {},
                        "input_values": recipe.get("input_values") or {},
                        "enabled": bool(recipe.get("enabled", True)),
                    },
                )
    except Exception:
        logger.exception("Failed to load worker recipe from database for %s", worker_id)

    config = get_worker_config(worker_id)
    if not config:
        return None
    return (_worker_owner_id(worker_id, repos_obj), config, None)


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


def _runner_key(config: Optional[WorkerConfig]) -> str:
    if config and config.runtime:
        runtime_type = (config.runtime.type or "").strip().lower()
        if runtime_type.startswith("skill"):
            return runtime_type
        return config.runtime.runner or "local"
    return "local"


def _worker_dir_for_run(worker_id: str, config: Optional[WorkerConfig]) -> Path:
    bundle_path = config.runtime.bundle_path if config and config.runtime else None
    if bundle_path:
        raw_path = Path(bundle_path)
        target = raw_path if raw_path.is_absolute() else WORKERS_DIR.parent.joinpath(raw_path)
    else:
        target = WORKERS_DIR.joinpath(worker_id)
    resolved = target.resolve()
    allowed_root = WORKERS_DIR.parent.resolve()
    try:
        resolved.relative_to(allowed_root)
    except ValueError as exc:
        raise ValueError(f"Path traversal attempt: {resolved}") from exc
    return resolved


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

def create_run(
    worker_id: str,
    inputs: Dict[str, Any],
    trigger_source: str = "manual",
    *,
    status: str | None = None,
    user_id: str | None = None,
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
    instance = loaded[2] if loaded else None
    if instance and not instance.get("enabled", True):
        raise ValueError(f"Worker {worker_id} is disabled")
    effective_inputs = _merge_instance_inputs(instance, inputs)
    # Determine runner from config (default to "local" for backward compat)
    runner = _runner_key(config)
    repos_obj.runs.create(
        user_id=owner_id,
        run_id=run_id,
        worker_id=worker_id,
        status=status or RunStatus.QUEUED.value,
        trigger_source=trigger_source,
        runner=runner,
        input_json=effective_inputs,
        created_at=_now_iso(),
    )
    logger.info("Created run %s for worker %s (runner=%s)", run_id, worker_id, runner)
    return run_id


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
    repos_obj.runs.update_status(
        user_id=owner_id,
        run_id=run_id,
        status=status,
        output_json=output,
        error=error,
        error_code=error_code,
    )

    # Publish SSE event for the status change
    _publish_sse(run_id, {
        "type": "status",
        "run_id": run_id,
        "status": status,
        "error": error,
        "error_code": error_code,
    })


def _store_run_artifacts(
    run_id: str,
    artifacts: list[Dict[str, Any]],
    log_fn: Callable[[str, str], None],
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
    for art in artifacts:
        try:
            art_id = f"art_{uuid.uuid4().hex[:12]}"
            art_name = art.get("name", "artifact")
            art_type = art.get("type", "file")
            art_path = art.get("path", "")
            art_size = art.get("size_bytes", 0)
            art_created = _now_iso()
            repos_obj.runs.add_artifact(
                user_id=owner_id,
                run_id=run_id,
                artifact_id=art_id,
                name=art_name,
                artifact_type=art_type,
                path=art_path,
                size_bytes=art_size,
                created_at=art_created,
            )
            _publish_sse(run_id, {
                "type": "artifact",
                "run_id": run_id,
                "artifact": {
                    "id": art_id,
                    "name": art_name,
                    "artifact_type": art_type,
                    "size_bytes": art_size,
                    "created_at": art_created,
                },
            })
        except Exception as exc:
            logger.exception("Failed to store artifact")
            log_fn(f"Failed to store artifact: {exc}", level="warning")


def _looks_like_relative_path(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or "\n" in text or "://" in text or text.startswith("/"):
        return False
    if _PATH_VALUE_RE.fullmatch(text):
        return True
    suffixes = (".md", ".txt", ".json", ".csv", ".html", ".pdf", ".docx")
    return "/" in text and text.lower().endswith(suffixes)


def _placeholder_warning(value: Any, output_name: str) -> str | None:
    if not isinstance(value, str):
        return None
    first = value.strip().lower()[:200]
    if not first:
        return None
    if any(marker in first for marker in _PLACEHOLDER_MARKERS):
        return f"{output_name}: output looks like placeholder/apology content"
    if first.startswith("note:"):
        return f"{output_name}: output starts with Note:"
    return None


def _output_artifact(output: Any, artifacts: list[Dict[str, Any]]) -> Dict[str, Any] | None:
    expected = (getattr(output, "path", None) or "").strip()
    output_name = getattr(output, "name", "")
    for artifact in artifacts:
        names = {
            str(artifact.get("relative_path") or ""),
            str(artifact.get("name") or ""),
        }
        if expected and expected in names:
            return artifact
        if output_name and output_name in names:
            return artifact
        if expected and any(name.endswith(f"/{expected}") for name in names):
            return artifact
    return None


def _candidate_output_path(run_id: str, output: Any, outputs: Dict[str, Any], artifacts: list[Dict[str, Any]]) -> Path | None:
    artifact = _output_artifact(output, artifacts)
    if artifact and artifact.get("path"):
        return Path(str(artifact["path"]))
    root = ARTIFACTS_DIR / run_id
    declared_path = getattr(output, "path", None)
    if declared_path:
        return (root / declared_path).resolve()
    value = outputs.get(getattr(output, "name", ""))
    if isinstance(value, str) and _looks_like_relative_path(value):
        return (root / value.strip()).resolve()
    return None


def _safe_artifact_path(run_id: str, relative_path: str) -> Path:
    root = (ARTIFACTS_DIR / run_id).resolve()
    target = (root / relative_path).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise ValueError(f"output path escapes artifact directory: {relative_path}")
    return target


def _materialize_declared_file_outputs(
    run_id: str,
    config: WorkerConfig,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> None:
    for output in config.outputs:
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        if kind != "file" or output.name not in outputs or _output_artifact(output, artifacts):
            continue
        relative_path = output.path or f"outputs/{output.name}.txt"
        path = _safe_artifact_path(run_id, relative_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        value = outputs[output.name]
        path.write_text(value if isinstance(value, str) else json.dumps(value, indent=2))
        artifacts.append(
            {
                "name": relative_path,
                "relative_path": relative_path,
                "type": output.media_type or "text/plain",
                "path": str(path),
                "size_bytes": path.stat().st_size,
            }
        )


def _validate_run_outputs(
    run_id: str,
    config: WorkerConfig,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> tuple[str | None, list[str]]:
    warnings: list[str] = []
    for output in config.outputs:
        name = output.name
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        value = outputs.get(name)

        if output.required and name not in outputs:
            return f"output_validation_failed: {name} missing required output", warnings

        if kind == "file":
            if not output.required and name not in outputs and not _output_artifact(output, artifacts):
                continue
            path = _candidate_output_path(run_id, output, outputs, artifacts)
            if path is None:
                return f"output_validation_failed: {name} missing output file", warnings
            if not path.is_file():
                return f"output_validation_failed: {name} file not found at {path.name}", warnings
            size = path.stat().st_size
            if size < MIN_OUTPUT_BYTES:
                return (
                    f"output_validation_failed: {name} file is too small "
                    f"({size} bytes, minimum {MIN_OUTPUT_BYTES})"
                ), warnings
            media_type = (output.media_type or "").lower()
            if media_type == "application/json":
                try:
                    json.loads(path.read_text())
                except Exception as exc:
                    return f"output_validation_failed: {name} JSON file is invalid: {exc}", warnings
            if media_type.startswith("text/"):
                warning = _placeholder_warning(path.read_text(errors="ignore")[:1000], name)
                if warning:
                    warnings.append(warning)
            continue

        if output.required and (value is None or value == ""):
            return f"output_validation_failed: {name} scalar output is empty", warnings
        if _looks_like_relative_path(value):
            return f"output_validation_failed: {name} scalar output leaked a path string", warnings
        warning = _placeholder_warning(value, name)
        if warning:
            warnings.append(warning)

    return None, warnings


def _load_runtime_env_files() -> None:
    load_dotenv(LOCAL_ENV_PATH, override=False)
    if API_ENV_PATH.is_file():
        load_dotenv(API_ENV_PATH, override=False)


def _env_keys_from_file(path: Path) -> set[str]:
    keys: set[str] = set()
    if not path.is_file():
        return keys
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0].strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            keys.add(key)
    return keys


def _secret_names_from_db(
    user_id: str,
    repos: Repositories | None = None,
) -> set[str]:
    try:
        return _repos(repos).secrets.list_names(user_id=user_id)
    except Exception:
        return set()


_PLATFORM_SECRET_NAMES: frozenset[str] = frozenset({
    # Platform infrastructure credentials — never legitimate worker inputs.
    "FLOOM_SECRET",
    "COMPOSIO_API_KEY",
    "COMPOSIO_WEBHOOK_SIGNING_KEY",
    "E2B_API_KEY",
    "FLOOM_DEPLOY_SECRET",
    # Platform infra paths / tuning vars — same.
    "WORKERS_FRONTEND_URL",
    "FLOOM_DB",
    "FLOOM_WORKERS_DIR",
    "FLOOM_ARTIFACTS_DIR",
    "FLOOM_CONTEXTS_DIR",
    "FLOOM_RUN_TIMEOUT",
    # NOTE: OPENAI_API_KEY is INTENTIONALLY NOT in this list. Workers
    # legitimately need it to call OpenAI from inside the sandbox (research_brief,
    # csv_enricher, cv_writeup etc. all declare secrets: [OPENAI_API_KEY]).
    # Workeros v0 is single-user, so the platform owner == the worker author,
    # and sharing the OpenAI key is acceptable. When the platform goes
    # multi-tenant (skills-neo v0.y), this needs to change: each tenant must
    # bring their own OPENAI_API_KEY via the secrets DB, and the platform's
    # own key must move to a separate name like PLATFORM_OPENAI_API_KEY.
    # See ARCHITECTURE.md.
})


def get_secrets_for_worker(
    worker_id: str,
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> Dict[str, str]:
    """Resolve the secrets dict that ships to the worker sandbox.

    SECURITY: The sandbox secrets.json must contain ONLY:
      (a) secrets declared in the worker's worker.yml `exec.secrets` field
      (b) user-managed secrets stored in the platform's `secrets` DB table
    It must NEVER contain platform infrastructure credentials (FLOOM_SECRET,
    E2B_API_KEY, COMPOSIO_API_KEY, COMPOSIO_WEBHOOK_SIGNING_KEY, OPENAI_API_KEY,
    etc.) because the sandbox runs untrusted worker code and any leak there
    is equivalent to publishing the secret.

    Pre-fix this function unioned every key in `/root/.config/workeros/api.env`
    into the result, including all platform secrets above. Audit 2026-05-26
    flagged it as P0. The `_PLATFORM_SECRET_NAMES` denylist now blocks them
    regardless of whether they appear in the worker manifest or the DB.
    """
    repos_obj = _repos(repos)
    owner_id = user_id or _worker_owner_id(worker_id, repos_obj)
    if not owner_id:
        return {}
    _load_runtime_env_files()
    config = _get_worker_config_for_run(worker_id, repos_obj)
    names = set(config.secrets if config else [])
    names.update(_secret_names_from_db(owner_id, repos_obj))
    # DO NOT union env-file keys here. They include platform infra secrets.
    allowed_names = [name for name in names if name not in _PLATFORM_SECRET_NAMES]
    return repos_obj.secrets.resolve(user_id=owner_id, names=allowed_names)


# ---------------------------------------------------------------------------
# Execution orchestration
# ---------------------------------------------------------------------------

INTERRUPTED_RUN_ERROR = "Run was interrupted by an API restart before completion."
INTERRUPTED_RUN_ERROR_CODE = "interrupted_by_restart"
WORKER_DELETED_RUN_ERROR = "Worker deleted before run completed."


@dataclass
class _ActiveRun:
    run_id: str
    worker_id: str
    user_id: str | None
    thread: threading.Thread


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


def active_run_count() -> int:
    with _active_runs_lock:
        return len(_active_runs)


def was_shutdown_cancelled(run_id: str) -> bool:
    with _active_runs_lock:
        return run_id in _shutdown_cancelled_runs

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

        try:
            # Claim the run before spawning a worker thread so subsequent drain
            # passes cannot dispatch the same queued row twice.
            repos_obj.runs.update(
                user_id=user_id,
                run_id=run_id,
                status=RunStatus.RUNNING.value,
                started_at=_now_iso(),
            )

            # Slot acquired — dispatch the run in a thread.
            # The semaphore is released inside _run_thread_entry_with_semaphore.
            thread = threading.Thread(
                target=_run_thread_entry_with_semaphore,
                args=(run_id, worker_id, inputs, user_id, None),
                daemon=True,
                name=f"workeros-run-{run_id}",
            )
            _register_active_run(_ActiveRun(run_id=run_id, worker_id=worker_id, user_id=user_id, thread=thread))
            thread.start()
            logger.info("Queue drain: dispatched run %s for worker %s", run_id, worker_id)
        except Exception as exc:
            logger.warning("Queue drain: failed to dispatch run %s: %s", run_id, exc)
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


def start_drain_loop() -> None:
    """Start the background queue drain thread (idempotent)."""
    global _drain_thread
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
    """Fail runs left in-flight by a prior API process.

    Worker execution currently runs in process-local threads. A service restart
    terminates those threads, so any row that is still `running` at the next
    startup no longer has an executor attached.

    Runs in status=`queued` are NOT failed here — they are re-enqueued by
    re_enqueue_queued_runs_on_startup so they resume draining after boot.
    """
    repos_obj = _repos(repos)
    failed = repos_obj.runs.fail_running(
        user_id=user_id,
        error=INTERRUPTED_RUN_ERROR,
        error_code=INTERRUPTED_RUN_ERROR_CODE,
    )
    for run_id in failed:
        try:
            repos_obj.runs.add_log(
                user_id=user_id,
                run_id=run_id,
                level="error",
                message=INTERRUPTED_RUN_ERROR,
                timestamp=datetime.now(timezone.utc).isoformat(),
                trace_id=None,
            )
        except Exception as exc:
            logger.warning("Failed to add interrupted-run log for %s: %s", run_id, exc)
    if failed:
        logger.warning("Marked %d interrupted run(s) as failed on startup", len(failed))
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


def execute_run(
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    repos_obj = _repos(repos)
    owner_id = user_id or _worker_owner_id(worker_id, repos_obj)
    trace_id = f"trace_{uuid.uuid4().hex[:16]}"
    loaded = _load_worker_recipe(worker_id, repos_obj)
    config = loaded[1] if loaded else None
    instance = loaded[2] if loaded else None
    effective_inputs = _merge_instance_inputs(instance, inputs)

    def log_fn(msg: str, level: str = "info") -> None:
        secrets = get_secrets_for_worker(worker_id, user_id=owner_id, repos=repos_obj)
        safe_msg = scrub_secrets(msg, secrets)
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
        if (current_run or {}).get("status") != RunStatus.RUNNING.value:
            update_run_status(run_id, RunStatus.RUNNING.value, user_id=owner_id, repos=repos_obj)
        log_fn("Run started")
        log_fn("Validating inputs", level="debug")

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

        log_fn("Loading secrets", level="debug")
        secrets = get_secrets_for_worker(worker_id, user_id=owner_id, repos=repos_obj)
        missing = [s for s in config.secrets if s not in secrets]
        if missing:
            err = f"Missing secrets: {', '.join(missing)}"
            update_run_status(run_id, RunStatus.FAILED.value, error=err, error_code="missing_secret", user_id=owner_id, repos=repos_obj)
            publish_run_part(run_id, {"type": "finish", "status": "failed", "error": err})
            log_fn(err, level="error")
            return

        # Resolve Composio connections declared in worker.yml.
        connection_ids: Dict[str, str] = {}
        if config.connections:
            log_fn("Resolving connections", level="debug")
            from runner_utils import _resolve_connections
            connection_ids, conn_err = _resolve_connections(worker_id, log_fn, config)
            if conn_err:
                update_run_status(run_id, RunStatus.FAILED.value, error=conn_err, error_code="missing_connection", user_id=owner_id, repos=repos_obj)
                publish_run_part(run_id, {"type": "finish", "status": "failed", "error": conn_err})
                log_fn(conn_err, level="error")
                return

        bundle_snapshot_path = _snapshot_worker_bundle(run_id, worker_id, config)
        if owner_id:
            repos_obj.runs.set_bundle_snapshot_path(
                user_id=owner_id,
                run_id=run_id,
                bundle_snapshot_path=bundle_snapshot_path,
            )

        # Dispatch to the appropriate sandbox driver based on worker config
        runner = "local"
        if config and config.runtime:
            runner = config.runtime.runner or "local"
        mode = config.runtime.mode if config and config.runtime else "pure-script"
        timeout_seconds = (
            config.runtime.limits.timeout_seconds
            if config and config.runtime and config.runtime.limits
            else 300
        )
        log_fn(f"Executing worker (mode={mode}, runner={runner})", level="debug")
        driver = get_sandbox_driver(runner, config=config)
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

        outputs = result.outputs
        artifacts = result.artifacts
        _materialize_declared_file_outputs(run_id, config, outputs, artifacts)
        _store_run_artifacts(run_id, artifacts, log_fn, user_id=owner_id, repos=repos_obj)

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
            log_fn(f"Run failed: {result_error}", level="error")
            return

        # S47 HITL: if the worker emitted decision_required AND the worker declares
        # approvals.required, land this run as PENDING_APPROVAL and create an
        # approvals row.  Do NOT mark COMPLETED — execution halts here.
        decision_required = result.decision_required
        worker_needs_approval = bool(config and getattr(config, "approvals", None) and config.approvals.required)
        if decision_required and worker_needs_approval and result.status not in ("error", "failed"):
            approval_id = f"apr_{uuid.uuid4().hex[:12]}"
            label = decision_required.get("label") or (config.approvals.label if config and config.approvals else "Approve action")
            preview = decision_required.get("preview") or ""
            decision_input_json = json.dumps(effective_inputs)
            now_ts = _now_iso()
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
                    decision_input_json=decision_input_json,
                )
            except Exception as exc:
                logger.error("Failed to create approval row for run %s: %s", run_id, exc)
            # Store the proposed outputs on the run so the approval page can show them
            update_run_status(run_id, RunStatus.PENDING_APPROVAL.value, output=outputs, user_id=owner_id, repos=repos_obj)
            _publish_sse(run_id, {
                "type": "status",
                "run_id": run_id,
                "status": RunStatus.PENDING_APPROVAL.value,
                "approval_id": approval_id,
                "label": label,
            })
            publish_run_part(run_id, {"type": "finish", "status": "pending_approval"})
            log_fn(f"Run awaiting approval: {label}")
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
            except Exception as exc:
                # Never fail the run on registration trouble — the bundle is
                # still viewable. Log so the operator/engineer can see why.
                logger.exception("worker-author registration failed for run %s", run_id)
                log_fn(f"Could not auto-register the drafted worker: {exc}", level="warning")

        update_run_status(run_id, RunStatus.COMPLETED.value, output=outputs, user_id=owner_id, repos=repos_obj)
        # Broadcast the new worker id on the live stream so the create flow can
        # navigate straight to the editor without a follow-up fetch.
        if worker_id == _WORKER_AUTHOR_WORKER_ID and isinstance(outputs, dict) and outputs.get("created_worker_id"):
            _publish_sse(run_id, {
                "type": "status",
                "run_id": run_id,
                "status": RunStatus.COMPLETED.value,
                "created_worker_id": outputs["created_worker_id"],
            })
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
) -> None:
    """Thread entry point used by the drain loop.

    The semaphore is already acquired before this thread is created.  We
    release it in the finally block so the next queued run can be dispatched.
    """
    try:
        # Check for pre-dispatch cancellation (cancelled while queued).
        repos_obj = _repos(repos)
        run_row = repos_obj.runs.get_any(run_id=run_id)
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
        execute_run(run_id, worker_id, inputs, user_id=user_id, repos=repos)
    finally:
        _unregister_active_run(run_id)
        _get_semaphore().release()
        # Wake the drain loop so the next queued run can fill the freed slot.
        _wake_drain()
