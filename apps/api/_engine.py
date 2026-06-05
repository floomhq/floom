from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def engine_workers_dir() -> Path:
    return repo_root() / "engine" / "workers"


def configure_cloud_workers_dir() -> Path | None:
    """Point engine worker discovery at the vendored engine workers tree.

    The engine computes ``worker_registry.WORKERS_DIR`` at import time from
    ``FLOOM_WORKERS_DIR``. Cloud imports engine modules through this helper, so
    this is the earliest reliable cloud-owned place to set the env var.
    """
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower()
    if deploy != "cloud":
        return None

    configured = (os.environ.get("WORKEROS_WORKERS_DIR") or "").strip()
    workers_dir = Path(configured).expanduser().resolve() if configured else engine_workers_dir()
    os.environ["FLOOM_WORKERS_DIR"] = str(workers_dir)
    return workers_dir


def engine_api_dir() -> Path:
    return repo_root() / "engine" / "apps" / "api"


def ensure_engine_api_path() -> Path:
    configure_cloud_workers_dir()
    path = engine_api_dir()
    if not path.is_dir():
        raise RuntimeError(
            f"Vendored workeros engine missing at {path}. "
            "Run `git submodule update --init --recursive`."
        )
    path_str = str(path)
    if path_str not in sys.path:
        sys.path.insert(0, path_str)
    return path


def import_engine_module(name: str):
    ensure_engine_api_path()
    return importlib.import_module(name)


configure_cloud_workers_dir()
