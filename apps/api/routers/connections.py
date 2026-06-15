"""Composio + MCP connection routes.

The connections surface: list / create (OAuth init + MCP), the OAuth callback,
per-connection status / activity / account-info / peek / tools, deletion, the
auth-config lookup, the live connection test, and the operator sweep. Plus the
connection serializers (public item shaping, account-label redaction, status
normalization, MCP payload normalization) and the Composio account-info /
email-peek fetchers. Extracted verbatim from main.py into an APIRouter.

Shared helpers come from services (composio unavailability, public_view error
shaping, worker_access listing); models leaf types (RunSummary, RunStatus,
read-only presets, MCP-URL guard) are module-level. db/auth are real
module-level imports — this router is purged in lockstep with main/db/auth by
the connection test fixtures, so the bindings refresh per reload.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import time
import urllib.parse
import uuid as _uuid_mod
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional, TypedDict

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import AuthContext, get_auth_context
from core.utils import _parse_iso8601, row_to_dict
from db import Repositories, get_repos, get_repositories, now_iso
from models import (
    RunStatus,
    RunSummary,
    UnsafeMCPUrlError,
    assert_safe_outbound_mcp_url,
    pin_safe_outbound_url,
    read_only_preset_for_app,
    read_only_presets,
)
from services.composio import _raise_composio_unavailable
from services.public_view import _operator_error_message
from services.worker_access import _list_visible_workers, _worker_connection_slugs

logger = logging.getLogger("floom.api")

connections_router = APIRouter()

def _connection_row_for_user(
    connection_id: str,
    user_id: str,
    columns: str,
    repos: Repositories | None = None,
) -> Dict[str, Any]:
    _ = columns
    row = (repos or get_repositories()).connections.get(
        user_id=user_id,
        composio_id=connection_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    return dict(row)


class ConnectionInitRequest(BaseModel):
    app_name: str


class MCPConnectionCreateRequest(BaseModel):
    label: str
    transport: Literal["streamable_http", "sse", "stdio"] = "streamable_http"
    url: Optional[str] = None
    command: Optional[str] = None
    args: List[str] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict)
    cwd: Optional[str] = None
    auth_secret: Optional[str] = None
    allowed_tools: List[str] = Field(default_factory=list)


class ConnectionItem(BaseModel):
    # NEW-7 (2026-06-02): the raw Composio ``ca_*`` connection id is no longer
    # exposed. Clients reference a connection by the internal Floom UUID ``id``;
    # the API resolves it to the raw ``ca_*`` server-side (with the server-held
    # COMPOSIO_API_KEY) when registering triggers / fetching account info.
    id: str
    app_name: str
    status: str
    created_at: str
    updated_at: str
    kind: str = "composio"
    scopes: List[str] = []
    account_label: Optional[str] = None
    display_name: Optional[str] = None
    last_checked_at: Optional[str] = None
    last_check_status: Optional[str] = None
    last_used_at: Optional[str] = None  # #802: most recent run using this connection
    last_used_by: Optional[str] = None  # #802: worker name of that run
    owner_id: Optional[str] = None
    mcp_label: Optional[str] = None
    mcp_url: Optional[str] = None
    mcp_transport: str = "streamable_http"
    mcp_command: Optional[str] = None
    mcp_args: List[str] = []
    mcp_env: Dict[str, str] = {}
    mcp_cwd: Optional[str] = None
    mcp_auth_secret: Optional[str] = None
    mcp_allowed_tools: List[str] = []


class ConnectionTestResult(BaseModel):
    status: str  # "valid" | "failed" | "expired"
    reason: str
    tested_at: str
    tools: Optional[List[str]] = None  # #789: live-enumerated MCP tool names


class ConnectionInitResponse(BaseModel):
    id: str
    app_name: str
    redirect_url: str
    composio_connection_id: str


def _get_callback_url() -> str:
    """Build the OAuth callback URL for Composio to redirect to."""
    base = os.environ.get("WORKERS_FRONTEND_URL", "http://localhost:3000")
    return f"{base}/connections/callback"


def _parse_scopes_json(scopes_json: Optional[str]) -> List[str]:
    """Parse a JSON-encoded scopes list from the DB; return [] on any error."""
    if not scopes_json:
        return []
    try:
        parsed = json.loads(scopes_json)
        if isinstance(parsed, list):
            return [s for s in parsed if isinstance(s, str)]
    except Exception:
        pass
    return []


def _parse_json_string_list(value: Optional[str]) -> List[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str) and item.strip()]


_CONNECTION_LIST_REFRESH_STATUSES = {"initiated", "pending"}
_CONNECTION_LIST_REFRESH_INTERVAL = timedelta(seconds=30)
_COMPOSIO_ACTIVE_STATUSES = {"active", "valid", "connected", "enabled", "success"}


def _normalize_composio_connection_status(status: Optional[str]) -> str:
    normalized = (status or "").strip().lower()
    if normalized in _COMPOSIO_ACTIVE_STATUSES:
        return "active"
    return normalized


def _account_label_from_info(info: Dict[str, Any]) -> str:
    for key in ("email", "account_label", "handle", "username", "login"):
        value = info.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _cache_connection_account_info(
    *,
    repos: Repositories,
    user_id: str,
    connection_id: str,
    composio_connection_id: str,
    now: str,
) -> Dict[str, Any]:
    info = _fetch_composio_account_info(composio_connection_id, user_id=user_id)
    if not info:
        return {}

    updates: Dict[str, Any] = {"updated_at": now}
    account_label = _account_label_from_info(info)
    if account_label:
        updates["account_label"] = account_label
    if info.get("scopes") is not None:
        updates["scopes_json"] = info.get("scopes") or []

    remote_status = _normalize_composio_connection_status(info.get("status"))
    if remote_status and remote_status != "not_found":
        updates["status"] = remote_status

    if len(updates) > 1:
        repos.connections.update(
            user_id=user_id,
            composio_id=connection_id,
            **updates,
        )
    return info


def _connection_list_refresh_due(row: Dict[str, Any], now: datetime) -> bool:
    if (row.get("kind") or "composio") != "composio":
        return False

    status = str(row.get("status") or "").lower()
    if status not in _CONNECTION_LIST_REFRESH_STATUSES:
        return False

    updated_at = _parse_iso8601(row.get("updated_at"))
    if updated_at is None or now - updated_at < _CONNECTION_LIST_REFRESH_INTERVAL:
        return False

    last_checked_at = _parse_iso8601(row.get("last_checked_at"))
    if last_checked_at is not None and now - last_checked_at < _CONNECTION_LIST_REFRESH_INTERVAL:
        return False

    return True


def _refresh_connection_status_for_list(
    row: Dict[str, Any],
    *,
    user_id: str,
    repos: Repositories,
    now: datetime,
) -> Dict[str, Any]:
    if not _connection_list_refresh_due(row, now):
        return row

    checked_at = now.isoformat()
    try:
        from composio_client import check_status

        remote_status = _normalize_composio_connection_status(
            check_status(row["composio_connection_id"])
        )
    except Exception as exc:
        logger.warning("Could not refresh Composio status for %s during list: %s", row.get("id"), exc)
        updated = repos.connections.update(
            user_id=user_id,
            composio_id=row["id"],
            last_checked_at=checked_at,
            last_check_status="failed",
            last_check_error=str(exc)[:500],
        )
        return row_to_dict(updated) if updated else row

    updates: Dict[str, Any] = {
        "last_checked_at": checked_at,
        "last_check_status": remote_status or "unknown",
        "last_check_error": None,
    }
    if remote_status and remote_status != "not_found" and remote_status != str(row.get("status") or "").lower():
        updates["status"] = remote_status
        updates["updated_at"] = checked_at

    updated = repos.connections.update(
        user_id=user_id,
        composio_id=row["id"],
        **updates,
    )
    return row_to_dict(updated) if updated else row


def _redact_connection_account_label(value: Optional[str]) -> Optional[str]:
    """Mask an account identity for any CROSS-USER / multi-tenant surface.

    Workeros OS is single-tenant: the owner is the only principal and MUST see
    their own account identity (the GitHub login, the connected Google email).
    This helper is retained for a future multi-tenant / shared path where one
    user must NOT see another user's account identity — call it only there.
    For the owner's own connections use ``_normalize_owner_account_label``.
    """
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if "@" in text:
        return "Connected account"
    return text[:32]


def _normalize_owner_account_label(value: Optional[str]) -> Optional[str]:
    """Return the owner's own account identity verbatim (single-tenant view).

    No redaction: in single-tenant the owner is entitled to see their real
    GitHub login / Google email. The placeholder "Connected account" string is
    treated as "no real label yet" so the UI can fall back to other fields.
    """
    if not value:
        return None
    text = str(value).strip()
    if not text or text == "Connected account":
        return None
    return text


def _public_connection_item(data: Dict[str, Any]) -> ConnectionItem:
    item = dict(data)
    # NEW-7: never surface the raw Composio ``ca_*`` id to clients.
    item.pop("composio_connection_id", None)
    item["owner_id"] = item.get("owner_id") or item.get("user_id")
    item["kind"] = item.get("kind") or "composio"
    # Single-tenant owner view: show the owner their OWN account identity.
    # display_name carries the real label when present; fall back to
    # account_label. Both are the owner's own data, so no redaction.
    raw_label = item.get("display_name") or item.get("account_label")
    normalized = _normalize_owner_account_label(raw_label)
    item["account_label"] = normalized
    item["display_name"] = normalized
    item["mcp_allowed_tools"] = _parse_json_string_list(item.pop("mcp_allowed_tools_json", None))
    item["mcp_args"] = _parse_json_string_list(item.pop("mcp_args_json", None))
    try:
        raw_env = json.loads(item.pop("mcp_env_json", None) or "{}")
        item["mcp_env"] = raw_env if isinstance(raw_env, dict) else {}
    except Exception:
        item["mcp_env"] = {}
    item["mcp_transport"] = item.get("mcp_transport") or "streamable_http"
    return ConnectionItem(**item)


def _normalize_mcp_connection_payload(payload: MCPConnectionCreateRequest) -> Dict[str, Any]:
    label = payload.label.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", label):
        raise HTTPException(
            status_code=400,
            detail="MCP label must be 1-64 letters, digits, underscores, or hyphens",
        )

    transport = payload.transport or "streamable_http"
    if transport not in {"streamable_http", "sse", "stdio"}:
        raise HTTPException(status_code=400, detail="MCP transport must be streamable_http, sse, or stdio")

    url = (payload.url or "").strip() or None
    command = (payload.command or "").strip() or None
    cwd = (payload.cwd or "").strip() or None
    if transport in {"streamable_http", "sse"}:
        if not url:
            raise HTTPException(status_code=400, detail="MCP URL is required for HTTP/SSE transports")
        if not url.startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail="MCP URL must start with http:// or https://")
        # SSRF deny-list: reject internal/loopback/link-local (incl. cloud
        # metadata 169.254.169.254) and RFC1918 targets at registration time.
        # Re-checked at dial time in the agent driver (DNS can rebind).
        try:
            url = assert_safe_outbound_mcp_url(url)
        except UnsafeMCPUrlError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if command:
            raise HTTPException(status_code=400, detail="MCP command is only valid for stdio transport")
    if transport == "stdio":
        if not command:
            raise HTTPException(status_code=400, detail="MCP command is required for stdio transport")
        if url:
            raise HTTPException(status_code=400, detail="MCP URL is not valid for stdio transport")

    auth_secret = (payload.auth_secret or "").strip() or None
    if auth_secret and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", auth_secret):
        raise HTTPException(status_code=400, detail="MCP auth secret must be a valid secret name")
    if auth_secret and transport == "stdio":
        raise HTTPException(status_code=400, detail="MCP auth secret is only valid for HTTP/SSE transports")

    allowed_tools = [tool.strip() for tool in payload.allowed_tools if tool and tool.strip()]
    if len(allowed_tools) != len(payload.allowed_tools):
        raise HTTPException(status_code=400, detail="MCP allowed tools must be non-empty")
    args = [str(arg).strip() for arg in payload.args if str(arg).strip()]
    env: Dict[str, str] = {}
    for key, raw in payload.env.items():
        name = str(key).strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise HTTPException(status_code=400, detail="MCP env keys must be valid environment variable names")
        value = str(raw).strip()
        if value:
            if not value.startswith("secret:"):
                raise HTTPException(
                    status_code=400,
                    detail="MCP env values must reference secrets as secret:SECRET_NAME",
                )
            secret_name = value.split(":", 1)[1]
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", secret_name):
                raise HTTPException(
                    status_code=400,
                    detail="MCP env secret references must use valid secret names",
                )
            env[name] = value

    return {
        "label": label,
        "transport": transport,
        "url": url,
        "command": command,
        "args": args,
        "env": env,
        "cwd": cwd,
        "auth_secret": auth_secret,
        "allowed_tools": allowed_tools,
    }


def _fetch_provider_email(toolkit_slug: str, composio_conn_id: str, user_id: str) -> Optional[str]:
    """Resolve the connected user's email via Composio's tool-execute proxy.

    Composio masks the raw OAuth access_token from `/connected_accounts/<id>`
    (returns only 8 chars), so we cannot call provider userinfo endpoints
    directly. Instead, we invoke a per-toolkit identity tool through Composio's
    /tools/execute proxy; Composio uses the real token server-side and returns
    just the response we asked for. Returns None on any error.

    Verified working for Gmail via GMAIL_GET_PROFILE -> response_data.emailAddress.
    Per-provider tool slug map below; extend as needed.
    """
    import requests as _requests
    PROVIDER_IDENTITY_TOOLS = {
        "gmail": ("GMAIL_GET_PROFILE", lambda d: d.get("emailAddress")),
        "googledrive": ("GOOGLEDRIVE_GET_ABOUT_USER", lambda d: ((d.get("user") or {}).get("emailAddress"))),
        "googlecalendar": ("GOOGLECALENDAR_GET_CURRENT_USER", lambda d: d.get("email")),
        "linkedin": ("LINKEDIN_GET_MY_INFO", lambda d: d.get("email")),
        "hubspot": ("HUBSPOT_GET_OWNER_BY_ID", lambda d: d.get("email")),
        "slack": ("SLACK_USERS_INFO", lambda d: ((d.get("user") or {}).get("profile") or {}).get("email")),
        "github": ("GITHUB_GET_THE_AUTHENTICATED_USER", lambda d: d.get("email") or d.get("login")),
    }
    spec = PROVIDER_IDENTITY_TOOLS.get(toolkit_slug)
    if not spec:
        return None
    tool_slug, extract = spec
    try:
        key = os.environ.get("COMPOSIO_API_KEY", "")
        if not key:
            return None
        r = _requests.post(
            f"https://backend.composio.dev/api/v3/tools/execute/{tool_slug}",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            json={"connected_account_id": composio_conn_id, "user_id": user_id, "arguments": {}},
            timeout=8,
        )
        if not r.ok:
            return None
        payload = r.json()
        if not payload.get("successful"):
            return None
        # Composio nests the tool output under either "response_data" or
        # "response_dict" depending on the tool implementation. Try both.
        outer = payload.get("data", {}) or {}
        data = (
            outer.get("response_data")
            or outer.get("response_dict")
            or outer
        )
        return extract(data) if isinstance(data, dict) else None
    except Exception as exc:
        logger.debug("provider email fetch failed for %s: %s", toolkit_slug, exc)
    return None


class _EmailPreviewItem(TypedDict):
    subject: str
    from_name: str
    from_email: str
    date: str


def _fetch_email_peek(toolkit_slug: str, composio_conn_id: str, user_id: str, *, max_results: int = 3) -> List[_EmailPreviewItem]:
    """Fetch recent email subjects/senders via Composio for trust-peek display.

    Only supports gmail for now. Returns [] on any error or unsupported provider.
    Response shapes vary by Composio tool version — handled defensively.
    """
    import requests as _requests
    if toolkit_slug != "gmail":
        return []
    key = os.environ.get("COMPOSIO_API_KEY", "")
    if not key:
        return []
    try:
        r = _requests.post(
            "https://backend.composio.dev/api/v3/tools/execute/GMAIL_FETCH_EMAILS",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            json={
                "connected_account_id": composio_conn_id,
                "user_id": user_id,
                "arguments": {"max_results": max_results, "include_spam_trash": False},
            },
            timeout=10,
        )
        if not r.ok:
            return []
        payload = r.json()
        if not payload.get("successful"):
            return []
        outer = payload.get("data") or {}
        if not isinstance(outer, dict):
            outer = {}
        data = (
            outer.get("response_data")
            or outer.get("response_dict")
            or outer
        )
        # Composio GMAIL_FETCH_EMAILS returns messages in different shapes:
        # {"messages": [{...}]} or directly a list, or {"emails": [{...}]}
        messages: List[Any] = []
        if isinstance(data, list):
            messages = data
        elif isinstance(data, dict):
            messages = data.get("messages") or data.get("emails") or []
        if not isinstance(messages, list):
            return []

        result: List[_EmailPreviewItem] = []
        for msg in messages[:max_results]:
            if not isinstance(msg, dict):
                continue
            # Extract subject — may be in "subject" or "payload.headers"
            subject = str(msg.get("subject") or msg.get("snippet") or "")
            if not subject:
                headers = msg.get("payload", {}).get("headers") or []
                for h in headers:
                    if isinstance(h, dict) and h.get("name", "").lower() == "subject":
                        subject = str(h.get("value") or "")
                        break
            # Extract sender
            sender_raw = str(msg.get("from") or msg.get("sender") or "")
            if not sender_raw:
                headers = msg.get("payload", {}).get("headers") or []
                for h in headers:
                    if isinstance(h, dict) and h.get("name", "").lower() == "from":
                        sender_raw = str(h.get("value") or "")
                        break
            # Parse "Name <email>" or bare email
            from_name, from_email = "", sender_raw
            if "<" in sender_raw and ">" in sender_raw:
                parts = sender_raw.split("<", 1)
                from_name = parts[0].strip().strip('"')
                from_email = parts[1].rstrip(">").strip()
            # Date
            date_str = str(msg.get("date") or msg.get("internalDate") or "")
            if date_str.isdigit():
                # internalDate is milliseconds since epoch
                try:
                    import datetime
                    dt = datetime.datetime.utcfromtimestamp(int(date_str) / 1000)
                    date_str = dt.isoformat() + "Z"
                except Exception:
                    pass
            if subject or from_email:
                result.append(_EmailPreviewItem(
                    subject=subject[:120],
                    from_name=from_name[:80],
                    from_email=from_email[:120],
                    date=date_str,
                ))
        return result
    except Exception as exc:
        logger.debug("email peek fetch failed for %s: %s", toolkit_slug, exc)
    return []


def _fetch_composio_account_info(composio_conn_id: str, *, user_id: str) -> Dict[str, Any]:
    """Fetch Composio connected-account and return normalized account info.

    Returns a dict with keys: email, scopes, user_id, auth_config_id.
    Returns empty dict on any error.
    """
    import requests as _requests
    base = "https://backend.composio.dev/api/v3"
    try:
        key = os.environ.get("COMPOSIO_API_KEY", "")
        if not key:
            return {}
        r = _requests.get(
            f"{base}/connected_accounts/{composio_conn_id}",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            timeout=10,
        )
        if not r.ok:
            return {}
        data = r.json()
        account = data.get("connected_account") or data
        if not isinstance(account, dict):
            return {}

        email = (
            account.get("email")
            or account.get("account_email")
            or (account.get("connection_data") or {}).get("email")
            or (account.get("data") or {}).get("email")
            or (account.get("metadata") or {}).get("email")
            or (account.get("user") or {}).get("email")
        )
        account_label = (
            email
            or account.get("handle")
            or account.get("username")
            or account.get("login")
            or (account.get("connection_data") or {}).get("handle")
            or (account.get("connection_data") or {}).get("username")
            or (account.get("data") or {}).get("handle")
            or (account.get("data") or {}).get("username")
            or (account.get("data") or {}).get("login")
            or (account.get("metadata") or {}).get("handle")
            or (account.get("metadata") or {}).get("username")
            or (account.get("metadata") or {}).get("login")
            or (account.get("user") or {}).get("login")
            or (account.get("user") or {}).get("name")
        )
        # Scopes: Composio v3 does NOT return a `scopes` list on the
        # connected_account. The real granted scopes live as a delimited
        # `scope` STRING under data/params/state.val (verified 2026-05-29):
        #   github -> "codespace,gist,repo,..."           (comma-delimited)
        #   google -> "https://.../auth/x https://.../y"  (space-delimited)
        # Parse whichever container is present and split on comma OR whitespace.
        scopes: List[str] = []
        raw_scopes = account.get("scopes")
        if isinstance(raw_scopes, list):
            scopes = [s for s in raw_scopes if isinstance(s, str) and s]
        if not scopes:
            scope_str = ""
            for container in (
                account.get("data"),
                account.get("params"),
                (account.get("state") or {}).get("val"),
            ):
                if isinstance(container, dict):
                    candidate = container.get("scope") or container.get("scopes")
                    if isinstance(candidate, str) and candidate.strip():
                        scope_str = candidate
                        break
                    if isinstance(candidate, list) and candidate:
                        scopes = [s for s in candidate if isinstance(s, str) and s]
                        break
            if scope_str and not scopes:
                scopes = [s for s in re.split(r"[,\s]+", scope_str.strip()) if s]
        # Fallback: Composio doesn't return email for managed-OAuth connections
        # and masks the raw access_token, so we cannot call provider userinfo
        # directly. Use Composio's /tools/execute proxy to invoke a per-provider
        # identity tool (e.g. GMAIL_GET_PROFILE) which runs server-side with the
        # real token and returns the email. Cached on the DB row by the caller.
        if not email:
            toolkit_slug = ((account.get("toolkit") or {}).get("slug") or "").lower()
            if toolkit_slug and composio_conn_id:
                email = _fetch_provider_email(toolkit_slug, composio_conn_id, user_id)
                account_label = email or account_label
        return {
            "email": email,
            "account_label": account_label,
            "scopes": scopes,
            "user_id": account.get("user_id") or account.get("userId"),
            "auth_config_id": (
                (account.get("auth_config") or {}).get("id")
                or account.get("auth_config_id")
            ),
            "status": (account.get("status") or "").lower() or None,
        }
    except Exception as exc:
        logger.warning("Composio account-info fetch failed for %s: %s", composio_conn_id, exc)
        return {}


@connections_router.get("/connections/tool-presets")
def list_connection_tool_presets(
    app: Optional[str] = None,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    """Curated read-only tool presets for the Tools-tab allowlist editor (C-B9).

    The UI's "Read-only" preset button calls this to fill a worker connection's
    ``allowed_tools`` with the curated read subset for the app. When ``app`` is
    given, returns the single preset (``tools: null`` when no curated preset
    exists, signalling the UI to fall back to the generic read_only scope).
    Without ``app``, returns every preset keyed by canonical app slug.
    """
    if app:
        return {"app": app, "tools": read_only_preset_for_app(app)}
    return {"presets": read_only_presets()}


def _connections_last_used(user_id: str, repos: Repositories) -> Dict[str, tuple[str, str]]:
    """#802: map connection slug -> (last_used_at, worker_name) from the most
    recent run of any worker declaring that connection. One pass over visible
    workers; O(workers) recent-run lookups."""
    last_used: Dict[str, tuple[str, str]] = {}
    try:
        for w in _list_visible_workers(user_id=user_id, repos=repos, use_cache=True):
            slugs = [s.lower() for s in _worker_connection_slugs(w)]
            if not slugs:
                continue
            recent = repos.runs.list_for_worker(user_id=user_id, worker_id=w["id"], limit=1, offset=0)
            if not recent:
                continue
            run = recent[0]
            ts = str(run.get("created_at") or "")
            if not ts:
                continue
            wname = str(w.get("name") or w["id"])
            for slug in slugs:
                prev = last_used.get(slug)
                if prev is None or ts > prev[0]:
                    last_used[slug] = (ts, wname)
    except Exception:
        logger.debug("connection last-used computation failed", exc_info=True)
    return last_used


@connections_router.get("/connections", response_model=List[ConnectionItem])
def list_connections(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[ConnectionItem]:
    rows = repos.connections.list(user_id=auth.user_id)
    now = datetime.now(timezone.utc)
    last_used = _connections_last_used(auth.user_id, repos)  # #802

    refreshed: List[Dict[str, Any]] = []
    for row in rows:
        d = row_to_dict(row)
        d = _refresh_connection_status_for_list(d, user_id=auth.user_id, repos=repos, now=now)
        d["scopes"] = _parse_scopes_json(d.pop("scopes_json", None))
        used = last_used.get(str(d.get("app_name") or "").lower())
        if used:
            d["last_used_at"], d["last_used_by"] = used
        refreshed.append(d)

    # Hide superseded dead rows: once an app has a live (active/valid) composio
    # connection, its leftover expired/initiated/pending/error siblings are dead
    # Composio sessions from earlier reconnects and only confuse the operator
    # ("reconnect did nothing — still Expired"). Suppress them. API-key rows and
    # apps with no live connection are always kept.
    def _is_live(status: object) -> bool:
        return str(status or "").lower() in ("active", "valid", "connected")

    live_apps = {
        d.get("app_name")
        for d in refreshed
        if (d.get("kind") or "composio") == "composio" and _is_live(d.get("status"))
    }
    result = []
    for d in refreshed:
        if (
            (d.get("kind") or "composio") == "composio"
            and d.get("app_name") in live_apps
            and not _is_live(d.get("status"))
        ):
            continue
        result.append(_public_connection_item(d))
    return result


@connections_router.get("/connections/by-app/{app_name}")
def get_connection_for_app(
    app_name: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return the live connection (if any) for ``app_name``.

    Powers the "Already connected as <email>" state on the connect screen so a
    user who re-clicks Connect on an app they already authorized is shown the
    existing account + a Reconnect option, instead of silently kicking off a
    fresh OAuth round-trip that would spawn a duplicate connected account.
    """
    slug = (app_name or "").lower().strip()
    if not slug:
        return {"connected": False}

    def _is_live(status: object) -> bool:
        return str(status or "").lower() in ("active", "valid", "connected")

    rows = repos.connections.list(user_id=auth.user_id)
    matches = [
        r
        for r in rows
        if (r.get("kind") or "composio") == "composio"
        and str(r.get("app_name") or "").lower() == slug
        and _is_live(r.get("status"))
    ]
    if not matches:
        return {"connected": False}

    accounts = [
        {
            "id": r["id"],
            "account_label": r.get("account_label") or None,
            "status": str(r.get("status") or "").lower(),
        }
        for r in matches
    ]
    return {
        "connected": True,
        "app_name": slug,
        "accounts": accounts,
    }


