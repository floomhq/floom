"""Worker admin/detail/share routes: share-link, detail, bundle export,
visibility, archive/restore, AI suggest, sample-input.

POST/DELETE /workers/{id}/share-link, GET /workers/{id}, GET
/workers/{id}/bundle.zip, PATCH /workers/{id}/visibility, POST
/workers/{id}/restore, POST /workers/{id}/archive, POST
/workers/{id}/suggest, GET /workers/{id}/sample-input. Extracted verbatim
from main.py (only worker_registry imports made lazy-in-handler per the
purged-module convention).

Deps from services (worker_access / worker_mutation / worker_serialize /
share_links / worker_registry_ops / git_service / secrets_env); db lazy via
Depends(get_repos); worker_registry lazy inside handlers. The router is
purged in lockstep with main by the worker test fixtures.
"""

from __future__ import annotations

import io
import json
import logging
import re
import zipfile
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from auth import AuthContext, get_auth_context
from db import Repositories, get_repos
from models import (
    WorkerDetail,
    WorkerVisibilityUpdate,
    _WorkerSuggestRequest,
    _WorkerSuggestResponse,
    _WorkerSuggestion,
)
from services.git_service import _git_author
from services.secrets_env import _platform_openai_api_key
from services.share_links import (
    _create_or_get_standalone_share_link,
    _revoke_standalone_share_link,
)
from services.worker_access import (
    _canonical_worker_id,
    _get_visible_worker,
    _raise_if_protected_worker_mutation,
    _worker_access_user_id,
    _worker_permissions,
    _worker_repo_role,
)
from services.worker_mutation import (
    _patch_worker_yml_field,
    _require_worker_write_workspace_context,
    _set_db_manifest_archived,
)
from services.worker_registry_ops import _git_commit_worker
from services.worker_serialize import _build_worker_detail, _iter_worker_dir_files

logger = logging.getLogger("floom.api")

worker_admin_router = APIRouter()


