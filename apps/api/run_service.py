"""Run orchestration service with structured logging, observability, and secret scrubbing."""

import os
import uuid
import json
import threading
import re
import logging
from typing import Dict, Any, Callable, Optional
from datetime import datetime

from db import get_db, now_iso
from worker_registry import get_worker_config
from runner_local import run_worker_local
from runner_sandbox import get_driver as get_sandbox_driver
from models import (
    WorkerConfig,
    WorkerContract,
    WorkerResult,
    LogLevel,
    ApprovalStatus,
    RunStatus,
    parse_worker_manifest,
    worker_contract_to_worker_config,
)

logger = logging.getLogger("floom.run_service")

# ---------------------------------------------------------------------------
# Secret scrubbing
# ---------------------------------------------------------------------------

SECRET_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*[=:]\s*[^\s'\"]+"),
    re.compile(r"\b(?:sk|pk)_(?:live|test|proj|sec)_[a-zA-Z0-9_-]+\b"),
]


def scrub_secrets(text: str, secrets: Dict[str, str]) -> str:
    """Replace secret values with redacted markers in log messages."""
    if not text:
        return text
    for name, value in secrets.items():
        if value and len(value) > 3:
            text = text.replace(value, f"<REDACTED:{name}>")
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("<REDACTED>", text)
    return text


# ---------------------------------------------------------------------------
# Run lifecycle
# ---------------------------------------------------------------------------

def _load_worker_recipe(worker_id: str) -> Optional[tuple[WorkerConfig, Optional[Dict[str, Any]]]]:
    """Load the executable recipe from skill_versions plus instance row."""
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT w.id, w.trigger_type, w.cron_expr, w.cron_timezone, w.grants_json,
                       w.input_values_json, w.enabled, sv.manifest_json
                FROM workers w
                JOIN skill_versions sv ON sv.id = w.skill_version_id
                WHERE w.id = ?
                """,
                (worker_id,),
            ).fetchone()
        if row:
            manifest_raw = json.loads(row["manifest_json"] or "{}")
            parsed = parse_worker_manifest(manifest_raw)
            if isinstance(parsed, WorkerContract):
                config = worker_contract_to_worker_config(parsed, worker_id)
            else:
                config = parsed
            if row["trigger_type"]:
                config.trigger.type = row["trigger_type"]
            if row["cron_expr"]:
                config.trigger.cron = row["cron_expr"]
            return config, {
                "grants": json.loads(row["grants_json"] or "{}"),
                "input_values": json.loads(row["input_values_json"] or "{}"),
                "enabled": bool(row["enabled"]),
            }
    except Exception:
        logger.exception("Failed to load worker recipe from database for %s", worker_id)

    config = get_worker_config(worker_id)
    return (config, None) if config else None


def _get_worker_config_for_run(worker_id: str) -> Optional[WorkerConfig]:
    loaded = _load_worker_recipe(worker_id)
    return loaded[0] if loaded else None


def get_worker_config_for_run(worker_id: str) -> Optional[WorkerConfig]:
    """Return the DB-resolved worker recipe used for run execution."""
    return _get_worker_config_for_run(worker_id)


def _merge_instance_inputs(instance: Optional[Dict[str, Any]], inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Apply saved instance input defaults, with per-run inputs taking precedence."""
    if not instance:
        return dict(inputs)
    defaults = instance.get("input_values") or {}
    if not isinstance(defaults, dict):
        return dict(inputs)
    return {**defaults, **inputs}

def create_run(
    worker_id: str,
    inputs: Dict[str, Any],
    trigger_source: str = "manual",
) -> str:
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    loaded = _load_worker_recipe(worker_id)
    config = loaded[0] if loaded else None
    instance = loaded[1] if loaded else None
    if instance and not instance.get("enabled", True):
        raise ValueError(f"Worker {worker_id} is disabled")
    effective_inputs = _merge_instance_inputs(instance, inputs)
    approval_status = (
        ApprovalStatus.PENDING
        if config and config.approvals.required
        else ApprovalStatus.NOT_REQUIRED
    )
    # Determine runner from config (default to "local" for backward compat)
    runner = "local"
    if config and config.runtime:
        runner = config.runtime.runner or "local"
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO runs
                (id, worker_id, status, trigger_source, runner,
                 input_json, approval_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                worker_id,
                RunStatus.QUEUED.value,
                trigger_source,
                runner,
                json.dumps(effective_inputs),
                approval_status.value,
                now_iso(),
            ),
        )
    logger.info("Created run %s for worker %s (runner=%s)", run_id, worker_id, runner)
    return run_id


