import sqlite3
import os
from datetime import datetime, timezone

DB_PATH = os.environ.get("FLOOM_DB", "../../data/floom.db")


def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH) if os.path.dirname(DB_PATH) else ".", exist_ok=True)
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS workers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            config_json TEXT NOT NULL,
            status TEXT DEFAULT 'healthy',
            trigger_type TEXT,
            runner TEXT,
            created_at TEXT,
            updated_at TEXT
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            worker_id TEXT NOT NULL,
            status TEXT NOT NULL,
            trigger_source TEXT NOT NULL,
            runner TEXT NOT NULL,
            input_json TEXT,
            output_json TEXT,
            approval_status TEXT DEFAULT 'not_required',
            error TEXT,
            started_at TEXT,
            completed_at TEXT,
            created_at TEXT,
            FOREIGN KEY(worker_id) REFERENCES workers(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            level TEXT DEFAULT 'info',
            message TEXT NOT NULL,
            timestamp TEXT,
            FOREIGN KEY(run_id) REFERENCES runs(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT,
            path TEXT NOT NULL,
            size_bytes INTEGER,
            created_at TEXT,
            FOREIGN KEY(run_id) REFERENCES runs(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            worker_id TEXT NOT NULL,
            status TEXT NOT NULL,
            label TEXT,
            preview TEXT,
            created_at TEXT,
            decided_at TEXT,
            FOREIGN KEY(run_id) REFERENCES runs(id),
            FOREIGN KEY(worker_id) REFERENCES workers(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS secrets (
            name TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            last_used_at TEXT,
            created_at TEXT,
            updated_at TEXT
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS schedules (
            id TEXT PRIMARY KEY,
            worker_id TEXT NOT NULL,
            cron TEXT NOT NULL,
            enabled INTEGER DEFAULT 1,
            next_run_at TEXT,
            last_run_at TEXT,
            created_at TEXT,
            updated_at TEXT,
            FOREIGN KEY(worker_id) REFERENCES workers(id)
        )
        """
    )

    conn.commit()
    conn.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat()
