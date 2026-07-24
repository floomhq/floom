"""Writeable contexts must mount from the authoritative durable store, not a
stale long-lived executor cache.

Root cause (floomhq/workeros-cloud): a writeable (mutable) context is mounted
from ``context_dir(name)`` on the executor's long-lived local disk, which is
only hydrated from durable storage when empty. A writeback made on another
executor/replica, or an operator edit made through the API container, is never
re-pulled, so a run reads a stale mutable pack ("not visible to other workers /
next run"). The ``set_context_mount_snapshot_hook`` seam lets the hosted cloud
mount a fresh EXACT snapshot from durable storage instead; OSS mode (no hook)
keeps mounting the canonical on-disk pack unchanged.

These tests register a fake snapshot hook whose durable state DIFFERS from the
local cache and assert the run mounts the durable snapshot, not the cache.
Before the seam existed both mount paths read the local cache, so a hook that
serves ``v2`` while the cache holds ``v1`` fails the assertions (fail-before);
with the seam they pass (pass-after).
"""

from __future__ import annotations

import importlib
import io
import sys
import tarfile
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def ctx_env(monkeypatch, tmp_path):
    """Per-tenant scoped contexts dir with the mutable-mount modules reloaded so
    the ``writeable_mount_source`` by-name imports rebind to this env's roots."""
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    # Tenant "alice" owns a writeable pack whose LOCAL cache is stale (v1).
    cache_pack = contexts_dir / "alice" / "notes"
    cache_pack.mkdir(parents=True)
    (cache_pack / "state.md").write_text("v1 stale cache\n", encoding="utf-8")
    (cache_pack / "old.md").write_text("deleted upstream\n", encoding="utf-8")

    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.delenv("WORKEROS_DEPLOY", raising=False)

    import contexts as contexts_mod
    importlib.reload(contexts_mod)
    from runner_sandbox import memory_context as memory_context_mod
    importlib.reload(memory_context_mod)
    from runner_sandbox import agent_capabilities as agent_capabilities_mod
    importlib.reload(agent_capabilities_mod)
    from runner_sandbox import e2b_driver as e2b_driver_mod
    importlib.reload(e2b_driver_mod)

    yield {
        "contexts": contexts_mod,
        "agent_capabilities": agent_capabilities_mod,
        "e2b_driver": e2b_driver_mod,
        "contexts_dir": contexts_dir,
        "tmp_path": tmp_path,
    }

    contexts_mod.set_context_mount_snapshot_hook(None)
    importlib.reload(contexts_mod)
    importlib.reload(memory_context_mod)
    importlib.reload(agent_capabilities_mod)
    importlib.reload(e2b_driver_mod)


def _log_fn(_msg, _level="info"):
    return None


def _install_v2_snapshot_hook(contexts_mod):
    """Register a hook whose durable snapshot is v2 (state.md changed, old.md
    deleted, new.md added) so it is distinguishable from the v1 local cache."""
    seen: dict[str, object] = {}

    def _hook(scope, name, dest_dir: Path) -> bool:
        seen["scope"] = scope
        seen["name"] = name
        seen["dest"] = Path(dest_dir)
        (dest_dir / "state.md").write_text("v2 durable\n", encoding="utf-8")
        (dest_dir / "new.md").write_text("added upstream\n", encoding="utf-8")
        return True

    contexts_mod.set_context_mount_snapshot_hook(_hook)
    return seen


# ---------------------------------------------------------------------------
# writeable_mount_source seam
# ---------------------------------------------------------------------------

def test_mount_source_without_hook_yields_local_cache(ctx_env):
    contexts_mod = ctx_env["contexts"]
    with contexts_mod.use_context_scope("alice"):
        with contexts_mod.writeable_mount_source("notes") as src:
            assert src == contexts_mod.context_dir("notes")
            assert (src / "state.md").read_text().strip() == "v1 stale cache"


def test_mount_source_with_hook_yields_exact_snapshot(ctx_env):
    contexts_mod = ctx_env["contexts"]
    seen = _install_v2_snapshot_hook(contexts_mod)
    with contexts_mod.use_context_scope("alice"):
        with contexts_mod.writeable_mount_source("notes") as src:
            snapshot_dir = Path(src)
            # The snapshot is the durable v2, NOT the v1 local cache.
            assert (src / "state.md").read_text().strip() == "v2 durable"
            assert (src / "new.md").is_file()
            # Exact mirror: a file deleted upstream is absent from the snapshot.
            assert not (src / "old.md").exists()
            # It is a fresh temp dir, not the canonical cache.
            assert src != contexts_mod.context_dir("notes")
            assert seen["scope"] == "alice"
        # Snapshot temp dir is cleaned up on exit; the canonical cache is untouched.
        assert not snapshot_dir.exists()
        assert (contexts_mod.context_dir("notes") / "state.md").read_text().strip() == "v1 stale cache"


