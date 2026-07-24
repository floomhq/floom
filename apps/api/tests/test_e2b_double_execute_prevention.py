"""Double-execute prevention on the E2B transport-retry path.

The failure this guards against: a transport drop (Server disconnected /
ConnectionTerminated / HPACK / reset / 503) after the worker command has
STARTED. The retry loop would re-run run.py from scratch in a fresh sandbox.
If the original sandbox is still running, its side effects (emails, CRM writes,
sends) run once in the original AND once in the retry -> a duplicate.

The fix: before ANY re-dispatch after a post-command-start drop, require PROOF
the original sandbox is terminated (bounded kill-and-verify). If it cannot be
confirmed dead, the run ends with the terminal ``sandbox_liveness_unconfirmed``
code instead of blind-retrying. Plus: refuse to spawn a sandbox for a run that
was cancel-requested while it sat in pre-sandbox setup (post-cancel create
race).
"""
from __future__ import annotations

import shutil
import sys
import types
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerConfig, WorkerRuntime, WorkerTrigger
from runner_sandbox import e2b_driver
from runner_sandbox.e2b_driver import E2BSandboxDriver


# --- fake e2b sandbox -------------------------------------------------------


class _Files:
    def __init__(self, host_root: Path):
        self.host_root = host_root
        self._files: dict[str, bytes] = {}

    def _host_path(self, sandbox_path: str) -> Path:
        return self.host_root / sandbox_path.removeprefix("/")

    def make_dir(self, sandbox_path: str, **_kwargs):
        self._host_path(sandbox_path).mkdir(parents=True, exist_ok=True)

    def write(self, sandbox_path: str, content, **_kwargs):
        if isinstance(content, str):
            content = content.encode("utf-8")
        data = bytes(content)
        self._files[sandbox_path] = data
        host_path = self._host_path(sandbox_path)
        host_path.parent.mkdir(parents=True, exist_ok=True)
        host_path.write_bytes(data)

    def exists(self, sandbox_path: str, **_kwargs):
        return sandbox_path in self._files or self._host_path(sandbox_path).exists()

    def read(self, sandbox_path: str, format="text", **_kwargs):
        if _ConfigurableSandbox.state.get("result_read_raises") and sandbox_path.endswith(
            "result.json"
        ):
            raise _TransientDrop("Request timed out")
        data = self._files.get(sandbox_path)
        if data is None:
            data = self._host_path(sandbox_path).read_bytes()  # raises if missing
        if format == "bytes":
            return bytearray(data)
        return data.decode("utf-8")


class _TransientDrop(RuntimeError):
    """A transport error the driver classifies as a transient drop."""


class _Commands:
    def __init__(self, sandbox: "_ConfigurableSandbox"):
        self.sandbox = sandbox
        self.run_calls: list[str] = []

    def run(self, command: str, **kwargs):
        self.run_calls.append(command)
        if "run.py" in command:
            state = self.sandbox.__class__.state
            state["worker_attempts"] += 1
            behaviour = state["command_behaviour"](state["worker_attempts"])
            if behaviour == "drop":
                raise _TransientDrop("Server disconnected")
            if behaviour == "boom":
                # Opaque, NON-transient failure (not a recognized transport drop
                # and not OOM) raised after the command started.
                raise RuntimeError("totally unexpected worker sandbox failure")
            # success: write result.json exactly as a real worker would
            self.sandbox.files.write(
                "/home/user/worker/result.json",
                '{"status": "success", "outputs": {"attempt": '
                + str(state["worker_attempts"])
                + '}, "artifacts": []}',
            )
            return types.SimpleNamespace(exit_code=0, stdout="", stderr="")
        # any non-worker command (installs, diagnostics) succeeds trivially
        return types.SimpleNamespace(exit_code=0, stdout="", stderr="")


