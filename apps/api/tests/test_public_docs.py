from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi.testclient import TestClient


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1]
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", "docs-test-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "docs-test-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    sys.path.insert(0, str(api_dir))
    for name in list(sys.modules):
        if name == "main" or name == "db" or name == "auth" or name.startswith("db.") or name.startswith("auth.") or name.startswith("routers"):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def test_openapi_and_docs_are_public_when_api_secret_is_set(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app) as client:
        openapi = client.get("/openapi.json")
        docs = client.get("/docs")
        redoc = client.get("/redoc")

    assert openapi.status_code == 200
    assert openapi.json()["openapi"]
    assert docs.status_code == 200
    assert "Swagger UI" in docs.text
    assert redoc.status_code == 200
