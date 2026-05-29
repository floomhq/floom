"""Tests for the cli-approve "claim from OSS placeholder" path.

The engine's POST /cli-auth/devices handler (mounted under /api in cloud)
stores user_id="federico" (the OSS bootstrap placeholder) because it has
no Supabase context. /auth/cli-approve must claim the row for the real
Supabase user_id when the placeholder is in place, while still preventing
another user from approving a device that already belongs to someone else.
"""

from __future__ import annotations

import base64
import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import apps.api.routes.auth as auth_routes


def _make_session_cookie(user_id: str, refresh_token: str = "rt-test") -> str:
    payload = {
        "access_token": "at",
        "refresh_token": refresh_token,
        "expires_at": 9999999999,
        "user_id": user_id,
    }
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


class _FakeCliAuth:
    def __init__(self, rows: dict[str, dict[str, Any]]):
        self.rows = rows
        self.updates: list[tuple[str, dict]] = []

    def prune_expired(self, now_ts: float):
        return []

    def verify_device(self, code: str):
        for row in self.rows.values():
            if str(row.get("user_code")).strip().upper() == code.strip().upper():
                return row
        return None

    def update(self, *, device_code: str, **fields):
        self.updates.append((device_code, fields))
        self.rows[device_code].update(fields)
        return self.rows[device_code]


def _client(rows: dict[str, dict], monkeypatch) -> tuple[TestClient, _FakeCliAuth, MagicMock]:
    app = FastAPI()
    app.include_router(auth_routes.router)
    fake = _FakeCliAuth(rows)
    monkeypatch.setattr(
        auth_routes,
        "get_repositories",
        lambda: SimpleNamespace(cli_auth=fake),
    )
    monkeypatch.setattr(
        auth_routes,
        "get_cloud_settings",
        lambda: SimpleNamespace(
            cli_code_ttl_seconds=300,
            supabase_url="https://test.supabase.co",
            supabase_anon_key="anon-test",
            api_base="https://workeros-api.test",
        ),
    )
    # Patch new_supabase_service_client to a chainable mock for the claim path.
    chain = MagicMock()
    chain.table.return_value.update.return_value.eq.return_value.execute.return_value = None
    import apps.api.config as config_module
    monkeypatch.setattr(config_module, "new_supabase_service_client", lambda: chain)
    return TestClient(app), fake, chain


def test_cli_approve_claims_oss_placeholder_device(monkeypatch):
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "federico",  # OSS placeholder
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    client, fake, chain = _client(rows, monkeypatch)
    cookie = _make_session_cookie("supabase-user-uuid")
    response = client.post(
        "/auth/cli-approve",
        json={"user_code": "ABCD-EFGH"},
        cookies={"workeros_cloud_session": cookie},
    )
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    # Status got flipped to approved with the user's refresh_token as secret.
    assert fake.rows["device-1"]["status"] == "approved"
    assert fake.rows["device-1"]["secret"] == "rt-test"
    # The service-role client was used to rewrite user_id (claim).
    chain.table.assert_called_once_with("cli_auth_devices")


def test_cli_approve_rejects_when_device_belongs_to_other_user(monkeypatch):
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "other-supabase-user",
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    client, _fake, _chain = _client(rows, monkeypatch)
    cookie = _make_session_cookie("supabase-user-uuid")
    response = client.post(
        "/auth/cli-approve",
        json={"user_code": "ABCD-EFGH"},
        cookies={"workeros_cloud_session": cookie},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "User code not found"


def test_cli_approve_works_when_device_already_belongs_to_caller(monkeypatch):
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "supabase-user-uuid",  # same user
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    client, fake, chain = _client(rows, monkeypatch)
    cookie = _make_session_cookie("supabase-user-uuid")
    response = client.post(
        "/auth/cli-approve",
        json={"user_code": "ABCD-EFGH"},
        cookies={"workeros_cloud_session": cookie},
    )
    assert response.status_code == 200
    # No re-claim required, so the service client isn't called.
    chain.table.assert_not_called()
    assert fake.rows["device-1"]["status"] == "approved"


def test_cli_bootstrap_returns_supabase_config(monkeypatch):
    rows: dict[str, dict] = {}
    client, _fake, _chain = _client(rows, monkeypatch)
    response = client.get("/auth/cli-bootstrap")
    assert response.status_code == 200
    body = response.json()
    assert body["supabase_url"] == "https://test.supabase.co"
    assert body["supabase_anon_key"] == "anon-test"
    assert body["api_base"] == "https://workeros-api.test"
