import os
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.path.join(str(ROOT), "apps", "api"))

from models import WorkerConfig, WorkerOutput, WorkerRuntime, WorkerTrigger
from runner_sandbox import e2b_driver
from runner_sandbox.e2b_driver import (
    E2BSandboxDriver,
    _install_timeout_for_run,
    _register_sandbox,
    _sandbox_lifetime_timeout,
    active_sandbox_count,
    cancel_sandbox,
)


class FakeFiles:
    def __init__(self, files: dict[str, bytes]):
        self._files = files

    def exists(self, path, **_kwargs):
        return path in self._files

    def read(self, path, format="text", **_kwargs):
        content = self._files[path]
        if format == "bytes":
            return bytearray(content)
        return content.decode("utf-8")


class FakeSandbox:
    def __init__(self, files: dict[str, bytes]):
        self.files = FakeFiles(files)


def _config(outputs):
    return WorkerConfig(
        id="artifact-test",
        name="Artifact Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        outputs=outputs,
    )


class FakeRunResult:
    exit_code = 0
    stdout = "stdout after exit\n"
    stderr = "stderr after exit\n"


class FakeCommandRunner:
    def __init__(self, files):
        self.files = files
        self.run_calls = []

    def run(self, command, **kwargs):
        self.run_calls.append((command, kwargs))
        if command == "python run.py":
            kwargs["on_stdout"]("live stdout\n")
            kwargs["on_stderr"]("live stderr\n")
            self.files.write(
                "/home/user/worker/result.json",
                '{"status":"success","outputs":{"ok":true},"artifacts":[]}',
            )
        return FakeRunResult()


class FakeFullSandbox:
    instances = []

    def __init__(self):
        self.files = FakeWritableFiles({})
        self.commands = FakeCommandRunner(self.files)
        self.killed = False
        FakeFullSandbox.instances.append(self)

    @classmethod
    def create(cls, **_kwargs):
        return cls()

    def kill(self):
        self.killed = True


class FakeWritableFiles(FakeFiles):
    def make_dir(self, _path):
        return None

    def write(self, path, content):
        if isinstance(content, str):
            content = content.encode("utf-8")
        self._files[path] = bytes(content)


class FakeOOMRunResult:
    exit_code = 137
    stdout = ""
    stderr = "Killed process 123 (python) total-vm: memory cgroup out of memory\n"


class FakeOOMCommandRunner:
    def __init__(self, files):
        self.files = files

    def run(self, _command, **_kwargs):
        return FakeOOMRunResult()


class FakeOOMSandbox:
    instances = []

    def __init__(self):
        self.files = FakeWritableFiles({})
        self.commands = FakeOOMCommandRunner(self.files)
        self.killed = False
        FakeOOMSandbox.instances.append(self)

    @classmethod
    def create(cls, **_kwargs):
        return cls()

    def kill(self):
        self.killed = True


