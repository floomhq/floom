"""Asset access-listing routes: who can access a worker or brain pack and why.

GET /workers/{id}/access and GET /contexts/{name}/access (#768) — both return
the owner + workspace-members (when visibility=workspace) + grantees, projected
through _AssetAccessEntry. Extracted verbatim from main.py.

Domain logic lives in services (worker_access._asset_access_list does the actual
owner/workspace/grant resolution; context_access for brain-pack scoping); db via
Depends(get_repos). The router is purged in lockstep with main by the test
fixtures.
"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException

from auth import AuthContext, get_auth_context
from db import Repositories, get_repos
from services.context_access import _context_summary, _require_context_for_user
from services.worker_access import (
    _AssetAccessEntry,
    _asset_access_list,
    _canonical_worker_id,
    _get_visible_worker,
)

asset_access_router = APIRouter()


@asset_access_router.get("/workers/{worker_id}/access", response_model=List[_AssetAccessEntry])
def list_worker_access(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[_AssetAccessEntry]:
    """#768: people-with-access listing for a worker (owner/workspace/grant)."""
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    return _asset_access_list(
        asset_type="worker", asset_id=worker_id,
        owner_id=str(worker.get("owner_id") or auth.user_id),
        visibility=str(worker.get("visibility") or "private"),
        auth=auth, repos=repos,
    )


@asset_access_router.get("/contexts/{name}/access", response_model=List[_AssetAccessEntry])
def list_context_access(
    name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[_AssetAccessEntry]:
    """#768: people-with-access listing for a brain pack."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id)
    summary = _context_summary(safe_name, _metadata, repos=repos, user_id=auth.user_id)
    return _asset_access_list(
        asset_type="brain_pack", asset_id=safe_name,
        owner_id=str(getattr(summary, "owner_id", None) or auth.user_id),
        visibility=str(getattr(summary, "visibility", "private")),
        auth=auth, repos=repos,
    )
