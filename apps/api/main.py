import os
import json
import uuid
from typing import Any, Dict, List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from db import init_db, get_db, now_iso
from models import RunCreate, ApproveRequest, RejectRequest
from worker_registry import discover_workers, get_worker, get_worker_config
from run_service import create_run, start_run, update_run_status, add_log
from run_service import get_secrets_for_worker

load_dotenv()

init_db()

app = FastAPI(title="Floom API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Helpers ---

def row_to_dict(row) -> Dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def get_last_run_for_worker(worker_id: str) -> Optional[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, status, created_at FROM runs WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1",
        (worker_id,)
    )
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row) if row else None


# --- Workers ---

@app.get("/workers")
def list_workers() -> List[Dict[str, Any]]:
    workers = discover_workers()
    conn = get_db()
    cursor = conn.cursor()
    for w in workers:
        last_run = get_last_run_for_worker(w["id"])
        w["last_run"] = last_run
        # Check secrets
        config = get_worker_config(w["id"])
        if config and config.secrets:
            missing = [s for s in config.secrets if s not in os.environ]
            if missing:
                w["status"] = "missing_secret"
    conn.close()
    return workers


@app.get("/workers/{worker_id}")
def get_worker_detail(worker_id: str) -> Dict[str, Any]:
    worker = get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, worker_id, status, trigger_source, created_at FROM runs WHERE worker_id = ? ORDER BY created_at DESC LIMIT 10",
        (worker_id,)
    )
    recent_runs = [row_to_dict(r) for r in cursor.fetchall()]
    conn.close()

    worker["recent_runs"] = recent_runs
    return worker


@app.post("/workers/reload")
def reload_workers() -> Dict[str, Any]:
    workers = discover_workers()
    conn = get_db()
    cursor = conn.cursor()
    now = now_iso()
    for w in workers:
        cursor.execute(
            """
            INSERT INTO workers (id, name, description, config_json, status, trigger_type, runner, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                description=excluded.description,
                config_json=excluded.config_json,
                status=excluded.status,
                trigger_type=excluded.trigger_type,
                runner=excluded.runner,
                updated_at=?
            """,
            (w["id"], w["name"], w.get("description"), json.dumps(w["config"]), w["status"], w["trigger_type"], w["runner"], now, now, now)
        )
    conn.commit()
    conn.close()
    return {"status": "success", "workers_loaded": len(workers)}


# --- Runs ---

@app.post("/workers/{worker_id}/runs")
def create_worker_run(worker_id: str, payload: RunCreate) -> Dict[str, str]:
    worker = get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    run_id = create_run(worker_id, payload.inputs, payload.trigger_source)
    start_run(run_id, worker_id, payload.inputs)
    return {"run_id": run_id, "status": "running"}


@app.get("/runs")
def list_runs(worker_id: Optional[str] = None, status: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    query = """
        SELECT r.id, r.worker_id, w.name as worker_name, r.status, r.trigger_source, r.created_at, r.approval_status
        FROM runs r
        LEFT JOIN workers w ON r.worker_id = w.id
        WHERE 1=1
    """
    params = []
    if worker_id:
        query += " AND r.worker_id = ?"
        params.append(worker_id)
    if status:
        query += " AND r.status = ?"
        params.append(status)
    query += " ORDER BY r.created_at DESC LIMIT ?"
    params.append(limit)
    cursor.execute(query, tuple(params))
    rows = [row_to_dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


@app.get("/runs/{run_id}")
def get_run(run_id: str) -> Dict[str, Any]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM runs WHERE id = ?", (run_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Run not found")

    run = row_to_dict(row)
    run["input"] = json.loads(run.get("input_json") or "{}")
    run["output"] = json.loads(run.get("output_json") or "{}")
    del run["input_json"]
    del run["output_json"]

    cursor.execute("SELECT level, message, timestamp FROM logs WHERE run_id = ? ORDER BY timestamp", (run_id,))
    run["logs"] = [row_to_dict(r) for r in cursor.fetchall()]

    cursor.execute("SELECT * FROM artifacts WHERE run_id = ?", (run_id,))
    run["artifacts"] = [row_to_dict(r) for r in cursor.fetchall()]

    cursor.execute("SELECT * FROM approvals WHERE run_id = ?", (run_id,))
    approval = cursor.fetchone()
    run["approval"] = row_to_dict(approval) if approval else None

    conn.close()
    return run


@app.get("/runs/{run_id}/logs")
def get_run_logs(run_id: str) -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT level, message, timestamp FROM logs WHERE run_id = ? ORDER BY timestamp",
        (run_id,)
    )
    rows = [row_to_dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


# --- Approvals ---

@app.get("/approvals")
def list_approvals(status: str = "pending") -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT a.id, a.run_id, a.worker_id, w.name as worker_name, a.status, a.label, a.preview, a.created_at
        FROM approvals a
        LEFT JOIN workers w ON a.worker_id = w.id
        WHERE a.status = ?
        ORDER BY a.created_at DESC
        """,
        (status,)
    )
    rows = [row_to_dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


@app.post("/runs/{run_id}/approve")
def approve_run(run_id: str) -> Dict[str, str]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE approvals SET status = ?, decided_at = ? WHERE run_id = ?", ("approved", now_iso(), run_id))
    cursor.execute("UPDATE runs SET approval_status = ?, status = ? WHERE id = ?", ("approved", "approved", run_id))
    conn.commit()
    conn.close()
    add_log(run_id, "Run approved")
    return {"status": "approved"}


@app.post("/runs/{run_id}/reject")
def reject_run(run_id: str, payload: RejectRequest) -> Dict[str, str]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE approvals SET status = ?, decided_at = ? WHERE run_id = ?", ("rejected", now_iso(), run_id))
    cursor.execute("UPDATE runs SET approval_status = ?, status = ? WHERE id = ?", ("rejected", "rejected", run_id))
    conn.commit()
    conn.close()
    reason = payload.reason or "No reason provided"
    add_log(run_id, f"Run rejected: {reason}")
    return {"status": "rejected"}


# --- Secrets ---

@app.get("/secrets")
def list_secrets() -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM secrets ORDER BY name")
    db_secrets = {r["name"]: row_to_dict(r) for r in cursor.fetchall()}
    conn.close()

    # Discover secrets from all workers
    workers = discover_workers()
    all_secret_names = set()
    for w in workers:
        config = get_worker_config(w["id"])
        if config:
            all_secret_names.update(config.secrets)

    # Build response from .env
    result = []
    for name in sorted(all_secret_names):
        value = os.environ.get(name)
        status = "set" if value else "missing"
        # Find which workers use it
        used_by = []
        for w in workers:
            config = get_worker_config(w["id"])
            if config and name in config.secrets:
                used_by.append(w["name"])

        # Update or insert into DB
        conn = get_db()
        cursor = conn.cursor()
        now = now_iso()
        cursor.execute(
            """
            INSERT INTO secrets (name, status, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET status=excluded.status, updated_at=?
            """,
            (name, status, now, now, now)
        )
        conn.commit()
        conn.close()

        result.append({
            "name": name,
            "status": status,
            "last_used_at": db_secrets.get(name, {}).get("last_used_at"),
            "used_by": used_by,
        })
    return result


# --- Startup sync ---
@app.on_event("startup")
def startup():
    reload_workers()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
