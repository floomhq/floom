"""Run-completion DM notification tests (#1382).

Covers:
  - notify_run_complete_via_slack sends a short outcome DM to the bound slack_user_id
  - notify_run_complete_via_slack does nothing when the owner has no Slack binding
  - notify_run_complete_via_slack does nothing when SLACK_BOT_TOKEN is absent
  - notify_run_complete_via_whatsapp sends a message to the bound wa_id on completion
  - notify_run_complete_via_whatsapp does nothing when owner has no WhatsApp binding
  - notify_run_complete_via_whatsapp does nothing when WhatsApp is unconfigured
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from typing import Any, Dict, List, Optional

VERIFY_TOKEN = "wk_rc_verify_test"
APP_SECRET = "test-wa-app-secret-rc"
PHONE_ID = "9999888777"
WA_TOKEN = "test-wa-token-rc"


def _load_api(monkeypatch, tmp_path, *, with_slack: bool = True, with_whatsapp: bool = True):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret-rc")
    monkeypatch.setenv("WORKEROS_USER_ID", "rc-test-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "http://localhost:3000")

    if with_slack:
        monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-rc-test-token")
        monkeypatch.setenv("SLACK_SIGNING_SECRET", "rc-signing-secret")
    else:
        monkeypatch.setenv("SLACK_BOT_TOKEN", "")
        monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")

    if with_whatsapp:
        monkeypatch.setenv("WHATSAPP_PHONE_ID", PHONE_ID)
        monkeypatch.setenv("WHATSAPP_TOKEN", WA_TOKEN)
        monkeypatch.setenv("WHATSAPP_APP_SECRET", APP_SECRET)
        monkeypatch.setenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", VERIFY_TOKEN)
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
# Slack run-complete notify
# ---------------------------------------------------------------------------

def test_slack_run_complete_sends_dm_on_success(monkeypatch, tmp_path):
    """notify_run_complete_via_slack opens a DM and posts a completion message."""
    main = _load_api(monkeypatch, tmp_path, with_slack=True, with_whatsapp=False)
    import channels.common as _common_mod

    SLACK_USER = "U_RC_TEST"
    TEAM = "T_RC_TEST"
    OWNER = "rc-slack-owner"
    RUN_ID = "run-rc-slack-001"

    conversations_opened: list = []
    messages_posted: list = []

    class _FakeResp:
        ok = True
        def json(self):
            if "conversations.open" in self._url:
                return {"channel": {"id": "D_RC_DM"}}
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

    _common_mod.notify_run_complete_via_slack(
        owner_id=OWNER,
        run_id=RUN_ID,
        worker_name="My Worker",
        status="completed",
        result_summary="Processed 42 records",
    )

    assert conversations_opened, "conversations.open was never called"
    assert any(SLACK_USER in s for s in conversations_opened), (
        f"Expected {SLACK_USER!r} in conversations.open; got {conversations_opened!r}"
    )
    assert len(messages_posted) == 1, f"Expected 1 chat.postMessage; got {messages_posted!r}"
    msg_text = messages_posted[0].get("text", "")
    assert "Done" in msg_text, f"Expected 'Done' in text; got {msg_text!r}"
    assert "Processed 42 records" in msg_text, f"Expected summary in text; got {msg_text!r}"
    assert RUN_ID in msg_text or "runs/" in msg_text, f"Expected run link; got {msg_text!r}"


def test_slack_run_complete_sends_failure_dm(monkeypatch, tmp_path):
    """notify_run_complete_via_slack posts failure message on failed status."""
    main = _load_api(monkeypatch, tmp_path, with_slack=True, with_whatsapp=False)
    import channels.common as _common_mod

    SLACK_USER = "U_RC_FAIL"
    TEAM = "T_RC_FAIL"
    OWNER = "rc-slack-fail-owner"
    RUN_ID = "run-rc-slack-fail"

    messages_posted: list = []

    class _FakeResp:
        ok = True
        def json(self):
            if "conversations.open" in self._url:
                return {"channel": {"id": "D_FAIL_DM"}}
            return {"ok": True}

    def _fake_post(url, *, headers=None, json=None, timeout=None):
        r = _FakeResp()
        r._url = url
        if "chat.postMessage" in url:
            messages_posted.append(json or {})
        return r

    import requests as _req_mod
    monkeypatch.setattr(_req_mod, "post", _fake_post)

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_slack_bound_user(conn, SLACK_USER, TEAM, OWNER, now)

    _common_mod.notify_run_complete_via_slack(
        owner_id=OWNER,
        run_id=RUN_ID,
        worker_name="My Worker",
        status="failed",
        result_summary="timeout after 60s",
    )

    assert messages_posted, "Expected a DM to be posted on failure"
    msg_text = messages_posted[0].get("text", "")
    assert "failed" in msg_text.lower(), f"Expected 'failed' in text; got {msg_text!r}"


def test_slack_run_complete_no_binding_is_noop(monkeypatch, tmp_path):
    """notify_run_complete_via_slack does nothing when owner has no Slack binding."""
    main = _load_api(monkeypatch, tmp_path, with_slack=True, with_whatsapp=False)
    import channels.common as _common_mod

    posts: list = []
    import requests as _req_mod
    monkeypatch.setattr(_req_mod, "post", lambda *a, **kw: posts.append((a, kw)))

    _common_mod.notify_run_complete_via_slack(
        owner_id="no-slack-owner",
        run_id="run-no-slack",
        worker_name="Worker",
        status="completed",
    )
    assert posts == [], f"Expected no HTTP calls; got {posts!r}"


def test_slack_run_complete_no_token_is_noop(monkeypatch, tmp_path):
    """notify_run_complete_via_slack does nothing when SLACK_BOT_TOKEN is absent."""
    main = _load_api(monkeypatch, tmp_path, with_slack=False, with_whatsapp=False)
    import channels.common as _common_mod

    posts: list = []
    import requests as _req_mod
    monkeypatch.setattr(_req_mod, "post", lambda *a, **kw: posts.append((a, kw)))

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_slack_bound_user(conn, "U_NO_TOK", "T_NO_TOK", "no-token-owner", now)

    _common_mod.notify_run_complete_via_slack(
        owner_id="no-token-owner",
        run_id="run-no-token",
        worker_name="Worker",
        status="completed",
    )
    assert posts == [], f"Expected no HTTP calls (no token); got {posts!r}"


# ---------------------------------------------------------------------------
# WhatsApp run-complete notify
# ---------------------------------------------------------------------------

def test_wa_run_complete_sends_message_on_success(monkeypatch, tmp_path):
    """notify_run_complete_via_whatsapp sends a text to the bound wa_id."""
    main = _load_api(monkeypatch, tmp_path, with_slack=False, with_whatsapp=True)
    import channels.common as _common_mod
    import channels.whatsapp as _wa_mod

    sent: list = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_wa_bound_user(conn, "4917010000002", "wa-rc-owner", now)

    _common_mod.notify_run_complete_via_whatsapp(
        owner_id="wa-rc-owner",
        run_id="run-wa-rc-001",
        worker_name="My WA Worker",
        status="completed",
        result_summary="Sent 10 emails",
    )

    assert len(sent) == 1, f"Expected 1 WA message; got {sent!r}"
    wa_id_sent, msg = sent[0]
    assert wa_id_sent == "4917010000002"
    assert "Done" in msg, f"Expected 'Done' in msg; got {msg!r}"
    assert "Sent 10 emails" in msg, f"Expected summary in msg; got {msg!r}"
    assert "run-wa-rc-001" in msg or "runs/" in msg, f"Expected run link; got {msg!r}"


def test_wa_run_complete_no_binding_is_noop(monkeypatch, tmp_path):
    """notify_run_complete_via_whatsapp does nothing when owner has no binding."""
    main = _load_api(monkeypatch, tmp_path, with_slack=False, with_whatsapp=True)
    import channels.common as _common_mod
    import channels.whatsapp as _wa_mod

    sent: list = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    _common_mod.notify_run_complete_via_whatsapp(
        owner_id="no-wa-binding",
        run_id="run-wa-no-bind",
        worker_name="Worker",
        status="completed",
    )
    assert sent == [], f"Expected no WA message; got {sent!r}"


def test_wa_run_complete_unconfigured_is_noop(monkeypatch, tmp_path):
    """notify_run_complete_via_whatsapp does nothing when WhatsApp creds absent."""
    main = _load_api(monkeypatch, tmp_path, with_slack=False, with_whatsapp=False)
    import channels.common as _common_mod
    import channels.whatsapp as _wa_mod

    sent: list = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_wa_bound_user(conn, "4917010000099", "wa-rc-uncfg-owner", now)

    _common_mod.notify_run_complete_via_whatsapp(
        owner_id="wa-rc-uncfg-owner",
        run_id="run-wa-uncfg",
        worker_name="Worker",
        status="completed",
    )
    assert sent == [], f"Expected no WA message (unconfigured); got {sent!r}"
