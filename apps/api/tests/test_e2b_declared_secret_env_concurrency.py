from __future__ import annotations

import contextlib
import json
import os
import shlex
import shutil
import sqlite3
import subprocess
import sys
import types
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerConfig, WorkerRuntime, WorkerTrigger
from runner_sandbox import e2b_driver
from runner_sandbox.e2b_driver import E2BSandboxDriver


class _Files:
    def __init__(self, host_root: Path):
        self.host_root = host_root
        self.dirs: set[str] = set()
        self._files: dict[str, bytes] = {}

    def _host_path(self, sandbox_path: str) -> Path:
        return self.host_root / sandbox_path.removeprefix("/")

    def make_dir(self, sandbox_path: str):
        self.dirs.add(sandbox_path)
        self._host_path(sandbox_path).mkdir(parents=True, exist_ok=True)

    def write(self, sandbox_path: str, content):
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
        data = self._files.get(sandbox_path)
        if data is None:
            data = self._host_path(sandbox_path).read_bytes()
        if format == "bytes":
            return bytearray(data)
        return data.decode("utf-8")


class _Commands:
    def __init__(self, files: _Files):
        self.files = files
        self.run_calls: list[tuple[str, dict]] = []

    def run(self, command: str, **kwargs):
        self.run_calls.append((command, kwargs))
        cwd = self.files._host_path(kwargs.get("cwd") or "/home/user/worker")
        envs = kwargs.get("envs") or {}
        env = {**os.environ, **envs}
        if envs:
            assignments = " ".join(f"{key}={shlex.quote(str(value))}" for key, value in envs.items())
            command = f"{assignments} {command}"
        proc = subprocess.run(
            ["bash", "-lc", command],
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            timeout=float(kwargs.get("timeout") or 30),
            check=False,
        )
        if kwargs.get("on_stdout") and proc.stdout:
            kwargs["on_stdout"](proc.stdout)
        if kwargs.get("on_stderr") and proc.stderr:
            kwargs["on_stderr"](proc.stderr)
        result_path = cwd / "result.json"
        if result_path.exists():
            self.files.write("/home/user/worker/result.json", result_path.read_bytes())
        return types.SimpleNamespace(
            exit_code=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
        )


class _Sandbox:
    instances: list["_Sandbox"] = []
    last_create_kwargs: dict = {}
    host_root: Path | None = None

    def __init__(self):
        assert self.__class__.host_root is not None
        self.files = _Files(self.__class__.host_root)
        self.commands = _Commands(self.files)
        self.killed = False
        self.set_timeout_calls: list[int] = []
        self.__class__.instances.append(self)

    @classmethod
    def create(cls, **kwargs):
        cls.last_create_kwargs = kwargs
        return cls()

    def kill(self):
        self.killed = True

    def set_timeout(self, timeout: int):
        self.set_timeout_calls.append(timeout)


def _install_fake_e2b(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("E2B_API_KEY", "e2b-test")
    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=_Sandbox))
    monkeypatch.setattr(e2b_driver, "WORKERS_DIR", tmp_path / "workers")
    _Sandbox.instances = []
    _Sandbox.last_create_kwargs = {}
    _Sandbox.host_root = tmp_path / "sandbox"


