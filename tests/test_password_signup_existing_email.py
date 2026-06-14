"""Regression test for #226A — existing-email signup must say so clearly.

Supabase's anti-enumeration behaviour means `auth.sign_up` for an
already-registered email does NOT raise: it returns an obfuscated user with
empty `identities` and no session. The old handler then wrote a bogus
`public.users` row and returned `confirmation_required` ("check your email"),
which is wrong — no email is sent and the user should sign in.

These tests call `password_signup` directly with a mocked anon client.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

import apps.api.routes.auth as auth_routes
from apps.api.routes.auth import PasswordSignupRequest, _ACCOUNT_EXISTS_DETAIL


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _FakeAnonClient:
    """Stands in for the Supabase anon client; `auth.sign_up` is configurable."""

    def __init__(self, *, sign_up_result=None, raises=None):
        self._result = sign_up_result
        self._raises = raises
        self.auth = self

    def sign_up(self, _payload):
        if self._raises is not None:
            raise self._raises
        return self._result


@pytest.fixture(autouse=True)
def _no_side_effects(monkeypatch):
    # Guard: the existing-account paths must NOT write a users row.
    calls = {"upsert": 0, "welcome": 0}
    monkeypatch.setattr(auth_routes, "_upsert_user_row", lambda *_a, **_k: calls.__setitem__("upsert", calls["upsert"] + 1))
    monkeypatch.setattr(auth_routes, "_maybe_send_welcome_email", lambda *_a, **_k: calls.__setitem__("welcome", calls["welcome"] + 1))
    monkeypatch.setattr(
        auth_routes,
        "get_cloud_settings",
        lambda: SimpleNamespace(
            api_base="https://workeros-api.floom.dev",
            dashboard_origin="https://workeros.floom.dev",
            frontend_url="https://workeros.floom.dev/app",
        ),
    )
    return calls


def _req():
    return PasswordSignupRequest(email="gohigh3242@gmail.com", password="hunter2hunter2", next="/app")


def test_obfuscated_existing_user_returns_clear_409(monkeypatch, _no_side_effects):
    # Existing email -> obfuscated user, empty identities, no session.
    fake_user = _Obj(id="00000000-0000-0000-0000-000000000000", identities=[])
    client = _FakeAnonClient(sign_up_result=_Obj(user=fake_user, session=None))
    monkeypatch.setattr(auth_routes, "new_supabase_anon_client", lambda: client)

    with pytest.raises(HTTPException) as ei:
        auth_routes.password_signup(_req())

    assert ei.value.status_code == 409
    assert ei.value.detail == _ACCOUNT_EXISTS_DETAIL
    # Must NOT have written a bogus users row for the fake id.
    assert _no_side_effects["upsert"] == 0
    assert _no_side_effects["welcome"] == 0


def test_already_registered_exception_maps_to_409(monkeypatch, _no_side_effects):
    exc = Exception("User already registered")
    setattr(exc, "status", 422)
    client = _FakeAnonClient(raises=exc)
    monkeypatch.setattr(auth_routes, "new_supabase_anon_client", lambda: client)

    with pytest.raises(HTTPException) as ei:
        auth_routes.password_signup(_req())

    assert ei.value.status_code == 409
    assert ei.value.detail == _ACCOUNT_EXISTS_DETAIL


def test_genuinely_new_signup_returns_confirmation_required(monkeypatch, _no_side_effects):
    # New email -> user with a real identity, no session yet (confirm email on).
    new_user = _Obj(id="11111111-1111-1111-1111-111111111111", identities=[{"id": "x"}])
    client = _FakeAnonClient(sign_up_result=_Obj(user=new_user, session=None))
    monkeypatch.setattr(auth_routes, "new_supabase_anon_client", lambda: client)

    resp = auth_routes.password_signup(_req())

    assert isinstance(resp, JSONResponse)
    import json

    body = json.loads(resp.body)
    assert body["status"] == "confirmation_required"
    assert body["ok"] is False
    # A real new user IS upserted.
    assert _no_side_effects["upsert"] == 1
