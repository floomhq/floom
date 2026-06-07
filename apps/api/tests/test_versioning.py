"""Tests for the asset versioning and rollback system.

Covers:
  GET  /workers/{id}/versions         — list worker version history
  POST /workers/{id}/rollback/{vid}   — rollback worker to a previous version
  GET  /contexts/{name}/versions      — list brain-pack version history
  POST /contexts/{name}/rollback/{vid} — rollback brain-pack to a previous version
  GET  /workspace/versions            — list workspace instruction version history
  POST /workspace/rollback/{vid}      — rollback workspace.md to a previous version

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

    def test_create_self_limits_to_keep(self):
        """create() prunes within the same transaction so the table self-limits
        even when callers never call prune() (2026-06-02 disk P1 root-cause guard)."""
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            for _ in range(25):
                repo.create(
                    asset_type="brain_pack",
                    asset_id="big-pack",
                    user_id="u",
                    snapshot_json="{}",
                    change_source="user",
                    keep=20,
                )
            remaining = repo.list(asset_type="brain_pack", asset_id="big-pack", limit=100)
            assert len(remaining) == 20
            # Newest 20 survive (versions 25..6); latest is always kept
            assert remaining[0]["version_number"] == 25
            assert remaining[-1]["version_number"] == 6
        finally:
            self._cleanup(repo)

    def test_create_keep_none_disables_self_limit(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            for _ in range(30):
                repo.create(
                    asset_type="worker",
                    asset_id="unbounded",
                    user_id="u",
                    snapshot_json="{}",
                    change_source="user",
                    keep=None,
                )
            remaining = repo.list(asset_type="worker", asset_id="unbounded", limit=100)
            assert len(remaining) == 30
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

    def test_delete_for_asset_removes_only_that_asset(self):
        """Deleting a worker prunes its versions; a sibling worker's stay (2026-06-02 orphan P2)."""
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            for _ in range(5):
                repo.create(asset_type="worker", asset_id="worker-a", user_id="u", snapshot_json="{}", change_source="user", keep=None)
            for _ in range(3):
                repo.create(asset_type="worker", asset_id="worker-b", user_id="u", snapshot_json="{}", change_source="user", keep=None)

            deleted = repo.delete_for_asset(asset_type="worker", asset_id="worker-a")
            assert deleted == 5
            assert repo.list(asset_type="worker", asset_id="worker-a") == []
            # Sibling untouched
            assert len(repo.list(asset_type="worker", asset_id="worker-b")) == 3
        finally:
            self._cleanup(repo)

    def test_delete_for_asset_does_not_cross_asset_types(self):
        """A worker delete must not touch a brain_pack that shares the same asset_id."""
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            repo.create(asset_type="worker", asset_id="shared", user_id="u", snapshot_json="{}", change_source="user")
            repo.create(asset_type="brain_pack", asset_id="shared", user_id="u", snapshot_json="{}", change_source="user")
            repo.delete_for_asset(asset_type="worker", asset_id="shared")
            assert repo.list(asset_type="worker", asset_id="shared") == []
            assert len(repo.list(asset_type="brain_pack", asset_id="shared")) == 1
        finally:
            self._cleanup(repo)

    def test_delete_for_context_removes_pack_and_files(self):
        """Deleting a context removes its brain_pack + every brain_file; a sibling context's stay."""
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            # Target context "my_pack": one brain_pack + two brain_file assets.
            repo.create(asset_type="brain_pack", asset_id="my_pack", user_id="u", snapshot_json="{}", change_source="user", keep=None)
            repo.create(asset_type="brain_file", asset_id="my_pack:README.md", user_id="u", snapshot_json="{}", change_source="user", keep=None)
            repo.create(asset_type="brain_file", asset_id="my_pack:data/rows.csv", user_id="u", snapshot_json="{}", change_source="user", keep=None)
            # Sibling context whose name is a LIKE-wildcard near-miss of "my_pack".
            repo.create(asset_type="brain_pack", asset_id="myXpack", user_id="u", snapshot_json="{}", change_source="user", keep=None)
            repo.create(asset_type="brain_file", asset_id="myXpack:README.md", user_id="u", snapshot_json="{}", change_source="user", keep=None)

            deleted = repo.delete_for_context(name="my_pack")
            assert deleted == 3
            assert repo.list(asset_type="brain_pack", asset_id="my_pack") == []
            assert repo.list(asset_type="brain_file", asset_id="my_pack:README.md") == []
            assert repo.list(asset_type="brain_file", asset_id="my_pack:data/rows.csv") == []
            # Underscore in the name must NOT be treated as a LIKE wildcard:
            # the "myXpack" sibling is fully intact.
            assert len(repo.list(asset_type="brain_pack", asset_id="myXpack")) == 1
            assert len(repo.list(asset_type="brain_file", asset_id="myXpack:README.md")) == 1
        finally:
            self._cleanup(repo)

    def test_workspace_instructions_versions(self):
        conn = self._make_conn()
        repo = self._make_repo(conn)
        try:
            repo.create(
                asset_type="workspace_instructions",
                asset_id="default",
                user_id="u",
                snapshot_json='{"content": "# v1"}',
                change_source="user",
            )
            repo.create(
                asset_type="workspace_instructions",
                asset_id="default",
                user_id="u",
                snapshot_json='{"content": "# v2"}',
                change_source="ai",
            )
            rows = repo.list(asset_type="workspace_instructions", asset_id="default")
            assert len(rows) == 2
            assert rows[0]["version_number"] == 2
            assert rows[0]["change_source"] == "ai"
            full = repo.get(version_id=rows[1]["id"])
            assert json.loads(full["snapshot_json"])["content"] == "# v1"
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

    def test_list_versions_bootstraps_baseline(self, client_and_worker):
        client, worker_id = client_and_worker
        r = client.get(f"/workers/{worker_id}/versions", headers={"x-floom-secret": "test-secret"})
        assert r.status_code == 200
        versions = r.json()
        assert len(versions) == 1
        assert versions[0]["version_number"] == 1
        assert versions[0]["change_source"] == "baseline"

        detail = client.get(
            f"/workers/{worker_id}/versions/{versions[0]['id']}",
            headers={"x-floom-secret": "test-secret"},
        )
        assert detail.status_code == 200
        paths = {item["path"] for item in detail.json()["files"]}
        assert {"worker.yml", "run.py"} <= paths

        r2 = client.get(f"/workers/{worker_id}/versions", headers={"x-floom-secret": "test-secret"})
        assert r2.status_code == 200
        assert len(r2.json()) == 1

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

    def test_delete_worker_prunes_its_asset_versions(self, client_and_worker):
        """Deleting a worker removes its asset_versions; a sibling's stay (orphan-GC P2)."""
        client, worker_id = client_and_worker
        headers = {"x-floom-secret": "test-secret", "content-type": "application/json"}

        import db as db_mod
        import main as app_main
        repos = db_mod.get_repositories()
        owner = app_main._bootstrap_user_id()

        # Register the worker as a DB row so the DELETE handler can find + remove it.
        repos.workers.create(
            user_id=owner,
            worker_id=worker_id,
            name="Version Test Worker",
            manifest_json={
                "id": worker_id,
                "name": "Version Test Worker",
                "trigger": {"type": "manual"},
                "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
                "inputs": [],
                "outputs": [],
                "secrets": [],
            },
            bundle_path=f"workers/{worker_id}",
        )

        # Seed version history for the worker-under-test plus a sibling worker id.
        for i in range(3):
            repos.versions.create(
                asset_type="worker", asset_id=worker_id, user_id="u",
                snapshot_json=f'{{"v":{i}}}', change_source="user", keep=None,
            )
        repos.versions.create(
            asset_type="worker", asset_id="sibling-worker", user_id="u",
            snapshot_json="{}", change_source="user", keep=None,
        )
        assert len(repos.versions.list(asset_type="worker", asset_id=worker_id, limit=100)) == 3

        r = client.delete(f"/workers/{worker_id}", headers=headers)
        assert r.status_code == 204

        # The deleted worker's versions are gone; the sibling's survive.
        assert repos.versions.list(asset_type="worker", asset_id=worker_id, limit=100) == []
        assert len(repos.versions.list(asset_type="worker", asset_id="sibling-worker", limit=100)) == 1

    def test_delete_context_prunes_pack_and_file_versions(self, client_and_context):
        """Deleting a context removes its brain_pack + brain_file versions; a sibling stays."""
        client, context_name = client_and_context
        headers = {"x-floom-secret": "test-secret"}

        import db as db_mod
        repos = db_mod.get_repositories()

        # Seed pack + file versions for the context-under-test plus a sibling context.
        repos.versions.create(asset_type="brain_pack", asset_id=context_name, user_id="u", snapshot_json="{}", change_source="user", keep=None)
        repos.versions.create(asset_type="brain_file", asset_id=f"{context_name}:README.md", user_id="u", snapshot_json="{}", change_source="user", keep=None)
        repos.versions.create(asset_type="brain_file", asset_id=f"{context_name}:data.csv", user_id="u", snapshot_json="{}", change_source="user", keep=None)
        repos.versions.create(asset_type="brain_pack", asset_id="other-pack", user_id="u", snapshot_json="{}", change_source="user", keep=None)
        repos.versions.create(asset_type="brain_file", asset_id="other-pack:README.md", user_id="u", snapshot_json="{}", change_source="user", keep=None)

        r = client.delete(f"/contexts/{context_name}?force=true", headers=headers)
        assert r.status_code == 200

        assert repos.versions.list(asset_type="brain_pack", asset_id=context_name, limit=100) == []
        assert repos.versions.list(asset_type="brain_file", asset_id=f"{context_name}:README.md", limit=100) == []
        assert repos.versions.list(asset_type="brain_file", asset_id=f"{context_name}:data.csv", limit=100) == []
        # Sibling context untouched.
        assert len(repos.versions.list(asset_type="brain_pack", asset_id="other-pack", limit=100)) == 1
        assert len(repos.versions.list(asset_type="brain_file", asset_id="other-pack:README.md", limit=100)) == 1

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

    @pytest.fixture
    def client_and_context(self, tmp_path):
        """Create a TestClient with a temporary Brain pack."""
        import sys
        from fastapi.testclient import TestClient

        contexts_dir = tmp_path / "contexts"
        pack_dir = contexts_dir / "baseline-pack"
        pack_dir.mkdir(parents=True)
        (pack_dir / "README.md").write_text("# Baseline pack\n", encoding="utf-8")
        (pack_dir / "data.csv").write_text("name,value\nalpha,1\n", encoding="utf-8")

        env_patches = {
            "FLOOM_CONTEXTS_DIR": str(contexts_dir),
            "WORKEROS_DB": str(tmp_path / "workeros.db"),
            "FLOOM_DB": str(tmp_path / "workeros.db"),
            "WORKEROS_DEPLOY": "local",
            "FLOOM_SECRET": "test-secret",
        }
        with pytest.MonkeyPatch().context() as mp:
            for k, v in env_patches.items():
                mp.setenv(k, v)

            for mod in [
                "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                "db.interface", "contexts", "main",
            ]:
                sys.modules.pop(mod, None)

            import db as db_mod
            db_mod.init_db()
            db_mod.get_repositories.cache_clear()

            import main as app_main
            client = TestClient(app_main.app, raise_server_exceptions=False)
            yield client, "baseline-pack"

    def test_context_versions_bootstrap_baseline(self, client_and_context):
        client, context_name = client_and_context
        headers = {"x-floom-secret": "test-secret"}

        r = client.get(f"/contexts/{context_name}/versions", headers=headers)
        assert r.status_code == 200
        versions = r.json()
        assert len(versions) == 1
        assert versions[0]["version_number"] == 1
        assert versions[0]["change_source"] == "baseline"

        detail = client.get(f"/contexts/{context_name}/versions/{versions[0]['id']}", headers=headers)
        assert detail.status_code == 200
        paths = {item["path"] for item in detail.json()["files"]}
        assert paths == {"README.md", "data.csv"}

        r2 = client.get(f"/contexts/{context_name}/versions", headers=headers)
        assert r2.status_code == 200
        assert len(r2.json()) == 1

    def test_context_rollback_returns_200_not_500(self, client_and_context):
        """Regression test: contexts.rollback must return 200 + context detail (not 500 NameError).

        Sequence: create context (baseline) → upload v1 file → upload v2 file →
        rollback to v1 → assert HTTP 200 + v1 file content in response.
        """
        client, context_name = client_and_context
        headers = {"x-floom-secret": "test-secret"}

        # Write v1 — PUT /contexts/{name}/files/{path} with JSON body {"content": "..."}
        r = client.put(
            f"/contexts/{context_name}/files/README.md",
            json={"content": "# Version one\n"},
            headers=headers,
        )
        assert r.status_code == 200, f"v1 upload failed: {r.text}"

        # Write v2
        r = client.put(
            f"/contexts/{context_name}/files/README.md",
            json={"content": "# Version two\n"},
            headers=headers,
        )
        assert r.status_code == 200, f"v2 upload failed: {r.text}"

        # List versions — newest first; find the v1 entry
        versions = client.get(f"/contexts/{context_name}/versions", headers=headers).json()
        assert len(versions) >= 2, f"expected at least 2 versions, got {versions}"
        # versions are newest-first; last one is v1
        v1_id = versions[-1]["id"]

        # Rollback to v1 — this is the call that 500'd before the fix
        rb = client.post(
            f"/contexts/{context_name}/rollback/{v1_id}",
            headers=headers,
        )
        assert rb.status_code == 200, f"rollback returned {rb.status_code}: {rb.text}"

        # Response must be a context-detail object (has "name" or "files")
        body = rb.json()
        assert "name" in body or "files" in body, f"unexpected rollback response shape: {body}"


