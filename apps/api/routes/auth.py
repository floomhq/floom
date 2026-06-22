from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
from functools import lru_cache
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, unquote_plus, urlencode, urlparse

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from apps.api import email_service
from apps.api._engine import ensure_engine_api_path
from apps.api.cli_auth_scopes import UnsupportedCliScope, normalize_cli_scopes
from apps.api.obs import get_logger
from apps.api.auth.supabase_provider import ACTIVE_WORKSPACE_COOKIE, PAT_HEADER
from apps.api.config import (
    get_cloud_settings,
    new_supabase_anon_client,
    new_supabase_service_client,
)
from apps.api.db.supabase_repos import SupabaseApiTokenRepository

ensure_engine_api_path()

from auth.context import AuthContext  # noqa: E402
from auth.dependency import get_auth_context  # noqa: E402
from db.factory import get_repositories  # noqa: E402


router = APIRouter(prefix="/auth", tags=["auth"])
logger = get_logger("workeros.cloud.auth")

_TOKEN_PREFIX = "floom_"


def _generate_raw_token() -> str:
    return _TOKEN_PREFIX + secrets.token_urlsafe(32)


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()

_SESSION_COOKIE_NAME = "workeros_cloud_session"
_OAUTH_VERIFIER_COOKIE_NAME = "workeros_cloud_pkce_verifier"
_OAUTH_COOKIE_MAX_AGE = 600
# The session cookie survives for the Supabase refresh-token lifetime (30 days)
# regardless of the 1-hour access-token TTL.  The refresh endpoint (/auth/refresh)
# mints a fresh access+refresh pair before the access token is used.  Previously
# max_age was set to expires_in (≈3600 s), which caused the cookie — and therefore
# the user's browser session — to expire every hour even though the refresh token
# inside was valid for 30 days.
_SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days
_SESSION_COOKIE_VERSION = "v2."
_SESSION_REFRESH_GRACE_SECONDS = 60
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_CLI_APPROVE_DENY_RATE_LIMIT = 5
_CLI_APPROVE_DENY_RATE_WINDOW_SECONDS = 60.0
_cli_approve_deny_rate_lock = threading.Lock()
_cli_approve_deny_rate_buckets: dict[str, list[float]] = {}


class CliExchangeRequest(BaseModel):
    device_code: str
    user_code: str


class CliApproveRequest(BaseModel):
    user_code: str


class CliDenyRequest(BaseModel):
    user_code: str


class PasswordLoginRequest(BaseModel):
    email: str = Field(..., min_length=3)
    password: str = Field(..., min_length=1)
    next: str = "/app"


class PasswordSignupRequest(BaseModel):
    email: str = Field(..., min_length=3)
    password: str = Field(..., min_length=8)
    next: str = "/app"


class FragmentSessionRequest(BaseModel):
    access_token: str = Field(..., min_length=10)
    refresh_token: str = Field(..., min_length=10)
    expires_at: int | None = None
    expires_in: int | None = None
    next: str = "/app"
    device_code: str | None = None
    user_code: str | None = None


def _gotrue_detail(exc: Exception) -> str:
    """Return a log-safe summary of a GoTrue/Supabase auth exception.

    Extracts the error type, GoTrue error_code, and HTTP status when
    available (supabase_auth.errors.AuthApiError). Never includes request
    bodies, passwords, or raw tokens.
    """
    exc_type = type(exc).__name__
    code = getattr(exc, "code", None)
    status = getattr(exc, "status", None)
    message = getattr(exc, "message", None) or str(exc)
    parts = [f"exc_type={exc_type}"]
    if status is not None:
        parts.append(f"gotrue_status={status}")
    if code:
        parts.append(f"gotrue_code={code}")
    parts.append(f"message={message!r}")
    return " ".join(parts)


def _safe_next(value: str | None) -> str:
    """Allow only same-origin relative redirect targets.

    Must start with a single "/" and must NOT be a protocol-relative URL
    ("//evil.com") or a backslash-smuggled one ("/\\evil.com", which some
    browsers normalize to "//evil.com"). Absolute URLs ("https://evil.com")
    also fail the leading-"/" check. Anything suspicious falls back to "/".
    """
    candidate = (value or "/").strip()
    if not candidate.startswith("/"):
        return "/"
    # Block protocol-relative ("//") and backslash variants ("/\", "\\").
    if candidate.startswith(("//", "/\\", "\\")):
        return "/"
    return candidate


def _query_value_from_encoded_separator(raw_query: str, name: str) -> str | None:
    """Read `name%3Dvalue` query parts used in Supabase Auth email links.

    The auth email template intentionally percent-encodes the `=` after
    `token_hash` and `type` so quoted-printable email transfer encoding cannot
    treat `=e9`, `=cb`, etc. inside token hashes as byte escapes.
    """
    prefix = f"{name}%3d"
    for part in (raw_query or "").split("&"):
        if part.lower().startswith(prefix):
            value = part[len(prefix):]
            return unquote_plus(value) if value else None
    return None


