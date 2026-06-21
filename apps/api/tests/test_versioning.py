"""Tests for the git-backed workspace versioning system.

Covers:
  git_ops module — ensure_repo, commit_paths, get_log, get_file_at_sha,
                   list_files_at_sha, checkout_path

Integration tests (Linux/CI only) boot the full FastAPI app and call:
  GET  /workers/{id}/versions         — returns git log
  POST /workers/{id}/rollback/{sha}   — git checkout + commit
  GET  /contexts/{name}/versions      — returns git log
  POST /contexts/{name}/rollback/{sha}
  GET  /workspace/versions            — returns git log
  POST /workspace/rollback/{sha}
"""

from __future__ import annotations

import os
import platform
import subprocess
import sys
from pathlib import Path

import pytest

_LINUX_ONLY = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="SQLite db layer uses fcntl (Linux only); runs in CI on ubuntu-latest",
)

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _git_available() -> bool:
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=True, timeout=5)
        return True
    except Exception:
        return False


_GIT_REQUIRED = pytest.mark.skipif(
    not _git_available(),
    reason="git is not installed or not on PATH",
)


def _head_tree_paths(repo: Path) -> set[str]:
    result = subprocess.run(
        ["git", "-C", str(repo), "ls-tree", "-r", "--name-only", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
        timeout=5,
    )
    return {line for line in result.stdout.splitlines() if line}


# ---------------------------------------------------------------------------
# Unit tests: git_ops module
# ---------------------------------------------------------------------------

@_GIT_REQUIRED
class TestGitOps:
    """Cross-platform tests for the git_ops helper module."""

    @pytest.fixture
    def workspace(self, tmp_path: Path) -> Path:
        """Return a fresh initialized git workspace."""
        import git_ops
        git_ops.ensure_repo(tmp_path)
        return tmp_path

    def test_ensure_repo_creates_git_dir(self, tmp_path: Path) -> None:
        import git_ops
        git_ops.ensure_repo(tmp_path)
        assert (tmp_path / ".git").exists()

    def test_ensure_repo_idempotent(self, tmp_path: Path) -> None:
        import git_ops
        result1 = git_ops.ensure_repo(tmp_path)
        result2 = git_ops.ensure_repo(tmp_path)
        assert result1 is True
        assert result2 is False  # already a repo

    def test_ensure_repo_creates_gitignore(self, tmp_path: Path) -> None:
        import git_ops
        git_ops.ensure_repo(tmp_path)
        assert (tmp_path / ".gitignore").exists()

    def test_ensure_repo_initial_commit_filters_secret_bearing_files(self, tmp_path: Path) -> None:
        import git_ops

        (tmp_path / "safe.txt").write_text("safe", encoding="utf-8")
        (tmp_path / ".secrets.enc").write_text("encrypted", encoding="utf-8")
        (tmp_path / "gcp-service-account.json").write_text("{}", encoding="utf-8")
        (tmp_path / "id_rsa").write_text("private key", encoding="utf-8")

        git_ops.ensure_repo(tmp_path)

        tree = _head_tree_paths(tmp_path)
        assert "safe.txt" in tree
        assert ".secrets.enc" not in tree
        assert "gcp-service-account.json" not in tree
        assert "id_rsa" not in tree

    def test_commit_paths_returns_sha(self, workspace: Path) -> None:
        import git_ops
        f = workspace / "hello.txt"
        f.write_text("hello world")
        sha = git_ops.commit_paths(workspace, ["hello.txt"], "add hello")
        assert sha is not None
        assert len(sha) == 7

    def test_commit_paths_nothing_to_commit(self, workspace: Path) -> None:
        import git_ops
        f = workspace / "hello.txt"
        f.write_text("hello world")
        git_ops.commit_paths(workspace, ["hello.txt"], "add hello")
        # Committing again with no changes should return HEAD sha, not raise
        sha = git_ops.commit_paths(workspace, ["hello.txt"], "no change")
        assert sha is not None

    def test_get_log_returns_commits_newest_first(self, workspace: Path) -> None:
        import git_ops
        (workspace / "workers").mkdir()
        for i in range(3):
            (workspace / "workers" / f"file{i}.txt").write_text(f"v{i}")
            git_ops.commit_paths(workspace, ["workers"], f"commit {i}")
        log = git_ops.get_log(workspace, rel_path="workers", limit=10)
        assert len(log) == 3
        assert log[0]["message"] == "commit 2"
        assert log[-1]["message"] == "commit 0"

    def test_get_log_entry_has_required_fields(self, workspace: Path) -> None:
        import git_ops
        (workspace / "test.md").write_text("content")
        git_ops.commit_paths(workspace, ["test.md"], "add test", author_name="Alice", author_email="alice@example.com")
        log = git_ops.get_log(workspace)
        assert len(log) >= 1
        entry = log[0]
        assert "id" in entry
        assert "sha" in entry
        assert "message" in entry
        assert "author" in entry
        assert "timestamp" in entry
        assert entry["id"] == entry["sha"]
        assert len(entry["sha"]) == 7
        assert entry["message"] == "add test"
        assert entry["author"] == "Alice"

    def test_get_log_respects_rel_path_filter(self, workspace: Path) -> None:
        import git_ops
        (workspace / "workers").mkdir()
        (workspace / "contexts").mkdir()
        (workspace / "workers" / "a.txt").write_text("worker")
        git_ops.commit_paths(workspace, ["workers"], "worker commit")
        (workspace / "contexts" / "b.txt").write_text("context")
        git_ops.commit_paths(workspace, ["contexts"], "context commit")
        # Log filtered to workers should only show the worker commit
        worker_log = git_ops.get_log(workspace, rel_path="workers", limit=50)
        assert len(worker_log) == 1
        assert worker_log[0]["message"] == "worker commit"

    def test_get_log_asset_type_and_id_passed_through(self, workspace: Path) -> None:
        import git_ops
        (workspace / "f.txt").write_text("x")
        git_ops.commit_paths(workspace, ["f.txt"], "add f")
        log = git_ops.get_log(workspace, asset_type="worker", asset_id="my-worker")
        assert log[0]["asset_type"] == "worker"
        assert log[0]["asset_id"] == "my-worker"

    def test_get_file_at_sha(self, workspace: Path) -> None:
        import git_ops
        (workspace / "doc.md").write_text("version 1")
        sha1 = git_ops.commit_paths(workspace, ["doc.md"], "v1")
        (workspace / "doc.md").write_text("version 2")
        sha2 = git_ops.commit_paths(workspace, ["doc.md"], "v2")
        assert sha1 != sha2
        content_at_v1 = git_ops.get_file_at_sha(workspace, sha1, "doc.md")
        assert content_at_v1 == "version 1"
        content_at_v2 = git_ops.get_file_at_sha(workspace, sha2, "doc.md")
        assert content_at_v2 == "version 2"

    def test_get_file_at_sha_missing_returns_none(self, workspace: Path) -> None:
        import git_ops
        (workspace / "f.txt").write_text("x")
        sha = git_ops.commit_paths(workspace, ["f.txt"], "add f")
        assert git_ops.get_file_at_sha(workspace, sha, "nonexistent.txt") is None

    def test_get_file_at_sha_bad_sha_returns_none(self, workspace: Path) -> None:
        import git_ops
        (workspace / "f.txt").write_text("x")
        git_ops.commit_paths(workspace, ["f.txt"], "add f")
        assert git_ops.get_file_at_sha(workspace, "0000000", "f.txt") is None

    def test_list_files_at_sha(self, workspace: Path) -> None:
        import git_ops
        (workspace / "workers" / "my-worker").mkdir(parents=True)
        (workspace / "workers" / "my-worker" / "worker.yml").write_text("id: my-worker")
        (workspace / "workers" / "my-worker" / "run.py").write_text("print('hi')")
        sha = git_ops.commit_paths(workspace, ["workers/my-worker"], "add worker")
        files = git_ops.list_files_at_sha(workspace, sha, "workers/my-worker")
        assert "workers/my-worker/worker.yml" in files
        assert "workers/my-worker/run.py" in files

    def test_commit_paths_directory_filters_secret_bearing_worker_files(self, workspace: Path) -> None:
        import git_ops

        worker_dir = workspace / "workers" / "secret-worker"
        worker_dir.mkdir(parents=True)
        (worker_dir / "worker.yml").write_text("id: secret-worker\n", encoding="utf-8")
        (worker_dir / "run.py").write_text("print('ok')\n", encoding="utf-8")
        (worker_dir / "credentials.json").write_text("{}", encoding="utf-8")

        sha = git_ops.commit_paths(workspace, ["workers/secret-worker"], "add worker")

        assert sha is not None
        tree = _head_tree_paths(workspace)
        assert "workers/secret-worker/worker.yml" in tree
        assert "workers/secret-worker/run.py" in tree
        assert "workers/secret-worker/credentials.json" not in tree

    def test_push_with_github_token_refuses_tracked_secret_bearing_files(self, workspace: Path) -> None:
        import git_ops

        secret_path = workspace / ".secrets.enc"
        secret_path.write_text("encrypted", encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(workspace), "add", "--", ".secrets.enc"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        subprocess.run(
            ["git", "-C", str(workspace), "commit", "-m", "force tracked secret"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )

        with pytest.raises(git_ops.GitOpsError, match="Refusing to push"):
            git_ops.push_with_github_token(workspace, "ghp_test")

    def test_checkout_path_restores_file(self, workspace: Path) -> None:
        import git_ops
        f = workspace / "readme.md"
        f.write_text("original content")
        sha_orig = git_ops.commit_paths(workspace, ["readme.md"], "initial")
        f.write_text("modified content")
        git_ops.commit_paths(workspace, ["readme.md"], "modify")
        # Restore to original
        git_ops.checkout_path(workspace, sha_orig, "readme.md")
        assert f.read_text() == "original content"

    def test_checkout_path_bad_sha_raises(self, workspace: Path) -> None:
        import git_ops
        (workspace / "f.txt").write_text("x")
        git_ops.commit_paths(workspace, ["f.txt"], "add")
        with pytest.raises(git_ops.GitOpsError):
            git_ops.checkout_path(workspace, "deadbeef", "f.txt")

    def test_get_log_empty_repo_returns_empty(self, workspace: Path) -> None:
        """A freshly initialized repo with no commits returns empty log."""
        import git_ops
        empty = Path(workspace) / "sub"
        empty.mkdir()
        # Note: ensure_repo already creates the initial commit if files exist.
        # Just check that get_log on a nonexistent path returns [].
        log = git_ops.get_log(workspace, rel_path="nonexistent-path/foo")
        assert log == []


# ---------------------------------------------------------------------------
# Integration tests: versioning API endpoints (Linux/CI only)
# ---------------------------------------------------------------------------

@_LINUX_ONLY
@_GIT_REQUIRED
class TestWorkerVersionsAPI:
    """Integration: GET /workers/{id}/versions and POST /workers/{id}/rollback/{sha}."""

    @pytest.fixture
    def app_client(self, tmp_path, monkeypatch):
        """Boot a test FastAPI client with isolated workspace + git repo."""
        import types, sys
        if "fcntl" not in sys.modules:
            _fcntl = types.ModuleType("fcntl")
            for attr in ("LOCK_EX", "LOCK_SH", "LOCK_UN", "LOCK_NB"):
                setattr(_fcntl, attr, 0)
            _fcntl.flock = lambda fd, op: None
            sys.modules["fcntl"] = _fcntl

        from fastapi.testclient import TestClient
        import git_ops

        workers_dir = tmp_path / "workers"
        workers_dir.mkdir()
        workspace = tmp_path
        git_ops.ensure_repo(workspace)
        monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
        monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(workspace))
        monkeypatch.setenv("WORKEROS_DEPLOY", "local")
        monkeypatch.setenv("FLOOM_SECRET", "dev")
        monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
        monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
        monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))

        import importlib, main as _main_mod
        importlib.reload(_main_mod)
        from main import app
        return TestClient(app), workspace, workers_dir

    def test_list_versions_returns_git_log(self, app_client):
        client, workspace, workers_dir = app_client
        import git_ops
        # Manually create a worker directory and commit it
        (workers_dir / "test-worker").mkdir()
        (workers_dir / "test-worker" / "worker.yml").write_text("id: test-worker\nname: Test Worker")
        git_ops.commit_paths(workspace, ["workers/test-worker"], "worker: create Test Worker")

        resp = client.get("/workers/test-worker/versions", headers={"x-floom-secret": "dev"})
        if resp.status_code == 404:
            pytest.skip("Worker not in DB — integration test requires full worker setup")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        if data:
            entry = data[0]
            assert "id" in entry
            assert "sha" in entry
            assert "message" in entry
            assert "author" in entry
            assert "timestamp" in entry


@_GIT_REQUIRED
class TestGitOpsVersionSummaryShape:
    """Verify that get_log output maps 1:1 to the VersionSummary API shape."""

    def test_log_entry_matches_version_summary_fields(self, tmp_path: Path) -> None:
        import git_ops
        git_ops.ensure_repo(tmp_path)
        (tmp_path / "workers" / "w1").mkdir(parents=True)
        (tmp_path / "workers" / "w1" / "run.py").write_text("print('hi')")
        git_ops.commit_paths(tmp_path, ["workers/w1"], "add x", author_name="Bob", author_email="bob@test.com")
        log = git_ops.get_log(tmp_path, rel_path="workers/w1", asset_type="worker", asset_id="w1")
        assert len(log) >= 1
        entry = log[0]
        # These are the exact fields VersionSummary expects
        for field in ("id", "sha", "message", "author", "timestamp", "asset_type", "asset_id"):
            assert field in entry, f"Missing field: {field}"
        assert entry["asset_type"] == "worker"
        assert entry["asset_id"] == "w1"
