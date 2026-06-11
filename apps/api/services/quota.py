"""Durable per-user rate quotas (DB-backed sliding window).

Extracted from main.py. Enforces run-create, run-replay and /chat quotas keyed on
the authenticated user, backed by the run_create_rate_limits table so the limits
survive restarts. Consumed by the run + chat route handlers. (The per-IP HTTP
middleware token bucket is a separate concern that stays with app construction.)

get_db is imported lazily (the test suite reloads the db module between cases).
"""

from __future__ import annotations

import math
import os
import time
from typing import TYPE_CHECKING, Optional

from fastapi import HTTPException

if TYPE_CHECKING:
    from auth import AuthContext


def _run_create_quota_config() -> tuple[int, float]:
    try:
        limit = int(os.environ.get("WORKEROS_RUN_CREATE_RATE_LIMIT", "10"))
    except ValueError:
        limit = 10
    try:
        window = float(os.environ.get("WORKEROS_RUN_CREATE_RATE_WINDOW_SECONDS", "60"))
    except ValueError:
        window = 60.0
    return max(0, limit), max(1.0, window)


def _run_create_per_worker_limit() -> int:
    raw = os.environ.get("WORKEROS_RUN_CREATE_PER_WORKER_RATE_LIMIT")
    if raw is None:
        return 0
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def _run_replay_per_run_limit() -> int:
    raw = os.environ.get("WORKEROS_RUN_REPLAY_PER_RUN_RATE_LIMIT")
    if raw is None:
        return 0
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def _claim_run_create_quota_slot(key: str, *, limit: int, window: float) -> Optional[int]:
    from db import get_db
    if limit <= 0:
        return None

    now = time.time()
    cutoff = now - window
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS run_create_rate_limits (
                key TEXT NOT NULL,
                ts REAL NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_run_create_rate_limits_key_ts ON run_create_rate_limits(key, ts)"
        )
        conn.execute("DELETE FROM run_create_rate_limits WHERE ts <= ?", (cutoff,))
        row = conn.execute(
            "SELECT COUNT(*) AS count, MIN(ts) AS oldest_ts FROM run_create_rate_limits WHERE key = ?",
            (key,),
        ).fetchone()
        count = int(row["count"] or 0) if row else 0
        if count >= limit:
            oldest_ts = float(row["oldest_ts"] or now) if row else now
            retry_after = max(1, int(math.ceil((oldest_ts + window) - now)))
            return retry_after
        conn.execute("INSERT INTO run_create_rate_limits (key, ts) VALUES (?, ?)", (key, now))
    return None


def _raise_run_create_quota(limit: int, window: float, retry_after: int) -> None:
    raise HTTPException(
        status_code=429,
        detail=f"Run creation rate limit exceeded: {limit}/{int(window)}s",
        headers={"Retry-After": str(retry_after)},
    )


def _enforce_run_create_quota(auth: AuthContext, worker_id: str) -> None:
    limit, window = _run_create_quota_config()
    retry_after = _claim_run_create_quota_slot(
        f"user:{auth.user_id}:runs",
        limit=limit,
        window=window,
    )
    if retry_after is not None:
        _raise_run_create_quota(limit, window, retry_after)

    per_worker_limit = _run_create_per_worker_limit()
    retry_after = _claim_run_create_quota_slot(
        f"user:{auth.user_id}:worker:{worker_id}",
        limit=per_worker_limit,
        window=window,
    )
    if retry_after is not None:
        _raise_run_create_quota(per_worker_limit, window, retry_after)


def _enforce_run_replay_quota(auth: AuthContext, worker_id: str, source_run_id: str) -> None:
    replay_limit = _run_replay_per_run_limit()
    if replay_limit <= 0:
        return
    _limit, window = _run_create_quota_config()
    retry_after = _claim_run_create_quota_slot(
        f"user:{auth.user_id}:worker:{worker_id}:replay:{source_run_id}",
        limit=replay_limit,
        window=window,
    )
    if retry_after is not None:
        _raise_run_create_quota(replay_limit, window, retry_after)


def _chat_quota_config() -> tuple[int, float]:
    """Per-user /chat quota.

    /chat calls OpenAI on every request (the workspace agent), so an
    unbounded caller can run up a real LLM bill. The shared IP rate limiter
    (60/60s) is too loose for a paid-LLM path; enforce a tighter per-user cap
    keyed on the authenticated user, durable across restarts via the same
    DB-backed sliding window used for run-create.
    """
    try:
        limit = int(os.environ.get("WORKEROS_CHAT_RATE_LIMIT", "20"))
    except ValueError:
        limit = 20
    try:
        window = float(os.environ.get("WORKEROS_CHAT_RATE_WINDOW_SECONDS", "60"))
    except ValueError:
        window = 60.0
    return max(0, limit), max(1.0, window)


def _enforce_chat_quota(auth: AuthContext) -> None:
    limit, window = _chat_quota_config()
    retry_after = _claim_run_create_quota_slot(
        f"user:{auth.user_id}:chat",
        limit=limit,
        window=window,
    )
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail=f"Chat rate limit exceeded: {limit}/{int(window)}s",
            headers={"Retry-After": str(retry_after)},
        )
