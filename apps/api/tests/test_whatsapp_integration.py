"""WhatsApp integration (Meta WhatsApp Business Cloud API) — webhook verify,
signature verify, payload parse, send chunking, the new "whatsapp" env note, and
graceful-no-creds behavior.

Mirrors the Slack integration: same stream_chat pipeline, same _claim_webhook_delivery
dedup, same fast-ACK + background-task pattern. The endpoints are inert and fail
closed when the WhatsApp env vars are absent, so an unconfigured deploy is safe.
"""

from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import sys
import types
import asyncio
from pathlib import Path

from fastapi.testclient import TestClient


VERIFY_TOKEN = "wk_workeros_verify_test"
APP_SECRET = "test-whatsapp-app-secret"
PHONE_ID = "1234567890"
TOKEN = "test-whatsapp-token"


def _load_api(monkeypatch, tmp_path, *, with_creds: bool = True):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "wa-test-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")

    if with_creds:
        monkeypatch.setenv("WHATSAPP_PHONE_ID", PHONE_ID)
        monkeypatch.setenv("WHATSAPP_TOKEN", TOKEN)
        monkeypatch.setenv("WHATSAPP_APP_SECRET", APP_SECRET)
        monkeypatch.setenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", VERIFY_TOKEN)
    else:
        for var in (
            "WHATSAPP_PHONE_ID",
            "WHATSAPP_TOKEN",
            "WHATSAPP_APP_SECRET",
            "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
        ):
            monkeypatch.setenv(var, "")

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "chat_service"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _sign(body: bytes) -> str:
    return "sha256=" + hmac.new(APP_SECRET.encode("utf-8"), body, hashlib.sha256).hexdigest()


def _text_payload(wa_id: str = "491701234567", text: str = "hello emily", message_id: str = "wamid.ABC123") -> dict:
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "WABA_ID",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "contacts": [{"wa_id": wa_id, "profile": {"name": "Tester"}}],
                            "messages": [
                                {
                                    "from": wa_id,
                                    "id": message_id,
                                    "timestamp": "1700000000",
                                    "type": "text",
                                    "text": {"body": text},
                                }
                            ],
                        },
                    }
                ],
            }
        ],
    }


# --------------------------------------------------------------------------- #
# GET webhook challenge
# --------------------------------------------------------------------------- #

