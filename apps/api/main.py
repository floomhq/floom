"""Floom API — FastAPI backend for the OS for Background Workers."""

import os
import json
import sqlite3
import logging
import mimetypes
import hashlib
import hmac
import base64
import fcntl
import re
import time
import collections
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from db import init_db, get_db, now_iso, DB_PATH
from models import (
    ApproveRequest,
    RunCreate,
    RejectRequest,
    PaginationParams,
    WorkerSummary,
    WorkerDetail,
    RunSummary,
    RunDetail,
    LogEntry,
    Artifact,
    ApprovalDetail,
    OutputField,
    SecretItem,
    ReloadResponse,
    ActionResponse,
    WorkerStateResponse,
    RunStatus,
    ApprovalStatus,
    SecretStatus,
    WorkerStatus,
    WorkerConfig,
)
from worker_registry import (
    discover_workers,
    get_worker,
    get_worker_config,
    get_worker_contract,
    invalidate_worker_cache,
)
from run_service import create_run, get_worker_config_for_run, start_run, update_run_status, add_log
from run_service import get_secrets_for_worker

load_dotenv()
api_env_path = Path("/root/.config/workeros/api.env")
if api_env_path.is_file():
    load_dotenv(api_env_path, override=False)
init_db()

# ---------------------------------------------------------------------------
# App & middleware
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan: startup + shutdown hooks."""
    # Startup
    reload_workers()
    from scheduler import start_scheduler
    start_scheduler()
    yield
    # Shutdown
    from scheduler import stop_scheduler
    stop_scheduler()


app = FastAPI(
    title="Floom API",
    version="0.1.0",
    description="The OS for Background Workers",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3011", "https://workers.floom.dev"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Require x-floom-secret on all write (non-GET, non-OPTIONS) requests.

    Skipped when FLOOM_SECRET env var is not configured (localhost dev).
    The connections/callback GET is also exempt (OAuth redirect landing).
    Incoming webhooks (/webhooks/<worker_id>) and Composio events are exempt —
    they use their own HMAC signature verification instead.
    """
    secret = os.environ.get("FLOOM_SECRET", "")
    if secret and request.method not in ("GET", "HEAD", "OPTIONS"):
        # Exempt incoming webhook calls from the internal secret
        if request.url.path.startswith("/webhooks/") or request.url.path == "/composio-events":
            return await call_next(request)
        header = request.headers.get("x-floom-secret", "")
        if header != secret:
            from fastapi.responses import JSONResponse as _JSONResponse
            return _JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)

logger = logging.getLogger("floom.api")

# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.exception_handler(ValueError)
async def value_error_handler(_request, exc: ValueError):
    logger.warning("Validation error: %s", exc)
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(Exception)
async def generic_error_handler(_request, exc: Exception):
    logger.exception("Unhandled exception")
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def _get_paused_workers() -> set:
    """Return set of worker_ids that are currently paused."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT worker_id FROM worker_state WHERE paused = 1")
        return {r["worker_id"] for r in cursor.fetchall()}


def _get_last_run_for_worker(worker_id: str) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, worker_id, 'manual' as trigger_source, status,
                   created_at, started_at, completed_at, duration_ms,
                   COALESCE(approval_status, 'not_required') as approval_status
            FROM runs WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1
            """,
            (worker_id,),
        )
        row = cursor.fetchone()
    return row_to_dict(row) if row else None


def _make_run_summary(row: sqlite3.Row) -> RunSummary:
    d = row_to_dict(row)
    return RunSummary(
        id=d["id"],
        worker_id=d["worker_id"],
        worker_name=d.get("worker_name"),
        status=RunStatus(d["status"]),
        trigger_source=d["trigger_source"],
        approval_status=ApprovalStatus(d.get("approval_status", "not_required")),
        created_at=d.get("created_at"),
        started_at=d.get("started_at"),
        completed_at=d.get("completed_at"),
        duration_ms=d.get("duration_ms"),
        error=d.get("error"),
    )


def _read_transcript_rows(run_runner: str, artifacts: List[Artifact]) -> List[Dict[str, Any]]:
    if not (run_runner or "").startswith("skill"):
        return []
    transcript = next((artifact for artifact in artifacts if artifact.name == "transcript.jsonl"), None)
    if not transcript:
        return []

    from runner_local import ARTIFACTS_DIR

    try:
        artifacts_dir = ARTIFACTS_DIR.resolve()
        path = Path(transcript.path).resolve()
        path.relative_to(artifacts_dir)
    except Exception:
        return []
    if not path.is_file() or path.stat().st_size > 2_000_000:
        return []

    rows: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            parsed = {"type": "parse_error", "content": line}
        if isinstance(parsed, dict):
            rows.append(parsed)
    return rows


def _skill_version_id(worker_id: str, manifest: Dict[str, Any]) -> str:
    version = str(manifest.get("version") or "0.1.0")
    safe_version = version.replace(".", "_").replace("-", "_")
    return f"sv_{worker_id}_{safe_version}"


def _composio_webhook_url() -> str:
    base = (
        os.environ.get("COMPOSIO_WEBHOOK_URL")
        or os.environ.get("WORKERS_API_URL")
        or os.environ.get("FLOOM_API_BASE")
        or "https://workers-api.floom.dev"
    )
    base = base.rstrip("/")
    if base.endswith("/composio-events"):
        return base
    return f"{base}/composio-events"


def _composio_trigger_signature(config: Optional[WorkerConfig]) -> Optional[Dict[str, Any]]:
    if not config or config.trigger.type != "composio" or not config.trigger.composio:
        return None
    composio = config.trigger.composio
    return {
        "event": composio.event,
        "connection_id": composio.connection_id,
        "filters": composio.filters or {},
    }


def _config_from_manifest_for_worker(raw: Dict[str, Any], worker_id: str) -> Optional[WorkerConfig]:
    try:
        from models import WorkerContract, parse_worker_manifest, worker_contract_to_worker_config
        parsed = parse_worker_manifest(raw)
        if isinstance(parsed, WorkerContract):
            return worker_contract_to_worker_config(parsed, worker_id)
        return parsed
    except Exception:
        logger.exception("Failed to parse worker manifest for composio lifecycle: %s", worker_id)
        return None


def _existing_composio_state(conn: sqlite3.Connection, worker_id: str) -> Dict[str, Any]:
    try:
        row = conn.execute(
            """
            SELECT w.composio_trigger_id, w.composio_event, sv.manifest_json
            FROM workers w
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE w.id = ?
            """,
            (worker_id,),
        ).fetchone()
    except sqlite3.OperationalError:
        return {}
    if not row:
        return {}
    manifest = json.loads(row["manifest_json"] or "{}")
    old_config = _config_from_manifest_for_worker(manifest, worker_id) if isinstance(manifest, dict) else None
    return {
        "trigger_id": row["composio_trigger_id"],
        "event": row["composio_event"],
        "signature": _composio_trigger_signature(old_config),
    }