def _normalize_email(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    if not normalized or not _EMAIL_RE.match(normalized):
        raise HTTPException(status_code=400, detail="valid email is required")
    return normalized


def _trusted_client_ip(request: Request) -> str:
    cf_ip = (request.headers.get("cf-connecting-ip") or "").strip()
    if cf_ip:
        return cf_ip
    real_ip = (request.headers.get("x-real-ip") or "").strip()
    if real_ip:
        return real_ip
    return request.client.host if request.client else "unknown"


def _enforce_cli_approve_deny_rate_limit(*, request: Request, user_code: str) -> None:
    normalized_code = (user_code or "").strip().upper()
    ip = _trusted_client_ip(request)
    key = f"{ip}:{normalized_code}"
    now = time.monotonic()
    with _cli_approve_deny_rate_lock:
        bucket = [
            ts
            for ts in _cli_approve_deny_rate_buckets.get(key, [])
            if ts > now - _CLI_APPROVE_DENY_RATE_WINDOW_SECONDS
        ]
        if len(bucket) >= _CLI_APPROVE_DENY_RATE_LIMIT:
            retry_after = max(
                1,
                int((bucket[0] + _CLI_APPROVE_DENY_RATE_WINDOW_SECONDS) - now),
            )
            raise HTTPException(
                status_code=429,
                detail="Too many CLI auth approval attempts",
                headers={"Retry-After": str(retry_after)},
            )
        bucket.append(now)
        _cli_approve_deny_rate_buckets[key] = bucket


def _frontend_redirect(next_path: str) -> str:
    # Must use dashboard_origin (host only, no path) NOT frontend_url. The
    # engine's Composio /connections/callback requires WORKERS_FRONTEND_URL
    # to include the /app basePath, so frontend_url is "https://<host>/app".
    # Concatenating next_path (which already starts with /app/...) onto that
    # produces "/app/app/..." — the original double-basePath bug.
    settings = get_cloud_settings()
    return f"{settings.dashboard_origin}{next_path}"


def _normalized_origin(value: str | None) -> str | None:
    parsed = urlparse((value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


def _allowed_frontend_origins() -> set[str]:
    settings = get_cloud_settings()
    origins = {_normalized_origin(settings.dashboard_origin)}
    configured = os.environ.get("WORKEROS_ALLOWED_FRONTEND_ORIGINS") or ""
    for raw_origin in configured.split(","):
        origins.add(_normalized_origin(raw_origin))
    return {origin for origin in origins if origin}


def _callback_base_from_request(request: Request | None) -> str | None:
    if request is None:
        return None
    origin = _normalized_origin(request.headers.get("x-workeros-frontend-origin"))
    if not origin or origin not in _allowed_frontend_origins():
        return None
    return f"{origin}/api/proxy"


def _callback_url(
    *,
    next_path: str,
    device_code: str | None = None,
    user_code: str | None = None,
    request: Request | None = None,
) -> str:
    settings = get_cloud_settings()
    params = {"next": next_path}
    if device_code:
        params["device_code"] = device_code
    if user_code:
        params["user_code"] = user_code.strip().upper()
    # Browser-facing OAuth return URL. When the frontend is on a different
    # registrable domain than the API (e.g. a *.vercel.app frontend + a Railway
    # backend), the callback must come back THROUGH the frontend's same-origin
    # /api/proxy so the session cookie lands on the frontend host (host-only).
    # WORKEROS_OAUTH_CALLBACK_BASE overrides api_base for exactly this; it does
    # NOT change api_base (the CLI + webhooks still need the real backend host).
    callback_base = (
        (os.environ.get("WORKEROS_OAUTH_CALLBACK_BASE") or "").strip().rstrip("/")
        or _callback_base_from_request(request)
        or settings.api_base
    )
    return f"{callback_base}/auth/callback?{urlencode(params)}"


def _cookie_domain() -> str | None:
    # Explicit override. WORKEROS_COOKIE_DOMAIN=none (or empty) forces a
    # HOST-ONLY cookie — required when the frontend is on a public-suffix host
    # such as *.vercel.app, where a Domain= cookie is rejected and the auth flow
    # is instead made same-origin via /api/proxy. A concrete value (".foo.com")
    # pins the cookie to that registrable domain (the multi-subdomain setup).
    override = os.environ.get("WORKEROS_COOKIE_DOMAIN")
    if override is not None:
        normalized = override.strip()
        if normalized.lower() in {"", "none", "host-only", "host_only"}:
            return None
        return normalized
    settings = get_cloud_settings()
    hostname = urlparse(settings.frontend_url).hostname or urlparse(settings.api_base).hostname
    if not hostname or hostname in {"localhost", "127.0.0.1"}:
        return None
    if hostname.replace(".", "").isdigit():
        return None
    parts = hostname.split(".")
    if len(parts) < 2:
        return None
    return "." + ".".join(parts[-2:])


def _set_cookie(response: JSONResponse | RedirectResponse, name: str, value: str, *, max_age: int) -> None:
    parts = [
        f"{name}={value}",
        f"Max-Age={int(max_age)}",
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=lax",
    ]
    domain = _cookie_domain()
    if domain:
        parts.append(f"Domain={domain}")
    response.headers.append("set-cookie", "; ".join(parts))


def _clear_cookie(response: JSONResponse | RedirectResponse, name: str) -> None:
    domains = [None]
    configured_domain = _cookie_domain()
    if configured_domain:
        domains.append(configured_domain)
    for domain in domains:
        response.delete_cookie(
            key=name,
            httponly=True,
            secure=True,
            samesite="lax",
            path="/",
            domain=domain,
        )


def _session_cookie_key_material() -> str:
    value = (
        os.environ.get("WORKEROS_SESSION_COOKIE_SECRET")
        or os.environ.get("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or ""
    ).strip()
    if value:
        return value
    if os.environ.get("WORKEROS_DEPLOY") == "cloud":
        raise RuntimeError(
            "WORKEROS_SESSION_COOKIE_SECRET or SUPABASE_SERVICE_ROLE_KEY is required to mint cloud session cookies"
        )
    return "workeros-local-dev-session-cookie-secret"


@lru_cache(maxsize=1)
def _session_cookie_fernet() -> Fernet:
    digest = hashlib.sha256(_session_cookie_key_material().encode("utf-8")).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def _session_cookie_payload(session: Any) -> dict[str, Any]:
    return {
        "access_token": session.access_token,
        "refresh_token": session.refresh_token,
        "expires_at": session.expires_at,
        "user_id": getattr(getattr(session, "user", None), "id", None),
    }


def _encode_session_cookie(session: Any) -> str:
    payload = _session_cookie_payload(session)
    plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return _SESSION_COOKIE_VERSION + _session_cookie_fernet().encrypt(plaintext).decode("ascii")


def _encode_legacy_session_cookie_for_tests(session: Any) -> str:
    payload = {
        "access_token": session.access_token,
        "refresh_token": session.refresh_token,
        "expires_at": session.expires_at,
        "user_id": getattr(getattr(session, "user", None), "id", None),
    }
    return base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")


def _session_from_tokens(
    *,
    access_token: str,
    refresh_token: str,
    expires_at: int | None,
    expires_in: int | None,
    user: Any,
) -> SimpleNamespace:
    ttl = max(int(expires_in or 3600), 60)
    resolved_expires_at = int(expires_at or (time.time() + ttl))
    return SimpleNamespace(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_at=resolved_expires_at,
        expires_in=ttl,
        user=user,
    )


def _script_json(value: Any) -> str:
    return (
        json.dumps(value, separators=(",", ":"))
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


def _auth_fragment_bridge_html(
    *,
    next_path: str,
    device_code: str | None,
    user_code: str | None,
) -> str:
    fallback_url = _frontend_redirect("/app/login?error=auth_callback_missing")
    payload = {
        "next": next_path,
        "device_code": device_code,
        "user_code": user_code,
        "fallback": fallback_url,
    }
    # Supabase can redirect with OAuth tokens in the URL fragment. Fragments
    # never reach FastAPI, so this page posts them back to the same API origin
    # where the token is verified before the HttpOnly session cookie is set.
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Completing sign in - Workeros</title>
  <style>
    :root {{ color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fbfaf7; color: #181716; }}
    main {{ width: min(360px, calc(100vw - 40px)); border: 1px solid #ded8cf; border-radius: 18px; background: #fffefb; padding: 28px; box-shadow: 0 18px 60px rgba(20, 20, 20, 0.08); }}
    h1 {{ margin: 0 0 8px; font-size: 22px; line-height: 1.15; letter-spacing: 0; }}
    p {{ margin: 0; color: #6f6960; font-size: 14px; line-height: 1.5; }}
  </style>
</head>
<body>
  <main>
    <h1>Completing sign in</h1>
    <p>Workeros is finishing your secure session.</p>
  </main>
  <script>
    const cfg = {_script_json(payload)};
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    const expiresAt = hash.get("expires_at");
    const expiresIn = hash.get("expires_in");
    if (!accessToken || !refreshToken) {{
      window.location.replace(cfg.fallback);
    }} else {{
      fetch("/auth/fragment-session", {{
        method: "POST",
        headers: {{ "content-type": "application/json" }},
        credentials: "include",
        body: JSON.stringify({{
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: expiresAt ? Number(expiresAt) : null,
          expires_in: expiresIn ? Number(expiresIn) : null,
          next: cfg.next,
          device_code: cfg.device_code,
          user_code: cfg.user_code
        }})
      }})
      .then(async (response) => {{
        const body = await response.json().catch(() => ({{}}));
        if (!response.ok) throw new Error(body.detail || "Auth callback failed");
        window.location.replace(body.redirect_to || cfg.fallback);
      }})
      .catch(() => window.location.replace(cfg.fallback));
    }}
  </script>
</body>
</html>"""


def _decode_session_cookie(raw_value: str | None) -> dict[str, Any] | None:
    if not raw_value:
        return None
    raw_value = raw_value.strip()
    if len(raw_value) >= 2 and raw_value[0] == '"' and raw_value[-1] == '"':
        raw_value = raw_value[1:-1]
    if raw_value.startswith(_SESSION_COOKIE_VERSION):
        try:
            decoded = _session_cookie_fernet().decrypt(
                raw_value[len(_SESSION_COOKIE_VERSION) :].encode("ascii")
            ).decode("utf-8")
            data = json.loads(decoded)
        except (InvalidToken, ValueError, TypeError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    # Rolling-deploy compatibility: accept pre-encryption base64 JSON cookies so
    # already signed-in users are not forced out, but never mint this format.
    padded = raw_value + "=" * (-len(raw_value) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded.encode()).decode()
        data = json.loads(decoded)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    return data


def _oauth_code_verifier(client: Any) -> str | None:
    storage_key = getattr(client.auth, "_storage_key", None)
    storage = getattr(client.auth, "_storage", None)
    if not storage_key or storage is None:
        return None
    return storage.get_item(f"{storage_key}-code-verifier")


@lru_cache(maxsize=1)
def _provider_flags() -> dict[str, bool | None]:
    pat = (os.environ.get("SUPABASE_MANAGEMENT_PAT") or "").strip()
    settings = get_cloud_settings()
    if not pat or not settings.project_ref:
        return {"google": None, "github": None}
    try:
        response = httpx.get(
            f"https://api.supabase.com/v1/projects/{settings.project_ref}/config/auth",
            headers={"Authorization": f"Bearer {pat}"},
            timeout=10.0,
        )
        response.raise_for_status()
        body = response.json()
    except httpx.HTTPError:
        return {"google": None, "github": None}
    return {
        "google": bool(body.get("external_google_enabled")),
        "github": bool(body.get("external_github_enabled")),
    }


def _upsert_user_row(user: Any) -> None:
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    new_supabase_service_client().table("users").upsert(
        {
            "id": str(user.id),
            "email": getattr(user, "email", None),
            "updated_at": now_iso,
        },
        on_conflict="id",
    ).execute()


def _email_config_can_send() -> bool:
    readiness = email_service.email_readiness()
    return bool(
        readiness.get("enabled")
        and readiness.get("has_api_key")
        and readiness.get("has_from")
    )


def _record_email_event_once(*, user_id: str, email_address: str, kind: str) -> bool:
    dedupe_key = f"{kind}:{user_id}"
    try:
        new_supabase_service_client().table("email_events").insert(
            {
                "dedupe_key": dedupe_key,
                "user_id": user_id,
                "kind": kind,
                "recipient_email": email_address,
                "status": "pending",
            }
        ).execute()
    except Exception:
        return False
    return True


def _update_email_event(
    *,
    user_id: str,
    kind: str,
    status: str,
    provider: str | None = None,
    message_id: str | None = None,
    reason: str | None = None,
) -> None:
    dedupe_key = f"{kind}:{user_id}"
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    payload: dict[str, Any] = {
        "status": status,
        "updated_at": now_iso,
    }
    if provider:
        payload["provider"] = provider
    if message_id:
        payload["provider_message_id"] = message_id
    if reason:
        payload["reason"] = reason[:500]
    if status in {"sent", "dry_run"}:
        payload["sent_at"] = now_iso
    try:
        new_supabase_service_client().table("email_events").update(payload).eq(
            "dedupe_key",
            dedupe_key,
        ).execute()
    except Exception:
        return


def _maybe_send_welcome_email(user: Any) -> None:
    user_id = str(getattr(user, "id", "") or "")
    email_address = str(getattr(user, "email", "") or "").strip().lower()
    if not user_id or not email_address or not _email_config_can_send():
        return
    if not _record_email_event_once(user_id=user_id, email_address=email_address, kind="welcome"):
        return
    try:
        result = email_service.send_transactional_email(
            email_service.build_welcome_email(
                to=email_address,
                dashboard_url=get_cloud_settings().dashboard_origin,
            )
        )
    except Exception as exc:
        _update_email_event(
            user_id=user_id,
            kind="welcome",
            status="failed",
            reason=str(exc),
        )
        return
    _update_email_event(
        user_id=user_id,
        kind="welcome",
        status=result.status,
        provider=result.provider,
        message_id=result.message_id,
        reason=result.reason,
    )


@router.get("/login")
def login(
    provider: str,
    next: str = "/",
    email: str | None = None,
    device_code: str | None = None,
    user_code: str | None = None,
    request: Request = None,  # type: ignore[assignment]
):
    normalized_provider = (provider or "").strip().lower()
    next_path = _safe_next(next)
    callback_url = _callback_url(
        next_path=next_path,
        request=request,
    )

    if normalized_provider in {"google", "github"}:
        flags = _provider_flags()
        if flags.get(normalized_provider) is False:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": f"{normalized_provider} OAuth is disabled for this Supabase project.",
                    "fallback": "email",
                },
            )
        client = new_supabase_anon_client()
        options: dict[str, Any] = {"redirect_to": callback_url}
        if normalized_provider == "github":
            options["scopes"] = "read:user user:email"
        oauth = client.auth.sign_in_with_oauth(
            {
                "provider": normalized_provider,
                "options": options,
            }
        )
        code_verifier = _oauth_code_verifier(client)
        if not code_verifier:
            raise RuntimeError("PKCE code verifier missing after OAuth URL generation")
        response = RedirectResponse(oauth.url, status_code=307)
        _set_cookie(
            response,
            _OAUTH_VERIFIER_COOKIE_NAME,
            code_verifier,
            max_age=_OAUTH_COOKIE_MAX_AGE,
        )
        return response

    if normalized_provider == "email":
        normalized_email = _normalize_email(email)
        client = new_supabase_anon_client()
        try:
            client.auth.sign_in_with_otp(
                {
                    "email": normalized_email,
                    "options": {"email_redirect_to": callback_url},
                }
            )
        except Exception as exc:
            logger.warning("auth/login magic-link delivery failed: %s", _gotrue_detail(exc))
            raise HTTPException(status_code=502, detail="Magic link delivery failed") from exc
        return JSONResponse(
            {
                "provider": "email",
                "status": "sent",
                "email": normalized_email,
            }
        )

    raise HTTPException(status_code=400, detail="provider must be google, github, or email")


@router.post("/password-login")
def password_login(payload: PasswordLoginRequest):
    normalized_email = _normalize_email(payload.email)
    client = new_supabase_anon_client()
    try:
        auth_response = client.auth.sign_in_with_password(
            {"email": normalized_email, "password": payload.password}
        )
    except Exception as exc:
        logger.warning("auth/password-login failed: %s", _gotrue_detail(exc))
        if getattr(exc, "status", None) == 429:
            raise HTTPException(status_code=429, detail="Too many login attempts — try again later") from exc
        raise HTTPException(status_code=401, detail="Invalid email or password") from exc

    session = getattr(auth_response, "session", None)
    user = getattr(auth_response, "user", None) or getattr(session, "user", None)
    if session is None or user is None or not getattr(user, "id", None):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    _upsert_user_row(user)
    _maybe_send_welcome_email(user)
    response = JSONResponse({"ok": True, "next": _safe_next(payload.next)})
    _set_cookie(
        response,
        _SESSION_COOKIE_NAME,
        _encode_session_cookie(session),
        max_age=_SESSION_COOKIE_MAX_AGE,
    )
    _clear_cookie(response, _OAUTH_VERIFIER_COOKIE_NAME)
    return response


# #226: shown verbatim to the user, so the dashboard can also key off the 409.
_ACCOUNT_EXISTS_DETAIL = "An account with this email already exists. Please sign in instead."


@router.post("/password-signup")
def password_signup(payload: PasswordSignupRequest, request: Request = None):  # type: ignore[assignment]
    normalized_email = _normalize_email(payload.email)
    next_path = _safe_next(payload.next)
    callback_url = _callback_url(next_path=next_path, request=request)
    client = new_supabase_anon_client()
    try:
        auth_response = client.auth.sign_up(
            {
                "email": normalized_email,
                "password": payload.password,
                "options": {"email_redirect_to": callback_url},
            }
        )
    except Exception as exc:
        detail_text = _gotrue_detail(exc)
        logger.warning("auth/password-signup failed: %s", detail_text)
        if getattr(exc, "status", None) == 429:
            raise HTTPException(status_code=429, detail="Too many sign-up attempts — try again later") from exc
        lowered = (detail_text or "").lower()
        if "already" in lowered and ("regist" in lowered or "exist" in lowered):
            raise HTTPException(status_code=409, detail=_ACCOUNT_EXISTS_DETAIL) from exc
        raise HTTPException(status_code=409, detail="Sign-up failed") from exc

    session = getattr(auth_response, "session", None)
    user = getattr(auth_response, "user", None) or getattr(session, "user", None)

    # Supabase anti-enumeration (#226): signing up an EXISTING email does not
    # raise — it returns an *obfuscated* user with empty `identities` and no
    # session. The old code then (a) wrote a bogus public.users row for that
    # fake id and (b) told the user "check your email" (confirmation_required),
    # when no email is sent and the right action is to sign in. Detect it and
    # return a clear 409 instead — and do NOT upsert the fake user.
    identities = getattr(user, "identities", None) if user is not None else None
    if user is not None and session is None and isinstance(identities, list) and len(identities) == 0:
        raise HTTPException(status_code=409, detail=_ACCOUNT_EXISTS_DETAIL)

    if user is not None and getattr(user, "id", None):
        _upsert_user_row(user)

    if session is None or user is None or not getattr(user, "id", None):
        return JSONResponse(
            {
                "ok": False,
                "status": "confirmation_required",
                "email": normalized_email,
                "next": next_path,
            }
        )

    _maybe_send_welcome_email(user)
    response = JSONResponse({"ok": True, "next": next_path})
    _set_cookie(
        response,
        _SESSION_COOKIE_NAME,
        _encode_session_cookie(session),
        max_age=_SESSION_COOKIE_MAX_AGE,
    )
    _clear_cookie(response, _OAUTH_VERIFIER_COOKIE_NAME)
    return response


@router.post("/fragment-session")
def fragment_session(payload: FragmentSessionRequest, request: Request):
    client = new_supabase_anon_client()
    try:
        auth_user_response = client.auth.get_user(payload.access_token)
    except Exception as exc:
        logger.warning("auth/fragment-session token verification failed: %s", _gotrue_detail(exc))
        raise HTTPException(status_code=401, detail="Auth token verification failed") from exc

    user = getattr(auth_user_response, "user", None) or auth_user_response
    if user is None or not getattr(user, "id", None):
        raise HTTPException(status_code=401, detail="No authenticated user returned")

    _upsert_user_row(user)
    _maybe_send_welcome_email(user)
    next_path = _safe_next(payload.next)
    session = _session_from_tokens(
        access_token=payload.access_token,
        refresh_token=payload.refresh_token,
        expires_at=payload.expires_at,
        expires_in=payload.expires_in,
        user=user,
    )
    response = JSONResponse({"ok": True, "next": next_path, "redirect_to": _frontend_redirect(next_path)})
    _set_cookie(
        response,
        _SESSION_COOKIE_NAME,
        _encode_session_cookie(session),
        max_age=_SESSION_COOKIE_MAX_AGE,
    )
    _clear_cookie(response, _OAUTH_VERIFIER_COOKIE_NAME)
    return response


@router.post("/refresh")
def refresh_session(request: Request):
    """Exchange the stored refresh_token for a fresh Supabase session.

    Called by the frontend proxy when the access_token in the
    workeros_cloud_session cookie is expired or within a 60-second grace
    window.  Returns a new session cookie via Set-Cookie so the browser
    immediately picks up the rotated tokens.  The old refresh_token is
    consumed by Supabase (refresh token rotation), so this is safe to call
    on every near-expiry request.

    Returns:
      200 { "ok": true }  with updated Set-Cookie on success
      401                  when the cookie is missing, malformed, or the
                           refresh_token has been revoked/expired
    """
    session = _decode_session_cookie(request.cookies.get(_SESSION_COOKIE_NAME))
    if not session:
        raise HTTPException(status_code=401, detail="Not signed in")
    refresh_token = str(session.get("refresh_token") or "").strip()
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Session cookie missing refresh_token")

    client = new_supabase_anon_client()
    try:
        auth_response = client.auth.refresh_session(refresh_token)
    except Exception as exc:
        logger.warning("auth/refresh failed: %s", _gotrue_detail(exc))
        raise HTTPException(status_code=401, detail="Session refresh failed — please sign in again") from exc

    new_session = getattr(auth_response, "session", None)
    user = getattr(auth_response, "user", None) or getattr(new_session, "user", None)
    if new_session is None or user is None or not getattr(user, "id", None):
        raise HTTPException(status_code=401, detail="Session refresh returned no session")

    response = JSONResponse({"ok": True})
    _set_cookie(
        response,
        _SESSION_COOKIE_NAME,
        _encode_session_cookie(new_session),
        max_age=_SESSION_COOKIE_MAX_AGE,
    )
    return response


@router.get("/session-token")
def session_token(request: Request):
    """Return a short-lived Supabase access token from the encrypted session cookie.

    This is for the Next.js server-side proxy. It lets the proxy stop decoding
    the cookie payload itself; refresh tokens remain opaque outside the API.
    """
    session = _decode_session_cookie(request.cookies.get(_SESSION_COOKIE_NAME))
    if not session:
        raise HTTPException(status_code=401, detail="Not signed in")
    access_token = str(session.get("access_token") or "").strip()
    refresh_token = str(session.get("refresh_token") or "").strip()
    if not access_token or not refresh_token:
        raise HTTPException(status_code=401, detail="Session cookie missing tokens")

    try:
        expires_at = int(session.get("expires_at") or 0)
    except (TypeError, ValueError):
        expires_at = 0
    now_ts = int(time.time())
    if expires_at and expires_at - now_ts > _SESSION_REFRESH_GRACE_SECONDS:
        return JSONResponse({"access_token": access_token, "expires_at": expires_at})

    client = new_supabase_anon_client()
    try:
        auth_response = client.auth.refresh_session(refresh_token)
    except Exception as exc:
        logger.warning("auth/session-token refresh failed: %s", _gotrue_detail(exc))
        raise HTTPException(status_code=401, detail="Session refresh failed") from exc

    new_session = getattr(auth_response, "session", None)
    user = getattr(auth_response, "user", None) or getattr(new_session, "user", None)
    if new_session is None or user is None or not getattr(user, "id", None):
        raise HTTPException(status_code=401, detail="Session refresh returned no session")

    response = JSONResponse(
        {
            "access_token": str(getattr(new_session, "access_token", "") or ""),
            "expires_at": getattr(new_session, "expires_at", None),
        }
    )
    _set_cookie(
        response,
        _SESSION_COOKIE_NAME,
        _encode_session_cookie(new_session),
        max_age=_SESSION_COOKIE_MAX_AGE,
    )
    return response


@router.get("/callback")
def callback(
    request: Request,
    code: str | None = None,
    token_hash: str | None = None,
    confirmation_url: str | None = None,
    type: str | None = None,
    next: str = "/",
    device_code: str | None = None,
    user_code: str | None = None,
):
    next_path = _safe_next(next)
    callback_url = _callback_url(
        next_path=next_path,
    )
    client = new_supabase_anon_client()
    if confirmation_url and not code and not token_hash:
        confirmation_raw_query = urlparse(confirmation_url).query
        confirmation_query = parse_qs(confirmation_raw_query)
        token_hash = (
            (confirmation_query.get("token_hash") or confirmation_query.get("token") or [None])[0]
            or _query_value_from_encoded_separator(confirmation_raw_query, "token_hash")
            or _query_value_from_encoded_separator(confirmation_raw_query, "token")
        )
        type = (confirmation_query.get("type") or [type])[0] or _query_value_from_encoded_separator(
            confirmation_raw_query, "type"
        )
    if not token_hash:
        token_hash = _query_value_from_encoded_separator(request.url.query, "token_hash")
    if not type:
        type = _query_value_from_encoded_separator(request.url.query, "type")

    try:
        if code:
            code_verifier = request.cookies.get(_OAUTH_VERIFIER_COOKIE_NAME)
            if not code_verifier:
                raise HTTPException(status_code=400, detail="Missing PKCE verifier cookie")
            auth_response = client.auth.exchange_code_for_session(
                {
                    "auth_code": code,
                    "code_verifier": code_verifier,
                    "redirect_to": callback_url,
                }
            )
        elif token_hash and type:
            auth_response = client.auth.verify_otp(
                {
                    "token_hash": token_hash,
                    "type": type,
                    "options": {"redirect_to": callback_url},
                }
            )
        else:
            return HTMLResponse(
                _auth_fragment_bridge_html(
                    next_path=next_path,
                )
            )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("auth/callback failed: %s", _gotrue_detail(exc))
        raise HTTPException(status_code=401, detail="Auth callback failed") from exc

    session = getattr(auth_response, "session", None)
    user = getattr(auth_response, "user", None) or getattr(session, "user", None)
    if session is None or user is None or not getattr(user, "id", None):
        raise HTTPException(status_code=401, detail="No authenticated session returned")

    _upsert_user_row(user)
    _maybe_send_welcome_email(user)
    response = RedirectResponse(_frontend_redirect(next_path), status_code=303)
    _set_cookie(
        response,
        _SESSION_COOKIE_NAME,
        _encode_session_cookie(session),
        max_age=_SESSION_COOKIE_MAX_AGE,
    )
    _clear_cookie(response, _OAUTH_VERIFIER_COOKIE_NAME)
    return response


@router.post("/cli-exchange")
def cli_exchange(payload: CliExchangeRequest):
    repos = get_repositories()
    settings = get_cloud_settings()
    normalized_user_code = payload.user_code.strip().upper()
    now_ts = time.time()
    record = repos.cli_auth.get_by_device_code(payload.device_code)
    if not record or str(record.get("user_code", "")).strip().upper() != normalized_user_code:
        repos.cli_auth.prune_expired(now_ts=now_ts)
        raise HTTPException(status_code=404, detail="Device code not found")
    if float(record.get("expires_at", 0.0) or 0.0) <= now_ts:
        repos.cli_auth.delete(device_code=payload.device_code)
        repos.cli_auth.prune_expired(now_ts=now_ts)
        raise HTTPException(status_code=403, detail="Device code expired")
    repos.cli_auth.prune_expired(now_ts=now_ts)
    if str(record.get("status", "")).lower() != "approved":
        raise HTTPException(status_code=409, detail="Device code is not approved")
    consumed = repos.cli_auth.consume(payload.device_code)
    if consumed is None:
        raise HTTPException(status_code=404, detail="Device code not found")
    api_token = str(consumed.get("secret") or "")
    if not api_token:
        raise HTTPException(status_code=500, detail="Approved device missing CLI credential")
    try:
        scopes = normalize_cli_scopes(consumed.get("scopes"))
    except UnsupportedCliScope as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "api_token": api_token,
        "expires_in_seconds": settings.cli_code_ttl_seconds,
        "user_id": consumed.get("user_id"),
        "client_name": str(consumed.get("client_name") or "workeros-cli"),
        "credential_type": "cloud_api_token",
        "header": PAT_HEADER,
        "scopes": scopes,
        "api_base": settings.api_base,
    }


@router.get("/cli-bootstrap")
def cli_bootstrap():
    """Public bootstrap endpoint for the @floomhq/floom CLI.

    SECURITY (audit 2026-05-29, CRIT-1 — ACCEPTED, intentionally public):
    This endpoint is unauthenticated BY DESIGN and returns ONLY public
    client config:
      - supabase_url        — the project URL, public (in every frontend bundle)
      - supabase_anon_key    — the Supabase ANON key, public by design; it is
                               the client key shipped in every frontend JS
                               bundle and is gated by Row Level Security (RLS
                               is now enabled on every public table, migration
                               0008). It grants NO privileged access.
      - api_base             — the public API host.
    It deliberately exposes NO secrets: the service_role key, JWT signing
    keys, DB credentials, and webhook encryption key are NEVER returned here.
    Do NOT add any field sourced from a service-role / secret setting to this
    response.

    Older CLI versions that don't read /auth/cli-exchange's expanded
    payload (or future tooling that wants to discover the cloud config
    before login) fall back to this endpoint.
    """
    settings = get_cloud_settings()
    return {
        "supabase_url": settings.supabase_url,
        "supabase_anon_key": settings.supabase_anon_key,
        "api_base": settings.api_base,
    }


def _session_user(request: Request) -> tuple[str, str]:
    """Return (verified_user_id, refresh_token) from the cloud session cookie.

    SECURITY (F1/F2/F4): current session cookies are encrypted server-side, but
    rolling deploys may still present legacy base64 cookies. This handler MUST
    NOT trust the raw ``user_id`` field. Instead it cryptographically verifies
    the cookie's Supabase ``access_token`` against the project's JWKS (the same local
    verification path /api/* uses) and derives the user_id from the VERIFIED
    ``sub`` claim. A forged or tampered cookie fails verification → 401.

    The ``refresh_token`` is returned as-is (it is only meaningful as the device
    secret AFTER the user_id has been pinned to the verified token holder), so an
    attacker can no longer pair a victim's user_id with their own refresh_token.

    Used by /auth/cli-approve and /auth/cli-deny.
    """
    session = _decode_session_cookie(request.cookies.get(_SESSION_COOKIE_NAME))
    if not session:
        raise HTTPException(status_code=401, detail="Not signed in")
    access_token = str(session.get("access_token") or "").strip()
    refresh_token = str(session.get("refresh_token") or "").strip()
    if not access_token or not refresh_token:
        raise HTTPException(status_code=401, detail="Session cookie missing fields")

    # Verify the access_token server-side and derive the identity from the
    # signed `sub` claim — never from the cookie's raw `user_id` field.
    from apps.api.auth.supabase_provider import _verify_jwt

    settings = get_cloud_settings()
    claims = _verify_jwt(access_token, settings.supabase_url)  # raises 401 on tamper/expiry
    user_id = str(claims.get("sub") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Not signed in")
    return user_id, refresh_token


_OSS_PLACEHOLDER_USER_ID = "federico"


def _device_can_be_claimed(device_user_id: str | None, session_user_id: str) -> bool:
    """Allow approve when the device hasn't been claimed yet.

    Cloud's POST /api/cli-auth/devices override (see routes/cli_auth_devices.py)
    mints rows with user_id=NULL since the dashboard user isn't known at
    mint time. When that user signs in and clicks Approve, this handler
    claims the device for the real Supabase user_id.

    Older device rows minted by the engine's OSS handler before the cloud
    override existed carry the placeholder string "federico" — same
    semantics, allow the claim.

    A device that already belongs to a real Supabase user can ONLY be
    approved by that same user (prevents another user from stealing a
    half-completed login).
    """
    if not device_user_id:
        return True
    if device_user_id == _OSS_PLACEHOLDER_USER_ID:
        return True
    return device_user_id == session_user_id


def _issue_cli_pat(*, user_id: str, client_name: str) -> str:
    raw = _generate_raw_token()
    SupabaseApiTokenRepository().create(
        user_id=user_id,
        name=f"CLI device: {(client_name or 'workeros-cli').strip() or 'workeros-cli'}",
        token_hash=_hash_token(raw),
    )
    return raw


@router.post("/cli-approve")
def cli_approve(payload: CliApproveRequest, request: Request):
    """Cloud equivalent of the engine's /cli-auth/approve.

    The engine endpoint requires FLOOM_SECRET (single-user shared secret)
    and is incompatible with cloud's per-user Supabase auth. This handler
    looks up the pending device by user_code, claims it for the signed-in
    user, marks it approved, and stores a new CLI-specific cloud API token
    as the device "secret" - that's what the CLI will receive via the
    /auth/cli-exchange poll. Do not copy the browser refresh token here:
    Supabase refresh tokens rotate and are shared with the dashboard session.
    """
    user_id, _refresh_token = _session_user(request)
    _enforce_cli_approve_deny_rate_limit(request=request, user_code=payload.user_code)
    repos = get_repositories()
    now_ts = time.time()
    repos.cli_auth.prune_expired(now_ts=now_ts)
    record = repos.cli_auth.verify_device(payload.user_code)
    if not record or not _device_can_be_claimed(
        str(record.get("user_id") or ""), user_id
    ):
        raise HTTPException(status_code=404, detail="User code not found")
    if str(record.get("status") or "").lower() != "pending":
        raise HTTPException(status_code=409, detail="Device code is no longer pending")
    api_token = _issue_cli_pat(
        user_id=user_id,
        client_name=str(record.get("client_name") or "workeros-cli"),
    )
    # SECURITY: claim and approve in one conditional repository write. The
    # write is guarded by status='pending' so two browser sessions racing the
    # same user_code cannot both stamp a CLI token; the loser gets 409.
    try:
        approved = repos.cli_auth.approve_pending(
            device_code=record["device_code"],
            user_id=user_id,
            secret=api_token,
            approved_at=now_ts,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(
            "auth/cli-approve claim write failed for user_code=%s: %s",
            payload.user_code,
            _gotrue_detail(exc),
        )
        raise HTTPException(status_code=400, detail="Could not approve device") from exc
    if approved is None:
        raise HTTPException(status_code=409, detail="Device code is no longer pending")
    return {"ok": True, "client_name": record.get("client_name") or "workeros-cli"}


@router.post("/cli-deny")
def cli_deny(payload: CliDenyRequest, request: Request):
    user_id, _refresh = _session_user(request)
    _enforce_cli_approve_deny_rate_limit(request=request, user_code=payload.user_code)
    repos = get_repositories()
    now_ts = time.time()
    repos.cli_auth.prune_expired(now_ts=now_ts)
    record = repos.cli_auth.verify_device(payload.user_code)
    if not record or not _device_can_be_claimed(
        str(record.get("user_id") or ""), user_id
    ):
        raise HTTPException(status_code=404, detail="User code not found")
    if str(record.get("status") or "").lower() != "pending":
        raise HTTPException(status_code=409, detail="Device code is no longer pending")
    denied = repos.cli_auth.deny_pending(device_code=record["device_code"])
    if denied is None:
        raise HTTPException(status_code=409, detail="Device code is no longer pending")
    return {"ok": True, "client_name": record.get("client_name") or "workeros-cli"}


class TokenCreateRequest(BaseModel):
    name: str = Field(default="default", min_length=1, max_length=100)


@router.get("/tokens")
def list_tokens(ctx: AuthContext = Depends(get_auth_context)):
    """List all PATs for the authenticated user (no raw values)."""
    repo = SupabaseApiTokenRepository()
    return repo.list_for_user(user_id=ctx.user_id)


@router.post("/tokens", status_code=201)
def create_token(body: TokenCreateRequest, ctx: AuthContext = Depends(get_auth_context)):
    """Create a new PAT. Returns the raw token value ONCE — never retrievable again."""
    raw = _generate_raw_token()
    token_hash = _hash_token(raw)
    repo = SupabaseApiTokenRepository()
    row = repo.create(user_id=ctx.user_id, name=body.name, token_hash=token_hash)
    return {**row, "token": raw, "header": PAT_HEADER}


@router.delete("/tokens/{token_id}", status_code=200)
def delete_token(token_id: str, ctx: AuthContext = Depends(get_auth_context)):
    """Revoke a PAT by ID."""
    repo = SupabaseApiTokenRepository()
    deleted = repo.delete(token_id=token_id, user_id=ctx.user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="token not found")
    return {"ok": True}


@router.post("/tokens/bootstrap", status_code=201)
def bootstrap_token(ctx: AuthContext = Depends(get_auth_context)):
    """Ensure user has at least one PAT. If none exist, creates a default token.

    Called automatically on first login from the UI. Safe to call multiple
    times — returns existing token metadata (not raw value) if already present.
    """
    repo = SupabaseApiTokenRepository()
    if repo.has_any(user_id=ctx.user_id):
        return {"created": False, "tokens": repo.list_for_user(user_id=ctx.user_id)}
    raw = _generate_raw_token()
    token_hash = _hash_token(raw)
    row = repo.create(user_id=ctx.user_id, name="default", token_hash=token_hash)
    return {"created": True, "token": raw, "header": PAT_HEADER, **row}


@router.get("/magic/{token}")
def cloud_consume_magic_link(token: str) -> RedirectResponse:
    """Consume an OSS-style HMAC magic-link token and create a Supabase session.

    The engine issues HMAC-signed tokens via POST /auth/magic-link and builds URLs
    of the form {frontend_url}/auth/magic/{token}. In OSS that token is consumed by
    the engine's own GET /auth/magic/{token} which creates an SQLite session —
    wrong in cloud. This route shadows it.

    Steps:
      1. Validate the HMAC token via the engine's _validate_magic_link.
      2. Look up the user's email from Supabase Admin.
      3. Call auth.admin.generate_link (type=magiclink) — no email is sent;
         Supabase returns a short-lived action_link URL.
      4. Redirect the user to the action_link; Supabase creates a native session
         and redirects to settings.frontend_url.
    """
    from apps.api._engine import import_engine_module

    engine_main = import_engine_module("main")

    # Step 1 — validate HMAC token; raises 400 on bad/expired. Then enforce
    # one-time use (F4): claim the token's nonce so a replay of the same link is
    # rejected here too, not just in the engine route.
    try:
        user_id, _nonce, _exp = engine_main._validate_magic_link_full(token)
        engine_main._consume_magic_link_nonce(_nonce, _exp)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid magic link") from exc

    # Step 2 — look up email
    svc = new_supabase_service_client()
    try:
        user_resp = svc.auth.admin.get_user_by_id(user_id)
        email: str | None = user_resp.user.email if user_resp and user_resp.user else None
    except Exception as exc:
        logger.warning("cloud_consume_magic_link: get_user_by_id failed for %s: %s", user_id, exc)
        raise HTTPException(status_code=404, detail="User not found") from exc

    if not email:
        raise HTTPException(status_code=404, detail="User not found")

    # Step 3 — generate Supabase session URL (no email sent)
    settings = get_cloud_settings()
    try:
        link_resp = svc.auth.admin.generate_link(
            {
                "type": "magiclink",
                "email": email,
                "options": {"redirect_to": settings.frontend_url},
            }
        )
        action_link: str = link_resp.properties.action_link
        if not action_link:
            raise ValueError("empty action_link in generate_link response")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("cloud_consume_magic_link: generate_link failed for %s: %s", user_id, exc)
        raise HTTPException(status_code=502, detail="Failed to create session") from exc

    # Step 4 — redirect; Supabase creates the session and sends user to frontend_url
    return RedirectResponse(action_link, status_code=307)


@router.post("/logout")
def logout(request: Request):
    session_cookie = _decode_session_cookie(request.cookies.get(_SESSION_COOKIE_NAME))
    access_token = str((session_cookie or {}).get("access_token") or "")
    refresh_token = str((session_cookie or {}).get("refresh_token") or "")
    if access_token and refresh_token:
        client = new_supabase_anon_client()
        try:
            client.auth.set_session(access_token, refresh_token)
            client.auth.sign_out()
        except Exception as exc:
            # Best-effort server-side revoke; we still clear cookies below, so a
            # failure here doesn't block logout. But it used to vanish — log a
            # secret-safe summary so a chronically failing revoke is visible.
            logger.warning("auth/logout server-side sign-out failed: %s", _gotrue_detail(exc))

    response = JSONResponse({"ok": True})
    _clear_cookie(response, _SESSION_COOKIE_NAME)
    _clear_cookie(response, _OAUTH_VERIFIER_COOKIE_NAME)
    _clear_cookie(response, ACTIVE_WORKSPACE_COOKIE)
    return response
