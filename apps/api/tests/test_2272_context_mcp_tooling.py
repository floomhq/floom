"""Regression coverage for context management on every MCP surface (#2272)."""
from __future__ import annotations

import importlib
import asyncio
import json
import sys
import types
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def client_and_main(monkeypatch, tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-2272")
    monkeypatch.setenv("WORKEROS_USER_ID", "owner-2272")
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(workspace))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workspace / "workers"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(workspace / "contexts"))
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)

    for name in list(sys.modules):
        if name == "main" or name.startswith(("db", "routers", "services")) or name in {
            "auth", "contexts", "git_ops", "models", "worker_registry", "run_service",
            "scheduler", "chat_service",
        }:
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={
        "x-floom-secret": "test-secret-2272", "x-floom-user": "owner-2272",
    }) as client:
        yield client, main
    db.get_repositories.cache_clear()


def _call(main, name: str, arguments: dict, *, user_id: str = "owner-2272") -> dict:
    from starlette.requests import Request

    body = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    auth = main.AuthContext(
        user_id=user_id, role="admin", auth_method="secret", scopes=("admin",)
    )
    request = Request({
        "type": "http", "method": "POST", "path": "/mcp-tools/serve",
        "query_string": b"", "headers": [
            (b"x-floom-secret", b"test-secret-2272"),
            (b"x-floom-user", user_id.encode("utf-8")),
        ],
    })
    result = asyncio.run(main._mcp_handle_request(body, auth, main.get_repositories(), request))
    return result["result"]


def _remote_call(
    client, name: str, arguments: dict, *, user_id: str = "owner-2272",
) -> dict:
    previous_user = client.headers["x-floom-user"]
    client.headers["x-floom-user"] = user_id
    try:
        response = client.post(
            "/api/mcp",
            content=json.dumps({
                "jsonrpc": "2.0",
                "id": 2272,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }),
        )
    finally:
        client.headers["x-floom-user"] = previous_user
    assert response.status_code == 200, response.text
    return response.json()["result"]


def _create(client, name: str, *, sensitive: bool) -> None:
    response = client.post(
        f"/contexts/{name}", json={"writeable": True, "sensitive": sensitive}
    )
    assert response.status_code == 200, response.text


def test_mcp_files_lists_written_paths_and_delete_removes_file_then_folder(client_and_main):
    client, main = client_and_main
    _create(client, "managed", sensitive=False)
    for path in ("notes.md", "nested/reference.txt"):
        result = _call(main, "contexts.write", {"name": "managed", "path": path, "content": path})
        assert result["isError"] is False, result

    listed = _call(main, "contexts.files", {"name": "managed"})
    assert listed["isError"] is False, listed
    assert listed["structuredContent"]["paths"] == ["nested/reference.txt", "notes.md"]

    deleted_file = _call(main, "contexts.delete", {"name": "managed", "path": "nested/reference.txt"})
    assert deleted_file["isError"] is False, deleted_file
    assert client.get("/contexts/managed/files/nested/reference.txt").status_code == 404

    deleted_folder = _call(main, "contexts.delete", {"name": "managed"})
    assert deleted_folder["isError"] is False, deleted_folder
    assert client.get("/contexts/managed").status_code == 404


def test_mcp_versions_returns_history_for_non_sensitive_context(client_and_main):
    client, main = client_and_main
    _create(client, "versioned", sensitive=False)
    _call(main, "contexts.write", {"name": "versioned", "path": "notes.md", "content": "v1"})
    _call(main, "contexts.write", {"name": "versioned", "path": "notes.md", "content": "v2"})

    result = _call(main, "contexts.versions", {"name": "versioned"})
    assert result["isError"] is False, result
    assert len(result["structuredContent"]["data"]) >= 1


def test_mcp_versions_stays_empty_for_sensitive_context(client_and_main):
    client, main = client_and_main
    _create(client, "sensitive", sensitive=True)
    _call(main, "contexts.write", {"name": "sensitive", "path": "notes.md", "content": "secret"})

    result = _call(main, "contexts.versions", {"name": "sensitive"})
    assert result["isError"] is False, result
    assert result["structuredContent"]["data"] == []


def test_remote_api_mcp_executes_files_versions_and_delete(client_and_main):
    client, _main = client_and_main
    _create(client, "remote-managed", sensitive=False)
    written = _remote_call(client, "contexts.write", {
        "name": "remote-managed", "path": "notes.md", "content": "remote",
    })
    assert written["isError"] is False, written

    listed = _remote_call(client, "contexts.files", {"name": "remote-managed"})
    assert listed["isError"] is False, listed
    assert listed["structuredContent"]["paths"] == ["notes.md"]

    versions = _remote_call(client, "contexts.versions", {"name": "remote-managed"})
    assert versions["isError"] is False, versions
    assert versions["structuredContent"]["data"]

    deleted = _remote_call(client, "contexts.delete", {"name": "remote-managed"})
    assert deleted["isError"] is False, deleted
    assert client.get("/contexts/remote-managed").status_code == 404


@pytest.mark.parametrize("tool", ["contexts.files", "contexts.versions", "contexts.delete"])
def test_context_management_tools_deny_cross_owner(client_and_main, tool):
    client, main = client_and_main
    _create(client, "owner-private", sensitive=False)
    _call(main, "contexts.write", {
        "name": "owner-private", "path": "private.txt", "content": "owner only",
    })

    denied = _remote_call(
        client, tool, {"name": "owner-private"}, user_id="other-owner",
    )
    assert denied["isError"] is True, denied
    assert "not found" in denied["content"][0]["text"].lower()
    assert client.get("/contexts/owner-private/files/private.txt").status_code == 200


def test_contexts_delete_rejects_path_traversal(client_and_main, tmp_path):
    client, _main = client_and_main
    _create(client, "traversal", sensitive=False)
    outside = tmp_path / "passwd"
    outside.write_text("must survive", encoding="utf-8")

    denied = _remote_call(client, "contexts.delete", {
        "name": "traversal", "path": "../passwd",
    })
    assert denied["isError"] is True, denied
    assert outside.read_text(encoding="utf-8") == "must survive"


def test_contexts_delete_requires_force_when_pack_is_referenced(client_and_main, monkeypatch):
    client, main = client_and_main
    _create(client, "in-use", sensitive=False)
    contexts_router = importlib.import_module("routers.contexts")
    monkeypatch.setattr(contexts_router, "_workers_referencing_context", lambda *args, **kwargs: ["worker-1"])

    blocked = _remote_call(client, "contexts.delete", {"name": "in-use"})
    assert blocked["isError"] is True, blocked
    assert "referenced" in blocked["content"][0]["text"].lower()
    assert client.get("/contexts/in-use").status_code == 200

    forced = _remote_call(client, "contexts.delete", {"name": "in-use", "force": True})
    assert forced["isError"] is False, forced
    assert client.get("/contexts/in-use").status_code == 404


def test_all_mcp_registries_expose_context_management_tools(client_and_main):
    _client, main = client_and_main
    expected = {"contexts.files", "contexts.delete", "contexts.versions"}
    assert expected <= {tool["name"] for tool in main._MCP_DEFAULT_TOOLS}
    assert expected <= {tool["name"] for tool in main._workeros_remote_mcp_tool_definitions()}
