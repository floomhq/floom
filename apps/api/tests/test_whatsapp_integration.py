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
    import channels.whatsapp as _wa_mod

    captured: list = []

    async def _fake_handle(*, wa_id, text, message_id, profile_name=""):
        captured.append((wa_id, text, message_id))

    # Patch both the main re-export and the actual module reference used by the router.
    monkeypatch.setattr(main, "_handle_whatsapp_message", _fake_handle)
    monkeypatch.setattr(_wa_mod, "_handle_whatsapp_message", _fake_handle)

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
    import channels.whatsapp as _wa_mod

    async def _fake_handle(*, wa_id, text, message_id, profile_name=""):
        return None

    # Patch both the main re-export and the actual module reference used by the router.
    monkeypatch.setattr(main, "_handle_whatsapp_message", _fake_handle)
    monkeypatch.setattr(_wa_mod, "_handle_whatsapp_message", _fake_handle)

    body = json.dumps(_text_payload(message_id="wamid.DEDUP1")).encode("utf-8")
    headers = {"Content-Type": "application/json", "X-Hub-Signature-256": _sign(body)}
    with TestClient(main.app) as client:
        first = client.post("/whatsapp/webhook", content=body, headers=headers)
        second = client.post("/whatsapp/webhook", content=body, headers=headers)
    assert first.json().get("queued") == 1
    assert second.json().get("queued") == 0


def test_unbound_sender_gets_claim_prompt_without_workspace_access(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod
    import channels.common as _common_mod
    sent: list[tuple[str, str]] = []

    async def _boom_collect(**_kwargs):  # pragma: no cover - must never run
        raise AssertionError("unbound sender must not reach workspace chat")

    # Patch both the main re-export and the actual module symbols.
    monkeypatch.setattr(main, "_collect_workspace_agent_reply_for_slack", _boom_collect)
    monkeypatch.setattr(_common_mod, "collect_agent_reply", _boom_collect)
    monkeypatch.setattr(main, "send_whatsapp_text", lambda to, text: sent.append((to, text)))
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

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
    # Short claim URL uses /c/{token} path
    assert "/c/" in sent[0][1]
    assert "24h" in sent[0][1]


def test_bound_senders_route_to_distinct_users(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod
    import channels.common as _common_mod
    routed: list[tuple[str, str]] = []
    sent: list[tuple[str, str]] = []

    with main.get_db() as conn:
        now = main.now_iso()
        # Seed user rows so the user-existence check passes (Phase 3 hardening).
        conn.execute(
            "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', 'admin', ?, ?)",
            ("alice", "alice", now, now),
        )
        conn.execute(
            "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', 'admin', ?, ?)",
            ("bob", "bob", now, now),
        )
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, workspace_id, created_at, updated_at)
            VALUES
                ('491701111111', 'alice', 'Alice', 'active', 'local-default', ?, ?),
                ('491702222222', 'bob', 'Bob', 'active', 'local-default', ?, ?)
            """,
            (now, now, now, now),
        )

    async def _fake_collect(*, message, user_id, conversation_id, source):
        routed.append((user_id, conversation_id))
        return f"reply for {user_id}"

    # Patch both the main re-export and the actual module symbols.
    monkeypatch.setattr(main, "_send_whatsapp_typing_indicator", lambda _message_id: None)
    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _message_id: None)
    monkeypatch.setattr(main, "_collect_workspace_agent_reply_for_slack", _fake_collect)
    # collect_agent_reply is imported directly into channels.whatsapp namespace.
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", _fake_collect)
    monkeypatch.setattr(main, "send_whatsapp_text", lambda to, text: sent.append((to, text)))
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

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
# Phase 3: workspace pinning at claim time
# --------------------------------------------------------------------------- #

def test_claim_pins_workspace_id_to_local_default(monkeypatch, tmp_path):
    """claim_whatsapp_sender stores workspace_id = 'local-default' for a local deploy."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    # Seed a pending binding.
    with main.get_db() as conn:
        now = main.now_iso()
        expires = "2099-01-01T00:00:00+00:00"
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, claim_token,
                 claim_expires_at, created_at, updated_at)
            VALUES ('49170999', NULL, 'Test', 'pending', 'tok-pin-ws', ?, ?, ?)
            """,
            (expires, now, now),
        )

    with TestClient(main.app) as client:
        resp = client.post(
            "/whatsapp/bindings/claim",
            json={"token": "tok-pin-ws"},
            headers={"x-floom-secret": "test-api-secret"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["workspace_id"] == "local-default"

    # Verify DB state.
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status, workspace_id, claim_token FROM whatsapp_sender_bindings WHERE wa_id = '49170999'"
        ).fetchone()
    assert row["status"] == "active"
    assert row["workspace_id"] == "local-default"
    # Token must be cleared (single-use).
    assert row["claim_token"] is None


def test_claim_token_is_single_use(monkeypatch, tmp_path):
    """The same claim token cannot be used twice."""
    main = _load_api(monkeypatch, tmp_path)

    with main.get_db() as conn:
        now = main.now_iso()
        expires = "2099-01-01T00:00:00+00:00"
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, claim_token,
                 claim_expires_at, created_at, updated_at)
            VALUES ('49170111', NULL, 'Test', 'pending', 'tok-single', ?, ?, ?)
            """,
            (expires, now, now),
        )

    with TestClient(main.app) as client:
        first = client.post(
            "/whatsapp/bindings/claim",
            json={"token": "tok-single"},
            headers={"x-floom-secret": "test-api-secret"},
        )
        assert first.status_code == 200
        # Second attempt with the same token must fail.
        second = client.post(
            "/whatsapp/bindings/claim",
            json={"token": "tok-single"},
            headers={"x-floom-secret": "test-api-secret"},
        )
    assert second.status_code == 404


