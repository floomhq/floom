"""Worker creation routes: POST /workers and POST /workers/from-bundle.

The two non-codegen worker-create entrypoints: create from an inline
worker.yml/run.py/skill.md payload, and create from an uploaded bundle zip.
Extracted verbatim from main.py. (The prompt-to-worker draft routes stay in main
until the run-engine smoke-gate helpers they depend on are extracted.)

Orchestration logic is in services.worker_create; supporting helpers from the
sibling worker services. worker_registry + db.get_db are lazy in the bundle
handler. Purged in lockstep with main.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile

from auth import AuthContext, get_auth_context
from core.config import PROTECTED_STOCK_WORKER_IDS
from db import Repositories, get_repos
from models import WorkerCreateRequest, WorkerDetail
from services.worker_access import _canonical_worker_id, _slugify_worker_id
from services.worker_create import (
    _create_worker_from_parsed_payload,
    _reject_raw_local_runner_on_create,
)
from services.worker_mutation import (
    _raw_worker_id_from_worker_yml,
    _require_worker_write_workspace_context,
    _set_worker_yml_is_example,
)
from services.worker_registry_ops import (
    _embed_files_in_skill_version,
    _free_worker_id,
    _parse_worker_payload,
    _persist_discovered_workers,
    _rewrite_worker_yml_id,
)
from services.worker_serialize import _DEFAULT_RUN_PY_STUB, _build_worker_detail, _is_secret_bearing_export_path

import logging

logger = logging.getLogger("floom.api")

worker_create_router = APIRouter()


def _apply_workspace_approval_default(worker_yml: str) -> str:
    """#794: at CREATE time, if the workspace `approval_default` is "always" and
    the manifest has no explicit `approvals` block, stamp approvals.required so
    the persisted worker.yml (the source of truth) carries the default. An
    explicit `approvals:` in the manifest is left untouched."""
    try:
        import yaml as _pyyaml
        from run_service import _workspace_setting

        if (_workspace_setting("approval_default") or "").strip().lower() != "always":
            return worker_yml
        raw = _pyyaml.safe_load(worker_yml)
        if not isinstance(raw, dict) or "approvals" in raw:
            return worker_yml
        raw["approvals"] = {"required": True}
        return _pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False, allow_unicode=True)
    except Exception:
        logger.debug("approval_default yaml injection failed", exc_info=True)
        return worker_yml


@worker_create_router.post("/workers", response_model=WorkerDetail)
def create_worker(
    payload: WorkerCreateRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Create a new worker from YAML + Python source."""
    _require_worker_write_workspace_context(request)

    worker_yml = payload.worker_yml
    raw_worker_id = _raw_worker_id_from_worker_yml(worker_yml)
    if raw_worker_id in PROTECTED_STOCK_WORKER_IDS:
        worker_id = _free_worker_id(f"{_slugify_worker_id(raw_worker_id)}-copy", repos=repos)
        worker_yml = _set_worker_yml_is_example(
            _rewrite_worker_yml_id(worker_yml, worker_id),
            False,
        )
    else:
        worker_id = _canonical_worker_id(raw_worker_id)
        if worker_id != raw_worker_id:
            worker_yml = _rewrite_worker_yml_id(worker_yml, worker_id)
    _reject_raw_local_runner_on_create(worker_yml)
    worker_yml = _apply_workspace_approval_default(worker_yml)  # #794
    worker_id, config = _parse_worker_payload(worker_yml, user_id=auth.user_id)
    return _create_worker_from_parsed_payload(
        worker_id=worker_id,
        worker_yml=worker_yml,
        payload=payload,
        config=config,
        auth=auth,
        repos=repos,
    )


