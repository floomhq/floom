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
        self.otp_payloads: list[dict] = []
        self.verify_payloads: list[dict] = []
        self.refresh_payloads: list[str] = []
        self.signup_response = signup_response
        self.user = user

    def sign_in_with_otp(self, payload: dict):
        self.otp_payloads.append(payload)
        return SimpleNamespace()

    def sign_up(self, payload: dict):
        self.signup_payloads.append(payload)
        return self.signup_response or SimpleNamespace(user=self.user, session=None)

    def verify_otp(self, payload: dict):
        self.verify_payloads.append(payload)
        user = self.user or SimpleNamespace(id="user-1", email="new@example.com")
        session = SimpleNamespace(
            access_token="access-token-123",
            refresh_token="refresh-token-123",
            expires_at=1_900_000_000,
            expires_in=3600,
            user=user,
        )
        return SimpleNamespace(user=user, session=session)

    def get_user(self, access_token: str):
        assert access_token == "access-token-123"
        return SimpleNamespace(user=self.user)

    def refresh_session(self, refresh_token: str):
        self.refresh_payloads.append(refresh_token)
        user = self.user or SimpleNamespace(id="user-1", email="new@example.com")
        session = SimpleNamespace(
            access_token="rotated-access-token-123",
            refresh_token="rotated-refresh-token-123",
            expires_at=1_900_000_500,
            expires_in=3600,
            user=user,
        )
        return SimpleNamespace(user=user, session=session)


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
    assert "https://workeros.floom.dev/app/login?error=auth_callback_missing" in response.text
    assert "https://workeros.floom.dev/login?error=auth_callback_missing" not in response.text


def test_email_magic_link_rejects_invalid_email_before_supabase(monkeypatch):
    auth_client = _AuthClient()
    client = _app(monkeypatch, auth_client)

    response = client.get("/auth/login?provider=email&email=not-an-email&next=/app")

    assert response.status_code == 400
    assert response.json() == {"detail": "valid email is required"}
    assert auth_client.otp_payloads == []


def test_password_login_rejects_invalid_email_before_supabase(monkeypatch):
    auth_client = _AuthClient()
    client = _app(monkeypatch, auth_client)

    response = client.post(
        "/auth/password-login",
        json={"email": "not-an-email", "password": "passw0rd-long", "next": "/app"},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "valid email is required"}


def test_password_signup_rejects_invalid_email_before_supabase(monkeypatch):
    auth_client = _AuthClient()
    client = _app(monkeypatch, auth_client)

    response = client.post(
        "/auth/password-signup",
        json={"email": "not-an-email", "password": "passw0rd-long", "next": "/app"},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "valid email is required"}
    assert auth_client.signup_payloads == []


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


def test_password_signup_uses_allowed_frontend_origin_for_callback(monkeypatch):
    monkeypatch.setenv("WORKEROS_ALLOWED_FRONTEND_ORIGINS", "https://preview.example")
    user = SimpleNamespace(id="user-1", email="new@example.com")
    auth_client = _AuthClient(user=user)
    client = _app(monkeypatch, auth_client)

    response = client.post(
        "/auth/password-signup",
        json={"email": "New@Example.com", "password": "passw0rd-long", "next": "/app/settings"},
        headers={"x-workeros-frontend-origin": "https://preview.example"},
    )

    assert response.status_code == 200
    redirect_to = auth_client.signup_payloads[0]["options"]["email_redirect_to"]
    assert redirect_to.startswith("https://preview.example/api/proxy/auth/callback?")
    assert "next=%2Fapp%2Fsettings" in redirect_to


def test_password_signup_ignores_unallowed_frontend_origin(monkeypatch):
    monkeypatch.setenv("WORKEROS_ALLOWED_FRONTEND_ORIGINS", "https://preview.example")
    user = SimpleNamespace(id="user-1", email="new@example.com")
    auth_client = _AuthClient(user=user)
    client = _app(monkeypatch, auth_client)

    response = client.post(
        "/auth/password-signup",
        json={"email": "New@Example.com", "password": "passw0rd-long", "next": "/app/settings"},
        headers={"x-workeros-frontend-origin": "https://evil.example"},
    )

    assert response.status_code == 200
    redirect_to = auth_client.signup_payloads[0]["options"]["email_redirect_to"]
    assert redirect_to.startswith("https://workeros-api.floom.dev/auth/callback?")


