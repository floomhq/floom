from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service  # noqa: E402
from models import RunStatus, WorkerStatus  # noqa: E402
from runner_sandbox.agent_driver import AgentDriver  # noqa: E402
from services.worker_serialize import _resolve_worker_status  # noqa: E402


def _status(last_run_status: RunStatus, error_code: str | None) -> WorkerStatus:
    return _resolve_worker_status(
        {"status": "healthy", "enabled": True, "archived": False},
        config=None,
        available_secret_names=set(),
        last_run_status=last_run_status,
        has_run=True,
        last_run_error_code=error_code,
    )


@pytest.mark.parametrize("error_code", ["agent_runtime_disconnected", "agent_runtime_error"])
def test_transient_infra_failure_does_not_downgrade_worker_health(error_code):
    assert _status(RunStatus.FAILED, error_code) == WorkerStatus.HEALTHY


@pytest.mark.parametrize("error_code", ["schema_violation", "missing_secret", "worker_reported_error"])
def test_genuine_failure_still_downgrades_worker_health(error_code):
    assert _status(RunStatus.FAILED, error_code) == WorkerStatus.NEEDS_ATTENTION


def test_successful_retry_as_latest_run_resolves_healthy():
    assert _status(RunStatus.COMPLETED, None) == WorkerStatus.HEALTHY


def test_httpx_disconnect_gets_distinct_retryable_infra_code(monkeypatch):
    driver = AgentDriver()

    def _raise(coro):
        coro.close()
        raise httpx.RemoteProtocolError("Server disconnected without sending a response")

    monkeypatch.setattr(driver, "_run_coro_sync", _raise)
    result = driver.run(
        worker_id="disconnect-worker",
        run_id="run-disconnect",
        inputs={},
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace-disconnect",
    )

    assert result.status == "error"
    assert result.error_code == "agent_runtime_disconnected"
    assert result.retryable is True
    decision = run_service._classify_retry_failure(
        error_code=result.error_code,
        error=result.error,
        result_retryable=result.retryable,
    )
    assert decision.retryable is True
    assert decision.reason == "transient_failure"
    assert run_service._is_infra_retry_error_code(result.error_code) is True


class _CommandResult:
    exit_code = 0
    stdout = "ok\n"
    stderr = ""


class _FakeFiles:
    def __init__(self):
        self.existing: set[str] = set()

    def make_dir(self, path):
        self.existing.add(path)

    def exists(self, path, **_kwargs):
        return path in self.existing


class _FakeCommands:
    def __init__(self):
        self.commands: list[str] = []

    def run(self, command, **_kwargs):
        self.commands.append(command)
        return _CommandResult()


class _FakeSandbox:
    create_calls = 0

    def __init__(self):
        self.files = _FakeFiles()
        self.commands = _FakeCommands()
        self.killed = False

    @classmethod
    def create(cls, **_kwargs):
        cls.create_calls += 1
        return cls()

    def kill(self):
        self.killed = True


def test_agent_run_command_uses_existing_warm_pool_when_enabled(monkeypatch, tmp_path):
    import runner_sandbox.e2b_driver as e2b_driver

    e2b_driver.clear_warm_pool()
    _FakeSandbox.create_calls = 0
    monkeypatch.setenv("E2B_API_KEY", "test-key")
    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")
    monkeypatch.setitem(sys.modules, "e2b", SimpleNamespace(Sandbox=_FakeSandbox))
    monkeypatch.setattr(e2b_driver, "_warm_pool_key", lambda **_kwargs: ("shared-key", None))
    monkeypatch.setattr(e2b_driver, "_e2b_template_for_run", lambda *_args, **_kwargs: (None, False))

    driver = AgentDriver()
    monkeypatch.setattr(driver, "_upload_tree", lambda *_args, **_kwargs: None)
    config = SimpleNamespace(
        id="agent-worker",
        runtime=SimpleNamespace(runner="e2b", command="python run.py", type="python"),
        contexts=[],
        connections=[],
        capabilities=None,
    )
    kwargs = {
        "cmd": "echo",
        "cmd_args": ["ok"],
        "cwd": tmp_path,
        "env": {},
        "timeout": 5,
        "bundle_dir": tmp_path,
        "input_dir": tmp_path,
        "output_dir": tmp_path,
        "secrets": {},
        "config": config,
        "user_id": "user-a",
        "log_fn": lambda *_args, **_kwargs: None,
    }

    first = driver._run_command_e2b(**kwargs)
    second = driver._run_command_e2b(**kwargs)

    assert first["ok"] is True
    assert second["ok"] is True
    assert _FakeSandbox.create_calls == 1
    assert e2b_driver.warm_pool_size() == 1
    assert e2b_driver.clear_warm_pool() == 1
