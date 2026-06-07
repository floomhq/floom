"""Tests for cloud_git_local — local git + Supabase Storage bundle workflow.

Covers:
- Repo initialisation (fresh init, bundle restore)
- commit_workspace (file writes, git commit, bundle upload)
- sync_checkout_to_workers (post-rollback disk + Supabase sync)
- upload/restore bundle round-trip
- _dispatch_write routing
"""
from __future__ import annotations

import os
import subprocess
import textwrap
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

WORKSPACE_ID = "ws-test-1234"


def _make_git_dir(tmp_path: Path) -> Path:
    """Init a real git repo in tmp_path for testing."""
    subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=str(tmp_path), check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=str(tmp_path), check=True, capture_output=True)
    return tmp_path


def _commit_file(git_dir: Path, rel_path: str, content: str) -> str:
    """Write a file and commit it. Returns the short SHA."""
    fpath = git_dir / rel_path
    fpath.parent.mkdir(parents=True, exist_ok=True)
    fpath.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=str(git_dir), check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", f"add {rel_path}", "--author=Test <test@test.com>"],
        cwd=str(git_dir),
        check=True,
        capture_output=True,
    )
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(git_dir),
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()[:7]


# ---------------------------------------------------------------------------
# get_workspaces_root / get_workspace_git_dir
# ---------------------------------------------------------------------------

def test_get_workspaces_root_env_override(tmp_path):
    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(tmp_path)}):
        from apps.api.cloud_git_local import get_workspaces_root
        assert get_workspaces_root() == tmp_path


def test_get_workspace_git_dir(tmp_path):
    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(tmp_path)}):
        from apps.api.cloud_git_local import get_workspace_git_dir
        result = get_workspace_git_dir("abc-123")
        assert result == tmp_path / "abc-123"


# ---------------------------------------------------------------------------
# ensure_workspace_repo — fresh init
# ---------------------------------------------------------------------------

def test_ensure_workspace_repo_init_fresh(tmp_path):
    ws_root = tmp_path / "workspaces"
    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        mock_storage = MagicMock()
        mock_storage.from_().download.side_effect = Exception("not found")
        mock_svc = MagicMock()
        mock_svc.storage = mock_storage

        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            from apps.api.cloud_git_local import ensure_workspace_repo
            git_dir = ensure_workspace_repo(WORKSPACE_ID)

    assert (git_dir / ".git").exists()
    assert git_dir == ws_root / WORKSPACE_ID


def test_ensure_workspace_repo_fast_path(tmp_path):
    """If .git already exists, no storage call is made."""
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client") as mock_svc:
            from apps.api.cloud_git_local import ensure_workspace_repo
            result = ensure_workspace_repo(WORKSPACE_ID)
            mock_svc.assert_not_called()

    assert result == git_dir


# ---------------------------------------------------------------------------
# ensure_workspace_repo — bundle restore
# ---------------------------------------------------------------------------

def test_ensure_workspace_repo_restores_bundle(tmp_path):
    """When a bundle exists in Storage, the repo is cloned from it."""
    ws_root = tmp_path / "workspaces"

    # Create a real bundle from a real repo
    src_dir = tmp_path / "src"
    _make_git_dir(src_dir)
    _commit_file(src_dir, "workers/w1/worker.yml", "name: w1\n")
    bundle_path = tmp_path / "repo.bundle"
    subprocess.run(
        ["git", "bundle", "create", str(bundle_path), "--all"],
        cwd=str(src_dir),
        check=True,
        capture_output=True,
    )
    bundle_bytes = bundle_path.read_bytes()

    mock_storage = MagicMock()
    mock_storage.from_().download.return_value = bundle_bytes
    mock_svc = MagicMock()
    mock_svc.storage = mock_storage

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            from apps.api.cloud_git_local import ensure_workspace_repo
            git_dir = ensure_workspace_repo(WORKSPACE_ID)

    assert (git_dir / ".git").exists()
    assert (git_dir / "workers" / "w1" / "worker.yml").exists()


# ---------------------------------------------------------------------------
# commit_workspace
# ---------------------------------------------------------------------------

