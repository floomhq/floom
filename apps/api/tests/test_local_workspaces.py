from __future__ import annotations

import importlib
import json
import os
import sys
import types
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from auth.local_workspaces import local_workspace_user_id


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
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
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
    with TestClient(
        main.app,
        headers={"x-floom-secret": "test-secret-workspaces"},
        base_url="https://testserver",
    ) as client:
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


def _manifest_with_connections(worker_id: str, name: str, connections: list[str]) -> str:
    payload = json.loads(_manifest(worker_id, name))
    payload["connections"] = connections
    return json.dumps(payload)


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


def _seed_workspace_owner(db, workspace_id: str, user_id: str) -> None:
    now = db.now_iso()
    with db.get_db() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO workspace_members
                (workspace_id, user_id, role, status, created_at, updated_at)
            VALUES (?, ?, 'owner', 'active', ?, ?)
            """,
            (workspace_id, user_id, now, now),
        )


def _seed_workspace_connection(db, *, user_id: str, connection_id: str, app_name: str, workspace_label: str) -> None:
    repos = db.get_repositories()
    now = db.now_iso()
    repos.connections.upsert(
        user_id=user_id,
        id=connection_id,
        app_name=app_name,
        composio_connection_id=f"ca_{connection_id}",
        status="active",
        account_label=f"{workspace_label}@example.com",
        created_at=now,
        updated_at=now,
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
    assert "smoke-fl1-db-owned" not in ids

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
        json={"username": "federico", "password": "ramen-stapler-42"},
    )
    assert setup.status_code == 201, setup.text
    me = client.get("/auth/me", headers={"x-floom-secret": ""})
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


def test_uuid_admin_session_sees_legacy_default_brain_packs(client_and_db, monkeypatch):
    client, _db = client_and_db
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")

    contexts_dir = Path(os.environ["FLOOM_CONTEXTS_DIR"])
    legacy_pack = contexts_dir / "federico" / "company"
    legacy_pack.mkdir(parents=True)
    (legacy_pack / "README.md").write_text("# Company\nlegacy default brain.\n", encoding="utf-8")
    (contexts_dir / "federico" / ".workeros-contexts.json").write_text(
        '{"company": {"owner_id": "federico", "writeable": true}}\n',
        encoding="utf-8",
    )

    setup = client.post(
        "/auth/setup",
        json={"username": "fede", "password": "ramen-stapler-42"},
    )
    assert setup.status_code == 201, setup.text
    assert setup.json()["id"] != "federico"

    me = client.get("/auth/me")
    assert me.status_code == 200, me.text
    assert me.json()["username"] == "fede"
    assert me.json()["auth_method"] == "session"

    listing = client.get("/contexts")
    assert listing.status_code == 200, listing.text
    packs = {row["name"]: row for row in listing.json()}
    assert "company" in packs
    assert packs["company"]["owner_id"] == "federico"
    assert packs["company"]["permissions"]["is_owner"] is True
    assert packs["company"]["permissions"]["can_edit"] is True

    detail = client.get("/contexts/company")
    assert detail.status_code == 200, detail.text
    assert [file["path"] for file in detail.json()["files"]] == ["README.md"]

    file_resp = client.get("/contexts/company/files/README.md")
    assert file_resp.status_code == 200, file_resp.text
    assert "legacy default brain" in file_resp.text


def test_side_workspace_workers_are_isolated_and_editable(client_and_db):
    client, db = client_and_db
    created = client.post("/workspaces", json={"name": "Side workspace"})
    assert created.status_code == 200, created.text
    workspace_id = created.json()["id"]
    scoped_user_id = local_workspace_user_id("federico", workspace_id)

    _seed_workspace_owner(db, workspace_id, scoped_user_id)
    _seed_legacy_worker(db, "default-worker")
    repos = db.get_repositories()
    repos.workers.create(
        user_id=scoped_user_id,
        worker_id="side-worker",
        name="side-worker",
        manifest_json=_manifest_with_connections("side-worker", "side-worker", ["gmail"]),
        bundle_path="workers/side-worker",
        workspace_id=workspace_id,
        visibility="private",
    )
    _seed_workspace_connection(
        db,
        user_id=scoped_user_id,
        connection_id="side-gmail",
        app_name="gmail",
        workspace_label="side",
    )

    default_list = client.get("/workers?shape=list")
    assert default_list.status_code == 200, default_list.text
    default_ids = {row["id"] for row in default_list.json()}
    assert "default-worker" in default_ids
    assert "side-worker" not in default_ids

    scoped_headers = {"x-workeros-workspace": workspace_id}
    side_list = client.get("/workers?shape=list", headers=scoped_headers)
    assert side_list.status_code == 200, side_list.text
    side_rows = side_list.json()
    side_ids = {row["id"] for row in side_rows}
    assert side_ids == {"side-worker"}
    side_row = side_rows[0]
    assert side_row["permissions"]["can_run"] is True
    assert side_row["permissions"]["can_edit"] is True
    assert side_row["missing_connections"] == []

    detail = client.get("/workers/side-worker", headers=scoped_headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["permissions"]["can_run"] is True
    assert detail.json()["permissions"]["can_edit"] is True

    update = client.patch(
        "/workers/side-worker",
        json={"input_values": {"example": "updated"}},
        headers=scoped_headers,
    )
    assert update.status_code == 200, update.text
    assert update.json()["permissions"]["can_edit"] is True


def test_connections_are_scoped_to_the_active_workspace(client_and_db):
    client, db = client_and_db
    created = client.post("/workspaces", json={"name": "Connections workspace"})
    assert created.status_code == 200, created.text
    workspace_id = created.json()["id"]
    scoped_user_id = local_workspace_user_id("federico", workspace_id)

    _seed_workspace_owner(db, workspace_id, scoped_user_id)
    repos = db.get_repositories()
    now = db.now_iso()
    repos.connections.upsert(
        user_id="federico",
        id="default-gmail",
        app_name="gmail",
        composio_connection_id="ca_default",
        status="active",
        account_label="default@example.com",
        created_at=now,
        updated_at=now,
    )
    repos.connections.upsert(
        user_id=scoped_user_id,
        id="side-gmail",
        app_name="gmail",
        composio_connection_id="ca_side",
        status="active",
        account_label="side@example.com",
        created_at=now,
        updated_at=now,
    )

    default_list = client.get("/connections")
    assert default_list.status_code == 200, default_list.text
    default_ids = {row["id"] for row in default_list.json()}
    assert default_ids == {"default-gmail"}

    scoped_headers = {"x-workeros-workspace": workspace_id}
    side_list = client.get("/connections", headers=scoped_headers)
    assert side_list.status_code == 200, side_list.text
    side_ids = {row["id"] for row in side_list.json()}
    assert side_ids == {"side-gmail"}

    by_app = client.get("/connections/by-app/gmail", headers=scoped_headers)
    assert by_app.status_code == 200, by_app.text
    assert by_app.json()["connected"] is True
    assert {row["id"] for row in by_app.json()["accounts"]} == {"side-gmail"}



def test_rename_workspace(client_and_db):
    # #791: PATCH /workspaces/{id} renames an owner's workspace.
    client, _db = client_and_db
    wid = client.post("/workspaces", json={"name": "Old name"}).json()["id"]

    renamed = client.patch(f"/workspaces/{wid}", json={"name": "New name"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "New name"

    listing = client.get("/workspaces").json()["workspaces"]
    assert any(w["id"] == wid and w["name"] == "New name" for w in listing)

    assert client.patch("/workspaces/ws_doesnotexist", json={"name": "x"}).status_code == 404
    assert client.patch(f"/workspaces/{wid}", json={"name": ""}).status_code == 422
