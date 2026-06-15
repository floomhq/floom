"""Tests for per-user Slack DM claim-linking (Phase 2 of channels-flow workplan).

Covers:
- Unbound DM sender gets a claim link reply and NO agent run.
- Bound DM sender runs as the bound user.
- Claim endpoint binds the sender to the authenticated user (single-use).
- Single-use: a consumed token is rejected on second claim attempt.
- New claim invalidates the prior pending claim for the same sender.
- Channel mention returns a pointer message, NOT an agent reply.
- Interactivity: unbound clicker gets an ephemeral claim-link message; no action taken.
- Interactivity: bound clicker acts as their linked user.
- Migration 64 creates the slack_sender_bindings table.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import importlib
import json
import sys
import time
import types
import urllib.parse
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


SLACK_SIGNING_SECRET = "test-slack-signing-secret"
SLACK_BOT_TOKEN = "xoxb-test-token"
SLACK_TEAM_ID = "T123"


def _load_api(monkeypatch, tmp_path, *, extra_env: dict | None = None):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "slack-test-user")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", SLACK_SIGNING_SECRET)
    monkeypatch.setenv("SLACK_BOT_TOKEN", SLACK_BOT_TOKEN)
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", SLACK_TEAM_ID)
    monkeypatch.setenv("SLACK_LEGACY_SINGLE_USER", "0")
    # Disable WhatsApp to avoid credential warnings.
    for var in ("WHATSAPP_PHONE_ID", "WHATSAPP_TOKEN", "WHATSAPP_APP_SECRET"):
        monkeypatch.setenv(var, "")
    for key, val in (extra_env or {}).items():
        monkeypatch.setenv(key, val)

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "chat_service",
                 "channels.slack", "channels.whatsapp", "channels.common"]:
        sys.modules.pop(name, None)
        for _rn in [n for n in list(sys.modules) if n.startswith("routers")]:
            sys.modules.pop(_rn, None)
    # Clear sub-modules that may have been cached.
    for key in list(sys.modules.keys()):
        if key.startswith("channels"):
            sys.modules.pop(key, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _slack_sig_headers(
    body: bytes,
    secret: str = SLACK_SIGNING_SECRET,
    ts: int | None = None,
    content_type: str = "application/json",
) -> dict:
    timestamp = str(ts or int(time.time()))
    base = b"v0:" + timestamp.encode("utf-8") + b":" + body
    sig = "v0=" + hmac.new(secret.encode("utf-8"), base, hashlib.sha256).hexdigest()
    return {
        "Content-Type": content_type,
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": sig,
    }


def _form_body(data: dict) -> bytes:
    return urllib.parse.urlencode(data).encode("utf-8")


def _dm_event_body(slack_user_id: str = "U456", text: str = "hello emily") -> bytes:
    payload = {
        "type": "event_callback",
        "team_id": SLACK_TEAM_ID,
        "event_id": f"EvDM-{slack_user_id}-{time.time_ns()}",
        "event": {
            "type": "message",
            "channel_type": "im",
            "channel": "D111",
            "ts": "1710000000.000001",
            "text": text,
            "user": slack_user_id,
        },
    }
    return json.dumps(payload).encode("utf-8")


def _mention_event_body(slack_user_id: str = "U456", text: str = "<@U999> hello") -> bytes:
    payload = {
        "type": "event_callback",
        "team_id": SLACK_TEAM_ID,
        "event_id": f"EvMention-{slack_user_id}-{time.time_ns()}",
        "authorizations": [{"user_id": "U999"}],
        "event": {
            "type": "app_mention",
            "channel": "C123",
            "ts": "1710000001.000001",
            "text": text,
            "user": slack_user_id,
        },
    }
    return json.dumps(payload).encode("utf-8")


def _interactivity_form(
    action_id: str,
    run_id: str,
    slack_user_id: str = "U456",
    team_id: str = SLACK_TEAM_ID,
) -> bytes:
    payload = {
        "team": {"id": team_id},
        "user": {"id": slack_user_id},
        "actions": [
            {
                "action_id": action_id,
                "value": json.dumps({"run_id": run_id}),
            }
        ],
    }
    return _form_body({"payload": json.dumps(payload)})


# ---------------------------------------------------------------------------
# Migration smoke
# ---------------------------------------------------------------------------

def test_migration_64_creates_slack_sender_bindings_table(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='slack_sender_bindings'"
        ).fetchone()
    assert row is not None, "migration 64 must create slack_sender_bindings"


# ---------------------------------------------------------------------------
# Unbound DM -> claim link, no agent run
# ---------------------------------------------------------------------------

def test_unbound_dm_sender_gets_claim_link_no_agent_run(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    import channels.common as _common_mod

    agent_calls: list = []
    posts: list = []

    async def _boom_collect(**_kwargs):
        agent_calls.append(_kwargs)
        return "should not happen"

    monkeypatch.setattr(_common_mod, "collect_agent_reply", _boom_collect)
    monkeypatch.setattr(_slack_mod, "collect_agent_reply", _boom_collect)
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kw: posts.append(kw))
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply_blocks", lambda **kw: posts.append(kw))

    body = _dm_event_body(slack_user_id="U_UNBOUND")
    with TestClient(main.app) as client:
        resp = client.post(
            "/slack/events",
            content=body,
            headers=_slack_sig_headers(body),
        )

    assert resp.status_code == 200
    assert resp.json().get("status") == "queued"
    # Background task ran synchronously in TestClient.
    assert agent_calls == [], "agent must NOT be invoked for unbound sender"
    assert posts, "claim-link message must be posted"
    # text or blocks should contain the short /c/{token} URL with expiry
    combined = posts[0].get("text", "") + str(posts[0].get("blocks", ""))
    assert "/c/" in combined, "claim link must use short /c/{token} URL"
    assert "24h" in combined


# ---------------------------------------------------------------------------
# Bound DM sender -> runs as bound user
# ---------------------------------------------------------------------------

def test_bound_dm_sender_runs_as_bound_user(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    import channels.common as _common_mod

    # Insert an active binding.
    with main.get_db() as conn:
        now = main.now_iso()
        # A real bound user exists in the users table. With FLOOM_SECRET set
        # (configured deployment), bound_user_is_valid now fails closed for a
        # binding whose user_id has NO users row (Codex finding #7), so the
        # bound user must be a genuine account for the binding to stay active.
        conn.execute(
            "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) "
            "VALUES ('alice', 'alice', 'x', 'admin', ?, ?)",
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, user_id, profile_name, status,
                 created_at, updated_at)
            VALUES (?, ?, 'alice', 'Alice', 'active', ?, ?)
            """,
            (SLACK_TEAM_ID, "U_BOUND", now, now),
        )

    routed: list[str] = []
    posts: list = []

    async def _fake_collect(*, message, user_id, conversation_id, **kwargs):
        routed.append(user_id)
        return f"reply for {user_id}"

    monkeypatch.setattr(_common_mod, "collect_agent_reply", _fake_collect)
    monkeypatch.setattr(_slack_mod, "collect_agent_reply", _fake_collect)
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kw: posts.append(kw))
    monkeypatch.setattr(_slack_mod, "_set_slack_assistant_status", lambda **kw: None)

    body = _dm_event_body(slack_user_id="U_BOUND", text="list my workers")
    with TestClient(main.app) as client:
        resp = client.post(
            "/slack/events",
            content=body,
            headers=_slack_sig_headers(body),
        )

    assert resp.status_code == 200
    assert routed == ["alice"]
    assert posts and "reply for alice" in posts[0]["text"]


