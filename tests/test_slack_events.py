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
    """Dismiss requires a bound identity. The clicker (U123) is pre-bound here."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    # Bind the clicker so the action is permitted.
    with main.get_db() as conn:
        now = main.now_iso()
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, user_id, profile_name, status, created_at, updated_at)
            VALUES ('T123', 'U123', 'bound-user-1', 'Bound User', 'active', ?, ?)
            """,
            (now, now),
        )

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


def test_slack_app_mention_returns_pointer_reply_not_agent(monkeypatch, tmp_path):
    """Channel @mentions return a 'DM me' pointer. The agent is never invoked."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    import channels.common as _common_mod
    agent_calls = []
    posts = []

    async def boom_collect(**_kwargs):
        agent_calls.append(_kwargs)
        return "should not happen"

    def fake_post(*, channel, thread_ts, text, bot_token=None):
        posts.append((channel, thread_ts, text, bot_token))

    monkeypatch.setattr(_common_mod, "collect_agent_reply", boom_collect)
    monkeypatch.setattr(_slack_mod, "collect_agent_reply", boom_collect)
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
    assert agent_calls == [], "agent must NOT be invoked from channel mention"
    assert posts, "a pointer reply must be posted"
    reply_text = posts[0][2]
    assert "DM" in reply_text or "direct message" in reply_text.lower()


def test_slack_app_mention_uses_team_install_bot_token(monkeypatch, tmp_path):
    """Mention pointer reply uses the per-team bot token from the installation row."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
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

    def fake_post(*, channel, thread_ts, text, bot_token=None):
        posts.append({
            "channel": channel,
            "thread_ts": thread_ts,
            "text": text,
            "bot_token": bot_token,
        })

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
    assert posts, "a pointer reply must be posted"
    assert posts[0]["bot_token"] == "xoxb-team-token", "must use per-team token"


def test_slack_app_mention_deduplicates_event_id(monkeypatch, tmp_path):
    """Duplicate event_ids are deduped — the pointer reply is sent only once."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    posts = []

    monkeypatch.setattr(main, "_post_slack_thread_reply", lambda **kwargs: posts.append(kwargs))
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kwargs: posts.append(kwargs))

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
    assert len(posts) == 1, "pointer reply must be sent exactly once despite duplicate event"


def test_two_distinct_events_same_second_both_processed(monkeypatch, tmp_path):
    """Regression: two distinct Slack events arriving within the same Unix second
    must BOTH be processed.  The old code used X-Slack-Retry-Num as a fallback
    dedup key, which maps to the same counter value ("1") for two unrelated
    events' first delivery — causing the second to be incorrectly rejected as a
    duplicate.  The fix uses the globally unique event_id field; two events with
    distinct event_ids must never collide in the dedup table.
    """
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    posts = []

    monkeypatch.setattr(main, "_post_slack_thread_reply", lambda **kwargs: posts.append(kwargs))
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kwargs: posts.append(kwargs))

    # Two different events, distinct event_ids, timestamps sharing the same
    # Unix second (only microseconds differ — as happens in a real burst).
    same_ts_base = str(int(time.time()))
    body_a = json.dumps(
        {
            "type": "event_callback",
            "team_id": "T123",
            "event_id": "EvDistinctA",
            "authorizations": [{"user_id": "U999"}],
            "event": {
                "type": "app_mention",
                "channel": "C123",
                "ts": f"{same_ts_base}.000001",
                "text": "<@U999> what is 2+2?",
                "user": "U111",
            },
        }
    ).encode("utf-8")
    body_b = json.dumps(
        {
            "type": "event_callback",
            "team_id": "T123",
            "event_id": "EvDistinctB",
            "authorizations": [{"user_id": "U999"}],
            "event": {
                "type": "app_mention",
                "channel": "C123",
                "ts": f"{same_ts_base}.000002",
                "text": "<@U999> what is 10*10?",
                "user": "U111",
            },
        }
    ).encode("utf-8")

    with TestClient(main.app) as client:
        resp_a = client.post("/slack/events", data=body_a, headers=_slack_headers(body_a))
        resp_b = client.post("/slack/events", data=body_b, headers=_slack_headers(body_b))

    assert resp_a.status_code == 200, resp_a.text
    assert resp_b.status_code == 200, resp_b.text
    assert resp_a.json().get("duplicate") is not True, "first event must not be rejected as duplicate"
    assert resp_b.json().get("duplicate") is not True, "second distinct event must not be rejected as duplicate"
    # Both events queued/processed.
    assert len(posts) == 2, f"both events must trigger a reply, got {len(posts)}"


def test_identical_event_redelivered_is_deduped(monkeypatch, tmp_path):
    """Regression: an identical Slack event redelivered (same event_id) must be
    deduped — only one reply is sent.  This validates the replay-protection path
    that the back-to-back fix must not break.
    """
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    posts = []

    monkeypatch.setattr(main, "_post_slack_thread_reply", lambda **kwargs: posts.append(kwargs))
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kwargs: posts.append(kwargs))

    body = json.dumps(
        {
            "type": "event_callback",
            "team_id": "T123",
            "event_id": "EvRedelivered",
            "authorizations": [{"user_id": "U999"}],
            "event": {
                "type": "app_mention",
                "channel": "C123",
                "ts": "1710000001.000001",
                "text": "<@U999> redelivered message",
                "user": "U111",
            },
        }
    ).encode("utf-8")

    with TestClient(main.app) as client:
        first = client.post("/slack/events", data=body, headers=_slack_headers(body))
        second = client.post("/slack/events", data=body, headers=_slack_headers(body))

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json() == {"ok": True, "duplicate": True}, "redelivery must be rejected as duplicate"
    assert len(posts) == 1, "exactly one reply must be sent despite redelivery"


def test_fallback_dedup_key_when_event_id_absent(monkeypatch, tmp_path):
    """When event_id is absent, the fallback composite key (type:channel:ts) is
    used.  Two payloads with the same type+channel+ts but no event_id must dedup;
    two payloads with different ts values must both be processed.
    """
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    posts = []

    monkeypatch.setattr(main, "_post_slack_thread_reply", lambda **kwargs: posts.append(kwargs))
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kwargs: posts.append(kwargs))

    def _make_body(ts: str) -> bytes:
        return json.dumps(
            {
                "type": "event_callback",
                "team_id": "T123",
                # NO event_id field — tests the fallback composite key path.
                "authorizations": [{"user_id": "U999"}],
                "event": {
                    "type": "app_mention",
                    "channel": "C123",
                    "ts": ts,
                    "text": "<@U999> no event_id message",
                    "user": "U111",
                },
            }
        ).encode("utf-8")

    body_same_ts_1 = _make_body("1710000002.000001")
    body_same_ts_2 = _make_body("1710000002.000001")  # same ts = same composite key
    body_diff_ts = _make_body("1710000002.000002")     # different ts = different key

    with TestClient(main.app) as client:
        r1 = client.post("/slack/events", data=body_same_ts_1, headers=_slack_headers(body_same_ts_1))
        r2 = client.post("/slack/events", data=body_same_ts_2, headers=_slack_headers(body_same_ts_2))
        r3 = client.post("/slack/events", data=body_diff_ts, headers=_slack_headers(body_diff_ts))

    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text
    assert r3.status_code == 200, r3.text
    assert r2.json() == {"ok": True, "duplicate": True}, "same fallback key must dedup"
    assert r3.json().get("duplicate") is not True, "different ts must not dedup"
    assert len(posts) == 2, f"first and third events must trigger replies, got {len(posts)}"
