"""Distributed run-concurrency limiter backed by a Postgres lease table.

The engine's run_service bounds concurrent runs with an in-process
``threading.Semaphore`` (the E2B-cap "runs" gate + the provider-quota "llm_runs"
gate). That only coordinates WITHIN one process. When the cloud executor is
scaled horizontally (N worker tasks), each process admits its own budget and the
fleet collectively blows past E2B's hard sandbox cap.

This module provides a drop-in limiter (same contract as ``threading.Semaphore``:
``acquire(blocking=False) -> bool`` and ``release()``) whose budget is shared
across every process pointing at the same Postgres. The cloud overlay installs it
in ``startup`` via the engine's ``register_run_limiter`` seam — mirroring how the
cloud injects Supabase repositories for the engine's repository Protocols. It is
gated behind ``WORKEROS_RUN_LEASE_ENABLED`` and is a no-op (engine keeps its
in-process semaphore) when unset, so single-task deploys are unaffected.

Design notes:
  - Admission is serialized per budget with a transaction-scoped advisory lock
    (``pg_advisory_xact_lock``), so the count-then-insert is race-free across
    tasks; the lock auto-releases at COMMIT/ROLLBACK.
  - Each held slot is a row in ``run_concurrency_leases`` (token, budget,
    acquired_at). The engine acquires a slot on the DRAIN thread and releases it
    on the EXECUTOR thread (different threads — like threading.Semaphore, which
    tracks no owner), so held tokens are kept in a PROCESS-WIDE, lock-protected
    list (NOT thread-local — a thread-local store would be empty on release and
    leak the lease). Tokens are interchangeable slots; ``release()`` deletes one
    of this process's tokens, freeing one slot.
  - Stale leases (a task that died without releasing) are reaped on each acquire
    via a TTL (``WORKEROS_RUN_LEASE_TTL_SECONDS``, default 1800s). The TTL MUST
    exceed the longest expected run, else a live lease is reaped → over-admission.
  - FAIL-OPEN: if the lease DB is unreachable, ``acquire`` admits the run (logged)
    rather than wedging all execution. A brief over-admission is bounded by E2B's
    own hard cap; fail-closed would halt the platform on a transient DB blip.
"""
from __future__ import annotations

import logging
import os
import threading
import uuid
from typing import Any, Callable, Optional

logger = logging.getLogger("workeros.cloud.run_limiter")

LEASE_TABLE = "public.run_concurrency_leases"
DEFAULT_TTL_SECONDS = 1800


def _ttl_seconds() -> int:
    try:
        return max(60, int(os.environ.get("WORKEROS_RUN_LEASE_TTL_SECONDS", str(DEFAULT_TTL_SECONDS))))
    except ValueError:
        return DEFAULT_TTL_SECONDS


def _default_connect():
    # Reuse the cloud scheduler's DSN (WORKEROS_CLOUD_DB_* on the session pooler).
    from psycopg import connect

    from apps.api.cloud_scheduler import _dsn

    return connect(_dsn(), autocommit=False)


