"""Git workspace resolution and commit-identity helpers.

Extracted from main.py. These are pure resolution helpers used across the
worker, context, and workspace route groups. They depend only on leaf modules
(``git_ops`` for the active-workspace resolver, ``worker_registry`` for the
workers directory), never on ``main``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from auth import AuthContext


def _git_workspace() -> Path:
    """Return the git workspace root for the current request.

    OSS (single-tenant): WORKEROS_WORKSPACE_DIR env var, or WORKERS_DIR.parent.
    Cloud (multi-tenant): WORKERS_DIR / {workspace_id} — one git repo per workspace,
    resolved via the workspace_id resolver registered by workeros-cloud at startup.

    git_ops and worker_registry are resolved lazily: the test suite pops and
    re-imports worker_registry (with a temp WORKERS_DIR) between cases, so binding
    WORKERS_DIR at module load would pin this helper to a stale directory.
    """
    import git_ops as _git_ops
    from worker_registry import WORKERS_DIR

    custom = os.environ.get("WORKEROS_WORKSPACE_DIR", "").strip()
    if custom:
        return Path(custom).resolve()
    workspace_id = _git_ops.get_active_workspace_id()
    if workspace_id:
        # Cloud: each workspace has its own git repo under WORKERS_DIR
        return (WORKERS_DIR / workspace_id).resolve()
    # OSS: single workspace at WORKERS_DIR.parent
    return WORKERS_DIR.parent.resolve()


def _git_author(auth: "AuthContext") -> tuple[str, str]:
    """Return (author_name, author_email) suitable for a git commit."""
    name = getattr(auth, "username", None) or getattr(auth, "user_id", None) or "WorkerOS"
    email = getattr(auth, "email", None) or f"{name}@workeros.local"
    return name, email


import threading

_git_ops_lock = threading.Lock()

_WORKSPACE_TOOLS_FILENAME = "workspace-tools.yml"


def _ensure_git_workspace_ready(workspace: Path) -> None:
    """Initialize the git workspace before path-level commit helpers run."""
    import git_ops as _git_ops

    remote = os.environ.get("WORKEROS_GIT_REMOTE", "").strip()
    if remote and not (workspace / ".git").exists():
        _git_ops.clone_or_init(workspace, remote)
    else:
        _git_ops.ensure_repo(workspace)
        if remote:
            _git_ops.configure_remote(workspace, remote)


def _sync_workspace_tools_yml(user_id: str, repos) -> None:
    """Write all MCP tools to workspace-tools.yml and commit to git.

    Called after every create/update/delete so the file is always the
    authoritative source of truth for the workspace's tool registrations.
    """
    import logging

    import git_ops as _git_ops
    import yaml as pyyaml

    logger = logging.getLogger("floom.api")
    try:
        tools = repos.mcp_tools.list(user_id=user_id)
        doc = {
            "version": 1,
            "tools": [
                {
                    "id": t["id"],
                    "name": t["name"],
                    "worker_id": t["worker_id"],
                    "description": t.get("description", ""),
                }
                for t in tools
            ],
        }
        workspace = _git_workspace()
        yml_path = workspace / _WORKSPACE_TOOLS_FILENAME
        yml_path.write_text(
            pyyaml.safe_dump(doc, sort_keys=False, default_flow_style=False, allow_unicode=True),
            encoding="utf-8",
        )
        with _git_ops_lock:
            _ensure_git_workspace_ready(workspace)
            _git_ops.commit_paths(
                workspace, [_WORKSPACE_TOOLS_FILENAME],
                f"tools: update workspace-tools.yml ({len(tools)} tool{'s' if len(tools) != 1 else ''})",
            )
            _git_ops.push_background(workspace)
    except Exception as exc:
        logger.warning("Failed to sync %s: %s", _WORKSPACE_TOOLS_FILENAME, exc)
