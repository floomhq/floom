from __future__ import annotations

from typing import Any, Iterable, Protocol

from models import RecentStats, TimeseriesDay

RowDict = dict[str, Any]


class WorkerRepository(Protocol):
    def list(self, *, user_id: str, role: str | None = None) -> list[RowDict]: ...

    def get(self, *, user_id: str, worker_id: str) -> RowDict | None: ...

    def list_for_agent(
        self,
        *,
        user_id: str,
        include_all_users: bool = False,
        stock_worker_ids: Iterable[str] = (),
    ) -> list[RowDict]:
        """Workers visible to the workspace agent (Emily) for *user_id*.

        #1027: lets the chat tools route through the repository Protocol instead
        of reading the SQLite db directly, so non-SQLite backends (cloud
        Supabase) supply their own implementation. *user_id* is the effective
        visibility user id; stock_worker_ids are passed in (caller owns the
        PUBLIC/PROTECTED sets) to avoid a db<-main import cycle. Each row carries
        at least id, name, trigger_type, enabled, owner_id, manifest_json; the
        caller shapes the agent output and applies system/example hiding.
        ``owner_id`` lets the caller exclude seeded stock/example/test workers the
        operator does NOT own so Emily's list matches the owner-scoped dashboard
        grid (round-09 #1 split-brain fix); a backend that cannot supply it may
        omit it and the caller falls back to the prior behaviour.
        """
        ...

    def get_for_agent(
        self,
        *,
        user_id: str,
        worker_id: str,
        stock_worker_ids: Iterable[str] = (),
        allow_fs_fallback: bool = False,
    ) -> RowDict | None:
        """Single worker for the workspace agent, gated by can-view (#1027).

        Returns None when the worker is not viewable by *user_id* or is absent.
        *user_id* is the effective visibility user id; stock_worker_ids and
        allow_fs_fallback are passed in to avoid a db<-main import cycle. Row
        carries id, name, trigger_type, enabled, cron_expr, manifest_json.
        """
        ...

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

    # -- worker_triggers (normalized multi-trigger rows) ---------------------

    def reconcile_triggers(
        self,
        *,
        worker_id: str,
        triggers: list[dict[str, Any]],
        external_trigger_id: str | None = None,
        enabled: bool = True,
    ) -> list[RowDict]: ...

    def list_trigger_rows(self, *, worker_id: str) -> list[RowDict]: ...

    def list_due_schedule_triggers(self, *, now_iso: str) -> list[RowDict]: ...

    def claim_schedule_trigger(
        self,
        *,
        trigger_id: str,
        now_iso: str,
        locked_until: str,
    ) -> bool: ...

    def set_trigger_next_run_at(self, *, trigger_id: str, next_run_at: str | None) -> None: ...

    def mark_trigger_fired(
        self,
        *,
        trigger_id: str,
        last_fired_at: str,
        next_run_at: str | None,
    ) -> None: ...

    def find_trigger_by_external_id(
        self,
        *,
        external_trigger_id: str,
        user_id: str | None = None,
        workspace_id: str | None = None,
    ) -> RowDict | None: ...

    def find_trigger_for_webhook(self, *, worker_id: str) -> RowDict | None: ...

    def count_schedule_trigger_rows(self) -> int: ...


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
        include_total: bool = True,
    ) -> tuple[list[RowDict], int]: ...

    def list_operator_visible(
        self,
        *,
        user_id: str,
        worker_id: str | None = None,
        statuses: list[str] | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 50,
        before_created_at: str | None = None,
        before_id: str | None = None,
        offset: int = 0,
        include_system: bool = False,
    ) -> tuple[list[RowDict], int]: ...

    def overview_status_rollup(
        self,
        *,
        user_id: str,
        since: str,
        window_7d: str,
        today_start: str,
    ) -> list[RowDict]: ...

    def overview_sparkline_buckets(
        self,
        *,
        user_id: str,
        since: str,
        until: str,
        bucket_seconds: int,
    ) -> list[RowDict]: ...

    def overview_current_counts(
        self,
        *,
        user_id: str,
        statuses: list[str],
    ) -> dict[str, int]: ...

    def overview_top_completed_by_worker(
        self,
        *,
        user_id: str,
        since: str,
        limit: int,
    ) -> list[RowDict]: ...

    def overview_recent_visible_runs(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        limit: int,
    ) -> list[RowDict]: ...

    def overview_latest_failures_by_worker(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        since: str,
        limit: int,
    ) -> list[RowDict]: ...

    def overview_terminal_runs(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        since: str,
        per_worker_limit: int = 10,
    ) -> list[RowDict]: ...

    def get(self, *, user_id: str, run_id: str) -> RowDict | None: ...

    def get_any(self, *, run_id: str) -> RowDict | None: ...

    def count_child_runs(self, *, parent_run_id: str) -> int:
        """Number of child runs spawned by a parent run via worker-to-worker calls.

        Child runs carry the parent's run id in ``trigger_ref``. Used to enforce
        the per-run fan-out cap (run_token.MAX_WORKER_CALLS_PER_RUN).
        """
        ...

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

    def add_logs(self, *, rows: Iterable[RowDict]) -> None: ...

    def list_logs(
        self,
        *,
        user_id: str,
        run_id: str,
        limit: int | None = 10_000,
    ) -> list[RowDict]: ...

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

    def list_artifacts(
        self,
        *,
        user_id: str,
        run_id: str,
        limit: int | None = 1_000,
    ) -> list[RowDict]: ...

    def list_artifacts_for_runs(
        self,
        *,
        user_id: str,
        run_ids: list[str],
        limit_per_run: int | None = 1_000,
    ) -> dict[str, list[RowDict]]: ...

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

    def claim_queued(
        self,
        *,
        user_id: str,
        run_id: str,
        started_at: str,
    ) -> RowDict | None: ...

    def count_queued(self) -> int: ...

    def fail_running(self, *, user_id: str, error: str, error_code: str | None = None) -> list[str]: ...

    def fail_stale_running(
        self,
        *,
        cutoff_iso: str,
        exclude_run_ids: Iterable[str] = (),
        error: str,
        error_code: str | None = None,
    ) -> list[RowDict]: ...

    def fail_stale_running_without_sandbox_logs(
        self,
        *,
        cutoff_iso: str,
        exclude_run_ids: Iterable[str] = (),
        error: str,
        error_code: str | None = None,
    ) -> list[RowDict]: ...

    def fail_all_pending_approval(
        self,
        *,
        error: str,
        error_code: str | None = None,
    ) -> list[RowDict]: ...


