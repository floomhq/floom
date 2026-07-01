from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    (tmp_path / "workers").mkdir()

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
    for _n in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(_n, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return db, main


def _run_headers(run_id: str) -> dict[str, str]:
    from run_token import make_run_token

    return {"X-Floom-Run-Token": make_run_token(run_id, secret="test-secret")}


def _worker_call_headers(run_id: str) -> dict[str, str]:
    from run_token import issue_worker_call_token

    return {
        "X-Floom-Run-Token": issue_worker_call_token(
            user_id="owner-a",
            parent_run_id=run_id,
            callable_workers=["child-worker"],
            secret="test-secret",
        )
    }


def test_composio_proxy_accepts_script_worker_call_token_header(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    repos.users.create(
        user_id="owner-a",
        username="owner-a",
        display_name=None,
        password_hash="x",
        role="admin",
    )
    manifest = {
        "id": "gmail-worker",
        "name": "Gmail Worker",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "calls": ["child-worker"],
        "connections": [{"app": "gmail", "allowed_tools": ["GMAIL_FETCH_EMAILS"]}],
    }
    repos.workers.create(
        user_id="owner-a",
        worker_id="gmail-worker",
        name="Gmail Worker",
        manifest_json=manifest,
        bundle_path="workers/gmail-worker",
    )
    repos.runs.create(
        user_id="owner-a",
        run_id="run-gmail",
        worker_id="gmail-worker",
        status="running",
        trigger_source="manual",
        runner="e2b",
    )
    repos.connections.upsert(
        user_id="owner-a",
        id="conn-row",
        app_name="gmail",
        composio_connection_id="ca_gmail",
        status="active",
    )

    captured = {}

    class _Response:
        def json(self):
            return {"successful": True, "data": {"messages": []}}

    def fake_post(url, *, headers, json, timeout):
        captured["url"] = url
        captured["json"] = json
        return _Response()

    monkeypatch.setattr("requests.post", fake_post)

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-gmail/composio-execute/GMAIL_FETCH_EMAILS",
        headers=_worker_call_headers("run-gmail"),
        json={"connected_account_id": "ca_gmail", "arguments": {"query": "is:unread"}},
    )

    assert resp.status_code == 200, resp.text
    assert captured["url"].endswith("/GMAIL_FETCH_EMAILS")
    assert captured["json"]["connected_account_id"] == "ca_gmail"
    assert captured["json"]["entity_id"] == "owner-a"
    assert captured["json"]["arguments"] == {"query": "is:unread"}

    mismatch = client.post(
        "/runs/run-gmail/composio-execute/GMAIL_FETCH_EMAILS",
        headers=_worker_call_headers("other-run"),
        json={"connected_account_id": "ca_gmail", "arguments": {}},
    )
    assert mismatch.status_code == 403
    assert mismatch.json()["detail"] == "Run token does not match request run_id"

    repos.users.update(user_id="owner-a", disabled=1)
    disabled = client.post(
        "/runs/run-gmail/composio-execute/GMAIL_FETCH_EMAILS",
        headers=_worker_call_headers("run-gmail"),
        json={"connected_account_id": "ca_gmail", "arguments": {}},
    )
    assert disabled.status_code == 401
    assert disabled.json()["detail"] == "account disabled"
    db.get_repositories.cache_clear()


def test_composio_proxy_accepts_public_connection_row_id(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    manifest = {
        "id": "gmail-worker",
        "name": "Gmail Worker",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "connections": [{"app": "gmail", "allowed_tools": ["GMAIL_FETCH_EMAILS"]}],
    }
    repos.workers.create(
        user_id="owner-a",
        worker_id="gmail-worker",
        name="Gmail Worker",
        manifest_json=manifest,
        bundle_path="workers/gmail-worker",
    )
    repos.runs.create(
        user_id="owner-a",
        run_id="run-gmail",
        worker_id="gmail-worker",
        status="running",
        trigger_source="manual",
        runner="e2b",
    )
    repos.connections.upsert(
        user_id="owner-a",
        id="public-conn-row",
        app_name="gmail",
        composio_connection_id="ca_private_gmail",
        status="active",
    )

    captured = {}

    class _Response:
        def json(self):
            return {"successful": True, "data": {"messages": []}}

    def fake_post(url, *, headers, json, timeout):
        captured["url"] = url
        captured["json"] = json
        return _Response()

    monkeypatch.setattr("requests.post", fake_post)

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-gmail/composio-execute/GMAIL_FETCH_EMAILS",
        headers=_run_headers("run-gmail"),
        json={"connected_account_id": "public-conn-row", "arguments": {"query": "is:unread"}},
    )

    assert resp.status_code == 200, resp.text
    assert captured["url"].endswith("/GMAIL_FETCH_EMAILS")
    assert captured["json"]["connected_account_id"] == "ca_private_gmail"
    assert captured["json"]["entity_id"] == "owner-a"
    assert captured["json"]["arguments"] == {"query": "is:unread"}
    db.get_repositories.cache_clear()


def test_composio_proxy_simple_run_token_uses_shared_worker_call_secret(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    manifest = {
        "id": "gmail-worker",
        "name": "Gmail Worker",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "connections": [{"app": "gmail", "allowed_tools": ["GMAIL_FETCH_EMAILS"]}],
    }
    repos.workers.create(
        user_id="owner-a",
        worker_id="gmail-worker",
        name="Gmail Worker",
        manifest_json=manifest,
        bundle_path="workers/gmail-worker",
    )
    repos.runs.create(
        user_id="owner-a",
        run_id="run-gmail",
        worker_id="gmail-worker",
        status="running",
        trigger_source="manual",
        runner="e2b",
    )
    repos.connections.upsert(
        user_id="owner-a",
        id="conn-row",
        app_name="gmail",
        composio_connection_id="ca_gmail",
        status="active",
    )

    captured = {}

    class _Response:
        def json(self):
            return {"successful": True, "data": {"messages": []}}

    def fake_post(url, *, headers, json, timeout):
        captured["url"] = url
        captured["json"] = json
        return _Response()

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.delenv("WORKEROS_RUN_TOKEN_SECRET", raising=False)
    monkeypatch.setenv("WORKEROS_WORKER_CALL_SECRET", "shared")
    monkeypatch.setenv("FLOOM_SECRET", "orch-only")

    from run_token import make_run_token

    token = make_run_token("run-gmail")
    monkeypatch.setenv("FLOOM_SECRET", "web-only")

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-gmail/composio-execute/GMAIL_FETCH_EMAILS",
        headers={"X-Floom-Run-Token": token},
        json={"connected_account_id": "ca_gmail", "arguments": {"query": "is:unread"}},
    )

    assert resp.status_code == 200, resp.text
    assert captured["url"].endswith("/GMAIL_FETCH_EMAILS")
    assert captured["json"]["connected_account_id"] == "ca_gmail"
    assert captured["json"]["entity_id"] == "owner-a"
    assert captured["json"]["arguments"] == {"query": "is:unread"}
    db.get_repositories.cache_clear()


def test_composio_proxy_derives_entity_id_from_run_owner(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    manifest = {
        "id": "gsc-worker",
        "name": "GSC Worker",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [
            {
                "app": "google_search_console",
                "allowed_tools": ["GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY"],
            }
        ],
    }
    repos.workers.create(
        user_id="owner-a",
        worker_id="gsc-worker",
        name="GSC Worker",
        manifest_json=manifest,
        bundle_path="workers/gsc-worker",
    )
    repos.runs.create(
        user_id="owner-a",
        run_id="run-gsc",
        worker_id="gsc-worker",
        status="running",
        trigger_source="manual",
        runner="e2b",
    )
    repos.connections.upsert(
        user_id="owner-a",
        id="conn-row",
        app_name="google_search_console",
        composio_connection_id="ca_test",
        status="active",
    )

    captured = {}

    class _Response:
        def json(self):
            return {"successful": True, "data": {"rows": []}}

    def fake_post(url, *, headers, json, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        captured["timeout"] = timeout
        return _Response()

    monkeypatch.setattr("requests.post", fake_post)

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-gsc/composio-execute/GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY",
        headers=_run_headers("run-gsc"),
        json={
            "connected_account_id": "ca_test",
            "arguments": {"site_url": "https://rocketlist.ai/"},
        },
    )

    assert resp.status_code == 200
    assert captured["json"]["connected_account_id"] == "ca_test"
    assert captured["json"]["entity_id"] == "owner-a"
    assert "user_id" not in captured["json"]
    assert captured["json"]["arguments"] == {"site_url": "https://rocketlist.ai/"}
    db.get_repositories.cache_clear()


def test_composio_proxy_accepts_cross_app_tool_in_explicit_allowlist(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    manifest = {
        "id": "sheets-worker",
        "name": "Sheets Worker",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [
            {
                "app": "googlesheets",
                "allowed_tools": [
                    "GOOGLESHEETS_BATCH_GET",
                    "GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE",
                ],
            }
        ],
    }
    repos.workers.create(
        user_id="owner-a",
        worker_id="sheets-worker",
        name="Sheets Worker",
        manifest_json=manifest,
        bundle_path="workers/sheets-worker",
    )
    repos.runs.create(
        user_id="owner-a",
        run_id="run-sheets",
        worker_id="sheets-worker",
        status="running",
        trigger_source="manual",
        runner="e2b",
    )
    repos.connections.upsert(
        user_id="owner-a",
        id="conn-row",
        app_name="googlesheets",
        composio_connection_id="ca_sheets",
        status="active",
    )

    captured = {}

    class _Response:
        def json(self):
            return {"successful": True, "data": {"shared": True}}

    def fake_post(url, *, headers, json, timeout):
        captured["url"] = url
        captured["json"] = json
        return _Response()

    monkeypatch.setattr("requests.post", fake_post)

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-sheets/composio-execute/GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE",
        headers=_run_headers("run-sheets"),
        json={"connected_account_id": "ca_sheets", "arguments": {"file_id": "sheet-1"}},
    )

    assert resp.status_code == 200, resp.text
    assert captured["url"].endswith("/GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE")
    assert captured["json"]["connected_account_id"] == "ca_sheets"
    assert captured["json"]["entity_id"] == "owner-a"
    assert captured["json"]["arguments"] == {"file_id": "sheet-1"}
    db.get_repositories.cache_clear()


def test_composio_proxy_rejects_sandbox_user_id_override(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    manifest = {
        "id": "gsc-worker",
        "name": "GSC Worker",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "connections": [{"app": "google_search_console"}],
    }
    repos.workers.create(
        user_id="owner-a",
        worker_id="gsc-worker",
        name="GSC Worker",
        manifest_json=manifest,
        bundle_path="workers/gsc-worker",
    )
    repos.runs.create(
        user_id="owner-a",
        run_id="run-gsc",
        worker_id="gsc-worker",
        status="running",
        trigger_source="manual",
        runner="e2b",
    )
    repos.connections.upsert(
        user_id="owner-a",
        id="conn-row",
        app_name="google_search_console",
        composio_connection_id="ca_test",
        status="active",
    )

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-gsc/composio-execute/GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY",
        headers=_run_headers("run-gsc"),
        json={"connected_account_id": "ca_test", "user_id": "other-user"},
    )

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Proxy user_id must match the run owner"
    db.get_repositories.cache_clear()


def test_composio_proxy_enforces_read_only_scope(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    manifest = {
        "id": "gmail-worker",
        "name": "Gmail Worker",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "connections": [{"app": "gmail", "scope": "read_only"}],
    }
    repos.workers.create(
        user_id="owner-a",
        worker_id="gmail-worker",
        name="Gmail Worker",
        manifest_json=manifest,
        bundle_path="workers/gmail-worker",
    )
    repos.runs.create(
        user_id="owner-a",
        run_id="run-gmail",
        worker_id="gmail-worker",
        status="running",
        trigger_source="manual",
        runner="e2b",
    )
    repos.connections.upsert(
        user_id="owner-a",
        id="conn-row",
        app_name="gmail",
        composio_connection_id="ca_gmail",
        status="active",
    )

    calls = []

    class _Response:
        def json(self):
            return {"successful": True}

    def fake_post(url, *, headers, json, timeout):
        calls.append((url, json))
        return _Response()

    monkeypatch.setattr("requests.post", fake_post)

    client = TestClient(main.app)
    read_resp = client.post(
        "/runs/run-gmail/composio-execute/GMAIL_FETCH_EMAILS",
        headers=_run_headers("run-gmail"),
        json={"connected_account_id": "ca_gmail", "arguments": {}},
    )
    assert read_resp.status_code == 200, read_resp.text
    assert len(calls) == 1

    write_resp = client.post(
        "/runs/run-gmail/composio-execute/GMAIL_SEND_EMAIL",
        headers=_run_headers("run-gmail"),
        json={"connected_account_id": "ca_gmail", "arguments": {}},
    )
    assert write_resp.status_code == 403
    assert "outside the worker connection scope" in write_resp.json()["detail"]
    assert len(calls) == 1
    db.get_repositories.cache_clear()


def test_composio_proxy_uses_scoped_recipe_when_unscoped_cache_is_stale(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    worker_id = "gmail-worker"
    workspace_id = "ws-gmail"
    manifest = {
        "id": worker_id,
        "name": "Gmail Worker",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "connections": [{"app": "gmail", "allowed_tools": ["GMAIL_FETCH_EMAILS"]}],
    }
    repos.workers.create(
        user_id="owner-a",
        worker_id=worker_id,
        name="Gmail Worker",
        manifest_json=manifest,
        bundle_path="workers/gmail-worker",
        workspace_id=workspace_id,
    )
    repos.runs.create(
        user_id="owner-a",
        run_id="run-gmail",
        worker_id=worker_id,
        status="running",
        trigger_source="manual",
        runner="e2b",
    )
    repos.connections.upsert(
        user_id="owner-a",
        id="conn-row",
        app_name="gmail",
        composio_connection_id="ca_gmail",
        status="active",
    )

    from db.sqlite import _recipe_cache
    from models import WorkerConfig, WorkerRuntime, WorkerTrigger

    stale_config = WorkerConfig(
        id=worker_id,
        name="Stale Gmail Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b", entrypoint="run.py"),
        connections=[],
    )
    stale_recipe = {
        "config": stale_config,
        "grants": {},
        "input_values": {},
        "enabled": True,
        "owner_id": "owner-a",
        "bundle_path": "workers/gmail-worker",
        "manifest_json": {},
    }
    original_get_worker_config_for_run = main.get_worker_config_for_run
    captured_kwargs = {}

    def get_worker_config_with_stale_cache(worker_id_arg, **kwargs):
        captured_kwargs.update(kwargs)
        token = _recipe_cache.set({worker_id: stale_recipe})
        try:
            return original_get_worker_config_for_run(worker_id_arg, **kwargs)
        finally:
            _recipe_cache.reset(token)

    captured_post = {}

    class _Response:
        def json(self):
            return {"successful": True, "data": {"messages": []}}

    def fake_post(url, *, headers, json, timeout):
        captured_post["url"] = url
        captured_post["json"] = json
        return _Response()

    monkeypatch.setattr(main, "get_worker_config_for_run", get_worker_config_with_stale_cache)
    monkeypatch.setattr("requests.post", fake_post)

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-gmail/composio-execute/GMAIL_FETCH_EMAILS",
        headers=_run_headers("run-gmail"),
        json={"connected_account_id": "ca_gmail", "arguments": {"query": "is:unread"}},
    )

    assert resp.status_code == 200, resp.text
    assert captured_kwargs["repos"] is repos
    assert captured_kwargs["user_id"] == "owner-a"
    assert captured_kwargs["workspace_id"] == workspace_id
    assert captured_post["url"].endswith("/GMAIL_FETCH_EMAILS")
    assert captured_post["json"]["connected_account_id"] == "ca_gmail"
    assert captured_post["json"]["entity_id"] == "owner-a"
    db.get_repositories.cache_clear()
