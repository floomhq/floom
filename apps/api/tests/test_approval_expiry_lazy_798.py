"""#798 LAZY approval expiry — read/action-time enforcement.

expires_at is stored on creation and previewed, and an hourly sweep
(_expire_stale_approvals) flips stale rows. But between sweeps a pending row can
be past its expires_at while still status='pending' in the DB. These tests pin
the LAZY guard that closes that window on the read AND action paths:

  1. listing pending approvals flips + drops a row past expires_at, so it
     surfaces as 'expired', not 'pending';
  2. approving an expired approval is refused (409) and fires NO side effect
     (no follow-up execution run is spawned) — the #418 fire-on-approve gate
     must never fire for an expired approval;
  3. a non-expired approval still approves normally and spawns exactly one run.

Harness mirrors test_approval_decision_toctou_280.py: real routes + real sqlite
repo, with run_service.create_run / start_run stubbed so a spawn is observable
(and so "zero spawns" proves the side effect was blocked).

Run: cd apps/api && python -m pytest tests/test_approval_expiry_lazy_798.py -q
"""

from __future__ import annotations

import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_TEST_DIR = Path(tempfile.mkdtemp(prefix="workeros-approval-expiry-798-"))
_DB_PATH = str(_TEST_DIR / "workeros.db")

main = None
run_service = None

_AUTH = {"x-floom-secret": "test-secret-expiry-798"}
_OWNER = "federico"


def _reset_api_modules() -> None:
    try:
        from auth.factory import get_auth_provider

        get_auth_provider.cache_clear()
    except Exception:
        pass
    for name in list(sys.modules):
        if (
            name in ("main", "run_service", "worker_registry", "runner_utils")
            or name in ("auth", "db", "routers")
            or name.startswith(("db.", "auth.", "routers."))
        ):
            sys.modules.pop(name, None)


