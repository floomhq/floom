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
from pydantic import BaseModel

from core.utils import row_to_dict

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


def _worker_for_mutation(
    worker_id: str,
    auth: "AuthContext",
    repos: Repositories,
) -> Optional[Dict[str, Any]]:
    """Resolve a worker the caller may MUTATE (donation model).

    - Owner fetch (unchanged): a member mutates their own private workers.
    - Admins additionally mutate workspace-shared workers, which are owned by
      the synthetic workspace actor after share-transfer — no human is ever
      is_owner of those, so this is the ONLY mutation path for shared workers.
    Returns None when the caller has no mutation rights (callers 404).
    """
    worker = _get_db_worker(worker_id, user_id=auth.user_id, repos=repos)
    if worker is not None:
        return worker
    if auth.is_admin:
        any_row = repos.workers.get_any(worker_id=worker_id)
        if any_row and str(any_row.get("visibility") or "private") == "workspace":
            return any_row
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
    owner_aliases: Optional[set[str]] = None,
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
    owner_id = str(worker.get("owner_id") or "")
    visibility = str(worker.get("visibility") or "private")
    # #767/#768: a specific-people grant adds VIEW access for the grantee, never
    # run/edit/delete/share (those stay with the owner / workspace admins). The
    # engine asset_access rule does not know about the app-level asset_grants
    # table, so the grant is layered in here.
    granted = bool(worker_id) and _canonical_worker_id(worker_id) in _granted_worker_ids()
    aliases = {user_id}
    if owner_aliases:
        aliases.update(alias for alias in owner_aliases if alias)
    is_owner = (not owner_id) or owner_id in aliases
    if asset_access is not None and worker_id and owner_id:
        try:
            perms = asset_access.get_permissions(
                workspace_id=str(worker.get("workspace_id") or "local-default"),
                user_id=user_id,
                asset_type="worker",
                asset_id=worker_id,
            )
            return AssetPermissions(
                is_owner=is_owner or bool(perms.get("is_owner", False)),
                can_view=is_owner or bool(perms.get("can_view", True)) or granted,
                can_edit=is_owner or bool(perms.get("can_edit", True)),
                can_run=is_owner or bool(perms.get("can_run", True)),
                can_delete=is_owner or bool(perms.get("can_delete", True)),
                can_share=is_owner or bool(perms.get("can_share", True)),
            )
        except Exception:
            logger.debug("permission probe failed for worker %s", worker_id, exc_info=True)
    # Fallback: stock/FS worker (no DB row) — the viewer who can see it is the
    # de-facto owner on the single-owner engine.
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


# ---------------------------------------------------------------------------
# Worker/run serializer helpers (manifest-declared names, trigger labels)
# ---------------------------------------------------------------------------

def _normalize_run_status(status_value: str) -> str:
    value = (status_value or "").lower()
    if value in {"completed", "approved", "success"}:
        return "success"
    if value == "pending_approval":
        return "pending_approval"
    if value in {"running", "queued"}:
        return "running"
    return "error"

def _available_connection_slugs_for_user(user_id: str, repos: "Repositories") -> set[str]:
    """Return lower-cased app_name slugs for all active connections owned by user_id."""
    _live = {"active", "valid", "connected"}
    try:
        rows = repos.connections.list(user_id=user_id)
        return {
            row_to_dict(r).get("app_name", "").lower()
            for r in rows
            if str((row_to_dict(r).get("status") or "")).lower() in _live
        }
    except Exception:
        return set()

def _normalize_trigger_type(value: Any) -> str:
    normalized = str(value or "manual").strip().lower()
    if normalized in {"cron", "scheduled"}:
        return "schedule"
    return normalized or "manual"

def _trigger_label(trigger: Dict[str, Any]) -> str:
    """Return a human-readable label for one trigger dict."""
    t_type = _normalize_trigger_type(trigger.get("type"))
    if t_type == "manual":
        return "Manual"
    if t_type in ("schedule", "scheduled"):
        cron_expr = trigger.get("cron")
        if cron_expr:
            return f"Cron · {cron_expr}"
        every = trigger.get("every")
        at_time = trigger.get("at")
        if every and at_time:
            return f"Every {every} at {at_time}"
        if every:
            return f"Every {every}"
        return "Scheduled"
    if t_type == "webhook":
        return "Webhook"
    if t_type == "composio":
        composio = trigger.get("composio")
        if composio and isinstance(composio, dict):
            event = composio.get("event") or ""
            conn_id = composio.get("connection_id") or ""
            app_hint = conn_id.split("_")[0].split("-")[0] if conn_id else "integration"
            if event:
                return f"On {app_hint} · {event}"
            return f"On {app_hint}"
        return "On integration"
    return t_type.title()

