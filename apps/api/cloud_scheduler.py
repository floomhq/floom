from __future__ import annotations

import logging
import os

from apps.api._engine import import_engine_module
from psycopg import Connection, connect


logger = logging.getLogger("workeros.cloud.scheduler")
SCHEDULER_ADVISORY_LOCK_KEY = 87452311
_lock_connection: Connection | None = None
_scheduler_started = False


def _dsn() -> str:
    required = {
        "WORKEROS_CLOUD_DB_HOST": (os.environ.get("WORKEROS_CLOUD_DB_HOST") or "").strip(),
        "WORKEROS_CLOUD_DB_PORT": (os.environ.get("WORKEROS_CLOUD_DB_PORT") or "").strip(),
        "WORKEROS_CLOUD_DB_NAME": (os.environ.get("WORKEROS_CLOUD_DB_NAME") or "").strip(),
        "WORKEROS_CLOUD_DB_USER": (os.environ.get("WORKEROS_CLOUD_DB_USER") or "").strip(),
        "WORKEROS_CLOUD_DB_PASS": (os.environ.get("WORKEROS_CLOUD_DB_PASS") or "").strip(),
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise RuntimeError(
            "Cloud scheduler DB lock requires env vars: " + ", ".join(sorted(missing))
        )
    return (
        f"host={required['WORKEROS_CLOUD_DB_HOST']} "
        f"port={required['WORKEROS_CLOUD_DB_PORT']} "
        f"dbname={required['WORKEROS_CLOUD_DB_NAME']} "
        f"user={required['WORKEROS_CLOUD_DB_USER']} "
        f"password={required['WORKEROS_CLOUD_DB_PASS']} "
        "sslmode=require"
    )


def start_cloud_scheduler() -> bool:
    global _lock_connection, _scheduler_started
    if _scheduler_started:
        return True
    import apps.api.startup  # noqa: F401

    connection = connect(_dsn(), autocommit=True)
    with connection.cursor() as cursor:
        cursor.execute(
            "select pg_try_advisory_lock(%s)",
            (SCHEDULER_ADVISORY_LOCK_KEY,),
        )
        row = cursor.fetchone()
    acquired = bool(row[0]) if row else False
    if not acquired:
        connection.close()
        logger.warning(
            "Cloud scheduler advisory lock %s is already held; refusing to start a second scheduler instance.",
            SCHEDULER_ADVISORY_LOCK_KEY,
        )
        return False
    scheduler = import_engine_module("scheduler")
    try:
        scheduler.start_scheduler()
    except Exception:
        connection.close()
        raise
    _lock_connection = connection
    _scheduler_started = True
    logger.info(
        "Cloud scheduler started with advisory lock %s.",
        SCHEDULER_ADVISORY_LOCK_KEY,
    )
    return True


def stop_cloud_scheduler() -> None:
    global _lock_connection, _scheduler_started
    if not _scheduler_started:
        return
    scheduler = import_engine_module("scheduler")
    try:
        scheduler.stop_scheduler()
    finally:
        if _lock_connection is not None and not _lock_connection.closed:
            try:
                with _lock_connection.cursor() as cursor:
                    cursor.execute(
                        "select pg_advisory_unlock(%s)",
                        (SCHEDULER_ADVISORY_LOCK_KEY,),
                    )
                    row = cursor.fetchone()
                released = bool(row[0]) if row else False
                if not released:
                    logger.warning(
                        "Cloud scheduler advisory lock %s was not released cleanly.",
                        SCHEDULER_ADVISORY_LOCK_KEY,
                    )
            finally:
                _lock_connection.close()
        _lock_connection = None
        _scheduler_started = False
