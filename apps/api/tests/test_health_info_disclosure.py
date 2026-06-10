"""#853 — /health must not leak internal infrastructure details without auth.

RCA: the unauthenticated ``/health`` endpoint returned the full dependency
check payload — disk free space, E2B/OpenAI/Composio connectivity, scheduler
thread name — handing reconnaissance data to anyone who can reach the port.

Fix: ``/health`` now returns only ``{"status", "checked_at"}`` (all a probe
needs); the detailed checks moved to ``/health/details`` which requires an
admin auth context.

Run:
    cd apps/api && python -m pytest tests/test_health_info_disclosure.py -v
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-health-secret"


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def test_public_health_is_minimal(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    from fastapi.testclient import TestClient

    with TestClient(main.app, raise_server_exceptions=False) as client:
        resp = client.get("/health")

    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"status", "checked_at"}
    assert "checks" not in body


def test_health_details_requires_auth(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    from fastapi.testclient import TestClient

    with TestClient(main.app, raise_server_exceptions=False) as client:
        resp = client.get("/health/details")

    assert resp.status_code == 401


def test_health_details_with_admin_secret_returns_checks(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    from fastapi.testclient import TestClient

    with TestClient(main.app, raise_server_exceptions=False) as client:
        resp = client.get("/health/details", headers={"x-floom-secret": SECRET})

    assert resp.status_code == 200
    assert "checks" in resp.json()
