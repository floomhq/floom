from __future__ import annotations

import importlib
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
