"""Public share projection: worker / brain-file / brain-pack / run -> public view.

The strict public view of a worker (no secrets, source, run history, owner id,
webhook url, or config internals), the signed-share-link resolver, the public
file-entry shaping for brain shares, and the standalone-share-payload dispatcher
that resolves a share token to its worker / brain-file / brain-pack / run card. Backs
the public worker, short-link, and standalone-share routes. Extracted verbatim
from main.py.

models / contexts names are imported lazily inside the functions (purged +
re-imported by fixtures); worker source helpers come from
services.worker_serialize, context helpers from services.context_access, and
share-row lookups from services.share_links. Never imports main.
"""

from __future__ import annotations

import hmac
import re
import urllib.parse
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List

from fastapi import HTTPException, Request

from core.config import PUBLIC_SHARE_TEXT_PREVIEW_LIMIT
from core.urls import _frontend_base_url
from services.context_access import (
    _assert_context_file_shareable,
    _assert_context_pack_shareable,
    _context_file_path_or_400,
    _context_name_or_400,
    _context_summary,
    _safe_context_file_or_400,
)
from services.share_links import (
    _load_short_link_public_worker,
    _load_standalone_share_row,
    _public_share_frontend_base_url,
)
from services.worker_serialize import (
    _read_worker_files,
    _worker_files_from_manifest,
    _worker_public_token,
)

if TYPE_CHECKING:
    from db import Repositories
    from models import PublicWorker, WorkerConfig


def _public_connection_labels(config: "WorkerConfig") -> List[str]:
    """Public, display-only tool/connection identifiers.

    Composio connections are plain app slugs (safe). MCP connections expose only
    their human LABEL — never the server url, env, command, args, or auth value,
    which can carry internal infrastructure detail or credentials.
    """
    labels: List[str] = []
    for connection in (config.connections or []):
        if isinstance(connection, str):
            slug = connection.strip()
            if slug:
                labels.append(slug)
        else:
            # WorkerConnection(mcp=WorkerMCPConnection(...)) — expose the human
            # label only, never the url/env/command/auth.
            mcp = getattr(connection, "mcp", None)
            label = (getattr(mcp, "label", "") or "").strip() if mcp else ""
            if label:
                labels.append(label)
    return labels


# Well-known secrets that imply a required service connection even when the
# worker declares the tool via a raw bot token rather than a Composio/MCP
# connection entry (e.g. a Slack template that ships `SLACK_BOT_TOKEN`). Kept
# deterministic and display-only — never exposes the secret value itself.
_SECRET_CONNECTION_HINTS: Dict[str, str] = {
    "SLACK_BOT_TOKEN": "slack",
    "SLACK_APP_TOKEN": "slack",
    "SLACK_USER_TOKEN": "slack",
    "SLACK_SIGNING_SECRET": "slack",
}


def _manifest_connection_labels(worker: Dict[str, Any]) -> List[str]:
    """Display-only connection slugs derived from a worker's stored manifest.

    Contract (schema 0.3) template bundles declare their required services under
    the manifest's top-level ``connections`` and ``capabilities.connections``,
    which is NOT always mirrored into the materialized ``config.connections`` the
    public projection reads. Recover those slugs so the share card + og-image
    show the real tools instead of "No tools". Never emits urls/env/auth.
    """
    manifest = worker.get("manifest") or worker.get("manifest_json") or {}
    if not isinstance(manifest, dict):
        return []
    labels: List[str] = []

    def _slug_from(entry: Any) -> str:
        if isinstance(entry, str):
            return entry.strip()
        if isinstance(entry, dict):
            mcp = entry.get("mcp")
            if isinstance(mcp, dict):
                label = mcp.get("label")
                if isinstance(label, str) and label.strip():
                    return label.strip()
            for key in ("app", "slug", "toolkit", "label", "name"):
                value = entry.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return ""

    sources: List[Any] = []
    top = manifest.get("connections")
    if isinstance(top, list):
        sources.extend(top)
    caps = manifest.get("capabilities")
    if isinstance(caps, dict):
        cap_conns = caps.get("connections")
        if isinstance(cap_conns, list):
            sources.extend(cap_conns)
    for entry in sources:
        slug = _slug_from(entry)
        if slug:
            labels.append(slug)
    return labels