# ---------------------------------------------------------------------------
# Claim endpoint: binds sender, single-use, invalidation
# ---------------------------------------------------------------------------

def test_claim_endpoint_binds_sender(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    # Create a pending claim.
    claim = _slack_mod._slack_create_claim(SLACK_TEAM_ID, "U_CLAIMTEST", "Tester")
    token = claim["claim_token"]

    with TestClient(main.app) as client:
        resp = client.post(
            "/slack/bindings/claim",
            json={"token": token},
            headers={"x-floom-secret": "test-api-secret"},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["slack_team_id"] == SLACK_TEAM_ID
    assert body["slack_user_id"] == "U_CLAIMTEST"
    assert body["user_id"] is not None

    # Verify binding is active in DB.
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status, claim_token FROM slack_sender_bindings WHERE slack_team_id=? AND slack_user_id=?",
            (SLACK_TEAM_ID, "U_CLAIMTEST"),
        ).fetchone()
    assert row["status"] == "active"
    assert row["claim_token"] is None, "token must be cleared after claim (single-use)"


def test_claim_sends_emily_welcome_dm(monkeypatch, tmp_path):
    """A successful Slack claim DMs an Emily welcome to the bound user."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    dms: list[dict] = []
    monkeypatch.setattr(_slack_mod, "_post_slack_dm", lambda **kw: dms.append(kw))

    claim = _slack_mod._slack_create_claim(SLACK_TEAM_ID, "U_WELCOME", "Welcome")
    token = claim["claim_token"]

    with TestClient(main.app) as client:
        resp = client.post(
            "/slack/bindings/claim",
            json={"token": token},
            headers={"x-floom-secret": "test-api-secret"},
        )
    assert resp.status_code == 200

    welcomes = [d for d in dms if d.get("slack_user_id") == "U_WELCOME"]
    assert len(welcomes) == 1, f"expected one welcome DM, got {dms}"
    text = welcomes[0]["text"]
    assert "Emily" in text
    assert "chief of staff" in text.lower()
    assert "connected" in text.lower()
    assert "**" not in text


def test_claim_welcome_dm_failure_does_not_break_claim(monkeypatch, tmp_path):
    """If the Emily welcome DM raises, the Slack claim still succeeds."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    def _boom(**kw):
        raise RuntimeError("slack api down")

    monkeypatch.setattr(_slack_mod, "_post_slack_dm", _boom)

    claim = _slack_mod._slack_create_claim(SLACK_TEAM_ID, "U_WELCOME_FAIL", "WelcomeFail")
    token = claim["claim_token"]

    with TestClient(main.app) as client:
        resp = client.post(
            "/slack/bindings/claim",
            json={"token": token},
            headers={"x-floom-secret": "test-api-secret"},
        )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status, claim_token FROM slack_sender_bindings WHERE slack_team_id=? AND slack_user_id=?",
            (SLACK_TEAM_ID, "U_WELCOME_FAIL"),
        ).fetchone()
    assert row["status"] == "active"
    assert row["claim_token"] is None


