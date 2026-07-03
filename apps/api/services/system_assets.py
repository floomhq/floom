"""Platform-only refresh helpers for bundled system workers and contexts."""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path
from typing import Any, Iterable

import yaml

from core.config import SYSTEM_CONTEXT_PACKS

REPO_ROOT = Path(__file__).resolve().parents[3]
ENGINE_WORKERS_DIR = REPO_ROOT / "workers"
ENGINE_CONTEXTS_DIR = REPO_ROOT / "contexts"

SYSTEM_WORKER_IDS = ("worker-author", "workspace-agent")
SYSTEM_CONTEXT_IDS = tuple(sorted(SYSTEM_CONTEXT_PACKS))


def _file_tree_text(root: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        try:
            files[rel] = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
    return files


def _tree_hash(files: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for rel, content in sorted(files.items()):
        rel_bytes = rel.encode("utf-8")
        content_bytes = content.encode("utf-8")
        digest.update(len(rel_bytes).to_bytes(4, "big"))
        digest.update(rel_bytes)
        digest.update(len(content_bytes).to_bytes(8, "big"))
        digest.update(content_bytes)
    return digest.hexdigest()


def _copy_text_tree(files: dict[str, str], target_dir: Path) -> None:
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    for rel, content in files.items():
        dest = target_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")


def _read_worker_manifest(worker_id: str, source_dir: Path) -> dict[str, Any]:
    manifest_path = source_dir / "worker.yml"
    if not manifest_path.is_file():
        raise ValueError(f"system worker {worker_id!r} has no worker.yml")
    parsed = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    if not isinstance(parsed, dict):
        raise ValueError(f"system worker {worker_id!r} worker.yml must be a mapping")
    if parsed.get("system_worker") is not True:
        raise ValueError(f"worker {worker_id!r} is not marked system_worker: true")
    declared_name = str(parsed.get("name") or worker_id).strip()
    if declared_name and declared_name != worker_id:
        raise ValueError(
            f"system worker bundle {worker_id!r} declares mismatched name {declared_name!r}"
        )
    return parsed


def _selected(
    requested: str | None,
    *,
    candidates: Iterable[str],
) -> list[str]:
    names = list(candidates)
    if not requested:
        return names
    return [name for name in names if name == requested]


def refresh_system_worker(
    worker_id: str,
    *,
    user_id: str,
    repos: Any,
    workspace_id: str | None = None,
) -> dict[str, Any]:
    """Refresh one bundled system worker into canonical DB and local disk."""
    source_dir = ENGINE_WORKERS_DIR / worker_id
    if not source_dir.is_dir():
        raise ValueError(f"unknown bundled system worker: {worker_id}")
    manifest = _read_worker_manifest(worker_id, source_dir)
    files = _file_tree_text(source_dir)
    if "worker.yml" not in files:
        raise ValueError(f"system worker {worker_id!r} has no embeddable worker.yml")
    source_hash = _tree_hash(files)
    manifest = dict(manifest)
    manifest["_files"] = files
    manifest["_system_source_hash"] = source_hash

    existing = None
    get_any = getattr(repos.workers, "get_any", None)
    if callable(get_any):
        existing = get_any(worker_id=worker_id)

    owner_id = str((existing or {}).get("owner_id") or user_id)
    target_workspace_id = (
        str((existing or {}).get("workspace_id") or workspace_id or "").strip() or None
    )
    visibility = str((existing or {}).get("visibility") or "workspace")

    trigger = manifest.get("trigger") if isinstance(manifest.get("trigger"), dict) else {}
    repos.workers.upsert(
        user_id=owner_id,
        worker_id=worker_id,
        name=manifest.get("title") or manifest.get("name") or worker_id,
        manifest_json=manifest,
        trigger_type=trigger.get("type") or "manual",
        bundle_path=f"workers/{worker_id}",
        workspace_id=target_workspace_id,
        visibility=visibility,
        enabled=(existing or {}).get("enabled", True),
    )

    from worker_registry import WORKERS_DIR, invalidate_worker_cache
    from run_service import invalidate_worker_run_cache

    _copy_text_tree(files, Path(WORKERS_DIR) / worker_id)
    invalidate_worker_cache()
    invalidate_worker_run_cache(worker_id)
    return {
        "asset": worker_id,
        "kind": "worker",
        "status": "refreshed",
        "hash": source_hash,
        "files": len(files),
        "workspace_id": target_workspace_id,
    }


def refresh_system_context(
    context_name: str,
    *,
    scope: str | None = None,
) -> dict[str, Any]:
    """Refresh one bundled system context into the active context store."""
    source_dir = ENGINE_CONTEXTS_DIR / context_name
    if not source_dir.is_dir():
        raise ValueError(f"unknown bundled system context: {context_name}")
    files = _file_tree_text(source_dir)
    if not files:
        raise ValueError(f"system context {context_name!r} has no embeddable files")

    from contexts import (
        context_dir,
        current_context_scope,
        refresh_context_summary_metadata,
        set_context_metadata,
        sync_refreshed_context_pack,
        use_context_scope,
    )

    context_scope = scope if scope is not None else current_context_scope()
    with use_context_scope(context_scope):
        target_dir = context_dir(context_name, hydrate=False)
        _copy_text_tree(files, target_dir)
        set_context_metadata(
            context_name,
            writeable=False,
            sensitive=True,
            category="system",
        )
        summary = refresh_context_summary_metadata(context_name)
        sync_refreshed_context_pack(context_scope, context_name, target_dir, summary)

    return {
        "asset": context_name,
        "kind": "context",
        "status": "refreshed",
        "hash": _tree_hash(files),
        "files": len(files),
        "workspace_id": context_scope,
    }


def refresh_system_assets(
    *,
    user_id: str,
    repos: Any,
    asset: str | None = None,
    workspace_id: str | None = None,
    all_workspaces: bool = False,
) -> dict[str, Any]:
    """Refresh bundled system workers and contexts.

    ``all_workspaces`` is accepted for hosted callers that fan out or bind the
    request to their global system workspace before invoking the engine. The OSS
    engine has one active context scope, so it refreshes that scope once.
    """
    requested = str(asset or "").strip() or None
    workers = _selected(requested, candidates=SYSTEM_WORKER_IDS)
    contexts = _selected(requested, candidates=SYSTEM_CONTEXT_IDS)
    if requested and not workers and not contexts:
        raise ValueError(f"unknown system asset: {requested}")

    refreshed: list[dict[str, Any]] = []
    for worker_id in workers:
        refreshed.append(
            refresh_system_worker(
                worker_id,
                user_id=user_id,
                repos=repos,
                workspace_id=workspace_id,
            )
        )
    for context_name in contexts:
        refreshed.append(refresh_system_context(context_name, scope=workspace_id))

    return {
        "refreshed": refreshed,
        "count": len(refreshed),
        "all_workspaces": bool(all_workspaces),
    }
