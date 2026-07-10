"""Public/shared worker + brain routes: signed-link projection, short-links,
share-link mint/revoke, standalone-share resolution, share import, and the
shareable-link run path (run-meta, public run trigger, public SSE stream).

GET /workers/public/{id} (HMAC-token public projection), POST/GET worker
short-links, POST /workers/import-from-share, the /contexts/{name}[/files/...]
share-link mint/revoke pairs, and the /s/{token} standalone-share resolver +
file download. Extracted verbatim from main.py (only contexts imports made
lazy-in-handler per the purged-module convention).

NEW (#1338 #1329): two endpoints for the /run/[id] shareable-link page:
  GET  /workers/public/{id}/run-meta?token=<hmac>  — identity + schema (no secrets)
  POST /workers/public/{id}/runs                   — body {inputs, token}, runs as owner
The public SSE path is GET /runs/{run_id}/stream?token=<fls_token> wired in
routers/runs.py so it shares the existing stream implementation.

All domain logic comes from services (public_worker / share_links /
context_access / public_view / worker_access / worker_registry_ops / run_access);
db via Depends(get_repos); contexts lazy inside the download handler. The router
is purged in lockstep with main by the worker/context test fixtures.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from auth import AuthContext, get_auth_context
from db import Repositories, get_repos
from models import (
    ActionResponse,
    DraftFile,
    PublicWorker,
    PublicWorkerInput,
    PublicWorkerOutput,
    RunCreate,
    WorkerConfig,
    _ImportFromShareRequest,
)
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
    _public_worker_card_by_handle_slug,
    _public_worker_response,
    _public_worker_share_from_worker,
    _public_workspace_profile,
    _resolve_public_workspace_handle,
    _slugify_handle,
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

_IMPORT_SOURCE_VERSION = "1"


class _PublicWorkerRunRequest(BaseModel):
    inputs: Dict[str, Any] = Field(default_factory=dict)
    token: str = Field(..., min_length=10)


def _worker_manifest_dict(worker: Dict[str, Any]) -> Dict[str, Any]:
    raw = worker.get("manifest_json")
    if raw is None:
        raw = worker.get("manifest")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw or "{}")
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {}
    return {}


def _find_existing_import(
    marker: Dict[str, str],
    *,
    auth: AuthContext,
    repos: Repositories,
) -> str | None:
    try:
        workers = repos.workers.list(user_id=auth.user_id, role=auth.role)
    except Exception:
        return None
    for worker in workers:
        owner_id = str(worker.get("owner_id") or "").strip()
        if owner_id and owner_id != auth.user_id:
            continue
        manifest = _worker_manifest_dict(worker)
        source = manifest.get("import_source")
        if isinstance(source, dict) and source == marker:
            worker_id = str(worker.get("id") or "").strip()
            if worker_id:
                return worker_id
    return None


def _stamp_import_source(draft_files: List[DraftFile], marker: Dict[str, str]) -> None:
    worker_yml = next((f for f in draft_files if f.path == "worker.yml"), None)
    if worker_yml is None:
        return
    raw = yaml.safe_load(worker_yml.content or "{}")
    if not isinstance(raw, dict):
        return
    raw["import_source"] = marker
    worker_yml.content = yaml.safe_dump(raw, sort_keys=False)


def _share_import_marker(token: str) -> Dict[str, str]:
    return {
        "version": _IMPORT_SOURCE_VERSION,
        "kind": "share",
        "token_sha256": hashlib.sha256(token.encode("utf-8")).hexdigest(),
    }


def _permalink_import_marker(
    *,
    handle: str,
    worker_slug: str,
    source_workspace_id: str,
    source_worker_id: str,
) -> Dict[str, str]:
    normalized_handle = _slugify_handle(str(handle or "").lstrip("@"))
    normalized_slug = _slugify_handle(str(worker_slug or ""))
    return {
        "version": _IMPORT_SOURCE_VERSION,
        "kind": "permalink",
        "handle": normalized_handle,
        "worker_slug": normalized_slug,
        "source_workspace_id": source_workspace_id,
        "source_worker_id": source_worker_id,
    }


def _load_standalone_worker_share(
    worker_id: str,
    token: str,
    repos: Repositories,
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    row = _load_standalone_share_row(token, repos)
    if (
        not row
        or str(row.get("entity_type") or "") != "worker"
        or str(row.get("entity_id") or "") != worker_id
    ):
        raise HTTPException(status_code=404, detail="Worker share not found")
    worker = repos.workers.get_any(worker_id=worker_id)
    if not worker or str(worker.get("owner_id") or "") != str(row.get("owner_id") or ""):
        raise HTTPException(status_code=404, detail="Worker share not found")
    return row, worker


def _public_worker_from_row(worker: Dict[str, Any]) -> PublicWorker:
    try:
        config = WorkerConfig(**(worker.get("config") or {}))
    except Exception:
        config = WorkerConfig(
            id=str(worker.get("id") or ""),
            name=str(worker.get("name") or ""),
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )
    return _public_worker_response(worker, config)


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


@worker_public_router.get("/workspaces/public/{handle}")
def get_public_workspace_profile(
    handle: str,
    limit: int = Query(50, ge=1, le=100),
    repos: Repositories = Depends(get_repos),
) -> JSONResponse:
    """Return a no-login public workspace profile.

    The payload lists only assets that already have public worker visibility and
    reuses the strict PublicWorker projection. It never returns secrets, source
    files, run history, private memory, owner ids, or connection identifiers.
    """
    return _json_noindex(_public_workspace_profile(handle, repos, limit=limit))


@worker_public_router.get("/workers/public/by-handle/{handle}/{worker_slug}")
def get_public_worker_by_handle_slug(
    handle: str,
    worker_slug: str,
    share: Optional[str] = Query(None, min_length=6, max_length=128),
    repos: Repositories = Depends(get_repos),
) -> JSONResponse:
    """Resolve a worker permalink (/@{handle}/{worker_slug}[?share=<token>]).

    Powers the L4 permalink page + og-image. Resolves the workspace by its
    stored handle and the worker by its stored per-workspace public_slug.
    Returns public card fields for a worker with visibility='public', OR
    (Fede 2026-07-06: "access is a property, not a URL namespace") for a
    non-public worker when a valid ``share`` token for THIS worker is
    supplied, the same ``fls_`` standalone-share-link token the Share modal
    mints, reused as an unguessable key on the one canonical URL instead of a
    separate ``/s/<token>`` link. Non-public / unknown handle or slug / bad or
    missing token -> identical 404 (never confirms existence). The SSR'd HTML
    page (not this JSON) is what search engines index.
    """
    return JSONResponse(_public_worker_card_by_handle_slug(handle, worker_slug, repos, share_token=share))


@worker_public_router.get("/workers/public/{worker_id}/permalink-redirect")
def get_worker_permalink_redirect(
    worker_id: str,
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Optional[str]]:
    """Legacy /w/{id}?token=<hmac> -> canonical permalink redirect target.

    Verifies the same signed HMAC the historical /w/ page always has (never a
    new capability: anyone who could reach the old page can reach this).
    Returns the bare permalink for a public worker, or a durable ``?share=``
    link (found-or-minted via the standard ``fls_`` share-link table) for a
    non-public one, a strict improvement over the legacy HMAC, which had no
    revoke path. ``path`` is None only when the workspace has no resolvable
    handle (an engine pin predating the L4 handle column); callers should fall
    back to rendering the legacy standalone share card in that case.
    """
    worker = _load_public_worker(worker_id, token, repos)
    permalink_path = None
    from services.public_worker import _worker_canonical_permalink_path

    permalink_path = _worker_canonical_permalink_path(worker, repos)
    if not permalink_path:
        return {"url": None}
    if str(worker.get("visibility") or "private") == "public":
        from services.share_links import _public_share_frontend_base_url

        return {"url": f"{_public_share_frontend_base_url()}{permalink_path}"}
    share = _create_or_get_standalone_share_link(
        entity_type="worker",
        entity_id=str(worker.get("id") or worker_id),
        owner_id=str(worker.get("owner_id") or ""),
        repos=repos,
        slug=str(worker.get("id") or worker_id),
        permalink_path=permalink_path,
    )
    return {"url": share.get("url")}


@worker_public_router.get("/workers/public/{worker_id}/run-meta")
def get_public_worker_run_meta(
    worker_id: str,
    token: str = Query(..., min_length=10),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return the safe run form metadata for a revocable worker share token."""
    _row, worker = _load_standalone_worker_share(worker_id, token, repos)
    public = _public_worker_from_row(worker).model_dump()
    return {
        "id": public.get("id"),
        "name": public.get("name"),
        "description": public.get("description"),
        "inputs": public.get("inputs") or [],
        "outputs": public.get("outputs") or [],
    }