def _secret_connection_labels(worker: Dict[str, Any], config: "WorkerConfig") -> List[str]:
    """Service slugs implied by well-known bot-token secrets (e.g. Slack)."""
    secret_names: List[str] = []
    for name in (getattr(config, "secrets", None) or []):
        if isinstance(name, str) and name.strip():
            secret_names.append(name.strip())
    manifest = worker.get("manifest") or worker.get("manifest_json") or {}
    if isinstance(manifest, dict):
        caps = manifest.get("capabilities")
        if isinstance(caps, dict):
            for name in (caps.get("secrets") or []):
                if isinstance(name, str) and name.strip():
                    secret_names.append(name.strip())
    labels: List[str] = []
    for name in secret_names:
        slug = _SECRET_CONNECTION_HINTS.get(name.upper())
        if slug:
            labels.append(slug)
    return labels


def _public_share_connection_labels(worker: Dict[str, Any], config: "WorkerConfig") -> List[str]:
    """All required connection slugs for the public share card + og image.

    Merges (in order) the materialized ``config.connections``, the stored
    manifest's contract ``connections`` / ``capabilities.connections``, and
    well-known secret hints (Slack bot token). De-duplicated, order-preserving.
    Display-only: never emits a url, env, command, auth, or secret value.
    """
    ordered: List[str] = []
    seen: set[str] = set()
    for label in (
        _public_connection_labels(config)
        + _manifest_connection_labels(worker)
        + _secret_connection_labels(worker, config)
    ):
        key = label.lower()
        if key not in seen:
            seen.add(key)
            ordered.append(label)
    return ordered


def _public_worker_response(worker: Dict[str, Any], config: "WorkerConfig") -> "PublicWorker":
    """Project a full worker dict + parsed config into the public allow-list.

    NOTHING outside the ``PublicWorker`` field set leaves this function: no
    secrets, no source files, no run history, no owner id, no webhook url, no
    config internals (bundle paths, MCP urls/env). Inputs and outputs are
    re-projected through ``PublicWorkerInput`` / ``PublicWorkerOutput`` so a
    future sensitive field on ``WorkerInput`` is not auto-forwarded.
    """
    from models import PublicWorker, PublicWorkerInput, PublicWorkerOutput

    return PublicWorker(
        id=str(worker.get("id") or config.id),
        name=str(worker.get("name") or config.name),
        description=worker.get("description"),
        long_description=worker.get("long_description"),
        use_cases=worker.get("use_cases"),
        how_it_works=worker.get("how_it_works"),
        is_example=worker.get("is_example"),
        tags=worker.get("tags") or [],
        example_input=worker.get("example_input"),
        example_output=worker.get("example_output"),
        trigger_type=str(worker.get("trigger_type") or "manual"),
        runtime=(config.runtime.type if config.runtime else None),
        connections=_public_share_connection_labels(worker, config),
        inputs=[
            PublicWorkerInput(
                name=inp.name,
                label=inp.label,
                type=inp.type,
                required=inp.required,
                description=inp.description,
                options=inp.options,
            )
            for inp in (config.inputs or [])
        ],
        outputs=[
            PublicWorkerOutput(name=out.name, label=out.label, type=out.type)
            for out in (config.outputs or [])
        ],
    )


def _load_public_worker(worker_id: str, token: str, repos: "Repositories") -> Dict[str, Any]:
    """Resolve + authenticate a worker for a signed public share link.

    Missing worker -> 404. Forged/missing token -> 401 (constant-time compare).
    Returns the full worker dict (owner-scoped projection happens in the route).
    """
    try:
        worker = repos.workers.get_any(worker_id=worker_id)
    except Exception:
        worker = None
    if worker is None:
        raise HTTPException(status_code=404, detail="Worker not found")
    expected = _worker_public_token(worker)
    if not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid worker link")
    return worker


