from __future__ import annotations

import json
import time
import urllib.request
from threading import Lock
from typing import Iterable
from urllib.parse import urljoin

import jwt
from fastapi import HTTPException, Request

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.workspace_context import set_active_workspace_id
from apps.api.config import get_cloud_settings
from apps.api.db import workspaces as workspace_repo

ensure_engine_api_path()

from auth.context import AuthContext  # noqa: E402


# Cookie name shared with apps.api.routes.workspaces and the dashboard
# (via Set-Cookie on .floom.dev). HttpOnly + Secure, 30d lifetime.
ACTIVE_WORKSPACE_COOKIE = "workeros_active_workspace"

# Header used by the @floomhq/workeros CLI (cloud mode) to scope a request
# to a specific workspace. Mirrors the cookie-based dashboard flow.
# Ownership is validated by workspace_repo.resolve_active_workspace, exactly
# like the cookie path; an attacker can NOT scope themselves into another
# user's workspace by setting the header.
ACTIVE_WORKSPACE_HEADER = "x-workeros-workspace"


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


# JWKS cache. Supabase rotates signing keys rarely; we refresh hourly
# or whenever a token's kid isn't in the cached key set.
_jwks_lock = Lock()
_jwks_cache: dict[str, object] = {"keys": {}, "fetched_at": 0.0}
_JWKS_TTL_SECONDS = 3600


def _fetch_jwks(supabase_url: str) -> dict[str, jwt.PyJWK]:
    jwks_url = urljoin(supabase_url.rstrip("/") + "/", "auth/v1/.well-known/jwks.json")
    req = urllib.request.Request(jwks_url, headers={"User-Agent": "workeros-cloud-auth"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        body = resp.read()
    payload = json.loads(body)
    keys: dict[str, jwt.PyJWK] = {}
    for key_dict in payload.get("keys", []):
        try:
            pyjwk = jwt.PyJWK(key_dict)
            kid = key_dict.get("kid") or pyjwk.key_id or "default"
            keys[kid] = pyjwk
        except Exception:
            continue
    return keys


def _get_jwks(supabase_url: str, force: bool = False) -> dict[str, jwt.PyJWK]:
    with _jwks_lock:
        now = time.time()
        cached = _jwks_cache.get("keys") or {}
        fetched = float(_jwks_cache.get("fetched_at") or 0.0)
        if not force and cached and (now - fetched) < _JWKS_TTL_SECONDS:
            return cached  # type: ignore[return-value]
        keys = _fetch_jwks(supabase_url)
        _jwks_cache["keys"] = keys
        _jwks_cache["fetched_at"] = now
        return keys


def _verify_jwt(token: str, supabase_url: str) -> dict:
    """Verify a Supabase JWT locally using the project's JWKS.

    Skips the supabase-py `auth.get_user(token)` network call (which has
    a per-request cost, rate limits, and can hang on stale HTTP/2 pools).
    Local verification is offline after the JWKS is cached.
    """
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="unauthorized") from exc

    kid = header.get("kid")
    alg = header.get("alg") or "ES256"
    keys = _get_jwks(supabase_url)
    key = keys.get(kid) if kid else None

    # Refresh and retry once if the kid wasn't in our cache (key rotation).
    if key is None:
        keys = _get_jwks(supabase_url, force=True)
        key = keys.get(kid) if kid else None
    if key is None and keys and len(keys) == 1:
        # Some projects sign with a single key; fall back when the
        # token didn't carry a kid.
        key = next(iter(keys.values()))

    if key is None:
        raise HTTPException(status_code=401, detail="unauthorized")

    try:
        claims = jwt.decode(
            token,
            key.key,  # type: ignore[arg-type]
            algorithms=[alg],
            audience="authenticated",
            options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="unauthorized") from exc
    return claims


class SupabaseAuthProvider:
    """Cloud auth provider: local JWT verify via Supabase JWKS.

    Stateless — no httpx client, no supabase-py round trip per request.
    Eliminates the auth rate-limit and stale-HTTP/2 failure modes that
    bit /api/* endpoints after warm-up.
    """

    def __init__(self) -> None:
        self._settings = get_cloud_settings()

    async def verify(self, request: Request) -> AuthContext:
        token = _parse_bearer_token(request.headers.get("authorization"))
        claims = _verify_jwt(token, self._settings.supabase_url)
        user_id = claims.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="unauthorized")
        email_value = claims.get("email")
        email = email_value if isinstance(email_value, str) else None
        scopes = ()
        app_metadata = claims.get("app_metadata") or {}
        if isinstance(app_metadata, dict):
            scopes = _normalize_scopes(app_metadata.get("scopes"))

        # Workspace resolution: header (CLI) -> cookie (dashboard) -> owner
        # check -> default -> lazy bootstrap. The contextvar feeds every
        # repository call inside this request, so all queries scope by the
        # active workspace_id. resolve_active_workspace() validates that
        # the requested workspace_id is owned by user_id; an unauthorized
        # header/cookie falls back to the user's default workspace, never
        # leaks data from another user's workspace.
        header_workspace_id = request.headers.get(ACTIVE_WORKSPACE_HEADER)
        cookie_workspace_id = request.cookies.get(ACTIVE_WORKSPACE_COOKIE)
        requested_workspace_id = (
            (header_workspace_id or "").strip() or cookie_workspace_id
        )
        try:
            active = workspace_repo.resolve_active_workspace(
                user_id=str(user_id),
                email=email,
                requested_id=requested_workspace_id,
            )
            set_active_workspace_id(str(active["id"]))
        except Exception:
            # If workspace resolution fails (e.g. transient Supabase
            # error), fall back to user-scoped behavior so the request
            # doesn't 500. Repos will scope by user_id when contextvar
            # is None.
            set_active_workspace_id(None)

        return AuthContext(
            user_id=str(user_id),
            email=email,
            scopes=scopes,
        )
