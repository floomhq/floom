"""#865 — channel bindings persist + validate workspace identity.

Pins:
  - migration 72: slack_sender_bindings has a workspace_id column
  - Slack claim pins a validated workspace (default workspace for unscoped
    auth ids) and stores it on the binding
  - Slack claim rejects a workspace that does not exist for the claimer
  - lookup validates the BASE user id, so a workspace-scoped binding
    ("base__ws_x") is NOT reset as deleted (the reported bug)
  - lookup still resets bindings whose base user is genuinely gone
  - WhatsApp cloud claims persist NULL workspace_id (no fabricated
    'local-default')

Run: cd apps/api && python -m pytest tests/test_865_channel_binding_workspace_identity.py -q
"""
from __future__ import annotations

import importlib
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

TEAM = "T865"
SENDER = "U865"


def _load_api(monkeypatch, tmp_path, *, deploy: str = "local"):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir(exist_ok=True)
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-865")
    monkeypatch.setenv("WORKEROS_USER_ID", "owner-865")
    monkeypatch.setenv("WORKEROS_DEPLOY", deploy)
    monkeypatch.setenv("SLACK_LEGACY_SINGLE_USER", "0")
    for name in list(sys.modules):
        if name in ("main", "db", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("channels", "auth", "db.")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None
    )
    return importlib.import_module("main")


def _seed_pending_claim(token: str = "claimtok865") -> None:
    from db import get_db, now_iso

    expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, user_id, status, claim_token,
                 claim_expires_at, created_at, updated_at, last_seen_at)
            VALUES (?, ?, NULL, 'pending', ?, ?, ?, ?, ?)
            """,
            (TEAM, SENDER, token, expires, now_iso(), now_iso(), now_iso()),
        )


def test_migration_adds_workspace_id_column(monkeypatch, tmp_path):
    _load_api(monkeypatch, tmp_path)
    from db import get_db

    with get_db() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(slack_sender_bindings)").fetchall()}
    assert "workspace_id" in cols


def test_slack_claim_pins_default_workspace(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    from fastapi.testclient import TestClient

    _seed_pending_claim()
    client = TestClient(main.app, headers={"x-floom-secret": "test-secret-865"})
    resp = client.post("/slack/bindings/claim", json={"token": "claimtok865"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["workspace_id"] == "local-default"

    from db import get_db

    with get_db() as conn:
        row = conn.execute(
            "SELECT user_id, workspace_id, status FROM slack_sender_bindings "
            "WHERE slack_team_id = ? AND slack_user_id = ?",
            (TEAM, SENDER),
        ).fetchone()
    assert row["status"] == "active"
    assert row["workspace_id"] == "local-default"


def test_scoped_binding_survives_lookup_validation(monkeypatch, tmp_path):
    """The reported bug: 'base__ws_x' bindings were reset as deleted because
    the raw scoped id was validated against users.id directly."""
    main = _load_api(monkeypatch, tmp_path)
    from channels.slack import _slack_binding_user_id
    from db import get_db, now_iso

    scoped = "owner-865__ws_aaaaaaaaaaaaaa"  # base id is the always-valid bootstrap owner
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, user_id, workspace_id, status,
                 created_at, updated_at, last_seen_at)
            VALUES (?, ?, ?, 'ws_aaaaaaaaaaaaaa', 'active', ?, ?, ?)
            """,
            (TEAM, SENDER, scoped, now_iso(), now_iso(), now_iso()),
        )

    assert _slack_binding_user_id(TEAM, SENDER) == scoped

    with get_db() as conn:
        row = conn.execute(
            "SELECT status FROM slack_sender_bindings WHERE slack_team_id = ? AND slack_user_id = ?",
            (TEAM, SENDER),
        ).fetchone()
    assert row["status"] == "active", "scoped binding must NOT be reset as deleted"


def test_deleted_base_user_still_resets_binding(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    from db import get_db, now_iso

    # configured deployment so validation fail-closes for unknown users
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-865")
    with get_db() as conn:
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, created_at, updated_at) "
            "VALUES ('real-user', 'real-user', 'x', 'member', ?, ?)",
            (now_iso(), now_iso()),
        )
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, user_id, workspace_id, status,
                 created_at, updated_at, last_seen_at)
            VALUES (?, ?, 'ghost-user__ws_bbbbbbbbbbbbbb', 'ws_bbbbbbbbbbbbbb', 'active', ?, ?, ?)
            """,
            (TEAM, SENDER, now_iso(), now_iso(), now_iso()),
        )

    from channels.slack import _slack_binding_user_id

    assert _slack_binding_user_id(TEAM, SENDER) is None
    with get_db() as conn:
        row = conn.execute(
            "SELECT status, user_id FROM slack_sender_bindings WHERE slack_team_id = ?",
            (TEAM,),
        ).fetchone()
    assert row["status"] == "pending" and row["user_id"] is None


def test_whatsapp_cloud_claim_persists_null_workspace(monkeypatch, tmp_path):
    # boot in local mode (the engine ships no cloud AuthProvider); the claim
    # route reads WORKEROS_DEPLOY at request time, so flip it before the POST
    main = _load_api(monkeypatch, tmp_path)
    from db import get_db, now_iso

    expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, status, claim_token, claim_expires_at,
                 created_at, updated_at, last_seen_at)
            VALUES ('4912345', NULL, 'pending', 'watok865', ?, ?, ?, ?)
            """,
            (expires, now_iso(), now_iso(), now_iso()),
        )

    # call the route handler directly with a fake auth context: the engine
    # ships no cloud AuthProvider, so flipping WORKEROS_DEPLOY before an HTTP
    # request would break the auth dependency, not just the claim branch
    from channels.whatsapp import WhatsAppClaimRequest, claim_whatsapp_sender

    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    result = claim_whatsapp_sender(
        WhatsAppClaimRequest(token="watok865"),
        auth=types.SimpleNamespace(user_id="cloud-user-1"),
    )
    assert result["ok"] is True, result

    with get_db() as conn:
        row = conn.execute(
            "SELECT workspace_id, status FROM whatsapp_sender_bindings WHERE wa_id = '4912345'"
        ).fetchone()
    assert row["status"] == "active"
    assert row["workspace_id"] is None, (
        "cloud claims must not fabricate 'local-default'; the cloud repository "
        "owns workspace resolution (#865)"
    )


def test_slack_claim_rejects_nonexistent_workspace(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    _seed_pending_claim(token="claimtok865b")

    from fastapi import HTTPException

    from channels.slack import SlackClaimRequest, claim_slack_sender

    with pytest.raises(HTTPException) as exc_info:
        claim_slack_sender(
            SlackClaimRequest(token="claimtok865b"),
            auth=types.SimpleNamespace(user_id="owner-865__ws_cccccccccccccc"),
        )
    assert exc_info.value.status_code == 400
    assert "does not exist" in str(exc_info.value.detail)

    from db import get_db

    with get_db() as conn:
        row = conn.execute(
            "SELECT status FROM slack_sender_bindings WHERE slack_team_id = ?", (TEAM,)
        ).fetchone()
    assert row["status"] == "pending", "failed claim must not activate the binding"