@pytest.fixture(autouse=True)
def _pin_db_to_this_module(monkeypatch):
    monkeypatch.setenv("WORKEROS_DB", _DB_PATH)
    monkeypatch.setenv("FLOOM_DB", _DB_PATH)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(_TEST_DIR / "api.env"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(_TEST_DIR / "blobs"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-expiry-798")
    _reset_api_modules()
    global main, run_service
    import main as main_mod  # noqa: PLC0415
    import run_service as run_service_mod  # noqa: PLC0415

    main = main_mod
    run_service = run_service_mod
    main.init_db()
    main.get_repositories.cache_clear()
    yield
    main = None
    run_service = None
    _reset_api_modules()


@pytest.fixture(autouse=True)
def _stub_side_effect(monkeypatch, _pin_db_to_this_module):
    """Stub the follow-up run spawn so the count of create_run calls IS the
    number of side effects that would fire. Zero spawns proves the side effect
    was blocked (e.g. by an expired approval)."""
    spawned: list[str] = []
    _lock = threading.Lock()
    _n = {"i": 0}

    def _fake_create_run(worker_id, inputs, **kwargs):
        with _lock:
            _n["i"] += 1
            rid = f"run_followup_{_n['i']}"
            spawned.append(rid)
        try:
            repos = main.get_repositories()
            repos.runs.create(
                user_id=_OWNER,
                run_id=rid,
                worker_id=worker_id,
                status=kwargs.get("status") or main.RunStatus.RUNNING.value,
                trigger_source=kwargs.get("trigger_source") or "approval",
                runner="e2b",
                input_json=inputs,
            )
        except Exception:
            pass
        return rid

    def _fake_start_run(*args, **kwargs):
        return None

    monkeypatch.setattr(run_service, "create_run", _fake_create_run)
    monkeypatch.setattr(run_service, "start_run", _fake_start_run)
    yield spawned


def _seed_pending(run_id: str, approval_id: str, *, expires_at: str | None) -> None:
    repos = main.get_repositories()
    worker_id = f"worker_{approval_id}"
    repos.workers.create(
        user_id=_OWNER,
        worker_id=worker_id,
        name=f"Expiry Worker {approval_id}",
        manifest_json={
            "id": worker_id,
            "name": worker_id,
            "version": f"0.1.0-{approval_id}",
            "trigger": {"type": "manual"},
            "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
            "inputs": [],
            "outputs": [],
            "secrets": [],
        },
        bundle_path=f"workers/{worker_id}",
    )
    repos.runs.create(
        user_id=_OWNER,
        run_id=run_id,
        worker_id=worker_id,
        status=main.RunStatus.PENDING_APPROVAL.value,
        trigger_source="manual",
        runner="e2b",
        input_json={},
        output_json={"proposed": "draft to be sent"},
    )
    repos.approvals.create(
        owner_id=_OWNER,
        id=approval_id,
        run_id=run_id,
        worker_id=worker_id,
        status="pending",
        label="Approve send",
        preview="draft to be sent",
        decision_input_json="{}",
        created_at="2026-06-15T10:00:00Z",
        expires_at=expires_at,
    )


def _past() -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()


def _future() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()


# ---------------------------------------------------------------------------
# (1) read path: a pending approval past expires_at surfaces as 'expired'.
# ---------------------------------------------------------------------------


def test_listing_pending_surfaces_expired_not_pending(_stub_side_effect):
    _seed_pending("run_exp_list", "apr_exp_list", expires_at=_past())
    client = TestClient(main.app)

    resp = client.get("/approvals", headers=_AUTH)
    assert resp.status_code == 200, resp.text
    # The stale row must NOT appear in the default (pending) list.
    pending_ids = [a["id"] for a in resp.json()]
    assert "apr_exp_list" not in pending_ids, resp.json()

    # And it is persisted as 'expired' (visible on the explicit expired filter).
    repos = main.get_repositories()
    row = repos.approvals.get(owner_id=_OWNER, approval_id="apr_exp_list")
    assert row["status"] == "expired", row

    exp_resp = client.get("/approvals", params={"status": "expired"}, headers=_AUTH)
    assert exp_resp.status_code == 200, exp_resp.text
    assert "apr_exp_list" in [a["id"] for a in exp_resp.json()]


# ---------------------------------------------------------------------------
# (2) action path: approving an expired approval is refused + fires NO side effect.
# ---------------------------------------------------------------------------


def test_approving_expired_is_refused_and_fires_no_side_effect(_stub_side_effect):
    spawned = _stub_side_effect
    _seed_pending("run_exp_appr", "apr_exp_appr", expires_at=_past())
    client = TestClient(main.app)

    resp = client.post("/runs/run_exp_appr/approve", json={}, headers=_AUTH)
    assert resp.status_code == 409, resp.text

    # #418 fire-exactly-once guard for expiry: ZERO follow-up runs spawned.
    assert spawned == [], spawned

    repos = main.get_repositories()
    row = repos.approvals.get_by_run_id(run_id="run_exp_appr")
    assert row["status"] == "expired", row
    # Never stamped a follow_up_run_id (the engine EXECUTE-phase signal).
    assert row.get("follow_up_run_id") in (None, ""), row
    # Run moved off pending_approval (no zombie).
    assert row["status"] != "pending"


def test_rejecting_expired_is_refused(_stub_side_effect):
    spawned = _stub_side_effect
    _seed_pending("run_exp_rej", "apr_exp_rej", expires_at=_past())
    client = TestClient(main.app)

    resp = client.post("/runs/run_exp_rej/reject", json={"reason": "late"}, headers=_AUTH)
    assert resp.status_code == 409, resp.text
    assert spawned == [], spawned

    repos = main.get_repositories()
    row = repos.approvals.get_by_run_id(run_id="run_exp_rej")
    assert row["status"] == "expired", row


# ---------------------------------------------------------------------------
# (3) a non-expired approval still works (approve spawns exactly one run).
# ---------------------------------------------------------------------------


def test_non_expired_approval_still_approves(_stub_side_effect):
    spawned = _stub_side_effect
    _seed_pending("run_live", "apr_live", expires_at=_future())
    client = TestClient(main.app)

    resp = client.post("/runs/run_live/approve", json={}, headers=_AUTH)
    assert resp.status_code == 200, resp.text
    assert len(spawned) == 1, spawned

    repos = main.get_repositories()
    row = repos.approvals.get_by_run_id(run_id="run_live")
    assert row["status"] == "approved", row
    assert row.get("follow_up_run_id") == spawned[0]


def test_non_expired_approval_lists_as_pending(_stub_side_effect):
    _seed_pending("run_live_list", "apr_live_list", expires_at=_future())
    client = TestClient(main.app)

    resp = client.get("/approvals", headers=_AUTH)
    assert resp.status_code == 200, resp.text
    assert "apr_live_list" in [a["id"] for a in resp.json()], resp.json()
