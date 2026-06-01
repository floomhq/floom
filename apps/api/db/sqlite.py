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


def _env_path() -> Path:
    configured = (
        os.environ.get("WORKEROS_API_ENV_FILE")
        or os.environ.get("FLOOM_API_ENV_FILE")
    )
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[1] / ".env"


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


def _read_env_lines() -> list[str]:
    env_path = _env_path()
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
    for line in _read_env_lines():
        stripped = line.rstrip("\n")
        if stripped.startswith(f"{name}="):
            return stripped.split("=", 1)[1]
    return None


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
    config = _config_from_manifest_row(row)
    manifest = json.loads(data.get("manifest_json") or "{}")
    manifest_dict = manifest if isinstance(manifest, dict) else {}
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
        "runner": config.runtime.runner if config and config.runtime else "local",
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
    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                _worker_select_sql("WHERE w.owner_id = ?"),
                (user_id,),
            ).fetchall()
        return [_worker_record_from_row(row) for row in rows]

    def get(self, *, user_id: str, worker_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                _worker_select_sql("WHERE w.owner_id = ? AND w.id = ?", "LIMIT 1"),
                (user_id, worker_id),
            ).fetchone()
        return _worker_record_from_row(row) if row else None

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
                     owner_id, composio_trigger_id, composio_event, triggers_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                     owner_id, composio_trigger_id, composio_event, triggers_json)
                VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?, 1, ?, ?, ?, ?, ?)
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
        runs = self.list_recent_runs(user_id=user_id, worker_id=worker_id, limit=1)
        return runs[0] if runs else None

    def stats_batch(self, *, user_id: str, worker_ids: list[str], days: int = 7) -> dict[str, RecentStats]:
        if not worker_ids:
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
                SELECT id, owner_id, cron_expr, next_run_at
                FROM workers
                WHERE enabled = 1 AND trigger_type IN ('schedule', 'cron', 'scheduled')
                ORDER BY created_at, id
                """
            ).fetchall()
        return [_row_dict(row) for row in rows]

    def get_schedule_state(self, *, worker_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                "SELECT owner_id, next_run_at, cron_expr FROM workers WHERE id = ?",
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
        return {
            "config": config,
            "grants": _json_load(row["grants_json"], {}),
            "input_values": _json_load(row["input_values_json"], {}),
            "enabled": bool(row["enabled"]),
            "owner_id": row["owner_id"],
            "bundle_path": row["bundle_path"],
            "manifest_json": json.loads(row["manifest_json"] or "{}"),
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
                       r.quality_warning
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
                "SELECT 1 FROM workers WHERE id = ? AND owner_id = ?",
                (worker_id, user_id),
            ).fetchone()
            if worker is None:
                raise ValueError(f"worker {worker_id} does not belong to {user_id}")
            conn.execute(
                """
                INSERT INTO runs
                    (id, worker_id, status, trigger_source, runner, input_json, output_json,
                     approval_status, error, started_at, completed_at, duration_ms,
                     created_at, bundle_snapshot_path, quality_warning)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    worker_id,
                    fields.get("status") or RunStatus.QUEUED.value,
                    fields.get("trigger_source") or "manual",
                    fields.get("runner") or "local",
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
                ),
            )
        created = self.get(user_id=user_id, run_id=run_id)
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
        if self.get(user_id=user_id, run_id=run_id) is None:
            raise ValueError(f"run {run_id} not found for {user_id}")
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO logs (run_id, level, message, timestamp, trace_id)
                VALUES (?, ?, ?, ?, ?)
                """,
                (run_id, level, message, timestamp, trace_id),
            )

    def list_logs(self, *, user_id: str, run_id: str) -> list[dict[str, Any]]:
        if self.get(user_id=user_id, run_id=run_id) is None:
            return []
        with get_db() as conn:
            rows = conn.execute(
                "SELECT level, message, timestamp, trace_id FROM logs WHERE run_id = ? ORDER BY timestamp",
                (run_id,),
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
        if self.get(user_id=user_id, run_id=run_id) is None:
            raise ValueError(f"run {run_id} not found for {user_id}")
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO artifacts (id, run_id, name, type, path, size_bytes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (artifact_id, run_id, name, artifact_type, path, size_bytes, created_at),
            )

    def list_artifacts(self, *, user_id: str, run_id: str) -> list[dict[str, Any]]:
        if self.get(user_id=user_id, run_id=run_id) is None:
            return []
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, name",
                (run_id,),
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
        for item in items:
            item["value"] = self.read_value(user_id=user_id, name=item["name"])
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
        edited_output_json: str | None = None,
        follow_up_run_id: str | None = None,
    ) -> dict[str, Any] | None:
        with get_db() as conn:
            conn.execute(
                """
                UPDATE approvals
                SET status = 'approved',
                    decided_at = ?,
                    edited_output_json = ?,
                    follow_up_run_id = ?
                WHERE run_id = ? AND owner_id = ? AND status = 'pending'
                """,
                (decided_at, edited_output_json, follow_up_run_id, run_id, owner_id),
            )
        return self.get_by_run_id(run_id=run_id)

    def reject(
        self,
        *,
        owner_id: str,
        run_id: str,
        decided_at: str,
        reason: str | None = None,
    ) -> dict[str, Any] | None:
        with get_db() as conn:
            conn.execute(
                """
                UPDATE approvals
                SET status = 'rejected', decided_at = ?, reason = ?
                WHERE run_id = ? AND owner_id = ? AND status = 'pending'
                """,
                (decided_at, reason, run_id, owner_id),
            )
        return self.get_by_run_id(run_id=run_id)


class SqliteVersionRepository:
    """SQLite implementation of VersionRepository."""

    def create(
        self,
        *,
        asset_type: str,
        asset_id: str,
        user_id: str,
        snapshot_json: str,
        change_source: str,
    ) -> dict[str, Any]:
        version_id = f"ver_{uuid.uuid4().hex[:12]}"
        created_at = datetime.now(timezone.utc).isoformat()
        with get_db() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(version_number), 0) FROM asset_versions WHERE asset_type = ? AND asset_id = ?",
                (asset_type, asset_id),
            ).fetchone()
            next_version = (row[0] if row else 0) + 1
            conn.execute(
                """
                INSERT INTO asset_versions (id, asset_type, asset_id, user_id, version_number, snapshot_json, change_source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (version_id, asset_type, asset_id, user_id, next_version, snapshot_json, change_source, created_at),
            )
        return self.get(version_id=version_id) or {}

    def list(
        self,
        *,
        asset_type: str,
        asset_id: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT id, asset_type, asset_id, user_id, version_number, change_source, created_at
                FROM asset_versions
                WHERE asset_type = ? AND asset_id = ?
                ORDER BY version_number DESC
                LIMIT ?
                """,
                (asset_type, asset_id, limit),
            ).fetchall()
        return [_row_dict(r) for r in rows]

    def get(self, *, version_id: str) -> dict[str, Any] | None:
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, asset_type, asset_id, user_id, version_number, snapshot_json, change_source, created_at FROM asset_versions WHERE id = ?",
                (version_id,),
            ).fetchone()
        return _row_dict(row) if row else None

    def prune(self, *, asset_type: str, asset_id: str, keep: int = 50) -> int:
        with get_db() as conn:
            ids_to_keep = conn.execute(
                """
                SELECT id FROM asset_versions
                WHERE asset_type = ? AND asset_id = ?
                ORDER BY version_number DESC LIMIT ?
                """,
                (asset_type, asset_id, keep),
            ).fetchall()
            if not ids_to_keep:
                return 0
            placeholders = ",".join("?" * len(ids_to_keep))
            keep_ids = [r[0] for r in ids_to_keep]
            cursor = conn.execute(
                f"DELETE FROM asset_versions WHERE asset_type = ? AND asset_id = ? AND id NOT IN ({placeholders})",
                [asset_type, asset_id] + keep_ids,
            )
        return cursor.rowcount


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
