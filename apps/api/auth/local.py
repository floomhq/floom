from __future__ import annotations

import hmac
import os

from fastapi import HTTPException, Request

from .context import AuthContext


class SharedSecretAuthProvider:
    def __init__(self) -> None:
        secret = (os.environ.get("FLOOM_SECRET") or "").strip()
        if not secret:
            raise RuntimeError("FLOOM_SECRET is required for local auth")
        self._secret = secret

    async def verify(self, request: Request) -> AuthContext:
        provided = request.headers.get("x-floom-secret", "")
        if not provided or not hmac.compare_digest(provided, self._secret):
            raise HTTPException(status_code=401, detail="unauthorized")
        return AuthContext(user_id="federico", email=None, scopes=("admin",))
