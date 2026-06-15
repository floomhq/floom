"""Asset share-grant routes (#767/#768).

``POST/GET /share/grants`` and ``DELETE /share/grants/{grant_id}`` — granting a
person (by email) view access to an asset, listing an asset's grantees, and
revoking a grant. Extracted verbatim from main.py into an APIRouter.

Following the channels/* convention, db helpers are imported lazily inside the
handlers (the test suite purges ``db``/``auth`` and re-imports them between
cases). ``services.worker_access`` is never purged and resolves db/auth lazily
itself, so it is a real module-level import. ``AuthContext``/``get_auth_context``
and ``Repositories``/``get_repos`` appear in route signatures, so they are real
module-level imports; the share-grant test fixtures purge ``routers.*``
alongside ``main``/``auth`` so this router rebuilds with fresh deps.
"""

from __future__ import annotations

import sqlite3
import uuid as _uuid_mod
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from auth import AuthContext, get_auth_context
from db import Repositories, get_repos
from services.worker_access import (
    _canonical_worker_id,
    _get_visible_worker,
    _worker_permissions,
)

share_router = APIRouter()


class _GrantRequest(BaseModel):
    asset_type: str = Field(..., max_length=32)
    asset_id: str = Field(..., max_length=256)
    email: str = Field(..., max_length=256)


class _GrantOut(BaseModel):
    id: str
    email: str
    created_at: str


def _canonical_grant_asset_id(asset_type: str, asset_id: str) -> str:
    """Normalize a grant's asset id. Worker ids are canonicalized so a grant
    stored under any alias resolves the same id the enforcement path looks up;
    other asset types are stored verbatim."""
    return _canonical_worker_id(asset_id) if asset_type == "worker" else asset_id


def _assert_can_share_asset(asset_type: str, asset_id: str, auth: AuthContext, repos: Repositories) -> None:
    """#767: only someone who can share the asset may grant access to it."""
    if asset_type == "worker":
        worker = _get_visible_worker(_canonical_worker_id(asset_id), user_id=auth.user_id, repos=repos)
        if not worker:
            raise HTTPException(status_code=404, detail="Asset not found")
        if not _worker_permissions(worker, user_id=auth.user_id, repos=repos).can_share:
            raise HTTPException(status_code=403, detail="You cannot share this asset")
    # brain/run/workspace grants are owner-scoped — the auth check suffices.


@share_router.post("/share/grants", response_model=_GrantOut, status_code=201)
def add_share_grant(
    body: _GrantRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _GrantOut:
    """#767: grant a person (by email) access to an asset."""
    from db import get_db, now_iso

    email = body.email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=422, detail="A valid email is required")
    _assert_can_share_asset(body.asset_type, body.asset_id, auth, repos)
    # Store the canonical worker id so the enforcement path (which canonicalizes
    # the requested id) finds the grant regardless of the alias the caller used.
    asset_id = _canonical_grant_asset_id(body.asset_type, body.asset_id)
    ts = now_iso()
    gid = str(_uuid_mod.uuid4())
    with get_db() as conn:
        try:
            conn.execute(
                "INSERT INTO asset_grants (id, asset_type, asset_id, owner_id, grantee_email, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (gid, body.asset_type, asset_id, auth.user_id, email, ts),
            )
        except sqlite3.IntegrityError:
            existing = conn.execute(
                "SELECT id, created_at FROM asset_grants "
                "WHERE asset_type=? AND asset_id=? AND owner_id=? AND grantee_email=?",
                (body.asset_type, asset_id, auth.user_id, email),
            ).fetchone()
            return _GrantOut(id=str(existing["id"]), email=email, created_at=str(existing["created_at"]))
    return _GrantOut(id=gid, email=email, created_at=ts)


@share_router.get("/share/grants", response_model=List[_GrantOut])
def list_share_grants(
    asset_type: str,
    asset_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[_GrantOut]:
    """#768: list the people granted access to an asset (owner-scoped)."""
    from db import get_db

    asset_id = _canonical_grant_asset_id(asset_type, asset_id)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, grantee_email, created_at FROM asset_grants "
            "WHERE asset_type=? AND asset_id=? AND owner_id=? ORDER BY created_at",
            (asset_type, asset_id, auth.user_id),
        ).fetchall()
    return [
        _GrantOut(id=str(r["id"]), email=str(r["grantee_email"]), created_at=str(r["created_at"]))
        for r in rows
    ]


@share_router.delete("/share/grants/{grant_id}", status_code=204, response_class=Response)
def delete_share_grant(
    grant_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """#767: revoke a person's access grant."""
    from db import get_db

    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM asset_grants WHERE id = ? AND owner_id = ?", (grant_id, auth.user_id)
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Grant not found")
    return Response(status_code=204)
