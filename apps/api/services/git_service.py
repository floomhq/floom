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
    resolved via the workspace_id resolver registered by managed-deployment at startup.

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
