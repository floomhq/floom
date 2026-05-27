from __future__ import annotations

from fastapi import Request

from .context import AuthContext
from .factory import get_auth_provider


async def get_auth_context(request: Request) -> AuthContext:
    return await get_auth_provider().verify(request)
