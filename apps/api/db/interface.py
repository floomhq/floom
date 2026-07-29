from __future__ import annotations

from typing import Any, Iterable, Protocol

from models import RecentStats, TimeseriesDay

RowDict = dict[str, Any]

# Durable run-log evidence that an executor advanced beyond queue claim and
# entered worker execution. Repository implementations use these prefixes to
# distinguish a genuine pre-dispatch orphan from an executor lost mid-run.
# Keep the historical agent and E2B markers so rows written by older releases
# are classified correctly during rolling deploys.
DURABLE_EXECUTION_LOG_PREFIXES = (
    "Executing worker (mode=",
    "Model call ",
    "Tool call:",
    "Tool finished:",
    "[e2b] Preparing sandbox",
    "[e2b] Spawning sandbox",
    "[e2b] Sandbox ready",
    "[e2b] Running worker",
)

# Internal row appended after every terminal transition. It lets a separate
# HTTP process distinguish "run is complete" from "all asynchronous log rows
# are visible" without changing the public run or log response shape.
RUN_LOG_DRAIN_MARKER_LEVEL = "__floom_internal__"
RUN_LOG_DRAIN_MARKER_MESSAGE = "__floom_run_logs_drained__"


class WorkerRepository(Protocol):
    def list(self, *, user_id: str, role: str | None = None) -> list[RowDict]: ...

    def list_summaries(
        self,
        *,
        user_id: str,
        role: str | None = None,
        include_system: bool = False,
        include_archived: bool = False,
        visibility: str | None = None,
        q: str | None = None,
        starred: bool | None = None,
        starred_ids: Iterable[str] = (),
        limit: int | None = None,
        offset: int = 0,
        owner_aliases: Iterable[str] = (),
    ) -> list[RowDict]:
        """Fast worker-card summaries for ``GET /workers?shape=list``.

        Implementations may return rows shaped like ``WorkerListSummary`` and
        avoid building full worker recipes/manifests. Callers fall back to
        ``list`` when this hook is unavailable.
        """
        ...

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

    def list_public_for_workspace(self, *, workspace_id: str, limit: int = 50) -> list[RowDict]:
        """Public/listed workers for a no-login workspace profile."""
        ...

    def resolve_workspace_by_handle(self, *, handle: str) -> RowDict | None:
        """Resolve a workspace row by its stored, unique ``handle`` column.

        Powers the L4 permalink read path (/@{handle}/{slug}). Returns the
        workspace row (id, name, handle, owner_user_id, ...) or None if no
        workspace has that handle. MUST NOT fall back to name-slug matching:
        the handle is a stored column and is the single source of truth.
        """
        ...

    def get_public_by_slug(self, *, workspace_id: str, public_slug: str) -> RowDict | None:
        """Resolve a PUBLIC worker by (workspace_id, public_slug).

        Returns the worker row ONLY when it exists AND its visibility is
        'public'. Non-public or absent -> None (the caller 404s, never
        confirming a private worker's existence). Card projection happens in
        the service layer; this returns the raw row.
        """
        ...

    def get_by_public_slug_any_visibility(self, *, workspace_id: str, public_slug: str) -> RowDict | None:
        """Resolve a worker by (workspace_id, public_slug) regardless of visibility.

        Sibling of ``get_public_by_slug`` WITHOUT the visibility filter: backs
        the ``?share=<token>`` unguessable-key path on the permalink (Fede
        2026-07-06: "one canonical URL per worker forever, access is a
        property not a URL namespace"). Callers MUST still verify a valid
        share token for the returned worker before granting access; this
        method alone does not authorize anything, and by itself is safe to
        call because the caller never returns its result directly to an
        unauthenticated request without that check. Optional capability:
        callers feature-detect via ``getattr(..., None)`` and 404 if absent,
        so an engine pin predating this method degrades to "share links don't
        unlock a private permalink yet" rather than 500ing.
        """
        ...

    def get_workspace_handle(self, *, workspace_id: str) -> str | None:
        """Reverse of ``resolve_workspace_by_handle``: the stored handle for a
        workspace id, or None if unresolvable (unknown id, or an engine pin
        predating the L4 handle column). Used to build a worker's canonical
        permalink path from a worker row that only carries workspace_id.
        """
        ...

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

    def context_worker_counts(self, *, user_id: str) -> dict[str, int]:
        """Map mounted context name to visible-worker count without full list()."""
        ...

    def stats_batch(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        days: int = 7,
        # False is for an explicit worker_ids set authorized by the caller.
        scope_to_owner: bool = True,
    ) -> dict[str, RecentStats]: ...

    def timeseries_batch(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
        days: int = 14,
    ) -> dict[str, list[TimeseriesDay]]: ...

    def schedule_staleness_batch(
        self,
        *,
        user_id: str,
        worker_ids: list[str],
    ) -> dict[str, str | None]:
        """Oldest pending ``next_run_at`` per worker, for schedule-staleness.

        One entry per requested worker id: the MIN ``next_run_at`` across that
        worker's ENABLED schedule trigger rows, or None when it has no enabled
        schedule trigger carrying a slot. Batched (one query for the whole page)
        like ``stats_batch`` / ``timeseries_batch`` so the worker list never pays
        an N+1.

        Why this is the health signal: the scheduler rewrites ``next_run_at`` to
        the next cron slot on BOTH its success and its failure path, so a value
        that has drifted into the past means nothing advanced it, i.e. the
        scheduler process is dead. The caller owns the grace window and the
        status downgrade (see ``services.worker_serialize``); no cron parsing
        happens here.

        Optional hook: every call site MUST tolerate a backend that does not
        implement it (treat every worker as not stale, exactly as before).
        """
        ...

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

    def update_manifest_files(self, *, worker_id: str, files: dict[str, str]) -> bool:
        """Merge ``files`` into the worker's skill_version ``manifest_json._files``.

        This is the portable, backend-agnostic write that makes a worker bundle
        survive container redeploys and run on a *different* executor machine than
        the API that created it (the e2b/agent runners materialize the bundle from
        ``manifest_json._files``). Every backend MUST persist into ITS canonical
        store — SQLite for single-tenant, Supabase/Postgres for cloud — so the
        create path no longer depends on a backend-specific shim.

        Returns ``True`` when the worker's skill_version row was found and updated,
        ``False`` when no such worker/skill_version exists (caller decides whether
        a miss is fatal). Implementations MUST raise on a real write failure rather
        than swallowing it, so a broken bundle never silently reaches 'ready'.
        """
        ...

    def get_recipe(
        self,
        *,
        worker_id: str,
        user_id: str | None = None,
        workspace_id: str | None = None,
    ) -> RowDict | None: ...

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
    def ops_error_code_stats(
        self,
        *,
        error_code: str,
        since_iso: str,
        exclude_run_id: str | None = None,
    ) -> RowDict:
        """Platform-wide failure count and historical existence for OPS alerts."""
        ...

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
        # An explicit set is authoritative and must be authorized by the caller.
        worker_ids: list[str] | None = None,
        statuses: list[str] | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 50,
        offset: int = 0,
        include_total: bool = True,
        workspace_id: str | None = None,
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
        workspace_id: str | None = None,
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

    def cost_total_usd(
        self,
        *,
        user_id: str,
        since: str,
        worker_id: str | None = None,
        actor_user_id: str | None = None,
        workspace_scoped: bool = False,
    ) -> float:
        """Sum run cost in the repository backend for spend-cap enforcement.

        Hosted deployments persist runs outside the engine's local sqlite DB.
        Implementations may scope by worker, actor, or the active workspace.
        """
        ...

    def create(self, *, user_id: str, **fields: Any) -> RowDict: ...

    def update(self, *, user_id: str, run_id: str, **fields: Any) -> RowDict | None: ...

    def add_usage(
        self,
        *,
        user_id: str,
        run_id: str,
        total_tokens: int | None,
        total_cost_usd: float | None,
    ) -> None:
        """Atomically add provider-reported LLM usage to a tenant-owned run."""
        ...

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

    def logs_drained(self, *, user_id: str, run_id: str) -> bool: ...

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

    def get_by_id(self, *, composio_id: str) -> RowDict | None: ...

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

    def create_authorize_link(self, *, link_id: str, user_id: str, redirect_url: str, nonce: str, exp: int, created_at: str) -> RowDict: ...

    def consume_authorize_link(self, *, link_id: str, now: int, consumed_at: str) -> RowDict | None: ...

    def prune_authorize_links(self, *, now: int) -> int: ...


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

    def list_pending_for_workspace(self, *, workspace_id: str, owner_id: str, limit: int = 100) -> list[RowDict]: ...

    def count_pending(self, *, owner_id: str) -> int: ...

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
        approval_id: str | None = None,
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
        self, *, asset_type: str, old_asset_id: str, new_asset_id: str, workspace_id: str
    ) -> RowDict | None:
        """Re-key an asset's access row (brain-pack rename moves its row, never
        leaving a stale one behind). Scoped to ``workspace_id`` because pack
        folders are workspace-local, so a same-named pack in another workspace is
        a different asset and must not be touched. Returns the moved row, or
        ``None`` when no source row exists in that workspace. Deletes any stale
        row already at ``new_asset_id`` in the SAME workspace first. Raises when
        ``new_asset_id`` is held by another workspace (the global ``id`` PK can't
        be re-keyed onto it); callers should ``asset_id_conflict`` first."""
        ...

    def asset_id_conflict(
        self, *, asset_type: str, asset_id: str, workspace_id: str
    ) -> bool:
        """True when an access row for ``asset_id`` exists in a DIFFERENT
        workspace. Asset ids are a global PK while pack folders are
        workspace-local, so a destination name free on disk can still collide
        with another workspace's row; the rename route rejects (409) such a
        name before mutating the filesystem."""
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


