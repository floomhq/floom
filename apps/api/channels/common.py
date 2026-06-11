"""Shared channel helpers used by both Slack and WhatsApp (and LangDock MCP).

All functions here are pure-logic or I/O helpers that do not depend on the
FastAPI ``app`` instance, so they can be imported freely from any channel
module without creating a circular dependency with main.py.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Maximum inbound webhook body size (applies to all channels).
# Reject payloads larger than this before any parsing or HMAC work.
# ---------------------------------------------------------------------------
_MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024  # 1 MB

# ---------------------------------------------------------------------------
# Per-message and per-delivery inbound caps (Codex finding #8).
#
# The 1 MB body cap above still allows a single huge message, or hundreds of
# small messages in one delivery, each of which would spawn an agent run.
# These bound the work a single signed webhook delivery can trigger:
#   - reject inbound message text over MAX_INBOUND_TEXT_CHARS with a friendly
#     "message too long" reply (no agent run),
#   - process at most MAX_EVENTS_PER_DELIVERY message events per payload and
#     skip the rest with a log.
# In-process / per-request only — no Redis, no new infra.
# ---------------------------------------------------------------------------
MAX_INBOUND_TEXT_CHARS = 8000
MAX_EVENTS_PER_DELIVERY = 25


# ---------------------------------------------------------------------------
# WhatsApp approval notification (outbound fan-out hook)
# ---------------------------------------------------------------------------

def notify_pending_approval_via_whatsapp(
    *,
    owner_id: str,
    run_id: str,
    worker_name: str,
    label: str,
    approval_id: str,
) -> None:
    """Send a WhatsApp notification to the run owner when a run enters pending-approval state.

    Looks up the owner's active WhatsApp binding by user_id (reverse of the
    normal wa_id→user_id direction).  Does nothing if the owner has no active
    binding or if WhatsApp is not configured.  Always best-effort — never raises.

    The message includes the short approval ID suffix (last 6 hex chars) so the
    user can reply ``yes <suffix>`` or ``no <suffix>`` when multiple approvals
    are pending simultaneously.
    """
    try:
        from db import get_db
        from channels.whatsapp import (
            send_whatsapp_text,
            _whatsapp_configured,
        )

        if not _whatsapp_configured():
            return

        # Reverse-lookup: find active wa_id bound to this owner.
        # #871: an admin/FLOOM_SECRET-created run is owned by the bootstrap id
        # ('federico'), but the human's binding is keyed to their real user
        # uuid (and a legacy binding may be under bootstrap). Match the binding
        # against the bootstrap<->uuid alternates so the owner still gets pinged.
        bootstrap_id = (os.environ.get("WORKEROS_USER_ID") or "").strip() or "federico"
        candidate_ids = [owner_id]
        wa_id: Optional[str] = None
        try:
            with get_db() as conn:
                if owner_id == bootstrap_id:
                    try:
                        admin_rows = conn.execute(
                            "SELECT id FROM users WHERE role = 'admin'"
                        ).fetchall()
                        candidate_ids += [str(r["id"]) for r in admin_rows]
                    except Exception:
                        pass  # no users table (legacy single-user) — owner_id alone is fine
                else:
                    candidate_ids.append(bootstrap_id)
                seen: set[str] = set()
                candidate_ids = [c for c in candidate_ids if c and not (c in seen or seen.add(c))]
                placeholders = ",".join("?" * len(candidate_ids))
                row = conn.execute(
                    f"""
                    SELECT wa_id FROM whatsapp_sender_bindings
                    WHERE user_id IN ({placeholders}) AND status = 'active'
                    LIMIT 1
                    """,
                    tuple(candidate_ids),
                ).fetchone()
            if row:
                wa_id = str(row["wa_id"])
        except Exception:
            logger.exception(
                "WhatsApp approval notify: binding lookup failed for owner %s", owner_id
            )
            return

        if not wa_id:
            return

        # Short suffix for disambiguation when multiple approvals are pending.
        short_id = approval_id[-6:] if len(approval_id) >= 6 else approval_id

        msg = (
            f"Approval needed for worker \"{worker_name}\": {label}\n\n"
            f"Reply *yes* to approve or *no* to reject.\n"
            f"If you have multiple pending approvals, reply *yes {short_id}* "
            f"or *no {short_id}*."
        )
        try:
            send_whatsapp_text(wa_id, msg)
        except Exception:
            logger.exception(
                "WhatsApp approval notify: send failed for wa_id %s (run %s)", wa_id, run_id
            )
    except Exception:
        logger.exception(
            "WhatsApp approval notify: unexpected error for owner %s run %s", owner_id, run_id
        )


def _auth_is_configured() -> bool:
    """True when this deployment has real auth configured (NOT legacy/dev mode).

    Legacy / pure-dev mode is the narrow case the #845 bootstrap-owner behavior
    targets: ``WORKEROS_DEPLOY=local`` AND no ``FLOOM_SECRET``.  Everything else
    (a secret is set, or a non-local deploy) is a configured deployment where a
    binding validation failure MUST fail closed (Codex finding #7).
    """
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy != "local":
        return True
    return bool((os.environ.get("FLOOM_SECRET") or "").strip())


def bound_user_is_valid(user_id: str) -> bool:
    """Return True if ``user_id`` should be treated as an existing, valid binding owner.

    A binding is valid when ANY of the following holds:

    1. The ``users`` table contains a row for ``user_id`` (normal multi-member case).
    2. ``user_id`` equals the bootstrap/legacy owner id
       (``WORKEROS_USER_ID`` env var, defaulting to ``"federico"``).  Legacy
       single-user installs bind under this id, which pre-dates the ``users``
       table.  Resetting that binding when there is no matching users row would
       disconnect a valid owner (preserves #845 legacy-bootstrap-owner behavior).
    3. The ``users`` table is absent or empty AND we are genuinely in legacy/dev
       mode (no FLOOM_SECRET, local deploy).  This is the "clone and run locally"
       case where no accounts are registered yet.

    Fail-closed (Codex finding #7): in a CONFIGURED deployment (FLOOM_SECRET set
    or non-local deploy), a DB error or a missing ``users`` table during this
    check returns ``False`` (invalid) rather than granting access.  A stale or
    deleted binding must not stay authorized just because the validation query
    failed.  The legacy/dev single-user pass is an explicit branch, not a
    catch-all ``except``.
    """
    # Bootstrap/legacy owner id is always valid — this id pre-dates the users
    # table and represents the single-tenant owner (#845).  Resolved without
    # importing main to avoid a circular import.
    bootstrap_id = (os.environ.get("WORKEROS_USER_ID") or "").strip() or "federico"
    if user_id == bootstrap_id:
        return True

    configured = _auth_is_configured()

    try:
        from db import get_db as _get_db  # lazy — avoids circular import at module level

        with _get_db() as conn:
            try:
                count_row = conn.execute("SELECT COUNT(*) FROM users").fetchone()
                user_count = count_row[0] if count_row else 0
            except Exception:
                # users table is absent / unreadable.
                if configured:
                    # Configured deployment with a broken users table: fail
                    # closed.  We cannot prove the binding is valid.
                    logger.exception(
                        "bound_user_is_valid: users table unreadable in configured "
                        "deployment for %r; failing closed",
                        user_id,
                    )
                    return False
                # Genuine legacy/dev mode (no secret, local): table not created
                # yet on a fresh install — treat bindings as valid.
                return True

            if user_count == 0:
                if configured:
                    # Configured deployment with zero users is anomalous (auth is
                    # set up but no accounts) — do not grant a non-bootstrap id.
                    return False
                # Legacy/dev pre-auth mode — no accounts registered; valid.
                return True

            exists = conn.execute(
                "SELECT 1 FROM users WHERE id = ? LIMIT 1", (user_id,)
            ).fetchone()
            return exists is not None
    except Exception:
        # Connection/query failure.
        if configured:
            logger.exception(
                "bound_user_is_valid check failed for %r in configured deployment; "
                "failing closed",
                user_id,
            )
            return False
        logger.exception(
            "bound_user_is_valid check failed for %r in legacy/dev mode; "
            "proceeding optimistically",
            user_id,
        )
        return True


async def collect_agent_reply(
    *,
    message: str,
    user_id: str,
    conversation_id: Optional[str],
    source: str = "slack",
    system_suffix: str = "",
) -> str:
    """Stream the workspace-agent reply for an inbound channel message.

    Drives ``chat_service.stream_chat`` over an asyncio Queue and returns the
    concatenated text reply (em-dashes stripped).  Named ``collect_agent_reply``
    here (channel-neutral); main.py re-exports it as
    ``_collect_workspace_agent_reply_for_slack`` for backwards compatibility with
    tests that monkeypatch that name directly.
    """
    from chat_service import stream_chat, strip_em_dashes  # lazy — avoids circular import

    queue: asyncio.Queue = asyncio.Queue(maxsize=1024)
    task = asyncio.create_task(
        stream_chat(
            message=message,
            user_id=user_id,
            conversation_id=conversation_id,
            part_queue=queue,
            source=source,
            system_suffix=system_suffix,
        )
    )
    text_parts: list[str] = []
    try:
        while True:
            part = await queue.get()
            if part.get("type") == "text":
                text_parts.append(str(part.get("text") or ""))
            if part.get("type") == "error":
                raise RuntimeError(str(part.get("error") or "workspace agent failed"))
            if part.get("type") == "finish":
                break
        await task
    finally:
        if not task.done():
            task.cancel()
    return strip_em_dashes("".join(text_parts).strip())
