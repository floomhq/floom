"""Regression: a worker CREATED via Emily's tool must be RUNNABLE.

Root cause (P1, 2026-06-04): ``chat_service._tool_workers_create`` was a parallel,
weaker implementation of worker creation. It parsed the manifest and wrote the
``workers`` + ``skill_versions`` DB rows, but NEVER materialized the worker's files
on disk (``WORKERS_DIR/<id>/worker.yml`` + ``run.py``). The E2B runner reads the
bundle from disk on every run (``run_service._snapshot_worker_bundle`` ->
``_worker_dir_for_run``), so an Emily-created worker failed at run time with
"worker directory not found". Pre-existing workers ran fine because their dir
already existed; Emily-created ones never got one.

The fix converges ``_tool_workers_create`` onto the SAME shared materialization
helper the HTTP/MCP create paths use (``main._register_worker_from_files``), which
writes the files, backfills a runnable ``run.py`` when absent, and registers the
worker. ``_tool_workers_update`` is converged onto the editor path
(``main.update_worker_files``) so a manifest edit reaches disk too.

These tests assert:
  * after Emily's create, ``WORKERS_DIR/<id>/`` contains ``worker.yml`` + ``run.py``,
  * a run of that worker reaches ``completed`` (no "worker directory not found"),
  * Emily's update writes the new ``worker.yml`` to disk and preserves ``run.py``.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


_UPPERCASE_YML = """\
schema_version: "0.3"
name: "emilyfix-uppercase"
title: "Emily Fix Uppercase"
description: "Uppercases a text input."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs:
  - name: "text"
    label: "Text"
    type: "string"
    required: true
