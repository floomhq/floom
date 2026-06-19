"""#995 — worker bundle / tree upload must not follow symlinks.

A crafted bundle could include `secret.env -> /etc/passwd` (or the host
api.env). The upload loops resolved the link and copied the TARGET's bytes
into the sandbox, exfiltrating host files. Both loops now skip symlinks.

Run: cd apps/api && python -m pytest tests/test_995_bundle_symlink_skip.py -q
"""
from __future__ import annotations

import io
import sys
import tarfile
from types import SimpleNamespace
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


class _CaptureSandboxFiles:
    def __init__(self):
        self.written: dict[str, bytes] = {}
        self.dirs: set[str] = set()

    def make_dir(self, path):
        self.dirs.add(path)

    def write(self, path, data):
        self.written[path] = data if isinstance(data, (bytes, bytearray)) else str(data).encode()


class _CaptureCommands:
    def __init__(self):
        self.runs: list[tuple[str, dict]] = []

    def run(self, command, **kwargs):
        self.runs.append((command, kwargs))
        return SimpleNamespace(exit_code=0, stdout="", stderr="")


class _CaptureSandbox:
    def __init__(self):
        self.files = _CaptureSandboxFiles()
        self.commands = _CaptureCommands()


def _make_bundle_with_symlink(tmp_path: Path, host_secret: Path) -> Path:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "worker.yml").write_text("id: w\nname: w\n")
    (bundle / "run.py").write_text("print('ok')\n")
    # the attack: a symlink pointing at a host secret file
    link = bundle / "stolen.env"
    try:
        link.symlink_to(host_secret)
    except OSError as exc:
        pytest.skip(f"symlink creation is unavailable in this environment: {exc}")
    return bundle


def test_agent_upload_tree_skips_symlinks(tmp_path):
    from runner_sandbox.agent_driver import AgentDriver

    host_secret = tmp_path / "host_api.env"
    host_secret.write_text("SECRET=topsecret\n")
    bundle = _make_bundle_with_symlink(tmp_path, host_secret)

    sandbox = _CaptureSandbox()
    AgentDriver.__new__(AgentDriver)._upload_tree(sandbox, bundle, "/remote")

    archives = [
        raw
        for path, raw in sandbox.files.written.items()
        if path.endswith(".workeros-upload.tar.gz")
    ]
    assert len(archives) == 1
    with tarfile.open(fileobj=io.BytesIO(archives[0]), mode="r:gz") as tf:
        names = set(tf.getnames())
        uploaded = b"".join(tf.extractfile(member).read() for member in tf.getmembers() if member.isfile())

    assert b"topsecret" not in uploaded, "symlinked host secret leaked into sandbox (#995)"
    # legitimate files still uploaded
    assert "worker.yml" in names
    assert "run.py" in names
    assert "stolen.env" not in names
    assert sandbox.commands.runs


def test_upload_tree_tarball_uses_single_archive_write(tmp_path):
    from runner_sandbox.e2b_upload import upload_tree_tarball

    root = tmp_path / "root"
    (root / "pkg").mkdir(parents=True)
    (root / "pkg" / "worker.py").write_text("print('ok')\n")
    (root / "__pycache__").mkdir()
    (root / "__pycache__" / "ignored.pyc").write_bytes(b"cache")

    sandbox = _CaptureSandbox()
    files, dirs = upload_tree_tarball(
        sandbox,
        root,
        "/remote",
        skip=lambda _path, rel: "__pycache__" in rel.parts,
        label="test tree",
    )

    assert (files, dirs) == (1, 1)
    assert list(sandbox.files.written) == ["/remote/.workeros-upload.tar.gz"]
    command, kwargs = sandbox.commands.runs[0]
    assert command.startswith("tar -xzf .workeros-upload.tar.gz")
    assert kwargs["cwd"] == "/remote"
    with tarfile.open(fileobj=io.BytesIO(next(iter(sandbox.files.written.values()))), mode="r:gz") as tf:
        assert set(tf.getnames()) == {"pkg", "pkg/worker.py"}


def test_symlink_skip_present_in_e2b_bundle_loop():
    # the e2b bundle upload loop runs inside .run() and needs a full sandbox;
    # pin the guard at the source level so the loop can't regress.
    import inspect
    from runner_sandbox import e2b_driver

    src = inspect.getsource(e2b_driver)
    assert "upload_tree_tarball(" in src
    assert "label=\"worker bundle\"" in src
