"""Cloud magic-link consume route: GET /auth/magic/{token}.

The cloud overrides the engine's consume endpoint. Instead of creating an SQLite
session, it validates the HMAC token, looks up the user's email from Supabase Admin,
calls auth.admin.generate_link to get a native Supabase session URL, and redirects
the user to it. No email is sent.

Run: pytest tests/test_cloud_magic_link_consume.py -v
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from apps.api.routes import auth as auth_module


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FAKE_USER_ID = "user-uuid-abc123"
_FAKE_EMAIL = "alice@example.com"
_FAKE_ACTION_LINK = "https://project.supabase.co/auth/v1/verify?token=xyz&type=magiclink"
_FAKE_FRONTEND_URL = "https://workeros.floom.dev/app"


def _settings():
    return SimpleNamespace(
        frontend_url=_FAKE_FRONTEND_URL,
        dashboard_origin="https://workeros.floom.dev",
        api_base="https://workeros-api.floom.dev",
    )


def _make_svc_client(*, email=_FAKE_EMAIL, action_link=_FAKE_ACTION_LINK, get_user_raises=None, generate_link_raises=None):
    """Build a mock Supabase service client for the consume route."""
    svc = MagicMock()

    # auth.admin.get_user_by_id
    if get_user_raises:
        svc.auth.admin.get_user_by_id.side_effect = get_user_raises
    else:
        user = SimpleNamespace(id=_FAKE_USER_ID, email=email)
        svc.auth.admin.get_user_by_id.return_value = SimpleNamespace(user=user)

    # auth.admin.generate_link
    if generate_link_raises:
        svc.auth.admin.generate_link.side_effect = generate_link_raises
    else:
        props = SimpleNamespace(action_link=action_link)
        svc.auth.admin.generate_link.return_value = SimpleNamespace(properties=props)

    return svc


def _app(monkeypatch, *, validate_user_id=_FAKE_USER_ID, validate_raises=None, svc_client=None):
    """Create a minimal FastAPI app with the auth router and patched dependencies."""
    if svc_client is None:
        svc_client = _make_svc_client()

    # Patch the engine's _validate_magic_link. We must patch at the _engine module
    # level (not as a context manager) so the mock stays active when requests are made.
    fake_engine = MagicMock()
    if validate_raises:
        fake_engine._validate_magic_link.side_effect = validate_raises
    else:
        fake_engine._validate_magic_link.return_value = validate_user_id

    import apps.api._engine as _engine_mod
    monkeypatch.setattr(_engine_mod, "import_engine_module", lambda _name: fake_engine)
    monkeypatch.setattr(auth_module, "get_cloud_settings", _settings)
    monkeypatch.setattr(auth_module, "new_supabase_service_client", lambda: svc_client)

    app = FastAPI()
    app.include_router(auth_module.router)
    return TestClient(app, follow_redirects=False)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_valid_token_redirects_to_supabase_action_link(monkeypatch):
    """Happy path: valid HMAC token → 307 redirect to Supabase action_link."""
    client = _app(monkeypatch)
    response = client.get("/auth/magic/valid.token")
    assert response.status_code == 307
    assert response.headers["location"] == _FAKE_ACTION_LINK


def test_invalid_token_returns_400(monkeypatch):
    """Engine raises 400 for bad/expired HMAC token → propagated to caller."""
    client = _app(monkeypatch, validate_raises=HTTPException(status_code=400, detail="Invalid magic link"))
    response = client.get("/auth/magic/bad.token")
    assert response.status_code == 400
    assert "Invalid magic link" in response.json()["detail"]


def test_user_not_found_in_supabase_returns_404(monkeypatch):
    """Token is valid but Supabase Admin returns no user → 404."""
    svc = _make_svc_client(get_user_raises=Exception("user not found"))
    client = _app(monkeypatch, svc_client=svc)
    response = client.get("/auth/magic/valid.token")
    assert response.status_code == 404
    assert response.json()["detail"] == "User not found"


def test_user_with_no_email_returns_404(monkeypatch):
    """Supabase returns a user with no email field → 404 (can't generate link)."""
    svc = MagicMock()
    svc.auth.admin.get_user_by_id.return_value = SimpleNamespace(user=SimpleNamespace(id=_FAKE_USER_ID, email=None))
    client = _app(monkeypatch, svc_client=svc)
    response = client.get("/auth/magic/valid.token")
    assert response.status_code == 404


def test_generate_link_failure_returns_502(monkeypatch):
    """Supabase generate_link raises → 502 (upstream failure, not our bug)."""
    svc = _make_svc_client(generate_link_raises=Exception("supabase unavailable"))
    client = _app(monkeypatch, svc_client=svc)
    response = client.get("/auth/magic/valid.token")
    assert response.status_code == 502
    assert "Failed to create session" in response.json()["detail"]


def test_generate_link_empty_action_link_returns_502(monkeypatch):
    """generate_link returns empty action_link → 502 (upstream contract violation)."""
    svc = _make_svc_client(action_link="")
    client = _app(monkeypatch, svc_client=svc)
    response = client.get("/auth/magic/valid.token")
    assert response.status_code == 502


def test_redirect_uses_supabase_url_not_frontend_url(monkeypatch):
    """Redirect destination is the Supabase action_link, not the frontend URL."""
    custom_link = "https://abc.supabase.co/auth/v1/verify?token=tok&type=magiclink&redirect_to=https%3A%2F%2Fworkeros.floom.dev%2Fapp"
    svc = _make_svc_client(action_link=custom_link)
    client = _app(monkeypatch, svc_client=svc)
    response = client.get("/auth/magic/some.token")
    assert response.status_code == 307
    assert response.headers["location"] == custom_link
    assert "workeros.floom.dev/auth/magic" not in response.headers["location"]


def test_generate_link_called_with_correct_params(monkeypatch):
    """generate_link must be called with type=magiclink, user email, and frontend_url as redirect_to."""
    svc = _make_svc_client()
    client = _app(monkeypatch, svc_client=svc)
    client.get("/auth/magic/valid.token")

    svc.auth.admin.generate_link.assert_called_once_with(
        {
            "type": "magiclink",
            "email": _FAKE_EMAIL,
            "options": {"redirect_to": _FAKE_FRONTEND_URL},
        }
    )


def test_no_email_is_sent_to_user(monkeypatch):
    """sign_in_with_otp must NOT be called — no email delivery in this flow."""
    svc = _make_svc_client()
    client = _app(monkeypatch, svc_client=svc)
    client.get("/auth/magic/valid.token")
    svc.auth.sign_in_with_otp.assert_not_called()
