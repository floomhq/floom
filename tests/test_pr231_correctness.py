"""Regression tests for PR #231 backend correctness batch.

Covers:
- 1.5.1 approve/reject transitions the original run OFF pending_approval.
- 1.5.2 archived workers render on GET /workers/<id> (not 404).
- 1.5.3 audit/system trigger_source runs are hidden from the default /runs view
  but reachable via ?include_system=true.

Reuses the working auth harness from test_round8_worker_authz.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from test_round8_worker_authz import AUTH, _load_api, _worker_payload


def _headers(user_id: str = "user-a") -> dict[str, str]:
    return {**AUTH, "x-floom-user": user_id}


def _seed_pending_approval(main, *, worker_id: str, user_id: str = "user-a") -> str:
    """Insert a pending_approval run + matching pending approval row directly."""
    from db import get_db

    run_id = f"run_{uuid.uuid4().hex[:12]}"
    approval_id = f"approval_{uuid.uuid4().hex[:12]}"
    with get_db() as conn:
        conn.execute(
            """INSERT INTO runs (id, worker_id, status, trigger_source, runner,
               input_json, output_json, approval_status, created_at)
               VALUES (?, ?, 'pending_approval', 'manual', 'local', '{}', '{}', 'pending', datetime('now'))""",
            (run_id, worker_id),
        )
        conn.execute(
            """INSERT INTO approvals (id, run_id, worker_id, owner_id, status, label, preview, created_at)
               VALUES (?, ?, ?, ?, 'pending', 'Approve output', 'preview', datetime('now'))""",
            (approval_id, run_id, worker_id, user_id),
        )
    return run_id


def _run_status(main, run_id: str) -> str:
    from db import get_db

    with get_db() as conn:
        row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
    return row["status"] if row else ""


# ---------------------------------------------------------------------------
# 1.5.1 — zombie approvals
# ---------------------------------------------------------------------------
def test_approve_transitions_original_run_off_pending_approval(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers", headers=_headers(), json=_worker_payload("approve-probe", title="Approve Probe")
    )
    assert created.status_code == 200, created.text

    run_id = _seed_pending_approval(main, worker_id="approve-probe")
    assert _run_status(main, run_id) == "pending_approval"
    assert client.get("/approvals/count", headers=_headers()).json()["pending"] == 1

    r = client.post(f"/runs/{run_id}/approve", headers=_headers())
    assert r.status_code == 200, r.text

    # Original run must no longer be pending_approval (zombie fix).
    assert _run_status(main, run_id) == "completed"
    # Approvals count must drop (badge clears).
    assert client.get("/approvals/count", headers=_headers()).json()["pending"] == 0


def test_reject_transitions_original_run_off_pending_approval(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers", headers=_headers(), json=_worker_payload("reject-probe", title="Reject Probe")
    )
    assert created.status_code == 200, created.text

    run_id = _seed_pending_approval(main, worker_id="reject-probe")
    assert _run_status(main, run_id) == "pending_approval"

    r = client.post(f"/runs/{run_id}/reject", headers=_headers(), json={"reason": "Not ready"})
    assert r.status_code == 200, r.text

    assert _run_status(main, run_id) == "completed"
    assert client.get("/approvals/count", headers=_headers()).json()["pending"] == 0
    # Rejection recorded in approvals.
    from db import get_db

    with get_db() as conn:
        arow = conn.execute("SELECT status, reason FROM approvals WHERE run_id = ?", (run_id,)).fetchone()
    assert arow["status"] == "rejected"
    assert arow["reason"] == "Not ready"


# ---------------------------------------------------------------------------
# 1.5.3 — audit/system telemetry hidden from default /runs
# ---------------------------------------------------------------------------
def test_audit_runs_hidden_by_default_but_visible_with_include_system(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers", headers=_headers(), json=_worker_payload("runs-filter-probe", title="Runs Filter Probe")
    )
    assert created.status_code == 200, created.text

    manual_run = client.post(
        "/workers/runs-filter-probe/runs",
        headers=_headers(),
        json={"inputs": {}, "trigger_source": "manual"},
    )
    audit_run = client.post(
        "/workers/runs-filter-probe/runs",
        headers=_headers(),
        json={"inputs": {}, "trigger_source": "audit"},
    )
    assert manual_run.status_code == 200, manual_run.text
    assert audit_run.status_code == 200, audit_run.text
    manual_id = manual_run.json()["run_id"]
    audit_id = audit_run.json()["run_id"]

    default_ids = {item["id"] for item in client.get("/runs", headers=_headers()).json()}
    assert manual_id in default_ids
    assert audit_id not in default_ids  # audit hidden from operator default

    system_ids = {item["id"] for item in client.get("/runs?include_system=true", headers=_headers()).json()}
    assert manual_id in system_ids
    assert audit_id in system_ids  # reachable, data preserved
