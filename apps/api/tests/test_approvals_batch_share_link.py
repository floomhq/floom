"""#1935 — actionable workspace batch approval share links.

Run:
  cd apps/api && python -m pytest tests/test_approvals_batch_share_link.py -q
"""

from __future__ import annotations

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
    workspace_id: str = "local-default",
    status: str = "pending",
    run_status: str | None = None,
    preview_payload: str | None = None,
) -> dict:
    repos = main.get_repositories()
    repos.workers.create(
        user_id=OWNER,
        worker_id=worker_id,
        name=f"Worker {worker_id}",
        manifest_json=_manifest(worker_id),
        bundle_path=f"workers/{worker_id}",
        workspace_id=workspace_id,
    )
    repos.runs.create(
        user_id=OWNER,
        run_id=run_id,
        worker_id=worker_id,
        status=run_status or main.RunStatus.PENDING_APPROVAL.value,
        trigger_source="manual",
        runner="e2b",
        input_json={"input": approval_id},
        output_json={"draft": approval_id},
    )
    return repos.approvals.create(
        owner_id=OWNER,
        id=approval_id,
        run_id=run_id,
        worker_id=worker_id,
        status=status,
        label=f"Approve {approval_id}",
        preview=f"Preview for {approval_id}",
        preview_payload_json=preview_payload,
        decision_input_json="{}",
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
