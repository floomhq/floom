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

import logging
import os
import re
import sqlite3
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

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
    from models import AssetPermissions

logger = logging.getLogger("floom.api")

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


def _worker_permissions(
    worker: Dict[str, Any],
    *,
    user_id: str,
    repos: "Repositories",
) -> "AssetPermissions":
    """Compute the requesting user's access matrix for a worker.

    Delegates to the AssetAccessRepository when available (the engine-owned,
    Cloud-mirrorable rule). Falls back to an owner-permissive default for
    filesystem/stock workers that have no DB row (the caller is the de-facto
    owner of a stock worker they can see), so the OSS single-owner UX is
    unchanged. Never raises — a permission probe must not break a list/detail.
    """
    from models import AssetPermissions

    asset_access = getattr(repos, "asset_access", None)
    worker_id = str(worker.get("id") or "")
    owner_id = worker.get("owner_id")
    visibility = str(worker.get("visibility") or "private")
    # #767/#768: a specific-people grant adds VIEW access for the grantee, never
    # run/edit/delete/share (those stay with the owner / workspace admins). The
    # engine asset_access rule does not know about the app-level asset_grants
    # table, so the grant is layered in here.
    granted = bool(worker_id) and _canonical_worker_id(worker_id) in _granted_worker_ids()
    if asset_access is not None and worker_id and owner_id:
        try:
            perms = asset_access.get_permissions(
                workspace_id=str(worker.get("workspace_id") or "local-default"),
                user_id=user_id,
                asset_type="worker",
                asset_id=worker_id,
            )
            return AssetPermissions(
                is_owner=bool(perms.get("is_owner", owner_id == user_id)),
                can_view=bool(perms.get("can_view", True)) or granted,
                can_edit=bool(perms.get("can_edit", True)),
                can_run=bool(perms.get("can_run", True)),
                can_delete=bool(perms.get("can_delete", True)),
                can_share=bool(perms.get("can_share", True)),
            )
        except Exception:
            logger.debug("permission probe failed for worker %s", worker_id, exc_info=True)
    # Fallback: stock/FS worker (no DB row) — the viewer who can see it is the
    # de-facto owner on the single-owner engine.
    is_owner = (not owner_id) or owner_id == user_id
    shared = visibility == "workspace"
    return AssetPermissions(
        is_owner=is_owner,
        can_view=is_owner or shared or granted,
        can_edit=is_owner,
        can_run=is_owner or shared,
        can_delete=is_owner,
        can_share=is_owner,
    )


# ---------------------------------------------------------------------------
# Worker listing / visibility composition (DB + stock + filesystem + grants)
# ---------------------------------------------------------------------------

def _list_db_workers(
    *,
    user_id: str,
    repos: "Repositories",
    role: Optional[str] = None,
) -> List[Dict[str, Any]]:
    try:
        return repos.workers.list(user_id=user_id, role=role)
    except sqlite3.OperationalError:
        return []


