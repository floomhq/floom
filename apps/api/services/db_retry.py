"""Deadlock-tolerant retry helper for multi-row DB writes.

Postgres raises SQLSTATE ``40P01`` ("deadlock detected") when two concurrent
transactions acquire row locks in opposite orders. We keep a consistent
lock-acquisition order in our own multi-row writes (see
``services.context_access._increment_file_ref_counts``), but a burst of
concurrent run bindings can still occasionally deadlock at the storage layer
when several transactions touch overlapping rows. This helper retries the
small, idempotent write a couple of times with jittered backoff before giving
up, and, on exhaustion, raises a clean :class:`TransientDatabaseError` so the
raw driver error (which carries the internal ``deadlock detected`` /
``Process NNN waits for ShareLock ...`` text) never propagates to a client.

Backend-agnostic: SQLite never raises ``40P01``, so on the single-tenant local
backend this is a transparent no-op; it only ever retries on the Postgres /
Supabase cloud backend. Detection is duck-typed (no ``psycopg`` import) so the
OSS engine keeps zero Postgres dependencies.
"""
from __future__ import annotations

import functools
import logging
import random
import time
from typing import Any, Callable, Optional, TypeVar

logger = logging.getLogger("floom.db_retry")

# Postgres SQLSTATE for "deadlock detected".
_DEADLOCK_SQLSTATE = "40P01"

# Total attempts (1 initial + up to 2 retries). A deadlock aborts exactly one of
# the two transactions, so a single retry usually clears; two covers a rare
# three-way pileup without turning a persistent lock problem into a stall.
_DEFAULT_ATTEMPTS = 3

# Jittered backoff bounds (seconds), scaled by attempt number. Jitter spreads
# the retrying transactions apart so they do not immediately re-collide.
_JITTER_MIN = 0.05
_JITTER_MAX = 0.2

T = TypeVar("T")


class TransientDatabaseError(Exception):
    """Raised when a DB write keeps deadlocking after the retry budget is spent.

    Carries no raw driver text in a way that should reach a client; the full
    original error is chained via ``__cause__`` and logged server-side. API
    layers map this to a generic 503 "temporarily busy" response.
    """


def is_deadlock_error(exc: BaseException) -> bool:
    """True when ``exc`` is (or wraps) a Postgres 40P01 deadlock.

    Duck-typed so the OSS engine needs no ``psycopg`` import: psycopg2/psycopg3
    expose the SQLSTATE on ``.pgcode`` / ``.sqlstate``; a wrapper (SQLAlchemy,
    postgrest, a repo-layer re-raise) may keep the driver error on ``.orig`` or
    ``.__cause__``. Falls back to a message match for the wrapped-string case.
    """
    seen: set[int] = set()
    stack = [exc]
    while stack:
        obj = stack.pop()
        if obj is None or id(obj) in seen:
            continue
        seen.add(id(obj))
        for attr in ("sqlstate", "pgcode"):
            code = getattr(obj, attr, None)
            if code is not None and str(code).strip().upper() == _DEADLOCK_SQLSTATE:
                return True
        for attr in ("orig", "__cause__", "__context__"):
            nested = getattr(obj, attr, None)
            if isinstance(nested, BaseException):
                stack.append(nested)
    text = str(exc).lower()
    return "deadlock detected" in text or _DEADLOCK_SQLSTATE.lower() in text


def call_with_deadlock_retry(
    op: Callable[[], T],
    *,
    attempts: int = _DEFAULT_ATTEMPTS,
    label: str = "db_write",
) -> T:
    """Run ``op`` and retry it on a 40P01 deadlock with jittered backoff.

    Non-deadlock exceptions propagate immediately (unchanged). After the retry
    budget is exhausted a :class:`TransientDatabaseError` is raised with the
    final driver error chained via ``from``.
    """
    last_exc: Optional[BaseException] = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            return op()
        except Exception as exc:  # noqa: BLE001 - re-raised below unless a deadlock
            if not is_deadlock_error(exc):
                raise
            last_exc = exc
            if attempt >= attempts:
                break
            delay = random.uniform(_JITTER_MIN, _JITTER_MAX) * attempt
            logger.warning(
                "Deadlock (40P01) on %s (attempt %d/%d); retrying in %.3fs",
                label,
                attempt,
                attempts,
                delay,
            )
            time.sleep(delay)
    logger.error(
        "Deadlock (40P01) persisted on %s after %d attempts; surfacing as transient",
        label,
        attempts,
        exc_info=last_exc,
    )
    raise TransientDatabaseError(
        f"database deadlock on {label}; retries exhausted"
    ) from last_exc


def retry_on_deadlock(
    func: Optional[Callable[..., Any]] = None,
    *,
    attempts: int = _DEFAULT_ATTEMPTS,
) -> Any:
    """Decorator form of :func:`call_with_deadlock_retry`.

    Usage::

        @retry_on_deadlock
        def _write(...): ...

        @retry_on_deadlock(attempts=5)
        def _write(...): ...
    """

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            return call_with_deadlock_retry(
                lambda: fn(*args, **kwargs),
                attempts=attempts,
                label=getattr(fn, "__qualname__", "db_write"),
            )

        return wrapper

    if func is not None:
        return decorate(func)
    return decorate
