"""#975 + #976 — user-management hardening.

#975: POST /users must never accept a role from the request body; new users
are always 'member'. Promotion is an explicit PATCH (admin-gated, auditable).
#976: an admin must not be able to disable or demote the LAST active admin
(self-disable included) — that permanently locks the workspace out.

Run: cd apps/api && python -m pytest tests/test_975_976_user_admin_guards.py -q
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


def _load_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", "")
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("db", "auth", "contexts")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None
    )
    return importlib.import_module("main")


@pytest.fixture
def admin_client(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    main = _load_main(monkeypatch, tmp_path)
    with TestClient(main.app, raise_server_exceptions=False, base_url="https://testserver") as c:
        resp = c.post("/auth/setup", json={"username": "admin", "password": "trombone-hunter7"})
        assert resp.status_code == 201, resp.text
        yield c, main


def _admin_id(client) -> str:
    return client.get("/auth/me").json()["user_id"]


class TestRoleInjection:
    def test_create_ignores_admin_role_in_body(self, admin_client):
        client, _ = admin_client
        resp = client.post(
            "/users",
            json={
                "username": "backdoor",
                "password": "Hacked123456!",
                "display_name": "Backdoor",
                "role": "admin",
            },
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["role"] == "member", "role from body must be ignored (#975)"

    def test_create_defaults_to_member(self, admin_client):
        client, _ = admin_client
        resp = client.post("/users", json={"username": "plain", "password": "Hacked123456!"})
        assert resp.status_code == 201, resp.text
        assert resp.json()["role"] == "member"

    def test_promotion_still_available_via_patch(self, admin_client):
        client, _ = admin_client
        uid = client.post(
            "/users", json={"username": "promoteme", "password": "Hacked123456!"}
        ).json()["id"]
        resp = client.patch(f"/users/{uid}", json={"role": "admin"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["role"] == "admin"


class TestLastAdminGuard:
    def test_cannot_self_disable_as_only_admin(self, admin_client):
        client, _ = admin_client
        resp = client.patch(f"/users/{_admin_id(client)}", json={"disabled": True})
        assert resp.status_code == 409, resp.text
        assert "at least one active admin" in resp.json()["detail"].lower()
        # still usable
        assert client.get("/auth/me").status_code == 200

    def test_cannot_demote_only_admin(self, admin_client):
        client, _ = admin_client
        resp = client.patch(f"/users/{_admin_id(client)}", json={"role": "member"})
        assert resp.status_code == 409, resp.text

    def test_can_self_disable_when_another_admin_exists(self, admin_client):
        client, main = admin_client
        # promote a second admin
        uid2 = client.post(
            "/users", json={"username": "admin2", "password": "Hacked123456!"}
        ).json()["id"]
        assert client.patch(f"/users/{uid2}", json={"role": "admin"}).status_code == 200
        # now the first admin may step down
        resp = client.patch(f"/users/{_admin_id(client)}", json={"disabled": True})
        assert resp.status_code == 200, resp.text
        assert resp.json()["disabled"] is True

    def test_can_disable_a_non_last_admin(self, admin_client):
        client, _ = admin_client
        uid2 = client.post(
            "/users", json={"username": "admin2", "password": "Hacked123456!"}
        ).json()["id"]
        assert client.patch(f"/users/{uid2}", json={"role": "admin"}).status_code == 200
        # disabling the SECOND admin is fine — the first stays active
        resp = client.patch(f"/users/{uid2}", json={"disabled": True})
        assert resp.status_code == 200, resp.text
