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
        unwrapped = engine_db_factory.get_repositories.__wrapped__
        # The engine's register_repositories() calls cache_clear() on
        # get_repositories after every registration. Give the unwrapped
        # function a no-op cache_clear so that path still works.
        unwrapped.cache_clear = lambda: None  # type: ignore[attr-defined]
        engine_db_factory.get_repositories = unwrapped

    # Same surgery for get_auth_provider — its cached SupabaseAuthProvider
    # holds a long-lived supabase client whose httpx HTTP/2 pool goes stale
    # after Supabase silently drops idle connections. Per-request providers
    # rebuild the client (~50ms TLS) but stay reliable.
    from auth import factory as engine_auth_factory
    if hasattr(engine_auth_factory.get_auth_provider, "__wrapped__"):
        unwrapped_ap = engine_auth_factory.get_auth_provider.__wrapped__
        unwrapped_ap.cache_clear = lambda: None  # type: ignore[attr-defined]
        engine_auth_factory.get_auth_provider = unwrapped_ap

    # The engine has MULTIPLE modules that call load_dotenv() on import,
    # each pointing at /root/.config/workeros/api.env (OSS single-tenant
    # local-mode prod env, contains FLOOM_SECRET). When any of them
    # imports lazily during a request (e.g. composio_client when
    # /api/integrations/catalog hits), FLOOM_SECRET leaks into our
    # process environment. The engine's auth_middleware then enforces
    # x-floom-secret on every subsequent request -> 401 for cloud
    # traffic.
    #
    # Eager-import the known offenders here so the leak happens ONCE at
    # boot, then pop FLOOM_SECRET. Also install a process-level
    # os.environ guard that strips FLOOM_SECRET whenever anything tries
    # to set it in cloud mode, in case the engine grows new
    # load_dotenv() call sites later.
    import os as _osmod
    if (_osmod.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud":
        try:
            __import__("composio_client")
        except Exception:
            pass
        try:
            __import__("run_service")
        except Exception:
            pass
        try:
            __import__("webhook_service")
        except Exception:
            pass
        _osmod.environ.pop("FLOOM_SECRET", None)

        _orig_setitem = type(_osmod.environ).__setitem__

        def _block_floom_secret(self, key, value):
            if key == "FLOOM_SECRET":
                # In cloud mode this env var has no place. Anything trying
                # to set it (load_dotenv pulling in a local-mode env file)
                # is silently bypassed. Auth flows entirely through
                # Supabase JWTs via SupabaseAuthProvider.
                return
            return _orig_setitem(self, key, value)

        type(_osmod.environ).__setitem__ = _block_floom_secret


register_cloud_components()
