"""Floom database layer with migrations, indexes, and context managers."""

import json
import sqlite3
import os
import logging
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Callable, Generator


def _configured_db_path() -> str:
    return (
        os.environ.get("WORKEROS_DB")
        or os.environ.get("FLOOM_DB")
        or "../../data/floom.db"
    )


DB_PATH = _configured_db_path()
logger = logging.getLogger("floom.db")
_WAL_LOCK = threading.Lock()
_WAL_INITIALIZED_PATHS: set[str] = set()


def _busy_timeout_ms() -> int:
    try:
        return max(1000, int(os.environ.get("WORKEROS_SQLITE_BUSY_TIMEOUT_MS", "30000")))
    except ValueError:
        return 30000


def _enable_wal_once(conn: sqlite3.Connection, db_path: str) -> None:
    if db_path == ":memory:":
        return
    cache_key = os.path.abspath(db_path)
    if cache_key in _WAL_INITIALIZED_PATHS:
        return
    with _WAL_LOCK:
        if cache_key in _WAL_INITIALIZED_PATHS:
            return
        mode_row = conn.execute("PRAGMA journal_mode=WAL").fetchone()
        mode = str(mode_row[0] if mode_row else "").lower()
        if mode != "wal":
            raise sqlite3.OperationalError(f"failed to enable SQLite WAL mode, journal_mode={mode!r}")
        _WAL_INITIALIZED_PATHS.add(cache_key)


def sqlite_runtime_settings() -> dict[str, Any]:
    with get_db() as conn:
        journal_mode_row = conn.execute("PRAGMA journal_mode").fetchone()
        synchronous_row = conn.execute("PRAGMA synchronous").fetchone()
        foreign_keys_row = conn.execute("PRAGMA foreign_keys").fetchone()
        busy_timeout_row = conn.execute("PRAGMA busy_timeout").fetchone()
    return {
        "journal_mode": journal_mode_row[0] if journal_mode_row else None,
        "synchronous": synchronous_row[0] if synchronous_row else None,
        "foreign_keys": foreign_keys_row[0] if foreign_keys_row else None,
        "busy_timeout": busy_timeout_row[0] if busy_timeout_row else None,
    }

# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------

@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """Yield a SQLite connection. Automatically commits on success,
    rolls back on exception, and closes on exit."""
    global DB_PATH
    DB_PATH = _configured_db_path()
    os.makedirs(os.path.dirname(DB_PATH) if os.path.dirname(DB_PATH) else ".", exist_ok=True)
    conn = sqlite3.connect(
        DB_PATH,
        detect_types=sqlite3.PARSE_DECLTYPES,
        timeout=_busy_timeout_ms() / 1000,
    )
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {_busy_timeout_ms()}")
    _enable_wal_once(conn, DB_PATH)
    conn.execute("PRAGMA synchronous = NORMAL")
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
# WorkerContract migration helpers
# ---------------------------------------------------------------------------

def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    cursor = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        (name,),
    )
    return cursor.fetchone() is not None