@worker_public_router.post("/workers/public/{worker_id}/runs")
def create_public_worker_run(
    worker_id: str,
    body: _PublicWorkerRunRequest,
    request: Request,
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    """Start a shared worker anonymously, scoped to exactly one worker token."""
    row, _worker = _load_standalone_worker_share(worker_id, body.token, repos)
    owner_auth = AuthContext(
        user_id=str(row.get("owner_id") or ""),
        email=None,
        scopes=("worker_share",),
        role="admin",
        auth_method="public_share",
    )
    payload = RunCreate(inputs=body.inputs, trigger_source="public_share")
    from main import create_worker_run

    result = create_worker_run(worker_id, payload, request=request, auth=owner_auth, repos=repos)
    return {"run_id": str(result.run_id or "")}


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
    marker = _share_import_marker(body.token)
    existing_id = _find_existing_import(marker, auth=auth, repos=repos)
    if existing_id:
        return {"worker_id": existing_id, "url": f"/workers/{existing_id}"}
    _stamp_import_source(draft_files, marker)
    new_id = _register_worker_from_files(draft_files, user_id=auth.user_id, repos=repos, dedupe_id=True)
    return {"worker_id": new_id, "url": f"/workers/{new_id}"}


class _ImportFromPermalinkRequest(BaseModel):
    handle: str = Field(..., min_length=1, max_length=80)
    worker_slug: str = Field(..., min_length=1, max_length=80)


@worker_public_router.post("/workers/import-from-permalink")
def import_worker_from_permalink(
    body: _ImportFromPermalinkRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """"Use this template" on a public permalink (/@{handle}/{worker_slug}).

    Authenticated clone of a PUBLIC worker into the caller's workspace, sourced
    by stored handle + public_slug (no share token round-trip). Same clone path
    as import-from-share (_register_worker_from_files, dedupe on collision), and
    the same auth surface — it only ever clones a worker whose visibility is
    'public'. Non-public / unknown -> 404.
    """
    workspace = _resolve_public_workspace_handle(body.handle, repos)
    workspace_id = str(workspace.get("id") or "local-default")
    normalized_slug = _slugify_handle(str(body.worker_slug or ""))
    getter = getattr(repos.workers, "get_public_by_slug", None)
    worker = getter(workspace_id=workspace_id, public_slug=normalized_slug) if callable(getter) else None
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    marker = _permalink_import_marker(
        handle=body.handle,
        worker_slug=body.worker_slug,
        source_workspace_id=workspace_id,
        source_worker_id=str(worker.get("id") or ""),
    )
    existing_id = _find_existing_import(marker, auth=auth, repos=repos)
    if existing_id:
        return {"worker_id": existing_id, "url": f"/workers/{existing_id}"}
    payload = _public_worker_share_from_worker(worker, repos)
    share_files = payload.get("files") or []
    if not share_files:
        raise HTTPException(status_code=409, detail="Worker has no importable files")
    draft_files = [DraftFile(path=f["path"], content=f.get("content") or "") for f in share_files if f.get("path")]
    if not any(f.path == "worker.yml" for f in draft_files):
        raise HTTPException(status_code=409, detail="Worker share is missing worker.yml")
    _stamp_import_source(draft_files, marker)
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
        repos=repos,
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
        repos=repos,
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
        repos=repos,
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
        repos=repos,
    )


@worker_public_router.get("/s/{token}/download")
def download_standalone_share_file(
    token: str,
    repos: Repositories = Depends(get_repos),
) -> Response:
    from contexts import context_scope_for_user, guess_mime_type, use_context_scope

    row = _load_standalone_share_row(token, repos)
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
    request: Request,
    token: str,
    repos: Repositories = Depends(get_repos),
) -> JSONResponse:
    return _json_noindex(_standalone_share_payload(token, repos, request=request))
