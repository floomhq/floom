"""Wedge fix (2026-05-29): the prompt-to-worker flow must end on a REAL,
editable, runnable worker — not a dead-end ``/runs/<id>`` bundle.

Root cause: ``/workers/new`` runs the ``worker-author`` meta-worker, which
drafts ``out/bundle.json`` inside its E2B sandbox but can never register a
worker (registration is a backend DB op). Its ``run.py`` always set
``created_worker_id: None``. So the happy path produced a bundle the operator
could only download — no catalog increment, no editor.

Fix (Path A): on worker-author run COMPLETION, the backend
(``run_service._register_authored_worker``) reads the drafted bundle and
registers it through the SAME path ``/workers/draft-and-create`` uses
(``main._register_worker_from_files``), then reports the new worker id on the
run output + via SSE so ``/workers/new`` navigates to ``/workers/<id>?edit=1``.

These tests are pure-function / on-disk and touch no HTTP/auth, so they are
immune to the suite-wide FLOOM_SECRET env-leak bug noted in
test_pr_54_draft_id_collision_repo.py.
"""

import json
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ.pop("FLOOM_SECRET", None)
os.environ.setdefault("OPENAI_API_KEY", "sk-test-fake-key")
os.environ["WORKEROS_DEPLOY"] = "local"


def _valid_worker_yml(name: str = "github-pr-digest") -> str:
    return f"""\
schema_version: "0.3"
name: {name}
title: "GitHub PR Digest"
description: "Email a daily digest of unread GitHub PRs."
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]

exec:
  runtime: skill
  mode: agent
  runner: e2b
  entrypoint: SKILL.md
  inputs: []
  outputs: []

trigger:
  type: manual
"""


def test_worker_author_id_constants_match():
    """The run_service hook constant must equal main's worker-author id, or
    the post-completion registration hook silently never fires."""
    import main
    import run_service

    assert run_service._WORKER_AUTHOR_WORKER_ID == main._WORKER_AUTHOR_ID == "worker-author"


def test_register_worker_from_files_creates_real_worker(monkeypatch, tmp_path):
    """The shared registration helper writes the bundle to disk and registers
    it, returning the worker id."""
    import worker_registry
    import main

    monkeypatch.setattr(worker_registry, "WORKERS_DIR", tmp_path)

    files = [
        main.DraftFile(path="worker.yml", content=_valid_worker_yml()),
        main.DraftFile(path="SKILL.md", content="# GitHub PR Digest\n\nDo the thing."),
    ]
    worker_id = main._register_worker_from_files(files, user_id="local-user", repos=None)

    assert worker_id == "github-pr-digest"
    assert (tmp_path / worker_id / "worker.yml").exists()
    assert (tmp_path / worker_id / "SKILL.md").exists()
    # run.py + requirements.txt are backfilled with safe defaults.
    assert (tmp_path / worker_id / "run.py").exists()
    assert (tmp_path / worker_id / "requirements.txt").exists()


def test_backfilled_run_py_satisfies_e2b_contract(monkeypatch, tmp_path):
    """LIVE-FOUND BUG (2026-05-29): the backfilled run.py used the legacy
    run(inputs, context) signature with NO __main__ block, so `python run.py`
    (the E2B pure-script contract) wrote no result.json and every run of a
    backfilled worker failed with error_code=missing_result. The stub MUST be
    valid Python AND write result.json when executed as a script."""
    import ast
    import subprocess
    import sys
    import main

    stub = main._DEFAULT_RUN_PY_STUB
    # 1. Valid Python.
    ast.parse(stub)
    # 2. Executing it as a script writes result.json with success.
    (tmp_path / "run.py").write_text(stub)
    subprocess.run([sys.executable, "run.py"], cwd=tmp_path, check=True, timeout=30)
    result = json.loads((tmp_path / "result.json").read_text())
    assert result["status"] == "success"
    assert "outputs" in result


def test_register_worker_from_files_dedupes_when_requested(monkeypatch, tmp_path):
    """With dedupe_id=True a colliding id is rewritten rather than 409'd, so a
    worker-author generation never fails because the suggested slug is taken."""
    import worker_registry
    import main

    monkeypatch.setattr(worker_registry, "WORKERS_DIR", tmp_path)

    files1 = [
        main.DraftFile(path="worker.yml", content=_valid_worker_yml()),
        main.DraftFile(path="SKILL.md", content="# A\n"),
    ]
    first = main._register_worker_from_files(files1, user_id="local-user", repos=None, dedupe_id=True)
    assert first == "github-pr-digest"

    files2 = [
        main.DraftFile(path="worker.yml", content=_valid_worker_yml()),
        main.DraftFile(path="SKILL.md", content="# B\n"),
    ]
    second = main._register_worker_from_files(files2, user_id="local-user", repos=None, dedupe_id=True)
    assert second != first
    assert second.startswith("github-pr-digest-"), second
    # The rewritten manifest agrees with the deduped dir name.
    import yaml as pyyaml
    raw = pyyaml.safe_load((tmp_path / second / "worker.yml").read_text())
    assert raw.get("name") == second


