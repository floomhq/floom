import hashlib
import hmac
import importlib
import json
import sys
import time
import types
from pathlib import Path

from fastapi.testclient import TestClient


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "slack-test-user")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "test-slack-signing-secret")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test-token")

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


def test_slack_app_mention_queues_workspace_agent_reply(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    calls = []
    posts = []

    async def fake_collect(*, message, user_id, conversation_id):
        calls.append((message, user_id, conversation_id))
        return "workspace reply"

    def fake_post(*, channel, thread_ts, text):
        posts.append((channel, thread_ts, text))

    monkeypatch.setattr(main, "_collect_workspace_agent_reply_for_slack", fake_collect)
    monkeypatch.setattr(main, "_post_slack_thread_reply", fake_post)

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
    assert posts == [("C123", "1710000000.000001", "workspace reply")]


def test_slack_app_mention_deduplicates_event_id(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    calls = []

    async def fake_collect(*, message, user_id, conversation_id):
        calls.append(message)
        return "workspace reply"

    monkeypatch.setattr(main, "_collect_workspace_agent_reply_for_slack", fake_collect)
    monkeypatch.setattr(main, "_post_slack_thread_reply", lambda **kwargs: None)

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