def _public_share_actor(worker: Dict[str, Any], repos: "Repositories" | None) -> Dict[str, str] | None:
    if repos is None:
        return None
    owner_id = str(worker.get("owner_id") or "").strip()
    workspace_id = str(worker.get("workspace_id") or "local-default").strip() or "local-default"
    if not owner_id:
        return None
    actor = None
    try:
        actor = repos.members.get(workspace_id=workspace_id, user_id=owner_id)
    except Exception:
        actor = None
    if not actor:
        try:
            users = getattr(repos, "users", None)
            actor = users.get(user_id=owner_id) if users is not None else None
        except Exception:
            actor = None
    if not actor:
        return None
    display_name = str(actor.get("display_name") or "").strip()
    email = str(actor.get("email") or "").strip()
    username = str(actor.get("username") or "").strip()
    label = display_name or email or username
    if not label:
        return None
    out = {"label": label}
    if display_name:
        out["display_name"] = display_name
    if email or "@" in username:
        out["email"] = email or username
    return out


def _public_worker_share_from_worker(
    worker: Dict[str, Any],
    repos: "Repositories" | None = None,
    *,
    token: str | None = None,
) -> Dict[str, Any]:
    from models import WorkerConfig

    try:
        config = WorkerConfig(**(worker.get("config") or {}))
    except Exception:
        config = WorkerConfig(
            id=str(worker.get("id") or ""),
            name=str(worker.get("name") or ""),
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )
    public = _public_worker_response(worker, config).model_dump()
    # Read the actual source files so the share card can preview them and the
    # import endpoint can clone them without a separate DB/FS lookup.
    from worker_registry import WORKERS_DIR as _SHARE_WORKERS_DIR
    worker_dir = _SHARE_WORKERS_DIR / str(worker.get("id") or "")
    raw_files = _read_worker_files(worker_dir)
    if not raw_files:
        raw_files = _worker_files_from_manifest(worker)
    share_files = [
        {"path": f.path, "content": f.content or "", "binary": f.binary}
        for f in raw_files
        if not f.binary
    ]
    # Worker permalink-redirect target: /s/<token> for a worker is a legacy
    # surface now — the canonical URL is the /@handle/slug permalink. When the
    # workspace handle resolves, hand the frontend an absolute redirect target
    # (bare for a public worker, ?share=<token> for a non-public one so the
    # legacy link keeps granting the same access it always did). Absolute
    # (not relative) so a Next.js redirect() called from inside the
    # dashboard's /app-basePath'd deployment lands the browser at the bare
    # apex URL instead of staying parked under /app/.
    permalink_path = _worker_canonical_permalink_path(worker, repos)
    is_public = str(worker.get("visibility") or "private") == "public"
    permalink_redirect_url: str | None = None
    if permalink_path:
        permalink_redirect_url = f"{_public_share_frontend_base_url()}{permalink_path}"
        if not is_public and token:
            permalink_redirect_url = f"{permalink_redirect_url}?share={urllib.parse.quote(token, safe='')}"
    return {
        "entity_type": "worker",
        "title": public.get("name"),
        "description": public.get("description") or public.get("long_description"),
        "shared_by": _public_share_actor(worker, repos),
        "worker": public,
        "files": share_files,
        "permalink_path": permalink_path,
        "is_public": is_public,
        "permalink_redirect_url": permalink_redirect_url,
    }


_HANDLE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")


def _slugify_handle(value: Any) -> str:
    text = str(value or "").strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return slug[:64].strip("-")


def _workspace_profile_path(handle: str) -> str:
    return f"/@{handle}"


def _worker_share_path(worker: Dict[str, Any]) -> str | None:
    worker_id = str(worker.get("id") or "").strip()
    if not worker_id:
        return None
    try:
        token = _worker_public_token(worker)
    except Exception:
        return None
    return f"/w/{urllib.parse.quote(worker_id, safe='')}?token={urllib.parse.quote(token, safe='')}"


def _worker_public_slug_value(worker: Dict[str, Any]) -> str:
    """The worker's canonical permalink slug segment.

    Cloud stores ``public_slug`` as a real per-workspace-unique column
    (assigned at worker create, present regardless of visibility — L4
    backfill). OSS has no such column, so it's derived the same way
    ``get_public_by_slug``/``resolve_workspace_by_handle`` already derive it
    (from name, falling back to id) — kept in lockstep so a worker's
    permalink slug is stable and never depends on which repo backend answers.
    """
    stored = str(worker.get("public_slug") or "").strip()
    if stored:
        return _slugify_handle(stored)
    return _slugify_handle(worker.get("name") or worker.get("id"))


