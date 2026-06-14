"""Worker discovery from the filesystem with caching and path-safety."""

import os
import yaml
import logging
from typing import List, Dict, Any, Optional
from pathlib import Path

from models import (
    WorkerConfig,
    WorkerContract,
    parse_worker_manifest,
    worker_config_to_worker_contract,
    worker_contract_to_worker_config,
)

logger = logging.getLogger("floom.worker_registry")

WORKERS_DIR = Path(os.environ.get("FLOOM_WORKERS_DIR", "../../workers")).resolve()

_worker_cache: Optional[List[Dict[str, Any]]] = None


def _safe_path(*parts: str) -> Path:
    """Resolve a path under WORKERS_DIR, rejecting traversal escapes.

    Containment is checked against the *logical* (non-symlink-followed) path so a
    legitimately symlinked deploy root (e.g. ``/opt/.../var`` -> ``/data/var`` on
    Railway) does not trip the guard on a valid ``<WORKERS_DIR>/<worker_id>``
    path. Real escapes (``..`` segments, absolute parts) are still rejected
    because they change the lexically-normalised path's prefix.
    """
    # Reject any part that tries to escape (absolute path or parent traversal)
    # before joining, so a malicious worker_id like "../../etc" never resolves.
    for part in parts:
        p = Path(part)
        if p.is_absolute() or ".." in p.parts:
            raise ValueError(f"Path traversal attempt: {WORKERS_DIR.joinpath(*parts)}")
    base = Path(os.path.normpath(str(WORKERS_DIR)))
    target = Path(os.path.normpath(str(base.joinpath(*parts))))
    try:
        target.relative_to(base)
    except ValueError:
        raise ValueError(f"Path traversal attempt: {target}")
    return target


def _load_worker_manifest(folder: Path) -> tuple[WorkerConfig, WorkerContract]:
    raw = yaml.safe_load((folder / "worker.yml").read_text())
    if not isinstance(raw, dict):
        raise ValueError("worker.yml must contain a YAML mapping")
    parsed = parse_worker_manifest(raw)
    if isinstance(parsed, WorkerContract):
        contract = parsed
        config = worker_contract_to_worker_config(contract, folder.name)
    else:
        config = parsed
        contract = worker_config_to_worker_contract(config)
    return config, contract


def discover_workers(use_cache: bool = False) -> List[Dict[str, Any]]:
    """Scan WORKERS_DIR for valid worker folders.

    A valid worker folder contains a ``worker.yml`` file.
    Malformed workers are returned with ``status == "error"`` so the UI
    can surface the problem rather than silently dropping them.
    """
    global _worker_cache
    if use_cache and _worker_cache is not None:
        return _worker_cache

    workers: List[Dict[str, Any]] = []
    if not WORKERS_DIR.is_dir():
        logger.warning("Workers directory does not exist: %s", WORKERS_DIR)
        return workers

    for folder in sorted(WORKERS_DIR.iterdir()):
        if not folder.is_dir():
            continue
        config_path = folder / "worker.yml"
        if not config_path.is_file():
            continue

        try:
            config, contract = _load_worker_manifest(folder)
            workers.append({
                "id": folder.name,
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
            })
        except Exception as exc:
            logger.warning("Failed to load worker %s: %s", folder.name, exc)
            workers.append({
                "id": folder.name,
                "name": folder.name,
                "description": f"Failed to load: {exc}",
                "config": {},
                "status": "error",
                "trigger_type": "manual",
                "runner": "e2b",
            })

    _worker_cache = workers
    return workers


def invalidate_worker_cache() -> None:
    global _worker_cache
    _worker_cache = None


def get_worker(worker_id: str) -> Optional[Dict[str, Any]]:
    for w in discover_workers(use_cache=True):
        if w["id"] == worker_id:
            return w
    return None


def get_worker_config(worker_id: str) -> Optional[WorkerConfig]:
    try:
        worker_dir = _safe_path(worker_id)
    except ValueError:
        return None
    config_path = worker_dir / "worker.yml"
    if not config_path.is_file():
        return None
    config, _contract = _load_worker_manifest(worker_dir)
    return config


def get_worker_contract(worker_id: str) -> Optional[WorkerContract]:
    try:
        worker_dir = _safe_path(worker_id)
    except ValueError:
        return None
    config_path = worker_dir / "worker.yml"
    if not config_path.is_file():
        return None
    _config, contract = _load_worker_manifest(worker_dir)
    return contract


def get_worker_entrypoint(worker_id: str) -> str:
    """Return the configured entrypoint for a worker (defaults to run.py)."""
    config = get_worker_config(worker_id)
    if config and config.runtime.entrypoint:
        return config.runtime.entrypoint
    return "run.py"
