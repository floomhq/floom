"""Regression coverage for MCP workspace identity, empty instructions, and scoped 404s."""
from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

import pytest
from fastapi import HTTPException
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


def test_workspace_info_id_uses_distinct_cloud_workspace_resolver_values(monkeypatch, tmp_path):
    _load_api(monkeypatch, tmp_path)
    import git_ops
    from routers.workspace import _workspace_info_id

    auth = types.SimpleNamespace(user_id="cloud-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    try:
        for workspace_id in ("cloud-workspace-alpha", "cloud-workspace-beta"):
            git_ops.set_workspace_id_resolver(lambda value=workspace_id: value)
            assert _workspace_info_id(auth) == workspace_id
    finally:
        git_ops.set_workspace_id_resolver(None)


@pytest.mark.parametrize(
    "resolver",
    [None, lambda: None, lambda: (_ for _ in ()).throw(RuntimeError("boom"))],
)
def test_workspace_info_id_fails_closed_when_cloud_workspace_unresolved(
    monkeypatch, tmp_path, resolver
):
    _load_api(monkeypatch, tmp_path)
    import git_ops
    from routers.workspace import _workspace_info_id

    auth = types.SimpleNamespace(user_id="cloud-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    git_ops.set_workspace_id_resolver(resolver)
    try:
        with pytest.raises(HTTPException) as exc_info:
            _workspace_info_id(auth)
    finally:
        git_ops.set_workspace_id_resolver(None)

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == (
        "workspace-unresolved: unable to determine the active workspace for this request"
    )


def test_workspace_info_id_keeps_local_default_fallback(monkeypatch, tmp_path):
    _load_api(monkeypatch, tmp_path)
    import git_ops
    from routers.workspace import _workspace_info_id

    auth = types.SimpleNamespace(user_id="mcp-test-user")
    git_ops.set_workspace_id_resolver(None)
    assert _workspace_info_id(auth) == "local-default"


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


@pytest.mark.parametrize("tool_name", ["runs.get", "workers.get"])
@pytest.mark.parametrize("invalid_id", ["", "   "])
def test_get_tools_reject_empty_id_on_both_mcp_surfaces(
    monkeypatch, tmp_path, tool_name, invalid_id
):
    main = _load_api(monkeypatch, tmp_path)
    payload = _rpc(
        "tools/call", params={"name": tool_name, "arguments": {"id": invalid_id}}
    )

    with TestClient(main.app) as client:
        served = client.post(
            "/mcp-tools/serve",
            data=json.dumps(payload),
            headers=_headers(),
        )
        remote = client.post(
            "/api/mcp",
            data=json.dumps(payload),
            headers=_remote_mcp_headers(),
        )

    for response in (served, remote):
        assert response.status_code == 200, response.text
        error = response.json()["error"]
        assert error["code"] == -32602
        assert error["message"] == "Invalid params: id must not be empty"


def test_validator_allows_empty_required_non_id_string(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    tools = [
        {
            "name": "example.set",
            "inputSchema": {
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
            },
        }
    ]

    error = main._mcp_validate_arguments_against_schema(
        tools, "example.set", {"value": ""}
    )

    assert error is None


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


def test_workers_get_404_names_only_current_workspace_for_cross_workspace_workers(
    monkeypatch, tmp_path
):
    main = _load_api(monkeypatch, tmp_path)
    from auth.local_workspaces import create_local_workspace, local_workspace_user_id

    other_workspace = create_local_workspace("mcp-test-user", "Other Secret Workspace")
    other_workspace_user = local_workspace_user_id("mcp-test-user", other_workspace["id"])
    repos = main.get_repositories()
    for user_id, worker_id in (
        (other_workspace_user, "worker-other-workspace"),
        ("foreign-user", "worker-foreign-user"),
    ):
        repos.workers.upsert(
            user_id=user_id,
            worker_id=worker_id,
            name=worker_id,
            manifest_json={"id": worker_id, "name": worker_id},
            bundle_path=f"workers/{worker_id}",
        )

    with TestClient(main.app) as client:
        same_user_other_workspace = client.get(
            "/workers/worker-other-workspace", headers=_headers()
        )
        foreign_user = client.get("/workers/worker-foreign-user", headers=_headers())
        mcp_responses = {
            (surface, worker_id): client.post(
                surface,
                data=json.dumps(_rpc("tools/call", params={
                    "name": "workers.get",
                    "arguments": {"id": worker_id},
                })),
                headers=headers,
            )
            for surface, headers in (
                ("/mcp-tools/serve", _headers()),
                ("/api/mcp", _remote_mcp_headers()),
            )
            for worker_id in ("worker-other-workspace", "worker-foreign-user")
        }

    expected = "Worker not found in workspace Current Workspace (local-default)"
    assert same_user_other_workspace.status_code == 404
    assert same_user_other_workspace.json() == {"detail": expected}
    assert foreign_user.status_code == 404
    assert foreign_user.json() == {"detail": expected}
    assert other_workspace["id"] not in same_user_other_workspace.text
    assert "Other Secret Workspace" not in same_user_other_workspace.text
    for response in mcp_responses.values():
        assert response.status_code == 200, response.text
        mcp_result = response.json()["result"]
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
