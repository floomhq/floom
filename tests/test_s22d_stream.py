from __future__ import annotations

import importlib
import json
import os
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient
from agent_driver_sdk_fakes import ScriptedAgentDriverMixin


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

AUTH = {"x-floom-secret": "s22d-secret"}


class ScriptedAgentDriver(ScriptedAgentDriverMixin):
    pass


def final_response(content=None, tokens=5):
    return {"kind": "message", "text": content or "", "tokens": tokens}


def tool_response(name, args, call_id="call_1", tokens=10):
    return {"kind": "tool", "name": name, "args": args, "call_id": call_id, "tokens": tokens}


def text_chunk(text: str):
    return {"kind": "text", "text": text}


def _load_api(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("FLOOM_SECRET", AUTH["x-floom-secret"])
    monkeypatch.setenv("WORKEROS_DEV", "1")
    Path(os.environ["FLOOM_WORKERS_DIR"]).mkdir(parents=True, exist_ok=True)
    Path(os.environ["FLOOM_ARTIFACTS_DIR"]).mkdir(parents=True, exist_ok=True)

    for name in [
        "main",
        "auth",
        "auth.context",
        "auth.dependency",
        "auth.factory",
        "auth.interface",
        "auth.local",
        "db",
        "files",
        "models",
        "worker_registry",
        "run_service",
        "runner_utils",
        "runner_sandbox",
        "runner_sandbox.agent_driver",
        "scheduler",
    ]:
        sys.modules.pop(name, None)
        for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
            sys.modules.pop(_rn, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    run_service = importlib.import_module("run_service")
    run_service.register_part_publisher(main._run_part_publish)
    main._run_part_buffers.clear()
    for timer in list(main._run_part_cleanup_timers.values()):
        timer.cancel()
    main._run_part_cleanup_timers.clear()
    return main


def _insert_run(main, run_id="run_s22d"):
    manifest = {
        # schema_version 0.3 selects the WorkerContract (exec-based) shape in
        # parse_worker_manifest. Without it the manifest is parsed as a legacy
        # WorkerConfig, which requires a top-level `runtime` this exec-shaped
        # manifest lacks -> ValidationError -> the endpoint returned 422.
        "schema_version": "0.3",
        "name": "s22d-worker",
        "version": "0.1.0",
        "title": "S22d Worker",
        "description": "Worker used by the s22d streaming tests.",
        "inputs": [],
        "outputs": [],
        "trigger": {"type": "manual"},
        "exec": {"runtime": "python311", "entrypoint": "SKILL.md", "mode": "agent"},
    }
    now = main.now_iso()
    with main.get_db() as conn:
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_versions'").fetchone():
            conn.execute(
                """
                INSERT OR IGNORE INTO skill_versions
                    (id, name, version, manifest_json, bundle_path, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                ("sv_s22d_worker_0_1_0", "s22d-worker", "0.1.0", json.dumps(manifest), None, now),
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO workers
                    (id, skill_version_id, name, trigger_type, grants_json,
                     input_values_json, enabled, created_at, owner_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("s22d-worker", "sv_s22d_worker_0_1_0", "S22d Worker", "manual", "{}", "{}", 1, now, "local-user"),
            )
        else:
            conn.execute(
                """
                INSERT OR IGNORE INTO workers
                    (id, name, config_json, status, trigger_type, runner, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ("s22d-worker", "S22d Worker", json.dumps(manifest), "healthy", "manual", "local", now),
            )
        conn.execute(
            """
            INSERT INTO runs
                (id, worker_id, status, trigger_source, runner, input_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (run_id, "s22d-worker", "running", "manual", "local", "{}", now),
        )
    return run_id


def _make_config(agent_module, models, tmp_path, *, outputs=None, limits=None):
    bundle = tmp_path / "bundle"
    workers_root = tmp_path / "workers-agent"
    artifacts = tmp_path / "artifacts-agent"
    bundle.mkdir()
    workers_root.mkdir()
    artifacts.mkdir()
    (bundle / "SKILL.md").write_text("# Skill\n\nRun once.", encoding="utf-8")
    agent_module.WORKERS_DIR = workers_root
    agent_module.ARTIFACTS_DIR = artifacts
    return models.WorkerConfig(
        id="s22d-worker",
        name="S22d Worker",
        trigger={"type": "manual"},
        runtime={
            "type": "skill",
            "entrypoint": "SKILL.md",
            "runner": "local",
            "mode": "agent",
            "bundle_path": str(bundle),
            "limits": limits
            or {
                "max_tool_iterations": 4,
                "max_output_tokens": 1024,
                "max_total_tokens": 50000,
                "timeout_seconds": 30,
            },
        },
        inputs=[],
        secrets=[],
        connections=[],
        outputs=outputs or [],
    )


def _run_driver(main, tmp_path, responses, *, outputs=None, limits=None):
    agent_module = importlib.import_module("runner_sandbox.agent_driver")
    models = importlib.import_module("models")
    driver_cls = type("ScriptedSDKAgentDriver", (ScriptedAgentDriver, agent_module.AgentDriver), {})
    driver = driver_cls()
    script = responses[0] if len(responses) == 1 and isinstance(responses[0], list) else responses
    driver.set_scripts([script])
    config = _make_config(agent_module, models, tmp_path, outputs=outputs, limits=limits)
    return driver.run(
        "s22d-worker",
        "run_s22d",
        {},
        {},
        lambda _message, _level="info": None,
        "trace",
        config=config,
    )


def _parts_from_stream(client: TestClient, run_id: str, headers=None):
    request_headers = {**AUTH, **(headers or {})}
    with client.stream("GET", f"/runs/{run_id}/stream", headers=request_headers) as response:
        assert response.status_code == 200, response.text
        body = "".join(response.iter_text())
    parts = []
    ids = []
    for block in body.strip().split("\n\n"):
        if not block or block.startswith(":"):
            continue
        event_id = None
        data = None
        for line in block.splitlines():
            if line.startswith("id: "):
                event_id = int(line.removeprefix("id: "))
            if line.startswith("data: "):
                data = json.loads(line.removeprefix("data: "))
        if data is not None:
            ids.append(event_id)
            parts.append(data)
    return ids, parts


def test_stream_emits_step_start_then_finish_completed(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    run_id = _insert_run(main)
    result = _run_driver(main, tmp_path, [final_response()])
    assert result.status == "success"
    main.update_run_status(run_id, main.RunStatus.COMPLETED.value, output={})
    importlib.import_module("run_service").publish_run_part(run_id, {"type": "finish", "status": "completed"})

    _ids, parts = _parts_from_stream(TestClient(main.app), run_id)

    assert parts[0] == {"type": "step-start", "stepNumber": 1}
    assert parts[-1] == {"type": "finish", "status": "completed"}


def test_stream_emits_tool_call_and_result_pair(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    run_id = _insert_run(main)
    result = _run_driver(
        main,
        tmp_path,
        [
            tool_response("write_output", {"name": "summary", "content": "ok"}, call_id="call_write"),
            final_response(),
        ],
        outputs=[{"name": "summary", "label": "Summary", "type": "markdown", "required": False}],
    )
    assert result.status == "success"
    importlib.import_module("run_service").publish_run_part(run_id, {"type": "finish", "status": "completed"})

    _ids, parts = _parts_from_stream(TestClient(main.app), run_id)
    call = next(part for part in parts if part["type"] == "tool-call")
    result_part = next(part for part in parts if part["type"] == "tool-result")

    assert call["toolName"] == "write_output"
    assert call["callId"] == "call_write"
    assert result_part["callId"] == "call_write"
    assert result_part["isError"] is False


def test_stream_text_chunks(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    run_id = _insert_run(main)
    result = _run_driver(main, tmp_path, [[text_chunk("one"), text_chunk("two"), text_chunk("three")]])
    assert result.status == "success"
    importlib.import_module("run_service").publish_run_part(run_id, {"type": "finish", "status": "completed"})

    _ids, parts = _parts_from_stream(TestClient(main.app), run_id)
    texts = [part["text"] for part in parts if part["type"] == "text"]

    assert texts == ["one", "two", "three"]


def test_stream_emits_finish_failed_on_error(monkeypatch, tmp_path):
    from agents.exceptions import MaxTurnsExceeded

    main = _load_api(monkeypatch, tmp_path)
    run_id = _insert_run(main)
    result = _run_driver(
        main,
        tmp_path,
        [{"kind": "raise", "error": MaxTurnsExceeded("Agent tool iteration cap exceeded")}],
        limits={
            "max_tool_iterations": 1,
            "max_output_tokens": 1024,
            "max_total_tokens": 50000,
            "timeout_seconds": 30,
        },
    )
    assert result.status == "error"
    main.update_run_status(run_id, main.RunStatus.FAILED.value, error=result.error)
    importlib.import_module("run_service").publish_run_part(
        run_id,
        {"type": "finish", "status": "failed", "error": result.error},
    )

    _ids, parts = _parts_from_stream(TestClient(main.app), run_id)

    assert parts[-1]["type"] == "finish"
    assert parts[-1]["status"] == "failed"
    assert "iteration cap" in parts[-1]["error"]


def test_stream_resume_via_last_event_id(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    run_id = _insert_run(main)
    run_service = importlib.import_module("run_service")
    run_service.publish_run_part(run_id, {"type": "step-start", "stepNumber": 1})
    run_service.publish_run_part(run_id, {"type": "text", "text": "after"})
    run_service.publish_run_part(run_id, {"type": "finish", "status": "completed"})
    main.update_run_status(run_id, main.RunStatus.COMPLETED.value, output={})

    ids, parts = _parts_from_stream(TestClient(main.app), run_id, headers={"Last-Event-ID": "0"})

    assert ids == [1, 2]
    assert [part["type"] for part in parts] == ["text", "finish"]
