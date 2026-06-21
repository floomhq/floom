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
import base64
import copy
import hashlib
import hmac
import json
import logging
import os
import re
import secrets as pysecrets
import threading
import time
import urllib.parse
import uuid as _uuid_mod
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any, Dict, List, Literal, Optional, TypedDict

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import AuthContext, get_auth_context
from auth.multi_member import SESSION_COOKIE
from core import hot_cache
from core.utils import _parse_iso8601, row_to_dict
from db import Repositories, get_repos, get_repositories, now_iso
from models import (
    RunStatus,
    RunSummary,
    UnsafeMCPUrlError,
    assert_safe_outbound_mcp_url,
    pinned_safe_outbound_httpx_target,
    read_only_preset_for_app,
    read_only_presets,
)
from services.composio import _raise_composio_unavailable
from services.public_view import _operator_error_message
from services.worker_access import _list_visible_workers, _worker_connection_slugs

logger = logging.getLogger("floom.api")

connections_router = APIRouter()
_CONNECTION_LIST_CACHE_TTL_SECONDS = 10.0
_connection_list_cache_lock = threading.Lock()
_connection_list_cache: Dict[str, tuple[float, List["ConnectionItem"]]] = {}
_OAUTH_STATE_FALLBACK_SECRET = pysecrets.token_urlsafe(32)


def _connection_list_cache_get(user_id: str) -> List["ConnectionItem"] | None:
    now = time.monotonic()
    with _connection_list_cache_lock:
        item = _connection_list_cache.get(user_id)
        if item is None:
            return None
        expires_at, value = item
        if expires_at <= now:
            _connection_list_cache.pop(user_id, None)
            return None
        return copy.deepcopy(value)


def _connection_list_cache_set(user_id: str, value: List["ConnectionItem"]) -> None:
    now = time.monotonic()
    with _connection_list_cache_lock:
        if len(_connection_list_cache) >= 256:
            for key, (expires_at, _) in list(_connection_list_cache.items()):
                if expires_at <= now:
                    _connection_list_cache.pop(key, None)
            if len(_connection_list_cache) >= 256:
                _connection_list_cache.pop(next(iter(_connection_list_cache)))
        _connection_list_cache[user_id] = (
            now + _CONNECTION_LIST_CACHE_TTL_SECONDS,
            copy.deepcopy(value),
        )


def _connection_list_cache_clear(user_id: str | None = None) -> None:
    with _connection_list_cache_lock:
        if user_id:
            _connection_list_cache.pop(user_id, None)
        else:
            _connection_list_cache.clear()


def _invalidate_connections_cache(user_id: str) -> None:
    """Drop every connections-list cache entry for this user after a mutation.

    Reconcile note (perf/backend-endpoints-1470 onto main): three caching
    intents coexist on this path and must all be invalidated together or reads
    go split-brain:
      (a) the owner's ``hot_cache``-backed connections cache,
      (b) R9's behavior (the legacy ``("connections", user_id)`` hot_cache key),
      (c) PR #1476's perf cache keyed by ``_connections_cache_key`` (DB-path
          aware).
    Main already unified (a)+(b) onto the per-router ``_connection_list_cache``
    (the live store that ``list_connections`` actually reads/writes). #1476
    additionally introduced ``_connections_cache_key``. To avoid any path
    clearing only one store, this helper clears the per-router cache AND both
    hot_cache keys. Clearing a store a given build does not populate is a
    harmless no-op.
    """
    _connection_list_cache_clear(user_id)
    hot_cache.delete(_connections_cache_key(user_id))
    hot_cache.delete(("connections", user_id))

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


def _oauth_state_secret() -> str:
    return (
        os.environ.get("WORKEROS_OAUTH_STATE_SECRET")
        or os.environ.get("WORKEROS_MAGIC_LINK_SECRET")
        or os.environ.get("FLOOM_SECRET")
        or _OAUTH_STATE_FALLBACK_SECRET
    )


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _issue_oauth_state(*, user_id: str, ttl_seconds: int = 600) -> str:
    payload = {
        "user_id": user_id,
        "nonce": pysecrets.token_urlsafe(18),
        "exp": int(time.time()) + ttl_seconds,
    }
    encoded = _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = hmac.new(
        _oauth_state_secret().encode("utf-8"),
        encoded.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    return f"{encoded}.{signature}"


def _validate_oauth_state(state: str) -> str:
    try:
        encoded, signature = state.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid OAuth state") from exc
    expected = hmac.new(
        _oauth_state_secret().encode("utf-8"),
        encoded.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=400, detail="Invalid OAuth state")
    try:
        payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid OAuth state") from exc
    if int(payload.get("exp") or 0) < int(time.time()):
        raise HTTPException(status_code=400, detail="OAuth state expired")
    user_id = str(payload.get("user_id") or "")
    if not user_id:
        raise HTTPException(status_code=400, detail="Invalid OAuth state")
    return user_id


def _callback_url_with_state(callback_url: str, state: str) -> str:
    parsed = urllib.parse.urlsplit(callback_url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("state", state))
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), parsed.fragment)
    )


