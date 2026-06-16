"""Slack approval push-parity tests (#1368).

Covers:
  - notify_pending_approval_via_slack sends a Block Kit DM to the bound slack_user_id
  - Does nothing when the owner has no Slack binding
  - Does nothing when SLACK_BOT_TOKEN is absent (Slack not configured)
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from typing import Any, Dict, List, Optional


def _load_api(monkeypatch, tmp_path, *, with_slack: bool = True):
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
    monkeypatch.setenv("WORKEROS_USER_ID", "slack-test-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    # WhatsApp always absent in these tests.
    for var in ("WHATSAPP_PHONE_ID", "WHATSAPP_TOKEN", "WHATSAPP_APP_SECRET",
                "WHATSAPP_WEBHOOK_VERIFY_TOKEN"):
        monkeypatch.setenv(var, "")

    if with_slack:
        monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test-token")
        monkeypatch.setenv("SLACK_SIGNING_SECRET", "test-signing-secret")
    else:
        monkeypatch.setenv("SLACK_BOT_TOKEN", "")
        monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "chat_service",
                 "channels.whatsapp", "channels.slack", "channels.common"]:
        sys.modules.pop(name, None)
    for _rn in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(_rn, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _seed_slack_bound_user(
    conn,
    slack_user_id: str,
    team_id: str,
    user_id: str,
    now: str,
) -> None:
    """Seed a user row + active Slack binding."""
    conn.execute(
        "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) "
        "VALUES (?, ?, 'x', 'admin', ?, ?)",
        (user_id, user_id, now, now),
    )
    conn.execute(
        """
        INSERT INTO slack_sender_bindings
            (slack_team_id, slack_user_id, user_id, profile_name, status,
             workspace_id, created_at, updated_at)
        VALUES (?, ?, ?, 'Test', 'active', 'local-default', ?, ?)
        """,
        (team_id, slack_user_id, user_id, now, now),
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_slack_notify_sends_block_kit_dm(monkeypatch, tmp_path):
    """notify_pending_approval_via_slack opens a DM channel and posts Block Kit."""
    main = _load_api(monkeypatch, tmp_path, with_slack=True)
    import channels.common as _common_mod

    SLACK_USER = "U123TEST"
    TEAM = "T456TEST"
    OWNER = "slack-owner-1"
    RUN_ID = "run-slack-notify-1"
    APR_ID = "apr_slack001122"

    conversations_opened: list[str] = []
    messages_posted: list[dict] = []

    class _FakeResp:
        ok = True
        def json(self):
            if "conversations.open" in self._url:
                return {"channel": {"id": "D_DM_CHANNEL"}}
            return {"ok": True}

    def _fake_post(url, *, headers=None, json=None, timeout=None):
        r = _FakeResp()
        r._url = url
        if "conversations.open" in url:
            conversations_opened.append(str(json or {}))
        elif "chat.postMessage" in url:
            messages_posted.append(json or {})
        return r

    import requests as _requests_mod
    monkeypatch.setattr(_requests_mod, "post", _fake_post)

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_slack_bound_user(conn, SLACK_USER, TEAM, OWNER, now)

    _common_mod.notify_pending_approval_via_slack(
        owner_id=OWNER,
        run_id=RUN_ID,
        worker_name="My Slack Worker",
        label="Send a report",
        approval_id=APR_ID,
    )

    # Must have opened a DM channel for the bound slack_user_id.
    assert conversations_opened, "conversations.open was never called"
    assert any(SLACK_USER in s for s in conversations_opened), (
        f"Expected {SLACK_USER!r} in conversations.open payload; got {conversations_opened!r}"
    )

    # Must have posted exactly one message.
    assert len(messages_posted) == 1, f"Expected 1 chat.postMessage call; got {messages_posted!r}"
    msg = messages_posted[0]
    assert msg.get("channel") == "D_DM_CHANNEL"

    # Must include Block Kit blocks.
    blocks = msg.get("blocks") or []
    assert blocks, "No blocks in posted message"

    # Must include Approve and Reject action buttons.
    action_ids = [
        elem.get("action_id")
        for block in blocks
        for elem in (block.get("elements") or [])
    ]
    assert "workeros_approval_approve" in action_ids, "Approve button missing from blocks"
    assert "workeros_approval_reject" in action_ids, "Reject button missing from blocks"

    # run_id must appear in the button value.
    values = [
        elem.get("value", "")
        for block in blocks
        for elem in (block.get("elements") or [])
    ]
    assert any(RUN_ID in v for v in values), (
        f"run_id {RUN_ID!r} not found in button values: {values!r}"
    )


def test_slack_notify_no_binding_is_noop(monkeypatch, tmp_path):
    """notify_pending_approval_via_slack does nothing when the owner has no Slack binding."""
    main = _load_api(monkeypatch, tmp_path, with_slack=True)
    import channels.common as _common_mod

    posts: list = []
    import requests as _requests_mod
    monkeypatch.setattr(_requests_mod, "post", lambda *a, **kw: posts.append((a, kw)) or _Noop())

    class _Noop:
        ok = False
        def json(self): return {}

    # No binding seeded.
    _common_mod.notify_pending_approval_via_slack(
        owner_id="no-binding-owner",
        run_id="run-no-binding",
        worker_name="Worker",
        label="Action",
        approval_id="apr_000000000000",
    )
    assert posts == [], f"Expected no HTTP calls but got {posts!r}"


def test_slack_notify_unconfigured_is_noop(monkeypatch, tmp_path):
    """notify_pending_approval_via_slack is silent when SLACK_BOT_TOKEN is absent."""
    main = _load_api(monkeypatch, tmp_path, with_slack=False)
    import channels.common as _common_mod

    posts: list = []
    import requests as _requests_mod
    monkeypatch.setattr(_requests_mod, "post", lambda *a, **kw: posts.append((a, kw)))

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_slack_bound_user(conn, "U_NO_TOKEN", "T_NO_TOKEN", "owner-no-token", now)

    _common_mod.notify_pending_approval_via_slack(
        owner_id="owner-no-token",
        run_id="run-no-token",
        worker_name="Worker",
        label="Action",
        approval_id="apr_000000000001",
    )
    # Must be a complete noop — no HTTP calls since no bot token.
    assert posts == [], f"Expected no HTTP calls (no token) but got {posts!r}"
