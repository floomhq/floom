"""Worker serialization: worker-row -> WorkerDetail/file/trigger shaping.

Builds the operator worker-detail response (status, triggers, required
secrets/connections, recent stats, bundle files, public share link) and the
worker file/language/bundle helpers. Shared by the worker, chat, and overview
surfaces. Extracted verbatim from main.py.

Dependency direction downward: services.worker_access (visibility/permissions/
manifest-declared names), services.run_serialize (_make_run_summary),
services.secrets_env (_available_secret_names_for_user), services.public_view
(_sanitize_operator_text), core.urls (_frontend_base_url). models/db/run_service
are imported lazily inside functions (purged modules). Never imports main.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Optional

from fastapi import HTTPException

from core.urls import _frontend_base_url
from services.public_view import _sanitize_operator_text
from services.run_serialize import _make_run_summary
from services.secrets_env import _available_secret_names_for_user
from services.worker_access import (
    _normalize_trigger_type,
    _available_connection_slugs_for_user,
    _get_visible_worker,
    _worker_connection_slugs,
    _worker_permissions,
    _worker_required_secret_names,
    _worker_source_visible_to_api,
)

logger = logging.getLogger("floom.api")

if TYPE_CHECKING:
    from db import Repositories


_DEFAULT_RUN_PY_STUB = (
    "import json\n"
    "from pathlib import Path\n"
    "from typing import Dict, Any\n\n\n"
    "def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:\n"
    "    # Placeholder worker — edit run.py to do the real work.\n"
    "    return {\"status\": \"success\", \"outputs\": {}, \"artifacts\": []}\n\n\n"
    "if __name__ == \"__main__\":\n"
    "    # E2B pure-script entry: write result.json so the run does not fail\n"
    "    # with missing_result. Edit this to produce real outputs.\n"
    "    Path(\"result.json\").write_text(\n"
    "        json.dumps({\"status\": \"success\", \"outputs\": {}, \"artifacts\": []}),\n"
    "        encoding='utf-8',\n"
    "    )\n"
)

_WORKER_FILE_IGNORE = frozenset({
    "__pycache__",
    ".DS_Store",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "node_modules",
    ".eggs",
    "dist",
    "build",
    "*.pyc",
})


def _language_for_path(rel_path: str) -> str:
    """Map a file path to a language identifier for syntax highlighting."""
    ext = Path(rel_path).suffix.lower()
    return {
        ".md": "markdown",
        ".py": "python",
        ".yml": "yaml",
        ".yaml": "yaml",
        ".json": "json",
        ".txt": "text",
        ".sh": "bash",
        ".toml": "toml",
        ".js": "javascript",
        ".ts": "typescript",
        ".html": "html",
        ".css": "css",
    }.get(ext, "text")


def _should_ignore_worker_file(rel_path: str) -> bool:
    """Return True if the file should be omitted from the worker's file listing."""
    parts = Path(rel_path).parts
    for part in parts:
        if part in _WORKER_FILE_IGNORE:
            return True
        if part.endswith(".pyc"):
            return True
    return False


def _worker_public_payload(worker: Dict[str, Any]) -> str:
    """Stable HMAC payload for a worker share link.

    Bound to both the worker id AND its owner so a link minted for one owner's
    worker can never resolve a same-id worker owned by someone else (defense in
    depth alongside the owner-scoped detail build).
    """
    return ".".join(
        ("worker", str(worker.get("id") or ""), str(worker.get("owner_id") or ""))
    )


