from __future__ import annotations

import logging
import os
import threading

from apps.api._engine import import_engine_module
from psycopg import Connection, connect


logger = logging.getLogger("workeros.cloud.scheduler")
SCHEDULER_ADVISORY_LOCK_KEY = 87452311
SCHEDULER_ACQUIRE_INITIAL_BACKOFF_SECONDS = 15.0
SCHEDULER_ACQUIRE_MAX_BACKOFF_SECONDS = 60.0
SCHEDULER_LOCK_HEALTHCHECK_SECONDS = 15.0

_state_lock = threading.RLock()
_lock_connection: Connection | None = None
_scheduler_started = False
_acquire_thread: threading.Thread | None = None
_stop_event: threading.Event | None = None


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


def _try_acquire_lock(connection: Connection) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(
            "select pg_try_advisory_lock(%s)",
            (SCHEDULER_ADVISORY_LOCK_KEY,),
        )
        row = cursor.fetchone()
    return bool(row[0]) if row else False


def _close_connection(connection: Connection | None) -> None:
    if connection is not None and not connection.closed:
        connection.close()


def _release_lock_connection(
    connection: Connection | None,
    *,
    warn_on_unlock_failure: bool = False,
) -> None:
    if connection is None:
        return
    try:
        if not connection.closed:
            try:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "select pg_advisory_unlock(%s)",
                        (SCHEDULER_ADVISORY_LOCK_KEY,),
                    )
                    row = cursor.fetchone()
                released = bool(row[0]) if row else False
                if warn_on_unlock_failure and not released:
                    logger.warning(
                        "Cloud scheduler advisory lock %s was not released cleanly.",
                        SCHEDULER_ADVISORY_LOCK_KEY,
                    )
            except Exception:
                logger.warning(
                    "Cloud scheduler advisory lock %s release failed; closing lock connection.",
                    SCHEDULER_ADVISORY_LOCK_KEY,
                    exc_info=True,
                )
    finally:
        _close_connection(connection)


def _lock_connection_alive(connection: Connection) -> bool:
    if connection.closed:
        return False
    try:
        with connection.cursor() as cursor:
            cursor.execute("select 1")
            cursor.fetchone()
    except Exception:
        return False
    return True


def _scheduler_acquire_loop(dsn: str, stop_event: threading.Event) -> None:
    global _lock_connection, _scheduler_started

    attempt = 0
    backoff = SCHEDULER_ACQUIRE_INITIAL_BACKOFF_SECONDS
    while not stop_event.is_set():
        attempt += 1
        connection: Connection | None = None
        try:
            connection = connect(dsn, autocommit=True)
            if not _try_acquire_lock(connection):
                _close_connection(connection)
                logger.warning(
                    "Cloud scheduler acquire: attempt %d, lock held elsewhere, retrying in %.0fs.",
                    attempt,
                    backoff,
                )
                stop_event.wait(backoff)
                backoff = min(backoff * 2, SCHEDULER_ACQUIRE_MAX_BACKOFF_SECONDS)
                continue

            scheduler = import_engine_module("scheduler")
            try:
                scheduler.start_scheduler()
            except Exception:
                logger.exception(
                    "Cloud scheduler start failed after acquiring advisory lock %s; releasing lock and retrying.",
                    SCHEDULER_ADVISORY_LOCK_KEY,
                )
                _release_lock_connection(connection)
                stop_event.wait(backoff)
                backoff = min(backoff * 2, SCHEDULER_ACQUIRE_MAX_BACKOFF_SECONDS)
                continue

            with _state_lock:
                if stop_event.is_set():
                    stop_after_start = True
                else:
                    _lock_connection = connection
                    _scheduler_started = True
                    stop_after_start = False
            if stop_after_start:
                try:
                    scheduler.stop_scheduler()
                finally:
                    _release_lock_connection(connection)
                return

            logger.info(
                "Cloud scheduler started (lock acquired after %d attempt%s) with advisory lock %s.",
                attempt,
                "" if attempt == 1 else "s",
                SCHEDULER_ADVISORY_LOCK_KEY,
            )

            while not stop_event.wait(SCHEDULER_LOCK_HEALTHCHECK_SECONDS):
                if _lock_connection_alive(connection):
                    continue
                logger.error(
                    "Cloud scheduler advisory lock connection died; stopping scheduler and retrying acquisition."
                )
                with _state_lock:
                    if _lock_connection is connection:
                        _lock_connection = None
                        _scheduler_started = False
                try:
                    scheduler.stop_scheduler()
                except Exception:
                    logger.exception(
                        "Cloud scheduler stop failed after advisory lock connection loss."
                    )
                finally:
                    _release_lock_connection(connection)
                backoff = SCHEDULER_ACQUIRE_INITIAL_BACKOFF_SECONDS
                break
        except Exception:
            logger.exception(
                "Cloud scheduler acquire loop failed on attempt %d; retrying in %.0fs.",
                attempt,
                backoff,
            )
            _close_connection(connection)
            stop_event.wait(backoff)
            backoff = min(backoff * 2, SCHEDULER_ACQUIRE_MAX_BACKOFF_SECONDS)


def start_cloud_scheduler() -> bool:
    global _acquire_thread, _stop_event
    dsn = _dsn()
    with _state_lock:
        if _scheduler_started:
            return True
        if _acquire_thread is not None and _acquire_thread.is_alive():
            return True
    import apps.api.startup  # noqa: F401

    stop_event = threading.Event()
    thread = threading.Thread(
        target=_scheduler_acquire_loop,
        args=(dsn, stop_event),
        name="cloud-scheduler-acquire",
        daemon=True,
    )
    with _state_lock:
        if _scheduler_started:
            return True
        if _acquire_thread is not None and _acquire_thread.is_alive():
            return True
        _stop_event = stop_event
        _acquire_thread = thread
    thread.start()
    logger.info(
        "Cloud scheduler acquisition supervisor started for advisory lock %s.",
        SCHEDULER_ADVISORY_LOCK_KEY,
    )
    return True


def stop_cloud_scheduler() -> None:
    global _lock_connection, _scheduler_started, _acquire_thread, _stop_event
    with _state_lock:
        thread = _acquire_thread
        stop_event = _stop_event
        connection = _lock_connection
        scheduler_started = _scheduler_started
        if stop_event is not None:
            stop_event.set()

    if scheduler_started:
        scheduler = import_engine_module("scheduler")
        try:
            scheduler.stop_scheduler()
        finally:
            with _state_lock:
                if _lock_connection is connection:
                    _lock_connection = None
                    _scheduler_started = False
            _release_lock_connection(connection, warn_on_unlock_failure=True)

    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=1.0)

    with _state_lock:
        if _acquire_thread is thread:
            _acquire_thread = None
        if _stop_event is stop_event:
            _stop_event = None