@worker_create_router.post("/workers/from-bundle", response_model=WorkerDetail)
async def create_worker_from_bundle(
    bundle: UploadFile = File(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> WorkerDetail:
    """Create a new worker from an uploaded zip bundle.

    The zip must contain ``worker.yml`` at the root or inside exactly one
    top-level directory. It must include at least one of: SKILL.md, run.py.
    Returns 400 if the structure is invalid, 409 if the worker_id already
    exists.
    """
    from worker_registry import discover_workers, invalidate_worker_cache
    from db import get_db

    import zipfile
    import io
    from worker_registry import WORKERS_DIR

    raw_bytes = await bundle.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail=f"Not a valid zip file: {exc}")

    # Zip-bomb guards: cap total uncompressed size and entry count BEFORE
    # extracting so a tiny zip cannot exhaust memory/disk. ZipInfo.file_size
    # is the declared uncompressed size; we pre-check the sum, then re-guard
    # the running total during extraction in case a header lies.
    _MAX_BUNDLE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024  # 50 MB
    _MAX_BUNDLE_ENTRIES = 2000

    infolist = zf.infolist()
    if len(infolist) > _MAX_BUNDLE_ENTRIES:
        raise HTTPException(
            status_code=413,
            detail=f"Bundle has too many entries ({len(infolist)} > {_MAX_BUNDLE_ENTRIES})",
        )
    declared_total = 0
    for info in infolist:
        file_type = (info.external_attr >> 16) & 0o170000
        if file_type == 0o120000:
            raise HTTPException(status_code=400, detail=f"Bundle contains unsupported symlink: {info.filename!r}")
        declared_total += info.file_size
        if declared_total > _MAX_BUNDLE_UNCOMPRESSED_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Bundle too large: uncompressed size exceeds "
                    f"{_MAX_BUNDLE_UNCOMPRESSED_BYTES // (1024 * 1024)} MB"
                ),
            )

    names = zf.namelist()

    # Determine bundle prefix: support flat root or single top-level dir.
    # worker.yml can be at "worker.yml" or "<dir>/worker.yml"
    prefix = ""
    if "worker.yml" not in names:
        # Try single-dir layout: all paths share the same top-level dir
        top_dirs = {n.split("/")[0] for n in names if "/" in n}
        if len(top_dirs) == 1:
            candidate = f"{next(iter(top_dirs))}/worker.yml"
            if candidate in names:
                prefix = next(iter(top_dirs)) + "/"
    if not prefix and "worker.yml" not in names:
        raise HTTPException(
            status_code=400,
            detail="Bundle must contain worker.yml at root or inside a single top-level directory",
        )

    worker_yml_path_in_zip = f"{prefix}worker.yml"
    worker_yml = zf.read(worker_yml_path_in_zip).decode("utf-8")

    worker_id, config = _parse_worker_payload(worker_yml, user_id=auth.user_id)

    target_dir = WORKERS_DIR / worker_id
    if target_dir.exists():
        raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")

    # Extract all files under the prefix into target_dir
    try:
        target_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists") from exc
    try:
        extracted_total = 0
        for zip_name in names:
            if not zip_name.startswith(prefix):
                continue
            rel = zip_name[len(prefix):]
            if not rel or rel.endswith("/"):
                continue  # skip directories
            # Guard against path traversal
            parts = rel.split("/")
            if any(p in ("", "..") for p in parts):
                raise HTTPException(status_code=400, detail=f"Invalid path in bundle: {rel!r}")
            # #932: strip secret-bearing files (.env, credentials.json, *.key, ...)
            # — export filters them out, so import must too, or a crafted bundle
            # can plant secrets that later leak via worker detail/share endpoints
            # or get committed to the workspace git repo.
            if _is_secret_bearing_export_path(rel):
                logger.info("from-bundle: stripped secret-bearing file %r", rel)
                continue
            data = zf.read(zip_name)
            # Re-guard the running total in case a ZipInfo header under-reported
            # the real uncompressed size (defends against a lying header).
            extracted_total += len(data)
            if extracted_total > _MAX_BUNDLE_UNCOMPRESSED_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"Bundle too large: uncompressed size exceeds "
                        f"{_MAX_BUNDLE_UNCOMPRESSED_BYTES // (1024 * 1024)} MB"
                    ),
                )
            dest = target_dir
            for part in parts[:-1]:
                dest = dest / part
                dest.mkdir(exist_ok=True)
            (dest / parts[-1]).write_bytes(data)
    except HTTPException:
        import shutil
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    except Exception as exc:
        import shutil
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"Failed to extract bundle: {exc}") from exc

    # Ensure run.py exists (stub if absent)
    run_py_path = target_dir / "run.py"
    if not run_py_path.exists():
        run_py_path.write_text(_DEFAULT_RUN_PY_STUB, encoding='utf-8')

    # Ensure requirements.txt exists
    req_path = target_dir / "requirements.txt"
    if not req_path.exists():
        req_path.write_text("", encoding='utf-8')

    # Register
    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers, user_id=auth.user_id)
        except RuntimeError as exc:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            invalidate_worker_cache()
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    try:
        _embed_files_in_skill_version(worker_id, target_dir)
    except Exception:
        logger.warning("Failed to embed files in DB for worker %s", worker_id, exc_info=True)

    # #1387: eagerly materialise the per-worker memory context (same as the
    # standard create path). Non-fatal if setup fails.
    if getattr(getattr(config, "memory", None), "enabled", False):
        try:
            from runner_sandbox.memory_context import ensure_memory_context_pack
            ensure_memory_context_pack(
                config=config,
                user_id=auth.user_id,
                log_fn=lambda msg, level="info": logger.debug(msg),
            )
        except Exception:
            logger.warning("Memory context setup failed for worker %s (from-bundle)", worker_id, exc_info=True)

    return _build_worker_detail(
        worker_id,
        user_id=auth.user_id,
        repos=repos,
    )