def _session_user_id_from_request(request: Request, repos: Repositories) -> str | None:
    session_id = request.cookies.get(SESSION_COOKIE)
    if not session_id or repos.sessions is None:
        return None
    row = repos.sessions.get(session_id=session_id)
    if not row:
        return None
    return str(row.get("user_id") or "") or None


def _verify_oauth_callback_state(
    *,
    request: Request,
    repos: Repositories,
    existing: Dict[str, Any],
    state: str,
) -> None:
    if not state:
        raise HTTPException(status_code=400, detail="Missing OAuth state")
    state_user_id = _validate_oauth_state(state)
    owner_id = str(existing.get("user_id") or "")
    session_user_id = _session_user_id_from_request(request, repos)
    if state_user_id != owner_id or session_user_id != owner_id:
        raise HTTPException(status_code=400, detail="OAuth state does not match the active session")


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


_COMPOSIO_ACTIVE_STATUSES = {"active", "valid", "connected", "enabled", "success"}


def _normalize_composio_connection_status(status: Optional[str]) -> str:
    normalized = (status or "").strip().lower()
    if normalized in _COMPOSIO_ACTIVE_STATUSES:
        return "active"
    return normalized


def _callback_persisted_status(existing_status: str, remote_status: str) -> str:
    """Return callback status using only persisted/remote state.

    The browser-visible OAuth callback query string is not proof that Composio
    activated the account. It can decide redirect UX, but it must not promote a
    stored connection to active.
    """
    if remote_status and remote_status != "not_found":
        return remote_status
    return existing_status


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


def _refresh_connection_status_for_list(
    row: Dict[str, Any],
    *,
    user_id: str,
    repos: Repositories,
    now: object = None,
) -> Dict[str, Any]:
    """Compatibility shim: list responses never block on remote status refresh."""
    return row


def _redact_connection_account_label(value: Optional[str]) -> Optional[str]:
    """Mask an account identity for any CROSS-USER / multi-tenant surface.

    Floom OS is single-tenant: the owner is the only principal and MUST see
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
    if cwd:
        posix = PurePosixPath(cwd.replace("\\", "/"))
        windows = PureWindowsPath(cwd)
        if (
            posix.is_absolute()
            or windows.is_absolute()
            or cwd.startswith("~")
            or any(part in {"", ".", ".."} for part in posix.parts)
        ):
            raise HTTPException(
                status_code=400,
                detail="MCP stdio cwd must be a workspace-relative path without '.' or '..'",
            )
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
    recent run of any worker declaring that connection.

    Uses a single batch SQL query (MAX created_at GROUP BY worker_id) instead of
    one list_for_worker call per worker (#1278 perf fix). Falls back to empty on
    any error so the connections list still renders.
    """
    last_used: Dict[str, tuple[str, str]] = {}
    try:
        workers = _list_visible_workers(user_id=user_id, repos=repos, use_cache=True)
        # Collect (worker_id -> (slugs, name)) for workers that declare connections.
        worker_slugs: Dict[str, tuple[list[str], str]] = {}
        for w in workers:
            slugs = [s.lower() for s in _worker_connection_slugs(w)]
            if slugs:
                worker_slugs[w["id"]] = (slugs, str(w.get("name") or w["id"]))
        if not worker_slugs:
            return {}
        # Batch-fetch the most recent run timestamp per worker in one SQL call.
        worker_ids = list(worker_slugs.keys())
        from db import get_db
        placeholders = ",".join("?" for _ in worker_ids)
        with get_db() as conn:
            rows = conn.execute(
                f"""
                SELECT r.worker_id, MAX(r.created_at) AS last_run_at
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE w.owner_id = ?
                  AND r.worker_id IN ({placeholders})
                GROUP BY r.worker_id
                """,
                [user_id, *worker_ids],
            ).fetchall()
        for row in rows:
            row_data = row_to_dict(row)
            wid = row_data.get("worker_id")
            ts = row_data.get("last_run_at")
            if not wid or not ts:
                continue
            ts = str(ts)
            entry = worker_slugs.get(str(wid))
            if not entry:
                continue
            slugs, wname = entry
            for slug in slugs:
                prev = last_used.get(slug)
                if prev is None or ts > prev[0]:
                    last_used[slug] = (ts, wname)
    except Exception:
        logger.debug("connection last-used computation failed", exc_info=True)
    return last_used