connections: []
"""


@pytest.fixture
def booted(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-emily-create")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "runner_sandbox", "run_service", "chat_service", "scheduler", "main",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    chat_service = importlib.import_module("chat_service")
    run_service = importlib.import_module("run_service")
    worker_registry = importlib.import_module("worker_registry")

    yield {
        "db": db,
        "main": main,
        "chat_service": chat_service,
        "run_service": run_service,
        "workers_dir": Path(worker_registry.WORKERS_DIR),
    }
    db.get_repositories.cache_clear()


def _fake_uppercase_driver(monkeypatch, run_service):
    """Stand in for the E2B driver: run the worker's logic in-process so the run
    reaches a terminal status WITHOUT a real sandbox.

    Critically, it mirrors the REAL E2B driver's first action — it reads the worker
    bundle from ``WORKERS_DIR/<id>/`` and FAILS with "Worker directory not found"
    when the dir is missing (runner_sandbox/e2b_driver.py:499). This is the exact
    bug: an Emily-created worker had no dir, so this check failed at run time. With
    the materialization fix the dir exists, so the run reaches a terminal status.
    It then reads ``inputs['text']`` and returns it uppercased."""
    from models import WorkerResult
    from worker_registry import WORKERS_DIR

    class _FakeDriver:
        def run(self, *, worker_id, run_id, inputs, config=None, **kwargs):  # noqa: ANN001
            worker_dir = WORKERS_DIR / worker_id
            if not worker_dir.is_dir() or not (worker_dir / "run.py").is_file():
                return WorkerResult(
                    status="error",
                    error=f"Worker directory not found: {worker_dir}",
                    error_code="missing_bundle",
                )
            text = str(inputs.get("text", ""))
            return WorkerResult(status="success", outputs={"result": text.upper()}, artifacts=[])

    monkeypatch.setattr(run_service, "get_sandbox_driver", lambda *a, **k: _FakeDriver())


def _stub_smoke_gate(monkeypatch, run_service, workers_dir):
    """Stub the codegen+E2B smoke/repair gate (network-bound, out of unit-test
    scope). It mirrors what the real gate does for a placeholder worker: replace
    the no-op run.py with real code, then report a clean verdict. ``_tool_workers_create``
    imports ``smoke_and_gate_generated_worker`` from ``run_service`` lazily, so we
    patch it on that module."""
    def _fake_gate(worker_id, bundle, *, user_id, repos, log_fn, allow_code_repair=True):
        run_py = workers_dir / worker_id / "run.py"
        run_py.write_text(
            "import json\n"
            "from pathlib import Path\n"
            "inputs = json.loads(Path('inputs/input.json').read_text())\n"
            "Path('result.json').write_text(json.dumps({'status': 'success', "
            "'outputs': {'result': str(inputs.get('text', '')).upper()}, 'artifacts': []}))\n",
            encoding="utf-8",
        )
        return {"status": "passed", "reason": None, "repairs": 1}

    monkeypatch.setattr(run_service, "smoke_and_gate_generated_worker", _fake_gate)


def test_emily_created_worker_materializes_files_on_disk(booted, monkeypatch):
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    _stub_smoke_gate(monkeypatch, run_service, workers_dir)

    result = chat_service._tool_workers_create({"yaml_text": _UPPERCASE_YML}, "federico")
    assert result["ok"] is True, result
    worker_id = result["worker_id"]

    worker_dir = workers_dir / worker_id
    assert worker_dir.is_dir(), f"worker dir not materialized: {worker_dir}"
    assert (worker_dir / "worker.yml").is_file(), "worker.yml missing on disk"
    assert (worker_dir / "run.py").is_file(), "run.py missing on disk"
    # The DB row must exist too (registered via the shared discover+persist path).
    db = booted["db"]
    repos = db.get_repositories()
    assert repos.workers.get(user_id="federico", worker_id=worker_id) is not None


def test_emily_created_worker_runs_to_completion(booted, monkeypatch):
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    _stub_smoke_gate(monkeypatch, run_service, workers_dir)
    _fake_uppercase_driver(monkeypatch, run_service)

    created = chat_service._tool_workers_create({"yaml_text": _UPPERCASE_YML}, "federico")
    assert created["ok"] is True, created
    worker_id = created["worker_id"]

    # Drive a run synchronously (no thread) for determinism. This exercises
    # _snapshot_worker_bundle -> _worker_dir_for_run, which raised
    # "worker directory not found" before the fix.
    run_id = run_service.create_run(
        worker_id, {"text": "hello world"}, trigger_source="workspace-agent", user_id="federico"
    )
    run_service.execute_run(run_id, worker_id, {"text": "hello world"}, user_id="federico")

    db = booted["db"]
    repos = db.get_repositories()
    run = repos.runs.get_any(run_id=run_id)
    assert run is not None
    assert run["status"] == "completed", f"run did not complete: {run.get('status')} / {run.get('error')}"
    import json as _json
    raw_output = run.get("output_json") or run.get("output") or "{}"
    output = _json.loads(raw_output) if isinstance(raw_output, str) else (raw_output or {})
    assert output.get("result") == "HELLO WORLD", output


def test_emily_update_writes_manifest_to_disk_and_keeps_run_py(booted, monkeypatch):
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    _stub_smoke_gate(monkeypatch, run_service, workers_dir)

    created = chat_service._tool_workers_create({"yaml_text": _UPPERCASE_YML}, "federico")
    assert created["ok"] is True, created
    worker_id = created["worker_id"]

    # Give run.py a recognizable marker so we can prove it survives the update.
    run_py_path = workers_dir / worker_id / "run.py"
    run_py_path.write_text("# EMILY-MARKER\nprint('hi')\n", encoding="utf-8")

    updated_yml = _UPPERCASE_YML.replace(
        'description: "Uppercases a text input."',
        'description: "Uppercases a text input. (edited)"',
    )
    res = chat_service._tool_workers_update(
        {"id": worker_id, "yaml_text": updated_yml}, "federico"
    )
    assert res["ok"] is True, res

    yml_on_disk = (workers_dir / worker_id / "worker.yml").read_text(encoding="utf-8")
    assert "(edited)" in yml_on_disk, "updated manifest was not written to disk"
    # run.py must be preserved, not deleted by the update.
    assert run_py_path.is_file(), "run.py was deleted by update"
    assert "EMILY-MARKER" in run_py_path.read_text(encoding="utf-8")


def test_emily_create_invokes_codegen_smoke_gate(booted, monkeypatch):
    """Create must run the codegen smoke+repair gate so a real run.py is generated
    from the manifest (a manifest with declared outputs + a no-op run.py fails at
    run time with "Output schema violation" — this gate is what prevents that)."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]

    calls: list = []

    def _spy_gate(worker_id, bundle, *, user_id, repos, log_fn, allow_code_repair=True):
        calls.append({"worker_id": worker_id, "allow_code_repair": allow_code_repair})
        return {"status": "passed", "reason": None, "repairs": 0}

    monkeypatch.setattr(run_service, "smoke_and_gate_generated_worker", _spy_gate)

    result = chat_service._tool_workers_create({"yaml_text": _UPPERCASE_YML}, "federico")
    assert result["ok"] is True, result
    assert len(calls) == 1, "smoke+repair gate was not invoked on create"
    # Must allow run.py code repair (Path B behavior): the manifest carries no code.
    assert calls[0]["allow_code_repair"] is True
    assert calls[0]["worker_id"] == result["worker_id"]
    assert result.get("smoke_status") == "passed"
