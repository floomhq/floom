"""Composio HTTP client for workeros.

Uses requests directly (no heavy SDK) against Composio v3 API:
  - list_apps()              → known app slugs we support
  - list_connections()       → active connected accounts for a Floom user
  - initiate_connection(app) → start OAuth flow, returns redirect_url + conn_id
  - check_status(conn_id)    → refresh connection status from Composio
  - get_entity_connection_id(app) → return composio_connection_id for the active connection
  - revoke_connection(conn_id) → delete connection from Composio
"""

from __future__ import annotations

import logging
import os
import time
import threading
import base64
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from dotenv import load_dotenv

logger = logging.getLogger("floom.composio")

_BASE = "https://backend.composio.dev/api/v3"
_CATALOG_TTL_SECONDS = 60 * 60
_catalog_cache: Dict[tuple, tuple[float, Dict[str, Any]]] = {}
_catalog_cache_lock = threading.Lock()

_TOOLKIT_TOOLS_TTL_SECONDS = 60 * 60
_toolkit_tools_cache: Dict[tuple, tuple[float, List[Dict[str, Any]]]] = {}
_toolkit_tools_cache_lock = threading.Lock()

_AUTH_CONFIG_TTL_SECONDS = 10 * 60
_auth_config_cache: Dict[str, tuple[float, str]] = {}
_auth_config_cache_lock = threading.Lock()

if os.environ.get("WORKEROS_DEV") == "1":
    api_env_override = os.environ.get("WORKEROS_API_ENV_FILE") or os.environ.get("FLOOM_API_ENV_FILE")
    api_env_path = (
        Path(api_env_override).expanduser()
        if api_env_override
        else Path.home() / ".config" / "workeros" / "api.env"
    )
    load_dotenv(api_env_path, override=False)

SUPPORTED_APPS: Dict[str, str] = {
    "gmail": "Gmail",
    "linkedin": "LinkedIn",
    "hubspot": "HubSpot",
    "slack": "Slack",
    "notion": "Notion",
    "googledrive": "Google Drive",
    "apollo": "Apollo",
}


class ComposioConfigurationError(RuntimeError):
    """Raised when the server is missing required Composio configuration."""


def _api_key() -> str:
    key = os.environ.get("COMPOSIO_API_KEY", "")
    if not key:
        raise ComposioConfigurationError(
            "Composio is not configured on this server. Set COMPOSIO_API_KEY to enable connections."
        )
    return key


def _headers() -> Dict[str, str]:
    return {
        "x-api-key": _api_key(),
        "Content-Type": "application/json",
    }


def _get(path: str, **params: Any) -> Any:
    clean_params = {k: v for k, v in params.items() if v not in (None, "")}
    r = requests.get(f"{_BASE}{path}", headers=_headers(), params=clean_params, timeout=15)
    r.raise_for_status()
    return r.json()


_CATALOG_RETRY_DELAY_SECONDS = 0.25


def _get_with_retry(path: str, **params: Any) -> Any:
    """GET wrapper that retries once after a short delay.

    The Composio catalog fetch is a safe, idempotent GET, but cold starts and
    transient rate-limiting made the first /integrations/catalog load fail
    ~50% of the time, surfacing "Could not load integrations" in the UI (#189).
    Retrying once after a brief pause clears the transient case without masking
    a genuine outage.
    """
    try:
        return _get(path, **params)
    except (requests.RequestException, RuntimeError) as exc:
        logger.warning("Composio GET %s failed (%s); retrying once after %sms", path, exc, int(_CATALOG_RETRY_DELAY_SECONDS * 1000))
        time.sleep(_CATALOG_RETRY_DELAY_SECONDS)
        return _get(path, **params)


def _post(path: str, body: Dict[str, Any]) -> Any:
    r = requests.post(f"{_BASE}{path}", headers=_headers(), json=body, timeout=15)
    r.raise_for_status()
    return r.json()


def _patch(path: str, body: Dict[str, Any]) -> Any:
    r = requests.patch(f"{_BASE}{path}", headers=_headers(), json=body, timeout=15)
    r.raise_for_status()
    return r.json()


def _delete(path: str) -> None:
    r = requests.delete(f"{_BASE}{path}", headers=_headers(), timeout=15)
    r.raise_for_status()


def list_apps() -> List[Dict[str, str]]:
    return [
        {"slug": slug, "display_name": name}
        for slug, name in SUPPORTED_APPS.items()
    ]


def _catalog_cursor(page: int, limit: int) -> Optional[str]:
    if page <= 1:
        return None
    return base64.b64encode(f"{page}-{limit}".encode("utf-8")).decode("ascii")


