from __future__ import annotations

import sys
import time
from types import SimpleNamespace

import pytest

from apps.api import cloud_scheduler


class _FakeCursor:
    def __init__(self, connection: "_FakeConnection"):
        self._connection = connection
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql: str, params=()):
        normalized = " ".join(sql.lower().split())
        self._connection.statements.append((normalized, params))
        if "pg_try_advisory_lock" in normalized:
            self._result = (self._connection.acquire_result,)
        elif "pg_advisory_unlock" in normalized:
            self._connection.unlocked = True
            self._result = (True,)
        elif normalized == "select 1":
            self._result = (1,)
        else:
            self._result = None

    def fetchone(self):
        return self._result


class _FakeConnection:
    def __init__(self, acquire_result: bool):
        self.acquire_result = acquire_result
        self.closed = False
        self.unlocked = False
        self.statements: list[tuple[str, tuple]] = []

    def cursor(self):
        return _FakeCursor(self)

    def close(self):
        self.closed = True


class _ConnectFactory:
    def __init__(self, acquire_results: list[bool]):
        self._acquire_results = acquire_results
        self.connections: list[_FakeConnection] = []

    def connect(self, _dsn: str, *, autocommit: bool):
        assert autocommit is True
        assert self._acquire_results, "unexpected scheduler DB connection"
        connection = _FakeConnection(self._acquire_results.pop(0))
        self.connections.append(connection)
        return connection


class _FakeScheduler:
    def __init__(self, start_failures: list[Exception] | None = None):
        self._start_failures = list(start_failures or [])
        self.start_calls = 0
        self.stop_calls = 0

    def start_scheduler(self):
        self.start_calls += 1
        if self._start_failures:
            raise self._start_failures.pop(0)

    def stop_scheduler(self):
        self.stop_calls += 1


@pytest.fixture(autouse=True)
def _scheduler_test_env(monkeypatch):
    _reset_scheduler_state()
    monkeypatch.setenv("WORKEROS_CLOUD_DB_HOST", "db.example.test")
    monkeypatch.setenv("WORKEROS_CLOUD_DB_PORT", "5432")
    monkeypatch.setenv("WORKEROS_CLOUD_DB_NAME", "workeros")
    monkeypatch.setenv("WORKEROS_CLOUD_DB_USER", "worker")
    monkeypatch.setenv("WORKEROS_CLOUD_DB_PASS", "secret")
    monkeypatch.setitem(sys.modules, "apps.api.startup", SimpleNamespace())
    monkeypatch.setattr(cloud_scheduler, "SCHEDULER_ACQUIRE_INITIAL_BACKOFF_SECONDS", 0.01)
    monkeypatch.setattr(cloud_scheduler, "SCHEDULER_ACQUIRE_MAX_BACKOFF_SECONDS", 0.01)
    monkeypatch.setattr(cloud_scheduler, "SCHEDULER_LOCK_HEALTHCHECK_SECONDS", 1.0)
    yield
    _reset_scheduler_state()


def _reset_scheduler_state() -> None:
    cloud_scheduler.stop_cloud_scheduler()
    with cloud_scheduler._state_lock:
        cloud_scheduler._lock_connection = None
        cloud_scheduler._scheduler_started = False
        cloud_scheduler._acquire_thread = None
        cloud_scheduler._stop_event = None


def _wait_until(predicate, *, timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("timed out waiting for scheduler supervisor")


def test_scheduler_acquire_succeeds_first_try(monkeypatch):
    connect_factory = _ConnectFactory([True])
    scheduler = _FakeScheduler()
    monkeypatch.setattr(cloud_scheduler, "connect", connect_factory.connect)
    monkeypatch.setattr(cloud_scheduler, "import_engine_module", lambda name: scheduler)

    assert cloud_scheduler.start_cloud_scheduler() is True

    _wait_until(lambda: scheduler.start_calls == 1 and cloud_scheduler._scheduler_started)
    assert scheduler.start_calls == 1
    assert len(connect_factory.connections) == 1
    assert cloud_scheduler._lock_connection is connect_factory.connections[0]
    assert not connect_factory.connections[0].closed


def test_scheduler_acquire_retries_until_lock_is_free(monkeypatch):
    connect_factory = _ConnectFactory([False, True])
    scheduler = _FakeScheduler()
    monkeypatch.setattr(cloud_scheduler, "connect", connect_factory.connect)
    monkeypatch.setattr(cloud_scheduler, "import_engine_module", lambda name: scheduler)

    assert cloud_scheduler.start_cloud_scheduler() is True

    _wait_until(lambda: scheduler.start_calls == 1 and cloud_scheduler._scheduler_started)
    assert len(connect_factory.connections) == 2
    assert connect_factory.connections[0].closed
    assert scheduler.start_calls == 1

    assert cloud_scheduler.start_cloud_scheduler() is True
    time.sleep(0.03)
    assert scheduler.start_calls == 1


def test_scheduler_start_failure_closes_lock_connection_and_retries(monkeypatch):
    connect_factory = _ConnectFactory([True, True])
    scheduler = _FakeScheduler(start_failures=[RuntimeError("boom")])
    monkeypatch.setattr(cloud_scheduler, "connect", connect_factory.connect)
    monkeypatch.setattr(cloud_scheduler, "import_engine_module", lambda name: scheduler)

    assert cloud_scheduler.start_cloud_scheduler() is True

    _wait_until(lambda: scheduler.start_calls == 2 and cloud_scheduler._scheduler_started)
    assert len(connect_factory.connections) == 2
    assert connect_factory.connections[0].unlocked
    assert connect_factory.connections[0].closed
    assert cloud_scheduler._lock_connection is connect_factory.connections[1]
    assert not connect_factory.connections[1].closed
