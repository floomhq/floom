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
import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel

from services.uploads import _store_uploaded_blob

drop_router = APIRouter()


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
    stored = await _store_uploaded_blob(
        request,
        file,
        owner_id,
        max_size_mb=float(max_size_mb) if max_size_mb is not None else None,
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