def test_e2b_run_materializes_missing_worker_dir_from_db_files(tmp_path, monkeypatch):
    _install_fake_e2b(monkeypatch, tmp_path)

    worker_id = "fresh-cloud-worker"
    workers_root = tmp_path / "workers"
    worker_dir = workers_root / worker_id

    db_path = tmp_path / "workers.db"
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE skill_versions (
            id TEXT PRIMARY KEY,
            manifest_json TEXT
        );
        CREATE TABLE workers (
            id TEXT PRIMARY KEY,
            skill_version_id TEXT
        );
        """
    )
    conn.execute(
        "INSERT INTO skill_versions (id, manifest_json) VALUES (?, ?)",
        (
            "sv-fresh-cloud-worker",
            json.dumps(
                {
                    "_files": {
                        "worker.yml": (
                            "id: fresh-cloud-worker\n"
                            "name: Fresh Cloud Worker\n"
                            "runtime:\n"
                            "  type: python311\n"
                            "  command: python3 run.py\n"
                            "trigger:\n"
                            "  type: manual\n"
                        ),
                        "run.py": (
                            "import json\n"
                            "from pathlib import Path\n"
                            "Path('result.json').write_text(json.dumps({"
                            "'status': 'success', "
                            "'outputs': {'materialized': True}, "
                            "'artifacts': []"
                            "}))\n"
                        ),
                        "requirements.txt": "",
                    }
                }
            ),
        ),
    )
    conn.execute(
        "INSERT INTO workers (id, skill_version_id) VALUES (?, ?)",
        (worker_id, "sv-fresh-cloud-worker"),
    )
    conn.commit()

    @contextlib.contextmanager
    def _get_db():
        yield conn
        conn.commit()

    import db
    from services import worker_materialization

    monkeypatch.setattr(db, "get_db", _get_db)
    monkeypatch.setattr(worker_materialization, "WORKERS_DIR", workers_root)

    config = WorkerConfig(
        id=worker_id,
        name="Fresh Cloud Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="python311",
            command="python3 run.py",
            mode="pure-script",
        ),
        secrets=[],
        memory=False,
        outputs=[],
    )
    logs: list[tuple[str, str]] = []

    assert not worker_dir.exists()
    result = E2BSandboxDriver().run(
        worker_id=worker_id,
        run_id="run-fresh-cloud-worker",
        inputs={},
        secrets={},
        log_fn=lambda msg, level="info": logs.append((msg, level)),
        trace_id="trace-fresh-cloud-worker",
        timeout_seconds=30,
        config=config,
    )

    assert result.status == "success"
    assert result.outputs == {"materialized": True}
    assert (worker_dir / "run.py").is_file()
    assert (worker_dir / "worker.yml").is_file()
    assert any("Re-materialized worker files from DB" in msg for msg, _level in logs)
    assert all("Worker directory not found" not in msg for msg, _level in logs)

    if _Sandbox.host_root:
        shutil.rmtree(_Sandbox.host_root, ignore_errors=True)
    conn.close()


def test_e2b_run_py_gets_declared_secrets_for_concurrent_provider_calls(tmp_path, monkeypatch):
    _install_fake_e2b(monkeypatch, tmp_path)

    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "requirements.txt").write_text("", encoding="utf-8")
    (worker_dir / "run.py").write_text(
        """
import asyncio
import json
import os
import time

DELAY = 0.2
N = 4

async def provider_call(index):
    assert os.environ["AWS_ACCESS_KEY_ID"] == "aws-test-key"
    assert os.environ["AWS_SECRET_ACCESS_KEY"] == "aws-test-secret"
    await asyncio.sleep(DELAY)
    return index

async def main():
    start = time.perf_counter()
    results = await asyncio.gather(*(provider_call(i) for i in range(N)))
    elapsed = time.perf_counter() - start
    with open("result.json", "w", encoding="utf-8") as handle:
        json.dump({
            "status": "success",
            "outputs": {
                "elapsed": elapsed,
                "serial_seconds": DELAY * N,
                "results": results,
                "secret_seen": os.environ["AWS_ACCESS_KEY_ID"],
            },
            "artifacts": [],
        }, handle)

asyncio.run(main())
""".lstrip(),
        encoding="utf-8",
    )

    config = WorkerConfig(
        id="bedrock-fanout",
        name="Bedrock Fanout",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="python311",
            command="python3 run.py",
            mode="pure-script",
            bundle_path=str(worker_dir),
        ),
        secrets=["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        memory=False,
        outputs=[],
    )

    result = E2BSandboxDriver().run(
        worker_id="bedrock-fanout",
        run_id="run-bedrock-fanout",
        inputs={},
        secrets={
            "AWS_ACCESS_KEY_ID": "aws-test-key",
            "AWS_SECRET_ACCESS_KEY": "aws-test-secret",
        },
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace-bedrock-fanout",
        timeout_seconds=30,
        config=config,
    )

    assert result.status == "success"
    assert result.outputs["secret_seen"] == "aws-test-key"
    assert result.outputs["results"] == [0, 1, 2, 3]
    assert 0.18 <= result.outputs["elapsed"] < 0.45
    assert result.outputs["elapsed"] < result.outputs["serial_seconds"] * 0.75

    sandbox = _Sandbox.instances[-1]
    _command, kwargs = sandbox.commands.run_calls[-1]
    assert kwargs["envs"]["AWS_ACCESS_KEY_ID"] == "aws-test-key"
    assert kwargs["envs"]["AWS_SECRET_ACCESS_KEY"] == "aws-test-secret"
    assert kwargs["envs"]["WORKEROS_API_URL"]
    assert sandbox.killed is True

    if _Sandbox.host_root:
        shutil.rmtree(_Sandbox.host_root, ignore_errors=True)


def test_e2b_honors_3600_second_worker_timeout_without_900_clamp(tmp_path, monkeypatch):
    _install_fake_e2b(monkeypatch, tmp_path)
    assert e2b_driver._install_timeout_for_run(3600) == 3600

    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text(
        """
import json

with open("result.json", "w", encoding="utf-8") as handle:
    json.dump({"status": "success", "outputs": {"ok": True}, "artifacts": []}, handle)