class ConnectionRepository(Protocol):
    def list(self, *, user_id: str) -> list[RowDict]: ...

    def get(self, *, user_id: str, composio_id: str) -> RowDict | None: ...

    def get_by_composio_connection_id(self, *, composio_connection_id: str) -> RowDict | None: ...

    def find_by_app_account(
        self,
        *,
        user_id: str,
        app_name: str,
        account_label: str,
        exclude_id: str | None = None,
    ) -> RowDict | None: ...

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

    # #1071 — workspace-scoped secrets. The route passes a real actor_id +
    # workspace_id rather than a SQLite-encoded synthetic actor, so non-SQLite
    # repos (e.g. Supabase) can stamp the real owner + active workspace.
    def list_workspace_secrets(self, *, workspace_id: str) -> list[RowDict]: ...

    def get_workspace_secret(self, *, workspace_id: str, name: str) -> RowDict | None: ...

    def set_workspace_secret(
        self, *, workspace_id: str, actor_id: str, name: str, value: str, status: str = "set"
    ) -> RowDict: ...

    def delete_workspace_secret(self, *, workspace_id: str, name: str) -> bool: ...


class ApprovalRepository(Protocol):
    def create(self, *, owner_id: str, **fields: Any) -> RowDict: ...

    def get(self, *, owner_id: str, approval_id: str) -> RowDict | None: ...

    def get_public(self, *, approval_id: str) -> RowDict | None: ...

    def get_by_run_id(self, *, run_id: str) -> RowDict | None: ...

    def get_by_follow_up_run_id(self, *, follow_up_run_id: str) -> RowDict | None:
        """Return the approval whose ``follow_up_run_id`` matches (the engine-
        spawned execution run for an approved decision), or ``None``.

        #418: the authoritative signal that a run is the post-approval EXECUTE
        phase. Only ``approve_run`` ever sets ``follow_up_run_id``, so this
        cannot be spoofed by a caller-supplied input or trigger_source.
        """
        ...

    def expire_if_stale(self, *, approval_id: str, now_iso_str: str) -> bool:
        """#798 LAZY: atomically flip one pending approval past its expires_at
        to 'expired' and move its run off pending_approval. Returns True iff
        this call performed the flip (idempotent + race-safe via a guarded
        UPDATE). Mirrors the hourly sweep's per-row logic.
        """
        ...

    def list_pending(self, *, owner_id: str, limit: int = 100) -> list[RowDict]: ...

    def count_pending(self, *, owner_id: str) -> int: ...

    def approve(
        self,
        *,
        owner_id: str,
        run_id: str,
        decided_at: str,
        edited_output_json: str | None = None,
        follow_up_run_id: str | None = None,
        annotations_json: str | None = None,
        reason: str | None = None,
    ) -> RowDict | None:
        """Atomically flip the pending approval to 'approved'.

        #280: returns the flipped row, or ``None`` if no pending row was
        flipped (a concurrent caller already decided this approval). Callers
        that gate a side effect MUST check for ``None`` and abort.
        """
        ...

    def attach_follow_up(
        self,
        *,
        owner_id: str,
        run_id: str,
        follow_up_run_id: str,
        edited_output_json: str | None = None,
    ) -> RowDict | None:
        """#280: attach the spawned follow-up run id to an already-approved row.

        The approve route claims the decision atomically *before* spawning the
        follow-up run, then records the run id in this second step.
        """
        ...

    def reject(
        self,
        *,
        owner_id: str,
        run_id: str,
        decided_at: str,
        reason: str | None = None,
        annotations_json: str | None = None,
    ) -> RowDict | None:
        """Atomically flip the pending approval to 'rejected'.

        #280: returns the flipped row, or ``None`` if a concurrent caller
        already decided this approval. Callers MUST check for ``None``.
        """
        ...


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


