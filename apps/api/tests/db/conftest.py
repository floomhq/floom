from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[2]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _manifest(worker_id: str, name: str) -> dict[str, object]:
    return {
        "id": worker_id,
        "name": name,
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
    }


def load_db(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    for name in list(sys.modules):
        if name in {
            "db",
            "db._legacy_sqlite",
            "db.sqlite",
            "db.factory",
            "db.dependency",
            "db.interface",
            "models",
        } or name.startswith("services."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return db


@pytest.fixture
def repo_bundle(monkeypatch, tmp_path):
    db = load_db(monkeypatch, tmp_path)
    repos = db.get_repositories()
    yield repos, db, _manifest
    db.get_repositories.cache_clear()
