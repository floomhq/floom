"""Emily can read Slack channels she's been invited to (consent = invite).

The bot can only read a channel it is a MEMBER of, so the operator grants access
per-channel by inviting Emily (/invite @Emily). Reading is on-demand only. These
tests cover:
  - slack__list_channels happy path (resolve names -> ids),
  - slack__read_channel happy path (cleaned recent messages, oldest-first),
  - graceful missing_scope (channel scopes not granted yet),
  - graceful not_in_channel (not invited),
  - graceful no bot token (Slack not connected),
  - the two tools are registered in the workspace tool set.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

API_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

import chat_service  # noqa: E402
from services import chat_slack  # noqa: E402

# The Slack read tools were extracted into services/chat_slack.py (PR #1073).
# chat_service re-imports them for backward compatibility, but the implementations
# call _slack_api_get / _slack_read_bot_token via their own module namespace, so
# patches must target services.chat_slack (where the names are looked up), not the
# re-exported chat_service references.


@pytest.fixture
def fake_token(monkeypatch):
    monkeypatch.setattr(chat_slack, "_slack_read_bot_token", lambda: "xoxb-test")
    return "xoxb-test"


def _stub_api(monkeypatch, responses):
    """Stub _slack_api_get with a dict {method: payload} or a callable."""
    def _fake(method, params):
        if callable(responses):
            return responses(method, params)
        return responses[method]

    monkeypatch.setattr(chat_slack, "_slack_api_get", _fake)


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------

def test_slack_tools_are_registered():
    names = {t.name for t in chat_service._workspace_tools("u1")}
    assert "slack__list_channels" in names
    assert "slack__read_channel" in names


# ---------------------------------------------------------------------------
# list_channels
# ---------------------------------------------------------------------------

def test_list_channels_happy_path(monkeypatch, fake_token):
    _stub_api(monkeypatch, {
        "users.conversations": {
            "ok": True,
            "channels": [
                {"id": "C200", "name": "ops", "is_private": False, "is_member": True},
                {"id": "C100", "name": "launch", "is_private": False, "is_member": True},
                {"id": "G300", "name": "founders", "is_private": True, "is_member": True},
            ],
        }
    })
    out = chat_service._tool_slack_list_channels({}, "u1")
    assert out["ok"] is True
    assert out["count"] == 3
    # sorted by name
    assert [c["name"] for c in out["channels"]] == ["founders", "launch", "ops"]
    assert out["channels"][0]["is_private"] is True
    assert "/invite" in out["note"]


def test_list_channels_missing_scope_is_graceful(monkeypatch, fake_token):
    _stub_api(monkeypatch, {"users.conversations": {"ok": False, "error": "missing_scope"}})
    out = chat_service._tool_slack_list_channels({}, "u1")
    assert out["ok"] is False
    assert out["error"] == "missing_scope"
    assert "channels:read" in out["message"]
    assert "reinstall" in out["message"].lower()


def test_list_channels_no_token_is_graceful(monkeypatch):
    monkeypatch.setattr(chat_slack, "_slack_read_bot_token", lambda: "")
    # _slack_api_get itself returns no_bot_token without a token.
    out = chat_service._tool_slack_list_channels({}, "u1")
    assert out["ok"] is False
    assert out["error"] == "no_bot_token"
    assert "Slack isn't connected" in out["message"]


# ---------------------------------------------------------------------------
# read_channel
# ---------------------------------------------------------------------------

def test_read_channel_happy_path_resolves_name(monkeypatch, fake_token):
    def _responses(method, params):
        if method == "users.conversations":
            return {"ok": True, "channels": [{"id": "C100", "name": "launch", "is_member": True}]}
        if method == "conversations.history":
            assert params["channel"] == "C100"
            return {
                "ok": True,
                "messages": [
                    {"user": "U2", "text": "second", "ts": "200.0"},
                    {"subtype": "channel_join", "text": "", "ts": "150.0"},  # dropped
                    {"user": "U1", "text": "first", "ts": "100.0"},
                ],
            }
        raise AssertionError(method)

    _stub_api(monkeypatch, _responses)
    out = chat_service._tool_slack_read_channel({"channel": "#launch"}, "u1")
    assert out["ok"] is True
    assert out["channel_id"] == "C100"
    # system join message dropped, and oldest-first ordering
    assert [m["text"] for m in out["messages"]] == ["first", "second"]
    assert out["count"] == 2
    assert "everyone's messages" in out["privacy_note"]


def test_read_channel_accepts_bare_id(monkeypatch, fake_token):
    def _responses(method, params):
        assert method == "conversations.history"
        assert params["channel"] == "C999"
        return {"ok": True, "messages": [{"user": "U1", "text": "hi", "ts": "1.0"}]}

    _stub_api(monkeypatch, _responses)
    out = chat_service._tool_slack_read_channel({"channel": "C999"}, "u1")
    assert out["ok"] is True
    assert out["channel_id"] == "C999"


def test_read_channel_not_in_channel_is_graceful(monkeypatch, fake_token):
    # conversations.history returns not_in_channel for a bare id the bot isn't in.
    _stub_api(monkeypatch, {"conversations.history": {"ok": False, "error": "not_in_channel"}})
    out = chat_service._tool_slack_read_channel({"channel": "C123"}, "u1")
    assert out["ok"] is False
    assert out["error"] == "not_in_channel"
    assert "/invite @Emily" in out["message"]


def test_read_channel_name_not_found_tells_user_to_invite(monkeypatch, fake_token):
    # Name resolution finds no matching membership -> invite guidance.
    _stub_api(monkeypatch, {"users.conversations": {"ok": True, "channels": []}})
    out = chat_service._tool_slack_read_channel({"channel": "#secret"}, "u1")
    assert out["ok"] is False
    assert out["error"] == "not_in_channel"
    assert "/invite @Emily" in out["message"]


def test_read_channel_missing_scope_is_graceful(monkeypatch, fake_token):
    _stub_api(monkeypatch, {"conversations.history": {"ok": False, "error": "missing_scope"}})
    out = chat_service._tool_slack_read_channel({"channel": "C123"}, "u1")
    assert out["ok"] is False
    assert out["error"] == "missing_scope"
    assert "channels:history" in out["message"]


def test_read_channel_no_token_is_graceful(monkeypatch):
    monkeypatch.setattr(chat_slack, "_slack_read_bot_token", lambda: "")
    out = chat_service._tool_slack_read_channel({"channel": "C123"}, "u1")
    assert out["ok"] is False
    assert out["error"] == "no_bot_token"
    assert "Slack isn't connected" in out["message"]


def test_read_channel_requires_a_channel(monkeypatch, fake_token):
    out = chat_service._tool_slack_read_channel({"channel": ""}, "u1")
    assert out["ok"] is False
    assert out["error"] == "channel_required"


def test_read_channel_limit_is_clamped(monkeypatch, fake_token):
    captured = {}

    def _responses(method, params):
        captured["limit"] = params.get("limit")
        return {"ok": True, "messages": []}

    _stub_api(monkeypatch, _responses)
    chat_service._tool_slack_read_channel({"channel": "C1", "limit": 5000}, "u1")
    assert captured["limit"] == 100  # clamped to max
