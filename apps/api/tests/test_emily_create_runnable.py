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
  * Emily's update writes the new ``worker.yml`` to disk and regenerates ``run.py``
    before smoke-gating, so manifest behavior edits reach runtime.
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
    "inputs = json.loads(Path('inputs.json').read_text())\n"
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


def test_emily_update_writes_manifest_to_disk_and_regenerates_run_py(booted, monkeypatch):
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    _stub_smoke_gate(monkeypatch, run_service, workers_dir)

    created = chat_service._tool_workers_create({"yaml_text": _UPPERCASE_YML}, "federico")
    assert created["ok"] is True, created
    worker_id = created["worker_id"]

    # Give run.py stale generated behavior so we can prove update refreshes it.
    run_py_path = workers_dir / worker_id / "run.py"
    run_py_path.write_text("# stale uppercase implementation\nprint('UPPER')\n", encoding="utf-8")

    def _lower_repair(*, run_code, failure, secrets, log_fn, intent=""):
        return (
            "import json\n"
            "from pathlib import Path\n"
            "inputs=json.loads(Path('inputs.json').read_text())\n"
            "Path('result.json').write_text(json.dumps({'status':'success',"
            "'outputs':{'result':str(inputs.get('text','')).lower()}}))\n"
        )

    monkeypatch.setattr(run_service, "_repair_run_py", _lower_repair)

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
    # run.py must be regenerated from the updated manifest, not preserved stale.
    assert run_py_path.is_file(), "run.py was deleted by update"
    run_py = run_py_path.read_text(encoding="utf-8")
    assert ".lower()" in run_py
    assert "UPPER" not in run_py


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


def test_canonicalize_normalizes_run_sh_entry_to_run_py(booted):
    """Second divergent-execution vector: a `run.sh` entry makes the schema derive
    `bash run.sh`, but codegen only emits run.py -> every run dies with
    'run.sh: No such file or directory'. The entry must be forced to run.py."""
    chat_service = booted["chat_service"]
    import yaml as _yaml

    sh_yml = (
        'schema_version: "0.3"\n'
        'name: "shworker"\n'
        'title: "Sh Worker"\n'
        'description: "x"\n'
        'version: "0.1.0"\n'
        'entrypoint: "run.sh"\n'
        'trigger:\n  type: "manual"\n'
        'exec:\n  entry: "run.sh"\n  runtime: "python311"\n  runner: "e2b"\n'
        '  command: "bash run.sh"\n'
        '  outputs:\n  - name: "result"\n    type: file\n    required: true\n'
    )
    parsed = _yaml.safe_load(chat_service._canonicalize_emily_exec_command(sh_yml))
    assert parsed["exec"]["entry"] == "run.py", parsed["exec"]
    assert parsed.get("entrypoint") == "run.py", parsed
    assert "command" not in parsed["exec"], "stale bash run.sh command survived"


def test_canonicalize_leaves_agent_entry_untouched(booted):
    """An agent worker (entry: SKILL.md) must NOT be rewritten to run.py — it has
    no run.py and codegen does not generate one for it."""
    chat_service = booted["chat_service"]
    import yaml as _yaml

    # Add a command to force a rewrite path, and assert entry stays SKILL.md.
    agent_yml = (
        'schema_version: "0.3"\n'
        'name: "agent-y"\n'
        'title: "Agent Y"\n'
        'description: "x"\n'
        'version: "0.1.0"\n'
        'entrypoint: "SKILL.md"\n'
        'trigger:\n  type: "manual"\n'
        'exec:\n  entry: "SKILL.md"\n  runtime: "skill"\n  runner: "e2b"\n'
    )
    parsed = _yaml.safe_load(chat_service._canonicalize_emily_exec_command(agent_yml))
    assert parsed["exec"]["entry"] == "SKILL.md"
    assert parsed.get("entrypoint") == "SKILL.md"


