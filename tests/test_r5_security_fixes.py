from __future__ import annotations

import importlib
import os
import sys
import types

from fastapi.testclient import TestClient


API_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)


_AUTH_HEADER = {"x-floom-secret": "test-secret-r5"}


def _load_api(monkeypatch, tmp_path, *, workeros_dev: bool = False):
    workers_dir = tmp_path / "workers"
    blobs_dir = tmp_path / "blobs"
    workers_dir.mkdir()
    blobs_dir.mkdir()

    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(blobs_dir))
    monkeypatch.setenv("FLOOM_SECRET", _AUTH_HEADER["x-floom-secret"])
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("E2B_API_KEY", "e2b-test")
    monkeypatch.setenv("COMPOSIO_API_KEY", "cmp-test")
    monkeypatch.setenv("COMPOSIO_WEBHOOK_SIGNING_KEY", "whsec-test")
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://workers.floom.dev")
    if workeros_dev:
        monkeypatch.setenv("WORKEROS_DEV", "1")
    else:
        monkeypatch.delenv("WORKEROS_DEV", raising=False)

    for name in [
        "main",
        "db",
        "files",
        "models",
        "worker_registry",
        "run_service",
        "composio_client",
        "scheduler",
    ]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def test_cors_preflight_rejects_localhost_origin_in_prod(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, workeros_dev=False)
    client = TestClient(main.app)

    resp = client.options(
        "/workers",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert resp.headers.get("access-control-allow-origin") != "http://localhost:3000"


def test_cors_preflight_allows_production_frontend(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, workeros_dev=False)
    client = TestClient(main.app)

    resp = client.options(
        "/workers",
        headers={
            "Origin": "https://workers.floom.dev",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert resp.headers.get("access-control-allow-origin") == "https://workers.floom.dev"
