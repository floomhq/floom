"""WhatsApp reply-to-approve tests (Phase 4).

Covers:
  - notify_pending_approval_via_whatsapp sends to the bound wa_id on approval entry
  - 'yes' approves the single pending approval
  - 'yes <suffix>' targets the correct one of two pending approvals
  - 'no' rejects the single pending approval
  - unbound sender replies are NEVER intercepted
  - 'yes' with no pending approvals falls through to the agent
  - non-owner cannot approve (approval is invisible to them)
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import types
from pathlib import Path
from typing import Any, Dict, List, Optional


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
        for var in ("WHATSAPP_PHONE_ID", "WHATSAPP_TOKEN", "WHATSAPP_APP_SECRET",
                    "WHATSAPP_WEBHOOK_VERIFY_TOKEN"):
            monkeypatch.setenv(var, "")

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "chat_service",
                 "channels.whatsapp", "channels.common"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _seed_bound_user(conn, wa_id: str, user_id: str, now: str, workspace_id: str = "local-default") -> None:
    """Seed a user row + active WhatsApp binding."""
    conn.execute(
        "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at, updated_at) "
        "VALUES (?, ?, 'x', 'admin', ?, ?)",
        (user_id, user_id, now, now),
    )
    conn.execute(
        """
        INSERT INTO whatsapp_sender_bindings
            (wa_id, user_id, profile_name, status, workspace_id, created_at, updated_at)
        VALUES (?, ?, 'Test', 'active', ?, ?, ?)
        """,
        (wa_id, user_id, workspace_id, now, now),
    )


def _seed_approval(
    conn,
    approval_id: str,
    run_id: str,
    owner_id: str,
    now: str,
    *,
    worker_id: str = "w1",
    label: str = "Approve action",
) -> None:
    """Seed a pending approval (and a minimal skill_version + worker + run row)."""
    # skill_versions is required for the workers FK.
    sv_id = f"sv_{worker_id}"
    conn.execute(
        "INSERT OR IGNORE INTO skill_versions "
        "(id, name, version, manifest_json, bundle_path, created_at) "
        "VALUES (?, ?, '0.1.0', '{}', NULL, ?)",
        (sv_id, worker_id, now),
    )
    conn.execute(
        "INSERT OR IGNORE INTO workers "
        "(id, skill_version_id, name, trigger_type, enabled, owner_id, workspace_id, "
        "visibility, created_at) "
        "VALUES (?, ?, ?, 'manual', 1, ?, 'local-default', 'private', ?)",
        (worker_id, sv_id, worker_id, owner_id, now),
    )
    conn.execute(
        "INSERT OR IGNORE INTO runs "
        "(id, worker_id, status, trigger_source, runner, input_json, output_json, "
        "approval_status, created_at) "
        "VALUES (?, ?, 'pending_approval', 'manual', 'e2b', '{}', '{}', 'required', ?)",
        (run_id, worker_id, now),
    )
    conn.execute(
        "INSERT INTO approvals (id, run_id, worker_id, owner_id, status, label, "
        "created_at, decision_input_json) "
        "VALUES (?, ?, ?, ?, 'pending', ?, ?, '{}')",
        (approval_id, run_id, worker_id, owner_id, label, now),
    )


# ---------------------------------------------------------------------------
# Outbound notification
# ---------------------------------------------------------------------------

def test_notify_sends_to_bound_wa_id(monkeypatch, tmp_path):
    """notify_pending_approval_via_whatsapp sends to the wa_id bound to the owner."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.common as _common_mod
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_bound_user(conn, "491701000001", "owner1", now)

    _common_mod.notify_pending_approval_via_whatsapp(
        owner_id="owner1",
        run_id="run-notify-1",
        worker_name="My Worker",
        label="Check this action",
        approval_id="apr_abcdef123456",
    )

    assert len(sent) == 1
    wa_id_sent, msg = sent[0]
    assert wa_id_sent == "491701000001"
    assert "My Worker" in msg
    assert "Check this action" in msg
    # ID suffix included for disambiguation.
    assert "123456" in msg