@worker_admin_router.post("/workers/{worker_id}/share-link")
def create_worker_share_link(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    perms = _worker_permissions(worker, user_id=auth.user_id, repos=repos)
    if not perms.can_share:
        raise HTTPException(status_code=403, detail="You cannot share this worker")
    return _create_or_get_standalone_share_link(
        entity_type="worker",
        entity_id=str(worker["id"]),
        owner_id=str(worker.get("owner_id") or auth.user_id),
    )


@worker_admin_router.delete("/workers/{worker_id}/share-link")
def revoke_worker_share_link(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    """#766: revoke (disable) a worker's public share link."""
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    perms = _worker_permissions(worker, user_id=auth.user_id, repos=repos)
    if not perms.can_share:
        raise HTTPException(status_code=403, detail="You cannot share this worker")
    return _revoke_standalone_share_link(
        entity_type="worker",
        entity_id=str(worker["id"]),
        owner_id=str(worker.get("owner_id") or auth.user_id),
    )


@worker_admin_router.get("/workers/{worker_id}", response_model=WorkerDetail)
def get_worker_detail(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    canonical_id = _canonical_worker_id(worker_id)
    # include_grants=True: a specific-people grantee (#767/#768) can VIEW the
    # worker detail. This is the only caller that opts in; mutation endpoints
    # keep owner/workspace-only access.
    return _build_worker_detail(
        canonical_id,
        user_id=_worker_access_user_id(auth),
        repos=repos,
        role=_worker_repo_role(auth),
        include_grants=True,
        owner_aliases={auth.user_id, auth.username or ""},
    )


class _RequestEditAccessBody(BaseModel):
    message: Optional[str] = Field(default=None, max_length=2000)


@worker_admin_router.post("/workers/{worker_id}/request-edit", status_code=201)
def request_worker_edit_access(
    worker_id: str,
    body: _RequestEditAccessBody,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """#807: a member viewing a locked (workspace-shared, not owned) worker
    asks the owner/admin for edit access. 404 if the worker isn't visible,
    403 if the caller already has edit rights. Records a pending request
    (idempotent) and notifies the owner best-effort.
    """
    import sqlite3
    import uuid as _uuid_mod
    from db import get_db, now_iso

    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(
        worker_id, user_id=auth.user_id, repos=repos,
        role=_worker_repo_role(auth), include_grants=True,
    )
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    perms = _worker_permissions(
        worker, user_id=auth.user_id, repos=repos,
        owner_aliases={auth.user_id, auth.username or ""},
    )
    if perms.can_edit:
        raise HTTPException(status_code=403, detail="You already have edit access to this worker.")

    req_id = f"editreq_{_uuid_mod.uuid4().hex[:12]}"
    created = False
    with get_db() as conn:
        try:
            conn.execute(
                "INSERT INTO edit_access_requests (id, worker_id, requester_id, message, status, created_at) "
                "VALUES (?, ?, ?, ?, 'pending', ?)",
                (req_id, worker_id, auth.user_id, (body.message or None), now_iso()),
            )
            created = True
        except sqlite3.IntegrityError:
            # idempotent: a pending request from this member already exists
            created = False
    if created:
        try:
            from alerting import _send_email  # noqa: PLC0415

            _send_email(
                f"Edit-access request for worker {worker.get('name') or worker_id}",
                f"{auth.username or auth.user_id} requested edit access to "
                f"'{worker.get('name') or worker_id}'."
                + (f"\n\nMessage: {body.message}" if body.message else ""),
            )
        except Exception:
            logger.debug("edit-access request email failed (non-fatal)", exc_info=True)
    return {"ok": True, "pending": True}


@worker_admin_router.get("/workers/{worker_id}/edit-requests")
def list_worker_edit_requests(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[Dict[str, Any]]:
    """#807: the owner/admin lists pending edit-access requests for a worker."""
    from db import get_db

    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(
        worker_id, user_id=auth.user_id, repos=repos,
        role="admin" if auth.is_admin else _worker_repo_role(auth),
    )
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    perms = _worker_permissions(
        worker, user_id=auth.user_id, repos=repos,
        owner_aliases={auth.user_id, auth.username or ""},
    )
    if not (perms.can_edit or auth.is_admin):
        raise HTTPException(status_code=403, detail="Only the owner or an admin can view edit requests.")
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, worker_id, requester_id, message, status, created_at "
            "FROM edit_access_requests WHERE worker_id = ? AND status = 'pending' "
            "ORDER BY created_at DESC",
            (worker_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@worker_admin_router.get("/workers/{worker_id}/bundle.zip")
def download_worker_bundle(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    """#816: download a worker as a skill bundle (zip of its on-disk files:
    worker.yml, run.py, SKILL.md, requirements.txt). Importable via
    POST /workers/from-bundle. Visible-worker scoped (404 otherwise)."""
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    buf = io.BytesIO()
    file_count = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, data in _iter_worker_dir_files(worker_id):
            zf.writestr(f"{worker_id}/{rel}", data)
            file_count += 1
    if file_count == 0:
        raise HTTPException(status_code=409, detail="Worker has no exportable files")
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", worker_id)[:60] or "worker"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe}.zip"'},
    )


@worker_admin_router.put("/workers/{worker_id}/visibility", response_model=WorkerDetail)
def set_worker_visibility(
    worker_id: str,
    payload: WorkerVisibilityUpdate,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Set a worker's visibility (Private <-> Shared with workspace).

    Owner/admin only. The AssetAccessRepository enforces ``can_share`` and the
    enum; a non-owner without share rights gets 403. On the OSS single-owner
    engine the local user owns their workers, so this always succeeds for them
    and is a no-op-shaped toggle for the one-member workspace. 404 for an
    invisible/unknown worker (never reveals another owner's private worker).
    """
    _require_worker_write_workspace_context(request)
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(
        worker_id,
        user_id=auth.user_id,
        repos=repos,
        # donation model: workspace-shared workers are owned by the synthetic
        # workspace actor, so the admin doing the unshare is not their owner.
        role="admin" if auth.is_admin else None,
    )
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    asset_access = getattr(repos, "asset_access", None)
    if asset_access is None:
        raise HTTPException(status_code=501, detail="Visibility control not available")

    owner_id = worker.get("owner_id")
    if not owner_id:
        # Stock/filesystem worker with no DB row — not an editable asset.
        raise HTTPException(
            status_code=409,
            detail="This worker is read-only and its visibility cannot be changed.",
        )

    try:
        result = asset_access.set_visibility(
            workspace_id=str(worker.get("workspace_id") or "local-default"),
            actor_id=auth.user_id,
            asset_type="worker",
            asset_id=worker_id,
            visibility=payload.visibility,
            actor_role="admin" if auth.is_admin else None,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Worker not found")

    # Write visibility back to worker.yml so it travels with the repo
    _patch_worker_yml_field(worker_id, "visibility", str(payload.visibility))
    author_name, author_email = _git_author(auth)
    _git_commit_worker(
        worker_id,
        message=f"worker {worker_id}: set visibility to {payload.visibility}",
        author_name=author_name,
        author_email=author_email,
    )

    # Donation model: after share-transfer the caller is no longer the owner,
    # but they can still VIEW the now-workspace-shared worker — fetch the
    # response with the member/admin role path, not the owner-scoped default.
    return _build_worker_detail(
        worker_id,
        user_id=auth.user_id,
        repos=repos,
        role="admin" if auth.is_admin else "member",
    )


@worker_admin_router.post("/workers/{worker_id}/restore", response_model=WorkerDetail)
def restore_worker(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Restore an archived worker (set archived: false in worker.yml).

    Writes back to the bundle file so the change survives server restarts.
    Invalidates the worker cache so the worker reappears in the default list.
    """
    from worker_registry import WORKERS_DIR as _WORKERS_DIR, invalidate_worker_cache
    import re as _re

    worker_id = _canonical_worker_id(worker_id)
    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = _WORKERS_DIR / worker_id / "worker.yml"
    if not worker_yml_path.exists():
        raise HTTPException(status_code=404, detail="Worker not found")
    try:
        raw_yml = worker_yml_path.read_text(encoding='utf-8')
        # Remove or set archived to false. Match both `archived: true` and `archived:true`.
        updated = _re.sub(r"(?m)^(archived:\s*)true\s*$", r"\1false\n", raw_yml)
        if updated == raw_yml:
            # Field may be missing — just remove it (defaults to false)
            updated = raw_yml  # already not archived
        # Also remove archive_reason line when restoring
        updated = _re.sub(r"(?m)^archive_reason:.*\n?", "", updated)
        worker_yml_path.write_text(updated, encoding='utf-8')
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to update worker.yml: {exc}") from exc
    # Mirror the cleared archived flag into the DB manifest (see archive_worker:
    # the API reads `archived` from the DB, not disk).
    _set_db_manifest_archived(worker_id, archived=False, user_id=auth.user_id, repos=repos)
    invalidate_worker_cache()
    return _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)


@worker_admin_router.post("/workers/{worker_id}/archive", response_model=WorkerDetail)
def archive_worker(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Archive a worker (set archived: true in worker.yml).

    Reversible counterpart to /restore. Writes back to the bundle file so the
    change survives server restarts, and invalidates the worker cache so the
    worker drops out of the default list (it stays reachable under the Archived
    view + by direct link, where Restore is offered).
    """
    from worker_registry import WORKERS_DIR as _WORKERS_DIR, invalidate_worker_cache
    import re as _re

    worker_id = _canonical_worker_id(worker_id)
    _raise_if_protected_worker_mutation(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = _WORKERS_DIR / worker_id / "worker.yml"
    if not worker_yml_path.exists():
        raise HTTPException(status_code=404, detail="Worker not found")
    try:
        raw_yml = worker_yml_path.read_text(encoding='utf-8')
        # Flip an existing `archived: false` to true; otherwise append the field.
        # Match both `archived: true` and `archived:true` spacing, same as restore.
        updated, n = _re.subn(r"(?m)^(archived:\s*)false\s*$", r"\1true\n", raw_yml)
        if n == 0 and not _re.search(r"(?m)^archived:\s*true\s*$", raw_yml):
            # Field missing entirely — append it (default was false).
            if not updated.endswith("\n"):
                updated += "\n"
            updated += "archived: true\n"
        worker_yml_path.write_text(updated, encoding='utf-8')
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to update worker.yml: {exc}") from exc
    # Persist the archived flag to the DB manifest too. The API reads `archived`
    # from skill_versions.manifest_json (via repos.workers.get), NOT from disk —
    # writing worker.yml alone left the detail response, the Archived view, and
    # the Restore button stale (archived:false) for DB-tracked workers, because
    # invalidate_worker_cache() only clears the filesystem discovery cache.
    _set_db_manifest_archived(worker_id, archived=True, user_id=auth.user_id, repos=repos)
    invalidate_worker_cache()
    return _build_worker_detail(worker_id, user_id=auth.user_id, repos=repos)


@worker_admin_router.post("/workers/{worker_id}/suggest", response_model=_WorkerSuggestResponse)
async def suggest_worker_updates(
    worker_id: str,
    payload: _WorkerSuggestRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _WorkerSuggestResponse:
    """Compare a new description against the current worker config and surface conflicts.

    Makes a single focused OpenAI call. Returns structured suggestions so the UI
    can show a conflict-resolution modal before the user saves.
    """
    import json as _json
    import os as _os
    import llm as _llm
    from codegen_model import codegen_model as _codegen_model
    from worker_registry import WORKERS_DIR as _WORKERS_DIR

    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = _WORKERS_DIR / worker_id / "worker.yml"
    current_yml = worker_yml_path.read_text(encoding="utf-8") if worker_yml_path.exists() else (
        getattr(worker, "manifest_yaml", "") or ""
    )

    suggest_model = _os.environ.get("WORKEROS_SUGGEST_MODEL") or _codegen_model()
    if not _llm.provider_credentials_present(suggest_model):
        return _WorkerSuggestResponse(has_conflicts=False, suggestions=[])

    prompt = (
        "You are reviewing a Workeros worker configuration for consistency with a new description.\n\n"
        f"New description from user:\n{payload.new_description}\n\n"
        f"Current worker.yml:\n{current_yml}\n\n"
        "Identify ONLY real conflicts between the new description and the existing config.\n"
        "Focus on: trigger schedule/type, required inputs, connections, and secrets.\n"
        "Ignore stylistic or wording differences — only flag functional mismatches.\n"
        "If the description does not clearly imply a change, do NOT flag a conflict.\n\n"
        'Return JSON: {"has_conflicts": bool, "suggestions": [{"field": str, "current": str, "suggested": str, "reason": str}]}\n'
        'If no conflicts: {"has_conflicts": false, "suggestions": []}'
    )

    try:
        response = _llm.completion(
            model=suggest_model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=512,
        )
        raw = response.choices[0].message.content or "{}"
        result = _json.loads(raw)
        return _WorkerSuggestResponse(
            has_conflicts=bool(result.get("has_conflicts", False)),
            suggestions=[_WorkerSuggestion(**s) for s in result.get("suggestions", [])],
        )
    except Exception as exc:
        logger.warning("suggest_worker_updates LLM call failed: %s", exc)
        return _WorkerSuggestResponse(has_conflicts=False, suggestions=[])


@worker_admin_router.get("/workers/{worker_id}/sample-input")
def get_worker_sample_input(
    worker_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Any:
    """Return the sample input JSON for a worker.

    Resolution order (consistent for ALL workers, not just stock ones):
      1. A static docs/workers/inputs/<worker_id>.json file, if present (stock
         workers ship curated samples there).
      2. The worker's own ``example_input`` from its manifest (every generated /
         user worker has this — it's what the UI prefills with).
    Returns 404 only when the worker has no sample input from EITHER source, so
    an API consumer gets the same answer the UI shows instead of a spurious 404
    on generated workers (the manifest example_input was always available).
    """
    worker_id = _canonical_worker_id(worker_id)
    worker = _get_visible_worker(worker_id, user_id=auth.user_id, repos=repos)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    from worker_registry import WORKERS_DIR

    safe_id = worker_id.replace("..", "").replace("/", "").replace("\\", "")
    # Walk from WORKERS_DIR up one level to the repo root, then into docs/workers/inputs/
    sample_path = WORKERS_DIR.parent / "docs" / "workers" / "inputs" / f"{safe_id}.json"
    if sample_path.is_file():
        try:
            return json.loads(sample_path.read_text(encoding='utf-8'))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to parse sample input: {exc}") from exc

    # Fall back to the worker's manifest example_input (consistent with the UI,
    # which prefers example_input and only used this endpoint as a fallback).
    example_input = (worker.get("manifest") or {}).get("example_input")
    if example_input is None:
        example_input = worker.get("example_input")
    if example_input is not None:
        return example_input

    raise HTTPException(status_code=404, detail=f"No sample input found for worker {worker_id!r}")