def test_register_authored_worker_reads_bundle_and_registers(monkeypatch, tmp_path):
    """The post-completion hook reads a worker-author bundle.json artifact and
    registers a real worker, returning its id."""
    import worker_registry
    import run_service

    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", workers_dir)

    # Write a bundle.json exactly as workers/worker-author/run.py produces it.
    artifacts_dir = tmp_path / "artifacts"
    bundle_path = artifacts_dir / "run_test" / "out" / "bundle.json"
    bundle_path.parent.mkdir(parents=True)
    bundle = {
        "worker_yml": _valid_worker_yml(),
        "skill_md": "# GitHub PR Digest\n\nFetch unread PRs and email them.",
        "run_code": None,
        "requirements_txt": None,
        "suggested_id": "github-pr-digest",
        "sample_input_json": "{}",
        "created_worker_id": None,
    }
    bundle_path.write_text(json.dumps(bundle), encoding="utf-8")

    artifacts = [{
        "name": "bundle.json",
        "relative_path": "out/bundle.json",
        "path": str(bundle_path),
        "type": "application/json",
        "size_bytes": bundle_path.stat().st_size,
    }]

    logs = []

    def log_fn(msg, level="info"):
        logs.append((level, msg))

    worker_id = run_service._register_authored_worker(
        "run_test",
        outputs={},
        artifacts=artifacts,
        user_id="local-user",
        repos=None,
        log_fn=log_fn,
    )

    assert worker_id == "github-pr-digest"
    assert (workers_dir / worker_id / "worker.yml").exists()
    assert (workers_dir / worker_id / "SKILL.md").exists()


def test_register_authored_worker_rejects_empty_bundle(monkeypatch, tmp_path):
    """GAP 2 (2026-05-29): a bundle with NEITHER skill_md NOR run_code must NOT
    register a worker. Otherwise the run.py stub backfill ships a worker that
    "runs green" with empty outputs — a silent no-op the operator thinks works.
    The hook returns None (the drafted bundle stays viewable)."""
    import worker_registry
    import run_service

    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", workers_dir)

    artifacts_dir = tmp_path / "artifacts"
    bundle_path = artifacts_dir / "run_empty" / "out" / "bundle.json"
    bundle_path.parent.mkdir(parents=True)
    bundle = {
        "worker_yml": _valid_worker_yml(),
        "skill_md": None,
        "run_code": None,  # neither executable form present
        "requirements_txt": None,
        "suggested_id": "github-pr-digest",
        "sample_input_json": "{}",
        "created_worker_id": None,
    }
    bundle_path.write_text(json.dumps(bundle), encoding="utf-8")
    artifacts = [{
        "name": "bundle.json",
        "relative_path": "out/bundle.json",
        "path": str(bundle_path),
        "type": "application/json",
        "size_bytes": bundle_path.stat().st_size,
    }]

    worker_id = run_service._register_authored_worker(
        "run_empty", outputs={}, artifacts=artifacts,
        user_id="local-user", repos=None, log_fn=lambda *a, **k: None,
    )

    assert worker_id is None
    # nothing written to disk — no silent no-op worker
    assert not any(workers_dir.iterdir())


def test_placeholder_stub_marker_matches_main_stub():
    """GAP 2 coupling guard: the smoke's placeholder marker MUST be a substring
    of main._DEFAULT_RUN_PY_STUB, or the smoke would silently pass a no-op stub
    worker as green. Catches the stub comment being edited out of sync."""
    import main
    import run_service

    assert run_service._PLACEHOLDER_RUN_PY_MARKER in main._DEFAULT_RUN_PY_STUB


