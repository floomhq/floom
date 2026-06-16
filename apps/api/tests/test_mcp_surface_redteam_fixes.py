"""Regression tests for the MCP-surface bugs a red-team found (2026-06-14).

Findings (all verified live on cloud + OSS before the fix):

* M-01 — ``workers.create`` via the remote ``/api/mcp`` surface crashed with
  ``-32603 ... missing 1 required positional argument: 'request'`` because the
  in-process dispatcher ``_mcp_call_workers_create`` did not pass the ``request``
  positional that ``create_worker`` now requires.
* M-02 — ``workers.update`` crashed with ``-32603 ... no attribute 'worker_yml'``
  because the dispatcher called the module-name ``update_worker`` which is
  shadowed by the PUT full-rewrite handler (WorkerCreateRequest-based), not the
  PATCH instance-settings handler the contract intends.
* M-03 — ``/mcp-tools/serve`` tools/call returned ``x-floom-user header required``
  for every tool under ``WORKEROS_ENABLE_USER_HEADER_SCOPE=1`` because the
  in-process ``_api_call`` proxy did not forward ``x-floom-user``.
* M-04 — the remote ``/api/mcp`` proxy serialized raw exceptions into the
  JSON-RPC error message (``... failed: {exc}``), leaking server internals.
* M-05 — the static ``WORKSPACE_AGENT_MCP_TOKEN`` short-circuited to the global
  bootstrap admin context on cloud, granting cross-tenant admin to any holder of
  the single cloud-wide secret.

Run:
    cd apps/api && python -m pytest tests/test_mcp_surface_redteam_fixes.py -v
"""
from __future__ import annotations

import importlib
import json
import sys
import textwrap
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request


def _load_api(monkeypatch, tmp_path, *, deploy="local", user_header_scope=False):
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
    monkeypatch.setenv("WORKEROS_USER_ID", "mcp-test-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", deploy)
    monkeypatch.setenv("WORKSPACE_AGENT_MCP_TOKEN", "test-langdock-token")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)
    if user_header_scope:
        monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    else:
        monkeypatch.delenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", raising=False)

    sys.path.insert(0, str(api_dir))
    for name in list(sys.modules):
        if any(name == m or name.startswith(m + ".") for m in [
            "main", "db", "models", "worker_registry", "runner_utils",
            "run_service", "chat_service", "auth", "contexts", "git_ops",
        ]):
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


def _auth_headers(token="test-langdock-token"):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _serve_headers():
    return {"x-floom-secret": "test-api-secret", "Content-Type": "application/json"}


def _worker_yml(worker_id: str) -> str:
    return textwrap.dedent(
        f"""
        schema_version: "0.3"
        id: "{worker_id}"
        name: "{worker_id}"
        title: t
        description: d
        version: "0.1.0"
        exec:
          entry: run.py
          runtime: python311
          runner: e2b
          command: python run.py
          inputs: []
          outputs: []
        trigger:
          type: manual
        """
    ).strip()


# ---------------------------------------------------------------------------
# M-01 — workers.create via /api/mcp must create a worker (not -32603)
# ---------------------------------------------------------------------------

def test_m01_workers_create_via_mcp_creates_worker(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/call", params={
                "name": "workers.create",
                "arguments": {
                    "worker_yml": _worker_yml("m01-created"),
                    "run_py": "print('hi')",
                },
            })),
            headers=_auth_headers(),
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "error" not in body, body
    result = body["result"]
    assert result["isError"] is False, result
    assert result["structuredContent"]["id"] == "m01-created"

    # the worker really exists now
    with TestClient(main.app) as client:
        listed = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/call", request_id=2, params={
                "name": "workers.get", "arguments": {"id": "m01-created"},
            })),
            headers=_auth_headers(),
        )
    assert listed.json()["result"]["isError"] is False


# ---------------------------------------------------------------------------
# M-02 — workers.update via /api/mcp updates instance settings (no worker_yml attr)
# ---------------------------------------------------------------------------

def test_m02_workers_update_via_mcp_updates_worker(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/call", params={
                "name": "workers.create",
                "arguments": {
                    "worker_yml": _worker_yml("m02-target"),
                    "run_py": "print('hi')",
                },
            })),
            headers=_auth_headers(),
        )
        resp = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/call", request_id=2, params={
                "name": "workers.update",
                "arguments": {
                    "id": "m02-target",
                    "trigger_type": "cron",
                    "cron_expr": "0 9 * * *",
                    "cron_timezone": "UTC",
                },
            })),
            headers=_auth_headers(),
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "error" not in body, body
    result = body["result"]
    assert result["isError"] is False, result
    assert result["structuredContent"]["id"] == "m02-target"


def test_m02_update_worker_instance_alias_is_the_patch_handler(monkeypatch, tmp_path):
    """The instance alias must be the PATCH (WorkerUpdateRequest) handler, not the
    PUT full-rewrite (WorkerCreateRequest) handler the plain name resolves to."""
    main = _load_api(monkeypatch, tmp_path)
    import inspect

    patch_params = inspect.signature(main.update_worker_instance).parameters
    assert "payload" in patch_params
    # PATCH handler's payload is WorkerUpdateRequest (no worker_yml)
    assert patch_params["payload"].annotation is main.WorkerUpdateRequest
    # the shadowed plain name is the PUT full-rewrite handler
    assert main.update_worker is not main.update_worker_instance