def test_commit_workspace_worker(tmp_path):
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)

    manifest = {
        "name": "my-worker",
        "description": "test",
        "_files": {"run.py": "print('hello')\n"},
    }

    mock_svc = MagicMock()
    mock_svc.table().select().eq().eq().limit().execute.return_value.data = [
        {"skill_version_id": "sv-111"}
    ]
    mock_svc.table().select().eq().limit().execute.return_value.data = [
        {"manifest_json": manifest}
    ]
    mock_storage = MagicMock()
    mock_svc.storage = mock_storage

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            with patch("apps.api.cloud_git_local.upload_bundle_background") as mock_upload:
                from apps.api.cloud_git_local import commit_workspace
                sha = commit_workspace(WORKSPACE_ID, ["workers/w1"], "feat: add worker")

    assert sha is not None
    assert len(sha) == 7
    assert (git_dir / "workers" / "w1" / "run.py").exists()
    assert (git_dir / "workers" / "w1" / "worker.yml").exists()
    mock_upload.assert_called_once_with(WORKSPACE_ID)


def test_commit_workspace_no_changes_returns_head(tmp_path):
    """If nothing is written (e.g. unknown rel_path), returns None gracefully."""
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)

    mock_svc = MagicMock()
    mock_svc.table().select().eq().eq().limit().execute.return_value.data = []
    mock_svc.storage = MagicMock()

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            from apps.api.cloud_git_local import commit_workspace
            sha = commit_workspace(WORKSPACE_ID, ["workers/nonexistent"], "test")

    assert sha is None


def test_commit_workspace_skips_secrets(tmp_path):
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client"):
            from apps.api.cloud_git_local import commit_workspace
            sha = commit_workspace(WORKSPACE_ID, [".secrets.enc"], "test")

    assert sha is None
    assert not (git_dir / ".secrets.enc").exists()


# ---------------------------------------------------------------------------
# _upload_bundle / upload_bundle_background
# ---------------------------------------------------------------------------

def test_upload_bundle_uploads_to_storage(tmp_path):
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)
    _commit_file(git_dir, "workers/w1/worker.yml", "name: w1\n")

    mock_storage = MagicMock()
    mock_storage.from_().upload.return_value = None
    mock_svc = MagicMock()
    mock_svc.storage = mock_storage

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            from apps.api.cloud_git_local import _upload_bundle
            _upload_bundle(WORKSPACE_ID)

    mock_storage.from_().upload.assert_called_once()
    call_args = mock_storage.from_().upload.call_args
    assert call_args.kwargs["path"] == f"{WORKSPACE_ID}/repo.bundle"
    assert len(call_args.kwargs["file"]) > 0


def test_upload_bundle_skips_when_no_commits(tmp_path):
    """Fresh repo with no commits: bundle upload is skipped silently."""
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)  # no commits

    mock_svc = MagicMock()

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            from apps.api.cloud_git_local import _upload_bundle
            _upload_bundle(WORKSPACE_ID)  # should not raise

    mock_svc.storage.from_().upload.assert_not_called()


# ---------------------------------------------------------------------------
# sync_checkout_to_workers
# ---------------------------------------------------------------------------

def test_sync_checkout_to_workers_writes_disk_and_supabase(tmp_path):
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    workers_dir = tmp_path / "floom_workers"

    # Set up git workspace with worker files
    worker_dir = git_dir / "workers" / "w1"
    worker_dir.mkdir(parents=True)
    (worker_dir / "worker.yml").write_text("name: w1\ndescription: test\n", encoding="utf-8")
    (worker_dir / "run.py").write_text("print('v1')\n", encoding="utf-8")

    mock_svc = MagicMock()
    mock_svc.table().select().eq().eq().limit().execute.return_value.data = [
        {"skill_version_id": "sv-222"}
    ]

    with patch.dict(os.environ, {
        "WORKEROS_GIT_WORKSPACES_DIR": str(ws_root),
        "FLOOM_WORKERS_DIR": str(workers_dir),
    }):
        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            from apps.api.cloud_git_local import sync_checkout_to_workers
            sync_checkout_to_workers(WORKSPACE_ID, git_dir, "workers/w1")

    assert (workers_dir / "w1" / "worker.yml").exists()
    assert (workers_dir / "w1" / "run.py").read_text() == "print('v1')\n"
    mock_svc.table().update().eq().execute.assert_called()


