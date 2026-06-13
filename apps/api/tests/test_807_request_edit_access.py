"""#807 — member can request edit access on a locked (workspace-shared) worker.

POST /workers/{id}/request-edit: 404 if not visible, 403 if caller already has
edit, else records a pending request (idempotent) + notifies the owner.
GET /workers/{id}/edit-requests: owner/admin lists pending requests.

Run: cd apps/api && python -m pytest tests/test_807_request_edit_access.py -q
"""
from __future__ import annotations

import hashlib
import importlib
import sys
import textwrap
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-807"
ADMIN = {"x-floom-secret": SECRET}
MEMBER_TOKEN = "wos_member807"
MEMBER = {"Authorization": f"Bearer {MEMBER_TOKEN}"}


def _yml(worker_id: str) -> str:
    return textwrap.dedent(
        f"""
        schema_version: "0.3"
        id: "{worker_id}"
        name: "{worker_id}"
        title: t
        description: d
        version: "0.1.0"
        exec:
          entry: run.py
          runtime: python311
          runner: e2b
          command: python run.py
          inputs: []
          outputs: []
        trigger:
          type: manual
        connections: []
        """
    ).strip() + "\n"


@pytest.fixture
def client_main(monkeypatch, tmp_path):
    (tmp_path / "workers").mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_USER_ID", "admin-807")
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("routers", "services", "core", "db", "auth", "contexts")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from db import get_db, now_iso

    with get_db() as conn:
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, created_at, updated_at) "
            "VALUES ('member-807', 'member-807', 'x', 'member', ?, ?)",
            (now_iso(), now_iso()),
        )
        conn.execute(
            "INSERT INTO cli_api_tokens (id, token_hash, user_id, role, name, created_at) "
            "VALUES ('t807', ?, 'member-807', 'member', 'm', ?)",
            (hashlib.sha256(MEMBER_TOKEN.encode()).hexdigest(), now_iso()),
        )
    from fastapi.testclient import TestClient

    client = TestClient(main.app, raise_server_exceptions=False)
    return client, main


def _shared_worker(client, worker_id):
    # member creates + shares (donation model: now workspace-owned, member can
    # view but not edit — i.e. "locked")
    assert client.post("/workers", headers=MEMBER, json={"worker_yml": _yml(worker_id), "run_py": "print(1)"}).status_code == 200
    assert client.put(f"/workers/{worker_id}/visibility", headers=MEMBER, json={"visibility": "workspace"}).status_code == 200


def test_member_requests_edit_on_locked_worker(client_main):
    client, _ = client_main
    _shared_worker(client, "locked-w")
    resp = client.post("/workers/locked-w/request-edit", headers=MEMBER, json={"message": "need to tweak the prompt"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["ok"] is True

    # admin sees the pending request
    reqs = client.get("/workers/locked-w/edit-requests", headers=ADMIN)
    assert reqs.status_code == 200, reqs.text
    rows = reqs.json()
    assert len(rows) == 1
    assert rows[0]["requester_id"] == "member-807"
    assert rows[0]["message"] == "need to tweak the prompt"


def test_request_is_idempotent(client_main):
    client, _ = client_main
    _shared_worker(client, "locked-w2")
    assert client.post("/workers/locked-w2/request-edit", headers=MEMBER, json={}).status_code == 201
    assert client.post("/workers/locked-w2/request-edit", headers=MEMBER, json={}).status_code == 201
    rows = client.get("/workers/locked-w2/edit-requests", headers=ADMIN).json()
    assert len(rows) == 1, "duplicate pending requests must collapse to one"


def test_owner_with_edit_gets_403(client_main):
    client, _ = client_main
    # admin owns nothing locked here; create an admin-private worker and request on it
    assert client.post("/workers", headers=ADMIN, json={"worker_yml": _yml("admin-w"), "run_py": "print(1)"}).status_code == 200
    resp = client.post("/workers/admin-w/request-edit", headers=ADMIN, json={})
    assert resp.status_code == 403, resp.text
    assert "already have edit" in resp.json()["detail"].lower()


def test_request_on_invisible_worker_404(client_main):
    client, _ = client_main
    # admin-private worker, member cannot see it
    assert client.post("/workers", headers=ADMIN, json={"worker_yml": _yml("hidden-w"), "run_py": "print(1)"}).status_code == 200
    resp = client.post("/workers/hidden-w/request-edit", headers=MEMBER, json={})
    assert resp.status_code == 404, resp.text


def test_member_cannot_list_edit_requests(client_main):
    client, _ = client_main
    _shared_worker(client, "locked-w3")
    client.post("/workers/locked-w3/request-edit", headers=MEMBER, json={})
    resp = client.get("/workers/locked-w3/edit-requests", headers=MEMBER)
    assert resp.status_code == 403, resp.text