def _normalize_catalog_item(item: Dict[str, Any]) -> Dict[str, Any]:
    meta = item.get("meta") or {}
    categories = []
    for category in meta.get("categories") or item.get("categories") or []:
        if isinstance(category, dict):
            value = category.get("id") or category.get("name")
        else:
            value = category
        if value:
            categories.append(str(value))

    return {
        "slug": (item.get("slug") or "").lower(),
        "name": item.get("name") or item.get("slug") or "",
        "logo_url": meta.get("logo") or item.get("logo") or item.get("logo_url") or "",
        "description": meta.get("description") or item.get("description") or "",
        "categories": categories,
        "tools_count": meta.get("tools_count") or 0,
        "triggers_count": meta.get("triggers_count") or 0,
    }


def list_catalog_apps(
    *,
    page: int = 1,
    limit: int = 30,
    search: str = "",
    category: str = "",
) -> Dict[str, Any]:
    """Return the Composio app/toolkit catalog, normalized for the web UI.

    Composio v3 currently exposes the catalog at /toolkits. The older /apps
    path returns 404, so this client uses the live v3 catalog endpoint.

    ``category`` is a single Composio category slug. For OR-merge across
    multiple categories, the caller (main.py endpoint) is responsible for
    calling this function once per slug and merging the results.
    """
    _api_key()
    page = max(1, page)
    limit = max(1, min(100, limit))
    normalized_search = search.strip()
    normalized_category = category.strip()
    cache_key = (page, limit, normalized_search.lower(), normalized_category.lower())
    now = time.monotonic()

    with _catalog_cache_lock:
        cached = _catalog_cache.get(cache_key)
        if cached and now - cached[0] < _CATALOG_TTL_SECONDS:
            return cached[1]

    # Composio /toolkits rejects a `search` shorter than 3 chars with a 400
    # ("Search query must be at least 3 characters long"), which previously
    # surfaced to the Browse grid as a dead-end 502. For 1-2 char queries we do
    # NOT forward the term; we fetch the page unfiltered and substring-filter it
    # locally so short queries still narrow without ever 400/502-ing upstream.
    upstream_search = normalized_search if len(normalized_search) >= 3 else None
    local_filter = normalized_search.lower() if normalized_search and upstream_search is None else None

    try:
        data = _get_with_retry(
            "/toolkits",
            limit=limit,
            cursor=_catalog_cursor(page, limit),
            search=upstream_search,
            category=normalized_category or None,
        )
    except requests.exceptions.HTTPError as exc:
        # Never dead-end the Browse grid on an upstream catalog error: degrade to
        # an unfiltered fetch (+ local filter). If even that fails, return an
        # empty page rather than bubbling a 502 — and don't cache the failure.
        logger.warning("Composio catalog query failed (%s); degrading to unfiltered", exc)
        try:
            data = _get_with_retry(
                "/toolkits",
                limit=limit,
                cursor=_catalog_cursor(page, limit),
                search=None,
                category=normalized_category or None,
            )
            local_filter = normalized_search.lower() or local_filter
        except requests.exceptions.HTTPError:
            return {
                "items": [], "page": page, "limit": limit,
                "total_items": 0, "total_pages": 1, "next_page": None, "categories": [],
            }

    items = [_normalize_catalog_item(item) for item in data.get("items") or []]
    if local_filter:
        items = [
            it for it in items
            if local_filter in it["name"].lower() or local_filter in it["slug"].lower()
        ]
    categories = sorted({cat for item in items for cat in item["categories"]})
    total_items = int(data.get("total_items") or len(items))
    total_pages = int(data.get("total_pages") or 1)

    result = {
        "items": items,
        "page": int(data.get("current_page") or page),
        "limit": limit,
        "total_items": total_items,
        "total_pages": total_pages,
        "next_page": page + 1 if data.get("next_cursor") and page < total_pages else None,
        "categories": categories,
    }

    with _catalog_cache_lock:
        _catalog_cache[cache_key] = (now, result)
    return result