def test_notify_no_binding_is_noop(monkeypatch, tmp_path):
    """notify_pending_approval_via_whatsapp does nothing when owner has no binding."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.common as _common_mod
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    # No binding seeded for 'orphan-owner'.
    _common_mod.notify_pending_approval_via_whatsapp(
        owner_id="orphan-owner",
        run_id="run-notify-2",
        worker_name="Worker",
        label="Action",
        approval_id="apr_000000000000",
    )
    assert sent == []


def test_notify_unconfigured_whatsapp_is_noop(monkeypatch, tmp_path):
    """notify_pending_approval_via_whatsapp is silent when WA creds are absent."""
    main = _load_api(monkeypatch, tmp_path, with_creds=False)
    import channels.common as _common_mod
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_bound_user(conn, "491701000002", "owner2", now)

    _common_mod.notify_pending_approval_via_whatsapp(
        owner_id="owner2",
        run_id="run-notify-3",
        worker_name="Worker",
        label="Action",
        approval_id="apr_000000000001",
    )
    assert sent == []


# ---------------------------------------------------------------------------
# _parse_approval_reply unit tests
# ---------------------------------------------------------------------------

def test_parse_approval_reply_keywords(monkeypatch, tmp_path):
    """_parse_approval_reply recognises all keyword forms."""
    _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    assert _wa_mod._parse_approval_reply("yes") == {"decision": "approved", "suffix": None}
    assert _wa_mod._parse_approval_reply("YES") == {"decision": "approved", "suffix": None}
    assert _wa_mod._parse_approval_reply("approve") == {"decision": "approved", "suffix": None}
    assert _wa_mod._parse_approval_reply("no") == {"decision": "rejected", "suffix": None}
    assert _wa_mod._parse_approval_reply("NO") == {"decision": "rejected", "suffix": None}
    assert _wa_mod._parse_approval_reply("reject") == {"decision": "rejected", "suffix": None}

    # With suffix
    result = _wa_mod._parse_approval_reply("yes 3456ef")
    assert result == {"decision": "approved", "suffix": "3456ef"}

    result = _wa_mod._parse_approval_reply("no abcd")
    assert result == {"decision": "rejected", "suffix": "abcd"}


def test_parse_approval_reply_non_approval_messages(monkeypatch, tmp_path):
    """Normal chat messages are never parsed as approval replies."""
    _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    assert _wa_mod._parse_approval_reply("yes please do X") is None
    assert _wa_mod._parse_approval_reply("no problem") is None
    assert _wa_mod._parse_approval_reply("hello") is None
    assert _wa_mod._parse_approval_reply("list my workers") is None
    assert _wa_mod._parse_approval_reply("") is None
    assert _wa_mod._parse_approval_reply("yes !!!") is None


# ---------------------------------------------------------------------------
# Inbound approval reply routing
# ---------------------------------------------------------------------------

def test_yes_approves_single_pending(monkeypatch, tmp_path):
    """Reply 'yes' when exactly one pending approval approves it."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    approved_runs: list = []

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))
    # Prevent agent from running.
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", lambda **_: (_ for _ in ()).throw(AssertionError("agent must not run")))

    WA_ID = "491702000001"
    APR_ID = "apr_aabbccdd1122"
    RUN_ID = "run-yes-single"
    OWNER = "user-yes-single"

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_bound_user(conn, WA_ID, OWNER, now)
        _seed_approval(conn, APR_ID, RUN_ID, OWNER, now, label="Send email")

    def _fake_approve(run_id, body, auth, repos):
        approved_runs.append(run_id)
        result = types.SimpleNamespace()
        result.run_id = "run-followup-1"
        return result

    monkeypatch.setattr(main, "approve_run", _fake_approve)

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id=WA_ID, text="yes", message_id="wamid.YES1", profile_name="Test"
        )
    )

    assert approved_runs == [RUN_ID]
    assert sent
    reply = sent[-1][1]
    assert "Approved" in reply or "approved" in reply.lower()


def test_no_rejects_single_pending(monkeypatch, tmp_path):
    """Reply 'no' when exactly one pending approval rejects it."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    rejected_runs: list = []

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", lambda **_: (_ for _ in ()).throw(AssertionError("agent must not run")))

    WA_ID = "491702000002"
    APR_ID = "apr_112233445566"
    RUN_ID = "run-no-single"
    OWNER = "user-no-single"

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_bound_user(conn, WA_ID, OWNER, now)
        _seed_approval(conn, APR_ID, RUN_ID, OWNER, now, label="Delete file")

    def _fake_reject(run_id, body, auth, repos):
        rejected_runs.append(run_id)
        result = types.SimpleNamespace()
        result.run_id = run_id
        return result

    monkeypatch.setattr(main, "reject_run", _fake_reject)

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id=WA_ID, text="no", message_id="wamid.NO1", profile_name="Test"
        )
    )

    assert rejected_runs == [RUN_ID]
    assert sent
    reply = sent[-1][1]
    assert "Rejected" in reply or "rejected" in reply.lower()


def test_yes_with_suffix_targets_correct_one_of_two(monkeypatch, tmp_path):
    """'yes <suffix>' approves the right approval when two are pending."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    approved_runs: list = []

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", lambda **_: (_ for _ in ()).throw(AssertionError("agent must not run")))

    WA_ID = "491702000003"
    APR_ID_A = "apr_aaaa00001111"  # suffix: 001111
    APR_ID_B = "apr_bbbb00002222"  # suffix: 002222
    OWNER = "user-two-pending"

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_bound_user(conn, WA_ID, OWNER, now)
        _seed_approval(conn, APR_ID_A, "run-two-A", OWNER, now, label="Action A", worker_id="w-aa")
        _seed_approval(conn, APR_ID_B, "run-two-B", OWNER, now, label="Action B", worker_id="w-bb")

    def _fake_approve(run_id, body, auth, repos):
        approved_runs.append(run_id)
        result = types.SimpleNamespace()
        result.run_id = "run-followup-2"
        return result

    monkeypatch.setattr(main, "approve_run", _fake_approve)

    # Use the suffix of APR_ID_A (last 6 chars = "001111")
    asyncio.run(
        main._handle_whatsapp_message(
            wa_id=WA_ID, text="yes 001111", message_id="wamid.SUFFIX1", profile_name="Test"
        )
    )

    # Only run-two-A must have been approved.
    assert approved_runs == ["run-two-A"]
    assert sent
    reply = sent[-1][1]
    assert "Approved" in reply or "approved" in reply.lower()


