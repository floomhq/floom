"""Cloud git config helpers.

Thin module — git operations (commit, push, rollback) now live in
cloud_git_local.py using real git commands against a per-workspace local
repo. This module retains only the Supabase config lookup used by the
startup overrides and fallback paths.
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


def get_git_cfg(workspace_id: str) -> Optional[dict]:
    """Return the git_workspace_config row for the workspace, or None."""
    from apps.api.config import get_supabase_service_client
    try:
        svc = get_supabase_service_client()
        rows = (
            svc.table("git_workspace_config")
            .select(
                "github_pat,github_username,repo_full_name,repo_url,"
                "remote_url,connected_at,last_pushed_at"
            )
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
        return rows.data[0] if rows.data else None
    except Exception as exc:
        logger.debug("get_git_cfg failed for %s: %s", workspace_id, exc)
        return None
