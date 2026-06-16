"""Tests for the in-process run-execution queue (S35 feature).

Verifies:
- Runs land as 'queued' when the execution semaphore is full
- The drain loop dispatches queued runs as slots free up
- Cancelling a queued run immediately fails it without spawning a sandbox
- On backend restart, queued runs are re-enqueued (not lost)
- The WORKEROS_MAX_CONCURRENT_RUNS env var controls the cap
"""
from __future__ import annotations

import importlib
import os
import sys
import time
import threading
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

API_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

AUTH_HEADER = {"x-floom-secret": "test-secret-queue"}


def _load_api(monkeypatch, tmp_path, *, max_concurrent: int = 3):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_SECRET", AUTH_HEADER["x-floom-secret"])
    monkeypatch.setenv("WORKEROS_MAX_CONCURRENT_RUNS", str(max_concurrent))
    monkeypatch.setenv("WORKEROS_RUN_CREATE_RATE_LIMIT", "100")
    monkeypatch.setenv("WORKEROS_RUN_CREATE_RATE_WINDOW_SECONDS", "60")
    monkeypatch.delenv("WORKEROS_RATE_LIMIT_DEV", raising=False)

    reset_prefixes = ("auth.", "db.")
    reset_exact = {
        "main",
        "auth",
        "db",
        "files",
        "models",
        "worker_registry",
        "run_service",
        "runner_utils",
        "composio_client",
        "scheduler",
    }
    for name in list(sys.modules):
        if name in reset_exact or name.startswith(reset_prefixes):
            sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    main.get_auth_provider.cache_clear()
    return main


def _insert_minimal_worker(
    main,
    worker_id: str,
    *,
    owner_id: str = "federico",
    visibility: str = "private",
) -> None:
    import json as _json
    now = main.now_iso()
    manifest = {
        "id": worker_id, "name": worker_id, "title": worker_id, "version": "0.1.0",
        "runtime": {"type": "python311", "runner": "e2b", "mode": "pure-script"},
        "inputs": [], "outputs": [], "secrets": [], "connections": [],
        "trigger": {"type": "manual"},
    }
    with main.get_db() as conn:
        conn.execute(
            """
            INSERT INTO skill_versions (id, name, version, manifest_json, created_at)
            VALUES (?, ?, '0.1.0', ?, ?)
            """,
            (f"sv_{worker_id}", worker_id, _json.dumps(manifest), now),
        )
        conn.execute(
            """
            INSERT INTO workers (id, skill_version_id, name, trigger_type, grants_json,
                                 input_values_json, enabled, created_at, owner_id, visibility)
            VALUES (?, ?, ?, 'manual', '{}', '{}', 1, ?, ?, ?)
            """,
            (worker_id, f"sv_{worker_id}", worker_id, now, owner_id, visibility),
        )


