"""Public share projection: worker / brain-file / brain-pack -> public view.

The strict public view of a worker (no secrets, source, run history, owner id,
webhook url, or config internals), the signed-share-link resolver, the public
file-entry shaping for brain shares, and the standalone-share-payload dispatcher
that resolves a share token to its worker / brain-file / brain-pack card. Backs
the public worker, short-link, and standalone-share routes. Extracted verbatim
from main.py.

models / contexts names are imported lazily inside the functions (purged +
re-imported by fixtures); worker source helpers come from
services.worker_serialize, context helpers from services.context_access, and
share-row lookups from services.share_links. Never imports main.
"""

from __future__ import annotations

import hmac
import urllib.parse
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List

from fastapi import HTTPException

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
)
from services.worker_serialize import _read_worker_files, _worker_public_token

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
        connections=_public_connection_labels(config),
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


def _public_worker_share_from_worker(worker: Dict[str, Any]) -> Dict[str, Any]:
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
    share_files = [
        {"path": f.path, "content": f.content or "", "binary": f.binary}
        for f in raw_files
        if not f.binary
    ]
    return {
        "entity_type": "worker",
        "title": public.get("name"),
        "description": public.get("description") or public.get("long_description"),
        "worker": public,
        "files": share_files,
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


def _standalone_share_payload(token: str, repos: "Repositories") -> Dict[str, Any]:
    row = _load_standalone_share_row(token)
    if row:
        entity_type = str(row.get("entity_type") or "")
        if entity_type == "worker":
            worker = repos.workers.get_any(worker_id=str(row.get("entity_id") or ""))
            if not worker or str(worker.get("owner_id") or "") != str(row.get("owner_id") or ""):
                raise HTTPException(status_code=404, detail="Share link not found")
            return _public_worker_share_from_worker(worker)
        if entity_type == "brain_file":
            return _public_brain_file_share(row)
        if entity_type == "brain_pack":
            return _public_brain_pack_share(row)
        raise HTTPException(status_code=404, detail="Share link not found")

    # Backward compatibility for worker short links created before the unified
    # share table existed.
    worker = _load_short_link_public_worker(token, repos)
    return _public_worker_share_from_worker(worker)
