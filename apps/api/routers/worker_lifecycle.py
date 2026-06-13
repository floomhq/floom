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
from models import WorkerDetail
from services.worker_access import (
    _canonical_worker_id,
    _db_worker_owners,
    _delete_worker_impl,
    _get_visible_worker,
)
from services.worker_mutation import (
    _mutate_worker_contexts,
    _require_worker_write_workspace_context,
    _set_worker_enabled,
    _toggle_worker_star,
)

worker_lifecycle_router = APIRouter()

@worker_lifecycle_router.post("/workers/{worker_id}/star")
def toggle_worker_star(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#782: toggle the caller's star/favorite for a worker. Per-user; returns
    the new state. 404 if the worker is not visible to the caller."""
    worker_id = _canonical_worker_id(worker_id)
    if _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos) is None:
        raise HTTPException(status_code=404, detail="Worker not found")
    return {"starred": _toggle_worker_star(auth.user_id, worker_id)}


class _WorkerContextAttachRequest(BaseModel):
    name: str
    writeable: bool = False


class _WorkerContextUpdateRequest(BaseModel):
    writeable: bool




@worker_lifecycle_router.post("/workers/{worker_id}/contexts", response_model=WorkerDetail)
def attach_worker_context(
    worker_id: str,
    payload: _WorkerContextAttachRequest,
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

    return _mutate_worker_contexts(worker_id, _add, auth=auth, repos=repos)


@worker_lifecycle_router.patch("/workers/{worker_id}/contexts/{context_name}", response_model=WorkerDetail)
def update_worker_context(
    worker_id: str,
    context_name: str,
    payload: _WorkerContextUpdateRequest,
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

    detail = _mutate_worker_contexts(worker_id, _update, auth=auth, repos=repos)
    if not found["hit"]:
        raise HTTPException(status_code=404, detail="Context not attached to this worker")
    return detail


@worker_lifecycle_router.delete("/workers/{worker_id}/contexts/{context_name}", response_model=WorkerDetail)
def detach_worker_context(
    worker_id: str,
    context_name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """#790: detach a brain folder from a worker."""
    found = {"hit": False}

    def _remove(contexts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        kept = [c for c in contexts if c["name"] != context_name]
        found["hit"] = len(kept) != len(contexts)
        return kept

    detail = _mutate_worker_contexts(worker_id, _remove, auth=auth, repos=repos)
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
    if _get_visible_worker(canonical_id, user_id=auth.user_id, repos=repos) is None:
        # Check whether any DB row exists for this worker_id regardless of ownership.
        # _db_worker_owners() reads the raw workers table and maps id → owner_id.
        # If the id appears there, a real DB-backed worker exists that the caller
        # cannot see — that is the ownership-protection case; raise 404.
        # If the id does not appear, it is a true orphan (directory without DB row);
        # let _delete_worker_impl handle it (it will rmtree the dir and return 204).
        if canonical_id in _db_worker_owners():
            raise HTTPException(status_code=404, detail="Worker not found")
    _delete_worker_impl(worker_id, auth.user_id, repos)
    # 204 No Content — FastAPI returns empty body automatically for status_code=204
    return None
