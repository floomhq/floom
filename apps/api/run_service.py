import os
import uuid
import json
import threading
from typing import Dict, Any, Callable, Optional
from datetime import datetime, timezone
from db import get_db, now_iso
from worker_registry import get_worker_config
from runner_local import run_worker_local

def create_run(worker_id: str, inputs: Dict[str, Any], trigger_source: str = "manual") -> str:
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    conn = get_db()
    cursor = conn.cursor()
    created_at = now_iso()
    cursor.execute(
        """
        INSERT INTO runs (id, worker_id, status, trigger_source, runner, input_json, approval_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (run_id, worker_id, "queued", trigger_source, "local", json.dumps(inputs), "not_required", created_at)
    )
    conn.commit()
    conn.close()
    return run_id


def add_log(run_id: str, message: str, level: str = "info"):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO logs (run_id, level, message, timestamp) VALUES (?, ?, ?, ?)",
        (run_id, level, message, now_iso())
    )
    conn.commit()
    conn.close()


def update_run_status(run_id: str, status: str, output: Optional[Dict[str, Any]] = None, error: Optional[str] = None):
    conn = get_db()
    cursor = conn.cursor()
    updates = ["status = ?"]
    params = [status]
    if output is not None:
        updates.append("output_json = ?")
        params.append(json.dumps(output))
    if error is not None:
        updates.append("error = ?")
        params.append(error)
    if status in ("completed", "failed", "pending_approval", "approved", "rejected"):
        updates.append("completed_at = ?")
        params.append(now_iso())
    params.append(run_id)
    cursor.execute(f"UPDATE runs SET {', '.join(updates)} WHERE id = ?", tuple(params))
    conn.commit()
    conn.close()


def create_approval(run_id: str, worker_id: str, label: str, preview: str):
    approval_id = f"approval_{uuid.uuid4().hex[:12]}"
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO approvals (id, run_id, worker_id, status, label, preview, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (approval_id, run_id, worker_id, "pending", label, preview, now_iso())
    )
    conn.commit()
    conn.close()
    return approval_id


def get_secrets_for_worker(worker_id: str) -> Dict[str, str]:
    config = get_worker_config(worker_id)
    if not config:
        return {}
    secrets = {}
    for name in config.secrets:
        value = os.environ.get(name)
        if value:
            secrets[name] = value
    return secrets


def execute_run(run_id: str, worker_id: str, inputs: Dict[str, Any]):
    def log_fn(msg: str, level: str = "info"):
        add_log(run_id, msg, level)

    update_run_status(run_id, "running")
    log_fn("Run started")
    log_fn("Validating inputs")

    config = get_worker_config(worker_id)
    if not config:
        update_run_status(run_id, "failed", error="Worker config not found")
        log_fn("Worker config not found", level="error")
        return

    # Validate required inputs
    for inp in config.inputs:
        if inp.required and (inp.name not in inputs or inputs[inp.name] in (None, "")):
            err = f"Missing required input: {inp.name}"
            update_run_status(run_id, "failed", error=err)
            log_fn(err, level="error")
            return

    log_fn("Loading secrets")
    secrets = get_secrets_for_worker(worker_id)
    missing = [s for s in config.secrets if s not in secrets]
    if missing:
        err = f"Missing secrets: {', '.join(missing)}"
        update_run_status(run_id, "failed", error=err)
        log_fn(err, level="error")
        return

    log_fn("Executing worker")
    result = run_worker_local(worker_id, run_id, inputs, secrets, log_fn)

    if result.get("status") == "error":
        update_run_status(run_id, "failed", error=result.get("error"))
        log_fn(f"Run failed: {result.get('error')}", level="error")
        return

    outputs = result.get("outputs", {})
    artifacts = result.get("artifacts", [])

    # Store artifacts
    for art in artifacts:
        # Simple artifact storage - in a real app we'd copy files
        pass

    update_run_status(run_id, "completed", output=outputs)
    log_fn("Output generated")

    # Check if approval is required
    if config.approvals.required:
        update_run_status(run_id, "pending_approval", output=outputs)
        preview = ""
        if outputs:
            first_key = list(outputs.keys())[0]
            preview = str(outputs.get(first_key, ""))[:500]
        label = config.approvals.label or "Approve output"
        create_approval(run_id, worker_id, label, preview)
        log_fn("Waiting for approval")
    else:
        log_fn("Run completed")


def start_run(run_id: str, worker_id: str, inputs: Dict[str, Any]):
    thread = threading.Thread(target=execute_run, args=(run_id, worker_id, inputs), daemon=True)
    thread.start()