def test_sync_checkout_to_workers_noop_for_non_workers(tmp_path):
    """sync_checkout_to_workers skips paths that don't start with workers/."""
    with patch("apps.api.cloud_git_local.get_supabase_service_client") as mock_svc:
        from apps.api.cloud_git_local import sync_checkout_to_workers
        sync_checkout_to_workers(WORKSPACE_ID, tmp_path, "contexts/my-context")
        mock_svc.assert_not_called()


# ---------------------------------------------------------------------------
# _dispatch_write routing
# ---------------------------------------------------------------------------

def test_dispatch_write_skips_secrets(tmp_path):
    from apps.api.cloud_git_local import _dispatch_write
    result = _dispatch_write(tmp_path, WORKSPACE_ID, ".secrets.enc")
    assert result is False


def test_dispatch_write_routes_workers_prefix(tmp_path):
    with patch("apps.api.cloud_git_local._write_worker", return_value=True) as mock_w:
        from apps.api.cloud_git_local import _dispatch_write
        result = _dispatch_write(tmp_path, WORKSPACE_ID, "workers/abc-123")
    mock_w.assert_called_once_with(tmp_path, WORKSPACE_ID, "abc-123")
    assert result is True


def test_dispatch_write_routes_contexts_prefix(tmp_path):
    with patch("apps.api.cloud_git_local._write_context", return_value=True) as mock_c:
        from apps.api.cloud_git_local import _dispatch_write
        result = _dispatch_write(tmp_path, WORKSPACE_ID, "contexts/my-ctx")
    mock_c.assert_called_once_with(tmp_path, WORKSPACE_ID, "my-ctx")
    assert result is True


def test_dispatch_write_routes_workspace_tools(tmp_path):
    with patch("apps.api.cloud_git_local._write_workspace_tools", return_value=True) as mock_t:
        from apps.api.cloud_git_local import _dispatch_write
        result = _dispatch_write(tmp_path, WORKSPACE_ID, "workspace-tools.yml")
    mock_t.assert_called_once_with(tmp_path, WORKSPACE_ID)
    assert result is True


def test_dispatch_write_routes_bare_worker_id(tmp_path):
    with patch("apps.api.cloud_git_local._write_worker", return_value=True) as mock_w:
        from apps.api.cloud_git_local import _dispatch_write
        result = _dispatch_write(tmp_path, WORKSPACE_ID, "some-uuid-1234")
    mock_w.assert_called_once_with(tmp_path, WORKSPACE_ID, "some-uuid-1234")
    assert result is True


# ---------------------------------------------------------------------------
# ensure_bucket
# ---------------------------------------------------------------------------

def test_ensure_bucket_creates_bucket(tmp_path):
    mock_svc = MagicMock()
    mock_svc.storage.create_bucket.return_value = None
    with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
        from apps.api.cloud_git_local import ensure_bucket
        ensure_bucket()
    mock_svc.storage.create_bucket.assert_called_once_with(
        "workeros-git-bundles",
        options={"public": False},
    )


# ---------------------------------------------------------------------------
# configure_remote / remove_remote / push_background
# ---------------------------------------------------------------------------

def test_configure_remote_sets_origin(tmp_path):
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client"):
            from apps.api.cloud_git_local import configure_remote
            configure_remote(WORKSPACE_ID, "https://token@github.com/owner/repo.git")

    result = subprocess.run(
        ["git", "remote", "get-url", "origin"], cwd=str(git_dir),
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "github.com/owner/repo.git" in result.stdout


def test_configure_remote_replaces_existing(tmp_path):
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)
    subprocess.run(["git", "remote", "add", "origin", "https://old@github.com/old/repo.git"],
                   cwd=str(git_dir), check=True, capture_output=True)

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client"):
            from apps.api.cloud_git_local import configure_remote
            configure_remote(WORKSPACE_ID, "https://new@gitlab.com/owner/repo.git")

    result = subprocess.run(["git", "remote", "get-url", "origin"], cwd=str(git_dir),
                            capture_output=True, text=True)
    assert "gitlab.com" in result.stdout