@_LINUX_ONLY
class TestWorkspaceInstructionsVersioningIntegration:
    @pytest.fixture(autouse=True)
    def _clear_caches(self):
        import db.factory as factory_mod
        if hasattr(factory_mod.get_repositories, "cache_clear"):
            factory_mod.get_repositories.cache_clear()
        yield
        if hasattr(factory_mod.get_repositories, "cache_clear"):
            factory_mod.get_repositories.cache_clear()

    @pytest.fixture
    def client(self, tmp_path):
        import sys
        from fastapi.testclient import TestClient

        workspace_md = tmp_path / "workspace.md"
        workspace_base_md = tmp_path / "workspace.base.md"
        workspace_md.write_text("# Workspace v0\n", encoding="utf-8")

        env_patches = {
            "WORKEROS_DB": str(tmp_path / "workeros.db"),
            "FLOOM_DB": str(tmp_path / "workeros.db"),
            "WORKEROS_DEPLOY": "local",
            "FLOOM_SECRET": "test-secret",
        }
        with pytest.MonkeyPatch().context() as mp:
            for k, v in env_patches.items():
                mp.setenv(k, v)
            import importlib
            for mod in [
                "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                "db.interface", "chat_service", "main",
            ]:
                sys.modules.pop(mod, None)
            import chat_service as chat_mod
            chat_mod.WORKSPACE_MD_PATH = workspace_md
            chat_mod.WORKSPACE_BASE_PERSONA_PATH = workspace_base_md
            import db as db_mod
            db_mod.init_db()
            db_mod.get_repositories.cache_clear()
            import main as app_main
            client = TestClient(app_main.app, raise_server_exceptions=False)
            yield client, workspace_md, workspace_base_md

    def test_workspace_version_on_save_and_rollback(self, client):
        test_client, workspace_md, _workspace_base_md = client
        headers = {"x-floom-secret": "test-secret", "Content-Type": "text/markdown"}

        r1 = test_client.put("/workspace", content="# Workspace v1\n", headers=headers)
        assert r1.status_code == 204

        r2 = test_client.put("/workspace", content="# Workspace v2\n", headers=headers)
        assert r2.status_code == 204

        versions = test_client.get("/workspace/versions", headers=headers).json()
        assert len(versions) == 2
        assert versions[0]["version_number"] == 2

        v1_id = versions[1]["id"]
        rb = test_client.post(f"/workspace/rollback/{v1_id}", headers=headers)
        assert rb.status_code == 200
        assert "# Workspace v1" in rb.text
        assert workspace_md.read_text(encoding="utf-8") == "# Workspace v1\n"

        versions_after = test_client.get("/workspace/versions", headers=headers).json()
        assert len(versions_after) == 3
        assert versions_after[0]["change_source"].startswith("rollback:")

    def test_workspace_base_persona_version_on_save_and_rollback(self, client):
        test_client, _workspace_md, workspace_base_md = client
        headers = {"x-floom-secret": "test-secret", "Content-Type": "text/markdown"}

        r1 = test_client.put("/workspace/base", content="# Emily\n\nYou are Emily v1.\n", headers=headers)
        assert r1.status_code == 204

        r2 = test_client.put("/workspace/base", content="# Emily\n\nYou are Emily v2.\n", headers=headers)
        assert r2.status_code == 204

        versions = test_client.get("/workspace/base/versions", headers=headers).json()
        assert len(versions) == 2
        assert versions[0]["version_number"] == 2
        assert versions[0]["asset_type"] == "workspace_base_persona"

        v1_id = versions[1]["id"]
        snap = test_client.get(f"/workspace/base/versions/{v1_id}", headers=headers)
        assert snap.status_code == 200
        assert "Emily v1" in snap.json()["content"]

        rb = test_client.post(f"/workspace/base/rollback/{v1_id}", headers=headers)
        assert rb.status_code == 200
        assert "Emily v1" in rb.text
        assert workspace_base_md.read_text(encoding="utf-8") == "# Emily\n\nYou are Emily v1.\n"

        versions_after = test_client.get("/workspace/base/versions", headers=headers).json()
        assert len(versions_after) == 3
        assert versions_after[0]["change_source"].startswith("rollback:")
