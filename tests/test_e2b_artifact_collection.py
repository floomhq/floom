import os
import shlex
import subprocess
import sys
import tarfile
import types
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.path.join(str(ROOT), "apps", "api"))

import contexts as contexts_module
from models import WorkerConfig, WorkerOutput, WorkerRuntime, WorkerTrigger
from runner_sandbox import e2b_driver
from runner_sandbox.e2b_driver import (
    E2BSandboxDriver,
    _configured_e2b_api_keys,
    _extract_context_tar,
    _install_timeout_for_run,
    _is_e2b_quota_or_rate_limit_error,
    _register_sandbox,
    _sandbox_api_url,
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
        if "python run.py" in command:  # #977: command may be env-scrub wrapped
            kwargs["on_stdout"]("live stdout\n")
            kwargs["on_stderr"]("live stderr\n")
            self.files.write(
                "/home/user/worker/result.json",
                '{"status":"success","outputs":{"ok":true},"artifacts":[]}',
            )
        return FakeRunResult()


class FakeFullSandbox:
    instances = []
    last_create_kwargs = {}

    def __init__(self):
        self.files = FakeWritableFiles({})
        self.commands = FakeCommandRunner(self.files)
        self.killed = False
        self.__class__.instances.append(self)

    @classmethod
    def create(cls, **kwargs):
        cls.last_create_kwargs = kwargs
        return cls()

    def kill(self):
        self.killed = True


class FakeQuotaError(Exception):
    status_code = 429


class FakeFallbackSandbox(FakeFullSandbox):
    instances = []
    last_create_kwargs = {}
    create_api_keys = []

    @classmethod
    def create(cls, **kwargs):
        cls.create_api_keys.append(kwargs["api_key"])
        cls.last_create_kwargs = kwargs
        if len(cls.create_api_keys) == 1:
            raise FakeQuotaError("rate limit exceeded")
        return cls()


class FakeBillingBlockedFallbackSandbox(FakeFullSandbox):
    instances = []
    last_create_kwargs = {}
    create_api_keys = []

    @classmethod
    def create(cls, **kwargs):
        cls.create_api_keys.append(kwargs["api_key"])
        cls.last_create_kwargs = kwargs
        if len(cls.create_api_keys) == 1:
            raise RuntimeError("403: team is blocked: missing payment method")
        return cls()


class FakeWritableFiles(FakeFiles):
    def __init__(self, files: dict[str, bytes]):
        super().__init__(files)
        self.dirs = set()

    def make_dir(self, _path):
        self.dirs.add(_path)
        return None

    def exists(self, path, **_kwargs):
        return path in self._files or path in self.dirs

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


class FakeRaisingOOMCommandError(Exception):
    pass


class FakeRaisingOOMCommandRunner:
    def __init__(self, files):
        self.files = files

    def run(self, _command, **_kwargs):
        raise FakeRaisingOOMCommandError(
            "Command exited with code 137 and error:\n"
            "memory cgroup out of memory\n"
        )


class FakeRaisingOOMSandbox:
    instances = []

    def __init__(self):
        self.files = FakeWritableFiles({})
        self.commands = FakeRaisingOOMCommandRunner(self.files)
        self.killed = False
        FakeRaisingOOMSandbox.instances.append(self)

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
    monkeypatch.setenv("WORKEROS_SANDBOX_API_URL", "https://origin-api.internal/")
    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=FakeFullSandbox))
    # Pin WORKERS_DIR so the bundle_path traversal guard (_worker_dir_for_run
    # rejects bundles outside WORKERS_DIR.parent) accepts the tmp worker dir.
    monkeypatch.setattr(e2b_driver, "WORKERS_DIR", tmp_path / "workers")
    FakeFullSandbox.instances = []
    FakeFullSandbox.last_create_kwargs = {}
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
    assert FakeFullSandbox.last_create_kwargs["envs"]["WORKEROS_API_URL"] == "https://origin-api.internal"
    command, kwargs = sandbox.commands.run_calls[-1]
    assert "python run.py" in command  # #977: env-scrub wrapped
    assert command.startswith("env -u ")
    assert kwargs["envs"]["WORKEROS_API_URL"] == "https://origin-api.internal"
    assert callable(kwargs["on_stdout"])
    assert callable(kwargs["on_stderr"])
    assert logs.count(("info", "[e2b] live stdout")) == 1
    assert logs.count(("warning", "[e2b] stderr: live stderr")) == 1
    assert not any("stdout after exit" in message for _level, message in logs)