def test_reclaim_notifies_old_bound_user(monkeypatch, tmp_path):
    """Re-claiming an active binding sends a notification to the old bound wa_id."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    # Seed an ACTIVE binding for user 'old-user'.
    with main.get_db() as conn:
        now = main.now_iso()
        expires = "2099-01-01T00:00:00+00:00"
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, claim_token,
                 claim_expires_at, created_at, updated_at)
            VALUES ('49170222', 'old-user', 'Old', 'pending', 'tok-reclaim', ?, ?, ?)
            """,
            (expires, now, now),
        )

    with TestClient(main.app) as client:
        resp = client.post(
            "/whatsapp/bindings/claim",
            json={"token": "tok-reclaim"},
            headers={"x-floom-secret": "test-api-secret"},
        )
    assert resp.status_code == 200
    # Notification must have been sent to the wa_id (same number).
    assert any("49170222" == to and "linked to a different" in msg for to, msg in sent)


def test_claim_sends_emily_welcome_to_bound_sender(monkeypatch, tmp_path):
    """A successful claim sends exactly one Emily welcome to the bound wa_id."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    # Seed a pending binding with NO prior owner (fresh link, no rebind notice).
    with main.get_db() as conn:
        now = main.now_iso()
        expires = "2099-01-01T00:00:00+00:00"
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, claim_token,
                 claim_expires_at, created_at, updated_at)
            VALUES ('49170666', NULL, 'Test', 'pending', 'tok-welcome', ?, ?, ?)
            """,
            (expires, now, now),
        )

    with TestClient(main.app) as client:
        resp = client.post(
            "/whatsapp/bindings/claim",
            json={"token": "tok-welcome"},
            headers={"x-floom-secret": "test-api-secret"},
        )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    # Exactly one send, to the bound number, with the Emily welcome copy.
    welcomes = [(to, msg) for to, msg in sent if to == "49170666"]
    assert len(welcomes) == 1, f"expected one welcome send, got {sent}"
    to, msg = welcomes[0]
    assert "Emily" in msg
    assert "chief of staff" in msg.lower()
    assert "connected" in msg.lower()
    # WhatsApp dialect: single-asterisk emphasis only, never markdown bold (**).
    assert "**" not in msg


