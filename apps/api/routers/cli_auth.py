"""CLI device-code authentication routes.

The OAuth-style device flow the `floom` CLI uses to obtain an API token:
``POST /cli-auth/devices`` mints a device+user code, the operator approves it in
the web UI (``/cli-auth/approve``), and the CLI polls ``/cli-auth/poll/{code}``
to collect its token. Extracted verbatim from main.py into an APIRouter.

Following the channels/* convention, db helpers are imported lazily inside the
handlers so the test suite's module-reload isolation continues to work.
"""

from __future__ import annotations

import base64
import os
import secrets as pysecrets
import secrets as _secrets_mod
import time
import uuid as _uuid_mod
import logging
from typing import TYPE_CHECKING, Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import AuthContext, get_auth_context
from auth.multi_member import _hash_token as _hash_pat
from core.net import _client_ip
from core.urls import _api_public_base, _frontend_public_base
from core.config import _bootstrap_user_id
# Repositories + get_repos are used in route signatures (FastAPI resolves the
# annotation + the Depends at route-build time), so they are real imports. This
# module is reloaded alongside db/main by the cli-auth test fixtures.
from db import Repositories, get_repos

logger = logging.getLogger("floom.api")

cli_auth_router = APIRouter()

_CLI_AUTH_EXPIRES_SECONDS = 600
_CLI_AUTH_POLL_INTERVAL_SECONDS = 2
_CLI_AUTH_USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CLI_AUTH_MAX_DEVICES = 100


class CliAuthDeviceCreateRequest(BaseModel):
    client_name: str
    scopes: List[str] = []


class CliAuthCodeRequest(BaseModel):
    user_code: str


def _new_device_code() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")


def _new_user_code() -> str:
    left = "".join(pysecrets.choice(_CLI_AUTH_USER_CODE_ALPHABET) for _ in range(4))
    right = "".join(pysecrets.choice(_CLI_AUTH_USER_CODE_ALPHABET) for _ in range(4))
    return f"{left}-{right}"


