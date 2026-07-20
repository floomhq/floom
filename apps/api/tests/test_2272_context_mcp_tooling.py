"""Regression coverage for context management on every MCP surface (#2272)."""
from __future__ import annotations

import importlib
import asyncio
import sys
import types
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def client_and_main(monkeypatch, tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-2272")
    monkeypatch.setenv("WORKEROS_USER_ID", "owner-2272")
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
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-2272"}) as client:
        yield client, main
    db.get_repositories.cache_clear()


def _call(main, name: str, arguments: dict) -> dict:
    from starlette.requests import Request

    body = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    auth = main.AuthContext(
        user_id="owner-2272", role="admin", auth_method="secret", scopes=("admin",)
    )
    request = Request({
        "type": "http", "method": "POST", "path": "/mcp-tools/serve",
        "query_string": b"", "headers": [(b"x-floom-secret", b"test-secret-2272")],
    })
    result = asyncio.run(main._mcp_handle_request(body, auth, main.get_repositories(), request))
    return result["result"]


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


def test_all_mcp_registries_expose_context_management_tools(client_and_main):
    _client, main = client_and_main
    expected = {"contexts.files", "contexts.delete", "contexts.versions"}
    assert expected <= {tool["name"] for tool in main._MCP_DEFAULT_TOOLS}
    assert expected <= {tool["name"] for tool in main._workeros_remote_mcp_tool_definitions()}
    stdio_source = (REPO_ROOT / "apps/mcp/src/server.ts").read_text(encoding="utf-8")
    for name in expected:
        assert f'"{name}"' in stdio_source
