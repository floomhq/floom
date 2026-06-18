"""Run visibility + artifact-serving access helpers.

Answers "can this request see / download this run or artifact?" — the run
visibility filter shared by the runs and approvals route groups, plus the
sensitive-artifact guards and the sandboxed artifact StreamingResponse builder.
Extracted from main.py.

Depends downward only: ``core``/``services.worker_access`` for the worker
visibility primitives, ``worker_registry``/``runner_utils`` (lazy) for the
filesystem fallback and artifacts dir, ``core.utils`` for row coercion. Never
imports ``main``.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from core.config import (
    PUBLIC_STOCK_WORKER_IDS,
    _SYSTEM_WORKER_IDS,
    _INTERNAL_WORKER_ID_PREFIXES,
)
from core.utils import row_to_dict
from services.worker_access import (
    _get_db_worker,
    _shared_filesystem_fallback_allowed,
    _stock_filesystem_workers_allowed,
    _worker_hidden_from_api,
)

if TYPE_CHECKING:
    from db import Repositories


def _run_visible_to_api(row: Any, *, user_id: str, repos: "Repositories") -> bool:
    from worker_registry import get_worker

    worker_id = str(row_to_dict(row).get("worker_id") or "")
    if not worker_id:
        return False
    # Always hide runs for system/infra workers — they're high-volume background
    # workers whose runs would flood the operator view and are never user-initiated.
    if worker_id in _SYSTEM_WORKER_IDS:
        return False
    if worker_id.startswith(".") or any(worker_id.startswith(p) for p in _INTERNAL_WORKER_ID_PREFIXES):
        return False
    if _worker_hidden_from_api(worker_id):
        return False
    actor_user_id = row_to_dict(row).get("actor_user_id")
    if actor_user_id is not None and str(actor_user_id) == str(user_id):
        return True
    # A run is visible if its worker is owned by the requesting user — regardless
    # of whether the worker is a stock/tracked worker. This closes the gap where
    # Emily (which bypasses the visibility filter) could see runs that /runs hid.
    worker = _get_db_worker(worker_id, user_id=user_id, repos=repos)
    if worker is not None:
        return True
    # Filesystem fallback: public stock workers are always visible.
    # #264: the stock-id arm is off-cloud only — on cloud the on-disk worker
    # belongs to the vendored engine tenant, so a run keyed on that id must not
    # become visible to an unrelated workspace via the shared filesystem.
    if _shared_filesystem_fallback_allowed() or (
        worker_id in PUBLIC_STOCK_WORKER_IDS and _stock_filesystem_workers_allowed()
    ):
        return get_worker(worker_id) is not None
    return False


def _get_visible_run(
    run_id: str,
    *,
    user_id: str,
    repos: "Repositories",
) -> Any:
    row = repos.runs.get(user_id=user_id, run_id=run_id)
    if row is None or not _run_visible_to_api(row, user_id=user_id, repos=repos):
        return None
    return row


def _sanitize_download_name(name: str) -> str:
    sanitized = (
        (name or "file")
        .replace("\\", "_")
        .replace("/", "_")
        .replace('"', "_")
        .replace("\r", "_")
        .replace("\n", "_")
    )
    return sanitized or "file"


_SENSITIVE_ARTIFACT_FILENAMES = frozenset({"transcript.jsonl"})


def _is_sensitive_artifact_name(name: str) -> bool:
    normalized = (name or "").replace("\\", "/").rsplit("/", 1)[-1].lower()
    return normalized in _SENSITIVE_ARTIFACT_FILENAMES


def _is_sensitive_artifact_row(row: Any) -> bool:
    data = row_to_dict(row)
    return _is_sensitive_artifact_name(str(data.get("name") or data.get("path") or ""))


def _artifact_file_response(row: Any) -> StreamingResponse:
    if _is_sensitive_artifact_row(row):
        raise HTTPException(status_code=404, detail="Artifact not found")

    art = row_to_dict(row)
    path_str = str(art.get("path") or "")

    from runner_utils import ARTIFACTS_DIR

    try:
        artifacts_dir = ARTIFACTS_DIR.resolve()
        stored_path = Path(path_str)
        resolved = (
            stored_path.resolve()
            if stored_path.is_absolute()
            else (artifacts_dir / stored_path).resolve()
        )
        resolved.relative_to(artifacts_dir)
    except Exception:
        raise HTTPException(status_code=403, detail="Access denied")

    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found on disk")

    name = str(art.get("name") or resolved.name)
    content_type, _ = mimetypes.guess_type(name)
    content_type = content_type or "application/octet-stream"
    filename = _sanitize_download_name(name)

    def iter_file():
        with open(resolved, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        iter_file(),
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


_OPERATOR_REACHABLE_HIDDEN_WORKER_IDS = frozenset({"worker-author"})


def _get_run_by_explicit_id(
    run_id: str,
    *,
    user_id: str,
    repos: Repositories,
) -> Any:
    """Fetch a run by its EXACT id, scoped to the caller's workspace.

    Returns the run if EITHER:
      - it passes the normal visibility filter (``_get_visible_run``), OR
      - its worker is in ``_OPERATOR_REACHABLE_HIDDEN_WORKER_IDS`` (the
        generation meta-worker), which the operator drives directly by run_id
        from the product UI.

    The system/audit visibility filter (``_run_visible_to_api`` ->
    ``_worker_hidden_from_api``) is for the LIST view: it keeps meta/system runs
    out of the operator's default /runs listing. But the /workers/new generation
    UI already holds the precise worker-author ``run_id`` (returned by POST
    /workers/new/from-prompt) and must be able to read its
    detail/logs/output/stream/events to drive the GeneratingPanel. Filtering
    those out returned a spurious 404 and hung generation (regression from PR
    #231/#235).

    This stays an allowlist so internal infra workers (slack-listener etc.)
    remain inaccessible by id. Authorization is enforced via the user-scoped
    ``repos.runs.get``.
    """
    row = repos.runs.get(user_id=user_id, run_id=run_id)
    if row is None:
        try:
            candidate = repos.runs.get_any(run_id=run_id)
        except Exception:
            candidate = None
        candidate_data = row_to_dict(candidate) if candidate is not None else {}
        if str(candidate_data.get("actor_user_id") or "") != str(user_id):
            return None
        row = candidate
    data = row_to_dict(row)
    actor_user_id = data.get("actor_user_id")
    if actor_user_id is not None and str(actor_user_id) != str(user_id):
        return None
    if _run_visible_to_api(row, user_id=user_id, repos=repos):
        return row
    worker_id = str(data.get("worker_id") or "")
    if worker_id in _OPERATOR_REACHABLE_HIDDEN_WORKER_IDS:
        return row
    return None


_OPERATOR_TRIGGER_SOURCES = frozenset({
    "manual",
    "schedule",
    "approval",
    "composio",
    "webhook",
    "workspace-agent",
})


def _is_operator_run(row: Any) -> bool:
    source = (row_to_dict(row).get("trigger_source") or "").strip().lower()
    # Treat unknown/empty as operator-facing only if explicitly allowlisted;
    # blank trigger_source is legacy "manual" and stays visible.
    if not source:
        return True
    return source in _OPERATOR_TRIGGER_SOURCES


def _list_visible_runs(
    *,
    user_id: str,
    repos: "Repositories",
    worker_id: str | None = None,
    statuses: list[str] | None = None,
    since: str | None = None,
    until: str | None = None,
    limit: int = 50,
    offset: int = 0,
    before_created_at: str | None = None,
    before_id: str | None = None,
    include_system: bool = False,
    exact_total: bool = True,
) -> tuple[list[Any], int]:
    list_operator_visible = getattr(repos.runs, "list_operator_visible", None)
    if list_operator_visible is not None and not exact_total:
        return list_operator_visible(
            user_id=user_id,
            worker_id=worker_id,
            statuses=statuses,
            since=since,
            until=until,
            limit=limit,
            before_created_at=before_created_at,
            before_id=before_id,
            offset=offset,
            include_system=include_system,
        )

    batch_size = max(limit, 100)
    raw_offset = 0
    raw_total_count: int | None = None
    visible_total = 0
    visible_rows: list[Any] = []
    target_visible = offset + limit
    # Fast mode only needs one extra visible row to tell callers there may be
    # another page. It avoids scanning the full run table for exact counts.
    stop_after_visible = None if exact_total else target_visible + 1

    while raw_total_count is None or raw_offset < raw_total_count:
        list_kwargs = dict(
            user_id=user_id,
            worker_id=worker_id,
            statuses=statuses,
            since=since,
            until=until,
            limit=batch_size,
            offset=raw_offset,
        )
        try:
            rows, raw_total_count = repos.runs.list(
                **list_kwargs,
                include_total=exact_total,
            )
        except TypeError as exc:
            if "include_total" not in str(exc):
                raise
            rows, raw_total_count = repos.runs.list(**list_kwargs)
        if not rows:
            break
        raw_offset += len(rows)
        for row in rows:
            if not _run_visible_to_api(row, user_id=user_id, repos=repos):
                continue
            # 1.5.2: hide audit/system/test telemetry from the default
            # operator view unless explicitly requested.
            if not include_system and not _is_operator_run(row):
                continue
            visible_total += 1
            if visible_total <= offset:
                continue
            if len(visible_rows) < limit:
                visible_rows.append(row)
            if stop_after_visible is not None and visible_total >= stop_after_visible:
                return visible_rows, visible_total
        if not exact_total and len(rows) < batch_size:
            break
    return visible_rows, visible_total