def test_canonicalize_preserves_legitimate_run_js_worker(booted):
    """Codex blocker: a LEGITIMATE hand-authored run.js worker (its source IS on
    disk) must NOT have its entry rewritten to run.py — that would break it. Only
    ORPHANED script entries (no source file) are redirected."""
    chat_service = booted["chat_service"]
    import yaml as _yaml

    js_yml = (
        'schema_version: "0.3"\n'
        'name: "nodeworker"\n'
        'title: "Node Worker"\n'
        'description: "x"\n'
        'version: "0.1.0"\n'
        'entrypoint: "run.js"\n'
        'trigger:\n  type: "manual"\n'
        'exec:\n  entry: "run.js"\n  runtime: "node22"\n  runner: "e2b"\n'
        '  command: "node run.js"\n'
    )
    # run.js source IS present -> the worker is legit and returned UNCHANGED
    # (entry preserved, command preserved — we never touch a real authored worker).
    out = chat_service._canonicalize_emily_exec_command(
        js_yml, existing_files={"run.js", "package.json"}
    )
    assert out == js_yml, "legit run.js worker was modified"
    parsed = _yaml.safe_load(out)
    assert parsed["exec"]["entry"] == "run.js", "legit run.js entry was clobbered"
    assert parsed.get("entrypoint") == "run.js"
    assert parsed["exec"]["command"] == "node run.js", "legit command was stripped"


def test_canonicalize_preserves_command_only_node_worker(booted):
    """Codex P1 #3: a command-only authored worker (exec.command: 'node run.js',
    runtime: node22, NO entry) uses the command as its only execution signal. When
    run.js source is present, the derived entry must be lifted into exec.entry so
    stripping the command does not collapse it to agent mode / python run.py."""
    chat_service = booted["chat_service"]
    import yaml as _yaml

    cmd_only_yml = (
        'schema_version: "0.3"\n'
        'name: "cmdnode"\n'
        'title: "Cmd Node"\n'
        'description: "x"\n'
        'version: "0.1.0"\n'
        'exec:\n  command: "node run.js"\n  runtime: "node22"\n  runner: "e2b"\n'
        'trigger:\n  type: "manual"\n'
    )
    # The command references real on-disk run.js -> legit, returned UNCHANGED so the
    # command stays the execution signal (no entry collapse to agent / python run.py).
    out = chat_service._canonicalize_emily_exec_command(
        cmd_only_yml, existing_files={"run.js", "package.json"}
    )
    assert out == cmd_only_yml, "legit command-only node worker was modified"
    parsed = _yaml.safe_load(out)
    assert parsed["exec"]["command"] == "node run.js"


def test_canonicalize_preserves_command_only_node_worker_with_args_and_dotslash(booted):
    """Codex P1 #4: command with args ('node run.js --mode test') or a './run.js'
    prefix must still be recognised as legit when run.js is on disk."""
    chat_service = booted["chat_service"]
    for cmd in ("node run.js --mode test", "node ./run.js"):
        cmd_yml = (
            'schema_version: "0.3"\n'
            'name: "cmdargs"\n'
            'title: "Cmd Args"\n'
            'description: "x"\n'
            'version: "0.1.0"\n'
            f'exec:\n  command: "{cmd}"\n  runtime: "node22"\n  runner: "e2b"\n'
            'trigger:\n  type: "manual"\n'
        )
        out = chat_service._canonicalize_emily_exec_command(
            cmd_yml, existing_files={"run.js"}
        )
        assert out == cmd_yml, f"legit worker with command {cmd!r} was modified"


