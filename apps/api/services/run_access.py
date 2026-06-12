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
    # A run is visible if its worker is owned by the requesting user — regardless
    # of whether the worker is a stock/tracked worker. This closes the gap where
    # Emily (which bypasses the visibility filter) could see runs that /runs hid.
    worker = _get_db_worker(worker_id, user_id=user_id, repos=repos)
    if worker is not None:
        return True
    # Filesystem fallback: public stock workers are always visible.
    if _shared_filesystem_fallback_allowed() or worker_id in PUBLIC_STOCK_WORKER_IDS:
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
