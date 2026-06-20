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
from auth import AuthContext, get_auth_context, get_optional_auth_context
from core import hot_cache
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
    _log_replay_events,
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


def _safe_run_output_payload(run_row: Dict[str, Any], *, user_id: str, repos: Repositories) -> Dict[str, Any]:
    try:
        output_payload = json.loads(run_row.get("output_json") or "{}")
    except Exception:
        output_payload = {}
    if not isinstance(output_payload, dict):
        output_payload = {}

    worker_id = str(run_row.get("worker_id") or "")
    if not worker_id:
        return output_payload
    try:
        from run_service import get_secrets_for_worker, scrub_secret_values

        secrets = get_secrets_for_worker(worker_id, user_id=user_id, repos=repos)
        scrubbed = scrub_secret_values(output_payload, secrets)
        return scrubbed if isinstance(scrubbed, dict) else {}
    except Exception:
        logger.exception("Failed to scrub output for run %s", run_row.get("id"))
        return output_payload


def _public_run_log_sse_event(event: Dict[str, Any]) -> Dict[str, Any]:
    log_event: Dict[str, Any] = {
        "type": "log",
        "level": event.get("level") or "info",
        "message": _redact_public_log_message(str(event.get("message") or "")),
        "timestamp": event.get("timestamp"),
    }
    if event.get("trace_id"):
        log_event["trace_id"] = event["trace_id"]
    return log_event


def _run_total_cost_usd(raw: Any) -> Optional[float]:
    """Coerce the stored ``runs.total_cost_usd`` (#793/#795) to a float for the run
    detail response. Returns None for missing/unparseable/zero values so the detail
    pane hides the cost line until a real spend is recorded (the column defaults to
    0.0 and is only populated once a run reaches a terminal status)."""
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _hot_cache_scope() -> tuple[str, str]:
    return (
        os.environ.get("WORKEROS_DB") or os.environ.get("FLOOM_DB") or "",
        os.environ.get("FLOOM_WORKERS_DIR") or "",
    )


def _effective_runs_limit(request: Request, limit: int) -> int:
    try:
        current_limit = int(limit)
    except (TypeError, ValueError):
        current_limit = 50
    if os.environ.get("WORKEROS_DEPLOY") != "cloud":
        return current_limit
    if "limit" in request.query_params:
        return current_limit
    try:
        default_limit = int(os.environ.get("WORKEROS_CLOUD_RUNS_DEFAULT_LIMIT", "20"))
    except ValueError:
        default_limit = 20
    default_limit = max(1, min(default_limit, 200))
    return min(current_limit, default_limit)


