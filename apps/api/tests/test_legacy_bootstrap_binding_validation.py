"""Regression tests for the legacy/bootstrap owner binding-validation bug.

Incident (2026-06-10): Phase-3 hardening in whatsapp.py checked
``SELECT 1 FROM users WHERE id = ?`` for the bound user_id.  On Federico's
live install the binding is user_id="federico" (bootstrap id), which has NO
row in the users table even though the table is non-empty (real accounts are
UUIDs).  The check wrongly reset the binding to pending mid-walk.
channels/slack.py had the same latent flaw (skipped only when users table
IS empty — broke when table has UUID rows but binding is the legacy owner).

Tests:
- WA: bootstrap user_id with non-empty users table → flows to agent, binding NOT reset.
- WA: bootstrap user_id with empty users table → flows to agent (dev mode).
- WA: genuinely deleted UUID user with non-empty table → binding IS reset (hardening preserved).
- Slack: bootstrap user_id with non-empty users table → returns user_id, NOT None.
- Slack: genuinely deleted UUID user with non-empty table → returns None (hardening preserved).
- bound_user_is_valid: unit tests for all three code paths.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import importlib
import json
import sys
import types
from pathlib import Path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

APP_SECRET = "test-whatsapp-app-secret"
PHONE_ID = "1234567890"
TOKEN = "test-whatsapp-token"
VERIFY_TOKEN = "wk_workeros_verify_test"


def _load_api(monkeypatch, tmp_path, *, bootstrap_id: str = "federico"):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", bootstrap_id)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "test-slack-secret")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "T_TEST")
    monkeypatch.setenv("SLACK_LEGACY_SINGLE_USER", "0")
    monkeypatch.setenv("WHATSAPP_PHONE_ID", PHONE_ID)
    monkeypatch.setenv("WHATSAPP_TOKEN", TOKEN)
    monkeypatch.setenv("WHATSAPP_APP_SECRET", APP_SECRET)
    monkeypatch.setenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", VERIFY_TOKEN)

    sys.path.insert(0, str(api_dir))
    for name in list(sys.modules.keys()):
        if name in ("main", "db", "models", "worker_registry", "run_service", "chat_service") \
                or name.startswith("channels") or name.startswith("auth"):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _seed_uuid_user(conn, now: str, user_id: str = "00000000-0000-0000-0000-000000000001") -> str:
    """Add a UUID-based user to make the users table non-empty."""
    conn.execute(
        "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) "
        "VALUES (?, ?, 'x', 'admin', ?, ?)",
        (user_id, f"user_{user_id[:8]}", now, now),
    )
    return user_id


# ===========================================================================
# WhatsApp tests
# ===========================================================================


def test_wa_bootstrap_user_non_empty_table_routes_to_agent(monkeypatch, tmp_path):
    """Bootstrap/legacy binding (e.g. user_id='federico') must reach the agent even
    when the users table is non-empty (has UUID rows).  This is the exact incident."""
    main = _load_api(monkeypatch, tmp_path, bootstrap_id="federico")
    import channels.whatsapp as _wa_mod
    import channels.common as _common_mod

    routed: list[str] = []
    sent: list[tuple[str, str]] = []

    async def _fake_collect(*, message, user_id, conversation_id, source, **kw):
        routed.append(user_id)
        return "pong"

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", _fake_collect)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    with main.get_db() as conn:
        now = main.now_iso()
        # Non-empty users table with a UUID account (not the bootstrap owner).
        _seed_uuid_user(conn, now)
        # Active binding for the bootstrap user — NO users row for "federico".
        conn.execute(
            "INSERT INTO whatsapp_sender_bindings "
            "(wa_id, user_id, profile_name, status, workspace_id, created_at, updated_at) "
            "VALUES ('4915167609512', 'federico', 'Federico', 'active', 'local-default', ?, ?)",
            (now, now),
        )

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id="4915167609512", text="test", message_id="wamid.BOOT1", profile_name="Federico"
        )
    )

    # Must reach the agent.
    assert routed, "bootstrap-user binding must route to agent, not be reset"
    assert routed[0] == "federico"

    # Binding must still be active.
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status FROM whatsapp_sender_bindings WHERE wa_id = '4915167609512'"
        ).fetchone()
    assert row["status"] == "active", "bootstrap binding must NOT be reset"


def test_wa_bootstrap_user_empty_table_routes_to_agent(monkeypatch, tmp_path):
    """Bootstrap binding with an empty users table (pure dev mode) also routes to agent."""
    main = _load_api(monkeypatch, tmp_path, bootstrap_id="federico")
    import channels.whatsapp as _wa_mod

    routed: list[str] = []

    async def _fake_collect(*, message, user_id, conversation_id, source, **kw):
        routed.append(user_id)
        return "pong"

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", _fake_collect)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: None)

    with main.get_db() as conn:
        now = main.now_iso()
        # users table is empty — no UUID accounts seeded.
        conn.execute(
            "INSERT INTO whatsapp_sender_bindings "
            "(wa_id, user_id, profile_name, status, workspace_id, created_at, updated_at) "
            "VALUES ('4915167609512', 'federico', 'Federico', 'active', 'local-default', ?, ?)",
            (now, now),
        )

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id="4915167609512", text="test", message_id="wamid.BOOT2", profile_name="Federico"
        )
    )

    assert routed, "bootstrap binding on empty table must route to agent"


def test_wa_deleted_uuid_user_binding_is_reset(monkeypatch, tmp_path):
    """A binding pointing to a UUID user that no longer exists must still be reset.
    (Hardening from Phase-3 must be preserved — only the bootstrap id is exempted.)"""
    main = _load_api(monkeypatch, tmp_path, bootstrap_id="federico")
    import channels.whatsapp as _wa_mod

    routed: list[str] = []
    sent: list[tuple[str, str]] = []

    async def _fake_collect(*, message, user_id, conversation_id, source, **kw):
        routed.append(user_id)
        return "should not reach"

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", _fake_collect)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    deleted_uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

    with main.get_db() as conn:
        now = main.now_iso()
        # Non-empty table — but deleted_uuid is NOT in it.
        _seed_uuid_user(conn, now)
        conn.execute(
            "INSERT INTO whatsapp_sender_bindings "
            "(wa_id, user_id, profile_name, status, workspace_id, created_at, updated_at) "
            "VALUES ('4915100000001', ?, 'Gone User', 'active', 'local-default', ?, ?)",
            (deleted_uuid, now, now),
        )

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id="4915100000001", text="test", message_id="wamid.DEL1", profile_name="Gone"
        )
    )

    # Must NOT route to agent.
    assert not routed, "deleted UUID user binding must not reach agent"

    # Binding must be pending.
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status FROM whatsapp_sender_bindings WHERE wa_id = '4915100000001'"
        ).fetchone()
    assert row["status"] == "pending", "deleted UUID user binding must be reset to pending"


# ===========================================================================
# Slack tests
# ===========================================================================

import time
import urllib.parse


def _slack_sig(body: bytes, secret: str = "test-slack-secret") -> dict:
    ts = str(int(time.time()))
    base = b"v0:" + ts.encode() + b":" + body
    sig = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    return {"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig,
            "Content-Type": "application/json"}


def test_slack_bootstrap_user_non_empty_table_is_valid(monkeypatch, tmp_path):
    """_slack_binding_user_id returns the bootstrap user_id even when
    the users table has UUID rows (the bootstrap id has no users row)."""
    main = _load_api(monkeypatch, tmp_path, bootstrap_id="slack-bootstrap")
    import channels.slack as _sl_mod

    # Directly exercise the binding lookup helper.
    with main.get_db() as conn:
        now = main.now_iso()
        # Non-empty users table — but "slack-bootstrap" has no row.
        _seed_uuid_user(conn, now)
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, profile_name, user_id, status,
                 created_at, updated_at)
            VALUES ('T_TEST', 'UBOOT', 'Bootstrap User', 'slack-bootstrap',
                    'active', ?, ?)
            """,
            (now, now),
        )

    result = _sl_mod._slack_binding_user_id(team_id="T_TEST", slack_user_id="UBOOT")

    assert result is not None, "bootstrap binding must not return None on non-empty users table"
    assert result == "slack-bootstrap"


