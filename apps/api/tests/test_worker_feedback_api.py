from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "test-secret-feedback"


@pytest.fixture
def client_repos_db(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", "owner-1")
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    (tmp_path / "workers").mkdir()
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "worker_registry",
        "runner_utils",
        "run_service",
        "main",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": _SECRET})
    repos = db.get_repositories()
    yield client, repos, db
    db.get_repositories.cache_clear()


def _headers(user_id: str) -> dict[str, str]:
    return {"x-floom-secret": _SECRET, "x-floom-user": user_id}


def _manifest(worker_id: str) -> dict:
    return {
        "id": worker_id,
        "name": "Feedback Worker",
        "version": "0.1.0",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
    }


def _seed_workspace_worker(repos, db, *, visibility: str = "workspace") -> None:
    repos.workers.create(
        user_id="owner-1",
        worker_id="feedback-worker",
        name="Feedback Worker",
        manifest_json=_manifest("feedback-worker"),
        bundle_path="workers/feedback-worker",
        visibility=visibility,
        workspace_id="local-default",
    )
    now = db.now_iso()
    with db.get_db() as conn:
        for user_id, role in (("owner-1", "owner"), ("member-1", "member")):
            conn.execute(
                """
                INSERT INTO workspace_members
                    (workspace_id, user_id, role, status, created_at, updated_at)
                VALUES ('local-default', ?, ?, 'active', ?, ?)
                ON CONFLICT(workspace_id, user_id) DO UPDATE SET
                    role = excluded.role,
                    status = excluded.status,
                    updated_at = excluded.updated_at
                """,
                (user_id, role, now, now),
            )


def test_member_can_create_and_list_feedback_for_workspace_worker(client_repos_db):
    client, repos, db = client_repos_db
    _seed_workspace_worker(repos, db)

    created = client.post(
        "/workers/feedback-worker/feedback",
        headers=_headers("member-1"),
        json={"body": "The summary needs a shorter executive section."},
    )

    assert created.status_code == 201, created.text
    item = created.json()
    assert item["worker_id"] == "feedback-worker"
    assert item["author_id"] == "member-1"
    assert item["body"] == "The summary needs a shorter executive section."
    assert item["resolved"] is False

    listed = client.get("/workers/feedback-worker/feedback", headers=_headers("member-1"))
    assert listed.status_code == 200, listed.text
    assert [row["id"] for row in listed.json()] == [item["id"]]


def test_member_cannot_resolve_owner_can_resolve_feedback(client_repos_db):
    client, repos, db = client_repos_db
    _seed_workspace_worker(repos, db)

    created = client.post(
        "/workers/feedback-worker/feedback",
        headers=_headers("member-1"),
        json={"body": "Please add examples before launch."},
    ).json()

    member_resolve = client.patch(
        f"/workers/feedback-worker/feedback/{created['id']}",
        headers=_headers("member-1"),
        json={"resolved": True},
    )
    assert member_resolve.status_code == 403, member_resolve.text

    owner_resolve = client.patch(
        f"/workers/feedback-worker/feedback/{created['id']}",
        headers=_headers("owner-1"),
        json={"resolved": True},
    )
    assert owner_resolve.status_code == 200, owner_resolve.text
    resolved = owner_resolve.json()
    assert resolved["resolved"] is True
    assert resolved["resolved_by"] == "owner-1"
    assert resolved["resolved_at"]

    unresolved = client.get("/workers/feedback-worker/feedback", headers=_headers("member-1"))
    assert unresolved.status_code == 200
    assert unresolved.json() == []

    all_rows = client.get(
        "/workers/feedback-worker/feedback?include_resolved=true",
        headers=_headers("member-1"),
    )
    assert all_rows.status_code == 200
    assert [row["id"] for row in all_rows.json()] == [created["id"]]


def test_private_worker_feedback_is_not_visible_to_non_owner(client_repos_db):
    client, repos, db = client_repos_db
    _seed_workspace_worker(repos, db, visibility="private")

    resp = client.post(
        "/workers/feedback-worker/feedback",
        headers=_headers("member-1"),
        json={"body": "Cannot see this private worker."},
    )

    assert resp.status_code == 404, resp.text


def test_mcp_worker_feedback_tools_are_registered_and_dispatch(client_repos_db, monkeypatch):
    client, _repos, _db = client_repos_db
    main = sys.modules["main"]

    listed = client.post(
        "/mcp-tools/serve",
        headers=_headers("owner-1"),
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
    )
    assert listed.status_code == 200, listed.text
    tool_names = {tool["name"] for tool in listed.json()["result"]["tools"]}
    assert {
        "workers.feedback.list",
        "workers.feedback.create",
        "workers.feedback.resolve",
    }.issubset(tool_names)

    forwarded = []

    async def fake_api_call(method, path, request, *, body=None, params=None):
        forwarded.append((method, path, body, params))
        return {"ok": True, "path": path}, 200

    monkeypatch.setattr(main, "_api_call", fake_api_call)

    for idx, (name, arguments) in enumerate(
        [
            ("workers.feedback.list", {"id": "feedback-worker", "include_resolved": True}),
            ("workers.feedback.create", {"id": "feedback-worker", "body": "Looks good"}),
            ("workers.feedback.resolve", {"id": "feedback-worker", "feedback_id": "wfb_123"}),
        ],
        start=2,
    ):
        resp = client.post(
            "/mcp-tools/serve",
            headers=_headers("owner-1"),
            json={
                "jsonrpc": "2.0",
                "id": idx,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["result"]["isError"] is False

    assert forwarded == [
        ("GET", "/workers/feedback-worker/feedback", None, {"include_resolved": True}),
        ("POST", "/workers/feedback-worker/feedback", {"body": "Looks good"}, None),
        ("PATCH", "/workers/feedback-worker/feedback/wfb_123", {"resolved": True}, None),
    ]
