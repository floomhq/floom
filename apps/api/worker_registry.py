"""Worker discovery from the filesystem with caching and path-safety."""

import os
import yaml
import logging
from typing import List, Dict, Any, Optional
from pathlib import Path

from models import WorkerConfig

logger = logging.getLogger("floom.worker_registry")

WORKERS_DIR = Path(os.environ.get("FLOOM_WORKERS_DIR", "../../workers")).resolve()

_worker_cache: Optional[List[Dict[str, Any]]] = None


def _safe_path(*parts: str) -> Path:
    """Resolve a path under WORKERS_DIR, rejecting traversal escapes."""
    target = WORKERS_DIR.joinpath(*parts).resolve()
    # Ensure the resolved path is still under WORKERS_DIR
    if not str(target).startswith(str(WORKERS_DIR)):
        raise ValueError(f"Path traversal attempt: {target}")
    return target


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
            raw = yaml.safe_load(config_path.read_text())
            if not isinstance(raw, dict):
                raise ValueError("worker.yml must contain a YAML mapping")
            config = WorkerConfig(**raw)
            workers.append({
                "id": config.id,
                "name": config.name,
                "description": config.description,
                "config": config.model_dump(),
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
                "runner": "local",
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
        config_path = _safe_path(worker_id, "worker.yml")
    except ValueError:
        return None
    if not config_path.is_file():
        return None
    raw = yaml.safe_load(config_path.read_text())
    return WorkerConfig(**raw)


def get_worker_entrypoint(worker_id: str) -> str:
    """Return the configured entrypoint for a worker (defaults to run.py)."""
    config = get_worker_config(worker_id)
    if config and config.runtime.entrypoint:
        return config.runtime.entrypoint
    return "run.py"
