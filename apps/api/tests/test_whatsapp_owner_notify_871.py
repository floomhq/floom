"""#871 — admin/bootstrap-owned approval runs must still notify the run owner
over WhatsApp.

Root cause: notify_pending_approval_via_whatsapp looked up the binding by
WHERE user_id = owner_id, but an admin/FLOOM_SECRET-created run is owned by the
bootstrap id ('federico') while the human's binding is keyed to their real
user uuid → no match → silent pending approval.

Fix: match the binding against the bootstrap<->uuid alternates (admin user
uuids when owner is bootstrap; bootstrap id when owner is a uuid).

Run: cd apps/api && python -m pytest tests/test_whatsapp_owner_notify_871.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_USER_ID", "federico")
    monkeypatch.setenv("WHATSAPP_PHONE_ID", "phone-1")
    monkeypatch.setenv("WHATSAPP_TOKEN", "tok-1")
    for name in list(sys.modules):
        if name == "db" or name.startswith("db.") or name.startswith("channels"):
            sys.modules.pop(name, None)
        for _rn in [n for n in list(sys.modules) if n.startswith("routers")]:
            sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    import channels.common as common
    import channels.whatsapp as wa
    return db, common, wa


def _seed_admin_with_binding(db, *, admin_uuid: str, wa_id: str):
    now = db.now_iso()
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at) "
            "VALUES (?, 'admin', 'Admin', 'x', 'admin', 0, ?, ?)",
            (admin_uuid, now, now),
        )
        conn.execute(
            "INSERT INTO whatsapp_sender_bindings (wa_id, user_id, profile_name, status, created_at, updated_at) "
            "VALUES (?, ?, 'Admin', 'active', ?, ?)",
            (wa_id, admin_uuid, now, now),
        )


def test_bootstrap_owned_run_notifies_admin_binding(env, monkeypatch):
    db, common, wa = env
    admin_uuid = "3900b8e2-93fe-46f6-8c59-cfe14c3c951c"
    _seed_admin_with_binding(db, admin_uuid=admin_uuid, wa_id="15551239709")

    sent = {}
    monkeypatch.setattr(wa, "_whatsapp_configured", lambda: True)
    monkeypatch.setattr(wa, "send_whatsapp_text", lambda wa_id, text: sent.update(wa_id=wa_id, text=text))

    # run is owned by the BOOTSTRAP id, not the admin uuid
    common.notify_pending_approval_via_whatsapp(
        owner_id="federico", run_id="run-1", worker_name="Gmail Brief",
        label="Send email", approval_id="apr_abc123def456",
    )
    assert sent.get("wa_id") == "15551239709", "bootstrap-owned run did not resolve the admin's binding"
    assert "Gmail Brief" in sent.get("text", "")


def test_uuid_owned_run_still_notifies(env, monkeypatch):
    # the normal case (run owner == binding user) keeps working
    db, common, wa = env
    admin_uuid = "uuid-direct-owner"
    _seed_admin_with_binding(db, admin_uuid=admin_uuid, wa_id="15550000000")
    sent = {}
    monkeypatch.setattr(wa, "_whatsapp_configured", lambda: True)
    monkeypatch.setattr(wa, "send_whatsapp_text", lambda wa_id, text: sent.update(wa_id=wa_id))
    common.notify_pending_approval_via_whatsapp(
        owner_id=admin_uuid, run_id="run-2", worker_name="W", label="L", approval_id="apr_x",
    )
    assert sent.get("wa_id") == "15550000000"


def test_no_binding_is_silent_noop(env, monkeypatch):
    db, common, wa = env
    sent = {}
    monkeypatch.setattr(wa, "_whatsapp_configured", lambda: True)
    monkeypatch.setattr(wa, "send_whatsapp_text", lambda wa_id, text: sent.update(wa_id=wa_id))
    common.notify_pending_approval_via_whatsapp(
        owner_id="federico", run_id="run-3", worker_name="W", label="L", approval_id="apr_y",
    )
    assert sent == {}