def test_auth_email_templates_use_qp_safe_token_query_separators():
    from scripts.configure_supabase_auth_emails import _payload

    payload = _payload()
    for key in [
        "mailer_templates_confirmation_content",
        "mailer_templates_magic_link_content",
        "mailer_templates_recovery_content",
        "mailer_templates_email_change_content",
        "mailer_templates_invite_content",
        "mailer_templates_reauthentication_content",
    ]:
        template = payload[key]
        assert "confirmation_url={{ .RedirectTo }}%26token_hash%3D{{ .TokenHash }}%26type%3D" in template
        assert "token_hash%3D{{ .TokenHash }}" in template
        assert "token_hash={{ .TokenHash }}" not in template
        assert "%26type%3D" in template
        assert "&amp;type=" not in template


def test_callback_accepts_qp_safe_encoded_token_query_separator(monkeypatch):
    user = SimpleNamespace(id="user-1", email="new@example.com")
    auth_client = _AuthClient(user=user)
    client = _app(monkeypatch, auth_client)

    response = client.get(
        "/auth/callback?next=/app&token_hash%3De978abc123&type%3Dsignup",
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert response.headers["location"] == "https://workeros.floom.dev/app"
    assert auth_client.verify_payloads == [
        {
            "token_hash": "e978abc123",
            "type": "signup",
            "options": {
                "redirect_to": "https://workeros-api.floom.dev/auth/callback?next=%2Fapp"
            },
        }
    ]
    assert "workeros_cloud_session=" in response.headers["set-cookie"]


def test_callback_accepts_qp_safe_confirmation_url_wrapper(monkeypatch):
    user = SimpleNamespace(id="user-1", email="new@example.com")
    auth_client = _AuthClient(user=user)
    client = _app(monkeypatch, auth_client)

    response = client.get(
        "/auth/callback?"
        "next=/app&"
        "confirmation_url=https://workeros-api.floom.dev/auth/callback?next=%2Fapp"
        "%26token_hash%3Dcb37abc123%26type%3Dsignup",
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert auth_client.verify_payloads[0]["token_hash"] == "cb37abc123"
    assert auth_client.verify_payloads[0]["type"] == "signup"
    assert "workeros_cloud_session=" in response.headers["set-cookie"]


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
    cookie_value = response.headers["set-cookie"].split("workeros_cloud_session=", 1)[1].split(";", 1)[0]
    assert cookie_value.startswith("v2.")
    assert "access-token-123" not in cookie_value
    assert "refresh-token-123" not in cookie_value
    decoded = auth._decode_session_cookie(cookie_value)
    assert decoded is not None
    assert decoded["access_token"] == "access-token-123"
    assert decoded["refresh_token"] == "refresh-token-123"


def test_session_cookie_rejects_tampered_ciphertext(monkeypatch):
    user = SimpleNamespace(id="user-1", email="new@example.com")
    session = SimpleNamespace(
        access_token="access-token-123",
        refresh_token="refresh-token-123",
        expires_at=1_900_000_000,
        expires_in=3600,
        user=user,
    )
    cookie = auth._encode_session_cookie(session)

    assert auth._decode_session_cookie(cookie[:-1] + ("A" if cookie[-1] != "A" else "B")) is None


def test_session_token_returns_access_token_from_encrypted_cookie(monkeypatch):
    user = SimpleNamespace(id="user-1", email="new@example.com")
    auth_client = _AuthClient(user=user)
    client = _app(monkeypatch, auth_client)
    session = SimpleNamespace(
        access_token="access-token-123",
        refresh_token="refresh-token-123",
        expires_at=1_900_000_000,
        expires_in=3600,
        user=user,
    )

    response = client.get(
        "/auth/session-token",
        cookies={"workeros_cloud_session": auth._encode_session_cookie(session)},
    )

    assert response.status_code == 200
    assert response.json()["access_token"] == "access-token-123"
    assert auth_client.refresh_payloads == []


def test_session_token_refreshes_near_expiry_cookie(monkeypatch):
    user = SimpleNamespace(id="user-1", email="new@example.com")
    auth_client = _AuthClient(user=user)
    client = _app(monkeypatch, auth_client)
    session = SimpleNamespace(
        access_token="old-access-token-123",
        refresh_token="refresh-token-123",
        expires_at=1,
        expires_in=3600,
        user=user,
    )

    response = client.get(
        "/auth/session-token",
        cookies={"workeros_cloud_session": auth._encode_session_cookie(session)},
    )

    assert response.status_code == 200
    assert response.json()["access_token"] == "rotated-access-token-123"
    assert auth_client.refresh_payloads == ["refresh-token-123"]
    cookie_value = response.headers["set-cookie"].split("workeros_cloud_session=", 1)[1].split(";", 1)[0]
    assert cookie_value.startswith("v2.")
    assert "rotated-refresh-token-123" not in cookie_value


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