def test_mount_source_hook_failure_propagates_fail_closed(ctx_env):
    contexts_mod = ctx_env["contexts"]

    def _boom(scope, name, dest_dir):
        raise RuntimeError("storage listing failed")

    contexts_mod.set_context_mount_snapshot_hook(_boom)
    with contexts_mod.use_context_scope("alice"):
        with pytest.raises(RuntimeError, match="storage listing failed"):
            with contexts_mod.writeable_mount_source("notes"):
                pass


def test_mount_source_hook_declines_falls_back_to_cache(ctx_env):
    contexts_mod = ctx_env["contexts"]

    def _decline(scope, name, dest_dir):
        return False  # pack not durably stored yet -> use local cache

    contexts_mod.set_context_mount_snapshot_hook(_decline)
    with contexts_mod.use_context_scope("alice"):
        with contexts_mod.writeable_mount_source("notes") as src:
            assert (src / "state.md").read_text().strip() == "v1 stale cache"


# ---------------------------------------------------------------------------
# Agent-mode staging path
# ---------------------------------------------------------------------------

def _writeable_config(name: str):
    class _Runtime:
        system_prompt = None
        type = "agent"

    class _Config:
        def __init__(self):
            self.contexts = [{"name": name, "source": "local", "writeable": True}]
            self.outputs = []
            self.runtime = _Runtime()

    return _Config()


def test_agent_staging_uses_durable_snapshot_for_writeable(ctx_env):
    contexts_mod = ctx_env["contexts"]
    agent_caps = ctx_env["agent_capabilities"]
    _install_v2_snapshot_hook(contexts_mod)

    context_root = ctx_env["tmp_path"] / "run-agent" / "context"
    context_root.mkdir(parents=True)

    staged = agent_caps.stage_context_packs(
        config=_writeable_config("notes"),
        context_root=context_root,
        user_id="alice",
        log_fn=_log_fn,
    )

    assert staged == ["notes"]
    staged_pack = context_root / "notes"
    assert (staged_pack / "state.md").read_text().strip() == "v2 durable"
    assert (staged_pack / "new.md").is_file()
    assert not (staged_pack / "old.md").exists()


# ---------------------------------------------------------------------------
# E2B mount path (fake sandbox capturing the uploaded tar)
# ---------------------------------------------------------------------------

class _FakeCommands:
    def run(self, *_args, **_kwargs):
        class _R:
            exit_code = 0
            stderr = ""
            stdout = ""
        return _R()


class _FakeFiles:
    def __init__(self):
        self.archives: dict[str, bytes] = {}

    def make_dir(self, *_args, **_kwargs):
        return None

    def write(self, path, raw, **_kwargs):
        self.archives[path] = bytes(raw)


class _FakeSandbox:
    def __init__(self):
        self.files = _FakeFiles()
        self.commands = _FakeCommands()


def _extract_uploaded(files: _FakeFiles, remote_root: str) -> dict[str, str]:
    """Decode the tarball the driver wrote for ``remote_root`` into {rel: text}."""
    archive = next(v for k, v in files.archives.items() if k.startswith(remote_root))
    out: dict[str, str] = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:*") as tar:
        for m in tar.getmembers():
            if m.isfile():
                out[m.name.lstrip("./")] = tar.extractfile(m).read().decode("utf-8")
    return out


def test_e2b_mount_uses_durable_snapshot_for_writeable(ctx_env):
    contexts_mod = ctx_env["contexts"]
    e2b_mod = ctx_env["e2b_driver"]
    _install_v2_snapshot_hook(contexts_mod)

    driver = e2b_mod.E2BSandboxDriver()
    sandbox = _FakeSandbox()
    workdir = "/home/user"
    config = _writeable_config("notes")

    err = driver._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir=workdir,
        config=config,
        inputs={},
        made_dirs=set(),
        log_fn=_log_fn,
        user_id="alice",
        mounted_contexts=set(),
        writeable_contexts=set(),
    )

    assert err is None
    uploaded = _extract_uploaded(sandbox.files, f"{workdir}/context/notes")
    assert uploaded.get("state.md", "").strip() == "v2 durable"
    assert "new.md" in uploaded
    assert "old.md" not in uploaded  # deletion honoured by the exact snapshot


def test_e2b_mount_fails_closed_on_snapshot_error(ctx_env):
    contexts_mod = ctx_env["contexts"]
    e2b_mod = ctx_env["e2b_driver"]

    def _boom(scope, name, dest_dir):
        raise RuntimeError("durable storage unavailable")

    contexts_mod.set_context_mount_snapshot_hook(_boom)

    driver = e2b_mod.E2BSandboxDriver()
    sandbox = _FakeSandbox()
    err = driver._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir="/home/user",
        config=_writeable_config("notes"),
        inputs={},
        made_dirs=set(),
        log_fn=_log_fn,
        user_id="alice",
        mounted_contexts=set(),
        writeable_contexts=set(),
    )

    assert err is not None
    assert "durable storage" in err
