from __future__ import annotations

from typing import Iterable

from fastapi import HTTPException, Request
from supabase import Client

from apps.api._engine import ensure_engine_api_path
from apps.api.config import get_supabase_anon_client

ensure_engine_api_path()

from auth.context import AuthContext  # noqa: E402


def _parse_bearer_token(authorization: str | None) -> str:
    header = (authorization or "").strip()
    if not header:
        raise HTTPException(status_code=401, detail="missing bearer token")
    parts = header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise HTTPException(status_code=401, detail="invalid bearer token")
    return parts[1].strip()


def _normalize_scopes(raw_scopes: object) -> tuple[str, ...]:
    if isinstance(raw_scopes, str):
        return tuple(scope for scope in raw_scopes.split() if scope)
    if isinstance(raw_scopes, Iterable):
        return tuple(str(scope) for scope in raw_scopes if scope)
    return ()


class SupabaseAuthProvider:
    def __init__(self, client: Client | None = None) -> None:
        self._client = client or get_supabase_anon_client()

    async def verify(self, request: Request) -> AuthContext:
        token = _parse_bearer_token(request.headers.get("authorization"))
        try:
            response = self._client.auth.get_user(token)
        except Exception as exc:
            raise HTTPException(status_code=401, detail="unauthorized") from exc
        user = getattr(response, "user", None)
        if user is None or not getattr(user, "id", None):
            raise HTTPException(status_code=401, detail="unauthorized")
        app_metadata = getattr(user, "app_metadata", None) or {}
        scopes = ()
        if isinstance(app_metadata, dict):
            scopes = _normalize_scopes(app_metadata.get("scopes"))
        return AuthContext(
            user_id=str(user.id),
            email=getattr(user, "email", None),
            scopes=scopes,
        )
