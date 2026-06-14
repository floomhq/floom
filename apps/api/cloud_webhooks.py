from __future__ import annotations

import logging
import os
from typing import Optional
from urllib.parse import quote

from apps.api._engine import ensure_engine_api_path, import_engine_module

ensure_engine_api_path()

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


def apply_engine_overrides() -> None:
    webhook_service = import_engine_module("webhook_service")
    webhook_service.build_webhook_url = build_webhook_url
    webhook_service.generate_webhook_secret = generate_webhook_secret
    webhook_service.verify_webhook_token = verify_webhook_token
    webhook_service.get_webhook_secret_hash = get_webhook_secret_hash
    webhook_service.delete_webhook_secret = delete_webhook_secret