def _get_client(main):
    from fastapi.testclient import TestClient
    return TestClient(main.app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSemaphoreEnvVar:
    """WORKEROS_MAX_CONCURRENT_RUNS controls the semaphore cap."""

    def test_default_cap_is_18(self, monkeypatch):
        monkeypatch.delenv("WORKEROS_MAX_CONCURRENT_RUNS", raising=False)
        for name in list(sys.modules):
            if name == "run_service":
                sys.modules.pop(name, None)
        rs = importlib.import_module("run_service")
        assert rs._max_concurrent_runs() == 18

    def test_env_var_overrides_cap(self, monkeypatch):
        monkeypatch.setenv("WORKEROS_MAX_CONCURRENT_RUNS", "5")
        for name in list(sys.modules):
            if name == "run_service":
                sys.modules.pop(name, None)
        rs = importlib.import_module("run_service")
        assert rs._max_concurrent_runs() == 5


class TestQueueDB:
    """DB layer: get_queued and count_queued work correctly."""

    def test_get_queued_returns_fifo(self, tmp_path, monkeypatch):
        monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
        for name in list(sys.modules):
            if name in ("db", "db.sqlite") or name.startswith("db."):
                sys.modules.pop(name, None)

        import db
        db.init_db()
        from db.factory import get_repositories
        repos = get_repositories()

        # Insert a worker and two runs
        import json as _json
        from db._legacy_sqlite import get_db, now_iso
        now = now_iso()
        worker_id = "queue-test-worker"
        manifest = {"name": worker_id, "title": worker_id, "version": "0.1.0", "runtime": {"runner": "e2b"}, "inputs": [], "outputs": [], "trigger": {"type": "manual"}}
        with get_db() as conn:
            conn.execute(
                "INSERT INTO skill_versions (id, name, version, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
                ("sv1", "t1", "0.1.0", _json.dumps(manifest), now),
            )
            conn.execute(
                "INSERT INTO workers (id, skill_version_id, name, trigger_type, grants_json, input_values_json, enabled, created_at, owner_id) VALUES (?, ?, ?, 'manual', '{}', '{}', 1, ?, 'local')",
                (worker_id, "sv1", worker_id, now),
            )

        repos.runs.create(
            user_id="local",
            run_id="run_a",
            worker_id=worker_id,
            status="queued",
            trigger_source="test",
            runner="e2b",
            input_json={},
        )
        repos.runs.create(
            user_id="local",
            run_id="run_b",
            worker_id=worker_id,
            status="queued",
            trigger_source="test",
            runner="e2b",
            input_json={},
        )

        queued = repos.runs.get_queued(limit=10)
        assert len(queued) == 2
        # FIFO: run_a was inserted first
        assert queued[0]["run_id"] == "run_a"
        assert queued[1]["run_id"] == "run_b"

    def test_cancelled_runs_excluded_from_get_queued(self, tmp_path, monkeypatch):
        monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
        for name in list(sys.modules):
            if name in ("db", "db.sqlite") or name.startswith("db."):
                sys.modules.pop(name, None)

        import db
        db.init_db()
        from db.factory import get_repositories
        repos = get_repositories()

        import json as _json
        from db._legacy_sqlite import get_db, now_iso
        now = now_iso()
        worker_id = "cancel-test-worker"
        manifest2 = {"name": worker_id, "title": worker_id, "version": "0.1.0", "runtime": {"runner": "e2b"}, "inputs": [], "outputs": [], "trigger": {"type": "manual"}}
        with get_db() as conn:
            conn.execute(
                "INSERT INTO skill_versions (id, name, version, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
                ("sv2", "t2", "0.1.0", _json.dumps(manifest2), now),
            )
            conn.execute(
                "INSERT INTO workers (id, skill_version_id, name, trigger_type, grants_json, input_values_json, enabled, created_at, owner_id) VALUES (?, ?, ?, 'manual', '{}', '{}', 1, ?, 'local')",
                (worker_id, "sv2", worker_id, now),
            )

        repos.runs.create(
            user_id="local",
            run_id="run_keep",
            worker_id=worker_id,
            status="queued",
            trigger_source="test",
            runner="e2b",
            input_json={},
        )
        repos.runs.create(
            user_id="local",
            run_id="run_cancel",
            worker_id=worker_id,
            status="queued",
            trigger_source="test",
            runner="e2b",
            input_json={},
        )
        # Mark run_cancel as cancel_requested
        repos.runs.cancel(user_id="local", run_id="run_cancel", cancelled_at=now)

        queued = repos.runs.get_queued(limit=10)
        run_ids = [r["run_id"] for r in queued]
        assert "run_keep" in run_ids
        assert "run_cancel" not in run_ids

    def test_claim_queued_is_compare_and_set(self, tmp_path, monkeypatch):
        monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
        for name in list(sys.modules):
            if name in ("db", "db.sqlite") or name.startswith("db."):
                sys.modules.pop(name, None)

        import db
        db.init_db()
        from db.factory import get_repositories
        repos = get_repositories()

        import json as _json
        from db._legacy_sqlite import get_db, now_iso
        now = now_iso()
        worker_id = "claim-cas-worker"
        manifest = {"name": worker_id, "title": worker_id, "version": "0.1.0", "runtime": {"runner": "e2b"}, "inputs": [], "outputs": [], "trigger": {"type": "manual"}}
        with get_db() as conn:
            conn.execute(
                "INSERT INTO skill_versions (id, name, version, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
                ("sv-claim-cas", "claim-cas", "0.1.0", _json.dumps(manifest), now),
            )
            conn.execute(
                "INSERT INTO workers (id, skill_version_id, name, trigger_type, grants_json, input_values_json, enabled, created_at, owner_id) VALUES (?, ?, ?, 'manual', '{}', '{}', 1, ?, 'local')",
                (worker_id, "sv-claim-cas", worker_id, now),
            )

        repos.runs.create(
            user_id="local",
            run_id="run_claim_once",
            worker_id=worker_id,
            status="queued",
            trigger_source="test",
            runner="e2b",
            input_json={},
        )

        first = repos.runs.claim_queued(
            user_id="local",
            run_id="run_claim_once",
            started_at=now,
        )
        second = repos.runs.claim_queued(
            user_id="local",
            run_id="run_claim_once",
            started_at=now,
        )

        assert first is not None
        assert first["status"] == "running"
        assert second is None

    def test_count_queued(self, tmp_path, monkeypatch):
        monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
        for name in list(sys.modules):
            if name in ("db", "db.sqlite") or name.startswith("db."):
                sys.modules.pop(name, None)

        import db
        db.init_db()
        from db.factory import get_repositories
        repos = get_repositories()

        assert repos.runs.count_queued() == 0

        import json as _json
        from db._legacy_sqlite import get_db, now_iso
        now = now_iso()
        manifest3 = {"name": "t3", "title": "t3", "version": "0.1.0", "runtime": {"runner": "e2b"}, "inputs": [], "outputs": [], "trigger": {"type": "manual"}}
        with get_db() as conn:
            conn.execute(
                "INSERT INTO skill_versions (id, name, version, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
                ("sv3", "t3", "0.1.0", _json.dumps(manifest3), now),
            )
            conn.execute(
                "INSERT INTO workers (id, skill_version_id, name, trigger_type, grants_json, input_values_json, enabled, created_at, owner_id) VALUES (?, ?, ?, 'manual', '{}', '{}', 1, ?, 'local')",
                ("wkr3", "sv3", "t3", now),
            )

        repos.runs.create(user_id="local", run_id="rc1", worker_id="wkr3", status="queued", trigger_source="t", runner="e2b", input_json={})
        repos.runs.create(user_id="local", run_id="rc2", worker_id="wkr3", status="queued", trigger_source="t", runner="e2b", input_json={})

        assert repos.runs.count_queued() == 2


class TestCancelQueuedRun:
    """Cancel endpoint immediately fails queued runs without sandbox spawn."""

    def test_cancel_queued_run(self, tmp_path, monkeypatch):
        main = _load_api(monkeypatch, tmp_path, max_concurrent=1)
        _insert_minimal_worker(main, "q-cancel-worker")

        # Fill the semaphore so next run lands queued
        run_service = sys.modules.get("run_service")
        assert run_service is not None
        sem = run_service._get_semaphore()
        # Consume the 1 available slot
        sem.acquire()
        try:
            client = _get_client(main)
            resp = client.post(
                "/workers/q-cancel-worker/runs",
                json={"inputs": {}},
                headers=AUTH_HEADER,
            )
            assert resp.status_code == 200, resp.text
            run_id = resp.json()["run_id"]

            # Verify run is queued
            detail = client.get(f"/runs/{run_id}", headers=AUTH_HEADER)
            assert detail.status_code == 200
            assert detail.json()["status"] == "queued"

            # Cancel it
            cancel_resp = client.post(f"/runs/{run_id}/cancel", headers=AUTH_HEADER)
            assert cancel_resp.status_code == 200
            assert cancel_resp.json()["status"] == "cancelled"

            # Should be failed now
            detail2 = client.get(f"/runs/{run_id}", headers=AUTH_HEADER)
            assert detail2.status_code == 200
            data = detail2.json()
            assert data["status"] == "failed"
            assert data["error_code"] == "cancelled_queued"
        finally:
            sem.release()


class TestDrainLoopDbMethods:
    """get_queued and count_queued interact correctly with the semaphore logic."""

    def test_manual_workspace_visible_non_owner_run_is_queued_and_drained(
        self,
        tmp_path,
        monkeypatch,
    ):
        main = _load_api(monkeypatch, tmp_path, max_concurrent=2)
        _insert_minimal_worker(
            main,
            "shared-owner-worker",
            owner_id="worker-owner",
            visibility="workspace",
        )
        from auth import AuthContext
        from auth.context import set_current_auth_context

        async def auth_override():
            ctx = AuthContext(
                user_id="workspace-admin",
                email="admin@example.com",
                scopes=("admin",),
                role="admin",
                auth_method="session",
            )
            set_current_auth_context(ctx)
            return ctx

        main.app.dependency_overrides[main.get_auth_context] = auth_override

        client = _get_client(main)
        resp = client.post(
            "/workers/shared-owner-worker/runs",
            json={"inputs": {}, "trigger_source": "manual"},
            headers=AUTH_HEADER,
        )
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["run_id"]

        repos = main.get_repositories()
        owner_row = repos.runs.get(user_id="worker-owner", run_id=run_id)
        assert owner_row is not None
        assert owner_row["status"] == "queued"
        assert owner_row["started_at"] is None
        assert repos.runs.get(user_id="workspace-admin", run_id=run_id) is None

        run_service = sys.modules.get("run_service")
        assert run_service is not None
        dispatched: list[str] = []

        class DummyThread:
            def __init__(self, *args, **kwargs):
                self._args = kwargs.get("args", ())

            def start(self):
                dispatched.append(self._args[0])

        with patch.object(run_service.threading, "Thread", DummyThread):
            run_service._drain_one_batch()

        drained = repos.runs.get(user_id="worker-owner", run_id=run_id)
        assert drained is not None
        assert drained["status"] == "running"
        assert drained["started_at"] is not None
        assert dispatched == [run_id]

        with run_service._active_runs_lock:
            run_service._active_runs.clear()
        run_service._get_semaphore().release()

    def test_queued_run_has_position_info(self, tmp_path, monkeypatch):
        """Queued runs expose queue_position via GET /runs/:id."""
        main = _load_api(monkeypatch, tmp_path, max_concurrent=1)
        _insert_minimal_worker(main, "pos-worker")

        run_service = sys.modules.get("run_service")
        assert run_service is not None
        sem = run_service._get_semaphore()
        sem.acquire()
        try:
            client = _get_client(main)
            resp = client.post(
                "/workers/pos-worker/runs",
                json={"inputs": {}},
                headers=AUTH_HEADER,
            )
            assert resp.status_code == 200
            run_id = resp.json()["run_id"]

            detail = client.get(f"/runs/{run_id}", headers=AUTH_HEADER)
            assert detail.status_code == 200
            data = detail.json()
            assert data["status"] == "queued"
            # queue_position should be 1 (first in queue)
            assert data.get("queue_position") == 1
        finally:
            sem.release()

    def test_drain_loop_claims_run_before_thread_start(self, tmp_path, monkeypatch):
        main = _load_api(monkeypatch, tmp_path, max_concurrent=2)
        _insert_minimal_worker(main, "claim-worker")

        run_service = sys.modules.get("run_service")
        assert run_service is not None
        repos = main.get_repositories()
        run_id = run_service.create_run(
            "claim-worker",
            {},
            user_id="federico",
            repos=repos,
        )
        stale_queue_row = repos.runs.get_queued(limit=1)[0]
        dispatched: list[str] = []

        class DummyThread:
            def __init__(self, *args, **kwargs):
                self._args = kwargs.get("args", ())

            def start(self):
                dispatched.append(self._args[0])

        with patch.object(repos.runs, "get_queued", lambda *, limit=50: [stale_queue_row]):
            with patch.object(run_service.threading, "Thread", DummyThread):
                run_service._drain_one_batch()
                run_service._drain_one_batch()

        assert dispatched == [run_id]

        row = repos.runs.get(user_id="federico", run_id=run_id)
        assert row is not None
        assert row["status"] == "running"

        with run_service._active_runs_lock:
            run_service._active_runs.clear()
        run_service._get_semaphore().release()

    def test_drain_loop_releases_slot_when_claim_lost(self, tmp_path, monkeypatch):
        main = _load_api(monkeypatch, tmp_path, max_concurrent=1)
        _insert_minimal_worker(main, "lost-claim-worker")

        run_service = sys.modules.get("run_service")
        assert run_service is not None
        repos = main.get_repositories()
        run_id = run_service.create_run(
            "lost-claim-worker",
            {},
            user_id="federico",
            repos=repos,
        )
        stale_queue_row = repos.runs.get_queued(limit=1)[0]
        repos.runs.claim_queued(
            user_id="federico",
            run_id=run_id,
            started_at=main.now_iso(),
        )
        dispatched: list[str] = []

        class DummyThread:
            def __init__(self, *args, **kwargs):
                self._args = kwargs.get("args", ())

            def start(self):
                dispatched.append(self._args[0])

        with patch.object(repos.runs, "get_queued", lambda *, limit=50: [stale_queue_row]):
            with patch.object(run_service.threading, "Thread", DummyThread):
                run_service._drain_one_batch()

        assert dispatched == []
        sem = run_service._get_semaphore()
        assert sem.acquire(blocking=False) is True
        sem.release()

        row = repos.runs.get(user_id="federico", run_id=run_id)
        assert row is not None
        assert row["status"] == "running"

    def test_drain_loop_legacy_single_process_claims_run_once(self, tmp_path, monkeypatch):
        main = _load_api(monkeypatch, tmp_path, max_concurrent=2)
        _insert_minimal_worker(main, "claim-worker")

        run_service = sys.modules.get("run_service")
        assert run_service is not None
        repos = main.get_repositories()
        run_id = run_service.create_run(
            "claim-worker",
            {},
            user_id="federico",
            repos=repos,
        )
        dispatched: list[str] = []

        class DummyThread:
            def __init__(self, *args, **kwargs):
                self._args = kwargs.get("args", ())

            def start(self):
                dispatched.append(self._args[0])

        with patch.object(run_service.threading, "Thread", DummyThread):
            run_service._drain_one_batch()
            run_service._drain_one_batch()

        row = repos.runs.get(user_id="federico", run_id=run_id)
        assert row is not None
        assert row["status"] == "running"
        assert dispatched == [run_id]

        with run_service._active_runs_lock:
            run_service._active_runs.clear()
        run_service._get_semaphore().release()

    def test_drain_loop_unregisters_active_run_when_thread_start_raises(self, tmp_path, monkeypatch):
        main = _load_api(monkeypatch, tmp_path, max_concurrent=2)
        _insert_minimal_worker(main, "start-fail-worker")

        run_service = sys.modules.get("run_service")
        assert run_service is not None
        repos = main.get_repositories()
        run_id = run_service.create_run(
            "start-fail-worker",
            {},
            user_id="federico",
            repos=repos,
        )

        def fail_start(self):
            raise RuntimeError("thread start failed")

        with patch.object(run_service.threading.Thread, "start", fail_start):
            run_service._drain_one_batch()

        with run_service._active_runs_lock:
            assert run_id not in run_service._active_runs

        row = repos.runs.get(user_id="federico", run_id=run_id)
        assert row is not None
        assert row["status"] == "queued"

    def test_retryable_failure_schedules_retry_with_default_backoff(self, tmp_path, monkeypatch):
        main = _load_api(monkeypatch, tmp_path, max_concurrent=2)
        run_service = sys.modules.get("run_service")
        assert run_service is not None

        scheduled: list[dict[str, object]] = []
        monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))
        repos = types.SimpleNamespace(
            runs=types.SimpleNamespace(get_any=lambda run_id: {"retry_attempt": 0})
        )
        log_messages: list[tuple[str, str]] = []

        scheduled_ok = run_service._schedule_retry_for_failed_run(
            run_id="retry-run",
            worker_id="retry-worker",
            inputs={"foo": "bar"},
            owner_id="federico",
            config=None,
            result_retryable=True,
            repos=repos,
            log_fn=lambda message, level="info": log_messages.append((level, message)),
        )

        assert scheduled_ok is True
        assert scheduled and scheduled[0]["attempt"] == 1
        assert scheduled[0]["delay_seconds"] == 60
        assert any("retryable failure" in message for _level, message in log_messages)

    def test_permanent_failure_without_retry_config_does_not_schedule_retry(self, tmp_path, monkeypatch):
        main = _load_api(monkeypatch, tmp_path, max_concurrent=2)
        run_service = sys.modules.get("run_service")
        assert run_service is not None

        scheduled: list[dict[str, object]] = []
        monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))
        repos = types.SimpleNamespace(
            runs=types.SimpleNamespace(get_any=lambda run_id: {"retry_attempt": 0})
        )

        scheduled_ok = run_service._schedule_retry_for_failed_run(
            run_id="permanent-run",
            worker_id="permanent-worker",
            inputs={"foo": "bar"},
            owner_id="federico",
            config=None,
            result_retryable=False,
            repos=repos,
            log_fn=lambda *_args, **_kwargs: None,
        )

        assert scheduled_ok is False
        assert scheduled == []


