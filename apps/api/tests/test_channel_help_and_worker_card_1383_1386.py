"""Help command (#1383) and worker-created card (#1386) tests.

Covers:
  - /floom help returns a Block Kit card with Run/Approve/Create/Notify
  - /floom help in DM returns the same card
  - WhatsApp 'help' keyword returns a capability reply without an agent run
  - _slack_worker_created_blocks returns fallback text and correct action_ids
"""

from __future__ import annotations

import asyncio
import importlib
import sys
import types
from pathlib import Path
from typing import Any, Dict, List, Optional


def _load_api(monkeypatch, tmp_path, *, with_slack: bool = True, with_whatsapp: bool = False):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret-1383")
    monkeypatch.setenv("WORKEROS_USER_ID", "help-test-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "http://localhost:3000")

    if with_slack:
        monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-help-test-token")
        monkeypatch.setenv("SLACK_SIGNING_SECRET", "help-signing-secret")
    else:
        monkeypatch.setenv("SLACK_BOT_TOKEN", "")
        monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")

    if with_whatsapp:
        monkeypatch.setenv("WHATSAPP_PHONE_ID", "1111222333")
        monkeypatch.setenv("WHATSAPP_TOKEN", "test-wa-help-token")
        monkeypatch.setenv("WHATSAPP_APP_SECRET", "test-wa-app-secret-help")
        monkeypatch.setenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", "wk_help_verify")
    else:
        for var in ("WHATSAPP_PHONE_ID", "WHATSAPP_TOKEN", "WHATSAPP_APP_SECRET",
                    "WHATSAPP_WEBHOOK_VERIFY_TOKEN"):
            monkeypatch.setenv(var, "")

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


def _seed_slack_bound_user(conn, slack_user_id: str, team_id: str, user_id: str, now: str) -> None:
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


def _seed_wa_bound_user(conn, wa_id: str, user_id: str, now: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) "
        "VALUES (?, ?, 'x', 'admin', ?, ?)",
        (user_id, user_id, now, now),
    )
    conn.execute(
        """
        INSERT INTO whatsapp_sender_bindings
            (wa_id, user_id, profile_name, status, workspace_id, created_at, updated_at)
        VALUES (?, ?, 'Test', 'active', 'local-default', ?, ?)
        """,
        (wa_id, user_id, now, now),
    )


# ---------------------------------------------------------------------------
# Feature #1383: Slack help response shape
# ---------------------------------------------------------------------------

def test_slack_help_response_has_blocks(monkeypatch, tmp_path):
    """_slack_help_response returns blocks with Run/Approve/Create/Notify content."""
    _load_api(monkeypatch, tmp_path, with_slack=True)
    import channels.slack as _slack_mod

    result = _slack_mod._slack_help_response()
    assert result["response_type"] == "ephemeral"
    assert result.get("blocks"), "Expected blocks in help response"
    # Find the mrkdwn section
    all_text = " ".join(
        b.get("text", {}).get("text", "") if isinstance(b.get("text"), dict) else ""
        for b in result["blocks"]
    )
    assert "Run" in all_text or "run" in all_text, f"Expected 'Run' mention in help; got {all_text!r}"
    assert "Approve" in all_text or "approve" in all_text, f"Expected 'Approve' in help; got {all_text!r}"
    assert "Create" in all_text or "create" in all_text, f"Expected 'Create' in help; got {all_text!r}"
    assert "Notify" in all_text or "notify" in all_text or "Notification" in all_text, f"Expected 'Notify/Notification' in help; got {all_text!r}"


# ---------------------------------------------------------------------------
# Feature #1386: Slack worker-created card block structure
# ---------------------------------------------------------------------------

def test_slack_worker_created_blocks_has_correct_action_ids(monkeypatch, tmp_path):
    """_slack_worker_created_blocks returns Review/Run/Disable actions."""
    _load_api(monkeypatch, tmp_path, with_slack=True)
    import channels.slack as _slack_mod

    WORKER_ID = "wk_test_1386_abc"
    WORKER_NAME = "Invoice Processor"

    fallback, blocks = _slack_mod._slack_worker_created_blocks(
        worker_name=WORKER_NAME,
        worker_id=WORKER_ID,
    )

    assert WORKER_NAME in fallback, f"Expected worker name in fallback; got {fallback!r}"
    assert blocks, "Expected blocks to be non-empty"

    # Extract all action_ids and values.
    action_ids = [
        elem.get("action_id")
        for block in blocks
        for elem in (block.get("elements") or [])
    ]
    values = [
        elem.get("value", "")
        for block in blocks
        for elem in (block.get("elements") or [])
    ]

    assert "workeros_worker_review" in action_ids, f"Missing Review action; got {action_ids!r}"
    assert "workeros_worker_run" in action_ids, f"Missing Run action; got {action_ids!r}"
    assert "workeros_worker_disable" in action_ids, f"Missing Disable action; got {action_ids!r}"

    # worker_id must appear in button values.
    assert any(WORKER_ID in v for v in values), (
        f"worker_id {WORKER_ID!r} not found in button values: {values!r}"
    )

    # Section text must mention worker name.
    section_texts = [
        block.get("text", {}).get("text", "")
        for block in blocks
        if block.get("type") == "section" and isinstance(block.get("text"), dict)
    ]
    assert any(WORKER_NAME in t for t in section_texts), (
        f"Worker name {WORKER_NAME!r} missing from section text: {section_texts!r}"
    )
    assert any(WORKER_ID in t for t in section_texts), (
        f"Worker ID {WORKER_ID!r} missing from section text: {section_texts!r}"
    )