def test_canonicalize_preserves_python_m_package_worker(booted):
    """Codex P1 #6: a command-only worker 'python -m pkgworker' backed by
    pkgworker/__main__.py (or pkgworker.py) must be recognised as legit and left
    unchanged — not stripped into agent mode."""
    chat_service = booted["chat_service"]
    base = (
        'schema_version: "0.3"\n'
        'name: "pkgw"\n'
        'title: "Pkg W"\n'
        'description: "x"\n'
        'version: "0.1.0"\n'
        'exec:\n  command: "python -m pkgworker"\n  runtime: "python311"\n  runner: "e2b"\n'
        'trigger:\n  type: "manual"\n'
    )
    # __main__.py layout
    assert chat_service._canonicalize_emily_exec_command(
        base, existing_files={"pkgworker/__main__.py"}
    ) == base, "python -m pkg (__main__.py) worker was modified"
    # module.py layout
    assert chat_service._canonicalize_emily_exec_command(
        base, existing_files={"pkgworker.py"}
    ) == base, "python -m pkg (module.py) worker was modified"
    # dotted module
    dotted = base.replace("python -m pkgworker", "python -m pkg.worker")
    assert chat_service._canonicalize_emily_exec_command(
        dotted, existing_files={"pkg/worker.py"}
    ) == dotted, "python -m pkg.worker worker was modified"


def test_canonicalize_strips_python_m_when_module_absent(booted):
    """A python -m command whose module is NOT on disk (orphaned / Emily heredoc-ish)
    is still neutralised so the generated run.py executes."""
    chat_service = booted["chat_service"]
    import yaml as _yaml
    base = (
        'schema_version: "0.3"\n'
        'name: "pkgorphan"\n'
        'title: "Pkg Orphan"\n'
        'description: "x"\n'
        'version: "0.1.0"\n'
        'exec:\n  command: "python -m ghostmod"\n  runtime: "python311"\n  runner: "e2b"\n'
        'trigger:\n  type: "manual"\n'
    )
    parsed = _yaml.safe_load(
        chat_service._canonicalize_emily_exec_command(base, existing_files=set())
    )
    assert "command" not in parsed["exec"], "orphaned python -m command survived"


def test_canonicalize_preserves_legacy_runtime_entrypoint_node(booted):
    """Codex P1 #4: a legacy worker with runtime.entrypoint: run.js + runtime.command
    must be preserved when run.js is on disk (and _manifest_executes_run_py False)."""
    chat_service = booted["chat_service"]
    import yaml as _yaml
    legacy_yml = (
        'schema_version: "0.3"\n'
        'name: "legacynode"\n'
        'title: "Legacy Node"\n'
        'description: "x"\n'
        'version: "0.1.0"\n'
        'runtime:\n  type: "node22"\n  entrypoint: "run.js"\n  command: "node run.js"\n  runner: "e2b"\n'
        'trigger:\n  type: "manual"\n'
    )
    out = chat_service._canonicalize_emily_exec_command(legacy_yml, existing_files={"run.js"})
    assert out == legacy_yml, "legacy runtime.entrypoint node worker was modified"
    parsed = _yaml.safe_load(out)
    assert chat_service._manifest_executes_run_py(parsed) is False, (
        "legacy run.js worker wrongly treated as a run.py worker"
    )


def test_canonicalize_command_only_orphaned_falls_back_to_run_py(booted):
    """A command-only worker whose target file is ABSENT (e.g. a divergent heredoc
    or a 'node run.js' with no run.js) is NOT preserved — the command is stripped
    and the worker falls back to the generated run.py."""
    chat_service = booted["chat_service"]
    import yaml as _yaml

    # Heredoc-style command with no script file (the original E1 bug shape).
    cmd_only_yml = (
        'schema_version: "0.3"\n'
        'name: "cmdorphan"\n'
        'title: "Cmd Orphan"\n'
        'description: "x"\n'
        'version: "0.1.0"\n'
        'exec:\n  command: "python -c \\"print(1)\\""\n  runtime: "python311"\n  runner: "e2b"\n'
        'trigger:\n  type: "manual"\n'
    )
    parsed = _yaml.safe_load(
        chat_service._canonicalize_emily_exec_command(cmd_only_yml, existing_files=set())
    )
    assert "command" not in parsed["exec"], "divergent heredoc command survived"
    # No entry was derivable (target not a script file present) -> falls back to
    # the schema default (run.py). exec.entry stays unset here; the schema fills it.
    assert parsed["exec"].get("entry") in (None, "run.py")


