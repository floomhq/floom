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
    worker_id = main._register_worker_from_files(files, user_id="federico", repos=None)

    assert worker_id == "github-pr-digest"
    assert (tmp_path / worker_id / "worker.yml").exists()
    assert (tmp_path / worker_id / "SKILL.md").exists()
    # run.py + requirements.txt are backfilled with safe defaults.
    assert (tmp_path / worker_id / "run.py").exists()
    assert (tmp_path / worker_id / "requirements.txt").exists()


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
    first = main._register_worker_from_files(files1, user_id="federico", repos=None, dedupe_id=True)
    assert first == "github-pr-digest"

    files2 = [
        main.DraftFile(path="worker.yml", content=_valid_worker_yml()),
        main.DraftFile(path="SKILL.md", content="# B\n"),
    ]
    second = main._register_worker_from_files(files2, user_id="federico", repos=None, dedupe_id=True)
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
        user_id="federico",
        repos=None,
        log_fn=log_fn,
    )

    assert worker_id == "github-pr-digest"
    assert (workers_dir / worker_id / "worker.yml").exists()
    assert (workers_dir / worker_id / "SKILL.md").exists()


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
        user_id="federico",
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
        user_id="federico",
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
        user_id="federico",
        repos=None,
        log_fn=lambda *a, **k: None,
    )
    assert worker_id is None
    assert not any(workers_dir.iterdir())
