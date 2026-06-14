"""Run routes: list/detail, exports, cancel/clear, artifact + bundle downloads,
share-links, public run view, SSE streaming (parts + events), and run logs.

The operator-facing /runs surface. The /runs/{id}/composio-execute worker
callback stays in main with the composio proxy. Extracted verbatim from main.py.

Dependency surface is fully services/leaf: run_access (visibility + artifact
serving), run_serialize (run->summary + transcript parsing), sse_streaming
(SSE registry + run-part cluster), share_links (standalone links), public_view
(operator redaction), worker_access (visible worker), core.utils. run_service/
db are imported lazily inside handlers (purged modules); the router is purged in
lockstep with main by the run test fixtures.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import mimetypes
import os
import sqlite3
import time
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
)
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

import auth
from auth import AuthContext, get_auth_context
from core.utils import _parse_iso8601, row_to_dict
from db import DB_PATH, Repositories, get_repos
from models import (
    ActionResponse,
    ApprovalEntry,
    Artifact,
    LogEntry,
    OutputField,
    RunDetail,
    RunStatus,
    RunSummary,
)
from services.public_view import (
    _collapse_stderr_code_echo_rows,
    _operator_error_message,
    _public_artifact_path,
    _public_sse_event,
    _redact_public_log_message,
    _run_error_raw,
)
from services.run_access import (
    _artifact_file_response,
    _get_run_by_explicit_id,
    _get_visible_run,
    _is_sensitive_artifact_row,
    _list_visible_runs,
    _sanitize_download_name,
)
from services.run_serialize import (
    _extract_primary_output_file,
    _extract_total_tokens_from_transcript,
    _make_run_summary,
    _parse_tool_calls_from_transcript,
    _read_transcript_rows,
    _resolve_run_status_filters,
)
from services.share_links import (
    _create_or_get_standalone_share_link,
    _load_standalone_share_row,
    _revoke_standalone_share_link,
)
from services.sse_streaming import (
    _TERMINAL_STATUSES,
    _finish_part_from_run_row,
    _format_run_part_sse,
    _log_replay_parts,
    _parse_last_event_id,
    _run_part_cleanup,
    _run_part_is_finish,
    _run_part_register,
    _run_part_snapshot,
    _sse_cleanup,
    _sse_lock,
    _sse_queues,
    _sse_stream_acquire,
    _sse_stream_release,
)
from services.worker_access import _get_visible_worker

logger = logging.getLogger("floom.api")

runs_router = APIRouter()


@runs_router.get("/runs", response_model=List[RunSummary])
def list_runs(
    response: Response,
    worker_id: Optional[str] = None,
    status: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    include_system: bool = Query(
        False,
        description="Include internal/system runs (audit, test, smoke). Hidden by default.",
    ),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[RunSummary]:
    statuses = _resolve_run_status_filters(status)
    since_dt = _parse_iso8601(since) if since else None
    if since and since_dt is None:
        raise HTTPException(status_code=400, detail="Invalid since value")
    until_dt = _parse_iso8601(until) if until else None
    if until and until_dt is None:
        raise HTTPException(status_code=400, detail="Invalid until value")
    if since_dt and until_dt and since_dt > until_dt:
        raise HTTPException(status_code=400, detail="since must be before until")

    if worker_id and _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos) is None:
        response.headers["X-Total-Count"] = "0"
        return []

    visible_rows, visible_total = _list_visible_runs(
        user_id=auth.user_id,
        repos=repos,
        worker_id=worker_id,
        statuses=statuses,
        since=since_dt.isoformat() if since_dt else None,
        until=until_dt.isoformat() if until_dt else None,
        limit=limit,
        offset=offset,
        include_system=include_system,
    )
    response.headers["X-Total-Count"] = str(visible_total)
    return [_make_run_summary(r) for r in visible_rows]


@runs_router.get("/runs/export.csv")
def export_runs_csv(
    worker_id: Optional[str] = None,
    status: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    limit: int = Query(1000, ge=1, le=10000),
    include_system: bool = Query(False),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """#796: bulk-export the run list as a CSV attachment, with the same
    filters as GET /runs (worker_id, status, since, until). Owner/visibility
    scoped via _list_visible_runs."""
    statuses = _resolve_run_status_filters(status)
    since_dt = _parse_iso8601(since) if since else None
    if since and since_dt is None:
        raise HTTPException(status_code=400, detail="Invalid since value")
    until_dt = _parse_iso8601(until) if until else None
    if until and until_dt is None:
        raise HTTPException(status_code=400, detail="Invalid until value")
    rows, _total = _list_visible_runs(
        user_id=auth.user_id,
        repos=repos,
        worker_id=worker_id,
        statuses=statuses,
        since=since_dt.isoformat() if since_dt else None,
        until=until_dt.isoformat() if until_dt else None,
        limit=limit,
        offset=0,
        include_system=include_system,
    )
    import csv as _csv
    import io as _io
    out = _io.StringIO()
    writer = _csv.writer(out)
    writer.writerow([
        "id", "worker_id", "worker_name", "status", "trigger_source",
        "created_at", "started_at", "completed_at", "duration_ms", "error_code",
    ])
    for r in rows:
        d = row_to_dict(r)
        writer.writerow([
            d.get("id"), d.get("worker_id"), d.get("worker_name"), d.get("status"),
            d.get("trigger_source"), d.get("created_at"), d.get("started_at"),
            d.get("completed_at"), d.get("duration_ms"), d.get("error_code"),
        ])
    return Response(
        content=out.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="runs.csv"'},
    )


_DEFAULT_PRECLEAR_BACKUP_DIR = "/root/backups/manual"


def _preclear_backup_dir() -> str:
    return os.environ.get("WORKEROS_PRECLEAR_BACKUP_DIR") or _DEFAULT_PRECLEAR_BACKUP_DIR


def _live_db_file_path() -> Optional[str]:
    """Resolve the on-disk path of the main SQLite database, or None for
    an in-memory DB. Uses PRAGMA database_list so it reflects the connection
    actually in use rather than a possibly-stale module global."""
    from db import get_db
    with get_db() as conn:
        for row in conn.execute("PRAGMA database_list").fetchall():
            # row: (seq, name, file). The main schema is named 'main'.
            if row["name"] == "main":
                file_path = row["file"]
                return file_path or None
    return None


def _backup_db_before_clear() -> str:
    """Snapshot the live DB to a timestamped file before a destructive clear.

    Uses SQLite ``VACUUM INTO`` for an atomic, WAL-consistent single-file copy.
    Raises on any failure so the caller can ABORT the clear (never wipe without
    a verified backup). Returns the backup file path.
    """
    db_file = _live_db_file_path()
    if not db_file:
        raise RuntimeError("cannot back up an in-memory database before clear")
    backup_dir = _preclear_backup_dir()
    os.makedirs(backup_dir, exist_ok=True)
    backup_path = os.path.join(
        backup_dir, f"floom-preclear-{time.time_ns()}.db"
    )
    # VACUUM cannot run inside a transaction. Use a standalone autocommit
    # connection so callers can safely invoke this before owner-scoped deletes.
    with sqlite3.connect(db_file, timeout=30.0, isolation_level=None) as conn:
        conn.execute("PRAGMA busy_timeout = 30000")
        # VACUUM INTO writes a fresh, fully-consistent copy (no WAL sidecar).
        conn.execute("VACUUM INTO ?", (backup_path,))
    if not os.path.isfile(backup_path) or os.path.getsize(backup_path) == 0:
        raise RuntimeError(f"backup file missing or empty after VACUUM INTO: {backup_path}")
    return backup_path


@runs_router.post("/runs/clear")
def clear_runs(
    confirm: str = Query("", description="Must be 'yes-wipe-all-runs' to proceed."),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Clear the caller's run history.

    Destructive operation. Requires explicit `?confirm=yes-wipe-all-runs`
    query param to proceed.

    Hardened (post-incident 2026-05-29):
    - Backs up the full DB to ``/root/backups/manual/floom-preclear-<epoch>.db``
      BEFORE deleting anything. If the backup fails, the clear is ABORTED.
    - Scopes deletion to the caller (``owner_id``) only — never a global wipe
      of every user's runs.
    """
    if confirm != "yes-wipe-all-runs":
        raise HTTPException(
            status_code=400,
            detail=(
                "Destructive endpoint. Append ?confirm=yes-wipe-all-runs to "
                "proceed. This backs up the DB, then clears YOUR run/log/"
                "artifact history."
            ),
        )
    try:
        backup_path = _backup_db_before_clear()
    except Exception as exc:
        logger.error("Aborting /runs/clear: pre-clear backup failed: %s", exc)
        raise HTTPException(
            status_code=500,
            detail=f"Pre-clear backup failed; clear aborted (no data deleted): {exc}",
        ) from exc
    # clear_all is owner-scoped (WHERE w.owner_id = ?), so this never touches
    # other tenants' runs.
    deleted_count = repos.runs.clear_all(user_id=auth.user_id)
    logger.warning(
        "Run history cleared for user %s (%d runs deleted, backup at %s)",
        auth.user_id,
        deleted_count,
        backup_path,
    )
    return {
        "status": "cleared",
        "cleared_count": deleted_count,
        # Back-compat alias for pre-hardening callers.
        "deleted_runs": deleted_count,
        "backup_path": backup_path,
    }


