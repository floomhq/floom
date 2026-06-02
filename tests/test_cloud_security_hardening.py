from __future__ import annotations

import importlib
import sys
import types
from collections import Counter

from fastapi.testclient import TestClient


def _load_cloud_app(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-that-cloud-must-strip")
    monkeypatch.delenv("WORKEROS_RATE_LIMIT_DEV", raising=False)

    psycopg = types.ModuleType("psycopg")
    psycopg.Connection = object
    psycopg.connect = lambda *_args, **_kwargs: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)

    for name in [
        "apps.api.main",
        "main",
        "db",
        "models",
        "worker_registry",
        "run_service",
        "chat_service",
    ]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


def test_cloud_healthz_gets_security_headers(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)
    client = TestClient(main.app)

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "deploy": "cloud"}
    assert response.headers["Strict-Transport-Security"] == "max-age=31536000; includeSubDomains"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "microphone=()" in response.headers["Permissions-Policy"]
    assert response.headers["Content-Security-Policy"] == "default-src 'none'; frame-ancestors 'none'"


def test_cloud_enables_engine_rate_limiter_without_floom_secret(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)
    client = TestClient(main.app)

    codes = [client.get("/workers").status_code for _ in range(25)]

    assert main.os.environ["WORKEROS_RATE_LIMIT_DEV"] == "1"
    assert "FLOOM_SECRET" not in main.os.environ
    assert Counter(codes) == Counter({401: 20, 429: 5})
