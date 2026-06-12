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
from webhook_service import derive_webhook_token as _engine_derive_webhook_token  # noqa: E402


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


def _webhook_token_key(
    worker_id: str,
    repos: Repositories | None = None,
    *,
    create: bool = False,
) -> str | None:
    """Stable string token-key for a worker, matching the engine's model.

    The engine derives the webhook URL token as
    ``derive_webhook_token(worker_id, token_key)`` where ``token_key`` is the
    worker's stored webhook secret hash AS A STRING (sqlite returns ``str``).
    The cloud repo stores it as ``bytea`` and returns ``bytes``, so normalise to
    a stable hex string here. When ``create`` is set, backfill a secret so the
    URL is always available (mirrors the engine's ``get_or_create_token_key``).
    """
    stored = _repos(repos).workers.get_webhook_secret_hash(worker_id=worker_id)
    if stored is None:
        if not create:
            return None
        generate_webhook_secret(worker_id, repos=repos)
        stored = _repos(repos).workers.get_webhook_secret_hash(worker_id=worker_id)
        if stored is None:
            return None
    return stored.hex() if isinstance(stored, (bytes, bytearray)) else str(stored)


def build_webhook_url(
    worker_id: str,
    base_url: Optional[str] = None,
    *,
    repos: Repositories | None = None,
    token: str | None = None,
) -> str:
    """Cloud override for the engine's webhook-URL builder.

    Aligned with the engine's deterministic token model: the URL carries the
    worker's CURRENT token, derived from its stored (rotatable) secret via the
    engine's ``derive_webhook_token``, so a rotation invalidates the old URL.
    The only cloud-specific seams are the API base and the ``/api`` path prefix
    (the engine app is mounted under ``/api`` in cloud).

    The engine calls this as ``build_webhook_url(worker_id, repos=repos)``; an
    explicit ``token`` (e.g. just-generated) still wins.
    """
    api_base = (
        base_url
        or os.environ.get("WORKEROS_API_BASE")
        or os.environ.get("WORKERS_API_URL")
        or "https://api.workeros.floom.dev"
    ).rstrip("/")
    if token is None:
        key = _webhook_token_key(worker_id, repos, create=True)
        if key:
            token = _engine_derive_webhook_token(worker_id, key)
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
    """Aligned with the engine's deterministic model: accept the token iff it
    matches the worker's CURRENT derived token (rotation invalidates old ones).

    Does not backfill — a worker with no webhook secret rejects all tokens.
    """
    key = _webhook_token_key(worker_id, repos, create=False)
    if not key:
        return False
    expected = _engine_derive_webhook_token(worker_id, key)
    return hmac.compare_digest((token or "").strip(), expected)


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
