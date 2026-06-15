"""Regression tests for #1170: cloud Slack app_mention fails closed for unbound channels.

In cloud, workspace_agent_channel_bindings is the tenant routing boundary. When an
app_mention arrives from a channel that has no binding row, the route must ignore the
event rather than enqueuing _run_bound_slack_agent under the bootstrap/legacy user.
"""
from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import sys
import time
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _slack_headers(body: bytes, secret: str = "test-signing-secret") -> dict[str, str]:
    timestamp = str(int(time.time()))
    base = b"v0:" + timestamp.encode() + b":" + body
    signature = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    return {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
    }


def _reload_slack_events(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "test-signing-secret")

    for name in [
        "apps.api.routes.slack_events",
        "main",
        "db",
        "models",
        "worker_registry",
        "run_service",
        "chat_service",
    ]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.routes.slack_events")


def _app_mention_body(*, team_id: str, channel: str, text: str = "hello") -> bytes:
    return json.dumps({
        "type": "event_callback",
        "team_id": team_id,
        "event_id": f"Ev-{team_id}-{channel}",
        "event": {
            "type": "app_mention",
            "channel": channel,
            "ts": "1710000000.000001",
            "text": text,
            "user": "U999",
        },
    }).encode()


def test_app_mention_with_no_binding_is_ignored_not_queued(monkeypatch, tmp_path):
    """#1170: app_mention from an unbound channel must return ignored, not queue an agent run."""
    slack_events = _reload_slack_events(monkeypatch, tmp_path)

    monkeypatch.setattr(slack_events.engine_main, "_slack_events_enabled", lambda: True)
    monkeypatch.setattr(slack_events.engine_main, "_slack_allowed_team_ids", lambda: set())
    monkeypatch.setattr(slack_events.engine_main, "_claim_webhook_delivery", lambda *_: True)
    monkeypatch.setattr(slack_events.slack_db, "bot_token_for_team", lambda _tid: "xoxb-test")

    # resolve_slack_event_binding returns None — no binding for this channel.
    monkeypatch.setattr(slack_events, "resolve_slack_event_binding", lambda *, team_id, channel_id: None)

    queued_calls: list[Any] = []

    async def must_not_queue(*args, **kwargs):
        queued_calls.append((args, kwargs))

    monkeypatch.setattr(slack_events.engine_main, "_handle_slack_app_mention", must_not_queue)

    app = FastAPI()
    app.include_router(slack_events.router, prefix="/api")
    body = _app_mention_body(team_id="T-UNBOUND", channel="C-UNBOUND")

    client = TestClient(app)
    resp = client.post("/api/slack/events", content=body, headers=_slack_headers(body))

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("ignored") == "no_workspace_binding", f"Expected ignored=no_workspace_binding, got: {data}"
    assert queued_calls == [], "Agent run must not have been queued for an unbound channel"


def test_app_mention_with_binding_is_still_queued(monkeypatch, tmp_path):
    """#1170: app_mention from a BOUND channel must still be queued (no regression)."""
    slack_events = _reload_slack_events(monkeypatch, tmp_path)

    monkeypatch.setattr(slack_events.engine_main, "_slack_events_enabled", lambda: True)
    monkeypatch.setattr(slack_events.engine_main, "_slack_allowed_team_ids", lambda: set())
    monkeypatch.setattr(slack_events.engine_main, "_claim_webhook_delivery", lambda *_: True)
    monkeypatch.setattr(slack_events.slack_db, "bot_token_for_team", lambda _tid: "xoxb-test")

    # resolve_slack_event_binding returns a binding row — channel IS bound.
    monkeypatch.setattr(
        slack_events,
        "resolve_slack_event_binding",
        lambda *, team_id, channel_id: {"workspace_id": "ws-bound", "owner_user_id": "owner-u"},
    )

    queued_calls: list[dict] = []

    async def fake_handle_app_mention(*, event, team_id, slack_sender_id, bot_token):
        queued_calls.append({"team_id": team_id, "slack_sender_id": slack_sender_id})

    monkeypatch.setattr(slack_events.engine_main, "_handle_slack_app_mention", fake_handle_app_mention)

    app = FastAPI()
    app.include_router(slack_events.router, prefix="/api")
    body = _app_mention_body(team_id="T-BOUND", channel="C-BOUND")

    client = TestClient(app)
    resp = client.post("/api/slack/events", content=body, headers=_slack_headers(body))

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("status") == "queued", f"Expected queued, got: {data}"
    assert len(queued_calls) == 1, "App mention from bound channel must be queued"
    assert queued_calls[0]["team_id"] == "T-BOUND"


def test_app_mention_binding_check_does_not_affect_dm_messages(monkeypatch, tmp_path):
    """#1170: DM messages (channel_type=im) still use the existing binding path (no regression)."""
    slack_events = _reload_slack_events(monkeypatch, tmp_path)

    monkeypatch.setattr(slack_events.engine_main, "_slack_events_enabled", lambda: True)
    monkeypatch.setattr(slack_events.engine_main, "_slack_allowed_team_ids", lambda: set())
    monkeypatch.setattr(slack_events.engine_main, "_claim_webhook_delivery", lambda *_: True)
    monkeypatch.setattr(slack_events.slack_db, "bot_token_for_team", lambda _tid: "xoxb-test")

    # No binding → DM also fails closed.
    monkeypatch.setattr(slack_events, "resolve_slack_event_binding", lambda *, team_id, channel_id: None)

    queued_calls: list[Any] = []

    async def must_not_queue(*a, **kw):
        queued_calls.append((a, kw))

    monkeypatch.setattr(slack_events, "_run_bound_slack_agent", must_not_queue)

    app = FastAPI()
    app.include_router(slack_events.router, prefix="/api")

    body = json.dumps({
        "type": "event_callback",
        "team_id": "T-DM",
        "event_id": "Ev-DM",
        "event": {
            "type": "message",
            "channel_type": "im",
            "channel": "D-CHAN",
            "ts": "1710000000.000002",
            "text": "hello",
            "user": "U001",
        },
    }).encode()

    client = TestClient(app)
    resp = client.post("/api/slack/events", content=body, headers=_slack_headers(body))

    assert resp.status_code == 200, resp.text
    # DM with no binding returns ignored.
    assert resp.json().get("ignored") == "no_workspace_binding"
    assert queued_calls == []
