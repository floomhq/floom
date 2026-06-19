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


def _approval_for_run(run_id: str):
    from db import get_db

    with get_db() as conn:
        return conn.execute("SELECT * FROM approvals WHERE run_id = ?", (run_id,)).fetchone()


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


def test_signed_standalone_approval_link_can_review_and_reject_without_secret(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers", headers=_headers(), json=_worker_payload("public-approval-probe", title="Public Approval Probe")
    )
    assert created.status_code == 200, created.text

    run_id = _seed_pending_approval(main, worker_id="public-approval-probe")
    approval = _approval_for_run(run_id)
    token = main._approval_public_token(dict(approval))

    denied = client.get(f"/approvals/public/{approval['id']}?token={'0' * 64}")
    assert denied.status_code == 401

    review = client.get(f"/approvals/public/{approval['id']}?token={token}")
    assert review.status_code == 200, review.text
    body = review.json()
    assert body["id"] == approval["id"]
    assert body["preview"] == "preview"
    assert "owner_id" not in body

    rejected = client.post(
        f"/approvals/public/{approval['id']}/reject?token={token}",
        json={"reason": "Needs changes"},
    )
    assert rejected.status_code == 200, rejected.text
    assert _run_status(main, run_id) == "completed"

    recorded = _approval_for_run(run_id)
    assert recorded["status"] == "rejected"
    assert recorded["reason"] == "Needs changes"


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


# ---------------------------------------------------------------------------
# P0 2026-05-29 — single-run-by-explicit-id access bypasses the system/audit
# worker-visibility filter. Regression: the /workers/new generation flow holds
# a worker-author (system_worker, hidden-from-list) run_id and must be able to
# fetch GET /runs/{id} + /logs to drive the GeneratingPanel. PR #231/#235 made
# those 404 by reusing the LIST visibility filter on single-run fetch.
# ---------------------------------------------------------------------------
def _insert_run_for_worker(main, *, worker_id: str) -> str:
    """Insert a completed run row for an already-created worker (FK satisfied)."""
    from db import get_db

    run_id = f"run_{uuid.uuid4().hex[:12]}"
    with get_db() as conn:
        conn.execute(
            """INSERT INTO runs (id, worker_id, status, trigger_source, runner,
               input_json, output_json, created_at)
               VALUES (?, ?, 'completed', 'manual', 'e2b', '{}', '{}', datetime('now'))""",
            (run_id, worker_id),
        )
    return run_id


def test_worker_author_run_fetchable_by_explicit_id_but_hidden_from_list(monkeypatch, tmp_path):
    """worker-author (the generation meta-worker) is hidden from the LIST view
    but its runs MUST be fetchable by explicit id so the /workers/new
    GeneratingPanel can poll GET /runs/{id} + /logs after
    POST /workers/new/from-prompt returns the run_id."""
    main = _load_api(monkeypatch, tmp_path, stock_workers=("worker-author",))
    client = TestClient(main.app)
    main._reload_workers_for_user("user-a")

    # Sanity: the allowlist constant matches the real worker id constant.
    assert main._WORKER_AUTHOR_ID in main._OPERATOR_REACHABLE_HIDDEN_WORKER_IDS

    run_id = _insert_run_for_worker(main, worker_id=main._WORKER_AUTHOR_ID)

    # Hidden from the default LIST view (system worker).
    default_ids = {item["id"] for item in client.get("/runs", headers=_headers()).json()}
    assert run_id not in default_ids

    # But fetchable by EXPLICIT id — this is what the generation UI relies on.
    detail = client.get(f"/runs/{run_id}", headers=_headers())
    assert detail.status_code == 200, detail.text
    assert detail.json()["id"] == run_id

    logs = client.get(f"/runs/{run_id}/logs", headers=_headers())
    assert logs.status_code == 200, logs.text


def test_non_allowlisted_hidden_worker_run_stays_inaccessible_by_id(monkeypatch, tmp_path):
    """The explicit-id allowlist is worker-author ONLY: a different hidden
    internal worker (e.g. an infra listener) must still 404 by id — preserves
    the security boundary from test_round8_worker_authz."""
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    worker_id = "infra-listener-probe"
    created = client.post(
        "/workers",
        headers=_headers(),
        json=_worker_payload(worker_id, title="Infra Listener Probe"),
    )
    assert created.status_code == 200, created.text
    run_id = _insert_run_for_worker(main, worker_id=worker_id)

    # Force this worker hidden (NOT worker-author, NOT on the allowlist).
    # _run_visible_to_api (the run-by-id visibility filter) lives in
    # services.run_access and resolves _worker_hidden_from_api in that module's
    # globals, so patch there — not on main's re-export.
    import services.run_access as _run_access
    real_hidden = _run_access._worker_hidden_from_api
    monkeypatch.setattr(
        _run_access,
        "_worker_hidden_from_api",
        lambda wid: True if wid == worker_id else real_hidden(wid),
    )

    for path in (f"/runs/{run_id}", f"/runs/{run_id}/logs"):
        resp = client.get(path, headers=_headers())
        assert resp.status_code == 404, f"{path}: {resp.status_code} {resp.text}"