def _disable_composio_trigger(event: Optional[str], trigger_id: Optional[str], worker_id: str) -> None:
    if not event:
        return
    try:
        from composio_client import disable_trigger
        disable_trigger(event, trigger_id)
    except Exception as exc:
        logger.exception("Failed to disable Composio trigger for worker %s", worker_id)
        raise RuntimeError(f"Composio disable failed for worker {worker_id}: {exc}") from exc


def _enable_composio_trigger(config: WorkerConfig, worker_id: str) -> str:
    signature = _composio_trigger_signature(config)
    if not signature:
        raise RuntimeError(f"Worker {worker_id} does not declare trigger.composio")
    try:
        from composio_client import enable_trigger
        return enable_trigger(
            signature["event"],
            signature["connection_id"],
            _composio_webhook_url(),
            signature["filters"],
        )
    except Exception as exc:
        logger.exception("Failed to enable Composio trigger for worker %s", worker_id)
        raise RuntimeError(f"Composio enable failed for worker {worker_id}: {exc}") from exc


def _sync_composio_registration(
    conn: sqlite3.Connection,
    worker_id: str,
    config: Optional[WorkerConfig],
    existing: Optional[Dict[str, Any]] = None,
) -> tuple[Optional[str], Optional[str]]:
    existing = existing or _existing_composio_state(conn, worker_id)
    new_signature = _composio_trigger_signature(config)
    old_signature = existing.get("signature")
    old_trigger_id = existing.get("trigger_id")
    old_event = existing.get("event") or (old_signature or {}).get("event")

    if not new_signature:
        if old_trigger_id:
            _disable_composio_trigger(old_event, old_trigger_id, worker_id)
        return None, None

    if old_trigger_id and old_signature == new_signature:
        return old_trigger_id, new_signature["event"]

    enabled_id = _enable_composio_trigger(config, worker_id)
    if old_trigger_id:
        try:
            _disable_composio_trigger(old_event, old_trigger_id, worker_id)
        except RuntimeError:
            try:
                _disable_composio_trigger(new_signature["event"], enabled_id, worker_id)
            except RuntimeError:
                logger.exception(
                    "Failed to roll back newly enabled Composio trigger for worker %s",
                    worker_id,
                )
            raise
    return enabled_id, new_signature["event"]


def _persist_discovered_workers(conn: sqlite3.Connection, workers: List[Dict[str, Any]]) -> None:
    now = now_iso()
    for w in workers:
        manifest = w.get("manifest") or {}
        config = w.get("config") or {}
        trigger = config.get("trigger") or {}
        worker_id = w["id"]
        skill_version_id = _skill_version_id(worker_id, manifest)
        config_model = _config_from_manifest_for_worker(manifest, worker_id)
        if config_model is None and config:
            try:
                config_model = WorkerConfig(**config)
            except Exception:
                logger.exception("Failed to parse worker config for composio lifecycle: %s", worker_id)
        existing_composio = _existing_composio_state(conn, worker_id)
        composio_trigger_id, composio_event = _sync_composio_registration(
            conn,
            worker_id,
            config_model,
            existing_composio,
        )
        conn.execute(
            """
            INSERT INTO skill_versions
                (id, name, version, manifest_json, bundle_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(name, version) DO UPDATE SET
                manifest_json=excluded.manifest_json,
                bundle_path=excluded.bundle_path
            """,
            (
                skill_version_id,
                manifest.get("name") or worker_id.replace("_", "-"),
                manifest.get("version") or "0.1.0",
                json.dumps(manifest),
                f"workers/{worker_id}",
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO workers
                (id, skill_version_id, name, trigger_type, cron_expr, cron_timezone,
                 next_run_at, last_scheduled_run_at, webhook_secret_hash, notify_email,
                 notify_webhook_url, grants_json, input_values_json, enabled, created_at, owner_id,
                 composio_trigger_id, composio_event)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?, 1, ?, 'federico', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                skill_version_id=excluded.skill_version_id,
                name=excluded.name,
                trigger_type=excluded.trigger_type,
                cron_expr=excluded.cron_expr,
                cron_timezone=excluded.cron_timezone,
                composio_trigger_id=excluded.composio_trigger_id,
                composio_event=excluded.composio_event
            """,
            (
                worker_id,
                skill_version_id,
                w["name"],
                trigger.get("type") or w.get("trigger_type") or "manual",
                trigger.get("cron"),
                trigger.get("timezone"),
                json.dumps({}),
                json.dumps({}),
                now,
                composio_trigger_id,
                composio_event,
            ),
        )


def _db_worker_from_row(row: sqlite3.Row) -> Dict[str, Any]:
    d = row_to_dict(row)
    config = get_worker_config_for_run(d["id"])
    manifest = json.loads(d.get("manifest_json") or "{}")
    return {
        "id": d["id"],
        "name": d["name"],
        "description": manifest.get("description") if isinstance(manifest, dict) else None,
        "status": "healthy",
        "trigger_type": d.get("trigger_type") or (config.trigger.type if config else "manual"),
        "runner": config.runtime.runner if config and config.runtime else "local",
        "config": config.model_dump(mode="json") if config else {},
        "manifest": manifest,
    }


def _list_db_workers() -> List[Dict[str, Any]]:
    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT w.id, w.name, w.trigger_type, sv.manifest_json
                FROM workers w
                JOIN skill_versions sv ON sv.id = w.skill_version_id
                ORDER BY w.created_at, w.id
                """
            ).fetchall()
        return [_db_worker_from_row(row) for row in rows]
    except sqlite3.OperationalError:
        return []


def _get_db_worker(worker_id: str) -> Optional[Dict[str, Any]]:
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT w.id, w.name, w.trigger_type, sv.manifest_json
                FROM workers w
                JOIN skill_versions sv ON sv.id = w.skill_version_id
                WHERE w.id = ?
                """,
                (worker_id,),
            ).fetchone()
        return _db_worker_from_row(row) if row else None
    except sqlite3.OperationalError:
        return None


# ---------------------------------------------------------------------------
# Workers
# ---------------------------------------------------------------------------

@app.get("/workers", response_model=List[WorkerSummary])
def list_workers() -> List[WorkerSummary]:
    workers = _list_db_workers() or discover_workers(use_cache=True)
    paused_workers = _get_paused_workers()
    result: List[WorkerSummary] = []
    for w in workers:
        last_run_row = _get_last_run_for_worker(w["id"])
        last_run = _make_run_summary(last_run_row) if last_run_row else None

        # Check secrets
        config = get_worker_config_for_run(w["id"])
        status = WorkerStatus(w["status"])
        if config and config.secrets:
            missing = [s for s in config.secrets if s not in os.environ]
            if missing:
                status = WorkerStatus.MISSING_SECRET
        if (
            status not in (WorkerStatus.MISSING_SECRET, WorkerStatus.ERROR)
            and w["id"] in paused_workers
        ):
            status = WorkerStatus.PAUSED
        elif (
            status == WorkerStatus.HEALTHY
            and last_run
            and last_run.status in (RunStatus.FAILED, RunStatus.REJECTED)
        ):
            status = WorkerStatus.NEEDS_ATTENTION

        result.append(
            WorkerSummary(
                id=w["id"],
                name=w["name"],
                description=w.get("description"),
                status=status,
                paused=w["id"] in paused_workers,
                trigger_type=w["trigger_type"],
                runner=w["runner"],
                last_run=last_run,
            )
        )
    return result


@app.post("/workers/{worker_id}/pause", response_model=WorkerStateResponse)
def pause_worker(worker_id: str) -> WorkerStateResponse:
    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    with get_db() as conn:
        conn.execute(
            """INSERT INTO worker_state (worker_id, paused, updated_at) VALUES (?, 1, ?)
               ON CONFLICT(worker_id) DO UPDATE SET paused=1, updated_at=excluded.updated_at""",
            (worker_id, now_iso()),
        )
    return WorkerStateResponse(worker_id=worker_id, paused=True)


@app.post("/workers/{worker_id}/unpause", response_model=WorkerStateResponse)
def unpause_worker(worker_id: str) -> WorkerStateResponse:
    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    with get_db() as conn:
        conn.execute(
            """INSERT INTO worker_state (worker_id, paused, updated_at) VALUES (?, 0, ?)
               ON CONFLICT(worker_id) DO UPDATE SET paused=0, updated_at=excluded.updated_at""",
            (worker_id, now_iso()),
        )
    return WorkerStateResponse(worker_id=worker_id, paused=False)


@app.get("/workers/{worker_id}", response_model=WorkerDetail)
def get_worker_detail(worker_id: str) -> WorkerDetail:
    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, worker_id, status, trigger_source, approval_status,
                   created_at, started_at, completed_at, duration_ms, error
            FROM runs WHERE worker_id = ? ORDER BY created_at DESC LIMIT 10
            """,
            (worker_id,),
        )
        recent_runs = [_make_run_summary(r) for r in cursor.fetchall()]
        cursor.execute(
            "SELECT paused FROM worker_state WHERE worker_id = ?",
            (worker_id,),
        )
        state_row = cursor.fetchone()
        paused = bool(state_row["paused"]) if state_row else False

    config_dict = worker.get("config", {})
    try:
        config = WorkerConfig(**config_dict)
    except Exception:
        config = WorkerConfig(
            id=worker["id"],
            name=worker["name"],
            trigger={"type": "manual"},
            runtime={"type": "python", "entrypoint": "run.py"},
        )

    status = WorkerStatus(worker["status"])
    if config and config.secrets:
        missing = [s for s in config.secrets if s not in os.environ]
        if missing:
            status = WorkerStatus.MISSING_SECRET
    if status not in (WorkerStatus.MISSING_SECRET, WorkerStatus.ERROR) and paused:
        status = WorkerStatus.PAUSED
    elif (
        status == WorkerStatus.HEALTHY
        and recent_runs
        and recent_runs[0].status in (RunStatus.FAILED, RunStatus.REJECTED)
    ):
        status = WorkerStatus.NEEDS_ATTENTION

    # Read raw YAML for manifest viewer
    manifest_yaml: Optional[str] = None
    run_py: Optional[str] = None
    try:
        from worker_registry import WORKERS_DIR
        yml_path = WORKERS_DIR / worker_id / "worker.yml"
        run_path = WORKERS_DIR / worker_id / "run.py"
        if yml_path.is_file():
            manifest_yaml = yml_path.read_text()
        elif worker.get("manifest"):
            import yaml as pyyaml
            manifest_yaml = pyyaml.safe_dump(worker["manifest"], sort_keys=False)
        if run_path.is_file():
            run_py = run_path.read_text()
    except Exception:
        pass

    return WorkerDetail(
        id=worker["id"],
        name=worker["name"],
        description=worker.get("description"),
        status=status,
        paused=paused,
        trigger_type=worker["trigger_type"],
        runner=worker["runner"],
        config=config,
        recent_runs=recent_runs,
        manifest_yaml=manifest_yaml,
        run_py=run_py,
    )