class _ConfigurableSandbox:
    # class-level shared state so behaviour spans the per-attempt fresh sandboxes
    state: dict = {}

    def __init__(self):
        assert self.state.get("host_root") is not None
        self.files = _Files(self.state["host_root"])
        self.commands = _Commands(self)
        self.kill_calls: list[float | None] = []
        self.is_running_calls = 0
        self.state["instances"].append(self)

    @classmethod
    def create(cls, **_kwargs):
        cls.state["creates"] += 1
        behaviour = cls.state.get("create_behaviour")
        if behaviour is not None and behaviour(cls.state["creates"]) == "drop":
            # Transport drop DURING Sandbox.create (before any worker code runs).
            raise _TransientDrop("Server disconnected")
        return cls()

    def set_timeout(self, *_args, **_kwargs):
        return None

    def kill(self, request_timeout=None, **_kwargs):
        self.kill_calls.append(request_timeout)
        if self.state["kill_raises"]:
            raise _TransientDrop("Server disconnected")
        return None

    def is_running(self, request_timeout=None, **_kwargs):
        self.is_running_calls += 1
        return self.state["is_running"]


def _install(
    monkeypatch,
    tmp_path,
    *,
    command_behaviour,
    kill_raises,
    is_running=True,
    result_read_raises=False,
    create_behaviour=None,
):
    monkeypatch.setenv("E2B_API_KEY", "e2b-test")
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("WORKEROS_E2B_TRANSPORT_RETRY_BASE_SECONDS", "0")
    monkeypatch.setenv("WORKEROS_E2B_KILL_VERIFY_BUDGET_SECONDS", "0")
    monkeypatch.setenv("WORKEROS_E2B_CREATE_MIN_INTERVAL_SECONDS", "0")
    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=_ConfigurableSandbox))
    monkeypatch.setattr(e2b_driver, "WORKERS_DIR", tmp_path / "workers")
    monkeypatch.setattr(e2b_driver, "run_cancel_requested", lambda _run_id: False)
    _ConfigurableSandbox.state = {
        "host_root": tmp_path / "sandbox",
        "instances": [],
        "creates": 0,
        "worker_attempts": 0,
        "command_behaviour": command_behaviour,
        "kill_raises": kill_raises,
        "is_running": is_running,
        "result_read_raises": result_read_raises,
        "create_behaviour": create_behaviour,
    }


def _worker_config(tmp_path) -> WorkerConfig:
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir(exist_ok=True)
    (worker_dir / "requirements.txt").write_text("", encoding="utf-8")
    (worker_dir / "run.py").write_text("print('placeholder')\n", encoding="utf-8")
    return WorkerConfig(
        id="side-effect-worker",
        name="Side Effect Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="python311",
            command="python3 run.py",
            mode="pure-script",
            bundle_path=str(worker_dir),
        ),
        secrets=[],
        memory=False,
        outputs=[],
    )


def _cleanup():
    host_root = _ConfigurableSandbox.state.get("host_root")
    if host_root:
        shutil.rmtree(host_root, ignore_errors=True)


# --- tests ------------------------------------------------------------------


def test_drop_after_command_start_with_unconfirmed_kill_does_not_double_execute(tmp_path, monkeypatch):
    """Transport drops mid-command and the original sandbox CANNOT be confirmed
    dead -> NO second sandbox is spawned; the run ends terminally with
    ``sandbox_liveness_unconfirmed`` rather than blind-retrying."""
    _install(
        monkeypatch,
        tmp_path,
        command_behaviour=lambda _attempt: "drop",  # every attempt drops
        kill_raises=True,  # control plane also unreachable -> unconfirmed
        is_running=True,  # sandbox still reports running
    )
    config = _worker_config(tmp_path)
    logs: list[tuple[str, str]] = []

    result = E2BSandboxDriver().run(
        worker_id="side-effect-worker",
        run_id="run-unconfirmed",
        inputs={},
        secrets={},
        log_fn=lambda msg, level="info": logs.append((msg, level)),
        trace_id="trace-unconfirmed",
        timeout_seconds=30,
        config=config,
    )

    # The core assertion: the worker command ran exactly ONCE across the whole
    # lifecycle, and only ONE sandbox was ever created. No duplicate execution.
    assert _ConfigurableSandbox.state["creates"] == 1
    assert _ConfigurableSandbox.state["worker_attempts"] == 1
    assert result.status == "error"
    assert result.error_code == "sandbox_liveness_unconfirmed"
    assert result.retryable is False
    assert any(
        "not retrying" in msg.lower() and level == "error"
        for msg, level in logs
    )
    _cleanup()


