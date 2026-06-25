"""#1935 — actionable workspace batch approval share links.

Run:
  cd apps/api && python -m pytest tests/test_approvals_batch_share_link.py -q
"""

from __future__ import annotations

import hashlib
import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-approvals-batch"
OWNER = "local-user"


def _purge_engine_modules() -> None:
    for name in list(sys.modules):
        if name in {
            "auth",
            "contexts",
            "db",
            "files",
            "main",
            "models",
            "run_service",
            "runner_utils",
            "worker_registry",
        } or name.startswith(("auth.", "core.", "db.", "routers.", "services.")):
            sys.modules.pop(name, None)


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    _purge_engine_modules()

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    run_service = importlib.import_module("run_service")
    monkeypatch.setattr(run_service, "start_run", lambda *args, **kwargs: None)

    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield client, main
    db.get_repositories.cache_clear()
    _purge_engine_modules()


def _manifest(worker_id: str) -> dict:
    return {
        "id": worker_id,
        "name": worker_id,
        "title": f"Worker {worker_id}",
        "version": f"0.1.0-{worker_id}",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
    }


def _seed_approval(
    main,
    *,
    approval_id: str,
    run_id: str,
    worker_id: str,
    owner_id: str = OWNER,
    workspace_id: str = "local-default",
    status: str = "pending",
    run_status: str | None = None,
    preview_payload: str | None = None,
    label: str | None = None,
    preview: str | None = None,
    decision_input_json: str = "{}",
) -> dict:
    repos = main.get_repositories()
    repos.workers.create(
        user_id=owner_id,
        worker_id=worker_id,
        name=f"Worker {worker_id}",
        manifest_json=_manifest(worker_id),
        bundle_path=f"workers/{worker_id}",
        workspace_id=workspace_id,
    )
    repos.runs.create(
        user_id=owner_id,
        run_id=run_id,
        worker_id=worker_id,
        status=run_status or main.RunStatus.PENDING_APPROVAL.value,
        trigger_source="manual",
        runner="e2b",
        input_json={"input": approval_id},
        output_json={"draft": approval_id},
    )
    return repos.approvals.create(
        owner_id=owner_id,
        id=approval_id,
        run_id=run_id,
        worker_id=worker_id,
        status=status,
        label=label if label is not None else f"Approve {approval_id}",
        preview=preview if preview is not None else f"Preview for {approval_id}",
        preview_payload_json=preview_payload,
        decision_input_json=decision_input_json,
        created_at="2026-06-24T00:00:00Z",
    )


def _batch_token(client) -> str:
    response = client.post("/approvals/batch-share-link")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["entity_type"] == "approvals_batch"
    assert "/s/" in body["url"]
    assert body["token"].startswith("fls_")
    return body["token"]