def test_ambiguous_yes_with_multiple_pending_lists_them(monkeypatch, tmp_path):
    """'yes' with multiple pending and no suffix returns a disambiguation list."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    approved_runs: list = []

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", lambda **_: (_ for _ in ()).throw(AssertionError("agent must not run")))
    monkeypatch.setattr(main, "approve_run", lambda *a, **kw: approved_runs.append(a) or types.SimpleNamespace(run_id="x"))

    WA_ID = "491702000004"
    OWNER = "user-ambiguous"

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_bound_user(conn, WA_ID, OWNER, now)
        _seed_approval(conn, "apr_aaaa00003333", "run-ambig-A", OWNER, now, label="Action A", worker_id="w-x1")
        _seed_approval(conn, "apr_bbbb00004444", "run-ambig-B", OWNER, now, label="Action B", worker_id="w-x2")

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id=WA_ID, text="yes", message_id="wamid.AMBIG", profile_name="Test"
        )
    )

    # Nothing approved.
    assert approved_runs == []
    # Reply lists the pending approvals.
    assert sent
    reply = sent[-1][1]
    assert "pending" in reply.lower() or "003333" in reply or "004444" in reply


def test_unbound_sender_yes_never_intercepted(monkeypatch, tmp_path):
    """An unbound sender's 'yes' message is never treated as an approval reply."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))
    # collect_agent_reply must NOT be called — unbound sender gets claim prompt.
    monkeypatch.setattr(_wa_mod, "collect_agent_reply", lambda **_: (_ for _ in ()).throw(AssertionError("agent must not run for unbound sender")))

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id="491702999999", text="yes", message_id="wamid.UNBOUND", profile_name="Ghost"
        )
    )

    # Must have sent a claim link, NOT an approval confirmation.
    assert sent
    assert any("whatsapp_claim=" in msg for _, msg in sent)


def test_yes_with_no_pending_goes_to_agent(monkeypatch, tmp_path):
    """'yes' from a bound sender with NO pending approvals falls through to agent."""
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    sent: list[tuple[str, str]] = []
    agent_called: list = []

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    async def _fake_collect(*, message, user_id, conversation_id, source):
        agent_called.append(message)
        return "agent reply"

    monkeypatch.setattr(_wa_mod, "collect_agent_reply", _fake_collect)

    WA_ID = "491702000005"
    OWNER = "user-no-pending"

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_bound_user(conn, WA_ID, OWNER, now)
        # No approval seeded.

    asyncio.run(
        main._handle_whatsapp_message(
            wa_id=WA_ID, text="yes", message_id="wamid.NOPENDING", profile_name="Test"
        )
    )

    # Agent must have received the "yes" message.
    assert "yes" in agent_called
    # Reply is the agent's reply, not an approval confirmation.
    assert sent
    assert sent[-1][1] == "agent reply"


def test_non_owner_yes_cannot_approve(monkeypatch, tmp_path):
    """A bound sender that is NOT the run owner cannot approve another user's run.

    The approval is invisible to non-owners (list_pending returns nothing for
    them), so their 'yes' falls through to the agent pipeline untouched.
    """
    main = _load_api(monkeypatch, tmp_path)
    import channels.whatsapp as _wa_mod

    agent_called: list = []
    approved_runs: list = []
    sent: list[tuple[str, str]] = []

    monkeypatch.setattr(_wa_mod, "_send_whatsapp_typing_indicator", lambda _: None)
    monkeypatch.setattr(_wa_mod, "send_whatsapp_text", lambda to, text: sent.append((to, text)))

    async def _fake_collect(*, message, user_id, conversation_id, source):
        agent_called.append((user_id, message))
        return "agent reply"

    monkeypatch.setattr(_wa_mod, "collect_agent_reply", _fake_collect)
    monkeypatch.setattr(main, "approve_run", lambda *a, **kw: approved_runs.append(a) or types.SimpleNamespace(run_id="x"))

    OWNER_WA_ID = "491702000010"
    OTHER_WA_ID = "491702000011"
    OWNER = "run-owner-user"
    OTHER = "other-user"

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_bound_user(conn, OWNER_WA_ID, OWNER, now)
        _seed_bound_user(conn, OTHER_WA_ID, OTHER, now)
        # Approval owned by OWNER only.
        _seed_approval(conn, "apr_owner000001", "run-owner-run", OWNER, now, label="Owner's action")

    # OTHER sends 'yes' — they have no pending approvals of their own.
    asyncio.run(
        main._handle_whatsapp_message(
            wa_id=OTHER_WA_ID, text="yes", message_id="wamid.NONOWNER", profile_name="Other"
        )
    )

    # approve_run must NOT have been called.
    assert approved_runs == []
    # The "yes" must have reached the agent pipeline.
    assert any(msg == "yes" for _, msg in agent_called)
