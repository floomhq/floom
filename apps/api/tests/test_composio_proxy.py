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

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return db, main


def _run_headers(run_id: str) -> dict[str, str]:
    from run_token import make_run_token

    return {"X-Workeros-Run-Token": make_run_token(run_id, secret="test-secret")}


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