_TERMINAL_RUN_STATUSES = frozenset({"completed", "failed"})


@runs_router.post("/runs/{run_id}/cancel", response_model=ActionResponse)
def cancel_run(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Request cancellation of an in-flight or queued run.

    For queued runs (not yet dispatched to a sandbox): immediately marks the
    run as failed with error_code=cancelled_queued so no sandbox is ever
    spawned.  Sets cancel_requested=1 first so the drain loop skips the row
    if it is already past the get_queued() poll boundary.

    For running runs: sets cancel_requested=1 and asks the E2B driver to kill
    any registered sandbox command for this run.

    Returns 404 if no cancellable run is visible, 200 if cancellation was
    recorded.
    """
    # Cancellation operates on the caller's own run by explicit id, so it must
    # work for system/meta runs too (e.g. aborting a worker-author generation
    # from the /workers/new GeneratingPanel). The system/audit visibility filter
    # is for the LIST view only.
    from db import now_iso
    from run_service import update_run_status
    row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if row["status"] in _TERMINAL_RUN_STATUSES:
        raise HTTPException(status_code=404, detail="Run not found")

    cancelled_at = now_iso()
    repos.runs.cancel(
        user_id=auth.user_id,
        run_id=run_id,
        cancelled_at=cancelled_at,
    )

    if row["status"] == RunStatus.QUEUED.value:
        # Immediately fail the run so it does not linger in the queued state.
        # The drain loop checks cancel_requested before dispatching, but marking
        # it failed here is cleaner for callers that poll status directly.
        update_run_status(
            run_id,
            RunStatus.FAILED.value,
            error="Run was cancelled before execution started.",
            error_code="cancelled_queued",
            user_id=auth.user_id,
            repos=repos,
        )
        logger.info("Cancelled queued run %s before dispatch", run_id)
        return ActionResponse(status="cancelled", run_id=run_id)

    try:
        from runner_sandbox.e2b_driver import cancel_sandbox

        cancel_sandbox(run_id, reason="User requested cancellation.")
    except Exception:
        logger.warning("Failed to cancel E2B sandbox for run %s", run_id, exc_info=True)

    logger.info("Cancel requested for running run %s", run_id)
    return ActionResponse(status="cancel_requested", run_id=run_id)


# ---------------------------------------------------------------------------
# S47 HITL — approval endpoints
# ---------------------------------------------------------------------------

# --- X4: structured reviewer annotations -----------------------------------
# Caps keep a malicious/fat-fingered reviewer from persisting an unbounded blob
# onto the approval row. These are deliberately generous for a review pass but
# hard ceilings.
# Approval routes moved to routers/approvals.py



class _RunExportRequest(BaseModel):
    run_ids: List[str] = Field(..., min_length=1, max_length=200)


@runs_router.post("/runs/export")
def export_runs_bundle(
    body: _RunExportRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """#796: bulk-export multiple runs as one ZIP — `run-<id>/` per run, reusing
    the single-run bundle's redaction rules (no inputs/logs/transcripts; sensitive
    + out-of-root artifacts skipped)."""
    from runner_utils import ARTIFACTS_DIR
    artifacts_root = ARTIFACTS_DIR.resolve()
    archive_buffer = io.BytesIO()
    included = 0
    with zipfile.ZipFile(archive_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for run_id in body.run_ids:
            run_row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
            if not run_row:
                continue
            run_data = row_to_dict(run_row)
            prefix = f"run-{_sanitize_download_name(str(run_data.get('id') or run_id))}/"
            output_payload = json.loads(run_row["output_json"] or "{}")
            if not isinstance(output_payload, dict):
                output_payload = {}
            metadata = {
                k: run_data.get(k)
                for k in ("id", "worker_id", "status", "trigger_source", "runner",
                          "created_at", "started_at", "completed_at", "duration_ms")
            }
            archive.writestr(prefix + "metadata.json", json.dumps(metadata, indent=2, sort_keys=True))
            archive.writestr(prefix + "outputs.json", json.dumps(output_payload, indent=2, sort_keys=True))
            primary = _extract_primary_output_file(output_payload)
            if primary:
                out_name, out_bytes = primary
                archive.writestr(prefix + out_name, out_bytes)
            for row in repos.runs.list_artifacts(user_id=auth.user_id, run_id=run_id):
                if _is_sensitive_artifact_row(row):
                    continue
                try:
                    resolved = Path(row["path"] or "").resolve()
                    resolved.relative_to(artifacts_root)
                except Exception:
                    continue
                if not resolved.is_file():
                    continue
                safe = _sanitize_download_name(str(row["name"] or resolved.name))
                archive.writestr(prefix + "artifacts/" + safe, resolved.read_bytes())
            included += 1
        if included == 0:
            raise HTTPException(status_code=404, detail="No exportable runs found")
        archive.writestr(
            "README.txt",
            "Bulk run export. Inputs, logs and internal transcripts are omitted.\n",
        )
    archive_buffer.seek(0)
    return Response(
        content=archive_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="runs-export.zip"'},
    )


@runs_router.get("/runs/{run_id}/download")
def download_run_bundle(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    run_row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if not run_row:
        raise HTTPException(status_code=404, detail="Run not found")
    artifact_rows = repos.runs.list_artifacts(user_id=auth.user_id, run_id=run_id)

    output_payload = json.loads(run_row["output_json"] or "{}")
    if not isinstance(output_payload, dict):
        output_payload = {}
    run_data = row_to_dict(run_row)

    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        metadata = {
            "id": run_data.get("id"),
            "worker_id": run_data.get("worker_id"),
            "status": run_data.get("status"),
            "trigger_source": run_data.get("trigger_source"),
            "runner": run_data.get("runner"),
            "created_at": run_data.get("created_at"),
            "started_at": run_data.get("started_at"),
            "completed_at": run_data.get("completed_at"),
            "duration_ms": run_data.get("duration_ms"),
        }
        archive.writestr("metadata.json", json.dumps(metadata, indent=2, sort_keys=True))
        archive.writestr("outputs.json", json.dumps(output_payload, indent=2, sort_keys=True))
        archive.writestr(
            "README.txt",
            "This archive omits run inputs, logs, and internal transcripts. "
            "Use the Workeros UI for redacted run history.\n",
        )

        primary_output = _extract_primary_output_file(output_payload)
        if primary_output:
            output_name, output_bytes = primary_output
            archive.writestr(output_name, output_bytes)

        from runner_utils import ARTIFACTS_DIR

        artifacts_root = ARTIFACTS_DIR.resolve()
        for row in artifact_rows:
            if _is_sensitive_artifact_row(row):
                continue
            path_value = row["path"] or ""
            try:
                resolved = Path(path_value).resolve()
                resolved.relative_to(artifacts_root)
            except Exception:
                continue
            if not resolved.is_file():
                continue
            artifact_name = _sanitize_download_name(str(row["name"] or resolved.name))
            with resolved.open("rb") as handle:
                archive.writestr(f"artifacts/{artifact_name}", handle.read())

    archive_buffer.seek(0)
    short_id = run_id.split("_", 1)[-1][:8] or run_id[:8]
    filename = f"run-{_sanitize_download_name(short_id)}.zip"
    return StreamingResponse(
        archive_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@runs_router.get("/runs/{run_id}/bundle/{filename:path}")
def get_run_bundle_file(
    run_id: str,
    filename: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    if _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos) is None:
        raise HTTPException(status_code=404, detail="Bundle file not found")
    snapshot_path = repos.runs.get_bundle_snapshot_path(user_id=auth.user_id, run_id=run_id)
    if snapshot_path is None:
        raise HTTPException(status_code=404, detail="Bundle file not found")
    if not snapshot_path:
        raise HTTPException(status_code=404, detail="Bundle file not found")

    base_dir = (Path(DB_PATH).resolve().parent / snapshot_path).resolve()
    try:
        target = (base_dir / filename).resolve()
        target.relative_to(base_dir)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid bundle path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Bundle file not found")

    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return FileResponse(path=target, media_type=media_type)


@runs_router.get("/runs/{run_id}/artifacts/{artifact_id}/download")
def download_artifact(
    run_id: str,
    artifact_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    if _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos) is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    row = next(
        (
            artifact
            for artifact in repos.runs.list_artifacts(user_id=auth.user_id, run_id=run_id)
            if artifact["id"] == artifact_id
        ),
        None,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Artifact not found")
    return _artifact_file_response(row)


@runs_router.get("/runs/{run_id}", response_model=RunDetail, response_model_exclude_none=True)
def get_run(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> RunDetail:
    from run_service import get_worker_config_for_run, queued_run_position
    run = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    run["output"] = json.loads(run.get("output_json") or "{}")
    run["outputs"] = run["output"]
    # Build typed output schema from worker config
    output_config = get_worker_config_for_run(run["worker_id"])
    output_schema = []
    if output_config:
        raw_output = run["output"]
        for out in output_config.outputs:
            output_schema.append(OutputField(
                name=out.name,
                label=out.label,
                type=out.type,
                value=raw_output.get(out.name),
            ))

    # G5 P1: collapse the e2b stderr code-echo on the RAW ordered rows FIRST
    # (frame + caret anchors intact), THEN per-row redact each survivor.
    _raw_log_rows = [
        {"level": r["level"], "message": r["message"], "timestamp": r["timestamp"]}
        for r in repos.runs.list_logs(user_id=auth.user_id, run_id=run_id)
    ]
    logs = [
        LogEntry(
            level=row["level"],
            message=_redact_public_log_message(row["message"]),
            timestamp=row["timestamp"],
        )
        for row in _collapse_stderr_code_echo_rows(_raw_log_rows)
    ]

    _artifact_rows = repos.runs.list_artifacts(user_id=auth.user_id, run_id=run_id)
    _has_sensitive_run_artifacts = any(_is_sensitive_artifact_row(r) for r in _artifact_rows)
    artifacts = [
        Artifact(
            id=r["id"],
            run_id=r["run_id"],
            name=r["name"],
            type=row_to_dict(r).get("type"),
            # PATH-1: never return the absolute host path; expose only the path
            # relative to the artifacts root. Download resolves the real path
            # server-side from the artifact id.
            path=_public_artifact_path(r["path"]),
            relative_path=_public_artifact_path(r["path"]),
            size_bytes=row_to_dict(r).get("size_bytes"),
            created_at=r["created_at"],
        )
        for r in _artifact_rows
        if not _is_sensitive_artifact_row(r)
    ]
    transcript: List[Dict[str, Any]] = []

    queue_position: Optional[int] = None
    if run["status"] == RunStatus.QUEUED.value:
        pos = queued_run_position(run_id)
        queue_position = pos if pos > 0 else None

    # #561: parse the run's actual input from the stored JSON.
    run_input: Dict[str, Any] = {}
    _raw_input_json = run.get("input_json")
    if _raw_input_json:
        try:
            run_input = json.loads(_raw_input_json) if isinstance(_raw_input_json, str) else _raw_input_json
            if not isinstance(run_input, dict):
                run_input = {}
        except Exception:
            run_input = {}
    if _has_sensitive_run_artifacts:
        run_input = {}

    # #561: extract structured tool calls and token usage from transcript artifact.
    _transcript_rows = _read_transcript_rows(run.get("runner", ""), artifacts)
    _tool_calls = _parse_tool_calls_from_transcript(_transcript_rows)
    _total_tokens = _extract_total_tokens_from_transcript(_transcript_rows)

    # #561: approval trail — single approval row per run (if any).
    _approval_trail: Optional[ApprovalEntry] = None
    try:
        _appr_row = repos.approvals.get_by_run_id(run_id=run_id)
        if _appr_row:
            _approval_trail = ApprovalEntry(
                id=str(_appr_row.get("id", "")),
                status=str(_appr_row.get("status", "pending")),
                label=_appr_row.get("label"),
                preview=_appr_row.get("preview"),
                created_at=str(_appr_row.get("created_at", "")),
                decided_at=_appr_row.get("decided_at"),
                reason=_appr_row.get("reason"),
                follow_up_run_id=_appr_row.get("follow_up_run_id"),
            )
    except Exception:
        pass

    # #561: replay is available for terminal statuses.
    _terminal_statuses = {RunStatus.COMPLETED.value, RunStatus.FAILED.value}
    _can_replay = run.get("status") in _terminal_statuses

    return RunDetail(
        id=run["id"],
        worker_id=run["worker_id"],
        # PR S21: query already SELECTs worker_name (line ~3670) but it was
        # never plumbed through to the response model — UI showed the slug.
        worker_name=run.get("worker_name"),
        status=RunStatus(run["status"]),
        trigger_source=run["trigger_source"],
        runner=run["runner"],
        input=run_input,
        inputs=run_input,
        output=run["output"],
        outputs=run["output"],
        output_schema=output_schema,
        logs=logs,
        artifacts=artifacts,
        transcript=transcript,
        tool_calls=_tool_calls,
        approval_trail=_approval_trail,
        can_replay=_can_replay,
        total_tokens=_total_tokens,
        error=_operator_error_message(run.get("error"), run.get("error_code")),
        # Raw error/traceback kept only for the debug "Raw" tab, secrets redacted.
        # Surfaced separately so it is never the operator-facing headline. We keep
        # it whenever the operator headline differs from the raw text (artifact,
        # runtime jargon, or error_code mapping) so engineers can still see it.
        error_raw=_run_error_raw(run.get("error"), run.get("error_code")),
        error_code=run.get("error_code"),
        started_at=run.get("started_at"),
        completed_at=run.get("completed_at"),
        duration_ms=run.get("duration_ms"),
        created_at=run.get("created_at"),
        queue_position=queue_position,
    )


@runs_router.post("/runs/{run_id}/share-link")
def create_run_share_link(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    """#765: mint a read-only public share link for a run. Owner only.

    Reuses the standalone_share_links infra (entity_type='run'); recipients
    open the run via GET /runs/public/{run_id}?token= with no sign-in.
    """
    run = _get_visible_run(run_id, user_id=auth.user_id, repos=repos)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return _create_or_get_standalone_share_link(
        entity_type="run",
        entity_id=run_id,
        owner_id=auth.user_id,
    )


@runs_router.delete("/runs/{run_id}/share-link")
def revoke_run_share_link(
    run_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#765/#766: revoke a run's public share link."""
    run = _get_visible_run(run_id, user_id=auth.user_id, repos=repos)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return _revoke_standalone_share_link(
        entity_type="run", entity_id=run_id, owner_id=auth.user_id,
    )