def test_remove_remote_removes_origin(tmp_path):
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)
    subprocess.run(["git", "remote", "add", "origin", "https://token@github.com/owner/repo.git"],
                   cwd=str(git_dir), check=True, capture_output=True)

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        from apps.api.cloud_git_local import remove_remote
        remove_remote(WORKSPACE_ID)

    result = subprocess.run(["git", "remote"], cwd=str(git_dir), capture_output=True, text=True)
    assert "origin" not in result.stdout


def test_push_background_noop_when_no_remote(tmp_path):
    """push_background exits silently when no remote is configured."""
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)
    _commit_file(git_dir, "test.txt", "hello")

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        from apps.api.cloud_git_local import push_background
        push_background(WORKSPACE_ID)  # should not raise


def test_push_background_noop_when_no_git_dir(tmp_path):
    ws_root = tmp_path / "workspaces"
    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        from apps.api.cloud_git_local import push_background
        push_background(WORKSPACE_ID)  # no .git dir — should not raise


def test_ensure_bucket_ignores_already_exists(tmp_path):
    mock_svc = MagicMock()
    mock_svc.storage.create_bucket.side_effect = Exception("already exists")
    with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
        from apps.api.cloud_git_local import ensure_bucket
        ensure_bucket()  # should not raise


# ---------------------------------------------------------------------------
# _backfill_worker_files_from_git
# ---------------------------------------------------------------------------

def test_backfill_updates_supabase_when_files_missing(tmp_path):
    """Workers with empty _files in Supabase get them backfilled from the git dir."""
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID

    # Set up git workspace with a worker
    worker_dir = git_dir / "workers" / "w1"
    worker_dir.mkdir(parents=True)
    (worker_dir / "worker.yml").write_text("name: w1\ndescription: test\n", encoding="utf-8")
    (worker_dir / "run.py").write_text("print('hello')\n", encoding="utf-8")

    # Supabase returns worker with empty _files
    mock_svc = MagicMock()
    mock_svc.table().select().eq().eq().limit().execute.return_value.data = [
        {"skill_version_id": "sv-111"}
    ]
    mock_svc.table().select().eq().limit().execute.return_value.data = [
        {"manifest_json": {"name": "w1", "_files": {}}}
    ]

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            from apps.api.cloud_git_local import _backfill_worker_files_from_git
            _backfill_worker_files_from_git(WORKSPACE_ID, git_dir)

    # Should have called update with _files populated
    # Access via return_value chain to avoid triggering a new mock call
    update_mock = mock_svc.table.return_value.update
    update_mock.assert_called()
    manifest_arg = update_mock.call_args.args[0]["manifest_json"]
    assert "run.py" in manifest_arg["_files"]
    assert manifest_arg["_files"]["run.py"] == "print('hello')\n"


def test_backfill_skips_workers_that_already_have_files(tmp_path):
    """Workers that already have _files in Supabase are not touched."""
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    worker_dir = git_dir / "workers" / "w1"
    worker_dir.mkdir(parents=True)
    (worker_dir / "worker.yml").write_text("name: w1\n", encoding="utf-8")
    (worker_dir / "run.py").write_text("print('existing')\n", encoding="utf-8")

    mock_svc = MagicMock()
    mock_svc.table().select().eq().eq().limit().execute.return_value.data = [
        {"skill_version_id": "sv-222"}
    ]
    mock_svc.table().select().eq().limit().execute.return_value.data = [
        {"manifest_json": {"name": "w1", "_files": {"run.py": "print('existing')"}}}
    ]

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            from apps.api.cloud_git_local import _backfill_worker_files_from_git
            _backfill_worker_files_from_git(WORKSPACE_ID, git_dir)

    mock_svc.table().update.assert_not_called()


