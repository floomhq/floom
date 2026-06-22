"""Worker lifecycle routes: star, knowledge-pack contexts, pause/resume, delete.

POST /workers/{id}/star, the worker-contexts CRUD (attach/update/detach),
pause/resume, and DELETE /workers/{id}. Extracted verbatim from main.py.

All deps from services (worker_access, worker_mutation); db lazy in handlers.
The router is purged in lockstep with main by the worker test fixtures.
"""

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import AuthContext, get_auth_context
from db import Repositories, get_repos
from models import DraftFile, WorkerConfig, WorkerDetail
from services.worker_access import (
    _canonical_worker_id,
    _db_worker_owners,
    _delete_worker_impl,
    _get_visible_worker,
    _slugify_worker_id,
    _worker_for_mutation,
)
from services.worker_mutation import (
    _mutate_worker_contexts,
    _require_worker_write_workspace_context,
    _set_worker_enabled,
    _set_worker_yml_is_example,
    _toggle_worker_star,
)
from services.worker_registry_ops import (
    _free_worker_id,
    _register_worker_from_files,
    _rewrite_worker_yml_id,
)
from services.worker_serialize import (
    _build_worker_detail,
    _read_worker_files,
    _worker_bundle_dir,
    _worker_files_from_manifest,
)
from worker_registry import invalidate_worker_cache

worker_lifecycle_router = APIRouter()


def _source_files_for_clone(worker_id: str, worker: Dict[str, Any]) -> Dict[str, str]:
    files: Dict[str, str] = {}
    try:
        config = WorkerConfig(**(worker.get("config") or {}))
        bundle_dir = _worker_bundle_dir(worker_id, config)
        for item in _read_worker_files(bundle_dir):
            if not item.binary and item.content is not None:
                files[item.path] = item.content
    except Exception:
        files = {}

    if not files:
        manifest = worker.get("manifest") or worker.get("manifest_json") or {}
        embedded = manifest.get("_files") if isinstance(manifest, dict) else None
        if isinstance(embedded, dict):
            for path, content in embedded.items():
                if isinstance(path, str) and isinstance(content, str):
                    files[path] = content

    if not files:
        for item in _worker_files_from_manifest(worker):
            if not item.binary and item.content is not None:
                files[item.path] = item.content

    return files

