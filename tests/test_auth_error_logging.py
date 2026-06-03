"""Tests that auth handler except blocks log the underlying GoTrue/Supabase error.

G7 fix: surface real error details to server log without leaking to client.
"""
from __future__ import annotations

import logging

import pytest
from fastapi import HTTPException

from apps.api.routes.auth import _gotrue_detail


# ---------------------------------------------------------------------------
# Unit tests for _gotrue_detail helper
# ---------------------------------------------------------------------------


class _FakeAuthApiError(Exception):
    """Minimal stand-in for supabase_auth.errors.AuthApiError."""

    def __init__(self, message: str, status: int, code: str | None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def test_gotrue_detail_extracts_status_code_and_message():
    exc = _FakeAuthApiError("Email rate limit exceeded", 429, "over_email_send_rate_limit")
    detail = _gotrue_detail(exc)
    assert "429" in detail
    assert "over_email_send_rate_limit" in detail
    assert "Email rate limit exceeded" in detail
    assert "_FakeAuthApiError" in detail


def test_gotrue_detail_handles_plain_exception():
    exc = RuntimeError("connection refused")
    detail = _gotrue_detail(exc)
    assert "RuntimeError" in detail
    assert "connection refused" in detail


def test_gotrue_detail_handles_exception_without_code():
    exc = _FakeAuthApiError("Bad credentials", 400, None)
    detail = _gotrue_detail(exc)
    assert "400" in detail
    # code=None should not appear as "gotrue_code=None" (it's omitted)
    assert "gotrue_code" not in detail


# ---------------------------------------------------------------------------
# Integration: verify logger.warning is called in each except block
# ---------------------------------------------------------------------------


def _make_supabase_exc(status: int = 429, code: str = "over_email_send_rate_limit") -> _FakeAuthApiError:
    return _FakeAuthApiError("rate limit", status, code)


def test_password_login_logs_on_exception(monkeypatch, caplog):
    from apps.api.routes import auth as auth_module

    def _boom(*_a, **_kw):
        raise _make_supabase_exc(status=429)

    monkeypatch.setattr(auth_module, "new_supabase_anon_client", lambda: type(
        "_C", (), {"auth": type("_A", (), {"sign_in_with_password": staticmethod(_boom)})()}
    )())

    with caplog.at_level(logging.WARNING, logger="workeros.cloud.auth"):
        with pytest.raises(HTTPException) as exc_info:
            from apps.api.routes.auth import PasswordLoginRequest, password_login
            password_login(PasswordLoginRequest(email="a@b.com", password="secret"))

    assert exc_info.value.status_code == 429  # rate-limit improvement
    assert any("password-login" in r.message for r in caplog.records)
    assert any("over_email_send_rate_limit" in r.message or "429" in r.message for r in caplog.records)


def test_password_login_logs_invalid_credentials(monkeypatch, caplog):
    from apps.api.routes import auth as auth_module

    def _boom(*_a, **_kw):
        raise _make_supabase_exc(status=401, code="invalid_credentials")

    monkeypatch.setattr(auth_module, "new_supabase_anon_client", lambda: type(
        "_C", (), {"auth": type("_A", (), {"sign_in_with_password": staticmethod(_boom)})()}
    )())

    with caplog.at_level(logging.WARNING, logger="workeros.cloud.auth"):
        with pytest.raises(HTTPException) as exc_info:
            from apps.api.routes.auth import PasswordLoginRequest, password_login
            password_login(PasswordLoginRequest(email="a@b.com", password="wrong"))

    # 401 generic for invalid creds (not 429)
    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Invalid email or password"
    assert any("password-login" in r.message for r in caplog.records)


def test_password_signup_logs_on_exception(monkeypatch, caplog):
    from apps.api.routes import auth as auth_module

    def _boom(*_a, **_kw):
        raise _make_supabase_exc(status=429, code="over_email_send_rate_limit")

    monkeypatch.setattr(auth_module, "new_supabase_anon_client", lambda: type(
        "_C", (), {"auth": type("_A", (), {"sign_up": staticmethod(_boom)})()}
    )())
    monkeypatch.setattr(auth_module, "get_cloud_settings", lambda: type(
        "_S", (), {"api_base": "http://localhost:8000"}
    )())

    with caplog.at_level(logging.WARNING, logger="workeros.cloud.auth"):
        with pytest.raises(HTTPException) as exc_info:
            from apps.api.routes.auth import PasswordSignupRequest, password_signup
            password_signup(PasswordSignupRequest(email="a@b.com", password="password123"))

    assert exc_info.value.status_code == 429
    assert any("password-signup" in r.message for r in caplog.records)


def test_magic_link_logs_on_exception(monkeypatch, caplog):
    from apps.api.routes import auth as auth_module

    def _boom(*_a, **_kw):
        raise _make_supabase_exc(status=429, code="over_email_send_rate_limit")

    monkeypatch.setattr(auth_module, "new_supabase_anon_client", lambda: type(
        "_C", (), {"auth": type("_A", (), {"sign_in_with_otp": staticmethod(_boom)})()}
    )())
    monkeypatch.setattr(auth_module, "get_cloud_settings", lambda: type(
        "_S", (), {"api_base": "http://localhost:8000"}
    )())

    with caplog.at_level(logging.WARNING, logger="workeros.cloud.auth"):
        with pytest.raises(HTTPException) as exc_info:
            from apps.api.routes.auth import login
            login(provider="email", next="/app", email="a@b.com")

    assert exc_info.value.status_code == 502  # magic-link keeps 502
    assert exc_info.value.detail == "Magic link delivery failed"
    assert any("magic-link" in r.message for r in caplog.records)
