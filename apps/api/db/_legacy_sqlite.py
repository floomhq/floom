"""Floom database layer with migrations, indexes, and context managers."""

import json
import re
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
_DB_TRANSACTION_LOCK = threading.RLock()
_DB_CONNECTION_STATE = threading.local()


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


def _db_cache_key(db_path: str, busy_timeout_ms: int) -> tuple[str, int]:
    if db_path == ":memory:":
        return (db_path, busy_timeout_ms)
    return (os.path.abspath(db_path), busy_timeout_ms)


def _close_cached_db_connection() -> None:
    conn = getattr(_DB_CONNECTION_STATE, "conn", None)
    if conn is not None:
        conn.close()
    _DB_CONNECTION_STATE.conn = None
    _DB_CONNECTION_STATE.cache_key = None
    _DB_CONNECTION_STATE.depth = 0


def _open_db_connection(db_path: str, busy_timeout_ms: int) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(db_path) if os.path.dirname(db_path) else ".", exist_ok=True)
    conn = sqlite3.connect(
        db_path,
        detect_types=sqlite3.PARSE_DECLTYPES,
        timeout=busy_timeout_ms / 1000,
    )
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
    _enable_wal_once(conn, db_path)
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _get_cached_db_connection(db_path: str, busy_timeout_ms: int) -> sqlite3.Connection:
    cache_key = _db_cache_key(db_path, busy_timeout_ms)
    cached_key = getattr(_DB_CONNECTION_STATE, "cache_key", None)
    conn = getattr(_DB_CONNECTION_STATE, "conn", None)
    if conn is not None and cached_key == cache_key:
        return conn

    _close_cached_db_connection()
    conn = _open_db_connection(db_path, busy_timeout_ms)
    _DB_CONNECTION_STATE.conn = conn
    _DB_CONNECTION_STATE.cache_key = cache_key
    return conn