def _worker_workspace_handle(worker: Dict[str, Any], repos: "Repositories | None") -> str | None:
    """Resolve the stored workspace ``handle`` for a worker's workspace_id.

    Returns None (never raises) when the repo can't answer — callers treat a
    missing handle as "permalink unavailable" and fall back to whatever they
    were doing before (e.g. the legacy /w/ HMAC link), so an engine pin
    predating this capability degrades gracefully instead of 500ing.
    """
    if repos is None:
        return None
    workspace_id = str(worker.get("workspace_id") or "local-default").strip() or "local-default"
    getter = getattr(getattr(repos, "workers", None), "get_workspace_handle", None)
    if not callable(getter):
        return None
    try:
        handle = getter(workspace_id=workspace_id)
    except Exception:
        return None
    return str(handle).strip() if handle else None


def _worker_canonical_permalink_path(worker: Dict[str, Any], repos: "Repositories | None") -> str | None:
    """``/@{handle}/{public_slug}`` for a worker, or None if the handle can't
    be resolved (e.g. an older repo backend without the L4 handle column)."""
    handle = _worker_workspace_handle(worker, repos)
    if not handle:
        return None
    return f"/@{handle}/{_worker_public_slug_value(worker)}"


def _public_workspace_actor(workspace: Dict[str, Any], repos: "Repositories" | None) -> Dict[str, str] | None:
    if repos is None:
        return None
    owner_id = str(workspace.get("owner_user_id") or "").strip()
    workspace_id = str(workspace.get("id") or "local-default").strip() or "local-default"
    if not owner_id:
        return None
    actor = None
    try:
        members = getattr(repos, "members", None)
        actor = members.get(workspace_id=workspace_id, user_id=owner_id) if members is not None else None
    except Exception:
        actor = None
    if not actor:
        try:
            users = getattr(repos, "users", None)
            actor = users.get(user_id=owner_id) if users is not None else None
        except Exception:
            actor = None
    display_name = str((actor or {}).get("display_name") or "").strip()
    username = str((actor or {}).get("username") or "").strip()
    username_label = "" if "@" in username else username
    label = display_name or username_label or str(workspace.get("name") or "").strip()
    if not label:
        return None
    out = {"label": label}
    if display_name:
        out["display_name"] = display_name
    return out


