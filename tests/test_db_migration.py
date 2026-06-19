#!/usr/bin/env python3
"""Migration regression tests for WorkerContract split."""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

import db  # noqa: E402
import db._legacy_sqlite as _legacy_sqlite  # noqa: E402


class WorkerContractMigrationTest(unittest.TestCase):
    def test_legacy_worker_rows_migrate_with_runs_approvals_and_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "legacy.db"
            self._create_legacy_db(db_path)

            # get_db() resolves the path live from WORKEROS_DB/FLOOM_DB on every
            # call (db.DB_PATH alone is overwritten each call), so point the env
            # at the legacy DB for the duration of this test.
            import os
            original_db_path = db.DB_PATH
            original_env = {k: os.environ.get(k) for k in ("WORKEROS_DB", "FLOOM_DB")}
            os.environ.pop("WORKEROS_DB", None)
            os.environ["FLOOM_DB"] = str(db_path)
            db.DB_PATH = str(db_path)
            try:
                db.init_db()
                with db.get_db() as conn:
                    version = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
                    worker = conn.execute("SELECT * FROM workers WHERE id = 'legacy_worker'").fetchone()
                    run_count = conn.execute("SELECT COUNT(*) FROM runs WHERE worker_id = 'legacy_worker'").fetchone()[0]
                    # The approvals table is dropped + recreated by the scope-cut
                    # migration (migration 15, added in #107), so it exists after
                    # init but legacy approval rows intentionally do NOT survive.
                    approvals_table_exists = conn.execute(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='approvals'"
                    ).fetchone()[0]
                    approval_count = conn.execute("SELECT COUNT(*) FROM approvals WHERE worker_id = 'legacy_worker'").fetchone()[0]
                    artifact_count = conn.execute("SELECT COUNT(*) FROM artifacts WHERE run_id = 'run_1'").fetchone()[0]
                    skill_version_count = conn.execute("SELECT COUNT(*) FROM skill_versions").fetchone()[0]
                    foreign_key_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
            finally:
                try:
                    db.get_repositories.cache_clear()
                    _legacy_sqlite._close_cached_db_connection()
                except Exception:
                    pass
                db.DB_PATH = original_db_path
                for key, value in original_env.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value

            # Latest schema version is the migration count, not a hardcoded
            # number that goes stale each time a migration is appended (was 11).
            from db import _legacy_sqlite as _legacy
            self.assertEqual(version, len(_legacy.MIGRATIONS))
            self.assertIsNotNone(worker)
            self.assertEqual(run_count, 1)
            # Worker / run / artifact / skill_version rows survive the full
            # migration chain. The approvals table is present (recreated by the
            # later migration) but legacy approval rows are dropped by design.
            self.assertEqual(approvals_table_exists, 1)
            self.assertEqual(approval_count, 0)
            self.assertEqual(artifact_count, 1)
            self.assertEqual(skill_version_count, 1)
            self.assertEqual(foreign_key_errors, [])

    def _create_legacy_db(self, db_path: Path) -> None:
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            PRAGMA foreign_keys = ON;
            CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
            INSERT INTO schema_version (version, applied_at)
            VALUES (1, 'now'), (2, 'now'), (3, 'now'), (4, 'now'), (5, 'now'),
                   (6, 'now'), (7, 'now'), (8, 'now'), (9, 'now'), (10, 'now');

            CREATE TABLE workers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                config_json TEXT NOT NULL,
                status TEXT DEFAULT 'healthy' NOT NULL,
                trigger_type TEXT,
                runner TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                next_run_at TEXT,
                last_scheduled_run_at TEXT
            );
            CREATE TABLE runs (
                id TEXT PRIMARY KEY,
                worker_id TEXT NOT NULL,
                status TEXT NOT NULL,
                trigger_source TEXT NOT NULL,
                runner TEXT NOT NULL,
                input_json TEXT,
                output_json TEXT,
                approval_status TEXT DEFAULT 'not_required' NOT NULL,
                error TEXT,
                started_at TEXT,
                completed_at TEXT,
                duration_ms INTEGER,
                created_at TEXT NOT NULL,
                FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
            );
            CREATE TABLE approvals (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                worker_id TEXT NOT NULL,
                status TEXT NOT NULL,
                label TEXT,
                preview TEXT,
                created_at TEXT NOT NULL,
                decided_at TEXT,
                reason TEXT,
                FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
                FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
            );
            CREATE TABLE artifacts (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                name TEXT NOT NULL,
                type TEXT,
                path TEXT NOT NULL,
                size_bytes INTEGER,
                created_at TEXT NOT NULL,
                FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
            );
            -- A faithful version-10 DB also has the tables from migration 1 that
            -- this fixture had omitted (logs, secrets, schedules) plus the tables
            -- created by migrations 5/7/9 (worker_state, composio_connections,
            -- worker_webhook_secrets). The fixture stamps version 10, so those
            -- migrations are skipped on init_db(); later migrations (e.g. 18,
            -- which ALTERs composio_connections AND secrets) require them to
            -- exist. Without these, init_db() failed with "no such table: ...".
            CREATE TABLE logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                level TEXT DEFAULT 'info' NOT NULL,
                message TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                trace_id TEXT,
                FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
            );
            CREATE TABLE secrets (
                name TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                last_used_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT
            );
            CREATE TABLE schedules (
                id TEXT PRIMARY KEY,
                worker_id TEXT NOT NULL,
                cron TEXT NOT NULL,
                enabled INTEGER DEFAULT 1 NOT NULL,
                next_run_at TEXT,
                last_run_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
            );
            CREATE TABLE worker_state (
                worker_id TEXT PRIMARY KEY,
                paused INTEGER DEFAULT 0 NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE composio_connections (
                id TEXT PRIMARY KEY,
                app_name TEXT NOT NULL,
                composio_connection_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'initiated',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX idx_composio_connections_app_name
                ON composio_connections(app_name);
            CREATE INDEX idx_composio_connections_status
                ON composio_connections(status);
            CREATE TABLE worker_webhook_secrets (
                worker_id TEXT PRIMARY KEY,
                secret_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                rotated_at TEXT,
                FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
            );
            CREATE INDEX idx_workers_next_run_at ON workers(next_run_at);
            """
        )
        config = {
            "id": "legacy_worker",
            "name": "Legacy Worker",
            "description": "Legacy test",
            "trigger": {"type": "manual"},
            "runtime": {"type": "python", "entrypoint": "run.py", "runner": "local"},
            "inputs": [{"name": "text", "label": "Text", "type": "text", "required": True}],
            "secrets": [],
            "connections": [],
            "outputs": [{"name": "output", "label": "Output", "type": "text"}],
            "approvals": {"required": True, "label": "Approve"},
        }
        conn.execute(
            """
            INSERT INTO workers
                (id, name, description, config_json, status, trigger_type, runner, created_at)
            VALUES (?, ?, ?, ?, 'healthy', 'manual', 'local', 'now')
            """,
            ("legacy_worker", "Legacy Worker", "Legacy test", json.dumps(config)),
        )
        conn.execute(
            """
            INSERT INTO runs
                (id, worker_id, status, trigger_source, runner, input_json, output_json,
                 approval_status, created_at)
            VALUES ('run_1', 'legacy_worker', 'completed', 'manual', 'local', '{}',
                    '{"output":"ok"}', 'pending', 'now')
            """
        )
        conn.execute(
            """
            INSERT INTO approvals
                (id, run_id, worker_id, status, label, preview, created_at, reason)
            VALUES ('approval_1', 'run_1', 'legacy_worker', 'pending', 'Approve', 'ok', 'now', NULL)
            """
        )
        conn.execute(
            """
            INSERT INTO artifacts
                (id, run_id, name, type, path, size_bytes, created_at)
            VALUES ('art_1', 'run_1', 'out.txt', 'text', '/tmp/out.txt', 2, 'now')
            """
        )
        conn.commit()
        conn.close()


if __name__ == "__main__":
    unittest.main()
