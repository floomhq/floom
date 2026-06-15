"""Auth + users route group: setup, login/logout, magic links, the current-user
probe, user CRUD, and personal-access-token management.

POST /auth/setup (first-admin bootstrap), /auth/login + /auth/logout, the
magic-link issue/consume pair, GET /auth/me + /auth/setup-required, the /users
CRUD surface (admin), and the /auth/tokens PAT list/create/delete/rotate.
Extracted verbatim from main.py.

Domain logic lives in services.auth_ops (hashing, lockout, sessions, magic links,
bootstrap); models are the request/response shapes; db via Depends(get_repos).
SESSION_COOKIE + PAT hashing come from auth.multi_member. Purged in lockstep
with main by the test fixtures.
"""

from __future__ import annotations

import os
import secrets as _secrets_mod
import secrets as pysecrets
import uuid as _uuid_mod
from typing import List

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi import Path as PathParam

from auth import AuthContext, get_auth_context
from auth.guards import _require_admin
from core.config import _bootstrap_user_id
from auth.multi_member import SESSION_COOKIE, _hash_token as _hash_pat
from core.urls import _frontend_base_url
from db import Repositories, get_repos
from models import (
    _AuthSetupRequest,
    _LoginRequest,
    _PATCreateRequest,
    _PATCreateResponse,
    _PATOut,
    _UserCreateRequest,
    _UserOut,
    _UserUpdateRequest,
)
from services.auth_ops import (
    _MAGIC_LINK_FALLBACK_SECRET,
    _SESSION_TTL_SECONDS,
    _bcrypt_hash,
    _bcrypt_verify,
    _claim_bootstrap_assets_for_new_admin,
    _clear_failed_logins,
    _default_token_expiry,
    _enforce_token_ttl_cap,
    _issue_magic_link,
    _login_locked_out,
    _magic_link_secret,
    _prune_expired_sessions,
    _consume_magic_link_nonce,
    _record_failed_login,
    _require_multi_member_repos,
    _set_session_cookie,
    _validate_magic_link,
    _validate_magic_link_full,
    _validate_new_password,
)

import logging

logger = logging.getLogger("floom.api")

auth_router = APIRouter()


@auth_router.post("/auth/setup", response_model=_UserOut, status_code=201)
def auth_setup(
    payload: _AuthSetupRequest,
    response: Response,
    repos: Repositories = Depends(get_repos),
) -> _UserOut:
    """Create the first admin account. Returns 409 if any user already exists."""
    user_repo, session_repo, _ = _require_multi_member_repos(repos)
    if user_repo.count() > 0:
        raise HTTPException(status_code=409, detail="workspace already set up")
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=422, detail="username required")
    password = payload.password
    _validate_new_password(password, username=username)
    if (
        (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower() == "local"
        and username == _bootstrap_user_id()
    ):
        user_id = username
    else:
        user_id = str(_uuid_mod.uuid4())
    pw_hash = _bcrypt_hash(password)
    row = user_repo.create(
        user_id=user_id,
        username=username,
        display_name=payload.display_name,
        password_hash=pw_hash,
        role="admin",
    )
    # Claim the bootstrap (local-default) identity's seed workers, connections,
    # and secrets for this first admin, so they OWN the seed data and can run it
    # (a run uses the owner's connections). Without this the admin owns nothing
    # and seed workers fail to run despite being visible. Non-fatal.
    try:
        _claimed = _claim_bootstrap_assets_for_new_admin(user_id, repos)
        if any(_claimed.values()):
            logger.info("claim-on-setup: first admin %s claimed %s", user_id, _claimed)
    except Exception:
        logger.warning("claim-on-setup failed (non-fatal)", exc_info=True)
    # Auto-login: issue a session cookie so the browser is immediately logged in
    _prune_expired_sessions(session_repo)  # #849
    session_id = _secrets_mod.token_urlsafe(32)
    from datetime import datetime, timedelta, timezone as _tz
    expires = (datetime.now(_tz.utc) + timedelta(seconds=_SESSION_TTL_SECONDS)).isoformat()
    session_repo.create(session_id=session_id, user_id=user_id, expires_at=expires)
    _set_session_cookie(response, session_id)
    return _UserOut(id=row["id"], username=row["username"], display_name=row.get("display_name"),
                    role=row["role"], disabled=bool(row["disabled"]), created_at=row["created_at"])


@auth_router.post("/auth/login")
def auth_login(
    payload: _LoginRequest,
    response: Response,
    repos: Repositories = Depends(get_repos),
) -> dict:
    """Authenticate with username+password; sets a session cookie."""
    user_repo, session_repo, _ = _require_multi_member_repos(repos)
    username = payload.username
    # #850: per-username lockout — checked before the credential comparison so
    # a locked account does not keep burning bcrypt work for an attacker.
    if _login_locked_out(username):
        raise HTTPException(
            status_code=429,
            detail="too many failed login attempts; try again later",
        )
    user = user_repo.get_by_username(username=username)
    if user is None or not _bcrypt_verify(payload.password, user.get("password_hash") or ""):
        _record_failed_login(username)
        raise HTTPException(status_code=401, detail="invalid credentials")
    if user.get("disabled"):
        raise HTTPException(status_code=403, detail="account disabled")
    _clear_failed_logins(username)
    _prune_expired_sessions(session_repo)  # #849
    session_id = _secrets_mod.token_urlsafe(32)
    from datetime import datetime, timedelta, timezone as _tz
    expires = (datetime.now(_tz.utc) + timedelta(seconds=_SESSION_TTL_SECONDS)).isoformat()
    try:
        session_repo.create(session_id=session_id, user_id=user["id"], expires_at=expires)
    except ValueError:
        # #848: user was disabled between the credential check above and the
        # session insert (TOCTOU) — the atomic guard in create() caught it.
        raise HTTPException(status_code=403, detail="account disabled")
    _set_session_cookie(response, session_id)
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user.get("display_name"),
        "role": user["role"],
        "redirect_to": "/overview",
    }


