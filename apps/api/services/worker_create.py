"""Worker creation mechanics: atomic bundle write -> persist -> git-commit.

The per-worker create lock, the worker.yml -> DB-record projection, the bundle
file writer, the create-failure cleanup, the hosted-runner guard, and the
end-to-end _create_worker_from_parsed_payload orchestration (staging dir ->
persist -> os.replace -> skill-version embed -> git commit, with rollback on any
failure). Shared by the create / from-bundle / draft-and-create routes.
Extracted verbatim from main.py.

models / worker_registry / db are imported lazily inside the functions (purged +
re-imported by fixtures); registry, serialization and git helpers come from the
sibling services. Never imports main. The per-process create-lock table is module
state here (keyed by worker_id; not reset between tests).
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Optional

from fastapi import HTTPException

from services.git_service import _git_author
from services.worker_registry_ops import (
    _embed_files_in_skill_version,
    _git_commit_worker,
    _persist_discovered_workers,
    _skill_version_id,
)
from services.worker_serialize import _build_worker_detail

if TYPE_CHECKING:
    from auth import AuthContext
    from db import Repositories
    from models import WorkerConfig, WorkerCreateRequest, WorkerDetail

import logging

logger = logging.getLogger("floom.api")

_worker_create_locks_guard = threading.Lock()
_worker_create_locks: Dict[str, threading.Lock] = {}


def _emit_worker_created(*, worker_id: str, owner_id: str, config: Any) -> None:
    """Emit the worker_created PostHog event after a successful create.

    Single chokepoint: every create route (HTTP / MCP / chat) funnels through
    _create_worker_from_parsed_payload. Sends counts/flags only, never the
    worker body. No-op when analytics is disabled; never raises."""
    try:
        from services import analytics_posthog
        from db import derive_workspace_id
    except Exception:  # pragma: no cover
        return
    if not analytics_posthog.is_enabled():
        return
    try:
        has_schedule = bool(getattr(getattr(config, "trigger", None), "cron", None))
        tool_count = len(getattr(config, "connections", None) or []) + len(
            getattr(config, "calls", None) or []
        )
        runner = None
        runtime = getattr(config, "runtime", None)
        if runtime is not None:
            runner = getattr(runtime, "runner", None)
        analytics_posthog.capture_event(
            distinct_id=owner_id or "",
            event="worker_created",
            properties={
                "worker_id": worker_id,
                "has_schedule": has_schedule,
                "tool_count": tool_count,
                "runner": runner or None,
            },
            groups={"workspace": derive_workspace_id(owner_id)},
        )
    except Exception:  # pragma: no cover
        logger.debug("PostHog worker_created emit failed for %s", worker_id, exc_info=True)


def _acquire_worker_create_lock(worker_id: str) -> threading.Lock:
    with _worker_create_locks_guard:
        lock = _worker_create_locks.get(worker_id)
        if lock is None:
            lock = threading.Lock()
            _worker_create_locks[worker_id] = lock
    lock.acquire()
    return lock


def _worker_record_from_worker_yml(worker_id: str, worker_yml: str) -> Dict[str, Any]:
    import yaml as pyyaml
    from models import (
        WorkerContract,
        parse_worker_manifest,
        worker_config_to_worker_contract,
        worker_contract_to_worker_config,
    )

    raw = pyyaml.safe_load(worker_yml)
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="worker_yml must contain a YAML mapping")
    parsed = parse_worker_manifest(raw)
    if isinstance(parsed, WorkerContract):
        contract = parsed
        config = worker_contract_to_worker_config(contract, worker_id)
    else:
        config = parsed
        contract = worker_config_to_worker_contract(config)
    return {
        "id": worker_id,
        "name": config.name,
        "description": config.description,
        "long_description": contract.long_description,
        "use_cases": contract.use_cases,
        "example_input": contract.example_input,
        "example_output": contract.example_output,
        "how_it_works": contract.how_it_works,
        "is_example": contract.is_example,
        "archived": contract.archived,
        "archive_reason": contract.archive_reason,
        "tags": contract.tags or [],
        "folder": contract.folder,
        "config": config.model_dump(),
        "manifest": contract.model_dump(mode="json", exclude_none=True),
        "status": "healthy",
        "trigger_type": config.trigger.type,
        "runner": config.runtime.runner,
        # Visibility from worker.yml — if set, used as the initial value on create/reload.
        # "private" is the safe default if not specified in the manifest.
        "visibility": contract.visibility or "private",
    }


def _write_worker_bundle_files(
    target_dir: Path,
    *,
    worker_yml: str,
    run_py: str,
    skill_md: Optional[str],
    config: WorkerConfig,
) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / "worker.yml").write_text(worker_yml, encoding="utf-8")
    (target_dir / "run.py").write_text(run_py, encoding="utf-8")
    (target_dir / "requirements.txt").write_text("", encoding="utf-8")
    if skill_md:
        (target_dir / "SKILL.md").write_text(skill_md, encoding="utf-8")
    else:
        (target_dir / "SKILL.md").write_text(
            f"# {config.name}\n\n"
            "This WorkerContract entrypoint is a placeholder for the markdown skill runtime. "
            "Current Workeros execution uses `exec.command` from `worker.yml`.\n",
            encoding="utf-8",
        )


def _cleanup_worker_create_state(
    *,
    worker_id: str,
    user_id: str,
    repos: Repositories,
    staging_dir: Optional[Path] = None,
    target_dir: Optional[Path] = None,
    skill_version_id: Optional[str] = None,
    delete_persisted: bool = True,
) -> None:
    from db import get_db
    from worker_registry import invalidate_worker_cache

    for path in (staging_dir, target_dir):
        if path and path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
    if not delete_persisted:
        invalidate_worker_cache()
        return
    try:
        repos.workers.delete(user_id=user_id, worker_id=worker_id)
    except Exception:
        logger.debug("worker create cleanup repo delete failed for %s", worker_id, exc_info=True)
    try:
        with get_db() as conn:
            conn.execute("DELETE FROM worker_triggers WHERE worker_id = ?", (worker_id,))
            conn.execute("DELETE FROM workers WHERE id = ? AND owner_id = ?", (worker_id, user_id))
            if skill_version_id:
                conn.execute(
                    """
                    DELETE FROM skill_versions
                    WHERE id = ?
                      AND NOT EXISTS (
                          SELECT 1 FROM workers WHERE skill_version_id = ?
                      )
                    """,
                    (skill_version_id, skill_version_id),
                )
    except Exception:
        logger.debug("worker create cleanup sqlite delete failed for %s", worker_id, exc_info=True)
    invalidate_worker_cache()


def _reject_raw_local_runner_on_create(worker_yml: str) -> None:
    import yaml as pyyaml

    try:
        raw = pyyaml.safe_load(worker_yml)
    except Exception:
        return
    if not isinstance(raw, dict):
        return
    candidates = []
    for section in (raw.get("exec"), raw.get("runtime"), raw):
        if isinstance(section, dict):
            candidates.append(str(section.get("runner") or "").strip().lower())
    if "local" in candidates:
        raise HTTPException(
            status_code=400,
            detail=(
                "exec.runner: local is not supported by the hosted Workeros API. "
                "Set exec.runner: e2b for workers created through the API or MCP."
            ),
        )


def _ensure_worker_memory_pack(config: "WorkerConfig", user_id: str) -> None:
    from contexts import context_scope_for_user, use_context_scope
    from runner_sandbox.memory_context import ensure_memory_context_pack

    def _log(message: str, level: str = "info") -> None:
        if level == "warning":
            logger.warning(message)
        else:
            logger.debug(message)

    try:
        with use_context_scope(context_scope_for_user(user_id)):
            ensure_memory_context_pack(config=config, user_id=user_id, log_fn=_log)
    except Exception:
        logger.warning("Failed to materialize memory pack for worker %s", config.id, exc_info=True)


def _create_worker_from_parsed_payload(
    *,
    worker_id: str,
    worker_yml: str,
    payload: WorkerCreateRequest,
    config: WorkerConfig,
    auth: AuthContext,
    repos: Repositories,
) -> WorkerDetail:
    from db import get_db
    from worker_registry import WORKERS_DIR, invalidate_worker_cache

    create_lock = _acquire_worker_create_lock(worker_id)
    try:
        target_dir = WORKERS_DIR / worker_id
        if target_dir.exists():
            raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")
        try:
            if repos.workers.get_any(worker_id=worker_id) is not None:
                raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")
        except HTTPException:
            raise
        except Exception:
            logger.warning("worker existence lookup failed for %s", worker_id, exc_info=True)

        staging_dir = Path(tempfile.mkdtemp(prefix=f".{worker_id}.", dir=str(WORKERS_DIR.parent)))
        worker_record: Optional[Dict[str, Any]] = None
        skill_version_id: Optional[str] = None
        create_complete = False
        target_committed = False
        delete_persisted = True
        try:
            _write_worker_bundle_files(
                staging_dir,
                worker_yml=worker_yml,
                run_py=payload.run_py,
                skill_md=payload.skill_md,
                config=config,
            )
            worker_record = _worker_record_from_worker_yml(worker_id, worker_yml)
            skill_version_id = _skill_version_id(worker_id, worker_record.get("manifest") or {})
            invalidate_worker_cache()
            with get_db() as conn:
                # Single-worker create: surface a persist failure (don't silently skip).
                _persist_discovered_workers(conn, [worker_record], user_id=auth.user_id, raise_on_skip=True)
            _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)
            os.replace(staging_dir, target_dir)
            target_committed = True
            try:
                _embed_files_in_skill_version(worker_id, target_dir)
            except Exception:
                logger.warning("Failed to embed files in DB for worker %s", worker_id, exc_info=True)
            _ensure_worker_memory_pack(config, auth.user_id)
            invalidate_worker_cache()
            detail = _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)
            # Commit new worker files to the workspace git repo.
            author_name, author_email = _git_author(auth)
            worker_name = (config.name if config else None) or worker_id
            _git_commit_worker(
                worker_id,
                message=f"worker: create {worker_name}",
                author_name=author_name,
                author_email=author_email,
            )
            create_complete = True
            # PostHog: worker created (single chokepoint for all create routes).
            _emit_worker_created(
                worker_id=worker_id, owner_id=auth.user_id, config=config
            )
            return detail
        except sqlite3.IntegrityError as exc:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Worker {worker_id!r} already exists or conflicts with a previous version. "
                    "Delete the old worker first, then recreate."
                ),
            ) from exc
        except FileExistsError as exc:
            delete_persisted = False
            raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to create worker {worker_id!r}: {exc}") from exc
        finally:
            if not create_complete:
                _cleanup_worker_create_state(
                    worker_id=worker_id,
                    user_id=auth.user_id,
                    repos=repos,
                    staging_dir=staging_dir,
                    target_dir=target_dir if target_committed else None,
                    skill_version_id=skill_version_id,
                    delete_persisted=delete_persisted,
                )
    finally:
        create_lock.release()
