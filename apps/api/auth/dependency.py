from __future__ import annotations

from fastapi import Request

from .context import AuthContext, set_current_auth_context
from .factory import get_auth_provider


async def get_auth_context(request: Request) -> AuthContext:
    ctx = await get_auth_provider().verify(request)
    set_current_auth_context(ctx)
    return ctx