@runs_router.get("/runs/public/{run_id}", response_model=RunDetail)
def get_public_run(
    run_id: str,
    token: str = Query(..., min_length=10),
    repos: Repositories = Depends(get_repos),
) -> RunDetail:
    """#765: read-only run view for a signed share link, no auth required.

    The token must resolve to a 'run' share row for THIS run_id; the run is
    then rendered under the share owner's identity (same builder as the authed
    GET /runs/{id}). 404 for any token/run mismatch — never leaks another run.
    """
    row = _load_standalone_share_row(token)
    if not row or str(row.get("entity_type")) != "run" or str(row.get("entity_id")) != run_id:
        raise HTTPException(status_code=404, detail="Run not found")
    owner_auth = AuthContext(user_id=str(row.get("owner_id") or ""), email=None, scopes=("run_share",))
    return get_run(run_id, auth=owner_auth, repos=repos)


@runs_router.get("/runs/{run_id}/stream")
async def stream_run_parts(
    run_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Server-Sent Events stream of AI SDK parts for a single run."""
    row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")

    last_seen = _parse_last_event_id(request.headers.get("last-event-id"))

    # Per-user concurrent-stream cap (Round 16 DoS finding). Acquire
    # synchronously so the 429 is returned before the StreamingResponse.
    stream_slot = _sse_stream_acquire(auth.user_id)

    async def event_generator():
        try:
            snapshot = _run_part_snapshot(run_id)
            if snapshot is None:
                final_part = _finish_part_from_run_row(row)
                if final_part is not None:
                    # #188: the in-memory part buffer is gone (terminal run past its
                    # TTL, or a fresh server process). Replay persisted log rows so
                    # the client reconstructs the transcript instead of receiving a
                    # bare finish event.
                    event_id = 0
                    for log_part in _log_replay_parts(repos, auth.user_id, run_id):
                        if event_id > last_seen:
                            yield _format_run_part_sse(event_id, log_part)
                        event_id += 1
                    if event_id > last_seen:
                        yield _format_run_part_sse(event_id, final_part)
                    return
                snapshot = {"parts": [], "finished": False}

            for event_id, part in snapshot["parts"]:
                if event_id > last_seen:
                    yield _format_run_part_sse(event_id, part)

            if snapshot["finished"]:
                return

            q: asyncio.Queue = asyncio.Queue(maxsize=512)
            loop = asyncio.get_running_loop()
            _run_part_register(run_id, q, loop)
            try:
                while True:
                    if await request.is_disconnected():
                        break

                    try:
                        event_id, part = await asyncio.wait_for(q.get(), timeout=5.0)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue

                    yield _format_run_part_sse(event_id, part)
                    if _run_part_is_finish(part):
                        break
            finally:
                _run_part_cleanup(run_id, q)
        finally:
            _sse_stream_release(stream_slot)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@runs_router.get("/runs/{run_id}/events")
async def stream_run_events(
    run_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Server-Sent Events stream for a single run.

    Emits one ``data: <json>\\n\\n`` line per state change: status updates,
    log lines, artifact additions.

    Closes automatically when the run reaches a terminal state (completed,
    failed, approved, rejected).

    Memory management:
    - Queue is registered in _sse_queues when consumer connects.
    - Queue is removed in _sse_cleanup when consumer disconnects or run ends.
    - If run is already terminal when client connects, current state is emitted
      immediately then the stream closes.
    """
    run_row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if not run_row:
        raise HTTPException(status_code=404, detail="Run not found")

    initial_status = run_row["status"]
    already_terminal = initial_status in _TERMINAL_STATUSES

    # Per-user concurrent-stream cap (Round 16 DoS finding). Acquire
    # synchronously so the 429 is returned before the StreamingResponse.
    stream_slot = _sse_stream_acquire(auth.user_id)

    async def event_generator():
        try:
            q: asyncio.Queue = asyncio.Queue(maxsize=512)

            # If run already terminal, emit current state and close immediately
            if already_terminal:
                final_row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
                if final_row:
                    evt = _public_sse_event({
                        "type": "status",
                        "run_id": run_id,
                        "status": final_row["status"],
                        "error": final_row["error"],
                        "completed_at": final_row["completed_at"],
                        "duration_ms": final_row["duration_ms"],
                    })
                    yield f"data: {json.dumps(evt)}\n\n"
                yield "data: {\"type\": \"close\"}\n\n"
                return

            # Register the consumer queue with its bound event loop
            loop = asyncio.get_running_loop()
            with _sse_lock:
                _sse_queues.setdefault(run_id, []).append((q, loop))

            try:
                while True:
                    # Check for client disconnect
                    if await request.is_disconnected():
                        break

                    try:
                        event = await asyncio.wait_for(q.get(), timeout=5.0)
                    except asyncio.TimeoutError:
                        # Send keepalive comment
                        yield ": keepalive\n\n"
                        continue

                    yield f"data: {json.dumps(event)}\n\n"

                    # Close stream if run reached terminal state
                    evt_type = event.get("type")
                    evt_status = event.get("status", "")
                    if evt_type == "close" or evt_status in _TERMINAL_STATUSES:
                        break
            finally:
                _sse_cleanup(run_id, q)
        finally:
            _sse_stream_release(stream_slot)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# A single traceback FRAME line: '  File "...", line N, in name' or the bare
# source line printed under it. After path-scrubbing these become noise like
# 'File "[worker file]", line 9, in main'.
# A final 'ExcClass: message' line (TypeError: ...), or a bare Traceback header.
# G5 P1 (2026-05-29): the residual e2b stderr code-echo. Each stderr line is
# emitted as a SEPARATE log row (e2b_driver._emit_command_output splits + strips
# per line), so the multiline-collapse in _redact_runtime_jargon_in_log never
# sees the block, and the single-line branch only matched traceback/exc regexes.
# Three line classes still leaked verbatim to the operator "Recent logs" panel:
#   - the caret marker line  '~~~~~~~~^~~~~~~~~'  (Python 3.11+ error-pointer)
#   - the Command-exit boilerplate  'Command exited with code 1'
#   - the source-line echo  'quotient = number1 / number2' (the line above the caret)
# The caret line is the unambiguous anchor: Python ALWAYS prints the offending
# source line immediately ABOVE the caret. So we collapse these at the ORDERED
# log-list level (where adjacency is preserved) with ZERO false positives — a
# clean stderr print only gets collapsed if it is itself caret-only or the row
# directly followed by a caret row.
# Strip the streaming '[e2b] stderr: ' / '[e2b] ' prefix so the markers above
# match the content even after the driver prepends a channel label.
# ---------------------------------------------------------------------------
# Operator-surface hygiene (G5): nothing internal is ever shown to operators.
#
# Raw Python tracebacks, sandbox paths (/home/user/worker/run.py), and env-var
# names must never be the operator-facing error or archive reason. We map them
# to a calm, human, actionable headline. The raw text is preserved separately
# (run.error_raw / the Logs tab) for engineers who need it.
# ---------------------------------------------------------------------------

# Sandbox/runtime paths that should never appear in an operator string.
# Bare ALL_CAPS env-var-style identifiers (FOO_BAR_TOKEN), 2+ segments so we
# don't eat normal words like "OK" or "JSON".
# Internal git branch / lane identifiers (lane/x, feat/x, fix/x, chore/x, …).
# Structured error_code -> calm operator headline. This is the PRIMARY mapping:
# the run pipeline already classifies every failure into this taxonomy, so we
# key the operator headline off the code FIRST (before any free-text matching).
# That guarantees no raw runtime/sandbox jargon reaches the operator surface,
# even when the raw string carries no traceback / path / env-var artifact.
#
# Any code not listed here falls through to _OPERATOR_ERROR_RULES (free-text)
# and then to the generic fallback, so every failure gets a clean headline.
# Generic fallback for any unknown / future error_code — never raw jargon.
# Ordered (pattern, operator-message) map. First hit wins for the headline.
# Free-text fallback used only when error_code is absent or unrecognised.
# A worker's OWN code crashing (NameError, FileNotFoundError, etc. raised inside
# its run.py) must read as a CODE error the operator can fix/re-generate, NOT as
# a platform "internal error" and NEVER as "took too long". The E2B driver wraps
# such a crash as error_code=execution_error (non-zero exit) or e2b_sandbox_error
# with the exception class name in the raw string. Detect those classes so we can
# route them to _CODE_HEADLINE before the generic code-taxonomy mapping.
# Bare Python exception MESSAGES that carry no exception-class name (so
# _WORKER_CODE_TRACEBACK_RE misses them) yet are unmistakably worker-code-crash
# jargon. e.g. a TypeError stringified as just its message
# ("unsupported operand type(s) for /: 'str' and 'float'") with error_code=None.
# These must read as a CODE error, never leak verbatim to the operator (P0-2).
# Error codes whose raw text can legitimately carry a worker-code traceback
# (the worker's run.py crashed). For these, a code-class traceback in the raw
# string outranks the generic headline so the operator sees "code has an error".
# The smoke pipeline builds its `reason` as "<raw error> (error_code=<code>)"
# (run_service `smoke_and_gate_generated_worker`). The raw error can carry a
# sandbox path (/home/user/worker/run.py) or a bare Python exception, so the
# reason must never leave the backend verbatim — it reaches the operator via
# the draft-and-create response and the worker-author SSE event.
# The smoke pipeline also builds reasons as "<code>: <raw error>" (e.g.
# "output_validation_failed: worker reported success but produced no real
# output"). The leading code prefix must be stripped and routed through the
# operator-headline path too, never leaked verbatim.
# Raw runtime/sandbox boilerplate that is artifact-free (no traceback/path/env)
# yet pure jargon to an operator. Used to stop these from passing through
# verbatim when an error_code is missing or unrecognised.


@runs_router.get("/runs/{run_id}/logs")
def get_run_logs(
    run_id: str,
    level: Optional[str] = Query(None, description="Filter by log level (info, warning, error, debug)"),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[Dict[str, Any]]:
    if _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos) is None:
        raise HTTPException(status_code=404, detail="Run not found")
    rows = repos.runs.list_logs(user_id=auth.user_id, run_id=run_id)
    # G5 P1: collapse the e2b stderr code-echo on RAW ordered rows FIRST, THEN
    # per-row redact, so GET /runs/{id}/logs matches the calm panel.
    raw = [
        {"level": r["level"], "message": r["message"], "timestamp": r["timestamp"]}
        for r in rows
    ]
    collapsed = _collapse_stderr_code_echo_rows(raw)
    if level:
        collapsed = [row for row in collapsed if row.get("level") == level]
    return [
        {
            "level": row["level"],
            "message": _redact_public_log_message(row["message"]),
            "timestamp": row["timestamp"],
        }
        for row in collapsed
    ]
