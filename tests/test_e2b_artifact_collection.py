import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.path.join(str(ROOT), "apps", "api"))

from models import WorkerConfig, WorkerOutput, WorkerRuntime, WorkerTrigger
from runner_sandbox import e2b_driver
from runner_sandbox.e2b_driver import (
    E2BSandboxDriver,
    _install_timeout_for_run,
    _sandbox_lifetime_timeout,
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


def test_long_worker_timeout_extends_install_and_sandbox_lifetime():
    install_timeout = _install_timeout_for_run(1200)

    assert install_timeout == 900
    assert _sandbox_lifetime_timeout(1200, install_timeout) == 2160


def test_sandbox_lifetime_caps_at_e2b_one_hour_limit():
    install_timeout = _install_timeout_for_run(3600)

    assert install_timeout == 900
    assert _sandbox_lifetime_timeout(3600, install_timeout) == 3600
