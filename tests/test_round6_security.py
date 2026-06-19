from __future__ import annotations

import importlib
import os
import sys
import types
import uuid
from pathlib import Path
from unittest.mock import patch

import yaml
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

AUTH = {"x-floom-secret": "round6-secret"}


def _load_api(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("FLOOM_SECRET", AUTH["x-floom-secret"])
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setenv("WORKEROS_USER_ID", "user-a")
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGIN_REGEX", raising=False)
    monkeypatch.delenv("WORKEROS_DEV", raising=False)

    for name in [
        "main",
        "db",
        "files",
        "models",
        "worker_registry",
        "run_service",
        "composio_client",
        "scheduler",
    ]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _headers(user_id: str = "user-a") -> dict[str, str]:
    return {**AUTH, "x-floom-user": user_id}


def _insert_connection(main, *, user_id: str, app_name: str = "gmail") -> str:
    local_id = f"local_{uuid.uuid4().hex}"
    with main.get_db() as conn:
        conn.execute(
            """
            INSERT INTO composio_connections
                (id, app_name, composio_connection_id, status, created_at, updated_at, user_id)
            VALUES (?, ?, ?, 'active', ?, ?, ?)
            """,
            (
                local_id,
                app_name,
                f"ca_{uuid.uuid4().hex}",
                main.now_iso(),
                main.now_iso(),
                user_id,
            ),
        )
    return local_id


def test_delete_connection_requires_auth(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.delete(f"/connections/{uuid.uuid4()}")

    assert resp.status_code == 401


def test_delete_connection_requires_ownership(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    with patch("composio_client.initiate_connection") as mocked:
        mocked.return_value = {
            "composio_connection_id": f"ca_{uuid.uuid4().hex}",
            "redirect_url": "https://auth.example.test",
        }
        created = client.post("/connections", json={"app_name": "gmail"}, headers=_headers("user-a"))
    assert created.status_code == 200, created.text

    with patch("composio_client.revoke_connection") as revoke:
        resp = client.delete(f"/connections/{created.json()['id']}", headers=_headers("user-b"))

    assert resp.status_code == 404
    revoke.assert_not_called()


def test_get_connections_scoped_to_caller(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    owned = _insert_connection(main, user_id="user-a", app_name="gmail")
    _insert_connection(main, user_id="user-b", app_name="slack")

    resp = client.get("/connections", headers=_headers("user-a"))

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [item["id"] for item in body] == [owned]
    assert "connection_id" not in body[0]
    assert "composio_connection_id" not in body[0]


def test_request_body_size_limit(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/workers/nope/runs",
        headers={**_headers("user-a"), "content-type": "application/json"},
        content=b"x" * (2 * 1024 * 1024),
    )

    assert resp.status_code == 413


def test_validation_error_does_not_echo_body(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    marker = "MALFORMED_INPUT_MARKER_" * 100

    resp = client.post("/workers", headers=_headers("user-a"), json={"worker_yml": marker, "run_py": 123})

    assert resp.status_code == 422
    assert marker not in resp.text


def test_validation_error_does_not_leak_schema(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post("/workers", headers=_headers("user-a"), json={})

    assert resp.status_code == 422
    assert "worker_yml" not in resp.text
    assert "run_py" not in resp.text
    assert "bundle" not in resp.text


def test_cors_blocks_unknown_origin(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.options(
        "/workers",
        headers={
            "Origin": "https://evil.com",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert resp.headers.get("access-control-allow-origin") != "https://evil.com"


def test_run_create_missing_worker_is_not_ip_globally_limited(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    responses = [
        client.post("/workers/nope/runs", headers=_headers("user-a"), json={"inputs": {}})
        for _ in range(11)
    ]

    assert [response.status_code for response in responses] == [404] * 11


def test_stock_agent_workers_do_not_require_user_openai_secret():
    for relative in ["workers/research_brief/worker.yml"]:
        manifest = yaml.safe_load((Path(__file__).resolve().parents[1] / relative).read_text())
        exec_secrets = ((manifest.get("exec") or {}).get("secrets") or [])
        capability_secrets = ((manifest.get("capabilities") or {}).get("secrets") or [])
        assert "OPENAI_API_KEY" not in exec_secrets
        assert "OPENAI_API_KEY" not in capability_secrets


def test_agent_tool_schemas_emit_native_web_search(monkeypatch, tmp_path):
    _load_api(monkeypatch, tmp_path)
    from runner_sandbox.agent_driver import AgentDriver

    config = types.SimpleNamespace(
        outputs=[],
        connections=[],
        runtime=types.SimpleNamespace(disable_tools=[]),
    )

    tools = AgentDriver()._tool_schemas(config)

    assert any(tool.get("type") == "web_search" for tool in tools)
    assert all(tool.get("type") in {"function", "custom", "web_search"} for tool in tools)
