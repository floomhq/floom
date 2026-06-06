from __future__ import annotations

import os

from fastapi import Request

from .context import AuthContext, set_current_auth_context
from .factory import get_auth_provider
from .local_workspaces import scope_local_auth_context


def _local_dev_context() -> AuthContext:
    """Default identity for single-tenant local dev (no FLOOM_SECRET, no users in DB).

    MultiMemberAuthProvider handles this case itself (dev mode path 4), so this
    function is only called when WORKEROS_DEPLOY=local AND no secret is set AND
    we cannot reach the DB (e.g. during early startup before init_db).
    """
    user_id = (os.environ.get("WORKEROS_USER_ID") or "federico").strip() or "federico"
    return AuthContext(user_id=user_id, email=None, scopes=("admin",), role="admin", auth_method="dev")


def _is_local_dev_mode() -> bool:
    """True only in pure local dev: no secret AND no DB configured.

    With MultiMemberAuthProvider the dev-mode fallback is handled inside verify()
    itself (it checks if users table is empty). The only time we short-circuit here
    is when there's no FLOOM_SECRET AND no WORKEROS_DB (no persistent DB path),
    which is the "clone and run locally without any config" case.
    """
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy != "local":
        return False
    has_secret = bool((os.environ.get("FLOOM_SECRET") or "").strip())
    has_db = bool((os.environ.get("WORKEROS_DB") or os.environ.get("FLOOM_DB") or "").strip())
    # If we have a secret OR a configured DB path, let the provider handle auth.
    return not has_secret and not has_db


async def get_auth_context(request: Request) -> AuthContext:
    if _is_local_dev_mode():
        ctx = _local_dev_context()
    else:
        ctx = await get_auth_provider().verify(request)
    ctx = scope_local_auth_context(request, ctx)
    set_current_auth_context(ctx)
    return ctx
