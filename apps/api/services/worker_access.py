"""Worker access-control and visibility helpers.

Extracted from main.py as a single cohesive cluster (verified closed by call-graph
analysis). These helpers answer "can the current request see / mutate this worker?"
and normalize worker ids. They are consumed by the worker, run, chat, and sharing
route groups and by chat_service.

Dependency direction is strictly downward: this module imports from ``core.config``
(stock/system id sets, deploy-mode predicates), ``db``, ``auth.context``, and
``worker_registry`` — never from ``main``.
"""

from __future__ import annotations

import re
import sqlite3
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Optional

from fastapi import HTTPException

from core.config import (
    PROTECTED_STOCK_WORKER_IDS,
    PUBLIC_STOCK_WORKER_IDS,
    _SYSTEM_WORKER_IDS,
    _INTERNAL_WORKER_ID_PREFIXES,
    _is_cloud_deploy,
    _user_scoped_local_mode,
)

if TYPE_CHECKING:
    from db import Repositories

# db, worker_registry and auth.context are imported lazily inside the functions
# below (not at module load). The test suite isolates state by popping those
# modules from sys.modules and re-importing main between tests; binding their
# functions at import time here would pin this module to the pre-reload module
# (e.g. a stale auth.context ContextVar -> the current request's auth context
# reads as unset). Resolving them at call time always uses the live module.


