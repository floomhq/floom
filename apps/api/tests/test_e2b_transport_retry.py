from __future__ import annotations

import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpcore
import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerResult
from runner_sandbox import e2b_driver
from runner_sandbox.e2b_driver import (
    E2B_CREATE_REQUEST_TIMEOUT_SECONDS,
    E2BSandboxDriver,
    E2BTransportDroppedError,
    _create_sandbox_with_key_fallback,
    _is_transient_e2b_transport_error,
    _pace_sandbox_create,
    _read_result_json,
)


def test_e2b_sync_transport_pool_is_isolated_per_thread():
    from e2b.api.client_sync import get_envd_transport, get_transport
    from e2b.connection_config import ConnectionConfig

    config = ConnectionConfig(api_key="e2b-test")
    barrier = threading.Barrier(2)

    def transport_ids() -> tuple[int, int, int]:
        barrier.wait(timeout=5)
        api_transport = get_transport(config)
        envd_transport = get_envd_transport(config)
        return threading.get_ident(), id(api_transport.pool), id(envd_transport.pool)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _index: transport_ids(), range(2)))

    assert len({result[0] for result in results}) == 2
    assert len({result[1] for result in results}) == 2
    assert len({result[2] for result in results}) == 2


def test_transient_transport_classifier_matches_observed_errors():
    assert _is_transient_e2b_transport_error(RuntimeError("Server disconnected")) is True
    assert _is_transient_e2b_transport_error(RuntimeError("[Errno 32] Broken pipe")) is True
    assert _is_transient_e2b_transport_error(RuntimeError("StreamIDTooLowError: 2383 is lower than 2383")) is True
    assert _is_transient_e2b_transport_error(RuntimeError("deque mutated during iteration")) is True
    assert _is_transient_e2b_transport_error(RuntimeError("Request timed out")) is True
    assert _is_transient_e2b_transport_error(httpcore.ReadTimeout("read stalled")) is True

    class ConnectionTerminated(Exception):
        def __str__(self) -> str:
            return "<ConnectionTerminated error_code:1, last_stream_id:343>"

    assert _is_transient_e2b_transport_error(ConnectionTerminated()) is True
    assert _is_transient_e2b_transport_error(
        httpcore.LocalProtocolError(
            "Error decoding header block: Encoder exceeded max allowable table size"
        )
    ) is True
    assert _is_transient_e2b_transport_error(
        httpcore.LocalProtocolError("Invalid URL scheme")
    ) is False
    assert _is_transient_e2b_transport_error(RuntimeError("worker raised ValueError")) is False