# ---------------------------------------------------------------------------
# Worker creation
# ---------------------------------------------------------------------------

class WorkerCreateRequest(BaseModel):
    worker_yml: str
    run_py: str


def _parse_worker_payload(worker_yml: str) -> tuple[str, WorkerConfig]:
    import yaml as pyyaml

    try:
        raw = pyyaml.safe_load(worker_yml)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {exc}")
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="worker_yml must contain a YAML mapping")

    try:
        from models import WorkerContract, parse_worker_manifest, worker_contract_to_worker_config
        parsed = parse_worker_manifest(raw)
        if isinstance(parsed, WorkerContract):
            worker_id = parsed.name
            config = worker_contract_to_worker_config(parsed, worker_id)
        else:
            config = parsed
            worker_id = config.id
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Schema validation failed: {exc}")

    if not re.fullmatch(r"[a-z0-9_-]+", worker_id):
        raise HTTPException(status_code=400, detail=f"Worker ID must be lowercase kebab/snake-case: {worker_id!r}")
    return worker_id, config


@app.post("/workers", response_model=WorkerDetail)
def create_worker(payload: WorkerCreateRequest) -> WorkerDetail:
    """Create a new worker from YAML + Python source."""
    from worker_registry import WORKERS_DIR

    worker_id, config = _parse_worker_payload(payload.worker_yml)

    target_dir = WORKERS_DIR / worker_id
    if target_dir.exists():
        raise HTTPException(status_code=409, detail=f"Worker {worker_id!r} already exists")

    # Write files
    target_dir.mkdir(parents=True, exist_ok=False)
    (target_dir / "worker.yml").write_text(payload.worker_yml)
    (target_dir / "run.py").write_text(payload.run_py)
    (target_dir / "requirements.txt").write_text("")
    (target_dir / "SKILL.md").write_text(
        f"# {config.name}\n\n"
        "This WorkerContract entrypoint is a placeholder for the markdown skill runtime. "
        "Current Workeros execution uses `exec.command` from `worker.yml`.\n"
    )

    # Register
    invalidate_worker_cache()
    workers = discover_workers()

    # Persist to DB
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers)
        except RuntimeError as exc:
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            invalidate_worker_cache()
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Return the new worker detail
    return get_worker_detail(worker_id)


@app.put("/workers/{worker_id}", response_model=WorkerDetail)
def update_worker(worker_id: str, payload: WorkerCreateRequest) -> WorkerDetail:
    """Update an existing worker from YAML + Python source."""
    from worker_registry import WORKERS_DIR

    parsed_worker_id, _config = _parse_worker_payload(payload.worker_yml)
    if parsed_worker_id != worker_id:
        raise HTTPException(
            status_code=400,
            detail=f"worker_yml name {parsed_worker_id!r} does not match path worker_id {worker_id!r}",
        )

    target_dir = WORKERS_DIR / worker_id
    if not target_dir.exists():
        raise HTTPException(status_code=404, detail="Worker not found")

    worker_yml_path = target_dir / "worker.yml"
    run_py_path = target_dir / "run.py"
    requirements_path = target_dir / "requirements.txt"
    skill_path = target_dir / "SKILL.md"
    old_worker_yml = worker_yml_path.read_text() if worker_yml_path.exists() else None
    old_run_py = run_py_path.read_text() if run_py_path.exists() else None
    had_requirements = requirements_path.exists()
    old_skill = skill_path.read_text() if skill_path.exists() else None

    worker_yml_path.write_text(payload.worker_yml)
    run_py_path.write_text(payload.run_py)
    if not requirements_path.exists():
        requirements_path.write_text("")
    if not skill_path.exists():
        skill_path.write_text(
            f"# {_config.name}\n\n"
            "This WorkerContract entrypoint is a placeholder for the markdown skill runtime. "
            "Current Workeros execution uses `exec.command` from `worker.yml`.\n"
        )

    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers)
        except RuntimeError as exc:
            if old_worker_yml is not None:
                worker_yml_path.write_text(old_worker_yml)
            if old_run_py is not None:
                run_py_path.write_text(old_run_py)
            if not had_requirements and requirements_path.exists():
                requirements_path.unlink()
            if old_skill is not None:
                skill_path.write_text(old_skill)
            elif skill_path.exists():
                skill_path.unlink()
            invalidate_worker_cache()
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    return get_worker_detail(worker_id)


