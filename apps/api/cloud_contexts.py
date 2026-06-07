"""Cloud context storage — Supabase Storage backend for brain packs.

Contexts are markdown/binary files that the engine reads from CONTEXTS_DIR on
disk. In cloud, containers are ephemeral — disk is lost on restart. This module
backs contexts with Supabase Storage (S3-compatible object store) so they
survive container lifecycle.

Architecture:
  Write: engine writes to disk (as normal) → cloud_git.schedule_push uploads
         to Storage + pushes to GitHub in background
  Read:  context_dir() is patched in startup.py to call hydrate_if_missing()
         before returning the path — if the dir is absent (fresh container),
         files are downloaded from Storage first. Falls back to GitHub if
         Storage is empty (first install / disaster recovery).

Storage path layout:
  bucket "contexts" / {workspace_id} / {context_name} / {relative_file_path}

The disk path mirrors this:
  CONTEXTS_DIR / {workspace_id} / {context_name} / {relative_file_path}
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_BUCKET = "contexts"


# ---------------------------------------------------------------------------
# Bucket bootstrap (called once at startup)
# ---------------------------------------------------------------------------

def ensure_bucket() -> None:
    """Create the contexts Storage bucket if it doesn't exist."""
    from apps.api.config import get_supabase_service_client
    svc = get_supabase_service_client()
    try:
        svc.storage.create_bucket(
            _BUCKET,
            options={"public": False, "file_size_limit": "50mb"},
        )
        logger.info("Created Supabase Storage bucket '%s'", _BUCKET)
    except Exception as exc:
        if "already exists" in str(exc).lower() or "duplicate" in str(exc).lower():
            pass  # Already exists — fine
        else:
            logger.warning("Could not create Storage bucket '%s': %s", _BUCKET, exc)


# ---------------------------------------------------------------------------
# Upload helpers
# ---------------------------------------------------------------------------

def upload_file(
    workspace_id: str,
    context_name: str,
    rel_path: str,
    content: bytes,
) -> None:
    """Upload a single context file to Supabase Storage."""
    from apps.api.config import get_supabase_service_client
    svc = get_supabase_service_client()
    storage_path = f"{workspace_id}/{context_name}/{rel_path}"
    mime = _guess_mime(rel_path)
    try:
        svc.storage.from_(_BUCKET).upload(
            path=storage_path,
            file=content,
            file_options={"upsert": "true", "content-type": mime},
        )
    except Exception as exc:
        logger.debug("upload_file %s failed: %s", storage_path, exc)
        raise


def upload_context(workspace_id: str, context_name: str, context_dir: Path) -> None:
    """Upload all files in a context directory to Supabase Storage.

    Called after every context file write so Storage is always in sync with disk.
    Runs from a background thread — errors are non-fatal.
    """
    if not context_dir.is_dir():
        return
    for fpath in context_dir.rglob("*"):
        if not fpath.is_file():
            continue
        rel = fpath.relative_to(context_dir).as_posix()
        try:
            upload_file(workspace_id, context_name, rel, fpath.read_bytes())
        except Exception as exc:
            logger.debug("upload_context: skipped %s/%s: %s", context_name, rel, exc)


def upload_context_background(
    workspace_id: str,
    context_name: str,
    context_dir: Path,
) -> None:
    """Non-blocking wrapper around upload_context — fires a daemon thread."""
    import threading
    threading.Thread(
        target=_safe_upload_context,
        args=(workspace_id, context_name, context_dir),
        daemon=True,
        name="workeros-ctx-upload",
    ).start()


def _safe_upload_context(workspace_id: str, context_name: str, context_dir: Path) -> None:
    try:
        upload_context(workspace_id, context_name, context_dir)
    except Exception as exc:
        logger.debug("_safe_upload_context failed: %s", exc)


# ---------------------------------------------------------------------------
# Download / hydration helpers
# ---------------------------------------------------------------------------

def download_context(
    workspace_id: str,
    context_name: str,
    dest_dir: Path,
) -> int:
    """Download all files for a context from Storage to dest_dir.

    Returns the number of files written. dest_dir is created if needed.
    """
    from apps.api.config import get_supabase_service_client
    svc = get_supabase_service_client()
    prefix = f"{workspace_id}/{context_name}"

    try:
        objects = svc.storage.from_(_BUCKET).list(prefix)
    except Exception as exc:
        logger.debug("download_context: list %s failed: %s", prefix, exc)
        return 0

    if not objects:
        return 0

    dest_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for obj in objects:
        name = obj.get("name") if isinstance(obj, dict) else getattr(obj, "name", None)
        if not name or name.startswith("."):
            continue
        storage_path = f"{prefix}/{name}"
        try:
            content = svc.storage.from_(_BUCKET).download(storage_path)
            fpath = dest_dir / name
            fpath.parent.mkdir(parents=True, exist_ok=True)
            fpath.write_bytes(content)
            written += 1
        except Exception as exc:
            logger.debug("download_context: skipped %s: %s", name, exc)

    return written