class _RetryDriver(E2BSandboxDriver):
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def _run_in_sandbox(self, *_args, **_kwargs):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def test_transport_drop_retries_with_fresh_sandbox_before_failing_run(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_RETRY_BASE_SECONDS", "0")
    monkeypatch.setattr(e2b_driver, "run_cancel_requested", lambda _run_id: False)

    driver = _RetryDriver(
        [
            E2BTransportDroppedError(RuntimeError("Server disconnected"), phase="worker_command"),
            WorkerResult(status="success", outputs={"ok": True}),
        ]
    )
    logs: list[tuple[str, str]] = []

    result = driver.run(
        worker_id="worker-a",
        run_id="run-a",
        inputs={},
        secrets={},
        log_fn=lambda msg, level="info": logs.append((msg, level)),
        trace_id="trace-a",
    )

    assert driver.calls == 2
    assert result.status == "success"
    assert result.outputs == {"ok": True}
    assert any("retrying sandbox attempt 2/3" in msg for msg, _level in logs)


def test_raw_transient_sdk_exception_retries_before_sandbox_error(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_RETRY_BASE_SECONDS", "0")
    monkeypatch.setattr(e2b_driver, "run_cancel_requested", lambda _run_id: False)

    driver = _RetryDriver(
        [
            RuntimeError("StreamIDTooLowError: 2383 is lower than 2383"),
            WorkerResult(status="success", outputs={"retried": True}),
        ]
    )

    result = driver.run(
        worker_id="worker-a",
        run_id="run-a",
        inputs={},
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace-a",
    )

    assert driver.calls == 2
    assert result.status == "success"
    assert result.outputs == {"retried": True}


def test_transport_retry_exhaustion_has_distinct_terminal_code(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_MAX_ATTEMPTS", "2")
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_RETRY_BASE_SECONDS", "0")
    monkeypatch.setattr(e2b_driver, "run_cancel_requested", lambda _run_id: False)

    driver = _RetryDriver(
        [
            E2BTransportDroppedError(RuntimeError("Server disconnected"), phase="worker_command"),
            E2BTransportDroppedError(RuntimeError("[Errno 32] Broken pipe"), phase="worker_command"),
        ]
    )

    result = driver.run(
        worker_id="worker-a",
        run_id="run-a",
        inputs={},
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace-a",
    )

    assert driver.calls == 2
    assert result.status == "error"
    assert result.error_code == "sandbox_transport_retry_exhausted"
    assert result.retryable is False
    assert "before the worker produced a result" in (result.error or "")


class _CreateOnlyDriver(E2BSandboxDriver):
    def __init__(self, sandbox_cls):
        self.sandbox_cls = sandbox_cls

    def _run_in_sandbox(self, *_args, **kwargs):
        _create_sandbox_with_key_fallback(
            self.sandbox_cls,
            api_keys=["test-key"],
            timeout=60,
            envs={},
            log_fn=kwargs.get("log_fn") or (lambda *_args, **_kwargs: None),
        )
        return WorkerResult(status="success", outputs={"created": True})


def test_header_block_create_failure_retries_with_fresh_lifecycle(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_RETRY_BASE_SECONDS", "0")
    monkeypatch.setenv("WORKEROS_E2B_CREATE_MIN_INTERVAL_SECONDS", "0")
    monkeypatch.setattr(e2b_driver, "run_cancel_requested", lambda _run_id: False)

    class Sandbox:
        calls = 0

        @classmethod
        def create(cls, **_kwargs):
            cls.calls += 1
            if cls.calls == 1:
                raise httpcore.LocalProtocolError(
                    "Error decoding header block: Encoder exceeded max allowable table size"
                )
            return object()

    result = _CreateOnlyDriver(Sandbox).run(
        worker_id="worker-a",
        run_id="run-header-retry",
        inputs={},
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace-header-retry",
    )

    assert Sandbox.calls == 2
    assert result.status == "success"


def test_sandbox_create_has_bounded_request_timeout(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_CREATE_MIN_INTERVAL_SECONDS", "0")

    class Sandbox:
        create_kwargs = None

        @classmethod
        def create(cls, **kwargs):
            cls.create_kwargs = kwargs
            return object()

    _create_sandbox_with_key_fallback(
        Sandbox,
        api_keys=["test-key"],
        timeout=300,
        envs={},
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert Sandbox.create_kwargs["request_timeout"] == E2B_CREATE_REQUEST_TIMEOUT_SECONDS


def test_result_read_timeout_enters_transport_retry_path():
    class Files:
        @staticmethod
        def read(*_args, **_kwargs):
            raise RuntimeError("Request timed out")

    class Sandbox:
        files = Files()

    with pytest.raises(E2BTransportDroppedError) as exc_info:
        _read_result_json(
            Sandbox(),
            "/home/user/worker/result.json",
            lambda *_args, **_kwargs: None,
        )

    assert exc_info.value.phase == "result_read"


def test_header_block_create_failure_is_bounded_to_three_total_creates(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_RETRY_BASE_SECONDS", "0")
    monkeypatch.setenv("WORKEROS_E2B_CREATE_MIN_INTERVAL_SECONDS", "0")
    monkeypatch.setattr(e2b_driver, "run_cancel_requested", lambda _run_id: False)

    class Sandbox:
        calls = 0

        @classmethod
        def create(cls, **_kwargs):
            cls.calls += 1
            raise httpcore.LocalProtocolError(
                "Error decoding header block: Encoder exceeded max allowable table size"
            )

    result = _CreateOnlyDriver(Sandbox).run(
        worker_id="worker-a",
        run_id="run-header-exhausted",
        inputs={},
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace-header-exhausted",
    )

    assert Sandbox.calls == 3
    assert result.status == "error"
    assert result.error_code == "sandbox_transport_retry_exhausted"


def test_sandbox_create_pacing_waits_between_creates(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_CREATE_MIN_INTERVAL_SECONDS", "1.0")
    monkeypatch.setattr(e2b_driver, "_last_sandbox_create_at", 99.5)
    now = [100.0]
    sleeps: list[float] = []

    monkeypatch.setattr(e2b_driver.time, "monotonic", lambda: now[0])

    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(e2b_driver.time, "sleep", fake_sleep)

    _pace_sandbox_create(lambda *_args, **_kwargs: None)

    assert sleeps == [0.5]
    assert e2b_driver._last_sandbox_create_at == 100.5


# --- 2026-10-01: HPACK "Encoder exceeded max allowable table size" hardening ---


@pytest.fixture
def _fresh_e2b_transport_state(monkeypatch):
    monkeypatch.delenv("WORKEROS_E2B_HTTP2", raising=False)
    monkeypatch.setattr(e2b_driver, "_e2b_transport_configured", False)
    yield


def test_hpack_table_size_error_is_transient():
    assert _is_transient_e2b_transport_error(
        RuntimeError("Encoder exceeded max allowable table size")
    ) is True

    class InvalidTableSizeError(Exception):
        pass

    wrapped = RuntimeError("sandbox create failed")
    wrapped.__cause__ = InvalidTableSizeError("table size 8192 > 4096")
    assert _is_transient_e2b_transport_error(wrapped) is True


def test_configure_forces_http1_on_every_sdk_transport(_fresh_e2b_transport_state):
    from e2b.api import client_sync
    from e2b.connection_config import ConnectionConfig
    from e2b.sandbox_sync.commands import command as sync_command
    from e2b.sandbox_sync.filesystem import filesystem as sync_filesystem

    assert e2b_driver._configure_e2b_transport() is True
    config = ConnectionConfig(api_key="e2b-test")

    def check(_index):
        # Control-plane API client transport (Sandbox.create / kill / is_running).
        api_transport = client_sync.get_transport(config)
        # envd transports as bound by name inside the SDK modules that use them.
        command_transport = sync_command.get_envd_transport(config)
        fs_transport = sync_filesystem.get_envd_transport(config)
        return [t.pool._http2 for t in (api_transport, command_transport, fs_transport)]

    # Fresh threads build fresh transports, so the cached ones cannot mask the result.
    with ThreadPoolExecutor(max_workers=1) as executor:
        assert executor.submit(check, 0).result() == [False, False, False]
    # Idempotent: a second call does not double-wrap.
    assert e2b_driver._configure_e2b_transport() is True
    assert getattr(sync_command.get_envd_transport, "__wrapped__", None) is not None
    assert getattr(sync_command.get_envd_transport.__wrapped__, "_floom_http1", False) is False


def test_http2_can_be_restored_by_env(monkeypatch):
    monkeypatch.setattr(e2b_driver, "_e2b_transport_configured", False)
    monkeypatch.setenv("WORKEROS_E2B_HTTP2", "1")
    assert e2b_driver._configure_e2b_transport() is False


def test_reset_drops_cached_transports_for_a_fresh_connection():
    from e2b.api.client_sync import get_envd_transport, get_transport
    from e2b.connection_config import ConnectionConfig

    config = ConnectionConfig(api_key="e2b-test")

    def ids(_index):
        before = (get_transport(config), get_envd_transport(config))
        assert get_transport(config) is before[0]  # cached per thread
        e2b_driver._reset_e2b_transport_caches()
        after = (get_transport(config), get_envd_transport(config))
        return before[0] is after[0], before[1] is after[1]

    with ThreadPoolExecutor(max_workers=1) as executor:
        assert executor.submit(ids, 0).result() == (False, False)


def test_transport_drop_recycles_cached_transports_before_retry(monkeypatch):
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_RETRY_BASE_SECONDS", "0")
    monkeypatch.setattr(e2b_driver, "run_cancel_requested", lambda _run_id: False)
    resets: list[int] = []
    monkeypatch.setattr(e2b_driver, "_reset_e2b_transport_caches", lambda: resets.append(1))

    driver = _RetryDriver(
        [
            RuntimeError("Error decoding header block: Encoder exceeded max allowable table size"),
            WorkerResult(status="success", outputs={"ok": True}),
        ]
    )
    result = driver.run(
        worker_id="worker-hpack",
        run_id="run-hpack",
        inputs={},
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace-hpack",
    )

    assert result.status == "success"
    assert driver.calls == 2
    assert resets == [1]