# ---------------------------------------------------------------------------
# Feature #1383: WhatsApp help keyword
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Feature #1386: notify_worker_created_via_slack / notify_worker_created_via_whatsapp
# ---------------------------------------------------------------------------

def test_notify_worker_created_via_slack_sends_block_kit(monkeypatch, tmp_path):
    """notify_worker_created_via_slack opens a DM and posts a Block Kit card."""
    main = _load_api(monkeypatch, tmp_path, with_slack=True)
    import channels.common as _common_mod

    SLACK_USER = "U_WC_TEST"
    TEAM = "T_WC_TEST"
    OWNER = "wc-slack-owner"
    WORKER_ID = "wk_created_abc123"
    WORKER_NAME = "Invoice Processor"

    conversations_opened: list = []
    messages_posted: list = []

    class _FakeResp:
        ok = True
        def json(self):
            if "conversations.open" in self._url:
                return {"channel": {"id": "D_WC_DM"}}
            return {"ok": True}

    def _fake_post(url, *, headers=None, json=None, timeout=None):
        r = _FakeResp()
        r._url = url
        if "conversations.open" in url:
            conversations_opened.append(str(json or {}))
        elif "chat.postMessage" in url:
            messages_posted.append(json or {})
        return r

    import requests as _req_mod
    monkeypatch.setattr(_req_mod, "post", _fake_post)

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_slack_bound_user(conn, SLACK_USER, TEAM, OWNER, now)

    _common_mod.notify_worker_created_via_slack(
        owner_id=OWNER,
        worker_id=WORKER_ID,
        worker_name=WORKER_NAME,
    )

    assert conversations_opened, "conversations.open was never called"
    assert len(messages_posted) == 1, f"Expected 1 chat.postMessage; got {messages_posted!r}"
    msg = messages_posted[0]
    assert WORKER_NAME in (msg.get("text") or ""), "Worker name missing from fallback text"
    blocks = msg.get("blocks") or []
    assert blocks, "Expected Block Kit blocks"
    action_ids = [
        elem.get("action_id")
        for block in blocks
        for elem in (block.get("elements") or [])
    ]
    assert "workeros_worker_review" in action_ids, f"Review button missing: {action_ids!r}"
    assert "workeros_worker_run" in action_ids, f"Run button missing: {action_ids!r}"
    assert "workeros_worker_disable" in action_ids, f"Disable button missing: {action_ids!r}"


def test_notify_worker_created_via_whatsapp_sends_message(monkeypatch, tmp_path):
    """notify_worker_created_via_whatsapp sends a formatted message to the bound wa_id."""
    main = _load_api(monkeypatch, tmp_path, with_slack=False, with_whatsapp=True)
    import channels.common as _common_mod
    import channels.whatsapp as _wa_mod

    sent: list = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    WORKER_ID = "wk_wa_created_xyz"
    WORKER_NAME = "Email Digest"

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_wa_bound_user(conn, "4917010000060", "wa-wc-owner", now)

    _common_mod.notify_worker_created_via_whatsapp(
        owner_id="wa-wc-owner",
        worker_id=WORKER_ID,
        worker_name=WORKER_NAME,
    )

    assert len(sent) == 1, f"Expected 1 WA message; got {sent!r}"
    _, msg = sent[0]
    assert WORKER_NAME in msg, f"Worker name missing from WA message: {msg!r}"
    assert WORKER_ID[:8] in msg, f"Worker ID prefix missing from WA message: {msg!r}"


def test_whatsapp_help_keyword_short_circuits_agent(monkeypatch, tmp_path):
    """WhatsApp 'help' text returns a capability reply without running the agent."""
    main = _load_api(monkeypatch, tmp_path, with_slack=False, with_whatsapp=True)
    import channels.whatsapp as _wa_mod
    import channels.common as _common_mod

    WA_ID = "4917010000050"
    USER_ID = "help-wa-user"

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_wa_bound_user(conn, WA_ID, USER_ID, now)

    sent: list = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    # Patch collect_agent_reply so if the agent IS called, we can detect it.
    agent_called: list = []
    async def _fake_agent(*a, **kw):
        agent_called.append(True)
        return "agent reply"
    monkeypatch.setattr(_common_mod, "collect_agent_reply", _fake_agent)

    async def _run():
        await _wa_mod._handle_whatsapp_message(
            wa_id=WA_ID,
            text="help",
            message_id="msg_help_001",
            profile_name="Tester",
        )
    asyncio.get_event_loop().run_until_complete(_run())

    # Agent must NOT have been called.
    assert not agent_called, "Agent should not run for 'help' keyword"
    # A reply must have been sent.
    assert len(sent) == 1, f"Expected 1 WA reply; got {sent!r}"
    _, msg = sent[0]
    # Must mention the core capabilities.
    for keyword in ("Run", "Approve", "Create", "Notify"):
        assert keyword in msg or keyword.lower() in msg, (
            f"Expected {keyword!r} in help reply; got {msg!r}"
        )
