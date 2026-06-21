"""Slack channel-reading tools for the workspace agent.

Extracted verbatim from chat_service.py: the on-demand Slack read tools
(list channels, read a channel the bot was invited to). chat_service re-imports
these names for backward compatibility. The bot-token lookup is a lazy
``from main import`` inside the functions (avoids an import cycle); ``requests``
is lazy-imported per the codebase style.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional


# ---------------------------------------------------------------------------
# Slack channel reading (consent = invite)
#
# Slack only lets the bot read a channel it is a MEMBER of, so the operator
# controls access per-channel by inviting Emily (`/invite @Emily`). Reading is
# on-demand only (the operator asks); there is no firehose ingestion. These
# tools degrade gracefully when the channel scopes are not granted yet.
# ---------------------------------------------------------------------------

SLACK_API_BASE = "https://slack.com/api"

# Slack error -> Emily-voice, actionable message. Used so a missing scope or a
# not-invited channel never crashes the tool call; Emily tells the operator
# exactly how to grant access.
_SLACK_SCOPE_DOC = (
    "https://api.slack.com/apps -> your Floom app -> OAuth & Permissions"
)


def _slack_read_bot_token() -> str:
    """Bot token used for reading channels. Reuses the same token helper as the
    Slack thread-reply path in main.py (multi-team aware), falling back to the
    single-workspace SLACK_BOT_TOKEN env var. Returns '' when not connected."""
    try:
        from main import _slack_bot_token_for_team  # lazy: avoid import cycle

        token = (_slack_bot_token_for_team(None) or "").strip()
        if token:
            return token
    except Exception:
        pass
    return os.environ.get("SLACK_BOT_TOKEN", "").strip()


def _slack_api_get(method: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """Call a Slack Web API GET method with the bot token. Returns the parsed
    payload (which includes Slack's own {ok, error}). Raises only on transport
    failure; Slack-level errors are surfaced via payload['error']."""
    import requests  # lazy import, matches codebase style

    token = _slack_read_bot_token()
    if not token:
        return {"ok": False, "error": "no_bot_token"}
    response = requests.get(
        f"{SLACK_API_BASE}/{method}",
        headers={"Authorization": f"Bearer {token}"},
        params=params,
        timeout=15,
    )
    try:
        return response.json()
    except Exception:
        return {"ok": False, "error": f"http_{response.status_code}"}


def _slack_friendly_error(error: str) -> Dict[str, Any]:
    """Map a Slack API error code to an Emily-voice message the operator can act
    on. Never raises; the caller returns this as the tool result so the model can
    relay it verbatim."""
    if error in ("no_bot_token",):
        return {
            "ok": False,
            "error": error,
            "message": (
                "Slack isn't connected to this workspace yet, so I can't read "
                "channels. Connect Slack from the Assistant ('Add to Slack') first."
            ),
        }
    if error in ("missing_scope", "not_allowed_token_type", "invalid_scope"):
        return {
            "ok": False,
            "error": error,
            "message": (
                "Channel reading isn't enabled yet. The workspace owner needs to add "
                "the channel scopes (channels:read, channels:history, groups:read, "
                "groups:history) to the Floom Slack app and reinstall it "
                f"({_SLACK_SCOPE_DOC}). Once that's done I can read any channel "
                "you've invited me to."
            ),
        }
    if error in ("not_in_channel", "channel_not_found"):
        return {
            "ok": False,
            "error": error,
            "message": (
                "I'm not in that channel yet. Invite me with /invite @Emily in the "
                "channel and I'll be able to read it. (Inviting me is how you grant "
                "consent: I can only read channels I've been added to.)"
            ),
        }
    return {
        "ok": False,
        "error": error or "unknown_error",
        "message": f"Slack returned an error I couldn't handle: {error or 'unknown'}.",
    }


def _tool_slack_list_channels(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """List the channels Emily (the bot) is a member of, so she can resolve a
    name like '#launch' to a channel id. Uses users.conversations (the bot's own
    memberships) so it only ever returns channels the operator has invited her to."""
    payload = _slack_api_get(
        "users.conversations",
        {
            "types": "public_channel,private_channel",
            "exclude_archived": "true",
            "limit": 200,
        },
    )
    if not payload.get("ok"):
        return _slack_friendly_error(str(payload.get("error") or ""))
    channels = []
    for ch in payload.get("channels", []) or []:
        channels.append({
            "id": ch.get("id"),
            "name": ch.get("name"),
            "is_private": bool(ch.get("is_private")),
            "is_member": bool(ch.get("is_member", True)),
        })
    channels.sort(key=lambda c: (c.get("name") or ""))
    return {
        "ok": True,
        "channels": channels,
        "count": len(channels),
        "note": (
            "These are the channels I've been invited to. To let me read another "
            "channel, invite me there with /invite @Emily."
        ),
    }


def _slack_resolve_channel_id(channel: str) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
    """Resolve a channel name (with or without '#') or id to a channel id the bot
    is a member of. Returns (channel_id, None) on success or (None, error_result)
    where error_result is a friendly tool result the caller should return."""
    channel = (channel or "").strip()
    if not channel:
        return None, {"ok": False, "error": "channel_required", "message": "Which channel? Give me a name like #launch or a channel id."}
    # Slack channel ids start with C (public) or G (legacy private group); a bare
    # id is used directly so the operator can paste one.
    if channel[0] in ("C", "G") and " " not in channel and channel == channel.upper():
        return channel, None
    target = channel.lstrip("#").lower()
    listing = _tool_slack_list_channels({}, "")
    if not listing.get("ok"):
        return None, listing  # propagate friendly missing_scope / no_token message
    for ch in listing.get("channels", []):
        if (ch.get("name") or "").lower() == target:
            return ch.get("id"), None
    return None, {
        "ok": False,
        "error": "not_in_channel",
        "message": (
            f"I'm not in #{target} (or it doesn't exist). If it exists, invite me "
            f"with /invite @Emily in #{target} and I'll read it."
        ),
    }


def _tool_slack_read_channel(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Read recent messages from a Slack channel on demand. Accepts a channel
    name (resolved via the bot's memberships) or a channel id. Returns cleaned
    recent messages (author + text + ts). Reading a channel ingests everyone's
    messages there, so this is invite-gated and pull-only."""
    channel_arg = str(args.get("channel") or args.get("channel_id") or args.get("name") or "")
    try:
        limit = int(args.get("limit") or 50)
    except (TypeError, ValueError):
        limit = 50
    limit = max(1, min(limit, 100))

    channel_id, err = _slack_resolve_channel_id(channel_arg)
    if err is not None:
        return err

    payload = _slack_api_get(
        "conversations.history",
        {"channel": channel_id, "limit": limit},
    )
    if not payload.get("ok"):
        return _slack_friendly_error(str(payload.get("error") or ""))

    messages = []
    for msg in payload.get("messages", []) or []:
        # Skip channel-join / system subtype noise; keep human + bot messages.
        text = (msg.get("text") or "").strip()
        if not text and not msg.get("attachments") and not msg.get("files"):
            continue
        messages.append({
            "author": msg.get("user") or msg.get("bot_id") or msg.get("username") or "unknown",
            "text": text,
            "ts": msg.get("ts"),
            "thread_ts": msg.get("thread_ts"),
            "reply_count": msg.get("reply_count"),
        })
    # Slack returns newest-first; present oldest-first for natural reading order.
    messages.reverse()
    return {
        "ok": True,
        "channel": channel_arg.lstrip("#") or channel_id,
        "channel_id": channel_id,
        "messages": messages,
        "count": len(messages),
        "privacy_note": (
            "Reading this channel includes everyone's messages in it. I only read "
            "channels I've been explicitly invited to, and only when asked."
        ),
    }