def _table_columns(conn: sqlite3.Connection, name: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({name})")}


def _row_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def _normalize_legacy_config(raw: dict[str, Any], worker_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    from models import WorkerConfig, WorkerContract, parse_worker_manifest
    from models import worker_config_to_worker_contract, worker_contract_to_worker_config

    parsed = parse_worker_manifest(raw)
    if isinstance(parsed, WorkerContract):
        contract = parsed
        config = worker_contract_to_worker_config(contract, worker_id)
    else:
        config = parsed if isinstance(parsed, WorkerConfig) else WorkerConfig(**raw)
        contract = worker_config_to_worker_contract(config)
    return contract.model_dump(mode="json", exclude_none=True), config.model_dump(mode="json", exclude_none=True)


def _migrate_worker_contract_split(conn: sqlite3.Connection) -> None:
    """One-shot migration from recipe/instance-conflated workers to WorkerContract split."""
    if not _table_exists(conn, "workers"):
        return
    worker_columns = _table_columns(conn, "workers")
    if "skill_version_id" in worker_columns and _table_exists(conn, "skill_versions"):
        return

    old_foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()[0]
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("PRAGMA legacy_alter_table = ON")
    try:
        if not _table_exists(conn, "workers_legacy"):
            conn.execute("ALTER TABLE workers RENAME TO workers_legacy")

        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS skill_versions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                manifest_json TEXT NOT NULL,
                bundle_path TEXT,
                created_at TEXT NOT NULL,
                UNIQUE(name, version)
            );

            CREATE TABLE IF NOT EXISTS workers (
                id TEXT PRIMARY KEY,
                skill_version_id TEXT NOT NULL,
                name TEXT NOT NULL,
                trigger_type TEXT NOT NULL DEFAULT 'manual',
                cron_expr TEXT,
                cron_timezone TEXT,
                next_run_at TEXT,
                last_scheduled_run_at TEXT,
                webhook_secret_hash TEXT,
                notify_email INTEGER DEFAULT 0 NOT NULL,
                notify_webhook_url TEXT,
                grants_json TEXT,
                input_values_json TEXT,
                enabled INTEGER DEFAULT 1 NOT NULL,
                created_at TEXT NOT NULL,
                owner_id TEXT NOT NULL DEFAULT 'federico',
                FOREIGN KEY(skill_version_id) REFERENCES skill_versions(id)
            );
            """
        )

        legacy_columns = _table_columns(conn, "workers_legacy")
        for row in conn.execute("SELECT * FROM workers_legacy ORDER BY id"):
            legacy = _row_dict(row)
            worker_id = legacy["id"]
            raw_config = json.loads(legacy.get("config_json") or "{}")
            manifest, config = _normalize_legacy_config(raw_config, worker_id)
            skill_version_id = f"sv_{worker_id}_{manifest['version'].replace('.', '_').replace('-', '_')}"
            created_at = legacy.get("created_at") or now_iso()
            conn.execute(
                """
                INSERT OR IGNORE INTO skill_versions
                    (id, name, version, manifest_json, bundle_path, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    skill_version_id,
                    manifest["name"],
                    manifest["version"],
                    json.dumps(manifest),
                    f"workers/{worker_id}",
                    created_at,
                ),
            )
            webhook_secret_hash = None
            if _table_exists(conn, "worker_webhook_secrets"):
                secret_row = conn.execute(
                    "SELECT secret_hash FROM worker_webhook_secrets WHERE worker_id = ?",
                    (worker_id,),
                ).fetchone()
                webhook_secret_hash = secret_row["secret_hash"] if secret_row else None
            conn.execute(
                """
                INSERT INTO workers
                    (id, skill_version_id, name, trigger_type, cron_expr, cron_timezone,
                     next_run_at, last_scheduled_run_at, webhook_secret_hash, notify_email,
                     notify_webhook_url, grants_json, input_values_json, enabled, created_at, owner_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    skill_version_id=excluded.skill_version_id,
                    name=excluded.name,
                    trigger_type=excluded.trigger_type,
                    cron_expr=excluded.cron_expr,
                    cron_timezone=excluded.cron_timezone,
                    next_run_at=excluded.next_run_at,
                    last_scheduled_run_at=excluded.last_scheduled_run_at,
                    webhook_secret_hash=excluded.webhook_secret_hash
                """,
                (
                    worker_id,
                    skill_version_id,
                    config["name"],
                    config.get("trigger", {}).get("type") or legacy.get("trigger_type") or "manual",
                    config.get("trigger", {}).get("cron"),
                    None,
                    legacy.get("next_run_at") if "next_run_at" in legacy_columns else None,
                    legacy.get("last_scheduled_run_at") if "last_scheduled_run_at" in legacy_columns else None,
                    webhook_secret_hash,
                    0,
                    None,
                    json.dumps({}),
                    json.dumps({}),
                    1,
                    created_at,
                    "federico",
                ),
            )

        approvals_source = "approvals"
        approvals_preserved = False
        if _table_exists(conn, "approvals"):
            missing_approval_workers = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM approvals a
                LEFT JOIN workers w ON w.id = a.worker_id
                WHERE w.id IS NULL
                """
            ).fetchone()["count"]
            missing_approval_runs = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM approvals a
                LEFT JOIN runs r ON r.id = a.run_id
                WHERE r.id IS NULL
                """
            ).fetchone()["count"]
            if missing_approval_workers or missing_approval_runs:
                raise RuntimeError(
                    "Cannot migrate approvals: "
                    f"{missing_approval_workers} rows reference missing workers, "
                    f"{missing_approval_runs} rows reference missing runs"
                )
            conn.execute("DROP TABLE IF EXISTS approvals_preserve")
            conn.execute("CREATE TEMP TABLE approvals_preserve AS SELECT * FROM approvals")
            approvals_source = "approvals_preserve"
            approvals_preserved = True

        if _table_exists(conn, "runs"):
            missing_run_workers = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM runs r
                LEFT JOIN workers w ON w.id = r.worker_id
                WHERE w.id IS NULL
                """
            ).fetchone()["count"]
            if missing_run_workers:
                raise RuntimeError(
                    f"Cannot migrate runs: {missing_run_workers} run rows reference missing workers"
                )
            conn.executescript(
                """
                CREATE TABLE runs_new (
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
                INSERT INTO runs_new
                    (id, worker_id, status, trigger_source, runner, input_json,
                     output_json, approval_status, error, started_at, completed_at,
                     duration_ms, created_at)
                SELECT id, worker_id, status, trigger_source, runner, input_json,
                       output_json, approval_status, error, started_at, completed_at,
                       duration_ms, created_at
                FROM runs;
                DROP TABLE runs;
                ALTER TABLE runs_new RENAME TO runs;
                """
            )

        if _table_exists(conn, "approvals"):
            conn.execute(
                """
                CREATE TABLE approvals_new (
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
                )
                """
            )
            conn.execute(
                f"""
                INSERT INTO approvals_new
                    (id, run_id, worker_id, status, label, preview, created_at, decided_at, reason)
                SELECT id, run_id, worker_id, status, label, preview, created_at, decided_at, reason
                FROM {approvals_source}
                """
            )
            conn.execute("DROP TABLE approvals")
            conn.execute("ALTER TABLE approvals_new RENAME TO approvals")
            if approvals_preserved:
                conn.execute("DROP TABLE approvals_preserve")

        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_skill_versions_name_version
                ON skill_versions(name, version);
            CREATE INDEX IF NOT EXISTS idx_workers_skill_version_id
                ON workers(skill_version_id);
            CREATE INDEX IF NOT EXISTS idx_workers_next_run_at
                ON workers(next_run_at);
            CREATE INDEX IF NOT EXISTS idx_runs_worker_id ON runs(worker_id);
            CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
            CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
            CREATE INDEX IF NOT EXISTS idx_runs_worker_status ON runs(worker_id, status);
            CREATE INDEX IF NOT EXISTS idx_approvals_run_id ON approvals(run_id);
            CREATE INDEX IF NOT EXISTS idx_approvals_worker_id ON approvals(worker_id);
            CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
            """
        )

        fk_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
        if fk_errors:
            raise RuntimeError(f"foreign_key_check failed after WorkerContract migration: {fk_errors}")
    finally:
        conn.execute("PRAGMA legacy_alter_table = OFF")
        conn.execute(f"PRAGMA foreign_keys = {int(old_foreign_keys)}")


