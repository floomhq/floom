"""Floom API — FastAPI backend for the OS for Background Workers."""

import os
import json
import sqlite3
import logging
import mimetypes
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv

from db import init_db, get_db, now_iso
from models import (
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
    invalidate_worker_cache,
)
from run_service import create_run, start_run, update_run_status, add_log
from run_service import get_secrets_for_worker

load_dotenv()
init_db()

# ---------------------------------------------------------------------------
# App & middleware
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Floom API",
    version="0.1.0",
    description="The OS for Background Workers",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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


# ---------------------------------------------------------------------------
# Workers
# ---------------------------------------------------------------------------

@app.get("/workers", response_model=List[WorkerSummary])
def list_workers() -> List[WorkerSummary]:
    workers = discover_workers(use_cache=True)
    result: List[WorkerSummary] = []
    for w in workers:
        last_run_row = _get_last_run_for_worker(w["id"])
        last_run = _make_run_summary(last_run_row) if last_run_row else None

        # Check secrets
        config = get_worker_config(w["id"])
        status = WorkerStatus(w["status"])
        if config and config.secrets:
            missing = [s for s in config.secrets if s not in os.environ]
            if missing:
                status = WorkerStatus.MISSING_SECRET

        result.append(
            WorkerSummary(
                id=w["id"],
                name=w["name"],
                description=w.get("description"),
                status=status,
                trigger_type=w["trigger_type"],
                runner=w["runner"],
                last_run=last_run,
            )
        )
    return result


@app.get("/workers/{worker_id}", response_model=WorkerDetail)
def get_worker_detail(worker_id: str) -> WorkerDetail:
    worker = get_worker(worker_id)
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

    return WorkerDetail(
        id=worker["id"],
        name=worker["name"],
        description=worker.get("description"),
        status=WorkerStatus(worker["status"]),
        trigger_type=worker["trigger_type"],
        runner=worker["runner"],
        config=config,
        recent_runs=recent_runs,
    )


@app.post("/workers/reload", response_model=ReloadResponse)
def reload_workers() -> ReloadResponse:
    invalidate_worker_cache()
    workers = discover_workers()
    with get_db() as conn:
        now = now_iso()
        for w in workers:
            conn.execute(
                """
                INSERT INTO workers
                    (id, name, description, config_json, status,
                     trigger_type, runner, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    description=excluded.description,
                    config_json=excluded.config_json,
                    status=excluded.status,
                    trigger_type=excluded.trigger_type,
                    runner=excluded.runner,
                    updated_at=excluded.updated_at
                """,
                (
                    w["id"], w["name"], w.get("description"),
                    json.dumps(w["config"]), w["status"],
                    w["trigger_type"], w["runner"], now, now,
                ),
            )
    return ReloadResponse(status="success", workers_loaded=len(workers))


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

@app.post("/workers/{worker_id}/runs", response_model=ActionResponse)
def create_worker_run(worker_id: str, payload: RunCreate) -> ActionResponse:
    worker = get_worker(worker_id)
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
        output_config = get_worker_config(run["worker_id"])
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
                   a.status, a.label, a.preview, a.created_at, a.decided_at
            FROM approvals a
            LEFT JOIN workers w ON a.worker_id = w.id
            WHERE a.status = ?
            ORDER BY a.created_at DESC
            """,
            (status,),
        )
        rows = cursor.fetchall()
    return [
        ApprovalDetail(
            id=r["id"],
            run_id=r["run_id"],
            worker_id=r["worker_id"],
            status=ApprovalStatus(r["status"]),
            label=row_to_dict(r).get("label"),
            preview=row_to_dict(r).get("preview"),
            created_at=r["created_at"],
            decided_at=row_to_dict(r).get("decided_at"),
        )
        for r in rows
    ]


@app.post("/runs/{run_id}/approve", response_model=ActionResponse)
def approve_run(run_id: str) -> ActionResponse:
    with get_db() as conn:
        conn.execute(
            "UPDATE approvals SET status = ?, decided_at = ? WHERE run_id = ?",
            (ApprovalStatus.APPROVED.value, now_iso(), run_id),
        )
        conn.execute(
            "UPDATE runs SET approval_status = ?, status = ? WHERE id = ?",
            (ApprovalStatus.APPROVED.value, RunStatus.APPROVED.value, run_id),
        )
    add_log(run_id, "Run approved", level="info")
    logger.info("Run %s approved", run_id)
    return ActionResponse(status="approved", run_id=run_id)


@app.post("/runs/{run_id}/reject", response_model=ActionResponse)
def reject_run(run_id: str, payload: RejectRequest) -> ActionResponse:
    reason = payload.reason or "No reason provided"
    with get_db() as conn:
        conn.execute(
            "UPDATE approvals SET status = ?, decided_at = ? WHERE run_id = ?",
            (ApprovalStatus.REJECTED.value, now_iso(), run_id),
        )
        conn.execute(
            "UPDATE runs SET approval_status = ?, status = ? WHERE id = ?",
            (ApprovalStatus.REJECTED.value, RunStatus.REJECTED.value, run_id),
        )
    add_log(run_id, f"Run rejected: {reason}", level="info")
    logger.info("Run %s rejected: %s", run_id, reason)
    return ActionResponse(status="rejected", run_id=run_id)


# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

@app.get("/secrets", response_model=List[SecretItem])
def list_secrets() -> List[SecretItem]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM secrets ORDER BY name")
        db_secrets = {r["name"]: row_to_dict(r) for r in cursor.fetchall()}

    workers = discover_workers(use_cache=True)
    all_secret_names: set[str] = set()
    for w in workers:
        config = get_worker_config(w["id"])
        if config:
            all_secret_names.update(config.secrets)

    result: List[SecretItem] = []
    for name in sorted(all_secret_names):
        value = os.environ.get(name)
        status = SecretStatus.SET if value else SecretStatus.MISSING
        used_by = []
        for w in workers:
            config = get_worker_config(w["id"])
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
# Startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
def startup():
    reload_workers()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
