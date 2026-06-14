"""Health checks + Prometheus metric formatting.

The per-dependency health probes (db, disk, OpenAI, E2B, Composio, scheduler),
the cached _run_health_checks aggregator, and the Prometheus label/value escapers.
Backs /health, /health/details, /healthz, /metrics, /system/metrics. Extracted
verbatim from main.py.

The platform OpenAI key check comes from services.secrets_env; db is lazy
(purged + re-imported by fixtures). The 60s health-result cache is module state
here and is cleared between tests by tests/conftest.py. Never imports main.
"""

from __future__ import annotations

import os
import shutil
import time
from datetime import datetime, timezone
from typing import Any, Dict

import requests

from services.secrets_env import _platform_openai_api_key

import logging

logger = logging.getLogger("floom.api")


_HEALTH_CACHE: Dict[str, Any] = {"checked_at": 0.0, "payload": None}


_HEALTH_CACHE_TTL_SECONDS = 60.0


def _health_check_db() -> Dict[str, Any]:
    from db import get_db

    with get_db() as conn:
        conn.execute("SELECT 1").fetchone()
    return {"ok": True}


_HEALTH_MIN_FREE_DISK_GB = float(os.environ.get("HEALTH_MIN_FREE_DISK_GB", "5") or "5")


def _health_check_disk() -> Dict[str, Any]:
    """Warn before the disk fills. Checks the filesystem holding the SQLite DB."""
    from db import DB_PATH

    db_path = str(DB_PATH)
    target = db_path if os.path.exists(db_path) else (os.path.dirname(db_path) or "/")
    usage = shutil.disk_usage(target if os.path.exists(target) else "/")
    free_gb = usage.free / (1024**3)
    ok = free_gb >= _HEALTH_MIN_FREE_DISK_GB
    result: Dict[str, Any] = {
        "ok": ok,
        "free_gb": round(free_gb, 2),
        "min_free_gb": _HEALTH_MIN_FREE_DISK_GB,
    }
    if not ok:
        result["error"] = f"low disk: {free_gb:.2f}GB free < {_HEALTH_MIN_FREE_DISK_GB}GB"
    return result


def _health_check_e2b() -> Dict[str, Any]:
    if not os.environ.get("E2B_API_KEY"):
        return {"ok": False, "error": "E2B_API_KEY missing"}
    import concurrent.futures

    from e2b import Sandbox

    def _list_sandboxes() -> None:
        Sandbox.list(limit=1).next_items()

    executor = concurrent.futures.ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="workeros-e2b-health",
    )
    try:
        future = executor.submit(_list_sandboxes)
        future.result(timeout=3)
    except concurrent.futures.TimeoutError:
        return {"ok": False, "error": "E2B health check timed out after 3s"}
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    return {"ok": True}


def _health_check_openai() -> Dict[str, Any]:
    key = _platform_openai_api_key()
    if not key:
        return {"ok": False, "error": "PLATFORM_OPENAI_API_KEY missing"}
    response = requests.get(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {key}"},
        timeout=3,
    )
    return {"ok": response.status_code == 200, "status_code": response.status_code}


def _health_check_composio() -> Dict[str, Any]:
    key = os.environ.get("COMPOSIO_API_KEY")
    if not key:
        return {"ok": False, "error": "COMPOSIO_API_KEY missing"}
    response = requests.get(
        "https://backend.composio.dev/api/v3/toolkits",
        headers={"x-api-key": key},
        params={"limit": 1},
        timeout=3,
    )
    return {"ok": response.status_code == 200, "status_code": response.status_code}


def _health_check_scheduler() -> Dict[str, Any]:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy != "local":
        return {"ok": True, "enabled": False, "deploy": deploy}
    try:
        from scheduler import scheduler_status
        return scheduler_status()
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:300]}


def _run_health_checks() -> Dict[str, Any]:
    now = time.monotonic()
    cached = _HEALTH_CACHE.get("payload")
    if cached is not None and now - float(_HEALTH_CACHE.get("checked_at") or 0.0) < _HEALTH_CACHE_TTL_SECONDS:
        return cached
    checks: Dict[str, Any] = {}
    for name, fn in {
        "db": _health_check_db,
        "disk": _health_check_disk,
        "e2b": _health_check_e2b,
        "openai": _health_check_openai,
        "composio": _health_check_composio,
        "scheduler": _health_check_scheduler,
    }.items():
        try:
            checks[name] = fn()
        except Exception as exc:
            checks[name] = {"ok": False, "error": str(exc)[:300]}
    payload = {
        "status": "ok" if all(check.get("ok") for check in checks.values()) else "degraded",
        "checks": checks,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    _HEALTH_CACHE["checked_at"] = now
    _HEALTH_CACHE["payload"] = payload
    return payload


def _prometheus_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _prometheus_label(worker_id: str, status: str | None = None) -> str:
    labels = [f'worker_id="{_prometheus_escape(worker_id)}"']
    if status is not None:
        labels.append(f'status="{_prometheus_escape(status)}"')
    return "{" + ",".join(labels) + "}"
