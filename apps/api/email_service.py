from __future__ import annotations

import os
from dataclasses import dataclass
from email.utils import parseaddr
from html import escape
from typing import Any

from apps.api.obs import get_logger, log_failure

logger = get_logger(__name__)

# Floom email logo (dark rounded-square play-arrow mark + "Floom" wordmark),
# served as a stable absolute https asset from the Floom OS marketing surface.
# Gmail and other clients require an absolute https URL for <img> in email; data
# URIs are stripped. The asset is hosted (and verified 200) at
# workers.floom.dev/brand/floom-email-logo@2x.png — the cloud root domain
# (workeros.floom.dev) is behind an auth middleware that blocks static assets.
FLOOM_EMAIL_LOGO_URL = "https://workers.floom.dev/brand/floom-email-logo@2x.png"


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
        preheader="Your Floom workspace is ready.",
        eyebrow="Workspace ready",
        headline="Welcome to Floom",
        body_html="""
<p class="workeros-ink" style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:17px;line-height:1.55;margin:0 0 20px;color:#16171A;font-weight:400;">Your workspace is ready. You can create workers, connect apps, attach Brain packs, and approve work from the dashboard.</p>
<p class="workeros-ink" style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:15px;line-height:1.65;margin:0 0 16px;color:#16171A;">Start with one worker, then attach the exact connections and Brain resources it is allowed to use.</p>
""".strip(),
        cta_label="Open Floom",
        cta_url=dashboard_link,
        footer_note="Need help? Reply to this email - a human reads every one.",
    )
    text = "\n".join(
        [
            "Welcome to Floom.",
            "",
            "Your workspace is ready. You can create workers, connect apps, attach Brain packs, and approve work from the dashboard.",
            f"Open Floom: {dashboard_link}",
        ]
    )
    return TransactionalEmail(
        to=to,
        subject="Welcome to Floom",
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
<title>Floom</title>
<style>
@media only screen and (max-width: 480px) {{
  .workeros-shell {{ padding: 16px 12px !important; }}
  .workeros-card {{ padding: 28px 24px 32px !important; border-radius: 0 0 12px 12px !important; }}
  .workeros-band {{ padding: 22px 24px !important; border-radius: 12px 12px 0 0 !important; }}
  .workeros-h1 {{ font-size: 24px !important; line-height: 1.22 !important; }}
  .workeros-cta a {{ display: block !important; padding: 16px 22px !important; }}
}}
@media (prefers-color-scheme: dark) {{
  .workeros-shell-bg {{ background: #FBFBFC !important; }}
  .workeros-ink {{ color: #16171A !important; }}
  .workeros-card-bg {{ background: #FFFFFF !important; }}
}}
</style>
</head>
<body class="workeros-shell-bg" style="margin:0;padding:0;background:#FBFBFC;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;color:#16171A;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">{safe_preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FBFBFC;">
<tr><td align="center" class="workeros-shell" style="padding:40px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td class="workeros-band" style="background:#F3F4F6;border:1px solid #ECEDF0;border-bottom:none;border-radius:16px 16px 0 0;padding:26px 36px;border-top:2px solid #3E6FE0;">
<a href="https://workeros.floom.dev" style="text-decoration:none;display:inline-block;"><img src="{FLOOM_EMAIL_LOGO_URL}" width="120" height="42" alt="Floom" style="display:block;border:0;outline:none;height:42px;width:120px;max-width:120px;"></a>
</td></tr>
<tr><td class="workeros-card workeros-card-bg" style="background:#FFFFFF;border:1px solid #ECEDF0;border-top:none;border-radius:0 0 16px 16px;padding:40px 40px 44px;">
<p style="margin:0 0 10px;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:11px;line-height:1.4;font-weight:650;letter-spacing:0.12em;text-transform:uppercase;color:#6B7280;">{safe_eyebrow}</p>
<h1 class="workeros-h1 workeros-ink" style="margin:0 0 24px;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:28px;line-height:1.2;font-weight:650;letter-spacing:0;color:#16171A;">{safe_headline}</h1>
{body_html}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="workeros-cta" style="margin:28px 0 8px;"><tr><td style="border-radius:10px;background:#3E6FE0;"><a href="{safe_cta_url}" style="display:inline-block;background:#3E6FE0;color:#FFFFFF;text-decoration:none;padding:14px 28px;border-radius:10px;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:15px;font-weight:650;letter-spacing:0;line-height:1;">{safe_cta_label}</a></td></tr></table>
<p style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:13px;line-height:1.55;margin:0 0 16px;color:#6B7280;">Or paste this link into your browser:<br><a href="{safe_cta_url}" style="color:#6B7280;word-break:break-all;text-decoration:underline;">{safe_cta_url}</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px;"><tr><td style="border-top:1px solid #ECEDF0;font-size:0;line-height:0;">&nbsp;</td></tr></table>
<p style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:13px;line-height:1.55;margin:16px 0 0;color:#6B7280;">{safe_footer_note}</p>
</td></tr>
<tr><td style="padding:28px 4px 4px;font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:12px;line-height:1.6;color:#6B7280;">
<a href="https://workeros.floom.dev" style="color:#16171A;font-weight:650;text-decoration:none;">Floom</a> &middot; <a href="mailto:team@floom.dev" style="color:#6B7280;text-decoration:underline;">team@floom.dev</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""


def build_workspace_invite_email(
    *,
    inviter_name: str,
    workspace_name: str,
    invite_url: str,
) -> dict[str, str]:
    """Return ``{"subject": ..., "html": ..., "text": ...}`` for a workspace invite."""
    safe_inviter = escape(inviter_name or "A workspace admin")
    safe_workspace = escape(workspace_name or "a workspace")
    html = _workeros_email_html(
        preheader=f"{safe_inviter} invited you to join {safe_workspace} on Floom.",
        eyebrow="Workspace invitation",
        headline=f"You've been invited to {safe_workspace}",
        body_html=f"""
<p class="workeros-ink" style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:17px;line-height:1.55;margin:0 0 20px;color:#16171A;font-weight:400;"><strong>{safe_inviter}</strong> has invited you to collaborate on <strong>{safe_workspace}</strong>.</p>
<p class="workeros-ink" style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:15px;line-height:1.65;margin:0 0 16px;color:#16171A;">Accept the invitation to access shared workers and start collaborating. The link expires in 7 days.</p>
""".strip(),
        cta_label="Accept invitation",
        cta_url=escape(invite_url, quote=True),
        footer_note="If you didn't expect this invitation, you can safely ignore this email.",
    )
    text = "\n".join(
        [
            f"{inviter_name} invited you to join {workspace_name} on Floom.",
            "",
            "Accept the invitation to access shared workers and start collaborating.",
            f"Accept invitation: {invite_url}",
            "",
            "The link expires in 7 days. If you didn't expect this, ignore this email.",
        ]
    )
    return {
        "subject": f"You're invited to join {workspace_name} on Floom",
        "html": html,
        "text": text,
    }


def send_email(*, to: str, subject: str, html: str, text: str | None = None) -> EmailSendResult:
    """Convenience wrapper for sending a plain html/text email."""
    return send_transactional_email(
        TransactionalEmail(to=to, subject=subject, html=html, text=text)
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

    try:
        response = resend.Emails.send(params)
    except Exception as exc:
        # Real failure: a transactional email (welcome / workspace invite) was
        # not delivered. Previously this returned status="failed" with no log, so
        # invite/welcome drops vanished silently. Log the recipient + subject +
        # tags (never the api_key or full payload) so the drop is actionable.
        log_failure(
            logger,
            "Transactional email send failed: to=%s subject=%r",
            to_email,
            message.subject,
            tags=(sorted(message.tags) if message.tags else None),
        )
        return EmailSendResult(
            status="failed",
            provider="resend",
            reason=f"{type(exc).__name__}: {str(exc)[:240]}",
        )
    message_id = response.get("id") if isinstance(response, dict) else None
    return EmailSendResult(status="sent", provider="resend", message_id=message_id)
