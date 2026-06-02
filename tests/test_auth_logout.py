from __future__ import annotations

from starlette.requests import Request

from apps.api.auth.supabase_provider import ACTIVE_WORKSPACE_COOKIE
from apps.api.routes import auth as auth_routes


def test_logout_clears_session_and_workspace_cookie_variants(monkeypatch):
    monkeypatch.setattr(
        auth_routes,
        "_decode_session_cookie",
        lambda _raw: {"access_token": "", "refresh_token": ""},
    )
    monkeypatch.setattr(auth_routes, "_cookie_domain", lambda: ".floom.dev")

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/auth/logout",
            "headers": [
                (
                    b"cookie",
                    (
                        "workeros_cloud_session=session-cookie; "
                        f"{ACTIVE_WORKSPACE_COOKIE}=workspace-id"
                    ).encode(),
                )
            ],
        }
    )
    response = auth_routes.logout(request)

    assert response.status_code == 200
    set_cookie_values = response.headers.getlist("set-cookie")
    combined = "\n".join(set_cookie_values)
    assert "workeros_cloud_session=" in combined
    assert "workeros_cloud_pkce_verifier=" in combined
    assert f"{ACTIVE_WORKSPACE_COOKIE}=" in combined
    assert "Domain=.floom.dev" in combined
    assert any(
        header.startswith("workeros_cloud_session=") and "Domain=.floom.dev" not in header
        for header in set_cookie_values
    )
    assert any(
        header.startswith(f"{ACTIVE_WORKSPACE_COOKIE}=") and "Domain=.floom.dev" not in header
        for header in set_cookie_values
    )
