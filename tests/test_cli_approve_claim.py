"""Tests for the cli-approve "claim from OSS placeholder" path.

The engine's POST /cli-auth/devices handler (mounted under /api in cloud)
stores user_id="federico" (the OSS bootstrap placeholder) because it has
no Supabase context. /auth/cli-approve must claim the row for the real
Supabase user_id when the placeholder is in place, while still preventing
another user from approving a device that already belongs to someone else.
"""

from __future__ import annotations

import base64
import hashlib
import json
import threading
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import apps.api.routes.auth as auth_routes


class _FakeApiTokenRepo:
    created: list[dict[str, str]] = []

    def create(self, *, user_id: str, name: str, token_hash: str, workspace_id: str | None = None):
        row = {
            "id": f"tok-{len(self.created) + 1}",
            "user_id": user_id,
            "name": name,
            "token_hash": token_hash,
            "workspace_id": workspace_id or "ws-test",
        }
        self.created.append(row)
        return row


def _make_session_cookie(
    user_id: str, refresh_token: str = "rt-test", access_token: str = "at"
) -> str:
    payload = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_at": 9999999999,
        # NOTE: post-F2 this `user_id` field is IGNORED by the server (it derives
        # identity from the verified access_token instead). Kept here only to
        # mirror the real cookie shape.
        "user_id": user_id,
    }
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


class _FakeCliAuth:
    def __init__(self, rows: dict[str, dict[str, Any]]):
        self.rows = rows
        self.updates: list[tuple[str, dict]] = []
        self._lock = threading.Lock()

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

    def approve_pending(
        self,
        *,
        device_code: str,
        user_id: str,
        secret: str,
        approved_at: float,
    ):
        with self._lock:
            row = self.rows.get(device_code)
            if not row or str(row.get("status") or "").lower() != "pending":
                return None
            row.update(
                {
                    "user_id": user_id,
                    "status": "approved",
                    "secret": secret,
                    "approved_at": approved_at,
                }
            )
            self.updates.append(
                (
                    device_code,
                    {
                        "user_id": user_id,
                        "status": "approved",
                        "secret": secret,
                        "approved_at": approved_at,
                    },
                )
            )
            return dict(row)

    def deny_pending(self, *, device_code: str):
        with self._lock:
            row = self.rows.get(device_code)
            if not row or str(row.get("status") or "").lower() != "pending":
                return None
            row.update({"status": "denied", "secret": None})
            self.updates.append((device_code, {"status": "denied", "secret": None}))
            return dict(row)


def _client(rows: dict[str, dict], monkeypatch) -> tuple[TestClient, _FakeCliAuth, MagicMock]:
    if hasattr(auth_routes, "_cli_approve_deny_rate_buckets"):
        auth_routes._cli_approve_deny_rate_buckets.clear()
    _FakeApiTokenRepo.created = []
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

    # F2: _session_user now cryptographically verifies the cookie's access_token
    # and derives user_id from the verified `sub`. Mock that verification: a
    # token of the form "valid:<uuid>" verifies to sub=<uuid>; anything else
    # (e.g. a forged/tampered token) raises 401, exactly like a real bad JWT.
    import apps.api.auth.supabase_provider as provider_module

    def _fake_verify_jwt(token: str, supabase_url: str) -> dict:
        if isinstance(token, str) and token.startswith("valid:"):
            return {"sub": token.split(":", 1)[1], "email": "u@test.dev"}
        from fastapi import HTTPException

        raise HTTPException(status_code=401, detail="unauthorized")

    monkeypatch.setattr(provider_module, "_verify_jwt", _fake_verify_jwt)
    monkeypatch.setattr(auth_routes, "SupabaseApiTokenRepository", _FakeApiTokenRepo)
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
    cookie = _make_session_cookie("supabase-user-uuid", access_token="valid:supabase-user-uuid")
    response = client.post(
        "/auth/cli-approve",
        json={"user_code": "ABCD-EFGH"},
        cookies={"workeros_cloud_session": cookie},
    )
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    # Status got flipped to approved with a fresh CLI PAT, never the browser
    # session refresh token.
    assert fake.rows["device-1"]["status"] == "approved"
    assert str(fake.rows["device-1"]["secret"]).startswith("floom_")
    assert fake.rows["device-1"]["secret"] != "rt-test"
    assert fake.rows["device-1"]["user_id"] == "supabase-user-uuid"
    assert _FakeApiTokenRepo.created == [
        {
            "id": "tok-1",
            "user_id": "supabase-user-uuid",
            "name": "CLI device: workeros-cli",
            "token_hash": hashlib.sha256(str(fake.rows["device-1"]["secret"]).encode()).hexdigest(),
            "workspace_id": "ws-test",
        }
    ]
    chain.table.assert_not_called()


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
    cookie = _make_session_cookie("supabase-user-uuid", access_token="valid:supabase-user-uuid")
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
    cookie = _make_session_cookie("supabase-user-uuid", access_token="valid:supabase-user-uuid")
    response = client.post(
        "/auth/cli-approve",
        json={"user_code": "ABCD-EFGH"},
        cookies={"workeros_cloud_session": cookie},
    )
    assert response.status_code == 200
    # No re-claim required, so the service client isn't called.
    chain.table.assert_not_called()
    assert fake.rows["device-1"]["status"] == "approved"