def _list_operator_workers(
    *,
    user_id: str,
    repos: "Repositories",
    use_cache: bool = True,
    role: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Workers shown in the operator's default view.

    Same filter as the default GET /workers view: visible (non-hidden) workers,
    minus system_worker:true and archived. Shared by /workers and the overview
    'Workers active' count so the two numbers cannot drift (1.5.4).

    ``role`` MUST be threaded through identically to GET /workers
    (``_worker_repo_role(auth)``); otherwise an admin member sees the full
    workspace-visible set on /workers but a smaller owner-only set on the
    overview, and the two counts diverge (the 78-vs-104 scoping bug). The
    ``user_id`` passed here must likewise be the access-resolved id
    (``_worker_access_user_id(auth)``), not the raw caller id.
    """
    workers = _list_visible_workers(
        user_id=user_id, repos=repos, use_cache=use_cache, role=role
    )
    workers = [
        w for w in workers
        if not (w.get("manifest") or {}).get("system_worker", False)
    ]
    workers = [w for w in workers if not w.get("archived", False)]
    return workers

def _worker_required_secret_names(w: Dict[str, Any]) -> List[str]:
    """Required secret NAMES declared by a worker manifest (never values).

    The normalized ``WorkerConfig`` surfaces secrets at the top level
    (``config["secrets"]``); raw manifests may also nest them under
    ``capabilities.secrets`` / ``exec.secrets``. Read all three so the name list
    is complete regardless of which shape we got.
    """
    names: List[str] = []
    config = w.get("config") or {}
    for s in config.get("secrets") or []:
        if isinstance(s, str) and s.strip():
            names.append(s.strip())
    cap = config.get("capabilities") or {}
    for s in cap.get("secrets") or []:
        if isinstance(s, str) and s.strip():
            names.append(s.strip())
    exec_block = config.get("exec") or {}
    for s in exec_block.get("secrets") or []:
        if isinstance(s, str) and s.strip():
            names.append(s.strip())
    # de-dup, preserve order
    seen: set[str] = set()
    ordered: List[str] = []
    for n in names:
        if n not in seen:
            seen.add(n)
            ordered.append(n)
    return ordered

def _worker_connection_slugs(w: Dict[str, Any]) -> List[str]:
    """Required connection slugs declared by a worker manifest (never tokens)."""
    config = w.get("config") or {}
    raw = config.get("connections") or []
    slugs: List[str] = []
    for c in raw:
        if isinstance(c, str) and c.strip():
            slugs.append(c.strip())
        elif isinstance(c, dict):
            label = (c.get("mcp", {}) or {}).get("label") or c.get("app") or c.get("slug")
            if isinstance(label, str) and label.strip():
                slugs.append(label.strip())
    seen: set[str] = set()
    ordered: List[str] = []
    for s in slugs:
        if s not in seen:
            seen.add(s)
            ordered.append(s)
    return ordered


# ---------------------------------------------------------------------------
# Worker deletion (shared by DELETE /workers/{id} and destructive-action approval)
# ---------------------------------------------------------------------------

def _delete_worker_impl(worker_id: str, owner_id: str, repos: "Repositories") -> None:
    """Core delete-worker logic, shared by the DELETE endpoint and approval execution."""
    import shutil

    from worker_registry import WORKERS_DIR, invalidate_worker_cache
    from models import RunStatus
    from run_service import get_worker_config_for_run, update_run_status
    from services.composio import _composio_trigger_signature, _disable_composio_trigger
    from services.git_service import (
        _ensure_git_workspace_ready,
        _git_ops_lock,
        _git_workspace,
        _workers_git_prefix,
    )
    import git_ops as _git_ops
    worker_id = _canonical_worker_id(worker_id)
    _raise_if_protected_worker_mutation(worker_id)
    worker = repos.workers.get(user_id=owner_id, worker_id=worker_id)
    if not worker:
        bundle_dir = WORKERS_DIR / worker_id
        if bundle_dir.is_dir():
            shutil.rmtree(bundle_dir, ignore_errors=True)
            invalidate_worker_cache()
            logger.info("Removed orphaned worker bundle dir %s", bundle_dir)
            return
        raise HTTPException(status_code=404, detail="Worker not found")
    skill_version_id = worker.get("skill_version_id")
    config = get_worker_config_for_run(worker_id)
    composio_state = {
        "trigger_id": worker.get("composio_trigger_id"),
        "event": worker.get("composio_event"),
        "signature": _composio_trigger_signature(config),
    }

    if composio_state.get("trigger_id"):
        try:
            _disable_composio_trigger(
                composio_state.get("event") or (composio_state.get("signature") or {}).get("event"),
                composio_state.get("trigger_id"),
                worker_id,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Cancel any in-progress runs gracefully before deletion
    active_runs = repos.workers.list_active_run_ids(user_id=owner_id, worker_id=worker_id)

    for run_id in active_runs:
        try:
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error="Worker deleted",
                error_code="worker_deleted",
                user_id=owner_id,
                repos=repos,
            )
            logger.info("Cancelled active run %s before worker deletion", run_id)
        except Exception as exc:
            logger.warning("Could not cancel run %s: %s", run_id, exc)

    # Remove webhook secret
    try:
        from webhook_service import delete_webhook_secret
        delete_webhook_secret(worker_id, repos=repos)
    except Exception as exc:
        logger.warning("Could not delete webhook secret for %s: %s", worker_id, exc)

    # Delete the worker (FK CASCADE removes runs/artifacts/logs/webhooks)
    repos.workers.delete(user_id=owner_id, worker_id=worker_id)

    # Check if skill_version is still referenced by other workers; preserve if so.
    ref_count = repos.workers.get_skill_version_ref_count(skill_version_id=skill_version_id)
    if ref_count == 0 and skill_version_id:
        repos.workers.delete_skill_version(skill_version_id=skill_version_id)
        logger.info("Removed unreferenced skill_version %s", skill_version_id)

    # Remove bundle files from disk only if no other worker references this skill_version
    bundle_dir = WORKERS_DIR / worker_id
    if ref_count == 0 and bundle_dir.is_dir():
        try:
            shutil.rmtree(bundle_dir)
            logger.info("Removed bundle dir %s", bundle_dir)
            # Record the deletion in git history (files gone, history preserved)
            try:
                workspace = _git_workspace()
                prefix = _workers_git_prefix()
                with _git_ops_lock:
                    _ensure_git_workspace_ready(workspace)
                    _git_ops.commit_paths(workspace, [f"{prefix}/{worker_id}"], f"worker: delete {worker_id}")
            except Exception as _git_exc:
                logger.warning("git commit for worker deletion failed (non-fatal): %s", _git_exc)
        except Exception as exc:
            logger.warning("Could not remove bundle dir %s: %s", bundle_dir, exc)
    elif ref_count > 0:
        logger.info("skill_version %s still referenced by %d workers, bundle preserved", skill_version_id, ref_count)

    invalidate_worker_cache()


def _active_local_workspace_id(auth: "AuthContext") -> str:
    from auth.local_workspaces import DEFAULT_WORKSPACE_ID, local_workspace_base_user_id

    base_user_id = local_workspace_base_user_id(auth.user_id)
    if auth.user_id == base_user_id:
        return DEFAULT_WORKSPACE_ID
    marker = "__"
    return auth.user_id.split(marker, 1)[1]


class _AssetAccessEntry(BaseModel):
    user_id: Optional[str] = None
    email: Optional[str] = None
    display_name: Optional[str] = None
    role: str  # "owner" | "editor" | "viewer"
    source: str  # "owner" | "workspace" | "grant"


def _require_members_repo(repos: "Repositories") -> "WorkspaceMemberRepository":
    members = getattr(repos, "members", None)
    if members is None:
        raise HTTPException(status_code=501, detail="Membership not available")
    return members


def _asset_access_list(
    *,
    asset_type: str,
    asset_id: str,
    owner_id: str,
    visibility: str,
    auth: "AuthContext",
    repos: "Repositories",
) -> List[_AssetAccessEntry]:
    """#768: who can access this asset and why. Always the owner; workspace
    members when visibility=workspace; grantees when visibility=specific_people
    (grants are also surfaced if any exist, since they confer access)."""
    from db import get_db

    entries: List[_AssetAccessEntry] = []
    seen_emails: set[str] = set()

    # owner (resolve display info from the users table if available)
    owner_email = None
    owner_name = None
    try:
        if repos.users is not None:
            urow = repos.users.get(user_id=owner_id)
            if urow:
                owner_email = urow.get("email")
                owner_name = urow.get("display_name") or urow.get("username")
    except Exception:
        pass
    entries.append(_AssetAccessEntry(
        user_id=owner_id, email=owner_email, display_name=owner_name,
        role="owner", source="owner",
    ))
    if owner_email:
        seen_emails.add(owner_email.lower())

    if visibility == "workspace":
        try:
            members_repo = _require_members_repo(repos)
            workspace_id = _active_local_workspace_id(auth)
            for m in members_repo.list(workspace_id=workspace_id):
                if str(m.get("user_id")) == str(owner_id):
                    continue
                email = (m.get("email") or "")
                role = "editor" if str(m.get("role")) in ("owner", "admin") else "viewer"
                entries.append(_AssetAccessEntry(
                    user_id=str(m.get("user_id")), email=email or None,
                    display_name=m.get("display_name"), role=role, source="workspace",
                ))
                if email:
                    seen_emails.add(email.lower())
        except Exception:
            logger.debug("access list: workspace members lookup failed", exc_info=True)

    # grants (always surfaced — a grant confers access regardless of the tier)
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT grantee_email FROM asset_grants "
                "WHERE asset_type=? AND asset_id=? AND owner_id=? ORDER BY created_at",
                (asset_type, asset_id, owner_id),
            ).fetchall()
        for r in rows:
            email = str(r["grantee_email"] or "")
            if not email or email.lower() in seen_emails:
                continue
            seen_emails.add(email.lower())
            entries.append(_AssetAccessEntry(
                user_id=None, email=email, display_name=None,
                role="viewer", source="grant",
            ))
    except Exception:
        logger.debug("access list: grant lookup failed", exc_info=True)

    return entries
