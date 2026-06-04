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


_REAL_RUN_PY = (
    "import json\n"
    "from pathlib import Path\n"
    "inputs = json.loads(Path('inputs/input.json').read_text())\n"
    "Path('result.json').write_text(json.dumps({'status': 'success', "
    "'outputs': {'result': str(inputs.get('text', '')).upper()}, 'artifacts': []}))\n"
)


def _stub_codegen_and_smoke(monkeypatch, run_service, workers_dir):
    """Stub the network-bound codegen + E2B smoke/repair (out of unit-test scope).

    `_tool_workers_create` (a) generates run.py from the manifest via
    `run_service._repair_run_py`, then (b) gates it via
    `run_service.smoke_and_gate_generated_worker`. Both are lazily imported from
    `run_service`, so we patch them there. The fake `_repair_run_py` returns real
    working code (what codegen would produce); the fake gate reports a clean
    verdict (the dir/code already exist after generation)."""
    def _fake_repair(*, run_code, failure, secrets, log_fn, intent=""):
        return _REAL_RUN_PY

    def _fake_gate(worker_id, bundle, *, user_id, repos, log_fn, allow_code_repair=True):
        return {"status": "passed", "reason": None, "repairs": 0}

    monkeypatch.setattr(run_service, "_repair_run_py", _fake_repair)
    monkeypatch.setattr(run_service, "smoke_and_gate_generated_worker", _fake_gate)


def _stub_smoke_gate(monkeypatch, run_service, workers_dir):
    """Backwards-compatible alias: stub both codegen + smoke gate."""
    _stub_codegen_and_smoke(monkeypatch, run_service, workers_dir)


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


def test_emily_create_generates_runpy_and_gates(booted, monkeypatch):
    """Create must (1) generate a real run.py from the manifest via codegen — a
    manifest with declared outputs + a no-op run.py fails at run time with
    "Output schema violation" — and (2) gate it via the smoke+repair path."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]

    repair_calls: list = []
    gate_calls: list = []

    def _spy_repair(*, run_code, failure, secrets, log_fn, intent=""):
        # The codegen MUST receive the placeholder code + the worker's intent so it
        # can implement the declared outputs.
        repair_calls.append({"intent": intent, "had_placeholder": "# Placeholder worker" in run_code})
        return _REAL_RUN_PY

    def _spy_gate(worker_id, bundle, *, user_id, repos, log_fn, allow_code_repair=True):
        gate_calls.append({"worker_id": worker_id, "allow_code_repair": allow_code_repair})
        return {"status": "passed", "reason": None, "repairs": 0}

    monkeypatch.setattr(run_service, "_repair_run_py", _spy_repair)
    monkeypatch.setattr(run_service, "smoke_and_gate_generated_worker", _spy_gate)

    result = chat_service._tool_workers_create({"yaml_text": _UPPERCASE_YML}, "federico")
    assert result["ok"] is True, result
    worker_id = result["worker_id"]

    # run.py was generated from the manifest (placeholder replaced with real code).
    assert len(repair_calls) == 1, "codegen was not invoked to generate run.py"
    assert repair_calls[0]["had_placeholder"] is True
    assert repair_calls[0]["intent"], "codegen did not receive the worker intent"
    run_py = (workers_dir / worker_id / "run.py").read_text(encoding="utf-8")
    assert "# Placeholder worker" not in run_py, "placeholder run.py was not replaced"
    assert "result" in run_py

    # The smoke+repair gate ran with code-repair allowed (Path B behavior).
    assert len(gate_calls) == 1, "smoke+repair gate was not invoked on create"
    assert gate_calls[0]["allow_code_repair"] is True
    assert gate_calls[0]["worker_id"] == worker_id
    assert result.get("smoke_status") == "passed"


# ---------------------------------------------------------------------------
# ISSUES.md #E1: Emily-created workers fail every real run despite smoke passed.
# Root cause: a divergent ``exec.command`` (Emily's self-repair heredoc) silently
# shadows the generated ``run.py`` with the wrong result.json schema, AND the
# update path had NO smoke gate so it shipped the break as a success.
# ---------------------------------------------------------------------------

# A manifest with a custom exec.command heredoc writing the WRONG result.json
# schema ({"result": x} — no status, no outputs wrapper). This is exactly the
# shape Emily injected via workers__update during the failing runs; it OVERRIDES
# run.py in the E2B driver and makes every real run fail validation.
_DIVERGENT_COMMAND_YML = (
    _UPPERCASE_YML.replace(
        '  command: "python run.py"',
        '  command: |\n'
        '    python -c "import json,sys; '
        'data=json.load(open(\'inputs/input.json\')); '
        'open(\'result.json\',\'w\').write(json.dumps({\'result\': '
        'data.get(\'text\',\'\').upper()}))"',
    )
)


def test_canonicalize_strips_divergent_exec_command(booted):
    """The single-execution-path guard: a caller-supplied exec.command is stripped
    so the generated run.py is the only executed script."""
    chat_service = booted["chat_service"]
    import yaml as _yaml

    cleaned = chat_service._canonicalize_emily_exec_command(_DIVERGENT_COMMAND_YML)
    parsed = _yaml.safe_load(cleaned)
    assert "command" not in (parsed.get("exec") or {}), (
        "exec.command was not stripped — run.py would be shadowed by the heredoc"
    )
    # The canonical command is re-derived by the schema (python run.py); the manifest
    # must NOT carry a divergent one. Other fields are preserved.
    assert parsed["exec"]["entry"] == "run.py"
    assert parsed["name"] == "emilyfix-uppercase"


def test_canonicalize_noop_when_no_command(booted):
    """Agent/skill-mode manifests (no command) pass through unchanged."""
    chat_service = booted["chat_service"]
    agent_yml = (
        'schema_version: "0.3"\n'
        'name: "agent-x"\n'
        'trigger:\n  type: "manual"\n'
        'exec:\n  entry: "SKILL.md"\n  runtime: "skill"\n  runner: "e2b"\n'
    )
    assert chat_service._canonicalize_emily_exec_command(agent_yml) == agent_yml


def test_emily_create_strips_divergent_command_before_persist(booted, monkeypatch):
    """End-to-end: creating with a divergent exec.command persists a manifest that
    does NOT carry the heredoc, so the generated run.py is the executed script."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    _stub_smoke_gate(monkeypatch, run_service, workers_dir)

    result = chat_service._tool_workers_create(
        {"yaml_text": _DIVERGENT_COMMAND_YML}, "federico"
    )
    assert result["ok"] is True, result
    worker_id = result["worker_id"]

    yml_on_disk = (workers_dir / worker_id / "worker.yml").read_text(encoding="utf-8")
    # The persisted manifest must NOT carry the divergent heredoc command.
    assert "result.json" not in yml_on_disk or "import json,sys" not in yml_on_disk, (
        "divergent exec.command heredoc was persisted — it would shadow run.py"
    )