def test_backfill_skips_dirs_without_worker_yml(tmp_path):
    """Directories without worker.yml are skipped silently."""
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    (git_dir / "workers" / "w1").mkdir(parents=True)
    # No worker.yml

    mock_svc = MagicMock()
    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            from apps.api.cloud_git_local import _backfill_worker_files_from_git
            _backfill_worker_files_from_git(WORKSPACE_ID, git_dir)

    mock_svc.table().update.assert_not_called()


def test_ensure_workspace_repo_triggers_backfill_on_restore(tmp_path):
    """After restoring from a bundle, backfill is called automatically."""
    ws_root = tmp_path / "workspaces"

    # Create a real bundle with a worker
    src_dir = tmp_path / "src"
    _make_git_dir(src_dir)
    (src_dir / "workers" / "w1").mkdir(parents=True)
    (src_dir / "workers" / "w1" / "worker.yml").write_text("name: w1\n", encoding="utf-8")
    (src_dir / "workers" / "w1" / "run.py").write_text("print('v1')\n", encoding="utf-8")
    _commit_file(src_dir, "workers/w1/worker.yml", "name: w1\n")
    import tempfile as _tf
    bundle_tmp = tmp_path / "repo.bundle"
    subprocess.run(["git", "bundle", "create", str(bundle_tmp), "--all"],
                   cwd=str(src_dir), check=True, capture_output=True)
    bundle_bytes = bundle_tmp.read_bytes()

    mock_storage = MagicMock()
    mock_storage.from_().download.return_value = bundle_bytes
    mock_svc = MagicMock()
    mock_svc.storage = mock_storage
    # Worker has no _files in Supabase
    mock_svc.table().select().eq().eq().limit().execute.return_value.data = [
        {"skill_version_id": "sv-333"}
    ]
    mock_svc.table().select().eq().limit().execute.return_value.data = [
        {"manifest_json": {"name": "w1", "_files": {}}}
    ]

    with patch.dict(os.environ, {"WORKEROS_GIT_WORKSPACES_DIR": str(ws_root)}):
        with patch("apps.api.cloud_git_local.get_supabase_service_client", return_value=mock_svc):
            from apps.api.cloud_git_local import ensure_workspace_repo
            git_dir = ensure_workspace_repo(WORKSPACE_ID)

    assert (git_dir / ".git").exists()
    # update should have been called to backfill _files
    mock_svc.table().update.assert_called()


# ---------------------------------------------------------------------------
# Sensitive context tests
# ---------------------------------------------------------------------------

def _reset_contexts_module():
    """Clear cached contexts module so env var changes take effect."""
    import sys
    for mod in [k for k in list(sys.modules) if k == "contexts" or k.startswith("contexts.")]:
        sys.modules.pop(mod)


def _make_context_dir(contexts_root: Path, name: str, sensitive: bool | None = None) -> Path:
    """Create a context directory with an optional sensitive flag in metadata."""
    ctx_dir = contexts_root / name
    ctx_dir.mkdir(parents=True, exist_ok=True)
    (ctx_dir / "notes.txt").write_text("secret data\n", encoding="utf-8")
    if sensitive is not None:
        meta = contexts_root / ".workeros-contexts.json"
        existing = {}
        if meta.exists():
            import json as _json
            existing = _json.loads(meta.read_text())
        existing[name] = {"sensitive": sensitive}
        import json as _json
        meta.write_text(_json.dumps(existing))
    return ctx_dir


def test_write_context_skips_sensitive_context(tmp_path):
    """_write_context returns False and writes nothing to git for sensitive contexts."""
    _reset_contexts_module()
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)
    contexts_root = tmp_path / "contexts"
    contexts_root.mkdir()
    _make_context_dir(contexts_root, "private-docs", sensitive=True)

    with patch.dict(os.environ, {
        "WORKEROS_GIT_WORKSPACES_DIR": str(ws_root),
        "FLOOM_CONTEXTS_DIR": str(contexts_root),
    }):
        with patch("apps.api.cloud_git_local.get_supabase_service_client"):
            from apps.api.cloud_git_local import _write_context
            result = _write_context(git_dir, WORKSPACE_ID, "private-docs")

    assert result is False
    # Nothing written to git workspace
    assert not (git_dir / "contexts" / "private-docs").exists()


