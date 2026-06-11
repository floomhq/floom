"""#773 — per-user settings KV (theme persistence): upsert + read back."""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "settings-secret-773"


@pytest.fixture
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in ["db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                 "db.interface", "models", "worker_registry", "run_service", "scheduler", "main"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient
    yield TestClient(main.app, headers={"x-floom-secret": _SECRET})
    db.get_repositories.cache_clear()


def test_settings_upsert_and_read(client):
    assert client.get("/me/settings").json() == {}

    assert client.put("/me/settings/theme", json={"value": "night"}).status_code == 204
    assert client.get("/me/settings").json() == {"theme": "night"}

    # Upsert overwrites.
    assert client.put("/me/settings/theme", json={"value": "day"}).status_code == 204
    assert client.get("/me/settings").json() == {"theme": "day"}

    # A second key coexists.
    assert client.put("/me/settings/density", json={"value": "compact"}).status_code == 204
    assert client.get("/me/settings").json() == {"theme": "day", "density": "compact"}
