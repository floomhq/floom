import hashlib
import hmac
import importlib
import json
import sys
import time
import types
from pathlib import Path

from fastapi.testclient import TestClient


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")
    monkeypatch.setenv("COMPOSIO_WEBHOOK_SIGNING_KEY", "test-signing-key")
    monkeypatch.setenv("COMPOSIO_WEBHOOK_URL", "https://example.test/composio-events")

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "composio_client"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
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
  runner: local
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


def _create_worker(client):
    return client.post(
        "/workers",
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
            "trigger_id": "ct_gmail_123",
            "event": "GMAIL_NEW_EMAIL",
            "payload": {"subject": "Hello"},
        }).encode()
        response = client.post(
            "/composio-events",
            content=body,
            headers={"X-Composio-Signature": _signature(body), "Content-Type": "application/json"},
        )

    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    with main.get_db() as conn:
        row = conn.execute("SELECT worker_id, trigger_source, input_json FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert row["worker_id"] == "gmail-composio"
    assert row["trigger_source"] == "composio"
    assert json.loads(row["input_json"])["event"]["payload"]["subject"] == "Hello"


def test_composio_events_with_invalid_hmac_returns_401(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_gmail_123")
    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        response = client.post(
            "/composio-events",
            json={"trigger_id": "ct_gmail_123", "event": "GMAIL_NEW_EMAIL"},
            headers={"X-Composio-Signature": "sha256=bad"},
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
        deleted = client.delete("/workers/gmail-composio")

    assert deleted.status_code == 200, deleted.text
    assert disabled == [("GMAIL_NEW_EMAIL", "ct_gmail_123")]


def test_gmail_composio_register_and_stub_event_end_to_end(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    monkeypatch.setattr(composio_client, "enable_trigger", lambda *args, **kwargs: "ct_gmail_123")
    with TestClient(main.app) as client:
        created = _create_worker(client)
        assert created.status_code == 200, created.text
        body = json.dumps({
            "trigger_id": "ct_gmail_123",
            "event": "GMAIL_NEW_EMAIL",
            "payload": {"from": "federico@example.test"},
        }).encode()
        event_response = client.post(
            "/composio-events",
            content=body,
            headers={"X-Composio-Signature": _signature(body), "Content-Type": "application/json"},
        )
        assert event_response.status_code == 200, event_response.text
        run_id = event_response.json()["run_id"]

        final_status = None
        for _ in range(30):
            run_response = client.get(f"/runs/{run_id}")
            assert run_response.status_code == 200, run_response.text
            final_status = run_response.json()["status"]
            if final_status in {"completed", "failed"}:
                break
            time.sleep(0.1)

    assert final_status == "completed"
