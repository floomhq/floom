"""#794/#797 — workspace settings KV: round-trip + member write-guard (#804 model)."""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "ws-settings-794"


@pytest.fixture
def app_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in ["db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                 "db.interface", "models", "worker_registry", "run_service", "scheduler",
                 "auth", "auth.context", "auth.dependency", "main"]:
        sys.modules.pop(name, None)
        for _rn in [n for n in list(sys.modules) if n.startswith(("routers", "services", "core"))]:
            sys.modules.pop(_rn, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    yield main
    main.app.dependency_overrides.clear()
    db.get_repositories.cache_clear()


@pytest.fixture
def client(app_main):
    from fastapi.testclient import TestClient
    with TestClient(app_main.app, headers={"x-floom-secret": _SECRET}) as c:
        yield c


def _as_role(main, **ctx):
    from auth import AuthContext, get_auth_context
    main.app.dependency_overrides[get_auth_context] = lambda: AuthContext(**ctx)


def test_admin_round_trip(app_main, client):
    _as_role(app_main, user_id="alice", role="admin")
    assert client.get("/workspace/settings").json() == {}

    assert client.put("/workspace/settings/approval_default", json={"value": "required"}).status_code == 204
    assert client.put("/workspace/settings/auto_pause", json={"value": "true"}).status_code == 204
    assert client.get("/workspace/settings").json() == {
        "approval_default": "required",
        "auto_pause": "true",
    }
    # Upsert overwrites.
    assert client.put("/workspace/settings/auto_pause", json={"value": "false"}).status_code == 204
    assert client.get("/workspace/settings").json()["auto_pause"] == "false"


def test_member_cannot_write(app_main, client):
    _as_role(app_main, user_id="bob", role="member", auth_method="session")
    resp = client.put("/workspace/settings/approval_default", json={"value": "off"})
    assert resp.status_code == 403, resp.text
