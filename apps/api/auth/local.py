from __future__ import annotations

import hmac
import os
import re

from fastapi import HTTPException, Request

from .context import AuthContext


class SharedSecretAuthProvider:
    def __init__(self) -> None:
        secret = (os.environ.get("FLOOM_SECRET") or "").strip()
        if not secret:
            raise RuntimeError("FLOOM_SECRET is required for local auth")
        self._secret = secret

    async def verify(self, request: Request) -> AuthContext:
        provided = None
        for key, value in request.scope.get("headers", []):
            if key.lower() == b"x-floom-secret":
                provided = value
                break
        expected = self._secret.encode("latin-1")
        if provided is None or not hmac.compare_digest(provided, expected):
            raise HTTPException(status_code=401, detail="unauthorized")
        user_id = (os.environ.get("WORKEROS_USER_ID") or "federico").strip() or "federico"
        if os.environ.get("WORKEROS_ENABLE_USER_HEADER_SCOPE") == "1":
            header_user = (request.headers.get("x-floom-user") or "").strip()
            if header_user:
                if not re.fullmatch(r"[A-Za-z0-9_.:@-]{1,128}", header_user):
                    raise HTTPException(status_code=400, detail="invalid x-floom-user")
                user_id = header_user
        return AuthContext(user_id=user_id, email=None, scopes=("admin",))
