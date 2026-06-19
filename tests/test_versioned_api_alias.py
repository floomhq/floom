from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi.testclient import TestClient


def _load_app(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    if str(api_dir) not in sys.path:
        sys.path.insert(0, str(api_dir))

    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "workeros.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "workeros.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")

    for name in [
        "main",
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "models",
        "worker_registry",
        "run_service",
        "chat_service",
    ]:
        sys.modules.pop(name, None)
    return importlib.import_module("main")


def test_versioned_api_aliases_reach_version_routes(monkeypatch, tmp_path):
    main = _load_app(monkeypatch, tmp_path)
    client = TestClient(main.app)
    headers = {"x-floom-secret": "test-secret"}

    empty_version_paths = [
        "/api/v1/workspace/versions",
        "/v1/workspace/versions",
    ]

    for path in empty_version_paths:
        response = client.get(path, headers=headers)
        assert response.status_code == 200, (path, response.text)
        assert response.json() == []

    missing_worker_paths = [
        "/api/v1/workers/example/versions",
        "/v1/workers/example/versions",
    ]
    for path in missing_worker_paths:
        response = client.get(path, headers=headers)
        assert response.status_code == 404, (path, response.text)
        assert response.json() == {"detail": "Worker not found"}