def test_cli_approve_pending_claim_is_atomic_under_race(monkeypatch):
    class _RaceCliAuth(_FakeCliAuth):
        def __init__(self, rows):
            super().__init__(rows)
            self.barrier = threading.Barrier(2)

        def verify_device(self, code: str):
            row = super().verify_device(code)
            if row is None:
                return None
            snapshot = dict(row)
            self.barrier.wait(timeout=5)
            return snapshot

    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": None,
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    app = FastAPI()
    app.include_router(auth_routes.router)
    fake = _RaceCliAuth(rows)
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
    import apps.api.auth.supabase_provider as provider_module

    monkeypatch.setattr(
        provider_module,
        "_verify_jwt",
        lambda token, _url: {"sub": token.split(":", 1)[1]},
    )
    chain = MagicMock()
    chain.table.return_value.update.return_value.eq.return_value.execute.return_value = None
    import apps.api.config as config_module

    monkeypatch.setattr(config_module, "new_supabase_service_client", lambda: chain)
    monkeypatch.setattr(auth_routes, "SupabaseApiTokenRepository", _FakeApiTokenRepo)
    if hasattr(auth_routes, "_cli_approve_deny_rate_buckets"):
        auth_routes._cli_approve_deny_rate_buckets.clear()
    client = TestClient(app)

    statuses: list[int] = []

    def approve(refresh_token: str):
        cookie = _make_session_cookie(
            "supabase-user-uuid",
            refresh_token=refresh_token,
            access_token="valid:supabase-user-uuid",
        )
        response = client.post(
            "/auth/cli-approve",
            json={"user_code": "ABCD-EFGH"},
            cookies={"workeros_cloud_session": cookie},
        )
        statuses.append(response.status_code)

    first = threading.Thread(target=approve, args=("rt-first",))
    second = threading.Thread(target=approve, args=("rt-second",))
    first.start()
    second.start()
    first.join(timeout=5)
    second.join(timeout=5)

    assert sorted(statuses) == [200, 409]
    assert fake.rows["device-1"]["status"] == "approved"
    assert str(fake.rows["device-1"]["secret"]).startswith("floom_")
    assert fake.rows["device-1"]["secret"] not in {"rt-first", "rt-second"}
    assert len([update for update in fake.updates if update[1].get("status") == "approved"]) == 1


def test_cli_approve_rate_limits_user_code_guessing(monkeypatch):
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "other-user",
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    client, fake, _chain = _client(rows, monkeypatch)
    cookie = _make_session_cookie("real-uuid", access_token="valid:real-uuid")

    statuses = [
        client.post(
            "/auth/cli-approve",
            json={"user_code": "ABCD-EFGH"},
            cookies={"workeros_cloud_session": cookie},
            headers={"cf-connecting-ip": "203.0.113.88"},
        ).status_code
        for _ in range(6)
    ]

    assert statuses[:5] == [404, 404, 404, 404, 404]
    assert statuses[5] == 429
    assert fake.rows["device-1"]["status"] == "pending"


def test_cli_bootstrap_returns_supabase_config(monkeypatch):
    rows: dict[str, dict] = {}
    client, _fake, _chain = _client(rows, monkeypatch)
    response = client.get("/auth/cli-bootstrap")
    assert response.status_code == 200
    body = response.json()
    assert body["supabase_url"] == "https://test.supabase.co"
    assert body["supabase_anon_key"] == "anon-test"
    assert body["api_base"] == "https://workeros-api.test"


# ---------------------------------------------------------------------------
# Security regression tests (red-team P0).
# ---------------------------------------------------------------------------


