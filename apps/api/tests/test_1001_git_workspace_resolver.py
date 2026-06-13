"""#1001 — worker rollback 500 in cloud: git ops ran in WORKERS_DIR/{id} which
the cloud host never materializes (its tree is var/workspaces/{id}).

Fix: a host-registered resolver lets _git_workspace() point EVERY git op
(versions read AND rollback) at the same real tree. Mirrors #992's
set_worker_call_secret_resolver.

Run: cd apps/api && python -m pytest tests/test_1001_git_workspace_resolver.py -q
"""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture
def main_mod(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "engine" / "workers"))
    (tmp_path / "engine" / "workers").mkdir(parents=True)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.delenv("WORKEROS_WORKSPACE_DIR", raising=False)
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("db", "auth", "contexts")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    main = importlib.import_module("main")
    yield main, tmp_path
    main.set_git_workspace_resolver(None)


def test_default_oss_path_unchanged(main_mod):
    main, tmp_path = main_mod
    # no resolver, no active workspace → WORKERS_DIR.parent (OSS)
    assert main._git_workspace() == (tmp_path / "engine" / "workers").parent.resolve()


def test_resolver_overrides_for_both_read_and_rollback(main_mod, monkeypatch):
    main, tmp_path = main_mod
    # simulate cloud: active workspace + the real tree elsewhere
    real_tree = tmp_path / "var" / "workspaces" / "ws_abc"
    real_tree.mkdir(parents=True)
    monkeypatch.setattr(main._git_ops, "get_active_workspace_id", lambda: "ws_abc")

    captured = {}

    def _resolver(ws_id):
        captured["ws"] = ws_id
        return real_tree

    main.set_git_workspace_resolver(_resolver)
    # every git op resolves to the materialized tree, NOT engine/workers/ws_abc
    assert main._git_workspace() == real_tree.resolve()
    assert captured["ws"] == "ws_abc"
    assert main._git_workspace() != (tmp_path / "engine" / "workers" / "ws_abc").resolve()


def test_resolver_failure_falls_back(main_mod, monkeypatch):
    main, tmp_path = main_mod
    monkeypatch.setattr(main._git_ops, "get_active_workspace_id", lambda: "ws_x")
    main.set_git_workspace_resolver(lambda ws: (_ for _ in ()).throw(RuntimeError("boom")))
    # never raises — falls back to the cloud default path
    assert main._git_workspace() == (tmp_path / "engine" / "workers" / "ws_x").resolve()


def test_resolver_returning_none_falls_back(main_mod, monkeypatch):
    main, tmp_path = main_mod
    monkeypatch.setattr(main._git_ops, "get_active_workspace_id", lambda: "ws_y")
    main.set_git_workspace_resolver(lambda ws: None)
    assert main._git_workspace() == (tmp_path / "engine" / "workers" / "ws_y").resolve()