@runs_router.get("/runs", response_model=List[RunSummary])
def list_runs(
    request: Request,
    response: Response,
    worker_id: Optional[str] = None,
    status: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    before_created_at: Optional[str] = Query(None),
    before_id: Optional[str] = Query(None),
    include_system: bool = Query(
        False,
        description="Include internal/system runs (audit, test, smoke). Hidden by default.",
    ),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[RunSummary]:
    started = time.perf_counter()
    limit = _effective_runs_limit(request, limit)
    try:
        offset = int(offset)
    except (TypeError, ValueError):
        offset = 0
    if not isinstance(before_created_at, str):
        before_created_at = None
    if not isinstance(before_id, str):
        before_id = None
    if not isinstance(include_system, bool):
        include_system = False
    statuses = _resolve_run_status_filters(status)
    since_dt = _parse_iso8601(since) if since else None
    if since and since_dt is None:
        raise HTTPException(status_code=400, detail="Invalid since value")
    until_dt = _parse_iso8601(until) if until else None
    if until and until_dt is None:
        raise HTTPException(status_code=400, detail="Invalid until value")
    if since_dt and until_dt and since_dt > until_dt:
        raise HTTPException(status_code=400, detail="since must be before until")
    before_dt = _parse_iso8601(before_created_at) if before_created_at else None
    if before_created_at and before_dt is None:
        raise HTTPException(status_code=400, detail="Invalid before_created_at value")
    if (before_created_at and not before_id) or (before_id and not before_created_at):
        raise HTTPException(status_code=400, detail="before_created_at and before_id must be supplied together")

    workspace_key = (
        request.headers.get("x-workeros-workspace")
        or request.query_params.get("workspace_id")
    )
    cache_key = (
        "runs",
        _hot_cache_scope(),
        auth.user_id,
        auth.role,
        workspace_key,
        worker_id,
        tuple(statuses) if statuses else None,
        since,
        until,
        limit,
        offset,
        before_created_at,
        before_id,
        include_system,
    )
    cached = hot_cache.get(cache_key)
    if cached is not None:
        visible_rows, visible_total = cached
        response.headers["X-Total-Count"] = str(visible_total)
        response.headers["X-Has-More"] = "true" if visible_total > offset + len(visible_rows) else "false"
        if visible_rows:
            last = visible_rows[-1]
            response.headers["X-Next-Before-Created-At"] = str(getattr(last, "created_at", "") or "")
            response.headers["X-Next-Before-Id"] = str(getattr(last, "id", "") or "")
        duration_ms = (time.perf_counter() - started) * 1000
        response.headers["Server-Timing"] = f"runs;dur={duration_ms:.1f};desc=\"hit\""
        logger.info(
            "runs list cache=hit user_id=%s count=%s total=%s duration_ms=%.1f",
            auth.user_id,
            len(visible_rows),
            visible_total,
            duration_ms,
        )
        return visible_rows

    if worker_id and _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos) is None:
        response.headers["X-Total-Count"] = "0"
        response.headers["Server-Timing"] = "runs;dur=0.0;desc=\"worker-miss\""
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
        before_created_at=before_dt.isoformat() if before_dt else None,
        before_id=before_id,
        include_system=include_system,
        exact_total=False,
    )
    result = [_make_run_summary(r) for r in visible_rows]
    hot_cache.set(cache_key, (result, visible_total))
    response.headers["X-Total-Count"] = str(visible_total)
    response.headers["X-Has-More"] = "true" if visible_total > offset + len(result) else "false"
    if result:
        last = result[-1]
        response.headers["X-Next-Before-Created-At"] = last.created_at or ""
        response.headers["X-Next-Before-Id"] = last.id
    duration_ms = (time.perf_counter() - started) * 1000
    response.headers["Server-Timing"] = f"runs;dur={duration_ms:.1f};desc=\"miss\""
    logger.info(
        "runs list cache=miss user_id=%s count=%s total=%s duration_ms=%.1f",
        auth.user_id,
        len(result),
        visible_total,
        duration_ms,
    )
    return result


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
    """Resolve the on-disk path of the main SQLite database.

    Kept for backward-compatible imports from main.py and older tests. The
    scoped pre-clear backup does not use this because it must not copy the full
    database.
    """
    from db import get_db
    with get_db() as conn:
        for row in conn.execute("PRAGMA database_list").fetchall():
            if row["name"] == "main":
                file_path = row["file"]
                return file_path or None
    return None


def _backup_db_before_clear(user_id: str) -> str:
    """Snapshot the caller's run history before a destructive clear.

    The backup intentionally contains only rows needed to restore this caller's
    run history. It must never be a full-database copy: the full DB also holds
    other tenants' runs, secrets, connections, and tokens.
    """
    backup_dir = _preclear_backup_dir()
    os.makedirs(backup_dir, mode=0o700, exist_ok=True)
    try:
        os.chmod(backup_dir, 0o700)
    except OSError:
        pass
    backup_path = os.path.join(
        backup_dir, f"floom-preclear-{time.time_ns()}.db"
    )
    from db import get_db
    try:
        with get_db() as conn:
            conn.execute("ATTACH DATABASE ? AS preclear_backup", (backup_path,))
            try:
                conn.execute(
                    """
                    CREATE TABLE preclear_backup.workers AS
                    SELECT DISTINCT w.*
                    FROM main.workers w
                    JOIN main.runs r ON r.worker_id = w.id
                    WHERE w.owner_id = ?
                    """,
                    (user_id,),
                )
                conn.execute(
                    """
                    CREATE TABLE preclear_backup.runs AS
                    SELECT r.*
                    FROM main.runs r
                    JOIN main.workers w ON w.id = r.worker_id
                    WHERE w.owner_id = ?
                    """,
                    (user_id,),
                )
                conn.execute(
                    """
                    CREATE TABLE preclear_backup.logs AS
                    SELECT l.*
                    FROM main.logs l
                    JOIN main.runs r ON r.id = l.run_id
                    JOIN main.workers w ON w.id = r.worker_id
                    WHERE w.owner_id = ?
                    """,
                    (user_id,),
                )
                conn.execute(
                    """
                    CREATE TABLE preclear_backup.artifacts AS
                    SELECT a.*
                    FROM main.artifacts a
                    JOIN main.runs r ON r.id = a.run_id
                    JOIN main.workers w ON w.id = r.worker_id
                    WHERE w.owner_id = ?
                    """,
                    (user_id,),
                )
                conn.commit()
            finally:
                conn.execute("DETACH DATABASE preclear_backup")
        try:
            os.chmod(backup_path, 0o600)
        except OSError:
            pass
    except Exception:
        try:
            if os.path.exists(backup_path):
                os.remove(backup_path)
        except OSError:
            pass
        raise
    if not os.path.isfile(backup_path) or os.path.getsize(backup_path) == 0:
        raise RuntimeError(f"backup file missing or empty after scoped backup: {backup_path}")
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
    - Backs up the caller's run history to
      ``/root/backups/manual/floom-preclear-<epoch>.db`` BEFORE deleting
      anything. If the backup fails, the clear is ABORTED.
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
        backup_path = _backup_db_before_clear(auth.user_id)
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
    }


_TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "cancelled"})


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

    For running runs: sets cancel_requested=1, asks the E2B driver to kill
    any registered sandbox command for this run, then marks the run cancelled
    promptly so list/detail surfaces stop reporting it as active.

    Returns 404 if no visible run exists, 200 if cancellation was recorded or
    the run is already terminal.
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
        return ActionResponse(status=str(row["status"]), run_id=run_id)

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

    update_run_status(
        run_id,
        RunStatus.CANCELLED.value,
        error="Run was cancelled by the user.",
        error_code="user_cancel",
        user_id=auth.user_id,
        repos=repos,
    )
    logger.info("Cancelled running run %s", run_id)
    return ActionResponse(status="cancelled", run_id=run_id)


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
            output_payload = _safe_run_output_payload(row_to_dict(run_row), user_id=auth.user_id, repos=repos)
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

    run_data = row_to_dict(run_row)
    output_payload = _safe_run_output_payload(run_data, user_id=auth.user_id, repos=repos)

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
            "Use the Floom UI for redacted run history.\n",
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

    run["output"] = _safe_run_output_payload(run, user_id=auth.user_id, repos=repos)
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
        total_cost_usd=_run_total_cost_usd(run.get("total_cost_usd")),
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


def _get_run_for_worker_share_stream(
    run_id: str,
    token: str,
    repos: Repositories,
) -> tuple[Any, str]:
    row = _load_standalone_share_row(token)
    if not row or str(row.get("entity_type") or "") != "worker":
        raise HTTPException(status_code=404, detail="Run not found")
    owner_id = str(row.get("owner_id") or "")
    worker_id = str(row.get("entity_id") or "")
    try:
        run_row = repos.runs.get_any(run_id=run_id)
    except Exception:
        run_row = None
    data = row_to_dict(run_row) if run_row is not None else {}
    if (
        not data
        or str(data.get("worker_id") or "") != worker_id
        or str(data.get("actor_user_id") or owner_id) != owner_id
    ):
        raise HTTPException(status_code=404, detail="Run not found")
    owner_scoped = _get_run_by_explicit_id(run_id, user_id=owner_id, repos=repos)
    if not owner_scoped:
        raise HTTPException(status_code=404, detail="Run not found")
    return owner_scoped, owner_id


