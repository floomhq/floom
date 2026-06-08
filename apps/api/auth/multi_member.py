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
        # 1. Bearer token — PAT or worker-call run token (wrt_)
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            raw_token = auth_header[7:].strip()
            if raw_token.startswith("wrt_"):
                return await self._verify_worker_call_token(raw_token)
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
        if provided is not None:
            provided_text = provided.decode("latin-1", errors="replace").strip()
            if provided_text.startswith(_PAT_PREFIX):
                return await self._verify_pat(provided_text)
        if self._secret:
            # A secret is configured: enforce it strictly and NEVER fall through
            # to dev mode. A missing or wrong secret must return 401 immediately.
            # Previously, a wrong secret with 0 users in the DB would bypass auth
            # entirely via the dev-mode path below — a P0 security hole on fresh
            # production installs. (#594)
            provided_val = provided if provided is not None else b""
            if not hmac.compare_digest(provided_val, self._secret.encode("latin-1")):
                raise HTTPException(status_code=401, detail="unauthorized")
            user_id = (os.environ.get("WORKEROS_USER_ID") or "federico").strip() or "federico"
            return AuthContext(
                user_id=user_id,
                role="admin",
                auth_method="secret",
                scopes=("admin",),
            )

        # 4. No users in DB — dev mode (legacy single-user install).
        # Only reached when FLOOM_SECRET is NOT set (local dev without config).
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
    # Worker-call run token verification
    # ------------------------------------------------------------------

    async def _verify_worker_call_token(self, raw_token: str) -> AuthContext:
        from run_token import validate_worker_call_token
        try:
            payload = validate_worker_call_token(raw_token)
        except ValueError as exc:
            raise HTTPException(status_code=401, detail=str(exc))
        user_id = str(payload.get("user_id") or "")
        if not user_id:
            raise HTTPException(status_code=401, detail="invalid run token: missing user_id")
        return AuthContext(
            user_id=user_id,
            role="member",
            auth_method="run_token",
            run_token_payload=payload,
        )

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
            return await self._verify_cli_api_token(raw_token)
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

    async def _verify_cli_api_token(self, raw_token: str) -> AuthContext:
        from db import get_db, now_iso

        token_hash = _hash_token(raw_token)
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT id, user_id, role, name
                FROM cli_api_tokens
                WHERE token_hash = ? AND revoked_at IS NULL
                LIMIT 1
                """,
                (token_hash,),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="invalid token")

        try:
            with get_db() as conn:
                conn.execute(
                    "UPDATE cli_api_tokens SET last_used_at = ? WHERE id = ?",
                    (now_iso(), row["id"]),
                )
        except Exception:
            pass

        role = row["role"] or "admin"
        return AuthContext(
            user_id=row["user_id"],
            role=role,
            auth_method="pat",
            username=row["name"],
            scopes=("admin",) if role == "admin" else (),
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
