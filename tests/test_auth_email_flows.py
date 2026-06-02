from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.api.routes import auth


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        api_base="https://workeros-api.floom.dev",
        dashboard_origin="https://workeros.floom.dev",
        frontend_url="https://workeros.floom.dev/app",
    )


class _AuthClient:
    def __init__(self, *, signup_response: SimpleNamespace | None = None, user: SimpleNamespace | None = None) -> None:
        self.signup_payloads: list[dict] = []
        self.signup_response = signup_response
        self.user = user

    def sign_up(self, payload: dict):
        self.signup_payloads.append(payload)
        return self.signup_response or SimpleNamespace(user=self.user, session=None)

    def get_user(self, access_token: str):
        assert access_token == "access-token-123"
        return SimpleNamespace(user=self.user)


class _Client:
    def __init__(self, auth_client: _AuthClient) -> None:
        self.auth = auth_client


def _app(monkeypatch, auth_client: _AuthClient) -> TestClient:
    app = FastAPI()
    app.include_router(auth.router)
    monkeypatch.setattr(auth, "get_cloud_settings", _settings)
    monkeypatch.setattr(auth, "_cookie_domain", lambda: ".floom.dev")
    monkeypatch.setattr(auth, "new_supabase_anon_client", lambda: _Client(auth_client))
    monkeypatch.setattr(auth, "_upsert_user_row", lambda user: None)
    monkeypatch.setattr(auth, "_maybe_send_welcome_email", lambda user: None)
    return TestClient(app)


def test_callback_without_query_params_returns_fragment_bridge(monkeypatch):
    client = _app(monkeypatch, _AuthClient())

    response = client.get("/auth/callback?next=/app/settings")

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "/auth/fragment-session" in response.text
    assert "Missing auth callback parameters" not in response.text


def test_password_signup_confirmation_required_is_not_signin_failure(monkeypatch):
    user = SimpleNamespace(id="user-1", email="new@example.com")
    auth_client = _AuthClient(user=user)
    client = _app(monkeypatch, auth_client)

    response = client.post(
        "/auth/password-signup",
        json={"email": "New@Example.com", "password": "passw0rd-long", "next": "/app/settings"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "status": "confirmation_required",
        "email": "new@example.com",
        "next": "/app/settings",
    }
    assert auth_client.signup_payloads[0]["options"]["email_redirect_to"].startswith(
        "https://workeros-api.floom.dev/auth/callback?"
    )


def test_password_signup_with_session_sets_cookie(monkeypatch):
    user = SimpleNamespace(id="user-1", email="new@example.com")
    session = SimpleNamespace(
        access_token="access-token-123",
        refresh_token="refresh-token-123",
        expires_at=1_900_000_000,
        expires_in=3600,
        user=user,
    )
    auth_client = _AuthClient(signup_response=SimpleNamespace(user=user, session=session), user=user)
    client = _app(monkeypatch, auth_client)

    response = client.post(
        "/auth/password-signup",
        json={"email": "new@example.com", "password": "passw0rd-long", "next": "/app"},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "next": "/app"}
    assert "workeros_cloud_session=" in response.headers["set-cookie"]


def test_fragment_session_verifies_token_and_sets_cookie(monkeypatch):
    user = SimpleNamespace(id="user-1", email="new@example.com")
    client = _app(monkeypatch, _AuthClient(user=user))

    response = client.post(
        "/auth/fragment-session",
        json={
            "access_token": "access-token-123",
            "refresh_token": "refresh-token-123",
            "expires_in": 3600,
            "next": "/app/overview",
        },
    )

    assert response.status_code == 200
    assert response.json()["redirect_to"] == "https://workeros.floom.dev/app/overview"
    assert "workeros_cloud_session=" in response.headers["set-cookie"]
