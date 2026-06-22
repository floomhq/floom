#!/usr/bin/env python3
"""Render all WorkerOS transactional email templates to HTML files for preview.

Renders:
  - build_welcome_email (apps/api/email_service)
  - build_workspace_invite_email (apps/api/email_service)
  - 6 Supabase auth templates from scripts/configure_supabase_auth_emails._payload()

Usage:
  python3 scripts/render_emails.py [output_dir]

Default output dir: /tmp/workeros-email-render/
"""
from __future__ import annotations

import re
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ---------------------------------------------------------------------------
# Stub heavy deps that may be absent outside the full app environment
# ---------------------------------------------------------------------------

def _stub_obs():
    """Stub apps.api.obs so email_service imports cleanly without the ORM/DB."""
    import logging

    mod = types.ModuleType("apps.api.obs")

    def get_logger(name: str):
        return logging.getLogger(name)

    def log_failure(logger, msg, *args, **kwargs):
        logger.error(msg, *args)

    mod.get_logger = get_logger
    mod.log_failure = log_failure
    sys.modules.setdefault("apps.api.obs", mod)


_stub_obs()

# ---------------------------------------------------------------------------
# Import email builders
# ---------------------------------------------------------------------------

from apps.api.email_service import build_welcome_email, build_workspace_invite_email  # noqa: E402


# ---------------------------------------------------------------------------
# Supabase auth templates — import _payload lazily, stub if needed
# ---------------------------------------------------------------------------

def _load_supabase_templates() -> dict[str, str]:
    """Return {name: html} for the 6 Supabase auth templates."""
    # configure_supabase_auth_emails imports _workeros_email_html which is
    # already available; its only other dep is urllib (stdlib).
    script_path = ROOT / "scripts" / "configure_supabase_auth_emails.py"
    import importlib.util

    spec = importlib.util.spec_from_file_location("configure_supabase_auth_emails", script_path)
    assert spec and spec.loader
    configure_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(configure_mod)  # type: ignore[union-attr]

    payload = configure_mod._payload()

    # Substitute Mustache/Go template placeholders with sample values so the
    # HTML renders with real-looking (but synthetic) links.
    sample_redirect = "https://workeros.floom.dev/auth/callback"
    # Synthetic placeholder — not a real token; gitleaks false-positive suppressed below
    sample_token = "preview-otp-placeholder-xxxx"  # noqa: S105 gitleaks:allow

    template_keys = {
        "mailer_templates_confirmation_content": "confirmation",
        "mailer_templates_magic_link_content": "magic_link",
        "mailer_templates_recovery_content": "recovery",
        "mailer_templates_email_change_content": "email_change",
        "mailer_templates_invite_content": "invite",
        "mailer_templates_reauthentication_content": "reauthentication",
    }

    result: dict[str, str] = {}
    for key, name in template_keys.items():
        html: str = payload.get(key, "")
        # Replace Mustache-style placeholders
        html = html.replace("{{ .RedirectTo }}", sample_redirect)
        html = html.replace("{{ .TokenHash }}", sample_token)
        # Strip any leftover {{ }} tokens
        html = re.sub(r"\{\{[^}]*\}\}", "", html)
        result[name] = html
    return result


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/workeros-email-render")
    out_dir.mkdir(parents=True, exist_ok=True)

    rendered: list[Path] = []

    # --- welcome email ---
    welcome = build_welcome_email(
        to="preview@example.com",
        dashboard_url="https://workeros.floom.dev",
    )
    path = out_dir / "welcome.html"
    path.write_text(welcome.html, encoding="utf-8")
    rendered.append(path)

    # --- workspace invite email ---
    invite_result = build_workspace_invite_email(
        inviter_name="Alice Smith",
        workspace_name="Acme Corp",
        invite_url="https://workeros.floom.dev/invite/preview-token",
    )
    path = out_dir / "workspace_invite.html"
    path.write_text(invite_result["html"], encoding="utf-8")
    rendered.append(path)

    # --- Supabase auth templates ---
    try:
        supabase_templates = _load_supabase_templates()
        for name, html in supabase_templates.items():
            path = out_dir / f"auth_{name}.html"
            path.write_text(html, encoding="utf-8")
            rendered.append(path)
    except Exception as exc:
        print(f"WARNING: could not render Supabase auth templates: {exc}", file=sys.stderr)

    for p in rendered:
        print(str(p))


if __name__ == "__main__":
    main()
