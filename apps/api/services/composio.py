"""Shared Composio integration helpers.

Small cross-route-group helpers for the Composio backend, kept in one service so
both the integrations catalog routes and the connections routes depend on it
rather than on each other. ``composio_client`` is imported lazily (purged + re-
imported by fixtures).
"""

from __future__ import annotations

from fastapi import HTTPException

import json
import logging
import os
import sqlite3
from typing import TYPE_CHECKING, Any, Dict, Optional

from core.config import _bootstrap_user_id

if TYPE_CHECKING:
    from models import WorkerConfig

logger = logging.getLogger("floom.api")


def _raise_composio_unavailable(exc: Exception) -> None:
    from composio_client import ComposioConfigurationError

    if isinstance(exc, ComposioConfigurationError):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    raise HTTPException(
        status_code=503,
        detail=(
            "Unable to reach the integration provider right now. "
            "Try again later or use an API-key connection if this app does not support OAuth."
        ),
    ) from exc



# ---------------------------------------------------------------------------
# Composio trigger lifecycle (enable/disable/sync on worker create/update/delete)
# ---------------------------------------------------------------------------
# These helpers reconcile a worker's declared composio trigger against the live
# Composio registration. composio_client / models / db are imported lazily
# (purged + re-imported by fixtures); core.config._bootstrap_user_id is a pure
# env-read helper. Moved verbatim from main.py.

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

def _resolve_composio_connection_id(connection_ref: str) -> str:
    """Resolve a trigger's connection reference to the raw Composio ``ca_*`` id.

    NEW-7 (2026-06-02): the raw ``ca_*`` id is no longer exposed via GET /connections,
    so the worker form now references a connection by its internal Floom UUID ``id``.
    Existing worker.yml files still carry the raw ``ca_*`` value, so this resolver is
    backward-compatible: a ``ca_*`` ref passes through unchanged, anything else is
    looked up by internal id. Composio's enable_trigger needs the raw ``ca_*`` value.
    """
    from db import get_repositories

    ref = (connection_ref or "").strip()
    if not ref or ref.startswith("ca_"):
        return ref
    try:
        repos = get_repositories()
        row = repos.connections.get(user_id=_bootstrap_user_id(), composio_id=ref)
        if row and row.get("composio_connection_id"):
            return str(row["composio_connection_id"])
    except Exception:
        logger.exception("Failed to resolve composio connection ref %s", ref)
    # Fall back to the original ref so the upstream call surfaces a clear error
    # instead of silently dropping the connection.
    return ref

def _composio_trigger_signature(config: "WorkerConfig") -> Optional[Dict[str, Any]]:
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

def _enable_composio_trigger(config: "WorkerConfig", worker_id: str) -> str:
    signature = _composio_trigger_signature(config)
    if not signature:
        raise RuntimeError(f"Worker {worker_id} does not declare trigger.composio")
    # #908: without the signing key the /composio-events receiver 503s every
    # delivery, so an enabled trigger is shipped-but-broken. Fail at enable
    # time with the operator fix instead of silently never firing.
    if not os.environ.get("COMPOSIO_WEBHOOK_SIGNING_KEY", "").strip():
        raise RuntimeError(
            f"Cannot enable Composio trigger for worker {worker_id}: "
            "COMPOSIO_WEBHOOK_SIGNING_KEY is not configured, so the "
            "/composio-events receiver rejects all deliveries (503). Set the "
            "env var from the Composio dashboard webhook settings and register "
            f"the webhook URL ({_composio_webhook_url()}) there, then retry."
        )
    try:
        from composio_client import enable_trigger
        return enable_trigger(
            signature["event"],
            _resolve_composio_connection_id(signature["connection_id"]),
            _composio_webhook_url(),
            signature["filters"],
        )
    except Exception as exc:
        logger.exception("Failed to enable Composio trigger for worker %s", worker_id)
        raise RuntimeError(f"Composio enable failed for worker {worker_id}: {exc}") from exc

def _sync_composio_registration(
    conn: sqlite3.Connection,
    worker_id: str,
    config: "WorkerConfig",
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
