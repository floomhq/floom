"""Webhook secret management for per-worker HMAC signature verification."""

import hashlib
import hmac
import logging
import os
import secrets
from datetime import datetime, timezone
from typing import Optional

from db.factory import Repositories, get_repositories

logger = logging.getLogger("floom.webhook_service")


def _hash_secret(raw_secret: str) -> str:
    """One-way hash the raw secret for storage (SHA-256 hex)."""
    return hashlib.sha256(raw_secret.encode()).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _repos(repos: Repositories | None = None) -> Repositories:
    return repos or get_repositories()


def derive_webhook_token(worker_id: str) -> str:
    """Derive a deterministic webhook token for a worker.

    Token = HMAC-SHA256(FLOOM_SECRET, worker_id)[:32] hex chars.
    Because FLOOM_SECRET is platform-private, the token is opaque to users
    who only know the worker_id. The same worker_id always produces the same
    token, so it can be surfaced in the UI without per-run storage.

    Falls back to a fixed sentinel when FLOOM_SECRET is not set (local dev).
    """
    platform_secret = os.environ.get("FLOOM_SECRET", "dev-secret-not-set")
    return hmac.new(
        platform_secret.encode(),
        worker_id.encode(),
        hashlib.sha256,
    ).hexdigest()[:32]


def build_webhook_url(worker_id: str, base_url: Optional[str] = None) -> str:
    """Build the full webhook URL for a worker, including the derived token."""
    token = derive_webhook_token(worker_id)
    api_base = (
        base_url
        or os.environ.get("WORKERS_API_URL")
        or os.environ.get("FLOOM_API_BASE")
        or "https://workers-api.floom.dev"
    ).rstrip("/")
    return f"{api_base}/webhooks/{worker_id}?token={token}"


def verify_webhook_token(worker_id: str, token: str) -> bool:
    """Return True if the provided token matches the derived token for the worker."""
    expected = derive_webhook_token(worker_id)
    return hmac.compare_digest(token, expected)


def generate_webhook_secret(worker_id: str, *, repos: Repositories | None = None) -> str:
    """Generate and store a new HMAC secret for the worker.

    Returns the raw secret exactly once — it is never stored in plaintext.
    The DB stores a SHA-256 hash of the secret, used as the HMAC key.
    """
    repos_obj = _repos(repos)
    raw = secrets.token_hex(32)  # 64 hex chars
    hashed = _hash_secret(raw)
    now = _now_iso()
    repos_obj.workers.upsert_webhook_secret_hash(
        worker_id=worker_id,
        secret_hash=hashed,
        created_at=now,
        rotated_at=now,
    )
    logger.info("Webhook secret generated/rotated for worker %s", worker_id)
    return raw  # returned once, never stored in plaintext


def get_webhook_secret_hash(worker_id: str, *, repos: Repositories | None = None) -> Optional[str]:
    """Return the stored hash for a worker's webhook secret, or None if not set."""
    return _repos(repos).workers.get_webhook_secret_hash(worker_id=worker_id)


def verify_signature(body: bytes, signature_header: str, secret_hash: str) -> bool:
    """Verify X-Floom-Signature header.

    Expected format: sha256=<hex_digest>
    HMAC-SHA256 is computed using the stored hash as the key.
    The client must compute: HMAC-SHA256(key=secret_hash, message=raw_body)
    """
    if not signature_header.startswith("sha256="):
        return False
    provided_sig = signature_header[len("sha256="):]
    expected_sig = hmac.new(
        secret_hash.encode(),
        body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(provided_sig, expected_sig)


def delete_webhook_secret(worker_id: str, *, repos: Repositories | None = None) -> bool:
    """Remove the webhook secret for a worker. Returns True if it existed."""
    return _repos(repos).workers.delete_webhook_secret(worker_id=worker_id)
