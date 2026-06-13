"""Auth operations: password hashing/policy, login lockout, magic links,
sessions, bootstrap seeding, and the multi-member-repos guard.

bcrypt hash/verify, the password-policy validators (length, common-password and
sequential checks), the failed-login lockout store + window, magic-link mint/
validate, session-cookie issue + expiry pruning, first-admin bootstrap asset/
secret seeding, and the _require_multi_member_repos guard. Backs the /auth and
/users route groups. Extracted verbatim from main.py.

SESSION_COOKIE comes from auth.multi_member; b64url codec from services.uploads;
_bootstrap_user_id from core.config; models.SecretStatus is an annotation only.
The failed-login store is module state here and is reset between tests by
tests/conftest.py. Never imports main.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets as pysecrets
import threading
import time
from typing import TYPE_CHECKING, Dict, List

from fastapi import HTTPException, Response

from auth.multi_member import SESSION_COOKIE
from core.config import _bootstrap_user_id
from services.uploads import _b64url_decode, _b64url_encode

if TYPE_CHECKING:
    from db import Repositories
    from models import SecretStatus

import logging

logger = logging.getLogger("floom.api")


_BOOTSTRAP_SECRETS_TO_SEED: tuple[str, ...] = ("OPENAI_API_KEY", "E2B_API_KEY")


def _seed_bootstrap_secrets(user_id: str, repos: Repositories) -> int:
    """Copy bootstrap-owned env secrets into the DB on first setup.

    The secrets UI and worker status checks are DB-backed. On a fresh install
    the process env may already carry OPENAI_API_KEY, but the secrets table has
    no row yet, so the operator sees the worker-author/defaulted worker as
    "missing secret" even though the key is present. Seed the bootstrap user's
    row from env exactly once when it is absent or empty.
    """
    from models import SecretStatus

    seeded = 0
    for name in _BOOTSTRAP_SECRETS_TO_SEED:
        value = os.environ.get(name)
        if not value or not value.strip():
            continue
        try:
            existing = repos.secrets.get(user_id=user_id, name=name)
        except Exception:
            logger.warning("Failed to read bootstrap secret row for %s", name, exc_info=True)
            continue
        if existing and existing.get("value"):
            continue
        try:
            repos.secrets.set(user_id=user_id, name=name, value=value, status=SecretStatus.SET.value)
            seeded += 1
        except Exception:
            logger.warning("Failed to seed bootstrap secret %s", name, exc_info=True)
    return seeded


def _claim_bootstrap_assets_for_new_admin(new_admin_id: str, repos: Repositories) -> Dict[str, int]:
    """First-account setup: transfer the bootstrap (local-default) identity's
    workers, connections, and secrets to the newly-created admin.

    On an OSS install everything is seeded under the bootstrap user
    (``_bootstrap_user_id`` / ``WORKEROS_USER_ID``). When the first admin account
    is created via ``/auth/setup`` it gets a fresh uuid and would otherwise own
    NOTHING: it can SEE the seed workers (admin listing is role-aware) but cannot
    RUN them, because a run executes with the worker OWNER's connections/secrets
    and the owner is the bootstrap id, not the admin. Claiming the bootstrap
    assets makes the admin the real owner, so the seed workers run with the
    admin's own connections.

    Idempotent and safe: no-op when admin == bootstrap, or off the local deploy
    (cloud is multi-tenant and has no single bootstrap owner). Best-effort per
    table so a missing table/column never breaks setup.
    """
    summary: Dict[str, int] = {"workers": 0, "connections": 0, "secrets": 0}
    if (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower() != "local":
        return summary
    bootstrap_id = _bootstrap_user_id()
    if not bootstrap_id or bootstrap_id == new_admin_id:
        return summary
    from db import get_db as _get_db
    with _get_db() as conn:
        for table, col, key in (
            ("workers", "owner_id", "workers"),
            ("composio_connections", "user_id", "connections"),
        ):
            try:
                summary[key] = conn.execute(
                    f"UPDATE {table} SET {col} = ? WHERE {col} = ?",
                    (new_admin_id, bootstrap_id),
                ).rowcount
            except Exception:
                logger.warning("claim-on-setup: could not move %s", table, exc_info=True)
        conn.commit()
    # Secrets: the value lives outside the metadata row, so copy value-safely via
    # the repo (don't UPDATE the table). Then seed any env-provided bootstrap
    # secrets the admin still lacks (e.g. OPENAI_API_KEY from process env).
    try:
        for name in repos.secrets.list_names(user_id=bootstrap_id):
            existing = repos.secrets.get(user_id=new_admin_id, name=name)
            if existing and existing.get("value"):
                continue
            src = repos.secrets.get(user_id=bootstrap_id, name=name)
            if src and src.get("value"):
                repos.secrets.set(
                    user_id=new_admin_id, name=name,
                    value=src["value"], status=SecretStatus.SET.value,
                )
                summary["secrets"] += 1
    except Exception:
        logger.warning("claim-on-setup: could not copy secrets", exc_info=True)
    try:
        summary["secrets"] += _seed_bootstrap_secrets(new_admin_id, repos)
    except Exception:
        pass
    return summary


_SESSION_TTL_SECONDS = 7 * 24 * 3600  # 7 days


_MAGIC_LINK_FALLBACK_SECRET: str = pysecrets.token_hex(32)


_MIN_PASSWORD_LENGTH = 12


_COMMON_PASSWORDS = frozenset({
    "password1234",
    "password12345",
    "password123456",
    "passwordpassword",
    "123456789012",
    "1234567890123",
    "12345678901234",
    "qwertyuiop123",
    "qwerty123456",
    "1q2w3e4r5t6y",
    "abc123456789",
    "iloveyou1234",
    "administrator",
    "adminpassword",
    "welcome123456",
    "letmein123456",
    "passw0rd1234",
})


def _is_sequential_password(lowered: str) -> bool:
    """True when every step is the same/next character (e.g. 123456789012,
    abcdefghijkl, aaaaaaaaaaaa)."""
    return all(0 <= ord(b) - ord(a) <= 1 for a, b in zip(lowered, lowered[1:]))


def _validate_new_password(password: str | None, *, username: str | None = None) -> None:
    if not password or len(password) < _MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"password must be at least {_MIN_PASSWORD_LENGTH} characters",
        )
    lowered = password.lower()
    if lowered in _COMMON_PASSWORDS or _is_sequential_password(lowered):
        raise HTTPException(
            status_code=422,
            detail="password is too common or predictable; choose something less guessable",
        )
    if username and len(username) >= 4 and username.lower() in lowered:
        raise HTTPException(
            status_code=422,
            detail="password must not contain your username",
        )


def _prune_expired_sessions(session_repo) -> None:
    # #849 RCA: SqliteUserSessionRepository.prune_expired existed but was never
    # called, so expired sessions accumulated forever. Called on every
    # session-creating endpoint (setup/login/magic-link) — those already hit
    # the DB, and pruning is one indexed DELETE. Best-effort: a prune failure
    # must never block a login.
    from datetime import datetime, timezone as _tz

    try:
        session_repo.prune_expired(now_iso=datetime.now(_tz.utc).isoformat())
    except Exception:
        logger.warning("session prune failed (non-fatal)", exc_info=True)


_FAILED_LOGIN_WINDOW_SECONDS = 15 * 60


_FAILED_LOGIN_LOCKOUT_THRESHOLD = 5


_failed_login_attempts: Dict[str, List[float]] = {}


_failed_login_lock = threading.Lock()


def _login_locked_out(username: str) -> bool:
    cutoff = time.time() - _FAILED_LOGIN_WINDOW_SECONDS
    with _failed_login_lock:
        attempts = [t for t in _failed_login_attempts.get(username, []) if t > cutoff]
        _failed_login_attempts[username] = attempts
        return len(attempts) >= _FAILED_LOGIN_LOCKOUT_THRESHOLD


def _record_failed_login(username: str) -> None:
    with _failed_login_lock:
        _failed_login_attempts.setdefault(username, []).append(time.time())


def _clear_failed_logins(username: str) -> None:
    with _failed_login_lock:
        _failed_login_attempts.pop(username, None)


def _session_cookie_secure() -> bool:
    return os.environ.get("WORKEROS_INSECURE_COOKIES") != "1"


def _set_session_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="lax",
        max_age=_SESSION_TTL_SECONDS,
        secure=_session_cookie_secure(),
    )


def _bcrypt_hash(password: str) -> str:
    try:
        import bcrypt
        return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    except ImportError:
        raise HTTPException(status_code=500, detail="bcrypt not installed")


def _bcrypt_verify(password: str, hashed: str) -> bool:
    try:
        import bcrypt
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ImportError:
        return False


def _require_multi_member_repos(repos: Repositories):
    if repos.users is None or repos.sessions is None or repos.tokens is None:
        raise HTTPException(status_code=503, detail="multi-member not available")
    return repos.users, repos.sessions, repos.tokens


def _magic_link_secret() -> str:
    """Return the HMAC key for magic-link tokens.

    Checks WORKEROS_MAGIC_LINK_SECRET first (dedicated key), then falls back to
    FLOOM_SECRET (shared operator secret). Never raises — falls back to a
    module-level random key so local installs without env vars still work.
    """
    return (
        os.environ.get("WORKEROS_MAGIC_LINK_SECRET", "").strip()
        or os.environ.get("FLOOM_SECRET", "").strip()
        or _MAGIC_LINK_FALLBACK_SECRET
    )


def _issue_magic_link(*, user_id: str, ttl_seconds: int = 900) -> str:
    """Issue a stateless HMAC-signed magic-link token for a user."""
    payload = {
        "user_id": user_id,
        "nonce": pysecrets.token_urlsafe(18),
        "exp": int(time.time()) + ttl_seconds,
    }
    encoded = _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = hmac.new(_magic_link_secret().encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def _validate_magic_link(token: str) -> str:
    """Validate a magic-link token and return the user_id. Raises HTTPException on failure."""
    try:
        encoded, signature = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid magic link") from exc
    expected = hmac.new(_magic_link_secret().encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=400, detail="Invalid magic link")
    try:
        payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid magic link") from exc
    if int(payload.get("exp") or 0) < int(time.time()):
        raise HTTPException(status_code=400, detail="Magic link expired")
    user_id = str(payload.get("user_id") or "")
    if not user_id:
        raise HTTPException(status_code=400, detail="Invalid magic link")
    return user_id
