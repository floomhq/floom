import base64
import hashlib
import hmac
import importlib
import json
import sys
import time
import types
from pathlib import Path

from fastapi.testclient import TestClient


_AUTH_HEADER = {"x-floom-secret": "test-composio-secret"}


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_SECRET", _AUTH_HEADER["x-floom-secret"])
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")
    monkeypatch.setenv("COMPOSIO_WEBHOOK_SIGNING_KEY", "test-signing-key")
    monkeypatch.setenv("COMPOSIO_WEBHOOK_URL", "https://example.test/composio-events")

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "composio_client"]:
        sys.modules.pop(name, None)
        for _rn in [n for n in list(sys.modules) if n.startswith("routers")]:
            sys.modules.pop(_rn, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    run_service = importlib.import_module("run_service")
    main.start_run = lambda *args, **kwargs: None
    run_service.start_run = main.start_run
    composio_client = importlib.import_module("composio_client")
    return main, composio_client


def _worker_yml(event="GMAIL_NEW_EMAIL", connection_id="conn_gmail_federico_stub"):
    return f"""
schema_version: "0.3"
name: gmail-composio
title: "Gmail Composio"
description: "Run from a Composio Gmail event."
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  inputs: []
  secrets: []
  outputs:
  - name: result
    kind: scalar
    type: string
    required: true
    label: Result
capabilities:
  secrets: []
  network: {{ egress: false }}
approvals:
  required: false
trigger:
  type: composio
  composio:
    event: "{event}"
    connection_id: "{connection_id}"
    filters: {{}}
""".strip()


RUN_PY = """
from typing import Any, Dict

def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    return {"status": "success", "outputs": {"result": "ok"}, "artifacts": []}
""".strip()


def _signature(body: bytes, key="test-signing-key"):
    return "sha256=" + hmac.new(key.encode(), body, hashlib.sha256).hexdigest()


def _composio_webhook_headers(body: bytes, key="test-signing-key"):
    webhook_id = "msg_test_123"
    webhook_timestamp = str(int(time.time()))
    signing_string = f"{webhook_id}.{webhook_timestamp}.{body.decode('utf-8')}".encode()
    signature = base64.b64encode(
        hmac.new(key.encode(), signing_string, hashlib.sha256).digest()
    ).decode()
    return {
        "webhook-id": webhook_id,
        "webhook-timestamp": webhook_timestamp,
        "webhook-signature": f"v1,{signature}",
        "Content-Type": "application/json",
    }


def _create_worker(client):
    return client.post(
        "/workers",
        headers=_AUTH_HEADER,
        json={"worker_yml": _worker_yml(), "run_py": RUN_PY},
    )


def test_worker_create_with_composio_trigger_calls_enable(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    calls = []

    def fake_enable(event, connection_id, webhook_url, config):
        calls.append((event, connection_id, webhook_url, config))
        return "ct_gmail_123"

    monkeypatch.setattr(composio_client, "enable_trigger", fake_enable)
    with TestClient(main.app) as client:
        response = _create_worker(client)

    assert response.status_code == 200, response.text
    assert calls == [
        ("GMAIL_NEW_EMAIL", "conn_gmail_federico_stub", "https://example.test/composio-events", {})
    ]
    with main.get_db() as conn:
        row = conn.execute("SELECT composio_trigger_id, composio_event FROM workers WHERE id = ?", ("gmail-composio",)).fetchone()
    assert row["composio_trigger_id"] == "ct_gmail_123"
    assert row["composio_event"] == "GMAIL_NEW_EMAIL"


def test_composio_events_with_valid_hmac_creates_run(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_gmail_123")
    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        body = json.dumps({
            "id": "msg_abc123",
            "type": "composio.trigger.message",
            "metadata": {
                "trigger_id": "ct_gmail_123",
                "trigger_slug": "GMAIL_NEW_EMAIL",
                "connected_account_id": "conn_gmail_federico_stub",
            },
            "data": {"subject": "Hello"},
        }).encode()
        response = client.post(
            "/composio-events",
            content=body,
            headers=_composio_webhook_headers(body),
        )

    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    with main.get_db() as conn:
        row = conn.execute("SELECT worker_id, trigger_source, input_json FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert row["worker_id"] == "gmail-composio"
    assert row["trigger_source"] == "composio"
    assert json.loads(row["input_json"])["event"]["data"]["subject"] == "Hello"


def test_composio_events_scopes_duplicate_trigger_id_by_connected_account(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_shared")
    other_user = "other-user"
    other_worker = "gmail-composio-other"

    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        repos = main.get_repositories()
        repos.workers.create(
            user_id=other_user,
            worker_id=other_worker,
            name="other-gmail-composio",
            manifest_json={
                "schema_version": "0.3",
                "id": other_worker,
                "name": "other-gmail-composio",
                "title": "Other Gmail Composio",
                "description": "Run from a Composio Gmail event.",
                "version": "0.1.0",
                "entrypoint": "SKILL.md",
                "exec": {"command": "python run.py", "runtime": "python311", "runner": "e2b"},
                "inputs": [],
                "outputs": [],
                "secrets": [],
                "trigger": {
                    "type": "composio",
                    "composio": {
                        "event": "GMAIL_NEW_EMAIL",
                        "connection_id": "conn_gmail_other_stub",
                    },
                },
            },
            composio_trigger_id="ct_shared",
            composio_event="GMAIL_NEW_EMAIL",
        )
        repos.workers.reconcile_triggers(
            worker_id=other_worker,
            triggers=[{"type": "composio_event", "event": "GMAIL_NEW_EMAIL"}],
            external_trigger_id="ct_shared",
        )
        repos.connections.upsert(
            user_id=other_user,
            id="conn-row-other",
            app_name="gmail",
            composio_connection_id="conn_gmail_other_stub",
            status="active",
        )
        body = json.dumps({
            "id": "msg_tenant_scoped",
            "metadata": {
                "trigger_id": "ct_shared",
                "trigger_slug": "GMAIL_NEW_EMAIL",
                "connected_account_id": "conn_gmail_other_stub",
            },
            "data": {"subject": "tenant-scoped"},
        }).encode()
        response = client.post(
            "/composio-events",
            content=body,
            headers=_composio_webhook_headers(body),
        )

    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    with main.get_db() as conn:
        row = conn.execute("SELECT worker_id, trigger_ref FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert row["worker_id"] == other_worker
    assert row["trigger_ref"] == f"trg_{other_worker}_0"


def test_composio_events_replay_same_delivery_is_ignored(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_gmail_123")
    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        body = json.dumps({
            "id": "msg_replay_123",
            "type": "composio.trigger.message",
            "metadata": {
                "trigger_id": "ct_gmail_123",
                "trigger_slug": "GMAIL_NEW_EMAIL",
                "connected_account_id": "conn_gmail_federico_stub",
            },
            "data": {"subject": "Replay me"},
        }).encode()
        headers = _composio_webhook_headers(body)
        first = client.post("/composio-events", content=body, headers=headers)
        second = client.post("/webhooks/composio-events", content=body, headers=headers)

    assert first.status_code == 200, first.text
    assert first.json()["status"] == "queued"
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "duplicate_ignored"
    assert second.json().get("run_id") is None
    with main.get_db() as conn:
        run_count = conn.execute("SELECT COUNT(*) AS count FROM runs").fetchone()["count"]
    assert run_count == 1


def test_composio_events_with_invalid_hmac_returns_401(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_gmail_123")
    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        body = json.dumps({
            "metadata": {"trigger_id": "ct_gmail_123", "trigger_slug": "GMAIL_NEW_EMAIL"},
            "data": {},
        }).encode()
        response = client.post(
            "/composio-events",
            content=body,
            headers={
                "webhook-id": "msg_bad",
                "webhook-timestamp": str(int(time.time())),
                "webhook-signature": "v1,bad",
                "Content-Type": "application/json",
            },
        )

    assert response.status_code == 401, response.text


def test_composio_events_rejects_legacy_body_only_hmac(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_gmail_123")

    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        body = json.dumps({
            "metadata": {"trigger_id": "ct_gmail_123", "trigger_slug": "GMAIL_NEW_EMAIL"},
            "data": {"subject": "legacy"},
        }).encode()
        response = client.post(
            "/composio-events",
            content=body,
            headers={"X-Composio-Signature": _signature(body), "Content-Type": "application/json"},
        )

    assert response.status_code == 401, response.text


def test_worker_delete_calls_composio_disable(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    disabled = []
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_gmail_123")
    monkeypatch.setattr(composio_client, "disable_trigger", lambda event, trigger_id=None: disabled.append((event, trigger_id)))

    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        deleted = client.delete("/workers/gmail-composio", headers=_AUTH_HEADER)

    assert deleted.status_code == 204, deleted.text
    assert disabled == [("GMAIL_NEW_EMAIL", "ct_gmail_123")]


def test_worker_update_trigger_change_disables_previous_composio_trigger(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    enabled = []
    disabled = []

    def fake_enable(event, connection_id, webhook_url, config):
        trigger_id = f"ct_gmail_{len(enabled) + 1}"
        enabled.append((event, connection_id, webhook_url, config, trigger_id))
        return trigger_id

    monkeypatch.setattr(composio_client, "enable_trigger", fake_enable)
    monkeypatch.setattr(composio_client, "disable_trigger", lambda event, trigger_id=None: disabled.append((event, trigger_id)))

    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        updated = client.put(
            "/workers/gmail-composio",
            headers=_AUTH_HEADER,
            json={"worker_yml": _worker_yml(connection_id="conn_gmail_second"), "run_py": RUN_PY},
        )
        assert updated.status_code == 200, updated.text

    assert enabled == [
        ("GMAIL_NEW_EMAIL", "conn_gmail_federico_stub", "https://example.test/composio-events", {}, "ct_gmail_1"),
        ("GMAIL_NEW_EMAIL", "conn_gmail_second", "https://example.test/composio-events", {}, "ct_gmail_2"),
    ]
    assert disabled == [("GMAIL_NEW_EMAIL", "ct_gmail_1")]
    with main.get_db() as conn:
        row = conn.execute("SELECT composio_trigger_id, composio_event FROM workers WHERE id = ?", ("gmail-composio",)).fetchone()
    assert row["composio_trigger_id"] == "ct_gmail_2"
    assert row["composio_event"] == "GMAIL_NEW_EMAIL"


def test_worker_update_rolls_back_new_composio_trigger_when_old_disable_fails(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    enabled = []
    disabled = []

    def fake_enable(event, connection_id, webhook_url, config):
        trigger_id = f"ct_gmail_{len(enabled) + 1}"
        enabled.append((event, connection_id, trigger_id))
        return trigger_id

    def fake_disable(event, trigger_id=None):
        disabled.append((event, trigger_id))
        if trigger_id == "ct_gmail_1":
            raise RuntimeError("old disable failed")

    monkeypatch.setattr(composio_client, "enable_trigger", fake_enable)
    monkeypatch.setattr(composio_client, "disable_trigger", fake_disable)

    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        updated = client.put(
            "/workers/gmail-composio",
            headers=_AUTH_HEADER,
            json={"worker_yml": _worker_yml(connection_id="conn_gmail_second"), "run_py": RUN_PY},
        )

    assert updated.status_code == 502, updated.text
    assert enabled == [
        ("GMAIL_NEW_EMAIL", "conn_gmail_federico_stub", "ct_gmail_1"),
        ("GMAIL_NEW_EMAIL", "conn_gmail_second", "ct_gmail_2"),
    ]
    assert disabled == [
        ("GMAIL_NEW_EMAIL", "ct_gmail_1"),
        ("GMAIL_NEW_EMAIL", "ct_gmail_2"),
    ]
    with main.get_db() as conn:
        row = conn.execute("SELECT composio_trigger_id FROM workers WHERE id = ?", ("gmail-composio",)).fetchone()
    assert row["composio_trigger_id"] == "ct_gmail_1"


def test_composio_events_with_stale_trigger_id_does_not_fallback_to_event(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_current")

    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        body = json.dumps({
            "metadata": {
                "trigger_id": "ct_stale",
                "trigger_slug": "GMAIL_NEW_EMAIL",
            },
            "data": {"subject": "stale"},
        }).encode()
        response = client.post(
            "/composio-events",
            content=body,
            headers=_composio_webhook_headers(body),
        )

    assert response.status_code == 404, response.text
    with main.get_db() as conn:
        run_count = conn.execute("SELECT COUNT(*) AS count FROM runs").fetchone()["count"]
    assert run_count == 0


def test_composio_events_with_stale_trigger_instance_id_does_not_fallback_to_event(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_current")

    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        body = json.dumps({
            "metadata": {
                "trigger_instance_id": "ct_stale",
                "trigger_slug": "GMAIL_NEW_EMAIL",
            },
            "data": {"subject": "stale instance"},
        }).encode()
        response = client.post(
            "/composio-events",
            content=body,
            headers=_composio_webhook_headers(body),
        )

    assert response.status_code == 404, response.text
    with main.get_db() as conn:
        run_count = conn.execute("SELECT COUNT(*) AS count FROM runs").fetchone()["count"]
    assert run_count == 0


def test_composio_events_without_trigger_id_can_fallback_to_unique_event_with_data_id(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_current")

    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        body = json.dumps({
            "metadata": {"trigger_slug": "GMAIL_NEW_EMAIL"},
            "data": {"id": "email_123", "subject": "fallback"},
        }).encode()
        response = client.post(
            "/composio-events",
            content=body,
            headers=_composio_webhook_headers(body),
        )

    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    with main.get_db() as conn:
        row = conn.execute("SELECT worker_id, input_json FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert row["worker_id"] == "gmail-composio"
    assert json.loads(row["input_json"])["event"]["data"]["id"] == "email_123"


def test_gmail_composio_register_and_stub_event_end_to_end(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_gmail_123")

    def fake_start_run(run_id, _worker_id, _inputs):
        started_at = main.now_iso()
        completed_at = main.now_iso()
        with main.get_db() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status = 'completed',
                    output_json = ?,
                    started_at = ?,
                    completed_at = ?,
                    duration_ms = 1
                WHERE id = ?
                """,
                (json.dumps({"result": "ok"}), started_at, completed_at, run_id),
            )

    monkeypatch.setattr(main, "start_run", fake_start_run)
    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        body = json.dumps({
            "id": "msg_abc123",
            "type": "composio.trigger.message",
            "metadata": {
                "trigger_id": "ct_gmail_123",
                "trigger_slug": "GMAIL_NEW_EMAIL",
                "connected_account_id": "conn_gmail_federico_stub",
            },
            "data": {"from": "federico@example.test"},
        }).encode()
        event_response = client.post(
            "/composio-events",
            content=body,
            headers=_composio_webhook_headers(body),
        )
        assert event_response.status_code == 200, event_response.text
        run_id = event_response.json()["run_id"]

        final_status = None
        for _ in range(30):
            run_response = client.get(f"/runs/{run_id}", headers=_AUTH_HEADER)
            assert run_response.status_code == 200, run_response.text
            final_status = run_response.json()["status"]
            if final_status in {"completed", "failed"}:
                break
            time.sleep(0.1)

    assert final_status == "completed"


def test_composio_events_without_signing_key_returns_503(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.delenv("COMPOSIO_WEBHOOK_SIGNING_KEY", raising=False)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_gmail_123")

    with TestClient(main.app) as client:
        # #908: without the signing key, enabling the trigger now fails LOUDLY
        # at worker-create time (was: created fine, then every delivery 503'd
        # — shipped-but-broken with no signal).
        created = _create_worker(client)
        assert created.status_code != 200, created.text
        assert "COMPOSIO_WEBHOOK_SIGNING_KEY" in created.text

        # The receiver itself still answers 503 (checked before any worker
        # lookup) so Composio's delivery attempts surface the misconfiguration.
        response = client.post(
            "/composio-events",
            json={"metadata": {"trigger_id": "ct_gmail_123", "trigger_slug": "GMAIL_NEW_EMAIL"}},
        )

    assert response.status_code == 503, response.text


def test_composio_client_uses_current_v3_trigger_endpoints(monkeypatch, tmp_path):
    _main, composio_client = _load_api(monkeypatch, tmp_path)
    calls = []

    def fake_get(path, **params):
        calls.append(("GET", path, params))
        return {"items": [{"slug": "GMAIL_NEW_EMAIL"}]}

    def fake_post(path, body):
        calls.append(("POST", path, body))
        return {"trigger_id": "ti_gmail_123"}

    def fake_patch(path, body):
        calls.append(("PATCH", path, body))
        return {"status": "success"}

    monkeypatch.setattr(composio_client, "_get", fake_get)
    monkeypatch.setattr(composio_client, "_post", fake_post)
    monkeypatch.setattr(composio_client, "_patch", fake_patch)

    assert composio_client.list_triggers() == [{"slug": "GMAIL_NEW_EMAIL"}]
    trigger_id = composio_client.enable_trigger(
        "GMAIL_NEW_EMAIL",
        "conn_gmail_federico_stub",
        "https://example.test/composio-events",
        {"labelIds": ["INBOX"]},
    )
    composio_client.disable_trigger("GMAIL_NEW_EMAIL", trigger_id)

    assert ("GET", "/triggers_types", {"limit": 100}) in calls
    assert (
        "POST",
        "/trigger_instances/GMAIL_NEW_EMAIL/upsert",
        {
            "connected_account_id": "conn_gmail_federico_stub",
            "trigger_config": {"labelIds": ["INBOX"]},
        },
    ) in calls
    assert ("PATCH", "/trigger_instances/manage/ti_gmail_123", {"status": "disable"}) in calls


def test_integrations_triggers_proxy_caches_catalog(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    calls = []

    def fake_list_triggers():
        calls.append("list")
        return [{"slug": "GMAIL_NEW_EMAIL"}]

    monkeypatch.setattr(composio_client, "list_triggers", fake_list_triggers)
    main._trigger_catalog_cache["items"] = None
    main._trigger_catalog_cache["expires_at"] = 0.0

    with TestClient(main.app) as client:
        first = client.get("/integrations/triggers", headers=_AUTH_HEADER)
        second = client.get("/integrations/triggers", headers=_AUTH_HEADER)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json() == {"items": [{"slug": "GMAIL_NEW_EMAIL"}]}
    assert second.json() == first.json()
    assert calls == ["list"]
