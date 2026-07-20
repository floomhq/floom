from __future__ import annotations

import importlib
import queue
import sys
import threading
import time
import types
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _fresh_run_service(monkeypatch):
    sys.modules.pop("run_service", None)
    monkeypatch.setenv("WORKEROS_ASYNC_LOG_FLUSH", "1")
    monkeypatch.setenv("WORKEROS_LOG_FLUSH_BATCH_SIZE", "2")
    monkeypatch.setenv("WORKEROS_LOG_FLUSH_INTERVAL_SECONDS", "0.01")
    return importlib.import_module("run_service")


def test_failed_batch_is_retried_in_order_without_loss(monkeypatch):
    run_service = _fresh_run_service(monkeypatch)
    persisted = threading.Event()
    attempts: list[list[str]] = []

    def persist(batch, repos=None):
        messages = [item.message for item in batch]
        attempts.append(messages)
        if len(attempts) == 1:
            raise RuntimeError("temporary Supabase outage")
        persisted.set()

    monkeypatch.setattr(run_service, "_persist_log_batch", persist)
    repos = types.SimpleNamespace(runs=types.SimpleNamespace())

    try:
        run_service.add_log("run-1", "one", user_id="owner-1", repos=repos)
        run_service.add_log("run-1", "two", user_id="owner-1", repos=repos)
        assert persisted.wait(timeout=2), attempts
    finally:
        run_service.stop_log_flush_loop(timeout=2)

    assert attempts[:2] == [["one", "two"], ["one", "two"]]


def test_queue_full_spills_without_synchronous_repository_write(monkeypatch):
    run_service = _fresh_run_service(monkeypatch)
    run_service._log_queue = queue.Queue(maxsize=1)
    monkeypatch.setattr(run_service, "start_log_flush_loop", lambda: None)
    run_service._log_queue.put_nowait(
        run_service._PendingLog(
            "owner-1",
            "run-1",
            "info",
            "queued",
            "2026-07-19T00:00:00+00:00",
            None,
        )
    )
    sync_writes: list[str] = []

    class Runs:
        def add_log(self, **row):
            sync_writes.append(row["message"])

    run_service.add_log(
        "run-1",
        "spilled",
        user_id="owner-1",
        repos=types.SimpleNamespace(runs=Runs()),
    )

    assert sync_writes == []
    assert run_service._log_spool_pending_count() == 1


def test_terminal_status_is_persisted_before_drain_marker_is_queued(monkeypatch):
    run_service = _fresh_run_service(monkeypatch)
    calls: list[str] = []

    class Runs:
        def get(self, **_kwargs):
            return {"worker_id": "", "status": "running"}

        def update_status(self, **_kwargs):
            calls.append("status")

    def mark(*_args, **_kwargs):
        assert calls == ["status"]
        calls.append("marker")

    monkeypatch.setattr(run_service, "_enqueue_log_drain_marker", mark)
    monkeypatch.setattr(run_service, "_publish_sse", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "_emit_run_lifecycle_event", lambda *_args, **_kwargs: None)

    run_service.update_run_status(
        "run-1",
        run_service.RunStatus.COMPLETED.value,
        user_id="owner-1",
        repos=types.SimpleNamespace(runs=Runs()),
    )

    assert calls == ["status", "marker"]


def test_three_hundred_rows_enqueue_fast_and_persist_in_ordered_batches(monkeypatch):
    run_service = _fresh_run_service(monkeypatch)
    monkeypatch.setenv("WORKEROS_LOG_FLUSH_BATCH_SIZE", "100")
    batches: list[list[str]] = []
    ingest_ids: list[str] = []

    def persist(batch, repos=None):
        time.sleep(0.05)
        batches.append([item.message for item in batch])
        ingest_ids.extend(item.ingest_id for item in batch)

    monkeypatch.setattr(run_service, "_persist_log_batch", persist)
    repos = types.SimpleNamespace(runs=types.SimpleNamespace())

    started = time.monotonic()
    for index in range(300):
        run_service.add_log(
            "run-300",
            f"line-{index:03d}",
            user_id="owner-1",
            repos=repos,
        )
    run_service._enqueue_log_drain_marker(
        "run-300",
        user_id="owner-1",
        repos=repos,
    )
    enqueue_elapsed = time.monotonic() - started

    try:
        run_service.flush_run_logs(timeout=5)
    finally:
        run_service.stop_log_flush_loop(timeout=2)

    flattened = [message for batch in batches for message in batch]
    assert enqueue_elapsed < 0.5
    assert flattened[:-1] == [f"line-{index:03d}" for index in range(300)]
    assert flattened[-1] == run_service.RUN_LOG_DRAIN_MARKER_MESSAGE
    assert all(len(batch) <= 100 for batch in batches)
    assert ingest_ids == sorted(ingest_ids)
    assert len(set(ingest_ids)) == 301