def _issue_cli_auth_pat(*, user_id: str, client_name: str, repos: "Repositories", role: str) -> str:
    # #847 RCA: this used to hardcode role="admin", so ANY member approving a
    # CLI device minted themselves an admin token (member → admin escalation).
    # Fix: the token inherits the approver's role, never more. Unknown role
    # strings clamp to "member" so a bad value can't widen privileges.
    from db import get_db, now_iso
    token_role = role if role in ("admin", "member") else "member"
    raw = "wos_" + _secrets_mod.token_urlsafe(32)
    token_id = str(_uuid_mod.uuid4())
    token_name = f"CLI device: {(client_name or 'unknown').strip() or 'unknown'}"
    try:
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO cli_api_tokens
                    (id, token_hash, user_id, role, name, created_at, last_used_at, revoked_at)
                VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
                """,
                (token_id, _hash_pat(raw), user_id, token_role, token_name, now_iso()),
            )
    except Exception as exc:
        logger.exception("Could not issue CLI auth token for user %s", user_id)
        raise HTTPException(
            status_code=500,
            detail="Could not issue CLI API token",
        ) from exc
    return raw


@cli_auth_router.post("/cli-auth/devices")
def create_cli_device(payload: CliAuthDeviceCreateRequest, request: Request) -> Dict[str, Any]:
    from db import get_repositories
    client_name = (payload.client_name or "").strip()
    if not client_name:
        raise HTTPException(status_code=400, detail="client_name is required")

    repos = get_repositories()
    now_ts = time.time()
    expires_at = now_ts + _CLI_AUTH_EXPIRES_SECONDS
    user_id = _bootstrap_user_id()
    repos.cli_auth.prune_expired(now_ts=now_ts)

    existing_devices = repos.cli_auth.list(user_id=user_id)
    while len(existing_devices) >= _CLI_AUTH_MAX_DEVICES:
        oldest = min(existing_devices, key=lambda row: float(row.get("created_at", 0.0)))
        repos.cli_auth.delete(device_code=oldest["device_code"])
        existing_devices = repos.cli_auth.list(user_id=user_id)

    device_code = _new_device_code()
    existing_device_codes = {row["device_code"] for row in existing_devices}
    while device_code in existing_device_codes:
        device_code = _new_device_code()

    existing_user_codes = {str(record.get("user_code", "")) for record in existing_devices}
    user_code = _new_user_code()
    while user_code in existing_user_codes:
        user_code = _new_user_code()

    repos.cli_auth.create_device(
        user_id=user_id,
        device_code=device_code,
        user_code=user_code,
        status="pending",
        secret=None,
        client_name=client_name,
        scopes=list(payload.scopes or []),
        created_ip=_client_ip(request),
        created_at=now_ts,
        expires_at=expires_at,
    )

    verification_url = f"{_frontend_public_base()}/cli-auth?code={user_code}"
    return {
        "device_code": device_code,
        "user_code": user_code,
        "verification_url": verification_url,
        "polling_interval_seconds": _CLI_AUTH_POLL_INTERVAL_SECONDS,
        "expires_in_seconds": _CLI_AUTH_EXPIRES_SECONDS,
    }


@cli_auth_router.get("/cli-auth/poll/{device_code}")
def poll_cli_device(device_code: str) -> Dict[str, Any]:
    from db import get_repositories
    repos = get_repositories()
    now_ts = time.time()
    record = repos.cli_auth.get_by_device_code(device_code)
    if not record:
        raise HTTPException(status_code=404, detail="Device code not found")

    if float(record.get("expires_at", 0.0)) <= now_ts:
        repos.cli_auth.delete(device_code=device_code)
        raise HTTPException(status_code=404, detail="Device code not found")

    status = str(record.get("status", "pending"))
    if status == "pending":
        return {"status": "pending"}

    if status == "denied":
        repos.cli_auth.delete(device_code=device_code)
        raise HTTPException(status_code=404, detail="Device code not found")

    if status == "approved":
        consumed = repos.cli_auth.consume(device_code)
        if consumed is None:
            raise HTTPException(status_code=404, detail="Device code not found")
        secret = str(consumed.get("secret") or "")
        if not secret:
            raise HTTPException(status_code=500, detail="Approved device missing API secret")
        return {
            "status": "approved",
            "api_secret": secret,
            "api_base": _api_public_base(),
        }

    raise HTTPException(status_code=500, detail=f"Unexpected device status: {status}")


@cli_auth_router.post("/cli-auth/approve")
def approve_cli_device(
    payload: CliAuthCodeRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    now_ts = time.time()
    repos.cli_auth.prune_expired(now_ts=now_ts)
    record = repos.cli_auth.verify_device(payload.user_code)
    if not record:
        raise HTTPException(status_code=404, detail="User code not found")
    if str(record.get("status")) != "pending":
        raise HTTPException(status_code=409, detail="Device code is no longer pending")
    api_token = _issue_cli_auth_pat(
        user_id=auth.user_id,
        client_name=str(record.get("client_name") or "unknown"),
        repos=repos,
        # #847: CLI token carries the approver's own role — a member approving
        # a device gets a member token, not admin.
        role=auth.role,
    )
    repos.cli_auth.update(
        device_code=record["device_code"],
        status="approved",
        secret=api_token,
        approved_at=now_ts,
    )
    return {"ok": True, "client_name": record.get("client_name") or "unknown"}


@cli_auth_router.post("/cli-auth/deny")
def deny_cli_device(
    payload: CliAuthCodeRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    now_ts = time.time()
    repos.cli_auth.prune_expired(now_ts=now_ts)
    record = repos.cli_auth.verify_device(payload.user_code)
    if not record:
        raise HTTPException(status_code=404, detail="User code not found")
    if str(record.get("status")) != "pending":
        raise HTTPException(status_code=409, detail="Device code is no longer pending")
    repos.cli_auth.update(
        device_code=record["device_code"],
        status="denied",
        secret=None,
    )
    return {"ok": True, "client_name": record.get("client_name") or "unknown"}
