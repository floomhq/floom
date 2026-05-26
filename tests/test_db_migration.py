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


class WorkerContractMigrationTest(unittest.TestCase):
    def test_legacy_worker_rows_migrate_with_runs_approvals_and_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "legacy.db"
            self._create_legacy_db(db_path)

            original_db_path = db.DB_PATH
            db.DB_PATH = str(db_path)
            try:
                db.init_db()
                with db.get_db() as conn:
                    version = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
                    worker = conn.execute("SELECT * FROM workers WHERE id = 'legacy_worker'").fetchone()
                    run_count = conn.execute("SELECT COUNT(*) FROM runs WHERE worker_id = 'legacy_worker'").fetchone()[0]
                    approval_count = conn.execute("SELECT COUNT(*) FROM approvals WHERE worker_id = 'legacy_worker'").fetchone()[0]
                    artifact_count = conn.execute("SELECT COUNT(*) FROM artifacts WHERE run_id = 'run_1'").fetchone()[0]
                    skill_version_count = conn.execute("SELECT COUNT(*) FROM skill_versions").fetchone()[0]
                    foreign_key_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
            finally:
                db.DB_PATH = original_db_path

            self.assertEqual(version, 11)
            self.assertIsNotNone(worker)
            self.assertEqual(run_count, 1)
            self.assertEqual(approval_count, 1)
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
