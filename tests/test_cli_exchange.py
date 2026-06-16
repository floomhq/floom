from __future__ import annotations

import threading
from types import SimpleNamespace

from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient

import apps.api.routes.auth as auth_routes
from apps.api.db.supabase_repos import SupabaseCliAuthRepository


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
        lambda: SimpleNamespace(
            cli_code_ttl_seconds=300,
            supabase_url="https://test.supabase.co",
            supabase_anon_key="anon-test-key",
            api_base="https://workeros-api.test",
        ),
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


class _RaceResponse:
    def __init__(self, data):
        self.data = data


class _RaceCliAuthTable:
    def __init__(self, rows: dict[str, dict], *, select_barrier: threading.Barrier | None = None):
        self.rows = rows
        self.select_barrier = select_barrier
        self.filters: list[tuple[str, object]] = []
        self.operation = "select"

    def select(self, *_args, **_kwargs):
        self.operation = "select"
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        matches = [
            dict(row)
            for row in self.rows.values()
            if all(row.get(key) == value for key, value in self.filters)
        ]
        if self.operation == "select" and self.select_barrier is not None:
            self.select_barrier.wait(timeout=5)
        if self.operation != "delete":
            return _RaceResponse(matches)
        deleted = []
        for row in matches:
            device_code = row["device_code"]
            if device_code in self.rows:
                deleted.append(dict(self.rows.pop(device_code)))
        return _RaceResponse(deleted)


class _RaceCliAuthClient:
    def __init__(self, rows: dict[str, dict]):
        self.rows = rows
        self.select_barrier = threading.Barrier(2)

    def table(self, name):
        assert name == "cli_auth_devices"
        return _RaceCliAuthTable(self.rows, select_barrier=self.select_barrier)


class _CliAuthTable:
    def __init__(self, rows: dict[str, dict]):
        self.rows = rows
        self.filters: list[tuple[str, object]] = []
        self.operation = "select"
        self.insert_payload: dict | None = None

    def insert(self, payload):
        self.operation = "insert"
        self.insert_payload = dict(payload)
        return self

    def select(self, *_args, **_kwargs):
        self.operation = "select"
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        if self.operation == "insert":
            assert self.insert_payload is not None
            self.rows[self.insert_payload["device_code"]] = dict(self.insert_payload)
            return _RaceResponse([dict(self.insert_payload)])
        matches = [
            dict(row)
            for row in self.rows.values()
            if all(row.get(key) == value for key, value in self.filters)
        ]
        if self.operation == "delete":
            for row in matches:
                self.rows.pop(row["device_code"], None)
        return _RaceResponse(matches)


class _CliAuthClient:
    def __init__(self, rows: dict[str, dict]):
        self.rows = rows

    def table(self, name):
        assert name == "cli_auth_devices"
        return _CliAuthTable(self.rows)


def test_supabase_cli_auth_consume_is_atomic_single_use():
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "user-123",
            "user_code": "ABCD-EFGH",
            "status": "approved",
            "secret": "refresh-123",
            "client_name": "workeros-cli",
            "scopes_json": [],
            "created_at": 1000.0,
            "expires_at": 9999999999.0,
            "approved_at": 1001.0,
        }
    }
    repo = SupabaseCliAuthRepository(client=_RaceCliAuthClient(rows))
    results = []

    def consume():
        row = repo.consume("device-1")
        results.append(None if row is None else row["secret"])

    first = threading.Thread(target=consume)
    second = threading.Thread(target=consume)
    first.start()
    second.start()
    first.join(timeout=5)
    second.join(timeout=5)

    assert sorted(results, key=lambda value: value or "") == [None, "refresh-123"]
    assert rows == {}


def test_supabase_cli_auth_secret_is_encrypted_at_rest_and_decrypted_on_consume(monkeypatch):
    monkeypatch.setenv("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))
    rows: dict[str, dict] = {}
    repo = SupabaseCliAuthRepository(client=_CliAuthClient(rows))

    created = repo.create_device(
        user_id="user-123",
        device_code="device-enc",
        user_code="ABCD-EFGH",
        status="approved",
        secret="refresh-sensitive",
        client_name="workeros-cli",
        scopes=[],
        created_ip="203.0.113.10",
        created_at=1000.0,
        expires_at=9999999999.0,
        approved_at=1001.0,
    )

    stored_secret = rows["device-enc"]["secret"]
    assert created["secret"] == "refresh-sensitive"
    assert stored_secret != "refresh-sensitive"
    assert str(stored_secret).startswith("fernet:")

    consumed = repo.consume("device-enc")

    assert consumed is not None
    assert consumed["secret"] == "refresh-sensitive"
    assert rows == {}