def _migrate_composio_trigger_columns(conn: sqlite3.Connection) -> None:
    """Add Composio trigger registration columns to worker instances."""
    if not _table_exists(conn, "workers"):
        return
    columns = _table_columns(conn, "workers")
    if "composio_trigger_id" not in columns:
        conn.execute("ALTER TABLE workers ADD COLUMN composio_trigger_id TEXT")
    if "composio_event" not in columns:
        conn.execute("ALTER TABLE workers ADD COLUMN composio_event TEXT")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_workers_composio_trigger_id "
        "ON workers(composio_trigger_id)"
    )


def _migrate_secrets_user_scope(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "secrets"):
        return
    columns = _table_columns(conn, "secrets")
    if "user_id" in columns:
        return

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS secrets_new (
            user_id TEXT NOT NULL DEFAULT 'federico',
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            last_used_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT,
            last_checked_at TEXT,
            last_check_status TEXT,
            last_check_error TEXT,
            PRIMARY KEY (user_id, name)
        );
        """
    )

    rows = conn.execute("SELECT * FROM secrets ORDER BY name").fetchall()
    for row in rows:
        conn.execute(
            """
            INSERT INTO secrets_new
                (user_id, name, status, last_used_at, created_at, updated_at,
                 last_checked_at, last_check_status, last_check_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "federico",
                row["name"],
                row["status"],
                row["last_used_at"],
                row["created_at"],
                row["updated_at"],
                row["last_checked_at"] if "last_checked_at" in columns else None,
                row["last_check_status"] if "last_check_status" in columns else None,
                row["last_check_error"] if "last_check_error" in columns else None,
            ),
        )

    conn.executescript(
        """
        DROP TABLE secrets;
        ALTER TABLE secrets_new RENAME TO secrets;
        CREATE INDEX IF NOT EXISTS idx_secrets_user_id ON secrets(user_id);
        """
    )


