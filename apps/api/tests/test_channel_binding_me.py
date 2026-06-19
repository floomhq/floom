"""Tests for GET/DELETE /slack/bindings/me and GET/DELETE /whatsapp/bindings/me.

These endpoints return the authenticated caller's binding status and support
self-service unlinking.  They are auth-gated — requests without credentials
must be rejected.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "binding-me-test-user")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "test-signing-secret")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "TTEST")
    monkeypatch.setenv("SLACK_LEGACY_SINGLE_USER", "0")
    for var in ("WHATSAPP_PHONE_ID", "WHATSAPP_TOKEN", "WHATSAPP_APP_SECRET",
                "WHATSAPP_WEBHOOK_VERIFY_TOKEN"):
        monkeypatch.setenv(var, "")

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "chat_service",
                 "channels.slack", "channels.whatsapp", "channels.common"]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)
    for key in list(sys.modules.keys()):
        if key.startswith("channels"):
            sys.modules.pop(key, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


_AUTH = {"x-floom-secret": "test-api-secret"}


# ---------------------------------------------------------------------------
# GET /slack/bindings/me
# ---------------------------------------------------------------------------

def test_slack_binding_me_returns_not_linked_when_no_binding(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.get("/slack/bindings/me", headers=_AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"linked": False}


def test_slack_binding_me_returns_linked_data(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)

    # Insert an active binding for the bootstrap user.
    with main.get_db() as conn:
        now = main.now_iso()
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, user_id, profile_name, status, created_at, updated_at)
            VALUES ('TTEST', 'UTEST', 'binding-me-test-user', 'Test User', 'active', ?, ?)
            """,
            (now, now),
        )

    with TestClient(main.app) as client:
        resp = client.get("/slack/bindings/me", headers=_AUTH)

    assert resp.status_code == 200
    body = resp.json()
    assert body["linked"] is True
    assert body["slack_user_id"] == "UTEST"
    assert body["slack_team_id"] == "TTEST"
    assert body["profile_name"] == "Test User"


def test_slack_binding_me_requires_auth(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.get("/slack/bindings/me")
    assert resp.status_code in {401, 403}


# ---------------------------------------------------------------------------
# DELETE /slack/bindings/me (unlink)
# ---------------------------------------------------------------------------

def test_slack_unlink_removes_active_binding(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)

    with main.get_db() as conn:
        now = main.now_iso()
        conn.execute(
            """
            INSERT INTO slack_sender_bindings
                (slack_team_id, slack_user_id, user_id, profile_name, status, created_at, updated_at)
            VALUES ('TTEST', 'U_UNLINK', 'binding-me-test-user', 'Unlink Test', 'active', ?, ?)
            """,
            (now, now),
        )

    with TestClient(main.app) as client:
        resp = client.delete("/slack/bindings/me", headers=_AUTH)

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["unlinked"] == 1

    # Verify row is now unlinked.
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status, user_id FROM slack_sender_bindings WHERE slack_user_id='U_UNLINK'"
        ).fetchone()
    assert row["status"] == "unlinked"
    assert row["user_id"] is None


def test_slack_unlink_is_idempotent_when_not_linked(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.delete("/slack/bindings/me", headers=_AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["unlinked"] == 0


def test_slack_unlink_requires_auth(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.delete("/slack/bindings/me")
    assert resp.status_code in {401, 403}


# ---------------------------------------------------------------------------
# GET /whatsapp/bindings/me
# ---------------------------------------------------------------------------

def test_whatsapp_binding_me_returns_not_linked_when_no_binding(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.get("/whatsapp/bindings/me", headers=_AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"linked": False}


def test_whatsapp_binding_me_returns_linked_data_with_masked_id(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)

    with main.get_db() as conn:
        now = main.now_iso()
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, created_at, updated_at)
            VALUES ('4917012345678', 'binding-me-test-user', 'WA User', 'active', ?, ?)
            """,
            (now, now),
        )

    with TestClient(main.app) as client:
        resp = client.get("/whatsapp/bindings/me", headers=_AUTH)

    assert resp.status_code == 200
    body = resp.json()
    assert body["linked"] is True
    assert body["profile_name"] == "WA User"
    # Masked: only last 4 digits visible.
    assert body["wa_id_masked"].endswith("5678")
    assert "4917012" not in body["wa_id_masked"], "wa_id must be masked, not returned in full"


def test_whatsapp_binding_me_requires_auth(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.get("/whatsapp/bindings/me")
    assert resp.status_code in {401, 403}


# ---------------------------------------------------------------------------
# DELETE /whatsapp/bindings/me (unlink)
# ---------------------------------------------------------------------------

def test_whatsapp_unlink_removes_active_binding(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)

    with main.get_db() as conn:
        now = main.now_iso()
        conn.execute(
            """
            INSERT INTO whatsapp_sender_bindings
                (wa_id, user_id, profile_name, status, created_at, updated_at)
            VALUES ('49170unlinktest', 'binding-me-test-user', 'Unlink WA', 'active', ?, ?)
            """,
            (now, now),
        )

    with TestClient(main.app) as client:
        resp = client.delete("/whatsapp/bindings/me", headers=_AUTH)

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["unlinked"] == 1

    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status, user_id FROM whatsapp_sender_bindings WHERE wa_id='49170unlinktest'"
        ).fetchone()
    assert row["status"] == "unlinked"
    assert row["user_id"] is None


def test_whatsapp_unlink_is_idempotent_when_not_linked(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.delete("/whatsapp/bindings/me", headers=_AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["unlinked"] == 0


def test_whatsapp_unlink_requires_auth(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        resp = client.delete("/whatsapp/bindings/me")
    assert resp.status_code in {401, 403}
