"""Server-Sent Events pub/sub for live run streaming.

Extracted from main.py. Holds the in-process SSE registry (per-run consumer
queues + AI-SDK part replay buffers) and the publish/subscribe helpers that
run_service drives from worker threads. The published payloads are shaped and
PII-redacted by services.public_view before they reach a consumer.

run_service binds _sse_publish / _run_part_publish at startup via
register_sse_publisher / register_part_publisher (see main's lifespan).
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import os
import sqlite3
import threading
import time
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from fastapi import HTTPException

from models import RunStatus
from core.utils import row_to_dict
from services.public_view import (
    _public_sse_event,
    _public_run_part,
    _redact_public_log_message,
    _collapse_stderr_code_echo_rows,
)

if TYPE_CHECKING:
    from db import Repositories

logger = logging.getLogger("floom.api")


_sse_queues: Dict[str, List[tuple]] = {}
_sse_lock = threading.Lock()
_run_part_buffers: Dict[str, Dict[str, Any]] = {}
_run_part_cleanup_timers: Dict[str, threading.Timer] = {}
_run_part_lock = threading.Lock()
_RUN_PART_TTL_SECONDS = 300
_TERMINAL_STATUSES = frozenset({
    RunStatus.COMPLETED.value,
    RunStatus.FAILED.value,
})
_sse_user_stream_counts: Dict[str, int] = {}
_sse_stream_count_lock = threading.Lock()


def _max_concurrent_streams() -> int:
    try:
        return max(1, int(os.environ.get("WORKEROS_MAX_CONCURRENT_STREAMS", "50")))
    except (TypeError, ValueError):
        return 50


def _sse_stream_acquire(user_id: str) -> str:
    """Reserve a per-user SSE stream slot or raise 429 if the cap is exceeded.

    Returns the registry key to pass to _sse_stream_release. Acquisition happens
    synchronously in the endpoint body so the 429 is returned before any
    StreamingResponse is constructed.
    """
    cap = _max_concurrent_streams()
    key = user_id or "anonymous"
    with _sse_stream_count_lock:
        current = _sse_user_stream_counts.get(key, 0)
        if current >= cap:
            raise HTTPException(
                status_code=429,
                detail="Too many concurrent streams. Close existing streams and retry.",
            )
        _sse_user_stream_counts[key] = current + 1
    return key


def _sse_stream_release(key: str) -> None:
    """Free a previously reserved per-user SSE stream slot.

    Called from the generator's finally block so a dropped/disconnected client
    always frees its slot.
    """
    with _sse_stream_count_lock:
        remaining = _sse_user_stream_counts.get(key, 0) - 1
        if remaining <= 0:
            _sse_user_stream_counts.pop(key, None)
        else:
            _sse_user_stream_counts[key] = remaining


def _sse_publish(run_id: str, event: Dict[str, Any]) -> None:
    """Publish an SSE event to all active consumers for a run.

    Called from run_service (worker threads) after each state change.
    asyncio.Queue is not thread-safe, so we route the put through each
    queue's bound loop via call_soon_threadsafe.
    """
    public_event = _public_sse_event(event)
    with _sse_lock:
        entries = list(_sse_queues.get(run_id, []))
    for q, loop in entries:
        def _put(q=q, event=public_event):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("SSE queue full for run %s, dropping event", run_id)
        try:
            loop.call_soon_threadsafe(_put)
        except RuntimeError:
            # Loop already closed (consumer disconnected, cleanup pending).
            pass


def _sse_cleanup(run_id: str, q: asyncio.Queue) -> None:
    """Remove a specific consumer queue from the registry."""
    with _sse_lock:
        entries = _sse_queues.get(run_id)
        if entries:
            _sse_queues[run_id] = [(eq, el) for (eq, el) in entries if eq is not q]
            if not _sse_queues[run_id]:
                _sse_queues.pop(run_id, None)


def _run_part_state(run_id: str) -> Dict[str, Any]:
    state = _run_part_buffers.get(run_id)
    if state is None:
        state = {
            "next_id": 0,
            "parts": collections.deque(maxlen=2000),
            "queues": [],
            "finished_at": None,
        }
        _run_part_buffers[run_id] = state
    return state


def _run_part_is_finish(part: Dict[str, Any]) -> bool:
    return part.get("type") == "finish"


def _cancel_run_part_cleanup(run_id: str) -> None:
    timer = _run_part_cleanup_timers.pop(run_id, None)
    if timer is not None:
        timer.cancel()


def _schedule_run_part_cleanup(run_id: str) -> None:
    def _cleanup() -> None:
        with _run_part_lock:
            _run_part_buffers.pop(run_id, None)
            _run_part_cleanup_timers.pop(run_id, None)

    with _run_part_lock:
        _cancel_run_part_cleanup(run_id)
        timer = threading.Timer(_RUN_PART_TTL_SECONDS, _cleanup)
        timer.daemon = True
        _run_part_cleanup_timers[run_id] = timer
        timer.start()


def _run_part_publish(run_id: str, part: Dict[str, Any]) -> None:
    """Publish one AI SDK part to the replay buffer and active consumers."""
    public_part = _public_run_part(part)
    with _run_part_lock:
        state = _run_part_state(run_id)
        event_id = state["next_id"]
        state["next_id"] = event_id + 1
        state["parts"].append((event_id, public_part))
        if _run_part_is_finish(public_part):
            state["finished_at"] = time.time()
        entries = list(state["queues"])

    for q, loop in entries:
        def _put(q=q, event_id=event_id, part=public_part):
            try:
                q.put_nowait((event_id, part))
            except asyncio.QueueFull:
                logger.warning("Run part queue full for run %s, dropping part", run_id)

        try:
            loop.call_soon_threadsafe(_put)
        except RuntimeError:
            pass

    if _run_part_is_finish(public_part):
        _schedule_run_part_cleanup(run_id)


def _run_part_register(run_id: str, q: asyncio.Queue, loop: asyncio.AbstractEventLoop) -> None:
    with _run_part_lock:
        state = _run_part_state(run_id)
        _cancel_run_part_cleanup(run_id)
        state["queues"].append((q, loop))


def _run_part_cleanup(run_id: str, q: asyncio.Queue) -> None:
    with _run_part_lock:
        state = _run_part_buffers.get(run_id)
        if not state:
            return
        state["queues"] = [(eq, el) for (eq, el) in state["queues"] if eq is not q]
        finished = state.get("finished_at") is not None
    if finished:
        _schedule_run_part_cleanup(run_id)


def _run_part_snapshot(run_id: str) -> Optional[Dict[str, Any]]:
    with _run_part_lock:
        state = _run_part_buffers.get(run_id)
        if state is None:
            return None
        return {
            "parts": list(state["parts"]),
            "finished": state.get("finished_at") is not None,
        }


def _format_run_part_sse(event_id: int, part: Dict[str, Any]) -> str:
    return f"id: {event_id}\nevent: part\ndata: {json.dumps(part)}\n\n"


def _parse_last_event_id(value: Optional[str]) -> int:
    if not value:
        return -1
    try:
        return int(value)
    except ValueError:
        return -1


def _finish_part_from_run_row(row: sqlite3.Row) -> Optional[Dict[str, Any]]:
    status = row["status"]
    if status == RunStatus.COMPLETED.value:
        return {"type": "finish", "status": "completed"}
    if status == RunStatus.FAILED.value:
        part: Dict[str, Any] = {"type": "finish", "status": "failed"}
        if row["error"]:
            part["error"] = _redact_public_log_message(str(row["error"]))
        return part
    return None


def _log_replay_parts(repos: "Repositories", user_id: str, run_id: str) -> List[Dict[str, Any]]:
    """Build replay parts from persisted log rows for a run.

    When a client opens the stream for a run whose in-memory part buffer is
    gone (terminal run after the buffer TTL'd out, or a fresh server process),
    the live tail is empty. Without this, the stream emitted only the finish
    part and the historical logs were lost (#188). Replaying the persisted log
    rows lets the UI reconstruct the transcript.
    """
    parts: List[Dict[str, Any]] = []
    try:
        rows = repos.runs.list_logs(user_id=user_id, run_id=run_id)
    except Exception:
        logger.exception("Failed to load logs for SSE replay (run %s)", run_id)
        return parts
    # G5 P1: collapse the e2b stderr code-echo on the RAW ordered rows FIRST,
    # THEN per-row redact, so the rebuilt transcript is as calm as the live panel.
    _raw_parts: List[Dict[str, Any]] = []
    for r in rows:
        row = row_to_dict(r)
        _raw_parts.append(
            {
                "type": "log",
                "level": row.get("level"),
                "message": row.get("message") or "",
                "timestamp": row.get("timestamp"),
            }
        )
    for part in _collapse_stderr_code_echo_rows(_raw_parts):
        part["message"] = _redact_public_log_message(part["message"])
        parts.append(part)
    return parts
