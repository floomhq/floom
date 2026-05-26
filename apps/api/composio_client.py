"""Composio HTTP client for workeros.

Uses requests directly (no heavy SDK) against Composio v3 API:
  - list_apps()              → known app slugs we support
  - list_connections()       → active connected accounts for entity "federico"
  - initiate_connection(app) → start OAuth flow, returns redirect_url + conn_id
  - check_status(conn_id)    → refresh connection status from Composio
  - get_entity_connection_id(app) → return composio_connection_id for the active connection
  - revoke_connection(conn_id) → delete connection from Composio

Single-user: all connections use user_id = "federico".
"""

from __future__ import annotations

import logging
import os
import time
import threading
import base64
from typing import Any, Dict, List, Optional

import requests
from dotenv import load_dotenv

logger = logging.getLogger("floom.composio")

_BASE = "https://backend.composio.dev/api/v3"
_USER_ID = "federico"
_CATALOG_TTL_SECONDS = 60 * 60
_catalog_cache: Dict[tuple, tuple[float, Dict[str, Any]]] = {}
_catalog_cache_lock = threading.Lock()

load_dotenv("/root/.config/workeros/api.env", override=False)

SUPPORTED_APPS: Dict[str, str] = {
    "gmail": "Gmail",
    "linkedin": "LinkedIn",
    "hubspot": "HubSpot",
    "slack": "Slack",
    "notion": "Notion",
    "googledrive": "Google Drive",
    "apollo": "Apollo",
}


def _api_key() -> str:
    key = os.environ.get("COMPOSIO_API_KEY", "")
    if not key:
        raise RuntimeError("COMPOSIO_API_KEY is not set")
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
    """
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

    data = _get(
        "/toolkits",
        limit=limit,
        cursor=_catalog_cursor(page, limit),
        search=normalized_search or None,
        category=normalized_category or None,
    )
    items = [_normalize_catalog_item(item) for item in data.get("items") or []]
    categories = sorted({category for item in items for category in item["categories"]})
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


def list_connections() -> List[Dict[str, Any]]:
    """Return connected accounts for our single user from Composio v3."""
    data = _get("/connected_accounts", user_ids=_USER_ID, limit=100)
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
    """Return the Composio v3 trigger catalog."""
    try:
        data = _get("/triggers_types", limit=1000)
    except requests.HTTPError as exc:
        if exc.response is None or exc.response.status_code not in {404, 405, 410}:
            raise
        data = _get("/triggers", limit=1000)
    if isinstance(data, list):
        return data
    items = data.get("items") or data.get("triggers") or data.get("data") or data.get("trigger_types") or []
    return items if isinstance(items, list) else []


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


def _resolve_auth_config_id(app_name: str) -> str:
    """Find (or create) a Composio-managed auth_config for the given toolkit."""
    data = _get("/auth_configs", toolkit_slugs=app_name, limit=20)
    for ac in data.get("items") or []:
        toolkit = ac.get("toolkit") or {}
        if (toolkit.get("slug") or "").lower() == app_name.lower():
            if ac.get("status") in (None, "ENABLED"):
                return ac["id"]
    # Create one if none exists
    created = _post("/auth_configs", {
        "toolkit": {"slug": app_name},
        "auth_config": {
            "type": "use_composio_managed_auth",
            "name": f"workeros_{app_name}",
        },
    })
    return created["auth_config"]["id"]


def initiate_connection(app_name: str, redirect_url: str) -> Dict[str, str]:
    """Initiate OAuth for app_name (v3 API).

    Returns {composio_connection_id, redirect_url}.
    """
    auth_config_id = _resolve_auth_config_id(app_name)
    data = _post("/connected_accounts", {
        "auth_config": {"id": auth_config_id},
        "connection": {
            "user_id": _USER_ID,
            "callback_url": redirect_url,
        },
    })
    # v3 returns the connection in two shapes; prefer the top-level id.
    conn_id = (
        data.get("id")
        or (data.get("connected_account") or {}).get("id", "")
    )
    oauth_url = (
        data.get("redirect_url")
        or data.get("redirect_uri")
        or (data.get("connection_data") or {}).get("redirectUrl", "")
    )
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


def get_entity_connection_id(app_name: str) -> Optional[str]:
    """Return the composio_connection_id of the active connection for app_name."""
    for conn in list_connections():
        if conn["app_name"].lower() == app_name.lower() and conn["status"] == "active":
            return conn["composio_connection_id"]
    return None