def test_drop_after_command_start_even_confirmed_dead_does_not_retry(tmp_path, monkeypatch):
    """Transport drops mid-command and the original sandbox IS confirmed dead
    (kill succeeds). Confirmed-dead stops concurrent execution, but it cannot
    undo a side effect the worker may have already committed before the drop,
    and the platform does not enforce action-level idempotency. So we still
    refuse to auto-retry a run whose command started: NO second sandbox, and the
    run ends terminally with sandbox_liveness_unconfirmed."""
    _install(
        monkeypatch,
        tmp_path,
        command_behaviour=lambda _attempt: "drop",
        kill_raises=False,  # control-plane kill confirms termination...
    )
    config = _worker_config(tmp_path)

    result = E2BSandboxDriver().run(
        worker_id="side-effect-worker",
        run_id="run-confirmed-dead",
        inputs={},
        secrets={},
        log_fn=lambda *_a, **_k: None,
        trace_id="trace-confirmed-dead",
        timeout_seconds=30,
        config=config,
    )

    # ...yet a completed/in-flight worker is never re-run.
    assert _ConfigurableSandbox.state["creates"] == 1
    assert _ConfigurableSandbox.state["worker_attempts"] == 1
    assert result.status == "error"
    assert result.error_code == "sandbox_liveness_unconfirmed"
    assert result.retryable is False
    _cleanup()


def test_opaque_failure_after_command_start_is_non_retryable(tmp_path, monkeypatch):
    """An opaque, non-transient failure raised AFTER the worker command started
    must NOT come back as a retryable code (which run_service's retry scheduler
    would re-dispatch, re-running the worker). The driver's outer handler forces
    the non-retryable sandbox_liveness_unconfirmed terminal."""
    _install(
        monkeypatch,
        tmp_path,
        command_behaviour=lambda _attempt: "boom",  # opaque non-transient failure
        kill_raises=False,
    )
    config = _worker_config(tmp_path)

    result = E2BSandboxDriver().run(
        worker_id="side-effect-worker",
        run_id="run-opaque-boom",
        inputs={},
        secrets={},
        log_fn=lambda *_a, **_k: None,
        trace_id="trace-opaque-boom",
        timeout_seconds=30,
        config=config,
    )

    assert _ConfigurableSandbox.state["creates"] == 1
    assert _ConfigurableSandbox.state["worker_attempts"] == 1
    assert result.status == "error"
    assert result.error_code == "sandbox_liveness_unconfirmed"
    assert result.retryable is False
    _cleanup()


def test_drop_before_command_start_retries(tmp_path, monkeypatch):
    """A transport drop DURING Sandbox.create (before any worker code runs) has
    no side-effect risk, so retry is safe and preserved: a fresh sandbox is
    created and the worker runs to success."""
    _install(
        monkeypatch,
        tmp_path,
        command_behaviour=lambda _attempt: "success",
        kill_raises=False,
        create_behaviour=lambda create_count: "drop" if create_count == 1 else "ok",
    )
    config = _worker_config(tmp_path)

    result = E2BSandboxDriver().run(
        worker_id="side-effect-worker",
        run_id="run-create-drop",
        inputs={},
        secrets={},
        log_fn=lambda *_a, **_k: None,
        trace_id="trace-create-drop",
        timeout_seconds=30,
        config=config,
    )

    # First create dropped (no worker ran); retry created a second sandbox and
    # the worker ran exactly once.
    assert _ConfigurableSandbox.state["creates"] == 2
    assert _ConfigurableSandbox.state["worker_attempts"] == 1
    assert result.status == "success"
    assert result.outputs == {"attempt": 1}
    _cleanup()


