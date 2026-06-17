"""#1453: workspace versions must be rollback-safe.

The common dev setup can point the git workspace at the engine source checkout.
Writes are disabled there, so reads must not expose engine commit history as
workspace versions. For real workspace repos, every listed workspace.md version
must be restorable by the rollback endpoint.
"""

from __future__ import annotations

import importlib
import subprocess
import sys
import types
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _purge_api_modules() -> None:
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service", "git_ops") or name.startswith(
            ("routers", "services", "core", "db", "auth", "contexts")
        ):
            sys.modules.pop(name, None)


def _install_app(monkeypatch, tmp_path: Path, *, workers_dir: Path, workspace_dir: Path | None):
    if "fcntl" not in sys.modules:
        _fcntl = types.ModuleType("fcntl")
        for attr in ("LOCK_EX", "LOCK_SH", "LOCK_UN", "LOCK_NB"):
            setattr(_fcntl, attr, 0)
        _fcntl.flock = lambda fd, op: None
        sys.modules["fcntl"] = _fcntl

    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    if workspace_dir is None:
        monkeypatch.delenv("WORKEROS_WORKSPACE_DIR", raising=False)
    else:
        monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(workspace_dir))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "dev")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))

    _purge_api_modules()
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient

    return TestClient(main.app, headers={"x-floom-secret": "dev"}, raise_server_exceptions=False), main


def _git_commit(workspace: Path, rel_path: str, content: str, message: str) -> str:
    path = workspace / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "--", rel_path], cwd=workspace, check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "commit", "-m", message, "--author=Test <test@example.com>"],
        cwd=workspace,
        check=True,
        capture_output=True,
        text=True,
    )
    sha = subprocess.run(["git", "rev-parse", "--short=7", "HEAD"], cwd=workspace, check=True, capture_output=True, text=True)
    return sha.stdout.strip()


def _init_git(workspace: Path) -> None:
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=workspace, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=workspace, check=True)


def test_workspace_versions_hidden_when_workspace_is_engine_source(monkeypatch, tmp_path):
    source_root = tmp_path / "engine-source"
    workers_dir = source_root / "workers"
    (source_root / "apps" / "api").mkdir(parents=True)
    workers_dir.mkdir(parents=True)
    (source_root / "apps" / "api" / "main.py").write_text("# engine marker\n", encoding="utf-8")
    _init_git(source_root)
    _git_commit(source_root, "workspace.md", "source checkout prompt\n", "source workspace prompt")

    client, _main = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=None)

    resp = client.get("/workspace/versions")

    assert resp.status_code == 200, resp.text
    assert resp.json() == []


def test_workspace_rollback_restores_a_listed_workspace_version(monkeypatch, tmp_path):
    workspace = tmp_path / "workspace"
    workers_dir = workspace / "workers"
    workers_dir.mkdir(parents=True)
    _init_git(workspace)
    old_sha = _git_commit(workspace, "workspace.md", "old instructions\n", "workspace: old")
    _git_commit(workspace, "workspace.md", "new instructions\n", "workspace: new")

    client, _main = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)

    versions = client.get("/workspace/versions")
    assert versions.status_code == 200, versions.text
    version_ids = {row["id"] for row in versions.json()}
    assert old_sha in version_ids

    rollback = client.post(f"/workspace/rollback/{old_sha}")

    assert rollback.status_code == 200, rollback.text
    assert rollback.text == "old instructions\n"
    assert (workspace / "workspace.md").read_text(encoding="utf-8") == "old instructions\n"
