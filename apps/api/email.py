from __future__ import annotations

import os
from dataclasses import dataclass
from email.utils import parseaddr
from html import escape
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
    dashboard_link = f"{safe_dashboard_url}/app"
    html = _workeros_email_html(
        preheader="Your Workeros workspace is ready.",
        eyebrow="Workspace ready",
        headline="Welcome to Workeros",
        body_html="""
<p class="workeros-ink" style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:17px;line-height:1.55;margin:0 0 20px;color:#181716;font-weight:400;">Your workspace is ready. You can create workers, connect apps, attach Brain packs, and approve work from the dashboard.</p>
<p class="workeros-ink" style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:15px;line-height:1.65;margin:0 0 16px;color:#181716;">Start with one worker, then attach the exact connections and Brain resources it is allowed to use.</p>
""".strip(),
        cta_label="Open Workeros",
        cta_url=dashboard_link,
        footer_note="Need help? Reply to this email - a human reads every one.",
    )
    text = "\n".join(
        [
            "Welcome to Workeros.",
            "",
            "Your workspace is ready. You can create workers, connect apps, attach Brain packs, and approve work from the dashboard.",
            f"Open Workeros: {dashboard_link}",
        ]
    )
    return TransactionalEmail(
        to=to,
        subject="Welcome to Workeros",
        html=html,
        text=text,
        tags={"kind": "welcome"},
    )


def _workeros_email_html(
    *,
    preheader: str,
    eyebrow: str,
    headline: str,
    body_html: str,
    cta_label: str,
    cta_url: str,
    footer_note: str,
) -> str:
    safe_preheader = escape(preheader)
    safe_eyebrow = escape(eyebrow)
    safe_headline = escape(headline)
    safe_cta_label = escape(cta_label)
    safe_cta_url = escape(cta_url, quote=True)
    safe_footer_note = escape(footer_note)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>Workeros</title>
<style>
@media only screen and (max-width: 480px) {{
  .workeros-shell {{ padding: 16px 12px !important; }}
  .workeros-card {{ padding: 28px 24px 32px !important; border-radius: 0 0 12px 12px !important; }}
  .workeros-band {{ padding: 22px 24px !important; border-radius: 12px 12px 0 0 !important; }}
  .workeros-h1 {{ font-size: 24px !important; line-height: 1.22 !important; }}
  .workeros-cta a {{ display: block !important; padding: 16px 22px !important; }}
}}
@media (prefers-color-scheme: dark) {{
  .workeros-shell-bg {{ background: #fbfaf7 !important; }}
  .workeros-ink {{ color: #181716 !important; }}
  .workeros-card-bg {{ background: #fffefb !important; }}
}}
</style>
</head>
<body class="workeros-shell-bg" style="margin:0;padding:0;background:#fbfaf7;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;color:#181716;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">{safe_preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fbfaf7;">
<tr><td align="center" class="workeros-shell" style="padding:40px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td class="workeros-band" style="background:#f1eee8;border:1px solid #ded8cf;border-bottom:none;border-radius:14px 14px 0 0;padding:28px 36px;border-top:2px solid #181716;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="width:28px;height:28px;border-radius:8px;background:#181716;color:#fffefb;font-size:0;line-height:0;">&nbsp;</td><td style="padding-left:10px;font-size:16px;font-weight:650;letter-spacing:-0.01em;color:#181716;">Floom <span style="color:#6f6960;font-weight:450;">/ workeros</span></td></tr></table>
</td></tr>
<tr><td class="workeros-card workeros-card-bg" style="background:#fffefb;border:1px solid #ded8cf;border-top:none;border-radius:0 0 14px 14px;padding:40px 40px 44px;">
<p style="margin:0 0 10px;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:11px;line-height:1.4;font-weight:650;letter-spacing:0.12em;text-transform:uppercase;color:#6f6960;">{safe_eyebrow}</p>
<h1 class="workeros-h1 workeros-ink" style="margin:0 0 24px;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:28px;line-height:1.2;font-weight:650;letter-spacing:0;color:#181716;">{safe_headline}</h1>
{body_html}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="workeros-cta" style="margin:28px 0 8px;"><tr><td style="border-radius:8px;background:#181716;"><a href="{safe_cta_url}" style="display:inline-block;background:#181716;color:#fffefb;text-decoration:none;padding:14px 28px;border-radius:8px;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:15px;font-weight:650;letter-spacing:0;line-height:1;">{safe_cta_label}</a></td></tr></table>
<p style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:13px;line-height:1.55;margin:0 0 16px;color:#6f6960;">Or paste this link into your browser:<br><a href="{safe_cta_url}" style="color:#6f6960;word-break:break-all;text-decoration:underline;">{safe_cta_url}</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px;"><tr><td style="border-top:1px solid #ded8cf;font-size:0;line-height:0;">&nbsp;</td></tr></table>
<p style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:13px;line-height:1.55;margin:16px 0 0;color:#6f6960;">{safe_footer_note}</p>
</td></tr>
<tr><td style="padding:28px 4px 4px;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:12px;line-height:1.6;color:#6f6960;">
<a href="https://workeros.floom.dev" style="color:#181716;font-weight:650;text-decoration:none;">Workeros</a> &middot; <a href="mailto:team@floom.dev" style="color:#6f6960;text-decoration:underline;">team@floom.dev</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""


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

    try:
        response = resend.Emails.send(params)
    except Exception as exc:
        return EmailSendResult(
            status="failed",
            provider="resend",
            reason=f"{type(exc).__name__}: {str(exc)[:240]}",
        )
    message_id = response.get("id") if isinstance(response, dict) else None
    return EmailSendResult(status="sent", provider="resend", message_id=message_id)
