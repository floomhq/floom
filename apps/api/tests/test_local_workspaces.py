from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def client_and_db(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-workspaces")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "auth.local_workspaces", "contexts",
        "chat_service",
    ]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-workspaces"}) as client:
        yield client, db
    db.get_repositories.cache_clear()


def _manifest(worker_id: str, name: str) -> str:
    return json.dumps(
        {
            "id": worker_id,
            "name": name,
            "trigger": {"type": "manual"},
            "runtime": {"type": "python", "entrypoint": "run.py", "runner": "local"},
            "inputs": [],
            "outputs": [],
            "secrets": [],
            "connections": [],
        }
    )


def _seed_legacy_worker(db, worker_id: str, *, workspace_id: str = "local-default") -> None:
    now = db.now_iso()
    with db.get_db() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO local_workspaces
                (id, owner_user_id, name, created_at)
            VALUES ('local-default', 'federico', 'federico', ?)
            """,
            (now,),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO workspace_members
                (workspace_id, user_id, role, status, created_at, updated_at)
            VALUES ('local-default', 'federico', 'owner', 'active', ?, ?)
            """,
            (now, now),
        )
    repos = db.get_repositories()
    repos.workers.create(
        user_id="federico",
        worker_id=worker_id,
        name=worker_id,
        manifest_json=_manifest(worker_id, worker_id),
        bundle_path=f"workers/{worker_id}",
        workspace_id=workspace_id or "local-default",
        visibility="private",
    )
    if workspace_id == "":
        with db.get_db() as conn:
            conn.execute(
                "UPDATE workers SET workspace_id = '' WHERE id = ?",
                (worker_id,),
            )


def test_local_workspaces_list_create_and_select(client_and_db):
    client, _db = client_and_db

    initial = client.get("/workspaces")
    assert initial.status_code == 200, initial.text
    body = initial.json()
    assert body["active_id"] == "local-default"
    assert [(row["id"], row["name"]) for row in body["workspaces"]] == [
        ("local-default", "federico")
    ]

    created = client.post("/workspaces", json={"name": "Side project"})
    assert created.status_code == 200, created.text
    workspace_id = created.json()["id"]
    assert workspace_id.startswith("ws_")

    selected = client.post(
        f"/workspaces/{workspace_id}/select",
        headers={"x-workeros-workspace": workspace_id},
    )
    assert selected.status_code == 200, selected.text
    assert selected.json()["name"] == "Side project"

    scoped = client.get("/workspaces", headers={"x-workeros-workspace": workspace_id})
    assert scoped.status_code == 200, scoped.text
    assert scoped.json()["active_id"] == workspace_id


def test_local_workspace_contexts_are_isolated(client_and_db):
    client, _db = client_and_db
    created = client.post("/workspaces", json={"name": "Isolated"})
    workspace_id = created.json()["id"]

    scoped_headers = {"x-workeros-workspace": workspace_id}
    created_context = client.post(
        "/contexts/isolated-pack",
        json={"writeable": True},
        headers=scoped_headers,
    )
    assert created_context.status_code == 200, created_context.text

    scoped_list = client.get("/contexts", headers=scoped_headers)
    assert scoped_list.status_code == 200, scoped_list.text
    assert any(item["name"] == "isolated-pack" for item in scoped_list.json())

    default_list = client.get("/contexts")
    assert default_list.status_code == 200, default_list.text
    assert all(item["name"] != "isolated-pack" for item in default_list.json())


def test_secret_auth_sees_legacy_private_workers(client_and_db):
    client, db = client_and_db
    _seed_legacy_worker(db, "legacy-private-local-default")
    _seed_legacy_worker(db, "legacy-private-empty-workspace", workspace_id="")
    _seed_legacy_worker(db, "smoke-fl1-db-owned")

    listing = client.get("/workers")
    assert listing.status_code == 200, listing.text
    ids = {row["id"] for row in listing.json()}
    assert "legacy-private-local-default" in ids
    assert "legacy-private-empty-workspace" in ids
    assert "smoke-fl1-db-owned" in ids

    detail = client.get("/workers/legacy-private-empty-workspace")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["owner_id"] == "federico"
    assert body["visibility"] == "private"
    assert body["permissions"]["is_owner"] is True


def test_federico_login_maps_to_legacy_worker_owner(client_and_db):
    client, db = client_and_db
    _seed_legacy_worker(db, "legacy-session-worker")

    setup = client.post(
        "/auth/setup",
        json={"username": "federico", "password": "federico-pass"},
    )
    assert setup.status_code == 201, setup.text
    me = client.get("/auth/me")
    assert me.status_code == 200, me.text
    assert me.json()["username"] == "federico"
    assert me.json()["auth_method"] == "session"

    listing = client.get("/workers")
    assert listing.status_code == 200, listing.text
    rows = listing.json()
    worker = next(row for row in rows if row["id"] == "legacy-session-worker")
    assert worker["owner_id"] == "federico"
    assert worker["permissions"]["is_owner"] is True

    detail = client.get("/workers/legacy-session-worker")
    assert detail.status_code == 200, detail.text
    assert detail.json()["permissions"]["can_share"] is True
