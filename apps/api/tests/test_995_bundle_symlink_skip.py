"""#995 — worker bundle / tree upload must not follow symlinks.

A crafted bundle could include `secret.env -> /etc/passwd` (or the host
api.env). The upload loops resolved the link and copied the TARGET's bytes
into the sandbox, exfiltrating host files. Both loops now skip symlinks.

Run: cd apps/api && python -m pytest tests/test_995_bundle_symlink_skip.py -q
"""
from __future__ import annotations

import sys
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


class _CaptureSandbox:
    def __init__(self):
        self.files = _CaptureSandboxFiles()


def _make_bundle_with_symlink(tmp_path: Path, host_secret: Path) -> Path:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "worker.yml").write_text("id: w\nname: w\n")
    (bundle / "run.py").write_text("print('ok')\n")
    # the attack: a symlink pointing at a host secret file
    link = bundle / "stolen.env"
    link.symlink_to(host_secret)
    return bundle


def test_agent_upload_tree_skips_symlinks(tmp_path):
    from runner_sandbox.agent_driver import AgentDriver

    host_secret = tmp_path / "host_api.env"
    host_secret.write_text("SECRET=topsecret\n")
    bundle = _make_bundle_with_symlink(tmp_path, host_secret)

    sandbox = _CaptureSandbox()
    AgentDriver.__new__(AgentDriver)._upload_tree(sandbox, bundle, "/remote")

    uploaded = b"".join(sandbox.files.written.values())
    assert b"topsecret" not in uploaded, "symlinked host secret leaked into sandbox (#995)"
    # legitimate files still uploaded
    assert any(p.endswith("worker.yml") for p in sandbox.files.written)
    assert any(p.endswith("run.py") for p in sandbox.files.written)
    assert not any(p.endswith("stolen.env") for p in sandbox.files.written)


def test_symlink_skip_present_in_e2b_bundle_loop():
    # the e2b bundle upload loop runs inside .run() and needs a full sandbox;
    # pin the guard at the source level so the loop can't regress.
    import inspect
    from runner_sandbox import e2b_driver

    src = inspect.getsource(e2b_driver)
    # the bundle rglob loop must skip symlinks before read_bytes()
    assert "if fpath.is_symlink():" in src
    assert "#995" in src