def test_emily_update_runs_smoke_gate(booted, monkeypatch):
    """The update path MUST run the same smoke gate as create — previously it
    wrote the manifest with zero validation, so an Emily self-repair that broke
    every real run shipped as a silent success."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    _stub_smoke_gate(monkeypatch, run_service, workers_dir)

    created = chat_service._tool_workers_create({"yaml_text": _UPPERCASE_YML}, "federico")
    assert created["ok"] is True, created
    worker_id = created["worker_id"]

    gate_calls: list = []

    def _spy_gate(wid, bundle, *, user_id, repos, log_fn, allow_code_repair=True):
        gate_calls.append(wid)
        return {"status": "passed", "reason": None, "repairs": 0}

    monkeypatch.setattr(run_service, "smoke_and_gate_generated_worker", _spy_gate)

    res = chat_service._tool_workers_update(
        {"id": worker_id, "yaml_text": _DIVERGENT_COMMAND_YML}, "federico"
    )
    assert res["ok"] is True, res
    assert gate_calls == [worker_id], "update did not run the smoke gate"
    assert res.get("smoke_status") == "passed"


def test_emily_update_gate_failure_surfaces_and_disables(booted, monkeypatch):
    """When the post-update smoke gate FAILS, the tool must surface the failure
    (smoke_status=failed) and not present the worker as a clean update."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    _stub_smoke_gate(monkeypatch, run_service, workers_dir)

    created = chat_service._tool_workers_create({"yaml_text": _UPPERCASE_YML}, "federico")
    assert created["ok"] is True, created
    worker_id = created["worker_id"]

    def _fail_gate(wid, bundle, *, user_id, repos, log_fn, allow_code_repair=True):
        return {"status": "failed", "reason": "result didn't pass validation", "repairs": 3}

    monkeypatch.setattr(run_service, "smoke_and_gate_generated_worker", _fail_gate)

    updated_yml = _UPPERCASE_YML.replace(
        'description: "Uppercases a text input."',
        'description: "Uppercases a text input. (v2)"',
    )
    res = chat_service._tool_workers_update(
        {"id": worker_id, "yaml_text": updated_yml}, "federico"
    )
    assert res["ok"] is True, res
    assert res.get("smoke_status") == "failed", res
    assert "disabled" in res.get("message", "").lower()
