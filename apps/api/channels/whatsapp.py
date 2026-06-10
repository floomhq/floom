"""WhatsApp (Meta WhatsApp Business Cloud API) channel — routes and helpers.

All route paths are identical to those previously defined directly on the
``app`` FastAPI instance in main.py.  The router is included in main.py via
``app.include_router(whatsapp_router)``.

Lazy imports are used for anything from main.py to avoid circular imports.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import requests
from fastapi import BackgroundTasks, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.routing import APIRouter
from pydantic import BaseModel, ConfigDict

from auth import AuthContext, get_auth_context
from channels.common import _MAX_WEBHOOK_BODY_BYTES, collect_agent_reply

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

whatsapp_router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WHATSAPP_TEXT_MAX = 4096


# ---------------------------------------------------------------------------
# Environment / feature-flag helpers
# ---------------------------------------------------------------------------

def _whatsapp_graph_version() -> str:
    return (os.environ.get("WHATSAPP_GRAPH_VERSION") or "v23.0").strip() or "v23.0"


def _whatsapp_phone_id() -> str:
    return (os.environ.get("WHATSAPP_PHONE_ID") or "").strip()


def _whatsapp_token() -> str:
    return (os.environ.get("WHATSAPP_TOKEN") or "").strip()


def _whatsapp_app_secret() -> str:
    return (os.environ.get("WHATSAPP_APP_SECRET") or "").strip()


def _whatsapp_webhook_verify_token() -> str:
    return (os.environ.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN") or "").strip()


def _whatsapp_enabled() -> bool:
    """Feature flag, mirrors _slack_events_enabled.

    Defaults ON, but the endpoints additionally fail closed when the concrete
    Meta credentials (phone id + token) are absent, so an enabled-but-unconfigured
    deploy is still inert.
    """
    value = os.environ.get("WHATSAPP_ENABLED", "1").strip().lower()
    return value not in {"0", "false", "no", "off"}


def _whatsapp_configured() -> bool:
    """True only when the outbound send path is usable (phone id + token)."""
    return bool(_whatsapp_phone_id() and _whatsapp_token())


# ---------------------------------------------------------------------------
# WA-ID normalization / claim helpers
# ---------------------------------------------------------------------------

def _normalize_whatsapp_wa_id(wa_id: str) -> str:
    return re.sub(r"\D", "", str(wa_id or ""))


def _whatsapp_claim_url(token: str) -> str:
    base = (
        os.environ.get("WORKERS_FRONTEND_URL")
        or os.environ.get("WORKEROS_PUBLIC_URL")
        or "https://workers.floom.dev"
    ).rstrip("/")
    return f"{base}/settings?whatsapp_claim={urllib.parse.quote(token)}"


def _whatsapp_binding_user_id(wa_id: str) -> Optional[str]:
    from db import get_db, now_iso
    normalized = _normalize_whatsapp_wa_id(wa_id)
    if not normalized:
        return None
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT user_id
                FROM whatsapp_sender_bindings
                WHERE wa_id = ? AND status = 'active' AND user_id IS NOT NULL
                """,
                (normalized,),
            ).fetchone()
            if row and row["user_id"]:
                conn.execute(
                    "UPDATE whatsapp_sender_bindings SET last_seen_at = ?, updated_at = ? WHERE wa_id = ?",
                    (now_iso(), now_iso(), normalized),
                )
                return str(row["user_id"])
    except Exception:
        logger.exception("WhatsApp sender binding lookup failed")
    return None


