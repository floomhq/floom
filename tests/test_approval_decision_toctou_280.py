"""Regression tests for #280 — approval-decision TOCTOU (cloud Supabase repo).

The HITL approve/reject routes gate a real side effect (approving spawns a
follow-up execution run). The decision was a check-then-act race: two concurrent
decisions both passed the "is it pending?" read and both fired the side effect,
so a rejected run could still execute and an approved one could double-spend.

The cloud fix makes `SupabaseApprovalRepository.approve` / `.reject` report
whether *this* call won the atomic claim: the conditional
`UPDATE ... WHERE status='pending'` returns the updated rows in PostgREST's
`.data`, and an empty result (the row was already decided by a concurrent
caller) now yields `None` instead of a re-read. The route only spawns the
follow-up run when it gets a non-None claim, so exactly one decision wins.

These tests drive the real repo against a fake Supabase client whose
conditional UPDATE has true single-winner semantics.
"""

from __future__ import annotations

import threading
from types import SimpleNamespace

from apps.api.db.supabase_repos import SupabaseApprovalRepository


class _ApprovalsClient:
    """Fake Supabase client modeling ONE approval row with an atomic
    `WHERE status='pending'` update — only the first decision flips it."""

    def __init__(self, *, run_id: str):
        self._run_id = run_id
        self._status = "pending"
        self._row = {
            "id": "apr_1",
            "run_id": run_id,
            "owner_id": "u1",
            "status": "pending",
            "follow_up_run_id": None,
            "edited_output_json": None,
        }
        self._lock = threading.Lock()

    # table()/update()/eq() are chainable no-ops that accumulate filter state.
    def table(self, _n):
        self._update_payload = None
        self._require_pending = False
        self._op = None
        return self

    def select(self, *a, **k):
        self._op = "select"
        return self

    def update(self, payload, *a, **k):
        self._op = "update"
        self._update_payload = payload
        return self

    def eq(self, col, val):
        if col == "status" and val == "pending":
            self._require_pending = True
        return self

    def order(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def execute(self):
        if self._op == "select":
            # get_by_run_id newest-first read.
            return SimpleNamespace(data=[dict(self._row)])
        # update: atomic claim semantics.
        with self._lock:
            if self._require_pending and self._status != "pending":
                # Lost the race — zero rows match WHERE status='pending'.
                return SimpleNamespace(data=[])
            # Win: apply the update + return the flipped row.
            self._row.update(self._update_payload or {})
            self._status = self._row.get("status", self._status)
            return SimpleNamespace(data=[dict(self._row)])


def test_approve_then_approve_second_loses():
    """Two sequential approves: first wins (row), second loses (None)."""
    repo = SupabaseApprovalRepository(client=_ApprovalsClient(run_id="run_a"))

    first = repo.approve(owner_id="u1", run_id="run_a", decided_at="t0")
    assert first is not None
    assert first["status"] == "approved"

    second = repo.approve(owner_id="u1", run_id="run_a", decided_at="t1")
    assert second is None, "second concurrent approve must lose the claim"


def test_approve_then_reject_loses():
    """Approve wins; a racing reject afterwards loses (None) — no double action."""
    repo = SupabaseApprovalRepository(client=_ApprovalsClient(run_id="run_b"))

    assert repo.approve(owner_id="u1", run_id="run_b", decided_at="t0") is not None
    assert repo.reject(owner_id="u1", run_id="run_b", decided_at="t1") is None


def test_reject_then_approve_loses():
    """Reject wins; a racing approve afterwards loses (None) — rejected run
    can never spawn a follow-up."""
    repo = SupabaseApprovalRepository(client=_ApprovalsClient(run_id="run_c"))

    won = repo.reject(owner_id="u1", run_id="run_c", decided_at="t0")
    assert won is not None and won["status"] == "rejected"
    assert repo.approve(owner_id="u1", run_id="run_c", decided_at="t1") is None


def test_concurrent_approve_reject_exactly_one_wins():
    """Fire approve + reject concurrently against the same row — exactly one
    returns a row, the other returns None."""
    client = _ApprovalsClient(run_id="run_d")
    repo = SupabaseApprovalRepository(client=client)

    results: dict[str, object] = {}
    barrier = threading.Barrier(2)

    def _approve():
        barrier.wait()
        results["approve"] = repo.approve(owner_id="u1", run_id="run_d", decided_at="t0")

    def _reject():
        barrier.wait()
        results["reject"] = repo.reject(owner_id="u1", run_id="run_d", decided_at="t1")

    ta, tr = threading.Thread(target=_approve), threading.Thread(target=_reject)
    ta.start(); tr.start(); ta.join(); tr.join()

    winners = [k for k, v in results.items() if v is not None]
    losers = [k for k, v in results.items() if v is None]
    assert len(winners) == 1, f"expected exactly one winner, got {results}"
    assert len(losers) == 1, f"expected exactly one loser, got {results}"


def test_attach_follow_up_sets_run_id():
    """attach_follow_up records the spawned run id on the approved row."""
    repo = SupabaseApprovalRepository(client=_ApprovalsClient(run_id="run_e"))
    assert repo.approve(owner_id="u1", run_id="run_e", decided_at="t0") is not None

    row = repo.attach_follow_up(
        owner_id="u1", run_id="run_e", follow_up_run_id="run_followup_1"
    )
    assert row is not None
    assert row["follow_up_run_id"] == "run_followup_1"
