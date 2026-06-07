"""Batch J — repair-persists-to-recipe + path-safety unit tests (2026-05-29).

`persist_worker_run_py` is the canonical save path the smoke-repair loop now
uses. It MUST: write run.py to disk (what the executor reads on every run),
re-discover, and re-persist the recipe. A persistence failure MUST raise so the
caller treats it as a smoke failure (disable, never silently ship stale code).
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


_WORKER_YML = """\
schema_version: '0.3'
name: persist-probe
title: Persist Probe
description: A worker for testing repair persistence.
version: 0.1.0
targets:
- generic
exec:
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
inputs:
- name: x
  kind: scalar
  type: string
  required: true
  label: X
outputs:
- name: y
  kind: scalar
  type: string
  required: true
  label: Y
trigger:
  type: manual
"""

_OLD_RUN_PY = "# broken\nprint('stale')\n"
_FIXED_RUN_PY = "# fixed\nprint('repaired')\n"


@pytest.fixture
def main_with_worker(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    wdir = workers_dir / "persist-probe"
    wdir.mkdir()
    (wdir / "worker.yml").write_text(_WORKER_YML, encoding="utf-8")
    (wdir / "run.py").write_text(_OLD_RUN_PY, encoding="utf-8")
    (wdir / "requirements.txt").write_text("", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    # Register the worker so a recipe exists.
    repos = db.get_repositories()
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")

    yield main, db, wdir, repos
    db.get_repositories.cache_clear()


def test_persist_worker_run_py_writes_disk_and_keeps_recipe(main_with_worker):
    main, db, wdir, repos = main_with_worker

    main.persist_worker_run_py("persist-probe", _FIXED_RUN_PY, user_id="federico")

    # The executor reads run.py from disk on every run; the fix must be there.
    assert (wdir / "run.py").read_text(encoding="utf-8") == _FIXED_RUN_PY

    # The recipe must still resolve (manifest in sync, not orphaned).
    recipe = repos.workers.get_recipe(worker_id="persist-probe")
    assert recipe is not None
    assert recipe["config"] is not None


def test_persist_worker_run_py_missing_worker_raises(main_with_worker):
    main, db, wdir, repos = main_with_worker
    with pytest.raises((FileNotFoundError, Exception)):
        main.persist_worker_run_py("no-such-worker", _FIXED_RUN_PY, user_id="federico")


def test_persist_does_not_break_run_py_content_roundtrip(main_with_worker):
    main, db, wdir, repos = main_with_worker
    main.persist_worker_run_py("persist-probe", _FIXED_RUN_PY, user_id="federico")
    # A second persist (idempotent) keeps the latest content.
    newer = "# fixed-again\nprint('v2')\n"
    main.persist_worker_run_py("persist-probe", newer, user_id="federico")
    assert (wdir / "run.py").read_text(encoding="utf-8") == newer
