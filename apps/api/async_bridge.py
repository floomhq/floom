"""Shared async/sync bridge utilities.

#605: extracted from runner_sandbox/agent_driver.py where _run_coro_sync()
handled the common problem of running an async coroutine from sync code that
may already be inside a running event loop (e.g. FastAPI route handlers).

The pattern is used in at least two places:
  - AgentDriver._run_coro_sync  (runner_sandbox/agent_driver.py)
  - chat_service stream dispatch (main.py post_chat endpoint)

Centralising it here keeps the pattern consistent and testable.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any, TypeVar

T = TypeVar("T")


def run_coro_sync(coro: Any) -> Any:
    """Run an async coroutine from synchronous code.

    Handles two cases:
    1. No running event loop — use asyncio.run() directly (simple, fast).
    2. Already inside a running loop (e.g. called from a FastAPI route via
       Starlette's threadpool) — spin up a *new* event loop in a daemon thread
       so the coroutine runs without conflicting with the host loop.

    The thread-based path blocks the calling thread until the coroutine
    completes or raises. Exceptions are re-raised in the calling thread.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # No running loop — safe to use asyncio.run()
        return asyncio.run(coro)

    result_box: dict[str, Any] = {}

    def _runner() -> None:
        try:
            result_box["result"] = asyncio.run(coro)
        except BaseException as exc:
            result_box["error"] = exc

    thread = threading.Thread(target=_runner, daemon=True)
    thread.start()
    thread.join()
    if "error" in result_box:
        raise result_box["error"]
    return result_box["result"]
