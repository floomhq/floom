from __future__ import annotations

import hashlib
import json
import time
import urllib.request
from threading import Lock
from typing import Iterable
from urllib.parse import urljoin

# ---------------------------------------------------------------------------
# Short-lived in-process caches to avoid a Supabase round-trip on every
# authenticated request.
#
# PAT cache: hash → (user_id, workspace_id, cached_at). TTL 60 s — PAT
# revocation takes effect within one minute, which is acceptable for an API
# token. workspace_id is part of the cached value because Cloud PATs are
# workspace-scoped credentials, not user-wide credentials.
#
# Workspace cache: user_id → (workspace_id, cached_at). TTL 30 s — workspace
# switches are infrequent; stale workspace selection for <30 s is fine.
#
# Both caches are process-local dicts protected by a single RLock so they
# are safe under uvicorn's threaded worker model (default sync workers).
# ---------------------------------------------------------------------------
_cache_lock = Lock()
_pat_cache: dict[str, tuple[str, str | None, float]] = {}   # hash → (user_id, workspace_id, ts)
_ws_cache:  dict[str, tuple[str, str | None, float]] = {}   # key → (workspace_id, role, ts)
_PAT_TTL = 60.0
_WS_TTL  = 30.0

import jwt
from fastapi import HTTPException, Request

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.workspace_context import set_active_member_role, set_active_workspace_id
from apps.api.config import get_cloud_settings
from apps.api.db import workspaces as workspace_repo

ensure_engine_api_path()

from auth.context import AuthContext  # noqa: E402

PAT_HEADER = "x-floom-token"


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


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
    # The whole verification path must fail closed: any error in header
    # parsing, JWKS fetch, key selection, algorithm mismatch (e.g. an HS256
    # anon key presented against the project's ES256 JWKS), signature
    # mismatch, or claim validation must surface as 401, never propagate as
    # a 500. Only HTTPException (already a clean 401 we raised) is re-raised
    # as-is.
    try:
        header = jwt.get_unverified_header(token)

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

        claims = jwt.decode(
            token,
            key.key,  # type: ignore[arg-type]
            algorithms=[alg],
            audience="authenticated",
            options={"require": ["exp", "sub"]},
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail="unauthorized") from exc
    return claims


def _resolve_role(*, workspace_id: str, user_id: str) -> str | None:
    """Return 'admin' if user owns the workspace, else their workspace_members role."""
    ws = workspace_repo.get(workspace_id=workspace_id)
    if ws and str(ws.get("owner_user_id", "")) == str(user_id):
        return "admin"
    return workspace_repo.get_member_role(workspace_id=workspace_id, user_id=user_id)


