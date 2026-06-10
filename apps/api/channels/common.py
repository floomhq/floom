"""Shared channel helpers used by both Slack and WhatsApp (and LangDock MCP).

All functions here are pure-logic or I/O helpers that do not depend on the
FastAPI ``app`` instance, so they can be imported freely from any channel
module without creating a circular dependency with main.py.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Maximum inbound webhook body size (applies to all channels).
# Reject payloads larger than this before any parsing or HMAC work.
# ---------------------------------------------------------------------------
_MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024  # 1 MB


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

        # Reverse-lookup: find active wa_id bound to this owner_id.
        wa_id: Optional[str] = None
        try:
            with get_db() as conn:
                row = conn.execute(
                    """
                    SELECT wa_id FROM whatsapp_sender_bindings
                    WHERE user_id = ? AND status = 'active'
                    LIMIT 1
                    """,
                    (owner_id,),
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
