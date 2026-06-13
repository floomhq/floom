"""Public worker projection: full worker dict -> PublicWorker allow-list.

The strict public view of a worker (no secrets, source, run history, owner id,
webhook url, or config internals), the signed-share-link resolver, and the
share-card payload that bundles the public projection with previewable source
files. Backs the public worker, short-link, and share routes. Extracted
verbatim from main.py.

models are imported lazily inside the constructing functions (purged +
re-imported by fixtures); worker source/token helpers come from
services.worker_serialize. Never imports main.
"""

from __future__ import annotations

import hmac
from typing import TYPE_CHECKING, Any, Dict, List

from fastapi import HTTPException

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