def test_e2b_driver_falls_back_to_next_key_on_quota_error(tmp_path, monkeypatch):
    primary_key = "e2b-primary-test-key"
    fallback_key = "e2b-fallback-test-key"
    monkeypatch.setenv("E2B_API_KEY", primary_key)
    monkeypatch.setenv("E2B_API_KEY_FALLBACK", fallback_key)
    monkeypatch.delenv("E2B_API_KEYS", raising=False)
    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=FakeFallbackSandbox))
    monkeypatch.setattr(e2b_driver, "WORKERS_DIR", tmp_path / "workers")
    FakeFallbackSandbox.instances = []
    FakeFallbackSandbox.last_create_kwargs = {}
    FakeFallbackSandbox.create_api_keys = []
    with e2b_driver._active_sandboxes_lock:
        e2b_driver._active_sandboxes.clear()

    worker_dir = tmp_path / "workers" / "fallback-worker"
    worker_dir.mkdir(parents=True)
    (worker_dir / "run.py").write_text("print('ok')\n")
    logs = []

    result = E2BSandboxDriver().run(
        worker_id="fallback-worker",
        run_id="run_fallback",
        inputs={},
        secrets={},
        log_fn=lambda msg, level="info": logs.append((level, msg)),
        trace_id="trace-fallback",
        timeout_seconds=30,
    )

    assert result.status == "success"
    assert FakeFallbackSandbox.create_api_keys == [primary_key, fallback_key]
    assert FakeFallbackSandbox.last_create_kwargs["api_key"] == fallback_key
    assert active_sandbox_count() == 0
    joined_logs = "\n".join(msg for _level, msg in logs)
    assert "quota/billing/rate limit" in joined_logs
    assert primary_key not in joined_logs
    assert fallback_key not in joined_logs


def test_configured_e2b_api_keys_are_ordered_and_deduplicated(monkeypatch):
    monkeypatch.setenv("E2B_API_KEYS", "k1, k2")
    monkeypatch.setenv("E2B_API_KEY", "k2")
    monkeypatch.setenv("E2B_API_KEY_FALLBACK", "k3")

    assert _configured_e2b_api_keys() == ["k1", "k2", "k3"]


def test_e2b_quota_error_detection_handles_status_and_text():
    class PaymentRequired(Exception):
        status_code = 402

    class TeamBlocked(Exception):
        status_code = 403

    assert _is_e2b_quota_or_rate_limit_error(PaymentRequired("payment required"))
    assert _is_e2b_quota_or_rate_limit_error(RuntimeError("quota exhausted"))
    assert _is_e2b_quota_or_rate_limit_error(
        RuntimeError("403: team is blocked: missing payment method")
    )
    assert _is_e2b_quota_or_rate_limit_error(
        TeamBlocked("team is blocked: missing payment method")
    )
    assert not _is_e2b_quota_or_rate_limit_error(RuntimeError("network unreachable"))
    assert not _is_e2b_quota_or_rate_limit_error(TeamBlocked("forbidden: invalid scope"))


def test_e2b_driver_falls_back_on_billing_blocked_primary_key(tmp_path, monkeypatch):
    primary_key = "e2b-primary-billing-blocked"
    fallback_key = "e2b-fallback-billing-blocked"
    monkeypatch.setenv("E2B_API_KEY", primary_key)
    monkeypatch.setenv("E2B_API_KEY_FALLBACK", fallback_key)
    monkeypatch.delenv("E2B_API_KEYS", raising=False)
    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=FakeBillingBlockedFallbackSandbox))
    monkeypatch.setattr(e2b_driver, "WORKERS_DIR", tmp_path / "workers")
    FakeBillingBlockedFallbackSandbox.instances = []
    FakeBillingBlockedFallbackSandbox.last_create_kwargs = {}
    FakeBillingBlockedFallbackSandbox.create_api_keys = []
    with e2b_driver._active_sandboxes_lock:
        e2b_driver._active_sandboxes.clear()

    worker_dir = tmp_path / "workers" / "billing-fallback-worker"
    worker_dir.mkdir(parents=True)
    (worker_dir / "run.py").write_text("print('ok')\n")
    logs = []

    result = E2BSandboxDriver().run(
        worker_id="billing-fallback-worker",
        run_id="run_billing_fallback",
        inputs={},
        secrets={},
        log_fn=lambda msg, level="info": logs.append((level, msg)),
        trace_id="trace-billing-fallback",
        timeout_seconds=30,
    )

    assert result.status == "success"
    assert FakeBillingBlockedFallbackSandbox.create_api_keys == [primary_key, fallback_key]
    assert FakeBillingBlockedFallbackSandbox.last_create_kwargs["api_key"] == fallback_key
    joined_logs = "\n".join(msg for _level, msg in logs)
    assert "quota/billing/rate limit" in joined_logs


