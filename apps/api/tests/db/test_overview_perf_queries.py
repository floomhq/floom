from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[2]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_db(monkeypatch: pytest.MonkeyPatch, db_path: Path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(db_path.with_suffix(".env")))
    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
    ]:
        sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return db


def _close_db() -> None:
    legacy = importlib.import_module("db._legacy_sqlite")
    legacy._close_cached_db_connection()


def _create_worker(repos, worker_id: str) -> None:
    repos.workers.create(
        user_id="federico",
        worker_id=worker_id,
        name=worker_id,
        manifest_json={
            "schema_version": "0.3",
            "name": worker_id,
            "title": worker_id,
            "description": worker_id,
            "version": "0.1.0",
            "exec": {
                "entry": "run.py",
                "runtime": "python311",
                "runner": "e2b",
                "command": "python run.py",
            },
        },
    )


def _create_run(repos, run_id: str, worker_id: str, status: str, created_at: str) -> None:
    repos.runs.create(
        user_id="federico",
        worker_id=worker_id,
        run_id=run_id,
        status=status,
        created_at=created_at,
        started_at=created_at,
    )


def test_overview_perf_indexes_are_migrated(monkeypatch, tmp_path):
    db = _load_db(monkeypatch, tmp_path / "overview-indexes.db")
    expected = {
        "idx_runs_created_status_worker",
        "idx_runs_status_created_worker",
        "idx_workers_owner_enabled_next_run",
        "idx_workers_workspace_enabled_next_run",
        "idx_worker_triggers_schedule_due",
    }

    with db.get_db() as conn:
        indexes = {
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }

    assert expected <= indexes
    _close_db()


def test_overview_perf_queries_return_grouped_and_bounded_rows(monkeypatch, tmp_path):
    db = _load_db(monkeypatch, tmp_path / "overview-queries.db")
    repos = db.get_repositories()
    _create_worker(repos, "active")
    _create_worker(repos, "visible")

    _create_run(repos, "old-success", "active", "completed", "2026-06-03T12:00:00+00:00")
    _create_run(repos, "today-success", "active", "completed", "2026-06-15T00:10:00+00:00")
    _create_run(repos, "today-fail-a", "active", "failed", "2026-06-15T00:20:00+00:00")
    _create_run(repos, "today-fail-b", "active", "failed", "2026-06-15T00:30:00+00:00")
    _create_run(repos, "recent-visible", "visible", "completed", "2026-06-15T00:40:00+00:00")
    _create_run(repos, "queued-now", "visible", "queued", "2026-06-15T00:50:00+00:00")

    rollup = {
        (row["worker_id"], row["status"]): row
        for row in repos.runs.overview_status_rollup(
            user_id="federico",
            since="2026-06-01T00:00:00+00:00",
            window_7d="2026-06-08T00:00:00+00:00",
            today_start="2026-06-15T00:00:00+00:00",
        )
    }
    assert int(rollup[("active", "completed")]["count_previous_7d"]) == 1
    assert int(rollup[("active", "completed")]["count_7d"]) == 1
    assert int(rollup[("active", "failed")]["count_today"]) == 2

    buckets = repos.runs.overview_sparkline_buckets(
        user_id="federico",
        since="2026-06-15T00:00:00+00:00",
        until="2026-06-15T01:00:00+00:00",
        bucket_seconds=3600,
    )
    assert sum(int(row["total"] or 0) for row in buckets) == 5

    current = repos.runs.overview_current_counts(
        user_id="federico",
        statuses=["queued", "running"],
    )
    assert current == {"queued": 1}

    recent = repos.runs.overview_recent_visible_runs(
        user_id="federico",
        worker_ids=["active"],
        limit=2,
    )
    assert [row["id"] for row in recent] == ["today-fail-b", "today-fail-a"]

    failures = repos.runs.overview_latest_failures_by_worker(
        user_id="federico",
        worker_ids=["active", "visible"],
        since="2026-06-15T00:00:00+00:00",
        limit=3,
    )
    assert len(failures) == 1
    assert failures[0]["id"] == "today-fail-b"
    assert int(failures[0]["failure_count"]) == 2

    terminal = repos.runs.overview_terminal_runs(
        user_id="federico",
        worker_ids=["active"],
        since="2026-06-01T00:00:00+00:00",
    )
    assert {row["id"] for row in terminal} == {
        "old-success",
        "today-success",
        "today-fail-a",
        "today-fail-b",
    }
    _close_db()


def test_overview_terminal_runs_are_bounded_per_worker(monkeypatch, tmp_path):
    db = _load_db(monkeypatch, tmp_path / "overview-terminal-limit.db")
    repos = db.get_repositories()
    _create_worker(repos, "active")
    _create_worker(repos, "visible")

    for idx in range(12):
        minute = idx + 1
        _create_run(
            repos,
            f"active-fail-{idx:02d}",
            "active",
            "failed",
            f"2026-06-15T00:{minute:02d}:00+00:00",
        )
        _create_run(
            repos,
            f"visible-fail-{idx:02d}",
            "visible",
            "failed",
            f"2026-06-15T01:{minute:02d}:00+00:00",
        )

    terminal = repos.runs.overview_terminal_runs(
        user_id="federico",
        worker_ids=["active", "visible"],
        since="2026-06-01T00:00:00+00:00",
        per_worker_limit=3,
    )

    by_worker: dict[str, list[str]] = {"active": [], "visible": []}
    for row in terminal:
        by_worker[row["worker_id"]].append(row["id"])

    assert by_worker["active"] == ["active-fail-11", "active-fail-10", "active-fail-09"]
    assert by_worker["visible"] == ["visible-fail-11", "visible-fail-10", "visible-fail-09"]
    _close_db()