""".lstrip(),
        encoding="utf-8",
    )

    config = WorkerConfig(
        id="long-worker",
        name="Long Worker",
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
    logs: list[tuple[str, str]] = []

    result = E2BSandboxDriver().run(
        worker_id="long-worker",
        run_id="run-long-worker",
        inputs={},
        secrets={},
        log_fn=lambda msg, level="info": logs.append((msg, level)),
        trace_id="trace-long-worker",
        timeout_seconds=3600,
        config=config,
    )

    assert result.status == "success"
    assert _Sandbox.last_create_kwargs["timeout"] == 3600

    sandbox = _Sandbox.instances[-1]
    assert sandbox.set_timeout_calls == [3600]
    command, kwargs = sandbox.commands.run_calls[-1]
    assert command.endswith("python3 run.py'")
    assert kwargs["timeout"] == 3600.0
    assert any("Capping sandbox lifetime at 3600s" in msg for msg, _level in logs)

    if _Sandbox.host_root:
        shutil.rmtree(_Sandbox.host_root, ignore_errors=True)


def test_e2b_python_template_skips_baked_requirements_install(tmp_path, monkeypatch):
    _install_fake_e2b(monkeypatch, tmp_path)
    monkeypatch.setenv("WORKEROS_E2B_PYTHON_TEMPLATE_ID", "tpl-python-fast")
    monkeypatch.setenv("WORKEROS_E2B_PYTHON_DEPS_BAKED", "1")

    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "requirements.txt").write_text("openai>=1.0.0\npython_dotenv>=1.0.0\n", encoding="utf-8")
    (worker_dir / "run.py").write_text(
        """
import json

with open("result.json", "w", encoding="utf-8") as handle:
    json.dump({"status": "success", "outputs": {"ok": True}, "artifacts": []}, handle)
""".lstrip(),
        encoding="utf-8",
    )

    config = WorkerConfig(
        id="templated-worker",
        name="Templated Worker",
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
    logs: list[tuple[str, str]] = []

    result = E2BSandboxDriver().run(
        worker_id="templated-worker",
        run_id="run-templated-worker",
        inputs={},
        secrets={},
        log_fn=lambda msg, level="info": logs.append((msg, level)),
        trace_id="trace-templated-worker",
        timeout_seconds=30,
        config=config,
    )

    assert result.status == "success"
    assert _Sandbox.last_create_kwargs["template"] == "tpl-python-fast"
    commands = [command for command, _kwargs in _Sandbox.instances[-1].commands.run_calls]
    assert not any("pip install -q -r" in command for command in commands)
    assert any("template marks Python deps as baked" in msg for msg, _level in logs)

    if _Sandbox.host_root:
        shutil.rmtree(_Sandbox.host_root, ignore_errors=True)


def test_e2b_python_template_installs_requirements_not_in_baked_template(tmp_path, monkeypatch):
    _install_fake_e2b(monkeypatch, tmp_path)
    monkeypatch.setenv("WORKEROS_E2B_PYTHON_TEMPLATE_ID", "tpl-python-fast")
    monkeypatch.setenv("WORKEROS_E2B_PYTHON_DEPS_BAKED", "1")
    monkeypatch.setenv("WORKEROS_E2B_PYTHON_BAKED_PACKAGES", "numpy")
    original_run = _Commands.run

    def run_with_successful_install(self, command: str, **kwargs):
        if "pip install -q -r" in command:
            self.run_calls.append((command, kwargs))
            return types.SimpleNamespace(exit_code=0, stdout="", stderr="")
        return original_run(self, command, **kwargs)

    monkeypatch.setattr(_Commands, "run", run_with_successful_install)

    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "requirements.txt").write_text("pip>=0\n", encoding="utf-8")
    (worker_dir / "run.py").write_text(
        """
import json

with open("result.json", "w", encoding="utf-8") as handle:
    json.dump({"status": "success", "outputs": {"ok": True}, "artifacts": []}, handle)
""".lstrip(),
        encoding="utf-8",
    )

    config = WorkerConfig(
        id="templated-worker",
        name="Templated Worker",
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
    logs: list[tuple[str, str]] = []

    result = E2BSandboxDriver().run(
        worker_id="templated-worker",
        run_id="run-templated-worker",
        inputs={},
        secrets={},
        log_fn=lambda msg, level="info": logs.append((msg, level)),
        trace_id="trace-templated-worker",
        timeout_seconds=30,
        config=config,
    )

    assert result.status == "success"
    commands = [command for command, _kwargs in _Sandbox.instances[-1].commands.run_calls]
    assert any("pip install -q -r" in command for command in commands)
    assert any("contains packages not in the baked package list" in msg for msg, _level in logs)

    if _Sandbox.host_root:
        shutil.rmtree(_Sandbox.host_root, ignore_errors=True)