def _connections_cache_key(user_id: str) -> tuple[str, str, str]:
    return (
        "connections",
        os.environ.get("WORKEROS_DB") or os.environ.get("FLOOM_DB") or "",
        user_id,
    )


@connections_router.get("/connections", response_model=List[ConnectionItem])
def list_connections(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[ConnectionItem]:
    # Reconcile (PR #1476 onto main): the per-router ``_connection_list_cache``
    # is the live store reads/writes go through (main's unified cache). PR
    # #1476's de-N+1 (single batched ``_connections_last_used`` query) and its
    # no-blocking-Composio-on-list behavior live in the body below and are
    # independent of which cache backs the read, so both are preserved.
    cached = _connection_list_cache_get(auth.user_id)
    if cached is not None:
        return cached
    rows = repos.connections.list(user_id=auth.user_id)
    if not rows:
        _connection_list_cache_set(auth.user_id, [])
        return []
    last_used = _connections_last_used(auth.user_id, repos)  # #802

    refreshed: List[Dict[str, Any]] = []
    for row in rows:
        d = row_to_dict(row)
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
    surviving: List[Dict[str, Any]] = []
    for d in refreshed:
        if (
            (d.get("kind") or "composio") == "composio"
            and d.get("app_name") in live_apps
            and not _is_live(d.get("status"))
        ):
            continue
        surviving.append(d)

    # #1727 — collapse exact-duplicate rows for the same account. Reconnect
    # flows could insert multiple ACTIVE rows for one (app, account), so the
    # list showed Gmail x2 / Google Calendar x3 for the same 'federico'. Dedupe
    # by (app, kind, account-label, scopes): rows that are the same account AND
    # the same grants collapse to one (keeping the live + most-recently-used),
    # while rows with genuinely different scopes are preserved as distinct.
    def _dedupe_key(d: Dict[str, Any]) -> tuple:
        label = _normalize_owner_account_label(
            d.get("display_name") or d.get("account_label")
        )
        label_norm = str(label or "").strip().lower()
        # #1727 — only collapse rows that share a REAL account label. Unlabeled
        # rows (no display_name/account_label) must each be preserved — same
        # stance as the canonical reconnect logic (find_by_app_account returns
        # None on a blank label, refusing to merge). Key blank-label rows on
        # their stable row id (NUL-prefixed so it can't collide with a literal
        # label) so they are never merged together.
        identity = label_norm if label_norm else f"\x00id:{d.get('id')}"
        return (
            str(d.get("app_name") or "").lower(),
            d.get("kind") or "composio",
            identity,
            tuple(sorted(str(s) for s in (d.get("scopes") or []))),
        )

    def _rank(d: Dict[str, Any]) -> tuple:
        return (
            1 if _is_live(d.get("status")) else 0,
            str(d.get("last_used_at") or d.get("created_at") or ""),
        )

    best_by_key: Dict[tuple, Dict[str, Any]] = {}
    order: List[tuple] = []
    for d in surviving:
        key = _dedupe_key(d)
        if key not in best_by_key:
            best_by_key[key] = d
            order.append(key)
        elif _rank(d) > _rank(best_by_key[key]):
            best_by_key[key] = d

    result = [_public_connection_item(best_by_key[key]) for key in order]
    _connection_list_cache_set(auth.user_id, result)
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

    oauth_state = _issue_oauth_state(user_id=auth.user_id)
    callback_url = _callback_url_with_state(_get_callback_url(), oauth_state)
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
    _invalidate_connections_cache(auth.user_id)
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
    _invalidate_connections_cache(auth.user_id)
    return _public_connection_item(item)


def _emit_connection_resolved(
    *,
    event: str,
    connection_id: str,
    owner_id: Optional[str],
    provider: Optional[str],
    failure_status: Optional[str] = None,
) -> None:
    """Emit connection_added / connection_failed when an OAuth connection
    resolves at the callback chokepoint.

    The OAuth callback is the single point where a pending connection
    transitions to active (added) or to a definitive non-active outcome
    (failed), so emitting here captures every resolution exactly once without
    the per-entrypoint double-emit risk of instrumenting each route.

    Metadata only — counts/ids/the provider slug, never the external account
    handle, any token, or PII. No-op when analytics is disabled; never raises.
    """
    try:
        from services import analytics_posthog
        from db import derive_workspace_id
    except Exception:  # pragma: no cover - analytics module import guard
        return
    if not analytics_posthog.is_enabled():
        return
    try:
        props: Dict[str, Any] = {
            "connection_id": connection_id or None,
            "provider": (provider or "").strip().lower() or None,
        }
        if event == "connection_failed":
            props["failure_status"] = (failure_status or "").strip().lower() or None
        analytics_posthog.capture_event(
            distinct_id=owner_id or "",
            event=event,
            properties=props,
            groups={"workspace": derive_workspace_id(owner_id)},
        )
    except Exception:  # pragma: no cover - belt-and-suspenders
        logger.debug("PostHog %s emit failed for %s", event, connection_id, exc_info=True)


@connections_router.get("/connections/callback")
def connections_callback(request: Request, connection_id: str = "", status: str = "", state: str = ""):
    """OAuth callback landing — Composio redirects here after user authorizes.

    Composio sends: ?connection_id=<composio_conn_id>&status=<status>&state=<signed-state>
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
        try:
            _verify_oauth_callback_state(
                request=request,
                repos=repos,
                existing=existing,
                state=state or request.query_params.get("state", ""),
            )
        except HTTPException:
            logger.warning("Rejected OAuth callback with invalid state for connection %s", callback_connection_id)
            return RedirectResponse(url=f"{frontend_url}/connections?connected=0&error=oauth_state")

        landing_id = existing["id"]
        landing_app = existing.get("app_name") or ""

        # Try to refresh from Composio first
        try:
            from composio_client import check_status
            remote_status = _normalize_composio_connection_status(check_status(callback_connection_id))
        except Exception:
            remote_status = ""

        final_status = _callback_persisted_status(str(existing.get("status") or ""), remote_status)
        now = now_iso()
        repos.connections.update(
            user_id=existing["user_id"],
            composio_id=existing["id"],
            status=final_status,
            composio_connection_id=callback_connection_id,
            updated_at=now,
        )
        _connection_list_cache_clear(str(existing["user_id"]))

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

        # Analytics: capture the OAuth activation outcome once per callback
        # resolution. ``active`` is an add; a definitive non-active status from
        # the provider is a failure. A missing/unknown remote answer leaves the
        # connection pending and emits nothing (no false signal). Fail-soft.
        if final_status == "active":
            _emit_connection_resolved(
                event="connection_added",
                connection_id=str(landing_id or existing["id"]),
                owner_id=str(existing["user_id"]),
                provider=landing_app or existing.get("app_name"),
            )
        elif remote_status and remote_status != "not_found":
            _emit_connection_resolved(
                event="connection_failed",
                connection_id=str(landing_id or existing["id"]),
                owner_id=str(existing["user_id"]),
                provider=landing_app or existing.get("app_name"),
                failure_status=final_status,
            )

    # Invalidate the connections list cache for the owner so the next list
    # request reflects the updated OAuth status.
    if existing:
        _invalidate_connections_cache(str(existing["user_id"]))
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
        _connection_list_cache_clear(str(user_id))
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
def connections_callback_alias(request: Request, connection_id: str = "", status: str = "", state: str = ""):
    return connections_callback(request=request, connection_id=connection_id, status=status, state=state)


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
    _invalidate_connections_cache(user_id)
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
    lives here on the API service so it never needs to be on the web host.
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

    Proxies to Composio so the key stays on the API service, not on the web host.
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

                # #1180/#1293: re-validate at dial time and pin the vetted IP
                # for the actual httpx connection. This closes the DNS
                # rebinding gap between validation and connect.
                try:
                    probe_url, pinned_headers, request_extensions = pinned_safe_outbound_httpx_target(
                        mcp_url,
                        label="MCP server URL",
                    )
                    headers.update(pinned_headers)
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
                probe_url = probe_url.rstrip("/")
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

                with _httpx.Client(timeout=8.0, trust_env=False) as http:
                    init_resp = http.post(
                        probe_url,
                        json=init_payload,
                        headers=headers,
                        extensions=request_extensions,
                    )
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

                    tools_resp = http.post(
                        probe_url,
                        json=tools_payload,
                        headers=headers,
                        extensions=request_extensions,
                    )
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
                        legacy_resp = http.get(
                            f"{probe_url}/tools/list",
                            headers=headers,
                            extensions=request_extensions,
                        )
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
        # user sees their actual email rather than the hardcoded "local-user"
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