@app.delete("/workers/{worker_id}")
def delete_worker(worker_id: str):
    """Delete a worker and unregister its Composio trigger before removal."""
    import shutil
    from worker_registry import WORKERS_DIR

    target_dir = WORKERS_DIR / worker_id
    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker and not target_dir.exists():
        raise HTTPException(status_code=404, detail="Worker not found")

    with get_db() as conn:
        state = _existing_composio_state(conn, worker_id)
        if state.get("trigger_id"):
            try:
                _disable_composio_trigger(
                    state.get("event") or (state.get("signature") or {}).get("event"),
                    state.get("trigger_id"),
                    worker_id,
                )
            except RuntimeError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
        conn.execute("DELETE FROM workers WHERE id = ?", (worker_id,))

    if target_dir.exists():
        try:
            resolved_root = WORKERS_DIR.resolve()
            resolved_target = target_dir.resolve()
            resolved_target.relative_to(resolved_root)
        except Exception:
            raise HTTPException(status_code=403, detail="Invalid worker path")
        shutil.rmtree(resolved_target)
    invalidate_worker_cache()
    return {"status": "deleted"}


@app.post("/workers/reload", response_model=ReloadResponse)
def reload_workers() -> ReloadResponse:
    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        try:
            _persist_discovered_workers(conn, workers)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    return ReloadResponse(status="success", workers_loaded=len(workers))


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

@app.post("/workers/{worker_id}/runs", response_model=ActionResponse)
def create_worker_run(worker_id: str, payload: RunCreate) -> ActionResponse:
    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    run_id = create_run(worker_id, payload.inputs, payload.trigger_source)
    start_run(run_id, worker_id, payload.inputs)
    return ActionResponse(status="running", run_id=run_id)