def test_sandbox_api_url_prefers_e2b_specific_origin(monkeypatch):
    for name in (
        "WORKEROS_SANDBOX_API_URL",
        "WORKEROS_E2B_API_URL",
        "WORKEROS_API_URL",
        "WORKEROS_API_BASE",
        "WORKERS_API_URL",
    ):
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setenv("WORKEROS_API_URL", "https://workers-api.floom.dev")
    monkeypatch.setenv("WORKEROS_SANDBOX_API_URL", "https://origin-api.internal/")

    assert _sandbox_api_url() == "https://origin-api.internal"


def test_sandbox_api_url_keeps_existing_public_fallbacks(monkeypatch):
    for name in (
        "WORKEROS_SANDBOX_API_URL",
        "WORKEROS_E2B_API_URL",
        "WORKEROS_API_URL",
        "WORKEROS_API_BASE",
        "WORKERS_API_URL",
    ):
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setenv("WORKERS_API_URL", "https://legacy-api.example.test/")

    assert _sandbox_api_url() == "https://legacy-api.example.test"


def test_uploads_declared_context_files_as_bytes(tmp_path, monkeypatch):
    contexts_root = tmp_path / "contexts"
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(e2b_driver, "CONTEXTS_DIR", contexts_root)
    local_context = contexts_root / "knowledge-base"
    local_context.mkdir(parents=True)
    (local_context / "faq.md").write_text("# FAQ\n")
    (local_context / "deck.pdf").write_bytes(b"%PDF-1.4\x00binary")
    sandbox = FakeFullSandbox()
    config = WorkerConfig(
        id="context-test",
        name="Context Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        contexts=["knowledge-base"],
        outputs=[],
    )

    err = E2BSandboxDriver()._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir="/home/user/worker",
        config=config,
        made_dirs={"/home/user/worker"},
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert err is None
    assert sandbox.files._files["/home/user/worker/context/knowledge-base/faq.md"] == b"# FAQ\n"
    assert sandbox.files._files["/home/user/worker/context/knowledge-base/deck.pdf"] == b"%PDF-1.4\x00binary"


def test_uploads_context_files_from_owner_scoped_root(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    contexts_root = tmp_path / "contexts"
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(e2b_driver, "CONTEXTS_DIR", contexts_root)
    owner_context = contexts_root / "user-a" / "knowledge-base"
    foreign_context = contexts_root / "user-b" / "knowledge-base"
    owner_context.mkdir(parents=True)
    foreign_context.mkdir(parents=True)
    (owner_context / "faq.md").write_text("# Owner FAQ\n")
    (foreign_context / "faq.md").write_text("# Foreign FAQ\n")
    sandbox = FakeFullSandbox()
    config = WorkerConfig(
        id="context-scope-test",
        name="Context Scope Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        contexts=["knowledge-base"],
        outputs=[],
    )

    err = E2BSandboxDriver()._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir="/home/user/worker",
        config=config,
        made_dirs={"/home/user/worker"},
        log_fn=lambda *_args, **_kwargs: None,
        user_id="user-a",
    )

    assert err is None
    assert sandbox.files._files["/home/user/worker/context/knowledge-base/faq.md"] == b"# Owner FAQ\n"


