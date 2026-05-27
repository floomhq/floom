from __future__ import annotations

import os

from fastapi import Request

from .context import AuthContext


class SupabaseAuthProvider:
    def __init__(self, supabase_url: str, supabase_jwt_secret: str) -> None:
        normalized_url = supabase_url.strip()
        dev_mode = os.environ.get("WORKEROS_DEV") == "1"
        if normalized_url.startswith("http://") and not dev_mode:
            raise RuntimeError("SUPABASE_URL must use https unless WORKEROS_DEV=1")
        if not normalized_url.startswith(("https://", "http://")):
            raise RuntimeError("SUPABASE_URL must start with https://")
        self.supabase_url = normalized_url
        self.supabase_jwt_secret = supabase_jwt_secret

    async def verify(self, request: Request) -> AuthContext:
        raise NotImplementedError("Phase 3")
