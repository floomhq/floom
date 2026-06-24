"""Cloud worker-bundle storage — Supabase Storage backend for worker code.

A worker's source bundle (``run.py``, ``worker.yml``, ``SKILL.md``, ``lib/*`` …)
was historically inlined into ``skill_versions.manifest_json`` under the
``_files`` key. That made the metadata column multi-MB for code-heavy workers, so
listing workers downloaded ~18 MB of bundle bytes the grid never displays
(``select("*")`` on skill_versions). This module moves the bundle out of the
metadata row and into Supabase Storage (S3-compatible object store), exactly like
``cloud_contexts`` does for brain packs.

Layout: bucket ``worker-bundles`` / ``{skill_version_id}`` / ``files.json`` — a
single JSON object holding the ``{relpath: text}`` files dict. One PUT on write,
one GET on run; no per-file N+1. ``skill_version_id`` is globally unique (the
skill_versions primary key), so no workspace component is needed in the path; the
bucket is private and only the service-role key (which bypasses RLS) can read it,
matching the "backend is the only data path" invariant.

The manifest keeps a ``_files_in_storage: true`` marker so the run path knows to
fetch from Storage, plus ``runtime.bundle_sha256`` so the engine warm-pool key
stays stable without the inline bundle.
"""
from __future__ import annotations

import json
from typing import Any

from apps.api.obs import get_logger

logger = get_logger(__name__)

_BUCKET = "worker-bundles"
_OBJECT = "files.json"


def ensure_bucket() -> None:
    """Create the worker-bundles Storage bucket if it doesn't exist (idempotent)."""
    from apps.api.config import get_supabase_service_client

    svc = get_supabase_service_client()
    try:
        svc.storage.create_bucket(
            _BUCKET,
            options={"public": False, "file_size_limit": "50mb"},
        )
        logger.info("Created Supabase Storage bucket '%s'", _BUCKET)
    except Exception as exc:  # noqa: BLE001
        if "already exists" in str(exc).lower() or "duplicate" in str(exc).lower():
            return  # Already exists — fine
        logger.warning("Could not create Storage bucket '%s': %s", _BUCKET, exc)


def _path(skill_version_id: str) -> str:
    return f"{skill_version_id}/{_OBJECT}"


def upload_bundle(skill_version_id: str, files: dict[str, str]) -> bool:
    """Upload a worker's files dict to Storage as one JSON object.

    Returns True on success. Raises on hard failure so the caller can decide to
    fall back to inline storage (never silently drop the bundle).
    """
    from apps.api.config import get_supabase_service_client

    svc = get_supabase_service_client()
    payload = json.dumps(files, separators=(",", ":")).encode("utf-8")
    svc.storage.from_(_BUCKET).upload(
        path=_path(skill_version_id),
        file=payload,
        file_options={"upsert": "true", "content-type": "application/json"},
    )
    return True


def load_bundle(skill_version_id: str) -> dict[str, str] | None:
    """Download a worker's files dict from Storage. Returns None if absent/unreadable."""
    from apps.api.config import get_supabase_service_client

    svc = get_supabase_service_client()
    try:
        raw = svc.storage.from_(_BUCKET).download(_path(skill_version_id))
    except Exception:  # noqa: BLE001
        logger.warning(
            "load_bundle: download failed for skill_version %s "
            "(worker files unavailable from Storage for this resolve)",
            skill_version_id,
            exc_info=True,
        )
        return None
    try:
        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        logger.warning("load_bundle: bad JSON for skill_version %s", skill_version_id, exc_info=True)
        return None
    if not isinstance(data, dict):
        return None
    return {str(k): v for k, v in data.items() if isinstance(v, str)}


def delete_bundle(skill_version_id: str) -> None:
    """Remove a worker's bundle object from Storage (best-effort)."""
    from apps.api.config import get_supabase_service_client

    svc = get_supabase_service_client()
    try:
        svc.storage.from_(_BUCKET).remove([_path(skill_version_id)])
    except Exception:  # noqa: BLE001
        logger.debug("delete_bundle: remove failed for %s", skill_version_id, exc_info=True)