class PgLeaseLimiter:
    """A ``threading.Semaphore``-compatible distributed limiter for one budget."""

    def __init__(
        self,
        budget: str,
        capacity_fn: Callable[[], int],
        connect_fn: Optional[Callable[[], Any]] = None,
        ttl_seconds: Optional[int] = None,
    ):
        self._budget = budget
        self._capacity_fn = capacity_fn
        self._connect = connect_fn or _default_connect
        self._ttl = int(ttl_seconds) if ttl_seconds is not None else None
        # Held lease tokens for THIS process. Deliberately NOT thread-local: the
        # engine acquires a slot on the DRAIN thread (run_service _drain_one_batch)
        # and releases it on the EXECUTOR thread (run_service executor entry) —
        # different threads — exactly like threading.Semaphore, which doesn't
        # track an owner. A thread-local stack would be empty on release and leak
        # the DB lease until TTL reap. So the store is shared across threads within
        # the process (lock-protected). Tokens are interchangeable slots: releasing
        # ANY one of this process's tokens frees one slot, and a process only ever
        # releases its OWN tokens, so cross-process budgets stay correct.
        self._held: list = []
        self._held_lock = threading.Lock()

    def _capacity(self) -> int:
        try:
            return max(1, int(self._capacity_fn()))
        except Exception:
            return 1

    # -- threading.Semaphore contract ----------------------------------------
    def acquire(self, blocking: bool = False) -> bool:
        # The engine only ever calls acquire(blocking=False) and requeues on a
        # miss, so we never block here.
        capacity = self._capacity()
        ttl = self._ttl if self._ttl is not None else _ttl_seconds()
        token = uuid.uuid4().hex
        conn = None
        try:
            conn = self._connect()
            with conn.cursor() as cur:
                # serialize admission for this budget; auto-released at txn end
                cur.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"run_lease:{self._budget}",))
                cur.execute(
                    f"delete from {LEASE_TABLE} where budget = %s "
                    f"and acquired_at < now() - make_interval(secs => %s)",
                    (self._budget, ttl),
                )
                cur.execute(f"select count(*) from {LEASE_TABLE} where budget = %s", (self._budget,))
                row = cur.fetchone()
                held = int(row[0]) if row else 0
                if held >= capacity:
                    conn.rollback()
                    return False
                cur.execute(
                    f"insert into {LEASE_TABLE} (token, budget) values (%s, %s)",
                    (token, self._budget),
                )
            conn.commit()
            with self._held_lock:
                self._held.append(token)
            return True
        except Exception as exc:  # fail OPEN — never wedge execution on a DB blip
            logger.warning(
                "run-lease acquire failed (budget=%s); FAILING OPEN, admitting run: %s",
                self._budget, exc,
            )
            if conn is not None:
                try:
                    conn.rollback()
                except Exception:
                    pass
            with self._held_lock:
                self._held.append(None)  # sentinel keeps release() balanced
            return True
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def release(self) -> None:
        with self._held_lock:
            token = self._held.pop() if self._held else None
        if token is None:
            return  # nothing held, or a fail-open sentinel
        conn = None
        try:
            conn = self._connect()
            with conn.cursor() as cur:
                cur.execute(f"delete from {LEASE_TABLE} where token = %s", (token,))
            conn.commit()
        except Exception as exc:
            logger.warning(
                "run-lease release failed (budget=%s token=%s); TTL reaper will clean: %s",
                self._budget, token, exc,
            )
            if conn is not None:
                try:
                    conn.rollback()
                except Exception:
                    pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def available_count(self) -> int:
        try:
            capacity = self._capacity()
            conn = self._connect()
            try:
                with conn.cursor() as cur:
                    cur.execute(f"select count(*) from {LEASE_TABLE} where budget = %s", (self._budget,))
                    row = cur.fetchone()
                    held = int(row[0]) if row else 0
                conn.commit()
            finally:
                conn.close()
            return max(0, capacity - held)
        except Exception:
            return -1


# ---------------------------------------------------------------------------
# Install hook (called from startup when WORKEROS_RUN_LEASE_ENABLED is set)
# ---------------------------------------------------------------------------

def _runs_capacity() -> int:
    try:
        return max(1, int(os.environ.get("WORKEROS_MAX_CONCURRENT_RUNS", "6")))
    except ValueError:
        return 6


def _llm_capacity() -> int:
    raw = (os.environ.get("WORKEROS_MAX_CONCURRENT_LLM_RUNS") or "").strip()
    if not raw:
        return _runs_capacity()
    try:
        return max(1, int(raw))
    except ValueError:
        return _runs_capacity()


def install_pg_run_limiters() -> bool:
    """Register PG-lease limiters for the 'runs' and 'llm_runs' budgets on the
    engine's run_service. Called ONCE at startup. Returns True if installed."""
    from apps.api._engine import import_engine_module

    run_service = import_engine_module("run_service")
    register = getattr(run_service, "register_run_limiter", None)
    if not callable(register):
        logger.warning(
            "engine run_service has no register_run_limiter seam; "
            "distributed run limiter NOT installed (bump the engine)"
        )
        return False
    register("runs", PgLeaseLimiter("runs", _runs_capacity))
    register("llm_runs", PgLeaseLimiter("llm_runs", _llm_capacity))
    logger.info(
        "Installed PG-lease run limiters (distributed concurrency): runs=%s llm_runs=%s ttl=%ss",
        _runs_capacity(), _llm_capacity(), _ttl_seconds(),
    )
    return True