def list_toolkit_tools(slug: str, *, limit: int = 100) -> List[Dict[str, Any]]:
    """Return the top N tools for a Composio toolkit slug, cached for 1 hour.

    Default limit raised to 100 to support the full tool list in the Browse
    modal (e.g. Gmail has 85+ tools). Cache key includes limit so that
    different callers with different caps get correct independent entries.

    Returns a list of dicts with keys: name, description.
    Falls back to [] on any error so the UI degrades gracefully.
    """
    _api_key()
    normalized = slug.strip().lower()
    cache_key = (normalized, limit)
    now = time.monotonic()
    with _toolkit_tools_cache_lock:
        cached = _toolkit_tools_cache.get(cache_key)
        if cached and now - cached[0] < _TOOLKIT_TOOLS_TTL_SECONDS:
            return cached[1]

    try:
        data = _get_with_retry("/tools", toolkit_slug=normalized, limit=limit)
        items = data.get("items") or []
        result: List[Dict[str, Any]] = [
            {
                "name": item.get("name") or item.get("slug") or "",
                "description": (item.get("description") or "")[:200],
            }
            for item in items
            if item.get("name") or item.get("slug")
        ]
    except Exception as exc:
        logger.warning("Failed to fetch tools for toolkit %s: %s", slug, exc)
        result = []

    with _toolkit_tools_cache_lock:
        _toolkit_tools_cache[cache_key] = (now, result)
    return result


def list_connections(*, user_id: str) -> List[Dict[str, Any]]:
    """Return connected accounts for a Floom user from Composio v3."""
    data = _get("/connected_accounts", user_ids=user_id, limit=100)
    items = data.get("items") or []
    result: List[Dict[str, Any]] = []
    for item in items:
        toolkit = item.get("toolkit") or {}
        result.append({
            "composio_connection_id": item.get("id", ""),
            "app_name": (toolkit.get("slug") or "").lower(),
            "status": (item.get("status") or "unknown").lower(),
        })
    return result


def list_triggers() -> List[Dict[str, Any]]:
    """Return the Composio v3 trigger catalog (all pages)."""
    _api_key()

    def fetch_page(cursor: Optional[str]) -> Dict[str, Any]:
        params: Dict[str, Any] = {"limit": 100}
        if cursor:
            params["cursor"] = cursor
        try:
            return _get("/triggers_types", **params)
        except requests.HTTPError as exc:
            if exc.response is None or exc.response.status_code not in {404, 405, 410}:
                raise
            return _get("/triggers", **params)

    all_items: List[Dict[str, Any]] = []
    cursor: Optional[str] = None
    max_pages = 50  # safety cap (5000 triggers max)
    for _ in range(max_pages):
        data = fetch_page(cursor)
        if isinstance(data, list):
            all_items.extend(data)
            break
        items = data.get("items") or data.get("triggers") or data.get("data") or data.get("trigger_types") or []
        if isinstance(items, list):
            all_items.extend(items)
        next_cursor = data.get("next_cursor") or data.get("nextCursor")
        if not next_cursor:
            break
        cursor = str(next_cursor)
    return all_items


def _extract_enabled_trigger_id(event: str, data: Any) -> str:
    """Extract Composio's trigger subscription id from known v3 response shapes."""
    if not isinstance(data, dict):
        return event
    candidates = [
        data.get("id"),
        data.get("trigger_id"),
        data.get("trigger_instance_id"),
        data.get("triggerInstanceId"),
        data.get("triggerId"),
        data.get("enabled_trigger_id"),
        data.get("connected_account_trigger_id"),
    ]
    trigger = data.get("trigger")
    if isinstance(trigger, dict):
        candidates.extend([trigger.get("id"), trigger.get("trigger_id")])
    item = data.get("item") or data.get("data") or data.get("trigger_instance")
    if isinstance(item, dict):
        candidates.extend([
            item.get("id"),
            item.get("uuid"),
            item.get("trigger_id"),
            item.get("trigger_instance_id"),
        ])
    for candidate in candidates:
        if candidate:
            return str(candidate)
    return event


def _legacy_fallback_enabled(exc: requests.HTTPError) -> bool:
    return exc.response is not None and exc.response.status_code in {404, 405, 410}


def enable_trigger(
    event: str,
    connection_id: str,
    webhook_url: str,
    config: Optional[Dict[str, Any]] = None,
) -> str:
    """Enable a Composio trigger and return the enabled trigger id."""
    try:
        data = _post(
            f"/trigger_instances/{event}/upsert",
            {
                "connected_account_id": connection_id,
                "trigger_config": config or {},
            },
        )
    except requests.HTTPError as exc:
        if not _legacy_fallback_enabled(exc):
            raise
        data = _post(
            f"/triggers/{event}/enable",
            {
                "connection_id": connection_id,
                "webhook_url": webhook_url,
                "config": config or {},
            },
        )
    return _extract_enabled_trigger_id(event, data)


