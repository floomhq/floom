"""Regression coverage for #2267: MCP stock-worker approval runs stay observable."""
from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "seed-owner")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setenv("WORKEROS_MCP_FULL_TOOLS", "1")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)

    if str(api_dir) not in sys.path:
        sys.path.insert(0, str(api_dir))
    reset_roots = {
        "main",
        "db",
        "models",
        "worker_registry",
        "runner_utils",
        "run_service",
        "chat_service",
        "auth",
        "contexts",
        "git_ops",
    }
    for name in list(sys.modules):
        if any(name == root or name.startswith(root + ".") for root in reset_roots):
            sys.modules.pop(name, None)
        if name.startswith("routers"):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main"), workers_dir


def _rpc_call(client: TestClient, name: str, arguments: dict, request_id: int) -> dict:
    response = client.post(
        "/mcp-tools/serve",
        json={
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
        headers={
            "x-floom-secret": "test-api-secret",
            "x-floom-user": "mcp-caller",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert "error" not in body, body
    result = body["result"]
    assert result["isError"] is False, result
    return result["structuredContent"]


def test_approval_gated_stock_run_is_observable_and_cancellable_via_mcp(
    monkeypatch, tmp_path
):
    main, workers_dir = _load_api(monkeypatch, tmp_path)
    worker_id = "outbound-approval-demo"
    worker_dir = workers_dir / worker_id
    worker_dir.mkdir()
    (worker_dir / "worker.yml").write_text(
        """schema_version: '0.3'
is_example: true
name: outbound-approval-demo
title: Outbound approval demo
description: Approval-gated regression worker.
version: 0.1.0
exec:
  mode: pure-script
  command: python run.py
  runtime: python311
  runner: e2b
  entry: run.py
  inputs:
    - name: prospect_name
      type: string
      required: true
  outputs:
    - name: message_draft
      type: text
      required: false
approvals:
  required: true
  label: Approve outbound message
trigger:
  type: manual
""",
        encoding="utf-8",
    )
    (worker_dir / "run.py").write_text("print('{}')\n", encoding="utf-8")

    repos = main.get_repositories()
    repos.workers.upsert(
        user_id="seed-owner",
        worker_id=worker_id,
        name="Outbound approval demo",
        manifest_json={
            "schema_version": "0.3",
            "is_example": True,
            "name": worker_id,
            "title": "Outbound approval demo",
            "description": "Approval-gated regression worker.",
            "version": "0.1.0",
            "exec": {
                "mode": "pure-script",
                "command": "python run.py",
                "runtime": "python311",
                "runner": "e2b",
                "entry": "run.py",
                "inputs": [
                    {"name": "prospect_name", "type": "string", "required": True}
                ],
                "outputs": [
                    {"name": "message_draft", "type": "text", "required": False}
                ],
            },
            "approvals": {"required": True, "label": "Approve outbound message"},
            "trigger": {"type": "manual"},
        },
        bundle_path=str(worker_dir),
        visibility="private",
    )

    def park_for_approval(run_id, dispatched_worker_id, inputs, *, user_id, repos):
        from db import now_iso

        assert dispatched_worker_id == worker_id
        assert user_id == "seed-owner"
        repos.approvals.create(
            owner_id=user_id,
            id=f"apr_{run_id}",
            run_id=run_id,
            worker_id=worker_id,
            status="pending",
            label="Approve outbound message",
            preview="Draft for review",
            created_at=now_iso(),
            decision_input_json=json.dumps(inputs),
        )
        repos.runs.update_status(
            user_id=user_id,
            run_id=run_id,
            status=main.RunStatus.PENDING_APPROVAL.value,
            output_json={"message_draft": "Draft for review"},
        )

    monkeypatch.setattr(main, "start_run", park_for_approval)

    with TestClient(main.app) as client:
        started = _rpc_call(
            client,
            "workers.run",
            {"id": worker_id, "inputs": {"prospect_name": "Acme Corp"}},
            1,
        )
        run_id = started["run_id"]

        fetched = _rpc_call(client, "runs.get", {"id": run_id}, 2)
        assert fetched["id"] == run_id
        assert fetched["status"] == "pending_approval"

        listed = _rpc_call(client, "runs.list", {"worker_id": worker_id}, 3)
        listed_run = next(row for row in listed["data"] if row["id"] == run_id)
        assert listed_run["status"] == "pending_approval"

        worker = _rpc_call(client, "workers.get", {"id": worker_id}, 4)
        assert worker["last_run"]["id"] == run_id
        assert worker["last_run"]["status"] == "pending_approval"
        assert worker["recent_runs"][0]["id"] == run_id
        assert worker["recent_runs"][0]["status"] == "pending_approval"

        cancelled = _rpc_call(client, "runs.cancel", {"id": run_id}, 5)
        assert cancelled == {"status": "cancelled", "run_id": run_id}

        after_cancel = _rpc_call(client, "runs.get", {"id": run_id}, 6)
        assert after_cancel["status"] == "failed"
        assert after_cancel["error_code"] == "user_cancel"

    persisted = repos.runs.get_any(run_id=run_id)
    assert persisted["actor_user_id"] == "mcp-caller"
    assert persisted["status"] == "cancelled"


def test_owner_can_observe_and_cancel_mcp_triggered_approval_run(
    monkeypatch, tmp_path
):
    main, workers_dir = _load_api(monkeypatch, tmp_path)
    worker_id = "outbound-approval-demo"
    worker_dir = workers_dir / worker_id
    worker_dir.mkdir()
    (worker_dir / "worker.yml").write_text(
        """schema_version: '0.3'
is_example: true
name: outbound-approval-demo
title: Outbound approval demo
description: Approval-gated regression worker.
version: 0.1.0
exec:
  mode: pure-script
  command: python run.py
  runtime: python311
  runner: e2b
  entry: run.py
  inputs:
    - name: prospect_name
      type: string
      required: true
  outputs:
    - name: message_draft
      type: text
      required: false
approvals:
  required: true
  label: Approve outbound message
trigger:
  type: manual
""",
        encoding="utf-8",
    )
    (worker_dir / "run.py").write_text("print('{}')\n", encoding="utf-8")

    repos = main.get_repositories()
    repos.workers.upsert(
        user_id="seed-owner",
        worker_id=worker_id,
        name="Outbound approval demo",
        manifest_json={
            "schema_version": "0.3",
            "is_example": True,
            "name": worker_id,
            "title": "Outbound approval demo",
            "description": "Approval-gated regression worker.",
            "version": "0.1.0",
            "exec": {
                "mode": "pure-script",
                "command": "python run.py",
                "runtime": "python311",
                "runner": "e2b",
                "entry": "run.py",
                "inputs": [
                    {"name": "prospect_name", "type": "string", "required": True}
                ],
                "outputs": [
                    {"name": "message_draft", "type": "text", "required": False}
                ],
            },
            "approvals": {"required": True, "label": "Approve outbound message"},
            "trigger": {"type": "manual"},
        },
        bundle_path=str(worker_dir),
        visibility="private",
    )

    def park_for_approval(run_id, dispatched_worker_id, inputs, *, user_id, repos):
        from db import now_iso

        assert dispatched_worker_id == worker_id
        assert user_id == "seed-owner"
        repos.approvals.create(
            owner_id=user_id,
            id=f"apr_{run_id}",
            run_id=run_id,
            worker_id=worker_id,
            status="pending",
            label="Approve outbound message",
            preview="Draft for review",
            created_at=now_iso(),
            decision_input_json=json.dumps(inputs),
        )
        repos.runs.update_status(
            user_id=user_id,
            run_id=run_id,
            status=main.RunStatus.PENDING_APPROVAL.value,
            output_json={"message_draft": "Draft for review"},
        )

    monkeypatch.setattr(main, "start_run", park_for_approval)

    with TestClient(main.app) as client:
        started = _rpc_call(
            client,
            "workers.run",
            {"id": worker_id, "inputs": {"prospect_name": "Acme Corp"}},
            1,
        )
        run_id = started["run_id"]

    owner_run = repos.runs.get(user_id="seed-owner", run_id=run_id)
    assert owner_run is not None
    assert owner_run["status"] == "pending_approval"

    cancelled = repos.runs.update(
        user_id="seed-owner",
        run_id=run_id,
        status="cancelled",
    )
    assert cancelled is not None
    assert cancelled["status"] == "cancelled"

    persisted = repos.runs.get_any(run_id=run_id)
    assert persisted["actor_user_id"] == "mcp-caller"


def test_third_tenant_cannot_observe_mcp_triggered_approval_run(
    monkeypatch, tmp_path
):
    main, workers_dir = _load_api(monkeypatch, tmp_path)
    worker_id = "outbound-approval-demo"
    worker_dir = workers_dir / worker_id
    worker_dir.mkdir()
    (worker_dir / "worker.yml").write_text(
        """schema_version: '0.3'
is_example: true
name: outbound-approval-demo
title: Outbound approval demo
description: Approval-gated regression worker.
version: 0.1.0
exec:
  mode: pure-script
  command: python run.py
  runtime: python311
  runner: e2b
  entry: run.py
  inputs:
    - name: prospect_name
      type: string
      required: true
  outputs:
    - name: message_draft
      type: text
      required: false
approvals:
  required: true
  label: Approve outbound message
trigger:
  type: manual
""",
        encoding="utf-8",
    )
    (worker_dir / "run.py").write_text("print('{}')\n", encoding="utf-8")

    repos = main.get_repositories()
    repos.workers.upsert(
        user_id="seed-owner",
        worker_id=worker_id,
        name="Outbound approval demo",
        manifest_json={
            "schema_version": "0.3",
            "is_example": True,
            "name": worker_id,
            "title": "Outbound approval demo",
            "description": "Approval-gated regression worker.",
            "version": "0.1.0",
            "exec": {
                "mode": "pure-script",
                "command": "python run.py",
                "runtime": "python311",
                "runner": "e2b",
                "entry": "run.py",
                "inputs": [
                    {"name": "prospect_name", "type": "string", "required": True}
                ],
                "outputs": [
                    {"name": "message_draft", "type": "text", "required": False}
                ],
            },
            "approvals": {"required": True, "label": "Approve outbound message"},
            "trigger": {"type": "manual"},
        },
        bundle_path=str(worker_dir),
        visibility="private",
    )

    def park_for_approval(run_id, dispatched_worker_id, inputs, *, user_id, repos):
        from db import now_iso

        assert dispatched_worker_id == worker_id
        assert user_id == "seed-owner"
        repos.approvals.create(
            owner_id=user_id,
            id=f"apr_{run_id}",
            run_id=run_id,
            worker_id=worker_id,
            status="pending",
            label="Approve outbound message",
            preview="Draft for review",
            created_at=now_iso(),
            decision_input_json=json.dumps(inputs),
        )
        repos.runs.update_status(
            user_id=user_id,
            run_id=run_id,
            status=main.RunStatus.PENDING_APPROVAL.value,
            output_json={"message_draft": "Draft for review"},
        )

    monkeypatch.setattr(main, "start_run", park_for_approval)

    with TestClient(main.app) as client:
        started = _rpc_call(
            client,
            "workers.run",
            {"id": worker_id, "inputs": {"prospect_name": "Acme Corp"}},
            1,
        )
        run_id = started["run_id"]

        assert repos.runs.get(user_id="other-tenant-user", run_id=run_id) is None

        response = client.post(
            "/mcp-tools/serve",
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "runs.get", "arguments": {"id": run_id}},
            },
            headers={
                "x-floom-secret": "test-api-secret",
                "x-floom-user": "other-tenant-user",
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        returned_run = body.get("result", {}).get("structuredContent")
        assert "error" in body or body.get("result", {}).get("isError") is True or not returned_run


def test_non_stock_approval_run_uses_mcp_caller_attribution(monkeypatch, tmp_path):
    main, workers_dir = _load_api(monkeypatch, tmp_path)
    from core.config import PUBLIC_STOCK_WORKER_IDS

    worker_id = "custom-approval-worker"
    assert worker_id not in PUBLIC_STOCK_WORKER_IDS
    worker_dir = workers_dir / worker_id
    worker_dir.mkdir()
    (worker_dir / "worker.yml").write_text(
        """schema_version: '0.3'
is_example: true
name: custom-approval-worker
title: Custom approval worker
description: Non-stock approval-gated regression worker.
version: 0.1.0
exec:
  mode: pure-script
  command: python run.py
  runtime: python311
  runner: e2b
  entry: run.py
  inputs:
    - name: prospect_name
      type: string
      required: true
  outputs:
    - name: message_draft
      type: text
      required: false
approvals:
  required: true
  label: Approve outbound message
trigger:
  type: manual
""",
        encoding="utf-8",
    )
    (worker_dir / "run.py").write_text("print('{}')\n", encoding="utf-8")

    repos = main.get_repositories()
    repos.workers.upsert(
        user_id="seed-owner",
        worker_id=worker_id,
        name="Custom approval worker",
        manifest_json={
            "schema_version": "0.3",
            "is_example": True,
            "name": worker_id,
            "title": "Custom approval worker",
            "description": "Non-stock approval-gated regression worker.",
            "version": "0.1.0",
            "exec": {
                "mode": "pure-script",
                "command": "python run.py",
                "runtime": "python311",
                "runner": "e2b",
                "entry": "run.py",
                "inputs": [
                    {"name": "prospect_name", "type": "string", "required": True}
                ],
                "outputs": [
                    {"name": "message_draft", "type": "text", "required": False}
                ],
            },
            "approvals": {"required": True, "label": "Approve outbound message"},
            "trigger": {"type": "manual"},
        },
        bundle_path=str(worker_dir),
        visibility="workspace",
    )
    from db import get_db, now_iso

    with get_db() as conn:
        timestamp = now_iso()
        conn.execute(
            """
            INSERT INTO workspace_members
                (workspace_id, user_id, role, status, created_at, updated_at)
            VALUES (?, ?, 'member', 'active', ?, ?)
            """,
            ("local-default", "mcp-caller", timestamp, timestamp),
        )
    assert repos.workers.get(
        user_id="mcp-caller", worker_id=worker_id, role="member"
    ) is not None

    def park_for_approval(run_id, dispatched_worker_id, inputs, *, user_id, repos):
        from db import now_iso

        assert dispatched_worker_id == worker_id
        assert user_id == "seed-owner"
        repos.approvals.create(
            owner_id=user_id,
            id=f"apr_{run_id}",
            run_id=run_id,
            worker_id=worker_id,
            status="pending",
            label="Approve outbound message",
            preview="Draft for review",
            created_at=now_iso(),
            decision_input_json=json.dumps(inputs),
        )
        repos.runs.update_status(
            user_id=user_id,
            run_id=run_id,
            status=main.RunStatus.PENDING_APPROVAL.value,
            output_json={"message_draft": "Draft for review"},
        )

    monkeypatch.setattr(main, "start_run", park_for_approval)

    with TestClient(main.app) as client:
        started = _rpc_call(
            client,
            "workers.run",
            {"id": worker_id, "inputs": {"prospect_name": "Acme Corp"}},
            1,
        )
        run_id = started["run_id"]

        fetched = _rpc_call(client, "runs.get", {"id": run_id}, 2)
        assert fetched["id"] == run_id

    persisted = repos.runs.get_any(run_id=run_id)
    assert persisted["actor_user_id"] == "mcp-caller"
