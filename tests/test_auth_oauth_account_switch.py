from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from apps.api.routes import auth as auth_routes


def test_google_oauth_requests_account_picker(monkeypatch):
    captured: dict = {}

    class FakeAuth:
        def sign_in_with_oauth(self, payload):
            captured.update(payload)
            return SimpleNamespace(url="https://example.test/oauth")

        @property
        def _storage_key(self):
            return "sb-test"

        @property
        def _storage(self):
            return {"sb-test-code-verifier": "verifier"}

    fake_client = SimpleNamespace(auth=FakeAuth())
    monkeypatch.setattr(auth_routes, "new_supabase_anon_client", lambda: fake_client)
    monkeypatch.setattr(auth_routes, "_provider_flags", lambda: {"google": True, "github": True})
    monkeypatch.setattr(auth_routes, "_callback_url", lambda **kwargs: "https://example.test/callback")
    monkeypatch.setattr(
        auth_routes,
        "_oauth_code_verifier",
        lambda _client: "verifier",
    )
    monkeypatch.setattr(auth_routes, "_cookie_domain", lambda: None)
    monkeypatch.setattr(auth_routes, "_set_cookie", lambda *args, **kwargs: None)

    response = auth_routes.login(provider="google", next="/app", request=None)

    assert response.status_code == 307
    assert captured["provider"] == "google"
    assert captured["options"]["queryParams"] == {"prompt": "select_account"}
