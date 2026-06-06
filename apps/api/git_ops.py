"""Git-backed workspace operations.

Every edit to a worker, context, or workspace file becomes a git commit.
History = git log. Rollback = git checkout <sha>.

The git root is ``WORKEROS_WORKSPACE_DIR`` (env var, defaults to WORKERS_DIR.parent).

Path layout inside the repo:
  workers/{worker_id}/        — worker bundles
  contexts/{context_name}/    — brain packs
  workspace.md                — workspace instructions
  workspace.base.md           — editable base persona
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class GitOpsError(Exception):
    pass


def _git(
    args: list[str],
    cwd: Path,
    check: bool = True,
    timeout: int = 30,
) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git"] + args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ},
    )
    if check and result.returncode != 0:
        raise GitOpsError(f"git {args[0]} failed: {result.stderr.strip()}")
    return result


def ensure_repo(workspace_dir: Path) -> bool:
    """Init a git repo at workspace_dir if one doesn't exist.

    Creates a default .gitignore and makes an initial commit of any existing
    files. Returns True if a fresh repo was created, False if already a repo.
    """
    git_dir = workspace_dir / ".git"
    if git_dir.exists():
        return False

    workspace_dir.mkdir(parents=True, exist_ok=True)
    _git(["init"], workspace_dir)
    _git(["config", "user.email", "workeros@local"], workspace_dir)
    _git(["config", "user.name", "WorkerOS"], workspace_dir)

    gitignore = workspace_dir / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text(
            "# WorkerOS workspace — auto-generated\n"
            "*.env\n.env\nsecrets.env\n"
            "workeros.db\nworkeros.db-wal\nworkeros.db-shm\n"
            ".venv/\nnode_modules/\n__pycache__/\n*.pyc\n",
            encoding="utf-8",
        )

    status = _git(["status", "--porcelain"], workspace_dir, check=False)
    if status.stdout.strip():
        _git(["add", "-A"], workspace_dir)
        _git(
            [
                "commit",
                "-m",
                "chore: initial workspace snapshot",
                "--author=WorkerOS <workeros@local>",
            ],
            workspace_dir,
            check=False,
        )

    return True


def commit_paths(
    workspace_dir: Path,
    rel_paths: list[str],
    message: str,
    author_name: str = "WorkerOS",
    author_email: str = "workeros@local",
) -> Optional[str]:
    """Stage rel_paths and create a commit.

    Returns the 7-char short SHA of the new commit, or the current HEAD SHA if
    there was nothing new to commit. Returns None if the repo has no commits
    yet and nothing was staged.
    """
    for rel in rel_paths:
        _git(["add", "--", rel], workspace_dir)

    result = _git(
        [
            "commit",
            "-m",
            message,
            f"--author={author_name} <{author_email}>",
        ],
        workspace_dir,
        check=False,
    )

    if result.returncode != 0:
        stderr = result.stderr + result.stdout
        if "nothing to commit" in stderr or "nothing added to commit" in stderr:
            head = _git(["rev-parse", "HEAD"], workspace_dir, check=False)
            return head.stdout.strip()[:7] if head.returncode == 0 else None
        raise GitOpsError(f"git commit failed: {result.stderr.strip()}")

    sha_result = _git(["rev-parse", "HEAD"], workspace_dir)
    return sha_result.stdout.strip()[:7]


def get_log(
    workspace_dir: Path,
    rel_path: Optional[str] = None,
    limit: int = 50,
    asset_type: str = "",
    asset_id: str = "",
) -> list[dict]:
    """Return commit log for a path (or whole repo), newest first.

    Each entry: {id, sha, message, author, timestamp, asset_type, asset_id}
    id and sha are both the 7-char short hash.
    """
    # %H=full sha  %an=author name  %aI=ISO-8601 date  %s=subject
    fmt = "%H%x00%an%x00%aI%x00%s"
    cmd = ["log", f"--max-count={limit}", f"--format={fmt}"]
    if rel_path:
        cmd += ["--follow", "--", rel_path]

    result = _git(cmd, workspace_dir, check=False)
    if result.returncode != 0 or not result.stdout.strip():
        return []

    entries = []
    for line in result.stdout.strip().splitlines():
        parts = line.split("\x00", 3)
        if len(parts) < 4:
            continue
        sha, author_name, timestamp, message = parts
        short = sha[:7]
        entries.append(
            {
                "id": short,
                "sha": short,
                "message": message or "(no message)",
                "author": author_name,
                "timestamp": timestamp,
                # kept for API compat
                "asset_type": asset_type,
                "asset_id": asset_id,
            }
        )
    return entries


def get_file_at_sha(
    workspace_dir: Path,
    sha: str,
    rel_path: str,
) -> Optional[str]:
    """Return the text content of rel_path at commit sha, or None if missing."""
    result = _git(["show", f"{sha}:{rel_path}"], workspace_dir, check=False)
    if result.returncode != 0:
        return None
    return result.stdout


def list_files_at_sha(
    workspace_dir: Path,
    sha: str,
    prefix: str,
) -> list[str]:
    """List all file paths under prefix at commit sha (relative to workspace_dir)."""
    result = _git(
        ["ls-tree", "-r", "--name-only", sha, "--", prefix],
        workspace_dir,
        check=False,
    )
    if result.returncode != 0:
        return []
    return [p for p in result.stdout.strip().splitlines() if p]


def checkout_path(
    workspace_dir: Path,
    sha: str,
    rel_path: str,
) -> None:
    """Restore rel_path to its state at commit sha (modifies working tree only)."""
    _git(["checkout", sha, "--", rel_path], workspace_dir)


def configure_remote(workspace_dir: Path, remote_url: str) -> None:
    """Set or replace the 'origin' remote."""
    _git(["remote", "remove", "origin"], workspace_dir, check=False)
    _git(["remote", "add", "origin", remote_url], workspace_dir)


def push(workspace_dir: Path) -> None:
    """Push HEAD to origin."""
    _git(["push", "-u", "origin", "HEAD"], workspace_dir, timeout=60)


def pull(workspace_dir: Path) -> None:
    """Pull from origin (fast-forward only)."""
    _git(["pull", "--ff-only"], workspace_dir, timeout=60)
