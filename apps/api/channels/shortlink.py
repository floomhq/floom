"""Short-link redirect handler for claim tokens.

GET /c/{token}
  - Looks up the token across slack_sender_bindings and whatsapp_sender_bindings
    (pending + unexpired rows only).
  - Returns a 302 to the generic /settings?claim_token=… URL on the frontend.
  - Returns 404 if the token matches no pending/unexpired binding.

This keeps all claim-handling logic in the existing /slack/bindings/claim and
/whatsapp/bindings/claim endpoints — the shortlink is purely a redirect shim.
"""

from __future__ import annotations

import logging
import os
import urllib.parse
from datetime import datetime, timezone

from fastapi import HTTPException
from fastapi.responses import RedirectResponse
from fastapi.routing import APIRouter

logger = logging.getLogger(__name__)

shortlink_router = APIRouter()


def _frontend_base_url() -> str:
    return (
        os.environ.get("WORKERS_FRONTEND_URL")
        or os.environ.get("WORKEROS_PUBLIC_URL")
        or "http://localhost:3000"
    ).rstrip("/")


@shortlink_router.get("/c/{token}", include_in_schema=False)
def claim_shortlink_redirect(token: str):
    """Redirect a short claim token to the full settings claim URL.

    Checks whatsapp_sender_bindings first, then slack_sender_bindings.
    Returns 302 on match, 404 on miss or expired token.
    """
    from db import get_db

    token = (token or "").strip()
    if not token:
        raise HTTPException(status_code=404, detail="Claim link not found")

    now_dt = datetime.now(timezone.utc)
    frontend = _frontend_base_url()

    try:
        with get_db() as conn:
            # WhatsApp bindings
            wa_row = conn.execute(
                """
                SELECT claim_token, claim_expires_at
                FROM whatsapp_sender_bindings
                WHERE claim_token = ?
                  AND status = 'pending'
                """,
                (token,),
            ).fetchone()

            if wa_row:
                try:
                    expires = datetime.fromisoformat(str(wa_row["claim_expires_at"]))
                    if expires.tzinfo is None:
                        expires = expires.replace(tzinfo=timezone.utc)
                except Exception:
                    expires = now_dt  # treat malformed expiry as expired

                if expires >= now_dt:
                    url = f"{frontend}/settings?claim_token={urllib.parse.quote(token)}"
                    return RedirectResponse(url=url, status_code=302)

            # Slack bindings
            sl_row = conn.execute(
                """
                SELECT claim_token, claim_expires_at
                FROM slack_sender_bindings
                WHERE claim_token = ?
                  AND status = 'pending'
                """,
                (token,),
            ).fetchone()

            if sl_row:
                try:
                    expires = datetime.fromisoformat(str(sl_row["claim_expires_at"]))
                    if expires.tzinfo is None:
                        expires = expires.replace(tzinfo=timezone.utc)
                except Exception:
                    expires = now_dt

                if expires >= now_dt:
                    url = f"{frontend}/settings?claim_token={urllib.parse.quote(token)}"
                    return RedirectResponse(url=url, status_code=302)

    except Exception:
        logger.exception("Short-link lookup failed for token prefix %.8s", token)
        raise HTTPException(status_code=404, detail="Claim link not found")

    raise HTTPException(status_code=404, detail="Claim link not found")
