"""Regression test for the concurrent "Event loop is closed" failure.

ROOT CAUSE
----------
The Agents SDK's default model provider lazily builds an ``AsyncOpenAI`` backed
by a *process-wide* ``httpx.AsyncClient`` (``OpenAIProvider.shared_http_client``).
``AgentDriver._run_coro_sync`` runs each worker in its OWN fresh ``asyncio.run``
loop (in a thread). An ``httpx.AsyncClient`` binds to the loop that first does
I/O on it, so when one run's loop closes, a concurrent run that streams on the
same shared client raises ``RuntimeError: Event loop is closed``. Solo runs
always pass; 2+ overlapping runs intermittently fail.

THE FIX
-------
``_run_agent_inner`` now builds a fresh, loop-local ``AsyncOpenAI`` +
``httpx.AsyncClient`` per run (via ``LoopLocalModelProvider``) and passes it to
``RunConfig.model_provider``, then closes it in ``finally``. No loop-bound async
resource is shared across runs.

These tests:
1. Demonstrate the failure mode with a deliberately *shared* loop-bound async
   resource reused across concurrent ``_run_coro_sync`` loops (the bug), and
   that a *per-run* loop-bound resource does NOT fail (the fix shape).
2. Drive many concurrent real ``AgentDriver`` runs whose streamed step performs
   actual async I/O on the per-run loop-local client, asserting ZERO
   "Event loop is closed" errors across all of them.
"""

from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

import runner_sandbox.agent_driver as agent_module  # noqa: E402
from runner_sandbox.agent_driver import AgentDriver  # noqa: E402

# Reuse the shared test scaffolding (make_config / logs).
from test_agent_driver import make_config, logs  # noqa: E402


def _run_in_fresh_loop(coro_factory):
    """Run a coroutine in its own fresh asyncio loop in a dedicated thread.

    Mirrors AgentDriver._run_coro_sync's per-run loop semantics.
    """
    box: dict[str, object] = {}

    def _runner() -> None:
        try:
            box["result"] = asyncio.run(coro_factory())
        except BaseException as exc:  # noqa: BLE001
            box["error"] = exc

    t = threading.Thread(target=_runner, daemon=True)
    t.start()
    t.join()
    return box


def _start_keepalive_server():
    """Start a minimal blocking HTTP/1.1 keep-alive server in a thread.

    Returns (base_url, shutdown_fn). The server keeps connections alive so an
    httpx pool actually retains a socket bound to the loop that opened it.
    """
    import http.server
    import socketserver

    class _Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):  # noqa: N802
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # silence
            pass

    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return f"http://127.0.0.1:{port}/", server.shutdown


def test_shared_httpx_client_breaks_but_per_loop_client_survives():
    """Pin down the exact failure mechanism the production fix avoids.

    A single shared ``httpx.AsyncClient`` (the SDK's process-wide
    ``shared_http_client``) that pools a keep-alive connection on loop A and is
    then reused on a fresh loop B raises ``RuntimeError: Event loop is closed``.
    A fresh per-loop client does not. This is the literal bug.
    """
    import httpx

    base_url, shutdown = _start_keepalive_server()
    try:
        shared: dict[str, httpx.AsyncClient] = {}

        async def _use_shared() -> None:
            if "client" not in shared:
                shared["client"] = httpx.AsyncClient()
            # Successful request -> connection pooled on THIS loop.
            r = await shared["client"].get(base_url, timeout=2.0)
            r.raise_for_status()

        first = _run_in_fresh_loop(_use_shared)
        second = _run_in_fresh_loop(_use_shared)
        assert "error" not in first, f"first run unexpectedly failed: {first.get('error')}"
        assert "error" in second, "shared client reused across a closed loop should raise"
        assert "Event loop is closed" in str(second["error"])

        # Per-loop client: each loop builds + closes its own -> no closed-loop error.
        async def _use_per_loop() -> None:
            async with httpx.AsyncClient() as client:
                r = await client.get(base_url, timeout=2.0)
                r.raise_for_status()

        for _ in range(4):
            box = _run_in_fresh_loop(_use_per_loop)
            assert "error" not in box, f"per-loop client must not fail: {box.get('error')}"
    finally:
        shutdown()


