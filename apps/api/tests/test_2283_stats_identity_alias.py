"""Regression coverage for workspace telemetry identity and admin population."""

from __future__ import annotations

import importlib
import json
import sqlite3
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "test-secret-2283"
_RESOLVED_USER_ID = "owner-admin"
_RAW_USER_ID = "session-uuid-2283"
_WORKSPACE_ID = "local-default"


def _insert_worker_and_run(
    db_path: Path,
    *,
    worker_id: str,
    owner_id: str,
    status: str,
    duration_ms: int,
) -> None:
    with sqlite3.connect(db_path) as conn:
        version_id = f"sv-{worker_id}"
        conn.execute(
            "INSERT INTO skill_versions "
            "(id,name,version,manifest_json,bundle_path,created_at) "
            "VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)",
            (version_id, worker_id, "1.0", json.dumps({"title": worker_id}), "/x"),
        )
        conn.execute(
            "INSERT INTO workers "
            "(id,skill_version_id,name,trigger_type,enabled,owner_id,workspace_id,"
            "visibility,created_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)",
            (worker_id, version_id, worker_id, "manual", 1, owner_id, _WORKSPACE_ID, "private"),
        )
        conn.execute(
            "INSERT INTO runs "
            "(id,worker_id,status,trigger_source,runner,created_at,started_at,completed_at,duration_ms) "
            "VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?)",
            (f"run-{worker_id}", worker_id, status, "manual", "e2b", duration_ms),
        )


@pytest.fixture
def stats_env(monkeypatch, tmp_path):
    db_path = tmp_path / "floom.db"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_USER_ID", "bootstrap-user")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))

    for name in list(sys.modules):
        if name == "db" or name.startswith("db.") or name == "main" or name.startswith("routers"):
            sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO workspace_members "
            "(workspace_id,user_id,role,status,created_at,updated_at) "
            "VALUES (?,?,'owner','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
            (_WORKSPACE_ID, _RESOLVED_USER_ID),
        )

    _insert_worker_and_run(
        db_path,
        worker_id="owner-worker",
        owner_id=_RESOLVED_USER_ID,
        status="completed",
        duration_ms=120,
    )

    from auth import AuthContext
    from fastapi.testclient import TestClient

    auth = AuthContext(
        user_id=_RAW_USER_ID,
        username=_RESOLVED_USER_ID,
        role="admin",
        auth_method="session",
    )
    main.app.dependency_overrides[main.get_auth_context] = lambda: auth
    client = TestClient(main.app, headers={"x-floom-secret": _SECRET})
    yield {"client": client, "db_path": db_path, "main": main}
    main.app.dependency_overrides.clear()
    db.get_repositories.cache_clear()


def test_stats_use_resolved_local_owner_identity(stats_env):
    response = stats_env["client"].get("/stats")
    assert response.status_code == 200, response.text
    stats = response.json()

    # The OSS runtime also exposes its shipped stock workers. They have no runs;
    # the seeded owner worker is the one proving the identity mapping.
    assert stats["total_workers"] >= 1
    assert stats["active_workers"] == 1
    assert stats["total_runs_7d"] == 1
    assert stats["success_rate_7d"] == 1.0
    assert stats["avg_duration_ms"] == 120


def test_admin_stats_cover_same_population_as_total_workers(stats_env):
    _insert_worker_and_run(
        stats_env["db_path"],
        worker_id="other-owner-worker",
        owner_id="other-owner",
        status="failed",
        duration_ms=280,
    )

    response = stats_env["client"].get("/stats")
    assert response.status_code == 200, response.text
    stats = response.json()

    # Includes both seeded DB workers plus any shipped OSS stock workers.
    assert stats["total_workers"] >= 2
    assert stats["active_workers"] == 2
    assert stats["total_runs_7d"] == 2
    assert stats["success_rate_7d"] == 0.5
    assert stats["avg_duration_ms"] == 200
    assert stats["most_active_worker_id"] in {"owner-worker", "other-owner-worker"}
    assert sum(stats["failures_by_category"].values()) == 1
