import os
import yaml
import json
from typing import List, Dict, Any, Optional
from models import WorkerConfig

WORKERS_DIR = os.environ.get("FLOOM_WORKERS_DIR", "../../workers")


def discover_workers() -> List[Dict[str, Any]]:
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
                print(f"Failed to load worker {folder}: {e}")
                workers.append({
                    "id": folder,
                    "name": folder,
                    "description": f"Failed to load: {e}",
                    "config": {},
                    "status": "error",
                    "trigger_type": "manual",
                    "runner": "local",
                })
    return workers


def get_worker(worker_id: str) -> Optional[Dict[str, Any]]:
    for w in discover_workers():
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
