"""Platform-resilience: one bad worker must never crash startup.

Regression for the 2026-06-14 outage: a foreign directory
(`.novasearch-v4-backup-...`) carrying a `worker.yml` was dropped into the
workers dir. `discover_workers()` ingested it and `_persist_discovered_workers`
raised `sqlite3.IntegrityError` (FOREIGN KEY constraint failed) UNCAUGHT, which
crashed API startup into a ~60s autodeploy crash-loop (prod 502 for ~10 min).

Guarantees covered here:
1. `_persist_discovered_workers` isolates each worker in a SAVEPOINT: a single
   FK-violating / failing worker is skipped (rolled back + logged), and the good
   workers still persist. No exception propagates by default.
2. `raise_on_skip=True` (single-worker save endpoints) re-raises so a user
   saving exactly one bad worker still gets a hard error.
3. `discover_workers()` skips dot-prefixed dirs (e.g. backup dirs) so foreign
   backups are never ingested as workers in the first place.
"""

from __future__ import annotations

import importlib
import sqlite3
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _worker_yml(name: str) -> str:
    return f"""\
schema_version: '0.3'
name: {name}
title: {name}
description: A worker for resilience testing.
version: 0.1.0
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


@pytest.fixture
def main_env(monkeypatch, tmp_path):
    """Bootstrap a fresh in-tmp DB + workers dir and return (main, db, workers_dir)."""
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()

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

    yield main, db, workers_dir
    db.get_repositories.cache_clear()


def _write_worker(workers_dir: Path, name: str) -> Path:
    wdir = workers_dir / name
    wdir.mkdir()
    (wdir / "worker.yml").write_text(_worker_yml(name), encoding="utf-8")
    (wdir / "run.py").write_text("print('ok')\n", encoding="utf-8")
    (wdir / "requirements.txt").write_text("", encoding="utf-8")
    return wdir


def test_bad_worker_is_skipped_good_workers_persist(main_env, monkeypatch):
    """One worker that raises on persist is skipped; the rest still load."""
    main, db, workers_dir = main_env
    _write_worker(workers_dir, "good-one")
    _write_worker(workers_dir, "poison-one")
    _write_worker(workers_dir, "good-two")

    main.invalidate_worker_cache()
    workers = main.discover_workers()
    assert {w["id"] for w in workers} == {"good-one", "poison-one", "good-two"}

    # Force ONLY the poison worker to fail inside the per-worker persist, the
    # way a dangling-FK / invalid-manifest worker fails in prod.
    real_persist_one = main._persist_one_worker

    def fake_persist_one(conn, w, *, user_id, now):
        if w["id"] == "poison-one":
            raise sqlite3.IntegrityError("FOREIGN KEY constraint failed")
        return real_persist_one(conn, w, user_id=user_id, now=now)

    monkeypatch.setattr(main, "_persist_one_worker", fake_persist_one)

    with main.get_db() as conn:
        loaded, skipped = main._persist_discovered_workers(
            conn, workers, user_id="federico"
        )

    assert loaded == 2
    assert skipped == 1

    # The good workers must be queryable; the poison one must be absent.
    repos = db.get_repositories()
    assert repos.workers.get_recipe(worker_id="good-one") is not None
    assert repos.workers.get_recipe(worker_id="good-two") is not None
    assert repos.workers.get_recipe(worker_id="poison-one") is None


def test_raise_on_skip_propagates_for_single_worker_save(main_env, monkeypatch):
    """Single-worker save endpoints pass raise_on_skip=True and must fail loud."""
    main, db, workers_dir = main_env
    _write_worker(workers_dir, "solo")

    main.invalidate_worker_cache()
    workers = main.discover_workers()

    def boom(conn, w, *, user_id, now):
        raise sqlite3.IntegrityError("FOREIGN KEY constraint failed")

    monkeypatch.setattr(main, "_persist_one_worker", boom)

    with pytest.raises(sqlite3.IntegrityError):
        with main.get_db() as conn:
            main._persist_discovered_workers(
                conn, workers, user_id="federico", raise_on_skip=True
            )


def test_real_fk_violation_is_skipped_not_fatal(main_env, monkeypatch):
    """End-to-end: a real dangling skill_version_id FK is skipped, not raised.

    Mirrors the prod failure mode where the workers INSERT references a
    skill_version row that never got created.
    """
    main, db, workers_dir = main_env
    _write_worker(workers_dir, "good-real")
    _write_worker(workers_dir, "fk-broken")

    main.invalidate_worker_cache()
    workers = main.discover_workers()

    real_persist_one = main._persist_one_worker

    def fk_break(conn, w, *, user_id, now):
        if w["id"] == "fk-broken":
            # Insert a workers row pointing at a skill_version that does not
            # exist -> FOREIGN KEY constraint failed (exactly the prod crash).
            conn.execute(
                "INSERT INTO workers (id, skill_version_id, name, trigger_type, "
                "enabled, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("fk-broken", "sv-does-not-exist", "fk-broken", "manual", 1,
                 main.now_iso(), user_id),
            )
            return
        return real_persist_one(conn, w, user_id=user_id, now=now)

    monkeypatch.setattr(main, "_persist_one_worker", fk_break)

    with main.get_db() as conn:
        loaded, skipped = main._persist_discovered_workers(
            conn, workers, user_id="federico"
        )

    assert loaded == 1
    assert skipped == 1
    repos = db.get_repositories()
    assert repos.workers.get_recipe(worker_id="good-real") is not None
    assert repos.workers.get_recipe(worker_id="fk-broken") is None


def test_discover_skips_dot_prefixed_dirs(main_env):
    """discover_workers must NOT ingest a dot-prefixed backup dir with worker.yml."""
    main, db, workers_dir = main_env
    _write_worker(workers_dir, "real-worker")

    # Foreign backup dir that carries a worker.yml — the 2026-06-14 poison shape.
    backup = workers_dir / ".novasearch-v4-backup-20260614-200950"
    backup.mkdir()
    (backup / "worker.yml").write_text(_worker_yml("novasearch-v4"), encoding="utf-8")
    (backup / "candidates.json").write_text("[]", encoding="utf-8")

    main.invalidate_worker_cache()
    ids = {w["id"] for w in main.discover_workers()}

    assert "real-worker" in ids
    assert ".novasearch-v4-backup-20260614-200950" not in ids
    assert "novasearch-v4" not in ids