@connections_router.post("/connections", response_model=ConnectionInitResponse)
def initiate_connection(
    payload: ConnectionInitRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ConnectionInitResponse:
    from composio_client import initiate_connection as composio_initiate, NoManagedAuthError
    app_name = payload.app_name.lower().strip()
    if not app_name:
        raise HTTPException(status_code=400, detail="app_name is required")

    callback_url = _get_callback_url()
    try:
        result = composio_initiate(app_name, callback_url, user_id=auth.user_id)
    except NoManagedAuthError as exc:
        # App does not support Composio-managed OAuth (e.g. API-key-only apps).
        # Return 422 with a prefixed detail string so the frontend can detect it
        # and offer an "Add API key" flow instead.
        raise HTTPException(
            status_code=422,
            detail=f"api_key_only: {exc}",
        ) from exc
    except Exception as exc:
        logger.exception("Failed to initiate Composio connection for %s", app_name)
        _raise_composio_unavailable(exc)

    composio_conn_id = result["composio_connection_id"]
    redirect_url = result["redirect_url"]
    # Always insert a new row — multiple accounts per app are allowed.
    # Each Composio connected_account is a distinct row identified by its own UUID.
    # (Stale expired siblings are hidden from the UI by list_connections once an
    # active connection exists for the app — see the suppression there. We do NOT
    # reuse/replace rows here, which would break genuine multi-account support.)
    conn_id = str(_uuid_mod.uuid4())
    now = now_iso()
    repos.connections.upsert(
        user_id=auth.user_id,
        id=conn_id,
        app_name=app_name,
        composio_connection_id=composio_conn_id,
        status="initiated",
        created_at=now,
        updated_at=now,
    )

    return ConnectionInitResponse(
        id=conn_id,
        app_name=app_name,
        redirect_url=redirect_url,
        composio_connection_id=composio_conn_id,
    )


@connections_router.post("/connections/mcp", response_model=ConnectionItem)
def create_mcp_connection(
    payload: MCPConnectionCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ConnectionItem:
    normalized = _normalize_mcp_connection_payload(payload)
    label = normalized["label"]
    label_key = label.lower()
    for existing in repos.connections.list(user_id=auth.user_id):
        if (existing.get("kind") or "composio") != "mcp":
            continue
        if str(existing.get("mcp_label") or "").lower() == label_key:
            raise HTTPException(status_code=409, detail="MCP label already exists")

    conn_id = str(_uuid_mod.uuid4())
    now = now_iso()
    app_name = f"mcp:{label.lower()}"
    account_label = normalized["url"] or " ".join(
        [normalized["command"] or "", *normalized["args"]]
    ).strip()
    row = repos.connections.upsert(
        user_id=auth.user_id,
        id=conn_id,
        app_name=app_name,
        composio_connection_id=f"mcp:{conn_id}",
        status="active",
        created_at=now,
        updated_at=now,
        kind="mcp",
        account_label=account_label,
        mcp_label=label,
        mcp_url=normalized["url"],
        mcp_transport=normalized["transport"],
        mcp_command=normalized["command"],
        mcp_args_json=normalized["args"],
        mcp_env_json=normalized["env"],
        mcp_cwd=normalized["cwd"],
        mcp_auth_secret=normalized["auth_secret"],
        mcp_allowed_tools_json=normalized["allowed_tools"],
    )
    item = row_to_dict(row)
    item["scopes"] = _parse_scopes_json(item.pop("scopes_json", None))
    return _public_connection_item(item)


@connections_router.get("/connections/callback")
def connections_callback(request: Request, connection_id: str = "", status: str = ""):
    """OAuth callback landing — Composio redirects here after user authorizes.

    Composio sends: ?connection_id=<composio_conn_id>&status=<status>
    We update the local DB and redirect the user to /connections.
    """
    from fastapi.responses import RedirectResponse

    frontend_url = os.environ.get("WORKERS_FRONTEND_URL", "http://localhost:3000")
    # The floom UUID of the row the user should land on / see highlighted, plus
    # the app slug, are forwarded to the connections page for post-connect
    # feedback ("Connected <App> as <email>"). Filled in below once known.
    landing_id = ""
    landing_app = ""

    callback_connection_id = (
        connection_id
        or request.query_params.get("connected_account_id", "")
        or request.query_params.get("connectedAccountId", "")
        or request.query_params.get("connectionId", "")
        or request.query_params.get("id", "")
    )

    if callback_connection_id:
        repos = get_repositories()
        existing = repos.connections.get_by_composio_connection_id(
            composio_connection_id=callback_connection_id,
        )

        # F2 (2026-06-03) — connection-existence timing oracle: ACCEPTED.
        #
        # The lookup above is an indexed, parameterized SQL equality (`= ?`), not
        # a per-character string comparison, so there is NO classic
        # non-constant-time secret-compare oracle here. The only observable
        # difference between a known and an unknown connection_id is control
        # flow: a KNOWN id triggers a downstream Composio `check_status` network
        # round-trip + DB writes (slow), while an UNKNOWN id returns immediately
        # (fast). The RESPONSE is identical in both cases (the same
        # `?connected=1` redirect below), so only a coarse timing signal remains.
        #
        # We accept this residual timing oracle rather than forcing constant time
        # because:
        #   1. The id space is unguessable — Composio connection ids are random
        #      high-entropy `ca_*` handles, so an attacker cannot meaningfully
        #      enumerate them via timing.
        #   2. This is an intentionally UNAUTHENTICATED OAuth-callback landing
        #      (Composio redirects the browser here); padding it to constant time
        #      would mean either always doing the slow remote call (a DoS amp /
        #      SSRF-ish lever for unauth callers) or never doing it (breaking the
        #      legitimate post-OAuth status refresh). Both are worse than the
        #      low-value timing leak they would close.
        # If the id space ever becomes guessable, revisit and pad the hit path.
        #
        # Ignore unknown callback IDs; known IDs are validated by persisted state.
        if not existing:
            return RedirectResponse(url=f"{frontend_url}/connections?connected=1")

        landing_id = existing["id"]
        landing_app = existing.get("app_name") or ""

        # Try to refresh from Composio first
        try:
            from composio_client import check_status
            remote_status = _normalize_composio_connection_status(check_status(callback_connection_id))
        except Exception:
            remote_status = ""

        callback_status = _normalize_composio_connection_status(status)
        final_status = (
            "active"
            if callback_status == "active" and remote_status in ("", "initiated", "pending", "unknown", "not_found")
            else remote_status
            if remote_status and remote_status != "not_found"
            else callback_status
            if callback_status
            else existing["status"]
        )
        now = now_iso()
        repos.connections.update(
            user_id=existing["user_id"],
            composio_id=existing["id"],
            status=final_status,
            composio_connection_id=callback_connection_id,
            updated_at=now,
        )

        # N5-1 dedupe: now that the OAuth round-trip is complete we can learn the
        # real account identity (e.g. the Gmail address) from Composio. If the
        # user just re-authorized an app+account they had ALREADY connected, an
        # older canonical row for the same (user, app, account_label) exists.
        # Merge into it — repoint that row at the fresh composio_connection_id
        # and refresh its status — then delete THIS freshly-created reconnect
        # row, so the (app, account) pair always collapses to a single row.
        landing_id, landing_app = _dedupe_connection_account(
            repos=repos,
            row=existing,
            connection_id=callback_connection_id,
            final_status=final_status,
            now=now,
        )

    redirect_qs = "connected=1"
    if landing_app:
        redirect_qs += f"&app={urllib.parse.quote(landing_app)}"
    if landing_id:
        redirect_qs += f"&connection_id={urllib.parse.quote(landing_id)}"
    return RedirectResponse(url=f"{frontend_url}/connections?{redirect_qs}")


def _dedupe_connection_account(
    *,
    repos: Any,
    row: Dict[str, Any],
    connection_id: str,
    final_status: str,
    now: str,
) -> tuple[str, str]:
    """Collapse a reconnect into the canonical (user, app, account) row.

    Returns ``(landing_floom_id, app_name)`` — the floom UUID the connections
    page should highlight (the surviving canonical row) and its app slug. On any
    failure it degrades gracefully to the row that was passed in.
    """
    user_id = row["user_id"]
    app_name = row.get("app_name") or ""
    new_id = row["id"]
    landing_id = new_id
    try:
        info = _fetch_composio_account_info(connection_id, user_id=user_id)
        account_label = _account_label_from_info(info)
        if not account_label:
            return landing_id, app_name

        # Cache the freshly learned identity on this row regardless of merge.
        repos.connections.update(
            user_id=user_id,
            composio_id=new_id,
            account_label=account_label,
            scopes_json=info.get("scopes") or [],
            updated_at=now,
        )

        canonical = repos.connections.find_by_app_account(
            user_id=user_id,
            app_name=app_name,
            account_label=account_label,
            exclude_id=new_id,
        )
        if not canonical:
            # First time this (app, account) is seen — the new row IS canonical.
            return new_id, app_name

        # Re-point the older canonical row at the new live Composio account and
        # refresh its status + scopes, then drop the duplicate just created.
        repos.connections.update(
            user_id=user_id,
            composio_id=canonical["id"],
            composio_connection_id=connection_id,
            status=final_status,
            account_label=account_label,
            scopes_json=info.get("scopes") or [],
            updated_at=now,
        )
        repos.connections.delete(user_id=user_id, composio_id=new_id)
        landing_id = canonical["id"]
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Connection dedupe failed for %s: %s", connection_id, exc)
    return landing_id, app_name


@connections_router.get(
    "/webhooks/oauth-callback",
    summary="OAuth callback alias",
    description=(
        "Alias for /connections/callback for cleaner webhook namespace. "
        "The existing /connections/callback route remains the primary callback URL."
    ),
)
def connections_callback_alias(request: Request, connection_id: str = "", status: str = ""):
    return connections_callback(request=request, connection_id=connection_id, status=status)


@connections_router.get("/connections/{connection_id}/status", response_model=ConnectionItem)
def get_connection_status(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ConnectionItem:
    user_id = auth.user_id
    row = _connection_row_for_user(
        connection_id,
        user_id,
        "id, app_name, composio_connection_id, status, created_at, updated_at, "
        "scopes_json, account_label, last_checked_at, last_check_status",
        repos=repos,
    )

    item = row_to_dict(row)
    item["scopes"] = _parse_scopes_json(item.pop("scopes_json", None))

    if (item.get("kind") or "composio") != "composio":
        return _public_connection_item(item)

    # Refresh from Composio
    now = now_iso()
    updated_row: Optional[Dict[str, Any]] = None
    try:
        from composio_client import check_status
        remote_status = _normalize_composio_connection_status(
            check_status(item["composio_connection_id"])
        )
        if remote_status and remote_status != "not_found" and remote_status != item["status"]:
            updated_row = repos.connections.update(
                user_id=user_id,
                composio_id=connection_id,
                status=remote_status,
                updated_at=now,
            )
    except Exception as exc:
        logger.warning("Could not refresh Composio status for %s: %s", connection_id, exc)

    _cache_connection_account_info(
        repos=repos,
        user_id=user_id,
        connection_id=connection_id,
        composio_connection_id=item["composio_connection_id"],
        now=now,
    )
    updated_row = repos.connections.get(user_id=user_id, composio_id=connection_id) or updated_row
    if updated_row:
        item = row_to_dict(updated_row)
        item["scopes"] = _parse_scopes_json(item.pop("scopes_json", None))

    return _public_connection_item(item)


@connections_router.delete("/connections/{connection_id}")
def delete_connection(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    user_id = auth.user_id
    row = _connection_row_for_user(connection_id, user_id, "composio_connection_id, kind", repos=repos)

    composio_conn_id = row["composio_connection_id"]

    # Attempt to revoke from Composio (best-effort)
    if (row.get("kind") or "composio") == "composio":
        try:
            from composio_client import revoke_connection
            revoke_connection(composio_conn_id)
        except Exception as exc:
            logger.warning("Could not revoke Composio connection %s: %s", composio_conn_id, exc)

    repos.connections.delete(user_id=user_id, composio_id=connection_id)

    return {"status": "deleted"}


@connections_router.get("/connections/{connection_id}/activity", response_model=List[RunSummary])
def get_connection_activity(
    connection_id: str,
    limit: int = 50,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[RunSummary]:
    """Return recent runs for all workers that declare this connection."""
    user_id = auth.user_id
    conn_row = _connection_row_for_user(connection_id, user_id, "id, app_name", repos=repos)
    conn_slug = (row_to_dict(conn_row).get("app_name") or "").lower().strip()

    # Find all workers owned by this user that declare this connection slug.
    all_workers = _list_visible_workers(user_id=user_id, repos=repos, use_cache=True, role=auth.role)
    matching_worker_ids = [
        w["id"]
        for w in all_workers
        if conn_slug and conn_slug in [s.lower() for s in _worker_connection_slugs(w)]
    ]

    if not matching_worker_ids:
        return []

    # Collect recent runs across all matching workers.
    per_worker = max(1, limit // max(1, len(matching_worker_ids)))
    runs: List[Dict[str, Any]] = []
    for wid in matching_worker_ids:
        runs.extend(repos.runs.list_recent_runs(user_id=user_id, worker_id=wid, limit=per_worker))

    runs.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    runs = runs[:limit]

    return [
        RunSummary(
            id=r["id"],
            worker_id=r["worker_id"],
            status=RunStatus(r["status"]),
            trigger_source=r.get("trigger_source") or "manual",
            created_at=r.get("created_at"),
            started_at=r.get("started_at"),
            completed_at=r.get("completed_at"),
            duration_ms=r.get("duration_ms"),
            error=_operator_error_message(r.get("error"), r.get("error_code")),
            error_code=r.get("error_code"),
        )
        for r in runs
    ]


@connections_router.get("/connections/{connection_id}/account-info")
def get_connection_account_info(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Return Composio connected-account info needed by the UI.

    The frontend calls this to hydrate connection cards. The Composio API key
    lives here on the API service so it never needs to be on Vercel.
    """
    row = _connection_row_for_user(
        connection_id,
        auth.user_id,
        "composio_connection_id, created_at",
        repos=repos,
    )

    if not os.environ.get("COMPOSIO_API_KEY", "").strip():
        raise HTTPException(
            status_code=503,
            detail="Composio is not configured on this server. Set COMPOSIO_API_KEY to enable connections.",
        )
    composio_conn_id = row["composio_connection_id"]
    info = _fetch_composio_account_info(composio_conn_id, user_id=auth.user_id)
    if not info:
        raise HTTPException(status_code=503, detail="Unable to fetch account info from upstream")

    # Cache scopes + account_label in DB for the list endpoint.
    account_label = _account_label_from_info(info)
    if info.get("scopes") is not None or account_label:
        now = now_iso()
        repos.connections.update(
            user_id=auth.user_id,
            composio_id=connection_id,
            scopes_json=info.get("scopes") or [],
            account_label=account_label,
            updated_at=now,
        )

    # Single-tenant owner view: return the owner's own account identity so the
    # UI can render the real GitHub login / Google email instead of a placeholder.
    return {
        "email": account_label or None,
        "scopes": info.get("scopes") or [],
        "connected_at": row["created_at"],
    }


class _ConnectionPeekResponse(BaseModel):
    emails: List[Dict[str, str]] = Field(default_factory=list)


@connections_router.get("/connections/{connection_id}/peek", response_model=_ConnectionPeekResponse)
def get_connection_peek(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _ConnectionPeekResponse:
    """Return a privacy-conscious email preview for trust-peek on connection detail.

    Only returns data for active gmail connections. Returns empty emails list for
    other providers, MCP connections, or if Composio is unconfigured. Never errors
    so the UI can call it best-effort.
    """
    try:
        row = _connection_row_for_user(
            connection_id,
            auth.user_id,
            "composio_connection_id, app_name, status",
            repos=repos,
        )
    except HTTPException:
        return _ConnectionPeekResponse(emails=[])
    if row.get("status") != "active":
        return _ConnectionPeekResponse(emails=[])
    toolkit_slug = (row.get("app_name") or "").lower()
    composio_conn_id = row.get("composio_connection_id") or ""
    if not composio_conn_id:
        return _ConnectionPeekResponse(emails=[])
    items = _fetch_email_peek(toolkit_slug, composio_conn_id, auth.user_id, max_results=3)
    return _ConnectionPeekResponse(
        emails=[{"subject": i["subject"], "from_name": i["from_name"], "from_email": i["from_email"], "date": i["date"]} for i in items]
    )


@connections_router.get("/connections/auth-configs/{auth_config_id}", dependencies=[Depends(get_auth_context)])
def get_auth_config(auth_config_id: str) -> Dict[str, Any]:
    """Return Composio auth_config (scopes definition) for a given auth_config_id.

    Proxies to Composio so the key stays on the API service, not on Vercel.
    """
    if os.environ.get("WORKEROS_ENABLE_INTERNAL_AUTH_CONFIGS") != "1":
        raise HTTPException(status_code=404, detail="Not found")

    import requests as _requests

    key = os.environ.get("COMPOSIO_API_KEY", "")
    if not key:
        raise HTTPException(status_code=503, detail="Composio API key not configured")

    base = "https://backend.composio.dev/api/v3"

    try:
        r = _requests.get(
            f"{base}/auth_configs/{auth_config_id}",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            timeout=10,
        )
        if r.ok:
            body = r.json()
            scopes = _extract_auth_config_scopes(body)
            config_id = (
                (body.get("auth_config") or {}).get("id")
                or body.get("id")
                or auth_config_id
            )
            return {"id": config_id, "scopes": scopes}

        if r.status_code in {401, 403}:
            raise HTTPException(status_code=r.status_code, detail="Authentication failed")
        if r.status_code == 429:
            raise HTTPException(status_code=429, detail="Rate limited")
        if r.status_code >= 500:
            raise HTTPException(status_code=502, detail="Upstream error")

        # Fall back: search by toolkit slug
        listed = _requests.get(
            f"{base}/auth_configs",
            headers={"x-api-key": key, "Content-Type": "application/json"},
            params={"toolkit_slugs": auth_config_id, "limit": 20},
            timeout=10,
        )
        if listed.ok:
            items = (listed.json().get("items") or [])
            item = next(
                (ac for ac in items if (ac.get("status") or "ENABLED").upper() == "ENABLED"),
                items[0] if items else None,
            )
            if item:
                scopes = _extract_auth_config_scopes(item)
                return {
                    "id": item.get("id") or auth_config_id,
                    "scopes": scopes,
                }
        return {"id": auth_config_id, "scopes": []}
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Auth config fetch failed for %s: %s", auth_config_id, exc)
        return {"id": auth_config_id, "scopes": []}


def _extract_auth_config_scopes(body: Any) -> List[str]:
    """Extract scopes from various Composio auth_config response shapes."""
    if not isinstance(body, dict):
        return []
    candidates = [
        body,
        body.get("auth_config") or {},
        (body.get("auth_config") or {}).get("auth_scheme") or {},
        body.get("auth_scheme") or {},
        body.get("config") or {},
        body.get("oauth") or {},
    ]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        for key in ("scopes", "oauth_scopes", "requested_scopes", "default_scopes"):
            val = candidate.get(key)
            if isinstance(val, list) and val:
                return [s for s in val if isinstance(s, str)]
        scope = candidate.get("scope")
        if isinstance(scope, str) and scope:
            return [s for s in scope.split() if s]
    return []


@connections_router.post("/connections/{connection_id}/test", response_model=ConnectionTestResult)
def test_connection(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ConnectionTestResult:
    """Test whether a connection's token is still valid by calling Composio."""
    row = _connection_row_for_user(
        connection_id,
        auth.user_id,
        "composio_connection_id, kind, mcp_transport, mcp_allowed_tools_json, mcp_url, mcp_auth_secret",
        repos=repos,
    )

    composio_conn_id = row["composio_connection_id"]
    tested_at = now_iso()

    if (row.get("kind") or "composio") != "composio":
        # #599: actually test MCP connections by attempting to initialize the
        # server and enumerate its tools. Previously returned "valid" immediately
        # without contacting the server, so agents couldn't validate credentials
        # or URL before wiring a connection into a worker.
        mcp_url = row.get("mcp_url") or row.get("url") or row.get("server_url") or ""
        mcp_token = row.get("mcp_auth_secret") or row.get("api_key") or row.get("token") or ""
        mcp_transport = str(row.get("mcp_transport") or "streamable_http").lower()
        allowed_tools = set(_parse_json_string_list(row.get("mcp_allowed_tools_json")))
        if mcp_url:
            try:
                import httpx as _httpx
                headers = {}
                if mcp_token:
                    headers["Authorization"] = f"Bearer {mcp_token}"
                # Streamable-HTTP MCP servers (spec 2025-03-26) reject probes
                # without this Accept header (HTTP 406) and may frame their
                # JSON-RPC responses as SSE.
                headers["accept"] = "application/json, text/event-stream"

                def _parse_mcp_response(resp) -> dict:
                    ctype = (resp.headers.get("content-type") or "").lower()
                    if "text/event-stream" in ctype:
                        for line in resp.text.splitlines():
                            line = line.strip()
                            if line.startswith("data:"):
                                try:
                                    parsed = json.loads(line[5:].strip())
                                except Exception:
                                    continue
                                if isinstance(parsed, dict):
                                    return parsed
                        return {}
                    try:
                        body = resp.json()
                    except Exception:
                        return {}
                    return body if isinstance(body, dict) else {}

                # #1293: pin the resolved IP at dial time to prevent DNS-rebind
                # TOCTOU between the SSRF check and the actual HTTP connection.
                # Resolve once, validate the IP is safe, then connect to the IP
                # literal directly (passing the original Host header for TLS SNI
                # / vhost routing).
                try:
                    mcp_url, _pinned_url = pin_safe_outbound_url(mcp_url, label="MCP server URL")
                except Exception as _ssrf_exc:
                    _write_connection_check(
                        connection_id,
                        "failed",
                        str(_ssrf_exc),
                        tested_at,
                        status="failed",
                        repos=repos,
                    )
                    return ConnectionTestResult(
                        status="failed",
                        reason=f"Connection URL is not permitted: {_ssrf_exc}",
                        tested_at=tested_at,
                    )
                # Use the IP-pinned URL for dial; preserve the original Host header
                # so TLS SNI and vhost routing work correctly.
                from urllib.parse import urlsplit as _urlsplit
                _orig_host = _urlsplit(mcp_url).hostname or ""
                if _orig_host:
                    headers.setdefault("Host", _orig_host)
                probe_url = _pinned_url.rstrip("/")
                init_payload = {
                    "jsonrpc": "2.0",
                    "method": "initialize",
                    "id": 1,
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "workeros", "version": "1.0"},
                    },
                }
                tools_payload = {"jsonrpc": "2.0", "method": "tools/list", "id": 2, "params": {}}

                init_resp = _httpx.post(probe_url, json=init_payload, headers=headers, timeout=8.0)
                if init_resp.status_code not in (200, 201):
                    if init_resp.status_code in (401, 403):
                        reason = (
                            f"MCP server reachable but authentication failed (HTTP {init_resp.status_code}). "
                            "Check your API key / token."
                        )
                    elif init_resp.status_code == 404:
                        reason = "MCP server returned 404. Verify the server URL is correct."
                    else:
                        reason = f"MCP server returned HTTP {init_resp.status_code}."
                    _write_connection_check(
                        connection_id,
                        "failed",
                        f"HTTP {init_resp.status_code}",
                        tested_at,
                        status="failed",
                        repos=repos,
                    )
                    return ConnectionTestResult(status="failed", reason=reason, tested_at=tested_at)

                # Streamable-HTTP sessions: echo the server-assigned session id
                # on follow-up requests, or compliant servers reject tools/list.
                init_session_id = init_resp.headers.get("mcp-session-id")
                if init_session_id:
                    headers["mcp-session-id"] = init_session_id

                tools_resp = _httpx.post(probe_url, json=tools_payload, headers=headers, timeout=8.0)
                tools = None
                if tools_resp.status_code in (200, 201):
                    body = _parse_mcp_response(tools_resp)
                    tools = body.get("tools")
                    if tools is None and isinstance(body.get("result"), dict):
                        tools = body["result"].get("tools")
                    if tools is None and isinstance(body.get("result"), dict):
                        tools = body["result"].get("capabilities", {}).get("tools")
                elif tools_resp.status_code in (401, 403):
                    reason = (
                        f"MCP server reachable but authentication failed (HTTP {tools_resp.status_code}). "
                        "Check your API key / token."
                    )
                    _write_connection_check(
                        connection_id,
                        "failed",
                        f"HTTP {tools_resp.status_code}",
                        tested_at,
                        status="failed",
                        repos=repos,
                    )
                    return ConnectionTestResult(status="failed", reason=reason, tested_at=tested_at)
                elif tools_resp.status_code == 404 and mcp_transport in {"streamable_http", "sse"}:
                    legacy_resp = _httpx.get(f"{probe_url}/tools/list", headers=headers, timeout=8.0)
                    if legacy_resp.status_code in (200, 201):
                        body = legacy_resp.json()
                        tools = body.get("tools") if isinstance(body, dict) else None
                    else:
                        if legacy_resp.status_code in (401, 403):
                            reason = (
                                f"MCP server reachable but authentication failed (HTTP {legacy_resp.status_code}). "
                                "Check your API key / token."
                            )
                        elif legacy_resp.status_code == 404:
                            reason = "MCP server returned 404. Verify the server URL is correct."
                        else:
                            reason = f"MCP server returned HTTP {legacy_resp.status_code}."
                        _write_connection_check(
                            connection_id,
                            "failed",
                            f"HTTP {legacy_resp.status_code}",
                            tested_at,
                            status="failed",
                            repos=repos,
                        )
                        return ConnectionTestResult(status="failed", reason=reason, tested_at=tested_at)
                else:
                    reason = f"MCP server returned HTTP {tools_resp.status_code}."
                    _write_connection_check(
                        connection_id,
                        "failed",
                        f"HTTP {tools_resp.status_code}",
                        tested_at,
                        status="failed",
                        repos=repos,
                    )
                    return ConnectionTestResult(status="failed", reason=reason, tested_at=tested_at)

                tool_names = sorted({
                    str(tool.get("name"))
                    for tool in (tools or [])
                    if isinstance(tool, dict) and isinstance(tool.get("name"), str) and tool.get("name")
                })
                tool_count = len(tool_names)
                missing_allowed = sorted(name for name in allowed_tools if name not in tool_names)
                if missing_allowed:
                    reason = (
                        f"MCP server reachable — {tool_count} tools. "
                        f"Allowed-tool mismatch: missing {', '.join(missing_allowed)}."
                    )
                    _write_connection_check(
                        connection_id,
                        "failed",
                        f"tool mismatch: {', '.join(missing_allowed)}",
                        tested_at,
                        status="failed",
                        repos=repos,
                    )
                    return ConnectionTestResult(status="failed", reason=reason, tested_at=tested_at)

                _write_connection_check(connection_id, "valid", None, tested_at, status="active", repos=repos)
                extra_tools = f" — {tool_count} tools" if tool_count is not None else ""
                allowed_tools_note = f" (allowlist: {len(allowed_tools)} tools)" if allowed_tools else ""
                return ConnectionTestResult(
                    status="valid",
                    reason=f"MCP server reachable{extra_tools}{allowed_tools_note}.",
                    tested_at=tested_at,
                    tools=tool_names,  # #789: live tool list
                )
            except Exception as exc:
                _write_connection_check(connection_id, "failed", str(exc), tested_at, status="failed", repos=repos)
                return ConnectionTestResult(
                    status="failed",
                    reason=f"Could not reach MCP server: {exc}",
                    tested_at=tested_at,
                )
        # No URL stored — connection is saved but untestable without a URL
        _write_connection_check(connection_id, "valid", None, tested_at, status="active", repos=repos)
        return ConnectionTestResult(
            status="valid",
            reason="MCP connection saved. Add a server URL to enable live testing.",
            tested_at=tested_at,
        )

    try:
        from composio_client import check_status
        remote_status = _normalize_composio_connection_status(check_status(composio_conn_id))
    except Exception as exc:
        _write_connection_check(connection_id, "failed", str(exc), tested_at, status="failed", repos=repos)
        return ConnectionTestResult(
            status="failed",
            reason=f"Upstream check failed: {exc}",
            tested_at=tested_at,
        )

    if remote_status == "not_found":
        _write_connection_check(
            connection_id,
            "failed",
            "Connection not found in upstream",
            tested_at,
            status="failed",
            repos=repos,
        )
        return ConnectionTestResult(
            status="failed",
            reason="Connection not found in the integration service",
            tested_at=tested_at,
        )
    if remote_status in ("expired", "failed"):
        _write_connection_check(
            connection_id,
            remote_status,
            f"Status: {remote_status}",
            tested_at,
            status=remote_status,
            repos=repos,
        )
        return ConnectionTestResult(
            status=remote_status,
            reason=f"Connection status is {remote_status}",
            tested_at=tested_at,
        )
    if remote_status == "active":
        _write_connection_check(connection_id, "valid", None, tested_at, status="active", repos=repos)
        _cache_connection_account_info(
            repos=repos,
            user_id=auth.user_id,
            connection_id=connection_id,
            composio_connection_id=composio_conn_id,
            now=tested_at,
        )
        return ConnectionTestResult(
            status="valid",
            reason="Connection is active",
            tested_at=tested_at,
        )

    # Unknown status: treat as valid but note it
    _write_connection_check(
        connection_id,
        "valid",
        f"Status: {remote_status}",
        tested_at,
        status="active",
        repos=repos,
    )
    _cache_connection_account_info(
        repos=repos,
        user_id=auth.user_id,
        connection_id=connection_id,
        composio_connection_id=composio_conn_id,
        now=tested_at,
    )
    return ConnectionTestResult(
        status="valid",
        reason=f"Connection status: {remote_status}",
        tested_at=tested_at,
    )


def _connection_by_id(
    connection_id: str,
    repos: Repositories | None = None,
) -> Optional[Dict[str, Any]]:
    rows = (repos or get_repositories()).connections.list_all()
    return next((row_to_dict(row) for row in rows if row["id"] == connection_id), None)


def _write_connection_check(
    connection_id: str,
    check_status: str,
    error: Optional[str],
    checked_at: str,
    *,
    status: Optional[str] = None,
    repos: Repositories | None = None,
) -> None:
    """Persist health-check result to the DB row."""
    repos_obj = repos or get_repositories()
    row = _connection_by_id(connection_id, repos_obj)
    if row is None:
        return
    updates: Dict[str, Any] = {
        "last_checked_at": checked_at,
        "last_check_status": check_status,
        "last_check_error": error,
        "updated_at": checked_at,
    }
    if status:
        updates["status"] = status
    repos_obj.connections.update(user_id=row["user_id"], composio_id=connection_id, **updates)


async def _run_connection_sweep(*, user_id: str | None = None) -> None:
    """Background task: test every connection and update last_checked_at columns."""
    logger.info("Connection health sweep starting")
    repos = get_repositories()
    rows = repos.connections.list(user_id=user_id) if user_id else repos.connections.list_all()

    for row in rows:
        if (row.get("kind") or "composio") != "composio":
            logger.debug("Skipped MCP connection %s during Composio sweep", row["id"])
            continue
        conn_id = row["id"]
        composio_conn_id = row["composio_connection_id"]
        tested_at = now_iso()
        try:
            from composio_client import check_status
            remote_status = _normalize_composio_connection_status(
                check_status(composio_conn_id)
            )
            check = "valid" if remote_status == "active" else (
                remote_status if remote_status in ("expired", "failed") else "valid"
            )
            error = None if remote_status == "active" else f"Status: {remote_status}"
        except Exception as exc:
            check = "failed"
            error = str(exc)
        _write_connection_check(conn_id, check, error, tested_at, repos=repos)
        # Also refresh account_label + scopes for ACTIVE connections so the
        # user sees their actual email rather than the hardcoded "federico"
        # user_id. _fetch_composio_account_info uses Composio's tool-execute
        # proxy to get the real email via GMAIL_GET_PROFILE etc.
        if check == "valid":
            try:
                info = _fetch_composio_account_info(composio_conn_id, user_id=row["user_id"])
                email_or_user = info.get("email") or info.get("user_id") or ""
                scopes = info.get("scopes") or []
                update_kwargs: Dict[str, Any] = {}
                if email_or_user:
                    update_kwargs["account_label"] = email_or_user
                if scopes:
                    update_kwargs["scopes_json"] = scopes
                if update_kwargs:
                    repos.connections.update(
                        user_id=row["user_id"],
                        composio_id=conn_id,
                        updated_at=tested_at,
                        **update_kwargs,
                    )
            except Exception as exc:
                logger.debug("account_label/scopes refresh failed for %s: %s", conn_id, exc)
        logger.debug("Swept connection %s: %s", conn_id, check)
        await asyncio.sleep(0.5)  # Rate-limit Composio calls

    logger.info("Connection health sweep complete (%d connections)", len(rows))


_connection_sweep_gate_lock = threading.Lock()
@connections_router.get("/connections/{connection_id}/tools")
def get_connection_tools(
    connection_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """#789: live tool list advertised by an MCP connection's server.

    Dials the server (reusing the test path) and returns the live tools/list,
    distinct from the operator-configured mcp_allowed_tools allowlist. Returns
    503 when the server is unreachable so the UI degrades gracefully.
    """
    result = test_connection(connection_id, auth=auth, repos=repos)
    if result.status != "valid" or result.tools is None:
        raise HTTPException(status_code=503, detail=result.reason or "MCP server unreachable")
    return {"tools": result.tools}


_connection_sweep_last_started_at_by_user: Dict[str, float] = {}


def _connection_sweep_cooldown_seconds() -> float:
    try:
        return max(0.0, float(os.environ.get("WORKEROS_SWEEP_COOLDOWN_SECONDS", "300")))
    except ValueError:
        return 300.0


@connections_router.post("/system/sweep-connections")
async def sweep_connections_endpoint(
    auth: AuthContext = Depends(get_auth_context),
):
    """Trigger a health-check sweep for all connections. Called by external cron."""
    now = time.monotonic()
    cooldown = _connection_sweep_cooldown_seconds()
    user_key = auth.user_id or "anonymous"
    with _connection_sweep_gate_lock:
        last_started_at = _connection_sweep_last_started_at_by_user.get(user_key, 0.0)
        elapsed = now - last_started_at
        if cooldown > 0 and last_started_at and elapsed < cooldown:
            retry_after = max(1, int(cooldown - elapsed))
            raise HTTPException(
                status_code=429,
                detail="Connection sweep already started recently",
                headers={"Retry-After": str(retry_after)},
            )
        _connection_sweep_last_started_at_by_user[user_key] = now
    asyncio.create_task(_run_connection_sweep(user_id=auth.user_id))
    return {"status": "sweep_started"}