def disable_trigger(event: str, composio_trigger_id: Optional[str] = None) -> None:
    """Disable a Composio trigger subscription for an event."""
    if composio_trigger_id:
        try:
            _patch(f"/trigger_instances/manage/{composio_trigger_id}", {"status": "disable"})
            return
        except requests.HTTPError as exc:
            if not _legacy_fallback_enabled(exc):
                raise
    body: Dict[str, Any] = {}
    if composio_trigger_id:
        body["trigger_id"] = composio_trigger_id
    _post(f"/triggers/{event}/disable", body)


class NoManagedAuthError(Exception):
    """Raised when Composio has no managed OAuth credentials for a toolkit.

    This typically means the app is API-key-only or uses a non-standard auth
    scheme (e.g. DCR_OAUTH) that requires user-supplied credentials.
    """


def _resolve_auth_config_id(app_name: str) -> str:
    """Find (or create) a Composio-managed auth_config for the given toolkit.

    Raises NoManagedAuthError if Composio does not support managed OAuth for
    this toolkit (e.g. the app is API-key-only or DCR_OAUTH-only).
    """
    normalized_app = app_name.lower().strip()
    now = time.monotonic()
    with _auth_config_cache_lock:
        cached = _auth_config_cache.get(normalized_app)
        if cached and now - cached[0] < _AUTH_CONFIG_TTL_SECONDS:
            return cached[1]

    data = _get("/auth_configs", toolkit_slugs=normalized_app, limit=20)
    for ac in data.get("items") or []:
        toolkit = ac.get("toolkit") or {}
        if (toolkit.get("slug") or "").lower() == normalized_app:
            if ac.get("status") in (None, "ENABLED"):
                auth_config_id = ac["id"]
                with _auth_config_cache_lock:
                    _auth_config_cache[normalized_app] = (now, auth_config_id)
                return auth_config_id
    # Create one if none exists.
    try:
        created = _post("/auth_configs", {
            "toolkit": {"slug": normalized_app},
            "auth_config": {
                "type": "use_composio_managed_auth",
                "name": f"workeros_{normalized_app}",
            },
        })
    except requests.HTTPError as exc:
        # Composio returns 400 with slug "Auth_Config_DefaultAuthConfigNotFound"
        # when the toolkit does not have Composio-managed OAuth credentials.
        if exc.response is not None and exc.response.status_code == 400:
            try:
                body = exc.response.json()
                err = body.get("error") or {}
                code = err.get("slug") or err.get("code") or ""
                if "DefaultAuthConfig" in str(code) or "no managed" in str(err.get("message", "")).lower():
                    raise NoManagedAuthError(
                        f"{normalized_app} does not support Composio-managed OAuth. "
                        "Add an API key in Secrets instead."
                    ) from exc
            except (ValueError, AttributeError):
                pass
        raise
    auth_config_id = created["auth_config"]["id"]
    with _auth_config_cache_lock:
        _auth_config_cache[normalized_app] = (now, auth_config_id)
    return auth_config_id


def initiate_connection(app_name: str, redirect_url: str, *, user_id: str) -> Dict[str, str]:
    """Initiate OAuth for app_name. Returns the Composio redirect URL.

    #631: Composio deprecated POST /connected_accounts for managed OAuth auth
    configs (June 2026 breaking change). The new endpoint is
    POST /connected_accounts/link with a flat payload; it returns a hosted
    Composio link URL that handles the provider OAuth redirect internally and
    calls our callback_url when done.

    Returns {composio_connection_id, redirect_url}.
    Raises NoManagedAuthError if the app does not support managed OAuth.
    """
    auth_config_id = _resolve_auth_config_id(app_name)
    data = _post("/connected_accounts/link", {
        "auth_config_id": auth_config_id,
        "user_id": user_id,
        "redirect_url": redirect_url,
    })
    conn_id = data.get("connected_account_id") or data.get("id") or ""
    oauth_url = data.get("redirect_url") or data.get("oauth_url") or ""
    return {
        "composio_connection_id": conn_id,
        "redirect_url": oauth_url,
    }


def check_status(composio_connection_id: str) -> str:
    """Fetch current status from Composio v3. Returns 'active', 'initiated', 'expired', 'failed', etc."""
    try:
        data = _get(f"/connected_accounts/{composio_connection_id}")
        return (data.get("status") or "unknown").lower()
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            return "not_found"
        raise


def revoke_connection(composio_connection_id: str) -> None:
    _delete(f"/connected_accounts/{composio_connection_id}")


def get_entity_connection_id(app_name: str, *, user_id: str) -> Optional[str]:
    """Return the composio_connection_id of the active connection for app_name."""
    for conn in list_connections(user_id=user_id):
        if conn["app_name"].lower() == app_name.lower() and conn["status"] == "active":
            return conn["composio_connection_id"]
    return None
