from __future__ import annotations

import sys
import threading
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
API_DIR = ROOT / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_request_active_run_shutdown_marks_cancel_and_kills_sandbox(monkeypatch):
    import run_service
    from runner_sandbox import e2b_driver

    class FakeRuns:
        def __init__(self):
            self.cancelled = []
            self.logs = []

        def cancel(self, **kwargs):
            self.cancelled.append(kwargs)
            return {}

        def add_log(self, **kwargs):
            self.logs.append(kwargs)

    class FakeRepos:
        def __init__(self):
            self.runs = FakeRuns()

    repos = FakeRepos()
    killed = []
    stop = threading.Event()
    thread = threading.Thread(target=lambda: stop.wait(0.2))
    thread.start()

    with run_service._active_runs_lock:
        run_service._active_runs.clear()
        run_service._shutdown_cancelled_runs.clear()
    run_service._register_active_run(
        run_service._ActiveRun(
            run_id="run_shutdown",
            worker_id="worker_shutdown",
            user_id="local-user",
            thread=thread,
        )
    )
    monkeypatch.setattr(
        e2b_driver,
        "cancel_sandbox",
        lambda run_id, reason=None: killed.append((run_id, reason)) or True,
    )

    try:
        cancelled = run_service.request_active_run_shutdown(repos=repos, timeout_seconds=0.01)

        assert cancelled == 1
        assert repos.runs.cancelled[0]["run_id"] == "run_shutdown"
        assert repos.runs.cancelled[0]["user_id"] == "local-user"
        assert repos.runs.logs[0]["message"] == run_service.INTERRUPTED_RUN_ERROR
        assert killed == [("run_shutdown", run_service.INTERRUPTED_RUN_ERROR)]
        assert run_service.was_shutdown_cancelled("run_shutdown") is True
    finally:
        stop.set()
        thread.join(timeout=1)
        with run_service._active_runs_lock:
            run_service._active_runs.clear()
            run_service._shutdown_cancelled_runs.clear()
