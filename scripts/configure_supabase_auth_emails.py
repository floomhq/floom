#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from apps.api.email import _workeros_email_html


AUTH_CONFIG_URL = "https://api.supabase.com/v1/projects/{project_ref}/config/auth"


def _load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"').strip("'")
    return values


def _setting(name: str, *sources: dict[str, str]) -> str:
    if os.environ.get(name):
        return os.environ[name].strip()
    for source in sources:
        if source.get(name):
            return source[name].strip()
    return ""


def _body(text: str) -> str:
    return f"""<p class="workeros-ink" style="font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;font-size:17px;line-height:1.55;margin:0 0 20px;color:#181716;font-weight:400;">{text}</p>"""


def _template(
    *,
    preheader: str,
    eyebrow: str,
    headline: str,
    body: str,
    cta_label: str,
    otp_type: str,
) -> str:
    # Keep the token/type query separators out of quoted-printable's `=XX`
    # grammar. SES/Supabase Auth emails have corrupted links when a token starts
    # with hex bytes such as e9 or cb and the body contains `token_hash=e9...`.
    #
    # If the email provider preserves the wrapper, deployed callbacks can read
    # token_hash/type from the nested URL. If it normalizes to direct encoded
    # separators, apps/api/routes/auth.py reads that shape too.
    action_url = (
        "{{ .RedirectTo }}&confirmation_url={{ .RedirectTo }}"
        "%26token_hash%3D{{ .TokenHash }}%26type%3D" + otp_type
    )
    return _workeros_email_html(
        preheader=preheader,
        eyebrow=eyebrow,
        headline=headline,
        body_html=_body(body),
        cta_label=cta_label,
        cta_url=action_url,
        footer_note="If you did not request this email, you can ignore it.",
    )


def _payload() -> dict[str, Any]:
    return {
        "mailer_subjects_confirmation": "Confirm your Floom email",
        "mailer_subjects_magic_link": "Your Floom sign-in link",
        "mailer_subjects_recovery": "Reset your Floom password",
        "mailer_subjects_email_change": "Confirm your new Floom email",
        "mailer_subjects_invite": "You've been invited to Floom",
        "mailer_subjects_reauthentication": "Verify this is you on Floom",
        "mailer_templates_confirmation_content": _template(
            preheader="Confirm your email to finish setting up Floom.",
            eyebrow="Account setup",
            headline="Confirm your email",
            body="Confirm this is your address to finish setting up your Floom account.",
            cta_label="Confirm email",
            otp_type="signup",
        ),
        "mailer_templates_magic_link_content": _template(
            preheader="Click to sign in to Floom. This link expires soon.",
            eyebrow="Sign in",
            headline="Your Floom sign-in link",
            body="Click below to sign in to Floom. The link can only be used once.",
            cta_label="Sign in to Floom",
            otp_type="email",
        ),
        "mailer_templates_recovery_content": _template(
            preheader="Reset your Floom password.",
            eyebrow="Password reset",
            headline="Reset your password",
            body="Click below to choose a new password for your Floom account.",
            cta_label="Reset password",
            otp_type="recovery",
        ),
        "mailer_templates_email_change_content": _template(
            preheader="Confirm your new Floom email address.",
            eyebrow="Email change",
            headline="Confirm your new email",
            body="Click below to confirm the new email address for your Floom account.",
            cta_label="Confirm new email",
            otp_type="email_change",
        ),
        "mailer_templates_invite_content": _template(
            preheader="You have been invited to a Floom workspace.",
            eyebrow="Workspace invite",
            headline="You've been invited",
            body="Accept the invite to join a Floom workspace and start using shared workers, connections, and Brain packs.",
            cta_label="Accept invite",
            otp_type="invite",
        ),
        "mailer_templates_reauthentication_content": _template(
            preheader="Quick verification step for Floom.",
            eyebrow="Verify it's you",
            headline="Confirm this is you",
            body="We need to verify your identity before continuing.",
            cta_label="Verify",
            otp_type="reauthentication",
        ),
    }


def _request_json(method: str, url: str, pat: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {pat}",
            "Content-Type": "application/json",
            "User-Agent": "workeros-ops/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode())


def main() -> int:
    parser = argparse.ArgumentParser(description="Configure Floom Supabase Auth email templates.")
    parser.add_argument("--apply", action="store_true", help="Patch the live Supabase project.")
    args = parser.parse_args()

    secret_env = _load_env_file(Path("/root/.config/floom-secrets/supabase-management.env"))
    service_env = _load_env_file(Path("/etc/workeros-cloud/api.env"))
    pat = _setting("SUPABASE_MANAGEMENT_PAT", secret_env, service_env)
    project_ref = _setting("WORKEROS_CLOUD_PROJECT_REF", service_env, secret_env)
    if not pat or not project_ref:
        raise SystemExit("Missing SUPABASE_MANAGEMENT_PAT or WORKEROS_CLOUD_PROJECT_REF")

    url = AUTH_CONFIG_URL.format(project_ref=project_ref)
    payload = _payload()
    # Sender identity: the grey "WORKEROS" name in the inbox comes from the
    # Supabase auth SMTP sender name. The Supabase Management API requires the
    # full SMTP block when patching any smtp_* field, and smtp_port must be a
    # STRING. Read the current config first so we preserve host/user/admin.
    if args.apply:
        before = _request_json("GET", url, pat)
        smtp_patch = {
            "smtp_sender_name": "Floom",
            "smtp_admin_email": before.get("smtp_admin_email"),
            "smtp_host": before.get("smtp_host"),
            "smtp_port": str(before.get("smtp_port") or "587"),
            "smtp_user": before.get("smtp_user"),
        }
        smtp_patch = {k: v for k, v in smtp_patch.items() if v is not None}
        _request_json("PATCH", url, pat, smtp_patch)
        _request_json("PATCH", url, pat, payload)
        current = _request_json("GET", url, pat)
    else:
        current = payload

    print("project_ref_present=true")
    print(f"applied={str(args.apply).lower()}")
    for key in [
        "mailer_templates_confirmation_content",
        "mailer_templates_magic_link_content",
        "mailer_templates_recovery_content",
    ]:
        value = current.get(key) or ""
        print(
            f"{key}: len={len(value)} "
            f"has_token_hash={'TokenHash' in value} "
            f"has_redirect_to={'RedirectTo' in value} "
            f"has_floom={'Floom' in value} "
            f"has_logo={'floom-email-logo' in value}"
        )
    for key in [
        "mailer_subjects_confirmation",
        "mailer_subjects_magic_link",
        "mailer_subjects_recovery",
        "smtp_sender_name",
    ]:
        print(f"{key}={current.get(key)!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
