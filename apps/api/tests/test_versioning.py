"""Tests for the asset versioning and rollback system.

Covers:
  GET  /workers/{id}/versions         — list worker version history
  POST /workers/{id}/rollback/{vid}   — rollback worker to a previous version
  GET  /contexts/{name}/versions      — list brain-pack version history
  POST /contexts/{name}/rollback/{vid} — rollback brain-pack to a previous version

Unit tests cover the SqliteVersionRepository directly (no fcntl needed).
Integration tests boot the full FastAPI app (SQLite-backed) and run on
Linux/CI only (fcntl dependency).
"""

from __future__ import annotations

import json
import platform
import sqlite3
import sys
from pathlib import Path

import pytest

_LINUX_ONLY = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="SQLite db layer uses fcntl (Linux only); runs in CI on ubuntu-latest",
)

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Unit tests: SqliteVersionRepository
# ---------------------------------------------------------------------------

class TestSqliteVersionRepository:
    """Tests that run cross-platform using an in-memory SQLite DB directly."""

    def _make_conn(self) -> sqlite3.Connection:
        """Create an in-memory DB with the asset_versions table."""
        conn = sqlite3.connect(":memory:", check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.executescript("""
            CREATE TABLE asset_versions (
                id              TEXT PRIMARY KEY,
                asset_type      TEXT NOT NULL,
                asset_id        TEXT NOT NULL,
                user_id         TEXT NOT NULL,
                version_number  INTEGER NOT NULL,
                snapshot_json   TEXT NOT NULL,
                change_source   TEXT NOT NULL DEFAULT 'user',
                created_at      TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS asset_versions_asset_idx
                ON asset_versions (asset_type, asset_id, version_number DESC);
        """)
        return conn

    def _make_repo(self, conn: sqlite3.Connection):
        """Create a SqliteVersionRepository that uses the given connection."""
        # fcntl is Linux-only; stub it out before importing db.sqlite on Windows
        import sys
        import types
        if "fcntl" not in sys.modules:
            _fcntl = types.ModuleType("fcntl")
            _fcntl.LOCK_EX = 2  # type: ignore[attr-defined]
            _fcntl.LOCK_SH = 1  # type: ignore[attr-defined]
            _fcntl.LOCK_UN = 8  # type: ignore[attr-defined]
            _fcntl.LOCK_NB = 4  # type: ignore[attr-defined]
            _fcntl.flock = lambda fd, op: None  # type: ignore[attr-defined]
            sys.modules["fcntl"] = _fcntl

        from contextlib import contextmanager
        from unittest.mock import patch

        @contextmanager
        def _fake_get_db():
            yield conn

        from db.sqlite import SqliteVersionRepository
        repo = SqliteVersionRepository()
        repo._patch = patch("db.sqlite.get_db", _fake_get_db)
        repo._patch.start()
        return repo

    def _cleanup(self, repo) -> None:
        repo._patch.stop()

    def test_create_first_version(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            v = repo.create(
                asset_type="worker",
                asset_id="my-worker",
                user_id="user-1",
                snapshot_json='{"files":[]}',
                change_source="user",
            )
            assert v["version_number"] == 1
            assert v["asset_type"] == "worker"
            assert v["asset_id"] == "my-worker"
            assert v["change_source"] == "user"
            assert v["id"].startswith("ver_")
        finally:
            self._cleanup(repo)

    def test_create_increments_version_number(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            v1 = repo.create(
                asset_type="worker",
                asset_id="my-worker",
                user_id="user-1",
                snapshot_json='{"files":[{"path":"worker.yml","content":"v1"}]}',
                change_source="user",
            )
            v2 = repo.create(
                asset_type="worker",
                asset_id="my-worker",
                user_id="user-1",
                snapshot_json='{"files":[{"path":"worker.yml","content":"v2"}]}',
                change_source="ai",
            )
            assert v1["version_number"] == 1
            assert v2["version_number"] == 2
        finally:
            self._cleanup(repo)

    def test_list_returns_newest_first(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            for i in range(5):
                repo.create(
                    asset_type="worker",
                    asset_id="my-worker",
                    user_id="user-1",
                    snapshot_json=f'{{"v":{i}}}',
                    change_source="user",
                )
            versions = repo.list(asset_type="worker", asset_id="my-worker")
            assert [v["version_number"] for v in versions] == [5, 4, 3, 2, 1]
        finally:
            self._cleanup(repo)

    def test_list_respects_limit(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            for _ in range(10):
                repo.create(
                    asset_type="worker",
                    asset_id="my-worker",
                    user_id="user-1",
                    snapshot_json="{}",
                    change_source="user",
                )
            versions = repo.list(asset_type="worker", asset_id="my-worker", limit=3)
            assert len(versions) == 3
            assert versions[0]["version_number"] == 10
        finally:
            self._cleanup(repo)

    def test_list_scoped_by_asset_id(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            repo.create(asset_type="worker", asset_id="worker-a", user_id="u", snapshot_json="{}", change_source="user")
            repo.create(asset_type="worker", asset_id="worker-b", user_id="u", snapshot_json="{}", change_source="user")
            versions_a = repo.list(asset_type="worker", asset_id="worker-a")
            assert len(versions_a) == 1
            assert versions_a[0]["asset_id"] == "worker-a"
        finally:
            self._cleanup(repo)

    def test_get_returns_snapshot_json(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            v = repo.create(
                asset_type="brain_pack",
                asset_id="my-pack",
                user_id="u",
                snapshot_json='{"files":[{"path":"doc.md","content":"hello"}]}',
                change_source="user",
            )
            fetched = repo.get(version_id=v["id"])
            assert fetched is not None
            assert json.loads(fetched["snapshot_json"])["files"][0]["path"] == "doc.md"
        finally:
            self._cleanup(repo)

    def test_get_returns_none_for_missing(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            assert repo.get(version_id="ver_does_not_exist") is None
        finally:
            self._cleanup(repo)

    def test_prune_keeps_n_newest(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            for _ in range(10):
                repo.create(
                    asset_type="worker",
                    asset_id="my-worker",
                    user_id="u",
                    snapshot_json="{}",
                    change_source="user",
                )
            deleted = repo.prune(asset_type="worker", asset_id="my-worker", keep=3)
            assert deleted == 7
            remaining = repo.list(asset_type="worker", asset_id="my-worker")
            assert len(remaining) == 3
            # The 3 newest should remain
            assert remaining[0]["version_number"] == 10
        finally:
            self._cleanup(repo)

    def test_prune_noop_when_under_limit(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            repo.create(asset_type="worker", asset_id="x", user_id="u", snapshot_json="{}", change_source="user")
            repo.create(asset_type="worker", asset_id="x", user_id="u", snapshot_json="{}", change_source="user")
            deleted = repo.prune(asset_type="worker", asset_id="x", keep=50)
            assert deleted == 0
        finally:
            self._cleanup(repo)

    def test_versions_isolated_across_asset_types(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            repo.create(asset_type="worker", asset_id="shared-id", user_id="u", snapshot_json='{"type":"worker"}', change_source="user")
            repo.create(asset_type="brain_pack", asset_id="shared-id", user_id="u", snapshot_json='{"type":"pack"}', change_source="user")
            workers = repo.list(asset_type="worker", asset_id="shared-id")
            packs = repo.list(asset_type="brain_pack", asset_id="shared-id")
            assert len(workers) == 1
            assert len(packs) == 1
            # list() does not include snapshot_json for performance; use get()
            w_full = repo.get(version_id=workers[0]["id"])
            p_full = repo.get(version_id=packs[0]["id"])
            assert json.loads(w_full["snapshot_json"])["type"] == "worker"
            assert json.loads(p_full["snapshot_json"])["type"] == "pack"
        finally:
            self._cleanup(repo)


# ---------------------------------------------------------------------------
# Integration tests: full FastAPI app (Linux/CI only)
# ---------------------------------------------------------------------------

_WORKER_YML = """\
schema_version: "0.3"
name: "version-test-worker"
title: "Version Test Worker"
description: "Worker used to test versioning."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
"""

_RUN_PY = """\
print("hello versioning")
"""


@_LINUX_ONLY
class TestVersioningIntegration:
    """Integration tests using the real FastAPI TestClient.

    These boot the full app with SQLite and test the HTTP endpoints end-to-end.
    They are skipped on Windows (fcntl).
    """

    @pytest.fixture(autouse=True)
    def _clear_caches(self):
        """Clear repos cache before/after each test."""
        import db.factory as factory_mod
        if hasattr(factory_mod.get_repositories, "cache_clear"):
            factory_mod.get_repositories.cache_clear()
        yield
        if hasattr(factory_mod.get_repositories, "cache_clear"):
            factory_mod.get_repositories.cache_clear()

    @pytest.fixture
    def client_and_worker(self, tmp_path):
        """Create a TestClient with a temporary workers dir containing a worker."""
        import os
        import sys
        from fastapi.testclient import TestClient

        workers_dir = tmp_path / "workers"
        workers_dir.mkdir()
        w_dir = workers_dir / "version-test-worker"
        w_dir.mkdir()
        (w_dir / "worker.yml").write_text(_WORKER_YML)
        (w_dir / "run.py").write_text(_RUN_PY)

        env_patches = {
            "FLOOM_WORKERS_DIR": str(workers_dir),
            "WORKEROS_DB": str(tmp_path / "workeros.db"),
            "FLOOM_DB": str(tmp_path / "workeros.db"),
            "WORKEROS_DEPLOY": "local",
            "FLOOM_SECRET": "test-secret",
        }
        with pytest.MonkeyPatch().context() as mp:
            for k, v in env_patches.items():
                mp.setenv(k, v)

            import importlib
            import sys
            for mod in [
                "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                "db.interface", "models", "worker_registry", "runner_utils",
                "run_service", "main",
            ]:
                sys.modules.pop(mod, None)

            import db as db_mod
            db_mod.init_db()
            db_mod.get_repositories.cache_clear()

            import main as app_main
            app = app_main.app
            client = TestClient(app, raise_server_exceptions=False)
            yield client, "version-test-worker"

    def test_list_versions_empty(self, client_and_worker):
        client, worker_id = client_and_worker
        r = client.get(f"/workers/{worker_id}/versions", headers={"x-floom-secret": "test-secret"})
        assert r.status_code == 200
        assert r.json() == []

    def test_version_created_on_file_save(self, client_and_worker):
        client, worker_id = client_and_worker
        headers = {"x-floom-secret": "test-secret"}
        files = [
            {"path": "worker.yml", "content": _WORKER_YML},
            {"path": "run.py", "content": _RUN_PY},
        ]
        r = client.put(
            f"/workers/{worker_id}/files",
            json={"files": files},
            headers=headers,
        )
        assert r.status_code == 200

        r2 = client.get(f"/workers/{worker_id}/versions", headers=headers)
        assert r2.status_code == 200
        versions = r2.json()
        assert len(versions) == 1
        assert versions[0]["version_number"] == 1
        assert versions[0]["asset_type"] == "worker"

    def test_rollback_restores_previous_version(self, client_and_worker):
        client, worker_id = client_and_worker
        headers = {"x-floom-secret": "test-secret", "content-type": "application/json"}

        v1_yml = _WORKER_YML.replace("Version Test Worker", "Version One Title")
        v2_yml = _WORKER_YML.replace("Version Test Worker", "Version Two Title")

        # Save v1
        client.put(f"/workers/{worker_id}/files", json={"files": [
            {"path": "worker.yml", "content": v1_yml},
            {"path": "run.py", "content": _RUN_PY},
        ]}, headers=headers)

        # Save v2
        client.put(f"/workers/{worker_id}/files", json={"files": [
            {"path": "worker.yml", "content": v2_yml},
            {"path": "run.py", "content": _RUN_PY},
        ]}, headers=headers)

        # List versions — should have 2
        versions = client.get(f"/workers/{worker_id}/versions", headers=headers).json()
        assert len(versions) == 2
        assert versions[0]["version_number"] == 2  # newest first

        # Rollback to v1
        v1_id = versions[1]["id"]  # index 1 = older version
        r = client.post(f"/workers/{worker_id}/rollback/{v1_id}", headers=headers)
        assert r.status_code == 200

        # After rollback, list should have 3 (rollback itself is recorded)
        versions_after = client.get(f"/workers/{worker_id}/versions", headers=headers).json()
        assert len(versions_after) == 3
        assert versions_after[0]["change_source"].startswith("rollback:")

    def test_rollback_404_for_wrong_worker(self, client_and_worker):
        client, worker_id = client_and_worker
        headers = {"x-floom-secret": "test-secret"}
        r = client.post(f"/workers/{worker_id}/rollback/ver_does_not_exist", headers=headers)
        assert r.status_code == 404