def _whatsapp_create_claim(wa_id: str, profile_name: str = "") -> Dict[str, str]:
    import secrets as pysecrets
    from db import get_db, now_iso
    normalized = _normalize_whatsapp_wa_id(wa_id)
    if not normalized:
        raise ValueError("WhatsApp sender id missing")
    token = pysecrets.token_urlsafe(24)
    now_ts = now_iso()
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, claim_token,
                 claim_expires_at, created_at, updated_at, last_seen_at)
            VALUES (?, NULL, ?, 'pending', ?, ?, ?, ?, ?)
            ON CONFLICT(wa_id) DO UPDATE SET
                profile_name = excluded.profile_name,
                status = CASE
                    WHEN whatsapp_sender_bindings.status = 'active'
                    THEN whatsapp_sender_bindings.status
                    ELSE 'pending'
                END,
                claim_token = CASE
                    WHEN whatsapp_sender_bindings.status = 'active'
                    THEN whatsapp_sender_bindings.claim_token
                    ELSE excluded.claim_token
                END,
                claim_expires_at = CASE
                    WHEN whatsapp_sender_bindings.status = 'active'
                    THEN whatsapp_sender_bindings.claim_expires_at
                    ELSE excluded.claim_expires_at
                END,
                updated_at = excluded.updated_at,
                last_seen_at = excluded.last_seen_at
            """,
            (normalized, profile_name or None, token, expires_at, now_ts, now_ts, now_ts),
        )
        row = conn.execute(
            "SELECT claim_token, claim_expires_at, status FROM whatsapp_sender_bindings WHERE wa_id = ?",
            (normalized,),
        ).fetchone()
    claim_token = str(row["claim_token"] or token) if row else token
    return {
        "wa_id": normalized,
        "claim_token": claim_token,
        "claim_url": _whatsapp_claim_url(claim_token),
        "claim_expires_at": str(row["claim_expires_at"] if row else expires_at),
        "status": str(row["status"] if row else "pending"),
    }


# ---------------------------------------------------------------------------
# Claim route
# ---------------------------------------------------------------------------

class WhatsAppClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str


@whatsapp_router.post("/whatsapp/bindings/claim")
def claim_whatsapp_sender(
    payload: WhatsAppClaimRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    from db import get_db, now_iso
    token = (payload.token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="token is required")
    now_dt = datetime.now(timezone.utc)
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT wa_id, status, claim_expires_at
            FROM whatsapp_sender_bindings
            WHERE claim_token = ?
            """,
            (token,),
        ).fetchone()
        if not row or row["status"] == "active":
            raise HTTPException(status_code=404, detail="WhatsApp claim not found")
        try:
            expires = datetime.fromisoformat(str(row["claim_expires_at"]))
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
        except Exception:
            expires = now_dt - timedelta(seconds=1)
        if expires < now_dt:
            raise HTTPException(status_code=410, detail="WhatsApp claim expired")
        conn.execute(
            """
            UPDATE whatsapp_sender_bindings
            SET user_id = ?, status = 'active', updated_at = ?
            WHERE claim_token = ?
            """,
            (auth.user_id, now_iso(), token),
        )
    return {"ok": True, "wa_id": row["wa_id"], "user_id": auth.user_id}


# ---------------------------------------------------------------------------
# Signature verification
# ---------------------------------------------------------------------------

