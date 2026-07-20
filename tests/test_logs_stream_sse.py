"""Tests for GET /runs/{run_id}/logs/stream (SSE log tail).

Verifies that:
- Existing log rows are replayed immediately on connect.
- A final done event is emitted when the run is terminal.
- Log events include level, message, timestamp (and trace_id when present).
- 404 is returned for unknown runs.
"""
from __future__ import annotations

import importlib
import json
import sys
import threading
import time
import types
from pathlib import Path

from fastapi.testclient import TestClient

API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

AUTH = {"x-floom-secret": "logs-stream-secret"}


def _load_api(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_SECRET", AUTH["x-floom-secret"])
    monkeypatch.setenv("WORKEROS_DEV", "1")
    Path(str(tmp_path / "workers")).mkdir(parents=True, exist_ok=True)
    Path(str(tmp_path / "artifacts")).mkdir(parents=True, exist_ok=True)

    reset_exact = {
        "main", "auth", "db", "files", "models", "worker_registry",
        "run_service", "runner_utils", "scheduler",
    }
    reset_prefixes = ("auth.", "db.", "routers", "services")
    for name in list(sys.modules):
        if name in reset_exact or any(name.startswith(p) for p in reset_prefixes):
            sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
        scheduler_status=lambda: {"ok": True, "enabled": False, "deploy": "local"},
    )
    main = importlib.import_module("main")
    return main


def _insert_worker_and_run(main, run_id: str, status: str = "completed"):
    now = main.now_iso()
    manifest = {
        "id": "ls-worker",
        "name": "ls-worker",
        "description": "Logs stream test worker",
        "title": "LS Worker",
        "version": "0.1.0",
        "runtime": {"type": "python311", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
        "trigger": {"type": "manual"},
    }
    with main.get_db() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO skill_versions
                (id, name, version, manifest_json, bundle_path, created_at)
            VALUES ('sv_ls_worker', 'ls-worker', '0.1.0', ?, 'workers/ls-worker', ?)
            """,
            (json.dumps(manifest), now),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO workers
                (id, skill_version_id, name, trigger_type, grants_json,
                 input_values_json, enabled, created_at, owner_id)
            VALUES ('ls-worker', 'sv_ls_worker', 'LS Worker', 'manual',
                    '{}', '{}', 1, ?, 'local-user')
            """,
            (now,),
        )
        conn.execute(
            """
            INSERT INTO runs
                (id, worker_id, status, trigger_source, runner, input_json, created_at)
            VALUES (?, 'ls-worker', ?, 'manual', 'e2b', '{}', ?)
            """,
            (run_id, status, now),
        )
        conn.execute(
            """
            INSERT INTO logs (run_id, level, message, timestamp, trace_id)
            VALUES (?, 'info', 'Run started', ?, 'trace_abc')
            """,
            (run_id, now),
        )
        conn.execute(
            """
            INSERT INTO logs (run_id, level, message, timestamp, trace_id)
            VALUES (?, 'info', 'Step complete', ?, NULL)
            """,
            (run_id, now),
        )


def _parse_sse_events(body: str):
    events = []
    for block in body.strip().split("\n\n"):
        block = block.strip()
        if not block or block.startswith(":"):
            continue
        for line in block.splitlines():
            if line.startswith("data: "):
                try:
                    events.append(json.loads(line.removeprefix("data: ")))
                except Exception:
                    pass
    return events


def test_logs_stream_replays_existing_logs_for_terminal_run(monkeypatch, tmp_path):
    """For a completed run all log rows are replayed and a done event is emitted."""
    main = _load_api(monkeypatch, tmp_path)
    run_id = "run-ls-completed"
    _insert_worker_and_run(main, run_id, status="completed")

    client = TestClient(main.app)
    with client.stream("GET", f"/runs/{run_id}/logs/stream", headers=AUTH) as resp:
        assert resp.status_code == 200, resp.text
        body = "".join(resp.iter_text())

    events = _parse_sse_events(body)
    log_events = [e for e in events if e.get("type") == "log"]
    done_events = [e for e in events if e.get("type") == "done"]

    assert len(log_events) == 2, f"expected 2 log events, got {log_events}"
    assert log_events[0]["message"] == "Run started"
    assert log_events[0]["level"] == "info"
    assert log_events[0].get("trace_id") == "trace_abc", "trace_id must be preserved"
    assert "trace_id" not in log_events[1], "trace_id must be omitted when absent"

    assert len(done_events) == 1, f"expected 1 done event, got {done_events}"
    assert done_events[0]["status"] == "completed"