def _slugify_worker_id(value: str) -> str:
    """Coerce an arbitrary id into a SLUG_PATTERN-valid slug.

    ``SLUG_PATTERN`` (``^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$``) forbids
    underscores, uppercase, leading/trailing hyphens, and ids shorter than 3
    chars. The 8 stock workers are underscore-named (``weekly_update`` etc.), so
    a clone base of ``weekly_update-copy`` is NOT a valid slug and would be
    rejected at registration with HTTP 400. Lowercase, replace every invalid
    character with a hyphen, collapse runs of hyphens, and strip leading/trailing
    hyphens so the result always matches SLUG_PATTERN (e.g. ``weekly_update`` ->
    ``weekly-update``). A too-short result is padded so the min-length rule holds.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if len(slug) < 3:
        slug = (slug + "-worker").strip("-")
    return slug


def _canonical_worker_id(value: str) -> str:
    text = (value or "").strip()
    if text in PROTECTED_STOCK_WORKER_IDS:
        return text
    return _slugify_worker_id(text)


def _raise_if_protected_worker_mutation(worker_id: str) -> None:
    if worker_id in PROTECTED_STOCK_WORKER_IDS:
        raise HTTPException(status_code=403, detail="Stock workers cannot be modified through the API")


def _shared_filesystem_fallback_allowed() -> bool:
    return not _is_cloud_deploy() and not _user_scoped_local_mode()


@lru_cache(maxsize=1)
def _tracked_worker_ids() -> frozenset[str]:
    # This file lives at apps/api/services/worker_access.py, so the repo root
    # (which holds the shipped, git-tracked workers/ tree) is three parents up.
    repo_root = Path(__file__).resolve().parents[3]
    try:
        tracked = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files", "workers/*/worker.yml"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        worker_ids = {
            worker_yml.parent.name
            for worker_yml in (repo_root / "workers").glob("*/worker.yml")
            if worker_yml.is_file()
        }
    else:
        worker_ids = {
            Path(line.strip()).parent.name
            for line in tracked.stdout.splitlines()
            if line.strip().endswith("/worker.yml")
        }
    return frozenset(worker_ids)


def _worker_hidden_from_api(
    worker_id: str,
    _owned_tracked_ids: frozenset[str] | None = None,
) -> bool:
    """Return True if worker_id should be hidden from the public API.

    Pass _owned_tracked_ids (a pre-fetched frozenset of git-tracked workers
    that have a DB owner) when calling inside a list loop to avoid one
    extra SELECT per worker (N+1). When absent the function falls back to
    an individual get_owner() query.
    """
    if worker_id.startswith("."):
        return True
    if any(worker_id.startswith(prefix) for prefix in _INTERNAL_WORKER_ID_PREFIXES):
        return True
    tracked_ids = _tracked_worker_ids()
    if worker_id in tracked_ids:
        if worker_id in _SYSTEM_WORKER_IDS:
            return True
        if worker_id in PUBLIC_STOCK_WORKER_IDS:
            return False
        # Git-tracked workers that have a DB owner are user workers — always visible.
        # Only pure engine/stock workers (no DB owner) are hidden from the user API.
        if _owned_tracked_ids is not None:
            return worker_id not in _owned_tracked_ids
        from db import get_repositories
        try:
            owner = get_repositories().workers.get_owner(worker_id=worker_id)
            if owner:
                return False
        except Exception:
            # On DB error expose the worker rather than silently clearing the
            # entire list (fail open for visibility, not fail closed).
            return False
        return True
    return False


def _visibility_role(role: Optional[str]) -> Optional[str]:
    """Resolve the worker-visibility role for the current request.

    Most callers pass role=None and historically relied on the shared-filesystem
    fallback to surface admin/shared workers. Now that the fallback is owner-
    scoped, default the role from the active request's auth context so admins
    still see EVERY worker and members still see workers SHARED with them, while
    another member's private worker stays hidden. Outside a request (no auth
    context) the role stays None — legacy owner-scoped behaviour.

    Security: local secret auth deliberately passes role=None via _worker_repo_role
    to keep workspace scoping intact. If we override that None with the auth
    context's default role ("admin"), _list_db_workers runs unfiltered and leaks
    workers across workspaces (issue #809). We must honour the explicit None from
    _worker_repo_role by skipping the auth-context default for local secret auth.
    """
    from auth.context import current_auth_context
    if role is not None:
        return role
    ctx = current_auth_context()
    if ctx is None:
        return None
    # Local single-operator secret auth: _worker_repo_role deliberately passes
    # None so the DB query stays scoped to the requesting user's workspace. Do
    # NOT upgrade that None to ctx.role ("admin" by default), which would bypass
    # workspace isolation. All other auth methods (session, PAT, cloud, supabase)
    # should use their declared role so admins/members see the right workers.
    import os
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local" and ctx.auth_method == "secret":
        return None
    return ctx.role


def _db_worker_owners() -> Dict[str, str]:
    """Map every DB worker id to its owner_id in one query.

    Used to keep the shared-filesystem fallback from leaking another member's
    runtime-created worker: a worker on disk that has a DB owner who is not the
    requesting user belongs to them and must never be surfaced.
    """
    from db import get_db
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, owner_id FROM workers WHERE owner_id IS NOT NULL"
            ).fetchall()
        return {str(r[0]): str(r[1]) for r in rows if r[0] and r[1]}
    except sqlite3.OperationalError:
        return {}


def _granted_asset_ids(asset_type: str) -> frozenset[str]:
    """Asset ids of ``asset_type`` granted to the CURRENT request's viewer.

    #767/#768 enforcement hook. A ``specific_people`` grant records a grantee by
    email (``asset_grants.grantee_email``); this resolves the active request's
    auth-context email to the set of assets shared with them so the visibility
    resolvers can surface those assets. Returns an empty set outside a request
    (no auth context) or for an email-less context — fail CLOSED (no grant)
    rather than open. Never raises: a grant probe must not break a list/detail.
    """
    from auth.context import current_auth_context
    from db import get_db
    ctx = current_auth_context()
    email = ((ctx.email if ctx else None) or "").strip().lower()
    if not email:
        return frozenset()
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT asset_id FROM asset_grants "
                "WHERE asset_type = ? AND lower(grantee_email) = ?",
                (asset_type, email),
            ).fetchall()
    except sqlite3.OperationalError:
        return frozenset()
    return frozenset(str(r[0]) for r in rows if r and r[0])


def _granted_worker_ids() -> frozenset[str]:
    """Canonical worker ids the current viewer has been granted (#767/#768)."""
    return frozenset(_canonical_worker_id(wid) for wid in _granted_asset_ids("worker"))


def _get_db_worker(
    worker_id: str,
    *,
    user_id: str,
    repos: Repositories,
    role: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    try:
        return repos.workers.get(user_id=user_id, worker_id=worker_id, role=role)
    except TypeError as exc:
        if "role" not in str(exc):
            raise
        return repos.workers.get(user_id=user_id, worker_id=worker_id)
    except sqlite3.OperationalError:
        return None


def _archived_tracked_worker(worker_id: str) -> Optional[Dict[str, Any]]:
    """Return a tracked worker's filesystem record iff it is archived.

    Archived workers are intentionally inactive but NOT deleted: the detail
    page must still render them (archived badge + reason + Restore) instead of
    404ing (1.5.3). Only archived workers get this fallback — other hidden
    tracked workers stay hidden.
    """
    from worker_registry import get_worker
    if worker_id not in _tracked_worker_ids():
        return None
    worker = get_worker(worker_id)
    if worker is not None and worker.get("archived"):
        return worker
    return None


def _get_visible_worker(
    worker_id: str,
    *,
    user_id: str,
    repos: Repositories,
    role: Optional[str] = None,
    include_grants: bool = False,
) -> Optional[Dict[str, Any]]:
    # Admin sees all, member sees own + shared; default from the request context
    # so the owner-scoped filesystem fallback below doesn't 404 an admin or a
    # worker shared with this member.
    #
    # include_grants (#767/#768) is OFF by default so EVERY mutation endpoint
    # that gates on this helper keeps owner/workspace-only semantics — a
    # specific-people grantee 404s there and can never edit/delete/run. Only the
    # read path (GET /workers/{id} detail) opts in, giving a grantee VIEW access.
    from worker_registry import get_worker
    role = _visibility_role(role)
    worker = _get_db_worker(worker_id, user_id=user_id, repos=repos, role=role)
    if worker is not None:
        if _worker_hidden_from_api(worker["id"]):
            # Archived workers stay reachable for detail rendering (not 404).
            if worker.get("archived"):
                return worker
            archived = _archived_tracked_worker(worker["id"])
            if archived is not None:
                return archived
            return None
        return worker
    if _worker_hidden_from_api(worker_id):
        # 1.5.3: archived tracked workers must render, not 404. Archived means
        # inactive, not deleted.
        archived = _archived_tracked_worker(worker_id)
        if archived is not None:
            return archived
        return None
    if worker_id in PUBLIC_STOCK_WORKER_IDS:
        return get_worker(worker_id)
    # #767/#768 enforcement: a viewer explicitly granted this worker can fetch it
    # even when visibility (private/specific_people) hides it from the owner-scoped
    # repo query above. get_any bypasses owner/visibility scoping; the grant IS the
    # authorization. VIEW only and opt-in (include_grants): only the read path
    # passes it, so a grantee never reaches a mutation endpoint's owner-scoped
    # write or the delete orphan-reap. Checked before the filesystem fallback so it
    # works in cloud (fallback disabled) too.
    if include_grants and _canonical_worker_id(worker_id) in _granted_worker_ids():
        try:
            granted = repos.workers.get_any(worker_id=worker_id)
        except Exception:
            granted = None
        if granted is not None:
            return granted
    if _shared_filesystem_fallback_allowed():
        # Owner-scope the filesystem fallback so one member cannot fetch — and,
        # via the endpoints that gate on this (run/edit/delete/files), act on —
        # another member's runtime worker. Unowned on-disk workers (true
        # first-run orphans) stay reachable; a worker owned by a different user
        # returns None (404).
        owner = _db_worker_owners().get(worker_id)
        if owner is not None and owner != user_id:
            return None
        return get_worker(worker_id)
    return None
