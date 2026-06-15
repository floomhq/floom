"""#280: approval-decision TOCTOU — concurrent approve+reject / double-approve.

The HITL approval routes (`POST /runs/{id}/approve` and `.../reject`) gate a
real outbound side effect: approving spawns a follow-up execution run. The old
code was a check-then-act race:

    get_by_run_id() -> "is it pending?"  (check)
    create_run() + start_run()           (act / side effect)
    approvals.approve()                  (flip state, AFTER the side effect)

Two concurrent decisions both passed the check and both spawned a run, and an
approve racing a reject could spawn an execution run for a run the operator had
already rejected ("rejected => nothing runs" broken).

The fix claims the decision atomically *first* (the conditional
`UPDATE ... WHERE status='pending'`, surfaced as a None return when no row was
flipped) and only spawns the follow-up run when this request won the claim.

These tests stub the side effect (`run_service.create_run` / `start_run`) and
hammer the real routes + real sqlite repo concurrently, asserting:
  - exactly ONE decision wins (200) and the loser gets 409,
  - reject-wins => ZERO follow-up runs spawned,
  - approve-wins => exactly ONE follow-up run spawned (no double-spend),
  - and the repo-level claim is itself single-winner.
"""

from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_TEST_DIR = Path(tempfile.mkdtemp(prefix="workeros-approval-toctou-280-"))
_DB_PATH = str(_TEST_DIR / "workeros.db")
os.environ["WORKEROS_DB"] = _DB_PATH
os.environ["FLOOM_DB"] = _DB_PATH
os.environ["WORKEROS_DEPLOY"] = "local"
os.environ["WORKEROS_API_ENV_FILE"] = str(_TEST_DIR / "api.env")
os.environ["FLOOM_BLOBS_DIR"] = str(_TEST_DIR / "blobs")
os.environ["FLOOM_SECRET"] = "test-secret-toctou-280"

import main  # noqa: E402
import run_service  # noqa: E402

_AUTH = {"x-floom-secret": "test-secret-toctou-280"}
_OWNER = "federico"


@pytest.fixture(autouse=True)
def _pin_db_to_this_module():
    os.environ["WORKEROS_DB"] = _DB_PATH
    os.environ["FLOOM_DB"] = _DB_PATH
    os.environ["FLOOM_SECRET"] = "test-secret-toctou-280"
    yield


@pytest.fixture(autouse=True)
def _stub_side_effect(monkeypatch):
    """Stub the follow-up run spawn so the only thing under test is the gate.

    `create_run` records every spawn and returns a fake run id; `start_run` is a
    no-op. The count of `create_run` calls is exactly the number of follow-up
    execution runs that *would* fire — i.e. the double-spend / rejected-still-
    runs blast radius.
    """
    spawned: list[str] = []
    _lock = threading.Lock()
    _n = {"i": 0}

    def _fake_create_run(worker_id, inputs, **kwargs):
        with _lock:
            _n["i"] += 1
            rid = f"run_followup_{_n['i']}"
            spawned.append(rid)
        return rid

    def _fake_start_run(*args, **kwargs):
        return None

    monkeypatch.setattr(run_service, "create_run", _fake_create_run)
    monkeypatch.setattr(run_service, "start_run", _fake_start_run)
    # Routes import these names lazily from `run_service` inside the handler, so
    # patching the module attribute is sufficient.
    yield spawned


def _seed_pending(run_id: str, approval_id: str) -> None:
    repos = main.get_repositories()
    worker_id = f"worker_{approval_id}"
    repos.workers.create(
        user_id=_OWNER,
        worker_id=worker_id,
        name=f"TOCTOU Worker {approval_id}",
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
    )