def _list_local_workspace_rows() -> list[Dict[str, Any]]:
    from db import get_db

    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT id, owner_user_id, name, created_at, region, timezone
                FROM local_workspaces
                ORDER BY created_at, id
                """
            ).fetchall()
    except Exception:
        return []
    return [dict(row) for row in rows]


def _resolve_public_workspace_handle(handle: str, repos: "Repositories" | None = None) -> Dict[str, Any]:
    """Resolve a workspace by handle.

    Primary path (cloud + L4): the stored, unique ``handle`` column via
    ``repos.workers.resolve_workspace_by_handle`` — a workspace/worker rename
    never breaks a shared /@handle URL. Fallback (OSS single-tenant, or an
    engine pin predating the repo method): the legacy name-slug scan over
    ``local_workspaces``. Both normalize the handle the same way.
    """
    raw = str(handle or "").strip().lstrip("@").strip("/")
    slug = _slugify_handle(raw)
    if not slug or not _HANDLE_RE.fullmatch(slug):
        raise HTTPException(status_code=404, detail="Workspace profile not found")

    resolver = getattr(getattr(repos, "workers", None), "resolve_workspace_by_handle", None)
    if callable(resolver):
        row = resolver(handle=slug)
        if row:
            return {**row, "handle": str(row.get("handle") or slug)}
        # Fall through to the legacy scan only if the repo has no local rows to
        # offer (keeps OSS behavior when the stored column is unpopulated).

    workspaces = _list_local_workspace_rows()
    exact_id = [row for row in workspaces if str(row.get("id") or "").lower() == raw.lower()]
    if exact_id:
        row = exact_id[0]
        return {**row, "handle": _slugify_handle(row.get("name") or row.get("id")) or str(row.get("id") or "")}

    for row in workspaces:
        row_handle = _slugify_handle(row.get("name") or row.get("id"))
        if row_handle == slug:
            return {**row, "handle": row_handle}
    raise HTTPException(status_code=404, detail="Workspace profile not found")


def _public_worker_card_by_handle_slug(
    handle: str, worker_slug: str, repos: "Repositories", *, share_token: str | None = None
) -> Dict[str, Any]:
    """Resolve a worker permalink (/@{handle}/{worker_slug}[?share=<token>]).

    Resolves the workspace by stored handle, then the worker by its stored
    per-workspace ``public_slug``. Two access paths, tried in order:

    1. Public (default, matches historical behavior): ``get_public_by_slug``
       only ever returns a row when ``visibility == "public"``.
    2. Unguessable-key (new): if the worker isn't public but a ``share_token``
       was supplied, resolve the slug WITHOUT the visibility filter
       (``get_by_public_slug_any_visibility``) and require the token to
       resolve (via the standard ``fls_`` standalone-share-link table) to
       THIS worker's ``(entity_id, owner_id)`` with ``entity_type=="worker"``.

    A visibility flip never changes this URL: making a worker private again
    only removes path 1 (bare access 404s, identical to an unknown slug —
    existence is never confirmed either way); an already-issued share token
    keeps working via path 2 until it's explicitly revoked, because the two
    paths are backed by independent state (the ``visibility`` column vs the
    ``standalone_share_links`` table).

    Anything not found, not public, and not validly shared -> 404.
    """
    from models import WorkerConfig

    workspace = _resolve_public_workspace_handle(handle, repos)
    workspace_id = str(workspace.get("id") or "local-default")
    profile_handle = str(workspace.get("handle") or _slugify_handle(workspace.get("name") or workspace_id))

    normalized_slug = _slugify_handle(str(worker_slug or ""))
    getter = getattr(repos.workers, "get_public_by_slug", None)
    worker = getter(workspace_id=workspace_id, public_slug=normalized_slug) if callable(getter) else None
    access = "public"

    if not worker and share_token:
        any_getter = getattr(repos.workers, "get_by_public_slug_any_visibility", None)
        candidate = (
            any_getter(workspace_id=workspace_id, public_slug=normalized_slug)
            if callable(any_getter)
            else None
        )
        if candidate:
            row = _load_standalone_share_row(share_token, repos)
            if (
                row
                and str(row.get("entity_type") or "") == "worker"
                and str(row.get("entity_id") or "") == str(candidate.get("id") or "")
                and str(row.get("owner_id") or "") == str(candidate.get("owner_id") or "")
            ):
                worker = candidate
                access = "shared_link"

    if not worker:
        # Identical 404 whether the slug doesn't exist or exists but is
        # private with no/an invalid share token — never confirms existence.
        raise HTTPException(status_code=404, detail="Worker not found")

    try:
        config = WorkerConfig(**(worker.get("config") or {}))
    except Exception:
        config = WorkerConfig(
            id=str(worker.get("id") or ""),
            name=str(worker.get("name") or ""),
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )
    public = _public_worker_response(worker, config).model_dump()
    permalink = f"/@{profile_handle}/{normalized_slug}"
    return {
        "entity_type": "worker_permalink",
        "workspace": {
            "id": workspace_id,
            "name": str(workspace.get("name") or workspace_id),
            "handle": profile_handle,
            "profile_path": _workspace_profile_path(profile_handle),
        },
        "worker": public,
        "public_slug": normalized_slug,
        "permalink": permalink,
        "title": public.get("name"),
        "description": public.get("description") or public.get("long_description"),
        # Canonical permalink, not the legacy /w/<id>?token=<hmac> shape — this
        # card is only ever built for a worker we've already confirmed access
        # to (public or validly shared), so the bare permalink is correct here.
        "share_path": permalink,
        "access": access,
        "shared_by": _public_workspace_actor(workspace, repos),
    }


def _public_workspace_profile(handle: str, repos: "Repositories", *, limit: int = 50) -> Dict[str, Any]:
    from models import WorkerConfig

    workspace = _resolve_public_workspace_handle(handle, repos)
    workspace_id = str(workspace.get("id") or "local-default")
    workers = repos.workers.list_public_for_workspace(workspace_id=workspace_id, limit=limit)
    if not workers:
        raise HTTPException(status_code=404, detail="Workspace profile not found")
    assets: list[Dict[str, Any]] = []
    for worker in workers:
        try:
            config = WorkerConfig(**(worker.get("config") or {}))
        except Exception:
            config = WorkerConfig(
                id=str(worker.get("id") or ""),
                name=str(worker.get("name") or ""),
                trigger={"type": "manual"},
                runtime={"type": "python", "entrypoint": "run.py"},
            )
        public = _public_worker_response(worker, config).model_dump()
        assets.append(
            {
                "type": "worker",
                "id": public.get("id"),
                "title": public.get("name"),
                "description": public.get("description") or public.get("long_description"),
                # list_public_for_workspace only ever returns visibility='public'
                # rows, so the bare canonical permalink is always correct here
                # (no access-control implication — replaces the legacy /w/
                # HMAC link this card used to emit).
                "share_path": f"/@{workspace.get('handle') or _slugify_handle(workspace.get('name') or workspace_id)}/{_worker_public_slug_value(worker)}",
                "worker": public,
            }
        )
    profile_handle = str(workspace.get("handle") or _slugify_handle(workspace.get("name") or workspace_id))
    return {
        "entity_type": "workspace_profile",
        "workspace": {
            "id": workspace_id,
            "name": str(workspace.get("name") or workspace_id),
            "handle": profile_handle,
            "profile_path": _workspace_profile_path(profile_handle),
        },
        "title": str(workspace.get("name") or workspace_id),
        "description": "Public Floom workspace profile",
        "shared_by": _public_workspace_actor(workspace, repos),
        "counts": {
            "workers": len(assets),
            "assets": len(assets),
        },
        "assets": assets,
        "workers": [asset["worker"] for asset in assets],
    }


def _public_file_entry(name: str, root: Path, path: Path, token: str | None = None) -> Dict[str, Any]:
    from contexts import context_file_metadata, guess_mime_type, is_binary_file, load_context_metadata

    rel = path.relative_to(root).as_posix()
    meta = context_file_metadata(root, path, pack_metadata=load_context_metadata().get(name) or {})
    raw = path.read_bytes()
    mime_type = str(meta.get("mime_type") or guess_mime_type(rel))
    binary = bool(meta.get("is_binary")) or is_binary_file(rel, mime_type)
    content_text: str | None = None
    if not binary and len(raw) <= PUBLIC_SHARE_TEXT_PREVIEW_LIMIT:
        content_text = raw.decode("utf-8", errors="replace")
    entry = {
        "path": rel,
        "size": int(meta.get("size") or len(raw)),
        "mime_type": mime_type,
        "display_type": meta.get("display_type") or "File",
        "is_binary": binary,
        "updated_at": meta.get("updated_at"),
        "description": meta.get("description"),
        "tags": meta.get("tags") or [],
        "metadata": meta.get("metadata") or {},
        "content_text": content_text,
    }
    if token:
        entry["download_url"] = f"{_frontend_base_url()}/s/{urllib.parse.quote(token, safe='')}/download"
    return entry


def _public_brain_file_share(row: Dict[str, Any]) -> Dict[str, Any]:
    from contexts import context_dir, context_scope_for_user, load_context_metadata, use_context_scope

    owner_id = str(row.get("owner_id") or "")
    name = str(row.get("entity_id") or "")
    rel = str(row.get("file_path") or "")
    token = str(row.get("token") or "")
    with use_context_scope(context_scope_for_user(owner_id)):
        safe_name = _context_name_or_400(name)
        rel = _context_file_path_or_400(rel)
        target = _safe_context_file_or_400(safe_name, rel)
        _assert_context_file_shareable(rel, target)
        root = context_dir(safe_name)
        summary = _context_summary(safe_name, load_context_metadata(), user_id=owner_id)
        file_entry = _public_file_entry(safe_name, root, target, token)
    return {
        "entity_type": "brain_file",
        "title": Path(rel).name,
        "description": f"{safe_name} / {rel}",
        "pack": {
            "name": summary.name,
            "description": summary.description,
            "file_count": summary.file_count,
            "total_size_bytes": summary.total_size_bytes,
        },
        "file": file_entry,
        "files": [file_entry],
    }


def _public_brain_pack_share(row: Dict[str, Any]) -> Dict[str, Any]:
    from contexts import context_dir, context_scope_for_user, iter_context_files, load_context_metadata, use_context_scope

    owner_id = str(row.get("owner_id") or "")
    name = str(row.get("entity_id") or "")
    with use_context_scope(context_scope_for_user(owner_id)):
        safe_name = _context_name_or_400(name)
        _assert_context_pack_shareable(safe_name)
        root = context_dir(safe_name)
        if not root.is_dir():
            raise HTTPException(status_code=404, detail="Brain pack not found")
        metadata = load_context_metadata()
        summary = _context_summary(safe_name, metadata, user_id=owner_id)
        files = [
            _public_file_entry(safe_name, root, path)
            for path in sorted(iter_context_files(root), key=lambda p: p.relative_to(root).as_posix())
        ]
    preview_file = next((f for f in files if f.get("content_text")), files[0] if files else None)
    return {
        "entity_type": "brain_pack",
        "title": summary.name,
        "description": summary.description or f"{summary.file_count} files",
        "pack": {
            "name": summary.name,
            "description": summary.description,
            "file_count": summary.file_count,
            "total_size_bytes": summary.total_size_bytes,
            "updated_at": summary.updated_at,
        },
        "file": preview_file,
        "files": files,
    }


def _public_run_share(row: Dict[str, Any], repos: "Repositories") -> Dict[str, Any]:
    from auth import AuthContext
    from routers.runs import get_run

    run_id = str(row.get("entity_id") or "")
    owner_id = str(row.get("owner_id") or "")
    if not run_id or not owner_id:
        raise HTTPException(status_code=404, detail="Share link not found")
    owner_auth = AuthContext(user_id=owner_id, email=None, scopes=("run_share",))
    detail = get_run(run_id, auth=owner_auth, repos=repos).model_dump(mode="json")
    worker_name = str(detail.get("worker_name") or detail.get("worker_id") or "Worker")
    return {
        "entity_type": "run",
        "title": f"Run · {worker_name}",
        "description": f"{detail.get('status') or 'run'} run {run_id}",
        "run": detail,
        "files": [],
    }


def _standalone_share_payload(
    token: str,
    repos: "Repositories",
    *,
    request: Request | None = None,
) -> Dict[str, Any]:
    row = _load_standalone_share_row(token, repos)
    if row:
        entity_type = str(row.get("entity_type") or "")
        if entity_type == "worker":
            worker = repos.workers.get_any(worker_id=str(row.get("entity_id") or ""))
            if not worker or str(worker.get("owner_id") or "") != str(row.get("owner_id") or ""):
                raise HTTPException(status_code=404, detail="Share link not found")
            return _public_worker_share_from_worker(worker, repos, token=token)
        if entity_type == "brain_file":
            return _public_brain_file_share(row)
        if entity_type == "brain_pack":
            return _public_brain_pack_share(row)
        if entity_type == "run":
            return _public_run_share(row, repos)
        if entity_type == "approvals_batch":
            from routers.approvals import _public_approvals_batch_payload

            return _public_approvals_batch_payload(token, repos, request=request, share=row)
        raise HTTPException(status_code=404, detail="Share link not found")

    try:
        from routers.approvals import _load_approvals_batch_share, _public_approvals_batch_payload

        _load_approvals_batch_share(token, repos)
        return _public_approvals_batch_payload(token, repos, request=request)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        pass

    # Backward compatibility for worker short links created before the unified
    # share table existed.
    worker = _load_short_link_public_worker(token, repos)
    return _public_worker_share_from_worker(worker, repos)
