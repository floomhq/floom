from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from functools import lru_cache

from supabase import Client, create_client
from supabase.lib.client_options import SyncClientOptions

from apps.api._cloud_env import load_cloud_env_file

load_cloud_env_file()


def _env(*names: str, default: str | None = None) -> str | None:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return default


@dataclass(frozen=True)
class CloudSettings:
    project_ref: str | None
    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: str
    frontend_url: str
    # Dashboard origin (scheme + host, NO path). Used by /auth/callback's
    # _frontend_redirect when posting users back to a dashboard route like
    # "/secrets". Distinct from frontend_url because the engine's
    # Composio /connections/callback expects WORKERS_FRONTEND_URL to end
    # with "/app" (the dashboard basePath), while _frontend_redirect must
    # NOT include "/app" or every redirect would land on "/app/app/...".
    dashboard_origin: str
    api_base: str
    cli_code_ttl_seconds: int


def _require_https(url: str) -> None:
    if url.startswith("https://"):
        return
    if (os.environ.get("WORKEROS_DEV") or "").strip():
        return
    raise RuntimeError(
        "Cloud mode requires an HTTPS Supabase URL unless WORKEROS_DEV is set."
    )


@lru_cache(maxsize=1)
def get_cloud_settings() -> CloudSettings:
    supabase_url = _env("SUPABASE_URL", "WORKEROS_CLOUD_SUPABASE_URL")
    anon_key = _env("SUPABASE_ANON_KEY", "WORKEROS_CLOUD_SUPABASE_ANON_KEY")
    service_role_key = _env(
        "SUPABASE_SERVICE_ROLE_KEY",
        "WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY",
    )
    frontend_url = _env(
        "WORKERS_FRONTEND_URL",
        "WORKEROS_FRONTEND_URL",
        default="http://127.0.0.1:3000",
    )
    dashboard_origin = _env(
        "WORKEROS_DASHBOARD_ORIGIN",
        "WORKEROS_FRONTEND_URL",
        default="http://127.0.0.1:3000",
    )
    api_base = _env(
        "WORKEROS_API_BASE",
        "WORKERS_API_URL",
        default="http://127.0.0.1:8000",
    )
    missing = [
        name
        for name, value in {
            "WORKEROS_CLOUD_SUPABASE_URL": supabase_url,
            "WORKEROS_CLOUD_SUPABASE_ANON_KEY": anon_key,
            "WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY": service_role_key,
        }.items()
        if not value
    ]
    if missing:
        raise RuntimeError(
            "Missing required cloud env vars: " + ", ".join(sorted(missing))
        )
    _require_https(supabase_url)
    return CloudSettings(
        project_ref=_env("WORKEROS_CLOUD_PROJECT_REF"),
        supabase_url=supabase_url,
        supabase_anon_key=anon_key,
        supabase_service_role_key=service_role_key,
        frontend_url=frontend_url.rstrip("/"),
        dashboard_origin=dashboard_origin.rstrip("/"),
        api_base=api_base.rstrip("/"),
        cli_code_ttl_seconds=int(
            _env(
                "WORKEROS_CLOUD_CLI_CODE_TTL_SECONDS",
                default="300",
            )
            or "300"
        ),
    )


def _client_options() -> SyncClientOptions:
    return SyncClientOptions(
        auto_refresh_token=False,
        persist_session=False,
        headers={"X-Client-Info": "workeros-cloud-api"},
    )


def _create_client_with_key(key: str) -> Client:
    settings = get_cloud_settings()
    return create_client(
        settings.supabase_url,
        key,
        options=_client_options(),
    )


def new_supabase_anon_client() -> Client:
    settings = get_cloud_settings()
    return _create_client_with_key(settings.supabase_anon_key)


def new_supabase_service_client() -> Client:
    settings = get_cloud_settings()
    return _create_client_with_key(settings.supabase_service_role_key)


# TTL-cached Supabase clients.
#
# Problem: creating a new httpx Client per request requires a full TLS
# handshake on every Supabase call. With 3-4 queries per page load and
# cross-region latency this costs 5-7s per request in production.
#
# Why not lru_cache forever: after ~5 min of idle Supabase closes the
# connection. The next request fails with httpcore.RemoteProtocolError:
# ConnectionTerminated, which Starlette's middleware swallows into a
# useless 500.
#
# Fix: cache the client with a 4-minute TTL. The warm client reuses the
# existing HTTP/2 connection pool (< 5ms per query); a new client is only
# created after 4 min of silence, accepting one ~50ms TLS handshake then.
_CLIENT_TTL = 240  # seconds — refresh before Supabase's ~5 min idle timeout

_svc_client: "Client | None" = None
_svc_client_ts: float = 0.0
_svc_lock = threading.Lock()


def get_supabase_service_client() -> Client:
    global _svc_client, _svc_client_ts
    now = time.monotonic()
    if _svc_client is None or (now - _svc_client_ts) > _CLIENT_TTL:
        with _svc_lock:
            if _svc_client is None or (now - _svc_client_ts) > _CLIENT_TTL:
                _svc_client = new_supabase_service_client()
                _svc_client_ts = now
    return _svc_client


def reset_cloud_caches() -> None:
    global _svc_client, _svc_client_ts
    get_cloud_settings.cache_clear()
    with _svc_lock:
        _svc_client = None
        _svc_client_ts = 0.0