class AlertThrottleRepository(Protocol):
    """Persistence for failure-alert throttling (dedup + workspace daily cap).

    Append-only log of failure-alert emails actually sent. Backend-agnostic:
    the throttle POLICY lives in services/alert_throttle.py; this store only
    records sends and counts them over time windows.
    """

    def record(
        self,
        *,
        workspace_id: str,
        worker_id: str,
        signature: str,
        sent_at_iso: str,
    ) -> None: ...

    def reserve(
        self,
        *,
        since_iso: str,
        workspace_id: str,
        worker_id: str,
        signature: str,
        sent_at_iso: str,
    ) -> bool:
        """Atomically record a send only when no matching recent row exists."""
        ...

    def release(
        self,
        *,
        workspace_id: str,
        worker_id: str,
        signature: str,
        sent_at_iso: str,
    ) -> None:
        """Delete an exact reservation after delivery failure."""
        ...

    def count_since(
        self,
        *,
        since_iso: str,
        workspace_id: str | None = None,
        worker_id: str | None = None,
        signature: str | None = None,
    ) -> int: ...

    def clear_dedup(self, *, workspace_id: str, worker_id: str) -> None:
        """Drop this worker's throttle history (called on recovery) so the next
        failure re-alerts immediately instead of waiting out the cooldown
        window. Best-effort. The workspace daily cap is a per-UTC-day backstop
        and still resets at midnight regardless."""
        ...


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


