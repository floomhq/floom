from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from apps.api import email_service as email


def _message() -> email.TransactionalEmail:
    return email.TransactionalEmail(
        to="user@example.com",
        subject="Welcome to WorkerOS",
        html="<p>Hello</p>",
        text="Hello",
        tags={"kind": "welcome"},
    )


def test_email_disabled_is_safe_noop(monkeypatch):
    monkeypatch.delenv("WORKEROS_EMAIL_ENABLED", raising=False)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("WORKEROS_EMAIL_FROM", raising=False)

    result = email.send_transactional_email(_message())

    assert result.status == "skipped"
    assert result.reason == "email disabled"


def test_email_readiness_requires_enabled_key_from_and_not_dry_run(monkeypatch):
    monkeypatch.setenv("WORKEROS_EMAIL_ENABLED", "1")
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    monkeypatch.setenv("WORKEROS_EMAIL_FROM", "Floom <hello@floom.dev>")
    monkeypatch.setenv("WORKEROS_EMAIL_DRY_RUN", "1")

    readiness = email.email_readiness()

    assert readiness["provider"] == "resend"
    assert readiness["has_api_key"] is True
    assert readiness["has_from"] is True
    assert readiness["ready"] is False


def test_welcome_email_uses_dashboard_link():
    message = email.build_welcome_email(
        to="user@example.com",
        dashboard_url="https://workeros.floom.dev",
    )

    assert message.to == "user@example.com"
    assert message.subject == "Welcome to Floom"
    assert message.html.startswith("<!doctype html>")
    assert email.FLOOM_EMAIL_LOGO_URL in message.html
    assert 'alt="Floom"' in message.html
    assert "workeros-card" in message.html
    assert "https://workeros.floom.dev/app" in message.html
    assert "https://workeros.floom.dev/app" in (message.text or "")
    assert message.tags == {"kind": "welcome"}


def test_email_dry_run_does_not_import_or_call_resend(monkeypatch):
    monkeypatch.setenv("WORKEROS_EMAIL_ENABLED", "1")
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    monkeypatch.setenv("WORKEROS_EMAIL_FROM", "hello@floom.dev")
    monkeypatch.setenv("WORKEROS_EMAIL_DRY_RUN", "1")

    result = email.send_transactional_email(_message())

    assert result.status == "dry_run"
    assert result.provider == "resend"


def test_email_enabled_calls_resend_with_server_side_key(monkeypatch):
    calls = []
    fake_resend = SimpleNamespace(
        api_key=None,
        Emails=SimpleNamespace(send=lambda payload: calls.append(payload) or {"id": "email_123"}),
    )
    monkeypatch.setitem(sys.modules, "resend", fake_resend)
    monkeypatch.setenv("WORKEROS_EMAIL_ENABLED", "1")
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    monkeypatch.setenv("WORKEROS_EMAIL_FROM", "Floom <hello@floom.dev>")
    monkeypatch.delenv("WORKEROS_EMAIL_DRY_RUN", raising=False)

    result = email.send_transactional_email(_message())

    assert result.status == "sent"
    assert result.message_id == "email_123"
    assert fake_resend.api_key == "re_test_key"
    assert calls == [
        {
            "from": "Floom <hello@floom.dev>",
            "to": ["user@example.com"],
            "subject": "Welcome to WorkerOS",
            "html": "<p>Hello</p>",
            "text": "Hello",
            "tags": [{"name": "kind", "value": "welcome"}],
        }
    ]


def test_email_provider_exception_returns_failed(monkeypatch):
    def fail_send(_payload):
        raise RuntimeError("provider unavailable")

    fake_resend = SimpleNamespace(
        api_key=None,
        Emails=SimpleNamespace(send=fail_send),
    )
    monkeypatch.setitem(sys.modules, "resend", fake_resend)
    monkeypatch.setenv("WORKEROS_EMAIL_ENABLED", "1")
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    monkeypatch.setenv("WORKEROS_EMAIL_FROM", "Floom <hello@floom.dev>")
    monkeypatch.delenv("WORKEROS_EMAIL_DRY_RUN", raising=False)

    result = email.send_transactional_email(_message())

    assert result.status == "failed"
    assert result.provider == "resend"
    assert "RuntimeError" in (result.reason or "")


def test_invalid_recipient_rejected_before_provider(monkeypatch):
    monkeypatch.setenv("WORKEROS_EMAIL_ENABLED", "1")

    with pytest.raises(ValueError):
        email.send_transactional_email(
            email.TransactionalEmail(to="not-an-email", subject="x", html="<p>x</p>")
        )
