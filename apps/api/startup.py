from __future__ import annotations

import os

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.supabase_provider import SupabaseAuthProvider
from apps.api.cloud_webhooks import apply_engine_overrides
from apps.api.config import get_cloud_settings
from apps.api.db._secret_crypto import ensure_secret_crypto_ready
from apps.api.db.supabase_repos import (
    SupabaseCliAuthRepository,
    SupabaseConnectionRepository,
    SupabaseRunRepository,
    SupabaseSecretRepository,
    SupabaseWorkerRepository,
)

ensure_engine_api_path()

from auth.factory import register_auth_provider  # noqa: E402
import db as engine_db  # noqa: E402
from db import factory as engine_db_factory  # noqa: E402
from db.factory import Repositories, register_repositories  # noqa: E402


def _activate_cloud_deploy() -> None:
    # This repository is the cloud wrapper around the vendored engine, so
    # importing its startup module defaults the engine to cloud mode.
    os.environ.setdefault("WORKEROS_DEPLOY", "cloud")


def _cloud_repositories() -> Repositories:
    return Repositories(
        workers=SupabaseWorkerRepository(),
        runs=SupabaseRunRepository(),
        connections=SupabaseConnectionRepository(),
        secrets=SupabaseSecretRepository(),
        cli_auth=SupabaseCliAuthRepository(),
    )


def register_cloud_components() -> None:
    _activate_cloud_deploy()
    get_cloud_settings()
    ensure_secret_crypto_ready()
    register_auth_provider("cloud", lambda: SupabaseAuthProvider())
    register_repositories("cloud", _cloud_repositories)
    apply_engine_overrides()
    engine_db.init_db = lambda: None

    # Bypass the engine's lru_cache on get_repositories. Otherwise the
    # cached Repositories instance holds repo objects that hold a stale
    # cached httpx client, and Supabase eventually closes the long-lived
    # HTTP/2 connection — the next request fails with
    # httpcore.RemoteProtocolError: ConnectionTerminated, which
    # Starlette's BaseHTTPMiddleware swallows into a useless 500
    # "No response returned". Rebuilding per request costs ~5ms but
    # stays reliable indefinitely.
    if hasattr(engine_db_factory.get_repositories, "__wrapped__"):
        engine_db_factory.get_repositories = (
            engine_db_factory.get_repositories.__wrapped__
        )


register_cloud_components()
