"""Issue #188: GET /runs/<id>/stream on a terminal run whose in-memory part
buffer is gone must replay persisted log rows before the finish event, instead
of emitting only {type:"finish"}.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient

API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

AUTH = {"x-floom-secret": "s188-secret"}


def _load_api(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("FLOOM_SECRET", AUTH["x-floom-secret"])
    monkeypatch.setenv("WORKEROS_DEV", "1")
    (tmp_path / "workers").mkdir(parents=True, exist_ok=True)
    (tmp_path / "artifacts").mkdir(parents=True, exist_ok=True)

    for name in [
        "main", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "db", "files", "models",
        "worker_registry", "run_service", "runner_utils", "runner_sandbox",
        "runner_sandbox.agent_driver", "scheduler",
    ]:
        sys.modules.pop(name, None)
        for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
            sys.modules.pop(_rn, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    # Ensure the in-memory part buffer is empty so the stream hits the
    # terminal-run replay path (snapshot is None).
    main._run_part_buffers.clear()
    for timer in list(main._run_part_cleanup_timers.values()):
        timer.cancel()
    main._run_part_cleanup_timers.clear()
    return main


def _insert_completed_run(main, run_id="run_s188"):
    manifest = {
        # schema_version 0.3 + description are required for the WorkerContract
        # (exec-based) shape; without them parse_worker_manifest tries a legacy
        # WorkerConfig and the missing top-level runtime raised a 422.
        "schema_version": "0.3",
        "name": "s188-worker",
        "version": "0.1.0",
        "title": "S188 Worker",
        "description": "Worker used by the PR-188 log-replay tests.",
        "inputs": [],
        "outputs": [],
        "trigger": {"type": "manual"},
        "exec": {"runtime": "python311", "entrypoint": "SKILL.md", "mode": "agent"},
    }
    now = main.now_iso()
    with main.get_db() as conn:
        has_sv = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_versions'"
        ).fetchone()
        if has_sv:
            conn.execute(
                "INSERT OR IGNORE INTO skill_versions (id, name, version, manifest_json, bundle_path, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                ("sv_s188_worker_0_1_0", "s188-worker", "0.1.0", json.dumps(manifest), None, now),
            )
            conn.execute(
                "INSERT OR IGNORE INTO workers (id, skill_version_id, name, trigger_type, grants_json,"
                " input_values_json, enabled, created_at, owner_id)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("s188-worker", "sv_s188_worker_0_1_0", "S188 Worker", "manual", "{}", "{}", 1, now, "local-user"),
            )
        else:
            conn.execute(
                "INSERT OR IGNORE INTO workers (id, name, config_json, status, trigger_type, runner, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("s188-worker", "S188 Worker", json.dumps(manifest), "healthy", "manual", "local", now),
            )
        conn.execute(
            "INSERT INTO runs (id, worker_id, status, trigger_source, runner, input_json, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (run_id, "s188-worker", "completed", "manual", "local", "{}", now),
        )
    return run_id


def _read_stream(main, run_id):
    client = TestClient(main.app)
    with client.stream("GET", f"/runs/{run_id}/stream", headers=AUTH) as response:
        assert response.status_code == 200, response.text
        body = "".join(response.iter_text())
    parts = []
    for block in body.strip().split("\n\n"):
        if not block or block.startswith(":"):
            continue
        for line in block.splitlines():
            if line.startswith("data: "):
                parts.append(json.loads(line.removeprefix("data: ")))
    return parts


def test_completed_run_replays_logs_then_finish(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    run_id = _insert_completed_run(main)

    repos = main.get_repositories()
    messages = ["starting up", "fetched 3 records", "wrote output", "done"]
    for i, msg in enumerate(messages):
        repos.runs.add_log(
            user_id="local-user",
            run_id=run_id,
            level="info",
            message=msg,
            timestamp=f"2026-05-29T00:00:0{i}Z",
        )

    parts = _read_stream(main, run_id)

    log_parts = [p for p in parts if p.get("type") == "log"]
    assert len(log_parts) == len(messages), f"expected {len(messages)} log events, got {len(log_parts)}: {parts}"
    assert [p["message"] for p in log_parts] == messages, "log order/content mismatch"

    assert parts[-1]["type"] == "finish", f"last event must be finish, got {parts[-1]}"
    assert parts[-1]["status"] == "completed"


def test_completed_run_with_no_logs_still_emits_finish(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    run_id = _insert_completed_run(main, run_id="run_s188_empty")

    parts = _read_stream(main, run_id)
    assert [p for p in parts if p.get("type") == "log"] == []
    assert parts[-1]["type"] == "finish"
    assert parts[-1]["status"] == "completed"