def test_collects_declared_sandbox_artifacts(tmp_path, monkeypatch):
    monkeypatch.setattr(e2b_driver, "ARTIFACTS_DIR", tmp_path)
    config = _config([
        WorkerOutput(
            name="draft",
            label="Draft",
            type="markdown",
            kind="file",
            media_type="text/markdown",
            path="out/final_draft.md",
        )
    ])
    sandbox = FakeSandbox({"/home/user/worker/out/final_draft.md": b"# Draft\n"})
    outputs = {}

    artifacts = E2BSandboxDriver()._collect_sandbox_artifacts(
        sandbox=sandbox,
        workdir="/home/user/worker",
        run_id="run_declared",
        result_artifacts=[],
        config=config,
        outputs=outputs,
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert outputs == {"draft": "out/final_draft.md"}
    assert artifacts[0]["relative_path"] == "out/final_draft.md"
    assert artifacts[0]["type"] == "text/markdown"
    assert Path(artifacts[0]["path"]).read_text() == "# Draft\n"


def test_collects_worker_reported_binary_artifact(tmp_path, monkeypatch):
    monkeypatch.setattr(e2b_driver, "ARTIFACTS_DIR", tmp_path)
    pdf_bytes = b"%PDF-1.4\nbinary-ish\x00content"
    sandbox = FakeSandbox({"/home/user/worker/out/final_draft.pdf": pdf_bytes})

    artifacts = E2BSandboxDriver()._collect_sandbox_artifacts(
        sandbox=sandbox,
        workdir="/home/user/worker",
        run_id="run_binary",
        result_artifacts=[
            {
                "name": "out/final_draft.pdf",
                "type": "application/pdf",
                "path": "out/final_draft.pdf",
            }
        ],
        config=None,
        outputs={},
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert artifacts[0]["size_bytes"] == len(pdf_bytes)
    assert Path(artifacts[0]["path"]).read_bytes() == pdf_bytes


def test_skips_path_traversal_artifact(tmp_path, monkeypatch):
    monkeypatch.setattr(e2b_driver, "ARTIFACTS_DIR", tmp_path)
    sandbox = FakeSandbox({"/home/user/worker/../secret.txt": b"secret"})
    logs = []

    artifacts = E2BSandboxDriver()._collect_sandbox_artifacts(
        sandbox=sandbox,
        workdir="/home/user/worker",
        run_id="run_traversal",
        result_artifacts=[{"name": "bad", "path": "../secret.txt"}],
        config=None,
        outputs={},
        log_fn=lambda msg, level="info": logs.append((level, msg)),
    )

    assert artifacts == []
    assert not any(tmp_path.rglob("secret.txt"))
    assert any("Skipping invalid artifact path" in msg for _level, msg in logs)


def test_e2b_driver_streams_command_output_callbacks(tmp_path, monkeypatch):
    monkeypatch.setenv("E2B_API_KEY", "e2b-test")
    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=FakeFullSandbox))
    FakeFullSandbox.instances = []
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text("print('unused')\n")
    (worker_dir / "requirements.txt").write_text("")
    config = WorkerConfig(
        id="stream-test",
        name="Stream Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="python311",
            command="python run.py",
            mode="pure-script",
            bundle_path=str(worker_dir),
        ),
        outputs=[],
    )
    logs = []

    result = E2BSandboxDriver().run(
        worker_id="stream-test",
        run_id="run_stream",
        inputs={},
        secrets={},
        log_fn=lambda msg, level="info": logs.append((level, msg)),
        trace_id="trace_stream",
        timeout_seconds=300,
        config=config,
    )

    assert result.status == "success"
    assert result.outputs == {"ok": True}
    sandbox = FakeFullSandbox.instances[-1]
    command, kwargs = sandbox.commands.run_calls[-1]
    assert command == "python run.py"
    assert callable(kwargs["on_stdout"])
    assert callable(kwargs["on_stderr"])
    assert logs.count(("info", "[e2b] live stdout")) == 1
    assert logs.count(("warning", "[e2b] stderr: live stderr")) == 1
    assert not any("stdout after exit" in message for _level, message in logs)


def test_e2b_driver_maps_oom_exit_to_sandbox_oom(tmp_path, monkeypatch):
    monkeypatch.setenv("E2B_API_KEY", "e2b-test")
    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=FakeOOMSandbox))
    FakeOOMSandbox.instances = []
    with e2b_driver._active_sandboxes_lock:
        e2b_driver._active_sandboxes.clear()
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text("print('unused')\n")
    config = WorkerConfig(
        id="oom-test",
        name="OOM Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="python311",
            command="python run.py",
            mode="pure-script",
            bundle_path=str(worker_dir),
        ),
        outputs=[],
    )

    result = E2BSandboxDriver().run(
        worker_id="oom-test",
        run_id="run_oom",
        inputs={},
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace_oom",
        timeout_seconds=300,
        config=config,
    )

    assert result.status == "error"
    assert result.error_code == "sandbox_oom"
    assert FakeOOMSandbox.instances[-1].killed is True
    assert active_sandbox_count() == 0


def test_cancel_sandbox_kills_registered_sandbox():
    class KillableSandbox:
        def __init__(self):
            self.killed = False

        def kill(self):
            self.killed = True

    with e2b_driver._active_sandboxes_lock:
        e2b_driver._active_sandboxes.clear()
    sandbox = KillableSandbox()
    _register_sandbox("run_cancel", sandbox)

    assert active_sandbox_count() == 1
    assert cancel_sandbox("run_cancel", reason="test cancel") is True
    assert sandbox.killed is True
    assert active_sandbox_count() == 0
    assert cancel_sandbox("run_cancel", reason="second cancel") is False


def test_long_worker_timeout_extends_install_and_sandbox_lifetime():
    install_timeout = _install_timeout_for_run(1200)

    assert install_timeout == 900
    assert _sandbox_lifetime_timeout(1200, install_timeout) == 2160


def test_sandbox_lifetime_caps_at_e2b_one_hour_limit():
    install_timeout = _install_timeout_for_run(3600)

    assert install_timeout == 900
    assert _sandbox_lifetime_timeout(3600, install_timeout) == 3600
