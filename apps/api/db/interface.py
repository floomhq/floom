from __future__ import annotations

from typing import Any, Iterable, Protocol

from models import RecentStats, TimeseriesDay

RowDict = dict[str, Any]


class WorkerRepository(Protocol):
    def list(self, *, user_id: str) -> list[RowDict]: ...

    def get(self, *, user_id: str, worker_id: str) -> RowDict | None: ...

    def get_any(self, *, worker_id: str) -> RowDict | None: ...

    def create(self, *, user_id: str, **fields: Any) -> RowDict: ...

    def update(self, *, user_id: str, worker_id: str, **fields: Any) -> RowDict | None: ...

    def upsert(self, *, user_id: str, **fields: Any) -> RowDict:
        """Insert-or-update a worker row from a discovered-worker dict.

        Implementations MUST be idempotent: if a row with the same id
        already exists for this user_id it is updated in place; otherwise
        it is inserted. Used by _persist_discovered_workers to sync the
        canonical store after a worker is drafted or its files change on
        disk.
        """
        ...

    def delete(self, *, user_id: str, worker_id: str) -> bool: ...

    def list_recent_runs(self, *, user_id: str, worker_id: str, limit: int = 10) -> list[RowDict]: ...

    def get_last_run(self, *, user_id: str, worker_id: str) -> RowDict | None: ...

    def stats_batch(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        days: int = 7,
    ) -> dict[str, RecentStats]: ...

    def timeseries_batch(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        days: int = 14,
    ) -> dict[str, list[TimeseriesDay]]: ...

    def get_owner(self, *, worker_id: str) -> str | None: ...

    def list_scheduled(self) -> list[RowDict]: ...

    def get_schedule_state(self, *, worker_id: str) -> RowDict | None: ...

    def set_next_run_at(self, *, worker_id: str, next_run_at: str | None) -> None: ...

    def mark_scheduled_run(
        self,
        *,
        worker_id: str,
        last_scheduled_run_at: str,
        next_run_at: str | None,
    ) -> None: ...

    def list_active_run_ids(self, *, user_id: str, worker_id: str) -> list[str]: ...

    def get_skill_version_ref_count(self, *, skill_version_id: str | None) -> int: ...

    def delete_skill_version(self, *, skill_version_id: str) -> None: ...

    def get_recipe(self, *, worker_id: str, user_id: str | None = None) -> RowDict | None: ...

    def upsert_webhook_secret_hash(
        self,
        *,
        worker_id: str,
        secret_hash: str,
        created_at: str,
        rotated_at: str,
    ) -> None: ...

    def get_webhook_secret_hash(self, *, worker_id: str) -> str | None: ...

    def delete_webhook_secret(self, *, worker_id: str) -> bool: ...


class RunRepository(Protocol):
    def list_for_worker(
        self,
        *,
        user_id: str,
        worker_id: str,
        limit: int,
        offset: int,
    ) -> list[RowDict]: ...

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
    ) -> tuple[list[RowDict], int]: ...

    def get(self, *, user_id: str, run_id: str) -> RowDict | None: ...

    def get_any(self, *, run_id: str) -> RowDict | None: ...

    def create(self, *, user_id: str, **fields: Any) -> RowDict: ...

    def update(self, *, user_id: str, run_id: str, **fields: Any) -> RowDict | None: ...

    def delete(self, *, user_id: str, run_id: str) -> bool: ...

    def set_input_json(self, *, user_id: str, run_id: str, input_json: dict[str, Any]) -> None: ...

    def update_status(
        self,
        *,
        user_id: str,
        run_id: str,
        status: str,
        output_json: dict[str, Any] | None = None,
        error: str | None = None,
        error_code: str | None = None,
    ) -> None: ...

    def add_log(
        self,
        *,
        user_id: str,
        run_id: str,
        level: str,
        message: str,
        timestamp: str,
        trace_id: str | None = None,
    ) -> None: ...

    def list_logs(self, *, user_id: str, run_id: str) -> list[RowDict]: ...

    def list_logs_for_worker(
        self,
        *,
        user_id: str,
        worker_id: str,
        level: str | None = None,
        since: str | None = None,
        limit: int = 200,
    ) -> list[RowDict]: ...

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
    ) -> None: ...

    def list_artifacts(self, *, user_id: str, run_id: str) -> list[RowDict]: ...

    def clear_all(self, *, user_id: str) -> int: ...

    def list_all_ids(self, *, user_id: str) -> list[RowDict]: ...

    def cancel(self, *, user_id: str, run_id: str, cancelled_at: str) -> RowDict | None: ...

    def count_running_for_worker(self, *, user_id: str, worker_id: str) -> int: ...

    def set_bundle_snapshot_path(
        self,
        *,
        user_id: str,
        run_id: str,
        bundle_snapshot_path: str | None,
    ) -> None: ...

    def get_bundle_snapshot_path(self, *, user_id: str, run_id: str) -> str | None: ...

    def get_queued(self, *, limit: int = 50) -> list[RowDict]: ...

    def count_queued(self) -> int: ...

    def fail_running(self, *, user_id: str, error: str, error_code: str | None = None) -> list[str]: ...