def test_f2_forged_cookie_cli_approve_is_rejected(monkeypatch):
    """F2 (account-takeover): forging a cookie with a VICTIM user_id + a junk
    (unsigned) access_token must NOT approve the victim's device. The server now
    verifies the access_token cryptographically, so a forged cookie → 401 and
    the device stays pending with NO attacker secret written."""
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "federico",  # victim's pending device (claimable)
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    client, fake, chain = _client(rows, monkeypatch)
    # Attacker hand-rolls a cookie: victim's user_id + attacker refresh_token,
    # but cannot produce a valid (signed) access_token — uses a forged blob.
    cookie = _make_session_cookie(
        "victim-user-uuid", refresh_token="attacker-rt", access_token="forged-not-a-jwt"
    )
    response = client.post(
        "/auth/cli-approve",
        json={"user_code": "ABCD-EFGH"},
        cookies={"workeros_cloud_session": cookie},
    )
    assert response.status_code == 401, response.text
    # Device untouched: still pending, no secret stamped.
    assert fake.rows["device-1"]["status"] == "pending"
    assert fake.rows["device-1"].get("secret") is None
    chain.table.assert_not_called()


def test_f1_forged_cookie_cli_deny_is_rejected(monkeypatch):
    """F1 (DoS): forged cookie cli-deny must be rejected (401); device stays
    pending so it cannot be used to deny arbitrary pending devices."""
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "federico",
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    client, fake, _chain = _client(rows, monkeypatch)
    cookie = _make_session_cookie("anyone", access_token="forged-not-a-jwt")
    response = client.post(
        "/auth/cli-deny",
        json={"user_code": "ABCD-EFGH"},
        cookies={"workeros_cloud_session": cookie},
    )
    assert response.status_code == 401, response.text
    assert fake.rows["device-1"]["status"] == "pending"


def test_f1_missing_cookie_cli_deny_is_rejected(monkeypatch):
    """No cookie at all → 401 (unauthenticated DoS attempt blocked)."""
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "federico",
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    client, fake, _chain = _client(rows, monkeypatch)
    response = client.post("/auth/cli-deny", json={"user_code": "ABCD-EFGH"})
    assert response.status_code == 401
    assert fake.rows["device-1"]["status"] == "pending"


def test_legit_cli_deny_still_works(monkeypatch):
    """Legit verified session denies a pending device normally."""
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "federico",
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    client, fake, _chain = _client(rows, monkeypatch)
    cookie = _make_session_cookie("real-uuid", access_token="valid:real-uuid")
    response = client.post(
        "/auth/cli-deny",
        json={"user_code": "ABCD-EFGH"},
        cookies={"workeros_cloud_session": cookie},
    )
    assert response.status_code == 200, response.text
    assert fake.rows["device-1"]["status"] == "denied"


def test_cli_deny_rate_limits_user_code_guessing(monkeypatch):
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "other-user",
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    client, fake, _chain = _client(rows, monkeypatch)
    cookie = _make_session_cookie("real-uuid", access_token="valid:real-uuid")

    statuses = [
        client.post(
            "/auth/cli-deny",
            json={"user_code": "ABCD-EFGH"},
            cookies={"workeros_cloud_session": cookie},
            headers={"cf-connecting-ip": "203.0.113.89"},
        ).status_code
        for _ in range(6)
    ]

    assert statuses[:5] == [404, 404, 404, 404, 404]
    assert statuses[5] == 429
    assert fake.rows["device-1"]["status"] == "pending"


def test_f3_claim_write_failure_returns_clean_4xx_not_500(monkeypatch):
    """F3: if the claim write raises (e.g. an FK/DB error), the handler returns
    a clean 4xx — never a 500 that leaks an internal error."""
    rows = {
        "device-1": {
            "device_code": "device-1",
            "user_id": "federico",
            "user_code": "ABCD-EFGH",
            "status": "pending",
        }
    }
    client, fake, _chain = _client(rows, monkeypatch)
    # Make the atomic claim write blow up like a DB FK violation.
    def fail_claim(**_kwargs):
        raise RuntimeError("insert or update on table violates foreign key constraint")

    fake.approve_pending = fail_claim
    cookie = _make_session_cookie("ghost-uuid", access_token="valid:ghost-uuid")
    response = client.post(
        "/auth/cli-approve",
        json={"user_code": "ABCD-EFGH"},
        cookies={"workeros_cloud_session": cookie},
    )
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "Could not approve device"
