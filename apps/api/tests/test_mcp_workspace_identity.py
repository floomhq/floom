"""Regression coverage for MCP workspace identity, empty instructions, and scoped 404s."""
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
    monkeypatch.setenv("WORKEROS_DEFAULT_WORKSPACE_NAME", "Current Workspace")
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "mcp-test-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKSPACE_AGENT_MCP_TOKEN", "test-langdock-token")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)
    monkeypatch.delenv("WORKEROS_MCP_FULL_TOOLS", raising=False)

    sys.path.insert(0, str(api_dir))
    for name in list(sys.modules):
        if any(name == module or name.startswith(module + ".") for module in [
            "main", "db", "models", "worker_registry", "runner_utils",
            "run_service", "chat_service", "auth", "contexts", "git_ops",
        ]):
            sys.modules.pop(name, None)
        if name.startswith("routers"):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _rpc(method, request_id=1, params=None):
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        payload["params"] = params
    return payload


def _headers():
    return {"x-floom-secret": "test-api-secret", "Content-Type": "application/json"}


def _remote_mcp_headers():
    return {"Authorization": "Bearer test-langdock-token", "Content-Type": "application/json"}


def test_missing_workspace_instructions_returns_empty_rest_and_mcp_payload(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")
    monkeypatch.setattr(chat_service, "get_workspace_md", lambda: None)
    monkeypatch.setenv("WORKEROS_MCP_FULL_TOOLS", "1")

    with TestClient(main.app) as client:
        rest = client.get("/workspace", headers=_headers())
        mcp = client.post(
            "/mcp-tools/serve",
            data=json.dumps(_rpc("tools/call", params={
                "name": "workspace.instructions.get",
                "arguments": {},
            })),
            headers=_headers(),
        )

    assert rest.status_code == 200, rest.text
    assert rest.text == ""
    assert mcp.status_code == 200, mcp.text
    result = mcp.json()["result"]
    assert result["isError"] is False
    assert result["structuredContent"] == {"content": ""}


def test_member_workspace_info_returns_workspace_and_principal_without_system_metadata(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app) as client:
        listed = client.post(
            "/mcp-tools/serve",
            data=json.dumps(_rpc("tools/list")),
            headers=_headers(),
        )
        called = client.post(
            "/mcp-tools/serve",
            data=json.dumps(_rpc("tools/call", params={"name": "workspace.info", "arguments": {}})),
            headers=_headers(),
        )
        remote_called = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/call", params={"name": "workspace.info", "arguments": {}})),
            headers=_remote_mcp_headers(),
        )

    tools = {tool["name"]: tool for tool in listed.json()["result"]["tools"]}
    assert "workspace.info" in tools
    result = called.json()["result"]
    assert result["isError"] is False
    assert result["structuredContent"] == {
        "workspace_id": "local-default",
        "workspace_name": "Current Workspace",
        "principal": {
            "user_id": "mcp-test-user",
            "email": None,
            "role": "member",
        },
    }
    assert "python_version" not in result["content"][0]["text"]
    assert "started_at" not in result["content"][0]["text"]
    remote_info = remote_called.json()["result"]["structuredContent"]
    assert remote_info["workspace_id"] == "local-default"
    assert remote_info["workspace_name"] == "Current Workspace"
    assert remote_info["principal"] == {
        "user_id": "mcp-test-user",
        "email": None,
        "role": "admin",
    }