def test_claim_token_is_single_use(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    claim = _slack_mod._slack_create_claim(SLACK_TEAM_ID, "U_ONCE", "Once")
    token = claim["claim_token"]

    with TestClient(main.app) as client:
        first = client.post(
            "/slack/bindings/claim",
            json={"token": token},
            headers={"x-floom-secret": "test-api-secret"},
        )
        second = client.post(
            "/slack/bindings/claim",
            json={"token": token},
            headers={"x-floom-secret": "test-api-secret"},
        )

    assert first.status_code == 200
    assert second.status_code == 404, "consumed token must be rejected on second attempt"


def test_new_claim_replaces_prior_pending_claim(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    claim1 = _slack_mod._slack_create_claim(SLACK_TEAM_ID, "U_REPLACE", "Replace")
    token1 = claim1["claim_token"]
    # Create a new claim for the same sender — invalidates the first.
    claim2 = _slack_mod._slack_create_claim(SLACK_TEAM_ID, "U_REPLACE", "Replace")
    token2 = claim2["claim_token"]

    assert token1 != token2, "new claim should produce a new token"

    with TestClient(main.app) as client:
        resp1 = client.post(
            "/slack/bindings/claim",
            json={"token": token1},
            headers={"x-floom-secret": "test-api-secret"},
        )
        resp2 = client.post(
            "/slack/bindings/claim",
            json={"token": token2},
            headers={"x-floom-secret": "test-api-secret"},
        )

    # First token was overwritten by the second claim creation.
    assert resp1.status_code == 404, "prior pending token must be invalidated by new claim"
    assert resp2.status_code == 200, "new token must be claimable"


def test_claim_endpoint_rejects_unknown_token(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.post(
            "/slack/bindings/claim",
            json={"token": "totally-unknown-token"},
            headers={"x-floom-secret": "test-api-secret"},
        )
    assert resp.status_code == 404


def test_claim_endpoint_requires_auth(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    claim = _slack_mod._slack_create_claim(SLACK_TEAM_ID, "U_NOAUTH", "NoAuth")
    with TestClient(main.app) as client:
        resp = client.post("/slack/bindings/claim", json={"token": claim["claim_token"]})
    # No auth header -> 401 or 403.
    assert resp.status_code in {401, 403}


# ---------------------------------------------------------------------------
# Channel mention -> pointer reply, no agent run
# ---------------------------------------------------------------------------

def test_mention_returns_pointer_not_agent_reply(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod
    import channels.common as _common_mod

    agent_calls: list = []
    posts: list = []

    async def _boom_collect(**_kwargs):
        agent_calls.append(_kwargs)
        return "should not happen"

    monkeypatch.setattr(_common_mod, "collect_agent_reply", _boom_collect)
    monkeypatch.setattr(_slack_mod, "collect_agent_reply", _boom_collect)
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kw: posts.append(kw))

    body = _mention_event_body(slack_user_id="U_MENTION")
    with TestClient(main.app) as client:
        resp = client.post(
            "/slack/events",
            content=body,
            headers=_slack_sig_headers(body),
        )

    assert resp.status_code == 200
    assert agent_calls == [], "agent must NOT be invoked from channel mention"
    assert posts, "a reply must be posted"
    reply_text = posts[0]["text"]
    assert "DM" in reply_text or "direct message" in reply_text.lower()


def test_mention_unbound_delivers_claim_link_privately_not_public(monkeypatch, tmp_path):
    """Codex finding #2: an unbound channel @mention must NEVER post the bearer
    claim token into the public thread (any channel reader could claim the
    mentioner's identity first — takeover).  The public reply is generic with NO
    token; the claim link is delivered privately via chat.postEphemeral targeted
    at the mentioning user."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    public_posts: list = []
    ephemeral_posts: list = []
    dm_posts: list = []
    monkeypatch.setattr(_slack_mod, "collect_agent_reply", lambda **kw: "nope")
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kw: public_posts.append(kw))
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply_blocks", lambda **kw: public_posts.append(kw))
    monkeypatch.setattr(_slack_mod, "_post_slack_ephemeral", lambda **kw: ephemeral_posts.append(kw))
    monkeypatch.setattr(_slack_mod, "_post_slack_dm", lambda **kw: dm_posts.append(kw))

    body = _mention_event_body(slack_user_id="U_UNBOUND_MENTION")
    with TestClient(main.app) as client:
        client.post("/slack/events", content=body, headers=_slack_sig_headers(body))

    # Public thread reply exists but carries NO claim token.
    assert public_posts
    public_combined = public_posts[0].get("text", "") + str(public_posts[0].get("blocks", ""))
    assert "/c/" not in public_combined
    assert "claim" not in public_combined.lower()

    # The claim link is delivered privately to the mentioning user only.
    assert ephemeral_posts, "claim link must be delivered via ephemeral message"
    eph = ephemeral_posts[0]
    assert eph.get("user") == "U_UNBOUND_MENTION"
    eph_combined = eph.get("text", "") + str(eph.get("blocks", ""))
    assert "/c/" in eph_combined


def test_mention_no_claim_link_for_already_bound_mentioner(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    # Pre-bind the user.
    with main.get_db() as conn:
        now = main.now_iso()
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, user_id, profile_name, status, created_at, updated_at)
            VALUES (?, ?, 'charlie', 'Charlie', 'active', ?, ?)
            """,
            (SLACK_TEAM_ID, "U_BOUND_MENTION", now, now),
        )

    posts: list = []
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kw: posts.append(kw))

    body = _mention_event_body(slack_user_id="U_BOUND_MENTION")
    with TestClient(main.app) as client:
        client.post("/slack/events", content=body, headers=_slack_sig_headers(body))

    assert posts
    assert "slack_claim=" not in posts[0]["text"]


# ---------------------------------------------------------------------------
# Interactivity: unbound clicker blocked, bound clicker acts as their user
# ---------------------------------------------------------------------------

def test_interactivity_unbound_clicker_gets_claim_link(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    form = _interactivity_form("workeros_approval_approve", "run_999", slack_user_id="U_UNBOUND_CLICK")
    with TestClient(main.app) as client:
        resp = client.post(
            "/slack/interactivity",
            content=form,
            headers=_slack_sig_headers(form, content_type="application/x-www-form-urlencoded"),
        )

    assert resp.status_code == 200
    body = resp.json()
    # Must return an ephemeral claim-link prompt, NOT a confirmation of approval.
    # The short /c/{token} URL should appear in text or blocks.
    full_text = body.get("text", "") + str(body.get("blocks", ""))
    assert "/c/" in full_text, (
        "unbound clicker must receive a short claim link, not an approval confirmation"
    )
    assert "Approved" not in body.get("text", "")


def test_interactivity_bound_clicker_can_dismiss(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)

    # Bind the clicker.
    with main.get_db() as conn:
        now = main.now_iso()
        # Real bound user row required in configured mode (Codex finding #7).
        conn.execute(
            "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) "
            "VALUES ('dave', 'dave', 'x', 'admin', ?, ?)",
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, user_id, profile_name, status, created_at, updated_at)
            VALUES (?, ?, 'dave', 'Dave', 'active', ?, ?)
            """,
            (SLACK_TEAM_ID, "U_BOUND_CLICK", now, now),
        )

    form = _interactivity_form("workeros_approval_dismiss", "run_888", slack_user_id="U_BOUND_CLICK")
    with TestClient(main.app) as client:
        resp = client.post(
            "/slack/interactivity",
            content=form,
            headers=_slack_sig_headers(form, content_type="application/x-www-form-urlencoded"),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body.get("replace_original") is True
    assert "Dismissed" in body.get("text", "")


# ---------------------------------------------------------------------------
# Legacy single-user fallback (SLACK_LEGACY_SINGLE_USER=1)
# ---------------------------------------------------------------------------

def test_legacy_mode_dm_routes_to_bootstrap_user(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, extra_env={"SLACK_LEGACY_SINGLE_USER": "1"})
    import channels.slack as _slack_mod
    import channels.common as _common_mod

    routed: list[str] = []

    async def _fake_collect(*, message, user_id, conversation_id, **kwargs):
        routed.append(user_id)
        return "legacy reply"

    monkeypatch.setattr(_common_mod, "collect_agent_reply", _fake_collect)
    monkeypatch.setattr(_slack_mod, "collect_agent_reply", _fake_collect)
    monkeypatch.setattr(_slack_mod, "_post_slack_thread_reply", lambda **kw: None)
    monkeypatch.setattr(_slack_mod, "_set_slack_assistant_status", lambda **kw: None)

    body = _dm_event_body(slack_user_id="U_LEGACY_UNBOUND")
    with TestClient(main.app) as client:
        resp = client.post("/slack/events", content=body, headers=_slack_sig_headers(body))

    assert resp.status_code == 200
    assert routed, "legacy mode must run the agent even for unbound sender"


# ---------------------------------------------------------------------------
# Short claim-link host (regression: /c/ must resolve on the host that serves it)
# ---------------------------------------------------------------------------

def test_slack_short_claim_url_built_on_host_that_serves_c(monkeypatch, tmp_path):
    """The short /c/ link MUST be built on the API host that actually serves /c/.

    The /c/{token} redirect route lives on the FastAPI app
    (workers-api.floom.dev), NOT on the Next.js web app (workers.floom.dev).
    Building it on WORKERS_FRONTEND_URL produced a dead link. Must use the
    public API base.
    """
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://workers.floom.dev")
    monkeypatch.setenv("WORKEROS_PUBLIC_API_URL", "https://workers-api.floom.dev")

    short_url = _slack_mod._slack_short_claim_url("tok456")
    assert short_url == "https://workers-api.floom.dev/c/tok456"
    assert "/c/" in short_url
    # The long claim URL still targets the frontend /settings page (unchanged).
    assert _slack_mod._slack_claim_url("tok456") == (
        "https://workers.floom.dev/settings?slack_claim=tok456"
    )


def test_slack_short_claim_url_defaults_to_api_host(monkeypatch, tmp_path):
    """With no overrides, the short link defaults to the API host, not the web host."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.slack as _slack_mod

    for var in ("WORKEROS_PUBLIC_API_URL", "WORKEROS_API_URL", "WORKERS_API_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://workers.floom.dev")

    short_url = _slack_mod._slack_short_claim_url("deftok2")
    assert short_url == "https://workeros-api.floom.dev/c/deftok2"