@worker_lifecycle_router.post("/workers/{worker_id}/star")
def toggle_worker_star(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#782: toggle the caller's star/favorite for a worker. Per-user; returns
    the new state. 404 if the worker is not visible to the caller."""
    worker_id = _canonical_worker_id(worker_id)
    if _worker_for_mutation(worker_id, auth, repos) is None:
        raise HTTPException(status_code=404, detail="Worker not found")
    return {"starred": _toggle_worker_star(auth.user_id, worker_id)}


@worker_lifecycle_router.post("/workers/{worker_id}/clone", response_model=WorkerDetail)
@worker_lifecycle_router.post("/workers/{worker_id}/duplicate", response_model=WorkerDetail)
@worker_lifecycle_router.post("/workers/{worker_id}/copy", response_model=WorkerDetail)
def clone_worker(
    worker_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    _require_worker_write_workspace_context(request)
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos, role=auth.role)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    files = _source_files_for_clone(worker_id, worker)
    worker_yml = files.get("worker.yml")
    if not worker_yml:
        raise HTTPException(status_code=409, detail="Worker source bundle is not available to clone")

    new_id = _free_worker_id(f"{_slugify_worker_id(worker_id)}-copy", repos=repos)
    files["worker.yml"] = _set_worker_yml_is_example(
        _rewrite_worker_yml_id(worker_yml, new_id),
        False,
    )
    created_id = _register_worker_from_files(
        [DraftFile(path=path, content=content) for path, content in files.items()],
        user_id=auth.user_id,
        repos=repos,
        dedupe_id=True,
    )
    return _build_worker_detail(created_id, user_id=auth.user_id, repos=repos)


@worker_lifecycle_router.post("/workers/{worker_id}/reload")
@worker_lifecycle_router.post("/workers/{worker_id}/restart")
@worker_lifecycle_router.post("/workers/{worker_id}/redeploy")
@worker_lifecycle_router.post("/workers/{worker_id}/materialize")
@worker_lifecycle_router.post("/workers/{worker_id}/refresh")
def reload_worker(
    worker_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    _require_worker_write_workspace_context(request)
    worker_id = _canonical_worker_id(worker_id)
    if _worker_for_mutation(worker_id, auth, repos) is None:
        raise HTTPException(status_code=404, detail="Worker not found")

    from services.worker_materialization import rematerialize_worker_from_db

    rematerialized = rematerialize_worker_from_db(worker_id)
    invalidate_worker_cache()
    return {
        "status": "success",
        "worker_id": worker_id,
        "rematerialized": bool(rematerialized),
    }


class _WorkerContextAttachRequest(BaseModel):
    name: str
    writeable: bool = False


class _WorkerContextUpdateRequest(BaseModel):
    writeable: bool




@worker_lifecycle_router.post("/workers/{worker_id}/contexts", response_model=WorkerDetail)
def attach_worker_context(
    worker_id: str,
    payload: _WorkerContextAttachRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#790: attach a brain folder to a worker (or update its writeable flag)."""
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="context name required")

    def _add(contexts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        for c in contexts:
            if c["name"] == name:
                c["writeable"] = payload.writeable
                return contexts
        contexts.append({"name": name, "writeable": payload.writeable})
        return contexts

    return _mutate_worker_contexts(worker_id, _add, auth=auth, repos=repos, request=request)


@worker_lifecycle_router.patch("/workers/{worker_id}/contexts/{context_name}", response_model=WorkerDetail)
def update_worker_context(
    worker_id: str,
    context_name: str,
    payload: _WorkerContextUpdateRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#790: change a mounted brain folder's read/write access."""
    found = {"hit": False}

    def _update(contexts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        for c in contexts:
            if c["name"] == context_name:
                c["writeable"] = payload.writeable
                found["hit"] = True
        return contexts

    detail = _mutate_worker_contexts(worker_id, _update, auth=auth, repos=repos, request=request)
    if not found["hit"]:
        raise HTTPException(status_code=404, detail="Context not attached to this worker")
    return detail


@worker_lifecycle_router.delete("/workers/{worker_id}/contexts/{context_name}", response_model=WorkerDetail)
def detach_worker_context(
    worker_id: str,
    context_name: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#790: detach a brain folder from a worker."""
    found = {"hit": False}

    def _remove(contexts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        kept = [c for c in contexts if c["name"] != context_name]
        found["hit"] = len(kept) != len(contexts)
        return kept

    detail = _mutate_worker_contexts(worker_id, _remove, auth=auth, repos=repos, request=request)
    if not found["hit"]:
        raise HTTPException(status_code=404, detail="Context not attached to this worker")
    return detail


@worker_lifecycle_router.post("/workers/{worker_id}/pause", response_model=WorkerDetail)
def pause_worker(
    worker_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#788: pause a worker (enabled=false) so it stops running on schedule."""
    return _set_worker_enabled(worker_id, enabled=False, auth=auth, repos=repos, request=request)


@worker_lifecycle_router.post("/workers/{worker_id}/resume", response_model=WorkerDetail)
def resume_worker(
    worker_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#788: resume a paused worker (enabled=true) and re-enqueue its schedule."""
    return _set_worker_enabled(worker_id, enabled=True, auth=auth, repos=repos, request=request)


# ---------------------------------------------------------------------------
# DELETE /workers/{worker_id}
# ---------------------------------------------------------------------------



@worker_lifecycle_router.delete("/workers/{worker_id}", status_code=204)
def delete_worker(
    worker_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Delete a worker and all dependent rows (runs, artifacts, logs).

    - Dependent run, artifact, log, and webhook rows are removed with the worker.
    - Cancels any in-progress run gracefully (marks failed).
    - Cleans up webhook secret.
    - Removes scheduler slot (next_run_at cleared before delete).
    - skill_version is preserved if other workers share it.
    """
    _require_worker_write_workspace_context(request)
    # Owner-gate: a member must not be able to delete (or no-op-204 against)
    # another member's worker. _get_visible_worker is now owner-scoped, so this
    # returns 404 for a worker the caller can't see — consistent with GET/run/edit.
    #
    # Exception: filesystem-only orphans (no DB row) have no owner to protect.
    # When WORKEROS_ENABLE_USER_HEADER_SCOPE=1, _shared_filesystem_fallback_allowed()
    # is False, so _get_visible_worker returns None for orphan dirs — blocking
    # _delete_worker_impl's orphan-reap path (issue #810). We must fall through
    # to _delete_worker_impl when the worker has no DB row at all; only deny when
    # a DB row exists but isn't visible to the caller (owned by someone else).
    canonical_id = _canonical_worker_id(worker_id)
    if canonical_id in _db_worker_owners():
        # DB-backed worker: mutation rights are required — the caller must be
        # its owner, or an admin when it is workspace-shared (donation model:
        # the sharer is NOT the owner anymore and must get 404 here even
        # though the bundle dir still exists on disk; the filesystem-visibility
        # fallback below must never bypass DB ownership).
        if _worker_for_mutation(canonical_id, auth, repos) is None:
            raise HTTPException(status_code=404, detail="Worker not found")
    elif _get_visible_worker(canonical_id, user_id=auth.user_id, repos=repos) is None:
        # No DB row anywhere: a true orphan (directory without DB row) falls
        # through so _delete_worker_impl can reap it (issue #810); anything
        # else invisible stays a 404.
        if canonical_id in _db_worker_owners():
            raise HTTPException(status_code=404, detail="Worker not found")
    _delete_worker_impl(worker_id, auth.user_id, repos)
    # 204 No Content — FastAPI returns empty body automatically for status_code=204
    return None
