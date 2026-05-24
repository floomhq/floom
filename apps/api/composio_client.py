"""Composio HTTP client for workeros.

Uses requests directly (no heavy SDK) to:
  - list_apps()              → known app slugs we support
  - list_connections()       → active connected accounts for entity "federico"
  - initiate_connection(app) → start OAuth flow, returns redirect_url + conn_id
  - check_status(conn_id)    → refresh connection status from Composio
  - get_entity_id(app)       → return composio_connection_id for a given app (for SDK toolset)
  - revoke_connection(conn_id) → delete connection from Composio

Single-user: all connections use entity_id = "federico".
"""

from __future__ import annotations

import os
import logging
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger("floom.composio")

_BASE = "https://backend.composio.dev/api/v1"
_ENTITY_ID = "federico"

# Apps we surface in the UI. Composio app slug → display name.
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


def _get(path: str, **params) -> Any:
    url = f"{_BASE}{path}"
    r = requests.get(url, headers=_headers(), params=params, timeout=15)
    r.raise_for_status()
    return r.json()


def _post(path: str, body: Dict) -> Any:
    url = f"{_BASE}{path}"
    r = requests.post(url, headers=_headers(), json=body, timeout=15)
    r.raise_for_status()
    return r.json()


def _delete(path: str) -> None:
    url = f"{_BASE}{path}"
    r = requests.delete(url, headers=_headers(), timeout=15)
    r.raise_for_status()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def list_apps() -> List[Dict[str, str]]:
    """Return list of {slug, display_name} for supported apps."""
    return [
        {"slug": slug, "display_name": name}
        for slug, name in SUPPORTED_APPS.items()
    ]


def list_connections() -> List[Dict[str, Any]]:
    """Return connected accounts for entity 'federico' from Composio."""
    data = _get("/connectedAccounts", entityId=_ENTITY_ID, page=1, pageSize=50)
    items = data.get("items") or data.get("connectedAccounts") or []
    result = []
    for item in items:
        result.append({
            "composio_connection_id": item.get("id") or item.get("connectedAccountId", ""),
            "app_name": (item.get("appName") or item.get("app") or "").lower(),
            "status": item.get("status", "unknown").lower(),
        })
    return result


def initiate_connection(app_name: str, redirect_url: str) -> Dict[str, str]:
    """Initiate OAuth for app_name. Returns {composio_connection_id, redirect_url}.

    Uses use_composio_auth=True so Composio manages the OAuth client credentials.
    """
    # Step 1: get or create an integration for the app using Composio-managed auth
    integration = _get_or_create_integration(app_name)
    integration_id = integration["id"]

    # Step 2: initiate connection
    body = {
        "integrationId": integration_id,
        "userUuid": _ENTITY_ID,
        "data": {},
        "labels": [],
        "redirectUri": redirect_url,
    }
    data = _post("/connectedAccounts", body)
    conn_id = data.get("connectedAccountId") or data.get("id", "")
    oauth_url = data.get("redirectUrl") or data.get("redirectUri", "")
    return {
        "composio_connection_id": conn_id,
        "redirect_url": oauth_url,
    }


def _get_or_create_integration(app_name: str) -> Dict[str, Any]:
    """Get existing integration for app or create one with Composio-managed auth."""
    # Try to find existing integration
    data = _get("/integrations", appName=app_name, page=1, pageSize=10)
    items = data.get("items") or data.get("integrations") or []

    # Filter to composio-managed auth integrations
    for item in items:
        if item.get("useComposioAuth") is not False:
            return item
    if items:
        return items[0]

    # Create new integration with Composio-managed OAuth
    resp = _post("/integrations", {
        "appName": app_name,
        "useComposioAuth": True,
        "name": f"workeros-{app_name}",
    })
    return resp


def check_status(composio_connection_id: str) -> str:
    """Fetch current status from Composio. Returns 'active', 'initiated', 'failed', etc."""
    try:
        data = _get(f"/connectedAccounts/{composio_connection_id}")
        status = data.get("status", "unknown")
        return status.lower()
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            return "not_found"
        raise


def revoke_connection(composio_connection_id: str) -> None:
    """Delete (revoke) a connection from Composio."""
    _delete(f"/connectedAccounts/{composio_connection_id}")


def get_entity_connection_id(app_name: str) -> Optional[str]:
    """Return the composio_connection_id for the active connection for app_name.

    Used by runner to inject into WorkerContext.connections.<app>.
    """
    connections = list_connections()
    for conn in connections:
        if conn["app_name"].lower() == app_name.lower() and conn["status"] == "active":
            return conn["composio_connection_id"]
    return None