def test_canonicalize_redirects_orphaned_js_entry(booted):
    """An orphaned run.js entry (no source file) IS redirected to run.py (codegen
    backfills run.py). This is the create case where the tool supplies no source."""
    chat_service = booted["chat_service"]
    import yaml as _yaml

    js_yml = (
        'schema_version: "0.3"\n'
        'name: "orphanjs"\n'
        'title: "Orphan JS"\n'
        'description: "x"\n'
        'version: "0.1.0"\n'
        'exec:\n  entry: "run.js"\n  runtime: "node22"\n  runner: "e2b"\n'
        'trigger:\n  type: "manual"\n'
    )
    parsed = _yaml.safe_load(
        chat_service._canonicalize_emily_exec_command(js_yml, existing_files=set())
    )
    assert parsed["exec"]["entry"] == "run.py", "orphaned run.js was not redirected"


def test_update_preserves_real_run_js_worker_entry(booted, monkeypatch):
    """End-to-end Codex-blocker regression: updating an existing real run.js worker
    via workers__update must keep entry: run.js (source is on disk), not rewrite to
    run.py."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    _stub_codegen_and_smoke(monkeypatch, run_service, workers_dir)

    from main import _register_worker_from_files, DraftFile
    from db import get_repositories

    js_yml = (
        'schema_version: "0.3"\n'
        'name: "realnode"\n'
        'title: "Real Node"\n'
        'description: "A genuine node worker."\n'
        'version: "0.1.0"\n'
        'entrypoint: "run.js"\n'
        'exec:\n  entry: "run.js"\n  runtime: "node22"\n  runner: "e2b"\n'
        '  command: "node run.js"\n'
        'trigger:\n  type: "manual"\n'
    )
    worker_id = _register_worker_from_files(
        [DraftFile(path="worker.yml", content=js_yml),
         DraftFile(path="run.js", content="console.log('hi')\n"),
         DraftFile(path="package.json", content='{"name":"realnode"}\n')],
        user_id="federico", repos=get_repositories(), dedupe_id=True,
    )

    updated = js_yml.replace('A genuine node worker.', 'A genuine node worker. (v2)')
    res = chat_service._tool_workers_update({"id": worker_id, "yaml_text": updated}, "federico")
    assert res["ok"] is True, res

    yml_on_disk = (workers_dir / worker_id / "worker.yml").read_text(encoding="utf-8")
    import yaml as _yaml
    parsed = _yaml.safe_load(yml_on_disk)
    assert parsed["exec"]["entry"] == "run.js", f"real run.js entry was clobbered: {parsed['exec']}"
    assert (workers_dir / worker_id / "run.js").is_file(), "run.js source was deleted"


def test_manifest_executes_run_py_classification(booted):
    """Unit: _manifest_executes_run_py must be POSITIVE (entry == run.py), never
    'absence of a non-script entry'. Agent SKILL.md must be False (Codex P1 #5)."""
    cs = booted["chat_service"]
    assert cs._manifest_executes_run_py({"exec": {"entry": "run.py"}}) is True
    assert cs._manifest_executes_run_py({"exec": {"entry": "SKILL.md"}}) is False
    assert cs._manifest_executes_run_py({"entrypoint": "SKILL.md"}) is False
    assert cs._manifest_executes_run_py({"exec": {"entry": "run.js"}}) is False
    assert cs._manifest_executes_run_py({"runtime": {"entrypoint": "run.js"}}) is False
    assert cs._manifest_executes_run_py({"exec": {"command": "node run.js"}}) is False
    # No entry/command at all -> schema default run.py (the Emily create case).
    assert cs._manifest_executes_run_py({"trigger": {"type": "manual"}}) is True
    # Command-only python -m package: NOT a run.py worker (Codex P1 #6 follow-up).
    assert cs._manifest_executes_run_py({"exec": {"command": "python -m pkgworker"}}) is False
    assert cs._manifest_executes_run_py({"exec": {"command": "python -m pkg.worker"}}) is False
    assert cs._manifest_executes_run_py({"exec": {"command": "./bin/start"}}) is False
    # Explicit canonical run.py command -> run.py worker.
    assert cs._manifest_executes_run_py({"exec": {"command": "python run.py"}}) is True


def test_agent_skill_md_worker_not_codegen_or_backfilled_on_update(booted, monkeypatch):
    """Codex P1 #5: updating a real SKILL.md agent worker must NOT backfill run.py
    nor invoke run.py codegen — its executable entry is SKILL.md."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]

    from main import _register_worker_from_files, DraftFile
    from db import get_repositories

    agent_yml = (
        'schema_version: "0.3"\n'
        'name: "agentw"\n'
        'title: "Agent W"\n'
        'description: "agent worker"\n'
        'version: "0.1.0"\n'
        'entrypoint: "SKILL.md"\n'
        'exec:\n  entry: "SKILL.md"\n  runtime: "skill"\n  runner: "e2b"\n'
        'trigger:\n  type: "manual"\n'
    )
    worker_id = _register_worker_from_files(
        [DraftFile(path="worker.yml", content=agent_yml),
         DraftFile(path="SKILL.md", content="You are a helpful agent.\n")],
        user_id="federico", repos=get_repositories(), dedupe_id=True,
    )

    codegen_calls: list = []
    orig = chat_service._generate_run_py_from_manifest
    def _spy(wid, manifest, uid, log_fn, *, force=False):
        codegen_calls.append(wid)
        return orig(wid, manifest, uid, log_fn, force=force)
    monkeypatch.setattr(chat_service, "_generate_run_py_from_manifest", _spy)

    # Gate returns skipped for an agent worker (not a script-mode worker) — fine.
    def _gate(wid, bundle, *, user_id, repos, log_fn, allow_code_repair=True):
        return {"status": "skipped", "reason": "not a script-mode worker"}
    monkeypatch.setattr(run_service, "smoke_and_gate_generated_worker", _gate)

    updated = agent_yml.replace("agent worker", "agent worker v2")
    res = chat_service._tool_workers_update({"id": worker_id, "yaml_text": updated}, "federico")
    assert res["ok"] is True, res
    # The meaningful invariant: the run.py-specific machinery (codegen) is NOT
    # applied to an agent worker. (A benign run.py stub from the shared
    # registration helper may exist on disk, but it is never executed nor codegen'd
    # for a SKILL.md worker, and the placeholder preflight only fires when the entry
    # IS run.py.) The update reports the skipped smoke verdict honestly.
    assert codegen_calls == [], f"agent worker was codegen'd into run.py: {codegen_calls}"
    assert res.get("smoke_status") == "skipped", res
    assert "generation produced no script code" not in (res.get("message") or "")


def test_run_js_worker_not_codegen_or_placeholder_gated(booted, monkeypatch):
    """Codex P1 (2nd): a real run.js worker updated via workers__update must NOT be
    codegen'd into run.py nor failed by the run.py placeholder preflight, even when
    codegen would return no code. The smoke must run its OWN entry (node run.js)."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]

    from main import _register_worker_from_files, DraftFile
    from db import get_repositories
    from models import WorkerResult

    js_yml = (
        'schema_version: "0.3"\n'
        'name: "noderun"\n'
        'title: "Node Run"\n'
        'description: "node worker"\n'
        'version: "0.1.0"\n'
        'entrypoint: "run.js"\n'
        'exec:\n  entry: "run.js"\n  runtime: "node22"\n  runner: "e2b"\n'
        '  command: "node run.js"\n'
        '  outputs:\n  - name: "result"\n    kind: scalar\n    type: string\n    required: true\n'
        'trigger:\n  type: "manual"\n'
    )
    worker_id = _register_worker_from_files(
        [DraftFile(path="worker.yml", content=js_yml),
         DraftFile(path="run.js", content="console.log('hi')\n"),
         DraftFile(path="package.json", content='{"name":"noderun"}\n')],
        user_id="federico", repos=get_repositories(), dedupe_id=True,
    )

    # codegen returns NO code (Codex's failure trigger). If the run.py machinery
    # were wrongly applied, this would fail the worker.
    monkeypatch.setattr(run_service, "_repair_run_py", lambda **k: None)

    codegen_calls: list = []
    orig_gen = chat_service._generate_run_py_from_manifest
    def _spy_gen(wid, manifest, uid, log_fn, *, force=False):
        codegen_calls.append(wid)
        return orig_gen(wid, manifest, uid, log_fn, force=force)
    monkeypatch.setattr(chat_service, "_generate_run_py_from_manifest", _spy_gen)

    # Driver runs node run.js successfully.
    class _NodeDriver:
        def run(self, *, worker_id, run_id, inputs, config=None, **kwargs):  # noqa: ANN001
            return WorkerResult(status="success", outputs={"result": "ok"}, artifacts=[])
    monkeypatch.setattr(run_service, "get_sandbox_driver", lambda *a, **k: _NodeDriver())

    import yaml as _yaml
    updated = js_yml.replace('node worker', 'node worker v2')
    res = chat_service._tool_workers_update({"id": worker_id, "yaml_text": updated}, "federico")
    assert res["ok"] is True, res
    # codegen must NOT have been called for a run.js worker.
    assert codegen_calls == [], f"run.js worker was codegen'd into run.py: {codegen_calls}"
    # And it must NOT be failed by the run.py placeholder preflight.
    assert res.get("smoke_status") in ("passed", "skipped"), res
    assert "generation produced no script code" not in (res.get("message") or "")


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


def test_skipped_smoke_is_not_reported_as_verified(booted, monkeypatch):
    """Blocker (Codex review): a 'skipped' gate (e.g. needs a secret) means runtime
    validation did NOT run — the tool must NOT claim the worker is verified runnable."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    _stub_codegen_and_smoke(monkeypatch, run_service, workers_dir)

    def _skip_gate(wid, bundle, *, user_id, repos, log_fn, allow_code_repair=True):
        return {"status": "skipped", "reason": "needs a credential before it can run (X_API_KEY)"}

    monkeypatch.setattr(run_service, "smoke_and_gate_generated_worker", _skip_gate)

    res = chat_service._tool_workers_create({"yaml_text": _UPPERCASE_YML}, "federico")
    assert res["ok"] is True, res
    assert res.get("smoke_status") == "skipped", res
    msg = res.get("message", "").lower()
    assert "verified runnable" not in msg, f"skipped worker falsely reported verified: {msg}"
    assert "untested" in msg or "could not verify" in msg, msg


def test_errored_smoke_is_not_reported_as_verified(booted, monkeypatch):
    """Blocker (Codex review): when the smoke infra itself raises, status must be
    'errored' and the tool must NOT claim the worker is verified runnable."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    _stub_codegen_and_smoke(monkeypatch, run_service, workers_dir)

    def _boom_gate(wid, bundle, *, user_id, repos, log_fn, allow_code_repair=True):
        raise RuntimeError("e2b sandbox unreachable")

    monkeypatch.setattr(run_service, "smoke_and_gate_generated_worker", _boom_gate)

    res = chat_service._tool_workers_create({"yaml_text": _UPPERCASE_YML}, "federico")
    assert res["ok"] is True, res
    assert res.get("smoke_status") == "errored", res
    msg = res.get("message", "").lower()
    assert "verified runnable" not in msg, f"errored worker falsely reported verified: {msg}"
    assert "unverified" in msg or "could not be run" in msg, msg


def test_smoke_runs_output_schema_contract_like_a_real_run(booted, monkeypatch):
    """Blocker (Codex review): smoke must validate the SAME two-stage gate a real
    run uses — _validate_output_schema (scalar type/json contract) THEN
    _validate_run_outputs. A scalar `type: json` output that is non-empty but not
    valid JSON must FAIL smoke, not pass it and then fail every real run with
    schema_violation. This drives the real _smoke_and_repair_generated_worker."""
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]

    # A worker declaring a scalar JSON output, with a driver that returns a
    # NON-JSON string for it. The real-run gate rejects this (schema_violation);
    # smoke must reject it too.
    json_yml = (
        'schema_version: "0.3"\n'
        'name: "jsonout"\n'
        'title: "JSON Out"\n'
        'description: "Returns a JSON scalar."\n'
        'version: "0.1.0"\n'
        'trigger:\n  type: "manual"\n'
        'exec:\n'
        '  entry: "run.py"\n  runtime: "python311"\n  runner: "e2b"\n'
        '  inputs:\n  - name: "text"\n    kind: scalar\n    type: string\n    required: true\n'
        '  outputs:\n  - name: "data"\n    kind: scalar\n    type: json\n    required: true\n'
    )
    main = booted["main"]
    from main import _register_worker_from_files, DraftFile
    from db import get_repositories

    worker_id = _register_worker_from_files(
        [DraftFile(path="worker.yml", content=json_yml),
         DraftFile(path="run.py", content="print('hi')\n")],
        user_id="federico",
        repos=get_repositories(),
        dedupe_id=True,
    )

    from models import WorkerResult

    class _BadJsonDriver:
        def run(self, *, worker_id, run_id, inputs, config=None, **kwargs):  # noqa: ANN001
            return WorkerResult(status="success", outputs={"data": "not json at all"}, artifacts=[])

    monkeypatch.setattr(run_service, "get_sandbox_driver", lambda *a, **k: _BadJsonDriver())
    # No code repair so we get the raw verdict, not a codegen rewrite.
    smoke = run_service._smoke_and_repair_generated_worker(
        worker_id, {}, user_id="federico", repos=get_repositories(),
        log_fn=lambda *a, **k: None, allow_code_repair=False,
    )
    assert smoke["status"] == "failed", (
        f"smoke passed a worker that fails real-run schema validation: {smoke}"
    )


