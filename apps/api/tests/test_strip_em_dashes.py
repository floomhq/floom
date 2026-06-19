"""Tests for the strip_em_dashes helper and its application to the Slack reply path."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Import the helper directly from chat_service (no DB / heavy deps needed)
# ---------------------------------------------------------------------------

def _strip_em_dashes():
    import importlib
    mod = importlib.import_module("chat_service")
    return mod.strip_em_dashes


# ---------------------------------------------------------------------------
# strip_em_dashes unit tests
# ---------------------------------------------------------------------------

def test_spaced_em_dash_replaced():
    fn = _strip_em_dashes()
    result = fn("a — b")
    assert "—" not in result  # U+2014 em dash gone
    assert "–" not in result  # U+2013 en dash gone


def test_unspaced_em_dash_replaced():
    fn = _strip_em_dashes()
    result = fn("a—b")
    assert "—" not in result


def test_spaced_en_dash_replaced():
    fn = _strip_em_dashes()
    result = fn("a – b")
    assert "–" not in result


def test_unspaced_en_dash_replaced():
    fn = _strip_em_dashes()
    result = fn("a–b")
    assert "–" not in result


def test_no_dash_unchanged():
    fn = _strip_em_dashes()
    text = "Hello, world. This is fine."
    assert fn(text) == text


def test_multiple_dashes_all_replaced():
    fn = _strip_em_dashes()
    text = "first — second — third"
    result = fn(text)
    assert "—" not in result
    assert "–" not in result


def test_spaced_em_dash_becomes_comma_space():
    fn = _strip_em_dashes()
    assert fn("a — b") == "a, b"


def test_unspaced_em_dash_becomes_comma_space():
    fn = _strip_em_dashes()
    assert fn("a—b") == "a, b"


def test_empty_string():
    fn = _strip_em_dashes()
    assert fn("") == ""


def test_only_em_dash():
    fn = _strip_em_dashes()
    result = fn("—")
    assert "—" not in result


# ---------------------------------------------------------------------------
# Slack reply path: _collect_workspace_agent_reply_for_slack strips em dashes
# ---------------------------------------------------------------------------

def test_slack_reply_strips_em_dashes():
    """The assembled Slack reply must contain zero em/en dashes."""
    import importlib

    # Build a fake part_queue that yields a text part with em dashes then finish
    async def _fake_stream_chat(*, message, user_id, conversation_id, part_queue, source="slack", **_kwargs):
        await part_queue.put({"type": "text", "text": "Worker A — failed due to — timeout"})
        await part_queue.put({"type": "finish", "conversation_id": "c1", "message_id": "m1"})

    async def _run():
        with patch("chat_service.stream_chat", side_effect=_fake_stream_chat):
            # Re-import main to pick up the patch in the module's own import of stream_chat
            main = importlib.import_module("main")
            # Call _collect_workspace_agent_reply_for_slack directly
            fn = getattr(main, "_collect_workspace_agent_reply_for_slack")
            reply = await fn(message="list workers", user_id="u1", conversation_id=None)
        assert "—" not in reply, f"em dash found in Slack reply: {reply!r}"
        assert "–" not in reply, f"en dash found in Slack reply: {reply!r}"

    asyncio.run(_run())