def _worker_public_token(worker: Dict[str, Any]) -> str:
    secret = os.environ.get("FLOOM_SECRET") or "dev-secret-not-set"
    return hmac.new(
        secret.encode("utf-8"),
        _worker_public_payload(worker).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _worker_public_link(worker: Dict[str, Any]) -> Optional[str]:
    """Owner-only standalone share URL for a worker (or None if id is missing)."""
    worker_id = str(worker.get("id") or "")
    if not worker_id:
        return None
    token = _worker_public_token(worker)
    return f"{_frontend_base_url()}/w/{worker_id}?token={token}"


def _worker_bundle_dir(worker_id: str, config: WorkerConfig) -> Path:
    from models import WorkerConfig
    from worker_registry import WORKERS_DIR
    bundle_path = config.runtime.bundle_path if config and config.runtime else None
    if bundle_path:
        raw_path = Path(bundle_path)
        target = raw_path if raw_path.is_absolute() else WORKERS_DIR.parent.joinpath(raw_path)
    else:
        target = WORKERS_DIR / worker_id
    resolved = target.resolve()
    allowed_root = WORKERS_DIR.parent.resolve()
    try:
        resolved.relative_to(allowed_root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid worker bundle path")
    return resolved


def _get_stats_batch(
    worker_ids: List[str],
    *,
    user_id: str,
    repos: Repositories,
) -> Dict[str, RecentStats]:
    """Batch-query 7-day run stats for a list of worker IDs in one SQL call."""
    from models import RecentStats
    if not worker_ids:
        return {}
    placeholders = ",".join("?" for _ in worker_ids)
    try:
        return repos.workers.stats_batch(user_id=user_id, worker_ids=worker_ids)
    except sqlite3.OperationalError:
        return {}


def _worker_has_webhook_trigger(worker: Dict[str, Any], config: Optional["WorkerConfig"]) -> bool:
    """Return True if any of the worker's triggers is of type 'webhook'.

    Checks triggers_json in the DB first (multi-trigger support), then
    falls back to the single config.trigger.type.
    """
    # Check multi-trigger DB column first
    try:
        if worker.get("triggers_json"):
            triggers = json.loads(worker["triggers_json"])
            if isinstance(triggers, list):
                return any(
                    isinstance(t, dict) and t.get("type") == "webhook"
                    for t in triggers
                )
    except Exception:
        pass
    # Fallback: single trigger config
    if config:
        return config.trigger.type == "webhook"
    return False


def _build_triggers_spec(worker: Dict[str, Any]) -> List[TriggerSpec]:
    """Build a structured list of TriggerSpec from a worker dict.

    Prefers triggers_json (multi-trigger DB column) when present.
    Falls back to config.trigger for single-trigger / legacy workers.
    Legacy workers without triggers_json are wrapped as a one-element list.
    """
    from models import TriggerSpec
    triggers_json = worker.get("triggers_json")
    if triggers_json:
        try:
            raw = json.loads(triggers_json)
            if isinstance(raw, list) and raw:
                specs = []
                for t in raw:
                    if not isinstance(t, dict):
                        continue
                    specs.append(TriggerSpec(
                        type=_normalize_trigger_type(t.get("type")),
                        cron=t.get("cron"),
                        timezone=t.get("timezone"),
                        webhook=t.get("webhook"),
                        composio=t.get("composio"),
                    ))
                if specs:
                    return specs
        except Exception:
            pass

    # Fall back to single trigger from config
    config: Dict[str, Any] = worker.get("config") or {}
    trigger: Dict[str, Any] = config.get("trigger") or {}
    trigger_type = _normalize_trigger_type(worker.get("trigger_type") or trigger.get("type"))
    return [TriggerSpec(
        type=trigger_type,
        cron=trigger.get("cron"),
        timezone=trigger.get("timezone"),
        webhook=trigger.get("webhook"),
        composio=trigger.get("composio"),
    )]


def _resolve_worker_status(
    worker: Dict[str, Any],
    *,
    config: Optional["WorkerConfig"],
    available_secret_names: Iterable[str],
    last_run_status: Optional[RunStatus],
    has_run: bool,
) -> WorkerStatus:
    """Single source of truth for an operator-facing worker status.

    Used by BOTH the LIST path (``list_workers``) and the DETAIL path
    (``_build_worker_detail``) so the two surfaces can never disagree for the
    same worker. The full honesty downgrade ladder, in order:

    1. MISSING_SECRET — a required secret is not configured.
    2. NEEDS_ATTENTION — the most recent run FAILED.
    3. NEEDS_ATTENTION — the worker is durably disabled (``enabled is False``,
       e.g. smoke-gated on creation). A disabled worker is broken, not healthy.
    4. READY — the worker has never run, so "healthy" (which implies a
       verified-working worker) has not been EARNED. READY renders identically
       to HEALTHY in the quiet UI; this only keeps the API claim honest.

    Archived workers are intentionally inactive and keep their stored status
    (they surface via the archived badge, not needs_attention).
    Already-broken raw states (e.g. "error") are preserved as-is — we only
    ever downgrade FROM healthy, never fabricate health.
    """
    from models import RunStatus, WorkerStatus
    raw = worker.get("status") or WorkerStatus.HEALTHY.value
    try:
        status = WorkerStatus(raw)
    except ValueError:
        status = WorkerStatus.ERROR
    is_archived = bool(worker.get("archived", False))
    # `enabled` defaults to True: stock/filesystem workers have no recipe row
    # and are not durably disable-able, so absence means "enabled".
    enabled = bool(worker.get("enabled", True))
    secret_set = set(available_secret_names)

    if config and config.secrets:
        missing = [s for s in config.secrets if s not in secret_set]
        if missing:
            status = WorkerStatus.MISSING_SECRET

    if (
        not is_archived
        and status == WorkerStatus.HEALTHY
        and last_run_status == RunStatus.FAILED
    ):
        status = WorkerStatus.NEEDS_ATTENTION

    if (
        not is_archived
        and status == WorkerStatus.HEALTHY
        and not enabled
    ):
        status = WorkerStatus.NEEDS_ATTENTION

    if (
        status == WorkerStatus.HEALTHY
        and not has_run
        and not is_archived
        and enabled
    ):
        status = WorkerStatus.READY

    return status


def _read_worker_files(worker_dir: Path) -> List[WorkerFile]:
    """Read all non-ignored files from a worker directory recursively.

    Priority order for display: worker.yml first, SKILL.md second, run.py third,
    then all remaining files alphabetically.
    """
    from models import WorkerFile
    if not worker_dir.is_dir():
        return []

    raw_files: List[WorkerFile] = []
    for file_path in sorted(worker_dir.rglob("*")):
        if not file_path.is_file():
            continue
        try:
            rel = file_path.relative_to(worker_dir).as_posix()
        except ValueError:
            continue
        if _should_ignore_worker_file(rel):
            continue
        size = file_path.stat().st_size
        language = _language_for_path(rel)
        # Attempt UTF-8 read; mark binary if it fails
        try:
            content = file_path.read_text(encoding="utf-8")
            raw_files.append(WorkerFile(path=rel, language=language, content=content, binary=False, size=size))
        except (UnicodeDecodeError, OSError):
            raw_files.append(WorkerFile(path=rel, language="text", content=None, binary=True, size=size))

    # Sort: worker.yml first, SKILL.md second, run.py third, then alphabetic
    def _sort_key(f: WorkerFile) -> tuple:
        from models import WorkerFile
        order = {"worker.yml": 0, "SKILL.md": 1, "run.py": 2}
        return (order.get(f.path, 3), f.path)

    raw_files.sort(key=_sort_key)
    return raw_files


def _worker_files_from_manifest(worker: Dict[str, Any]) -> List[WorkerFile]:
    """Build the minimal editable source view for DB-backed workers without a bundle dir."""
    from models import WorkerFile
    import yaml as pyyaml

    files: List[WorkerFile] = []
    manifest = worker.get("manifest") or worker.get("manifest_json") or {}
    if manifest:
        try:
            manifest_yaml = pyyaml.safe_dump(manifest, sort_keys=False)
            files.append(
                WorkerFile(
                    path="worker.yml",
                    language=_language_for_path("worker.yml"),
                    content=manifest_yaml,
                    binary=False,
                    size=len(manifest_yaml.encode("utf-8")),
                )
            )
        except Exception:
            pass

    config = worker.get("config") or {}
    runtime = config.get("runtime") if isinstance(config, dict) else {}
    entrypoint = ""
    if isinstance(runtime, dict):
        entrypoint = str(runtime.get("entrypoint") or "")
    for rel in ("SKILL.md", "run.py"):
        content = ""
        if isinstance(manifest, dict):
            files_section = manifest.get("files")
            if isinstance(files_section, dict) and isinstance(files_section.get(rel), str):
                content = files_section[rel]
        if not content and rel == "run.py" and entrypoint == "run.py":
            content = _DEFAULT_RUN_PY_STUB
        if content:
            files.append(
                WorkerFile(
                    path=rel,
                    language=_language_for_path(rel),
                    content=content,
                    binary=False,
                    size=len(content.encode("utf-8")),
                )
            )
    return files


def _build_worker_detail(
    worker_id: str,
    *,
    user_id: str,
    repos: Repositories,
    role: Optional[str] = None,
    include_grants: bool = False,
) -> WorkerDetail:
    from models import WorkerConfig, WorkerDetail, WorkerFile
    worker = _get_visible_worker(
        worker_id, user_id=user_id, repos=repos, role=role, include_grants=include_grants
    )
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    recent_runs = [
        _make_run_summary(row)
        for row in repos.runs.list_for_worker(
            user_id=user_id,
            worker_id=worker_id,
            limit=10,
            offset=0,
        )
    ]

    # #815: latest output — the most recent COMPLETED run's output, fetched once
    # so the detail page renders an output-first overview without a second call.
    latest_output: Optional[Dict[str, Any]] = None
    latest_output_run_id: Optional[str] = None
    _latest_completed = next(
        (r for r in recent_runs if str(getattr(r, "status", "")).lower().endswith("completed")),
        None,
    )
    if _latest_completed is not None:
        try:
            _run_row = repos.runs.get(user_id=user_id, run_id=_latest_completed.id)
            if _run_row:
                parsed = json.loads(_run_row.get("output_json") or "{}")
                if isinstance(parsed, dict):
                    latest_output = parsed
                    latest_output_run_id = _latest_completed.id
        except Exception:
            logger.debug("latest-output fetch failed for worker %s", worker_id, exc_info=True)

    config_dict = worker.get("config", {})
    try:
        config = WorkerConfig(**config_dict)
    except Exception:
        config = WorkerConfig(
            id=worker["id"],
            name=worker["name"],
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )

    # Resolve status via the SHARED resolver so DETAIL and LIST agree exactly
    # for the same worker (full honesty ladder: missing-secret / failed-run /
    # disabled / never-run, see _resolve_worker_status). The worker dict already
    # carries `enabled` (same w.enabled column get_recipe reads), so no separate
    # recipe fetch is needed.
    available_secret_names = _available_secret_names_for_user(user_id, repos)
    available_conn_slugs_detail = _available_connection_slugs_for_user(user_id, repos)
    status = _resolve_worker_status(
        worker,
        config=config,
        available_secret_names=available_secret_names,
        last_run_status=recent_runs[0].status if recent_runs else None,
        has_run=bool(recent_runs),
    )
    # #556: compute specific missing items.
    _det_req_secrets = _worker_required_secret_names(worker) if config else []
    _det_missing_secrets = [s for s in _det_req_secrets if s not in available_secret_names]
    _det_req_conns = _worker_connection_slugs(worker)
    _det_missing_connections = [c for c in _det_req_conns if c.lower() not in available_conn_slugs_detail]
    # `enabled` mirrors the same w.enabled column the resolver reads; stock /
    # filesystem workers carry no enabled flag and are treated as enabled.
    worker_enabled = bool(worker.get("enabled", True))

    manifest_yaml: Optional[str] = None
    run_py: Optional[str] = None
    skill_md_content: Optional[str] = None
    run_py_content: Optional[str] = None
    worker_files: List[WorkerFile] = []
    if _worker_source_visible_to_api(worker_id):
        try:
            worker_dir = _worker_bundle_dir(worker_id, config)
            yml_path = worker_dir / "worker.yml"
            run_path = worker_dir / "run.py"
            skill_path = worker_dir / "SKILL.md"
            if yml_path.is_file():
                manifest_yaml = yml_path.read_text(encoding='utf-8')
            elif worker.get("manifest"):
                import yaml as pyyaml
                manifest_yaml = pyyaml.safe_dump(worker["manifest"], sort_keys=False)
            if run_path.is_file():
                run_py = run_path.read_text(encoding='utf-8')
                run_py_content = run_py
            if skill_path.is_file():
                skill_md_content = skill_path.read_text(encoding='utf-8')
            worker_files = _read_worker_files(worker_dir)
            if not worker_files:
                worker_files = _worker_files_from_manifest(worker)
        except Exception:
            worker_files = _worker_files_from_manifest(worker)

    # Build webhook URL if this worker has a webhook trigger
    from webhook_service import build_webhook_url as _build_webhook_url
    webhook_url: Optional[str] = None
    if _worker_has_webhook_trigger(worker, config):
        try:
            # Token derives from the worker's current rotatable secret (backfilled
            # lazily if absent), so this always surfaces the working current URL.
            webhook_url = _build_webhook_url(worker["id"], repos=repos)
        except Exception:
            logger.warning("Could not build webhook URL for %s", worker["id"], exc_info=True)

    triggers_spec = _build_triggers_spec(worker)

    # P2 (2026-05-29): runtime.bundle_path carries the absolute host path
    # (/root/workeros/workers/<id>) and is serialized into the public `config`.
    # The UI never renders it, but the API exposed the deploy dir + storage
    # layout. Relativise to the bundle BASENAME (the worker id) so the value
    # stays self-consistent (worker_registry resolves it under WORKERS_DIR
    # server-side) without disclosing the host path. `config` here is freshly
    # constructed for this response only; mutating it does not affect any
    # server-side bundle resolution (which reads from disk / a fresh config).
    if config and config.runtime and config.runtime.bundle_path:
        config.runtime.bundle_path = Path(config.runtime.bundle_path).name

    return WorkerDetail(
        id=worker["id"],
        name=worker["name"],
        description=worker.get("description"),
        long_description=worker.get("long_description"),
        use_cases=worker.get("use_cases"),
        example_input=worker.get("example_input"),
        example_output=worker.get("example_output"),
        how_it_works=worker.get("how_it_works"),
        is_example=worker.get("is_example"),
        archived=bool(worker.get("archived", False)),
        enabled=worker_enabled,
        archive_reason=_sanitize_operator_text(worker.get("archive_reason")),
        tags=worker.get("tags") or [],
        folder=worker.get("folder"),
        status=status,
        trigger_type=worker["trigger_type"],
        runner=worker["runner"],
        config=config,
        recent_runs=recent_runs,
        latest_output=latest_output,  # #815
        latest_output_run_id=latest_output_run_id,  # #815
        recent_stats=_get_stats_batch([worker_id], user_id=user_id, repos=repos).get(worker_id),
        manifest_yaml=manifest_yaml,
        run_py=run_py,
        skill_md_content=skill_md_content,
        run_py_content=run_py_content,
        files=worker_files,
        webhook_url=webhook_url,
        triggers_spec=triggers_spec,
        missing_secrets=_det_missing_secrets,
        missing_connections=_det_missing_connections,
        public_link=_worker_public_link(worker) if str(worker.get("visibility") or "private") == "public" else None,
        owner_id=worker.get("owner_id"),
        visibility=str(worker.get("visibility") or "private"),
        permissions=_worker_permissions(worker, user_id=user_id, repos=repos),
    )


def _get_timeseries_batch(
    worker_ids: List[str],
    *,
    user_id: str,
    repos: Repositories,
    days: int = 14,
) -> Dict[str, List[TimeseriesDay]]:
    """Batch-query per-day run counts for sparkline charts (last N days).

    Returns a dict mapping worker_id -> list of N TimeseriesDay objects,
    oldest first, zero-filled for days with no runs.
    """
    if not worker_ids:
        return {}
    try:
        return repos.workers.timeseries_batch(user_id=user_id, worker_ids=worker_ids, days=days)
    except sqlite3.OperationalError:
        return {}
