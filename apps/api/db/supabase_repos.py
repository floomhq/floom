from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Iterable, Mapping
from datetime import date, datetime, timedelta, timezone
from typing import Any

from supabase import Client

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.workspace_context import get_active_workspace_id
from apps.api.config import get_supabase_service_client
from apps.api.db import workspaces as workspace_repo
from apps.api.db._secret_crypto import decrypt_secret, encrypt_secret

ensure_engine_api_path()

from models import (  # noqa: E402
    RecentStats,
    RunStatus,
    TimeseriesDay,
    WorkerConfig,
    WorkerContract,
    parse_worker_manifest,
    worker_contract_to_worker_config,
)


def _json_dump(value: Any) -> str:
    return json.dumps(value if value is not None else {}, separators=(",", ":"))


def _json_load(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    if isinstance(default, dict) and isinstance(value, dict):
        return value
    if isinstance(default, list) and isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            loaded = json.loads(value)
        except Exception:
            return default
        return loaded if isinstance(loaded, type(default)) else default
    return default


def _json_storage_value(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(default, dict) and isinstance(value, dict):
        return value
    if isinstance(default, list) and isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            loaded = json.loads(value)
        except Exception:
            return default
        return loaded if isinstance(loaded, type(default)) else default
    return default


def _json_text(value: Any, default: Any) -> str:
    if isinstance(value, str):
        return value
    return _json_dump(value if value is not None else default)


def _skill_version_id(worker_id: str, manifest: dict[str, Any]) -> str:
    version = str(manifest.get("version") or "0.1.0").replace(".", "_").replace("-", "_")
    return f"sv_{worker_id}_{version}"


def _lift_legacy_manifest_fields(manifest_raw: Any) -> Any:
    """Lift legacy top-level inputs/outputs/secrets into exec block.

    Authoring tools and our own example workers still emit the OSS schema
    (top-level ``inputs:`` etc.) even with ``schema_version: "0.3"``, while
    the 0.3 WorkerContract requires them under ``exec``. Without this lift,
    pydantic silently drops the unknown top-level fields and the UI shows
    "This worker has no inputs", breaking the run form. Idempotent: a
    manifest that already has fields under exec is unchanged.
    """
    if not (
        isinstance(manifest_raw, dict)
        and manifest_raw.get("schema_version") == "0.3"
        and isinstance(manifest_raw.get("exec"), dict)
    ):
        return manifest_raw
    exec_block = manifest_raw["exec"]
    for legacy_key in ("inputs", "outputs", "secrets"):
        if manifest_raw.get(legacy_key) and not exec_block.get(legacy_key):
            exec_block[legacy_key] = manifest_raw[legacy_key]
    return manifest_raw


def _config_from_manifest(
    *,
    worker_id: str,
    manifest_json: Any,
    trigger_type: str | None,
    cron_expr: str | None,
    cron_timezone: str | None,
    bundle_path: str | None,
) -> WorkerConfig | None:
    if isinstance(manifest_json, str):
        manifest_raw = json.loads(manifest_json or "{}")
    elif isinstance(manifest_json, dict):
        manifest_raw = manifest_json
    else:
        manifest_raw = {}
    # Read-side leniency: workers ingested before the write-side lift may
    # still have top-level inputs/outputs/secrets. Lift them here too so a
    # data migration isn't required.
    manifest_raw = _lift_legacy_manifest_fields(manifest_raw)
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


def _worker_record_from_rows(
    worker_row: Mapping[str, Any],
    skill_version_row: Mapping[str, Any] | None,
) -> dict[str, Any]:
    manifest = (
        _json_load(skill_version_row.get("manifest_json"), {})
        if skill_version_row
        else {}
    )
    config = _config_from_manifest(
        worker_id=str(worker_row["id"]),
        manifest_json=manifest,
        trigger_type=worker_row.get("trigger_type"),
        cron_expr=worker_row.get("cron_expr"),
        cron_timezone=worker_row.get("cron_timezone"),
        bundle_path=skill_version_row.get("bundle_path") if skill_version_row else None,
    )
    return {
        "id": worker_row["id"],
        "name": worker_row["name"],
        "description": manifest.get("description"),
        "long_description": manifest.get("long_description"),
        "use_cases": manifest.get("use_cases"),
        "example_input": manifest.get("example_input"),
        "example_output": manifest.get("example_output"),
        "how_it_works": manifest.get("how_it_works"),
        "tags": manifest.get("tags") or [],
        "folder": manifest.get("folder"),
        "status": "healthy",
        "trigger_type": worker_row.get("trigger_type") or (config.trigger.type if config else "manual"),
        "runner": config.runtime.runner if config and config.runtime else "local",
        "config": config.model_dump(mode="json") if config else {},
        "manifest": manifest,
        "manifest_json": manifest,
        "bundle_path": skill_version_row.get("bundle_path") if skill_version_row else None,
        "triggers_json": _json_load(worker_row.get("triggers_json"), []),
        "skill_version_id": worker_row.get("skill_version_id"),
        "cron_expr": worker_row.get("cron_expr"),
        "cron_timezone": worker_row.get("cron_timezone"),
        "next_run_at": worker_row.get("next_run_at"),
        "last_scheduled_run_at": worker_row.get("last_scheduled_run_at"),
        "webhook_secret_hash": worker_row.get("webhook_secret_hash"),
        "notify_email": bool(worker_row.get("notify_email")),
        "notify_webhook_url": worker_row.get("notify_webhook_url"),
        "grants_json": _json_load(worker_row.get("grants_json"), {}),
        "input_values_json": _json_load(worker_row.get("input_values_json"), {}),
        "enabled": bool(worker_row.get("enabled", True)),
        "created_at": worker_row.get("created_at"),
        "owner_id": worker_row.get("user_id"),
        "composio_trigger_id": worker_row.get("composio_trigger_id"),
        "composio_event": worker_row.get("composio_event"),
    }


def _response_rows(response: Any) -> list[dict[str, Any]]:
    data = getattr(response, "data", None)
    if data is None:
        return []
    if isinstance(data, list):
        return [dict(item) if isinstance(item, Mapping) else item for item in data]
    if isinstance(data, Mapping):
        return [dict(data)]
    return []


def _first_row(response: Any) -> dict[str, Any] | None:
    rows = _response_rows(response)
    return rows[0] if rows else None


def _bytea_literal(value: bytes | str | bytearray | memoryview | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, memoryview):
        value = value.tobytes()
    if isinstance(value, bytearray):
        value = bytes(value)
    if isinstance(value, bytes):
        return "\\x" + value.hex()
    text = value.strip()
    if not text:
        return None
    if text.startswith("\\x"):
        return text
    try:
        bytes.fromhex(text)
    except ValueError:
        return "\\x" + text.encode().hex()
    return "\\x" + text.lower()


def _bytea_bytes(value: Any) -> bytes | None:
    if value in (None, ""):
        return None
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, memoryview):
        return value.tobytes()
    if isinstance(value, str):
        text = value[2:] if value.startswith("\\x") else value
        try:
            return bytes.fromhex(text)
        except ValueError:
            return value.encode()
    return None


# ---------------------------------------------------------------------------
# Workspace scoping
# ---------------------------------------------------------------------------
#
# The cloud is workspace-scoped, but the engine code that calls these repos
# only knows about ``user_id`` (from AuthContext). The active workspace_id
# is set on a contextvar by SupabaseAuthProvider.verify on every HTTP
# request; we read it here.
#
# Two scoping modes:
#   1. Web request (contextvar set) -> filter by workspace_id.
#   2. Out-of-request (scheduler, webhook -- contextvar unset) -> fall back
#      to filtering by user_id. The scheduler/webhook code already passes
#      the worker's owner_id; user-scoped queries still return correct rows
#      because every workspace_id maps to exactly one owner.
#
# On INSERT we always set workspace_id. Resolution order:
#   a. ``workspace_id`` kwarg explicitly passed (rare; tests or future
#      cross-workspace tooling).
#   b. contextvar.
#   c. worker_id -> workspace_id lookup (scheduler / webhook trigger path).
#   d. user's default workspace (lazy create if zero exist).

def _scope_by_workspace(
    builder: Any,
    *,
    user_id: str | None,
    explicit_workspace_id: str | None = None,
) -> Any:
    """Apply the right scope filter to a Supabase query builder.

    Prefers workspace_id (active workspace for the request); falls back to
    user_id when the contextvar is unset and no explicit workspace_id is
    provided.
    """
    workspace_id = explicit_workspace_id or get_active_workspace_id()
    if workspace_id:
        return builder.eq("workspace_id", workspace_id)
    if user_id is not None:
        return builder.eq("user_id", user_id)
    return builder


def _resolve_workspace_id_for_write(
    *,
    user_id: str,
    explicit_workspace_id: str | None = None,
    worker_id: str | None = None,
    email: str | None = None,
) -> str:
    """Resolve the workspace_id to stamp on a new row.

    Order: explicit kwarg -> contextvar -> worker's existing workspace_id
    -> user's default workspace (lazy-create if none). Always returns a
    non-empty string; never returns None.
    """
    if explicit_workspace_id:
        return explicit_workspace_id
    from_context = get_active_workspace_id()
    if from_context:
        return from_context
    if worker_id:
        existing = workspace_repo.workspace_id_for_worker(worker_id=worker_id)
        if existing:
            return existing
    active = workspace_repo.resolve_active_workspace(
        user_id=user_id,
        email=email,
        requested_id=None,
    )
    return str(active["id"])


class _BaseSupabaseRepository:
    def __init__(self, client: Client | None = None) -> None:
        self._client = client or get_supabase_service_client()


class SupabaseWorkerRepository(_BaseSupabaseRepository):
    def _skill_versions_by_id(
        self, skill_version_ids: Iterable[str]
    ) -> dict[str, dict[str, Any]]:
        ids = [item for item in dict.fromkeys(skill_version_ids) if item]
        if not ids:
            return {}
        response = (
            self._client.table("skill_versions")
            .select("*")
            .in_("id", ids)
            .execute()
        )
        return {
            row["id"]: row
            for row in _response_rows(response)
        }

    def _worker_rows(
        self,
        *,
        user_id: str | None = None,
        worker_id: str | None = None,
        worker_ids: Iterable[str] | None = None,
    ) -> list[dict[str, Any]]:
        builder = self._client.table("workers").select("*")
        # Workspace scope: filter by workspace_id when set (per-request
        # contextvar). Falls back to user_id when out of request context.
        builder = _scope_by_workspace(builder, user_id=user_id)
        if worker_id is not None:
            builder = builder.eq("id", worker_id)
        if worker_ids is not None:
            ids = [item for item in dict.fromkeys(worker_ids) if item]
            if not ids:
                return []
            builder = builder.in_("id", ids)
        response = builder.order("created_at").order("id").execute()
        return _response_rows(response)

    def _worker_name_map(self, worker_ids: Iterable[str]) -> dict[str, str]:
        workers = self._worker_rows(worker_ids=worker_ids)
        skill_map = self._skill_versions_by_id(
            row.get("skill_version_id") for row in workers if row.get("skill_version_id")
        )
        result: dict[str, str] = {}
        for row in workers:
            skill = skill_map.get(row.get("skill_version_id"))
            manifest = _json_load(skill.get("manifest_json"), {}) if skill else {}
            result[str(row["id"])] = str(manifest.get("title") or row.get("name") or row["id"])
        return result

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        rows = self._worker_rows(user_id=user_id)
        skill_map = self._skill_versions_by_id(
            row.get("skill_version_id") for row in rows if row.get("skill_version_id")
        )
        return [
            _worker_record_from_rows(row, skill_map.get(row.get("skill_version_id")))
            for row in rows
        ]

    def get(self, *, user_id: str, worker_id: str) -> dict[str, Any] | None:
        rows = self._worker_rows(user_id=user_id, worker_id=worker_id)
        if not rows:
            return None
        row = rows[0]
        skill_map = self._skill_versions_by_id([row.get("skill_version_id")])
        return _worker_record_from_rows(row, skill_map.get(row.get("skill_version_id")))

    def get_any(self, *, worker_id: str) -> dict[str, Any] | None:
        rows = self._worker_rows(worker_id=worker_id)
        if not rows:
            return None
        row = rows[0]
        skill_map = self._skill_versions_by_id([row.get("skill_version_id")])
        return _worker_record_from_rows(row, skill_map.get(row.get("skill_version_id")))

    def create(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        worker_id = fields["worker_id"]
        manifest_json = _lift_legacy_manifest_fields(
            _json_storage_value(fields.get("manifest_json"), {})
        )
        name = fields.get("name") or manifest_json.get("title") or manifest_json.get("name") or worker_id
        created_at = fields.get("created_at") or datetime.now(timezone.utc).isoformat()
        skill_version_id = fields.get("skill_version_id") or _skill_version_id(worker_id, manifest_json)
        workspace_id = _resolve_workspace_id_for_write(
            user_id=user_id,
            explicit_workspace_id=fields.get("workspace_id"),
        )
        self._client.table("skill_versions").upsert(
            {
                "id": skill_version_id,
                "user_id": user_id,
                "name": manifest_json.get("name") or name,
                "version": str(manifest_json.get("version") or "0.1.0"),
                "manifest_json": manifest_json,
                "bundle_path": fields.get("bundle_path") or f"workers/{worker_id}",
                "created_at": created_at,
            },
            on_conflict="id",
        ).execute()
        self._client.table("workers").insert(
            {
                "id": worker_id,
                "user_id": user_id,
                "workspace_id": workspace_id,
                "skill_version_id": skill_version_id,
                "name": name,
                "trigger_type": fields.get("trigger_type") or "manual",
                "cron_expr": fields.get("cron_expr"),
                "cron_timezone": fields.get("cron_timezone"),
                "next_run_at": fields.get("next_run_at"),
                "last_scheduled_run_at": fields.get("last_scheduled_run_at"),
                "webhook_secret_hash": _bytea_literal(fields.get("webhook_secret_hash")),
                "notify_email": bool(fields.get("notify_email")),
                "notify_webhook_url": fields.get("notify_webhook_url"),
                "grants_json": _json_storage_value(fields.get("grants_json"), {}),
                "input_values_json": _json_storage_value(fields.get("input_values_json"), {}),
                "enabled": bool(fields.get("enabled", True)),
                "created_at": created_at,
                "composio_trigger_id": fields.get("composio_trigger_id"),
                "composio_event": fields.get("composio_event"),
                "triggers_json": _json_storage_value(fields.get("triggers_json"), []),
            }
        ).execute()
        created = self.get(user_id=user_id, worker_id=worker_id)
        if created is None:
            raise RuntimeError(f"failed to create worker {worker_id}")
        return created

    def upsert(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        """Insert-or-update a worker row in Supabase.

        Called by the engine's _persist_discovered_workers after a worker
        is drafted, created, or updated. Idempotent across repeated
        discovery passes. Verifies ownership when updating: rows owned by
        a different user are NOT clobbered (raises).
        """
        worker_id = fields["worker_id"]
        manifest_json = _lift_legacy_manifest_fields(
            _json_storage_value(fields.get("manifest_json"), {})
        )
        name = (
            fields.get("name")
            or manifest_json.get("title")
            or manifest_json.get("name")
            or worker_id
        )
        created_at = fields.get("created_at") or datetime.now(timezone.utc).isoformat()
        skill_version_id = fields.get("skill_version_id") or _skill_version_id(
            worker_id, manifest_json
        )

        # Ownership guard: if the row exists under a different user_id,
        # refuse rather than reassign. Worker IDs are globally unique by
        # PK so two tenants can't legitimately own the same id, but a
        # filesystem rename + re-discover could surface a collision and
        # we should fail loud rather than steal someone else's worker.
        existing_owner = self.get_owner(worker_id=worker_id)
        if existing_owner is not None and existing_owner != user_id:
            raise RuntimeError(
                f"worker {worker_id!r} already exists for a different user"
            )

        self._client.table("skill_versions").upsert(
            {
                "id": skill_version_id,
                "user_id": user_id,
                "name": manifest_json.get("name") or name,
                "version": str(manifest_json.get("version") or "0.1.0"),
                "manifest_json": manifest_json,
                "bundle_path": fields.get("bundle_path") or f"workers/{worker_id}",
                "created_at": created_at,
            },
            on_conflict="id",
        ).execute()

        worker_payload: dict[str, Any] = {
            "id": worker_id,
            "user_id": user_id,
            "skill_version_id": skill_version_id,
            "name": name,
            "trigger_type": fields.get("trigger_type") or "manual",
            "cron_expr": fields.get("cron_expr"),
            "cron_timezone": fields.get("cron_timezone"),
            "grants_json": _json_storage_value(fields.get("grants_json"), {}),
            "input_values_json": _json_storage_value(fields.get("input_values_json"), {}),
            "enabled": bool(fields.get("enabled", True)),
            "created_at": created_at,
            "composio_trigger_id": fields.get("composio_trigger_id"),
            "composio_event": fields.get("composio_event"),
            "triggers_json": _json_storage_value(fields.get("triggers_json"), []),
        }
        # Don't clobber notify_* and next_run_at on update; only set on
        # insert. PostgREST upsert applies the whole payload on conflict,
        # so we have to branch.
        if existing_owner is None:
            # On insert: stamp workspace_id. On update: leave it as-is
            # (a worker's workspace doesn't change after creation; the
            # engine's _persist_discovered_workers re-runs upsert on
            # every discovery pass).
            worker_payload["workspace_id"] = _resolve_workspace_id_for_write(
                user_id=user_id,
                explicit_workspace_id=fields.get("workspace_id"),
                worker_id=worker_id,
            )
            worker_payload.update(
                {
                    "next_run_at": fields.get("next_run_at"),
                    "last_scheduled_run_at": fields.get("last_scheduled_run_at"),
                    "webhook_secret_hash": _bytea_literal(fields.get("webhook_secret_hash")),
                    "notify_email": bool(fields.get("notify_email")),
                    "notify_webhook_url": fields.get("notify_webhook_url"),
                }
            )
            self._client.table("workers").insert(worker_payload).execute()
        else:
            self._client.table("workers").update(worker_payload).eq(
                "id", worker_id
            ).eq("user_id", user_id).execute()

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
        if manifest_json is not None or bundle_path is not None:
            payload: dict[str, Any] = {}
            if manifest_json is not None:
                payload["manifest_json"] = _json_storage_value(manifest_json, {})
            if bundle_path is not None:
                payload["bundle_path"] = bundle_path
            self._client.table("skill_versions").update(payload).eq(
                "id",
                worker["skill_version_id"],
            ).execute()
        payload: dict[str, Any] = {}
        for key in (
            "name",
            "trigger_type",
            "cron_expr",
            "cron_timezone",
            "next_run_at",
            "last_scheduled_run_at",
            "webhook_secret_hash",
            "notify_webhook_url",
            "composio_trigger_id",
            "composio_event",
        ):
            if key in fields:
                if key == "webhook_secret_hash":
                    payload[key] = _bytea_literal(fields[key])
                else:
                    payload[key] = fields[key]
        if "notify_email" in fields:
            payload["notify_email"] = bool(fields["notify_email"])
        if "enabled" in fields:
            payload["enabled"] = bool(fields["enabled"])
        if "grants_json" in fields:
            payload["grants_json"] = _json_storage_value(fields["grants_json"], {})
        if "input_values_json" in fields:
            payload["input_values_json"] = _json_storage_value(fields["input_values_json"], {})
        if "triggers_json" in fields:
            payload["triggers_json"] = _json_storage_value(fields["triggers_json"], [])
        if payload:
            builder = self._client.table("workers").update(payload).eq("id", worker_id)
            builder = _scope_by_workspace(builder, user_id=user_id)
            builder.execute()
        return self.get(user_id=user_id, worker_id=worker_id)

    def delete(self, *, user_id: str, worker_id: str) -> bool:
        builder = self._client.table("workers").delete().eq("id", worker_id)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.execute()
        return bool(_response_rows(response))

    def list_recent_runs(
        self,
        *,
        user_id: str,
        worker_id: str,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        builder = self._client.table("runs").select(
            "id,worker_id,status,trigger_source,created_at,started_at,completed_at,duration_ms,error"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        builder = builder.eq("worker_id", worker_id)
        response = builder.order("created_at", desc=True).limit(limit).execute()
        return _response_rows(response)

    def get_last_run(self, *, user_id: str, worker_id: str) -> dict[str, Any] | None:
        runs = self.list_recent_runs(user_id=user_id, worker_id=worker_id, limit=1)
        return runs[0] if runs else None

    def stats_batch(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        days: int = 7,
    ) -> dict[str, RecentStats]:
        if not worker_ids:
            return {}
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        builder = self._client.table("runs").select("worker_id,status,created_at")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = (
            builder
            .in_("worker_id", worker_ids)
            .gte("created_at", cutoff)
            .execute()
        )
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in _response_rows(response):
            grouped[str(row["worker_id"])].append(row)
        result: dict[str, RecentStats] = {}
        for worker_id, rows in grouped.items():
            last_run_at = max((str(row.get("created_at")) for row in rows if row.get("created_at")), default=None)
            total = len(rows)
            completed = sum(1 for row in rows if row.get("status") == RunStatus.COMPLETED.value)
            result[worker_id] = RecentStats(
                last_run_at=last_run_at,
                runs_7d=total,
                success_rate_7d=(completed / total) if total else None,
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
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        builder = self._client.table("runs").select("worker_id,status,created_at")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = (
            builder
            .in_("worker_id", worker_ids)
            .gte("created_at", cutoff)
            .execute()
        )
        by_worker_day: dict[tuple[str, str], dict[str, int]] = defaultdict(
            lambda: {"total": 0, "completed": 0, "failed": 0}
        )
        for row in _response_rows(response):
            created_at = str(row.get("created_at") or "")
            day = created_at[:10]
            if not day:
                continue
            key = (str(row["worker_id"]), day)
            by_worker_day[key]["total"] += 1
            if row.get("status") == RunStatus.COMPLETED.value:
                by_worker_day[key]["completed"] += 1
            if row.get("status") == RunStatus.FAILED.value:
                by_worker_day[key]["failed"] += 1
        today = date.today()
        range_days = [
            (today - timedelta(days=idx)).isoformat()
            for idx in range(days - 1, -1, -1)
        ]
        result: dict[str, list[TimeseriesDay]] = {}
        for worker_id in worker_ids:
            items: list[TimeseriesDay] = []
            for day in range_days:
                bucket = by_worker_day.get((worker_id, day), {"total": 0, "completed": 0, "failed": 0})
                items.append(
                    TimeseriesDay(
                        date=day,
                        total=bucket["total"],
                        completed=bucket["completed"],
                        failed=bucket["failed"],
                    )
                )
            result[worker_id] = items
        return result

    def get_owner(self, *, worker_id: str) -> str | None:
        response = (
            self._client.table("workers")
            .select("user_id")
            .eq("id", worker_id)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        return str(row["user_id"]) if row else None

    def list_scheduled(self) -> list[dict[str, Any]]:
        response = (
            self._client.table("workers")
            .select("id,user_id,cron_expr,next_run_at")
            .eq("enabled", True)
            .eq("trigger_type", "schedule")
            .order("created_at")
            .order("id")
            .execute()
        )
        return [
            {
                "id": row["id"],
                "owner_id": row.get("user_id"),
                "cron_expr": row.get("cron_expr"),
                "next_run_at": row.get("next_run_at"),
            }
            for row in _response_rows(response)
        ]

    def get_schedule_state(self, *, worker_id: str) -> dict[str, Any] | None:
        response = (
            self._client.table("workers")
            .select("user_id,next_run_at,cron_expr")
            .eq("id", worker_id)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        if row is None:
            return None
        return {
            "owner_id": row.get("user_id"),
            "next_run_at": row.get("next_run_at"),
            "cron_expr": row.get("cron_expr"),
        }

    def set_next_run_at(self, *, worker_id: str, next_run_at: str | None) -> None:
        self._client.table("workers").update({"next_run_at": next_run_at}).eq(
            "id",
            worker_id,
        ).execute()

    def mark_scheduled_run(
        self,
        *,
        worker_id: str,
        last_scheduled_run_at: str,
        next_run_at: str | None,
    ) -> None:
        self._client.table("workers").update(
            {
                "last_scheduled_run_at": last_scheduled_run_at,
                "next_run_at": next_run_at,
            }
        ).eq("id", worker_id).execute()

    def list_active_run_ids(self, *, user_id: str, worker_id: str) -> list[str]:
        builder = self._client.table("runs").select("id")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = (
            builder
            .eq("worker_id", worker_id)
            .in_("status", [RunStatus.QUEUED.value, RunStatus.RUNNING.value])
            .order("created_at")
            .execute()
        )
        return [str(row["id"]) for row in _response_rows(response)]

    def get_skill_version_ref_count(self, *, skill_version_id: str | None) -> int:
        if not skill_version_id:
            return 0
        response = (
            self._client.table("workers")
            .select("id", count="exact")
            .eq("skill_version_id", skill_version_id)
            .execute()
        )
        return int(getattr(response, "count", 0) or 0)

    def delete_skill_version(self, *, skill_version_id: str) -> None:
        self._client.table("skill_versions").delete().eq("id", skill_version_id).execute()

    def get_recipe(
        self,
        *,
        worker_id: str,
        user_id: str | None = None,
    ) -> dict[str, Any] | None:
        rows = self._worker_rows(user_id=user_id, worker_id=worker_id)
        if not rows:
            return None
        worker = rows[0]
        skill_map = self._skill_versions_by_id([worker.get("skill_version_id")])
        skill = skill_map.get(worker.get("skill_version_id"))
        if not skill:
            return None
        config = _config_from_manifest(
            worker_id=str(worker["id"]),
            manifest_json=skill.get("manifest_json") or {},
            trigger_type=worker.get("trigger_type"),
            cron_expr=worker.get("cron_expr"),
            cron_timezone=worker.get("cron_timezone"),
            bundle_path=skill.get("bundle_path"),
        )
        return {
            "config": config,
            "grants": _json_load(worker.get("grants_json"), {}),
            "input_values": _json_load(worker.get("input_values_json"), {}),
            "enabled": bool(worker.get("enabled", True)),
            "owner_id": worker.get("user_id"),
            "bundle_path": skill.get("bundle_path"),
            "manifest_json": _json_load(skill.get("manifest_json"), {}),
        }

    def upsert_webhook_secret_hash(
        self,
        *,
        worker_id: str,
        secret_hash: bytes | str,
        created_at: str,
        rotated_at: str,
    ) -> None:
        _ = created_at
        _ = rotated_at
        if self.get_any(worker_id=worker_id) is None:
            raise ValueError(f"worker {worker_id} not found")
        self._client.table("workers").update(
            {"webhook_secret_hash": _bytea_literal(secret_hash)}
        ).eq("id", worker_id).execute()

    def get_webhook_secret_hash(self, *, worker_id: str) -> bytes | None:
        worker_response = (
            self._client.table("workers")
            .select("webhook_secret_hash")
            .eq("id", worker_id)
            .limit(1)
            .execute()
        )
        worker = _first_row(worker_response)
        return _bytea_bytes(worker.get("webhook_secret_hash")) if worker else None

    def delete_webhook_secret(self, *, worker_id: str) -> bool:
        existed = self.get_webhook_secret_hash(worker_id=worker_id) is not None
        self._client.table("workers").update({"webhook_secret_hash": None}).eq(
            "id",
            worker_id,
        ).execute()
        return existed


class SupabaseRunRepository(_BaseSupabaseRepository):
    def _decorate_run_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not rows:
            return []
        worker_name_map = SupabaseWorkerRepository(self._client)._worker_name_map(
            row["worker_id"] for row in rows
        )
        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            if "input_json" in item:
                item["input_json"] = _json_text(item.get("input_json"), {})
            if "output_json" in item:
                item["output_json"] = _json_text(item.get("output_json"), {})
            item["worker_name"] = worker_name_map.get(str(item["worker_id"]))
            result.append(item)
        return result

    def list_for_worker(
        self,
        *,
        user_id: str,
        worker_id: str,
        limit: int,
        offset: int,
    ) -> list[dict[str, Any]]:
        builder = self._client.table("runs").select(
            "id,worker_id,status,trigger_source,created_at,started_at,completed_at,duration_ms,error"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = (
            builder
            .eq("worker_id", worker_id)
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        return _response_rows(response)

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
        builder = self._client.table("runs").select(
            "id,worker_id,status,trigger_source,runner,input_json,output_json,error,started_at,completed_at,duration_ms,created_at,cancel_requested,cancelled_at,bundle_snapshot_path",
            count="exact",
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        if worker_id:
            builder = builder.eq("worker_id", worker_id)
        if statuses:
            builder = builder.in_("status", statuses)
        if since:
            builder = builder.gte("created_at", since)
        if until:
            builder = builder.lte("created_at", until)
        response = builder.order("created_at", desc=True).range(
            offset,
            offset + limit - 1,
        ).execute()
        rows = self._decorate_run_rows(_response_rows(response))
        total = int(getattr(response, "count", 0) or 0)
        return rows, total

    def get(self, *, user_id: str, run_id: str) -> dict[str, Any] | None:
        builder = self._client.table("runs").select(
            "id,worker_id,status,trigger_source,runner,input_json,output_json,error,started_at,completed_at,duration_ms,created_at,cancel_requested,cancelled_at,bundle_snapshot_path"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("id", run_id).limit(1).execute()
        row = _first_row(response)
        if row is None:
            return None
        return self._decorate_run_rows([row])[0]

    def get_any(self, *, run_id: str) -> dict[str, Any] | None:
        response = (
            self._client.table("runs")
            .select("*")
            .eq("id", run_id)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        if row is None:
            return None
        if "input_json" in row:
            row["input_json"] = _json_text(row.get("input_json"), {})
        if "output_json" in row:
            row["output_json"] = _json_text(row.get("output_json"), {})
        return row

    def create(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        worker_id = fields["worker_id"]
        # Pre-check: confirm the worker belongs to this user. We scope by
        # workspace_id (if contextvar is set) so a user can't trigger a
        # run on a worker in a workspace they aren't currently viewing.
        worker_builder = self._client.table("workers").select("id").eq("id", worker_id)
        worker_builder = _scope_by_workspace(worker_builder, user_id=user_id)
        worker = worker_builder.limit(1).execute()
        if _first_row(worker) is None:
            raise ValueError(f"worker {worker_id} does not belong to {user_id}")
        run_id = fields["run_id"]
        # Stamp workspace_id on the run row. For scheduler/webhook triggers
        # the contextvar is unset, so we fall back to the worker's
        # workspace_id (looked up from the DB).
        workspace_id = _resolve_workspace_id_for_write(
            user_id=user_id,
            explicit_workspace_id=fields.get("workspace_id"),
            worker_id=worker_id,
        )
        self._client.table("runs").insert(
            {
                "id": run_id,
                "user_id": user_id,
                "workspace_id": workspace_id,
                "worker_id": worker_id,
                "status": fields.get("status") or RunStatus.QUEUED.value,
                "trigger_source": fields.get("trigger_source") or "manual",
                "runner": fields.get("runner") or "local",
                "input_json": _json_storage_value(fields.get("input_json") or fields.get("inputs"), {}),
                "output_json": _json_storage_value(fields.get("output_json"), {}),
                "approval_status": fields.get("approval_status") or "not_required",
                "error": fields.get("error"),
                "started_at": fields.get("started_at"),
                "completed_at": fields.get("completed_at"),
                "duration_ms": fields.get("duration_ms"),
                "created_at": fields.get("created_at") or datetime.now(timezone.utc).isoformat(),
                "cancel_requested": bool(fields.get("cancel_requested", False)),
                "cancelled_at": fields.get("cancelled_at"),
                "bundle_snapshot_path": fields.get("bundle_snapshot_path"),
            }
        ).execute()
        created = self.get(user_id=user_id, run_id=run_id)
        if created is None:
            raise RuntimeError(f"failed to create run {run_id}")
        return created

    def update(self, *, user_id: str, run_id: str, **fields: Any) -> dict[str, Any] | None:
        payload: dict[str, Any] = {}
        for key in (
            "status",
            "trigger_source",
            "runner",
            "approval_status",
            "error",
            "started_at",
            "completed_at",
            "duration_ms",
            "cancelled_at",
            "bundle_snapshot_path",
        ):
            if key in fields:
                payload[key] = fields[key]
        if "input_json" in fields:
            payload["input_json"] = _json_storage_value(fields["input_json"], {})
        if "output_json" in fields:
            payload["output_json"] = _json_storage_value(fields["output_json"], {})
        if "cancel_requested" in fields:
            payload["cancel_requested"] = bool(fields["cancel_requested"])
        if payload:
            builder = self._client.table("runs").update(payload).eq("id", run_id)
            builder = _scope_by_workspace(builder, user_id=user_id)
            builder.execute()
        return self.get(user_id=user_id, run_id=run_id)

    def delete(self, *, user_id: str, run_id: str) -> bool:
        builder = self._client.table("runs").delete().eq("id", run_id)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.execute()
        return bool(_response_rows(response))

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
    ) -> None:
        run = self.get(user_id=user_id, run_id=run_id)
        if run is None:
            raise ValueError(f"run {run_id} not found for {user_id}")
        updates: dict[str, Any] = {"status": status}
        if output_json is not None:
            updates["output_json"] = output_json
        if error is not None:
            updates["error"] = error
        if status == RunStatus.RUNNING.value:
            updates["started_at"] = datetime.now(timezone.utc).isoformat()
        if status in {RunStatus.COMPLETED.value, RunStatus.FAILED.value}:
            completed_at = datetime.now(timezone.utc).isoformat()
            updates["completed_at"] = completed_at
            started_at = run.get("started_at")
            if started_at:
                try:
                    started = datetime.fromisoformat(str(started_at))
                    completed = datetime.fromisoformat(completed_at)
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
        self._client.table("run_logs").insert(
            {
                "user_id": user_id,
                "run_id": run_id,
                "level": level,
                "message": message,
                "timestamp": timestamp,
                "trace_id": trace_id,
            }
        ).execute()

    def list_logs(self, *, user_id: str, run_id: str) -> list[dict[str, Any]]:
        if self.get(user_id=user_id, run_id=run_id) is None:
            return []
        response = (
            self._client.table("run_logs")
            .select("level,message,timestamp,trace_id")
            .eq("user_id", user_id)
            .eq("run_id", run_id)
            .order("timestamp")
            .execute()
        )
        return _response_rows(response)

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
        self._client.table("artifacts").insert(
            {
                "id": artifact_id,
                "user_id": user_id,
                "run_id": run_id,
                "name": name,
                "type": artifact_type,
                "path": path,
                "size_bytes": size_bytes,
                "created_at": created_at,
            }
        ).execute()

    def list_artifacts(self, *, user_id: str, run_id: str) -> list[dict[str, Any]]:
        if self.get(user_id=user_id, run_id=run_id) is None:
            return []
        response = (
            self._client.table("artifacts")
            .select("*")
            .eq("user_id", user_id)
            .eq("run_id", run_id)
            .order("created_at")
            .order("name")
            .execute()
        )
        return _response_rows(response)

    def clear_all(self, *, user_id: str) -> int:
        run_ids = [row["id"] for row in self.list_all_ids(user_id=user_id)]
        if not run_ids:
            return 0
        # Delete by run_ids (already scoped to the active workspace via
        # list_all_ids) so we don't accidentally wipe runs across all
        # workspaces this user owns.
        self._client.table("runs").delete().in_("id", run_ids).execute()
        return len(run_ids)

    def list_all_ids(self, *, user_id: str) -> list[dict[str, Any]]:
        builder = self._client.table("runs").select("id")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.execute()
        return _response_rows(response)

    def cancel(self, *, user_id: str, run_id: str, cancelled_at: str) -> dict[str, Any] | None:
        return self.update(
            user_id=user_id,
            run_id=run_id,
            cancel_requested=True,
            cancelled_at=cancelled_at,
        )

    def count_running_for_worker(self, *, user_id: str, worker_id: str) -> int:
        # Scoped by workspace_id when called inside a web request; falls
        # back to user_id outside one (scheduler concurrency check).
        builder = self._client.table("runs").select("id", count="exact")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = (
            builder
            .eq("worker_id", worker_id)
            .eq("status", RunStatus.RUNNING.value)
            .execute()
        )
        return int(getattr(response, "count", 0) or 0)

    def set_bundle_snapshot_path(
        self,
        *,
        user_id: str,
        run_id: str,
        bundle_snapshot_path: str | None,
    ) -> None:
        self.update(
            user_id=user_id,
            run_id=run_id,
            bundle_snapshot_path=bundle_snapshot_path,
        )

    def get_bundle_snapshot_path(self, *, user_id: str, run_id: str) -> str | None:
        run = self.get(user_id=user_id, run_id=run_id)
        return str(run["bundle_snapshot_path"]) if run and run.get("bundle_snapshot_path") else None


class SupabaseConnectionRepository(_BaseSupabaseRepository):
    def _normalize_row(self, row: Mapping[str, Any]) -> dict[str, Any]:
        item = dict(row)
        item["scopes_json"] = _json_text(item.get("scopes_json"), [])
        return item

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        builder = self._client.table("connections").select(
            "id,app_name,composio_connection_id,composio_user_id,status,created_at,updated_at,scopes_json,account_label,last_checked_at,last_check_status,last_check_error,user_id"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.order("app_name").execute()
        return [self._normalize_row(row) for row in _response_rows(response)]

    def get(self, *, user_id: str, composio_id: str) -> dict[str, Any] | None:
        builder = self._client.table("connections").select(
            "id,app_name,composio_connection_id,composio_user_id,status,created_at,updated_at,scopes_json,account_label,last_checked_at,last_check_status,last_check_error,user_id"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("id", composio_id).limit(1).execute()
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def get_by_composio_connection_id(self, *, composio_connection_id: str) -> dict[str, Any] | None:
        response = (
            self._client.table("connections")
            .select(
                "id,app_name,composio_connection_id,composio_user_id,status,created_at,updated_at,scopes_json,account_label,last_checked_at,last_check_status,last_check_error,user_id"
            )
            .eq("composio_connection_id", composio_connection_id)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def upsert(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        connection_id = fields["id"]
        created_at = fields.get("created_at") or datetime.now(timezone.utc).isoformat()
        updated_at = fields.get("updated_at") or created_at
        workspace_id = _resolve_workspace_id_for_write(
            user_id=user_id,
            explicit_workspace_id=fields.get("workspace_id"),
        )
        self._client.table("connections").upsert(
            {
                "id": connection_id,
                "user_id": user_id,
                "workspace_id": workspace_id,
                "app_name": fields["app_name"],
                "composio_connection_id": fields["composio_connection_id"],
                "composio_user_id": fields.get("composio_user_id") or user_id,
                "status": fields.get("status") or "initiated",
                "created_at": created_at,
                "updated_at": updated_at,
                "scopes_json": _json_storage_value(fields.get("scopes_json"), []),
                "account_label": fields.get("account_label"),
                "last_checked_at": fields.get("last_checked_at"),
                "last_check_status": fields.get("last_check_status"),
                "last_check_error": fields.get("last_check_error"),
            },
            on_conflict="id",
        ).execute()
        item = self.get(user_id=user_id, composio_id=connection_id)
        if item is None:
            raise RuntimeError(f"failed to upsert connection {connection_id}")
        return item

    def update(self, *, user_id: str, composio_id: str, **fields: Any) -> dict[str, Any] | None:
        payload: dict[str, Any] = {}
        for key in (
            "app_name",
            "composio_connection_id",
            "status",
            "updated_at",
            "account_label",
            "last_checked_at",
            "last_check_status",
            "last_check_error",
        ):
            if key in fields:
                payload[key] = fields[key]
        if "scopes_json" in fields:
            payload["scopes_json"] = _json_storage_value(fields["scopes_json"], [])
        if payload:
            builder = self._client.table("connections").update(payload).eq("id", composio_id)
            builder = _scope_by_workspace(builder, user_id=user_id)
            builder.execute()
        return self.get(user_id=user_id, composio_id=composio_id)

    def delete(self, *, user_id: str, composio_id: str) -> bool:
        builder = self._client.table("connections").delete().eq("id", composio_id)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.execute()
        return bool(_response_rows(response))

    def list_all(self) -> list[dict[str, Any]]:
        response = (
            self._client.table("connections")
            .select(
                "id,app_name,composio_connection_id,composio_user_id,status,created_at,updated_at,scopes_json,account_label,last_checked_at,last_check_status,last_check_error,user_id"
            )
            .order("created_at")
            .order("id")
            .execute()
        )
        return [self._normalize_row(row) for row in _response_rows(response)]


class SupabaseSecretRepository(_BaseSupabaseRepository):
    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        builder = self._client.table("secrets").select(
            "user_id,name,value,status,last_used_at,created_at,updated_at,last_checked_at,last_check_status,last_check_error"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.order("name").execute()
        items = _response_rows(response)
        for item in items:
            ciphertext = _bytea_bytes(item.get("value"))
            item["value"] = decrypt_secret(ciphertext) if ciphertext is not None else None
        return items

    def get(self, *, user_id: str, name: str) -> dict[str, Any] | None:
        builder = self._client.table("secrets").select(
            "user_id,name,value,status,last_used_at,created_at,updated_at,last_checked_at,last_check_status,last_check_error"
        )
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("name", name).limit(1).execute()
        row = _first_row(response)
        if row is None:
            return None
        ciphertext = _bytea_bytes(row.get("value"))
        row["value"] = decrypt_secret(ciphertext) if ciphertext is not None else None
        return row

    def set(self, *, user_id: str, name: str, value: str, status: str = "set") -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        ciphertext = _bytea_literal(encrypt_secret(value))
        workspace_id = _resolve_workspace_id_for_write(user_id=user_id)
        existing_builder = self._client.table("secrets").select("created_at")
        existing_builder = _scope_by_workspace(existing_builder, user_id=user_id)
        existing = existing_builder.eq("name", name).limit(1).execute()
        if _first_row(existing) is None:
            self._client.table("secrets").insert(
                {
                    "user_id": user_id,
                    "workspace_id": workspace_id,
                    "name": name,
                    "value": ciphertext,
                    "status": status,
                    "created_at": now,
                    "updated_at": now,
                }
            ).execute()
        else:
            update_builder = self._client.table("secrets").update(
                {
                    "value": ciphertext,
                    "status": status,
                    "updated_at": now,
                }
            ).eq("name", name)
            update_builder = _scope_by_workspace(update_builder, user_id=user_id)
            update_builder.execute()
        item = self.get(user_id=user_id, name=name)
        if item is None:
            raise RuntimeError(f"failed to set secret {name}")
        return item

    def delete(self, *, user_id: str, name: str) -> bool:
        builder = self._client.table("secrets").delete().eq("name", name)
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.execute()
        return bool(_response_rows(response))

    def read_value(self, *, user_id: str, name: str) -> str | None:
        builder = self._client.table("secrets").select("value")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.eq("name", name).limit(1).execute()
        row = _first_row(response)
        if row is None:
            return None
        ciphertext = _bytea_bytes(row.get("value"))
        if ciphertext is None:
            return None
        plaintext = decrypt_secret(ciphertext)
        used_builder = self._client.table("secrets").update(
            {"last_used_at": datetime.now(timezone.utc).isoformat()}
        ).eq("name", name)
        used_builder = _scope_by_workspace(used_builder, user_id=user_id)
        used_builder.execute()
        return plaintext

    def list_names(self, *, user_id: str) -> set[str]:
        builder = self._client.table("secrets").select("name")
        builder = _scope_by_workspace(builder, user_id=user_id)
        response = builder.order("name").execute()
        return {str(item["name"]) for item in _response_rows(response)}

    def resolve(self, *, user_id: str, names: Iterable[str]) -> dict[str, str]:
        secrets: dict[str, str] = {}
        for name in names:
            value = self.read_value(user_id=user_id, name=name)
            if value:
                secrets[name] = value
        return secrets


class SupabaseCliAuthRepository(_BaseSupabaseRepository):
    def _normalize_row(self, row: Mapping[str, Any]) -> dict[str, Any]:
        item = dict(row)
        item["scopes"] = _json_load(item.pop("scopes_json", None), [])
        return item

    def create_device(self, *, user_id: str, **fields: Any) -> dict[str, Any]:
        device_code = fields["device_code"]
        self._client.table("cli_auth_devices").insert(
            {
                "device_code": device_code,
                "user_id": user_id,
                "user_code": str(fields["user_code"]).strip().upper(),
                "status": fields.get("status") or "pending",
                "secret": fields.get("secret"),
                "client_name": fields["client_name"],
                "scopes_json": _json_storage_value(fields.get("scopes"), []),
                "created_ip": fields.get("created_ip"),
                "created_at": fields["created_at"],
                "expires_at": fields["expires_at"],
                "approved_at": fields.get("approved_at"),
            }
        ).execute()
        item = self.get(user_id=user_id, device_code=device_code)
        if item is None:
            raise RuntimeError(f"failed to create cli auth device {device_code}")
        return item

    def verify_device(self, code: str) -> dict[str, Any] | None:
        response = (
            self._client.table("cli_auth_devices")
            .select(
                "device_code,user_id,user_code,status,secret,client_name,scopes_json,created_ip,created_at,expires_at,approved_at"
            )
            .eq("user_code", code.strip().upper())
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def consume(self, code: str) -> dict[str, Any] | None:
        record = self.get_by_device_code(code)
        if record is None:
            return None
        self.delete(device_code=code)
        return record

    def list(self, *, user_id: str) -> list[dict[str, Any]]:
        response = (
            self._client.table("cli_auth_devices")
            .select(
                "device_code,user_id,user_code,status,secret,client_name,scopes_json,created_ip,created_at,expires_at,approved_at"
            )
            .eq("user_id", user_id)
            .order("created_at")
            .order("device_code")
            .execute()
        )
        return [self._normalize_row(row) for row in _response_rows(response)]

    def get(self, *, user_id: str, device_code: str) -> dict[str, Any] | None:
        response = (
            self._client.table("cli_auth_devices")
            .select(
                "device_code,user_id,user_code,status,secret,client_name,scopes_json,created_ip,created_at,expires_at,approved_at"
            )
            .eq("user_id", user_id)
            .eq("device_code", device_code)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def get_by_device_code(self, device_code: str) -> dict[str, Any] | None:
        response = (
            self._client.table("cli_auth_devices")
            .select(
                "device_code,user_id,user_code,status,secret,client_name,scopes_json,created_ip,created_at,expires_at,approved_at"
            )
            .eq("device_code", device_code)
            .limit(1)
            .execute()
        )
        row = _first_row(response)
        return self._normalize_row(row) if row else None

    def update(self, *, device_code: str, **fields: Any) -> dict[str, Any] | None:
        payload: dict[str, Any] = {}
        for key in (
            "user_code",
            "status",
            "secret",
            "client_name",
            "created_ip",
            "created_at",
            "expires_at",
            "approved_at",
        ):
            if key in fields:
                payload[key] = fields[key]
        if "user_code" in payload:
            payload["user_code"] = str(payload["user_code"]).strip().upper()
        if "scopes_json" in fields:
            payload["scopes_json"] = _json_storage_value(fields["scopes_json"], [])
        if payload:
            self._client.table("cli_auth_devices").update(payload).eq(
                "device_code",
                device_code,
            ).execute()
        return self.get_by_device_code(device_code)

    def delete(self, *, device_code: str) -> bool:
        response = (
            self._client.table("cli_auth_devices")
            .delete()
            .eq("device_code", device_code)
            .execute()
        )
        return bool(_response_rows(response))

    def prune_expired(self, *, now_ts: float) -> list[str]:
        response = (
            self._client.table("cli_auth_devices")
            .select("device_code")
            .lte("expires_at", now_ts)
            .execute()
        )
        expired = [str(row["device_code"]) for row in _response_rows(response)]
        if expired:
            self._client.table("cli_auth_devices").delete().in_(
                "device_code",
                expired,
            ).execute()
        return expired