def test_get_challenge_echoes_when_token_matches(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.get(
            "/whatsapp/webhook",
            params={"hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "challenge123"},
        )
    assert resp.status_code == 200
    assert resp.text == "challenge123"


def test_get_challenge_rejects_wrong_token(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.get(
            "/whatsapp/webhook",
            params={"hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "challenge123"},
        )
    assert resp.status_code == 403
    assert resp.text != "challenge123"


def test_get_challenge_rejects_wrong_mode(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.get(
            "/whatsapp/webhook",
            params={"hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "challenge123"},
        )
    assert resp.status_code == 403


def test_get_challenge_fails_closed_with_no_creds(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, with_creds=False)
    with TestClient(main.app) as client:
        resp = client.get(
            "/whatsapp/webhook",
            params={"hub.mode": "subscribe", "hub.verify_token": "anything", "hub.challenge": "challenge123"},
        )
    # No verify token configured -> never echoes the challenge.
    assert resp.status_code == 403
    assert resp.text != "challenge123"


# --------------------------------------------------------------------------- #
# POST webhook signature verification
# --------------------------------------------------------------------------- #

def test_post_accepts_valid_signature_and_queues(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    captured: list = []

    async def _fake_handle(*, wa_id, text, message_id, profile_name=""):
        captured.append((wa_id, text, message_id))

    monkeypatch.setattr(main, "_handle_whatsapp_message", _fake_handle)

    body = json.dumps(_text_payload(text="hi")).encode("utf-8")
    with TestClient(main.app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            content=body,
            headers={"Content-Type": "application/json", "X-Hub-Signature-256": _sign(body)},
        )
    assert resp.status_code == 200
    assert resp.json().get("queued") == 1


def test_post_rejects_invalid_signature(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    body = json.dumps(_text_payload()).encode("utf-8")
    with TestClient(main.app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            content=body,
            headers={"Content-Type": "application/json", "X-Hub-Signature-256": "sha256=deadbeef"},
        )
    assert resp.status_code == 401


def test_post_rejects_missing_signature(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    body = json.dumps(_text_payload()).encode("utf-8")
    with TestClient(main.app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            content=body,
            headers={"Content-Type": "application/json"},
        )
    assert resp.status_code == 401


def test_post_ignores_status_callbacks(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    body = json.dumps(
        {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "changes": [
                        {
                            "field": "messages",
                            "value": {"statuses": [{"id": "wamid.X", "status": "delivered"}]},
                        }
                    ]
                }
            ],
        }
    ).encode("utf-8")
    with TestClient(main.app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            content=body,
            headers={"Content-Type": "application/json", "X-Hub-Signature-256": _sign(body)},
        )
    assert resp.status_code == 200
    assert resp.json().get("ignored") is True


def test_post_dedups_meta_retries(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    async def _fake_handle(*, wa_id, text, message_id, profile_name=""):
        return None

    monkeypatch.setattr(main, "_handle_whatsapp_message", _fake_handle)

    body = json.dumps(_text_payload(message_id="wamid.DEDUP1")).encode("utf-8")
    headers = {"Content-Type": "application/json", "X-Hub-Signature-256": _sign(body)}
    with TestClient(main.app) as client:
        first = client.post("/whatsapp/webhook", content=body, headers=headers)
        second = client.post("/whatsapp/webhook", content=body, headers=headers)
    assert first.json().get("queued") == 1
    assert second.json().get("queued") == 0


def test_unbound_sender_gets_claim_prompt_without_workspace_access(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    sent: list[tuple[str, str]] = []

    async def _boom_collect(**_kwargs):  # pragma: no cover - must never run
        raise AssertionError("unbound sender must not reach workspace chat")

    monkeypatch.setattr(main, "_collect_workspace_agent_reply_for_slack", _boom_collect)
    monkeypatch.setattr(main, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id="491701234567",
            text="list my workers",
            message_id="wamid.UNBOUND",
            profile_name="Tester",
        )
    )

    assert sent
    assert sent[0][0] == "491701234567"
    assert "whatsapp_claim=" in sent[0][1]
    assert "before I can access any workers" in sent[0][1]


def test_bound_senders_route_to_distinct_users(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    routed: list[tuple[str, str]] = []
    sent: list[tuple[str, str]] = []

    with main.get_db() as conn:
        now = main.now_iso()
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, created_at, updated_at)
            VALUES
                ('491701111111', 'alice', 'Alice', 'active', ?, ?),
                ('491702222222', 'bob', 'Bob', 'active', ?, ?)
            """,
            (now, now, now, now),
        )

    async def _fake_collect(*, message, user_id, conversation_id, source):
        routed.append((user_id, conversation_id))
        return f"reply for {user_id}"

    monkeypatch.setattr(main, "_send_whatsapp_typing_indicator", lambda _message_id: None)
    monkeypatch.setattr(main, "_collect_workspace_agent_reply_for_slack", _fake_collect)
    monkeypatch.setattr(main, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    asyncio.run(main._handle_whatsapp_message(wa_id="491701111111", text="hi", message_id="wamid.A"))
    asyncio.run(main._handle_whatsapp_message(wa_id="491702222222", text="hi", message_id="wamid.B"))

    assert routed == [
        ("alice", "whatsapp:491701111111"),
        ("bob", "whatsapp:491702222222"),
    ]
    assert sent == [
        ("491701111111", "reply for alice"),
        ("491702222222", "reply for bob"),
    ]


# --------------------------------------------------------------------------- #
# Graceful pre-creds
# --------------------------------------------------------------------------- #

def test_post_returns_503_when_no_creds(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, with_creds=False)
    body = json.dumps(_text_payload()).encode("utf-8")
    with TestClient(main.app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            content=body,
            headers={"Content-Type": "application/json"},
        )
    assert resp.status_code == 503


def test_app_boots_and_health_green_without_creds(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, with_creds=False)
    with TestClient(main.app) as client:
        resp = client.get("/health", headers={"x-floom-secret": "test-api-secret"})
    assert resp.status_code == 200


# --------------------------------------------------------------------------- #
# Helper units: parse, sign, chunk
# --------------------------------------------------------------------------- #

def test_parse_extracts_text_message(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    events = main._parse_whatsapp_inbound(_text_payload(wa_id="49170", text="ping", message_id="wamid.P"))
    assert len(events) == 1
    assert events[0]["wa_id"] == "49170"
    assert events[0]["text"] == "ping"
    assert events[0]["message_id"] == "wamid.P"
    assert events[0]["profile_name"] == "Tester"


def test_parse_ignores_non_text_and_wrong_object(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    # Wrong object envelope.
    assert main._parse_whatsapp_inbound({"object": "page", "entry": []}) == []
    # Image message (non-text) is ignored.
    image_payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messages": [
                                {"from": "49170", "id": "wamid.IMG", "type": "image", "image": {"id": "media1"}}
                            ]
                        },
                    }
                ]
            }
        ],
    }
    assert main._parse_whatsapp_inbound(image_payload) == []


def test_signature_verify_unit(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    class _Req:
        def __init__(self, sig):
            self.headers = {"X-Hub-Signature-256": sig} if sig is not None else {}

    body = b'{"hello":"world"}'
    good = "sha256=" + hmac.new(APP_SECRET.encode("utf-8"), body, hashlib.sha256).hexdigest()
    assert main._verify_whatsapp_signature(body, _Req(good), APP_SECRET) is True
    assert main._verify_whatsapp_signature(body, _Req("sha256=bad"), APP_SECRET) is False
    assert main._verify_whatsapp_signature(body, _Req(None), APP_SECRET) is False
    # No secret -> fail closed.
    assert main._verify_whatsapp_signature(body, _Req(good), "") is False


def test_chunking_splits_long_text(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    short = main._split_whatsapp_text("hello")
    assert short == ["hello"]

    long_text = "x" * 5000
    chunks = main._split_whatsapp_text(long_text)
    assert len(chunks) >= 2
    assert all(len(c) <= main.WHATSAPP_TEXT_MAX for c in chunks)
    assert "".join(chunks) == long_text

    assert main._split_whatsapp_text("") == []
    assert main._split_whatsapp_text("   ") == []


def test_send_whatsapp_text_chunks_and_posts(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    calls: list = []

    class _Resp:
        ok = True
        status_code = 200

        def json(self):
            return {}

    def _fake_post(url, headers=None, json=None, timeout=None):
        calls.append(json)
        return _Resp()

    monkeypatch.setattr(main.requests, "post", _fake_post)

    # Two paragraphs over the limit -> at least 2 POSTs.
    para = "a" * 4000
    main.send_whatsapp_text("49170", f"{para}\n\n{para}")
    assert len(calls) >= 2
    assert all(c.get("messaging_product") == "whatsapp" and c.get("to") == "49170" for c in calls)


# --------------------------------------------------------------------------- #
# Env note
# --------------------------------------------------------------------------- #

def test_whatsapp_env_note_present_and_distinct():
    api_dir = Path(__file__).resolve().parents[1]
    if str(api_dir) not in sys.path:
        sys.path.insert(0, str(api_dir))
    sys.modules.pop("chat_service", None)
    import chat_service  # noqa: E402

    note = chat_service._environment_note("whatsapp")
    assert "WhatsApp" in note
    assert note != chat_service._environment_note("slack")
    assert note != chat_service._environment_note("web")
    # Stays short.
    assert note.count("\n") <= 4
