"""WhatsApp (Meta WhatsApp Business Cloud API) channel — routes and helpers.

All route paths are identical to those previously defined directly on the
``app`` FastAPI instance in main.py.  The router is included in main.py via
``app.include_router(whatsapp_router)``.

Lazy imports are used for anything from main.py to avoid circular imports.

## Approval reply grammar (Phase 4)

When a bound sender has one or more pending approvals, the handler intercepts
messages that match:

    (yes|approve)[ <suffix>]   — approve
    (no|reject)[ <suffix>]     — reject

Detection is conservative: the keyword must appear at the very START of the
message (after stripping whitespace), and interception only occurs when the
sender has at least one pending approval.  A message like "yes please do X"
is intercepted only if it starts with the exact keyword "yes" followed by
nothing or a short hex suffix.

When ``<suffix>`` is given it identifies the approval by the last 6 chars of
the approval_id (``approval_id[-6:]``).  When omitted:
  - exactly 1 pending: that one is resolved.
  - more than 1 pending: a disambiguation reply lists all pending approvals
    with their suffixes and leaves all unchanged.
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
from typing import Any, Dict, List, Optional, Protocol, Tuple

import requests
from fastapi import BackgroundTasks, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.routing import APIRouter
from pydantic import BaseModel, ConfigDict

from auth import AuthContext, get_auth_context
from channels.common import (
    _MAX_WEBHOOK_BODY_BYTES,
    MAX_EVENTS_PER_DELIVERY,
    MAX_INBOUND_TEXT_CHARS,
    collect_agent_reply,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

whatsapp_router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WHATSAPP_TEXT_MAX = 4096

# Workspace ID used when no workspace is pinned on a binding (backwards compat).
_DEFAULT_WORKSPACE_ID = "local-default"


# ---------------------------------------------------------------------------
# Binding-persistence seam (#1007)
# ---------------------------------------------------------------------------
#
# The engine persists WhatsApp sender bindings in the local SQLite
# ``whatsapp_sender_bindings`` table.  A multi-tenant host (workeros-cloud)
# needs them in Postgres/Supabase instead.  Rather than have the host
# monkeypatch the private ``_whatsapp_*`` functions via ``setattr`` (fragile,
# and bypassed entirely for callers that imported the symbol at module load —
# e.g. main.py:_whatsapp_create_claim), the engine exposes a first-class
# registration seam mirroring ``set_worker_call_secret_resolver`` and
# ``set_context_scope_resolver``.
#
# The host registers a store ONCE at startup; the binding read/claim/reset
# helpers delegate to it at CALL time.  Because resolution happens per call
# (not at import), a caller holding a direct reference to the engine function
# still gets the host implementation — which is exactly what the old
# setattr-rebind could not guarantee.


class WhatsAppBindingStore(Protocol):
    """Host-pluggable persistence for WhatsApp sender bindings (#1007).

    workeros-cloud registers a Supabase-backed implementation at startup via
    :func:`set_whatsapp_binding_store`; OSS leaves it unset and the engine uses
    its local SQLite ``whatsapp_sender_bindings`` table.  The method contracts
    mirror the engine's own ``_whatsapp_binding_info`` / ``_whatsapp_create_claim``
    / ``_reset_binding_to_pending`` exactly so the two are drop-in equivalent.
    """

    def binding_info(self, wa_id: str) -> Optional[Tuple[str, str]]:
        """Return ``(user_id, workspace_id)`` for an active binding, else None."""
        ...

    def create_claim(self, wa_id: str, profile_name: str = "") -> Dict[str, str]:
        """Create/refresh a pending claim; return the claim dict.

        Same shape as :func:`_whatsapp_create_claim`:
        ``{wa_id, claim_token, claim_url, claim_expires_at, status}``.
        """
        ...

    def reset_to_pending(self, wa_id: str) -> Optional[str]:
        """Flip an active binding back to pending; return a fresh claim_url or None."""
        ...


_whatsapp_binding_store: Optional[WhatsAppBindingStore] = None


def set_whatsapp_binding_store(store: Optional[WhatsAppBindingStore]) -> None:
    """Register a host binding store, or ``None`` to use the local SQLite store.

    Called once at startup by a downstream host (e.g. workeros-cloud) so binding
    reads/claims/resets are persisted in its own multi-tenant store.  This is the
    supported replacement for monkeypatching the private ``_whatsapp_*`` helpers
    (#1007); pass ``None`` to clear (OSS mode).
    """
    global _whatsapp_binding_store
    _whatsapp_binding_store = store


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
        or "http://localhost:3000"
    ).rstrip("/")
    return f"{base}/settings?whatsapp_claim={urllib.parse.quote(token)}"


def _public_api_base_url() -> str:
    """Public base URL of THIS API host — the host that actually serves /c/{token}.

    The /c/ short-link redirect route lives on the FastAPI app (served at the
    API base URL), NOT on the Next.js web app (the frontend base URL).
    Building the short link on the frontend base produced a dead link that
    404'd / bounced to /login.  Mirrors main._public_api_base_url and
    channels.slack._public_api_base_url.
    """
    return (
        os.environ.get("WORKEROS_PUBLIC_API_URL")
        or os.environ.get("WORKEROS_API_URL")
        or os.environ.get("WORKERS_API_URL")
        or "http://localhost:8000"
    ).rstrip("/")


def _whatsapp_short_claim_url(token: str) -> str:
    """Return the short /c/{token} redirect URL for use in outbound messages.

    Built on the API public base because that host serves the /c/ route and
    302s cross-domain to the frontend /settings?whatsapp_claim= URL.
    """
    base = _public_api_base_url()
    return f"{base}/c/{urllib.parse.quote(token)}"


def _whatsapp_binding_info(wa_id: str) -> Optional[Tuple[str, str]]:
    """Return (user_id, workspace_id) for an active binding, or None.

    Updates last_seen_at as a side-effect.  workspace_id falls back to
    'local-default' when the column is NULL (pre-migration 65 rows).
    """
    if _whatsapp_binding_store is not None:
        try:
            return _whatsapp_binding_store.binding_info(wa_id)
        except Exception:
            logger.exception("WhatsApp binding store .binding_info failed")
            return None
    from db import get_db, now_iso
    normalized = _normalize_whatsapp_wa_id(wa_id)
    if not normalized:
        return None
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT user_id, workspace_id
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
                workspace_id = str(row["workspace_id"] or _DEFAULT_WORKSPACE_ID)
                return str(row["user_id"]), workspace_id
    except Exception:
        logger.exception("WhatsApp sender binding lookup failed")
    return None


def _whatsapp_binding_user_id(wa_id: str) -> Optional[str]:
    """Backwards-compat shim — returns user_id only (pre-workspace-pinning callers)."""
    info = _whatsapp_binding_info(wa_id)
    return info[0] if info else None


def _whatsapp_create_claim(wa_id: str, profile_name: str = "") -> Dict[str, str]:
    """Create (or refresh) a pending claim for the given wa_id.

    Hardening (from design review):
    - Any prior *pending* claim tokens for this wa_id are invalidated by
      generating a new token.  An existing *active* binding is left intact
      (the sender is already bound; the claim prompt should not have been sent).
    """
    if _whatsapp_binding_store is not None:
        return _whatsapp_binding_store.create_claim(wa_id, profile_name)
    import secrets as pysecrets
    from db import get_db, now_iso
    normalized = _normalize_whatsapp_wa_id(wa_id)
    if not normalized:
        raise ValueError("WhatsApp sender id missing")
    token = pysecrets.token_urlsafe(12)  # 96-bit, 16 urlsafe chars
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
                -- Always replace a pending token so the old one is invalidated.
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
# Binding reset helper (used when pinned workspace no longer exists)
# ---------------------------------------------------------------------------

def _reset_binding_to_pending(wa_id: str) -> Optional[str]:
    """Flip an active binding back to pending and generate a fresh claim token.

    Returns the new claim_url so the caller can send it to the sender.
    Called at message-time when the pinned workspace no longer exists.
    """
    if _whatsapp_binding_store is not None:
        try:
            return _whatsapp_binding_store.reset_to_pending(wa_id)
        except Exception:
            logger.exception("WhatsApp binding store .reset_to_pending failed")
            return None
    import secrets as pysecrets
    from db import get_db, now_iso
    normalized = _normalize_whatsapp_wa_id(wa_id)
    if not normalized:
        return None
    token = pysecrets.token_urlsafe(12)  # 96-bit, 16 urlsafe chars
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
    now_ts = now_iso()
    try:
        with get_db() as conn:
            conn.execute(
                """
                UPDATE whatsapp_sender_bindings
                SET status = 'pending',
                    user_id = NULL,
                    workspace_id = NULL,
                    claim_token = ?,
                    claim_expires_at = ?,
                    updated_at = ?
                WHERE wa_id = ?
                """,
                (token, expires_at, now_ts, normalized),
            )
        return _whatsapp_claim_url(token)
    except Exception:
        logger.exception("WhatsApp binding reset to pending failed")
        return None


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
    """Consume a claim token and bind the wa_id to the authenticated user.

    Hardening (design review):
    - Token is single-use: cleared immediately after successful claim.
    - Workspace is pinned to the claiming user's currently-active workspace
      (engine: resolved via local_workspace_user_id; default 'local-default').
    - Re-claim of an already-active binding: the old bound user receives a
      WhatsApp notification, then the binding is transferred.
    """
    from db import get_db, now_iso
    from auth.local_workspaces import (
        local_workspace_base_user_id,
        local_workspace_user_id,
        DEFAULT_WORKSPACE_ID,
    )
    token = (payload.token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="token is required")
    now_dt = datetime.now(timezone.utc)

    # Resolve the workspace being claimed.
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local":
        # In local mode, the auth context user_id may already be workspace-scoped
        # (e.g. "federico__ws_abc123").  We pin the workspace embedded in it, or
        # fall back to local-default.
        base_user_id = local_workspace_base_user_id(auth.user_id)
        # Extract the workspace segment from the scoped user_id.
        import re as _re
        _ws_re = _re.compile(r"__(?P<ws>(?:local-default|ws_[a-f0-9]{14}))$")
        m = _ws_re.search(auth.user_id)
        workspace_id = m.group("ws") if m else DEFAULT_WORKSPACE_ID
        # Store the fully scoped user_id (base__workspace) as user_id in the binding
        # so downstream consumers that use local_workspace_user_id round-trip correctly.
        scoped_user_id = local_workspace_user_id(base_user_id, workspace_id)
    else:
        # Cloud: workspace is carried in the cloud's own auth context and
        # resolved by the cloud repository. #865: persist NULL instead of a
        # fabricated 'local-default' that downstream code then ignores.
        scoped_user_id = auth.user_id
        workspace_id = None

    with get_db() as conn:
        row = conn.execute(
            """
            SELECT wa_id, status, claim_expires_at, user_id AS old_user_id
            FROM whatsapp_sender_bindings
            WHERE claim_token = ?
            """,
            (token,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="WhatsApp claim not found")
        # Single-use: a token that was already cleared (status == active but token
        # still in DB on conflict — we check status to distinguish).
        # Actually: active rows keep their claim_token; we gate on token being present
        # and not already consumed.  "consumed" = status was set to active by a PRIOR
        # claim call, which also clears the token (see UPDATE below).
        # The check below prevents reuse after a successful claim.
        # NOTE: an active row with a DIFFERENT claim_token would not match here at all
        # (WHERE clause), so this only fires when the exact same token is re-submitted.
        if row["status"] == "active":
            raise HTTPException(status_code=404, detail="WhatsApp claim not found")
        try:
            expires = datetime.fromisoformat(str(row["claim_expires_at"]))
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
        except Exception:
            expires = now_dt - timedelta(seconds=1)
        if expires < now_dt:
            raise HTTPException(status_code=410, detail="WhatsApp claim expired")

        old_user_id = row["old_user_id"]
        wa_id = row["wa_id"]

        # Bind and clear the token (single-use).
        conn.execute(
            """
            UPDATE whatsapp_sender_bindings
            SET user_id = ?,
                workspace_id = ?,
                status = 'active',
                claim_token = NULL,
                claim_expires_at = NULL,
                updated_at = ?
            WHERE claim_token = ?
            """,
            (scoped_user_id, workspace_id, now_iso(), token),
        )

    # Notify previous owner if a different user has re-claimed an active binding.
    if old_user_id and old_user_id != scoped_user_id:
        try:
            send_whatsapp_text(
                wa_id,
                "Heads up: this number was just linked to a different account. If that wasn't you, go to Settings and re-link it.",
            )
        except Exception:
            logger.warning(
                "WhatsApp rebind notify to old user %s failed", old_user_id, exc_info=True
            )

    # Welcome the newly bound sender from Emily (best-effort; never block the claim).
    # Chief-of-staff persona, WhatsApp dialect: warm, concise, single *asterisk*
    # emphasis only, no markdown headers/links.
    # #1369 — include 3 concrete example commands so users know what to ask.
    try:
        send_whatsapp_text(
            wa_id,
            "Hi, it's *Emily*, your chief of staff. We're connected.\n"
            "Tell me what you want handled and I'll take it from here.\n\n"
            "Try:\n"
            "- _run my daily digest_\n"
            "- _what ran today?_\n"
            "- _approve the pending run_",
        )
    except Exception:
        logger.warning(
            "WhatsApp welcome send to %s failed", wa_id, exc_info=True
        )

    return {
        "ok": True,
        "wa_id": wa_id,
        "user_id": scoped_user_id,
        "workspace_id": workspace_id,
    }


# ---------------------------------------------------------------------------
# My WhatsApp binding — status + unlink
# ---------------------------------------------------------------------------

@whatsapp_router.get("/whatsapp/bindings/me")
def get_whatsapp_binding_me(auth: AuthContext = Depends(get_auth_context)) -> Dict[str, Any]:
    """Return the caller's active WhatsApp sender binding, if any.

    Returns:
        { "linked": true, "wa_id_masked": "***9709", "workspace_id": ...,
          "profile_name": ..., "linked_at": ..., "last_seen_at": ... }
        or
        { "linked": false }
    """
    from db import get_db
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT wa_id, profile_name, workspace_id, updated_at, last_seen_at
            FROM whatsapp_sender_bindings
            WHERE user_id = ? AND status = 'active'
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (auth.user_id,),
        ).fetchone()
    if not row:
        return {"linked": False}
    wa_id = str(row["wa_id"] or "")
    masked = ("*" * max(0, len(wa_id) - 4) + wa_id[-4:]) if len(wa_id) > 4 else wa_id
    workspace_id = row["workspace_id"] or _DEFAULT_WORKSPACE_ID
    return {
        "linked": True,
        "wa_id_masked": masked,
        "workspace_id": workspace_id,
        "profile_name": row["profile_name"] or None,
        "linked_at": row["updated_at"],
        "last_seen_at": row["last_seen_at"] or None,
    }


@whatsapp_router.get("/whatsapp/status")
def whatsapp_status(auth: AuthContext = Depends(get_auth_context)) -> Dict[str, Any]:
    """#801: connection-status shape for Settings > Channels.

    Returns { connected: bool, wa_id?: str, status?: "active"|"pending" } for
    the authenticated user, derived from whatsapp_sender_bindings. Distinct
    from /whatsapp/bindings/me (which returns a richer, masked binding object).
    """
    from db import get_db
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT wa_id, status
            FROM whatsapp_sender_bindings
            WHERE user_id = ?
            ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC
            LIMIT 1
            """,
            (auth.user_id,),
        ).fetchone()
    if not row:
        return {"connected": False}
    status = str(row["status"] or "")
    wa_id = str(row["wa_id"] or "")
    masked = ("*" * max(0, len(wa_id) - 4) + wa_id[-4:]) if len(wa_id) > 4 else wa_id
    return {
        "connected": status == "active",
        "wa_id": masked or None,
        "status": status or None,
    }


@whatsapp_router.delete("/whatsapp/bindings/me")
def delete_whatsapp_binding_me(auth: AuthContext = Depends(get_auth_context)) -> Dict[str, Any]:
    """Unlink the caller's active WhatsApp sender binding.

    Returns the number of rows unlinked.  Safe to call when not linked.
    """
    from db import get_db, now_iso
    with get_db() as conn:
        result = conn.execute(
            """
            UPDATE whatsapp_sender_bindings
            SET user_id = NULL, status = 'unlinked', workspace_id = NULL, updated_at = ?
            WHERE user_id = ? AND status = 'active'
            """,
            (now_iso(), auth.user_id),
        )
        unlinked = result.rowcount
    return {"ok": True, "unlinked": unlinked}


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
# Approval helpers (WhatsApp reply-to-approve, Phase 4)
# ---------------------------------------------------------------------------

# Regex: optional whitespace, keyword, optional whitespace + 4-8 hex chars suffix.
# Anchored to start-of-string only; full-match check in the caller.
_APPROVAL_KEYWORD_RE = re.compile(
    r"^(?P<keyword>yes|approve|no|reject)\s*(?P<suffix>[0-9a-f]{4,8})?$",
    re.IGNORECASE,
)

# #891: natural affirmation / negation phrasings accepted ONLY when the bound
# sender has EXACTLY ONE pending approval (the unambiguous case). These are
# deliberately matched against the WHOLE trimmed message (after stripping a
# trailing approval-id suffix) so "yes, approve it", "go ahead", "do it",
# "cancel it" route to the single pending approval instead of falling through
# to the agent (which could then only show a link — the #891 P0). When NOTHING
# is pending, NONE of this runs (the caller short-circuits), so a conversational
# "yes" is never eaten.
_NATURAL_AFFIRM_RE = re.compile(
    r"^(?:yes|yep|yeah|yup|ok|okay|sure|approve(?:d|s)?|approve\s+it|"
    r"go\s+ahead|do\s+it|run\s+it|confirm(?:ed)?|sounds\s+good|"
    r"please\s+do|proceed|accept(?:ed)?)\b.*$",
    re.IGNORECASE,
)
_NATURAL_NEGATE_RE = re.compile(
    r"^(?:no|nope|nah|reject(?:ed|s)?|reject\s+it|decline(?:d)?|"
    r"cancel(?:\s+it)?|don'?t(?:\s+run\s+it)?|do\s+not|stop|abort|"
    r"deny|denied)\b.*$",
    re.IGNORECASE,
)

# Trailing approval-id suffix (4-8 hex) the sender may append to target one of
# several pending approvals, e.g. "yes approve it a1b2c3".
_TRAILING_SUFFIX_RE = re.compile(r"\b(?P<suffix>[0-9a-f]{4,8})\s*$", re.IGNORECASE)


def _parse_approval_reply(text: str, *, single_pending: bool = False) -> Optional[Dict[str, Any]]:
    """Return {decision: 'approved'|'rejected', suffix: str|None} or None.

    Two acceptance modes:

    - Strict (always): the entire trimmed message is a bare keyword
      (yes/approve/no/reject) optionally followed by a hex suffix. Conservative
      so normal sentences starting with 'yes' are never eaten — this is what
      runs when multiple approvals are pending or none are.

    - Natural (``single_pending=True`` only, #891): when the sender has EXACTLY
      ONE pending approval, accept natural affirmations ("yes, approve it",
      "go ahead", "do it") and negations ("no", "reject it", "cancel it"). Still
      conservative: only enabled by the caller when a single approval is pending.
    """
    stripped = (text or "").strip()
    if not stripped:
        return None

    # Strict path first — preserves the existing suffix-targeting behaviour.
    m = _APPROVAL_KEYWORD_RE.fullmatch(stripped)
    if m:
        keyword = m.group("keyword").lower()
        suffix = (m.group("suffix") or "").lower() or None
        decision = "approved" if keyword in ("yes", "approve") else "rejected"
        return {"decision": decision, "suffix": suffix}

    if not single_pending:
        return None

    # Natural path (single pending only). Pull off a trailing id-suffix if the
    # user added one, then classify the affirmation/negation.
    suffix = None
    suffix_match = _TRAILING_SUFFIX_RE.search(stripped)
    body = stripped
    if suffix_match:
        suffix = suffix_match.group("suffix").lower()
        body = stripped[: suffix_match.start()].strip()
    # Negation is checked first so "do not" / "don't run it" never read as the
    # affirmative "do it".
    if _NATURAL_NEGATE_RE.match(body):
        return {"decision": "rejected", "suffix": suffix}
    if _NATURAL_AFFIRM_RE.match(body):
        return {"decision": "approved", "suffix": suffix}
    return None


def _approval_kind(target: Any) -> str:
    """Best-effort kind of an approval row ('agent_tool'/'destructive_delete'/'')."""
    import json as _json
    try:
        di = _json.loads((target or {}).get("decision_input_json") or "{}") or {}
        return str(di.get("kind") or "")
    except Exception:
        return ""


def _approve_pending_run_for_whatsapp(
    *, run_id: str, user_id: str, repos: Any, approval_id: str = "", kind: str = ""
) -> Any:
    """Approve a pending approval as the bound WhatsApp user.

    Reuses the SAME canonical decision functions as Slack / the chat tools /
    the public-link path so the decision, follow-up run, and SSE broadcast go
    through a single code path. Kind-aware (#891): an ``agent_tool`` approval is
    resumed in-place via approve_agent_tool_approval rather than approve_run
    (which only handles run-level approvals and rejects agent-tool ones).
    """
    from auth import AuthContext
    auth = AuthContext(user_id=user_id, email=None, scopes=("whatsapp",))
    if kind == "agent_tool" and approval_id:
        from main import approve_agent_tool_approval, ApproveRequest
        return approve_agent_tool_approval(approval_id, ApproveRequest(), auth, repos)
    if kind == "destructive_delete" and approval_id:
        from main import approve_destructive_action
        return approve_destructive_action(approval_id, auth, repos)
    from main import approve_run, ApproveRequest
    return approve_run(run_id, ApproveRequest(), auth, repos)


def _reject_pending_run_for_whatsapp(
    *, run_id: str, user_id: str, repos: Any, reason: str, approval_id: str = "", kind: str = ""
) -> Any:
    """Reject a pending approval as the bound WhatsApp user (kind-aware, #891)."""
    from auth import AuthContext
    from main import RejectRequest
    auth = AuthContext(user_id=user_id, email=None, scopes=("whatsapp",))
    if kind == "agent_tool" and approval_id:
        from main import reject_agent_tool_approval
        return reject_agent_tool_approval(approval_id, RejectRequest(reason=reason), auth, repos)
    if kind == "destructive_delete" and approval_id:
        from main import reject_destructive_action
        return reject_destructive_action(approval_id, RejectRequest(reason=reason), auth, repos)
    from main import reject_run
    return reject_run(run_id, RejectRequest(reason=reason), auth, repos)


async def _maybe_handle_approval_reply(
    *,
    wa_id: str,
    text: str,
    scoped_user_id: str,
) -> Optional[str]:
    """Detect and process an approval reply from a bound sender.

    Returns a reply text to send back if the message was an approval command,
    or None if it was not (caller should proceed to the normal agent pipeline).

    Safety rules:
    - Only intercept when the sender has >= 1 pending approval (conservative).
    - Owner must be the bound user (scoped_user_id) — enforced by the canonical
      approve/reject path which checks run visibility + ownership.
    - Ambiguous (multiple pending, no suffix) → list pending approvals with
      their id-suffixes; do NOT approve anything.
    - Already-resolved or not-found approval → graceful "no longer pending" reply.
    """
    # #891: a fast strict parse decides whether this even LOOKS like an approval
    # command without touching the DB. Only when it doesn't strictly match do we
    # load pending approvals to see if the single-pending natural-language path
    # applies (e.g. "yes, approve it"). This keeps the no-pending common case
    # cheap and guarantees a conversational 'yes' is never intercepted unless an
    # approval is actually pending.
    strict = _parse_approval_reply(text)

    try:
        from db import get_repositories
        repos = get_repositories()
        pending = repos.approvals.list_pending(owner_id=scoped_user_id)
    except Exception:
        logger.exception("WhatsApp approval reply: could not load pending approvals")
        return None

    if not pending:
        # No pending approvals for this user — do NOT intercept; pass to agent.
        # This is the guard that prevents eating a conversational 'yes'.
        return None

    parsed = strict
    if parsed is None:
        # Strict parse failed. Accept natural affirmations/negations ONLY when
        # exactly one approval is pending (the unambiguous case).
        if len(pending) == 1:
            parsed = _parse_approval_reply(text, single_pending=True)
    if parsed is None:
        # Not an approval command — fall through to the agent.
        return None

    decision = parsed["decision"]
    suffix = parsed["suffix"]

    # Resolve which approval row to act on.
    target: Optional[Dict[str, Any]] = None
    if suffix:
        # Match by last-N chars of approval_id (case-insensitive hex).
        for row in pending:
            approval_id = str(row.get("id") or "")
            if approval_id.lower().endswith(suffix):
                target = row
                break
        if target is None:
            # Suffix given but didn't match any pending approval.
            lines = [
                f"• {str(row.get('worker_name') or row.get('worker_id') or 'Worker')}: "
                f"{str(row.get('label') or 'Approval requested')} "
                f"[...{str(row.get('id') or '')[-6:]}]"
                for row in pending
            ]
            return (
                f"No pending approval matches that ID. Pending ({len(pending)}):\n"
                + "\n".join(lines)
                + "\n\nReply *yes <id>* or *no <id>* to decide."
            )
    elif len(pending) == 1:
        target = pending[0]
    else:
        # Multiple pending, no suffix → list them and ask for disambiguation.
        lines = [
            f"• {str(row.get('worker_name') or row.get('worker_id') or 'Worker')}: "
            f"{str(row.get('label') or 'Approval requested')} "
            f"[...{str(row.get('id') or '')[-6:]}]"
            for row in pending
        ]
        return (
            f"You have {len(pending)} pending approvals:\n"
            + "\n".join(lines)
            + "\n\nReply *yes <id>* or *no <id>* to decide, "
            + "e.g. *yes " + str(pending[0].get("id") or "")[-6:] + "*"
        )

    run_id = str(target.get("run_id") or "")
    approval_id = str(target.get("id") or "")
    kind = _approval_kind(target)
    worker_name = str(target.get("worker_name") or target.get("worker_id") or "Worker")
    label = str(target.get("label") or "Approval requested")

    try:
        if decision == "approved":
            result = _approve_pending_run_for_whatsapp(
                run_id=run_id, user_id=scoped_user_id, repos=repos,
                approval_id=approval_id, kind=kind,
            )
            follow_up = getattr(result, "run_id", None) or (result.get("run_id") if isinstance(result, dict) else None)
            # Only a run-level approval spawns a NEW follow-up run; for agent-tool
            # approvals the returned run_id is the same in-place run, so don't
            # mislabel it as a follow-up.
            suffix_info = (
                f" Follow-up run: `{follow_up}`."
                if follow_up and kind not in ("agent_tool", "destructive_delete")
                else ""
            )
            return f"Approved *{worker_name}* — {label}.{suffix_info}"
        else:
            _reject_pending_run_for_whatsapp(
                run_id=run_id,
                user_id=scoped_user_id,
                repos=repos,
                reason=f"Rejected via WhatsApp by {wa_id}",
                approval_id=approval_id,
                kind=kind,
            )
            return f"Rejected *{worker_name}* — {label}."
    except Exception as exc:
        detail = getattr(exc, "detail", None) or str(exc)
        if "not awaiting approval" in str(detail).lower() or "already decided" in str(detail).lower():
            return f"That approval is no longer pending (already resolved: {worker_name} — {label})."
        if "not found" in str(detail).lower():
            return "That approval is no longer pending."
        logger.exception(
            "WhatsApp approval reply: %s failed for run %s user %s",
            decision,
            run_id,
            scoped_user_id,
        )
        return f"Could not process approval: {detail}"


# ---------------------------------------------------------------------------
# Inbound payload parsing
# ---------------------------------------------------------------------------

def _parse_whatsapp_inbound(payload: Dict[str, Any]) -> List[Dict[str, str]]:
    """Normalize a Meta whatsapp_business_account webhook body into a flat list of
    text messages: [{wa_id, text, message_id, profile_name, too_long}]. Non-text
    messages and status callbacks are ignored gracefully.

    Security / abuse hardening:

    - Codex finding #5 (phone-id check): the Meta signature only proves the
      payload came from the Meta app, not that it targets *our* number.  A
      callback for a DIFFERENT phone number under the same Meta app would
      otherwise enter this workspace.  Each ``change`` carries
      ``value.metadata.phone_number_id``; when it is present and does NOT match
      the configured ``WHATSAPP_PHONE_ID`` the whole change entry is dropped
      (log + skip).  (Absent metadata is tolerated for legacy/test payloads;
      real Meta deliveries always include it, so a foreign number always
      mismatches and is dropped.)

    - Codex finding #8 (caps): at most ``MAX_EVENTS_PER_DELIVERY`` message
      events are returned per webhook delivery; the rest are skipped with a log.
      Messages whose text exceeds ``MAX_INBOUND_TEXT_CHARS`` are returned with
      ``too_long=True`` (and truncated text) so the caller can answer with a
      friendly "message too long" reply instead of spawning agent work.
    """
    if not isinstance(payload, dict):
        return []
    if str(payload.get("object") or "").strip().lower() != "whatsapp_business_account":
        return []

    configured_phone_id = _whatsapp_phone_id()

    events: List[Dict[str, str]] = []
    skipped_for_cap = 0
    for entry in payload.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        for change in entry.get("changes") or []:
            if not isinstance(change, dict):
                continue
            if str(change.get("field") or "").strip().lower() != "messages":
                continue
            value = change.get("value") if isinstance(change.get("value"), dict) else {}

            # Finding #5: validate this change targets our configured number.
            metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
            inbound_phone_id = str(metadata.get("phone_number_id") or "").strip()
            if configured_phone_id and inbound_phone_id and inbound_phone_id != configured_phone_id:
                logger.warning(
                    "WhatsApp webhook: dropping change for foreign phone_number_id "
                    "%r (configured %r)",
                    inbound_phone_id,
                    configured_phone_id,
                )
                continue

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

                # Finding #8: per-payload event cap.
                if len(events) >= MAX_EVENTS_PER_DELIVERY:
                    skipped_for_cap += 1
                    continue

                # Finding #8: per-message text length cap.  Keep the event but
                # flag it so the caller answers "too long" without an agent run.
                too_long = len(text_body) > MAX_INBOUND_TEXT_CHARS
                events.append({
                    "wa_id": wa_id,
                    "text": text_body[:MAX_INBOUND_TEXT_CHARS] if too_long else text_body,
                    "message_id": message_id,
                    "profile_name": profiles_by_wa_id.get(wa_id, ""),
                    "too_long": too_long,
                })

    if skipped_for_cap:
        logger.warning(
            "WhatsApp webhook: capped at %d events; skipped %d additional message event(s)",
            MAX_EVENTS_PER_DELIVERY,
            skipped_for_cap,
        )
    return events


# ---------------------------------------------------------------------------
# Message handler (background task)
# ---------------------------------------------------------------------------

async def _handle_whatsapp_message(*, wa_id: str, text: str, message_id: str, profile_name: str = "") -> None:
    """Run the inbound text through the shared assistant pipeline and reply.

    Workspace-scoping (Phase 3):
    1. Look up (user_id, workspace_id) from the active binding.
    2. Validate the bound user still exists in the DB (hardening).
    3. Validate the pinned workspace still exists.  If not: reset binding to
       pending and send a fresh claim link.
    4. Compute the scoped user_id via local_workspace_user_id and run the agent
       under that identity so all resource lookups are workspace-scoped.
    """
    normalized_wa_id = _normalize_whatsapp_wa_id(wa_id)
    binding = _whatsapp_binding_info(normalized_wa_id)
    if not binding:
        try:
            claim = _whatsapp_create_claim(normalized_wa_id, profile_name)
            short_url = _whatsapp_short_claim_url(claim["claim_token"])
            send_whatsapp_text(
                normalized_wa_id,
                (
                    f"Hi! I'm Emily. Link this number to your Workeros account and we're good to go: "
                    f"{short_url} (valid 24h)"
                ),
            )
        except Exception:
            logger.exception("WhatsApp unbound sender claim prompt failed")
        return

    base_user_id, workspace_id = binding

    # Validate the bound user still exists (hardening: user deleted after bind).
    # bound_user_is_valid() treats the bootstrap/legacy owner id as always-valid
    # so a "federico" binding on a non-empty users table is never wrongly reset.
    try:
        deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
        if deploy == "local":
            from auth.local_workspaces import local_workspace_base_user_id
            from channels.common import bound_user_is_valid
            base_only = local_workspace_base_user_id(base_user_id)
            if not bound_user_is_valid(base_only):
                logger.warning(
                    "WhatsApp binding user %s no longer exists; resetting binding for %s",
                    base_user_id, normalized_wa_id,
                )
                claim_url = _reset_binding_to_pending(normalized_wa_id)
                if claim_url:
                    try:
                        # claim_url is the full /settings URL; derive the short URL from it.
                        # Reconstruct the token from the full URL.
                        _claim_token_stale = claim_url.split("whatsapp_claim=")[-1] if "whatsapp_claim=" in claim_url else ""
                        _short = _whatsapp_short_claim_url(_claim_token_stale) if _claim_token_stale else claim_url
                        send_whatsapp_text(
                            normalized_wa_id,
                            (
                                f"Your link needs a refresh. Tap here and you're back in a minute: "
                                f"{_short} (valid 24h)"
                            ),
                        )
                    except Exception:
                        logger.exception("WhatsApp stale-user re-claim send failed")
                return
    except Exception:
        # Non-fatal: if we can't verify existence, proceed optimistically.
        logger.exception("WhatsApp user-existence check failed; proceeding")

    # Resolve workspace-scoped user_id for the engine.
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local":
        from auth.local_workspaces import (
            local_workspace_base_user_id,
            local_workspace_user_id,
            get_local_workspace,
        )
        base_only = local_workspace_base_user_id(base_user_id)
        workspace = get_local_workspace(base_only, workspace_id)
        if workspace is None:
            # Pinned workspace no longer exists — reset binding and send fresh link.
            logger.warning(
                "WhatsApp pinned workspace %s not found for user %s; resetting binding",
                workspace_id, base_user_id,
            )
            claim_url = _reset_binding_to_pending(normalized_wa_id)
            if claim_url:
                try:
                    _claim_token_ws = claim_url.split("whatsapp_claim=")[-1] if "whatsapp_claim=" in claim_url else ""
                    _short_ws = _whatsapp_short_claim_url(_claim_token_ws) if _claim_token_ws else claim_url
                    send_whatsapp_text(
                        normalized_wa_id,
                        (
                            f"Your link needs a refresh. Tap here and you're back in a minute: "
                            f"{_short_ws} (valid 24h)"
                        ),
                    )
                except Exception:
                    logger.exception("WhatsApp invalid-workspace re-claim send failed")
            return
        scoped_user_id = local_workspace_user_id(base_only, workspace_id)
    else:
        # Cloud: user_id is already fully qualified; no local scoping.
        scoped_user_id = base_user_id

    # ---------------------------------------------------------------------------
    # Phase 4: approval reply detection.
    # Check BEFORE routing to the agent.  Conservative: only intercepts when
    # the sender has >= 1 pending approval AND the message matches the exact
    # keyword grammar.  Normal chat is never eaten.
    # ---------------------------------------------------------------------------
    try:
        approval_reply = await _maybe_handle_approval_reply(
            wa_id=normalized_wa_id,
            text=text,
            scoped_user_id=scoped_user_id,
        )
    except Exception:
        logger.exception("WhatsApp approval reply check failed; falling through to agent")
        approval_reply = None

    if approval_reply is not None:
        try:
            send_whatsapp_text(normalized_wa_id, approval_reply)
        except Exception:
            logger.exception("WhatsApp approval reply send failed")
        return

    conversation_id = f"whatsapp:{normalized_wa_id}"
    try:
        try:
            _send_whatsapp_typing_indicator(message_id)
        except Exception:
            logger.exception("WhatsApp typing indicator failed")
        reply = await collect_agent_reply(
            message=text,
            user_id=scoped_user_id,
            conversation_id=conversation_id,
            source="whatsapp",
        )
        send_whatsapp_text(normalized_wa_id, reply)
    except Exception as exc:
        logger.exception("WhatsApp message processing failed")
        if os.environ.get("WHATSAPP_POST_ERRORS_TO_CHAT", "1").strip().lower() not in {"0", "false", "no", "off"}:
            try:
                from llm import is_llm_provider_outage, safe_llm_error_message

                if is_llm_provider_outage(exc):
                    error_text = safe_llm_error_message(exc, action="Chat")
                else:
                    error_text = "Something went wrong on my end. Try again in a moment."
                send_whatsapp_text(normalized_wa_id, error_text)
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
    rejected_too_long = 0
    for event in events:
        message_id = event["message_id"]
        # Dedup on Meta's stable message id (Meta retries on timeout).
        if message_id and not _claim_webhook_delivery("whatsapp:messages", message_id):
            continue

        # Finding #8: over-length inbound message — reply "too long" and do NOT
        # spawn agent work.  The dedup claim above is intentionally consumed so
        # Meta retries of the same oversized message do not re-trigger replies.
        if event.get("too_long"):
            rejected_too_long += 1
            try:
                send_whatsapp_text(
                    _normalize_whatsapp_wa_id(event["wa_id"]),
                    (
                        f"That message is too long for me to process "
                        f"(limit {MAX_INBOUND_TEXT_CHARS:,} characters). "
                        "Please shorten it and send again."
                    ),
                )
            except Exception:
                logger.exception("WhatsApp too-long reply failed")
            continue

        background_tasks.add_task(
            _handle_whatsapp_message,
            wa_id=event["wa_id"],
            text=event["text"],
            message_id=message_id,
            profile_name=event.get("profile_name") or "",
        )
        queued += 1

    return JSONResponse({"ok": True, "queued": queued, "rejected_too_long": rejected_too_long})
