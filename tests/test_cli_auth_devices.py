"""Tests for the cloud override of POST /api/cli-auth/devices.

The engine handler stores user_id="federico" which fails the Supabase
UUID FK; the cloud route must mint rows with user_id=NULL.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import apps.api.routes.cli_auth_devices as cli_devices


class _FakeCliAuth:
    def __init__(self):
        self.created: list[dict] = []

    def prune_expired(self, *, now_ts: float):
        return []

    def create_device(self, *, user_id, **fields):
        # Capture the kwargs the route sent and simulate the repo's return.
        row = {"user_id": user_id, **fields}
        self.created.append(row)
        return row


def _client(monkeypatch) -> tuple[TestClient, _FakeCliAuth]:
    app = FastAPI()
    app.include_router(cli_devices.router, prefix="/api")
    fake = _FakeCliAuth()
    monkeypatch.setattr(cli_devices, "get_repositories", lambda: SimpleNamespace(cli_auth=fake))
    monkeypatch.setattr(
        cli_devices,
        "get_cloud_settings",
        lambda: SimpleNamespace(frontend_url="https://workeros.floom.dev/app"),
    )
    return TestClient(app), fake


def test_create_device_persists_null_user_id(monkeypatch):
    client, fake = _client(monkeypatch)
    response = client.post(
        "/api/cli-auth/devices",
        json={"client_name": "floom-cli"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["device_code"]
    assert payload["user_code"]
    # Verification URL points at the cloud dashboard cli-auth page.
    assert payload["verification_url"].startswith("https://workeros.floom.dev/app/cli-auth?code=")
    # Repo was called with user_id=None.
    assert len(fake.created) == 1
    assert fake.created[0]["user_id"] is None
    assert fake.created[0]["status"] == "pending"
    assert fake.created[0]["client_name"] == "floom-cli"


def test_create_device_returns_polling_info(monkeypatch):
    client, _ = _client(monkeypatch)
    response = client.post(
        "/api/cli-auth/devices",
        json={"client_name": "floom-cli", "scopes": []},
    )
    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload["polling_interval_seconds"], int)
    assert payload["polling_interval_seconds"] > 0
    assert isinstance(payload["expires_in_seconds"], int)
    assert payload["expires_in_seconds"] > 60


def test_poll_endpoint_returns_410_with_upgrade_hint(monkeypatch):
    client, _ = _client(monkeypatch)
    response = client.get("/api/cli-auth/poll/some-device-code")
    assert response.status_code == 410
    detail = response.json()["detail"]
    assert "0.2.0" in detail
    assert "cli-exchange" in detail


def test_create_device_rejects_empty_client_name(monkeypatch):
    client, _ = _client(monkeypatch)
    response = client.post("/api/cli-auth/devices", json={"client_name": ""})
    assert response.status_code == 422