class SupabaseAuthProvider:
    """Cloud auth provider: local JWT verify via Supabase JWKS.

    Stateless — no httpx client, no supabase-py round trip per request.
    Eliminates the auth rate-limit and stale-HTTP/2 failure modes that
    bit /api/* endpoints after warm-up.
    """

    def __init__(self) -> None:
        self._settings = get_cloud_settings()

    async def verify(self, request: Request) -> AuthContext:
        # PAT path: x-floom-token header takes priority over Bearer JWT.
        # Simple opaque tokens — no expiry, no SDK required, just hash lookup.
        pat_raw = (request.headers.get(PAT_HEADER) or "").strip()
        if pat_raw:
            return await self._verify_pat(pat_raw, request)

        # JWT path: existing Supabase Bearer token flow (browser dashboard,
        # CLI via refresh-token exchange).
        # Also accept PATs sent as "Authorization: Bearer floom_..." — clients
        # like Claude Code write this format from mcp install.
        token = _parse_bearer_token(request.headers.get("authorization"))
        # Worker-to-worker run token (wrt_): the engine issues it when a worker
        # whose manifest declares calls: invokes another worker via call_worker.
        # Cloud-owned auth must accept it or chaining 401s — the engine only
        # taught its single-tenant MultiMemberAuthProvider about wrt_ tokens.
        if token.startswith("wrt_"):
            return await self._verify_worker_call_token(token, request)
        if token.startswith("floom_"):
            return await self._verify_pat(token, request)
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

        return await self._resolve_workspace_and_build_context(
            user_id=str(user_id), email=email, scopes=scopes, request=request
        )

    async def _verify_worker_call_token(self, raw_token: str, request: Request) -> AuthContext:
        """Verify a worker-to-worker run token (wrt_).

        Mirrors the engine's MultiMemberAuthProvider._verify_worker_call_token,
        adding cloud workspace scoping: the token carries the caller's user_id
        but no workspace, so resolve the active workspace (header/cookie, else
        the user's default) and feed the contextvars the cloud repos read — the
        target worker only resolves inside the caller's workspace. The engine's
        create_worker_run still enforces the callable_workers allowlist and call
        depth from the token payload, so accepting it here is not a privilege
        grant beyond what the parent run was already issued.
        """
        from run_token import validate_worker_call_token

        try:
            payload = validate_worker_call_token(raw_token)
        except ValueError as exc:
            raise HTTPException(status_code=401, detail=str(exc))
        user_id = str(payload.get("user_id") or "")
        if not user_id:
            raise HTTPException(status_code=401, detail="invalid run token: missing user_id")

        requested = (request.headers.get(ACTIVE_WORKSPACE_HEADER) or "").strip() or (
            request.cookies.get(ACTIVE_WORKSPACE_COOKIE) or ""
        )
        workspace_id: str | None = None
        role: str | None = None
        try:
            active = workspace_repo.resolve_active_workspace(
                user_id=user_id, email=None, requested_id=requested,
            )
            workspace_id = str(active["id"])
            if str(active.get("owner_user_id", "")) == str(user_id):
                role = "admin"
            else:
                role = workspace_repo.get_member_role(workspace_id=workspace_id, user_id=user_id)
        except Exception:
            workspace_id = None
        set_active_workspace_id(workspace_id)
        set_active_member_role(role)

        return AuthContext(
            user_id=user_id,
            role=role or "member",
            auth_method="run_token",
            run_token_payload=payload,
        )

    async def _verify_pat(self, raw: str, request: Request) -> AuthContext:
        token_hash = _hash_token(raw)
        now = time.time()

        # Fast path: PAT already in cache and not expired.
        with _cache_lock:
            cached = _pat_cache.get(token_hash)
        if cached and (now - cached[2]) < _PAT_TTL:
            user_id = cached[0]
            workspace_id = cached[1]
            return await self._build_pat_context(
                user_id=user_id,
                workspace_id=workspace_id,
                request=request,
            )

        # Slow path: DB lookup (one round-trip to Supabase).
        from apps.api.db.supabase_repos import SupabaseApiTokenRepository
        repo = SupabaseApiTokenRepository()
        row = repo.get_by_hash(token_hash)
        if not row:
            # Evict stale cache entry on explicit miss (token was revoked).
            with _cache_lock:
                _pat_cache.pop(token_hash, None)
            raise HTTPException(status_code=401, detail="invalid token")

        user_id = str(row["user_id"])
        workspace_id = str(row["workspace_id"]) if row.get("workspace_id") else None
        with _cache_lock:
            _pat_cache[token_hash] = (user_id, workspace_id, now)

        # Touch last_used_at at most once per cache TTL, not on every request.
        repo.touch(token_id=str(row["id"]))

        return await self._build_pat_context(
            user_id=user_id,
            workspace_id=workspace_id,
            request=request,
        )

    async def _build_pat_context(
        self,
        *,
        user_id: str,
        workspace_id: str | None,
        request: Request,
    ) -> AuthContext:
        header_workspace_id = request.headers.get(ACTIVE_WORKSPACE_HEADER)
        cookie_workspace_id = request.cookies.get(ACTIVE_WORKSPACE_COOKIE)
        query_workspace_id = request.query_params.get("workspace_id")
        requested_workspace_id = (
            (header_workspace_id or "").strip()
            or (query_workspace_id or "").strip()
            or cookie_workspace_id
        )

        if workspace_id and requested_workspace_id and requested_workspace_id != workspace_id:
            raise HTTPException(status_code=403, detail="token is not valid for this workspace")

        if workspace_id:
            set_active_workspace_id(workspace_id)
            # Determine role: owner → 'admin', else look up workspace_members.
            role = _resolve_role(workspace_id=workspace_id, user_id=user_id)
            set_active_member_role(role)
            return AuthContext(user_id=user_id, email=None, scopes=("api",))

        # Legacy safety path for rows created before the workspace_id
        # migration is applied. Once migrated, all PAT rows have workspace_id.
        return await self._resolve_workspace_and_build_context(
            user_id=user_id,
            email=None,
            scopes=("api",),
            request=request,
        )

    async def _resolve_workspace_and_build_context(
        self,
        *,
        user_id: str,
        email: str | None,
        scopes: tuple[str, ...],
        request: Request,
    ) -> AuthContext:
        # Workspace resolution: header (CLI) -> cookie (dashboard) -> owner
        # check -> default -> lazy bootstrap. The contextvar feeds every
        # repository call inside this request, so all queries scope by the
        # active workspace_id. resolve_active_workspace() validates that
        # the requested workspace_id is owned by user_id; an unauthorized
        # header/cookie falls back to the user's default workspace, never
        # leaks data from another user's workspace.
        header_workspace_id = request.headers.get(ACTIVE_WORKSPACE_HEADER)
        cookie_workspace_id = request.cookies.get(ACTIVE_WORKSPACE_COOKIE)
        query_workspace_id = request.query_params.get("workspace_id")
        requested_workspace_id = (
            (header_workspace_id or "").strip()
            or (query_workspace_id or "").strip()
            or cookie_workspace_id
        )

        # Cache key includes the requested workspace so explicit switches
        # (workspace switcher, CLI --workspace flag) are not served stale.
        ws_cache_key = f"{user_id}:{requested_workspace_id or ''}"
        now = time.time()
        workspace_id: str | None = None

        with _cache_lock:
            ws_cached = _ws_cache.get(ws_cache_key)
        role: str | None = None
        if ws_cached and (now - ws_cached[2]) < _WS_TTL:
            workspace_id = ws_cached[0]
            role = ws_cached[1]
        else:
            # Step 1: resolve workspace (must not be swallowed by role lookup errors).
            active: dict | None = None
            try:
                active = workspace_repo.resolve_active_workspace(
                    user_id=user_id,
                    email=email,
                    requested_id=requested_workspace_id,
                )
                workspace_id = str(active["id"])
            except Exception:
                # Transient Supabase error — fall back to user-scoped behavior.
                workspace_id = None

            # Step 2: resolve role (separate try so workspace is not lost on failure).
            if workspace_id and active is not None:
                try:
                    if str(active.get("owner_user_id", "")) == str(user_id):
                        role = "admin"
                    else:
                        role = workspace_repo.get_member_role(
                            workspace_id=workspace_id, user_id=user_id
                        )
                except Exception:
                    role = None

            with _cache_lock:
                _ws_cache[ws_cache_key] = (workspace_id, role, now)

        set_active_workspace_id(workspace_id)
        set_active_member_role(role)

        return AuthContext(
            user_id=user_id,
            email=email,
            scopes=scopes,
        )