def test_member_system_info_remains_admin_gated(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    monkeypatch.setenv("WORKEROS_MCP_FULL_TOOLS", "1")

    with TestClient(main.app) as client:
        response = client.post(
            "/mcp-tools/serve",
            data=json.dumps(_rpc("tools/call", params={"name": "system.info", "arguments": {}})),
            headers=_headers(),
        )

    result = response.json()["result"]
    assert result["isError"] is True
    assert result["structuredContent"]["status"] == 403
    assert "python_version" not in result["content"][0]["text"]
    assert "started_at" not in result["content"][0]["text"]


def _create_run(main, *, user_id: str, worker_id: str, run_id: str):
    repos = main.get_repositories()
    repos.workers.upsert(
        user_id=user_id,
        worker_id=worker_id,
        name=worker_id,
        manifest_json={"id": worker_id, "name": worker_id},
        bundle_path=f"workers/{worker_id}",
    )
    repos.runs.create(
        user_id=user_id,
        run_id=run_id,
        worker_id=worker_id,
        input_json={},
        status=main.RunStatus.COMPLETED.value,
        trigger_source="manual",
        runner="e2b",
    )


def test_runs_get_404_names_only_current_workspace_for_cross_workspace_runs(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    from auth.local_workspaces import create_local_workspace, local_workspace_user_id

    other_workspace = create_local_workspace("mcp-test-user", "Other Secret Workspace")
    other_workspace_user = local_workspace_user_id("mcp-test-user", other_workspace["id"])
    _create_run(
        main,
        user_id=other_workspace_user,
        worker_id="other-workspace-worker",
        run_id="run-other-workspace",
    )
    _create_run(
        main,
        user_id="foreign-user",
        worker_id="foreign-user-worker",
        run_id="run-foreign-user",
    )

    with TestClient(main.app) as client:
        same_user_other_workspace = client.get("/runs/run-other-workspace", headers=_headers())
        foreign_user = client.get("/runs/run-foreign-user", headers=_headers())
        mcp = client.post(
            "/mcp-tools/serve",
            data=json.dumps(_rpc("tools/call", params={
                "name": "runs.get",
                "arguments": {"id": "run-other-workspace"},
            })),
            headers=_headers(),
        )

    expected = "Run not found in workspace Current Workspace (local-default)"
    assert same_user_other_workspace.status_code == 404
    assert same_user_other_workspace.json() == {"detail": expected}
    assert foreign_user.status_code == 404
    assert foreign_user.json() == {"detail": expected}
    assert other_workspace["id"] not in same_user_other_workspace.text
    assert "Other Secret Workspace" not in same_user_other_workspace.text
    mcp_result = mcp.json()["result"]
    assert mcp_result["isError"] is True
    assert mcp_result["structuredContent"]["status"] == 404
    assert expected in mcp_result["content"][0]["text"]
    assert other_workspace["id"] not in mcp_result["content"][0]["text"]
    assert "Other Secret Workspace" not in mcp_result["content"][0]["text"]


def test_workers_list_mcp_is_paginated_and_compact_unless_verbose(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    calls = []
    workers = [{
        "id": "worker-1",
        "name": "Worker 1",
        "description": "short",
        "long_description": "L" * 5000,
        "example_output": {"large": "O" * 5000},
        "timeseries": [{"date": "2026-07-17", "runs": 1}],
    }]

    async def fake_api_call(method, path, request, **kwargs):
        calls.append((method, path, kwargs.get("params")))
        return workers, 200

    monkeypatch.setattr(main, "_api_call", fake_api_call)

    with TestClient(main.app) as client:
        listed = client.post(
            "/mcp-tools/serve",
            data=json.dumps(_rpc("tools/list")),
            headers=_headers(),
        )
        compact = client.post(
            "/mcp-tools/serve",
            data=json.dumps(_rpc("tools/call", params={
                "name": "workers.list",
                "arguments": {"limit": 1, "offset": 2},
            })),
            headers=_headers(),
        )
        verbose = client.post(
            "/mcp-tools/serve",
            data=json.dumps(_rpc("tools/call", params={
                "name": "workers.list",
                "arguments": {"limit": 1, "offset": 2, "verbose": True},
            })),
            headers=_headers(),
        )

    schema = next(
        tool["inputSchema"]
        for tool in listed.json()["result"]["tools"]
        if tool["name"] == "workers.list"
    )
    assert {"limit", "offset", "verbose"} <= set(schema["properties"])
    assert calls[0][2] == {
        "include_system": False,
        "include_archived": False,
        "shape": "list",
        "limit": 1,
        "offset": 2,
    }
    compact_row = compact.json()["result"]["structuredContent"]["data"][0]
    assert compact_row == {"id": "worker-1", "name": "Worker 1", "description": "short"}
    assert calls[1][2]["shape"] == "full"
    verbose_row = verbose.json()["result"]["structuredContent"]["data"][0]
    assert verbose_row["long_description"] == "L" * 5000
    assert verbose_row["example_output"] == {"large": "O" * 5000}