def _migrate_cli_auth_devices(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS cli_auth_devices (
            device_code TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            user_code TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            secret TEXT,
            client_name TEXT NOT NULL,
            scopes_json TEXT NOT NULL,
            created_ip TEXT,
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL,
            approved_at REAL
        );
        CREATE INDEX IF NOT EXISTS idx_cli_auth_devices_user_id
            ON cli_auth_devices(user_id);
        CREATE INDEX IF NOT EXISTS idx_cli_auth_devices_user_code
            ON cli_auth_devices(user_code);
        """
    )


def _add_owner_indexes(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_workers_owner_id ON workers(owner_id);
        CREATE INDEX IF NOT EXISTS idx_runs_worker_created_at ON runs(worker_id, created_at);
        """
    )


def _ensure_mcp_connection_columns(conn: sqlite3.Connection) -> None:
    columns = {
        row[1]
        for row in conn.execute("PRAGMA table_info(composio_connections)").fetchall()
    }
    additions = [
        ("kind", "ALTER TABLE composio_connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'composio'"),
        ("mcp_label", "ALTER TABLE composio_connections ADD COLUMN mcp_label TEXT"),
        ("mcp_url", "ALTER TABLE composio_connections ADD COLUMN mcp_url TEXT"),
        ("mcp_auth_secret", "ALTER TABLE composio_connections ADD COLUMN mcp_auth_secret TEXT"),
        ("mcp_allowed_tools_json", "ALTER TABLE composio_connections ADD COLUMN mcp_allowed_tools_json TEXT"),
    ]
    for column, statement in additions:
        if column not in columns:
            conn.execute(statement)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_composio_connections_kind "
        "ON composio_connections(kind)"
    )


def _ensure_runs_artifacts_archived_column(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "runs")
    if "artifacts_archived" not in columns:
        conn.execute("ALTER TABLE runs ADD COLUMN artifacts_archived INTEGER DEFAULT 0 NOT NULL")


# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------

Migration = str | Callable[[sqlite3.Connection], None]


