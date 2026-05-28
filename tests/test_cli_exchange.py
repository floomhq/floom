from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

import apps.api.routes.auth as auth_routes


class _FakeCliAuth:
    def __init__(self, rows: dict[str, dict]):
        self.rows = rows

    def prune_expired(self, now_ts: float):
        expired = [
            device_code
            for device_code, row in self.rows.items()
            if float(row.get("expires_at", 0.0) or 0.0) <= now_ts
        ]
        for device_code in expired:
            self.rows.pop(device_code, None)
        return expired

    def get_by_device_code(self, device_code: str):
        return self.rows.get(device_code)

    def consume(self, device_code: str):
        return self.rows.pop(device_code, None)

    def delete(self, *, device_code: str):
        return self.rows.pop(device_code, None) is not None


def _client(rows: dict[str, dict], monkeypatch) -> TestClient:
    app = FastAPI()
    app.include_router(auth_routes.router)
    monkeypatch.setattr(
        auth_routes,
        "get_repositories",
        lambda: SimpleNamespace(cli_auth=_FakeCliAuth(rows)),
    )
    monkeypatch.setattr(
        auth_routes,
        "get_cloud_settings",
        lambda: SimpleNamespace(cli_code_ttl_seconds=300),
    )
    return TestClient(app)


def test_cli_exchange_is_single_use(monkeypatch):
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "user-123",
            "user_code": "ABCD-EFGH",
            "status": "approved",
            "secret": "refresh-123",
            "expires_at": 9999999999.0,
        }
    }
    client = _client(rows, monkeypatch)

    first = client.post("/auth/cli-exchange", json={"device_code": "device-1", "user_code": "ABCD-EFGH"})
    second = client.post("/auth/cli-exchange", json={"device_code": "device-1", "user_code": "ABCD-EFGH"})

    assert first.status_code == 200
    assert first.json()["refresh_token"] == "refresh-123"
    assert second.status_code == 404


def test_cli_exchange_rejects_expired_code(monkeypatch):
    rows = {
        "device-expired": {
            "device_code": "device-expired",
            "user_id": "user-123",
            "user_code": "WXYZ-9876",
            "status": "approved",
            "secret": "refresh-expired",
            "expires_at": 1.0,
        }
    }
    client = _client(rows, monkeypatch)

    response = client.post(
        "/auth/cli-exchange",
        json={"device_code": "device-expired", "user_code": "WXYZ-9876"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Device code expired"