def test_claim_welcome_failure_does_not_break_claim(monkeypatch, tmp_path):
    """If the Emily welcome send raises, the claim still succeeds (best-effort)."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    def _boom(to, text):
        raise RuntimeError("graph api down")

    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", _boom)

    with main.get_db() as conn:
        now = main.now_iso()
        expires = "2099-01-01T00:00:00+00:00"
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, claim_token,
                 claim_expires_at, created_at, updated_at)
            VALUES ('49170777', NULL, 'Test', 'pending', 'tok-welcome-fail', ?, ?, ?)
            """,
            (expires, now, now),
        )

    with TestClient(main.app) as client:
        resp = client.post(
            "/whatsapp/bindings/claim",
            json={"token": "tok-welcome-fail"},
            headers={"x-floom-secret": "test-api-secret"},
        )
    # Claim must still return ok despite the welcome send blowing up.
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    # And the binding must be active.
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status, claim_token FROM whatsapp_sender_bindings WHERE wa_id = '49170777'"
        ).fetchone()
    assert row["status"] == "active"
    assert row["claim_token"] is None


def test_scoped_run_uses_workspace_pinned_user_id(monkeypatch, tmp_path):
    """_handle_whatsapp_message calls collect_agent_reply with the workspace-scoped user_id."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod
    import channels.common as _common_mod

    routed: list[tuple[str, str]] = []
    sent: list[tuple[str, str]] = []

    # Seed an active binding with workspace_id = 'local-default'.
    with main.get_db() as conn:
        now = main.now_iso()
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, workspace_id, created_at, updated_at)
            VALUES ('49170333', 'alice', 'Alice', 'active', 'local-default', ?, ?)
            """,
            (now, now),
        )
        # Seed the user row so the user-existence check passes.
        conn.execute(
            "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', 'admin', ?, ?)",
            ("alice", "alice", now, now),
        )

    async def _fake_collect(*, message, user_id, conversation_id, source):
        routed.append((user_id, conversation_id))
        return f"reply for {user_id}"

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", _fake_collect)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id="49170333", text="hi", message_id="wamid.WS1", profile_name="Alice"
        )
    )

    # workspace_id is 'local-default' → local_workspace_user_id returns base user_id unchanged.
    assert routed == [("alice", "whatsapp:49170333")]
    assert sent == [("49170333", "reply for alice")]