def test_register_authored_worker_normalizes_invalid_use_cases(monkeypatch, tmp_path):
    """LIVE-FOUND BUG (2026-05-29): the worker-author LLM emitted a worker.yml
    with use_cases of <3 items, which passes worker-author's loose validator but
    FAILS the canonical WorkerContract schema (use_cases must be 3-5 items), so
    registration 400'd and the worker never got created. The backend must strip
    the violating OPTIONAL metadata and still register a functional worker."""
    import worker_registry
    import run_service

    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", workers_dir)

    # A worker.yml that is functionally valid but carries 1 use_case (<3) and
    # 9 tags (>8) — both violate the schema's optional-metadata validators.
    bad_meta_yml = _valid_worker_yml().rstrip() + (
        "\n\nuse_cases:\n  - \"Get a daily PR summary by email\"\n"
        "tags:\n" + "".join(f"  - \"tag{i}\"\n" for i in range(9))
    )

    bundle_path = tmp_path / "artifacts" / "run_meta" / "out" / "bundle.json"
    bundle_path.parent.mkdir(parents=True)
    bundle_path.write_text(json.dumps({
        "worker_yml": bad_meta_yml,
        "skill_md": "# GitHub PR Digest\n\nFetch and email unread PRs.",
        "run_code": None,
        "requirements_txt": None,
        "created_worker_id": None,
    }), encoding="utf-8")

    artifacts = [{
        "name": "bundle.json",
        "relative_path": "out/bundle.json",
        "path": str(bundle_path),
    }]

    worker_id = run_service._register_authored_worker(
        "run_meta",
        outputs={},
        artifacts=artifacts,
        user_id="local-user",
        repos=None,
        log_fn=lambda *a, **k: None,
    )

    assert worker_id == "github-pr-digest", "functional worker must register despite bad optional metadata"
    import yaml as pyyaml
    raw = pyyaml.safe_load((workers_dir / worker_id / "worker.yml").read_text())
    # Violating optional metadata is stripped (lossless to function).
    assert "use_cases" not in raw
    assert "tags" not in raw


def test_normalize_authored_worker_yml_keeps_valid_metadata(monkeypatch):
    """The normalizer must NOT touch metadata that already satisfies the schema."""
    import run_service

    good_yml = _valid_worker_yml().rstrip() + (
        "\n\nuse_cases:\n  - \"A\"\n  - \"B\"\n  - \"C\"\n"
        "tags:\n  - \"x\"\n  - \"y\"\n"
    )
    out = run_service._normalize_authored_worker_yml(good_yml, lambda *a, **k: None)
    import yaml as pyyaml
    raw = pyyaml.safe_load(out)
    assert raw.get("use_cases") == ["A", "B", "C"]
    assert raw.get("tags") == ["x", "y"]


def test_register_authored_worker_is_idempotent(monkeypatch, tmp_path):
    """If the run output already has created_worker_id, no second worker is
    made (guards against duplicate creation on resume/re-execution)."""
    import worker_registry
    import run_service

    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", workers_dir)

    worker_id = run_service._register_authored_worker(
        "run_already",
        outputs={"created_worker_id": "already-made"},
        artifacts=[],
        user_id="local-user",
        repos=None,
        log_fn=lambda *a, **k: None,
    )
    assert worker_id == "already-made"
    # No dirs created.
    assert not any(workers_dir.iterdir())


def test_register_authored_worker_skips_broken_bundle(monkeypatch, tmp_path):
    """A bundle carrying a validation `error` is NOT registered (don't create a
    broken worker); the run still completes and the bundle stays viewable."""
    import worker_registry
    import run_service

    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", workers_dir)

    bundle_path = tmp_path / "artifacts" / "run_bad" / "out" / "bundle.json"
    bundle_path.parent.mkdir(parents=True)
    bundle_path.write_text(json.dumps({
        "worker_yml": "name: x\n",  # invalid (too short, missing fields)
        "error": "YAML validation failed after 3 attempts: name too short",
    }), encoding="utf-8")

    artifacts = [{
        "name": "bundle.json",
        "relative_path": "out/bundle.json",
        "path": str(bundle_path),
    }]

    worker_id = run_service._register_authored_worker(
        "run_bad",
        outputs={},
        artifacts=artifacts,
        user_id="local-user",
        repos=None,
        log_fn=lambda *a, **k: None,
    )
    assert worker_id is None
    assert not any(workers_dir.iterdir())


# ---------------------------------------------------------------------------
# Fix 3 (2026-05-29): post-generation smoke + bounded repair safety net.
# A generated SCRIPT-mode worker must be PROVEN to run before it is presented
# as ready. These cover the pure helpers; the E2B driver call itself is not
# exercised here (no network), matching this file's no-HTTP/no-auth style.
# ---------------------------------------------------------------------------

