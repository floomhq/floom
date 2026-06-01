from __future__ import annotations

import os
from dataclasses import dataclass
from email.utils import parseaddr
from typing import Any


@dataclass(frozen=True)
class EmailSendResult:
    status: str
    provider: str | None = None
    message_id: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class TransactionalEmail:
    to: str
    subject: str
    html: str
    text: str | None = None
    reply_to: str | None = None
    tags: dict[str, str] | None = None


def build_welcome_email(*, to: str, dashboard_url: str) -> TransactionalEmail:
    safe_dashboard_url = dashboard_url.rstrip("/") or "https://workeros.floom.dev"
    html = f"""
<p>Welcome to Workeros.</p>
<p>Your workspace is ready. You can create workers, connect apps, attach Brain packs, and approve work from the dashboard.</p>
<p><a href="{safe_dashboard_url}/app">Open Workeros</a></p>
""".strip()
    text = "\n".join(
        [
            "Welcome to Workeros.",
            "",
            "Your workspace is ready. You can create workers, connect apps, attach Brain packs, and approve work from the dashboard.",
            f"Open Workeros: {safe_dashboard_url}/app",
        ]
    )
    return TransactionalEmail(
        to=to,
        subject="Welcome to Workeros",
        html=html,
        text=text,
        tags={"kind": "welcome"},
    )


def _enabled() -> bool:
    return (os.environ.get("WORKEROS_EMAIL_ENABLED") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _dry_run() -> bool:
    return (os.environ.get("WORKEROS_EMAIL_DRY_RUN") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _require_email(value: str, *, field: str) -> str:
    raw = value.strip()
    _, parsed = parseaddr(raw)
    if "@" not in parsed or len(parsed) > 320:
        raise ValueError(f"{field} must be a valid email address")
    return raw


def email_readiness() -> dict[str, Any]:
    configured = {
        "enabled": _enabled(),
        "dry_run": _dry_run(),
        "provider": "resend",
        "has_api_key": bool((os.environ.get("RESEND_API_KEY") or "").strip()),
        "has_from": bool((os.environ.get("WORKEROS_EMAIL_FROM") or "").strip()),
    }
    configured["ready"] = bool(
        configured["enabled"]
        and configured["has_api_key"]
        and configured["has_from"]
        and not configured["dry_run"]
    )
    return configured


def send_transactional_email(message: TransactionalEmail) -> EmailSendResult:
    to_email = _require_email(message.to, field="to")
    from_email = (os.environ.get("WORKEROS_EMAIL_FROM") or "").strip()
    api_key = (os.environ.get("RESEND_API_KEY") or "").strip()

    if not _enabled():
        return EmailSendResult(status="skipped", provider="resend", reason="email disabled")
    if not from_email:
        return EmailSendResult(status="skipped", provider="resend", reason="WORKEROS_EMAIL_FROM missing")
    _require_email(from_email, field="from")
    if not api_key:
        return EmailSendResult(status="skipped", provider="resend", reason="RESEND_API_KEY missing")
    if _dry_run():
        return EmailSendResult(status="dry_run", provider="resend")

    import resend

    resend.api_key = api_key
    params: dict[str, Any] = {
        "from": from_email,
        "to": [to_email],
        "subject": message.subject,
        "html": message.html,
    }
    if message.text:
        params["text"] = message.text
    if message.reply_to:
        params["reply_to"] = message.reply_to
    if message.tags:
        params["tags"] = [{"name": key, "value": value} for key, value in message.tags.items()]

    response = resend.Emails.send(params)
    message_id = response.get("id") if isinstance(response, dict) else None
    return EmailSendResult(status="sent", provider="resend", message_id=message_id)
