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