def test_uploads_git_context_by_cloning_into_sandbox(tmp_path, monkeypatch):
    contexts_root = tmp_path / "contexts"
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(e2b_driver, "CONTEXTS_DIR", contexts_root)
    sandbox = FakeFullSandbox()
    config = WorkerConfig(
        id="git-context-test",
        name="Git Context Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        contexts=[{
            "name": "external-notes",
            "source": "git+https://github.com/example/notes.git",
        }],
        outputs=[],
    )

    err = E2BSandboxDriver()._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir="/home/user/worker",
        config=config,
        made_dirs={"/home/user/worker"},
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert err is None
    assert sandbox.commands.run_calls == [(
        "git clone --depth 1 https://github.com/example/notes.git "
        "/home/user/worker/context/external-notes",
        {"timeout": 180},
    )]
    assert "/home/user/worker/context/external-notes" in sandbox.files.dirs
    assert not sandbox.files._files


def test_uploads_git_context_clones_real_repo_into_context_dir(tmp_path, monkeypatch):
    repo = tmp_path / "brain-pack-repo"
    repo.mkdir()
    (repo / "README.md").write_text("hello from git brain pack\n", encoding="utf-8")
    (repo / "notes").mkdir()
    (repo / "notes" / "facts.md").write_text("fact from cloned pack\n", encoding="utf-8")
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True, text=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test User"], check=True)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", "seed brain pack"], check=True, capture_output=True, text=True)

    contexts_root = tmp_path / "contexts"
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(e2b_driver, "CONTEXTS_DIR", contexts_root)

    class _HostMappedFiles:
        def __init__(self, root: Path):
            self.root = root
            self.dirs: set[str] = set()
            self._files: dict[str, bytes] = {}

        def host_path(self, sandbox_path: str) -> Path:
            return self.root / sandbox_path.removeprefix("/")

        def make_dir(self, sandbox_path: str):
            self.dirs.add(sandbox_path)
            self.host_path(sandbox_path).mkdir(parents=True, exist_ok=True)

    class _RealGitCloneCommands:
        def __init__(self, files: _HostMappedFiles):
            self.files = files
            self.run_calls = []

        def run(self, command: str, **kwargs):
            self.run_calls.append((command, kwargs))
            tokens = shlex.split(command)
            assert tokens[:4] == ["git", "clone", "--depth", "1"]
            assert len(tokens) == 6
            repo_url = tokens[4]
            sandbox_target = tokens[5]
            result = subprocess.run(
                ["git", "clone", "--depth", "1", repo_url, str(self.files.host_path(sandbox_target))],
                capture_output=True,
                text=True,
                timeout=30,
            )
            return types.SimpleNamespace(
                exit_code=result.returncode,
                stdout=result.stdout,
                stderr=result.stderr,
            )

    class _HostMappedSandbox:
        def __init__(self, root: Path):
            self.files = _HostMappedFiles(root)
            self.commands = _RealGitCloneCommands(self.files)

    sandbox = _HostMappedSandbox(tmp_path / "sandbox")
    config = WorkerConfig(
        id="git-context-real-clone-test",
        name="Git Context Real Clone Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        contexts=[{
            "name": "hello-world",
            "source": f"git+{repo.as_uri()}",
        }],
        outputs=[],
    )

    err = E2BSandboxDriver()._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir="/home/user/worker",
        config=config,
        made_dirs={"/home/user/worker"},
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert err is None
    context_dir = tmp_path / "sandbox" / "home" / "user" / "worker" / "context" / "hello-world"
    assert (context_dir / "README.md").read_text(encoding="utf-8") == "hello from git brain pack\n"
    assert (context_dir / "notes" / "facts.md").read_text(encoding="utf-8") == "fact from cloned pack\n"
    assert (context_dir / ".git").is_dir()
    assert sandbox.commands.run_calls == [(
        f"git clone --depth 1 {repo.as_uri()} /home/user/worker/context/hello-world",
        {"timeout": 180},
    )]


def _tar_bytes(entries: dict[str, bytes]) -> bytes:
    buffer = BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, content in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, BytesIO(content))
    return buffer.getvalue()


def test_persists_writeable_context_tar_safely(tmp_path, monkeypatch):
    contexts_root = tmp_path / "contexts"
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(e2b_driver, "CONTEXTS_DIR", contexts_root)
    target = contexts_root / "history"
    target.mkdir(parents=True)
    (target / "state.json").write_text('{"before": true}\n')

    raw_tar = _tar_bytes({"state.json": b'{"after": true}\n', "nested/log.bin": b"\x00\x01"})
    _extract_context_tar(raw_tar, target)

    assert (target / "state.json").read_text() == '{"after": true}\n'
    assert (target / "nested" / "log.bin").read_bytes() == b"\x00\x01"