def _fire_concurrent(calls):
    """Run a list of (method, path) POSTs concurrently, return list of statuses."""
    client = TestClient(main.app)
    results: list[int] = [0] * len(calls)
    barrier = threading.Barrier(len(calls))

    def _worker(idx, path, body):
        barrier.wait()  # maximise overlap on the check-then-act window
        resp = client.post(path, json=body, headers=_AUTH)
        results[idx] = resp.status_code

    threads = [
        threading.Thread(target=_worker, args=(i, path, body))
        for i, (path, body) in enumerate(calls)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


# ---------------------------------------------------------------------------
# Route-level: the actual exploit.
# ---------------------------------------------------------------------------


def test_concurrent_approve_and_reject_one_wins_no_double_action(_stub_side_effect):
    """A. approve + reject concurrently => exactly one 200, one 409.

    Crucially: if the *reject* wins, NO follow-up run may be spawned; if the
    *approve* wins, exactly one is spawned. Either way the decision is consistent
    with the persisted approval status.
    """
    spawned = _stub_side_effect
    _seed_pending("run_ar", "apr_ar")

    statuses = _fire_concurrent([
        ("/runs/run_ar/approve", {}),
        ("/runs/run_ar/reject", {"reason": "race"}),
    ])

    assert sorted(statuses) == [200, 409], statuses

    repos = main.get_repositories()
    final = repos.approvals.get_by_run_id(run_id="run_ar")
    assert final["status"] in {"approved", "rejected"}

    if final["status"] == "rejected":
        # "rejected => nothing runs" guarantee.
        assert spawned == [], spawned
        assert final.get("follow_up_run_id") in (None, "")
    else:
        # approved => exactly one follow-up run, recorded on the row.
        assert len(spawned) == 1, spawned
        assert final.get("follow_up_run_id") == spawned[0]


def test_concurrent_double_approve_spawns_exactly_one_run(_stub_side_effect):
    """B. two concurrent approves => one 200 + one 409 + exactly one run."""
    spawned = _stub_side_effect
    _seed_pending("run_dbl", "apr_dbl")

    statuses = _fire_concurrent([
        ("/runs/run_dbl/approve", {}),
        ("/runs/run_dbl/approve", {}),
    ])

    assert sorted(statuses) == [200, 409], statuses
    assert len(spawned) == 1, f"double-spend: {spawned}"

    repos = main.get_repositories()
    final = repos.approvals.get_by_run_id(run_id="run_dbl")
    assert final["status"] == "approved"
    assert final.get("follow_up_run_id") == spawned[0]


def test_second_decision_after_first_is_409(_stub_side_effect):
    """Sequential: approve, then reject the same run => clean 409, no 2nd run."""
    spawned = _stub_side_effect
    _seed_pending("run_seq", "apr_seq")
    client = TestClient(main.app)

    r1 = client.post("/runs/run_seq/approve", json={}, headers=_AUTH)
    assert r1.status_code == 200, r1.text
    assert len(spawned) == 1

    r2 = client.post("/runs/run_seq/reject", json={"reason": "late"}, headers=_AUTH)
    assert r2.status_code == 409, r2.text
    assert len(spawned) == 1  # no extra spawn


# ---------------------------------------------------------------------------
# Repo-level: the atomic claim is single-winner regardless of caller.
# ---------------------------------------------------------------------------


def test_repo_approve_claim_returns_none_when_already_decided():
    _seed_pending("run_repo_a", "apr_repo_a")
    repos = main.get_repositories()

    first = repos.approvals.approve(
        owner_id=_OWNER, run_id="run_repo_a", decided_at="2026-06-15T11:00:00Z",
    )
    assert first is not None and first["status"] == "approved"

    # Second claim flips zero rows -> None (loser).
    second = repos.approvals.approve(
        owner_id=_OWNER, run_id="run_repo_a", decided_at="2026-06-15T11:00:01Z",
    )
    assert second is None

    # Reject after approve also loses.
    third = repos.approvals.reject(
        owner_id=_OWNER, run_id="run_repo_a", decided_at="2026-06-15T11:00:02Z",
    )
    assert third is None


def test_repo_reject_claim_returns_none_when_already_decided():
    _seed_pending("run_repo_r", "apr_repo_r")
    repos = main.get_repositories()

    first = repos.approvals.reject(
        owner_id=_OWNER, run_id="run_repo_r", decided_at="2026-06-15T11:00:00Z",
    )
    assert first is not None and first["status"] == "rejected"

    second = repos.approvals.approve(
        owner_id=_OWNER, run_id="run_repo_r", decided_at="2026-06-15T11:00:01Z",
    )
    assert second is None


def test_unique_partial_index_blocks_second_pending_row():
    """C. amplifier: a second pending approval row per run is rejected by the
    UNIQUE partial index (migration 80)."""
    import sqlite3

    _seed_pending("run_uniq", "apr_uniq_1")
    repos = main.get_repositories()
    with pytest.raises(sqlite3.IntegrityError):
        repos.approvals.create(
            owner_id=_OWNER,
            id="apr_uniq_2",
            run_id="run_uniq",  # same run, second pending row
            worker_id="worker_apr_uniq_1",
            status="pending",
            label="dup",
            preview="dup",
            decision_input_json="{}",
            created_at="2026-06-15T10:05:00Z",
        )
