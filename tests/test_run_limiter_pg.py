"""PgLeaseLimiter — distributed run-concurrency limiter (apps/api/run_limiter_pg.py).

Exercises the limiter against an in-memory fake of the lease table (no real DB):
cap enforcement across "connections", release frees a slot, available_count,
thread-local token balance, and the FAIL-OPEN behavior when the DB is down.

Run: python -m pytest tests/test_run_limiter_pg.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from apps.api.run_limiter_pg import PgLeaseLimiter  # noqa: E402


class _FakeStore:
    """Shared in-memory stand-in for public.run_concurrency_leases."""

    def __init__(self):
        self.rows: list[dict] = []  # {token, budget}

    def count(self, budget: str) -> int:
        return sum(1 for r in self.rows if r["budget"] == budget)

    def insert(self, token: str, budget: str) -> None:
        self.rows.append({"token": token, "budget": budget})

    def delete_token(self, token: str) -> None:
        self.rows = [r for r in self.rows if r["token"] != token]


class _FakeCursor:
    def __init__(self, store: _FakeStore):
        self._store = store
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql: str, params=()):
        s = " ".join(sql.lower().split())
        if "pg_advisory_xact_lock" in s:
            return
        if s.startswith("delete from") and "where token" in s:
            self._store.delete_token(params[0])
        elif s.startswith("delete from") and "acquired_at <" in s:
            pass  # no stale rows simulated
        elif "count(*)" in s:
            self._result = (self._store.count(params[0]),)
        elif s.startswith("insert into"):
            self._store.insert(params[0], params[1])

    def fetchone(self):
        return self._result


class _FakeConn:
    def __init__(self, store: _FakeStore):
        self._store = store

    def cursor(self):
        return _FakeCursor(self._store)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def _limiter(store: _FakeStore, budget: str, cap: int) -> PgLeaseLimiter:
    return PgLeaseLimiter(budget, lambda: cap, connect_fn=lambda: _FakeConn(store))


def test_cap_enforced_across_acquires():
    store = _FakeStore()
    lim = _limiter(store, "runs", 2)
    assert lim.acquire(blocking=False) is True
    assert lim.acquire(blocking=False) is True
    assert lim.acquire(blocking=False) is False  # cap=2 reached
    assert store.count("runs") == 2


def test_release_frees_a_slot():
    store = _FakeStore()
    lim = _limiter(store, "runs", 1)
    assert lim.acquire(blocking=False) is True
    assert lim.acquire(blocking=False) is False
    lim.release()
    assert store.count("runs") == 0
    assert lim.acquire(blocking=False) is True


def test_budgets_are_independent():
    store = _FakeStore()
    runs = _limiter(store, "runs", 1)
    llm = _limiter(store, "llm_runs", 1)
    assert runs.acquire(blocking=False) is True
    assert llm.acquire(blocking=False) is True   # different budget, own slot
    assert runs.acquire(blocking=False) is False
    assert store.count("runs") == 1 and store.count("llm_runs") == 1


def test_available_count():
    store = _FakeStore()
    lim = _limiter(store, "runs", 3)
    assert lim.available_count() == 3
    lim.acquire(blocking=False)
    lim.acquire(blocking=False)
    assert lim.available_count() == 1


def test_fail_open_when_db_down():
    def _boom():
        raise RuntimeError("pooler unreachable")

    lim = PgLeaseLimiter("runs", lambda: 2, connect_fn=_boom)
    # DB down -> admit (fail open) so execution is never wedged
    assert lim.acquire(blocking=False) is True
    # release of a fail-open sentinel is a safe no-op
    lim.release()


def test_release_with_nothing_held_is_noop():
    store = _FakeStore()
    lim = _limiter(store, "runs", 1)
    lim.release()  # must not raise
    assert store.count("runs") == 0


def test_release_on_a_different_thread_frees_the_lease():
    """Regression: the engine acquires on the drain thread and releases on the
    executor thread. A thread-local token store would be empty on release and
    leak the DB lease until TTL. The slot must be freed cross-thread."""
    import threading

    store = _FakeStore()
    lim = _limiter(store, "runs", 1)

    # acquire on a "drain" thread
    acquired = []
    t_acq = threading.Thread(target=lambda: acquired.append(lim.acquire(blocking=False)))
    t_acq.start(); t_acq.join()
    assert acquired == [True]
    assert store.count("runs") == 1            # cap=1 now full
    assert lim.acquire(blocking=False) is False  # confirms it's full

    # release on a DIFFERENT "executor" thread must delete the DB lease
    t_rel = threading.Thread(target=lim.release)
    t_rel.start(); t_rel.join()
    assert store.count("runs") == 0            # <-- bug would leave this at 1

    # capacity restored across threads
    assert lim.acquire(blocking=False) is True


def test_cross_thread_acquire_release_many_runs():
    """N runs each acquired on a drain thread and released on an executor thread
    must not leak capacity (the production pattern)."""
    import threading

    store = _FakeStore()
    lim = _limiter(store, "runs", 2)
    for _ in range(10):
        a = []
        t1 = threading.Thread(target=lambda: a.append(lim.acquire(blocking=False)))
        t1.start(); t1.join()
        assert a == [True]
        t2 = threading.Thread(target=lim.release)
        t2.start(); t2.join()
    assert store.count("runs") == 0  # no slow leak after many completed runs
