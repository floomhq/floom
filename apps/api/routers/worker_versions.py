"""Worker version history + rollback routes.

GET /workers/{id}/versions, GET /workers/{id}/versions/{sha}, and
POST /workers/{id}/rollback/{sha}. Extracted verbatim from main.py.

Deps resolve to services (worker_serialize, worker_access, worker_registry_ops,
git_service); db/git_ops/worker_registry lazy in handlers. The router is purged
in lockstep with main by the worker test fixtures.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request

from auth import AuthContext, get_auth_context
from db import Repositories, get_repos
from models import VersionSummary, WorkerDetail
from services.git_service import _git_author, _git_workspace, _require_sha_in_asset_history, _workers_git_prefix
from services.worker_access import (
    _canonical_worker_id,
    _get_visible_worker,
    _raise_if_protected_worker_mutation,
    _worker_for_mutation,
)
from services.worker_mutation import _require_worker_write_workspace_context
from services.worker_registry_ops import (
    _embed_files_in_skill_version,
    _git_commit_worker,
    _persist_discovered_workers,
)
from services.worker_serialize import _build_worker_detail, _should_ignore_worker_file

logger = logging.getLogger("floom.api")

worker_versions_router = APIRouter()

@worker_versions_router.get("/workers/{worker_id}/versions", response_model=List[VersionSummary])
def list_worker_versions(
    worker_id: str,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[VersionSummary]:
    """List git commit history for a worker (newest first)."""
    import git_ops as _git_ops
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    prefix = _workers_git_prefix()
    workspace = _git_workspace()
    rows = _git_ops.get_log(
        workspace,
        rel_path=f"{prefix}/{worker_id}",
        limit=min(limit, 100),
        asset_type="worker",
        asset_id=worker_id,
    )
    # #979: a GET must be side-effect free. The old path committed a baseline
    # when history was empty, so a read (incl. a browser prefetch or crawler)
    # mutated server-side git state and could snapshot a wrongly-visible private
    # worker. Baseline creation now happens on worker create/update/import; an
    # empty history just returns [].
    return [VersionSummary(**r) for r in rows]


@worker_versions_router.get("/workers/{worker_id}/versions/{sha}")
def get_worker_version(
    worker_id: str,
    sha: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return the file tree for a worker at a specific git commit."""
    import git_ops as _git_ops
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    workspace = _git_workspace()
    prefix = _workers_git_prefix()
    file_paths = _git_ops.list_files_at_sha(workspace, sha, f"{prefix}/{worker_id}")
    if not file_paths:
        raise HTTPException(status_code=404, detail="Version not found or worker had no files at this commit")
    files = []
    for fp in file_paths:
        rel = fp[len(f"{prefix}/{worker_id}/"):]
        # #1681: never surface credential/secret-bearing files (vertex-wif-cred.json,
        # .env, *.pem, ...) or build cruft in the version-history file tree.
        if _should_ignore_worker_file(rel):
            continue
        content = _git_ops.get_file_at_sha(workspace, sha, fp)
        if content is not None:
            files.append({"path": rel, "content": content})
    return {"files": files}


@worker_versions_router.post("/workers/{worker_id}/rollback/{sha}", response_model=WorkerDetail)
def rollback_worker(
    worker_id: str,
    sha: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Restore a worker to the state at a given git commit SHA."""
    from db import get_db
    from worker_registry import discover_workers, invalidate_worker_cache
    import git_ops as _git_ops
    # #1455(b): rollback rewrites the worker bundle, so it is a worker write and
    # takes the same workspace-context guard as create/update/delete.
    _require_worker_write_workspace_context(request)
    worker_id = _canonical_worker_id(worker_id)
    _raise_if_protected_worker_mutation(worker_id)
    worker = _worker_for_mutation(worker_id, auth, repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    workspace = _git_workspace()
    prefix = _workers_git_prefix()
    worker_git_path = f"{prefix}/{worker_id}"
    _require_sha_in_asset_history(workspace, sha, worker_git_path)

    try:
        _git_ops.checkout_path(workspace, sha, worker_git_path)
    except _git_ops.GitOpsError as exc:
        raise HTTPException(status_code=404, detail=f"Commit {sha!r} not found: {exc}") from exc

    author_name, author_email = _git_author(auth)
    _git_commit_worker(
        worker_id,
        message=f"rollback: restore {worker_id} to {sha}",
        author_name=author_name,
        author_email=author_email,
    )

    invalidate_worker_cache()
    workers = discover_workers()
    this_worker_list = [w for w in workers if w["id"] == worker_id]
    if not this_worker_list:
        raise HTTPException(status_code=500, detail=f"Worker {worker_id!r} not found after rollback")
    with get_db() as conn:
        # Single-worker save: surface a persist failure (don't silently skip).
        _persist_discovered_workers(conn, this_worker_list, user_id=auth.user_id, raise_on_skip=True)

    try:
        from worker_registry import WORKERS_DIR as _WD
        _embed_files_in_skill_version(worker_id, _WD / worker_id)
    except Exception:
        logger.warning("Failed to embed files in DB after rollback for worker %s", worker_id, exc_info=True)

    return _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)
