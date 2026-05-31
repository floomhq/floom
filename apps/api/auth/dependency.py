from __future__ import annotations

import os

from fastapi import Request

from .context import AuthContext, set_current_auth_context
from .factory import get_auth_provider
from .local_workspaces import scope_local_auth_context


def _local_dev_context() -> AuthContext:
    """Default identity for single-tenant local dev (no FLOOM_SECRET set).

    Mirrors the request middleware contract in main.py: when FLOOM_SECRET is
    not configured the API runs in localhost dev mode and all requests pass.
    The SharedSecretAuthProvider requires a secret to construct, so without
    this dev fallback every endpoint using Depends(get_auth_context) would
    500 on a fresh OSS checkout that follows README (uvicorn, no secret).
    Prod always sets FLOOM_SECRET, so this branch is never taken there.
    """
    user_id = (os.environ.get("WORKEROS_USER_ID") or "federico").strip() or "federico"
    return AuthContext(user_id=user_id, email=None, scopes=("admin",))


def _is_local_dev_mode() -> bool:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy != "local":
        return False
    return not (os.environ.get("FLOOM_SECRET") or "").strip()


async def get_auth_context(request: Request) -> AuthContext:
    if _is_local_dev_mode():
        ctx = _local_dev_context()
    else:
        ctx = await get_auth_provider().verify(request)
    ctx = scope_local_auth_context(request, ctx)
    set_current_auth_context(ctx)
    return ctx
