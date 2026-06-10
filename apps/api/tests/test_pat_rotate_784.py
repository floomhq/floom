"""#784 — rotating a PAT issues a new secret, keeps the same id/name, and
immediately invalidates the old secret.
"""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def load_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", "")
    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "run_service",
        "auth", "auth.context", "auth.dependency", "auth.factory", "auth.interface",
        "auth.local", "auth.multi_member", "auth.local_workspaces", "chat_service",
        "scheduler",
    ]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None)
    return importlib.import_module("main")


def test_rotate_swaps_secret_keeps_identity(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = load_main(monkeypatch, tmp_path)
    with TestClient(main.app, base_url="https://testserver") as c:
        c.post("/auth/setup", json={"username": "alice", "password": "password123"})
        created = c.post("/auth/tokens", json={"name": "ci-token"}).json()
        old_raw = created["token"]
        token_id = created["pat"]["id"]

        rotated = c.post(f"/auth/tokens/{token_id}/rotate")
        assert rotated.status_code == 200, rotated.text
        body = rotated.json()
        new_raw = body["token"]
        assert new_raw.startswith("wos_")
        assert new_raw != old_raw
        # Same identity preserved.
        assert body["pat"]["id"] == token_id
        assert body["pat"]["name"] == "ci-token"

        # Old secret no longer authenticates; new one does.
        c_old = TestClient(main.app, base_url="https://testserver")
        assert c_old.get("/auth/me", headers={"Authorization": f"Bearer {old_raw}"}).status_code == 401
        c_new = TestClient(main.app, base_url="https://testserver")
        me = c_new.get("/auth/me", headers={"Authorization": f"Bearer {new_raw}"})
        assert me.status_code == 200, me.text
        assert me.json()["username"] == "alice"


def test_rotate_unknown_token_404(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = load_main(monkeypatch, tmp_path)
    with TestClient(main.app, base_url="https://testserver") as c:
        c.post("/auth/setup", json={"username": "alice", "password": "password123"})
        resp = c.post("/auth/tokens/does-not-exist/rotate")
        assert resp.status_code == 404, resp.text
