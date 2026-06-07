"""Agent-mode workers must receive their attached brain packs at runtime.

Parity with the e2b driver: a worker declaring ``contexts: [{name: X}]`` can
read pack X's files via the agent's list_dir / read_file tools, staged under
``context/<name>/`` (mirroring e2b's ``{workdir}/context/<name>``). Owner scope
is strictly enforced: a worker only ever gets ITS attached packs, never another
tenant's, and a worker WITHOUT the attachment cannot read the pack at all.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def driver_env(monkeypatch, tmp_path):
    """Per-user-scoped contexts + artifacts dirs, with contexts/models reloaded
    so they pick up the env-driven CONTEXTS_DIR / ARTIFACTS_DIR roots."""
    contexts_dir = tmp_path / "contexts"
    artifacts_dir = tmp_path / "artifacts"
    workers_dir = tmp_path / "workers"
    for path in (contexts_dir, artifacts_dir, workers_dir):
        path.mkdir()

    # Owner-scoped pack for tenant "alice": CONTEXTS_DIR/alice/research-notes
    alice_pack = contexts_dir / "alice" / "research-notes"
    (alice_pack / "facts").mkdir(parents=True)
    (alice_pack / "summary.md").write_text("# Alice facts\nQ2 revenue up 30%.\n", encoding="utf-8")
    (alice_pack / "facts" / "raw.txt").write_text("raw alice data\n", encoding="utf-8")

    # A different tenant ("bob") owns a same-named pack with different content.
    bob_pack = contexts_dir / "bob" / "research-notes"
    bob_pack.mkdir(parents=True)
    (bob_pack / "summary.md").write_text("BOB SECRET\n", encoding="utf-8")

    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    # Turn on per-user scoping so context_scope_for_user("alice") == "alice".
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.delenv("WORKEROS_DEPLOY", raising=False)

    import contexts as contexts_mod
    import runner_utils as runner_utils_mod
    importlib.reload(contexts_mod)
    importlib.reload(runner_utils_mod)
    # agent_capabilities holds the staging/writeback context helpers (context_dir,
    # iter_context_files, …) bound at import time; reload it AFTER contexts so it
    # picks up the env-driven CONTEXTS_DIR, then reload agent_driver which imports
    # from it.
    from runner_sandbox import agent_capabilities as agent_capabilities_mod
    importlib.reload(agent_capabilities_mod)
    from runner_sandbox import agent_driver as agent_driver_mod
    importlib.reload(agent_driver_mod)

    yield {
        "agent_driver": agent_driver_mod,
        "contexts_dir": contexts_dir,
        "artifacts_dir": artifacts_dir,
        "tmp_path": tmp_path,
    }

    # Restore module state for sibling tests.
    importlib.reload(contexts_mod)
    importlib.reload(runner_utils_mod)
    importlib.reload(agent_capabilities_mod)
    importlib.reload(agent_driver_mod)


def _log_fn(_msg, _level="info"):
    return None


def _stage(agent_driver_mod, artifacts_dir, *, contexts, user_id, run_id):
    driver = agent_driver_mod.AgentDriver()
    context_root = artifacts_dir / run_id / "context"
    context_root.mkdir(parents=True)

    class _Runtime:
        system_prompt = None
        type = "agent"

    class _Config:
        def __init__(self, ctx):
            self.contexts = ctx
            self.outputs = []
            self.runtime = _Runtime()

    config = _Config(contexts)
    staged = driver._stage_contexts(
        config=config,
        context_root=context_root,
        user_id=user_id,
        log_fn=_log_fn,
    )
    return driver, context_root, staged


def test_agent_worker_reads_attached_pack(driver_env):
    """A worker WITH contexts: [{name: research-notes}] reads pack files at
    runtime under its owner scope."""
    agent_driver_mod = driver_env["agent_driver"]
    artifacts_dir = driver_env["artifacts_dir"]
    bundle_dir = driver_env["tmp_path"] / "workers" / "w-with"
    bundle_dir.mkdir()

    driver, context_root, staged = _stage(
        agent_driver_mod,
        artifacts_dir,
        contexts=[{"name": "research-notes", "source": "local"}],
        user_id="alice",
        run_id="run-with",
    )

    assert staged == ["research-notes"]

    # Files landed in the staged context/<name> tree...
    assert (context_root / "research-notes" / "summary.md").is_file()
    assert (context_root / "research-notes" / "facts" / "raw.txt").is_file()

    # ...and the agent's file tools can discover + read them.
    listing = driver._list_dir(bundle_dir, "context", context_root)
    assert listing["ok"] is True
    assert {"name": "research-notes", "type": "dir"} in listing["entries"]

    pack_listing = driver._list_dir(bundle_dir, "context/research-notes", context_root)
    assert pack_listing["ok"] is True
    names = {entry["name"] for entry in pack_listing["entries"]}
    assert {"summary.md", "facts"} <= names

    read = driver._read_file(bundle_dir, "context/research-notes/summary.md", context_root)
    assert read["ok"] is True
    assert "Q2 revenue up 30%" in read["content"]
    # Owner scope: alice gets alice's pack, NOT bob's same-named pack.
    assert "BOB SECRET" not in read["content"]


def test_agent_worker_without_attachment_cannot_read_pack(driver_env):
    """A worker that did NOT attach the pack stages nothing and cannot read it."""
    agent_driver_mod = driver_env["agent_driver"]
    artifacts_dir = driver_env["artifacts_dir"]
    bundle_dir = driver_env["tmp_path"] / "workers" / "w-without"
    bundle_dir.mkdir()

    driver, context_root, staged = _stage(
        agent_driver_mod,
        artifacts_dir,
        contexts=[],
        user_id="alice",
        run_id="run-without",
    )

    assert staged == []
    # Nothing staged: the pack is unreadable through the file tools.
    assert driver._list_dir(bundle_dir, "context", context_root)["entries"] == []
    read = driver._read_file(bundle_dir, "context/research-notes/summary.md", context_root)
    assert read["ok"] is False


def test_stage_contexts_does_not_leak_cross_tenant(driver_env):
    """Even when bob owns a same-named pack, alice's run never stages bob's
    files — owner scope is enforced via context_scope_for_user."""
    agent_driver_mod = driver_env["agent_driver"]
    artifacts_dir = driver_env["artifacts_dir"]

    _driver, context_root, staged = _stage(
        agent_driver_mod,
        artifacts_dir,
        contexts=[{"name": "research-notes", "source": "local"}],
        user_id="bob",
        run_id="run-bob",
    )

    assert staged == ["research-notes"]
    content = (context_root / "research-notes" / "summary.md").read_text()
    assert content.strip() == "BOB SECRET"
    # bob's run never staged alice's facts subtree.
    assert not (context_root / "research-notes" / "facts").exists()