def test_slack_deleted_uuid_user_binding_returns_none(monkeypatch, tmp_path):
    """A Slack binding pointing to a deleted UUID user must still return None.
    (Phase-3 hardening must be preserved for genuine deletions.)"""
    main = _load_api(monkeypatch, tmp_path, bootstrap_id="slack-bootstrap")
    import channels.slack as _sl_mod

    deleted_uuid = "ffffffff-ffff-ffff-ffff-ffffffffffff"

    with main.get_db() as conn:
        now = main.now_iso()
        # Non-empty table — deleted_uuid is NOT in it.
        _seed_uuid_user(conn, now)
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, profile_name, user_id, status,
                 created_at, updated_at)
            VALUES ('T_TEST', 'UDEL', 'Gone User', ?, 'active', ?, ?)
            """,
            (deleted_uuid, now, now),
        )

    result = _sl_mod._slack_binding_user_id(team_id="T_TEST", slack_user_id="UDEL")

    assert result is None, "deleted UUID user Slack binding must return None (hardening preserved)"


# ===========================================================================
# bound_user_is_valid unit tests
# ===========================================================================


def test_bound_user_is_valid_returns_true_for_bootstrap_id(monkeypatch, tmp_path):
    """bootstrap id → always valid regardless of table state."""
    main = _load_api(monkeypatch, tmp_path, bootstrap_id="federico")
    import channels.common as _cm

    # Non-empty users table, no row for "federico".
    with main.get_db() as conn:
        now = main.now_iso()
        _seed_uuid_user(conn, now)

    assert _cm.bound_user_is_valid("federico") is True


def test_bound_user_is_valid_returns_true_for_empty_table(monkeypatch, tmp_path):
    """Empty users table → any id is valid (dev/pre-auth mode)."""
    main = _load_api(monkeypatch, tmp_path, bootstrap_id="federico")
    import channels.common as _cm

    # Table is empty — no rows at all (no UUID accounts).
    assert _cm.bound_user_is_valid("some-uuid-user") is True


def test_bound_user_is_valid_returns_true_for_existing_uuid(monkeypatch, tmp_path):
    """UUID user that IS in the users table → valid."""
    main = _load_api(monkeypatch, tmp_path, bootstrap_id="federico")
    import channels.common as _cm

    uuid_user = "11111111-2222-3333-4444-555555555555"
    with main.get_db() as conn:
        now = main.now_iso()
        conn.execute(
            "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) "
            "VALUES (?, ?, 'x', 'admin', ?, ?)",
            (uuid_user, "existing", now, now),
        )

    assert _cm.bound_user_is_valid(uuid_user) is True


def test_bound_user_is_valid_returns_false_for_missing_uuid(monkeypatch, tmp_path):
    """UUID user NOT in the non-empty users table → invalid (must be reset)."""
    main = _load_api(monkeypatch, tmp_path, bootstrap_id="federico")
    import channels.common as _cm

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_uuid_user(conn, now)

    assert _cm.bound_user_is_valid("cccccccc-dddd-eeee-ffff-000000000000") is False
