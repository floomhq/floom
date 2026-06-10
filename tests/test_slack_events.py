import hashlib
import hmac
import importlib
import json
import sys
import time
import types
import urllib.parse
from pathlib import Path

from fastapi.testclient import TestClient


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "slack-test-user")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "test-slack-signing-secret")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test-token")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "T123")

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "chat_service"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _slack_headers(body: bytes, secret: str = "test-slack-signing-secret", ts: int | None = None):
    timestamp = str(ts or int(time.time()))
    base = b"v0:" + timestamp.encode("utf-8") + b":" + body
    signature = "v0=" + hmac.new(secret.encode("utf-8"), base, hashlib.sha256).hexdigest()
    return {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
    }


def _slack_form_headers(body: bytes, secret: str = "test-slack-signing-secret", ts: int | None = None):
    headers = _slack_headers(body, secret=secret, ts=ts)
    headers["Content-Type"] = "application/x-www-form-urlencoded"
    return headers


def _form_body(payload: dict[str, str]) -> bytes:
    return urllib.parse.urlencode(payload).encode("utf-8")


def test_slack_events_url_verification_uses_slack_hmac_without_api_secret(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    body = json.dumps(
        {"type": "url_verification", "challenge": "challenge-token"}
    ).encode("utf-8")

    with TestClient(main.app) as client:
        response = client.post("/slack/events", data=body, headers=_slack_headers(body))

    assert response.status_code == 200
    assert response.text == "challenge-token"


def test_slack_events_rejects_invalid_signature(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    body = json.dumps({"type": "url_verification", "challenge": "challenge-token"}).encode("utf-8")
    headers = _slack_headers(body)
    headers["X-Slack-Signature"] = "v0=bad"

    with TestClient(main.app) as client:
        response = client.post("/slack/events", data=body, headers=headers)

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid Slack signature"


def test_slack_commands_help_uses_signed_form_without_api_secret(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    body = _form_body(
        {
            "team_id": "T123",
            "channel_id": "C123",
            "text": "help",
            "response_url": "https://hooks.slack.test/response",
        }
    )

    with TestClient(main.app) as client:
        response = client.post("/slack/commands", data=body, headers=_slack_form_headers(body))

    assert response.status_code == 200, response.text
    assert response.json()["response_type"] == "ephemeral"
    assert "/floom approvals" in response.json()["text"]


def test_slack_interactivity_dismisses_signed_approval_action(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    payload = {
        "team": {"id": "T123"},
        "user": {"id": "U123"},
        "actions": [
            {
                "action_id": "workeros_approval_dismiss",
                "value": json.dumps({"run_id": "run_123"}),
            }
        ],
    }
    body = _form_body({"payload": json.dumps(payload)})

    with TestClient(main.app) as client:
        response = client.post("/slack/interactivity", data=body, headers=_slack_form_headers(body))

    assert response.status_code == 200, response.text
    assert response.json() == {
        "replace_original": True,
        "text": "Dismissed approval `run_123`.",
    }


def test_slack_app_mention_queues_workspace_agent_reply(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    calls = []
    posts = []

    async def fake_collect(*, message, user_id, conversation_id, **kwargs):
        calls.append((message, user_id, conversation_id))
        return "workspace reply"

    def fake_post(*, channel, thread_ts, text, bot_token=None):
        posts.append((channel, thread_ts, text, bot_token))

    monkeypatch.setattr(main, "_collect_workspace_agent_reply_for_slack", fake_collect)
    monkeypatch.setattr(_slack_mod, "collect_agent_reply", fake_collect)
    monkeypatch.setattr(main, "_post_slack_thread_reply", fake_post)
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", fake_post)

    body = json.dumps(
        {
            "type": "event_callback",
            "team_id": "T123",
            "event_id": "Ev123",
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

    with TestClient(main.app) as client:
        response = client.post("/slack/events", data=body, headers=_slack_headers(body))

    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "status": "queued"}
    assert calls == [("summarize failed runs", "slack-test-user", "slack:C123:1710000000.000001")]
    assert posts == [("C123", "1710000000.000001", "workspace reply", "xoxb-test-token")]


def test_slack_app_mention_uses_team_install_bot_token(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    calls = []
    posts = []
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
    monkeypatch.setenv("SLACK_BOT_TOKEN_T123", "xoxb-team-token")
    main._upsert_slack_installation(
        team_id="T123",
        team_name="test-games",
        enterprise_id=None,
        enterprise_name=None,
        app_id="A123",
        bot_user_id="U999",
        bot_token_env_key="SLACK_BOT_TOKEN_T123",
        scopes=["app_mentions:read", "chat:write"],
        installer_user_id="U111",
        installed_by_user_id="slack-test-user",
    )

    async def fake_collect(*, message, user_id, conversation_id, **kwargs):
        calls.append((message, user_id, conversation_id))
        return "team reply"

    def fake_post(*, channel, thread_ts, text, bot_token=None):
        posts.append({
            "channel": channel,
            "thread_ts": thread_ts,
            "text": text,
            "bot_token": bot_token,
        })

    monkeypatch.setattr(main, "_collect_workspace_agent_reply_for_slack", fake_collect)
    monkeypatch.setattr(_slack_mod, "collect_agent_reply", fake_collect)
    monkeypatch.setattr(main, "_post_slack_thread_reply", fake_post)
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", fake_post)

    body = json.dumps(
        {
            "type": "event_callback",
            "team_id": "T123",
            "event_id": "EvTeamToken",
            "authorizations": [{"user_id": "U999"}],
            "event": {
                "type": "app_mention",
                "channel": "C123",
                "ts": "1710000000.000002",
                "text": "<@U999> inspect workspace",
                "user": "U111",
            },
        }
    ).encode("utf-8")

    with TestClient(main.app) as client:
        response = client.post("/slack/events", data=body, headers=_slack_headers(body))

    assert response.status_code == 200, response.text
    assert calls == [("inspect workspace", "slack-test-user", "slack:C123:1710000000.000002")]
    assert posts[0]["bot_token"] == "xoxb-team-token"


def test_slack_app_mention_deduplicates_event_id(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    calls = []

    async def fake_collect(*, message, user_id, conversation_id, **kwargs):
        calls.append(message)
        return "workspace reply"

    monkeypatch.setattr(main, "_collect_workspace_agent_reply_for_slack", fake_collect)
    monkeypatch.setattr(_slack_mod, "collect_agent_reply", fake_collect)
    monkeypatch.setattr(main, "_post_slack_thread_reply", lambda **kwargs: None)
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kwargs: None)

    body = json.dumps(
        {
            "type": "event_callback",
            "team_id": "T123",
            "event_id": "EvDuplicate",
            "authorizations": [{"user_id": "U999"}],
            "event": {
                "type": "app_mention",
                "channel": "C123",
                "ts": "1710000000.000001",
                "text": "<@U999> summarize failed runs",
            },
        }
    ).encode("utf-8")

    with TestClient(main.app) as client:
        first = client.post("/slack/events", data=body, headers=_slack_headers(body))
        second = client.post("/slack/events", data=body, headers=_slack_headers(body))

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json() == {"ok": True, "duplicate": True}
    assert calls == ["summarize failed runs"]