def test_persists_writeable_context_tar_under_owner_scope(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    contexts_root = tmp_path / "contexts"
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(e2b_driver, "CONTEXTS_DIR", contexts_root)

    owner_target = contexts_root / "user-a" / "history"
    foreign_target = contexts_root / "user-b" / "history"
    owner_target.mkdir(parents=True)
    foreign_target.mkdir(parents=True)
    (owner_target / "state.json").write_text('{"owner": true}\n')
    (foreign_target / "state.json").write_text('{"foreign": true}\n')

    class _PersistFiles(FakeWritableFiles):
        def read(self, path, format="text", **_kwargs):
            content = self._files[path]
            if format == "bytes":
                return bytearray(content)
            return content.decode("utf-8")

    class _PersistCommands:
        def __init__(self, files):
            self.files = files

        def run(self, command, **_kwargs):
            tar_path = command.split("tar -cf ", 1)[1].split(" ", 1)[0]
            self.files.write(tar_path, _tar_bytes({"state.json": b'{"owner": false}\n'}))
            return types.SimpleNamespace(exit_code=0, stdout="", stderr="")

    class _PersistSandbox:
        def __init__(self):
            self.files = _PersistFiles({})
            self.files.dirs.add("/home/user/worker/context/history")
            self.commands = _PersistCommands(self.files)

    sandbox = _PersistSandbox()
    config = WorkerConfig(
        id="context-writeback-test",
        name="Context Writeback Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        contexts=[{"name": "history", "writeable": True}],
        outputs=[],
    )

    E2BSandboxDriver()._persist_writeable_contexts(
        sandbox=sandbox,
        workdir="/home/user/worker",
        run_id="run_context_writeback",
        config=config,
        log_fn=lambda *_args, **_kwargs: None,
        user_id="user-a",
    )

    assert (owner_target / "state.json").read_text() == '{"owner": false}\n'
    assert (foreign_target / "state.json").read_text() == '{"foreign": true}\n'


def test_writeable_context_round_trip_persists_sandbox_edits(tmp_path, monkeypatch):
    contexts_root = tmp_path / "contexts"
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(e2b_driver, "CONTEXTS_DIR", contexts_root)
    target = contexts_root / "history"
    target.mkdir(parents=True)
    (target / "state.json").write_text('{"before": true}\n')

    class _RoundTripCommands:
        def __init__(self, files):
            self.files = files

        def run(self, command, **_kwargs):
            tar_path = command.split("tar -cf ", 1)[1].split(" ", 1)[0]
            prefix = "/home/user/worker/context/history/"
            buffer = BytesIO()
            with tarfile.open(fileobj=buffer, mode="w") as archive:
                for path, content in self.files._files.items():
                    if not path.startswith(prefix) or path.endswith(".tar"):
                        continue
                    rel = path[len(prefix):]
                    if not rel:
                        continue
                    info = tarfile.TarInfo(rel)
                    info.size = len(content)
                    archive.addfile(info, BytesIO(content))
            self.files.write(tar_path, buffer.getvalue())
            return types.SimpleNamespace(exit_code=0, stdout="", stderr="")

    sandbox = FakeFullSandbox()
    sandbox.commands = _RoundTripCommands(sandbox.files)
    config = WorkerConfig(
        id="context-round-trip-test",
        name="Context Round Trip Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        contexts=[{"name": "history", "writeable": True}],
        outputs=[],
    )

    err = E2BSandboxDriver()._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir="/home/user/worker",
        config=config,
        made_dirs={"/home/user/worker"},
        log_fn=lambda *_args, **_kwargs: None,
    )
    assert err is None
    assert sandbox.files._files["/home/user/worker/context/history/state.json"] == b'{"before": true}\n'

    sandbox.files._files["/home/user/worker/context/history/state.json"] = b'{"after": true}\n'

    E2BSandboxDriver()._persist_writeable_contexts(
        sandbox=sandbox,
        workdir="/home/user/worker",
        run_id="run_context_round_trip",
        config=config,
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert (target / "state.json").read_text() == '{"after": true}\n'


def test_overlay_writeback_preserves_concurrent_external_context_files(tmp_path, monkeypatch):
    contexts_root = tmp_path / "contexts"
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(e2b_driver, "CONTEXTS_DIR", contexts_root)
    target = contexts_root / "history"
    target.mkdir(parents=True)
    (target / "feedback-memory.json").write_text('{"before": true}\n')

    class _RoundTripCommands:
        def __init__(self, files):
            self.files = files

        def run(self, command, **_kwargs):
            tar_path = command.split("tar -cf ", 1)[1].split(" ", 1)[0]
            prefix = "/home/user/worker/context/history/"
            buffer = BytesIO()
            with tarfile.open(fileobj=buffer, mode="w") as archive:
                for path, content in self.files._files.items():
                    if not path.startswith(prefix) or path.endswith(".tar"):
                        continue
                    rel = path[len(prefix):]
                    if not rel:
                        continue
                    info = tarfile.TarInfo(rel)
                    info.size = len(content)
                    archive.addfile(info, BytesIO(content))
            self.files.write(tar_path, buffer.getvalue())
            return types.SimpleNamespace(exit_code=0, stdout="", stderr="")

    sandbox = FakeFullSandbox()
    sandbox.commands = _RoundTripCommands(sandbox.files)
    config = WorkerConfig(
        id="context-overlay-writeback-test",
        name="Context Overlay Writeback Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        contexts=[{"name": "history", "writeable": True}],
        outputs=[],
    )

    err = E2BSandboxDriver()._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir="/home/user/worker",
        config=config,
        made_dirs={"/home/user/worker"},
        log_fn=lambda *_args, **_kwargs: None,
    )
    assert err is None
    assert sandbox.files._files["/home/user/worker/context/history/feedback-memory.json"] == b'{"before": true}\n'

    external_feedback = target / "feedback" / "raw" / "2026-06-14" / "external.json"
    external_feedback.parent.mkdir(parents=True)
    external_feedback.write_text('{"feedback": "do not erase"}\n')
    sandbox.files._files["/home/user/worker/context/history/feedback-memory.json"] = b'{"after": true}\n'

    E2BSandboxDriver()._persist_writeable_contexts(
        sandbox=sandbox,
        workdir="/home/user/worker",
        run_id="run_context_overlay_writeback",
        config=config,
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert (target / "feedback-memory.json").read_text() == '{"after": true}\n'
    assert external_feedback.read_text() == '{"feedback": "do not erase"}\n'


def test_e2b_driver_maps_oom_exit_to_sandbox_oom(tmp_path, monkeypatch):
    monkeypatch.setenv("E2B_API_KEY", "e2b-test")
    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=FakeOOMSandbox))
    monkeypatch.setattr(e2b_driver, "WORKERS_DIR", tmp_path / "workers")
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


