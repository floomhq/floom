"""Multi-member auth provider for OSS WorkerOS (WORKEROS_DEPLOY=local).

Auth priority (first match wins):
  1. Bearer <token>   — personal access token (PAT) in Authorization header
  2. workeros_session — server-side session cookie from /auth/login
  3. x-floom-secret   — shared secret backdoor (backwards compat, always works)
  4. No users in DB   — dev mode fallback (single-user legacy installs)
  5. Otherwise        — 401

The x-floom-secret path (3) means existing single-user installs continue to work
unchanged after upgrading. Once a first admin is created via POST /auth/setup,
web UI users authenticate via session cookie and API clients use PATs.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timezone

from fastapi import HTTPException, Request

from .context import AuthContext

SESSION_COOKIE = "wos_session"  # backend session; intentionally different from the Next.js web-session cookie
_PAT_PREFIX = "wos_"  # all generated PATs start with this prefix for easy identification


def _hash_token(token: str) -> str:
    """SHA-256 hash of a raw PAT value — what's stored in the DB."""
    return hashlib.sha256(token.encode()).hexdigest()


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_expired(expires_at: str | None) -> bool:
    if not expires_at:
        return False
    try:
        exp = datetime.fromisoformat(expires_at)
        return datetime.now(timezone.utc) > exp
    except Exception:
        return False


class MultiMemberAuthProvider:
    """Auth provider for local/OSS multi-member deployments.

    Reads from the SQLite users/sessions/PAT tables via lazy import of the
    db module to avoid circular imports at auth module load time.
    """

    def __init__(self) -> None:
        self._secret = (os.environ.get("FLOOM_SECRET") or "").strip()

    # ------------------------------------------------------------------
    # Public interface (matches AuthProvider Protocol)
    # ------------------------------------------------------------------

    async def verify(self, request: Request) -> AuthContext:
        # 1. Bearer PAT
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            raw_token = auth_header[7:].strip()
            return await self._verify_pat(raw_token)

        # 2. Session cookie
        session_id = request.cookies.get(SESSION_COOKIE)
        if session_id:
            return await self._verify_session(session_id)

        # 3. x-floom-secret backdoor (backwards compat)
        provided = None
        for key, value in request.scope.get("headers", []):
            if key.lower() == b"x-floom-secret":
                provided = value
                break
        if provided is not None and self._secret:
            expected = self._secret.encode("latin-1")
            if hmac.compare_digest(provided, expected):
                user_id = (os.environ.get("WORKEROS_USER_ID") or "federico").strip() or "federico"
                return AuthContext(
                    user_id=user_id,
                    role="admin",
                    auth_method="secret",
                    scopes=("admin",),
                )

        # 4. No users in DB — dev mode (legacy single-user install)
        from db import get_repositories
        repos = get_repositories()
        if repos.users is not None and repos.users.count() == 0:
            user_id = (os.environ.get("WORKEROS_USER_ID") or "federico").strip() or "federico"
            return AuthContext(
                user_id=user_id,
                role="admin",
                auth_method="dev",
                scopes=("admin",),
            )

        raise HTTPException(status_code=401, detail="unauthorized")

    # ------------------------------------------------------------------
    # PAT verification
    # ------------------------------------------------------------------

    async def _verify_pat(self, raw_token: str) -> AuthContext:
        from db import get_repositories, now_iso
        repos = get_repositories()
        if repos.tokens is None:
            raise HTTPException(status_code=401, detail="unauthorized")

        token_hash = _hash_token(raw_token)
        row = repos.tokens.get_by_hash(token_hash=token_hash)
        if row is None:
            raise HTTPException(status_code=401, detail="invalid token")
        if row.get("disabled"):
            raise HTTPException(status_code=401, detail="account disabled")
        if _is_expired(row.get("expires_at")):
            raise HTTPException(status_code=401, detail="token expired")

        # Update last_used timestamp (fire and forget — don't fail auth if this errors)
        try:
            repos.tokens.touch_last_used(token_id=row["id"], last_used_at=now_iso())
        except Exception:
            pass

        return AuthContext(
            user_id=row["user_id"],
            role=row.get("role") or "member",
            auth_method="pat",
            username=row.get("username"),
            scopes=("admin",) if row.get("role") == "admin" else (),
        )

    # ------------------------------------------------------------------
    # Session verification
    # ------------------------------------------------------------------

    async def _verify_session(self, session_id: str) -> AuthContext:
        from db import get_repositories
        repos = get_repositories()
        if repos.sessions is None:
            raise HTTPException(status_code=401, detail="unauthorized")

        row = repos.sessions.get(session_id=session_id)
        if row is None:
            raise HTTPException(status_code=401, detail="session not found")
        if row.get("disabled"):
            raise HTTPException(status_code=401, detail="account disabled")
        if _is_expired(row.get("expires_at")):
            # Clean up expired session
            try:
                repos.sessions.delete(session_id=session_id)
            except Exception:
                pass
            raise HTTPException(status_code=401, detail="session expired")

        return AuthContext(
            user_id=row["user_id"],
            role=row.get("role") or "member",
            auth_method="session",
            username=row.get("username"),
            scopes=("admin",) if row.get("role") == "admin" else (),
        )
