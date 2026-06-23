"""#772 — unified workspace changelog merging worker + context + workspace
prompt git history into one timeline.

The git-workspace plumbing is exercised by the per-asset /versions tests;
here we mock _git_ops.get_log to return synthetic history per path and assert
the changelog's fan-out / merge / sort / asset-tagging logic.

Run: cd apps/api && python -m pytest tests/test_workspace_changelog_772.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

OWNER = "local-user"


@pytest.fixture
def workspace_router_module(monkeypatch, tmp_path):
    sys.modules.pop("routers.workspace", None)
    module = importlib.import_module("routers.workspace")
    monkeypatch.setattr(module, "_git_workspace", lambda: tmp_path)
    monkeypatch.setattr(module, "_workers_git_prefix", lambda: "workers")
    monkeypatch.setattr(module, "_contexts_git_prefix", lambda: "contexts")
    monkeypatch.setattr(
        module,
        "_list_visible_workers",
        lambda user_id, repos, use_cache=True: [{"id": "cl-worker", "name": "Changelog Worker"}],
    )
    monkeypatch.setattr(
        module,
        "list_contexts",
        lambda auth, repos: [SimpleNamespace(name="facts", sensitive=False)],
    )
    return module


def _fake_log(monkeypatch, mapping):
    """mapping: rel_path-substring -> list of (sha, message, timestamp)."""
    def _get_log(workspace, rel_path=None, limit=50, asset_type="", asset_id=""):
        for needle, rows in mapping.items():
            if needle in (rel_path or ""):
                return [
                    {"id": sha, "sha": sha, "message": msg, "author": "a",
                     "timestamp": ts, "asset_type": asset_type, "asset_id": asset_id}
                    for sha, msg, ts in rows
                ]
        return []
    git_ops = importlib.import_module("git_ops")
    monkeypatch.setattr(git_ops, "get_log", _get_log)


def _call_changelog(module, **kwargs):
    entries = module.workspace_changelog(
        auth=SimpleNamespace(user_id=OWNER),
        repos=object(),
        **kwargs,
    )
    return [entry.model_dump() for entry in entries]


def test_changelog_merges_and_sorts(workspace_router_module, monkeypatch):
    _fake_log(monkeypatch, {
        "cl-worker": [("aaaaaaa", "worker edit", "2026-06-10T10:00:00Z")],
        "facts": [("bbbbbbb", "added fact", "2026-06-11T09:00:00Z")],
        "workspace.md": [("ccccccc", "prompt tweak", "2026-06-09T08:00:00Z")],
        "workspace.base.md": [("ddddddd", "base tweak", "2026-06-12T08:00:00Z")],
        "workspace-tools.yml": [("eeeeeee", "tools tweak", "2026-06-08T08:00:00Z")],
    })
    entries = _call_changelog(workspace_router_module)
    # newest first across all asset types
    assert [e["sha"] for e in entries[:5]] == ["ddddddd", "bbbbbbb", "aaaaaaa", "ccccccc", "eeeeeee"]
    by_sha = {e["sha"]: e for e in entries}
    assert by_sha["aaaaaaa"]["asset_type"] == "worker"
    assert by_sha["aaaaaaa"]["asset_name"] == "Changelog Worker"
    assert by_sha["bbbbbbb"]["asset_type"] == "context"
    assert by_sha["bbbbbbb"]["asset_name"] == "facts"
    assert by_sha["ccccccc"]["asset_type"] == "workspace_instructions"
    assert by_sha["ddddddd"]["asset_type"] == "workspace_base_persona"
    assert by_sha["ddddddd"]["asset_name"] == "Base persona"
    assert by_sha["eeeeeee"]["asset_type"] == "workspace_tools"
    assert by_sha["eeeeeee"]["asset_name"] == "Workspace tools"


def test_asset_types_filter(workspace_router_module, monkeypatch):
    _fake_log(monkeypatch, {
        "cl-worker": [("aaaaaaa", "w", "2026-06-10T10:00:00Z")],
        "facts": [("bbbbbbb", "ctx", "2026-06-11T09:00:00Z")],
        "workspace-tools.yml": [("eeeeeee", "tools", "2026-06-08T08:00:00Z")],
    })
    entries = _call_changelog(workspace_router_module, asset_types="worker")
    assert all(e["asset_type"] == "worker" for e in entries)
    assert any(e["sha"] == "aaaaaaa" for e in entries)
    entries = _call_changelog(workspace_router_module, asset_types="workspace_tools")
    assert [e["asset_type"] for e in entries] == ["workspace_tools"]
    assert entries[0]["sha"] == "eeeeeee"


def test_limit_applied(workspace_router_module, monkeypatch):
    _fake_log(monkeypatch, {
        "cl-worker": [(f"sha{i:04d}", "m", f"2026-06-{i+1:02d}T00:00:00Z") for i in range(10)],
    })
    entries = _call_changelog(workspace_router_module, limit=3)
    assert len(entries) == 3


def test_git_status_surfaces_versioning_disabled(monkeypatch, tmp_path):
    sys.modules.pop("routers.system_git", None)
    module = importlib.import_module("routers.system_git")
    git_ops = importlib.import_module("git_ops")
    monkeypatch.setattr(module, "_git_cfg_get", lambda _user_id: None)
    monkeypatch.setattr(module, "_git_workspace", lambda: tmp_path)
    monkeypatch.setattr(git_ops, "is_engine_source_checkout", lambda _workspace: True)

    status = module.get_git_status(auth=SimpleNamespace(user_id=OWNER))

    body = status.model_dump()
    assert body["connected"] is False
    assert body["versioning_disabled"] is True