@app.get("/runs", response_model=List[RunSummary])
def list_runs(
    worker_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> List[RunSummary]:
    with get_db() as conn:
        cursor = conn.cursor()
        query = """
            SELECT r.id, r.worker_id, w.name as worker_name, r.status,
                   r.trigger_source, r.created_at, r.approval_status,
                   r.started_at, r.completed_at, r.duration_ms, r.error
            FROM runs r
            LEFT JOIN workers w ON r.worker_id = w.id
            WHERE 1=1
        """
        params: list[Any] = []
        if worker_id:
            query += " AND r.worker_id = ?"
            params.append(worker_id)
        if status:
            query += " AND r.status = ?"
            params.append(status)
        query += " ORDER BY r.created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
    return [_make_run_summary(r) for r in rows]


@app.post("/runs/clear")
def clear_runs():
    with get_db() as conn:
        conn.execute("DELETE FROM artifacts")
        conn.execute("DELETE FROM approvals")
        conn.execute("DELETE FROM logs")
        conn.execute("DELETE FROM runs")
    logger.info("All run history cleared")
    return {"status": "cleared"}


@app.get("/runs/{run_id}/artifacts/{artifact_id}/download")
def download_artifact(run_id: str, artifact_id: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM artifacts WHERE id = ? AND run_id = ?",
            (artifact_id, run_id),
        )
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Artifact not found")

    art = row_to_dict(row)
    path_str = art["path"]

    from runner_local import ARTIFACTS_DIR
    from pathlib import Path
    try:
        artifacts_dir = ARTIFACTS_DIR.resolve()
        resolved = Path(path_str).resolve()
    except Exception:
        raise HTTPException(status_code=403, detail="Invalid path")

    try:
        resolved.relative_to(artifacts_dir)
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found on disk")

    content_type, _ = mimetypes.guess_type(art["name"])
    content_type = content_type or "application/octet-stream"
    filename = (
        str(art["name"])
        .replace("\\", "_")
        .replace('"', "_")
        .replace("\r", "_")
        .replace("\n", "_")
    )

    def iter_file():
        with open(resolved, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        iter_file(),
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/runs/{run_id}", response_model=RunDetail)
def get_run(run_id: str) -> RunDetail:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT r.id, r.worker_id, w.name as worker_name, r.status, r.trigger_source, r.runner,
                   r.input_json, r.output_json, r.approval_status, r.error,
                   r.started_at, r.completed_at, r.duration_ms, r.created_at
            FROM runs r
            LEFT JOIN workers w ON r.worker_id = w.id
            WHERE r.id = ?
            """,
            (run_id,),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Run not found")

        run = row_to_dict(row)
        run["input"] = json.loads(run.get("input_json") or "{}")
        run["output"] = json.loads(run.get("output_json") or "{}")
        # Build typed output schema from worker config
        output_config = get_worker_config_for_run(run["worker_id"])
        output_schema = []
        if output_config:
            raw_output = run["output"]
            for out in output_config.outputs:
                output_schema.append(OutputField(
                    name=out.name,
                    label=out.label,
                    type=out.type,
                    value=raw_output.get(out.name),
                ))

        cursor.execute(
            """
            SELECT level, message, timestamp, trace_id
            FROM logs WHERE run_id = ? ORDER BY timestamp
            """,
            (run_id,),
        )
        logs = [
            LogEntry(level=r["level"], message=r["message"], timestamp=r["timestamp"], trace_id=row_to_dict(r).get("trace_id"))
            for r in cursor.fetchall()
        ]

        cursor.execute(
            "SELECT * FROM artifacts WHERE run_id = ?",
            (run_id,),
        )
        artifacts = [
            Artifact(
                id=r["id"], run_id=r["run_id"], name=r["name"],
                type=row_to_dict(r).get("type"), path=r["path"],
                size_bytes=row_to_dict(r).get("size_bytes"), created_at=r["created_at"],
            )
            for r in cursor.fetchall()
        ]
        transcript = _read_transcript_rows(run["runner"], artifacts)

        cursor.execute(
            "SELECT * FROM approvals WHERE run_id = ?",
            (run_id,),
        )
        approval_row = cursor.fetchone()
        approval = None
        if approval_row:
            a = row_to_dict(approval_row)
            approval = ApprovalDetail(
                id=a["id"],
                run_id=a["run_id"],
                worker_id=a["worker_id"],
                status=ApprovalStatus(a["status"]),
                label=a.get("label"),
                preview=a.get("preview"),
                created_at=a["created_at"],
                decided_at=a.get("decided_at"),
                reason=a.get("reason"),
            )

    return RunDetail(
        id=run["id"],
        worker_id=run["worker_id"],
        status=RunStatus(run["status"]),
        trigger_source=run["trigger_source"],
        runner=run["runner"],
        input=run["input"],
        output=run["output"],
        output_schema=output_schema,
        logs=logs,
        artifacts=artifacts,
        transcript=transcript,
        approval=approval,
        approval_status=ApprovalStatus(run.get("approval_status", "not_required")),
        error=run.get("error"),
        started_at=run.get("started_at"),
        completed_at=run.get("completed_at"),
        duration_ms=run.get("duration_ms"),
        created_at=run.get("created_at"),
    )


@app.get("/runs/{run_id}/logs", response_model=List[LogEntry])
def get_run_logs(run_id: str) -> List[LogEntry]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT level, message, timestamp, trace_id
            FROM logs WHERE run_id = ? ORDER BY timestamp
            """,
            (run_id,),
        )
        rows = cursor.fetchall()
    return [
        LogEntry(level=r["level"], message=r["message"], timestamp=r["timestamp"], trace_id=row_to_dict(r).get("trace_id"))
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Approvals
# ---------------------------------------------------------------------------

@app.get("/approvals", response_model=List[ApprovalDetail])
def list_approvals(status: str = "pending") -> List[ApprovalDetail]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT a.id, a.run_id, a.worker_id, w.name as worker_name,
                   a.status, a.label, a.preview, a.created_at, a.decided_at,
                   a.reason
            FROM approvals a
            LEFT JOIN workers w ON a.worker_id = w.id
            WHERE a.status = ?
            ORDER BY a.created_at DESC
            """,
            (status,),
        )
        rows = cursor.fetchall()
    result = []
    for r in rows:
        rd = row_to_dict(r)
        preview_type: Optional[str] = None
        config = get_worker_config_for_run(r["worker_id"])
        if config and config.outputs:
            preview_type = config.outputs[0].type
        result.append(
            ApprovalDetail(
                id=r["id"],
                run_id=r["run_id"],
                worker_id=r["worker_id"],
                worker_name=rd.get("worker_name"),
                status=ApprovalStatus(r["status"]),
                label=rd.get("label"),
                preview=rd.get("preview"),
                preview_type=preview_type,
                created_at=r["created_at"],
                decided_at=rd.get("decided_at"),
                reason=rd.get("reason"),
            )
        )
    return result


@app.post("/runs/{run_id}/approve", response_model=ActionResponse)
def approve_run(run_id: str, payload: Optional[ApproveRequest] = None) -> ActionResponse:
    now = now_iso()

    # If edited output provided, patch the run's output_json before marking approved
    if payload and payload.edited_output is not None:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT output_json FROM runs WHERE id = ?", (run_id,))
            row = cursor.fetchone()
            if row and row["output_json"]:
                try:
                    existing_output = json.loads(row["output_json"])
                    # Replace the value of the first output key with the edited content
                    if existing_output:
                        first_key = next(iter(existing_output))
                        existing_output[first_key] = payload.edited_output
                    patched_json = json.dumps(existing_output)
                except (json.JSONDecodeError, StopIteration):
                    patched_json = json.dumps({"output": payload.edited_output})
                conn.execute(
                    "UPDATE runs SET output_json = ? WHERE id = ?",
                    (patched_json, run_id),
                )

    with get_db() as conn:
        conn.execute(
            "UPDATE approvals SET status = ?, decided_at = ? WHERE run_id = ?",
            (ApprovalStatus.APPROVED.value, now, run_id),
        )
        conn.execute(
            "UPDATE runs SET approval_status = ?, status = ? WHERE id = ?",
            (ApprovalStatus.APPROVED.value, RunStatus.APPROVED.value, run_id),
        )
    edited_note = " (output edited before approval)" if payload and payload.edited_output else ""
    add_log(run_id, f"Run approved{edited_note}", level="info")
    logger.info("Run %s approved%s", run_id, edited_note)
    return ActionResponse(status="approved", run_id=run_id)


@app.post("/runs/{run_id}/reject", response_model=ActionResponse)
def reject_run(run_id: str, payload: RejectRequest) -> ActionResponse:
    reason = payload.reason or "No reason provided"
    now = now_iso()
    with get_db() as conn:
        conn.execute(
            "UPDATE approvals SET status = ?, decided_at = ?, reason = ? WHERE run_id = ?",
            (ApprovalStatus.REJECTED.value, now, reason, run_id),
        )
        conn.execute(
            "UPDATE runs SET approval_status = ?, status = ? WHERE id = ?",
            (ApprovalStatus.REJECTED.value, RunStatus.REJECTED.value, run_id),
        )
    add_log(run_id, f"Run rejected: {reason}", level="info")
    logger.info("Run %s rejected: %s", run_id, reason)
    return ActionResponse(status="rejected", run_id=run_id)


# ---------------------------------------------------------------------------
# Secrets — CRUD + test
# ---------------------------------------------------------------------------

# Path to the .env file used by the API
_ENV_PATH = Path(__file__).parent / ".env"


class SecretUpsertRequest(BaseModel):
    value: str


class SecretTestResult(BaseModel):
    status: str  # "valid" | "invalid"
    reason: Optional[str] = None


def _read_env_lines() -> list[str]:
    """Read .env lines; return [] if file does not exist."""
    if not _ENV_PATH.exists():
        return []
    with open(_ENV_PATH, "r") as f:
        return f.readlines()


def _write_env_lines(lines: list[str]) -> None:
    """Atomically write .env lines with fcntl lock."""
    _ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_ENV_PATH, "a+") as lock_fd:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            with open(_ENV_PATH, "w") as f:
                f.writelines(lines)
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)


def _upsert_env_var(name: str, value: str) -> None:
    """Set or replace NAME=value in the .env file, then reload into os.environ."""
    # Validate name is a legal env var identifier
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError(f"Invalid secret name: {name!r}")

    lines = _read_env_lines()
    new_line = f"{name}={value}\n"
    replaced = False
    new_lines: list[str] = []
    for line in lines:
        stripped = line.rstrip("\n")
        if stripped.startswith(f"{name}=") or stripped == name:
            new_lines.append(new_line)
            replaced = True
        else:
            new_lines.append(line)
    if not replaced:
        # Ensure trailing newline before appending
        if new_lines and not new_lines[-1].endswith("\n"):
            new_lines[-1] += "\n"
        new_lines.append(new_line)
    _write_env_lines(new_lines)
    # Reload in-process so workers immediately see the new value
    os.environ[name] = value


def _delete_env_var(name: str) -> bool:
    """Remove NAME from .env and os.environ. Returns True if it was present."""
    lines = _read_env_lines()
    new_lines = [
        line for line in lines
        if not (line.rstrip("\n").startswith(f"{name}=") or line.rstrip("\n") == name)
    ]
    removed = len(new_lines) < len(lines)
    if removed:
        _write_env_lines(new_lines)
    os.environ.pop(name, None)
    return removed


@app.post("/secrets/{name}", response_model=SecretTestResult)
def upsert_secret(name: str, payload: SecretUpsertRequest) -> SecretTestResult:
    """Create or update a secret. Value is write-only — never returned."""
    try:
        _upsert_env_var(name, payload.value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Refresh DB record
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO secrets (name, status, created_at, updated_at)
            VALUES (?, 'set', ?, ?)
            ON CONFLICT(name) DO UPDATE SET status='set', updated_at=excluded.updated_at
            """,
            (name, now_iso(), now_iso()),
        )
    logger.info("Secret %s upserted", name)
    return SecretTestResult(status="valid", reason=f"Secret {name!r} saved.")


@app.delete("/secrets/{name}", response_model=SecretTestResult)
def delete_secret(name: str) -> SecretTestResult:
    """Delete a secret from .env and env."""
    removed = _delete_env_var(name)
    with get_db() as conn:
        conn.execute("DELETE FROM secrets WHERE name = ?", (name,))
    if not removed:
        raise HTTPException(status_code=404, detail=f"Secret {name!r} not found in .env")
    logger.info("Secret %s deleted", name)
    return SecretTestResult(status="valid", reason=f"Secret {name!r} removed.")


@app.post("/secrets/{name}/test", response_model=SecretTestResult)
def test_secret(name: str) -> SecretTestResult:
    """Test a secret. For OPENAI_API_KEY: does a 1-token completion. Others: confirms env var is set."""
    value = os.environ.get(name)
    if not value:
        return SecretTestResult(status="invalid", reason=f"{name} is not set in the environment.")

    if name == "OPENAI_API_KEY":
        try:
            import openai
            client = openai.OpenAI(api_key=value)
            resp = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
            )
            _ = resp.choices[0].message.content
            return SecretTestResult(status="valid", reason="OpenAI API key is valid (1-token ping succeeded).")
        except Exception as exc:
            return SecretTestResult(status="invalid", reason=f"OpenAI API key test failed: {exc}")

    # Generic: secret is set
    return SecretTestResult(
        status="valid",
        reason=f"{name} is set ({len(value)} chars). No additional test available for this secret type.",
    )