def add_log(
    run_id: str,
    message: str,
    level: str = "info",
    trace_id: Optional[str] = None,
    attributes: Optional[Dict[str, Any]] = None,
) -> None:
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO logs
                (run_id, level, message, timestamp, trace_id)
            VALUES (?, ?, ?, ?, ?)
            """,
            (run_id, level, message, now_iso(), trace_id),
        )


def update_run_status(
    run_id: str,
    status: str,
    output: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        updates = ["status = ?"]
        params: list[Any] = [status]

        if output is not None:
            updates.append("output_json = ?")
            params.append(json.dumps(output))
        if error is not None:
            updates.append("error = ?")
            params.append(error)
        if status == RunStatus.RUNNING.value:
            updates.append("started_at = ?")
            params.append(now_iso())
        if status in {
            RunStatus.COMPLETED.value,
            RunStatus.FAILED.value,
            RunStatus.PENDING_APPROVAL.value,
            RunStatus.APPROVED.value,
            RunStatus.REJECTED.value,
        }:
            updates.append("completed_at = ?")
            params.append(now_iso())
            # Compute duration if started_at exists
            cursor.execute("SELECT started_at FROM runs WHERE id = ?", (run_id,))
            row = cursor.fetchone()
            if row and row["started_at"]:
                try:
                    started = datetime.fromisoformat(row["started_at"])
                    completed = datetime.fromisoformat(now_iso())
                    duration_ms = int((completed - started).total_seconds() * 1000)
                    updates.append("duration_ms = ?")
                    params.append(duration_ms)
                except Exception:
                    pass

        params.append(run_id)
        cursor.execute(
            f"UPDATE runs SET {', '.join(updates)} WHERE id = ?",
            tuple(params),
        )


def create_approval(
    run_id: str,
    worker_id: str,
    label: str,
    preview: str,
) -> str:
    approval_id = f"approval_{uuid.uuid4().hex[:12]}"
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO approvals
                (id, run_id, worker_id, status, label, preview, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (approval_id, run_id, worker_id, ApprovalStatus.PENDING.value, label, preview, now_iso()),
        )
    return approval_id


def get_secrets_for_worker(worker_id: str) -> Dict[str, str]:
    config = _get_worker_config_for_run(worker_id)
    if not config:
        return {}
    secrets: Dict[str, str] = {}
    for name in config.secrets:
        value = os.environ.get(name)
        if value:
            secrets[name] = value
    return secrets


# ---------------------------------------------------------------------------
# Execution orchestration
# ---------------------------------------------------------------------------

def execute_run(run_id: str, worker_id: str, inputs: Dict[str, Any]) -> None:
    trace_id = f"trace_{uuid.uuid4().hex[:16]}"
    loaded = _load_worker_recipe(worker_id)
    config = loaded[0] if loaded else None
    instance = loaded[1] if loaded else None
    effective_inputs = _merge_instance_inputs(instance, inputs)

    def log_fn(msg: str, level: str = "info") -> None:
        secrets = get_secrets_for_worker(worker_id)
        safe_msg = scrub_secrets(msg, secrets)
        add_log(run_id, safe_msg, level=level, trace_id=trace_id)

    update_run_status(run_id, RunStatus.RUNNING.value)
    log_fn("Run started")
    log_fn("Validating inputs", level="debug")

    if not config:
        err = "Worker config not found"
        update_run_status(run_id, RunStatus.FAILED.value, error=err)
        log_fn(err, level="error")
        return

    if instance and not instance.get("enabled", True):
        err = "Worker is disabled"
        update_run_status(run_id, RunStatus.FAILED.value, error=err)
        log_fn(err, level="error")
        return

    # Validate required inputs
    for inp in config.inputs:
        if inp.required and (inp.name not in effective_inputs or effective_inputs[inp.name] in (None, "")):
            err = f"Missing required input: {inp.name}"
            update_run_status(run_id, RunStatus.FAILED.value, error=err)
            log_fn(err, level="error")
            return

    log_fn("Loading secrets", level="debug")
    secrets = get_secrets_for_worker(worker_id)
    missing = [s for s in config.secrets if s not in secrets]
    if missing:
        err = f"Missing secrets: {', '.join(missing)}"
        update_run_status(run_id, RunStatus.FAILED.value, error=err)
        log_fn(err, level="error")
        return

    # Dispatch to the appropriate sandbox driver based on worker config
    runner = "local"
    if config and config.runtime:
        runner = config.runtime.runner or "local"
    log_fn(f"Executing worker (runner={runner})", level="debug")
    driver = get_sandbox_driver(runner)
    result = driver.run(
        worker_id=worker_id,
        run_id=run_id,
        inputs=effective_inputs,
        secrets=secrets,
        log_fn=log_fn,
        trace_id=trace_id,
        config=config,
    )

    # Both "error" and "failed" terminal statuses map to a failed run
    if result.status in ("error", "failed"):
        update_run_status(run_id, RunStatus.FAILED.value, error=result.error)
        log_fn(f"Run failed: {result.error}", level="error")
        return

    outputs = result.outputs
    artifacts = result.artifacts

    # Store artifacts
    for art in artifacts:
        try:
            art_id = f"art_{uuid.uuid4().hex[:12]}"
            art_name = art.get("name", "artifact")
            art_type = art.get("type", "file")
            art_path = art.get("path", "")
            art_size = art.get("size_bytes", 0)
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO artifacts
                        (id, run_id, name, type, path, size_bytes, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (art_id, run_id, art_name, art_type, art_path, art_size, now_iso()),
                )
        except Exception as exc:
            logger.exception("Failed to store artifact")
            log_fn(f"Failed to store artifact: {exc}", level="warning")

    update_run_status(run_id, RunStatus.COMPLETED.value, output=outputs)
    log_fn("Output generated")

    if config.approvals.required:
        update_run_status(run_id, RunStatus.PENDING_APPROVAL.value, output=outputs)
        preview = ""
        if outputs:
            first_key = list(outputs.keys())[0]
            preview = str(outputs.get(first_key, ""))[:500]
        label = config.approvals.label or "Approve output"
        create_approval(run_id, worker_id, label, preview)
        log_fn("Waiting for approval")
    else:
        log_fn("Run completed")


def start_run(run_id: str, worker_id: str, inputs: Dict[str, Any]) -> None:
    thread = threading.Thread(
        target=execute_run,
        args=(run_id, worker_id, inputs),
        daemon=True,
    )
    thread.start()
