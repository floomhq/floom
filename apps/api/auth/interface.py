from __future__ import annotations

from typing import Protocol

from fastapi import Request

from .context import AuthContext


class AuthProvider(Protocol):
    async def verify(self, request: Request) -> AuthContext: ...
