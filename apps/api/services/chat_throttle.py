"""Chat rate-limiting + worker-author run orchestration.

DB-backed sliding-window rate limits for Emily's draft / run-create actions, plus
worker-author registration and the idempotent worker-author run. Extracted verbatim
from chat_service.py; self-contained (db + stdlib), no chat_service dependency.
chat_service re-imports these names.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, List, Optional

from db import get_db, now_iso

logger = logging.getLogger("floom.chat")


def _chat_workspace_id(user_id: str) -> str:
    try:
        from db import derive_workspace_id

        return derive_workspace_id(user_id)
    except Exception:
        return "local-default"


def _claim_chat_rate_slot(key: str, *, limit: int, window: float) -> Optional[int]:
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
            return max(1, int((oldest_ts + window) - now) + 1)
        conn.execute("INSERT INTO run_create_rate_limits (key, ts) VALUES (?, ?)", (key, now))
    return None


def _release_chat_rate_slot(key: str) -> None:
    try:
        with get_db() as conn:
            conn.execute(
                """
                DELETE FROM run_create_rate_limits
                WHERE rowid = (
                    SELECT rowid FROM run_create_rate_limits
                    WHERE key = ?
                    ORDER BY ts DESC
                    LIMIT 1
                )
                """,
                (key,),
            )
    except Exception:
        logger.warning("Failed to release rate slot for %s", key, exc_info=True)


def _emily_draft_limit() -> tuple[int, float]:
    try:
        limit = int(os.environ.get("WORKEROS_DRAFT_RATE_HOUR", "20"))
    except ValueError:
        limit = 20
    return max(0, limit), 3600.0


def _emily_run_create_limit() -> tuple[int, float]:
    try:
        limit = int(os.environ.get("WORKEROS_RUN_CREATE_RATE_LIMIT", "10"))
    except ValueError:
        limit = 10
    try:
        window = float(os.environ.get("WORKEROS_RUN_CREATE_RATE_WINDOW_SECONDS", "60"))
    except ValueError:
        window = 60.0
    return max(0, limit), max(1.0, window)


def _enforce_worker_author_chat_throttles(user_id: str, workspace_id: str) -> Optional[Dict[str, Any]]:
    draft_limit, draft_window = _emily_draft_limit()
    draft_key = f"user:{user_id}:workspace:{workspace_id}:drafts"
    retry_after = _claim_chat_rate_slot(
        draft_key,
        limit=draft_limit,
        window=draft_window,
    )
    if retry_after is not None:
        return {
            "ok": False,
            "error": f"Draft rate limit reached: {draft_limit}/hour.",
            "retry_after": retry_after,
        }

    run_limit, run_window = _emily_run_create_limit()
    retry_after = _claim_chat_rate_slot(
        f"user:{user_id}:workspace:{workspace_id}:runs",
        limit=run_limit,
        window=run_window,
    )
    if retry_after is not None:
        _release_chat_rate_slot(draft_key)
        return {
            "ok": False,
            "error": f"Run creation rate limit exceeded: {run_limit}/{int(run_window)}s.",
            "retry_after": retry_after,
        }
    return None


def _ensure_worker_author_registered(user_id: str) -> Optional[str]:
    try:
        from main import _WORKER_AUTHOR_ID
        from services.worker_access import _get_db_worker
        from worker_registry import discover_workers, get_worker, invalidate_worker_cache
        from db import get_repositories
        from main import _persist_discovered_workers
    except Exception as exc:
        return str(exc)

    repos = get_repositories()
    worker = _get_db_worker(_WORKER_AUTHOR_ID, user_id=user_id, repos=repos) or get_worker(_WORKER_AUTHOR_ID)
    if worker:
        return None
    try:
        invalidate_worker_cache()
        workers = discover_workers(use_cache=False)
        with get_db() as conn:
            _persist_discovered_workers(conn, workers, user_id=user_id)
    except Exception as exc:
        logger.warning("Failed to auto-register worker-author for chat: %s", exc)
    worker = _get_db_worker(_WORKER_AUTHOR_ID, user_id=user_id, repos=repos) or get_worker(_WORKER_AUTHOR_ID)
    if not worker:
        return "worker-author bundle not found"
    return None


def _idempotent_worker_author_run(
    *,
    user_id: str,
    conversation_id: str,
    idempotency_key: str,
    prompt: str,
    mode: str,
) -> Dict[str, Any]:
    from db import get_repositories
    from run_service import create_run, start_run

    tool_name = "workers__create_from_prompt"
    clean_key = idempotency_key.strip()
    if not clean_key:
        return {"ok": False, "error": "idempotency_key is required"}

    claimed = False
    with get_db() as conn:
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO chat_tool_idempotency
                (user_id, conversation_id, tool_name, idempotency_key,
                 run_id, worker_id, created_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                user_id,
                conversation_id,
                tool_name,
                clean_key,
                "worker-author",
                now_iso(),
            ),
        )
        claimed = cursor.rowcount == 1
        if not claimed:
            row = conn.execute(
                """
                SELECT run_id, worker_id
                FROM chat_tool_idempotency
                WHERE user_id = ? AND conversation_id = ? AND tool_name = ? AND idempotency_key = ?
                """,
                (user_id, conversation_id, tool_name, clean_key),
            ).fetchone()
            if row and row["run_id"]:
                return {
                    "ok": True,
                    "run_id": row["run_id"],
                    "worker_id": row["worker_id"] or "worker-author",
                    "idempotent": True,
                    "message": f"Worker-author run '{row['run_id']}' is already queued.",
                }

    if not claimed:
        deadline = time.time() + 2.0
        while time.time() < deadline:
            time.sleep(0.05)
            with get_db() as conn:
                row = conn.execute(
                    """
                    SELECT run_id, worker_id
                    FROM chat_tool_idempotency
                    WHERE user_id = ? AND conversation_id = ? AND tool_name = ? AND idempotency_key = ?
                    """,
                    (user_id, conversation_id, tool_name, clean_key),
                ).fetchone()
            if row and row["run_id"]:
                return {
                    "ok": True,
                    "run_id": row["run_id"],
                    "worker_id": row["worker_id"] or "worker-author",
                    "idempotent": True,
                    "message": f"Worker-author run '{row['run_id']}' is already queued.",
                }
        return {
            "ok": False,
            "error": "A matching worker-author request is already being created. Retry shortly with the same idempotency_key.",
            "idempotent": True,
        }

    def _release_reservation() -> None:
        try:
            with get_db() as conn:
                conn.execute(
                    """
                    DELETE FROM chat_tool_idempotency
                    WHERE user_id = ? AND conversation_id = ? AND tool_name = ?
                      AND idempotency_key = ? AND run_id IS NULL
                    """,
                    (user_id, conversation_id, tool_name, clean_key),
                )
        except Exception:
            logger.warning("Failed to release worker-author idempotency reservation", exc_info=True)

    try:
        workspace_id = _chat_workspace_id(user_id)
        throttled = _enforce_worker_author_chat_throttles(user_id, workspace_id)
        if throttled:
            _release_reservation()
            return throttled
        unavailable = _ensure_worker_author_registered(user_id)
        if unavailable:
            _release_reservation()
            return {"ok": False, "error": unavailable}

        inputs: Dict[str, Any] = {"prompt": prompt, "mode": mode}
        repos = get_repositories()
        run_id = create_run(
            "worker-author",
            inputs,
            "workspace-agent",
            user_id=user_id,
            repos=repos,
        )
        with get_db() as conn:
            conn.execute(
                """
                UPDATE chat_tool_idempotency
                SET run_id = ?, worker_id = ?
                WHERE user_id = ? AND conversation_id = ? AND tool_name = ? AND idempotency_key = ?
                """,
                (
                    run_id,
                    "worker-author",
                    user_id,
                    conversation_id,
                    tool_name,
                    clean_key,
                ),
            )
        start_run(run_id, "worker-author", inputs, user_id=user_id, repos=repos)
        return {
            "ok": True,
            "run_id": run_id,
            "worker_id": "worker-author",
            "status": "running",
            "idempotent": False,
            "message": f"Worker-author run '{run_id}' started.",
        }
    except Exception as exc:
        _release_reservation()
        logger.exception("workers__create_from_prompt failed")
        return {"ok": False, "error": str(exc)}