def _verify_whatsapp_signature(body: bytes, request: Request, app_secret: str) -> bool:
    """Verify Meta's X-Hub-Signature-256 header (sha256=HMAC(app_secret, raw_body)).

    Fails closed: a missing/malformed header or missing secret returns False.
    """
    if not app_secret:
        return False
    signature = request.headers.get("X-Hub-Signature-256", "")
    if not signature or not signature.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(app_secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


# ---------------------------------------------------------------------------
# Text chunking / send helpers
# ---------------------------------------------------------------------------

def _split_whatsapp_text(text: str) -> List[str]:
    """Chunk text to the 4096-char WhatsApp limit, preferring paragraph/sentence
    boundaries (ported from the staged whatsapp.ts reference)."""
    raw = (text or "").replace("\r\n", "\n").strip()
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    if not raw:
        return []
    if len(raw) <= WHATSAPP_TEXT_MAX:
        return [raw]

    chunks: List[str] = []
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", raw) if part.strip()]
    for paragraph in paragraphs:
        if len(paragraph) <= WHATSAPP_TEXT_MAX:
            chunks.append(paragraph)
            continue
        sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", paragraph) if part.strip()]
        current = ""
        for sentence in sentences:
            candidate = f"{current} {sentence}" if current else sentence
            if len(candidate) > WHATSAPP_TEXT_MAX and current:
                chunks.append(current)
                current = sentence
            elif len(candidate) > WHATSAPP_TEXT_MAX:
                # Single sentence longer than the limit: hard-split.
                index = 0
                while index < len(sentence):
                    chunks.append(sentence[index:index + WHATSAPP_TEXT_MAX])
                    index += WHATSAPP_TEXT_MAX
                current = ""
            else:
                current = candidate
        if current:
            chunks.append(current)
    return [chunk for chunk in chunks if chunk]


def _send_whatsapp_json(payload: Dict[str, Any]) -> None:
    phone_id = _whatsapp_phone_id()
    token = _whatsapp_token()
    if not phone_id or not token:
        raise RuntimeError("WhatsApp is not configured (WHATSAPP_PHONE_ID / WHATSAPP_TOKEN missing)")
    response = requests.post(
        f"https://graph.facebook.com/{_whatsapp_graph_version()}/{phone_id}/messages",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=15,
    )
    if not response.ok:
        try:
            body = response.json()
            error = str((body.get("error") or {}).get("message") or f"HTTP {response.status_code}")
        except Exception:
            error = f"HTTP {response.status_code}"
        raise RuntimeError(f"WhatsApp API error: {error}")


def send_whatsapp_text(to: str, text: str) -> None:
    """Send a text message via the Graph API, chunked to 4096 chars."""
    if not to:
        raise RuntimeError("WhatsApp recipient missing")
    chunks = _split_whatsapp_text(text)
    if not chunks:
        chunks = ["(No reply)"]
    for chunk in chunks:
        _send_whatsapp_json({
            "messaging_product": "whatsapp",
            "to": to,
            "type": "text",
            "text": {"body": chunk},
        })


def _send_whatsapp_typing_indicator(message_id: str) -> None:
    """Mark the inbound message read + show a typing indicator (best-effort)."""
    trimmed = (message_id or "").strip()
    if not trimmed:
        return
    _send_whatsapp_json({
        "messaging_product": "whatsapp",
        "status": "read",
        "message_id": trimmed,
        "typing_indicator": {"type": "text"},
    })


# ---------------------------------------------------------------------------
# Inbound payload parsing
# ---------------------------------------------------------------------------

def _parse_whatsapp_inbound(payload: Dict[str, Any]) -> List[Dict[str, str]]:
    """Normalize a Meta whatsapp_business_account webhook body into a flat list of
    text messages: [{wa_id, text, message_id, profile_name}]. Non-text messages
    and status callbacks are ignored gracefully."""
    if not isinstance(payload, dict):
        return []
    if str(payload.get("object") or "").strip().lower() != "whatsapp_business_account":
        return []

    events: List[Dict[str, str]] = []
    for entry in payload.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        for change in entry.get("changes") or []:
            if not isinstance(change, dict):
                continue
            if str(change.get("field") or "").strip().lower() != "messages":
                continue
            value = change.get("value") if isinstance(change.get("value"), dict) else {}

            profiles_by_wa_id: Dict[str, str] = {}
            for contact in value.get("contacts") or []:
                if not isinstance(contact, dict):
                    continue
                wa_id = re.sub(r"\D", "", str(contact.get("wa_id") or ""))
                name = str(((contact.get("profile") or {}) if isinstance(contact.get("profile"), dict) else {}).get("name") or "")
                if wa_id:
                    profiles_by_wa_id[wa_id] = name

            for message in value.get("messages") or []:
                if not isinstance(message, dict):
                    continue
                if str(message.get("type") or "").strip().lower() != "text":
                    # Non-text (image/audio/document/etc.) and status callbacks
                    # are ignored gracefully for this text-only assistant.
                    continue
                wa_id = re.sub(r"\D", "", str(message.get("from") or ""))
                message_id = str(message.get("id") or "").strip()
                text_body = str(((message.get("text") or {}) if isinstance(message.get("text"), dict) else {}).get("body") or "").strip()
                if not wa_id or not message_id or not text_body:
                    continue
                events.append({
                    "wa_id": wa_id,
                    "text": text_body,
                    "message_id": message_id,
                    "profile_name": profiles_by_wa_id.get(wa_id, ""),
                })
    return events


# ---------------------------------------------------------------------------
# Message handler (background task)
# ---------------------------------------------------------------------------

async def _handle_whatsapp_message(*, wa_id: str, text: str, message_id: str, profile_name: str = "") -> None:
    """Run the inbound text through the shared assistant pipeline and reply."""
    normalized_wa_id = _normalize_whatsapp_wa_id(wa_id)
    user_id = _whatsapp_binding_user_id(normalized_wa_id)
    if not user_id:
        try:
            claim = _whatsapp_create_claim(normalized_wa_id, profile_name)
            send_whatsapp_text(
                normalized_wa_id,
                (
                    "Link this WhatsApp number to your Workeros workspace before "
                    "I can access any workers, runs, brain packs, or connections.\n\n"
                    f"{claim['claim_url']}\n\n"
                    "This link expires in 24 hours."
                ),
            )
        except Exception:
            logger.exception("WhatsApp unbound sender claim prompt failed")
        return
    conversation_id = f"whatsapp:{normalized_wa_id}"
    try:
        try:
            _send_whatsapp_typing_indicator(message_id)
        except Exception:
            logger.exception("WhatsApp typing indicator failed")
        reply = await collect_agent_reply(
            message=text,
            user_id=user_id,
            conversation_id=conversation_id,
            source="whatsapp",
        )
        send_whatsapp_text(normalized_wa_id, reply)
    except Exception:
        logger.exception("WhatsApp message processing failed")
        if os.environ.get("WHATSAPP_POST_ERRORS_TO_CHAT", "1").strip().lower() not in {"0", "false", "no", "off"}:
            try:
                send_whatsapp_text(
                    normalized_wa_id,
                    "I could not complete that request. The failure was logged for the workspace operator.",
                )
            except Exception:
                logger.exception("WhatsApp error reply failed")


# ---------------------------------------------------------------------------
# Webhook routes
# ---------------------------------------------------------------------------

@whatsapp_router.get("/whatsapp/webhook")
async def whatsapp_webhook_verify(request: Request) -> Response:
    """Answer Meta's one-time webhook verification challenge.

    Returns hub.challenge as plain text (200) only when hub.mode == subscribe
    and hub.verify_token matches WHATSAPP_WEBHOOK_VERIFY_TOKEN. Fails closed
    (403) otherwise, including when no verify token is configured.
    """
    if not _whatsapp_enabled():
        raise HTTPException(status_code=503, detail="WhatsApp integration is disabled")
    mode = request.query_params.get("hub.mode", "")
    token = request.query_params.get("hub.verify_token", "")
    challenge = request.query_params.get("hub.challenge", "")
    expected = _whatsapp_webhook_verify_token()
    if mode == "subscribe" and expected and token and hmac.compare_digest(token, expected):
        return PlainTextResponse(challenge, media_type="text/plain")
    raise HTTPException(status_code=403, detail="WhatsApp webhook verification failed")


@whatsapp_router.post("/whatsapp/webhook")
async def whatsapp_webhook(request: Request, background_tasks: BackgroundTasks) -> Response:
    """Receive Meta WhatsApp Cloud API inbound message callbacks.

    Verifies the X-Hub-Signature-256 HMAC against the raw body, dedups Meta
    retries, ACKs 200 fast, and forwards each text message to the shared
    assistant pipeline in a background task. Inert when WhatsApp env vars are
    absent (503), so an unconfigured deploy cannot break.
    """
    if not _whatsapp_enabled():
        raise HTTPException(status_code=503, detail="WhatsApp integration is disabled")

    body = await request.body()
    # Payload size cap: reject oversized bodies before any HMAC work.
    if len(body) > _MAX_WEBHOOK_BODY_BYTES:
        raise HTTPException(status_code=413, detail="WhatsApp webhook payload too large")

    app_secret = _whatsapp_app_secret()
    if not app_secret or not _whatsapp_configured():
        # No credentials yet: accept nothing, do nothing, but do not 500. Fail
        # closed on signature (can't verify) while keeping the app healthy.
        raise HTTPException(status_code=503, detail="WhatsApp integration is not configured")

    if not _verify_whatsapp_signature(body, request, app_secret):
        raise HTTPException(status_code=401, detail="Invalid WhatsApp signature")

    try:
        payload: Dict[str, Any] = json.loads(body.decode("utf-8") or "{}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid WhatsApp JSON payload") from exc

    events = _parse_whatsapp_inbound(payload)
    if not events:
        # Status callbacks, non-text messages, or empty envelopes: ACK and ignore.
        return JSONResponse({"ok": True, "ignored": True})

    from main import _claim_webhook_delivery
    queued = 0
    for event in events:
        message_id = event["message_id"]
        # Dedup on Meta's stable message id (Meta retries on timeout).
        if message_id and not _claim_webhook_delivery("whatsapp:messages", message_id):
            continue
        background_tasks.add_task(
            _handle_whatsapp_message,
            wa_id=event["wa_id"],
            text=event["text"],
            message_id=message_id,
            profile_name=event.get("profile_name") or "",
        )
        queued += 1

    return JSONResponse({"ok": True, "queued": queued})
