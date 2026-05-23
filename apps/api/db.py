"""Floom database layer with migrations, indexes, and context managers."""

import sqlite3
import os
import logging
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Generator

DB_PATH = os.environ.get("FLOOM_DB", "../../data/floom.db")
logger = logging.getLogger("floom.db")

# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------

@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """Yield a SQLite connection. Automatically commits on success,
    rolls back on exception, and closes on exit."""
    os.makedirs(os.path.dirname(DB_PATH) if os.path.dirname(DB_PATH) else ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------

MIGRATIONS = [
    # -- migration 1: base schema ------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        config_json TEXT NOT NULL,
        status TEXT DEFAULT 'healthy' NOT NULL,
        trigger_type TEXT,
        runner TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
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

    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        level TEXT DEFAULT 'info' NOT NULL,
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        trace_id TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT,
        path TEXT NOT NULL,
        size_bytes INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        status TEXT NOT NULL,
        label TEXT,
        preview TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
        FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS schedules (
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
    """,
    # -- migration 2: indexes ----------------------------------------------------
    """
    CREATE INDEX IF NOT EXISTS idx_runs_worker_id ON runs(worker_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_worker_status ON runs(worker_id, status);
    CREATE INDEX IF NOT EXISTS idx_logs_run_id ON logs(run_id);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_run_id ON approvals(run_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_worker_id ON approvals(worker_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_schedules_worker_id ON schedules(worker_id);
    """,
    # -- migration 3: add duration_ms to runs (schema evolution) -----------------
    """
    ALTER TABLE runs ADD COLUMN duration_ms INTEGER;
    """,
    # -- migration 4: add trace_id to logs (schema evolution) --------------------
    """
    ALTER TABLE logs ADD COLUMN trace_id TEXT;
    """,
    # -- migration 5: worker_state table for pause/unpause ----------------------
    """
    CREATE TABLE IF NOT EXISTS worker_state (
        worker_id TEXT PRIMARY KEY,
        paused INTEGER DEFAULT 0 NOT NULL,
        updated_at TEXT NOT NULL
    );
    """,
]


def get_current_version(conn: sqlite3.Connection) -> int:
    cursor = conn.cursor()
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    )
    if not cursor.fetchone():
        return 0
    cursor.execute("SELECT MAX(version) FROM schema_version")
    row = cursor.fetchone()
    return row[0] or 0 if row else 0


def apply_migrations():
    with get_db() as conn:
        current = get_current_version(conn)
    for i, sql in enumerate(MIGRATIONS, start=1):
        if i > current:
            with get_db() as conn:
                try:
                    conn.executescript(sql)
                except sqlite3.OperationalError as exc:
                    if i not in {3, 4} or "duplicate column name" not in str(exc):
                        raise
                    logger.info(
                        "Skipping already-applied column migration %s: %s",
                        i,
                        exc,
                    )
                conn.execute(
                    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                    (i, now_iso())
                )
            print(f"[db] Applied migration {i}")


def init_db():
    apply_migrations()
