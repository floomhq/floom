from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import sys
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from apps.api.auth.workspace_context import get_active_workspace_id


def _slack_headers(body: bytes, secret: str = "test-slack-signing-secret") -> dict[str, str]:
    timestamp = str(int(time.time()))
    base = b"v0:" + timestamp.encode("utf-8") + b":" + body
    signature = "v0=" + hmac.new(secret.encode("utf-8"), base, hashlib.sha256).hexdigest()
    return {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
    }


def test_cloud_slack_events_routes_app_mentions_to_bound_workspace(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "test-slack-signing-secret")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test-token")

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
    slack_events = importlib.import_module("apps.api.routes.slack_events")

    monkeypatch.setattr(slack_events.engine_main, "_slack_events_enabled", lambda: True)
    monkeypatch.setattr(slack_events.engine_main, "_slack_allowed_team_ids", lambda: set())
    monkeypatch.setattr(slack_events.engine_main, "_claim_webhook_delivery", lambda *_args: True)
    monkeypatch.setattr(slack_events.slack_db, "bot_token_for_team", lambda team_id: "xoxb-test-token")

    calls: list[dict[str, object]] = []

    async def fake_handle_slack_app_mention(*, event, team_id, slack_sender_id, bot_token):
        calls.append(
            {
                "event": event,
                "team_id": team_id,
                "slack_sender_id": slack_sender_id,
                "bot_token": bot_token,
            }
        )

    monkeypatch.setattr(
        slack_events.engine_main,
        "_handle_slack_app_mention",
        fake_handle_slack_app_mention,
    )

    app = FastAPI()
    app.include_router(slack_events.router, prefix="/api")

    body = json.dumps(
        {
            "type": "event_callback",
            "team_id": "T123",
            "event_id": "EvCloudRoute",
            "authorizations": [{"user_id": "U999"}],
            "event": {
                "type": "app_mention",
                "channel": "C123",
                "ts": "1710000000.000001",
                "text": "<@U999> summarize failed runs",
                "user": "U111",
            },
        }
    ).encode("utf-8")

    with TestClient(app) as client:
        response = client.post("/api/slack/events", data=body, headers=_slack_headers(body))

    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "status": "queued", "routed": "app_mention"}
    assert calls == [
        {
            "event": {
                "type": "app_mention",
                "channel": "C123",
                "ts": "1710000000.000001",
                "text": "<@U999> summarize failed runs",
                "user": "U111",
            },
            "team_id": "T123",
            "slack_sender_id": "U111",
            "bot_token": "xoxb-test-token",
        }
    ]


def test_install_claim_link_is_not_delivered_to_unauthorized_slack_user(monkeypatch):
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
    slack_events = importlib.import_module("apps.api.routes.slack_events")

    replies: list[dict[str, str]] = []
    monkeypatch.setattr(
        slack_events.slack_db,
        "get_installation",
        lambda _team_id: {
            "team_id": "T123",
            "workspace_id": "ws_1",
            "installation_id": "00000000-0000-0000-0000-000000000001",
            "installer_slack_user_id": "U_INSTALLER",
        },
    )
    monkeypatch.setattr(slack_events.slack_db, "can_claim_install", lambda **_kwargs: False)
    monkeypatch.setattr(
        slack_events.slack_db,
        "create_install_claim",
        lambda **_kwargs: pytest.fail("unauthorized users must not receive install claim tokens"),
    )
    monkeypatch.setattr(
        slack_events.engine_main,
        "_post_slack_thread_reply",
        lambda **kwargs: replies.append(kwargs),
    )

    slack_events._post_install_claim_link(
        team_id="T123",
        slack_user_id="U_ATTACKER",
        channel="D123",
        thread_ts="1710000000.000001",
        bot_token="xoxb-test",
    )

    assert replies == [
        {
            "channel": "D123",
            "thread_ts": "1710000000.000001",
            "text": "Ask the original installer or a Slack admin to claim this Floom workspace.",
            "bot_token": "xoxb-test",
        }
    ]
