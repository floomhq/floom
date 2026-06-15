"""Cloud override for the engine's POST /cli-auth/devices + poll endpoints.

Why this exists:
- The engine's apps/api/main.py registers POST /cli-auth/devices and
  GET /cli-auth/poll/{device_code} for the OSS single-tenant flow.
- In cloud, the engine sub-app is mounted under /api, so those would
  become /api/cli-auth/devices and /api/cli-auth/poll/{device_code}.
- The OSS POST handler stores user_id=_bootstrap_user_id()="federico",
  which is not a UUID and fails the FK on public.cli_auth_devices.user_id
  in Supabase. Every cloud `floom login` call therefore 500s before the
  user ever sees a verification URL.

Fix: mount this router at /api BEFORE the engine sub-app mount, so the
cloud handler wins. We mint the device row with user_id=NULL (allowed by
migration 0007). /auth/cli-approve later UPDATEs user_id to the real
Supabase user_id when the dashboard user clicks Approve.

The cloud /auth/cli-exchange flow (apps/api/routes/auth.py) is what the
CLI polls for the approved refresh_token; this module does NOT replicate
the engine's GET /cli-auth/poll/{device_code} (which returns an
api_secret, the wrong shape for cloud). Instead we 410 it to nudge any
old OSS-shaped client into pointing at /auth/cli-exchange.
"""

from __future__ import annotations

import secrets
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from apps.api._engine import ensure_engine_api_path
from apps.api.config import get_cloud_settings
from apps.api.obs import get_logger

ensure_engine_api_path()

from db.factory import get_repositories  # noqa: E402


logger = get_logger("workeros.cloud.cli_auth_devices")

router = APIRouter(prefix="/cli-auth", tags=["cli-auth"])


_CLI_AUTH_EXPIRES_SECONDS = 60 * 10  # 10 minutes; matches engine default
_CLI_AUTH_POLL_INTERVAL_SECONDS = 2
_CLI_AUTH_MAX_DEVICES_PENDING = 25


class _CliAuthDeviceCreateRequest(BaseModel):
    client_name: str = Field(..., min_length=1, max_length=80)
    scopes: list[str] = Field(default_factory=list)


def _new_device_code() -> str:
    return secrets.token_urlsafe(24)


def _new_user_code() -> str:
    # 8-char dash-segmented Crockford-style for the dashboard input.
    # SECURITY (F5): use the CSPRNG (`secrets`) — NOT `random` (Mersenne-Twister
    # is predictable and unfit for a security token the user types to approve a
    # CLI session). Mirrors the engine's `secrets`-based generator.
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    chunk = "".join(secrets.choice(alphabet) for _ in range(4))
    chunk2 = "".join(secrets.choice(alphabet) for _ in range(4))
    return f"{chunk}-{chunk2}"


def _client_ip(request: Request) -> str | None:
    cf_ip = (request.headers.get("cf-connecting-ip") or "").strip()
    if cf_ip:
        return cf_ip
    real_ip = (request.headers.get("x-real-ip") or "").strip()
    if real_ip:
        return real_ip
    if request.client is None:
        return None
    return request.client.host


def _frontend_public_base() -> str:
    settings = get_cloud_settings()
    # The dashboard runs under /app (Next.js basePath). cli-auth page lives
    # at /app/cli-auth?code=XXXX. Settings.frontend_url already ends with
    # /app (see config.py docs).
    return settings.frontend_url.rstrip("/")


@router.post("/devices")
def create_cli_device(payload: _CliAuthDeviceCreateRequest, request: Request) -> dict[str, Any]:
    """Mint a pending CLI auth device with NULL user_id.

    The dashboard user claims it via /auth/cli-approve (sets status=approved
    and writes the real Supabase user_id + refresh_token).
    """
    repos = get_repositories()
    now_ts = time.time()
    expires_at = now_ts + _CLI_AUTH_EXPIRES_SECONDS
    repos.cli_auth.prune_expired(now_ts=now_ts)
    created_ip = _client_ip(request) or "unknown"
    pending_count = repos.cli_auth.count_pending(created_ip=created_ip, now_ts=now_ts)
    if pending_count >= _CLI_AUTH_MAX_DEVICES_PENDING:
        raise HTTPException(
            status_code=429,
            detail="Too many pending CLI auth devices for this client.",
            headers={"Retry-After": str(_CLI_AUTH_POLL_INTERVAL_SECONDS)},
        )

    device_code = _new_device_code()
    user_code = _new_user_code()

    # The cloud SupabaseCliAuthRepository.create_device() takes user_id as
    # a kwarg; pass an empty string so the underlying INSERT writes NULL
    # (the repo coerces empty → NULL via the column's nullable + default
    # behavior). To be safe, use None explicitly and let the repo pass it
    # through.
    try:
        repos.cli_auth.create_device(
            user_id=None,  # NULL until cli-approve claims it
            device_code=device_code,
            user_code=user_code,
            status="pending",
            secret=None,
            client_name=payload.client_name,
            scopes=list(payload.scopes or []),
            created_ip=created_ip,
            created_at=now_ts,
            expires_at=expires_at,
        )
    except Exception as exc:
        logger.exception("Failed to mint CLI auth device", exc_info=exc)
        raise HTTPException(status_code=500, detail="Failed to mint CLI auth device") from exc

    verification_url = f"{_frontend_public_base()}/cli-auth?code={user_code}"
    return {
        "device_code": device_code,
        "user_code": user_code,
        "verification_url": verification_url,
        "polling_interval_seconds": _CLI_AUTH_POLL_INTERVAL_SECONDS,
        "expires_in_seconds": _CLI_AUTH_EXPIRES_SECONDS,
    }


@router.get("/poll/{device_code}")
def poll_cli_device(device_code: str) -> dict[str, Any]:
    """Redirect old OSS-shaped CLI clients to the cloud cli-exchange flow.

    The engine endpoint returns {"status": "approved", "api_secret": "..."}
    which is the wrong shape for cloud (cloud returns a Supabase
    refresh_token via /auth/cli-exchange). Return 410 Gone with a hint
    so the user knows to upgrade their CLI (>=0.2.0).
    """
    raise HTTPException(
        status_code=410,
        detail=(
            "This Workeros Cloud endpoint replaced the OSS /cli-auth/poll flow. "
            "Upgrade to @floomhq/workeros>=0.2.0 (which polls /auth/cli-exchange)."
        ),
    )
