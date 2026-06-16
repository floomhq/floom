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

    def count_pending(self, *, created_ip: str, now_ts: float):
        return sum(
            1
            for row in self.created
            if row.get("created_ip") == created_ip
            and row.get("status") == "pending"
            and float(row.get("expires_at") or 0.0) > now_ts
        )


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
    assert fake.created[0]["scopes"] == ["api"]
    assert payload["scopes"] == ["api"]


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
    assert payload["scopes"] == ["api"]


def test_create_device_normalizes_supported_scopes(monkeypatch):
    client, fake = _client(monkeypatch)
    response = client.post(
        "/api/cli-auth/devices",
        json={"client_name": "floom-cli", "scopes": [" API ", "mcp", "api", ""]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["scopes"] == ["api", "mcp"]
    assert fake.created[0]["scopes"] == ["api", "mcp"]


def test_create_device_rejects_unsupported_scopes(monkeypatch):
    client, fake = _client(monkeypatch)
    response = client.post(
        "/api/cli-auth/devices",
        json={"client_name": "floom-cli", "scopes": ["api", "admin"]},
    )
    assert response.status_code == 400
    assert "Unsupported CLI auth scope" in response.json()["detail"]
    assert fake.created == []


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


def test_create_device_caps_pending_devices_per_edge_ip(monkeypatch):
    monkeypatch.setattr(cli_devices, "_CLI_AUTH_MAX_DEVICES_PENDING", 1)
    client, fake = _client(monkeypatch)

    first = client.post(
        "/api/cli-auth/devices",
        json={"client_name": "floom-cli"},
        headers={"cf-connecting-ip": "203.0.113.10"},
    )
    second = client.post(
        "/api/cli-auth/devices",
        json={"client_name": "floom-cli"},
        headers={"cf-connecting-ip": "203.0.113.10"},
    )

    assert first.status_code == 200
    assert second.status_code == 429
    assert second.headers["retry-after"] == str(cli_devices._CLI_AUTH_POLL_INTERVAL_SECONDS)
    assert len(fake.created) == 1


def test_client_ip_ignores_raw_x_forwarded_for_when_edge_header_present(monkeypatch):
    client, fake = _client(monkeypatch)
    response = client.post(
        "/api/cli-auth/devices",
        json={"client_name": "floom-cli"},
        headers={
            "cf-connecting-ip": "203.0.113.20",
            "x-forwarded-for": "198.51.100.99",
        },
    )

    assert response.status_code == 200
    assert fake.created[0]["created_ip"] == "203.0.113.20"
