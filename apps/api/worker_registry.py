import os
import yaml
import json
from typing import List, Dict, Any, Optional
from models import WorkerConfig

WORKERS_DIR = os.environ.get("FLOOM_WORKERS_DIR", "../../workers")

_worker_cache: Optional[List[Dict[str, Any]]] = None

def discover_workers(use_cache: bool = False) -> List[Dict[str, Any]]:
    global _worker_cache
    if use_cache and _worker_cache is not None:
        return _worker_cache

    workers = []
    if not os.path.isdir(WORKERS_DIR):
        return workers

    for folder in sorted(os.listdir(WORKERS_DIR)):
        path = os.path.join(WORKERS_DIR, folder)
        config_path = os.path.join(path, "worker.yml")
        if os.path.isdir(path) and os.path.isfile(config_path):
            try:
                with open(config_path, "r") as f:
                    raw = yaml.safe_load(f)
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
            except Exception as e:
                import logging
                logging.warning(f"Failed to load worker {folder}: {e}")
                workers.append({
                    "id": folder,
                    "name": folder,
                    "description": f"Failed to load: {e}",
                    "config": {},
                    "status": "error",
                    "trigger_type": "manual",
                    "runner": "local",
                })
    _worker_cache = workers
    return workers


def invalidate_worker_cache():
    global _worker_cache
    _worker_cache = None


def get_worker(worker_id: str) -> Optional[Dict[str, Any]]:
    for w in discover_workers(use_cache=True):
        if w["id"] == worker_id:
            return w
    return None


def get_worker_config(worker_id: str) -> Optional[WorkerConfig]:
    path = os.path.join(WORKERS_DIR, worker_id, "worker.yml")
    if not os.path.isfile(path):
        return None
    with open(path, "r") as f:
        raw = yaml.safe_load(f)
    return WorkerConfig(**raw)