class RunFeedbackRepository(Protocol):
    """Lightweight per-run feedback comments that can be promoted to issues."""

    def add(
        self,
        *,
        feedback_id: str,
        run_id: str,
        worker_id: str,
        author_id: str,
        author_name: str | None,
        content: str,
        rating: str | None,
        created_at: str,
    ) -> RowDict: ...

    def list(self, *, run_id: str) -> list[RowDict]: ...

    def get(self, *, feedback_id: str) -> RowDict | None: ...

    def mark_issue_created(self, *, feedback_id: str, issue_id: str) -> RowDict | None: ...


class WorkerRuleRepository(Protocol):
    """Durable worker-level rules learned from reviewer feedback."""

    def upsert(
        self,
        *,
        rule_id: str,
        workspace_id: str,
        worker_id: str,
        rule_text: str,
        rule_hash: str,
        source: str,
        source_ref: str | None,
        run_id: str | None,
        approval_id: str | None,
        created_by: str,
        created_at: str,
    ) -> RowDict: ...

    def list_active(self, *, workspace_id: str, worker_id: str) -> list[RowDict]: ...


class ShareLinkRepository(Protocol):
    def create_approvals_batch_share(
        self,
        *,
        workspace_id: str,
        owner_id: str,
        token_hash: str,
        expires_at: str | None = None,
    ) -> RowDict: ...

    def resolve_approvals_batch_share(self, *, token_hash: str, now_iso_str: str) -> RowDict | None: ...

    def revoke_approvals_batch_share(
        self,
        *,
        token_hash: str | None = None,
        link_id: str | None = None,
        owner_id: str,
        revoked_at: str,
    ) -> bool: ...

    def revoke_all_for_workspace(self, *, workspace_id: str, owner_id: str, revoked_at: str) -> int: ...