MIGRATIONS: list[Migration] = [
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
    # -- migration 6: add reason column to approvals for reject audit trail -----
    """
    ALTER TABLE approvals ADD COLUMN reason TEXT;
    """,
    # -- migration 7: composio_connections table for OAuth integration ----------
    """
    CREATE TABLE IF NOT EXISTS composio_connections (
        id TEXT PRIMARY KEY,
        app_name TEXT NOT NULL,
        composio_connection_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'initiated',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_composio_connections_app_name
        ON composio_connections(app_name);
    CREATE INDEX IF NOT EXISTS idx_composio_connections_status
        ON composio_connections(status);
    """,
    # -- migration 8: schedule columns for workers (F2 cron scheduler) ---------
    """
    ALTER TABLE workers ADD COLUMN next_run_at TEXT;
    ALTER TABLE workers ADD COLUMN last_scheduled_run_at TEXT;
    """,
    # -- migration 9: webhook secrets table (F3 webhook trigger) ---------------
    """
    CREATE TABLE IF NOT EXISTS worker_webhook_secrets (
        worker_id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        rotated_at TEXT,
        FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
    );
    """,
    # -- migration 10: index on workers.next_run_at (F2 performance) -----------
    """
    CREATE INDEX IF NOT EXISTS idx_workers_next_run_at ON workers(next_run_at);
    """,
    _migrate_worker_contract_split,
    _migrate_composio_trigger_columns,
    # -- migration 13: content-addressed file input blobs ----------------------
    """
    CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        uploaded_by TEXT,
        uploaded_at TEXT NOT NULL,
        ref_count INTEGER DEFAULT 0 NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_uploaded_at ON files(uploaded_at);
    """,
    # -- migration 13: file_binding_audit for cross-user binding observability ---
    """
    CREATE TABLE IF NOT EXISTS file_binding_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        input_name TEXT NOT NULL,
        file_id TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        bound_by TEXT NOT NULL,
        bound_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_binding_audit_run_id
        ON file_binding_audit(run_id);
    CREATE INDEX IF NOT EXISTS idx_file_binding_audit_file_id
        ON file_binding_audit(file_id);
    """,
    # -- migration 15: drop approvals + worker_state tables (scope cut) ---------
    """
    DROP TABLE IF EXISTS approvals;
    DROP TABLE IF EXISTS worker_state;
    """,
    # -- migration 16: cancel_requested column on runs (cancel mechanism) -------
    """
    ALTER TABLE runs ADD COLUMN cancel_requested INTEGER DEFAULT 0 NOT NULL;
    ALTER TABLE runs ADD COLUMN cancelled_at TEXT;
    """,
    # -- migration 17: drop file_binding_audit (scope cut: no UI consumer) -----
    """
    DROP TABLE IF EXISTS file_binding_audit;
    """,
    # -- migration 18: health-check columns on connections + secrets + cached fields ----
    """
    ALTER TABLE composio_connections ADD COLUMN last_checked_at TEXT;
    ALTER TABLE composio_connections ADD COLUMN last_check_status TEXT;
    ALTER TABLE composio_connections ADD COLUMN last_check_error TEXT;
    ALTER TABLE composio_connections ADD COLUMN scopes_json TEXT;
    ALTER TABLE composio_connections ADD COLUMN account_label TEXT;
    ALTER TABLE secrets ADD COLUMN last_checked_at TEXT;
    ALTER TABLE secrets ADD COLUMN last_check_status TEXT;
    ALTER TABLE secrets ADD COLUMN last_check_error TEXT;
    """,
    # -- migration 19: drop unique constraint on app_name to allow multiple
    #    accounts per app (e.g. two Gmail accounts). Recreate table without
    #    the UNIQUE index on app_name; composio_connection_id remains unique
    #    per row via the primary-key id.
    """
    CREATE TABLE IF NOT EXISTS composio_connections_new (
        id TEXT PRIMARY KEY,
        app_name TEXT NOT NULL,
        composio_connection_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'initiated',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,
        last_check_status TEXT,
        last_check_error TEXT,
        scopes_json TEXT,
        account_label TEXT
    );
    INSERT INTO composio_connections_new
        SELECT id, app_name, composio_connection_id, status, created_at, updated_at,
               last_checked_at, last_check_status, last_check_error, scopes_json, account_label
        FROM composio_connections;
    DROP TABLE composio_connections;
    ALTER TABLE composio_connections_new RENAME TO composio_connections;
    CREATE INDEX IF NOT EXISTS idx_composio_connections_app_name
        ON composio_connections(app_name);
    CREATE INDEX IF NOT EXISTS idx_composio_connections_status
        ON composio_connections(status);
    """,
    # -- migration 20: triggers_json for multi-trigger support (PR P) ----------
    """
    ALTER TABLE workers ADD COLUMN triggers_json TEXT;
    """,
    # -- migration 21: clean up orphaned skill_versions rows (N5 fix) ----------
    # Rows in skill_versions that are not referenced by any worker can block
    # recreating a worker with the same name+version (UNIQUE constraint).
    # This one-time cleanup removes any orphans left by prior deletions.
    """
    DELETE FROM skill_versions
    WHERE id NOT IN (
        SELECT skill_version_id FROM workers WHERE skill_version_id IS NOT NULL
    );
    """,
    # -- migration 22: persist worker bundle snapshot path per run -------------
    """
    ALTER TABLE runs ADD COLUMN bundle_snapshot_path TEXT;
    """,
    # -- migration 23: scope OAuth connections to the owning user -------------
    """
    ALTER TABLE composio_connections ADD COLUMN user_id TEXT NOT NULL DEFAULT 'federico';
    CREATE INDEX IF NOT EXISTS idx_composio_connections_user_id
        ON composio_connections(user_id);
    """,
    # -- migration 24: scope secrets by user_id for repository abstraction -----
    _migrate_secrets_user_scope,
    # -- migration 25: persist CLI auth devices in sqlite ----------------------
    _migrate_cli_auth_devices,
    # -- migration 26: index owner/user joins for repository queries -----------
    _add_owner_indexes,
    # -- migration 27: output quality warning marker on runs -------------------
    """
    ALTER TABLE runs ADD COLUMN quality_warning TEXT;
    """,
    # -- migration 28: MCP server rows on the connections surface --------------
    """
    ALTER TABLE composio_connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'composio';
    ALTER TABLE composio_connections ADD COLUMN mcp_label TEXT;
    ALTER TABLE composio_connections ADD COLUMN mcp_url TEXT;
    ALTER TABLE composio_connections ADD COLUMN mcp_auth_secret TEXT;
    ALTER TABLE composio_connections ADD COLUMN mcp_allowed_tools_json TEXT;
    CREATE INDEX IF NOT EXISTS idx_composio_connections_kind
        ON composio_connections(kind);
    """,
    # -- migration 29: repair DBs where version 28 was already consumed --------
    _ensure_mcp_connection_columns,
    # -- migration 30: persist machine-readable run failure causes ------------
    """
    ALTER TABLE runs ADD COLUMN error_code TEXT;
    """,
    # -- migration 31: mark runs whose internal artifacts were compressed ------
    """
    ALTER TABLE runs ADD COLUMN artifacts_archived INTEGER DEFAULT 0 NOT NULL;
    """,
    # -- migration 32: repair DBs where version 31 was already consumed --------
    _ensure_runs_artifacts_archived_column,
    # -- migration 33: persist real display name (email/login) for connections --
    # display_name stores the unredacted email resolved from Composio so the
    # /connections page can show "depontefede@gmail.com" instead of
    # "Connected account". Additive only — no existing columns dropped.
    """
    ALTER TABLE composio_connections ADD COLUMN display_name TEXT;
    """,
    # -- migration 34: conversation persistence for /chat endpoint (S37) -----
    """
    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        total_tokens INTEGER DEFAULT 0 NOT NULL,
        total_cost_usd REAL DEFAULT 0.0 NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        tool_call_id TEXT,
        created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv_idx
        ON conversation_messages(conversation_id, created_at);
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
    for i, migration in enumerate(MIGRATIONS, start=1):
        if i > current:
            with get_db() as conn:
                try:
                    if isinstance(migration, str):
                        conn.executescript(migration)
                    else:
                        migration(conn)
                except sqlite3.OperationalError as exc:
                    if i not in {3, 4, 6, 8, 15, 18, 20, 22, 27, 28, 30, 31, 33} or "duplicate column name" not in str(exc):
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
    global DB_PATH
    DB_PATH = _configured_db_path()
    apply_migrations()