@auth_router.post("/auth/logout")
def auth_logout(
    request: Request,
    response: Response,
    repos: Repositories = Depends(get_repos),
) -> dict:
    """Invalidate the current session cookie."""
    session_id = request.cookies.get(SESSION_COOKIE)
    if session_id and repos.sessions is not None:
        try:
            repos.sessions.delete(session_id=session_id)
        except Exception:
            pass
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@auth_router.post("/auth/magic-link")
def auth_issue_magic_link(
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    """Issue a one-time sign-in URL for the authenticated user (multi-member mode only)."""
    # #917: the per-process random fallback key makes links unverifiable after a
    # restart and ties a security-critical signing key to process lifetime. Refuse
    # issuance instead of silently minting links only this process can validate;
    # consumption of already-issued links is unaffected.
    if _magic_link_secret() is _MAGIC_LINK_FALLBACK_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Magic links require WORKEROS_MAGIC_LINK_SECRET or FLOOM_SECRET to be configured",
        )
    token = _issue_magic_link(user_id=auth.user_id)
    url = f"{_frontend_base_url()}/auth/magic/{token}"
    return {"url": url, "expires_in": 900}


@auth_router.get("/auth/magic/{token}")
def auth_consume_magic_link(
    token: str,
    response: Response,
    repos: Repositories = Depends(get_repos),
) -> dict:
    """Consume a magic-link token and create a session (multi-member mode only)."""
    user_id, nonce, exp = _validate_magic_link_full(token)
    try:
        user_repo, session_repo, _ = _require_multi_member_repos(repos)
    except HTTPException:
        raise HTTPException(status_code=400, detail="Magic links require multi-member auth mode")
    # F4: enforce one-time use. Claim the nonce before issuing a session so a
    # replay of the same link cannot mint a second session.
    _consume_magic_link_nonce(nonce, exp)
    user = user_repo.get(user_id=user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.get("disabled"):
        raise HTTPException(status_code=403, detail="Account disabled")
    _prune_expired_sessions(session_repo)  # #849
    from datetime import datetime, timedelta, timezone as _tz
    session_id = pysecrets.token_urlsafe(32)
    expires = (datetime.now(_tz.utc) + timedelta(seconds=_SESSION_TTL_SECONDS)).isoformat()
    try:
        session_repo.create(session_id=session_id, user_id=user_id, expires_at=expires)
    except ValueError:
        # #848: user was disabled between the check above and the session
        # insert (TOCTOU) — the atomic guard in create() caught it.
        raise HTTPException(status_code=403, detail="Account disabled")
    _set_session_cookie(response, session_id)
    return {"ok": True, "redirect_to": "/overview"}


@auth_router.get("/auth/me")
def auth_me(auth: AuthContext = Depends(get_auth_context)) -> dict:
    """Return the current authenticated user's profile."""
    return {
        "user_id": auth.user_id,
        "username": auth.username,
        "role": auth.role,
        "auth_method": auth.auth_method,
        "is_admin": auth.is_admin,
    }


@auth_router.get("/auth/setup-required")
def auth_setup_required(repos: Repositories = Depends(get_repos)) -> dict:
    """Public endpoint — returns whether the workspace needs initial setup.

    Used by the login page to decide whether to show the setup form.
    """
    if repos.users is None:
        return {"required": False}
    return {"required": repos.users.count() == 0}


@auth_router.get("/users", response_model=List[_UserOut])
def list_users(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[_UserOut]:
    _require_admin(auth)
    user_repo, _, _ = _require_multi_member_repos(repos)
    rows = user_repo.list()
    return [_UserOut(id=r["id"], username=r["username"], display_name=r.get("display_name"),
                     role=r["role"], disabled=bool(r["disabled"]), created_at=r["created_at"]) for r in rows]


@auth_router.post("/users", response_model=_UserOut, status_code=201)
def create_user(
    payload: _UserCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _UserOut:
    _require_admin(auth)
    user_repo, _, _ = _require_multi_member_repos(repos)
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=422, detail="username required")
    _validate_new_password(payload.password, username=username)
    if user_repo.get_by_username(username=username) is not None:
        raise HTTPException(status_code=409, detail="username already taken")
    user_id = str(_uuid_mod.uuid4())
    pw_hash = _bcrypt_hash(payload.password)
    # #975: always 'member' regardless of any role in the request body.
    row = user_repo.create(
        user_id=user_id,
        username=username,
        display_name=payload.display_name,
        password_hash=pw_hash,
        role="member",
    )
    return _UserOut(id=row["id"], username=row["username"], display_name=row.get("display_name"),
                    role=row["role"], disabled=bool(row["disabled"]), created_at=row["created_at"])


@auth_router.patch("/users/{uid}", response_model=_UserOut)
def update_user(
    uid: str = PathParam(...),
    payload: _UserUpdateRequest = Body(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _UserOut:
    _require_admin(auth)
    user_repo, _, _ = _require_multi_member_repos(repos)
    updates: dict = {}
    if payload.display_name is not None:
        updates["display_name"] = payload.display_name
    if payload.role is not None:
        if payload.role not in ("admin", "member"):
            raise HTTPException(status_code=422, detail="role must be admin or member")
        updates["role"] = payload.role
    if payload.disabled is not None:
        updates["disabled"] = 1 if payload.disabled else 0
    if payload.password is not None:
        existing_user = user_repo.get(user_id=uid)
        _validate_new_password(
            payload.password,
            username=(existing_user or {}).get("username"),
        )
        updates["password_hash"] = _bcrypt_hash(payload.password)
    # #976: never let the LAST active admin be disabled or demoted — that
    # permanently locks the workspace out with no self-service recovery.
    # Guard fires for self-disable AND for demoting another admin when no
    # other active admin would remain.
    _would_disable = updates.get("disabled") == 1
    _would_demote = updates.get("role") == "member"
    if _would_disable or _would_demote:
        target = user_repo.get(user_id=uid)
        if target is None:
            raise HTTPException(status_code=404, detail="user not found")
        if str(target.get("role")) == "admin" and not bool(target.get("disabled")):
            other_active_admins = [
                u for u in user_repo.list()
                if str(u.get("role")) == "admin"
                and not bool(u.get("disabled"))
                and u.get("id") != uid
            ]
            if not other_active_admins:
                raise HTTPException(
                    status_code=409,
                    detail="At least one active admin is required; "
                           "promote another admin before disabling or demoting this one.",
                )
    row = user_repo.update(user_id=uid, **updates)
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")
    return _UserOut(id=row["id"], username=row["username"], display_name=row.get("display_name"),
                    role=row["role"], disabled=bool(row["disabled"]), created_at=row["created_at"])


@auth_router.delete("/users/{uid}", status_code=204, response_class=Response)
def delete_user(
    uid: str = PathParam(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    _require_admin(auth)
    user_repo, _, _ = _require_multi_member_repos(repos)
    if uid == auth.user_id:
        raise HTTPException(status_code=400, detail="cannot delete your own account")
    if not user_repo.delete(user_id=uid):
        raise HTTPException(status_code=404, detail="user not found")
    # #915: cli_api_tokens has no FK cascade to users — revoke explicitly so a
    # deleted user's CLI tokens can't outlive the account. (The auth provider
    # also rejects tokens for missing users; this keeps the table clean.)
    try:
        from db import get_db, now_iso
        with get_db() as conn:
            conn.execute(
                "UPDATE cli_api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
                (now_iso(), uid),
            )
    except Exception:
        logger.exception("failed to revoke CLI tokens for deleted user %s", uid)
    return Response(status_code=204)


@auth_router.get("/auth/tokens", response_model=List[_PATOut])
def list_tokens(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[_PATOut]:
    _, _, token_repo = _require_multi_member_repos(repos)
    rows = token_repo.list(user_id=auth.user_id)
    return [_PATOut(**{k: r[k] for k in ("id", "name", "last_used_at", "created_at", "expires_at")}) for r in rows]


@auth_router.post("/auth/tokens", response_model=_PATCreateResponse, status_code=201)
def create_token(
    payload: _PATCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _PATCreateResponse:
    _, _, token_repo = _require_multi_member_repos(repos)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="token name required")
    # #924/#949: tokens are bounded by default — no more accidental forever-keys.
    expires_at = _enforce_token_ttl_cap(payload.expires_at)
    raw = "wos_" + _secrets_mod.token_urlsafe(32)
    token_hash = _hash_pat(raw)
    token_id = str(_uuid_mod.uuid4())
    try:
        row = token_repo.create(
            token_id=token_id,
            user_id=auth.user_id,
            name=name,
            token_hash=token_hash,
            expires_at=expires_at,
        )
    except Exception as _pat_exc:
        # FK constraint failure means auth.user_id has no row in the users
        # table — this happens in dev mode (ghost auth, no setup done).
        # Surface a clear 409 rather than a raw 500.
        import sqlite3 as _sqlite3
        if isinstance(_pat_exc, _sqlite3.IntegrityError):
            raise HTTPException(
                status_code=409,
                detail="Personal access tokens require a real user account. "
                       "Complete workspace setup at /login first.",
            ) from _pat_exc
        raise
    pat = _PATOut(**{k: row[k] for k in ("id", "name", "last_used_at", "created_at", "expires_at")})
    return _PATCreateResponse(token=raw, pat=pat)


@auth_router.delete("/auth/tokens/{token_id}", status_code=204, response_class=Response)
def delete_token(
    token_id: str = PathParam(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Response:
    _, _, token_repo = _require_multi_member_repos(repos)
    if not token_repo.delete(token_id=token_id, user_id=auth.user_id):
        raise HTTPException(status_code=404, detail="token not found")
    return Response(status_code=204)


@auth_router.post("/auth/tokens/{token_id}/rotate", response_model=_PATCreateResponse)
def rotate_token(
    token_id: str = PathParam(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _PATCreateResponse:
    """#784: rotate a PAT in place — issues a fresh raw value while keeping the
    same token id/name. The old value stops working immediately; the new value
    is shown once."""
    _, _, token_repo = _require_multi_member_repos(repos)
    raw = "wos_" + _secrets_mod.token_urlsafe(32)
    row = token_repo.rotate(token_id=token_id, user_id=auth.user_id, token_hash=_hash_pat(raw))
    if row is None:
        raise HTTPException(status_code=404, detail="token not found")
    pat = _PATOut(**{k: row[k] for k in ("id", "name", "last_used_at", "created_at", "expires_at")})
    return _PATCreateResponse(token=raw, pat=pat)
