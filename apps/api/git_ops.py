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
import re
import subprocess
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Safety guard: never version into the engine's own source checkout
#
# _git_workspace() falls back to WORKERS_DIR.parent when WORKEROS_WORKSPACE_DIR
# is unset. If the server is run from inside a clone of the WorkerOS source repo
# (the common dev case), that fallback IS the source checkout — so every worker/
# context/workspace edit would auto-commit into the engine's own repo, and
# push_background would push it to that repo's origin (e.g. floomhq/workeros).
#
# Fail safe: if the workspace root is the engine source checkout, skip committing
# and pushing entirely. To enable versioning, the operator sets
# WORKEROS_WORKSPACE_DIR to a separate directory (local history; this moves the
# root off the source tree so the guard no longer trips) and optionally
# WORKEROS_GIT_REMOTE to push to their own repo.
# ---------------------------------------------------------------------------

_engine_source_warned = False


def is_engine_source_checkout(workspace_dir: Path) -> bool:
    """True if workspace_dir is the WorkerOS engine's own source tree.

    Detected by the engine entrypoint apps/api/main.py at the root. We must never
    auto-commit or push workspace snapshots into it.
    """
    try:
        return (Path(workspace_dir) / "apps" / "api" / "main.py").is_file()
    except OSError:  # pragma: no cover - defensive
        return False


def _block_engine_source_versioning(workspace_dir: Path) -> bool:
    """Return True (and warn once) when versioning must be skipped because the
    workspace root is the engine source checkout."""
    if not is_engine_source_checkout(workspace_dir):
        return False
    global _engine_source_warned
    if not _engine_source_warned:
        _engine_source_warned = True
        logger.warning(
            "Workspace git versioning DISABLED: workspace root %s is the WorkerOS "
            "source checkout. Worker/context/workspace edits will not be committed "
            "or pushed (prevents leaking them into the engine repo and its origin). "
            "Set WORKEROS_WORKSPACE_DIR to a separate directory to enable local "
            "history, and WORKEROS_GIT_REMOTE to push to your own repo.",
            workspace_dir,
        )
    return True


# ---------------------------------------------------------------------------
# Workspace ID resolver — cloud hook
#
# In OSS single-tenant mode this is never set; everything lives in one repo.
# In cloud multi-tenant mode, workeros-cloud registers a callable that returns
# the active workspace_id for the current request (same pattern as
# contexts.set_context_scope_resolver). The engine uses it to scope the git
# root to the right per-workspace directory.
# ---------------------------------------------------------------------------

_workspace_id_resolver: Optional[Callable[[], Optional[str]]] = None


def set_workspace_id_resolver(fn: Optional[Callable[[], Optional[str]]]) -> None:
    """Register a callable that returns the active workspace_id per request.

    Called by workeros-cloud at startup. Pass ``None`` to clear (OSS mode).
    The callable MUST return either a safe workspace_id string or None.
    """
    global _workspace_id_resolver
    _workspace_id_resolver = fn


def get_active_workspace_id() -> Optional[str]:
    """Return the workspace_id for the current request, or None in OSS mode."""
    if _workspace_id_resolver is None:
        return None
    try:
        return _workspace_id_resolver()
    except Exception:
        return None


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


def clone_or_init(workspace_dir: Path, remote_url: str) -> bool:
    """Clone remote_url into workspace_dir if it doesn't exist yet.

    Use this instead of ensure_repo() when a remote URL is configured on a
    fresh install — it does 'git clone' so the full history arrives intact.
    Returns True if a clone was performed.
    """
    git_dir = workspace_dir / ".git"
    if git_dir.exists():
        return False  # already have a repo, nothing to clone

    workspace_dir.mkdir(parents=True, exist_ok=True)
    # Clone into a temp subdir then move contents up, since git clone requires
    # an empty target.  Simpler: clone into the dir directly (git allows it
    # when the dir is empty or has only non-git files).
    result = _git(["clone", remote_url, "."], workspace_dir, check=False, timeout=120)
    if result.returncode != 0:
        raise GitOpsError(
            f"git clone failed: {result.stderr.strip()}\n"
            "Check WORKEROS_GIT_REMOTE and that the token/SSH key has read access."
        )
    _git(["config", "user.email", "workeros@local"], workspace_dir)
    _git(["config", "user.name", "WorkerOS"], workspace_dir)
    return True


def ensure_repo(workspace_dir: Path) -> bool:
    """Init a git repo at workspace_dir if one doesn't exist.

    Creates a default .gitignore and makes an initial commit of any existing
    files. Returns True if a fresh repo was created, False if already a repo.

    If a remote URL is configured (WORKEROS_GIT_REMOTE), call clone_or_init()
    instead so a fresh install clones the full history rather than starting blank.
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
    if _block_engine_source_versioning(workspace_dir):
        return None
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


def get_file_bytes_at_sha(
    workspace_dir: Path,
    sha: str,
    rel_path: str,
) -> Optional[bytes]:
    """Return raw bytes for rel_path at commit sha, or None if missing."""
    result = subprocess.run(
        ["git", "show", f"{sha}:{rel_path}"],
        cwd=str(workspace_dir),
        capture_output=True,
        timeout=30,
        env={**os.environ},
    )
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


_SHA_RE = re.compile(r"^[0-9a-f]{4,40}$")


def sha_in_path_history(
    workspace_dir: Path,
    sha: str,
    rel_path: str,
) -> bool:
    """True when ``sha`` (full or short, >=4 hex chars) is a commit that
    touched ``rel_path``.

    #928: rollback/restore endpoints must only accept SHAs from the target
    asset's own history — an arbitrary commit id from the shared workspace
    repo would otherwise let one user inject file states from another user's
    workers or brain packs.
    """
    candidate = (sha or "").strip().lower()
    if not _SHA_RE.fullmatch(candidate):
        return False
    # No --follow: it requires a single-file pathspec, and rollback targets
    # include directories (worker bundles, brain packs).
    result = _git(
        ["log", "--format=%H", "--", rel_path],
        workspace_dir,
        check=False,
    )
    if result.returncode != 0:
        return False
    return any(
        line.startswith(candidate)
        for line in result.stdout.strip().splitlines()
    )


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


def push_background(workspace_dir: Path) -> None:
    """Push to origin in a daemon thread — fires after every commit, never blocks.

    Silently skips if no remote is configured. Errors are logged at DEBUG level
    so a transient network blip never surfaces to the user.
    """
    import threading

    def _run() -> None:
        try:
            if _block_engine_source_versioning(workspace_dir):
                return
            has_remote = _git(["remote", "get-url", "origin"], workspace_dir, check=False)
            if has_remote.returncode != 0:
                return
            _git(["push", "-u", "origin", "HEAD"], workspace_dir, check=False, timeout=60)
        except Exception as exc:
            logger.debug("Background git push failed (non-fatal): %s", exc)

    threading.Thread(target=_run, daemon=True, name="workeros-git-push").start()


def pull(workspace_dir: Path) -> None:
    """Pull from origin (fast-forward only)."""
    _git(["pull", "--ff-only"], workspace_dir, timeout=60)