class ConnectionRepository(Protocol):
    def list(self, *, user_id: str) -> list[RowDict]: ...

    def get(self, *, user_id: str, composio_id: str) -> RowDict | None: ...

    def get_by_composio_connection_id(self, *, composio_connection_id: str) -> RowDict | None: ...

    def upsert(self, *, user_id: str, **fields: Any) -> RowDict: ...

    def update(self, *, user_id: str, composio_id: str, **fields: Any) -> RowDict | None: ...

    def delete(self, *, user_id: str, composio_id: str) -> bool: ...

    def list_all(self) -> list[RowDict]: ...


class SecretRepository(Protocol):
    def list(self, *, user_id: str) -> list[RowDict]: ...

    def get(self, *, user_id: str, name: str) -> RowDict | None: ...

    def set(self, *, user_id: str, name: str, value: str, status: str = "set") -> RowDict: ...

    def delete(self, *, user_id: str, name: str) -> bool: ...

    def read_value(self, *, user_id: str, name: str) -> str | None: ...

    def list_names(self, *, user_id: str) -> set[str]: ...

    def resolve(self, *, user_id: str, names: Iterable[str]) -> dict[str, str]: ...


class ApprovalRepository(Protocol):
    def create(self, *, owner_id: str, **fields: Any) -> RowDict: ...

    def get(self, *, owner_id: str, approval_id: str) -> RowDict | None: ...

    def get_public(self, *, approval_id: str) -> RowDict | None: ...

    def get_by_run_id(self, *, run_id: str) -> RowDict | None: ...

    def list_pending(self, *, owner_id: str) -> list[RowDict]: ...

    def count_pending(self, *, owner_id: str) -> int: ...

    def approve(
        self,
        *,
        owner_id: str,
        run_id: str,
        decided_at: str,
        edited_output_json: str | None = None,
        follow_up_run_id: str | None = None,
    ) -> RowDict | None: ...

    def reject(
        self,
        *,
        owner_id: str,
        run_id: str,
        decided_at: str,
        reason: str | None = None,
    ) -> RowDict | None: ...


class CliAuthRepository(Protocol):
    def create_device(self, *, user_id: str, **fields: Any) -> RowDict: ...

    def verify_device(self, code: str) -> RowDict | None: ...

    def consume(self, code: str) -> RowDict | None: ...

    def list(self, *, user_id: str) -> list[RowDict]: ...

    def get(self, *, user_id: str, device_code: str) -> RowDict | None: ...

    def get_by_device_code(self, device_code: str) -> RowDict | None: ...

    def update(self, *, device_code: str, **fields: Any) -> RowDict | None: ...

    def delete(self, *, device_code: str) -> bool: ...

    def prune_expired(self, *, now_ts: float) -> list[str]: ...


class VersionRepository(Protocol):
    """Immutable snapshots of worker, brain-pack, and workspace-instruction state for rollback."""

    def create(
        self,
        *,
        asset_type: str,
        asset_id: str,
        user_id: str,
        snapshot_json: str,
        change_source: str,
        keep: int | None = 20,
    ) -> RowDict: ...

    def list(
        self,
        *,
        asset_type: str,
        asset_id: str,
        limit: int = 50,
    ) -> list[RowDict]: ...

    def get(self, *, version_id: str) -> RowDict | None: ...

    def prune(
        self,
        *,
        asset_type: str,
        asset_id: str,
        keep: int = 20,
    ) -> int: ...

    def delete_for_asset(self, *, asset_type: str, asset_id: str) -> int: ...

    def delete_for_context(self, *, name: str) -> int: ...


class McpToolRepository(Protocol):
    """Custom MCP tools backed by workers, scoped per user/workspace."""

    def list(self, *, user_id: str) -> list[RowDict]: ...

    def get(self, *, user_id: str, tool_id: str) -> RowDict | None: ...

    def get_by_name(self, *, user_id: str, name: str) -> RowDict | None: ...

    def create(
        self,
        *,
        user_id: str,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        worker_id: str,
    ) -> RowDict: ...

    def update(self, *, user_id: str, tool_id: str, **fields: Any) -> RowDict | None: ...

    def delete(self, *, user_id: str, tool_id: str) -> bool: ...


class AlertRepository(Protocol):
    """Webhook and email alert registrations per-worker."""

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
    ) -> RowDict: ...

    def list(self, *, worker_id: str) -> list[RowDict]: ...

    def get(self, *, alert_id: str) -> RowDict | None: ...

    def delete(self, *, alert_id: str, worker_id: str) -> bool: ...
