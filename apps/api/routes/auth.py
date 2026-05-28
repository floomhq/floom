from __future__ import annotations

import base64
import json
import os
import time
from functools import lru_cache
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

from apps.api._engine import ensure_engine_api_path
from apps.api.config import (
    get_cloud_settings,
    new_supabase_anon_client,
    new_supabase_service_client,
)

ensure_engine_api_path()

from db.factory import get_repositories  # noqa: E402


router = APIRouter(prefix="/auth", tags=["auth"])

_SESSION_COOKIE_NAME = "workeros_cloud_session"
_OAUTH_VERIFIER_COOKIE_NAME = "workeros_cloud_pkce_verifier"
_OAUTH_COOKIE_MAX_AGE = 600


class CliExchangeRequest(BaseModel):
    device_code: str
    user_code: str


def _safe_next(value: str | None) -> str:
    candidate = (value or "/").strip()
    if not candidate.startswith("/") or candidate.startswith("//"):
        return "/"
    return candidate


def _frontend_redirect(next_path: str) -> str:
    settings = get_cloud_settings()
    return f"{settings.frontend_url}{next_path}"


def _callback_url(
    *,
    next_path: str,
    device_code: str | None = None,
    user_code: str | None = None,
) -> str:
    settings = get_cloud_settings()
    params = {"next": next_path}
    if device_code:
        params["device_code"] = device_code
    if user_code:
        params["user_code"] = user_code.strip().upper()
    return f"{settings.api_base}/auth/callback?{urlencode(params)}"


def _cookie_domain() -> str | None:
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
    response.set_cookie(
        key=name,
        value=value,
        max_age=max_age,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
        domain=_cookie_domain(),
    )


def _clear_cookie(response: JSONResponse | RedirectResponse, name: str) -> None:
    response.delete_cookie(
        key=name,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
        domain=_cookie_domain(),
    )


def _encode_session_cookie(session: Any) -> str:
    payload = {
        "access_token": session.access_token,
        "refresh_token": session.refresh_token,
        "expires_at": session.expires_at,
        "user_id": getattr(getattr(session, "user", None), "id", None),
    }
    return base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode()


def _decode_session_cookie(raw_value: str | None) -> dict[str, Any] | None:
    if not raw_value:
        return None
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


def _store_cli_exchange(
    *,
    request: Request,
    user_id: str,
    device_code: str,
    user_code: str,
    refresh_token: str,
) -> None:
    repos = get_repositories()
    normalized_user_code = user_code.strip().upper()
    now_ts = time.time()
    expires_at = now_ts + get_cloud_settings().cli_code_ttl_seconds
    existing = repos.cli_auth.get_by_device_code(device_code)
    if existing is not None:
        if str(existing.get("user_code", "")).strip().upper() != normalized_user_code:
            raise HTTPException(status_code=409, detail="CLI auth device code mismatch")
        repos.cli_auth.delete(device_code=device_code)
        client_name = str(existing.get("client_name") or "workeros-cli")
        scopes = list(existing.get("scopes") or [])
        created_ip = existing.get("created_ip") or (request.client.host if request.client else None)
        created_at = float(existing.get("created_at", now_ts) or now_ts)
    else:
        client_name = "workeros-cli"
        scopes = []
        created_ip = request.client.host if request.client else None
        created_at = now_ts
    repos.cli_auth.create_device(
        user_id=user_id,
        device_code=device_code,
        user_code=normalized_user_code,
        status="approved",
        secret=refresh_token,
        client_name=client_name,
        scopes=scopes,
        created_ip=created_ip,
        created_at=created_at,
        expires_at=expires_at,
        approved_at=now_ts,
    )


@router.get("/login")
def login(
    provider: str,
    next: str = "/",
    email: str | None = None,
    device_code: str | None = None,
    user_code: str | None = None,
):
    normalized_provider = (provider or "").strip().lower()
    next_path = _safe_next(next)
    callback_url = _callback_url(
        next_path=next_path,
        device_code=device_code,
        user_code=user_code,
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
        normalized_email = (email or "").strip().lower()
        if not normalized_email:
            raise HTTPException(status_code=400, detail="email is required for email login")
        client = new_supabase_anon_client()
        client.auth.sign_in_with_otp(
            {
                "email": normalized_email,
                "options": {"email_redirect_to": callback_url},
            }
        )
        return JSONResponse(
            {
                "provider": "email",
                "status": "sent",
                "email": normalized_email,
            }
        )

    raise HTTPException(status_code=400, detail="provider must be google, github, or email")


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
        device_code=device_code,
        user_code=user_code,
    )
    client = new_supabase_anon_client()
    if confirmation_url and not code and not token_hash:
        confirmation_query = parse_qs(urlparse(confirmation_url).query)
        token_hash = (
            (confirmation_query.get("token_hash") or confirmation_query.get("token") or [None])[0]
        )
        type = (confirmation_query.get("type") or [type])[0]

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
            raise HTTPException(status_code=400, detail="Missing auth callback parameters")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Auth callback failed") from exc

    session = getattr(auth_response, "session", None)
    user = getattr(auth_response, "user", None) or getattr(session, "user", None)
    if session is None or user is None or not getattr(user, "id", None):
        raise HTTPException(status_code=401, detail="No authenticated session returned")

    _upsert_user_row(user)
    if device_code and user_code:
        _store_cli_exchange(
            request=request,
            user_id=str(user.id),
            device_code=device_code,
            user_code=user_code,
            refresh_token=session.refresh_token,
        )

    response = RedirectResponse(_frontend_redirect(next_path), status_code=303)
    _set_cookie(
        response,
        _SESSION_COOKIE_NAME,
        _encode_session_cookie(session),
        max_age=max(int(getattr(session, "expires_in", 3600) or 3600), 60),
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
    refresh_token = str(consumed.get("secret") or "")
    if not refresh_token:
        raise HTTPException(status_code=500, detail="Approved device missing refresh token")
    return {
        "refresh_token": refresh_token,
        "expires_in_seconds": settings.cli_code_ttl_seconds,
        "user_id": consumed.get("user_id"),
    }


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
        except Exception:
            pass

    response = JSONResponse({"ok": True})
    _clear_cookie(response, _SESSION_COOKIE_NAME)
    _clear_cookie(response, _OAUTH_VERIFIER_COOKIE_NAME)
    return response