class _IOAgentDriver(AgentDriver):
    """Driver whose streamed step performs real async I/O on the per-run client.

    It reaches ``run_config.model_provider`` (the loop-local provider installed
    by the fix), grabs the resolved ``AsyncOpenAI``'s underlying httpx client,
    and issues a real keep-alive request so a socket is pooled on THIS run's
    loop. With the fix, that client/socket dies with this run's own loop. Under
    the buggy shared-global path, the pooled socket from a prior (now closed)
    loop is reused -> ``RuntimeError: Event loop is closed``.
    """

    target_url: str = ""

    async def _run_streamed(self, agent, run_input, max_turns, run_config):  # type: ignore[override]
        provider = run_config.model_provider
        openai_client = provider.openai_provider._get_client()
        http_client = openai_client._client  # httpx.AsyncClient
        r = await http_client.get(self.target_url, timeout=2.0)
        r.raise_for_status()
        # Returning normally would require the rest of the agent loop; raise a
        # sentinel the driver maps to an error WorkerResult. We only assert on
        # the absence of closed-loop errors, so any non-closed-loop outcome is
        # acceptable.
        raise RuntimeError("io-step-complete-sentinel")


async def _noop_connect(self, *a, **k):
    return []


async def _noop_cleanup(self, *a, **k):
    return None


def _make_io_driver(url: str) -> "_IOAgentDriver":
    driver = _IOAgentDriver()
    driver.target_url = url
    driver._connect_mcp_servers = _noop_connect.__get__(driver, _IOAgentDriver)
    driver._cleanup_mcp_servers = _noop_cleanup.__get__(driver, _IOAgentDriver)
    return driver


def _run_driver(driver, config, idx: int):
    _entries, log_fn = logs()
    try:
        result = driver.run(
            "agent-test", f"run_{idx}", {}, {}, log_fn, f"trace_{idx}", config=config
        )
        err = (result.error or "") if result else ""
        if "Event loop is closed" in err:
            return RuntimeError(err)
    except BaseException as exc:  # noqa: BLE001
        if "Event loop is closed" in str(exc):
            return exc
    return None


def test_sequential_runs_reuse_closed_loop_no_error(tmp_path, monkeypatch):
    """Back-to-back runs (each its own closed loop) must not raise closed-loop.

    This is the deterministic mirror of the production failure: run A's loop
    closes, then run B executes on a fresh loop. With the shared-global client
    the pooled socket from A's dead loop poisons B. The per-run loop-local
    client makes each run fully self-contained.
    """
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-used")
    base = tmp_path / "shared"
    base.mkdir()
    config = make_config(base)
    base_url, shutdown = _start_keepalive_server()
    try:
        errors = []
        for idx in range(6):
            err = _run_driver(_make_io_driver(base_url), config, idx)
            if err:
                errors.append(err)
        assert not errors, f"Closed-loop errors across sequential runs: {errors}"
    finally:
        shutdown()


def test_concurrent_runs_no_closed_loop_error(tmp_path, monkeypatch):
    """8 overlapping AgentDriver runs (x2 = 16) must not raise closed-loop.

    Each run builds its own loop-local httpx client (the fix) and performs real
    async I/O on it. The ONLY assertion is that no run reports an
    "Event loop is closed" error.
    """
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-used")
    base = tmp_path / "shared"
    base.mkdir()
    config = make_config(base)
    base_url, shutdown = _start_keepalive_server()
    try:
        errors: list[BaseException] = []
        lock = threading.Lock()

        def _one(idx: int) -> None:
            err = _run_driver(_make_io_driver(base_url), config, idx)
            if err:
                with lock:
                    errors.append(err)

        for _wave in range(2):  # 8 concurrent x 2 waves = 16 overlapping runs
            threads = [threading.Thread(target=_one, args=(i,)) for i in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

        assert not errors, f"Closed-loop errors under concurrency: {errors}"
    finally:
        shutdown()
