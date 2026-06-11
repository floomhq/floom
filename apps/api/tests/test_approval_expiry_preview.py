"""#798 approval TTL/expiry + #792 typed approval preview.

#798: pending approvals carry expires_at and are auto-expired by
_expire_stale_approvals (run moves off pending_approval).
#792: approvals carry preview_type + preview_payload (parsed) for type-aware
rendering. Both surfaced via _approval_response.

Run: cd apps/api && python -m pytest tests/test_approval_expiry_preview.py -q
"""
from __future__ import annotations

import importlib
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

OWNER = "federico"


@pytest.fixture
def main_mod(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main"), db


def _seed_worker_run(main, db, *, run_id, status):
    repos = main.get_repositories()
    repos.workers.create(
        user_id=OWNER, worker_id="appr-w", name="appr-w",
        manifest_json='{"id":"appr-w","name":"appr-w","version":"0.1.0","trigger":{"type":"manual"},'
                      '"runtime":{"type":"python","entrypoint":"run.py","runner":"e2b"},'
                      '"inputs":[],"outputs":[],"secrets":[]}',
        bundle_path="workers/appr-w",
    )
    repos.runs.create(
        user_id=OWNER, run_id=run_id, worker_id="appr-w", status=status,
        trigger_source="manual", runner="e2b", input_json={}, output_json={},
    )
    return repos


def test_expire_stale_approval(main_mod):
    main, db = main_mod
    repos = _seed_worker_run(main, db, run_id="run-exp", status=main.RunStatus.PENDING_APPROVAL.value)
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    repos.approvals.create(
        owner_id=OWNER, id="apr-exp", run_id="run-exp", worker_id="appr-w",
        status="pending", label="x", preview="p", created_at=main.now_iso(),
        expires_at=past, decision_input_json="{}",
    )
    n = main._expire_stale_approvals()
    assert n == 1
    row = repos.approvals.get(owner_id=OWNER, approval_id="apr-exp")
    assert row["status"] == "expired"
    # run moved off pending_approval
    with db.get_db() as conn:
        st = conn.execute("SELECT status FROM runs WHERE id = 'run-exp'").fetchone()["status"]
    assert st == main.RunStatus.FAILED.value


def test_unexpired_approval_untouched(main_mod):
    main, db = main_mod
    repos = _seed_worker_run(main, db, run_id="run-live", status=main.RunStatus.PENDING_APPROVAL.value)
    future = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
    repos.approvals.create(
        owner_id=OWNER, id="apr-live", run_id="run-live", worker_id="appr-w",
        status="pending", label="x", preview="p", created_at=main.now_iso(),
        expires_at=future, decision_input_json="{}",
    )
    assert main._expire_stale_approvals() == 0
    assert repos.approvals.get(owner_id=OWNER, approval_id="apr-live")["status"] == "pending"


def test_response_surfaces_expiry_and_typed_preview(main_mod):
    main, db = main_mod
    repos = _seed_worker_run(main, db, run_id="run-typed", status=main.RunStatus.PENDING_APPROVAL.value)
    future = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
    repos.approvals.create(
        owner_id=OWNER, id="apr-typed", run_id="run-typed", worker_id="appr-w",
        status="pending", label="Send email", preview="p", created_at=main.now_iso(),
        expires_at=future, preview_type="email",
        preview_payload_json='{"to":"a@b.com","subject":"Hi","body":"hello"}',
        decision_input_json="{}",
    )
    row = repos.approvals.get(owner_id=OWNER, approval_id="apr-typed")
    resp = main._approval_response(row, repos)
    assert resp["expires_at"] == future
    assert resp["preview_type"] == "email"
    assert resp["preview_payload"] == {"to": "a@b.com", "subject": "Hi", "body": "hello"}
    assert "preview_payload_json" not in resp
