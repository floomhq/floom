"""Public/shared worker + brain routes: signed-link projection, short-links,
share-link mint/revoke, standalone-share resolution, and share import.

GET /workers/public/{id} (HMAC-token public projection), POST/GET worker
short-links, POST /workers/import-from-share, the /contexts/{name}[/files/...]
share-link mint/revoke pairs, and the /s/{token} standalone-share resolver +
file download. Extracted verbatim from main.py (only contexts imports made
lazy-in-handler per the purged-module convention).

All domain logic comes from services (public_worker / share_links /
context_access / public_view / worker_access / worker_registry_ops / run_access);
db via Depends(get_repos); contexts lazy inside the download handler. The router
is purged in lockstep with main by the worker/context test fixtures.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse, JSONResponse

from auth import AuthContext, get_auth_context
from db import Repositories, get_repos
from models import PublicWorker, WorkerConfig, _ImportFromShareRequest
from services.context_access import (
    _assert_context_file_shareable,
    _assert_context_pack_shareable,
    _context_file_path_or_400,
    _context_name_or_400,
    _context_summary,
    _require_context_for_user,
    _safe_context_file_or_400,
)
from services.public_view import _json_noindex, _public_noindex_headers
from services.public_worker import (
    _load_public_worker,
    _public_worker_response,
    _standalone_share_payload,
)
from services.run_access import _sanitize_download_name
from services.share_links import (
    _create_or_get_standalone_share_link,
    _load_short_link_public_worker,
    _load_standalone_share_row,
    _revoke_standalone_share_link,
    _worker_short_link_response,
)
from services.worker_access import _canonical_worker_id, _get_visible_worker
from services.worker_registry_ops import _register_worker_from_files

worker_public_router = APIRouter()


@worker_public_router.get("/workers/public/{worker_id}", response_model=PublicWorker)
def get_public_worker(
    worker_id: str,
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
) -> PublicWorker:
    """Return a read-only, allow-listed projection of a worker for a signed link.

    Authenticated solely by the HMAC ``token`` (no app login). The response is
    a strict ``PublicWorker`` allow-list — no secrets, source, run history,
    owner id, or webhook url. See ``_public_worker_response``.
    """
    worker = _load_public_worker(worker_id, token, repos)
    config_dict = worker.get("config", {})
    try:
        config = WorkerConfig(**config_dict)
    except Exception:
        config = WorkerConfig(
            id=str(worker.get("id") or worker_id),
            name=str(worker.get("name") or worker_id),
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )
    return _public_worker_response(worker, config)


@worker_public_router.post("/workers/{worker_id}/short-link")
def create_worker_short_link(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    return _worker_short_link_response(worker)


@worker_public_router.get("/workers/short-links/{short_id}", response_model=PublicWorker)
def resolve_worker_short_link(
    short_id: str,
    repos: Repositories = Depends(get_repos),
) -> PublicWorker:
    worker = _load_short_link_public_worker(short_id, repos)
    try:
        config = WorkerConfig(**(worker.get("config") or {}))
    except Exception:
        config = WorkerConfig(
            id=str(worker.get("id") or short_id),
            name=str(worker.get("name") or short_id),
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )
    return _public_worker_response(worker, config)


@worker_public_router.post("/workers/import-from-share")
def import_worker_from_share(
    body: _ImportFromShareRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Clone a shared worker into the authenticated user's workspace.

    Resolves the share token, reads the source worker's files from the share
    payload (populated by _public_worker_share_from_worker), and registers
    them as a new worker owned by the caller. Colliding IDs are deduplicated
    automatically so the same token can be imported by multiple users.
    """
    payload = _standalone_share_payload(body.token, repos)
    if payload.get("entity_type") != "worker":
        raise HTTPException(status_code=400, detail="Share link is not a worker")
    share_files = payload.get("files") or []
    if not share_files:
        raise HTTPException(status_code=409, detail="Worker has no importable files")
    draft_files = [DraftFile(path=f["path"], content=f.get("content") or "") for f in share_files if f.get("path")]
    if not any(f.path == "worker.yml" for f in draft_files):
        raise HTTPException(status_code=409, detail="Worker share is missing worker.yml")
    new_id = _register_worker_from_files(draft_files, user_id=auth.user_id, repos=repos, dedupe_id=True)
    return {"worker_id": new_id, "url": f"/workers/{new_id}"}


@worker_public_router.post("/contexts/{name}/share-link")
def create_brain_pack_share_link(
    name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    summary = _context_summary(safe_name, _metadata, repos=repos, user_id=auth.user_id)
    if not summary.permissions.can_share:
        raise HTTPException(status_code=403, detail="You cannot share this brain pack")
    _assert_context_pack_shareable(safe_name)
    return _create_or_get_standalone_share_link(
        entity_type="brain_pack",
        entity_id=safe_name,
        owner_id=auth.user_id,
    )


@worker_public_router.post("/contexts/{name}/files/{file_path:path}/share-link")
def create_brain_file_share_link(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    summary = _context_summary(safe_name, _metadata, repos=repos, user_id=auth.user_id)
    if not summary.permissions.can_share:
        raise HTTPException(status_code=403, detail="You cannot share this brain file")
    rel = _context_file_path_or_400(file_path)
    target = _safe_context_file_or_400(safe_name, rel)
    _assert_context_file_shareable(rel, target)
    return _create_or_get_standalone_share_link(
        entity_type="brain_file",
        entity_id=safe_name,
        file_path=rel,
        owner_id=auth.user_id,
    )


@worker_public_router.delete("/contexts/{name}/share-link")
def revoke_brain_pack_share_link(
    name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#766: revoke a brain pack's public share link."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    return _revoke_standalone_share_link(
        entity_type="brain_pack",
        entity_id=safe_name,
        owner_id=auth.user_id,
    )


@worker_public_router.delete("/contexts/{name}/files/{file_path:path}/share-link")
def revoke_brain_file_share_link(
    name: str,
    file_path: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#766: revoke a brain file's public share link."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    rel = _context_file_path_or_400(file_path)
    return _revoke_standalone_share_link(
        entity_type="brain_file",
        entity_id=safe_name,
        file_path=rel,
        owner_id=auth.user_id,
    )


@worker_public_router.get("/s/{token}/download")
def download_standalone_share_file(
    token: str,
    repos: Repositories = Depends(get_repos),
) -> Response:
    from contexts import context_scope_for_user, guess_mime_type, use_context_scope

    row = _load_standalone_share_row(token)
    if not row or row.get("entity_type") != "brain_file":
        raise HTTPException(status_code=404, detail="Download not found")
    owner_id = str(row.get("owner_id") or "")
    safe_name = str(row.get("entity_id") or "")
    rel = str(row.get("file_path") or "")
    with use_context_scope(context_scope_for_user(owner_id)):
        safe_name = _context_name_or_400(safe_name)
        rel = _context_file_path_or_400(rel)
        target = _safe_context_file_or_400(safe_name, rel)
        _assert_context_file_shareable(rel, target)
        mime_type = guess_mime_type(rel)
        headers = {
            **_public_noindex_headers(),
            "Content-Disposition": f'attachment; filename="{_sanitize_download_name(Path(rel).name)}"',
            "X-Content-Type-Options": "nosniff",
        }
        return FileResponse(target, media_type=mime_type, headers=headers)


@worker_public_router.get("/s/{token}")
def get_standalone_share(
    token: str,
    repos: Repositories = Depends(get_repos),
) -> JSONResponse:
    return _json_noindex(_standalone_share_payload(token, repos))