def list_context_names(workspace_id: str) -> list[str]:
    """Return the names of all contexts stored for a workspace."""
    from apps.api.config import get_supabase_service_client
    svc = get_supabase_service_client()
    try:
        objects = svc.storage.from_(_BUCKET).list(workspace_id)
        return [
            obj.get("name") if isinstance(obj, dict) else getattr(obj, "name", "")
            for obj in (objects or [])
            if (obj.get("name") if isinstance(obj, dict) else getattr(obj, "name", ""))
        ]
    except Exception as exc:
        logger.debug("list_context_names failed for %s: %s", workspace_id, exc)
        return []


def hydrate_if_missing(workspace_id: str, context_name: str, dest_dir: Path) -> bool:
    """Download context from Storage if dest_dir doesn't exist or is empty.

    Returns True if files were written. Falls back to GitHub if Storage is empty.
    """
    if dest_dir.is_dir() and any(dest_dir.iterdir()):
        return False  # Already on disk

    written = download_context(workspace_id, context_name, dest_dir)
    if written > 0:
        logger.info(
            "Hydrated context '%s' (%d files) from Supabase Storage",
            context_name, written,
        )
        return True

    # Storage empty — try GitHub
    return _hydrate_from_github(workspace_id, context_name, dest_dir)


def _hydrate_from_github(
    workspace_id: str,
    context_name: str,
    dest_dir: Path,
) -> bool:
    """Fetch context files from the linked GitHub repo as last-resort fallback."""
    try:
        from apps.api.cloud_git import get_git_cfg
        import github_api

        cfg = get_git_cfg(workspace_id)
        if not cfg or not cfg.get("github_pat") or not cfg.get("repo_full_name"):
            return False

        pat = cfg["github_pat"]
        repo = cfg["repo_full_name"]
        tree = github_api.list_repo_tree(pat, repo)
        prefix = f"contexts/{context_name}/"
        files = [e for e in tree if e.get("type") == "blob" and e.get("path", "").startswith(prefix)]
        if not files:
            return False

        dest_dir.mkdir(parents=True, exist_ok=True)
        for entry in files:
            rel = entry["path"][len(prefix):]
            content = github_api.get_file_content(pat, repo, entry["path"])
            if content is not None:
                fpath = dest_dir / rel
                fpath.parent.mkdir(parents=True, exist_ok=True)
                fpath.write_text(content, encoding="utf-8")
                # Also upload to Storage so next restart doesn't need GitHub
                try:
                    upload_file(workspace_id, context_name, rel, content.encode("utf-8"))
                except Exception:
                    pass

        count = sum(1 for _ in dest_dir.rglob("*") if _.is_file())
        if count:
            logger.info(
                "Hydrated context '%s' (%d files) from GitHub (Storage was empty)",
                context_name, count,
            )
            return True
    except Exception as exc:
        logger.debug("_hydrate_from_github for %s/%s failed: %s", workspace_id, context_name, exc)
    return False


# ---------------------------------------------------------------------------
# Deletion
# ---------------------------------------------------------------------------

def delete_context_from_storage(workspace_id: str, context_name: str) -> None:
    """Remove all Storage objects for a context (called on context delete)."""
    from apps.api.config import get_supabase_service_client
    svc = get_supabase_service_client()
    prefix = f"{workspace_id}/{context_name}"
    try:
        objects = svc.storage.from_(_BUCKET).list(prefix) or []
        paths = [
            f"{prefix}/{obj.get('name') if isinstance(obj, dict) else obj.name}"
            for obj in objects
            if (obj.get("name") if isinstance(obj, dict) else getattr(obj, "name", ""))
        ]
        if paths:
            svc.storage.from_(_BUCKET).remove(paths)
    except Exception as exc:
        logger.debug("delete_context_from_storage %s/%s failed: %s", workspace_id, context_name, exc)


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _guess_mime(filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return {
        "md": "text/markdown",
        "txt": "text/plain",
        "json": "application/json",
        "yaml": "application/yaml",
        "yml": "application/yaml",
        "pdf": "application/pdf",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
    }.get(ext, "application/octet-stream")