def test_invalid_workspace_resets_binding_and_sends_fresh_claim(monkeypatch, tmp_path):
    """At message time, if the pinned workspace no longer exists, binding resets to pending."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod
    import channels.common as _common_mod

    sent: list[tuple[str, str]] = []

    async def _boom_collect(**_):
        raise AssertionError("must not reach agent with invalid workspace")

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", _boom_collect)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    with main.get_db() as conn:
        now = main.now_iso()
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, workspace_id, created_at, updated_at)
            VALUES ('49170444', 'alice', 'Alice', 'active', 'ws_doesnotexist', ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', 'admin', ?, ?)",
            ("alice", "alice", now, now),
        )

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id="49170444", text="hi", message_id="wamid.IVWS1", profile_name="Alice"
        )
    )

    # A re-claim link must have been sent (as a short /c/{token} URL).
    assert sent
    assert any("/c/" in msg for _, msg in sent)

    # Binding must now be pending.
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status FROM whatsapp_sender_bindings WHERE wa_id = '49170444'"
        ).fetchone()
    assert row["status"] == "pending"


def test_new_claim_invalidates_prior_pending_token(monkeypatch, tmp_path):
    """Sending another message from an unbound wa_id rotates the pending claim token."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod
    import channels.common as _common_mod

    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    async def _boom_collect(**_):
        raise AssertionError("unbound sender must not reach agent")

    monkeypatch.setattr(_wa_mod, "collect_agent_reply", _boom_collect)

    # First message → creates a pending claim with token T1.
    asyncio.run(
        main._handle_whatsapp_message(
            wa_id="49170555", text="first", message_id="wamid.FIRST", profile_name="Test"
        )
    )
    with main.get_db() as conn:
        row1 = conn.execute(
            "SELECT claim_token FROM whatsapp_sender_bindings WHERE wa_id = '49170555'"
        ).fetchone()
    token1 = row1["claim_token"]
    assert token1 is not None

    # Second message → must rotate to a new token T2.
    asyncio.run(
        main._handle_whatsapp_message(
            wa_id="49170555", text="second", message_id="wamid.SECOND", profile_name="Test"
        )
    )
    with main.get_db() as conn:
        row2 = conn.execute(
            "SELECT claim_token FROM whatsapp_sender_bindings WHERE wa_id = '49170555'"
        ).fetchone()
    token2 = row2["claim_token"]
    assert token2 is not None
    assert token2 != token1, "Pending claim token must be rotated on new message"


# --------------------------------------------------------------------------- #
# Short-link redirect GET /c/{token}
# --------------------------------------------------------------------------- #

def test_shortlink_redirects_to_whatsapp_claim(monkeypatch, tmp_path):
    """GET /c/{token} resolves a pending WA token to /settings?whatsapp_claim=…."""
    main = _load_api(monkeypatch, tmp_path)
    with main.get_db() as conn:
        now = main.now_iso()
        expires = "2099-01-01T00:00:00+00:00"
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, claim_token,
                 claim_expires_at, created_at, updated_at)
            VALUES ('4917099999', NULL, 'Test', 'pending', 'shorttest', ?, ?, ?)
            """,
            (expires, now, now),
        )
    with TestClient(main.app, follow_redirects=False) as client:
        resp = client.get("/c/shorttest")
    assert resp.status_code == 302
    assert "whatsapp_claim=shorttest" in resp.headers["location"]


def test_shortlink_redirects_to_slack_claim(monkeypatch, tmp_path):
    """GET /c/{token} resolves a pending Slack token to /settings?slack_claim=…."""
    main = _load_api(monkeypatch, tmp_path)
    with main.get_db() as conn:
        now = main.now_iso()
        expires = "2099-01-01T00:00:00+00:00"
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, user_id, profile_name, status,
                 claim_token, claim_expires_at, created_at, updated_at, last_seen_at)
            VALUES ('T123', 'U999', NULL, 'Test', 'pending', 'slackshort', ?, ?, ?, ?)
            """,
            (expires, now, now, now),
        )
    with TestClient(main.app, follow_redirects=False) as client:
        resp = client.get("/c/slackshort")
    assert resp.status_code == 302
    assert "slack_claim=slackshort" in resp.headers["location"]


def test_shortlink_returns_404_for_unknown_token(monkeypatch, tmp_path):
    """GET /c/unknown returns 404."""
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.get("/c/no-such-token-xyz")
    assert resp.status_code == 404


def test_shortlink_returns_404_for_expired_token(monkeypatch, tmp_path):
    """GET /c/{token} returns 404 for an expired pending token."""
    main = _load_api(monkeypatch, tmp_path)
    with main.get_db() as conn:
        now = main.now_iso()
        expired = "2000-01-01T00:00:00+00:00"
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, claim_token,
                 claim_expires_at, created_at, updated_at)
            VALUES ('4917088888', NULL, 'Test', 'pending', 'expiredtok', ?, ?, ?)
            """,
            (expired, now, now),
        )
    with TestClient(main.app) as client:
        resp = client.get("/c/expiredtok")
    assert resp.status_code == 404


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