def test_completed_worker_then_result_read_drop_does_not_retry(tmp_path, monkeypatch):
    """The worker command RETURNS successfully (exit 0, side effects done), then
    the result.json read drops transiently. Retrying would re-run the completed
    worker -> duplicate. So NO second sandbox is spawned and the run ends
    terminally rather than re-executing."""
    _install(
        monkeypatch,
        tmp_path,
        command_behaviour=lambda _attempt: "success",  # command returns exit 0
        kill_raises=False,  # kill confirms dead - but that must NOT greenlight retry
        result_read_raises=True,  # the post-completion result.json read drops
    )
    config = _worker_config(tmp_path)

    result = E2BSandboxDriver().run(
        worker_id="side-effect-worker",
        run_id="run-completed-read-drop",
        inputs={},
        secrets={},
        log_fn=lambda *_a, **_k: None,
        trace_id="trace-completed-read-drop",
        timeout_seconds=30,
        config=config,
    )

    # The worker ran exactly ONCE and no retry sandbox was created, even though
    # the sandbox was confirmed dead. A completed worker is never re-run.
    assert _ConfigurableSandbox.state["creates"] == 1
    assert _ConfigurableSandbox.state["worker_attempts"] == 1
    assert result.status == "error"
    assert result.error_code == "sandbox_liveness_unconfirmed"
    assert result.retryable is False
    _cleanup()


def test_cancel_during_setup_after_registration_aborts_before_command(tmp_path, monkeypatch):
    """Create-race second gate: cancel lands AFTER the pre-spawn check (e.g.
    during Sandbox.create/setup). The sandbox is created and registered but the
    worker command must NOT run."""
    _install(
        monkeypatch,
        tmp_path,
        command_behaviour=lambda _attempt: "success",
        kill_raises=False,
    )
    # False on the pre-spawn check, True on the pre-command re-check.
    calls = {"n": 0}

    def _cancel(_run_id):
        calls["n"] += 1
        return calls["n"] >= 2

    monkeypatch.setattr(e2b_driver, "run_cancel_requested", _cancel)
    config = _worker_config(tmp_path)

    result = E2BSandboxDriver().run(
        worker_id="side-effect-worker",
        run_id="run-cancel-during-setup",
        inputs={},
        secrets={},
        log_fn=lambda *_a, **_k: None,
        trace_id="trace-cancel-during-setup",
        timeout_seconds=30,
        config=config,
    )

    # Sandbox was created (cancel landed after the pre-spawn check) but the
    # worker command never ran, and the created sandbox was killed via finally.
    assert _ConfigurableSandbox.state["creates"] == 1
    assert _ConfigurableSandbox.state["worker_attempts"] == 0
    assert result.status == "cancelled"
    assert result.error_code == "user_cancel"
    assert _ConfigurableSandbox.state["instances"][0].kill_calls  # killed on the way out
    _cleanup()


def test_cancel_requested_before_spawn_does_not_create_sandbox(tmp_path, monkeypatch):
    """Post-cancel create race: a run cancel-requested while it sat in
    pre-sandbox setup must NOT spawn a sandbox (which the cancel sweep already
    believes it terminated)."""
    _install(
        monkeypatch,
        tmp_path,
        command_behaviour=lambda _attempt: "success",
        kill_raises=False,
    )
    # Simulate the cancel sweep having set cancel_requested before this thread
    # reached the spawn point.
    monkeypatch.setattr(e2b_driver, "run_cancel_requested", lambda _run_id: True)
    config = _worker_config(tmp_path)

    result = E2BSandboxDriver().run(
        worker_id="side-effect-worker",
        run_id="run-cancel-race",
        inputs={},
        secrets={},
        log_fn=lambda *_a, **_k: None,
        trace_id="trace-cancel-race",
        timeout_seconds=30,
        config=config,
    )

    assert _ConfigurableSandbox.state["creates"] == 0  # never spawned
    assert _ConfigurableSandbox.state["worker_attempts"] == 0
    assert result.status == "cancelled"
    assert result.error_code == "user_cancel"
    _cleanup()
