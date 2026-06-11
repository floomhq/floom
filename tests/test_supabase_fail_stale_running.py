"""Unit test for SupabaseRunRepository.fail_stale_running — the cloud impl of the
engine's run-reaper Protocol method (engine apps/api/db/sqlite.py).

Regression guard for the engine bump that added `fail_stale_running` to the run
repository interface: cloud startup recovery (recover_cloud_runs_on_startup ->
engine reap_abandoned_runs) calls it, and the cloud's SupabaseRunRepository must
implement it or boot fails with AttributeError. The existing
test_cloud_startup_recovery.py mocks the engine call, so it does not exercise
this method — this test does.
"""
from __future__ import annotations

from apps.api.db.supabase_repos import SupabaseRunRepository

CUTOFF = "2026-06-11T00:00:00+00:00"  # runs started before this are stale


class _FakeResp:
    def __init__(self, data):
        self.data = data


class _FakeRunsTable:
    def __init__(self, store: dict):
        self._store = store
        self._mode = None
        self._payload = None
        self._eq: dict = {}

    def select(self, _cols, **_kw):
        self._mode = "select"
        return self

    def update(self, payload):
        self._mode = "update"
        self._payload = payload
        return self

    def eq(self, key, value):
        self._eq[key] = value
        return self

    def execute(self):
        if self._mode == "select":
            assert self._eq.get("status") == "running"
            return _FakeResp([dict(r) for r in self._store.values() if r["status"] == "running"])
        # status-gated update by id
        rid = self._eq.get("id")
        want = self._eq.get("status")
        row = self._store.get(rid)
        if row is None or (want is not None and row["status"] != want):
            return _FakeResp([])
        row.update(self._payload)
        return _FakeResp([dict(row)])


class _FakeClient:
    def __init__(self, rows):
        self._store = {r["id"]: dict(r) for r in rows}

    def table(self, name):
        assert name == "runs"
        return _FakeRunsTable(self._store)


def _rows():
    return [
        # stale (started before cutoff) — must be failed
        {"id": "r_stale", "user_id": "u1", "status": "running",
         "started_at": "2026-06-10T08:00:00+00:00", "created_at": "2026-06-10T07:59:00+00:00"},
        # stale via created_at fallback (no started_at) — COALESCE path
        {"id": "r_created_only", "user_id": "u2", "status": "running",
         "started_at": None, "created_at": "2026-06-10T06:00:00+00:00"},
        # stale, but mixed 'Z' timezone format — exercises _as_aware_utc
        {"id": "r_zsuffix", "user_id": "u3", "status": "running",
         "started_at": "2026-06-10T05:00:00Z", "created_at": "2026-06-10T05:00:00Z"},
        # recent (started after cutoff) — must be left running
        {"id": "r_recent", "user_id": "u4", "status": "running",
         "started_at": "2026-06-11T12:00:00+00:00", "created_at": "2026-06-11T11:59:00+00:00"},
        # stale but excluded (active in this process) — must be left running
        {"id": "r_active", "user_id": "u5", "status": "running",
         "started_at": "2026-06-09T00:00:00+00:00", "created_at": "2026-06-09T00:00:00+00:00"},
        # already finished — ignored by the running-only select
        {"id": "r_done", "user_id": "u6", "status": "succeeded",
         "started_at": "2026-06-10T00:00:00+00:00", "created_at": "2026-06-10T00:00:00+00:00"},
    ]


def test_fail_stale_running_reaps_only_stale_unexcluded_running_runs():
    client = _FakeClient(_rows())
    repo = SupabaseRunRepository(client=client)

    failed = repo.fail_stale_running(
        cutoff_iso=CUTOFF,
        exclude_run_ids=["r_active"],
        error="Run interrupted: server restarted.",
        error_code="abandoned",
    )

    failed_ids = {f["run_id"] for f in failed}
    assert failed_ids == {"r_stale", "r_created_only", "r_zsuffix"}
    # return shape carries what the engine reaper needs for follow-up logging
    for f in failed:
        assert f["id"] == f["run_id"]
        assert f["user_id"]
        assert f["completed_at"]

    store = client._store
    assert store["r_stale"]["status"] == "failed"
    assert store["r_stale"]["error"] == "Run interrupted: server restarted."
    assert store["r_stale"]["error_code"] == "abandoned"
    assert store["r_created_only"]["status"] == "failed"
    assert store["r_zsuffix"]["status"] == "failed"
    # untouched
    assert store["r_recent"]["status"] == "running"
    assert store["r_active"]["status"] == "running"
    assert store["r_done"]["status"] == "succeeded"


def test_fail_stale_running_is_idempotent():
    client = _FakeClient(_rows())
    repo = SupabaseRunRepository(client=client)
    common = dict(cutoff_iso=CUTOFF, error="x", error_code="abandoned")

    # No exclusions here, so every stale running run is reaped (r_active too).
    first = repo.fail_stale_running(**common)
    assert {f["run_id"] for f in first} == {"r_stale", "r_created_only", "r_zsuffix", "r_active"}
    # second sweep finds nothing still-running among the now-failed set
    second = repo.fail_stale_running(**common)
    assert second == []


def test_fail_stale_running_handles_no_running_rows():
    client = _FakeClient([
        {"id": "r1", "user_id": "u", "status": "succeeded",
         "started_at": "2026-06-10T00:00:00+00:00", "created_at": "2026-06-10T00:00:00+00:00"},
    ])
    repo = SupabaseRunRepository(client=client)
    assert repo.fail_stale_running(cutoff_iso=CUTOFF, error="x") == []