class TestStartupReEnqueue:
    """Queued runs on startup are re-enqueued, not failed."""

    def test_re_enqueue_queued_runs_on_startup(self, tmp_path, monkeypatch):
        monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
        for name in list(sys.modules):
            if name in ("db", "db.sqlite", "run_service") or name.startswith("db."):
                sys.modules.pop(name, None)

        import db
        db.init_db()
        from db.factory import get_repositories
        repos = get_repositories()

        import json as _json
        from db._legacy_sqlite import get_db, now_iso
        now = now_iso()
        manifests = {"name": "ts", "title": "ts", "version": "0.1.0", "runtime": {"runner": "e2b"}, "inputs": [], "outputs": [], "trigger": {"type": "manual"}}
        with get_db() as conn:
            conn.execute(
                "INSERT INTO skill_versions (id, name, version, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
                ("svs", "ts", "0.1.0", _json.dumps(manifests), now),
            )
            conn.execute(
                "INSERT INTO workers (id, skill_version_id, name, trigger_type, grants_json, input_values_json, enabled, created_at, owner_id) VALUES (?, ?, ?, 'manual', '{}', '{}', 1, ?, 'local')",
                ("startup-wkr", "svs", "ts", now),
            )

        repos.runs.create(user_id="local", run_id="rq1", worker_id="startup-wkr", status="queued", trigger_source="t", runner="e2b", input_json={})
        repos.runs.create(user_id="local", run_id="rq2", worker_id="startup-wkr", status="queued", trigger_source="t", runner="e2b", input_json={})

        # Simulate startup
        for name in list(sys.modules):
            if name == "run_service":
                sys.modules.pop(name, None)
        import run_service

        count = run_service.re_enqueue_queued_runs_on_startup()
        assert count == 2

        # Runs should still be queued (not failed)
        queued = repos.runs.get_queued(limit=10)
        assert len(queued) == 2
        run_ids = [r["run_id"] for r in queued]
        assert "rq1" in run_ids
        assert "rq2" in run_ids

    def test_startup_reaper_fails_stale_running_and_does_not_touch_queued(self, tmp_path, monkeypatch):
        """Startup reaper fails stale running rows and never changes queued→failed."""
        monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
        for name in list(sys.modules):
            if name in ("db", "db.sqlite", "run_service") or name.startswith("db."):
                sys.modules.pop(name, None)

        import db
        db.init_db()
        from db.factory import get_repositories
        repos = get_repositories()

        import json as _json
        from db._legacy_sqlite import get_db, now_iso
        import datetime as _dt

        now = now_iso()
        stale = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(seconds=900)).isoformat()
        manifestf = {"name": "tf", "title": "tf", "version": "0.1.0", "runtime": {"runner": "e2b"}, "inputs": [], "outputs": [], "trigger": {"type": "manual"}}
        with get_db() as conn:
            conn.execute(
                "INSERT INTO skill_versions (id, name, version, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
                ("svsf", "tf", "0.1.0", _json.dumps(manifestf), now),
            )
            conn.execute(
                "INSERT INTO workers (id, skill_version_id, name, trigger_type, grants_json, input_values_json, enabled, created_at, owner_id) VALUES (?, ?, ?, 'manual', '{}', '{}', 1, ?, 'local')",
                ("fail-wkr", "svsf", "tf", now),
            )

        # One running, one queued
        repos.runs.create(user_id="local", run_id="rrun", worker_id="fail-wkr", status="running", started_at=stale, trigger_source="t", runner="e2b", input_json={})
        repos.runs.create(user_id="local", run_id="rqueue", worker_id="fail-wkr", status="queued", trigger_source="t", runner="e2b", input_json={})

        for name in list(sys.modules):
            if name == "run_service":
                sys.modules.pop(name, None)
        import run_service
        assert run_service.fail_interrupted_runs_on_startup(user_id="local") == 1

        # Running → failed; queued → still queued
        rrun = repos.runs.get(user_id="local", run_id="rrun")
        assert rrun["status"] == "failed"
        assert rrun["error_code"] == "run_abandoned_server_restart"

        rqueue = repos.runs.get(user_id="local", run_id="rqueue")
        assert rqueue["status"] == "queued"
