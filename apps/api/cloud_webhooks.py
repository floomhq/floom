from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote

from apps.api._engine import ensure_engine_api_path, import_engine_module

ensure_engine_api_path()

from apps.api.db.supabase_repos import _is_table_not_found  # noqa: E402
from db.factory import Repositories, get_repositories  # noqa: E402
from webhook_service import current_webhook_token as _engine_current_webhook_token  # noqa: E402
from webhook_service import delete_webhook_secret as _engine_delete_webhook_secret  # noqa: E402
from webhook_service import generate_webhook_secret as _engine_generate_webhook_secret  # noqa: E402
from webhook_service import get_webhook_secret_hash as _engine_get_webhook_secret_hash  # noqa: E402
from webhook_service import verify_webhook_token as _engine_verify_webhook_token  # noqa: E402


logger = logging.getLogger("workeros.cloud.webhooks")


def _repos(repos: Repositories | None = None) -> Repositories:
    return repos or get_repositories()


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
        token = _engine_current_webhook_token(worker_id, repos=_repos(repos))
    url = f"{api_base}/api/webhooks/{worker_id}"
    if token:
        return f"{url}?token={quote(token, safe='')}"
    return url


def generate_webhook_secret(
    worker_id: str,
    *,
    repos: Repositories | None = None,
) -> str:
    return _engine_generate_webhook_secret(worker_id, repos=_repos(repos))


def verify_webhook_token(
    worker_id: str,
    token: str,
    *,
    repos: Repositories | None = None,
) -> bool:
    return _engine_verify_webhook_token(worker_id, token, repos=_repos(repos))


def get_webhook_secret_hash(
    worker_id: str,
    *,
    repos: Repositories | None = None,
) -> str | None:
    return _engine_get_webhook_secret_hash(worker_id, repos=_repos(repos))


def delete_webhook_secret(
    worker_id: str,
    *,
    repos: Repositories | None = None,
) -> bool:
    return _engine_delete_webhook_secret(worker_id, repos=_repos(repos))


class SupabaseWebhookDeliveryStore:
    """#277: Supabase-backed webhook delivery-receipt store for the cloud.

    The engine dedups inbound webhook redeliveries (GitHub/Composio retry with
    the same delivery id) via ``_claim_webhook_delivery``, which defaults to
    SQLite. On the ephemeral, sometimes multi-instance managed cloud that breaks
    two ways: (A) concurrent inbound webhooks hit "database is locked" and raise
    a 500 AFTER token verification but BEFORE run creation, so legit webhooks are
    silently dropped; (B) the receipt table is wiped on every redeploy, so the
    dedup never fires and senders' retries spawn duplicate runs.

    Backing the claim with Supabase makes it atomic (composite PK
    ``(source, delivery_id)``) and durable across instances/redeploys. Registered
    via the engine's ``set_webhook_delivery_store`` seam (engine #1075).
    """

    _TABLE = "webhook_delivery_receipts"

    def __init__(self, client=None) -> None:
        self._client = client

    def _client_or_default(self):
        if self._client is None:
            from apps.api.config import get_supabase_service_client

            self._client = get_supabase_service_client()
        return self._client

    @staticmethod
    def _ttl_seconds() -> int:
        # Mirror the engine default (7d, floor 1h) so cloud TTL == OSS TTL.
        try:
            return max(3600, int(os.environ.get("WORKEROS_WEBHOOK_RECEIPT_TTL_SECONDS", "604800")))
        except ValueError:
            return 604800

    def claim(self, source: str, delivery_id: str) -> bool:
        """True = first-seen (process); False = duplicate (drop).

        Fails OPEN (returns True) on a missing table or a transient/unknown DB
        error so a Supabase hiccup never silently DROPS a legitimate webhook
        (#277 part A). A genuine PK collision returns False (drop the redelivery).
        """
        client = self._client_or_default()
        now = datetime.now(timezone.utc)
        cutoff = (now - timedelta(seconds=self._ttl_seconds())).isoformat()

        # Best-effort expiry sweep for this source (hygiene only; the PK is the
        # real claim gate). A receipt older than the TTL is treated as fresh.
        try:
            client.table(self._TABLE).delete().eq("source", source).lte(
                "received_at", cutoff
            ).execute()
        except Exception:  # noqa: BLE001 - cleanup must never block a claim
            pass

        try:
            client.table(self._TABLE).insert(
                {"source": source, "delivery_id": delivery_id, "received_at": now.isoformat()}
            ).execute()
            return True
        except Exception as exc:  # noqa: BLE001
            if _is_table_not_found(exc):
                logger.warning(
                    "webhook_delivery_receipts table missing; processing webhook "
                    "without dedup (source=%s) — apply migration 0037",
                    source,
                )
                return True
            # Collision on the composite PK == a redelivery we already recorded.
            # Disambiguate by re-reading (same approach as the secrets race in
            # SupabaseSecretRepository.set) rather than parsing driver errors.
            try:
                existing = (
                    client.table(self._TABLE)
                    .select("delivery_id")
                    .eq("source", source)
                    .eq("delivery_id", delivery_id)
                    .limit(1)
                    .execute()
                )
                if getattr(existing, "data", None):
                    return False  # genuine duplicate -> drop
            except Exception:  # noqa: BLE001
                pass
            logger.warning(
                "webhook delivery claim failed (source=%s): %s; processing without dedup",
                source,
                exc,
            )
            return True


def apply_engine_overrides() -> None:
    webhook_service = import_engine_module("webhook_service")
    webhook_service.build_webhook_url = build_webhook_url
    webhook_service.generate_webhook_secret = generate_webhook_secret
    webhook_service.verify_webhook_token = verify_webhook_token
    webhook_service.get_webhook_secret_hash = get_webhook_secret_hash
    webhook_service.delete_webhook_secret = delete_webhook_secret

    # #277: route inbound-webhook dedup through Supabase (durable + atomic across
    # instances) instead of the ephemeral SQLite default.
    main = import_engine_module("main")
    main.set_webhook_delivery_store(SupabaseWebhookDeliveryStore())