def test_mint_and_public_batch_lists_only_pending_workspace_items(client_and_main):
    client, main = client_and_main
    _seed_approval(
        main,
        approval_id="apr_local",
        run_id="run_local",
        worker_id="w_local",
        preview_payload='{"subject":"ok","connection_id":"conn_secret","nested":{"api_token":"hidden"}}',
    )
    _seed_approval(
        main,
        approval_id="apr_other_workspace",
        run_id="run_other_workspace",
        worker_id="w_other_workspace",
        workspace_id="ws_aaaaaaaaaaaaaa",
    )
    _seed_approval(
        main,
        approval_id="apr_done",
        run_id="run_done",
        worker_id="w_done",
        status="approved",
        run_status=main.RunStatus.COMPLETED.value,
    )

    token = _batch_token(client)
    from fastapi.testclient import TestClient

    anon = TestClient(client.app, raise_server_exceptions=False)
    response = anon.get(f"/approvals/public-batch/{token}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["entity_type"] == "approvals_batch"
    assert [item["id"] for item in body["approvals"]] == ["apr_local"]
    item = body["approvals"][0]
    assert item["label"] == "Approve apr_local"
    assert item["preview"] == "Preview for apr_local"
    assert item["action_token"]
    assert "owner_id" not in item
    assert "public_link" not in item
    assert "decision_input_json" not in item
    assert "connection_id" not in item["preview_payload"]
    assert "api_token" not in item["preview_payload"]["nested"]


def test_batch_share_link_is_idempotent_and_uses_top_level_standalone_url(client_and_main, monkeypatch):
    client, main = client_and_main
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://floom.dev/app")
    _seed_approval(main, approval_id="apr_local", run_id="run_local", worker_id="w_local")

    first = client.post("/approvals/batch-share-link")
    second = client.post("/approvals/batch-share-link")

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["token"] == second.json()["token"]
    assert first.json()["url"] == f"https://floom.dev/s/{first.json()['token']}"
    assert "/app/s/" not in first.json()["url"]
    assert client.get(f"/approvals/public-batch/{first.json()['token']}").status_code == 200


def test_batch_share_link_uses_active_workspace_context_in_cloud(client_and_main, monkeypatch):
    client, main = client_and_main
    _seed_approval(
        main,
        approval_id="apr_cloud",
        run_id="run_cloud",
        worker_id="w_cloud",
        workspace_id="ws_cloud",
    )
    db_factory = importlib.import_module("db.factory")
    auth_factory = importlib.import_module("auth.factory")
    auth_multi_member = importlib.import_module("auth.multi_member")
    repos = main.get_repositories()
    db_factory.register_repositories("cloud", lambda: repos)
    auth_factory.register_auth_provider("cloud", lambda: auth_multi_member.MultiMemberAuthProvider())
    git_ops = importlib.import_module("git_ops")
    monkeypatch.setattr(git_ops, "get_active_workspace_id", lambda: "ws_cloud")
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    response = client.post("/approvals/batch-share-link")

    assert response.status_code == 200, response.text
    token = response.json()["token"]
    assert client.get(f"/approvals/public-batch/{token}").json()["approvals"][0]["id"] == "apr_cloud"


def test_public_batch_requires_workspace_scoped_approval_repo(client_and_main, monkeypatch):
    client, main = client_and_main
    _seed_approval(main, approval_id="apr_scoped", run_id="run_scoped", worker_id="w_scoped")
    repos = main.get_repositories()

    class UnscopedApprovalsRepo:
        def __init__(self):
            self.list_pending_called = False

        def list_pending(self, *, owner_id: str, limit: int = 100):
            self.list_pending_called = True
            return repos.approvals.list_pending(owner_id=owner_id, limit=limit)

    unscoped_approvals = UnscopedApprovalsRepo()
    patched_repos = repos._replace(approvals=unscoped_approvals)
    db_factory = importlib.import_module("db.factory")
    auth_factory = importlib.import_module("auth.factory")
    auth_multi_member = importlib.import_module("auth.multi_member")
    db_factory.register_repositories("cloud", lambda: patched_repos)
    auth_factory.register_auth_provider("cloud", lambda: auth_multi_member.MultiMemberAuthProvider())
    git_ops = importlib.import_module("git_ops")
    monkeypatch.setattr(git_ops, "get_active_workspace_id", lambda: "local-default")
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    db_factory.get_repositories.cache_clear()

    response = client.post("/approvals/batch-share-link")

    assert response.status_code == 503
    assert "workspace-scoped pending approvals" in response.text
    assert unscoped_approvals.list_pending_called is False


def test_sqlite_approval_repo_exposes_workspace_scoped_pending_contract(client_and_main):
    _client, main = client_and_main
    repos = main.get_repositories()
    assert callable(getattr(repos.approvals, "list_pending_for_workspace", None))


def test_batch_share_link_stores_hash_only_token(client_and_main):
    client, main = client_and_main
    _seed_approval(main, approval_id="apr_hash_only", run_id="run_hash_only", worker_id="w_hash_only")

    token = _batch_token(client)

    db = importlib.import_module("db")
    with db.get_db() as conn:
        columns = [row["name"] for row in conn.execute("PRAGMA table_info(approval_batch_share_links)").fetchall()]
        row = conn.execute("SELECT * FROM approval_batch_share_links").fetchone()

    assert "token_hash" in columns
    assert "token" not in columns
    assert row is not None
    stored = dict(row)
    assert stored["token_hash"] == hashlib.sha256(token.encode("utf-8")).hexdigest()
    assert token not in repr(stored)


def test_public_batch_token_is_scoped_to_minted_pending_approval_snapshot(client_and_main):
    client, main = client_and_main
    _seed_approval(main, approval_id="apr_original", run_id="run_original", worker_id="w_original")
    token = _batch_token(client)
    _seed_approval(main, approval_id="apr_later", run_id="run_later", worker_id="w_later")

    from fastapi.testclient import TestClient

    anon = TestClient(client.app, raise_server_exceptions=False)
    batch = anon.get(f"/approvals/public-batch/{token}")
    assert batch.status_code == 200, batch.text
    assert [item["id"] for item in batch.json()["approvals"]] == ["apr_original"]

    denied = anon.post(
        f"/approvals/public-batch/{token}/items/apr_later/decision",
        json={"decision": "rejected"},
    )
    assert denied.status_code == 404
    row = main.get_repositories().approvals.get(owner_id=OWNER, approval_id="apr_later")
    assert row["status"] == "pending"


def test_public_batch_legacy_raw_token_table_migrates_and_freezes_scope(client_and_main):
    client, main = client_and_main
    legacy_token = "fls_legacy123456"
    _seed_approval(main, approval_id="apr_legacy", run_id="run_legacy", worker_id="w_legacy")

    db = importlib.import_module("db")
    with db.get_db() as conn:
        conn.execute(
            """
            CREATE TABLE approval_batch_share_links (
                token TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(workspace_id, owner_id)
            )
            """
        )
        conn.execute(
            """
            INSERT INTO approval_batch_share_links (token, workspace_id, owner_id, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (legacy_token, "local-default", OWNER, "2026-06-24T00:00:00Z"),
        )

    from fastapi.testclient import TestClient

    anon = TestClient(client.app, raise_server_exceptions=False)
    response = anon.get(f"/approvals/public-batch/{legacy_token}")
    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()["approvals"]] == ["apr_legacy"]

    with db.get_db() as conn:
        columns = [row["name"] for row in conn.execute("PRAGMA table_info(approval_batch_share_links)").fetchall()]
        row = conn.execute("SELECT * FROM approval_batch_share_links").fetchone()

    assert "token_hash" in columns
    assert "token" not in columns
    stored = dict(row)
    assert stored["token_hash"] == hashlib.sha256(legacy_token.encode("utf-8")).hexdigest()
    assert stored["approval_ids_json"] == '["apr_legacy"]'
    assert legacy_token not in repr(stored)

    reshared = _batch_token(client)
    reshared_response = anon.get(f"/approvals/public-batch/{reshared}")
    assert reshared_response.status_code == 200, reshared_response.text
    assert [item["id"] for item in reshared_response.json()["approvals"]] == ["apr_legacy"]


def test_public_batch_allows_floom_preflight_for_decision(client_and_main):
    client, main = client_and_main
    _seed_approval(main, approval_id="apr_cors", run_id="run_cors", worker_id="w_cors")
    token = _batch_token(client)

    response = client.options(
        f"/approvals/public-batch/{token}/items/apr_cors/decision",
        headers={
            "origin": "https://floom.dev",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
        },
    )

    assert response.status_code == 200, response.text
    assert response.headers["access-control-allow-origin"] == "https://floom.dev"
    assert "POST" in response.headers["access-control-allow-methods"]
    assert "Content-Type" in response.headers["access-control-allow-headers"]


def test_public_batch_decision_approves_and_creates_follow_up(client_and_main):
    client, main = client_and_main
    _seed_approval(main, approval_id="apr_approve", run_id="run_approve", worker_id="w_approve")
    token = _batch_token(client)

    from fastapi.testclient import TestClient

    anon = TestClient(client.app, raise_server_exceptions=False)
    response = anon.post(
        f"/approvals/public-batch/{token}/items/apr_approve/decision",
        json={"decision": "approved", "edited_output": {"draft": "edited"}},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "approved"
    assert body["run_id"] != "run_approve"

    row = main.get_repositories().approvals.get(owner_id=OWNER, approval_id="apr_approve")
    assert row["status"] == "approved"
    assert row["follow_up_run_id"] == body["run_id"]


def test_public_batch_decision_rejects_and_persists_rejected_status(client_and_main):
    client, main = client_and_main
    _seed_approval(main, approval_id="apr_reject", run_id="run_reject", worker_id="w_reject")
    token = _batch_token(client)

    from fastapi.testclient import TestClient

    anon = TestClient(client.app, raise_server_exceptions=False)
    response = anon.post(
        f"/approvals/public-batch/{token}/items/apr_reject/decision",
        json={"decision": "rejected", "reason": "Not this one"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {"status": "rejected", "run_id": "run_reject"}

    repos = main.get_repositories()
    row = repos.approvals.get(owner_id=OWNER, approval_id="apr_reject")
    assert row["status"] == "rejected"
    run = repos.runs.get(user_id=OWNER, run_id="run_reject")
    assert run["status"] == main.RunStatus.REJECTED.value


def test_public_batch_humanizes_title_and_strips_internal_error_preview(client_and_main):
    client, main = client_and_main
    _seed_approval(
        main,
        approval_id="apr_publish",
        run_id="run_publish",
        worker_id="content-pub-cp2",
        label="content-pub-cp2",
        preview=(
            "Token source per account: personal1:input, personal2:input\n"
            '{"http_error":429,"error":"RATE_LIMIT_EXCEEDED"}\n'
            "channel 'youtube' not connected in personal-2"
        ),
        preview_payload='{"channels":["youtube","linkedin"],"caption":"belong in public"}',
        decision_input_json='{"channels":["youtube","linkedin"],"caption":"belong in public"}',
    )
    token = _batch_token(client)

    from fastapi.testclient import TestClient

    anon = TestClient(client.app, raise_server_exceptions=False)
    response = anon.get(f"/approvals/public-batch/{token}")
    assert response.status_code == 200, response.text
    item = response.json()["approvals"][0]

    assert item["label"] == "Publish 'belong in public' to YouTube + LinkedIn"
    rendered = f"{item['label']}\n{item['preview']}"
    assert "content-pub-cp2" not in item["label"]
    assert "Token source per account" not in rendered
    assert "http_error" not in rendered
    assert "RATE_LIMIT_EXCEEDED" not in rendered
    assert "not connected" not in rendered


def test_public_batch_rejects_wrong_workspace_item_and_bad_token(client_and_main):
    client, main = client_and_main
    _seed_approval(main, approval_id="apr_local", run_id="run_local", worker_id="w_local")
    _seed_approval(
        main,
        approval_id="apr_other_workspace",
        run_id="run_other_workspace",
        worker_id="w_other_workspace",
        workspace_id="ws_bbbbbbbbbbbbbb",
    )
    token = _batch_token(client)

    from fastapi.testclient import TestClient

    anon = TestClient(client.app, raise_server_exceptions=False)
    wrong_workspace = anon.post(
        f"/approvals/public-batch/{token}/items/apr_other_workspace/decision",
        json={"decision": "rejected"},
    )
    assert wrong_workspace.status_code == 404
    row = main.get_repositories().approvals.get(owner_id=OWNER, approval_id="apr_other_workspace")
    assert row["status"] == "pending"

    bad_token = anon.get("/approvals/public-batch/fls_badbadbad")
    assert bad_token.status_code == 404


def test_public_batch_rejects_same_workspace_different_owner_item(client_and_main):
    client, main = client_and_main
    _seed_approval(main, approval_id="apr_owner", run_id="run_owner", worker_id="w_owner")
    _seed_approval(
        main,
        approval_id="apr_other_owner",
        run_id="run_other_owner",
        worker_id="w_other_owner",
        owner_id="other-user",
        workspace_id="local-default",
    )
    token = _batch_token(client)

    from fastapi.testclient import TestClient

    anon = TestClient(client.app, raise_server_exceptions=False)
    batch = anon.get(f"/approvals/public-batch/{token}")
    assert batch.status_code == 200, batch.text
    assert [item["id"] for item in batch.json()["approvals"]] == ["apr_owner"]

    denied = anon.post(
        f"/approvals/public-batch/{token}/items/apr_other_owner/decision",
        json={"decision": "rejected"},
    )
    assert denied.status_code == 404
    row = main.get_repositories().approvals.get(owner_id="other-user", approval_id="apr_other_owner")
    assert row["status"] == "pending"


def test_standalone_batch_share_route_enforces_read_rate_limit(client_and_main, monkeypatch):
    client, main = client_and_main
    _seed_approval(main, approval_id="apr_standalone_limit", run_id="run_standalone_limit", worker_id="w_limit")
    token = _batch_token(client)

    approvals = importlib.import_module("routers.approvals")
    monkeypatch.setattr(approvals, "_PUBLIC_BATCH_READ_LIMIT", 1)
    approvals._PUBLIC_BATCH_RATE_BUCKETS.clear()

    from fastapi.testclient import TestClient

    anon = TestClient(client.app, raise_server_exceptions=False)
    first = anon.get(f"/s/{token}")
    assert first.status_code == 200, first.text
    second = anon.get(f"/s/{token}")
    assert second.status_code == 429