def test_e2b_driver_maps_oom_command_exception_to_sandbox_oom(tmp_path, monkeypatch):
    monkeypatch.setenv("E2B_API_KEY", "e2b-test")
    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=FakeRaisingOOMSandbox))
    monkeypatch.setattr(e2b_driver, "WORKERS_DIR", tmp_path / "workers")
    FakeRaisingOOMSandbox.instances = []
    with e2b_driver._active_sandboxes_lock:
        e2b_driver._active_sandboxes.clear()
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text("print('unused')\n")
    config = WorkerConfig(
        id="oom-exception-test",
        name="OOM Exception Test",
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
        worker_id="oom-exception-test",
        run_id="run_oom_exception",
        inputs={},
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        trace_id="trace_oom_exception",
        timeout_seconds=300,
        config=config,
    )

    assert result.status == "error"
    assert result.error_code == "sandbox_oom"
    assert FakeRaisingOOMSandbox.instances[-1].killed is True
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

    assert install_timeout == 1200
    assert _sandbox_lifetime_timeout(1200, install_timeout) == 2460


def test_sandbox_lifetime_caps_at_e2b_one_hour_limit():
    install_timeout = _install_timeout_for_run(3600)

    assert install_timeout == 3600
    assert _sandbox_lifetime_timeout(3600, install_timeout) == 3600


# ---------------------------------------------------------------------------
# Tests for fix/e2b-context-hydration
# These prove that:
# 1. context_dir() calls the registered hydration hook when the dir is missing.
# 2. The driver uses _contexts_module.context_dir (module-level lookup) so any
#    runtime hook/patch on the contexts module is honoured, even if the original
#    function was imported by-name at module load.
# ---------------------------------------------------------------------------

