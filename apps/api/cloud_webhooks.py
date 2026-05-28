from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

from apps.api._engine import ensure_engine_api_path, import_engine_module

ensure_engine_api_path()

from db.factory import Repositories, get_repositories  # noqa: E402


logger = logging.getLogger("workeros.cloud.webhooks")
_WEBHOOK_TOKEN_HASH_KEY = b"workeros-cloud-webhook-token:v1"


def _repos(repos: Repositories | None = None) -> Repositories:
    return repos or get_repositories()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def hash_webhook_token(token: str) -> bytes:
    normalized = (token or "").strip()
    if not normalized:
        raise ValueError("webhook token is required")
    return hmac.digest(
        _WEBHOOK_TOKEN_HASH_KEY,
        normalized.encode(),
        hashlib.sha256,
    )


def build_webhook_url(
    worker_id: str,
    base_url: Optional[str] = None,
    *,
    token: str | None = None,
) -> str:
    api_base = (
        base_url
        or os.environ.get("WORKEROS_API_BASE")
        or os.environ.get("WORKERS_API_URL")
        or "https://api.workeros.floom.dev"
    ).rstrip("/")
    url = f"{api_base}/api/webhooks/{worker_id}"
    if token:
        return f"{url}?token={quote(token, safe='')}"
    return url


def generate_webhook_secret(
    worker_id: str,
    *,
    repos: Repositories | None = None,
) -> str:
    raw_token = secrets.token_urlsafe(32)
    timestamp = _now_iso()
    _repos(repos).workers.upsert_webhook_secret_hash(
        worker_id=worker_id,
        secret_hash=hash_webhook_token(raw_token),
        created_at=timestamp,
        rotated_at=timestamp,
    )
    logger.info("Cloud webhook token rotated for worker %s", worker_id)
    return raw_token


def verify_webhook_token(
    worker_id: str,
    token: str,
    *,
    repos: Repositories | None = None,
) -> bool:
    stored_hash = _repos(repos).workers.get_webhook_secret_hash(worker_id=worker_id)
    if stored_hash is None:
        return False
    try:
        provided_hash = hash_webhook_token(token)
    except ValueError:
        return False
    return hmac.compare_digest(provided_hash, stored_hash)


def get_webhook_secret_hash(
    worker_id: str,
    *,
    repos: Repositories | None = None,
) -> bytes | None:
    return _repos(repos).workers.get_webhook_secret_hash(worker_id=worker_id)


def delete_webhook_secret(
    worker_id: str,
    *,
    repos: Repositories | None = None,
) -> bool:
    return _repos(repos).workers.delete_webhook_secret(worker_id=worker_id)


def apply_engine_overrides() -> None:
    webhook_service = import_engine_module("webhook_service")
    webhook_service.build_webhook_url = build_webhook_url
    webhook_service.generate_webhook_secret = generate_webhook_secret
    webhook_service.verify_webhook_token = verify_webhook_token
    webhook_service.get_webhook_secret_hash = get_webhook_secret_hash
    webhook_service.delete_webhook_secret = delete_webhook_secret
