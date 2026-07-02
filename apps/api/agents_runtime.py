"""Runtime guardrails for the OpenAI Agents SDK."""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("floom.agents_runtime")

_TRACING_DISABLED = False


def disable_openai_agents_tracing() -> None:
    """Disable Agents SDK trace export globally for this process."""
    global _TRACING_DISABLED
    os.environ.setdefault("OPENAI_AGENTS_DISABLE_TRACING", "1")
    if _TRACING_DISABLED:
        return
    try:
        from agents import set_tracing_disabled

        set_tracing_disabled(True)
        _TRACING_DISABLED = True
    except Exception:
        logger.warning("Failed to disable OpenAI Agents SDK tracing", exc_info=True)