class WorkspaceMemberRepository(Protocol):
    """Workspace-level RBAC membership.

    Roles: owner / admin / member. Status: active / invited / removed.
    On the OSS single-owner engine this collapses to exactly one active owner
    row per workspace; Cloud implements the same Protocol against Supabase with
    RLS keyed off these rows. ``actor_id`` is the user performing a mutation, so
    implementations enforce the permission matrix (only owner changes roles /
    transfers ownership; owner+admin invite/remove members; admin cannot target
    owner/admin) rather than trusting the caller.
    """

    def list(self, *, workspace_id: str) -> list[RowDict]: ...

    def get(self, *, workspace_id: str, user_id: str) -> RowDict | None: ...

    def invite(self, *, workspace_id: str, email: str, role: str, invited_by: str) -> RowDict: ...

    def set_role(self, *, workspace_id: str, actor_id: str, user_id: str, role: str) -> RowDict | None: ...

    def remove(self, *, workspace_id: str, actor_id: str, user_id: str) -> bool: ...

    def transfer_owner(self, *, workspace_id: str, actor_id: str, new_owner_id: str) -> RowDict: ...


class AssetAccessRepository(Protocol):
    """Per-asset visibility + computed permissions.

    ``get_permissions`` resolves the (can_edit/can_run/can_delete/can_share)
    matrix for ``user_id`` against an asset, combining the asset's owner_id +
    visibility with the user's workspace role. ``set_visibility`` flips an
    asset between private / workspace (specific_people reserved). On the OSS
    single-owner engine the actor is always the owner, so every permission is
    granted for their own assets and private assets stay invisible to non-owners.
    ``asset_type`` is currently ``"worker"`` (brain/assistant land in later steps).
    """

    def get_permissions(
        self, *, workspace_id: str, user_id: str, asset_type: str, asset_id: str
    ) -> RowDict: ...

    def set_visibility(
        self, *, workspace_id: str, actor_id: str, asset_type: str, asset_id: str, visibility: str
    ) -> RowDict | None: ...

    def transfer_asset_owner(
        self, *, workspace_id: str, actor_id: str, asset_type: str, asset_id: str, new_owner_id: str
    ) -> RowDict | None: ...

    def rename_asset(
        self, *, asset_type: str, old_asset_id: str, new_asset_id: str
    ) -> RowDict | None:
        """Re-key an asset's access row (brain-pack rename moves its row, never
        leaving a stale one behind). Returns the moved row, or ``None`` when no
        source row exists. Deletes any row already at ``new_asset_id`` first."""
        ...


class UserRepository(Protocol):
    """Local user accounts for multi-member OSS deployments (migration 59)."""

    def count(self) -> int: ...

    def create(
        self,
        *,
        user_id: str,
        username: str,
        display_name: str | None,
        password_hash: str,
        role: str,
    ) -> RowDict: ...

    def get(self, *, user_id: str) -> RowDict | None: ...

    def get_by_username(self, *, username: str) -> RowDict | None: ...

    def list(self) -> list[RowDict]: ...

    def update(self, *, user_id: str, **fields: Any) -> RowDict | None: ...

    def delete(self, *, user_id: str) -> bool: ...


class PersonalAccessTokenRepository(Protocol):
    """Per-user long-lived API tokens for API/MCP access (migration 59)."""

    def create(
        self,
        *,
        token_id: str,
        user_id: str,
        name: str,
        token_hash: str,
        expires_at: str | None,
    ) -> RowDict: ...

    def get_by_hash(self, *, token_hash: str) -> RowDict | None: ...

    def list(self, *, user_id: str) -> list[RowDict]: ...

    def delete(self, *, token_id: str, user_id: str) -> bool: ...

    def touch_last_used(self, *, token_id: str, last_used_at: str) -> None: ...

    def rotate(self, *, token_id: str, user_id: str, token_hash: str) -> RowDict | None:
        """Replace the secret hash in place, keeping the same token row (#784)."""
        ...


class UserSessionRepository(Protocol):
    """Server-side sessions for cookie-based web UI auth (migration 59)."""

    def create(self, *, session_id: str, user_id: str, expires_at: str) -> RowDict:
        """Atomically create a session for an *enabled* user.

        Raises ValueError if the user is disabled or missing — the enabled
        check must be atomic with the insert, not a caller pre-check (#848).
        """
        ...

    def get(self, *, session_id: str) -> RowDict | None: ...

    def delete(self, *, session_id: str) -> bool: ...

    def prune_expired(self, *, now_iso: str) -> int: ...


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


class FeedbackRepository(Protocol):
    """Lightweight per-worker feedback comments (SPEC §12)."""

    def add(
        self,
        *,
        feedback_id: str,
        worker_id: str,
        author_id: str,
        author_name: str | None,
        content: str,
        created_at: str,
    ) -> RowDict: ...

    def list(self, *, worker_id: str) -> list[RowDict]: ...

    def get(self, *, feedback_id: str) -> RowDict | None: ...

    def delete(self, *, feedback_id: str, worker_id: str) -> bool: ...
