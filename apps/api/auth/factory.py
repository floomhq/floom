from __future__ import annotations

import os
from functools import lru_cache

from .interface import AuthProvider
from .local import SharedSecretAuthProvider
from .supabase import SupabaseAuthProvider


@lru_cache(maxsize=1)
def get_auth_provider() -> AuthProvider:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local":
        return SharedSecretAuthProvider()
    if deploy == "cloud":
        supabase_url = (os.environ.get("SUPABASE_URL") or "").strip()
        supabase_jwt_secret = (os.environ.get("SUPABASE_JWT_SECRET") or "").strip()
        if not supabase_url or not supabase_jwt_secret:
            raise RuntimeError(
                "WORKEROS_DEPLOY=cloud requires SUPABASE_URL and SUPABASE_JWT_SECRET"
            )
        return SupabaseAuthProvider(
            supabase_url=supabase_url,
            supabase_jwt_secret=supabase_jwt_secret,
        )
    raise RuntimeError(f"Unknown WORKEROS_DEPLOY value: {deploy}")