def test_write_context_skips_when_no_metadata(tmp_path):
    """_write_context returns False when context has no metadata (default=sensitive)."""
    _reset_contexts_module()
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)
    contexts_root = tmp_path / "contexts"
    contexts_root.mkdir()
    # Create context dir with no metadata entry — defaults to sensitive
    _make_context_dir(contexts_root, "new-pack", sensitive=None)

    with patch.dict(os.environ, {
        "WORKEROS_GIT_WORKSPACES_DIR": str(ws_root),
        "FLOOM_CONTEXTS_DIR": str(contexts_root),
    }):
        with patch("apps.api.cloud_git_local.get_supabase_service_client"):
            from apps.api.cloud_git_local import _write_context
            result = _write_context(git_dir, WORKSPACE_ID, "new-pack")

    assert result is False
    assert not (git_dir / "contexts" / "new-pack").exists()


def test_write_context_writes_when_non_sensitive(tmp_path):
    """_write_context writes to git workspace when sensitive=False."""
    _reset_contexts_module()
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)
    contexts_root = tmp_path / "contexts"
    contexts_root.mkdir()
    _make_context_dir(contexts_root, "shared-docs", sensitive=False)

    with patch.dict(os.environ, {
        "WORKEROS_GIT_WORKSPACES_DIR": str(ws_root),
        "FLOOM_CONTEXTS_DIR": str(contexts_root),
    }):
        with patch("apps.api.cloud_git_local.get_supabase_service_client"):
            from apps.api.cloud_git_local import _write_context
            result = _write_context(git_dir, WORKSPACE_ID, "shared-docs")

    assert result is True
    assert (git_dir / "contexts" / "shared-docs" / "notes.txt").exists()


def test_commit_workspace_skips_sensitive_context(tmp_path):
    """commit_workspace makes no git commit when context path is sensitive."""
    _reset_contexts_module()
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)
    contexts_root = tmp_path / "contexts"
    contexts_root.mkdir()
    _make_context_dir(contexts_root, "classified", sensitive=True)

    # Seed one commit so HEAD exists
    _commit_file(git_dir, "workers/dummy/worker.yml", "name: dummy\n")
    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(git_dir),
        capture_output=True, text=True
    ).stdout.strip()

    with patch.dict(os.environ, {
        "WORKEROS_GIT_WORKSPACES_DIR": str(ws_root),
        "FLOOM_CONTEXTS_DIR": str(contexts_root),
    }):
        with patch("apps.api.cloud_git_local.get_supabase_service_client"):
            from apps.api.cloud_git_local import commit_workspace
            sha = commit_workspace(WORKSPACE_ID, ["contexts/classified"], "test: sensitive ctx")

    head_after = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(git_dir),
        capture_output=True, text=True
    ).stdout.strip()

    assert sha is None
    assert head_before == head_after  # no new commit


def test_commit_workspace_commits_non_sensitive_context(tmp_path):
    """commit_workspace creates a git commit when context is explicitly non-sensitive."""
    _reset_contexts_module()
    ws_root = tmp_path / "workspaces"
    git_dir = ws_root / WORKSPACE_ID
    _make_git_dir(git_dir)
    contexts_root = tmp_path / "contexts"
    contexts_root.mkdir()
    _make_context_dir(contexts_root, "public-docs", sensitive=False)

    _commit_file(git_dir, "workers/dummy/worker.yml", "name: dummy\n")
    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(git_dir),
        capture_output=True, text=True
    ).stdout.strip()

    with patch.dict(os.environ, {
        "WORKEROS_GIT_WORKSPACES_DIR": str(ws_root),
        "FLOOM_CONTEXTS_DIR": str(contexts_root),
    }):
        with patch("apps.api.cloud_git_local.get_supabase_service_client"):
            from apps.api.cloud_git_local import commit_workspace
            sha = commit_workspace(WORKSPACE_ID, ["contexts/public-docs"], "test: non-sensitive ctx")

    head_after = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(git_dir),
        capture_output=True, text=True
    ).stdout.strip()

    assert sha is not None
    assert head_after != head_before  # new commit created
    assert (git_dir / "contexts" / "public-docs" / "notes.txt").exists()