def _script_worker_config(name="word-counter", with_file=False):
    """Build a projected WorkerConfig for a script-mode worker."""
    from models import WorkerConfig

    inputs = [
        {"name": "text", "label": "Text", "type": "textarea", "required": True, "kind": "scalar"},
    ]
    if with_file:
        inputs.append(
            {"name": "csv_file", "label": "CSV", "type": "file", "required": True, "kind": "file",
             "path": "inputs/csv_file"}
        )
    raw = {
        "schema_version": "0.3",
        "name": name,
        "title": "Word Counter",
        "description": "Counts the words in a block of text.",
        "version": "0.1.0",
        "exec": {
            "entry": "run.py",
            "command": "python run.py",
            "runtime": "python311",
            "runner": "e2b",
            "inputs": inputs,
            "outputs": [
                {"name": "result", "label": "Result", "type": "file", "kind": "file",
                 "path": "out/result.json", "media_type": "application/json"}
            ],
        },
        "trigger": {"type": "manual"},
    }
    from models import parse_worker_manifest, worker_contract_to_worker_config, WorkerConfig

    parsed = parse_worker_manifest(raw)
    if isinstance(parsed, WorkerConfig):
        return parsed
    return worker_contract_to_worker_config(parsed, name)


def test_build_smoke_inputs_scalar_uses_sample_literal(tmp_path):
    import run_service

    config = _script_worker_config()
    bundle = {"sample_input_json": json.dumps({"text": "hello world"})}
    inputs = run_service._build_smoke_inputs(config, bundle, tmp_path)
    # Scalar value is the literal — NOT a path, NOT opened.
    assert inputs["text"] == "hello world"


def test_build_smoke_inputs_scalar_falls_back_when_no_sample(tmp_path):
    import run_service

    config = _script_worker_config()
    inputs = run_service._build_smoke_inputs(config, {}, tmp_path)
    # Required scalar gets a deterministic placeholder so the smoke isn't blocked.
    assert inputs["text"] == "sample"


def test_build_smoke_inputs_file_is_materialized_as_abs_path(tmp_path):
    import os as _os
    import run_service

    config = _script_worker_config(with_file=True)
    bundle = {"sample_input_json": json.dumps({"text": "hi", "csv_file": "a,b\n1,2\n"})}
    inputs = run_service._build_smoke_inputs(config, bundle, tmp_path)
    # File input is an ABSOLUTE path to a real file (what the E2B driver needs).
    assert _os.path.isabs(inputs["csv_file"])
    assert _os.path.isfile(inputs["csv_file"])
    assert open(inputs["csv_file"]).read() == "a,b\n1,2\n"


def test_strip_code_fences():
    import run_service

    assert run_service._strip_code_fences("```python\nx = 1\n```") == "x = 1"
    assert run_service._strip_code_fences("x = 1") == "x = 1"


def test_repair_run_py_skips_without_key(monkeypatch):
    import run_service

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    out = run_service._repair_run_py(
        run_code="print('x')",
        failure="NameError: name 'os' is not defined",
        secrets={},
        log_fn=lambda *a, **k: None,
    )
    assert out is None


def test_repair_run_py_rejects_invalid_python(monkeypatch):
    """The repair pass must never write syntactically invalid Python over the
    broken file — a worse file is not a fix."""
    import run_service

    class _FakeResp:
        class _Choice:
            class _Msg:
                content = "def main(:\n  pass"  # invalid syntax
            message = _Msg()
        choices = [_Choice()]

    class _FakeClient:
        def __init__(self, **kw):
            self.chat = self
            self.completions = self

        def create(self, **kw):
            return _FakeResp()

    import openai
    monkeypatch.setattr(openai, "OpenAI", _FakeClient)
    out = run_service._repair_run_py(
        run_code="print('x')",
        failure="boom",
        secrets={"OPENAI_API_KEY": "sk-test"},
        log_fn=lambda *a, **k: None,
    )
    assert out is None


def test_smoke_skips_non_script_worker(monkeypatch, tmp_path):
    """Agent-mode workers are not smoke-tested by this path."""
    import worker_registry
    import run_service

    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", workers_dir)

    # Register an agent-mode worker (SKILL.md entry).
    import main
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", workers_dir)
    files = [
        main.DraftFile(path="worker.yml", content=_valid_worker_yml("agent-worker")),
        main.DraftFile(path="SKILL.md", content="# Agent\n"),
    ]
    wid = main._register_worker_from_files(files, user_id="local-user", repos=None)

    out = run_service._smoke_and_repair_generated_worker(
        wid, {}, user_id="local-user", repos=None, log_fn=lambda *a, **k: None
    )
    assert out["status"] == "skipped"
    assert "script" in out["reason"].lower()