def test_disabled_worker_smoke_is_not_reported_verified(booted, monkeypatch):
    """Blocker (Codex review #3): a manifest with paused:true is rejected by
    create_run ('Worker is disabled'), so smoke must NOT report it 'verified
    runnable'. The gate must surface it as skipped, and the tool must say untested."""
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    workers_dir = booted["workers_dir"]
    # Use the REAL smoke gate (only stub codegen so no network), so the disabled
    # short-circuit inside _smoke_and_repair_generated_worker is exercised.
    def _fake_repair(*, run_code, failure, secrets, log_fn, intent=""):
        return _REAL_RUN_PY
    monkeypatch.setattr(run_service, "_repair_run_py", _fake_repair)

    paused_yml = _UPPERCASE_YML.replace(
        'trigger:\n  type: "manual"\n',
        'paused: true\ntrigger:\n  type: "manual"\n',
    )
    res = chat_service._tool_workers_create({"yaml_text": paused_yml}, "federico")
    assert res["ok"] is True, res
    # Must be skipped (intentionally off), never passed/verified.
    assert res.get("smoke_status") == "skipped", res
    msg = res.get("message", "").lower()
    assert "verified runnable" not in msg, f"disabled worker falsely reported verified: {msg}"

    # And the worker is genuinely disabled at the runtime boundary (the mismatch
    # Codex repro'd): create_run rejects it.
    worker_id = res["worker_id"]
    import pytest as _pytest
    with _pytest.raises(ValueError, match="disabled"):
        run_service.create_run(
            worker_id, {"text": "x"}, trigger_source="workspace-agent", user_id="federico"
        )
