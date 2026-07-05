"""Deadlock retry wrapper + raw-DB-error leak guard.

Covers the Postgres 40P01 mitigation added to the engine:
  - ``services.db_retry`` deadlock detection (duck-typed, no psycopg import),
    jittered retry, and clean ``TransientDatabaseError`` on exhaustion.
  - ``services.context_access._increment_file_ref_counts`` acquires the
    ``files`` row locks in a deterministic (sorted) order.
"""
from __future__ import annotations

import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import pytest

from services.db_retry import (
    TransientDatabaseError,
    call_with_deadlock_retry,
    is_deadlock_error,
    retry_on_deadlock,
)


class _PgError(Exception):
    """Stand-in for a psycopg error carrying a SQLSTATE."""

    def __init__(self, message: str, sqlstate: str | None = None, pgcode: str | None = None):
        super().__init__(message)
        if sqlstate is not None:
            self.sqlstate = sqlstate
        if pgcode is not None:
            self.pgcode = pgcode


def test_is_deadlock_error_detects_sqlstate_attr():
    assert is_deadlock_error(_PgError("deadlock detected", sqlstate="40P01"))


def test_is_deadlock_error_detects_pgcode_attr():
    assert is_deadlock_error(_PgError("boom", pgcode="40P01"))


def test_is_deadlock_error_detects_message_only():
    # The real PostHog capture carried this exact phrasing with no SQLSTATE attr.
    assert is_deadlock_error(RuntimeError("deadlock detected"))
    assert is_deadlock_error(RuntimeError("ERROR: 40P01 waiting for ShareLock"))


def test_is_deadlock_error_detects_wrapped_cause():
    wrapper = RuntimeError("repo write failed")
    wrapper.__cause__ = _PgError("deadlock detected", sqlstate="40P01")
    assert is_deadlock_error(wrapper)


def test_is_deadlock_error_detects_orig_attr():
    class _Wrapper(Exception):
        pass

    wrapper = _Wrapper("write failed")
    wrapper.orig = _PgError("deadlock detected", sqlstate="40P01")
    assert is_deadlock_error(wrapper)


def test_is_deadlock_error_ignores_other_errors():
    assert not is_deadlock_error(ValueError("bad value"))
    assert not is_deadlock_error(_PgError("unique violation", sqlstate="23505"))


def test_retry_succeeds_after_transient_deadlock(monkeypatch):
    monkeypatch.setattr("services.db_retry.time.sleep", lambda _s: None)
    calls = {"n": 0}

    def op():
        calls["n"] += 1
        if calls["n"] < 2:
            raise _PgError("deadlock detected", sqlstate="40P01")
        return "ok"

    assert call_with_deadlock_retry(op, label="test") == "ok"
    assert calls["n"] == 2


def test_retry_exhaustion_raises_transient_not_raw(monkeypatch):
    monkeypatch.setattr("services.db_retry.time.sleep", lambda _s: None)
    calls = {"n": 0}

    def op():
        calls["n"] += 1
        raise _PgError(
            "deadlock detected: Process 2786526 waits for ShareLock on transaction 240251",
            sqlstate="40P01",
        )

    with pytest.raises(TransientDatabaseError) as excinfo:
        call_with_deadlock_retry(op, attempts=3, label="test")

    # The default budget is 3 attempts (1 + 2 retries).
    assert calls["n"] == 3
    # The clean error must not surface the raw ShareLock/process detail.
    assert "ShareLock" not in str(excinfo.value)
    assert "2786526" not in str(excinfo.value)
    # The raw driver error is preserved for server-side debugging only.
    assert isinstance(excinfo.value.__cause__, _PgError)


def test_non_deadlock_error_propagates_immediately(monkeypatch):
    monkeypatch.setattr("services.db_retry.time.sleep", lambda _s: None)
    calls = {"n": 0}

    def op():
        calls["n"] += 1
        raise ValueError("not a deadlock")

    with pytest.raises(ValueError):
        call_with_deadlock_retry(op, label="test")
    # No retries for a non-deadlock error.
    assert calls["n"] == 1


def test_retry_on_deadlock_decorator(monkeypatch):
    monkeypatch.setattr("services.db_retry.time.sleep", lambda _s: None)
    calls = {"n": 0}

    @retry_on_deadlock
    def write():
        calls["n"] += 1
        if calls["n"] < 2:
            raise _PgError("deadlock detected", pgcode="40P01")
        return "written"

    assert write() == "written"
    assert calls["n"] == 2


def test_increment_file_ref_counts_locks_rows_in_sorted_order(monkeypatch):
    """The UPDATE loop must touch files in id order regardless of input order."""
    from services import context_access

    updated: list[str] = []

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, _sql, params):
            # params = (count, file_id)
            updated.append(params[1])

    monkeypatch.setattr("db.get_db", lambda: _Conn())

    context_access._increment_file_ref_counts(["file-c", "file-a", "file-b", "file-a"])

    # Deterministic ascending-id acquisition order (dedupe collapses the two
    # "file-a" refs into one row).
    assert updated == ["file-a", "file-b", "file-c"]
