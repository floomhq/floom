"""Public signed drop-page upload endpoints.

The /drop UI can hand an unauthed browser a short-lived signed token whose
claims identify the owner, worker, and input field. The upload itself still goes
through the normal blob validation/quota path before a queued run is created.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
import collections
from typing import Any, Dict, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel

from services.uploads import _store_uploaded_blob

drop_router = APIRouter()
_DROP_RATE_WINDOW_SECONDS = 3600.0
_drop_rate_lock = threading.Lock()
_drop_rate_store: Dict[str, collections.deque[float]] = {}


class DropUploadResponse(BaseModel):
    file_id: str
    sha256: str
    run_id: str
    worker_id: str
    input_name: str


def _drop_signing_key() -> bytes:
    key = os.environ.get("WORKEROS_DROP_LINK_SECRET") or os.environ.get("FLOOM_SECRET")
    if not key:
        raise HTTPException(
            status_code=503,
            detail="Drop links require WORKEROS_DROP_LINK_SECRET or FLOOM_SECRET to be configured",
        )
    return key.encode("utf-8")


def _positive_float_env(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


def _drop_default_max_size_mb() -> float:
    return _positive_float_env("WORKEROS_DROP_DEFAULT_MAX_SIZE_MB", 50.0)


def _drop_uploads_per_token_hour() -> int:
    return _positive_int_env("WORKEROS_DROP_UPLOADS_PER_TOKEN_HOUR", 25)


def _claim_drop_rate_limit(token: str, owner_id: str) -> None:
    limit = _drop_uploads_per_token_hour()
    now = time.monotonic()
    cutoff = now - _DROP_RATE_WINDOW_SECONDS
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()[:24]
    key = f"{owner_id}:{token_hash}"
    with _drop_rate_lock:
        dq = _drop_rate_store.setdefault(key, collections.deque())
        while dq and dq[0] <= cutoff:
            dq.popleft()
        if len(dq) >= limit:
            raise HTTPException(
                status_code=429,
                detail=f"Drop link upload limit exceeded ({limit} per hour)",
            )
        dq.append(now)


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def make_drop_upload_token(
    *,
    drop_id: str,
    owner_id: str,
    worker_id: str,
    input_name: str,
    expires_at: int,
    accepts: Optional[str] = None,
    max_size_mb: Optional[float] = None,
) -> str:
    payload: Dict[str, Any] = {
        "drop_id": drop_id,
        "owner_id": owner_id,
        "worker_id": worker_id,
        "input_name": input_name,
        "exp": int(expires_at),
    }
    if accepts:
        payload["accepts"] = accepts
    if max_size_mb is not None:
        payload["max_size_mb"] = float(max_size_mb)
    encoded = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(_drop_signing_key(), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{encoded}.{sig}"


def _verify_drop_upload_token(drop_id: str, token: str) -> Dict[str, Any]:
    try:
        payload, signature = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Drop link not found") from exc
    expected = hmac.new(_drop_signing_key(), payload.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=404, detail="Drop link not found")
    try:
        claims = json.loads(_b64url_decode(payload).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Drop link not found") from exc
    if claims.get("drop_id") != drop_id:
        raise HTTPException(status_code=404, detail="Drop link not found")
    if int(claims.get("exp") or 0) < int(time.time()):
        raise HTTPException(status_code=410, detail="Drop link expired")
    for key in ("owner_id", "worker_id", "input_name"):
        if not str(claims.get(key) or "").strip():
            raise HTTPException(status_code=404, detail="Drop link not found")
    return claims


@drop_router.post("/drop/public/{drop_id}/uploads", response_model=DropUploadResponse)
async def public_drop_upload(
    drop_id: str,
    request: Request,
    file: UploadFile = File(...),
    token: str = Query(..., min_length=16),
) -> DropUploadResponse:
    claims = _verify_drop_upload_token(drop_id, token)
    owner_id = str(claims["owner_id"])
    worker_id = str(claims["worker_id"])
    input_name = str(claims["input_name"])
    accepts = claims.get("accepts")
    max_size_mb = claims.get("max_size_mb")
    effective_max_size_mb = (
        float(max_size_mb) if max_size_mb is not None else _drop_default_max_size_mb()
    )
    _claim_drop_rate_limit(token, owner_id)
    stored = await _store_uploaded_blob(
        request,
        file,
        owner_id,
        max_size_mb=effective_max_size_mb,
        accepts=str(accepts) if accepts else None,
    )
    from run_service import create_run

    run_id = create_run(
        worker_id,
        {input_name: stored["sha256"]},
        trigger_source="drop",
        user_id=owner_id,
    )
    return DropUploadResponse(
        file_id=str(stored["id"]),
        sha256=str(stored["sha256"]),
        run_id=run_id,
        worker_id=worker_id,
        input_name=input_name,
    )
