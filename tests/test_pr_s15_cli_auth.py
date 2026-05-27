"""Regression tests for PR S15 CLI device-code auth endpoints."""

import os
import sys
import tempfile
import time

import pytest
from fastapi.testclient import TestClient


sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ["FLOOM_SECRET"] = "test-secret-s15"

import db  # noqa: E402

db.DB_PATH = _tmp_db.name

import main as app_module  # noqa: E402

client = TestClient(app_module.app, raise_server_exceptions=True)


@pytest.fixture(autouse=True)
def reset_cli_auth_devices():
    app_module._cli_auth_devices.clear()
    app_module._rate_buckets.clear()
    yield
    app_module._cli_auth_devices.clear()
    app_module._rate_buckets.clear()


def test_devices_create_and_pending_poll_shape():
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


def test_approve_requires_secret_and_flips_device_to_approved():
    created = client.post("/cli-auth/devices", json={"client_name": "floom-cli"}).json()
    user_code = created["user_code"]

    unauth = client.post("/cli-auth/approve", json={"user_code": user_code})
    assert unauth.status_code == 401

    approved = client.post(
        "/cli-auth/approve",
        json={"user_code": user_code},
        headers={"x-floom-secret": "test-secret-s15"},
    )
    assert approved.status_code == 200
    assert approved.json()["ok"] is True
    assert approved.json()["client_name"] == "floom-cli"


def test_poll_returns_approved_once_then_404_after_consumption():
    created = client.post("/cli-auth/devices", json={"client_name": "floom-cli"}).json()
    device_code = created["device_code"]
    user_code = created["user_code"]

    approve = client.post(
        "/cli-auth/approve",
        json={"user_code": user_code},
        headers={"x-floom-secret": "test-secret-s15"},
    )
    assert approve.status_code == 200

    first_poll = client.get(f"/cli-auth/poll/{device_code}")
    assert first_poll.status_code == 200
    assert first_poll.json() == {
        "status": "approved",
        "api_secret": "test-secret-s15",
        "api_base": "https://workers-api.floom.dev",
    }

    consumed = client.get(f"/cli-auth/poll/{device_code}")
    assert consumed.status_code == 404


def test_poll_returns_410_for_expired_device():
    created = client.post("/cli-auth/devices", json={"client_name": "floom-cli"}).json()
    device_code = created["device_code"]
    app_module._cli_auth_devices[device_code]["expires_at"] = time.time() - 1

    expired = client.get(f"/cli-auth/poll/{device_code}")
    assert expired.status_code == 410


def test_poll_returns_404_for_unknown_device_code():
    unknown = client.get("/cli-auth/poll/not-a-real-device-code")
    assert unknown.status_code == 404