def _execute_sql_script(conn: sqlite3.Connection, script: str) -> None:
    statement: list[str] = []
    in_single_quote = False
    in_double_quote = False
    in_line_comment = False
    in_block_comment = False
    i = 0
    length = len(script)
    while i < length:
        ch = script[i]
        nxt = script[i + 1] if i + 1 < length else ""

        if in_line_comment:
            statement.append(ch)
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            statement.append(ch)
            if ch == "*" and nxt == "/":
                statement.append(nxt)
                i += 2
                in_block_comment = False
            else:
                i += 1
            continue

        if in_single_quote:
            statement.append(ch)
            if ch == "'" and nxt == "'":
                statement.append(nxt)
                i += 2
                continue
            if ch == "'":
                in_single_quote = False
            i += 1
            continue

        if in_double_quote:
            statement.append(ch)
            if ch == '"' and nxt == '"':
                statement.append(nxt)
                i += 2
                continue
            if ch == '"':
                in_double_quote = False
            i += 1
            continue

        if ch == "-" and nxt == "-":
            statement.append(ch)
            statement.append(nxt)
            in_line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            statement.append(ch)
            statement.append(nxt)
            in_block_comment = True
            i += 2
            continue

        if ch == "'":
            in_single_quote = True
        elif ch == '"':
            in_double_quote = True

        if ch == ";":
            statement.append(ch)
            sql = "".join(statement).strip()
            if sql:
                conn.execute(sql)
            statement = []
            i += 1
            continue

        statement.append(ch)
        i += 1

    trailing = "".join(statement).strip()
    if trailing:
        conn.execute(trailing)


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
    busy_timeout_ms = _busy_timeout_ms()
    conn = _get_cached_db_connection(DB_PATH, busy_timeout_ms)
    depth = getattr(_DB_CONNECTION_STATE, "depth", 0)
    _DB_CONNECTION_STATE.depth = depth + 1
    savepoint_name = None
    acquired_lock = False
    if depth > 0:
        savepoint_name = f"db_ctx_{depth}"
        conn.execute(f"SAVEPOINT {savepoint_name}")
    else:
        _DB_TRANSACTION_LOCK.acquire()
        acquired_lock = True
        conn.execute("BEGIN")
    try:
        yield conn
        if savepoint_name is not None:
            conn.execute(f"RELEASE SAVEPOINT {savepoint_name}")
        else:
            conn.commit()
    except Exception:
        if savepoint_name is not None:
            conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint_name}")
            conn.execute(f"RELEASE SAVEPOINT {savepoint_name}")
        else:
            conn.rollback()
        raise
    finally:
        _DB_CONNECTION_STATE.depth = depth
        if acquired_lock:
            _DB_TRANSACTION_LOCK.release()


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

        _execute_sql_script(conn,
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
        table_preserves: list[tuple[str, str]] = []
        for table_name in ("logs", "artifacts"):
            if _table_exists(conn, table_name):
                preserve_name = f"{table_name}_preserve"
                conn.execute(f"DROP TABLE IF EXISTS {preserve_name}")
                conn.execute(f"CREATE TEMP TABLE {preserve_name} AS SELECT * FROM {table_name}")
                table_preserves.append((table_name, preserve_name))
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
            _execute_sql_script(conn,
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

        for table_name, preserve_name in table_preserves:
            conn.execute(f"DELETE FROM {table_name}")
            conn.execute(f"INSERT INTO {table_name} SELECT * FROM {preserve_name}")
            conn.execute(f"DROP TABLE {preserve_name}")

        _execute_sql_script(conn,
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

    _execute_sql_script(conn,
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

    _execute_sql_script(conn,
        """
        DROP TABLE secrets;
        ALTER TABLE secrets_new RENAME TO secrets;
        CREATE INDEX IF NOT EXISTS idx_secrets_user_id ON secrets(user_id);
        """
    )


def _migrate_cli_auth_devices(conn: sqlite3.Connection) -> None:
    _execute_sql_script(conn,
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
    _execute_sql_script(conn,
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
        ("mcp_transport", "ALTER TABLE composio_connections ADD COLUMN mcp_transport TEXT NOT NULL DEFAULT 'streamable_http'"),
        ("mcp_command", "ALTER TABLE composio_connections ADD COLUMN mcp_command TEXT"),
        ("mcp_args_json", "ALTER TABLE composio_connections ADD COLUMN mcp_args_json TEXT"),
        ("mcp_env_json", "ALTER TABLE composio_connections ADD COLUMN mcp_env_json TEXT"),
        ("mcp_cwd", "ALTER TABLE composio_connections ADD COLUMN mcp_cwd TEXT"),
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


def _migrate_file_owners(conn: sqlite3.Connection) -> None:
    _execute_sql_script(conn,
        """
        CREATE TABLE IF NOT EXISTS file_owners (
            file_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            first_uploaded_at TEXT NOT NULL,
            PRIMARY KEY (file_id, user_id),
            FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_file_owners_user_id
            ON file_owners(user_id);
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO file_owners (file_id, user_id, first_uploaded_at)
        SELECT
            id,
            COALESCE(NULLIF(uploaded_by, ''), 'anonymous'),
            uploaded_at
        FROM files
        """
    )


def _derive_workspace_id_from_owner(owner_id: str | None) -> str:
    """Derive a workspace_id from an engine owner_id.

    In OSS/local mode the active workspace is encoded into the scoped user_id:
    the base user keeps its bare id under the default workspace (``local-default``),
    and a non-default local workspace appends a ``__ws_<14 hex>`` suffix (see
    ``auth/local_workspaces.py``). owner_id IS that scoped user_id, so the
    workspace it belongs to is the suffix when present, else ``local-default``.

    This keeps the new ``workspace_members`` / ``workers.workspace_id`` model
    consistent with the existing per-workspace owner-scoping with zero new
    encoding: one workspace == one (base_user, workspace_id) pair.
    """
    text = (owner_id or "").strip()
    match = re.search(r"__(ws_[a-f0-9]{14})$", text)
    if match:
        return match.group(1)
    return "local-default"


def _migrate_workspace_members_and_visibility(conn: sqlite3.Connection) -> None:
    """Members + asset-visibility schema (engine STEP 1).

    Adds the ``workspace_members`` table (workspace-level RBAC) + a partial
    unique index enforcing exactly one active owner per workspace, and the
    per-asset ``workspace_id`` / ``visibility`` columns on ``workers``.

    Idempotent: re-runnable. Uses IF NOT EXISTS / PRAGMA checks so a partially
    applied migration (or a fresh DB that created some of this inline) is safe.
    Backwards-safe: existing workers keep working; the backfill (next migration)
    populates the new columns so single-tenant behaviour is unchanged.
    """
    _execute_sql_script(conn,
        """
        CREATE TABLE IF NOT EXISTS workspace_members (
            workspace_id TEXT NOT NULL,
            user_id      TEXT NOT NULL,
            email        TEXT,
            display_name TEXT,
            role         TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
            status       TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','invited','removed')),
            invited_by   TEXT,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL,
            PRIMARY KEY (workspace_id, user_id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_one_owner
            ON workspace_members(workspace_id)
            WHERE role = 'owner' AND status = 'active';

        CREATE INDEX IF NOT EXISTS idx_workspace_members_user
            ON workspace_members(user_id);
        """
    )

    worker_columns = _table_columns(conn, "workers")
    if "workspace_id" not in worker_columns:
        conn.execute("ALTER TABLE workers ADD COLUMN workspace_id TEXT")
    if "visibility" not in worker_columns:
        # Cannot inline a CHECK on ADD COLUMN reliably across SQLite versions for
        # an existing table; enforce the allowed set at the repository layer and
        # default to the secure value here. New rows created via INSERT paths set
        # it explicitly.
        conn.execute(
            "ALTER TABLE workers ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'"
        )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_workers_workspace_id "
        "ON workers(workspace_id)"
    )


def _migrate_workspace_members_backfill(conn: sqlite3.Connection) -> None:
    """Backfill members + worker workspace_id/visibility from existing state.

    Idempotent + backwards-safe:
      1. One active owner ``workspace_members`` row per ``local_workspaces`` row,
         keyed by (derived workspace_id, owner_user_id). INSERT OR IGNORE so a
         re-run never duplicates or downgrades an existing membership.
      2. Every worker gets ``workspace_id`` derived from its owner_id suffix
         (``local-default`` for the base user) when currently NULL.
      3. Every worker gets ``visibility='private'`` when currently NULL/empty,
         preserving the secure default; rows already set are untouched.

    Existing single-tenant behaviour is unchanged: the single local owner becomes
    the one workspace member, and every existing worker stays private + owned by
    the same user, so list/run/edit see no change.
    """
    now = now_iso()

    if _table_exists(conn, "local_workspaces"):
        rows = conn.execute(
            "SELECT id, owner_user_id FROM local_workspaces"
        ).fetchall()
        for row in rows:
            ws_id = row["id"]
            owner = row["owner_user_id"]
            if not ws_id or not owner:
                continue
            conn.execute(
                """
                INSERT OR IGNORE INTO workspace_members
                    (workspace_id, user_id, email, display_name, role,
                     status, invited_by, created_at, updated_at)
                VALUES (?, ?, NULL, NULL, 'owner', 'active', NULL, ?, ?)
                """,
                (ws_id, owner, now, now),
            )

    # Backfill workers.workspace_id + visibility. owner_id already exists.
    if _table_exists(conn, "workers"):
        worker_rows = conn.execute(
            "SELECT id, owner_id, workspace_id, visibility FROM workers"
        ).fetchall()
        for row in worker_rows:
            updates: list[str] = []
            params: list[Any] = []
            if not (row["workspace_id"] or "").strip():
                updates.append("workspace_id = ?")
                params.append(_derive_workspace_id_from_owner(row["owner_id"]))
            if not (row["visibility"] or "").strip():
                updates.append("visibility = ?")
                params.append("private")
            if updates:
                params.append(row["id"])
                conn.execute(
                    f"UPDATE workers SET {', '.join(updates)} WHERE id = ?",
                    tuple(params),
                )

    # Ensure every distinct worker owner that lacks a local_workspaces row still
    # has an owner membership (e.g. derived-workspace owners, or DBs predating
    # local_workspaces). Derive their workspace_id the same way.
    if _table_exists(conn, "workers"):
        owner_rows = conn.execute(
            "SELECT DISTINCT owner_id FROM workers WHERE owner_id IS NOT NULL"
        ).fetchall()
        for row in owner_rows:
            owner = row["owner_id"]
            if not owner:
                continue
            ws_id = _derive_workspace_id_from_owner(owner)
            conn.execute(
                """
                INSERT OR IGNORE INTO workspace_members
                    (workspace_id, user_id, email, display_name, role,
                     status, invited_by, created_at, updated_at)
                VALUES (?, ?, NULL, NULL, 'owner', 'active', NULL, ?, ?)
                """,
                (ws_id, owner, now, now),
            )


def _migrate_brain_pack_assistant_visibility(conn: sqlite3.Connection) -> None:
    """Normalize brain packs + assistants for per-asset visibility (engine STEP 4-5).

    Brain packs (the /contexts feature) and the workspace assistant are not SQL
    rows in the engine: brain packs are filesystem directories + a JSON metadata
    sidecar, and the assistant is the ``workspace.md`` instructions. To bring them
    under the SAME ``AssetAccessRepository`` access model that STEP 1 gave workers,
    we add two access-control mirror tables. Each row carries exactly the columns
    the generic ``SqliteAssetAccessRepository`` reads (``id, owner_id,
    workspace_id, visibility``) so the repo works with zero new logic — the asset
    type is just registered in ``_ASSET_TABLES``.

    The filesystem metadata (``.workeros-contexts.json``) and ``workspace.md``
    remain the content source of truth; these rows are the access-control mirror,
    written through the same repository on create + visibility change so they never
    drift (design top-risk: "writes go through one repository").

    Defaults per the design: brain packs ``private`` (knowledge can carry
    credentials/PII); assistant ``workspace`` (it is a shared workspace tool).

    Idempotent: IF NOT EXISTS / re-runnable.
    """
    _execute_sql_script(conn,
        """
        CREATE TABLE IF NOT EXISTS brain_packs (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            owner_id     TEXT NOT NULL,
            visibility   TEXT NOT NULL DEFAULT 'private',
            name         TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_brain_packs_workspace_id
            ON brain_packs(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_brain_packs_owner_id
            ON brain_packs(owner_id);

        CREATE TABLE IF NOT EXISTS assistants (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            owner_id     TEXT NOT NULL,
            visibility   TEXT NOT NULL DEFAULT 'workspace',
            name         TEXT NOT NULL,
            config_json  TEXT NOT NULL DEFAULT '{}',
            instructions_md TEXT,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_assistants_workspace_id
            ON assistants(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_assistants_owner_id
            ON assistants(owner_id);
        """
    )


def _migrate_brain_pack_assistant_backfill(conn: sqlite3.Connection) -> None:
    """Backfill brain_packs + assistants rows from existing engine state.

    Backwards-safe + idempotent (INSERT OR IGNORE):
      1. One ``assistants`` row per local workspace (id ``workspace-agent``,
         owner = workspace owner, visibility ``workspace``). The assistant is a
         shared workspace tool so it is workspace-visible by default; on the OSS
         single-owner engine the owner IS the local user, so chat is unchanged.

    Brain packs are NOT backfilled here because their owner_id already lives in
    the per-workspace ``.workeros-contexts.json`` (which the SQLite DB cannot see
    in cloud's per-workspace FS layout). Instead the API lazily upserts a
    ``brain_packs`` row the first time a pack's visibility is read/changed (see
    ``ensure_brain_pack_row`` in contexts.py), defaulting to ``private`` — the
    secure default that matches the existing owner-only behaviour. This keeps the
    mirror correct without a migration reading customer FS state.
    """
    now = now_iso()
    if _table_exists(conn, "local_workspaces") and _table_exists(conn, "assistants"):
        rows = conn.execute(
            "SELECT id, owner_user_id FROM local_workspaces"
        ).fetchall()
        for row in rows:
            ws_id = row["id"]
            owner = row["owner_user_id"]
            if not ws_id or not owner:
                continue
            conn.execute(
                """
                INSERT OR IGNORE INTO assistants
                    (id, workspace_id, owner_id, visibility, name,
                     config_json, instructions_md, created_at, updated_at)
                VALUES (?, ?, ?, 'workspace', 'Workspace assistant',
                        '{}', NULL, ?, ?)
                """,
                (_assistant_row_id(ws_id), ws_id, owner, now, now),
            )

    # Every distinct worker owner that lacks a local_workspaces row still gets an
    # assistant row for their derived workspace (mirrors the members backfill).
    if _table_exists(conn, "workers") and _table_exists(conn, "assistants"):
        owner_rows = conn.execute(
            "SELECT DISTINCT owner_id FROM workers WHERE owner_id IS NOT NULL"
        ).fetchall()
        for row in owner_rows:
            owner = row["owner_id"]
            if not owner:
                continue
            ws_id = _derive_workspace_id_from_owner(owner)
            conn.execute(
                """
                INSERT OR IGNORE INTO assistants
                    (id, workspace_id, owner_id, visibility, name,
                     config_json, instructions_md, created_at, updated_at)
                VALUES (?, ?, ?, 'workspace', 'Workspace assistant',
                        '{}', NULL, ?, ?)
                """,
                (_assistant_row_id(ws_id), ws_id, owner, now, now),
            )


def _assistant_row_id(workspace_id: str) -> str:
    """Stable per-workspace assistant row id.

    One assistant per workspace, keyed by workspace so the OSS default workspace
    and each derived/cloud workspace get exactly one ``assistants`` row.
    """
    ws = (workspace_id or "local-default").strip() or "local-default"
    return f"workspace-agent:{ws}"


def _make_worker_alerts_url_nullable(conn: sqlite3.Connection) -> None:
    """Allow email-only worker alerts in SQLite databases created before email alerts."""
    if not _table_exists(conn, "worker_alerts"):
        return
    columns = list(conn.execute("PRAGMA table_info(worker_alerts)"))
    url_col = next((row for row in columns if row["name"] == "url"), None)
    if url_col is None or int(url_col["notnull"] or 0) == 0:
        return

    _execute_sql_script(conn,
        """
        CREATE TABLE worker_alerts_new (
            id          TEXT PRIMARY KEY,
            worker_id   TEXT NOT NULL,
            url         TEXT,
            events      TEXT NOT NULL DEFAULT 'failed',
            description TEXT,
            created_at  TEXT NOT NULL,
            email_to    TEXT,
            FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
        );
        INSERT INTO worker_alerts_new (id, worker_id, url, events, description, created_at, email_to)
        SELECT id, worker_id, url, events, description, created_at, email_to
        FROM worker_alerts;
        DROP TABLE worker_alerts;
        ALTER TABLE worker_alerts_new RENAME TO worker_alerts;
        CREATE INDEX IF NOT EXISTS idx_worker_alerts_worker_id
            ON worker_alerts(worker_id);
        """
    )


def _migrate_worker_webhook_secrets_fk(conn: sqlite3.Connection) -> None:
    rows = conn.execute("PRAGMA foreign_key_list(worker_webhook_secrets)").fetchall()
    if rows and all(row["table"] == "workers" for row in rows):
        return

    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS worker_webhook_secrets_new (
            worker_id TEXT PRIMARY KEY,
            secret_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            rotated_at TEXT,
            FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
        )
        """
    )
    if _table_exists(conn, "worker_webhook_secrets"):
        conn.execute(
            """
            INSERT OR REPLACE INTO worker_webhook_secrets_new
                (worker_id, secret_hash, created_at, rotated_at)
            SELECT s.worker_id, s.secret_hash, s.created_at, s.rotated_at
            FROM worker_webhook_secrets s
            WHERE EXISTS (
                SELECT 1 FROM workers w WHERE w.id = s.worker_id
            )
            """
        )
        conn.execute("DROP TABLE worker_webhook_secrets")
    conn.execute("ALTER TABLE worker_webhook_secrets_new RENAME TO worker_webhook_secrets")
    conn.execute("PRAGMA foreign_keys = ON")


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
    ALTER TABLE composio_connections ADD COLUMN mcp_transport TEXT NOT NULL DEFAULT 'streamable_http';
    ALTER TABLE composio_connections ADD COLUMN mcp_command TEXT;
    ALTER TABLE composio_connections ADD COLUMN mcp_args_json TEXT;
    ALTER TABLE composio_connections ADD COLUMN mcp_env_json TEXT;
    ALTER TABLE composio_connections ADD COLUMN mcp_cwd TEXT;
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
    # /connections page can show "owner@example.com" instead of
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
    # -- migration 35: webhook delivery receipts for replay/idempotency -------
    """
    CREATE TABLE IF NOT EXISTS webhook_delivery_receipts (
        source TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        received_at REAL NOT NULL,
        PRIMARY KEY (source, delivery_id)
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_delivery_receipts_received_at
        ON webhook_delivery_receipts(received_at);
    """,
    # -- migration 36: many-to-many upload ownership for dedup-safe auth ------
    _migrate_file_owners,
    # -- migration 37: restore approvals table (S47 HITL) --------------------
    # The approvals table was dropped in migration 15 (scope cut #29).
    # S47 reintroduces it with additional columns for the two-run respawn model:
    #   decision_input_json  — inputs to spawn the follow-up run
    #   edited_output_json   — operator edits to the proposed output
    #   follow_up_run_id     — the run spawned on approval
    #   owner_id             — scoping for multi-tenant forward-compat
    """
    CREATE TABLE IF NOT EXISTS approvals (
        id                  TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL,
        worker_id           TEXT NOT NULL,
        status              TEXT NOT NULL,
        label               TEXT,
        preview             TEXT,
        created_at          TEXT NOT NULL,
        decided_at          TEXT,
        reason              TEXT,
        decision_input_json TEXT,
        edited_output_json  TEXT,
        follow_up_run_id    TEXT,
        annotations_json    TEXT,
        owner_id            TEXT NOT NULL,
        FOREIGN KEY(run_id)    REFERENCES runs(id) ON DELETE CASCADE,
        FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_run_id     ON approvals(run_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_worker_id  ON approvals(worker_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status     ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_owner_id   ON approvals(owner_id);
    """,
    # -- migration 38: alert_incidents table for worker alerting ---------------
    # Persists fired alert incidents so the same incident is not re-sent and
    # there is an audit trail.  One row per (worker_id, incident_key) per open
    # incident; resolved_at is set when the worker recovers.
    """
    CREATE TABLE IF NOT EXISTS alert_incidents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        worker_id   TEXT NOT NULL,
        incident_key TEXT NOT NULL,
        reason      TEXT NOT NULL,
        details     TEXT,
        fired_at    TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(worker_id, incident_key)
    );
    CREATE INDEX IF NOT EXISTS idx_alert_incidents_worker
        ON alert_incidents(worker_id);
    """,
    # -- migration 39: local OSS workspaces ----------------------------------
    # Cloud owns Supabase workspaces. The OSS engine keeps a tiny local
    # workspace registry so the single-user dashboard can switch isolated local
    # workspaces without adding workspace_id columns to every existing table.
    """
    CREATE TABLE IF NOT EXISTS local_workspaces (
        id            TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        name          TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (owner_user_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_local_workspaces_owner_created
        ON local_workspaces(owner_user_id, created_at);
    """,
    # -- migration 40: worker_alerts (webhook alert registrations) -----------
    # Stores webhook endpoints registered per-worker. When a run terminates
    # the engine fires a POST to each matching URL. Events: "failed",
    # "completed". Optional HMAC secret for request signing.
    """
    CREATE TABLE IF NOT EXISTS worker_alerts (
        id          TEXT PRIMARY KEY,
        worker_id   TEXT NOT NULL,
        url         TEXT,
        events      TEXT NOT NULL DEFAULT 'failed',
        description TEXT,
        created_at  TEXT NOT NULL,
        FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_worker_alerts_worker_id
        ON worker_alerts(worker_id);
    """,
    # -- migration 41: retry tracking on runs --------------------------------
    # retry_of_run_id: the original run this is a retry of (NULL for originals)
    # retry_attempt:   1-based attempt number (0 for the original run)
    """
    ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT;
    ALTER TABLE runs ADD COLUMN retry_attempt INTEGER DEFAULT 0;
    """,
    # -- migration 42: email channel on worker_alerts ------------------------
    # email_to: JSON list of recipient email addresses for email notifications.
    # url is now nullable — an alert can be webhook-only, email-only, or both.
    """
    ALTER TABLE worker_alerts ADD COLUMN email_to TEXT;
    """,
    # -- migration 43: make worker_alerts.url nullable -----------------------
    # Migration 42 introduced email-only alerts, but SQLite cannot alter an
    # existing NOT NULL column in place. Rebuild the table for older DB files.
    _make_worker_alerts_url_nullable,
    # -- migration 44: asset_versions (worker + brain-pack versioning) --------
    """
    CREATE TABLE IF NOT EXISTS asset_versions (
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
    """,
    # -- migration 45: repair DBs that already consumed older MCP migrations ---
    _ensure_mcp_connection_columns,
    # -- migration 46: mcp_tools (custom tools backed by workers) --------------
    """
    CREATE TABLE IF NOT EXISTS mcp_tools (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL,
        input_schema TEXT NOT NULL DEFAULT '{}',
        worker_id    TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE(user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_tools_user_id ON mcp_tools(user_id);
    """,
    # -- migration 47: native Slack app OAuth installations -------------------
    """
    CREATE TABLE IF NOT EXISTS slack_installations (
        team_id TEXT PRIMARY KEY,
        team_name TEXT,
        enterprise_id TEXT,
        enterprise_name TEXT,
        app_id TEXT,
        bot_user_id TEXT,
        bot_token_env_key TEXT NOT NULL,
        scopes_json TEXT,
        installer_user_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        installed_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,
        last_check_status TEXT,
        last_check_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_slack_installations_installed_by
        ON slack_installations(installed_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_slack_installations_status
        ON slack_installations(status);
    """,
    # -- migration 48: structured reviewer annotations on approvals (X4) -------
    # Persists the structured highlight+comment / screenshot-pin feedback the
    # reviewer attaches alongside an approve/reject decision, as a JSON blob:
    #   {"text": [{"quote", "comment", ...}], "images": [{"url", "comments": [...]}]}
    # Fresh DBs already created the column inline above, so a duplicate-column
    # OperationalError here is expected and skipped (see apply_migrations).
    """
    ALTER TABLE approvals ADD COLUMN annotations_json TEXT;
    """,
    # -- migration 49: normalize triggers into worker_triggers -----------------
    # A worker can declare N triggers (persisted in workers.triggers_json), but
    # the scheduler/registration historically read only the scalar trigger_type/
    # cron_expr on the workers row, so only the PRIMARY (first) trigger ever
    # fired. This table stores ONE ROW PER DECLARED TRIGGER so every trigger is
    # independently schedulable / resolvable.
    #
    #   type           — schedule | webhook | composio_event | manual
    #   config_json    — the per-trigger config (cron/timezone, webhook spec, or
    #                    composio event spec) so each row is self-describing.
    #   enabled        — disabled rows are skipped by the scheduler/resolvers.
    #   next_run_at    — schedule rows only: next due ISO time (croniter).
    #   external_trigger_id — composio rows: the Composio registration id used to
    #                    resolve an incoming event back to this specific row.
    #   webhook_path   — webhook rows: the worker_id used in the /webhooks/<id>
    #                    path (kept for forward-compat with per-trigger paths).
    #   last_fired_at  — bookkeeping for observability.
    #
    # Existing single-trigger workers are reconciled into exactly one row on the
    # next registration/startup, so nothing breaks during the migration.
    """
    CREATE TABLE IF NOT EXISTS worker_triggers (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        config_json TEXT,
        enabled INTEGER DEFAULT 1 NOT NULL,
        next_run_at TEXT,
        external_trigger_id TEXT,
        webhook_path TEXT,
        last_fired_at TEXT,
        position INTEGER DEFAULT 0 NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_worker_triggers_worker_id
        ON worker_triggers(worker_id);
    CREATE INDEX IF NOT EXISTS idx_worker_triggers_type_enabled
        ON worker_triggers(type, enabled);
    CREATE INDEX IF NOT EXISTS idx_worker_triggers_next_run_at
        ON worker_triggers(next_run_at);
    CREATE INDEX IF NOT EXISTS idx_worker_triggers_external_id
        ON worker_triggers(external_trigger_id);
    """,
    # -- migration 50: trigger_ref on runs (which trigger fired) ----------------
    # Records WHICH worker_triggers row fired a run so two schedule triggers on
    # the same worker produce distinguishable runs. Fresh DBs created by an
    # earlier inline path may already have it, so a duplicate-column
    # OperationalError here is expected and skipped (see apply_migrations).
    """
    ALTER TABLE runs ADD COLUMN trigger_ref TEXT;
    """,
    # -- migration 51: workspace_members + per-asset visibility (Members STEP 1) -
    # Workspace-level RBAC (workspace_members) + per-asset owner_id/visibility on
    # workers. owner_id already exists; this adds workspace_id + visibility and
    # the one-active-owner-per-workspace unique index. Idempotent.
    _migrate_workspace_members_and_visibility,
    # -- migration 52: backfill members + worker workspace_id/visibility --------
    # One owner membership per local workspace + per distinct worker owner;
    # existing workers get derived workspace_id + visibility='private'. Idempotent
    # + backwards-safe (single-tenant behaviour unchanged).
    _migrate_workspace_members_backfill,
    # -- migration 53: brain_packs + assistants tables (Members STEP 4-5) -------
    # Access-control mirror rows for brain packs (/contexts) + the workspace
    # assistant so the generic AssetAccessRepository covers them too. brain packs
    # default private; assistant defaults workspace (shared tool). Idempotent.
    _migrate_brain_pack_assistant_visibility,
    # -- migration 54: backfill assistants per workspace -----------------------
    # One assistant row per local workspace + per distinct worker owner. Brain
    # packs are lazily upserted by the API (owner lives in FS metadata, not the DB).
    _migrate_brain_pack_assistant_backfill,
    # -- migration 55: public worker share short links -------------------------
    """
    CREATE TABLE IF NOT EXISTS worker_short_links (
        short_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(worker_id, owner_id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_short_links_worker_owner
        ON worker_short_links(worker_id, owner_id);
    """,
    # -- migration 56: workspace-agent capability settings -------------------
    """
    CREATE TABLE IF NOT EXISTS workspace_agent_settings (
        user_id TEXT PRIMARY KEY,
        brain_read INTEGER DEFAULT 1 NOT NULL,
        brain_write INTEGER DEFAULT 0 NOT NULL,
        connections_read INTEGER DEFAULT 1 NOT NULL,
        connections_use INTEGER DEFAULT 0 NOT NULL,
        connections_add INTEGER DEFAULT 0 NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    """,
    # -- migration 57: WhatsApp sender-to-workspace bindings ------------------
    """
    CREATE TABLE IF NOT EXISTS whatsapp_sender_bindings (
        wa_id TEXT PRIMARY KEY,
        user_id TEXT,
        profile_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        claim_token TEXT UNIQUE,
        claim_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_bindings_user_id
        ON whatsapp_sender_bindings(user_id);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_bindings_claim_token
        ON whatsapp_sender_bindings(claim_token);
    """,
    # -- migration 58: Emily chat Phase 1 tool cards + idempotency ------------
    """
    CREATE TABLE IF NOT EXISTS conversation_tool_calls (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL,
        conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        call_id             TEXT NOT NULL,
        tool_name           TEXT NOT NULL,
        status              TEXT NOT NULL,
        card_json           TEXT NOT NULL,
        resource_json       TEXT,
        streams_json        TEXT,
        actions_json        TEXT,
        args_preview_json   TEXT,
        result_preview_json TEXT,
        run_id              TEXT,
        worker_id           TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE(conversation_id, call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_tool_calls_conv
        ON conversation_tool_calls(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_tool_calls_run
        ON conversation_tool_calls(run_id);

    CREATE TABLE IF NOT EXISTS chat_tool_idempotency (
        user_id         TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        tool_name       TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        run_id          TEXT,
        worker_id       TEXT,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (user_id, conversation_id, tool_name, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_tool_idempotency_run
        ON chat_tool_idempotency(run_id);
    """,
    # -- migration 59: multi-member support — users, sessions, PATs -----------
    # users: local user accounts with bcrypt-hashed passwords and admin|member roles.
    # user_sessions: server-side sessions for cookie-based web UI auth.
    # personal_access_tokens: per-user long-lived API tokens for API/MCP access.
    #
    # Backwards-safe: existing installs with no users keep working via x-floom-secret.
    # The users table being empty signals "single-user legacy mode" — multi-member
    # auth only activates once the first admin is created via POST /auth/setup.
    """
    CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        username    TEXT NOT NULL,
        display_name TEXT,
        password_hash TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('admin', 'member')),
        disabled    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
        ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_role
        ON users(role);

    CREATE TABLE IF NOT EXISTS user_sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at  TEXT NOT NULL,
        created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id
        ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at
        ON user_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS personal_access_tokens (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        token_hash  TEXT NOT NULL,
        last_used_at TEXT,
        created_at  TEXT NOT NULL,
        expires_at  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pat_token_hash
        ON personal_access_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_pat_user_id
        ON personal_access_tokens(user_id);
    """,
    # -- migration 60: git workspace config ----------------------------------
    # Stores the GitHub PAT and linked repo for the git-backed workspace.
    # One row per user (in practice one row for the local admin in OSS mode).
    # The PAT is stored in plain text in the local SQLite DB — acceptable since
    # OSS runs on a private server and the DB file is already the trust boundary
    # (same as the workeros.db that holds all other sensitive settings).
    """
    CREATE TABLE IF NOT EXISTS git_workspace_config (
        user_id         TEXT PRIMARY KEY,
        github_pat      TEXT NOT NULL,
        github_username TEXT,
        repo_full_name  TEXT,
        repo_url        TEXT,
        remote_url      TEXT,
        connected_at    TEXT NOT NULL,
        last_pushed_at  TEXT
    );
    """,
    # -- migration 61: hash-backed CLI API tokens ------------------------------
    # CLI device flow returns a per-client token that the MCP package sends in
    # x-floom-secret. Store only its hash; do not reuse or reveal FLOOM_SECRET.
    """
    CREATE TABLE IF NOT EXISTS cli_api_tokens (
        id           TEXT PRIMARY KEY,
        token_hash   TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        role         TEXT NOT NULL DEFAULT 'admin',
        name         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at   TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cli_api_tokens_hash
        ON cli_api_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_cli_api_tokens_user_id
        ON cli_api_tokens(user_id);
    """,
    # -- migration 62: repair webhook-secret FK after workers table rebuild ----
    _migrate_worker_webhook_secrets_fk,
    # -- migration 63: worker_feedback (lightweight comments per worker) --------
    # SPEC §12: anyone who can SEE a worker can leave feedback (a short comment)
    # on it, surfaced to the owner. author_id/author_name capture who wrote it so
    # the owner knows the source; rows cascade-delete with the worker. Mirrors the
    # worker_alerts FK pattern.
    """
    CREATE TABLE IF NOT EXISTS worker_feedback (
        id          TEXT PRIMARY KEY,
        worker_id   TEXT NOT NULL,
        author_id   TEXT NOT NULL,
        author_name TEXT,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        FOREIGN KEY(worker_id) REFERENCES workers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_worker_feedback_worker_id
        ON worker_feedback(worker_id, created_at);
    """,
    # -- migration 64: Slack per-user sender bindings (claim-link DM identity) --
    # Mirrors whatsapp_sender_bindings (migration 57). PK is (slack_team_id,
    # slack_user_id) so the same Slack user in two different workspaces can have
    # independent bindings. claim_token is UNIQUE to support fast single-use
    # lookup and invalidation.
    """
    CREATE TABLE IF NOT EXISTS slack_sender_bindings (
        slack_team_id   TEXT NOT NULL,
        slack_user_id   TEXT NOT NULL,
        user_id         TEXT,
        profile_name    TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        claim_token     TEXT UNIQUE,
        claim_expires_at TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        last_seen_at    TEXT,
        PRIMARY KEY (slack_team_id, slack_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_slack_sender_bindings_user_id
        ON slack_sender_bindings(user_id);
    CREATE INDEX IF NOT EXISTS idx_slack_sender_bindings_claim_token
        ON slack_sender_bindings(claim_token);
    """,
    # -- migration 65: pin workspace_id on WhatsApp sender bindings -----------
    # Adds workspace_id (nullable for backward compat — NULL = 'local-default').
    # Backfills existing active rows to 'local-default' so the live Federico
    # binding keeps working without any manual intervention.
    """
    ALTER TABLE whatsapp_sender_bindings ADD COLUMN workspace_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_bindings_workspace_id
        ON whatsapp_sender_bindings(workspace_id);
    UPDATE whatsapp_sender_bindings
    SET workspace_id = 'local-default'
    WHERE status = 'active' AND workspace_id IS NULL;
    """,
    # -- migration 66: per-user appearance settings (#773) --------------------
    # Theme (day/dark/system) + accent are per-user preferences, distinct from
    # workspace settings. Keyed by user_id, one row per user.
    """
    CREATE TABLE IF NOT EXISTS user_settings (
        user_id    TEXT PRIMARY KEY,
        theme      TEXT NOT NULL DEFAULT 'system',
        accent     TEXT,
        updated_at TEXT NOT NULL
    );
    """,
    # -- migration 67: per-user worker star/favorite (#782) -------------------
    # Kept per-user (not a workers column) so stars don't leak across members
    # in a shared workspace. One row per (user, worker) that is starred.
    """
    CREATE TABLE IF NOT EXISTS user_worker_prefs (
        user_id    TEXT NOT NULL,
        worker_id  TEXT NOT NULL,
        starred    INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, worker_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_worker_prefs_user
        ON user_worker_prefs(user_id, starred);
    """,
    # -- migration 68: workspace settings KV (#794 toggles, #797 model defaults) -
    """
    CREATE TABLE IF NOT EXISTS workspace_settings (
        workspace_id TEXT NOT NULL,
        key          TEXT NOT NULL,
        value        TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (workspace_id, key)
    );
    """,
    # -- migration 69: specific-people share grants (#767/#768) ----------------
    """
    CREATE TABLE IF NOT EXISTS asset_grants (
        id            TEXT PRIMARY KEY,
        asset_type    TEXT NOT NULL,
        asset_id      TEXT NOT NULL,
        owner_id      TEXT NOT NULL,
        grantee_email TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        UNIQUE(asset_type, asset_id, owner_id, grantee_email)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_grants_asset
        ON asset_grants(asset_type, asset_id, owner_id);
    """,
    # -- migration 70: grantee lookup index for grant enforcement (#767/#768) ---
    # The enforcement path resolves "which assets is this viewer granted?" by
    # grantee_email; index it so the per-request lookup stays O(log n).
    """
    CREATE INDEX IF NOT EXISTS idx_asset_grants_grantee
        ON asset_grants(asset_type, grantee_email);
    """,
    # -- migration 71: workspace region/timezone (#791) + approval expiry (#798)
    #    + approval preview typing (#792). Grouped ADD COLUMNs (idempotent set).
    """
    ALTER TABLE local_workspaces ADD COLUMN region TEXT;
    ALTER TABLE local_workspaces ADD COLUMN timezone TEXT;
    ALTER TABLE approvals ADD COLUMN expires_at TEXT;
    ALTER TABLE approvals ADD COLUMN preview_type TEXT;
    ALTER TABLE approvals ADD COLUMN preview_payload_json TEXT;
    CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals(expires_at);
    """,
    # -- migration 72: CLI API token expiry (#915/#924/#949) -------------------
    # CLI device tokens used to live forever. New tokens get a bounded TTL at
    # mint time; NULL means a legacy token (still honored until rotated).
    """
    ALTER TABLE cli_api_tokens ADD COLUMN expires_at TEXT;
    """,
    # -- migration 73: pin workspace_id on Slack sender bindings (#865) --------
    # Mirrors migration 65 (WhatsApp). Nullable for backward compat — NULL =
    # 'local-default' on the engine; cloud rows resolve workspace via the cloud
    # repository and stay NULL here. Backfills existing active rows so live
    # bindings keep working without manual intervention.
    """
    ALTER TABLE slack_sender_bindings ADD COLUMN workspace_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_slack_sender_bindings_workspace_id
        ON slack_sender_bindings(workspace_id);
    UPDATE slack_sender_bindings
    SET workspace_id = 'local-default'
    WHERE status = 'active' AND workspace_id IS NULL;
    """,
    # -- migration 74: donation model — workspace-shared workers are owned by --
    # the synthetic workspace actor (workspace:<id>). Migrate-and-break by
    # decision (2026-06-12): existing shared workers stop resolving their
    # sharer's personal secrets/connections; an admin re-binds workspace creds.
    """
    UPDATE workers
    SET owner_id = 'workspace:' || COALESCE(NULLIF(workspace_id, ''), 'local-default')
    WHERE visibility = 'workspace'
      AND owner_id IS NOT NULL
      AND owner_id NOT LIKE 'workspace:%';
    """,
    # -- migration 75: workspace API tokens (read+run access to shared workers)
    """
    CREATE TABLE IF NOT EXISTS workspace_api_tokens (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name         TEXT NOT NULL,
        token_hash   TEXT NOT NULL,
        created_by   TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_used_at TEXT,
        expires_at   TEXT,
        revoked_at   TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_api_tokens_hash
        ON workspace_api_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_workspace_api_tokens_workspace
        ON workspace_api_tokens(workspace_id);
    """,
    # -- migration 76: persisted per-run cost accounting (#793 spend cap, #795
    # approval cost-so-far). Populated at terminal status from the transcript
    # usage row; NULL = not yet computed / pure-script run with no LLM tokens.
    """
    ALTER TABLE runs ADD COLUMN total_tokens INTEGER;
    ALTER TABLE runs ADD COLUMN total_cost_usd REAL;
    CREATE INDEX IF NOT EXISTS idx_runs_worker_created ON runs(worker_id, created_at);
    """,
    # -- migration 77: approval cost-so-far snapshot (#795). Captured at
    # approval creation from the live transcript; estimate, surfaced on the
    # approval Run tab so the page needs no separate run fetch.
    """
    ALTER TABLE approvals ADD COLUMN tokens_so_far INTEGER;
    ALTER TABLE approvals ADD COLUMN cost_usd_so_far REAL;
    """,
    # -- migration 78: edit-access requests (#807). A member viewing a locked
    # (workspace-shared, not owned) worker can ask the owner/admin for edit
    # rights; the request is recorded (and the owner notified best-effort).
    """
    CREATE TABLE IF NOT EXISTS edit_access_requests (
        id           TEXT PRIMARY KEY,
        worker_id    TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        message      TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_req_pending
        ON edit_access_requests(worker_id, requester_id)
        WHERE status = 'pending';
    """,
    # -- migration 79: persistent workspace-export audit trail (#925). Every
    # full-workspace download is recorded (who/when/role) as a queryable row,
    # not just a log line, so exfiltration via a compromised admin session is
    # reviewable after the fact.
    """
    CREATE TABLE IF NOT EXISTS workspace_export_audit (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        role        TEXT,
        exported_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_export_audit_time
        ON workspace_export_audit(exported_at);
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
                        _execute_sql_script(conn, migration)
                    else:
                        migration(conn)
                except sqlite3.OperationalError as exc:
                    if i not in {3, 4, 6, 8, 15, 18, 20, 22, 27, 28, 30, 31, 33, 41, 42, 48, 50, 65, 71} or "duplicate column name" not in str(exc):
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
