"""Worker bundle materialization helpers."""

from __future__ import annotations

import json
import logging
import shutil
import tempfile
from pathlib import Path

from worker_registry import WORKERS_DIR, invalidate_worker_cache

logger = logging.getLogger("floom.worker_materialization")


def _validated_materialization_target(worker_id: str, target_dir: Path | None) -> Path:
    if target_dir is None:
        target = WORKERS_DIR / worker_id
    else:
        target = Path(target_dir)

    resolved = target.resolve(strict=False)
    allowed_root = WORKERS_DIR.parent.resolve()
    try:
        resolved.relative_to(allowed_root)
    except ValueError as exc:
        raise ValueError(f"Path traversal attempt: {resolved}") from exc
    if resolved.name != worker_id:
        raise ValueError(
            f"refusing to materialize worker {worker_id!r} into {resolved}"
        )
    return resolved


def rematerialize_worker_from_db(worker_id: str, *, target_dir: Path | None = None) -> bool:
    """Write worker files from manifest_json._files back to disk.

    Returns True when at least one file is written. Returns False when the
    worker or stored file payload is absent. The write uses an atomic temp-dir
    rename so a failed hydration never leaves a partial worker bundle behind.
    """
    from db import get_db

    worker_dir = _validated_materialization_target(worker_id, target_dir)
    with get_db() as conn:
        row = conn.execute(
            "SELECT sv.manifest_json FROM skill_versions sv "
            "JOIN workers w ON w.skill_version_id = sv.id WHERE w.id = ?",
            (worker_id,),
        ).fetchone()
    if not row:
        return False

    manifest = json.loads(row["manifest_json"] or "{}")
    files = manifest.get("_files")
    if not isinstance(files, dict) or not files:
        return False

    worker_dir.parent.mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix=f".rmat.{worker_id}.", dir=str(worker_dir.parent)))
    written = 0
    try:
        resolved_tmp = tmp_dir.resolve()
        for rel_path, content in files.items():
            if not isinstance(rel_path, str) or not isinstance(content, str):
                continue
            dest = (tmp_dir / rel_path).resolve()
            try:
                dest.relative_to(resolved_tmp)
            except ValueError:
                logger.warning("Skipping path traversal in _files for worker %s: %s", worker_id, rel_path)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content, encoding="utf-8")
            written += 1

        if written == 0:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return False
        if worker_dir.exists():
            shutil.rmtree(worker_dir)
        tmp_dir.rename(worker_dir)
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise

    invalidate_worker_cache()
    logger.info("Re-materialized %d files for worker %s from DB", written, worker_id)
    return True