def test_logs_stream_waits_for_late_rows_after_terminal_status(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_RUN_LOG_DRAIN_POLL_INTERVAL", "0.05")
    main = _load_api(monkeypatch, tmp_path)
    run_id = "run-ls-late-drain"
    _insert_worker_and_run(main, run_id, status="running")

    def finish_then_drain():
        time.sleep(0.1)
        completed_at = main.now_iso()
        with main.get_db() as conn:
            conn.execute(
                "UPDATE runs SET status = 'completed', completed_at = ? WHERE id = ?",
                (completed_at, run_id),
            )
        time.sleep(0.1)
        with main.get_db() as conn:
            conn.execute(
                "INSERT INTO logs (run_id, level, message, timestamp) VALUES (?, 'info', 'late row', ?)",
                (run_id, main.now_iso()),
            )
            conn.execute(
                "INSERT INTO logs (run_id, level, message, timestamp) VALUES (?, ?, ?, ?)",
                (
                    run_id,
                    "__floom_internal__",
                    "__floom_run_logs_drained__",
                    main.now_iso(),
                ),
            )

    thread = threading.Thread(target=finish_then_drain)
    thread.start()
    try:
        client = TestClient(main.app)
        with client.stream("GET", f"/runs/{run_id}/logs/stream", headers=AUTH) as resp:
            assert resp.status_code == 200
            body = "".join(resp.iter_text())
    finally:
        thread.join(timeout=2)

    events = _parse_sse_events(body)
    assert [event["message"] for event in events if event.get("type") == "log"].count("late row") == 1
    assert events[-1] == {"type": "done", "status": "completed"}


def test_logs_stream_treats_rejected_as_terminal(monkeypatch, tmp_path):
    """For a rejected run all log rows are replayed and a done event is emitted."""
    main = _load_api(monkeypatch, tmp_path)
    run_id = "run-ls-rejected"
    _insert_worker_and_run(main, run_id, status="rejected")

    client = TestClient(main.app)
    with client.stream("GET", f"/runs/{run_id}/logs/stream", headers=AUTH) as resp:
        assert resp.status_code == 200, resp.text
        body = "".join(resp.iter_text())

    events = _parse_sse_events(body)
    log_events = [e for e in events if e.get("type") == "log"]
    done_events = [e for e in events if e.get("type") == "done"]

    assert len(log_events) == 2, f"expected 2 log events, got {log_events}"
    assert len(done_events) == 1, f"expected 1 done event, got {done_events}"
    assert done_events[0]["status"] == "rejected"


def test_logs_stream_treats_cancelled_as_terminal(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    run_id = "run-ls-cancelled"
    _insert_worker_and_run(main, run_id, status="cancelled")

    client = TestClient(main.app)
    with client.stream("GET", f"/runs/{run_id}/logs/stream", headers=AUTH) as resp:
        assert resp.status_code == 200, resp.text
        body = "".join(resp.iter_text())

    events = _parse_sse_events(body)
    assert events[-1] == {"type": "done", "status": "cancelled"}


def test_logs_stream_returns_404_for_unknown_run(monkeypatch, tmp_path):
    """404 for a run_id that does not exist."""
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    resp = client.get("/runs/nonexistent-run-id/logs/stream", headers=AUTH)
    assert resp.status_code == 404


def test_logs_stream_includes_required_fields(monkeypatch, tmp_path):
    """Every log event must include level, message, and timestamp."""
    main = _load_api(monkeypatch, tmp_path)
    run_id = "run-ls-fields"
    _insert_worker_and_run(main, run_id, status="failed")

    client = TestClient(main.app)
    with client.stream("GET", f"/runs/{run_id}/logs/stream", headers=AUTH) as resp:
        assert resp.status_code == 200
        body = "".join(resp.iter_text())

    events = _parse_sse_events(body)
    log_events = [e for e in events if e.get("type") == "log"]
    assert log_events, "must emit at least one log event"
    for evt in log_events:
        assert "level" in evt, f"missing level in {evt}"
        assert "message" in evt, f"missing message in {evt}"
        assert "timestamp" in evt, f"missing timestamp in {evt}"
