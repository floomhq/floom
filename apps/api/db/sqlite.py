from __future__ import annotations

try:
    import fcntl as _fcntl_mod
    _LOCK_EX = _fcntl_mod.LOCK_EX
    _LOCK_UN = _fcntl_mod.LOCK_UN
except ImportError:
    class _fcntl_mod:  # type: ignore[no-redef]
        LOCK_EX = 1; LOCK_UN = 8
        @staticmethod
        def flock(fd, op): pass
    _LOCK_EX = 1
    _LOCK_UN = 8
import contextvars
import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from models import (
    RecentStats,
    RunStatus,
    TimeseriesDay,
    WorkerConfig,
    WorkerContract,
    parse_worker_manifest,
    worker_contract_to_worker_config,
)

from ._legacy_sqlite import _row_dict, get_db, now_iso


_SECRET_PREFIX = "__WORKEROS_SECRET__"
_FLOOM_USER_ID = "federico"

# Per-request batch caches — same pattern as supabase_repos.py in the cloud.
# Populated before per-worker loops; consumed by get_last_run() / get_recipe().
# ContextVar isolation ensures no cross-request contamination.
_last_run_batch: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "_workeros_last_run_batch", default=None
)
_recipe_cache: contextvars.ContextVar[dict[str, dict[str, Any] | None] | None] = contextvars.ContextVar(
    "_workeros_recipe_cache", default=None
)

# Per-asset visibility default. Private-by-default matches the Codex design
# (Notion/Drive convention) — automation assets that hold secrets must not be
# discoverable until the owner explicitly shares them.
_DEFAULT_VISIBILITY = "private"
_DEFAULT_RUN_LOG_LIMIT = 10_000
_DEFAULT_RUN_ARTIFACT_LIMIT = 1_000


