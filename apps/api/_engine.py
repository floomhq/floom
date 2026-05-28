from __future__ import annotations

import importlib
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def engine_api_dir() -> Path:
    return repo_root() / "engine" / "apps" / "api"


def ensure_engine_api_path() -> Path:
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
