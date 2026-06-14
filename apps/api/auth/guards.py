"""Authorization guards shared across route groups.

Body-level checks raised inside handlers (not FastAPI dependencies), so route
groups extracted from main.py can import them lazily without binding the auth
package at module load. Moved verbatim from main.py.
"""

from __future__ import annotations

from fastapi import HTTPException

from .context import AuthContext


def _require_admin(auth: AuthContext) -> None:
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="admin required")


def _require_workspace_write(auth: AuthContext) -> None:
    """#804: workspace instructions (workspace.md / workspace.base.md) are admin-write.

    Members are read-only and get a server-enforced 403 — not merely a hidden UI.
    AI worker-authoring still works: run-token auth carries role="member" by design
    (see auth/multi_member.py), so allow auth_method=="run_token" through; those calls
    are what the handlers record as source="ai".
    """
    if auth.is_admin or auth.auth_method == "run_token":
        return
    raise HTTPException(status_code=403, detail="admin required to edit workspace instructions")
