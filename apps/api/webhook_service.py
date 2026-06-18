"""Webhook secret management for per-worker HMAC signature verification.

Security model (2026-06-02):
    The webhook URL token is derived from a PER-WORKER ROTATABLE secret, not
    from the platform-global FLOOM_SECRET. Rotating a worker's webhook secret
    (POST /workers/{id}/webhook-secret/rotate) changes the stored secret hash,
    which changes the derived token, which invalidates the previously surfaced
    webhook URL. A leaked URL is therefore revocable by rotation.

    Token = HMAC-SHA256(key=<per-worker secret hash>, msg=worker_id)[:32].

    The per-worker secret hash is the SHA-256 of the raw secret minted by
    ``generate_webhook_secret``. It is a stable, high-entropy, per-worker value
    that already exists in storage, so it doubles as the URL-token key without
    storing any additional material.

Legacy migration:
    Workers created before this change had FLOOM_SECRET-derived tokens. Switching
    the derivation changes EVERY existing webhook URL — externally registered URLs
    must be re-copied from the UI (which always surfaces the current token).

    Secure default = HARD CUTOVER: the legacy FLOOM_SECRET-derived token is NOT
    accepted. To soften a migration you may set
    ``WORKEROS_WEBHOOK_LEGACY_TOKEN_GRACE=1`` (default OFF / "0"), which makes
    verification ALSO accept the legacy token during a grace window. This is
    opt-in so security is the default.
"""

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


def _legacy_grace_enabled() -> bool:
    """True if legacy FLOOM_SECRET-derived tokens are accepted during migration.

    Default OFF (secure). Opt in with WORKEROS_WEBHOOK_LEGACY_TOKEN_GRACE in
    {"1", "true", "yes", "on"} (case-insensitive).
    """
    val = os.environ.get("WORKEROS_WEBHOOK_LEGACY_TOKEN_GRACE", "0").strip().lower()
    return val in {"1", "true", "yes", "on"}


class WebhookSigningSecretMissing(RuntimeError):
    """#998: FLOOM_SECRET is required to sign/verify legacy webhook tokens."""


def _legacy_platform_secret() -> str:
    # #998: never fall back to a public constant — a forged legacy webhook
    # token must not validate when no real secret is configured.
    secret = (os.environ.get("FLOOM_SECRET") or "").strip()
    if not secret:
        raise WebhookSigningSecretMissing(
            "FLOOM_SECRET is not configured; legacy webhook tokens cannot be "
            "signed or verified."
        )
    return secret


def _legacy_token(worker_id: str) -> str:
    """The pre-2026-06-02 token: HMAC(FLOOM_SECRET, worker_id)[:32].

    Retained ONLY so a grace window can keep accepting already-registered
    legacy URLs. Never surfaced to users anymore.
    """
    return hmac.new(
        _legacy_platform_secret().encode(),
        worker_id.encode(),
        hashlib.sha256,
    ).hexdigest()[:32]


def derive_webhook_token(worker_id: str, token_key: str) -> str:
    """Derive the deterministic webhook URL token from a per-worker key.

    Token = HMAC-SHA256(key=token_key, msg=worker_id)[:32] hex chars.

    ``token_key`` is the worker's stored webhook secret hash. Because it rotates
    when the worker's secret is rotated, the derived token (and thus the webhook
    URL) changes on rotation, invalidating any leaked URL.
    """
    return hmac.new(
        token_key.encode(),
        worker_id.encode(),
        hashlib.sha256,
    ).hexdigest()[:32]


def get_or_create_token_key(worker_id: str, *, repos: Repositories | None = None) -> str:
    """Return the worker's current webhook token key (secret hash), backfilling
    one if the worker has none yet.

    Lazy-init: a worker with no stored webhook secret (legacy workers, or workers
    whose ``webhook.secret`` was false) gets a freshly generated secret on first
    use so a stable, rotatable token key always exists. The raw secret is NOT
    returned here (the user re-copies the URL, not the raw secret); only the
    derived URL token is user-facing for query-param auth.
    """
    repos_obj = _repos(repos)
    existing = repos_obj.workers.get_webhook_secret_hash(worker_id=worker_id)
    if existing:
        return existing
    # Backfill: mint a secret so a rotatable token key exists.
    generate_webhook_secret(worker_id, repos=repos_obj)
    backfilled = repos_obj.workers.get_webhook_secret_hash(worker_id=worker_id)
    if not backfilled:
        # Should never happen, but fail loud rather than silently degrade.
        raise RuntimeError(
            f"Failed to backfill webhook token key for worker {worker_id!r}"
        )
    logger.info("Backfilled webhook token key for worker %s", worker_id)
    return backfilled


def get_existing_token_key(worker_id: str, *, repos: Repositories | None = None) -> str | None:
    """Return the worker's current webhook token key without backfilling.

    Verification must be read-only: unauthenticated probes should not create or
    rotate webhook material for legacy workers that do not yet have a secret.
    """
    return _repos(repos).workers.get_webhook_secret_hash(worker_id=worker_id)


def current_webhook_token(worker_id: str, *, repos: Repositories | None = None) -> str:
    """Return the worker's current webhook URL token (backfilling key if needed)."""
    token_key = get_or_create_token_key(worker_id, repos=repos)
    return derive_webhook_token(worker_id, token_key)


def build_webhook_url(
    worker_id: str,
    base_url: Optional[str] = None,
    *,
    repos: Repositories | None = None,
) -> str:
    """Build the full webhook URL for a worker, including the CURRENT token.

    The token is derived from the worker's current (rotatable) secret hash, so
    the URL surfaced in the UI always reflects the latest rotation.
    """
    token = current_webhook_token(worker_id, repos=repos)
    api_base = (
        base_url
        or os.environ.get("WORKERS_API_URL")
        or os.environ.get("FLOOM_API_BASE")
        or "https://workers-api.floom.dev"
    ).rstrip("/")
    return f"{api_base}/webhooks/{worker_id}?token={token}"


def verify_webhook_token(
    worker_id: str,
    token: str,
    *,
    repos: Repositories | None = None,
) -> bool:
    """Return True iff ``token`` matches the worker's CURRENT derived token.

    Constant-time comparison. After a rotation, the previous token no longer
    matches (the secret hash changed). When the legacy grace flag is enabled,
    the pre-migration FLOOM_SECRET-derived token is also accepted (constant-time).
    """
    if not token:
        return False
    token_key = get_existing_token_key(worker_id, repos=repos)
    if token_key:
        expected = derive_webhook_token(worker_id, token_key)
        if hmac.compare_digest(token, expected):
            return True
    if _legacy_grace_enabled():
        # #998: with no real FLOOM_SECRET the legacy token cannot be valid —
        # fail closed (reject) instead of comparing against a public constant.
        try:
            return hmac.compare_digest(token, _legacy_token(worker_id))
        except WebhookSigningSecretMissing:
            return False
    return False


def generate_webhook_secret(worker_id: str, *, repos: Repositories | None = None) -> str:
    """Generate and store a new HMAC secret for the worker.

    Returns the raw secret exactly once — it is never stored in plaintext.
    The DB stores a SHA-256 hash of the secret, used both as the signature HMAC
    key and as the webhook URL token key. Rotating thus changes the URL token.
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