@runs_router.get("/runs/{run_id}/stream")
async def stream_run_parts(
    run_id: str,
    request: Request,
    token: Optional[str] = Query(None, min_length=10),
    auth: Optional[AuthContext] = Depends(get_optional_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Server-Sent Events stream of AI SDK parts for a single run.

    Authentication (#1338 #1329):
    - Operator (authed): normal ``auth`` dependency, no ``token`` param.
    - RUN share-link viewer (#1329): ``?token=`` resolves to a standalone share
      row whose ``entity_type=='run'`` and ``entity_id==run_id``. Streams under
      the owner's identity via the fixed ``__public_share__`` SSE bucket.
    - WORKER share-link viewer (#1338): ``?token=`` resolves to a standalone
      share row whose ``entity_type=='worker'``; ``_get_run_for_worker_share_stream``
      validates the run belongs to that worker+owner.

    RECONCILIATION FLAG (round-09 base + main): base and main each shipped a
    DIFFERENT ``?token=`` contract under #1338. This union supports BOTH token
    entity types so neither feature is lost. Human review required to confirm
    the union is the intended public contract (vs. one canonical token type).
    """
    if token is not None:
        # Try RUN share token first (base / #1329), then WORKER share token
        # (main / #1338). Both validate ownership; both stream under owner id.
        share_row = _load_standalone_share_row(token)
        if (
            share_row
            and str(share_row.get("entity_type")) == "run"
            and str(share_row.get("entity_id")) == run_id
        ):
            effective_user_id = str(share_row.get("owner_id") or "")
            run_row = _get_run_by_explicit_id(run_id, user_id=effective_user_id, repos=repos)
            if not run_row:
                raise HTTPException(status_code=404, detail="Run not found")
        else:
            run_row, effective_user_id = _get_run_for_worker_share_stream(run_id, token, repos)
        stream_user_id = "__public_share__"
    elif auth is not None:
        # Normal authenticated path.
        effective_user_id = auth.user_id
        stream_user_id = auth.user_id
        run_row = _get_run_by_explicit_id(run_id, user_id=effective_user_id, repos=repos)
        if not run_row:
            raise HTTPException(status_code=404, detail="Run not found")
    else:
        raise HTTPException(status_code=401, detail="Unauthorized")

    last_seen = _parse_last_event_id(request.headers.get("last-event-id"))

    # Per-user concurrent-stream cap (Round 16 DoS finding). Acquire
    # synchronously so the 429 is returned before the StreamingResponse.
    stream_slot = _sse_stream_acquire(stream_user_id)

    async def event_generator():
        try:
            snapshot = _run_part_snapshot(run_id)
            if snapshot is None:
                final_part = _finish_part_from_run_row(run_row)
                if final_part is not None:
                    # #188: the in-memory part buffer is gone (terminal run past its
                    # TTL, or a fresh server process). Replay persisted log rows so
                    # the client reconstructs the transcript instead of receiving a
                    # bare finish event.
                    event_id = 0
                    for log_part in _log_replay_parts(repos, effective_user_id, run_id):
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


@runs_router.get("/runs/{run_id}/logs/stream")
async def stream_run_logs(
    run_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Server-Sent Events stream of log/trace lines for a single run.

    Emits one ``data: <json>\\n\\n`` line per log event. Each event carries:
      - ``type``: always ``"log"``
      - ``level``: ``"info"`` | ``"warning"`` | ``"error"`` | ``"debug"``
      - ``message``: redacted operator-safe log text
      - ``timestamp``: ISO-8601 UTC string
      - ``trace_id``: optional step/trace identifier (omitted when absent)

    On connect, all existing log rows for the run are replayed immediately so
    the client receives the full history without a separate REST call. New log
    lines are then pushed in real-time as the run produces them.

    When the run reaches a terminal state the stream emits a final
    ``{"type": "done", "status": "<completed|failed>"}`` event and closes.

    The stream uses the same per-user concurrent-stream cap as /runs/{id}/events
    and /runs/{id}/stream. Returns 404 for unknown runs, 429 when the cap is
    exceeded.
    """
    run_row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
    if not run_row:
        raise HTTPException(status_code=404, detail="Run not found")

    initial_status = run_row["status"]
    already_terminal = initial_status in _TERMINAL_STATUSES

    # Per-user concurrent-stream cap (same guard as /events and /stream).
    stream_slot = _sse_stream_acquire(auth.user_id)

    async def event_generator():
        try:
            # Always replay persisted log rows first so the client gets the
            # full history on connect without a separate GET /runs/{id}/logs call.
            for event in _log_replay_events(repos, auth.user_id, run_id):
                yield f"data: {json.dumps(event)}\n\n"

            # If the run is already terminal, emit a done event and close.
            if already_terminal:
                done_row = _get_run_by_explicit_id(run_id, user_id=auth.user_id, repos=repos)
                done_status = (done_row or {}).get("status", initial_status)
                yield f"data: {json.dumps({'type': 'done', 'status': done_status})}\n\n"
                return

            # Subscribe to live SSE events for this run.
            q: asyncio.Queue = asyncio.Queue(maxsize=512)
            loop = asyncio.get_running_loop()
            with _sse_lock:
                _sse_queues.setdefault(run_id, []).append((q, loop))

            try:
                while True:
                    if await request.is_disconnected():
                        break

                    try:
                        event = await asyncio.wait_for(q.get(), timeout=5.0)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue

                    evt_type = event.get("type")

                    if evt_type == "log":
                        # Forward log events with trace_id when present.
                        log_event = _public_run_log_sse_event(event)
                        yield f"data: {json.dumps(log_event)}\n\n"

                    evt_status = event.get("status", "")
                    if evt_type == "close" or evt_status in _TERMINAL_STATUSES:
                        yield f"data: {json.dumps({'type': 'done', 'status': evt_status or 'unknown'})}\n\n"
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