def _bounded_positive_int(value: int | None, *, default: int, maximum: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if parsed <= 0:
        return default
    return min(parsed, maximum)


def _derive_workspace_id_local(owner_id: str | None) -> str:
    """Workspace id for an owner_id (``<base>__ws_<14hex>`` suffix, else default).

    Defined early so the worker INSERT paths can stamp workspace_id on create.
    Mirrors ``derive_workspace_id`` (defined later for external callers).
    """
    text = (owner_id or "").strip()
    match = re.search(r"__(ws_[a-f0-9]{14})$", text)
    return match.group(1) if match else "local-default"


def _normalize_visibility(value: Any) -> str:
    """Coerce a visibility input to a valid enum value, defaulting to private."""
    text = (str(value).strip().lower() if value is not None else "")
    return text if text in {"private", "workspace", "specific_people"} else _DEFAULT_VISIBILITY


def _legacy_source_relative_env_path() -> Path:
    """The historical, source-tree-relative secret env file (``apps/api/.env``).

    THIS PATH IS THE N4-1 BUG. Because it is resolved relative to this source
    file, two processes serving the SAME shared DB but running from different
    checkouts/deploy directories (e.g. ``/root/workeros`` vs
    ``/opt/workeros-live`` vs a ``/tmp`` worktree) resolve it to DIFFERENT
    files. A secret set by one process writes its value into that process's
    tree, while the DB row (anchored to the ABSOLUTE ``WORKEROS_DB``/``FLOOM_DB``
    path) is shared — so the secret reads back as "set" in the DB but its value
    is invisible (orphaned in the other tree's ``.env``), and every scheduled
    run fails ``missing_secret``.

    It is retained ONLY as a read-time fallback so secrets written before this
    fix are not lost. New writes go to ``secret_store_env_path()``.
    """
    return Path(__file__).resolve().parents[1] / ".env"


def _db_anchored_env_path() -> Path | None:
    """Stable secret env file co-located with the DB, deploy-dir-independent.

    The DB path (``WORKEROS_DB`` / ``FLOOM_DB``) is the one piece of state that
    is already shared across deploy directories. Anchoring the secret-value
    store to the SAME directory (``<db_dir>/secrets.env``) guarantees the write
    path and every run-time read path resolve to the same file regardless of
    which checkout the serving process runs from. Returns ``None`` when the DB
    path is not configured to an absolute location (pure local dev), so we fall
    back to the legacy source-relative file.
    """
    db_path = (
        os.environ.get("WORKEROS_DB")
        or os.environ.get("FLOOM_DB")
    )
    if not db_path:
        return None
    db_path_obj = Path(db_path)
    if not db_path_obj.is_absolute():
        return None
    return db_path_obj.resolve().parent / "secrets.env"


def secret_store_env_path() -> Path:
    """Canonical path to the env file that backs user-managed secret VALUES.

    Single source of truth for WHERE a secret value is written. Both the write
    path (``SqliteSecretRepository.set`` -> ``_upsert_env_var``) and the
    run-time read paths (manual / scheduled / webhook / composio, via
    ``get_secrets_for_worker``) resolve through here, so a secret set under the
    worker's owner is always found at run time.

    Resolution order:
      1. ``WORKEROS_API_ENV_FILE`` / ``FLOOM_API_ENV_FILE`` (explicit config /
         tests).
      2. ``<db_dir>/secrets.env`` — stable, co-located with the DB, immune to
         deploy-directory swaps (the N4-1 fix).
      3. ``apps/api/.env`` relative to this source file (local-dev default,
         only when no absolute DB path is configured).
    """
    configured = (
        os.environ.get("WORKEROS_API_ENV_FILE")
        or os.environ.get("FLOOM_API_ENV_FILE")
    )
    if configured:
        return Path(configured)
    anchored = _db_anchored_env_path()
    if anchored is not None:
        return anchored
    return _legacy_source_relative_env_path()


def secret_store_read_paths() -> list[Path]:
    """All env files consulted when READING a secret value, in priority order.

    The canonical write target comes first, then legacy locations so that
    values written before the N4-1 fix (orphaned in a prior deploy tree's
    ``apps/api/.env``) still resolve. De-duplicated, existing-files only.
    """
    candidates = [secret_store_env_path(), _legacy_source_relative_env_path()]
    seen: set[Path] = set()
    ordered: list[Path] = []
    for path in candidates:
        try:
            resolved = path.resolve()
        except OSError:
            resolved = path
        if resolved in seen:
            continue
        seen.add(resolved)
        ordered.append(path)
    return ordered


# Back-compat alias (kept so existing private callers don't break).
def _env_path() -> Path:
    return secret_store_env_path()


def _json_dump(value: Any) -> str:
    return json.dumps(value if value is not None else {}, separators=(",", ":"))


def _json_load(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    try:
        loaded = json.loads(value)
    except Exception:
        return default
    return loaded if isinstance(loaded, type(default)) else default


def _user_secret_key(user_id: str, name: str) -> str:
    if user_id == _FLOOM_USER_ID:
        return name
    safe_user = re.sub(r"[^A-Za-z0-9_]", "_", user_id).upper()
    return f"{_SECRET_PREFIX}_{safe_user}_{name}"


def _read_env_lines(path: Path | None = None) -> list[str]:
    """Read lines from a secret env file (defaults to the canonical write path)."""
    env_path = path if path is not None else _env_path()
    if not env_path.exists():
        return []
    return env_path.read_text().splitlines(keepends=True)


def _write_env_lines(lines: list[str]) -> None:
    env_path = _env_path()
    env_path.parent.mkdir(parents=True, exist_ok=True)
    with env_path.open("a+") as lock_fd:
        _fcntl_mod.flock(lock_fd, _LOCK_EX)
        try:
            env_path.write_text("".join(lines))
        finally:
            _fcntl_mod.flock(lock_fd, _LOCK_UN)


def _upsert_env_var(name: str, value: str) -> None:
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise ValueError("Secret value must not contain newline or control characters")
    lines = _read_env_lines()
    new_line = f"{name}={value}\n"
    replaced = False
    updated: list[str] = []
    for line in lines:
        stripped = line.rstrip("\n")
        if stripped.startswith(f"{name}=") or stripped == name:
            updated.append(new_line)
            replaced = True
        else:
            updated.append(line)
    if not replaced:
        if updated and not updated[-1].endswith("\n"):
            updated[-1] += "\n"
        updated.append(new_line)
    _write_env_lines(updated)
    os.environ[name] = value


def _delete_env_var(name: str) -> bool:
    lines = _read_env_lines()
    updated = [
        line
        for line in lines
        if not (line.rstrip("\n").startswith(f"{name}=") or line.rstrip("\n") == name)
    ]
    removed = len(updated) < len(lines)
    if removed:
        _write_env_lines(updated)
    os.environ.pop(name, None)
    return removed


def _read_env_var(name: str) -> str | None:
    value = os.environ.get(name)
    if value is not None:
        return value
    # Scan the canonical store first, then legacy locations, so secrets written
    # before the N4-1 fix (orphaned in a prior deploy tree's apps/api/.env)
    # still resolve. First match wins.
    for env_path in secret_store_read_paths():
        for line in _read_env_lines(env_path):
            stripped = line.rstrip("\n")
            if stripped.startswith(f"{name}="):
                return stripped.split("=", 1)[1]
    return None


def _build_env_lookup() -> dict[str, str]:
    """Parse all secret env files into a single dict (first match wins).

    Used by SqliteSecretRepository.list() to avoid re-reading the file N times.
    """
    result: dict[str, str] = {}
    for env_path in secret_store_read_paths():
        for line in _read_env_lines(env_path):
            stripped = line.rstrip("\n")
            if "=" in stripped and not stripped.startswith("#"):
                k, _, v = stripped.partition("=")
                result.setdefault(k, v)  # first file / first occurrence wins
    return result


def _skill_version_id(worker_id: str, manifest: dict[str, Any]) -> str:
    version = str(manifest.get("version") or "0.1.0").replace(".", "_").replace("-", "_")
    return f"sv_{worker_id}_{version}"


def _config_from_manifest(
    *,
    worker_id: str,
    manifest_json: str,
    trigger_type: str | None,
    cron_expr: str | None,
    cron_timezone: str | None,
    bundle_path: str | None,
) -> Optional[WorkerConfig]:
    manifest_raw = json.loads(manifest_json or "{}")
    parsed = parse_worker_manifest(manifest_raw)
    if isinstance(parsed, WorkerContract):
        config = worker_contract_to_worker_config(parsed, worker_id)
    else:
        config = parsed if isinstance(parsed, WorkerConfig) else WorkerConfig(**manifest_raw)
    if trigger_type:
        config.trigger.type = trigger_type
    if cron_expr:
        config.trigger.cron = cron_expr
    if cron_timezone:
        config.trigger.timezone = cron_timezone
    if config.runtime:
        config.runtime.bundle_path = bundle_path
    return config


def _config_from_manifest_row(row: sqlite3.Row) -> Optional[WorkerConfig]:
    return _config_from_manifest(
        worker_id=row["id"],
        manifest_json=row["manifest_json"] or "{}",
        trigger_type=row["trigger_type"],
        cron_expr=row["cron_expr"],
        cron_timezone=row["cron_timezone"],
        bundle_path=row["bundle_path"],
    )


def _worker_record_from_row(row: sqlite3.Row) -> dict[str, Any]:
    data = _row_dict(row)
    # Parse manifest_json once and reuse for both the WorkerConfig and the
    # raw manifest_dict — avoids a second json.loads on the same string.
    manifest_dict: dict[str, Any] = {}
    try:
        parsed = json.loads(data.get("manifest_json") or "{}")
        if isinstance(parsed, dict):
            manifest_dict = parsed
    except Exception:
        pass
    config = _config_from_manifest(
        worker_id=row["id"],
        manifest_json=json.dumps(manifest_dict),
        trigger_type=row["trigger_type"],
        cron_expr=row["cron_expr"],
        cron_timezone=row["cron_timezone"],
        bundle_path=row["bundle_path"],
    )
    return {
        "id": data["id"],
        "name": data["name"],
        "description": manifest_dict.get("description"),
        "long_description": manifest_dict.get("long_description"),
        "use_cases": manifest_dict.get("use_cases"),
        "example_input": manifest_dict.get("example_input"),
        "example_output": manifest_dict.get("example_output"),
        "how_it_works": manifest_dict.get("how_it_works"),
        "is_example": manifest_dict.get("is_example"),
        "archived": bool(manifest_dict.get("archived", False)),
        "archive_reason": manifest_dict.get("archive_reason"),
        "tags": manifest_dict.get("tags") or [],
        "folder": manifest_dict.get("folder"),
        "status": "healthy",
        "trigger_type": data.get("trigger_type") or (config.trigger.type if config else "manual"),
        "runner": config.runtime.runner if config and config.runtime else "e2b",
        "config": config.model_dump(mode="json") if config else {},
        "manifest": manifest_dict,
        "manifest_json": manifest_dict,
        "bundle_path": data.get("bundle_path"),
        "triggers_json": data.get("triggers_json"),
        "skill_version_id": data.get("skill_version_id"),
        "cron_expr": data.get("cron_expr"),
        "cron_timezone": data.get("cron_timezone"),
        "next_run_at": data.get("next_run_at"),
        "last_scheduled_run_at": data.get("last_scheduled_run_at"),
        "webhook_secret_hash": data.get("webhook_secret_hash"),
        "notify_email": bool(data.get("notify_email") or 0),
        "notify_webhook_url": data.get("notify_webhook_url"),
        "grants_json": _json_load(data.get("grants_json"), {}),
        "input_values_json": _json_load(data.get("input_values_json"), {}),
        "enabled": bool(data.get("enabled") or 0),
        "created_at": data.get("created_at"),
        "owner_id": data.get("owner_id") or _FLOOM_USER_ID,
        "workspace_id": data.get("workspace_id") or "local-default",
        "visibility": data.get("visibility") or "private",
        "composio_trigger_id": data.get("composio_trigger_id"),
        "composio_event": data.get("composio_event"),
    }


def _worker_select_sql(where_clause: str = "", limit_clause: str = "") -> str:
    return (
        """
        SELECT
            w.id,
            w.skill_version_id,
            w.name,
            w.trigger_type,
            w.cron_expr,
            w.cron_timezone,
            w.next_run_at,
            w.last_scheduled_run_at,
            w.webhook_secret_hash,
            w.notify_email,
            w.notify_webhook_url,
            w.grants_json,
            w.input_values_json,
            w.enabled,
            w.created_at,
            w.owner_id,
            w.workspace_id,
            w.visibility,
            w.composio_trigger_id,
            w.composio_event,
            w.triggers_json,
            sv.manifest_json,
            sv.bundle_path
        FROM workers w
        JOIN skill_versions sv ON sv.id = w.skill_version_id
        """
        + where_clause
        + " ORDER BY w.created_at, w.id "
        + limit_clause
    )


class SqliteWorkerRepository:
    def list(self, *, user_id: str, role: str | None = None) -> list[dict[str, Any]]:
        """List workers visible to the requesting user.

        role="admin"  — admin sees all workers regardless of owner.
        role="member" — member sees own workers + workspace-visibility workers.
        role=None     — legacy default: only workers owned by user_id (backwards compat).
        """
        with get_db() as conn:
            if role == "admin":
                rows = conn.execute(_worker_select_sql()).fetchall()
            elif role == "member":
                rows = conn.execute(
                    _worker_select_sql("WHERE w.owner_id = ? OR w.visibility = 'workspace'"),
                    (user_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    _worker_select_sql("WHERE w.owner_id = ?"),
                    (user_id,),
                ).fetchall()
        # Parse manifest_json once per row; share the result between the worker
        # record and the recipe cache to avoid a second json.loads per worker.
        cache: dict[str, dict[str, Any] | None] = {}
        records = []
        for row in rows:
            wid = str(row["id"])
            config = _config_from_manifest_row(row)
            # _worker_record_from_row also calls json.loads internally; supply the
            # already-parsed dict via a thin wrapper to avoid the duplicate parse.
            records.append(_worker_record_from_row(row))
            if config is not None:
                _mj = json.loads(row["manifest_json"] or "{}")
                cache[wid] = {
                    "config": config,
                    "grants": _json_load(row["grants_json"], {}),
                    "input_values": _json_load(row["input_values_json"], {}),
                    "enabled": bool(row["enabled"]),
                    "owner_id": row["owner_id"],
                    "bundle_path": row["bundle_path"],
                    "manifest_json": {k: v for k, v in _mj.items() if k != "_files"},
                }
            else:
                cache[wid] = None
        _recipe_cache.set(cache)
        return records

    def get(self, *, user_id: str, worker_id: str, role: str | None = None) -> dict[str, Any] | None:
        """Get a single worker, respecting visibility rules.

        role="admin"  — admin can fetch any worker by id.
        role="member" — member can fetch own or workspace-visible workers.
        role=None     — legacy default: only owner-scoped fetch (backwards compat).
        """
        with get_db() as conn:
            if role == "admin":
                row = conn.execute(
                    _worker_select_sql("WHERE w.id = ?", "LIMIT 1"),
                    (worker_id,),
                ).fetchone()
            elif role == "member":
                row = conn.execute(
                    _worker_select_sql(
                        "WHERE w.id = ? AND (w.owner_id = ? OR w.visibility = 'workspace')",
                        "LIMIT 1",
                    ),
                    (worker_id, user_id),
                ).fetchone()
            else:
                row = conn.execute(
                    _worker_select_sql("WHERE w.owner_id = ? AND w.id = ?", "LIMIT 1"),
                    (user_id, worker_id),
                ).fetchone()
        return _worker_record_from_row(row) if row else None

    def list_for_agent(
        self,
        *,
        user_id: str,
        include_all_users: bool = False,
        stock_worker_ids: Iterable[str] = (),
    ) -> list[dict[str, Any]]:
        """Workers visible to the workspace agent (Emily) — see WorkerRepository.

        #1027: moved verbatim from chat_service._tool_workers_list_all so the
        tool routes through the repo Protocol. *user_id* must already be the
        effective visibility user id; stock ids are passed in to avoid a
        db<-main import cycle.
        """
        all_stock_ids = [s for s in dict.fromkeys(stock_worker_ids) if s]
        base_select = (
            "SELECT w.id, w.name, w.trigger_type, w.enabled, w.owner_id, sv.manifest_json "
            "FROM workers w "
            "LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id "
        )
        with get_db() as conn:
            try:
                role_row = conn.execute(
                    "SELECT role FROM users WHERE id = ?", (user_id,)
                ).fetchone()
                is_admin = bool(role_row) and str(role_row["role"]).lower() == "admin"
            except Exception:
                is_admin = False
            if is_admin and include_all_users:
                rows = conn.execute(base_select + "ORDER BY w.name").fetchall()
            else:
                try:
                    has_members_table = bool(conn.execute(
                        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_members' LIMIT 1"
                    ).fetchone())
                except Exception:
                    has_members_table = False

                if has_members_table:
                    rows = conn.execute(
                        base_select
                        + "LEFT JOIN workspace_members wm "
                        + "  ON wm.workspace_id = COALESCE(w.workspace_id, 'local-default') "
                        + "  AND wm.user_id = ? AND wm.status = 'active' "
                        + "WHERE w.owner_id = ? "
                        + "OR (COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                        + "    AND wm.user_id IS NOT NULL) "
                        + "ORDER BY w.name",
                        (user_id, user_id),
                    ).fetchall()
                    if all_stock_ids:
                        seen_ids = {r["id"] for r in rows}
                        missing_stock = [sid for sid in all_stock_ids if sid not in seen_ids]
                        if missing_stock:
                            placeholders = ",".join("?" * len(missing_stock))
                            stock_rows = conn.execute(
                                base_select
                                + f"WHERE w.id IN ({placeholders}) ORDER BY w.name",
                                missing_stock,
                            ).fetchall()
                            rows = list(rows) + stock_rows
                else:
                    if all_stock_ids:
                        placeholders = ",".join("?" * len(all_stock_ids))
                        rows = conn.execute(
                            base_select
                            + "WHERE w.owner_id = ? "
                            + "OR COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                            + f"OR w.id IN ({placeholders}) "
                            + "ORDER BY w.name",
                            [user_id] + all_stock_ids,
                        ).fetchall()
                    else:
                        rows = conn.execute(
                            base_select
                            + "WHERE w.owner_id = ? "
                            + "OR COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                            + "ORDER BY w.name",
                            (user_id,),
                        ).fetchall()
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "trigger_type": r["trigger_type"],
                "enabled": bool(r["enabled"]),
                "manifest_json": r["manifest_json"],
            }
            for r in rows
        ]

    def get_for_agent(
        self,
        *,
        user_id: str,
        worker_id: str,
        stock_worker_ids: Iterable[str] = (),
        allow_fs_fallback: bool = False,
    ) -> dict[str, Any] | None:
        """Single agent-visible worker, gated by can-view — see WorkerRepository.

        #1027: moved verbatim from chat_service._tool_workers_get +
        _worker_can_view. *user_id* must already be the effective visibility user
        id; stock ids + allow_fs_fallback are passed in to avoid a db<-main
        import cycle.
        """
        import sqlite3 as _sqlite3

        stock_ids = set(stock_worker_ids)

        def _can_view(conn: Any) -> bool:
            # Stock/public workers are always accessible regardless of DB state.
            if worker_id in stock_ids:
                return True
            try:
                row = conn.execute(
                    "SELECT owner_id, workspace_id, visibility FROM workers WHERE id = ? LIMIT 1",
                    (worker_id,),
                ).fetchone()
            except _sqlite3.OperationalError:
                # DB not initialised / workers table absent — let the run path decide.
                return True
            if row is None:
                # No DB row — unregistered filesystem worker or unknown.
                return bool(allow_fs_fallback)
            if row["owner_id"] == user_id:
                return True
            # Admins may view every worker (mirrors role-aware /workers + list_all).
            try:
                role_row = conn.execute(
                    "SELECT role FROM users WHERE id = ? LIMIT 1", (user_id,)
                ).fetchone()
                if role_row and str(role_row["role"]).lower() == "admin":
                    return True
            except Exception:
                pass
            visibility = (row["visibility"] or "private").lower()
            if visibility not in ("workspace", "shared"):
                return False
            workspace_id = row["workspace_id"] or "local-default"
            try:
                member_row = conn.execute(
                    "SELECT 1 FROM workspace_members "
                    "WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
                    (workspace_id, user_id),
                ).fetchone()
            except Exception:
                return False
            return member_row is not None

        with get_db() as conn:
            if not _can_view(conn):
                return None
            row = conn.execute(
                """
                SELECT w.id, w.name, w.trigger_type, w.enabled, w.cron_expr,
                       sv.manifest_json
                FROM workers w
                LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
                WHERE w.id = ?
                """,
                (worker_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "trigger_type": row["trigger_type"],
            "enabled": bool(row["enabled"]),
            "cron_expr": row["cron_expr"],
            "manifest_json": row["manifest_json"],
        }

    def get_any(self, *, worker_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                _worker_select_sql("WHERE w.id = ?", "LIMIT 1"),
                (worker_id,),
            ).fetchone()
        return _worker_record_from_row(row) if row else None

    def create(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        worker_id = fields["worker_id"]
        manifest_json = fields.get("manifest_json") or {}
        if isinstance(manifest_json, str):
            manifest_json = json.loads(manifest_json or "{}")
        name = fields.get("name") or manifest_json.get("title") or manifest_json.get("name") or worker_id
        bundle_path = fields.get("bundle_path") or f"workers/{worker_id}"
        created_at = fields.get("created_at") or now_iso()
        skill_version_id = fields.get("skill_version_id") or _skill_version_id(worker_id, manifest_json)
        trigger_type = fields.get("trigger_type") or "manual"
        cron_expr = fields.get("cron_expr")
        cron_timezone = fields.get("cron_timezone")
        webhook_secret_hash = fields.get("webhook_secret_hash")
        notify_email = 1 if fields.get("notify_email") else 0
        notify_webhook_url = fields.get("notify_webhook_url")
        grants_json = fields.get("grants_json") or {}
        input_values_json = fields.get("input_values_json") or {}
        enabled = 1 if fields.get("enabled", True) else 0
        composio_trigger_id = fields.get("composio_trigger_id")
        composio_event = fields.get("composio_event")
        triggers_json = fields.get("triggers_json")
        manifest_str = _json_dump(manifest_json)
        version = str(manifest_json.get("version") or "0.1.0")

        with get_db() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO skill_versions
                    (id, name, version, manifest_json, bundle_path, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    skill_version_id,
                    manifest_json.get("name") or name,
                    version,
                    manifest_str,
                    bundle_path,
                    created_at,
                ),
            )
            conn.execute(
                """
                INSERT INTO workers
                    (id, skill_version_id, name, trigger_type, cron_expr, cron_timezone,
                     next_run_at, last_scheduled_run_at, webhook_secret_hash, notify_email,
                     notify_webhook_url, grants_json, input_values_json, enabled, created_at,
                     owner_id, workspace_id, visibility, composio_trigger_id, composio_event,
                     triggers_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    worker_id,
                    skill_version_id,
                    name,
                    trigger_type,
                    cron_expr,
                    cron_timezone,
                    fields.get("next_run_at"),
                    fields.get("last_scheduled_run_at"),
                    webhook_secret_hash,
                    notify_email,
                    notify_webhook_url,
                    _json_dump(grants_json),
                    _json_dump(input_values_json),
                    enabled,
                    created_at,
                    user_id,
                    fields.get("workspace_id") or _derive_workspace_id_local(user_id),
                    _normalize_visibility(fields.get("visibility")),
                    composio_trigger_id,
                    composio_event,
                    _json_dump(triggers_json) if triggers_json is not None else None,
                ),
            )
        created = self.get(user_id=user_id, worker_id=worker_id)
        if created is None:
            raise RuntimeError(f"failed to create worker {worker_id}")
        return created

    def upsert(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        """Insert-or-update a worker row from a discovered-worker dict.

        Matches the legacy _persist_discovered_workers SQL (INSERT OR
        REPLACE on skill_versions by (name, version); INSERT ON
        CONFLICT(id) DO UPDATE on workers). Idempotent across repeated
        discovery passes; safe to call multiple times for the same id.
        """
        worker_id = fields["worker_id"]
        manifest_json = fields.get("manifest_json") or {}
        if isinstance(manifest_json, str):
            manifest_json = json.loads(manifest_json or "{}")
        name = (
            fields.get("name")
            or manifest_json.get("title")
            or manifest_json.get("name")
            or worker_id
        )
        bundle_path = fields.get("bundle_path") or f"workers/{worker_id}"
        created_at = fields.get("created_at") or now_iso()
        skill_version_id = fields.get("skill_version_id") or _skill_version_id(
            worker_id, manifest_json
        )
        trigger_type = fields.get("trigger_type") or "manual"
        triggers_json = fields.get("triggers_json")
        manifest_str = _json_dump(manifest_json)
        version = str(manifest_json.get("version") or "0.1.0")

        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO skill_versions
                    (id, name, version, manifest_json, bundle_path, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(name, version) DO UPDATE SET
                    manifest_json=excluded.manifest_json,
                    bundle_path=excluded.bundle_path
                """,
                (
                    skill_version_id,
                    manifest_json.get("name") or name,
                    version,
                    manifest_str,
                    bundle_path,
                    created_at,
                ),
            )
            conn.execute(
                """
                INSERT INTO workers
                    (id, skill_version_id, name, trigger_type, cron_expr, cron_timezone,
                     next_run_at, last_scheduled_run_at, webhook_secret_hash, notify_email,
                     notify_webhook_url, grants_json, input_values_json, enabled, created_at,
                     owner_id, workspace_id, visibility, composio_trigger_id, composio_event,
                     triggers_json)
                VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    skill_version_id=excluded.skill_version_id,
                    name=excluded.name,
                    trigger_type=excluded.trigger_type,
                    cron_expr=excluded.cron_expr,
                    cron_timezone=excluded.cron_timezone,
                    owner_id=excluded.owner_id,
                    composio_trigger_id=excluded.composio_trigger_id,
                    composio_event=excluded.composio_event,
                    triggers_json=excluded.triggers_json
                """,
                (
                    worker_id,
                    skill_version_id,
                    name,
                    trigger_type,
                    fields.get("cron_expr"),
                    fields.get("cron_timezone"),
                    _json_dump(fields.get("grants_json") or {}),
                    _json_dump(fields.get("input_values_json") or {}),
                    created_at,
                    user_id,
                    fields.get("workspace_id") or _derive_workspace_id_local(user_id),
                    _normalize_visibility(fields.get("visibility")),
                    fields.get("composio_trigger_id"),
                    fields.get("composio_event"),
                    _json_dump(triggers_json) if triggers_json is not None else None,
                ),
            )
        upserted = self.get(user_id=user_id, worker_id=worker_id)
        if upserted is None:
            raise RuntimeError(f"failed to upsert worker {worker_id}")
        return upserted

    def update(self, *, user_id: str, worker_id: str, **fields: Any) -> dict[str, Any] | None:
        worker = self.get(user_id=user_id, worker_id=worker_id)
        if worker is None:
            return None

        manifest_json = fields.pop("manifest_json", None)
        bundle_path = fields.pop("bundle_path", None)
        if manifest_json is not None:
            if isinstance(manifest_json, str):
                manifest_json = json.loads(manifest_json or "{}")
            with get_db() as conn:
                conn.execute(
                    """
                    UPDATE skill_versions
                    SET manifest_json = ?, bundle_path = COALESCE(?, bundle_path)
                    WHERE id = ?
                    """,
                    (
                        _json_dump(manifest_json),
                        bundle_path,
                        worker["skill_version_id"],
                    ),
                )
        elif bundle_path is not None:
            with get_db() as conn:
                conn.execute(
                    "UPDATE skill_versions SET bundle_path = ? WHERE id = ?",
                    (bundle_path, worker["skill_version_id"]),
                )

        allowed = {
            "name",
            "trigger_type",
            "cron_expr",
            "cron_timezone",
            "next_run_at",
            "last_scheduled_run_at",
            "webhook_secret_hash",
            "notify_email",
            "notify_webhook_url",
            "grants_json",
            "input_values_json",
            "enabled",
            "composio_trigger_id",
            "composio_event",
            "triggers_json",
        }
        updates: list[str] = []
        params: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            updates.append(f"{key} = ?")
            if key in {"notify_email", "enabled"}:
                params.append(1 if value else 0)
            elif key in {"grants_json", "input_values_json", "triggers_json"} and value is not None:
                params.append(_json_dump(value))
            else:
                params.append(value)
        if updates:
            params.extend([worker_id, user_id])
            with get_db() as conn:
                conn.execute(
                    f"UPDATE workers SET {', '.join(updates)} WHERE id = ? AND owner_id = ?",
                    tuple(params),
                )
        return self.get(user_id=user_id, worker_id=worker_id)

    def delete(self, *, user_id: str, worker_id: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM workers WHERE id = ? AND owner_id = ?",
                (worker_id, user_id),
            )
            return cursor.rowcount > 0

    def list_recent_runs(self, *, user_id: str, worker_id: str, limit: int = 10) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT r.id, r.worker_id, r.status, r.trigger_source, r.created_at,
                       r.started_at, r.completed_at, r.duration_ms, r.error, r.error_code
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ? AND r.worker_id = ?
                ORDER BY r.created_at DESC
                LIMIT ?
                """,
                (user_id, worker_id, limit),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def get_last_run(self, *, user_id: str, worker_id: str) -> dict[str, Any] | None:
        batch = _last_run_batch.get()
        if batch is not None:
            return batch.get(worker_id)
        runs = self.list_recent_runs(user_id=user_id, worker_id=worker_id, limit=1)
        return runs[0] if runs else None

    def stats_batch(self, *, user_id: str, worker_ids: list[str], days: int = 7) -> dict[str, RecentStats]:
        if not worker_ids:
            # Do NOT set _last_run_batch — {} is not None so any later
            # get_last_run() would see a "populated" cache and return None
            # for every worker instead of falling back to the DB.
            return {}
        placeholders = ",".join("?" for _ in worker_ids)
        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    r.worker_id,
                    MAX(CASE WHEN r.created_at > datetime('now', '-{days} days') THEN r.created_at END) AS last_run_at,
                    SUM(CASE WHEN r.created_at > datetime('now', '-{days} days') THEN 1 ELSE 0 END) AS runs_{days}d,
                    SUM(CASE WHEN r.created_at > datetime('now', '-{days} days') AND r.status = 'completed' THEN 1 ELSE 0 END) AS completed_{days}d,
                    SUM(CASE WHEN r.created_at <= datetime('now', '-{days} days') THEN 1 ELSE 0 END) AS previous_runs_{days}d,
                    SUM(CASE WHEN r.created_at <= datetime('now', '-{days} days') AND r.status = 'completed' THEN 1 ELSE 0 END) AS previous_completed_{days}d
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ?
                  AND r.created_at > datetime('now', '-{days * 2} days')
                  AND r.worker_id IN ({placeholders})
                GROUP BY r.worker_id
                """,
                [user_id, *worker_ids],
            ).fetchall()
        result: dict[str, RecentStats] = {}
        for row in rows:
            data = _row_dict(row)
            runs = int(data[f"runs_{days}d"] or 0)
            completed = int(data[f"completed_{days}d"] or 0)
            previous_runs = int(data[f"previous_runs_{days}d"] or 0)
            previous_completed = int(data[f"previous_completed_{days}d"] or 0)
            current_rate = (completed / runs) if runs else None
            previous_rate = (previous_completed / previous_runs) if previous_runs else None
            result[data["worker_id"]] = RecentStats(
                last_run_at=data.get("last_run_at"),
                runs_7d=runs,
                success_rate_7d=current_rate,
                success_rate_change_7d=(current_rate - previous_rate)
                if current_rate is not None and previous_rate is not None
                else None,
            )
        # Batch-fetch the last run per worker (SQLite equivalent of DISTINCT ON).
        # Populate _last_run_batch so per-worker get_last_run() calls are cache hits.
        try:
            with get_db() as conn:
                last_run_rows = conn.execute(
                    f"""
                    SELECT r.*
                    FROM runs r
                    INNER JOIN (
                        SELECT worker_id, MAX(created_at) AS max_at
                        FROM runs
                        WHERE worker_id IN ({placeholders})
                        GROUP BY worker_id
                    ) latest ON r.worker_id = latest.worker_id AND r.created_at = latest.max_at
                    JOIN workers w ON w.id = r.worker_id
                    WHERE w.owner_id = ?
                    """,
                    [*worker_ids, user_id],
                ).fetchall()
            batch: dict[str, Any] = {wid: None for wid in worker_ids}
            seen: set[str] = set()
            for lr in last_run_rows:
                d = _row_dict(lr)
                wid = str(d.get("worker_id", ""))
                if wid and wid not in seen:
                    batch[wid] = d
                    seen.add(wid)
            _last_run_batch.set(batch)
        except Exception:
            pass  # Leave cache unpopulated; get_last_run() will fall back to DB
        return result

    def timeseries_batch(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        days: int = 14,
    ) -> dict[str, list[TimeseriesDay]]:
        if not worker_ids:
            return {}
        import datetime as _dt

        today = _dt.date.today()
        date_range = [(today - _dt.timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
        placeholders = ",".join("?" for _ in worker_ids)
        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    r.worker_id,
                    DATE(r.created_at) AS run_date,
                    COUNT(*) AS total,
                    SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed,
                    SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ?
                  AND r.created_at > datetime('now', '-{days} days')
                  AND r.worker_id IN ({placeholders})
                GROUP BY r.worker_id, DATE(r.created_at)
                """,
                [user_id, *worker_ids],
            ).fetchall()
        raw: dict[tuple[str, str], dict[str, Any]] = {
            (row["worker_id"], row["run_date"]): _row_dict(row)
            for row in rows
        }
        result: dict[str, list[TimeseriesDay]] = {}
        for worker_id in worker_ids:
            result[worker_id] = []
            for date_str in date_range:
                item = raw.get((worker_id, date_str))
                if item:
                    result[worker_id].append(
                        TimeseriesDay(
                            date=date_str,
                            total=int(item.get("total") or 0),
                            completed=int(item.get("completed") or 0),
                            failed=int(item.get("failed") or 0),
                        )
                    )
                else:
                    result[worker_id].append(TimeseriesDay(date=date_str, total=0, completed=0, failed=0))
        return result

    def get_owner(self, *, worker_id: str) -> str | None:
        with get_db() as conn:
            row = conn.execute(
                "SELECT owner_id FROM workers WHERE id = ?",
                (worker_id,),
            ).fetchone()
        return row["owner_id"] if row else None

    def list_scheduled(self) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT id, owner_id, cron_expr, cron_timezone, next_run_at
                FROM workers
                WHERE enabled = 1 AND trigger_type IN ('schedule', 'cron', 'scheduled')
                ORDER BY created_at, id
                """
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def get_schedule_state(self, *, worker_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                "SELECT owner_id, next_run_at, cron_expr, cron_timezone FROM workers WHERE id = ?",
                (worker_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def set_next_run_at(self, *, worker_id: str, next_run_at: str | None) -> None:
        with get_db() as conn:
            conn.execute(
                "UPDATE workers SET next_run_at = ? WHERE id = ?",
                (next_run_at, worker_id),
            )

    def mark_scheduled_run(self, *, worker_id: str, last_scheduled_run_at: str, next_run_at: str | None) -> None:
        with get_db() as conn:
            conn.execute(
                "UPDATE workers SET last_scheduled_run_at = ?, next_run_at = ? WHERE id = ?",
                (last_scheduled_run_at, next_run_at, worker_id),
            )

    def list_active_run_ids(self, *, user_id: str, worker_id: str) -> list[str]:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT r.id
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ?
                  AND r.worker_id = ?
                  AND r.status IN ('queued', 'running')
                ORDER BY r.created_at
                """,
                (user_id, worker_id),
            ).fetchall()
        return [row["id"] for row in rows]

    def get_skill_version_ref_count(self, *, skill_version_id: str | None) -> int:
        if not skill_version_id:
            return 0
        with get_db() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM workers WHERE skill_version_id = ?",
                (skill_version_id,),
            ).fetchone()
        return int(row["cnt"] or 0) if row else 0

    def delete_skill_version(self, *, skill_version_id: str) -> None:
        with get_db() as conn:
            conn.execute(
                "DELETE FROM skill_versions WHERE id = ?",
                (skill_version_id,),
            )

    def get_recipe(self, *, worker_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        cache = _recipe_cache.get()
        if cache is not None and worker_id in cache:
            # Cache hit — return what was pre-fetched by list().
            return cache[worker_id]
        # Cache miss (cache absent OR worker created after list() was called):
        # fall through to a direct DB query rather than returning None.
        where = "WHERE w.id = ?"
        params: list[Any] = [worker_id]
        if user_id is not None:
            where += " AND w.owner_id = ?"
            params.append(user_id)
        with get_db() as conn:
            row = conn.execute(
                f"""
                SELECT w.id, w.owner_id, w.trigger_type, w.cron_expr, w.cron_timezone,
                       w.grants_json, w.input_values_json, w.enabled,
                       sv.manifest_json, sv.bundle_path
                FROM workers w
                JOIN skill_versions sv ON sv.id = w.skill_version_id
                {where}
                LIMIT 1
                """,
                tuple(params),
            ).fetchone()
        if row is None:
            return None
        config = _config_from_manifest(
            worker_id=row["id"],
            manifest_json=row["manifest_json"] or "{}",
            trigger_type=row["trigger_type"],
            cron_expr=row["cron_expr"],
            cron_timezone=row["cron_timezone"],
            bundle_path=row["bundle_path"],
        )
        _mj = json.loads(row["manifest_json"] or "{}")
        return {
            "config": config,
            "grants": _json_load(row["grants_json"], {}),
            "input_values": _json_load(row["input_values_json"], {}),
            "enabled": bool(row["enabled"]),
            "owner_id": row["owner_id"],
            "bundle_path": row["bundle_path"],
            "manifest_json": {k: v for k, v in _mj.items() if k != "_files"},
        }

    def upsert_webhook_secret_hash(
        self,
        *,
        worker_id: str,
        secret_hash: str,
        created_at: str,
        rotated_at: str,
    ) -> None:
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO worker_webhook_secrets (worker_id, secret_hash, created_at, rotated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(worker_id) DO UPDATE SET
                    secret_hash = excluded.secret_hash,
                    rotated_at = excluded.rotated_at
                """,
                (worker_id, secret_hash, created_at, rotated_at),
            )
            conn.execute(
                "UPDATE workers SET webhook_secret_hash = ? WHERE id = ?",
                (secret_hash, worker_id),
            )

    def get_webhook_secret_hash(self, *, worker_id: str) -> str | None:
        with get_db() as conn:
            worker_row = conn.execute(
                "SELECT webhook_secret_hash FROM workers WHERE id = ?",
                (worker_id,),
            ).fetchone()
            if worker_row and worker_row["webhook_secret_hash"]:
                return worker_row["webhook_secret_hash"]
            row = conn.execute(
                "SELECT secret_hash FROM worker_webhook_secrets WHERE worker_id = ?",
                (worker_id,),
            ).fetchone()
        return row["secret_hash"] if row else None

    def delete_webhook_secret(self, *, worker_id: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM worker_webhook_secrets WHERE worker_id = ?",
                (worker_id,),
            )
            conn.execute(
                "UPDATE workers SET webhook_secret_hash = NULL WHERE id = ?",
                (worker_id,),
            )
            return cursor.rowcount > 0

    # -- worker_triggers (normalized multi-trigger rows) ---------------------

    @staticmethod
    def _trigger_config_for(trigger: dict[str, Any]) -> dict[str, Any]:
        """Strip the redundant ``type`` key; keep the per-trigger config payload."""
        return {k: v for k, v in trigger.items() if k != "type" and v is not None}

    @staticmethod
    def reconcile_triggers_conn(
        conn: sqlite3.Connection,
        *,
        worker_id: str,
        triggers: list[dict[str, Any]],
        external_trigger_id: str | None = None,
        enabled: bool = True,
    ) -> list[dict[str, Any]]:
        """Connection-bound reconcile used when a write transaction is already
        open (e.g. startup registration writes everything through one ``conn``
        to avoid a second-connection ``database is locked``)."""
        now = now_iso()
        kept_ids: list[str] = []
        existing = {
            row["id"]: _row_dict(row)
            for row in conn.execute(
                "SELECT * FROM worker_triggers WHERE worker_id = ?",
                (worker_id,),
            ).fetchall()
        }
        for position, trigger in enumerate(triggers):
            if not isinstance(trigger, dict):
                continue
            t_type = str(trigger.get("type") or "manual").strip().lower()
            if t_type in {"cron", "scheduled"}:
                t_type = "schedule"
            if t_type == "composio":
                t_type = "composio_event"
            trigger_id = f"trg_{worker_id}_{position}"
            kept_ids.append(trigger_id)
            config_json = json.dumps(SqliteWorkerRepository._trigger_config_for(trigger))
            ext_id = external_trigger_id if t_type == "composio_event" else None
            webhook_path = worker_id if t_type == "webhook" else None
            enabled_int = 1 if enabled else 0
            prior = existing.get(trigger_id)
            # Preserve next_run_at/last_fired_at across reconciles when the
            # schedule config is unchanged, so the scheduler slot is stable.
            next_run_at = None
            last_fired_at = None
            if prior:
                prior_config = prior.get("config_json")
                if t_type == "schedule" and prior_config == config_json:
                    next_run_at = prior.get("next_run_at")
                last_fired_at = prior.get("last_fired_at")
            conn.execute(
                """
                INSERT INTO worker_triggers
                    (id, worker_id, type, config_json, enabled, next_run_at,
                     external_trigger_id, webhook_path, last_fired_at, position,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    type=excluded.type,
                    config_json=excluded.config_json,
                    enabled=excluded.enabled,
                    next_run_at=excluded.next_run_at,
                    external_trigger_id=excluded.external_trigger_id,
                    webhook_path=excluded.webhook_path,
                    position=excluded.position,
                    updated_at=excluded.updated_at
                """,
                (
                    trigger_id,
                    worker_id,
                    t_type,
                    config_json,
                    enabled_int,
                    next_run_at,
                    ext_id,
                    webhook_path,
                    last_fired_at,
                    position,
                    (prior or {}).get("created_at") or now,
                    now,
                ),
            )
        # Delete rows for triggers that no longer exist.
        if kept_ids:
            placeholders = ",".join("?" for _ in kept_ids)
            conn.execute(
                f"DELETE FROM worker_triggers WHERE worker_id = ? AND id NOT IN ({placeholders})",
                (worker_id, *kept_ids),
            )
        else:
            conn.execute(
                "DELETE FROM worker_triggers WHERE worker_id = ?",
                (worker_id,),
            )
        return [
            _row_dict(row)
            for row in conn.execute(
                "SELECT * FROM worker_triggers WHERE worker_id = ? ORDER BY position, id",
                (worker_id,),
            ).fetchall()
        ]

    def reconcile_triggers(
        self,
        *,
        worker_id: str,
        triggers: list[dict[str, Any]],
        external_trigger_id: str | None = None,
        enabled: bool = True,
    ) -> list[dict[str, Any]]:
        """Sync worker_triggers rows to exactly match the declared triggers.

        One row per declared trigger. Row identity is stable across
        re-reconciliations (id = ``trg_<worker_id>_<position>``) so updating a
        worker's triggers in place updates the same rows instead of churning
        them, and a removed trigger deletes its row.

        ``external_trigger_id`` is the Composio registration id (a worker has at
        most one composio trigger today); it is stamped onto the composio row so
        an incoming event resolves back to the specific trigger.
        """
        with get_db() as conn:
            return self.reconcile_triggers_conn(
                conn,
                worker_id=worker_id,
                triggers=triggers,
                external_trigger_id=external_trigger_id,
                enabled=enabled,
            )

    def list_trigger_rows(self, *, worker_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM worker_triggers WHERE worker_id = ? ORDER BY position, id",
                (worker_id,),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def list_due_schedule_triggers(self, *, now_iso: str) -> list[dict[str, Any]]:
        """Return enabled schedule trigger rows (joined to an enabled worker).

        next_run_at filtering / due-comparison is done by the caller, since the
        scheduler also handles NULL next_run_at (uninitialized) rows.
        """
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT t.id, t.worker_id, t.config_json, t.next_run_at,
                       t.last_fired_at, w.owner_id, w.cron_timezone
                FROM worker_triggers t
                JOIN workers w ON w.id = t.worker_id
                WHERE t.type = 'schedule'
                  AND t.enabled = 1
                  AND w.enabled = 1
                ORDER BY t.worker_id, t.position, t.id
                """
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def set_trigger_next_run_at(self, *, trigger_id: str, next_run_at: str | None) -> None:
        with get_db() as conn:
            conn.execute(
                "UPDATE worker_triggers SET next_run_at = ?, updated_at = ? WHERE id = ?",
                (next_run_at, now_iso(), trigger_id),
            )

    def mark_trigger_fired(
        self,
        *,
        trigger_id: str,
        last_fired_at: str,
        next_run_at: str | None,
    ) -> None:
        with get_db() as conn:
            conn.execute(
                """
                UPDATE worker_triggers
                SET last_fired_at = ?, next_run_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (last_fired_at, next_run_at, now_iso(), trigger_id),
            )

    def find_trigger_by_external_id(self, *, external_trigger_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT * FROM worker_triggers
                WHERE external_trigger_id = ? AND enabled = 1
                LIMIT 1
                """,
                (external_trigger_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def find_trigger_for_webhook(self, *, worker_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT * FROM worker_triggers
                WHERE worker_id = ? AND type = 'webhook' AND enabled = 1
                ORDER BY position, id
                LIMIT 1
                """,
                (worker_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def count_schedule_trigger_rows(self) -> int:
        with get_db() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM worker_triggers WHERE type = 'schedule'"
            ).fetchone()
        return int(row["cnt"] or 0) if row else 0


class SqliteRunRepository:
    def list_for_worker(
        self,
        *,
        user_id: str,
        worker_id: str,
        limit: int,
        offset: int,
    ) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT r.id, r.worker_id, r.status, r.trigger_source, r.created_at,
                       r.started_at, r.completed_at, r.duration_ms, r.error, r.error_code
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ? AND r.worker_id = ?
                ORDER BY r.created_at DESC
                LIMIT ? OFFSET ?
                """,
                (user_id, worker_id, limit, offset),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def list(
        self,
        *,
        user_id: str,
        worker_id: str | None = None,
        statuses: list[str] | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        where = ["w.owner_id = ?"]
        params: list[Any] = [user_id]
        if worker_id:
            where.append("r.worker_id = ?")
            params.append(worker_id)
        if statuses:
            where.append(f"r.status IN ({', '.join('?' for _ in statuses)})")
            params.extend(statuses)
        if since:
            where.append("r.created_at >= ?")
            params.append(since)
        if until:
            where.append("r.created_at <= ?")
            params.append(until)
        where_sql = " AND ".join(where)
        select_sql = f"""
            SELECT r.id, r.worker_id,
                   COALESCE(JSON_EXTRACT(sv.manifest_json, '$.title'), w.name) AS worker_name,
                   r.status, r.trigger_source, r.created_at, r.started_at,
                   r.completed_at, r.duration_ms, r.error, r.error_code,
                   r.quality_warning
            FROM runs r
            JOIN workers w ON w.id = r.worker_id
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE {where_sql}
        """
        with get_db() as conn:
            total = conn.execute(
                f"SELECT COUNT(*) AS total FROM ({select_sql}) AS filtered_runs",
                tuple(params),
            ).fetchone()["total"]
            rows = conn.execute(
                f"{select_sql} ORDER BY r.created_at DESC LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
        return [_row_dict(row) for row in rows], int(total or 0)

    def get(self, *, user_id: str, run_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT r.id, r.worker_id,
                       COALESCE(JSON_EXTRACT(sv.manifest_json, '$.title'), w.name) AS worker_name,
                       r.status, r.trigger_source, r.runner, r.input_json, r.output_json,
                       r.error, r.error_code, r.started_at, r.completed_at, r.duration_ms, r.created_at,
                       r.cancel_requested, r.cancelled_at, r.bundle_snapshot_path,
                       r.quality_warning, r.trigger_ref
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
                WHERE w.owner_id = ? AND r.id = ?
                LIMIT 1
                """,
                (user_id, run_id),
            ).fetchone()
        return _row_dict(row) if row else None

    def get_any(self, *, run_id: str) -> dict[str, Any] | None:
        # UNSCOPED run lookup (no owner filter). Reserved for internal/capability
        # paths only: the sandbox→API composio-execute callback (run_id is the
        # capability) and background run-execution in run_service.py. NEVER use on
        # an operator-facing authed read path — those use get(user_id=...), which
        # enforces WHERE w.owner_id = ? via the workers JOIN.
        with get_db() as conn:
            row = conn.execute(
                "SELECT * FROM runs WHERE id = ? LIMIT 1",
                (run_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def create(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        worker_id = fields["worker_id"]
        run_id = fields["run_id"]
        with get_db() as conn:
            worker = conn.execute(
                "SELECT owner_id, visibility FROM workers WHERE id = ?",
                (worker_id,),
            ).fetchone()
            if worker is None:
                raise ValueError(f"worker {worker_id} not found")
            # Allow workspace-visible workers to be run by any authenticated user.
            # Non-workspace private workers can only be run by their owner.
            # When a non-owner runs a workspace worker, attribute the run to the
            # worker's owner so existing owner-scoped run queries keep working.
            if worker["owner_id"] == user_id:
                effective_user_id = user_id
            elif worker["visibility"] == "workspace":
                effective_user_id = worker["owner_id"]
            else:
                raise ValueError(f"worker {worker_id} does not belong to {user_id}")
            conn.execute(
                """
                INSERT INTO runs
                    (id, worker_id, status, trigger_source, runner, input_json, output_json,
                     approval_status, error, started_at, completed_at, duration_ms,
                     created_at, bundle_snapshot_path, quality_warning, trigger_ref)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    worker_id,
                    fields.get("status") or RunStatus.QUEUED.value,
                    fields.get("trigger_source") or "manual",
                    fields.get("runner") or "e2b",
                    _json_dump(fields.get("input_json") or fields.get("inputs") or {}),
                    _json_dump(fields.get("output_json") or {}),
                    fields.get("approval_status") or "not_required",
                    fields.get("error"),
                    fields.get("started_at"),
                    fields.get("completed_at"),
                    fields.get("duration_ms"),
                    fields.get("created_at") or now_iso(),
                    fields.get("bundle_snapshot_path"),
                    fields.get("quality_warning"),
                    fields.get("trigger_ref"),
                ),
            )
        created = self.get(user_id=effective_user_id, run_id=run_id)
        if created is None:
            raise RuntimeError(f"failed to create run {run_id}")
        return created

    def update(self, *, user_id: str, run_id: str, **fields: Any) -> dict[str, Any] | None:
        allowed = {
            "status",
            "trigger_source",
            "runner",
            "input_json",
            "output_json",
            "approval_status",
            "error",
            "error_code",
            "started_at",
            "completed_at",
            "duration_ms",
            "cancel_requested",
            "cancelled_at",
            "bundle_snapshot_path",
            "quality_warning",
            "trigger_ref",
        }
        updates: list[str] = []
        params: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            updates.append(f"{key} = ?")
            if key in {"input_json", "output_json"} and value is not None and not isinstance(value, str):
                params.append(_json_dump(value))
            else:
                params.append(value)
        if updates:
            params.extend([run_id, user_id])
            with get_db() as conn:
                conn.execute(
                    f"""
                    UPDATE runs
                    SET {', '.join(updates)}
                    WHERE id = ?
                      AND EXISTS (
                          SELECT 1 FROM workers
                          WHERE workers.id = runs.worker_id
                            AND workers.owner_id = ?
                      )
                    """,
                    tuple(params),
                )
        return self.get(user_id=user_id, run_id=run_id)

    def delete(self, *, user_id: str, run_id: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute(
                """
                DELETE FROM runs
                WHERE id = ?
                  AND EXISTS (
                      SELECT 1 FROM workers
                      WHERE workers.id = runs.worker_id
                        AND workers.owner_id = ?
                  )
                """,
                (run_id, user_id),
            )
            return cursor.rowcount > 0

    def set_input_json(self, *, user_id: str, run_id: str, input_json: dict[str, Any]) -> None:
        self.update(user_id=user_id, run_id=run_id, input_json=input_json)

    def update_status(
        self,
        *,
        user_id: str,
        run_id: str,
        status: str,
        output_json: dict[str, Any] | None = None,
        error: str | None = None,
        error_code: str | None = None,
    ) -> None:
        run = self.get(user_id=user_id, run_id=run_id)
        if run is None:
            raise ValueError(f"run {run_id} not found for {user_id}")
        updates: dict[str, Any] = {"status": status}
        if output_json is not None:
            updates["output_json"] = output_json
        if error is not None:
            updates["error"] = error
        if error_code is not None:
            updates["error_code"] = error_code
        if status == RunStatus.RUNNING.value:
            updates["started_at"] = now_iso()
        # PENDING_APPROVAL marks the END of execution: the worker ran, emitted a
        # decision_required, and halted to wait for the operator. Capture the real
        # execution duration NOW. Without this, the later approve/reject COMPLETED
        # transition would measure completed_at - started_at = execution time PLUS
        # the entire approval-wait (a HITL run-1 showed "28m" duration that was
        # mostly the operator thinking time). G5 rescore4 P2 (2026-05-29).
        if status == RunStatus.PENDING_APPROVAL.value and run.get("duration_ms") is None:
            started_at = run.get("started_at")
            if started_at:
                try:
                    import datetime as _dt

                    started = _dt.datetime.fromisoformat(started_at)
                    ended = _dt.datetime.fromisoformat(now_iso())
                    updates["duration_ms"] = int((ended - started).total_seconds() * 1000)
                except Exception:
                    pass
        if status in {RunStatus.COMPLETED.value, RunStatus.FAILED.value}:
            completed_at = now_iso()
            updates["completed_at"] = completed_at
            started_at = run.get("started_at")
            # Preserve a duration_ms already captured at PENDING_APPROVAL park time
            # — recomputing here would re-add the approval-wait. Only compute when
            # the run never parked for approval (the normal path).
            if started_at and run.get("duration_ms") is None:
                try:
                    import datetime as _dt

                    started = _dt.datetime.fromisoformat(started_at)
                    completed = _dt.datetime.fromisoformat(completed_at)
                    updates["duration_ms"] = int((completed - started).total_seconds() * 1000)
                except Exception:
                    pass
        self.update(user_id=user_id, run_id=run_id, **updates)

    def add_log(
        self,
        *,
        user_id: str,
        run_id: str,
        level: str,
        message: str,
        timestamp: str,
        trace_id: str | None = None,
    ) -> None:
        with get_db() as conn:
            cursor = conn.execute(
                """
                INSERT INTO logs (run_id, level, message, timestamp, trace_id)
                SELECT ?, ?, ?, ?, ?
                WHERE EXISTS (
                    SELECT 1
                    FROM runs r
                    JOIN workers w ON w.id = r.worker_id
                    WHERE r.id = ? AND w.owner_id = ?
                )
                """,
                (run_id, level, message, timestamp, trace_id, run_id, user_id),
            )
            if cursor.rowcount == 0:
                raise ValueError(f"run {run_id} not found for {user_id}")

    def list_logs(
        self,
        *,
        user_id: str,
        run_id: str,
        limit: int | None = _DEFAULT_RUN_LOG_LIMIT,
    ) -> list[dict[str, Any]]:
        bounded_limit = _bounded_positive_int(
            limit,
            default=_DEFAULT_RUN_LOG_LIMIT,
            maximum=_DEFAULT_RUN_LOG_LIMIT,
        )
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT l.level, l.message, l.timestamp, l.trace_id
                FROM logs l
                JOIN runs r ON r.id = l.run_id
                JOIN workers w ON w.id = r.worker_id
                WHERE l.run_id = ? AND w.owner_id = ?
                ORDER BY l.timestamp
                LIMIT ?
                """,
                (run_id, user_id, bounded_limit),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def list_logs_for_worker(
        self,
        *,
        user_id: str,
        worker_id: str,
        level: str | None = None,
        since: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """Cross-run logs for a worker, scoped to user_id, optionally filtered by level/since."""
        params: list[Any] = [user_id, worker_id]
        level_clause = ""
        since_clause = ""
        if level:
            level_clause = "AND l.level = ?"
            params.append(level)
        if since:
            since_clause = "AND l.timestamp >= ?"
            params.append(since)
        params.append(limit)
        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT l.level, l.message, l.timestamp, l.trace_id, l.run_id
                FROM logs l
                JOIN runs r ON r.id = l.run_id
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ? AND r.worker_id = ?
                  {level_clause} {since_clause}
                ORDER BY l.timestamp DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def add_artifact(
        self,
        *,
        user_id: str,
        run_id: str,
        artifact_id: str,
        name: str,
        artifact_type: str | None,
        path: str,
        size_bytes: int | None,
        created_at: str,
    ) -> None:
        with get_db() as conn:
            cursor = conn.execute(
                """
                INSERT INTO artifacts (id, run_id, name, type, path, size_bytes, created_at)
                SELECT ?, ?, ?, ?, ?, ?, ?
                WHERE EXISTS (
                    SELECT 1
                    FROM runs r
                    JOIN workers w ON w.id = r.worker_id
                    WHERE r.id = ? AND w.owner_id = ?
                )
                """,
                (artifact_id, run_id, name, artifact_type, path, size_bytes, created_at, run_id, user_id),
            )
            if cursor.rowcount == 0:
                raise ValueError(f"run {run_id} not found for {user_id}")

    def list_artifacts(
        self,
        *,
        user_id: str,
        run_id: str,
        limit: int | None = _DEFAULT_RUN_ARTIFACT_LIMIT,
    ) -> list[dict[str, Any]]:
        bounded_limit = _bounded_positive_int(
            limit,
            default=_DEFAULT_RUN_ARTIFACT_LIMIT,
            maximum=_DEFAULT_RUN_ARTIFACT_LIMIT,
        )
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT a.*
                FROM artifacts a
                JOIN runs r ON r.id = a.run_id
                JOIN workers w ON w.id = r.worker_id
                WHERE a.run_id = ? AND w.owner_id = ?
                ORDER BY a.created_at, a.name
                LIMIT ?
                """,
                (run_id, user_id, bounded_limit),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def clear_all(self, *, user_id: str) -> int:
        run_ids = [row["id"] for row in self.list_all_ids(user_id=user_id)]
        if not run_ids:
            return 0
        placeholders = ",".join("?" for _ in run_ids)
        with get_db() as conn:
            conn.execute(f"DELETE FROM artifacts WHERE run_id IN ({placeholders})", tuple(run_ids))
            conn.execute(f"DELETE FROM logs WHERE run_id IN ({placeholders})", tuple(run_ids))
            conn.execute(f"DELETE FROM runs WHERE id IN ({placeholders})", tuple(run_ids))
        return len(run_ids)

    def list_all_ids(self, *, user_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT r.id
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ?
                """,
                (user_id,),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def cancel(self, *, user_id: str, run_id: str, cancelled_at: str) -> dict[str, Any] | None:
        return self.update(
            user_id=user_id,
            run_id=run_id,
            cancel_requested=1,
            cancelled_at=cancelled_at,
        )

    def fail_running(self, *, user_id: str, error: str, error_code: str | None = None) -> list[str]:
        completed_at = now_iso()
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT r.id, r.started_at
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ? AND r.status = 'running'
                """,
                (user_id,),
            ).fetchall()
            if not rows:
                return []
            for row in rows:
                duration_ms = None
                started_at = row["started_at"]
                if started_at:
                    try:
                        import datetime as _dt

                        started = _dt.datetime.fromisoformat(started_at)
                        completed = _dt.datetime.fromisoformat(completed_at)
                        duration_ms = int((completed - started).total_seconds() * 1000)
                    except Exception:
                        duration_ms = None
                conn.execute(
                    """
                    UPDATE runs
                    SET status = ?, error = ?, error_code = ?, completed_at = ?, duration_ms = ?
                    WHERE id = ?
                    """,
                    (
                        RunStatus.FAILED.value,
                        error,
                        error_code,
                        completed_at,
                        duration_ms,
                        row["id"],
                    ),
                )
        return [row["id"] for row in rows]

    def fail_stale_running(
        self,
        *,
        cutoff_iso: str,
        exclude_run_ids: Iterable[str] = (),
        error: str,
        error_code: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fail abandoned running runs older than *cutoff_iso*.

        The status predicate is repeated in the UPDATE so a concurrently
        finishing run is not overwritten by the reaper after it leaves
        `running`.
        """
        completed_at = now_iso()
        excluded = [str(run_id) for run_id in exclude_run_ids if str(run_id)]
        exclude_clause = ""
        params: list[Any] = [cutoff_iso]
        if excluded:
            placeholders = ",".join("?" for _ in excluded)
            exclude_clause = f"AND r.id NOT IN ({placeholders})"
            params.extend(excluded)

        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT r.id, r.started_at, r.created_at, w.owner_id AS user_id
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE r.status = 'running'
                  AND COALESCE(r.started_at, r.created_at) < ?
                  {exclude_clause}
                ORDER BY COALESCE(r.started_at, r.created_at) ASC
                """,
                tuple(params),
            ).fetchall()
            failed: list[dict[str, Any]] = []
            for row in rows:
                started_at = row["started_at"] or row["created_at"]
                duration_ms = None
                if started_at:
                    try:
                        import datetime as _dt

                        started = _dt.datetime.fromisoformat(started_at)
                        completed = _dt.datetime.fromisoformat(completed_at)
                        duration_ms = int((completed - started).total_seconds() * 1000)
                    except Exception:
                        duration_ms = None
                cursor = conn.execute(
                    """
                    UPDATE runs
                    SET status = ?, error = ?, error_code = ?, completed_at = ?, duration_ms = ?
                    WHERE id = ? AND status = 'running'
                    """,
                    (
                        RunStatus.FAILED.value,
                        error,
                        error_code,
                        completed_at,
                        duration_ms,
                        row["id"],
                    ),
                )
                if cursor.rowcount:
                    failed.append(
                        {
                            "id": row["id"],
                            "run_id": row["id"],
                            "user_id": row["user_id"],
                            "started_at": row["started_at"],
                            "created_at": row["created_at"],
                            "completed_at": completed_at,
                        }
                    )
        return failed

    def fail_all_pending_approval(
        self,
        *,
        error: str,
        error_code: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fail ALL runs stuck in pending_approval.

        Called once on startup. Any pending_approval row at boot time has a
        dead in-process polling loop — there is no live executor to resume it.
        Unlike fail_stale_running (which uses a timeout+grace window), we fail
        all of them immediately because a server restart is definitive proof the
        loop is gone.
        """
        completed_at = now_iso()
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT r.id, r.started_at, r.created_at, w.owner_id AS user_id
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE r.status = 'pending_approval'
                ORDER BY COALESCE(r.started_at, r.created_at) ASC
                """,
            ).fetchall()
            failed: list[dict[str, Any]] = []
            for row in rows:
                started_at = row["started_at"] or row["created_at"]
                duration_ms = None
                if started_at:
                    try:
                        started = _dt.datetime.fromisoformat(started_at)
                        completed = _dt.datetime.fromisoformat(completed_at)
                        duration_ms = int((completed - started).total_seconds() * 1000)
                    except Exception:
                        duration_ms = None
                cursor = conn.execute(
                    """
                    UPDATE runs
                    SET status = ?, error = ?, error_code = ?, completed_at = ?, duration_ms = ?
                    WHERE id = ? AND status = 'pending_approval'
                    """,
                    (
                        RunStatus.FAILED.value,
                        error,
                        error_code,
                        completed_at,
                        duration_ms,
                        row["id"],
                    ),
                )
                if cursor.rowcount:
                    failed.append({
                        "id": row["id"],
                        "run_id": row["id"],
                        "user_id": row["user_id"],
                        "started_at": row["started_at"],
                        "created_at": row["created_at"],
                        "completed_at": completed_at,
                    })
        return failed

    def count_running_for_worker(self, *, user_id: str, worker_id: str) -> int:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS cnt
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ? AND r.worker_id = ? AND r.status = 'running'
                """,
                (user_id, worker_id),
            ).fetchone()
        return int(row["cnt"] or 0) if row else 0

    def set_bundle_snapshot_path(self, *, user_id: str, run_id: str, bundle_snapshot_path: str | None) -> None:
        self.update(user_id=user_id, run_id=run_id, bundle_snapshot_path=bundle_snapshot_path)

    def get_bundle_snapshot_path(self, *, user_id: str, run_id: str) -> str | None:
        run = self.get(user_id=user_id, run_id=run_id)
        return run.get("bundle_snapshot_path") if run else None

    def get_queued(self, *, limit: int = 50) -> list[dict[str, Any]]:
        """Return queued runs ordered by created_at (FIFO), up to *limit* rows.

        Used by the queue drain loop in run_service.  Returns only rows whose
        cancel_requested flag is 0 so that cancelled-before-dispatch runs are
        skipped automatically.
        """
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT r.id AS run_id, r.worker_id, r.input_json,
                       w.owner_id AS user_id
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE r.status = 'queued' AND (r.cancel_requested = 0 OR r.cancel_requested IS NULL)
                ORDER BY r.created_at ASC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def count_queued(self) -> int:
        """Return the number of pending queued runs (not yet cancelled)."""
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS cnt FROM runs
                WHERE status = 'queued' AND (cancel_requested = 0 OR cancel_requested IS NULL)
                """,
            ).fetchone()
        return int(row["cnt"] or 0) if row else 0


class SqliteConnectionRepository:
    _columns = """
        id, app_name, composio_connection_id, status, created_at, updated_at,
        scopes_json, account_label, display_name, last_checked_at, last_check_status, last_check_error, user_id,
        kind, mcp_label, mcp_url, mcp_transport, mcp_command, mcp_args_json, mcp_env_json, mcp_cwd,
        mcp_auth_secret, mcp_allowed_tools_json
    """

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT {self._columns}
                FROM composio_connections
                WHERE user_id = ?
                ORDER BY kind, app_name
                """,
                (user_id,),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def get(self, *, user_id: str, composio_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                f"""
                SELECT {self._columns}
                FROM composio_connections
                WHERE user_id = ? AND id = ?
                LIMIT 1
                """,
                (user_id, composio_id),
            ).fetchone()
        return _row_dict(row) if row else None

    def get_by_composio_connection_id(self, *, composio_connection_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                f"""
                SELECT {self._columns}
                FROM composio_connections
                WHERE composio_connection_id = ?
                LIMIT 1
                """,
                (composio_connection_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def find_by_app_account(
        self,
        *,
        user_id: str,
        app_name: str,
        account_label: str,
        exclude_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Return the canonical composio connection for an (app, account) pair.

        Dedupe key for N5-1: reconnecting the SAME app + SAME account (by
        normalized account_label, e.g. the Gmail address) must reuse the
        existing row rather than spawning a duplicate. Returns the OLDEST
        matching row (the canonical one) so repeated reconnects always merge
        into a single, stable connection id. ``exclude_id`` skips the freshly
        created reconnect row so it is never matched against itself.
        """
        label = (account_label or "").strip().lower()
        if not label:
            return None
        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT {self._columns}
                FROM composio_connections
                WHERE user_id = ?
                  AND LOWER(app_name) = LOWER(?)
                  AND (kind IS NULL OR kind = 'composio')
                  AND LOWER(TRIM(COALESCE(account_label, ''))) = ?
                ORDER BY created_at ASC, id ASC
                """,
                (user_id, app_name, label),
            ).fetchall()
        for row in rows:
            record = _row_dict(row)
            if exclude_id is not None and record.get("id") == exclude_id:
                continue
            return record
        return None

    def upsert(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        connection_id = fields["id"]
        app_name = fields["app_name"]
        composio_connection_id = fields["composio_connection_id"]
        status = fields.get("status") or "initiated"
        created_at = fields.get("created_at") or now_iso()
        updated_at = fields.get("updated_at") or created_at
        scopes_json = fields.get("scopes_json")
        account_label = fields.get("account_label")
        display_name = fields.get("display_name")
        last_checked_at = fields.get("last_checked_at")
        last_check_status = fields.get("last_check_status")
        last_check_error = fields.get("last_check_error")
        kind = fields.get("kind") or "composio"
        mcp_label = fields.get("mcp_label")
        mcp_url = fields.get("mcp_url")
        mcp_transport = fields.get("mcp_transport") or "streamable_http"
        mcp_command = fields.get("mcp_command")
        mcp_args_json = fields.get("mcp_args_json")
        mcp_env_json = fields.get("mcp_env_json")
        mcp_cwd = fields.get("mcp_cwd")
        mcp_auth_secret = fields.get("mcp_auth_secret")
        mcp_allowed_tools_json = fields.get("mcp_allowed_tools_json")
        if mcp_args_json is not None and not isinstance(mcp_args_json, str):
            mcp_args_json = _json_dump(mcp_args_json)
        if mcp_env_json is not None and not isinstance(mcp_env_json, str):
            mcp_env_json = _json_dump(mcp_env_json)
        if mcp_allowed_tools_json is not None and not isinstance(mcp_allowed_tools_json, str):
            mcp_allowed_tools_json = _json_dump(mcp_allowed_tools_json)
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO composio_connections
                    (id, app_name, composio_connection_id, status, created_at, updated_at,
                     scopes_json, account_label, display_name, last_checked_at, last_check_status, last_check_error, user_id,
                     kind, mcp_label, mcp_url, mcp_transport, mcp_command, mcp_args_json, mcp_env_json, mcp_cwd,
                     mcp_auth_secret, mcp_allowed_tools_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    app_name = excluded.app_name,
                    composio_connection_id = excluded.composio_connection_id,
                    status = excluded.status,
                    updated_at = excluded.updated_at,
                    scopes_json = excluded.scopes_json,
                    account_label = excluded.account_label,
                    display_name = excluded.display_name,
                    last_checked_at = excluded.last_checked_at,
                    last_check_status = excluded.last_check_status,
                    last_check_error = excluded.last_check_error,
                    user_id = excluded.user_id,
                    kind = excluded.kind,
                    mcp_label = excluded.mcp_label,
                    mcp_url = excluded.mcp_url,
                    mcp_transport = excluded.mcp_transport,
                    mcp_command = excluded.mcp_command,
                    mcp_args_json = excluded.mcp_args_json,
                    mcp_env_json = excluded.mcp_env_json,
                    mcp_cwd = excluded.mcp_cwd,
                    mcp_auth_secret = excluded.mcp_auth_secret,
                    mcp_allowed_tools_json = excluded.mcp_allowed_tools_json
                """,
                (
                    connection_id,
                    app_name,
                    composio_connection_id,
                    status,
                    created_at,
                    updated_at,
                    scopes_json,
                    account_label,
                    display_name,
                    last_checked_at,
                    last_check_status,
                    last_check_error,
                    user_id,
                    kind,
                    mcp_label,
                    mcp_url,
                    mcp_transport,
                    mcp_command,
                    mcp_args_json,
                    mcp_env_json,
                    mcp_cwd,
                    mcp_auth_secret,
                    mcp_allowed_tools_json,
                ),
            )
        item = self.get(user_id=user_id, composio_id=connection_id)
        if item is None:
            raise RuntimeError(f"failed to upsert connection {connection_id}")
        return item

    def update(self, *, user_id: str, composio_id: str, **fields: Any) -> dict[str, Any] | None:
        allowed = {
            "app_name",
            "composio_connection_id",
            "status",
            "updated_at",
            "scopes_json",
            "account_label",
            "display_name",
            "last_checked_at",
            "last_check_status",
            "last_check_error",
            "kind",
            "mcp_label",
            "mcp_url",
            "mcp_transport",
            "mcp_command",
            "mcp_args_json",
            "mcp_env_json",
            "mcp_cwd",
            "mcp_auth_secret",
            "mcp_allowed_tools_json",
        }
        updates: list[str] = []
        params: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            updates.append(f"{key} = ?")
            if key in {"scopes_json", "mcp_args_json", "mcp_env_json", "mcp_allowed_tools_json"} and value is not None and not isinstance(value, str):
                params.append(_json_dump(value))
            else:
                params.append(value)
        if updates:
            params.extend([composio_id, user_id])
            with get_db() as conn:
                conn.execute(
                    f"UPDATE composio_connections SET {', '.join(updates)} WHERE id = ? AND user_id = ?",
                    tuple(params),
                )
        return self.get(user_id=user_id, composio_id=composio_id)

    def delete(self, *, user_id: str, composio_id: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM composio_connections WHERE id = ? AND user_id = ?",
                (composio_id, user_id),
            )
            return cursor.rowcount > 0

    def list_all(self) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT {self._columns}
                FROM composio_connections
                ORDER BY created_at, id
                """
            ).fetchall()
        return [_row_dict(row) for row in rows]


class SqliteSecretRepository:
    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT user_id, name, status, last_used_at, created_at, updated_at,
                       last_checked_at, last_check_status, last_check_error
                FROM secrets
                WHERE user_id = ?
                ORDER BY name
                """,
                (user_id,),
            ).fetchall()
        items = [_row_dict(row) for row in rows]
        # Read env files once and resolve all values from the resulting dict —
        # avoids re-reading the file for every secret.
        env_lookup = _build_env_lookup()
        for item in items:
            env_key = _user_secret_key(user_id, item["name"])
            # Use `is not None` so an intentionally-empty string value "" is
            # preserved rather than falling through to the file-based lookup.
            _env_val = os.environ.get(env_key)
            item["value"] = _env_val if _env_val is not None else env_lookup.get(env_key)
        return items

    def get(self, *, user_id: str, name: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT user_id, name, status, last_used_at, created_at, updated_at,
                       last_checked_at, last_check_status, last_check_error
                FROM secrets
                WHERE user_id = ? AND name = ?
                LIMIT 1
                """,
                (user_id, name),
            ).fetchone()
        if row is None:
            return None
        item = _row_dict(row)
        item["value"] = self.read_value(user_id=user_id, name=name)
        return item

    def set(self, *, user_id: str, name: str, value: str, status: str = "set") -> dict[str, Any]:
        env_key = _user_secret_key(user_id, name)
        _upsert_env_var(env_key, value)
        created_at = now_iso()
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO secrets
                    (user_id, name, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id, name) DO UPDATE SET
                    status = excluded.status,
                    updated_at = excluded.updated_at
                """,
                (user_id, name, status, created_at, created_at),
            )
        item = self.get(user_id=user_id, name=name)
        if item is None:
            raise RuntimeError(f"failed to set secret {name}")
        return item

    def delete(self, *, user_id: str, name: str) -> bool:
        removed = _delete_env_var(_user_secret_key(user_id, name))
        with get_db() as conn:
            conn.execute(
                "DELETE FROM secrets WHERE user_id = ? AND name = ?",
                (user_id, name),
            )
        return removed

    def read_value(self, *, user_id: str, name: str) -> str | None:
        env_key = _user_secret_key(user_id, name)
        return _read_env_var(env_key)

    def list_names(self, *, user_id: str) -> set[str]:
        return {item["name"] for item in self.list(user_id=user_id)}

    def resolve(self, *, user_id: str, names: Iterable[str]) -> dict[str, str]:
        secrets: dict[str, str] = {}
        for name in names:
            value = self.read_value(user_id=user_id, name=name)
            if value:
                secrets[name] = value
        return secrets


class SqliteCliAuthRepository:
    def create_device(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        device_code = fields["device_code"]
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO cli_auth_devices
                    (device_code, user_id, user_code, status, secret, client_name,
                     scopes_json, created_ip, created_at, expires_at, approved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    device_code,
                    user_id,
                    fields["user_code"],
                    fields.get("status") or "pending",
                    fields.get("secret"),
                    fields["client_name"],
                    _json_dump(fields.get("scopes") or []),
                    fields.get("created_ip"),
                    fields["created_at"],
                    fields["expires_at"],
                    fields.get("approved_at"),
                ),
            )
        item = self.get(user_id=user_id, device_code=device_code)
        if item is None:
            raise RuntimeError(f"failed to create cli auth device {device_code}")
        return item

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT device_code, user_id, user_code, status, secret, client_name,
                       scopes_json, created_ip, created_at, expires_at, approved_at
                FROM cli_auth_devices
                WHERE user_id = ?
                ORDER BY created_at, device_code
                """,
                (user_id,),
            ).fetchall()
        result = []
        for row in rows:
            data = _row_dict(row)
            data["scopes"] = _json_load(data.pop("scopes_json", None), [])
            result.append(data)
        return result

    def get(self, *, user_id: str, device_code: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT device_code, user_id, user_code, status, secret, client_name,
                       scopes_json, created_ip, created_at, expires_at, approved_at
                FROM cli_auth_devices
                WHERE user_id = ? AND device_code = ?
                LIMIT 1
                """,
                (user_id, device_code),
            ).fetchone()
        if row is None:
            return None
        data = _row_dict(row)
        data["scopes"] = _json_load(data.pop("scopes_json", None), [])
        return data

    def get_by_device_code(self, device_code: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT device_code, user_id, user_code, status, secret, client_name,
                       scopes_json, created_ip, created_at, expires_at, approved_at
                FROM cli_auth_devices
                WHERE device_code = ?
                LIMIT 1
                """,
                (device_code,),
            ).fetchone()
        if row is None:
            return None
        data = _row_dict(row)
        data["scopes"] = _json_load(data.pop("scopes_json", None), [])
        return data

    def verify_device(self, code: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT device_code, user_id, user_code, status, secret, client_name,
                       scopes_json, created_ip, created_at, expires_at, approved_at
                FROM cli_auth_devices
                WHERE user_code = ?
                LIMIT 1
                """,
                (code.strip().upper(),),
            ).fetchone()
        if row is None:
            return None
        data = _row_dict(row)
        data["scopes"] = _json_load(data.pop("scopes_json", None), [])
        return data

    def update(self, *, device_code: str, **fields: Any) -> dict[str, Any] | None:
        allowed = {"user_code", "status", "secret", "client_name", "scopes_json", "created_ip", "created_at", "expires_at", "approved_at"}
        updates: list[str] = []
        params: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            updates.append(f"{key} = ?")
            if key == "scopes_json" and value is not None and not isinstance(value, str):
                params.append(_json_dump(value))
            else:
                params.append(value)
        if updates:
            params.append(device_code)
            with get_db() as conn:
                conn.execute(
                    f"UPDATE cli_auth_devices SET {', '.join(updates)} WHERE device_code = ?",
                    tuple(params),
                )
        record = self.get_by_device_code(device_code)
        return record

    def consume(self, code: str) -> dict[str, Any] | None:
        record = self.get_by_device_code(code)
        if record is None:
            return None
        with get_db() as conn:
            conn.execute(
                "DELETE FROM cli_auth_devices WHERE device_code = ?",
                (code,),
            )
        return record

    def delete(self, *, device_code: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM cli_auth_devices WHERE device_code = ?",
                (device_code,),
            )
            return cursor.rowcount > 0

    def prune_expired(self, *, now_ts: float) -> list[str]:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT device_code FROM cli_auth_devices WHERE expires_at <= ?",
                (now_ts,),
            ).fetchall()
            expired = [row["device_code"] for row in rows]
            if expired:
                conn.execute(
                    f"DELETE FROM cli_auth_devices WHERE device_code IN ({', '.join('?' for _ in expired)})",
                    tuple(expired),
                )
        return expired


class SqliteApprovalRepository:
    """SQLite-backed approval repository for S47 HITL."""

    def create(self, *, owner_id: str, **fields: Any) -> dict[str, Any]:
        allowed = {
            "id", "run_id", "worker_id", "status", "label", "preview",
            "created_at", "decided_at", "reason",
            "decision_input_json", "edited_output_json", "follow_up_run_id",
            "annotations_json",
            "expires_at",  # #798
            "preview_type", "preview_payload_json",  # #792
            "tokens_so_far", "cost_usd_so_far",  # #795
        }
        cols = list(allowed & fields.keys())
        cols_str = ", ".join(cols + ["owner_id"])
        placeholders = ", ".join("?" for _ in cols) + ", ?"
        values = [fields[c] for c in cols] + [owner_id]
        with get_db() as conn:
            conn.execute(
                f"INSERT INTO approvals ({cols_str}) VALUES ({placeholders})",
                tuple(values),
            )
        return self.get(owner_id=owner_id, approval_id=fields["id"])  # type: ignore[return-value]

    def get(self, *, owner_id: str, approval_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                "SELECT * FROM approvals WHERE id = ? AND owner_id = ?",
                (approval_id, owner_id),
            ).fetchone()
        return _row_dict(row) if row else None

    def get_public(self, *, approval_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT a.*, w.name AS worker_name
                FROM approvals a
                LEFT JOIN workers w ON w.id = a.worker_id
                WHERE a.id = ?
                LIMIT 1
                """,
                (approval_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def get_by_run_id(self, *, run_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                "SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
                (run_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def list_pending(self, *, owner_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT a.*, w.name AS worker_name
                FROM approvals a
                LEFT JOIN workers w ON w.id = a.worker_id
                WHERE a.owner_id = ? AND a.status = 'pending'
                ORDER BY a.created_at ASC
                """,
                (owner_id,),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def count_pending(self, *, owner_id: str) -> int:
        with get_db() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM approvals WHERE owner_id = ? AND status = 'pending'",
                (owner_id,),
            ).fetchone()
        return int(row["cnt"] or 0) if row else 0

    def approve(
        self,
        *,
        owner_id: str,
        run_id: str,
        decided_at: str,
        approval_id: str | None = None,
        edited_output_json: str | None = None,
        follow_up_run_id: str | None = None,
        annotations_json: str | None = None,
        reason: str | None = None,
    ) -> dict[str, Any] | None:
        # approval_id filter prevents bulk-approving all pending rows for a run
        # when multiple sequential request_approval() calls are in flight.
        # #769: reason is the reviewer's plain-text approve comment (distinct
        # from structured annotations); stored in the same column reject uses.
        id_clause = "AND id = ?" if approval_id is not None else ""
        params: tuple[Any, ...] = (
            decided_at, edited_output_json, follow_up_run_id, annotations_json, reason,
            run_id, owner_id,
            *((approval_id,) if approval_id is not None else ()),
        )
        with get_db() as conn:
            conn.execute(
                f"""
                UPDATE approvals
                SET status = 'approved',
                    decided_at = ?,
                    edited_output_json = ?,
                    follow_up_run_id = ?,
                    annotations_json = COALESCE(?, annotations_json),
                    reason = COALESCE(?, reason)
                WHERE run_id = ? AND owner_id = ? AND status = 'pending'
                {id_clause}
                """,
                params,
            )
        if approval_id is not None:
            return self.get(owner_id=owner_id, approval_id=approval_id)
        return self.get_by_run_id(run_id=run_id)

    def reject(
        self,
        *,
        owner_id: str,
        run_id: str,
        decided_at: str,
        approval_id: str | None = None,
        reason: str | None = None,
        annotations_json: str | None = None,
    ) -> dict[str, Any] | None:
        id_clause = "AND id = ?" if approval_id is not None else ""
        params: tuple[Any, ...] = (
            decided_at, reason, annotations_json,
            run_id, owner_id,
            *((approval_id,) if approval_id is not None else ()),
        )
        with get_db() as conn:
            conn.execute(
                f"""
                UPDATE approvals
                SET status = 'rejected',
                    decided_at = ?,
                    reason = ?,
                    annotations_json = COALESCE(?, annotations_json)
                WHERE run_id = ? AND owner_id = ? AND status = 'pending'
                {id_clause}
                """,
                params,
            )
        if approval_id is not None:
            return self.get(owner_id=owner_id, approval_id=approval_id)
        return self.get_by_run_id(run_id=run_id)




class SqliteAlertRepository:
    """SQLite implementation of AlertRepository for webhook alert registrations."""

    def add(
        self,
        *,
        alert_id: str,
        worker_id: str,
        url: str | None,
        email_to: str | None,
        events: str,
        description: str | None,
        created_at: str,
    ) -> dict[str, Any]:
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO worker_alerts (id, worker_id, url, email_to, events, description, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (alert_id, worker_id, url, email_to, events, description, created_at),
            )
        return self.get(alert_id=alert_id) or {}

    def list(self, *, worker_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, worker_id, url, email_to, events, description, created_at FROM worker_alerts WHERE worker_id = ? ORDER BY created_at",
                (worker_id,),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def get(self, *, alert_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, worker_id, url, email_to, events, description, created_at FROM worker_alerts WHERE id = ?",
                (alert_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def delete(self, *, alert_id: str, worker_id: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM worker_alerts WHERE id = ? AND worker_id = ?",
                (alert_id, worker_id),
            )
        return cursor.rowcount > 0


class SqliteFeedbackRepository:
    """SQLite implementation of FeedbackRepository (per-worker feedback comments)."""

    _cols = "id, worker_id, author_id, author_name, content, created_at"

    def add(
        self,
        *,
        feedback_id: str,
        worker_id: str,
        author_id: str,
        author_name: str | None,
        content: str,
        created_at: str,
    ) -> dict[str, Any]:
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO worker_feedback (id, worker_id, author_id, author_name, content, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (feedback_id, worker_id, author_id, author_name, content, created_at),
            )
        return self.get(feedback_id=feedback_id) or {}

    def list(self, *, worker_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                f"SELECT {self._cols} FROM worker_feedback WHERE worker_id = ? ORDER BY created_at",
                (worker_id,),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def get(self, *, feedback_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                f"SELECT {self._cols} FROM worker_feedback WHERE id = ?",
                (feedback_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def delete(self, *, feedback_id: str, worker_id: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM worker_feedback WHERE id = ? AND worker_id = ?",
                (feedback_id, worker_id),
            )
        return cursor.rowcount > 0


class SqliteMcpToolRepository:
    _cols = "id, user_id, name, description, input_schema, worker_id, created_at, updated_at"

    def _deserialize(self, row: dict[str, Any]) -> dict[str, Any]:
        row["input_schema"] = json.loads(row.get("input_schema") or "{}")
        return row

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                f"SELECT {self._cols} FROM mcp_tools WHERE user_id = ? ORDER BY created_at",
                (user_id,),
            ).fetchall()
        return [self._deserialize(_row_dict(r)) for r in rows]

    def get(self, *, user_id: str, tool_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                f"SELECT {self._cols} FROM mcp_tools WHERE user_id = ? AND id = ? LIMIT 1",
                (user_id, tool_id),
            ).fetchone()
        return self._deserialize(_row_dict(row)) if row else None

    def get_by_name(self, *, user_id: str, name: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                f"SELECT {self._cols} FROM mcp_tools WHERE user_id = ? AND name = ? LIMIT 1",
                (user_id, name),
            ).fetchone()
        return self._deserialize(_row_dict(row)) if row else None

    def create(
        self,
        *,
        user_id: str,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        worker_id: str,
    ) -> dict[str, Any]:
        tool_id = str(uuid.uuid4())
        now = now_iso()
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO mcp_tools
                    (id, user_id, name, description, input_schema, worker_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (tool_id, user_id, name, description, json.dumps(input_schema), worker_id, now, now),
            )
        item = self.get(user_id=user_id, tool_id=tool_id)
        if item is None:
            raise RuntimeError(f"failed to create mcp_tool {name!r}")
        return item

    def update(self, *, user_id: str, tool_id: str, **fields: Any) -> dict[str, Any] | None:
        existing = self.get(user_id=user_id, tool_id=tool_id)
        if existing is None:
            return None
        updates: dict[str, Any] = {}
        for key in ("name", "description", "worker_id"):
            if key in fields and fields[key] is not None:
                updates[key] = fields[key]
        if "input_schema" in fields and fields["input_schema"] is not None:
            updates["input_schema"] = json.dumps(fields["input_schema"])
        if not updates:
            return existing
        updates["updated_at"] = now_iso()
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        with get_db() as conn:
            conn.execute(
                f"UPDATE mcp_tools SET {set_clause} WHERE user_id = ? AND id = ?",
                [*updates.values(), user_id, tool_id],
            )
        return self.get(user_id=user_id, tool_id=tool_id)

    def delete(self, *, user_id: str, tool_id: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM mcp_tools WHERE user_id = ? AND id = ?",
                (user_id, tool_id),
            )
        return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# Members + per-asset visibility (Members STEP 1)
# ---------------------------------------------------------------------------

# Allowed enum values. ``specific_people`` is reserved (hidden in UI) until the
# asset_grants table ships in a later step.
VISIBILITY_VALUES: frozenset[str] = frozenset({"private", "workspace", "specific_people"})
MEMBER_ROLES: frozenset[str] = frozenset({"owner", "admin", "member"})
_ASSET_TABLES: dict[str, str] = {
    "worker": "workers",
    "brain_pack": "brain_packs",
    "assistant": "assistants",
}


WORKSPACE_ACTOR_PREFIX = "workspace:"


def workspace_actor_id(workspace_id: str | None) -> str:
    """Synthetic principal that owns workspace-shared assets (donation model).

    Never a login: no session, password, or PAT can authenticate as it directly.
    Workspace-shared workers are owned by it, workspace secrets/connections are
    stored under it, and the workspace API token authenticates as it (member
    role). Because no human is ever ``is_owner`` of its assets, edit/delete on
    shared workers structurally reduces to admin-only.
    """
    ws = (workspace_id or "").strip() or "local-default"
    return f"{WORKSPACE_ACTOR_PREFIX}{ws}"


def is_workspace_actor(user_id: str | None) -> bool:
    return bool(user_id) and str(user_id).startswith(WORKSPACE_ACTOR_PREFIX)


def derive_workspace_id(owner_id: str | None) -> str:
    """Workspace id for an engine owner_id (mirrors the migration helper).

    owner_id is the per-workspace scoped user_id: the base user under the default
    workspace, or ``<base>__ws_<14hex>`` under a non-default local workspace. The
    workspace is the suffix when present, else ``local-default``.
    """
    text = (owner_id or "").strip()
    match = re.search(r"__(ws_[a-f0-9]{14})$", text)
    return match.group(1) if match else "local-default"


def assistant_row_id(workspace_id: str) -> str:
    """Stable per-workspace assistant row id (one assistant per workspace).

    Mirrors ``_legacy_sqlite._assistant_row_id`` so the lazily-upserted row and
    the migration backfill row collide on the same id (idempotent).
    """
    ws = (workspace_id or "local-default").strip() or "local-default"
    return f"workspace-agent:{ws}"


class SqliteWorkspaceMemberRepository:
    """Single-owner-degenerate WorkspaceMemberRepository for the OSS engine.

    On the OSS engine each workspace has exactly one active owner (the local
    user). ``list`` returns that one owner row; mutations that don't apply to a
    single-owner workspace (invite/set_role/remove others) are no-ops or raise so
    the same API surface renders identically to Cloud without forking the UI.
    """

    _cols = (
        "workspace_id, user_id, email, display_name, role, status, "
        "invited_by, created_at, updated_at"
    )

    def list(self, *, workspace_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT {self._cols} FROM workspace_members
                WHERE workspace_id = ? AND status != 'removed'
                ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                         created_at
                """,
                (workspace_id,),
            ).fetchall()
        return [_row_dict(r) for r in rows]

    def get(self, *, workspace_id: str, user_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                f"SELECT {self._cols} FROM workspace_members "
                "WHERE workspace_id = ? AND user_id = ? LIMIT 1",
                (workspace_id, user_id),
            ).fetchone()
        return _row_dict(row) if row else None

    def _owner(self, conn: sqlite3.Connection, workspace_id: str) -> sqlite3.Row | None:
        return conn.execute(
            "SELECT user_id FROM workspace_members "
            "WHERE workspace_id = ? AND role = 'owner' AND status = 'active' LIMIT 1",
            (workspace_id,),
        ).fetchone()

    def _assert_owner_or_admin(self, conn: sqlite3.Connection, workspace_id: str, actor_id: str) -> str:
        row = conn.execute(
            "SELECT role FROM workspace_members "
            "WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
            (workspace_id, actor_id),
        ).fetchone()
        role = row["role"] if row else None
        if role not in {"owner", "admin"}:
            raise PermissionError("actor is not an owner or admin of this workspace")
        return role

    def invite(self, *, workspace_id: str, email: str, role: str, invited_by: str) -> dict[str, Any]:
        if role not in MEMBER_ROLES:
            raise ValueError(f"invalid role {role!r}")
        if role == "owner":
            raise ValueError("cannot invite a second owner; use transfer_owner")
        now = now_iso()
        # user_id is unknown until the invitee accepts; on the OSS engine we key
        # the invited row by the email so the row is unique and acceptable later.
        user_id = f"invite:{email.strip().lower()}"
        with get_db() as conn:
            self._assert_owner_or_admin(conn, workspace_id, invited_by)
            conn.execute(
                """
                INSERT INTO workspace_members
                    (workspace_id, user_id, email, display_name, role, status,
                     invited_by, created_at, updated_at)
                VALUES (?, ?, ?, NULL, ?, 'invited', ?, ?, ?)
                ON CONFLICT(workspace_id, user_id) DO UPDATE SET
                    role = excluded.role, status = 'invited',
                    invited_by = excluded.invited_by, updated_at = excluded.updated_at
                """,
                (workspace_id, user_id, email.strip(), role, invited_by, now, now),
            )
        member = self.get(workspace_id=workspace_id, user_id=user_id)
        if member is None:
            raise RuntimeError("failed to invite member")
        return member

    def set_role(self, *, workspace_id: str, actor_id: str, user_id: str, role: str) -> dict[str, Any] | None:
        if role not in MEMBER_ROLES or role == "owner":
            raise ValueError("set_role only supports 'admin' or 'member'; use transfer_owner for owner")
        with get_db() as conn:
            owner = self._owner(conn, workspace_id)
            if owner is None or owner["user_id"] != actor_id:
                raise PermissionError("only the workspace owner can change roles")
            if user_id == actor_id:
                raise ValueError("owner cannot change their own role; use transfer_owner")
            cursor = conn.execute(
                "UPDATE workspace_members SET role = ?, updated_at = ? "
                "WHERE workspace_id = ? AND user_id = ? AND role != 'owner'",
                (role, now_iso(), workspace_id, user_id),
            )
            if cursor.rowcount == 0:
                return None
        return self.get(workspace_id=workspace_id, user_id=user_id)

    def remove(self, *, workspace_id: str, actor_id: str, user_id: str) -> bool:
        with get_db() as conn:
            actor_role = self._assert_owner_or_admin(conn, workspace_id, actor_id)
            target = conn.execute(
                "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? LIMIT 1",
                (workspace_id, user_id),
            ).fetchone()
            if target is None:
                return False
            if target["role"] == "owner":
                raise PermissionError("cannot remove the workspace owner; transfer ownership first")
            if actor_role == "admin" and target["role"] == "admin":
                raise PermissionError("admins can only remove members, not other admins")
            cursor = conn.execute(
                "UPDATE workspace_members SET status = 'removed', updated_at = ? "
                "WHERE workspace_id = ? AND user_id = ?",
                (now_iso(), workspace_id, user_id),
            )
        return cursor.rowcount > 0

    def transfer_owner(self, *, workspace_id: str, actor_id: str, new_owner_id: str) -> dict[str, Any]:
        with get_db() as conn:
            owner = self._owner(conn, workspace_id)
            if owner is None or owner["user_id"] != actor_id:
                raise PermissionError("only the current owner can transfer ownership")
            target = conn.execute(
                "SELECT user_id FROM workspace_members "
                "WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
                (workspace_id, new_owner_id),
            ).fetchone()
            if target is None:
                raise ValueError("new owner must be an active member of the workspace")
            now = now_iso()
            # Demote current owner to admin, then promote the target. The partial
            # unique index forbids two active owners, so demote first.
            conn.execute(
                "UPDATE workspace_members SET role = 'admin', updated_at = ? "
                "WHERE workspace_id = ? AND user_id = ?",
                (now, workspace_id, actor_id),
            )
            conn.execute(
                "UPDATE workspace_members SET role = 'owner', updated_at = ? "
                "WHERE workspace_id = ? AND user_id = ?",
                (now, workspace_id, new_owner_id),
            )
        member = self.get(workspace_id=workspace_id, user_id=new_owner_id)
        if member is None:
            raise RuntimeError("failed to transfer ownership")
        return member


class SqliteAssetAccessRepository:
    """Per-asset visibility + computed permission resolution for the OSS engine.

    ``get_permissions`` combines the asset's owner_id + visibility with the
    requesting user's workspace role. The OSS single-owner case: the local user
    is the owner of their own assets, so every permission is granted; a private
    asset they do not own is invisible (no permissions). The same logic is the
    multi-member-correct rule, so Cloud's RLS mirrors it without a fork.
    """

    def _asset_row(self, conn: sqlite3.Connection, asset_type: str, asset_id: str) -> sqlite3.Row | None:
        table = _ASSET_TABLES.get(asset_type)
        if table is None:
            raise ValueError(f"unsupported asset_type {asset_type!r}")
        return conn.execute(
            f"SELECT id, owner_id, workspace_id, visibility FROM {table} WHERE id = ? LIMIT 1",
            (asset_id,),
        ).fetchone()

    def ensure_brain_pack(
        self,
        *,
        pack_id: str,
        workspace_id: str,
        owner_id: str,
        name: str | None = None,
        default_visibility: str = "private",
    ) -> dict[str, Any]:
        """Lazily upsert the access-control mirror row for a brain pack.

        Brain packs are filesystem dirs; their owner lives in the per-workspace
        ``.workeros-contexts.json``. The first time the API needs visibility for a
        pack it calls this so a row exists for ``get_permissions``/``set_visibility``.
        Idempotent: never downgrades an existing visibility, only refreshes
        owner/name/workspace. Returns the current row.
        """
        if default_visibility not in VISIBILITY_VALUES:
            default_visibility = "private"
        now = now_iso()
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO brain_packs
                    (id, workspace_id, owner_id, visibility, name,
                     metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, '{}', ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    owner_id = excluded.owner_id,
                    name = excluded.name,
                    updated_at = excluded.updated_at
                """,
                (
                    pack_id,
                    workspace_id,
                    owner_id,
                    default_visibility,
                    name or pack_id,
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "SELECT id, owner_id, workspace_id, visibility FROM brain_packs WHERE id = ?",
                (pack_id,),
            ).fetchone()
        return _row_dict(row) if row else {}

    def ensure_assistant(
        self,
        *,
        assistant_id: str,
        workspace_id: str,
        owner_id: str,
        name: str = "Workspace assistant",
        default_visibility: str = "workspace",
    ) -> dict[str, Any]:
        """Lazily upsert the access-control mirror row for the workspace assistant.

        The assistant is a single shared workspace tool (``workspace`` default).
        Idempotent: never downgrades visibility; refreshes owner/workspace/name.
        """
        if default_visibility not in VISIBILITY_VALUES:
            default_visibility = "workspace"
        now = now_iso()
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO assistants
                    (id, workspace_id, owner_id, visibility, name,
                     config_json, instructions_md, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, '{}', NULL, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    owner_id = excluded.owner_id,
                    name = excluded.name,
                    updated_at = excluded.updated_at
                """,
                (
                    assistant_id,
                    workspace_id,
                    owner_id,
                    default_visibility,
                    name,
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "SELECT id, owner_id, workspace_id, visibility FROM assistants WHERE id = ?",
                (assistant_id,),
            ).fetchone()
        return _row_dict(row) if row else {}

    def _role(self, conn: sqlite3.Connection, workspace_id: str, user_id: str) -> str | None:
        # The synthetic workspace actor is implicitly a MEMBER of its own
        # workspace (and only its own): it can view/run workspace-shared
        # assets but is never owner or admin, so it can never edit, delete,
        # or share. Powers the workspace API token.
        if user_id == workspace_actor_id(workspace_id):
            return "member"
        row = conn.execute(
            "SELECT role FROM workspace_members "
            "WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
            (workspace_id, user_id),
        ).fetchone()
        return row["role"] if row else None

    @staticmethod
    def _compute(
        *, owner_id: str | None, visibility: str, role: str | None, user_id: str
    ) -> dict[str, Any]:
        is_owner = bool(owner_id) and owner_id == user_id
        is_admin = role in {"owner", "admin"}
        is_member = role in {"owner", "admin", "member"}
        shared = visibility == "workspace"
        # Discoverability gate: a private asset is visible only to its owner.
        can_view = is_owner or (shared and is_member)
        return {
            "owner_id": owner_id,
            "visibility": visibility,
            "is_owner": is_owner,
            "role": role,
            "can_view": can_view,
            # Owner edits/deletes/shares their own asset; an owner/admin may also
            # edit/delete a workspace-shared asset owned by someone else.
            "can_edit": is_owner or (shared and is_admin),
            "can_delete": is_owner or (shared and is_admin),
            "can_run": can_view,
            "can_share": is_owner or is_admin,
        }

    def get_permissions(
        self, *, workspace_id: str, user_id: str, asset_type: str, asset_id: str
    ) -> dict[str, Any]:
        with get_db() as conn:
            asset = self._asset_row(conn, asset_type, asset_id)
            if asset is None:
                return self._compute(owner_id=None, visibility="private", role=None, user_id=user_id)
            role = self._role(conn, asset["workspace_id"] or workspace_id, user_id)
        visibility = asset["visibility"] or "private"
        return self._compute(
            owner_id=asset["owner_id"], visibility=visibility, role=role, user_id=user_id
        )

    def set_visibility(
        self,
        *,
        workspace_id: str,
        actor_id: str,
        asset_type: str,
        asset_id: str,
        visibility: str,
        actor_role: str | None = None,
    ) -> dict[str, Any] | None:
        if visibility not in VISIBILITY_VALUES:
            raise ValueError(f"invalid visibility {visibility!r}")
        table = _ASSET_TABLES.get(asset_type)
        if table is None:
            raise ValueError(f"unsupported asset_type {asset_type!r}")
        with get_db() as conn:
            asset = self._asset_row(conn, asset_type, asset_id)
            if asset is None:
                return None
            # actor_role: callers with an authenticated role (e.g. the engine
            # bootstrap admin, who has no workspace_members row) pass it
            # explicitly; otherwise resolve from the members table.
            role = actor_role or self._role(conn, asset["workspace_id"] or workspace_id, actor_id)
            perms = self._compute(
                owner_id=asset["owner_id"],
                visibility=asset["visibility"] or "private",
                role=role,
                user_id=actor_id,
            )
            if not perms["can_share"]:
                raise PermissionError("only the asset owner or a workspace admin can change visibility")
            conn.execute(
                f"UPDATE {table} SET visibility = ? WHERE id = ?",
                (visibility, asset_id),
            )
            # Donation model (workers only): sharing TRANSFERS ownership to the
            # synthetic workspace actor — the sharer loses edit (no human is
            # is_owner), and run-time secrets/connections resolve against the
            # workspace actor's rows (admin-populated), never personal creds.
            # Unshare (workspace -> private) re-assigns to the acting admin;
            # can_share already restricts that transition to admins because
            # the workspace actor is the owner and never authenticates.
            if asset_type == "worker":
                ws = str(asset["workspace_id"] or workspace_id or "local-default")
                current_owner = asset["owner_id"]
                if visibility == "workspace" and not is_workspace_actor(current_owner):
                    conn.execute(
                        f"UPDATE {table} SET owner_id = ? WHERE id = ?",
                        (workspace_actor_id(ws), asset_id),
                    )
                elif visibility != "workspace" and is_workspace_actor(current_owner):
                    conn.execute(
                        f"UPDATE {table} SET owner_id = ? WHERE id = ?",
                        (actor_id, asset_id),
                    )
        return self.get_permissions(
            workspace_id=workspace_id, user_id=actor_id, asset_type=asset_type, asset_id=asset_id
        )

    def transfer_asset_owner(
        self, *, workspace_id: str, actor_id: str, asset_type: str, asset_id: str, new_owner_id: str
    ) -> dict[str, Any] | None:
        table = _ASSET_TABLES.get(asset_type)
        if table is None:
            raise ValueError(f"unsupported asset_type {asset_type!r}")
        with get_db() as conn:
            asset = self._asset_row(conn, asset_type, asset_id)
            if asset is None:
                return None
            role = self._role(conn, asset["workspace_id"] or workspace_id, actor_id)
            is_owner = asset["owner_id"] == actor_id
            if not (is_owner or role in {"owner", "admin"}):
                raise PermissionError("only the asset owner or a workspace admin can transfer the asset")
            conn.execute(
                f"UPDATE {table} SET owner_id = ? WHERE id = ?",
                (new_owner_id, asset_id),
            )
        return self.get_permissions(
            workspace_id=workspace_id, user_id=actor_id, asset_type=asset_type, asset_id=asset_id
        )


# ---------------------------------------------------------------------------
# Multi-member: users, sessions, personal access tokens (migration 59)
# ---------------------------------------------------------------------------


class SqliteUserRepository:
    """Local user accounts — created via POST /auth/setup or POST /users (admin)."""

    def count(self) -> int:
        with get_db() as conn:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()
        return int(row["cnt"] or 0) if row else 0

    def create(
        self,
        *,
        user_id: str,
        username: str,
        display_name: str | None,
        password_hash: str,
        role: str,
    ) -> dict[str, Any]:
        created_at = now_iso()
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 0, ?, ?)
                """,
                (user_id, username, display_name, password_hash, role, created_at, created_at),
            )
        result = self.get(user_id=user_id)
        if result is None:
            raise RuntimeError(f"failed to create user {user_id}")
        return result

    def get(self, *, user_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, username, display_name, role, disabled, created_at, updated_at FROM users WHERE id = ? LIMIT 1",
                (user_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def get_by_username(self, *, username: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, username, display_name, password_hash, role, disabled, created_at, updated_at FROM users WHERE username = ? LIMIT 1",
                (username,),
            ).fetchone()
        return _row_dict(row) if row else None

    def list(self) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, username, display_name, role, disabled, created_at, updated_at FROM users ORDER BY created_at, id"
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def update(self, *, user_id: str, **fields: Any) -> dict[str, Any] | None:
        allowed = {"display_name", "password_hash", "role", "disabled"}
        updates: list[str] = []
        params: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            updates.append(f"{key} = ?")
            params.append(value)
        if updates:
            updates.append("updated_at = ?")
            params.append(now_iso())
            params.append(user_id)
            with get_db() as conn:
                conn.execute(
                    f"UPDATE users SET {', '.join(updates)} WHERE id = ?",
                    tuple(params),
                )
        return self.get(user_id=user_id)

    def delete(self, *, user_id: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        return cursor.rowcount > 0


class SqlitePersonalAccessTokenRepository:
    """Per-user PATs for API/MCP access — token values are never stored, only their SHA-256 hash."""

    def create(
        self,
        *,
        token_id: str,
        user_id: str,
        name: str,
        token_hash: str,
        expires_at: str | None,
    ) -> dict[str, Any]:
        created_at = now_iso()
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO personal_access_tokens (id, user_id, name, token_hash, last_used_at, created_at, expires_at)
                VALUES (?, ?, ?, ?, NULL, ?, ?)
                """,
                (token_id, user_id, name, token_hash, created_at, expires_at),
            )
        return self._get(token_id=token_id)

    def _get(self, *, token_id: str) -> dict[str, Any]:
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, user_id, name, last_used_at, created_at, expires_at FROM personal_access_tokens WHERE id = ? LIMIT 1",
                (token_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError(f"PAT {token_id} not found after insert")
        return _row_dict(row)

    def get_by_hash(self, *, token_hash: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT p.id, p.user_id, p.name, p.last_used_at, p.created_at, p.expires_at,
                       u.username, u.role, u.disabled
                FROM personal_access_tokens p
                JOIN users u ON u.id = p.user_id
                WHERE p.token_hash = ? LIMIT 1
                """,
                (token_hash,),
            ).fetchone()
        return _row_dict(row) if row else None

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, user_id, name, last_used_at, created_at, expires_at FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at DESC",
                (user_id,),
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def delete(self, *, token_id: str, user_id: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM personal_access_tokens WHERE id = ? AND user_id = ?",
                (token_id, user_id),
            )
        return cursor.rowcount > 0

    def touch_last_used(self, *, token_id: str, last_used_at: str) -> None:
        with get_db() as conn:
            conn.execute(
                "UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?",
                (last_used_at, token_id),
            )

    def rotate(self, *, token_id: str, user_id: str, token_hash: str) -> dict[str, Any] | None:
        # #784: replace the secret hash in place, keeping the same token row
        # (id/name/created_at/expires_at) and clearing last_used_at.
        with get_db() as conn:
            cursor = conn.execute(
                "UPDATE personal_access_tokens SET token_hash = ?, last_used_at = NULL "
                "WHERE id = ? AND user_id = ?",
                (token_hash, token_id, user_id),
            )
            if cursor.rowcount == 0:
                return None
            row = conn.execute(
                "SELECT id, user_id, name, last_used_at, created_at, expires_at "
                "FROM personal_access_tokens WHERE id = ?",
                (token_id,),
            ).fetchone()
        return _row_dict(row) if row else None


class SqliteUserSessionRepository:
    """Server-side sessions for cookie-based auth — each session is a random UUID."""

    def create(self, *, session_id: str, user_id: str, expires_at: str) -> dict[str, Any]:
        # #848 RCA: login/magic-link checked user.disabled and then inserted the
        # session in a separate statement — a user disabled between the two
        # steps (TOCTOU) could still obtain a valid session. Fix: guard the
        # INSERT on the user being enabled in the same statement, making the
        # check and the insert atomic. Raises ValueError when no row inserted.
        created_at = now_iso()
        with get_db() as conn:
            cursor = conn.execute(
                """
                INSERT INTO user_sessions (id, user_id, expires_at, created_at)
                SELECT ?, id, ?, ? FROM users WHERE id = ? AND disabled = 0
                """,
                (session_id, expires_at, created_at, user_id),
            )
            if cursor.rowcount == 0:
                raise ValueError("cannot create session: user is disabled or does not exist")
        return {"id": session_id, "user_id": user_id, "expires_at": expires_at, "created_at": created_at}

    def get(self, *, session_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT s.id, s.user_id, s.expires_at, s.created_at,
                       u.username, u.role, u.disabled
                FROM user_sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.id = ? LIMIT 1
                """,
                (session_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def delete(self, *, session_id: str) -> bool:
        with get_db() as conn:
            cursor = conn.execute("DELETE FROM user_sessions WHERE id = ?", (session_id,))
        return cursor.rowcount > 0

    def prune_expired(self, *, now_iso: str) -> int:
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM user_sessions WHERE expires_at < ?",
                (now_iso,),
            )
        return cursor.rowcount