def _worker_access_user_id(auth: "AuthContext") -> str:
    """Resolve the engine owner id for worker visibility checks."""
    from auth.local_workspaces import DEFAULT_WORKSPACE_ID, local_workspace_base_user_id
    from db import get_db

    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local" and auth.user_id != local_workspace_base_user_id(auth.user_id):
        return auth.user_id
    username = (auth.username or "").strip()
    if deploy != "local" or not username or username == auth.user_id:
        return auth.user_id
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT 1
                FROM workspace_members
                WHERE workspace_id = ?
                  AND user_id = ?
                  AND role IN ('owner', 'admin')
                  AND status = 'active'
                LIMIT 1
                """,
                (DEFAULT_WORKSPACE_ID, username),
            ).fetchone()
            if row is not None:
                return username
            row = conn.execute(
                """
                SELECT 1
                FROM local_workspaces
                WHERE id = ? AND owner_user_id = ?
                LIMIT 1
                """,
                (DEFAULT_WORKSPACE_ID, username),
            ).fetchone()
            if row is not None:
                return username
    except Exception:
        logger.debug("worker access user-id compatibility lookup failed", exc_info=True)
    return auth.user_id


def _worker_repo_role(auth: "AuthContext") -> str | None:
    """Return the worker-repo role for the current auth context.

    Local OSS secret auth uses the shared backdoor but still needs workspace
    boundaries, so it must not bypass the repo with admin visibility. Session /
    PAT / cloud auth keep their declared role semantics.
    """
    if (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower() == "local" and auth.auth_method == "secret":
        return None
    return auth.role


def _build_owned_tracked_ids() -> frozenset[str]:
    """Return the set of git-tracked worker IDs that have a DB owner.

    Called once before a list loop to pre-load ownership for all tracked
    workers in a single query, eliminating the N+1 problem in
    _worker_hidden_from_api().
    """
    tracked = _tracked_worker_ids()
    if not tracked:
        return frozenset()
    from db import get_repositories
    try:
        placeholders = ",".join("?" * len(tracked))
        from db import get_db
        with get_db() as conn:
            rows = conn.execute(
                f"SELECT id FROM workers WHERE id IN ({placeholders}) AND owner_id IS NOT NULL",
                tuple(tracked),
            ).fetchall()
        return frozenset(str(r["id"]) for r in rows)
    except Exception:
        return frozenset(tracked)  # Fail open: treat all as owned


def _worker_source_visible_to_api(worker_id: str) -> bool:
    if _worker_hidden_from_api(worker_id):
        return False
    # Public stock/example workers ship their source on purpose — the Source
    # tab is meant to show run.py / SKILL.md / worker.yml so users can learn
    # from and fork them. These are git-tracked, so the generic
    # "not tracked" rule below would hide them (R3: /workers/<stock>#code was
    # empty for every example worker). Make stock source explicitly visible.
    if worker_id in PUBLIC_STOCK_WORKER_IDS:
        return True
    return worker_id not in _tracked_worker_ids()


def _stock_workers_from_filesystem(*, use_cache: bool = True) -> List[Dict[str, Any]]:
    from worker_registry import discover_workers

    return [
        worker
        for worker in discover_workers(use_cache=use_cache)
        if worker["id"] in PUBLIC_STOCK_WORKER_IDS
    ]


def _list_visible_workers(
    *,
    user_id: str,
    repos: "Repositories",
    use_cache: bool = True,
    role: Optional[str] = None,
) -> List[Dict[str, Any]]:
    # Admin sees all, member sees own + shared; default from the request context
    # so the owner-scoped fallback below doesn't hide admin/shared workers.
    from worker_registry import discover_workers

    role = _visibility_role(role)
    # Pre-load ownership for all git-tracked workers in one query so
    # _worker_hidden_from_api() inside the loop doesn't fire N extra SELECTs.
    _owned = _build_owned_tracked_ids()
    visible = {
        worker["id"]: worker
        for worker in _list_db_workers(user_id=user_id, repos=repos, role=role)
        if not str(worker.get("id") or "").startswith(".")
        and not _worker_hidden_from_api(str(worker.get("id") or ""), _owned)
    }
    for worker in _stock_workers_from_filesystem(use_cache=use_cache):
        visible.setdefault(worker["id"], worker)
    if _shared_filesystem_fallback_allowed():
        # Owner-scope the fallback so it never leaks another member's runtime
        # worker. Only unowned on-disk workers (true first-run orphans) and the
        # requesting user's own workers are surfaced here; curated shipped
        # templates already came in via _stock_workers_from_filesystem() above.
        # This keeps single-operator first-run UX intact (you still see all your
        # own + shipped workers) while making worker visibility consistent with
        # the per-member run/secret isolation.
        _owners = _db_worker_owners()
        for worker in discover_workers(use_cache=use_cache):
            worker_id = str(worker.get("id") or "")
            if not worker_id or _worker_hidden_from_api(worker_id, _owned):
                continue
            owner = _owners.get(worker_id)
            if owner is not None and owner != user_id:
                continue  # belongs to another member — do not surface
            visible.setdefault(worker_id, worker)
    # #767/#768 enforcement: surface workers explicitly shared with this viewer
    # (by email) even when visibility (private/specific_people) would otherwise
    # hide them. get_any bypasses owner/visibility scoping — the grant IS the
    # authorization. This is read access only; repo UPDATE/DELETE stay
    # owner-scoped (WHERE owner_id=?), so a grantee cannot edit or delete.
    for gid in _granted_worker_ids():
        if gid in visible or _worker_hidden_from_api(gid, _owned):
            continue
        try:
            granted = repos.workers.get_any(worker_id=gid)
        except Exception:
            granted = None
        if granted is not None:
            visible[gid] = granted
    return list(visible.values())


def _mcp_input_schema_from_worker_record(worker: Dict[str, Any]) -> Dict[str, Any]:
    config = worker.get("config") or {}
    inputs = config.get("inputs") if isinstance(config, dict) else []
    if not isinstance(inputs, list):
        return {"type": "object", "properties": {}}
    properties: Dict[str, Any] = {}
    required: List[str] = []
    type_map = {
        "string": "string",
        "text": "string",
        "markdown": "string",
        "number": "number",
        "integer": "integer",
        "boolean": "boolean",
        "bool": "boolean",
        "object": "object",
        "json": "object",
        "array": "array",
    }
    for item in inputs:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        raw_type = str(item.get("type") or item.get("kind") or "string").lower()
        prop: Dict[str, Any] = {"type": type_map.get(raw_type, "string")}
        if item.get("description"):
            prop["description"] = str(item["description"])
        if isinstance(item.get("options"), list):
            prop["enum"] = [str(option) for option in item["options"]]
        properties[name] = prop
        if item.get("required"):
            required.append(name)
    schema: Dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema
