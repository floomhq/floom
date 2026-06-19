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
import re
from datetime import datetime, timezone

from fastapi import HTTPException, Request

from .context import AuthContext

SESSION_COOKIE = "wos_session"  # backend session; intentionally different from the Next.js web-session cookie
_PAT_PREFIX = "wos_"  # all generated PATs start with this prefix for easy identification
_LOCAL_USER_HEADER_RE = re.compile(r"[A-Za-z0-9_.:@-]{1,128}")


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


def _local_shared_secret_context(request: Request) -> AuthContext:
    user_id = (os.environ.get("WORKEROS_USER_ID") or "local-user").strip() or "local-user"
    if os.environ.get("WORKEROS_ENABLE_USER_HEADER_SCOPE") == "1":
        header_user = (request.headers.get("x-floom-user") or "").strip()
        if header_user:
            if not _LOCAL_USER_HEADER_RE.fullmatch(header_user):
                raise HTTPException(status_code=400, detail="invalid x-floom-user")
            return AuthContext(
                user_id=header_user,
                role="member",
                auth_method="secret",
            )
        # #933: user-header scope means a trusted proxy MUST identify the user
        # on every request. A request without x-floom-user used to fall back to
        # the default ADMIN context, so a proxy that forgot to inject the
        # header silently granted admin to everyone. Fail closed instead.
        raise HTTPException(
            status_code=401,
            detail="x-floom-user header required when user-header scope is enabled",
        )
    # FLOOM_SECRET authenticates the caller, but it should not grant root by
    # default. Operators that intentionally need legacy root-equivalent shared
    # secret behavior must opt in explicitly.
    if (os.environ.get("WORKEROS_SHARED_SECRET_ROLE") or "").strip().lower() != "admin":
        return AuthContext(user_id=user_id, role="member", auth_method="secret")
    return AuthContext(
        user_id=user_id,
        role="admin",
        auth_method="secret",
        scopes=("admin",),
    )


def _require_active_token_user(user_id: str) -> None:
    """#915/#916: tokens must die with their user.

    Once the install has real user accounts (multi-member mode), any token
    whose owning user is missing or disabled is rejected. Installs with an
    empty users table (legacy single-user/dev) keep working unchanged.
    """
    from db import get_db

    with get_db() as conn:
        row = conn.execute(
            "SELECT disabled FROM users WHERE id = ? LIMIT 1", (user_id,)
        ).fetchone()
        if row is not None:
            if row["disabled"]:
                raise HTTPException(status_code=401, detail="account disabled")
            return
        count_row = conn.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()
    if count_row and int(count_row["cnt"] or 0) > 0:
        raise HTTPException(status_code=401, detail="invalid token")


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
                # #831 RCA: a wos_-prefixed value was routed to PAT verification
                # unconditionally, so an instance whose FLOOM_SECRET itself
                # starts with "wos_" became unreachable via shared-secret auth
                # (PAT lookup fails -> 401, no fallback). Fix: when PAT
                # verification rejects the value but it matches the configured
                # shared secret, fall back to the shared-secret context.
                try:
                    return await self._verify_pat(provided_text)
                except HTTPException:
                    if self._secret and hmac.compare_digest(
                        provided_text.encode("latin-1"),
                        self._secret.encode("latin-1"),
                    ):
                        return _local_shared_secret_context(request)
                    raise
        if self._secret:
            # A secret is configured: enforce it strictly and NEVER fall through
            # to dev mode. A missing or wrong secret must return 401 immediately.
            # Previously, a wrong secret with 0 users in the DB would bypass auth
            # entirely via the dev-mode path below — a P0 security hole on fresh
            # production installs. (#594)
            provided_val = provided if provided is not None else b""
            if not hmac.compare_digest(provided_val, self._secret.encode("latin-1")):
                raise HTTPException(status_code=401, detail="unauthorized")
            return _local_shared_secret_context(request)

        # 4. No users in DB — dev mode (legacy single-user install).
        # Only reached when FLOOM_SECRET is NOT set (local dev without config).
        from db import get_repositories
        repos = get_repositories()
        if repos.users is not None and repos.users.count() == 0:
            user_id = (os.environ.get("WORKEROS_USER_ID") or "local-user").strip() or "local-user"
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
        # #916: a disabled/deleted user's in-flight runs must not keep minting
        # access via child-run tokens for the rest of the token lifetime.
        _require_active_token_user(user_id)
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

        if raw_token.startswith("wst_"):
            return await self._verify_workspace_token(raw_token)
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

    async def _verify_workspace_token(self, raw_token: str) -> AuthContext:
        """Workspace API token (wst_): authenticates as the synthetic workspace
        actor with MEMBER role — read+run on workspace-shared assets only.

        The actor is never is_owner of anything a human can claim, so private
        workers (including the minter's own) are structurally invisible, and
        edit/delete/share are denied by the canonical permission rule. A
        main.py middleware additionally restricts these tokens to GET/HEAD +
        POST /workers/{id}/runs and blocks credential/config surfaces.
        """
        from db import get_db, now_iso
        from db.sqlite import workspace_actor_id

        token_hash = _hash_token(raw_token)
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT id, workspace_id, name, expires_at
                FROM workspace_api_tokens
                WHERE token_hash = ? AND revoked_at IS NULL
                LIMIT 1
                """,
                (token_hash,),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="invalid token")
        if _is_expired(row["expires_at"]):
            raise HTTPException(status_code=401, detail="token expired")
        try:
            with get_db() as conn:
                conn.execute(
                    "UPDATE workspace_api_tokens SET last_used_at = ? WHERE id = ?",
                    (now_iso(), row["id"]),
                )
        except Exception:
            pass
        return AuthContext(
            user_id=workspace_actor_id(str(row["workspace_id"])),
            role="member",
            auth_method="workspace_token",
            username=row["name"],
        )

    async def _verify_cli_api_token(self, raw_token: str) -> AuthContext:
        from db import get_db, now_iso

        token_hash = _hash_token(raw_token)
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT id, user_id, role, name, expires_at
                FROM cli_api_tokens
                WHERE token_hash = ? AND revoked_at IS NULL
                LIMIT 1
                """,
                (token_hash,),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="invalid token")
        if _is_expired(row["expires_at"]):
            raise HTTPException(status_code=401, detail="token expired")
        # #915: validate the owning user's lifecycle — disabling or deleting a
        # user must invalidate their CLI tokens, same as PATs and sessions.
        _require_active_token_user(row["user_id"])

        try:
            with get_db() as conn:
                conn.execute(
                    "UPDATE cli_api_tokens SET last_used_at = ? WHERE id = ?",
                    (now_iso(), row["id"]),
                )
        except Exception:
            pass

        # #847: a NULL/empty role column must degrade to "member", not "admin" —
        # the least-privilege default. Tokens are minted with an explicit role,
        # so this fallback only fires for malformed rows.
        role = row["role"] or "member"
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
