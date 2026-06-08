"""Regression tests for PR S15 CLI device-code auth endpoints."""

from __future__ import annotations

import importlib
import os
import sys
import time
import types

from fastapi.testclient import TestClient


API_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)


AUTH_HEADER = {"x-floom-secret": "test-secret-s15"}


def _load_api(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_SECRET", AUTH_HEADER["x-floom-secret"])
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://workers.floom.dev")

    reset_prefixes = ("auth.", "db.")
    reset_exact = {
        "main",
        "auth",
        "db",
        "files",
        "models",
        "worker_registry",
        "run_service",
        "runner_utils",
        "scheduler",
    }
    for name in list(sys.modules):
        if name in reset_exact or name.startswith(reset_prefixes):
            sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    main.get_auth_provider.cache_clear()
    client = TestClient(main.app, raise_server_exceptions=True, base_url="https://testserver")
    return main, client


def _setup_bootstrap_user(monkeypatch, main, client) -> str:
    response = client.post("/auth/setup", json={"username": "admin", "password": "adminpass123"})
    assert response.status_code == 201, response.text
    user_id = response.json()["id"]
    monkeypatch.setenv("WORKEROS_USER_ID", user_id)
    return user_id


def test_devices_create_and_pending_poll_shape(monkeypatch, tmp_path):
    _main, client = _load_api(monkeypatch, tmp_path)

    response = client.post("/cli-auth/devices", json={"client_name": "floom-cli"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["device_code"]
    assert payload["user_code"].count("-") == 1
    assert payload["verification_url"].startswith("https://workers.floom.dev/cli-auth?code=")
    assert payload["polling_interval_seconds"] == 2
    assert payload["expires_in_seconds"] == 600

    pending = client.get(f"/cli-auth/poll/{payload['device_code']}")
    assert pending.status_code == 200
    assert pending.json() == {"status": "pending"}


def test_devices_use_configured_bootstrap_user(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_USER_ID", "backend-audit-user")
    main, client = _load_api(monkeypatch, tmp_path)

    created = client.post("/cli-auth/devices", json={"client_name": "floom-cli"}).json()

    with main.get_db() as conn:
        row = conn.execute(
            "SELECT user_id FROM cli_auth_devices WHERE device_code = ?",
            (created["device_code"],),
        ).fetchone()

    assert row is not None
    assert row["user_id"] == "backend-audit-user"


def test_approve_requires_secret_and_flips_device_to_approved(monkeypatch, tmp_path):
    main, client = _load_api(monkeypatch, tmp_path)
    created = client.post("/cli-auth/devices", json={"client_name": "floom-cli"}).json()
    user_code = created["user_code"]

    client.cookies.clear()
    unauth = client.post("/cli-auth/approve", json={"user_code": user_code})
    assert unauth.status_code == 401

    approved = client.post(
        "/cli-auth/approve",
        json={"user_code": user_code},
        headers=AUTH_HEADER,
    )
    assert approved.status_code == 200
    assert approved.json()["ok"] is True
    assert approved.json()["client_name"] == "floom-cli"


def test_poll_returns_approved_once_then_404_after_consumption(monkeypatch, tmp_path):
    main, client = _load_api(monkeypatch, tmp_path)
    created = client.post("/cli-auth/devices", json={"client_name": "floom-cli"}).json()
    device_code = created["device_code"]
    user_code = created["user_code"]

    approve = client.post(
        "/cli-auth/approve",
        json={"user_code": user_code},
        headers=AUTH_HEADER,
    )
    assert approve.status_code == 200

    first_poll = client.get(f"/cli-auth/poll/{device_code}")
    assert first_poll.status_code == 200
    body = first_poll.json()
    assert body["status"] == "approved"
    assert body["api_base"] == "https://workers-api.floom.dev"
    assert body["api_secret"].startswith("wos_")
    assert body["api_secret"] != AUTH_HEADER["x-floom-secret"]

    token_auth = client.get("/auth/me", headers={"x-floom-secret": body["api_secret"]})
    assert token_auth.status_code == 200
    assert token_auth.json()["auth_method"] == "pat"

    consumed = client.get(f"/cli-auth/poll/{device_code}")
    assert consumed.status_code == 404


def test_poll_returns_404_for_expired_device(monkeypatch, tmp_path):
    main, client = _load_api(monkeypatch, tmp_path)
    created = client.post("/cli-auth/devices", json={"client_name": "floom-cli"}).json()
    device_code = created["device_code"]
    main.get_repositories().cli_auth.update(
        device_code=device_code,
        expires_at=time.time() - 1,
    )

    expired = client.get(f"/cli-auth/poll/{device_code}")
    assert expired.status_code == 404
    assert expired.json() == {"detail": "Device code not found"}


def test_poll_returns_404_for_denied_device(monkeypatch, tmp_path):
    main, client = _load_api(monkeypatch, tmp_path)
    created = client.post("/cli-auth/devices", json={"client_name": "floom-cli"}).json()
    device_code = created["device_code"]
    user_code = created["user_code"]

    denied = client.post(
        "/cli-auth/deny",
        json={"user_code": user_code},
        headers=AUTH_HEADER,
    )
    assert denied.status_code == 200

    poll = client.get(f"/cli-auth/poll/{device_code}")
    assert poll.status_code == 404
    assert poll.json() == {"detail": "Device code not found"}


def test_poll_returns_404_for_unknown_device_code(monkeypatch, tmp_path):
    _main, client = _load_api(monkeypatch, tmp_path)

    unknown = client.get("/cli-auth/poll/not-a-real-device-code")

    assert unknown.status_code == 404