# ---------------------------------------------------------------------------
# Platform secrets — infra vars that belong in Settings, NOT the secrets UI
# ---------------------------------------------------------------------------

PLATFORM_SECRETS: frozenset[str] = frozenset({
    "COMPOSIO_API_KEY",
    "COMPOSIO_WEBHOOK_SIGNING_KEY",
    "WORKERS_FRONTEND_URL",
    "FLOOM_DB",
    "FLOOM_WORKERS_DIR",
    "FLOOM_ARTIFACTS_DIR",
    "FLOOM_RUN_TIMEOUT",
    "FLOOM_SECRET",
    "E2B_API_KEY",
})


@app.get("/secrets", response_model=List[SecretItem])
def list_secrets() -> List[SecretItem]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM secrets ORDER BY name")
        db_secrets = {r["name"]: row_to_dict(r) for r in cursor.fetchall()}

    workers = _list_db_workers() or discover_workers(use_cache=True)

    # (a) All secrets declared by any worker.yml
    worker_secret_names: set[str] = set()
    for w in workers:
        config = get_worker_config_for_run(w["id"])
        if config:
            worker_secret_names.update(config.secrets)

    # (b) All keys present in the .env file (user-added secrets not yet referenced by a worker)
    env_secret_names: set[str] = set()
    for line in _read_env_lines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key:
                env_secret_names.add(key)

    # Filter out platform-managed secrets — they appear in Settings, not here
    all_secret_names = (worker_secret_names | env_secret_names) - PLATFORM_SECRETS

    result: List[SecretItem] = []
    for name in sorted(all_secret_names):
        value = os.environ.get(name)
        status = SecretStatus.SET if value else SecretStatus.MISSING
        used_by = []
        for w in workers:
            config = get_worker_config_for_run(w["id"])
            if config and name in config.secrets:
                used_by.append(w["name"])

        with get_db() as conn:
            now = now_iso()
            conn.execute(
                """
                INSERT INTO secrets (name, status, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (name, status.value, now, now),
            )

        result.append(
            SecretItem(
                name=name,
                status=status,
                last_used_at=db_secrets.get(name, {}).get("last_used_at"),
                used_by=used_by,
            )
        )
    return result


# ---------------------------------------------------------------------------
# Connections (Composio OAuth)
# ---------------------------------------------------------------------------

class ConnectionInitRequest(BaseModel):
    app_name: str


class ConnectionItem(BaseModel):
    id: str
    app_name: str
    composio_connection_id: str
    status: str
    created_at: str
    updated_at: str


class ConnectionInitResponse(BaseModel):
    id: str
    app_name: str
    redirect_url: str
    composio_connection_id: str


class IntegrationCatalogItem(BaseModel):
    slug: str
    name: str
    logo_url: str
    description: str
    categories: List[str]
    tools_count: int = 0
    triggers_count: int = 0


class IntegrationCatalogResponse(BaseModel):
    items: List[IntegrationCatalogItem]
    page: int
    limit: int
    total_items: int
    total_pages: int
    next_page: Optional[int] = None
    categories: List[str] = []


def _get_callback_url() -> str:
    """Build the OAuth callback URL for Composio to redirect to."""
    base = os.environ.get("WORKERS_FRONTEND_URL", "https://workers.floom.dev")
    return f"{base}/connections/callback"


@app.get("/integrations/catalog", response_model=IntegrationCatalogResponse)
def integrations_catalog(
    page: int = Query(1, ge=1),
    limit: int = Query(30, ge=1, le=100),
    search: str = Query("", max_length=120),
    category: str = Query("", max_length=80),
) -> IntegrationCatalogResponse:
    from composio_client import list_catalog_apps

    try:
        result = list_catalog_apps(
            page=page,
            limit=limit,
            search=search,
            category=category,
        )
    except Exception as exc:
        logger.exception("Failed to load Composio catalog")
        raise HTTPException(status_code=502, detail=f"Composio catalog error: {exc}") from exc
    return IntegrationCatalogResponse(**result)


@app.get("/connections", response_model=List[ConnectionItem])
def list_connections() -> List[ConnectionItem]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, app_name, composio_connection_id, status, created_at, updated_at "
            "FROM composio_connections ORDER BY app_name"
        )
        rows = cursor.fetchall()
    return [ConnectionItem(**row_to_dict(r)) for r in rows]


@app.post("/connections", response_model=ConnectionInitResponse)
def initiate_connection(payload: ConnectionInitRequest) -> ConnectionInitResponse:
    from composio_client import initiate_connection as composio_initiate
    app_name = payload.app_name.lower().strip()
    if not app_name:
        raise HTTPException(status_code=400, detail="app_name is required")

    callback_url = _get_callback_url()
    try:
        result = composio_initiate(app_name, callback_url)
    except Exception as exc:
        logger.exception("Failed to initiate Composio connection for %s", app_name)
        raise HTTPException(status_code=502, detail=f"Composio error: {exc}") from exc

    composio_conn_id = result["composio_connection_id"]
    redirect_url = result["redirect_url"]

    # Upsert into local DB (replace any prior row for this app)
    conn_id = str(__import__("uuid").uuid4())
    now = now_iso()
    with get_db() as conn:
        # Check if row already exists for this app
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id FROM composio_connections WHERE app_name = ?", (app_name,)
        )
        existing = cursor.fetchone()
        if existing:
            conn_id = existing["id"]
            conn.execute(
                "UPDATE composio_connections SET composio_connection_id=?, status='initiated', updated_at=? WHERE id=?",
                (composio_conn_id, now, conn_id),
            )
        else:
            conn.execute(
                "INSERT INTO composio_connections (id, app_name, composio_connection_id, status, created_at, updated_at) "
                "VALUES (?, ?, ?, 'initiated', ?, ?)",
                (conn_id, app_name, composio_conn_id, now, now),
            )

    return ConnectionInitResponse(
        id=conn_id,
        app_name=app_name,
        redirect_url=redirect_url,
        composio_connection_id=composio_conn_id,
    )


@app.get("/connections/callback")
def connections_callback(connection_id: str = "", status: str = ""):
    """OAuth callback landing — Composio redirects here after user authorizes.

    Composio sends: ?connection_id=<composio_conn_id>&status=<status>
    We update the local DB and redirect the user to /connections.
    """
    from fastapi.responses import RedirectResponse

    if connection_id:
        # Try to refresh from Composio first
        try:
            from composio_client import check_status
            remote_status = check_status(connection_id)
        except Exception:
            remote_status = status or "active"

        final_status = remote_status if remote_status else (status or "active")
        now = now_iso()
        with get_db() as conn:
            conn.execute(
                "UPDATE composio_connections SET status=?, composio_connection_id=?, updated_at=? "
                "WHERE composio_connection_id=?",
                (final_status, connection_id, now, connection_id),
            )

    frontend_url = os.environ.get("WORKERS_FRONTEND_URL", "https://workers.floom.dev")
    return RedirectResponse(url=f"{frontend_url}/connections?connected=1")


@app.get("/connections/{connection_id}/status", response_model=ConnectionItem)
def get_connection_status(connection_id: str) -> ConnectionItem:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, app_name, composio_connection_id, status, created_at, updated_at "
            "FROM composio_connections WHERE id = ?",
            (connection_id,),
        )
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")

    item = row_to_dict(row)

    # Refresh from Composio
    try:
        from composio_client import check_status
        remote_status = check_status(item["composio_connection_id"])
        if remote_status and remote_status != item["status"]:
            now = now_iso()
            with get_db() as conn:
                conn.execute(
                    "UPDATE composio_connections SET status=?, updated_at=? WHERE id=?",
                    (remote_status, now, connection_id),
                )
            item["status"] = remote_status
            item["updated_at"] = now
    except Exception as exc:
        logger.warning("Could not refresh Composio status for %s: %s", connection_id, exc)

    return ConnectionItem(**item)


@app.delete("/connections/{connection_id}")
def delete_connection(connection_id: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT composio_connection_id FROM composio_connections WHERE id = ?",
            (connection_id,),
        )
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")

    composio_conn_id = row["composio_connection_id"]

    # Attempt to revoke from Composio (best-effort)
    try:
        from composio_client import revoke_connection
        revoke_connection(composio_conn_id)
    except Exception as exc:
        logger.warning("Could not revoke Composio connection %s: %s", composio_conn_id, exc)

    with get_db() as conn:
        conn.execute("DELETE FROM composio_connections WHERE id = ?", (connection_id,))

    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Integration trigger catalog + Composio event receiver
# ---------------------------------------------------------------------------

_trigger_catalog_cache: Dict[str, Any] = {"expires_at": 0.0, "items": None}
_trigger_catalog_lock = threading.Lock()


@app.get("/integrations/triggers")
def list_integration_triggers():
    """Proxy Composio's trigger catalog, cached for one hour."""
    now = time.monotonic()
    with _trigger_catalog_lock:
        if _trigger_catalog_cache["items"] is not None and now < _trigger_catalog_cache["expires_at"]:
            return {"items": _trigger_catalog_cache["items"]}

    try:
        from composio_client import list_triggers
        items = list_triggers()
    except Exception as exc:
        logger.exception("Failed to fetch Composio trigger catalog")
        raise HTTPException(status_code=502, detail=f"Composio error: {exc}") from exc

    with _trigger_catalog_lock:
        _trigger_catalog_cache["items"] = items
        _trigger_catalog_cache["expires_at"] = now + 3600
    return {"items": items}


def _signature_values(signature_header: str) -> list[str]:
    values: list[str] = []
    signature_header = signature_header.strip()
    if not signature_header:
        return values
    if "," in signature_header:
        values.append(signature_header.split(",", 1)[1].strip())
    for part in signature_header.split():
        if "," in part:
            values.append(part.split(",", 1)[1].strip())
        if "=" in part:
            key, _, value = part.partition("=")
            if key in {"v1", "sha256"} and value:
                values.append(value.strip())
    values.append(signature_header)
    return [value for value in dict.fromkeys(values) if value]


def _verify_composio_signature(body: bytes, request: Request, signing_key: str) -> bool:
    webhook_id = request.headers.get("webhook-id", "")
    webhook_timestamp = request.headers.get("webhook-timestamp", "")
    signature_header = request.headers.get("webhook-signature", "")
    if not webhook_id or not webhook_timestamp or not signature_header:
        return False

    try:
        timestamp = int(webhook_timestamp)
    except ValueError:
        return False
    tolerance = int(os.environ.get("COMPOSIO_WEBHOOK_TOLERANCE_SECONDS", "300"))
    if tolerance > 0 and abs(time.time() - timestamp) > tolerance:
        return False

    signing_string = f"{webhook_id}.{webhook_timestamp}.{body.decode('utf-8')}".encode()
    expected = base64.b64encode(
        hmac.new(signing_key.encode(), signing_string, hashlib.sha256).digest()
    ).decode()
    return any(
        hmac.compare_digest(expected, provided)
        for provided in _signature_values(signature_header)
    )


def _candidate_composio_trigger_ids(payload: Any, request: Request) -> list[str]:
    candidates = [
        request.headers.get("X-Composio-Trigger-Id"),
        request.headers.get("X-Trigger-Id"),
    ]
    if isinstance(payload, dict):
        for key in (
            "composio_trigger_id",
            "trigger_id",
            "triggerId",
            "trigger_instance_id",
            "triggerInstanceId",
            "enabled_trigger_id",
            "connected_account_trigger_id",
        ):
            candidates.append(payload.get(key))
        for nested_key in ("data", "metadata", "trigger"):
            nested = payload.get(nested_key)
            if isinstance(nested, dict):
                nested_keys = [
                    "composio_trigger_id",
                    "trigger_id",
                    "triggerId",
                    "trigger_instance_id",
                    "triggerInstanceId",
                    "enabled_trigger_id",
                    "connected_account_trigger_id",
                ]
                if nested_key != "data":
                    nested_keys.append("id")
                for key in nested_keys:
                    candidates.append(nested.get(key))
    return [str(c) for c in candidates if c]


def _event_name_from_payload(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    for key in ("event", "event_name", "trigger_event", "trigger"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    nested = payload.get("metadata")
    if isinstance(nested, dict):
        value = nested.get("trigger_slug") or nested.get("event") or nested.get("event_name")
        if isinstance(value, str) and value:
            return value
    return None


def _find_worker_for_composio_event(payload: Any, request: Request) -> Optional[str]:
    candidates = _candidate_composio_trigger_ids(payload, request)
    with get_db() as conn:
        for trigger_id in candidates:
            row = conn.execute(
                "SELECT id FROM workers WHERE composio_trigger_id = ? LIMIT 1",
                (trigger_id,),
            ).fetchone()
            if row:
                return row["id"]
        if candidates:
            return None
        event_name = _event_name_from_payload(payload)
        if event_name:
            rows = conn.execute(
                "SELECT id FROM workers WHERE composio_event = ? AND composio_trigger_id IS NOT NULL",
                (event_name,),
            ).fetchall()
            if len(rows) == 1:
                return rows[0]["id"]
    return None


@app.post("/composio-events", response_model=ActionResponse)
async def composio_events(request: Request) -> ActionResponse:
    """Receive signed Composio trigger webhooks and create worker runs."""
    signing_key = os.environ.get("COMPOSIO_WEBHOOK_SIGNING_KEY", "")
    if not signing_key:
        raise HTTPException(status_code=503, detail="COMPOSIO_WEBHOOK_SIGNING_KEY is not configured")

    body = await request.body()
    if not _verify_composio_signature(body, request, signing_key):
        raise HTTPException(status_code=401, detail="Invalid Composio signature")

    if body:
        try:
            payload: Any = json.loads(body)
        except Exception:
            payload = {"raw": body.decode("utf-8", errors="replace")}
    else:
        payload = {}

    worker_id = _find_worker_for_composio_event(payload, request)
    if not worker_id:
        raise HTTPException(status_code=404, detail="No worker registered for Composio trigger")

    inputs = {"event": payload}
    run_id = create_run(worker_id, inputs, trigger_source="composio")
    start_run(run_id, worker_id, inputs)
    return ActionResponse(status="queued", run_id=run_id)


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------

@app.get("/system/platform-config")
def platform_config():
    """Return platform-level configuration vars with set/missing status (values never returned)."""
    items = []
    for name in sorted(PLATFORM_SECRETS):
        items.append({
            "name": name,
            "status": "set" if os.environ.get(name) else "missing",
        })
    return {"platform_secrets": items}


@app.get("/system/info")
def system_info():
    workers = discover_workers(use_cache=True)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as cnt FROM runs")
        run_count = cursor.fetchone()["cnt"]
    from runner_local import ARTIFACTS_DIR
    from worker_registry import WORKERS_DIR
    return {
        "api_version": app.version,
        "workers_dir": str(WORKERS_DIR),
        "db_path": DB_PATH,
        "artifacts_dir": str(ARTIFACTS_DIR),
        "run_count": run_count,
        "worker_count": len(workers),
    }


# ---------------------------------------------------------------------------
# Webhook rate limiter (in-memory sliding window)
# ---------------------------------------------------------------------------

_wh_rate_lock = threading.Lock()
_wh_rate_store: Dict[str, collections.deque] = {}
_WH_RATE_LIMIT = int(os.environ.get("FLOOM_WH_RATE_LIMIT", "60"))   # max calls
_WH_RATE_WINDOW = int(os.environ.get("FLOOM_WH_RATE_WINDOW", "60")) # seconds


def _check_webhook_rate_limit(key: str) -> bool:
    """Return True if the request is within the rate limit, False if exceeded.

    Uses a per-key sliding window (IP or worker_id) stored in memory.
    Resets on process restart — acceptable for single-server MVP.
    """
    now = time.monotonic()
    cutoff = now - _WH_RATE_WINDOW
    with _wh_rate_lock:
        dq = _wh_rate_store.setdefault(key, collections.deque())
        # Evict timestamps older than the window
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= _WH_RATE_LIMIT:
            return False
        dq.append(now)
        return True


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------

class WebhookSecretResponse(BaseModel):
    worker_id: str
    secret: Optional[str] = None  # Only present on generation/rotation


@app.post("/webhooks/{worker_id}", response_model=ActionResponse)
async def webhook_trigger(worker_id: str, request: Request) -> ActionResponse:
    """Receive an incoming webhook and trigger a worker run.

    If the worker declares webhook.secret=true, the X-Floom-Signature header
    is verified. On success returns run_id immediately (non-blocking).
    """
    from webhook_service import get_webhook_secret_hash, verify_signature

    # Rate limit: 60 req/60s per (worker_id, client_ip) — in-memory sliding window
    client_ip = (request.client.host if request.client else "unknown")
    rl_key = f"{worker_id}:{client_ip}"
    if not _check_webhook_rate_limit(rl_key):
        raise HTTPException(status_code=429, detail="Too many webhook requests")

    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    config = get_worker_config_for_run(worker_id)
    if not config or config.trigger.type != "webhook":
        raise HTTPException(
            status_code=400,
            detail=f"Worker {worker_id!r} does not have a webhook trigger",
        )

    body = await request.body()

    # Signature verification (only when webhook.secret=true)
    webhook_cfg = config.trigger.webhook
    if webhook_cfg and webhook_cfg.secret:
        secret_hash = get_webhook_secret_hash(worker_id)
        if not secret_hash:
            raise HTTPException(
                status_code=500,
                detail=(
                    "Webhook secret not configured — call POST "
                    f"/workers/{worker_id}/webhook-secret/rotate first"
                ),
            )
        sig_header = request.headers.get("X-Floom-Signature", "")
        if not verify_signature(body, sig_header, secret_hash):
            raise HTTPException(status_code=401, detail="Invalid webhook signature")

    # Parse body as JSON inputs (or empty dict)
    inputs: Dict[str, Any] = {}
    if body:
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                inputs = parsed
            else:
                inputs = {"payload": parsed}
        except Exception:
            inputs = {"raw": body.decode("utf-8", errors="replace")}

    # Create and start run (non-blocking)
    run_id = create_run(worker_id, inputs, trigger_source="webhook")
    start_run(run_id, worker_id, inputs)

    return ActionResponse(status="queued", run_id=run_id)


@app.post("/workers/{worker_id}/webhook-secret/rotate", response_model=WebhookSecretResponse)
def rotate_webhook_secret(worker_id: str) -> WebhookSecretResponse:
    """Rotate the webhook HMAC secret for a worker.

    Returns the new raw secret exactly once — it is never stored in plaintext.
    """
    from webhook_service import generate_webhook_secret

    worker = _get_db_worker(worker_id) or get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    config = get_worker_config_for_run(worker_id)
    if not config or config.trigger.type != "webhook":
        raise HTTPException(
            status_code=400,
            detail=f"Worker {worker_id!r} does not have a webhook trigger",
        )

    raw_secret = generate_webhook_secret(worker_id)
    return WebhookSecretResponse(worker_id=worker_id, secret=raw_secret)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