def test_context_dir_calls_hydration_hook_when_dir_missing(tmp_path, monkeypatch):
    """context_dir() must call the registered hydration hook for absent dirs."""
    contexts_root = tmp_path / "contexts"
    contexts_root.mkdir()
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)

    hydration_calls = []

    def _fake_hook(scope, name, dest_dir):
        hydration_calls.append((scope, name, dest_dir))
        dest_dir.mkdir(parents=True, exist_ok=True)
        (dest_dir / "seed.txt").write_text("hydrated")

    # Register hook, call context_dir for an absent pack, check hook fired.
    contexts_module.set_context_hydration_hook(_fake_hook)
    try:
        result = contexts_module.context_dir("my-brain")
        assert result == contexts_root / "my-brain"
        assert len(hydration_calls) == 1
        scope, name, dest_dir = hydration_calls[0]
        assert name == "my-brain"
        assert dest_dir == result
    finally:
        contexts_module.set_context_hydration_hook(None)


def test_context_dir_skips_hydration_hook_when_dir_populated(tmp_path, monkeypatch):
    """context_dir() must NOT call the hook when the dir already has files."""
    contexts_root = tmp_path / "contexts"
    brain_dir = contexts_root / "my-brain"
    brain_dir.mkdir(parents=True)
    (brain_dir / "data.txt").write_text("already here")
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)

    hydration_calls = []

    def _fake_hook(scope, name, dest_dir):
        hydration_calls.append((scope, name, dest_dir))

    contexts_module.set_context_hydration_hook(_fake_hook)
    try:
        contexts_module.context_dir("my-brain")
        assert hydration_calls == [], "hook must not fire when dir is already populated"
    finally:
        contexts_module.set_context_hydration_hook(None)


def test_context_dir_hydration_hook_error_does_not_raise(tmp_path, monkeypatch):
    """A failing hydration hook must not propagate — context_dir() returns the path."""
    contexts_root = tmp_path / "contexts"
    contexts_root.mkdir()
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)

    def _exploding_hook(scope, name, dest_dir):
        raise RuntimeError("Storage unavailable")

    contexts_module.set_context_hydration_hook(_exploding_hook)
    try:
        result = contexts_module.context_dir("my-brain")
        assert result == contexts_root / "my-brain"
    finally:
        contexts_module.set_context_hydration_hook(None)


def test_driver_upload_contexts_uses_module_level_context_dir(tmp_path, monkeypatch):
    """_upload_contexts_to_sandbox must resolve context_dir via the module
    so a runtime hydration hook registered on contexts.context_dir is honoured
    even though e2b_driver imported the function before the hook was set.
    """
    contexts_root = tmp_path / "contexts"
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(e2b_driver, "CONTEXTS_DIR", contexts_root)

    hydration_calls = []

    def _fake_hook(scope, name, dest_dir):
        hydration_calls.append(name)
        # Simulate Storage hydration: write a file so the dir is populated.
        dest_dir.mkdir(parents=True, exist_ok=True)
        (dest_dir / "candidates.db").write_bytes(b"SQLITE_DATA")

    contexts_module.set_context_hydration_hook(_fake_hook)
    try:
        sandbox = FakeFullSandbox()
        config = WorkerConfig(
            id="hydrate-test",
            name="Hydrate Test",
            trigger=WorkerTrigger(type="manual"),
            runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
            contexts=["novasearch-candidates"],
            outputs=[],
        )

        err = E2BSandboxDriver()._upload_contexts_to_sandbox(
            sandbox=sandbox,
            workdir="/home/user/worker",
            config=config,
            made_dirs={"/home/user/worker"},
            log_fn=lambda *_args, **_kwargs: None,
        )

        assert err is None
        # Hydration hook must have been called because the dir did not exist.
        assert "novasearch-candidates" in hydration_calls
        # After hydration the file must be uploaded to the sandbox.
        assert (
            sandbox.files._files.get(
                "/home/user/worker/context/novasearch-candidates/candidates.db"
            )
            == b"SQLITE_DATA"
        )
    finally:
        contexts_module.set_context_hydration_hook(None)