# ---------------------------------------------------------------------------
# M-03 — _api_call must forward x-floom-user (user-header scope)
# ---------------------------------------------------------------------------

def test_m03_x_floom_user_in_forwarded_header_allowlist(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    assert "x-floom-user" in main._API_CALL_AUTH_HEADERS


def test_m03_tool_executes_under_user_header_scope(monkeypatch, tmp_path):
    """With user-header scope on, /mcp-tools/serve tools/call must execute the
    proxied tool instead of failing closed with 'x-floom-user header required'."""
    main = _load_api(monkeypatch, tmp_path, user_header_scope=True)
    headers = {
        "x-floom-secret": "test-api-secret",
        "x-floom-user": "tenant-user-a",
        "Content-Type": "application/json",
    }
    with TestClient(main.app) as client:
        resp = client.post(
            "/mcp-tools/serve",
            data=json.dumps(_rpc("tools/call", params={
                "name": "workers.list", "arguments": {},
            })),
            headers=headers,
        )
    assert resp.status_code == 200, resp.text
    result = resp.json()["result"]
    # the key bug: under the user-header scope the proxied sub-request used to
    # 401 with "x-floom-user header required"; it must now succeed.
    assert result["isError"] is False, result
    text = json.dumps(result)
    assert "x-floom-user header required" not in text


# M-06 / #1295 - /mcp-tools/serve must return JSON-RPC errors, not raw 500s

def test_m06_mcp_serve_accepts_json_rpc_batch(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    payload = [
        _rpc("tools/list", request_id=1),
        _rpc("tools/call", request_id=2, params={"name": "runs.get", "arguments": {}}),
    ]
    with TestClient(main.app) as client:
        resp = client.post("/mcp-tools/serve", data=json.dumps(payload), headers=_serve_headers())

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body, list)
    assert body[0]["id"] == 1
    assert "result" in body[0]
    assert body[1]["id"] == 2
    assert body[1]["error"]["code"] == -32602
    assert "missing id" in body[1]["error"]["message"]


def test_m06_mcp_serve_rejects_non_object_tool_arguments(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    payload = _rpc("tools/call", params={"name": "runs.get", "arguments": []})
    with TestClient(main.app) as client:
        resp = client.post("/mcp-tools/serve", data=json.dumps(payload), headers=_serve_headers())

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["error"]["code"] == -32602
    assert body["error"]["message"] == "Invalid params"


def test_m06_mcp_serve_rejects_non_object_json_rpc_payload(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.post("/mcp-tools/serve", data=json.dumps("not an object"), headers=_serve_headers())

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["error"]["code"] == -32600
    assert body["error"]["message"] == "Invalid JSON-RPC request"


# M-04 - /api/mcp must not leak raw exception detail

def test_m04_generic_error_no_internal_leak(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    secret = "SQLSTATE-42P01 column federico::float infinity boom"

    async def _boom(tool_name, arguments):
        raise RuntimeError(secret)

    monkeypatch.setattr(main, "_call_workeros_remote_mcp_tool", _boom)

    with TestClient(main.app) as client:
        resp = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/call", params={
                "name": "workers.list", "arguments": {},
            })),
            headers=_auth_headers(),
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["error"]["code"] == -32603
    assert body["error"]["message"] == "Internal server error"
    # none of the raw internals leak to the client
    assert secret not in json.dumps(body)
    assert "SQLSTATE" not in json.dumps(body)
    assert "federico" not in json.dumps(body)


# ---------------------------------------------------------------------------
# M-05 — static token must NOT grant cross-tenant admin on cloud
# ---------------------------------------------------------------------------

def test_m05_static_token_rejected_on_cloud(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, deploy="cloud")
    from auth import AuthContext, register_auth_provider

    class FakeCloudAuthProvider:
        async def verify(self, request):
            # only a real per-tenant PAT is accepted on cloud
            if request.headers.get("x-floom-token") != "workspace-pat":
                raise main.HTTPException(status_code=401, detail="invalid token")
            return AuthContext(user_id="tenant-a-user", scopes=("api",))

    register_auth_provider("cloud", lambda: FakeCloudAuthProvider())

    with TestClient(main.app) as client:
        # the static WORKSPACE_AGENT_MCP_TOKEN must be rejected on cloud — it
        # carries no workspace binding, so it must NOT short-circuit to admin.
        static = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/list")),
            headers=_auth_headers("test-langdock-token"),
        )
        # a per-tenant PAT still works (Emily's correct cloud path)
        pat = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/list")),
            headers={"x-floom-token": "workspace-pat", "Content-Type": "application/json"},
        )
    assert static.status_code == 401, static.text
    assert pat.status_code == 200, pat.text


def test_m05_static_token_still_works_on_oss_local(monkeypatch, tmp_path):
    """The static token remains the legitimate single-tenant credential on OSS."""
    main = _load_api(monkeypatch, tmp_path, deploy="local")
    with TestClient(main.app) as client:
        resp = client.post(
            "/api/mcp",
            data=json.dumps(_rpc("tools/list")),
            headers=_auth_headers("test-langdock-token"),
        )
    assert resp.status_code == 200, resp.text
    assert "result" in resp.json()
