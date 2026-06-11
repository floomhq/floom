"""Pydantic models for Floom V0: request schemas, response schemas, and domain types."""

import ipaddress
import os
import re
import socket
import warnings
from typing import Any, Dict, Iterable, List, Literal, Mapping, Optional, Union
from urllib.parse import unquote, urlsplit
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from enum import Enum


DEFAULT_WORKER_AGENT_MODEL = "gpt-5.1"


def _model_data(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return value


# ---------------------------------------------------------------------------
# SSRF deny-list for outbound URLs (MCP server URLs, alert webhook URLs, ...)
# ---------------------------------------------------------------------------
#
# Several features cause the backend to dial a user-supplied URL from inside our
# network: an MCP HTTP/SSE connection URL is dialed by the worker runtime, and
# an alert webhook URL is POSTed to on run terminal status. Without validation,
# a user can point such a URL at an internal / loopback / link-local address
# (e.g. the cloud metadata endpoint 169.254.169.254, localhost, RFC1918 hosts)
# and the backend will issue an outbound request from inside our network — a
# classic SSRF.
#
# `assert_safe_outbound_url` is the single shared validator. It is enforced at
# STORE/REGISTRATION time (MCP connection add, alert create) AND re-checked at
# USE time (MCP dial, webhook POST) for defense in depth, since DNS can rebind
# between store and use.
#
# Self-hosters who legitimately target a local URL can opt out with
# WORKEROS_ALLOW_PRIVATE_MCP_URLS=1 (default OFF / secure).

# Resolution timeout so a hostile/slow DNS record can't hang the request.
_MCP_DNS_RESOLVE_TIMEOUT_SECONDS = 3.0


class UnsafeOutboundUrlError(ValueError):
    """Raised when an outbound URL (MCP server, alert webhook, ...) points to an
    internal/loopback/link-local address (or uses a disallowed scheme)."""


# Backward-compatible alias: the original MCP-specific name. Existing call sites
# and tests import UnsafeMCPUrlError; it is the exact same exception type, so
# `except UnsafeMCPUrlError` and `except UnsafeOutboundUrlError` both catch it.
UnsafeMCPUrlError = UnsafeOutboundUrlError


def _allow_private_mcp_urls() -> bool:
    """Self-hoster escape hatch: WORKEROS_ALLOW_PRIVATE_MCP_URLS=1 bypasses the
    SSRF deny-list. Default OFF (secure)."""
    return os.environ.get("WORKEROS_ALLOW_PRIVATE_MCP_URLS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _ip_is_disallowed(ip: ipaddress._BaseAddress) -> bool:
    """True if an IP is in a range we must never dial from inside our network.

    Covers (IPv4 + IPv6):
      - loopback           (127.0.0.0/8, ::1)
      - link-local         (169.254.0.0/16 incl. cloud metadata 169.254.169.254, fe80::/10)
      - private RFC1918    (10/8, 172.16/12, 192.168/16)
      - unique-local       (fc00::/7)
      - unspecified        (0.0.0.0, ::)
      - other non-global   (reserved, multicast, etc.)
    """
    # IPv4-mapped IPv6 (::ffff:127.0.0.1) — unwrap to judge the real target.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return (
        ip.is_loopback
        or ip.is_link_local
        or ip.is_private
        or ip.is_unspecified
        or ip.is_reserved
        or ip.is_multicast
        or not ip.is_global
    )


def _resolve_host_ips(host: str) -> List[ipaddress._BaseAddress]:
    """Resolve a hostname to all of its IPs (A + AAAA), bounded by a short
    timeout. Returns parsed ip_address objects. Raises socket.gaierror on
    failure (caller treats resolution failure as unsafe)."""
    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(_MCP_DNS_RESOLVE_TIMEOUT_SECONDS)
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    finally:
        socket.setdefaulttimeout(old_timeout)
    ips: List[ipaddress._BaseAddress] = []
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        try:
            ips.append(ipaddress.ip_address(sockaddr[0]))
        except ValueError:
            continue
    return ips


def assert_safe_outbound_url(url: str, *, label: str = "URL") -> str:
    """Validate a user-supplied outbound http(s) URL for SSRF safety.

    Shared by the MCP-connection registration path and the alert-webhook path.

    Rejects:
      - schemes other than http/https,
      - URLs with no hostname,
      - hosts that are, or resolve to, loopback / link-local (incl. the cloud
        metadata IP 169.254.169.254) / RFC1918 private / unique-local /
        unspecified / otherwise non-global addresses.

    Resolves the hostname (all A/AAAA records, bounded timeout) and checks every
    resolved IP, so a public-looking hostname that points at an internal address
    is still rejected. Resolution failure is treated as unsafe (fail closed).

    ``label`` is woven into the error message (e.g. "MCP server URL", "Alert
    webhook URL") so callers get a clear rejection reason.

    Returns the (stripped) url when safe. Raises UnsafeOutboundUrlError otherwise.

    Bypassed entirely when WORKEROS_ALLOW_PRIVATE_MCP_URLS=1 (self-hoster opt-in).
    """
    stripped = (url or "").strip()

    # Reject CRLF injection — check raw, percent-decoded, and double-decoded to
    # catch %0d%0a, %250d%250a, and mixed variants before any HTTP client sees them.
    _once = unquote(stripped)
    _twice = unquote(_once)
    if any("\r" in s or "\n" in s for s in (stripped, _once, _twice)):
        raise UnsafeOutboundUrlError(
            f"{label} is not allowed: contains control characters (CRLF injection)"
        )

    if _allow_private_mcp_urls():
        return stripped

    parts = urlsplit(stripped)
    if parts.scheme.lower() not in {"http", "https"}:
        raise UnsafeOutboundUrlError(
            f"{label} is not allowed: only http:// and https:// schemes are permitted"
        )

    host = parts.hostname
    if not host:
        raise UnsafeOutboundUrlError(f"{label} is not allowed: missing host")

    # If the host is already an IP literal, judge it directly (no DNS needed).
    try:
        literal_ip = ipaddress.ip_address(host)
    except ValueError:
        literal_ip = None

    if literal_ip is not None:
        if _ip_is_disallowed(literal_ip):
            raise UnsafeOutboundUrlError(
                f"{label} is not allowed: points to an internal/loopback/link-local address"
            )
        return stripped

    # Reject obvious localhost aliases up front (cheap, before DNS).
    if host.lower() in {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"}:
        raise UnsafeOutboundUrlError(
            f"{label} is not allowed: points to an internal/loopback/link-local address"
        )

    try:
        resolved = _resolve_host_ips(host)
    except (socket.gaierror, socket.timeout, OSError) as exc:
        raise UnsafeOutboundUrlError(
            f"{label} is not allowed: host could not be resolved ({host})"
        ) from exc

    if not resolved:
        raise UnsafeOutboundUrlError(
            f"{label} is not allowed: host could not be resolved ({host})"
        )

    for ip in resolved:
        if _ip_is_disallowed(ip):
            raise UnsafeOutboundUrlError(
                f"{label} is not allowed: points to an internal/loopback/link-local address"
            )
    return stripped


def assert_safe_outbound_mcp_url(url: str) -> str:
    """SSRF validator for MCP HTTP/SSE server URLs. Thin wrapper around
    :func:`assert_safe_outbound_url` preserving the original API + error text."""
    return assert_safe_outbound_url(url, label="MCP server URL")


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class WorkerStatus(str, Enum):
    HEALTHY = "healthy"
    # P2 (2026-05-29): a worker that has never run has not EARNED "healthy"
    # (which implies a verified-working worker). Report a neutral READY/Untested
    # state instead. The UI treats READY exactly like HEALTHY (quiet, no pill),
    # so this only makes the API claim honest — it never says "healthy" for an
    # unverified worker.
    READY = "ready"
    NEEDS_ATTENTION = "needs_attention"
    MISSING_SECRET = "missing_secret"
    ERROR = "error"


class RunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PENDING_APPROVAL = "pending_approval"


class LogLevel(str, Enum):
    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class SecretStatus(str, Enum):
    SET = "set"
    MISSING = "missing"


# ---------------------------------------------------------------------------
# Worker config schemas (used for YAML parsing)
# ---------------------------------------------------------------------------

class WorkerInput(BaseModel):
    name: str
    label: str
    type: str
    required: bool = False
    placeholder: Optional[str] = None
    description: Optional[str] = None
    options: Optional[List[str]] = None
    default: Optional[Any] = None
    accept_csv: bool = False  # When True, render the CSV column mapper in the UI
    accepts: Optional[List[str]] = None
    max_size_mb: Optional[float] = None


class WorkerOutput(BaseModel):
    name: str
    label: str
    type: str
    required: bool = True
    kind: Optional[str] = None
    media_type: Optional[str] = None
    path: Optional[str] = None
    columns: Optional[List[str]] = None  # For CSV: declared expected column headers in order
    json_required_keys: Optional[List[str]] = None  # For JSON: declared required top-level keys


class WorkerApprovals(BaseModel):
    """HITL approval configuration for a worker."""
    required: bool = False
    label: str = "Approve action"


class WorkerWebhookConfig(BaseModel):
    secret: bool = True
    allowed_methods: List[str] = ["POST"]


class WorkerComposioTriggerConfig(BaseModel):
    event: str
    connection_id: str
    filters: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("event", "connection_id")
    @classmethod
    def validate_nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value is required")
        return value.strip()


class WorkerTrigger(BaseModel):
    type: str
    cron: Optional[str] = None
    timezone: Optional[str] = None
    every: Optional[str] = None
    at: Optional[str] = None
    webhook: Optional[WorkerWebhookConfig] = None
    composio: Optional[WorkerComposioTriggerConfig] = None

    @field_validator("type")
    @classmethod
    def normalize_type(cls, value: str) -> str:
        normalized = (value or "manual").strip().lower()
        if normalized in {"cron", "scheduled"}:
            return "schedule"
        return normalized

    @field_validator("cron")
    @classmethod
    def validate_cron(cls, value: Optional[str]) -> Optional[str]:
        if value is None or not value.strip():
            return value
        from cron_utils import is_valid_cron_expr

        if not is_valid_cron_expr(value):
            raise ValueError(f"invalid cron expression: {value!r}")
        return value


class WorkerMCPConnection(BaseModel):
    label: str
    transport: Literal["streamable_http", "sse", "stdio"] = "streamable_http"
    url: Optional[str] = None
    command: Optional[str] = None
    args: List[str] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict)
    cwd: Optional[str] = None
    auth: Optional[str] = None
    allowed_tools: Optional[List[str]] = None
    require_approval: Literal["never", "always"] = "never"

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str) -> str:
        stripped = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", stripped):
            raise ValueError("mcp label must be 1-64 letters, digits, underscores, or hyphens")
        return stripped

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped.startswith(("http://", "https://")):
            raise ValueError("mcp url must start with http:// or https://")
        return stripped

    @field_validator("command")
    @classmethod
    def validate_command(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            return None
        return stripped

    @field_validator("args")
    @classmethod
    def validate_args(cls, value: List[str]) -> List[str]:
        return [str(item).strip() for item in value if str(item).strip()]

    @field_validator("env")
    @classmethod
    def validate_env(cls, value: Dict[str, str]) -> Dict[str, str]:
        cleaned: Dict[str, str] = {}
        for key, raw in value.items():
            name = str(key).strip()
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                raise ValueError("mcp env keys must be valid environment variable names")
            val = str(raw).strip()
            if val:
                cleaned[name] = val
        return cleaned

    @field_validator("cwd")
    @classmethod
    def validate_cwd(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator("auth")
    @classmethod
    def validate_auth(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        stripped = value.strip()
        if not stripped:
            return None
        if not stripped.startswith("bearer:"):
            raise ValueError("mcp auth currently supports bearer:<SECRET_NAME>")
        secret_name = stripped.split(":", 1)[1]
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", secret_name):
            raise ValueError("mcp bearer auth must reference a valid secret name")
        return stripped

    @field_validator("allowed_tools")
    @classmethod
    def validate_allowed_tools(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        if value is None:
            return value
        cleaned = [item.strip() for item in value if item and item.strip()]
        if len(cleaned) != len(value):
            raise ValueError("mcp allowed_tools entries must be non-empty")
        return cleaned

    @model_validator(mode="after")
    def validate_transport_shape(self) -> "WorkerMCPConnection":
        if self.transport in {"streamable_http", "sse"}:
            if not self.url:
                raise ValueError("mcp url is required for HTTP/SSE transports")
            if self.command:
                raise ValueError("mcp command is only valid for stdio transport")
        elif self.transport == "stdio":
            if not self.command:
                raise ValueError("mcp command is required for stdio transport")
            if self.url:
                raise ValueError("mcp url is not valid for stdio transport")
            if self.auth:
                raise ValueError("mcp auth is only valid for HTTP/SSE transports")
        return self


class WorkerConnection(BaseModel):
    mcp: Optional[WorkerMCPConnection] = None
    composio: Optional["WorkerComposioConnection"] = None
    # Shorthand for:
    #   connections:
    #     - app: gmail
    #       allowed_tools: [GMAIL_FETCH_EMAILS]
    app: Optional[str] = None
    allowed_tools: Optional[List[str]] = None
    scope: Optional[str] = None
    scopes: Optional[List[str]] = None

    @model_validator(mode="after")
    def validate_connection_kind(self) -> "WorkerConnection":
        composio_shorthand = self.app is not None
        kind_count = int(self.mcp is not None) + int(self.composio is not None or composio_shorthand)
        if kind_count != 1:
            raise ValueError("connection entries must declare exactly one of: mcp, composio, or app")
        if composio_shorthand:
            self.composio = WorkerComposioConnection(
                app=self.app or "",
                allowed_tools=self.allowed_tools,
                scope=self.scope,
                scopes=self.scopes,
            )
        return self


class WorkerComposioConnection(BaseModel):
    app: str
    allowed_tools: Optional[List[str]] = None
    scope: Optional[str] = None
    scopes: Optional[List[str]] = None

    @field_validator("app")
    @classmethod
    def validate_app(cls, value: str) -> str:
        stripped = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", stripped):
            raise ValueError("composio app must be 1-64 lowercase letters, digits, underscores, or hyphens")
        return stripped

    @field_validator("allowed_tools")
    @classmethod
    def validate_composio_allowed_tools(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        if value is None:
            return value
        cleaned = [item.strip().upper() for item in value if item and item.strip()]
        if len(cleaned) != len(value):
            raise ValueError("composio allowed_tools entries must be non-empty")
        return cleaned

    @field_validator("scope")
    @classmethod
    def validate_composio_scope(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip().lower().replace("-", "_")
        if not cleaned:
            return None
        if cleaned not in {"full", "read_only"}:
            raise ValueError("composio scope must be 'full' or 'read_only'")
        return cleaned

    @field_validator("scopes")
    @classmethod
    def validate_composio_scopes(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        if value is None:
            return None
        cleaned: List[str] = []
        for raw in value:
            scope = str(raw).strip().lower().replace("-", "_")
            if not scope:
                continue
            if scope not in {"full", "read_only"}:
                raise ValueError("composio scopes entries must be 'full' or 'read_only'")
            if scope not in cleaned:
                cleaned.append(scope)
        return cleaned or None


WorkerConnectionSpec = Union[str, WorkerConnection]


def composio_connection_app_name(connection: WorkerConnectionSpec) -> Optional[str]:
    if isinstance(connection, str):
        return connection.strip().lower() or None
    composio = getattr(connection, "composio", None)
    if composio is not None:
        return composio.app
    return None


def composio_connection_allowed_tools(connection: WorkerConnectionSpec) -> Optional[List[str]]:
    if isinstance(connection, str):
        app = connection.strip().lower()
        if not app:
            return []
        return read_only_preset_for_app(app) or []
    composio = getattr(connection, "composio", None)
    if composio is None:
        return None
    return composio.allowed_tools


def composio_connection_scopes(connection: WorkerConnectionSpec) -> List[str]:
    if isinstance(connection, str):
        return ["read_only"]
    composio = getattr(connection, "composio", None)
    if composio is None:
        return []
    scopes = list(composio.scopes or [])
    if composio.scope and composio.scope not in scopes:
        scopes.append(composio.scope)
    return scopes or ["full"]


def declared_composio_connections(config: Optional["WorkerConfig"]) -> Dict[str, Optional[List[str]]]:
    declared: Dict[str, Optional[List[str]]] = {}
    if not config:
        return declared
    legacy_allowlists: Dict[str, set[str]] = {}
    explicit_allowlists: Dict[str, set[str]] = {}
    full_access_apps: set[str] = set()
    for connection in config.connections or []:
        app = composio_connection_app_name(connection)
        if not app:
            continue
        allowed_tools = composio_connection_allowed_tools(connection)
        if isinstance(connection, str):
            legacy_allowlists.setdefault(app, set()).update(allowed_tools or [])
            continue
        if allowed_tools is None:
            full_access_apps.add(app)
        else:
            explicit_allowlists.setdefault(app, set()).update(allowed_tools)
    for app in sorted(set(legacy_allowlists) | set(explicit_allowlists) | full_access_apps):
        if app in legacy_allowlists:
            declared[app] = sorted(legacy_allowlists[app] | explicit_allowlists.get(app, set()))
            continue
        if app in full_access_apps:
            declared[app] = None
            continue
        if app in explicit_allowlists:
            declared[app] = sorted(explicit_allowlists[app])
    return declared


def declared_composio_connection_scopes(config: Optional["WorkerConfig"]) -> Dict[str, List[str]]:
    declared: Dict[str, List[str]] = {}
    if not config:
        return declared
    legacy_apps: set[str] = set()
    explicit_scopes: Dict[str, set[str]] = {}
    full_access_apps: set[str] = set()
    for connection in config.connections or []:
        app = composio_connection_app_name(connection)
        if not app:
            continue
        scopes = composio_connection_scopes(connection)
        if isinstance(connection, str):
            legacy_apps.add(app)
            continue
        if "full" in scopes or not scopes:
            full_access_apps.add(app)
        else:
            explicit_scopes.setdefault(app, set()).update(scopes)
    for app in sorted(set(legacy_apps) | set(explicit_scopes) | full_access_apps):
        if app in legacy_apps:
            declared[app] = ["read_only"]
            continue
        if app in full_access_apps:
            declared[app] = ["full"]
            continue
        merged = sorted(explicit_scopes.get(app, set()))
        if merged:
            declared[app] = ["full"] if "full" in merged else merged
    return declared


def composio_tool_allowed_by_scope(app: str, tool_slug: str, scopes: List[str] | None) -> bool:
    normalized_scopes = {scope.strip().lower().replace("-", "_") for scope in (scopes or ["full"])}
    if "full" in normalized_scopes or not normalized_scopes:
        return True
    normalized_tool = tool_slug.upper()
    app_prefix = app.upper().replace("-", "_")
    if normalized_tool.startswith(app_prefix + "_"):
        action = normalized_tool[len(app_prefix) + 1:]
    else:
        action = normalized_tool
    if "read_only" in normalized_scopes:
        deny_prefixes = (
            "SEND", "CREATE", "UPDATE", "DELETE", "MODIFY", "PATCH", "POST",
            "REPLY", "FORWARD", "MOVE", "MARK", "ARCHIVE", "TRASH", "DRAFT",
        )
        if action.startswith(deny_prefixes):
            return False
        allow_prefixes = ("GET", "LIST", "SEARCH", "FETCH", "READ", "QUERY", "RETRIEVE")
        return action.startswith(allow_prefixes)
    return False


# ---------------------------------------------------------------------------
# Read-only tool presets (C-B9)
# ---------------------------------------------------------------------------
#
# ``composio_tool_allowed_by_scope`` enforces a read-only *scope* with a
# prefix heuristic (deny SEND/CREATE/..., allow GET/LIST/...). That heuristic
# is the safety net at execution time. These presets are the *curated* read
# subset a worker's connection can be pinned to via ``allowed_tools`` — an
# explicit, auditable list per common app that the Tools-tab allowlist editor
# can apply with a single "Read-only" button instead of asking the operator to
# hand-pick tool slugs. Keeping the list explicit (rather than only relying on
# the prefix heuristic) means the allowlist shown in the UI is the exact set of
# tools the worker can ever call.
READ_ONLY_TOOL_PRESETS: Dict[str, List[str]] = {
    "gmail": [
        "GMAIL_FETCH_EMAILS",
        "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
        "GMAIL_LIST_THREADS",
        "GMAIL_LIST_LABELS",
        "GMAIL_GET_PROFILE",
        "GMAIL_SEARCH_PEOPLE",
        "GMAIL_GET_CONTACTS",
        "GMAIL_GET_ATTACHMENT",
    ],
    "slack": [
        "SLACK_FETCH_CONVERSATION_HISTORY",
        "SLACK_LIST_ALL_CHANNELS",
        "SLACK_LIST_ALL_USERS",
        "SLACK_LIST_ALL_SLACK_TEAM_CHANNELS_WITH_VARIOUS_FILTERS",
        "SLACK_SEARCH_MESSAGES",
        "SLACK_FETCH_CONVERSATION_REPLIES",
        "SLACK_RETRIEVE_DETAILED_USER_INFORMATION",
        "SLACK_LIST_ALL_USERS_IN_A_USER_GROUP",
    ],
    "github": [
        "GITHUB_GET_A_REPOSITORY",
        "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
        "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER",
        "GITHUB_GET_AN_ISSUE",
        "GITHUB_LIST_PULL_REQUESTS",
        "GITHUB_GET_A_PULL_REQUEST",
        "GITHUB_LIST_COMMITS",
        "GITHUB_GET_A_COMMIT",
        "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
        "GITHUB_SEARCH_REPOSITORIES",
    ],
    "googlecalendar": [
        "GOOGLECALENDAR_EVENTS_LIST",
        "GOOGLECALENDAR_FIND_EVENT",
        "GOOGLECALENDAR_GET_CALENDAR",
        "GOOGLECALENDAR_LIST_CALENDARS",
        "GOOGLECALENDAR_GET_CURRENT_DATE_TIME",
        "GOOGLECALENDAR_FREE_BUSY_QUERY",
    ],
}

# Common app-slug aliases mapped to their canonical preset key, so callers can
# pass "calendar"/"google_calendar"/"gcal" etc. and still resolve a preset.
_READ_ONLY_PRESET_ALIASES: Dict[str, str] = {
    "google_calendar": "googlecalendar",
    "googlecalender": "googlecalendar",
    "calendar": "googlecalendar",
    "gcal": "googlecalendar",
}


def _normalize_preset_app(app: str) -> str:
    normalized = (app or "").strip().lower().replace("-", "_")
    return _READ_ONLY_PRESET_ALIASES.get(normalized, normalized)


def read_only_preset_for_app(app: str) -> Optional[List[str]]:
    """Return the curated read-only tool slug subset for ``app``.

    Returns ``None`` when no preset exists for the app (the UI should then fall
    back to the generic read_only *scope* rather than an explicit allowlist).
    """
    key = _normalize_preset_app(app)
    preset = READ_ONLY_TOOL_PRESETS.get(key)
    return list(preset) if preset is not None else None


def read_only_presets() -> Dict[str, List[str]]:
    """Return all curated read-only presets, keyed by canonical app slug."""
    return {app: list(tools) for app, tools in READ_ONLY_TOOL_PRESETS.items()}


def composio_app_for_tool_slug(
    tool_slug: str,
    declared_connections: Mapping[str, Optional[List[str]]] | Iterable[str],
) -> Optional[str]:
    normalized_tool = tool_slug.upper()
    if isinstance(declared_connections, Mapping):
        declared_apps = list(declared_connections.keys())
    else:
        declared_apps = list(declared_connections)
    matches = [
        app for app in declared_apps
        if normalized_tool.startswith(app.upper().replace("-", "_") + "_")
    ]
    if matches:
        return max(matches, key=len)
    if not isinstance(declared_connections, Mapping):
        return None
    allowlist_matches = [
        app
        for app, allowed_tools in declared_connections.items()
        if allowed_tools is not None and normalized_tool in {tool.upper() for tool in allowed_tools}
    ]
    if not allowlist_matches:
        return None
    return max(allowlist_matches, key=len)


class WorkerContextMount(BaseModel):
    name: str
    writeable: bool = False
    source: str = "local"

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        stripped = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", stripped):
            raise ValueError(
                "context name must be 1-64 letters, digits, dots, underscores, or hyphens"
            )
        return stripped

    @field_validator("source")
    @classmethod
    def validate_source(cls, value: str) -> str:
        stripped = (value or "local").strip()
        if stripped != "local" and not stripped.startswith("git+"):
            raise ValueError("context source must be 'local' or start with 'git+'")
        return stripped


WorkerContextMountSpec = Union[str, WorkerContextMount]


class WorkerRuntime(BaseModel):
    type: str
    entrypoint: str = "run.py"
    runner: str = "e2b"
    command: Optional[str] = None
    bundle_path: Optional[str] = None
    mode: Literal["agent", "pure-script"] = "pure-script"
    model: Optional[str] = None
    system_prompt: Optional[str] = None
    # PR S11: tool opt-out propagated from WorkerContractExec.disable_tools.
    disable_tools: List[str] = Field(default_factory=list)
    limits: "WorkerLimits" = Field(default_factory=lambda: WorkerLimits())

    @field_validator("mode", mode="before")
    @classmethod
    def coerce_hybrid_mode(cls, v: object) -> object:
        # #603: "hybrid" was a deprecated synonym for "pure-script". Coerce it
        # here so existing DB rows that still carry mode="hybrid" in their
        # manifest_json load cleanly after the Literal was narrowed.
        # The startup migration converts rows proactively, but this validator
        # is the safety net for any row not yet migrated.
        if v == "hybrid":
            return "pure-script"
        return v

    @field_validator("runner")
    @classmethod
    def validate_runner(cls, v: str) -> str:
        # In-process execution was removed in PR #28; only E2B is supported.
        # Coerce legacy `local` declarations to `e2b` for backward-compat
        # with old worker.yml files, but reject anything else.
        if v == "local":
            return "e2b"
        if v != "e2b":
            raise ValueError(f"runner must be 'e2b' (got {v!r}). Workers execute in E2B sandboxes; no in-process execution is supported.")
        return v


class WorkerConfig(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    model: Optional[str] = None
    trigger: WorkerTrigger
    runtime: WorkerRuntime
    inputs: List[WorkerInput] = []
    secrets: List[str] = []
    connections: List[WorkerConnectionSpec] = []  # Strings are deprecated legacy Composio app slugs.
    contexts: List[WorkerContextMountSpec] = []
    outputs: List[WorkerOutput] = []
    csv_required_columns: Optional[List[str]] = None  # Column names for the CSV mapper wizard
    approvals: WorkerApprovals = Field(default_factory=WorkerApprovals)
    retry: Optional["RetryConfig"] = None
    notify: Optional["NotifyConfig"] = None
    calls: List[str] = Field(default_factory=list)  # worker IDs this worker is allowed to invoke

    @model_validator(mode="after")
    def validate_webhook_secret(self) -> "WorkerConfig":
        if self.trigger.type == "webhook":
            if not self.trigger.webhook:
                raise ValueError(
                    "webhook-triggered workers must declare trigger.webhook.secret: true"
                )
            if self.trigger.webhook.secret is not True:
                raise ValueError(
                    "webhook-triggered workers must declare trigger.webhook.secret: true"
                )
        if self.trigger.type == "composio" and not self.trigger.composio:
            raise ValueError("composio-triggered workers must declare trigger.composio")
        return self


# ---------------------------------------------------------------------------
# WorkerContract schemas (schema_version: "0.3")
# ---------------------------------------------------------------------------

SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$")
SEMVER_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$")


class WorkerContractAuthor(BaseModel):
    name: str
    email: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("author name is required")
        return value

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        if "@" not in value:
            raise ValueError("author email must be an email address")
        return value


class WorkerContractBounds(BaseModel):
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    min_length: Optional[int] = None
    max_length: Optional[int] = None


class WorkerContractField(BaseModel):
    name: str
    kind: Literal["scalar", "file"] = "scalar"
    type: Optional[str] = None
    media_type: Optional[str] = None
    path: Optional[str] = None
    required: bool = False
    default: Optional[Any] = None
    enum: Optional[List[Any]] = None
    examples: Optional[List[Any]] = None
    bounds: Optional[WorkerContractBounds] = None
    format: Optional[str] = None
    description: Optional[str] = None
    label: Optional[str] = None
    placeholder: Optional[str] = None
    options: Optional[List[str]] = None
    accept_csv: bool = False
    accepts: Optional[List[str]] = None
    max_size_mb: Optional[float] = None
    columns: Optional[List[str]] = None
    json_required_keys: Optional[List[str]] = None

    @field_validator("name")
    @classmethod
    def validate_field_name(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
            raise ValueError("field name must be identifier-like")
        return value

    @model_validator(mode="after")
    def validate_shape(self) -> "WorkerContractField":
        if self.kind == "scalar":
            if not self.type:
                raise ValueError(f"scalar field {self.name!r} must declare type")
            if self.media_type:
                raise ValueError(f"scalar field {self.name!r} cannot declare media_type")
            if self.path:
                raise ValueError(f"scalar field {self.name!r} cannot declare path")
        if self.kind == "file":
            if not self.media_type:
                if self.accepts:
                    self.media_type = self.accepts[0]
                else:
                    self.media_type = "application/octet-stream"
            if self.type and self.type != "file":
                raise ValueError(f"file field {self.name!r} cannot declare scalar type")
            if self.max_size_mb is not None and self.max_size_mb <= 0:
                raise ValueError(f"file field {self.name!r} max_size_mb must be greater than 0")
        if self.type == "select" and not (self.options or self.enum):
            raise ValueError(f"select field {self.name!r} must declare options or enum")
        return self


class WorkerEntrypoint(BaseModel):
    name: str
    path: str
    type: str

    @field_validator("name", "path", "type")
    @classmethod
    def validate_nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value is required")
        return value


class WorkerLimits(BaseModel):
    max_tool_iterations: int = Field(default=12, ge=1)
    max_output_tokens: int = Field(default=1000000, ge=1)
    max_total_tokens: int = Field(default=1000000, ge=1)
    timeout_seconds: int = Field(default=300, ge=1)


_SCRIPT_ENTRY_SUFFIXES: tuple[str, ...] = (".py", ".sh", ".js")
_AGENT_ENTRY_SUFFIXES: tuple[str, ...] = (".md",)


def _infer_mode_from_entry(entry: str) -> Literal["agent", "pure-script"]:
    lower = entry.lower()
    if lower.endswith(_AGENT_ENTRY_SUFFIXES):
        return "agent"
    if lower.endswith(_SCRIPT_ENTRY_SUFFIXES):
        return "pure-script"
    raise ValueError(
        f"exec.entry must end in .md (agent) or .py/.sh/.js (script); got {entry!r}"
    )


def _default_command_from_entry(entry: str) -> Optional[str]:
    """Derive a canonical exec.command from a script entry by extension.

    Engine #211: the LLM frequently emits `exec.mode: pure-script` +
    `entry: run.py` WITHOUT a `command`. PR #184 added auto-repair
    that injects `python <entry>`, but in the draft-and-create / draft-from-prompt
    loops the WorkerContract validation ran (and 502'd) BEFORE the repair. By
    defaulting the command inside WorkerContractExec validation we cover every
    call site at once (draft-and-create, draft-from-prompt, upload, from-bundle,
    disk-load).
    """
    lower = entry.lower()
    if lower.endswith(".py"):
        return f"python {entry}"
    if lower.endswith(".sh"):
        return f"bash {entry}"
    if lower.endswith(".js"):
        return f"node {entry}"
    return None


class WorkerContractExec(BaseModel):
    command: Optional[str] = None
    runtime: Literal["python311", "node22", "bash", "skill", "none"] = "skill"
    # E2B-only execution. Workers must run in sandboxed microVMs. The
    # Legacy local runner declarations get coerced to `e2b` for
    # backward-compatibility with old worker.yml files (in-process executor
    # was removed in PR #28).
    runner: str = "e2b"
    # PR S11: `entry` is the canonical mode signal. `.md` -> agent, `.py/.sh/.js` -> script.
    # `mode` is a deprecated alias retained for back-compat; if both are absent we infer
    # from `command` / `runtime` (legacy path).
    entry: Optional[str] = None
    mode: Optional[Literal["agent", "pure-script"]] = None
    # PR S11: tools-on-by-default. `disable_tools` removes specific tools
    # from the agent loop (e.g. ["web_search"]). Empty/missing = all tools on.
    disable_tools: List[str] = Field(default_factory=list)
    inputs: List[WorkerContractField] = Field(default_factory=list)
    secrets: List[str] = Field(default_factory=list)
    contexts: List[WorkerContextMountSpec] = Field(default_factory=list)
    outputs: List[WorkerContractField] = Field(default_factory=list)

    @field_validator("mode", mode="before")
    @classmethod
    def coerce_hybrid_mode(cls, v: object) -> object:
        # #603: coerce legacy "hybrid" → "pure-script" on read so existing DB
        # rows don't crash with ValidationError after the Literal was narrowed.
        if v == "hybrid":
            return "pure-script"
        return v

    @field_validator("command")
    @classmethod
    def validate_command(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not value.strip():
            raise ValueError("value is required")
        return value

    @field_validator("runner")
    @classmethod
    def validate_runner(cls, value: str) -> str:
        # Coerce legacy `local` to `e2b` (PR #28 removed the in-process
        # executor; this guard prevents misleading manifests). Reject any
        # other value with a clear message.
        if value == "local":
            return "e2b"
        if value != "e2b":
            raise ValueError(f"runner must be 'e2b' (got {value!r}). Workers execute in E2B sandboxes; no in-process execution is supported.")
        return value

    @field_validator("entry")
    @classmethod
    def validate_entry(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        stripped = value.strip()
        if not stripped:
            raise ValueError("exec.entry cannot be empty")
        # validate suffix; raises if neither agent nor script suffix.
        _infer_mode_from_entry(stripped)
        return stripped

    @model_validator(mode="after")
    def validate_runtime_mode(self) -> "WorkerContractExec":
        # PR S11: resolve `entry` <-> `mode` so downstream code can read either.
        # Priority: explicit `entry` wins. If only `mode` is set (legacy), derive
        # an entry default so the new code path stays uniform.
        if self.entry:
            inferred = _infer_mode_from_entry(self.entry)
            if self.mode is None:
                self.mode = inferred
        elif self.mode is not None:
            # Legacy mode-only manifest: derive entry for the new code path.
            if self.mode == "agent":
                self.entry = "SKILL.md"
            else:
                # pure-script -> run.py
                self.entry = "run.py"
        # Engine #211: default exec.command from exec.entry for script modes
        # when the author (often the LLM) omitted it. `.py` -> `python <entry>`,
        # `.sh` -> `bash <entry>`, `.js` -> `node <entry>`. Only fall back to the
        # hard error when we genuinely cannot derive a command (no entry).
        if self.mode == "pure-script" and not self.command:
            if self.entry:
                self.command = _default_command_from_entry(self.entry)
        # Validation: keep existing constraints.
        if self.mode == "pure-script" and not self.command:
            raise ValueError(f"exec.command is required when exec.mode is {self.mode!r}")
        if self.mode == "pure-script" and self.runtime == "none":
            raise ValueError("exec.runtime 'none' is only valid when exec.mode is agent")
        if self.runtime == "none" and self.command:
            raise ValueError("exec.runtime 'none' cannot declare exec.command")
        return self


class WorkerContractNetworkCapabilities(BaseModel):
    egress: bool = False


class WorkerContractCapabilities(BaseModel):
    secrets: List[str] = Field(default_factory=list)
    files: List[str] = Field(default_factory=list)
    network: WorkerContractNetworkCapabilities = Field(default_factory=WorkerContractNetworkCapabilities)


class WorkerContractTrigger(BaseModel):
    type: str = "manual"
    cron: Optional[str] = None
    timezone: Optional[str] = None
    webhook: Optional[WorkerWebhookConfig] = None
    composio: Optional[WorkerComposioTriggerConfig] = None

    @field_validator("type")
    @classmethod
    def normalize_type(cls, value: str) -> str:
        normalized = (value or "manual").strip().lower()
        if normalized in {"cron", "scheduled"}:
            return "schedule"
        return normalized

    @field_validator("cron")
    @classmethod
    def validate_cron(cls, value: Optional[str]) -> Optional[str]:
        if value is None or not value.strip():
            return value
        from cron_utils import is_valid_cron_expr

        if not is_valid_cron_expr(value):
            raise ValueError(f"invalid cron expression: {value!r}")
        return value

    @model_validator(mode="after")
    def validate_composio(self) -> "WorkerContractTrigger":
        if self.type == "composio" and not self.composio:
            raise ValueError("composio-triggered workers must declare trigger.composio")
        return self


class WorkerContract(BaseModel):
    schema_version: Literal["0.3"]
    name: str
    title: str
    description: str = ""
    long_description: Optional[str] = None
    use_cases: Optional[List[str]] = None
    example_input: Optional[Dict[str, Any]] = None
    example_output: Optional[str] = None
    how_it_works: Optional[str] = None
    is_example: Optional[bool] = None
    system_worker: Optional[bool] = None
    archived: bool = False
    archive_reason: Optional[str] = None
    # Visibility: controls who can see and run this worker.
    # "private"   — owner only (default)
    # "workspace" — all workspace members
    # Stored in worker.yml so it travels with the repo and is version-controlled.
    visibility: Optional[str] = None
    # Runtime gate: a smoke-disabled worker (its first test run failed) sets
    # paused=true in its manifest so the disable survives re-discovery
    # (`_persist_discovered_workers` reads `manifest.get("paused")` to compute
    # `enabled`). Without this field WorkerContract.model_dump() would drop it
    # and a re-discover would silently RE-ENABLE the broken worker (P0-1).
    paused: bool = False
    folder: Optional[str] = None
    version: str
    entrypoint: Optional[str] = "SKILL.md"
    system_prompt: Optional[str] = None
    model: Optional[str] = DEFAULT_WORKER_AGENT_MODEL
    entrypoints: Optional[List[WorkerEntrypoint]] = None
    limits: WorkerLimits = Field(default_factory=WorkerLimits)
    targets: List[str] = Field(default_factory=lambda: ["generic"])
    tags: Optional[List[str]] = None
    authors: List[WorkerContractAuthor] = Field(default_factory=list)
    license: Optional[str] = None
    homepage: Optional[str] = None
    repository: Optional[str] = None
    exec: WorkerContractExec
    capabilities: WorkerContractCapabilities = Field(default_factory=WorkerContractCapabilities)
    # Single trigger (legacy, backward compat). New manifests should use `triggers`.
    trigger: WorkerContractTrigger = Field(default_factory=WorkerContractTrigger)
    # Multiple triggers (new). If provided, `trigger` is derived from triggers[0].
    triggers: Optional[List[WorkerContractTrigger]] = None
    connections: List[WorkerConnectionSpec] = Field(default_factory=list)
    contexts: List[WorkerContextMountSpec] = Field(default_factory=list)
    csv_required_columns: Optional[List[str]] = None
    approvals: WorkerApprovals = Field(default_factory=WorkerApprovals)
    calls: List[str] = Field(default_factory=list)  # worker IDs this worker is allowed to invoke

    @model_validator(mode="before")
    @classmethod
    def fill_missing_description(cls, value: Any) -> Any:
        if isinstance(value, dict) and not str(value.get("description") or "").strip():
            fallback = str(value.get("title") or value.get("name") or "Workeros worker").strip()
            value = {**value, "description": fallback[:500]}
        return value

    @field_validator("name")
    @classmethod
    def validate_slug(cls, value: str) -> str:
        if not SLUG_PATTERN.fullmatch(value):
            raise ValueError(
                "name must be lowercase letters/digits/hyphens, 3-64 chars, start+end alphanumeric"
            )
        return value

    @field_validator("version")
    @classmethod
    def validate_semver(cls, value: str) -> str:
        if not SEMVER_PATTERN.fullmatch(value):
            raise ValueError("version must be semver, e.g. 0.1.0")
        return value

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("title is required")
        if len(value) > 120:
            raise ValueError("title must be 120 characters or fewer")
        return value

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("description is required")
        if len(value) > 500:
            raise ValueError("description must be 500 characters or fewer")
        return value

    @model_validator(mode="after")
    def resolve_exec_mode(self) -> "WorkerContract":
        if self.exec.mode is None:
            self.exec.mode = _resolve_legacy_exec_mode(self.exec)
        if self.exec.runtime == "none" and self.exec.mode != "agent":
            raise ValueError("exec.runtime 'none' is only valid when exec.mode is agent")
        if self.exec.runtime == "none" and self.exec.command:
            raise ValueError("exec.runtime 'none' cannot declare exec.command")
        if self.exec.runtime == "none" and (self.entrypoint or self.entrypoints):
            raise ValueError("exec.runtime 'none' cannot declare entrypoints")
        # Engine #211: default exec.command from exec.entry for script modes
        # (covers the legacy path where mode was resolved to pure-script above
        # from an entry but command was omitted).
        if self.exec.mode == "pure-script" and not self.exec.command and self.exec.entry:
            self.exec.command = _default_command_from_entry(self.exec.entry)
        if self.exec.mode == "pure-script" and not self.exec.command:
            raise ValueError(f"exec.command is required when exec.mode is {self.exec.mode!r}")
        # Canonicalize triggers: if `triggers` list present, use it; else derive from `trigger`.
        if self.triggers:
            # `trigger` field is first trigger for backward compat consumers.
            self.trigger = self.triggers[0]
        else:
            # No `triggers` list supplied: populate it from the single `trigger`.
            self.triggers = [self.trigger]
        return self

    @field_validator("long_description")
    @classmethod
    def validate_long_description(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        if len(value) > 2000:
            raise ValueError("long_description must be 2000 characters or fewer")
        return value

    @field_validator("use_cases")
    @classmethod
    def validate_use_cases(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        if value is None:
            return value
        if not 3 <= len(value) <= 5:
            raise ValueError("use_cases must contain 3 to 5 items")
        if any(not item.strip() for item in value):
            raise ValueError("use_cases items must be non-empty")
        return value

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        if value is None:
            return value
        if len(value) > 8:
            raise ValueError("tags must contain 8 items or fewer")
        if any("/" in tag or not tag.strip() for tag in value):
            raise ValueError("tags must be flat non-empty strings")
        return value

    @field_validator("folder")
    @classmethod
    def validate_folder(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        if len(value) > 64:
            raise ValueError("folder must be 64 characters or fewer")
        if value.startswith("/") or value.endswith("/") or ".." in value.split("/"):
            raise ValueError("folder must be a relative folder path")
        if not all(part.strip() for part in value.split("/")):
            raise ValueError("folder path segments must be non-empty")
        return value


WorkerManifest = WorkerConfig | WorkerContract


def _resolve_legacy_exec_mode(exec_config: WorkerContractExec) -> Literal["agent", "pure-script"]:
    # PR S11: entry-first. If `entry` is set, prefer the suffix-based inference.
    if exec_config.entry:
        return _infer_mode_from_entry(exec_config.entry)
    if exec_config.runtime in {"python311", "node22", "bash"} and exec_config.command:
        return "pure-script"
    return "agent"


def _lift_legacy_manifest_fields(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Lift legacy top-level inputs/outputs/secrets into the exec block.

    Authoring tools and example workers still emit the OSS schema (top-level
    ``inputs:`` etc.) even with ``schema_version: "0.3"``, while the 0.3
    ``WorkerContract`` requires them under ``exec``. Without this lift, pydantic
    silently drops the unknown top-level fields and the UI shows "This worker
    has no inputs", breaking the run form.

    Idempotent: a manifest that already has the field under ``exec`` is left
    unchanged. Emits a ``DeprecationWarning`` when it lifts anything so authors
    are nudged toward the canonical exec-scoped shape.
    """
    if not (
        isinstance(raw, dict)
        and raw.get("schema_version") == "0.3"
        and isinstance(raw.get("exec"), dict)
    ):
        return raw
    exec_block = raw["exec"]
    lifted: List[str] = []
    for legacy_key in ("inputs", "outputs", "secrets"):
        if raw.get(legacy_key) and not exec_block.get(legacy_key):
            exec_block[legacy_key] = raw[legacy_key]
            lifted.append(legacy_key)
    if lifted:
        warnings.warn(
            "Worker manifest (schema_version 0.3) declares "
            f"{', '.join(lifted)} at the top level; these belong under `exec`. "
            "Lifting them automatically for now, but this is deprecated and "
            "may stop working in a future schema version.",
            DeprecationWarning,
            stacklevel=2,
        )
    return raw


def _warn_legacy_composio_connections(raw: Dict[str, Any]) -> None:
    connections = raw.get("connections")
    if not isinstance(connections, list):
        return
    legacy_apps = sorted(
        {
            app
            for connection in connections
            if isinstance(connection, str)
            for app in [composio_connection_app_name(connection)]
            if app
        }
    )
    if not legacy_apps:
        return
    warnings.warn(
        "Legacy Composio connection strings are deprecated; migrate to structured "
        f"connections with explicit allowed_tools instead ({', '.join(legacy_apps)}).",
        DeprecationWarning,
        stacklevel=2,
    )


def parse_worker_manifest(raw: Dict[str, Any]) -> WorkerManifest:
    """Parse a worker manifest, using schema_version to select old vs new shape."""
    _warn_legacy_composio_connections(raw)
    if raw.get("schema_version") == "0.3":
        raw = _lift_legacy_manifest_fields(raw)
        return WorkerContract(**raw)
    return WorkerConfig(**raw)


def is_worker_contract(manifest: WorkerManifest) -> bool:
    return isinstance(manifest, WorkerContract)


def _contract_input_type(field: WorkerContractField) -> str:
    if field.kind == "file":
        return "file"
    if field.type == "select" or field.options:
        return "select"
    if field.type == "string":
        return "text"
    if field.type in {"textarea", "text", "number", "boolean"}:
        return field.type
    return field.type or "text"


def _contract_output_type(field: WorkerContractField) -> str:
    if field.kind == "file":
        media_type = field.media_type or ""
        if media_type == "text/markdown":
            return "markdown"
        if media_type == "text/csv":
            return "csv"
        if media_type == "application/json":
            return "json"
        return "file"
    if field.type in {"string", "text"}:
        return "text"
    if field.type == "select":
        return "text"
    return field.type or "text"


def worker_contract_to_worker_config(contract: WorkerContract, worker_id: str) -> WorkerConfig:
    """Project WorkerContract into the existing response/runtime config shape."""
    command_parts = contract.exec.command.strip().split() if contract.exec.command else []
    # PR S11: prefer exec.entry as the entrypoint signal.
    entrypoint = contract.exec.entry or contract.entrypoint or "SKILL.md"
    if contract.exec.mode == "pure-script":
        if contract.exec.entry:
            entrypoint = contract.exec.entry
        else:
            entrypoint = "run.py"
            if len(command_parts) >= 2 and command_parts[0].startswith("python"):
                entrypoint = command_parts[-1]
            elif command_parts:
                entrypoint = command_parts[-1]
    elif contract.entrypoints:
        entrypoint = contract.entrypoints[0].path

    runner = contract.exec.runner or "e2b"
    runtime = WorkerRuntime(
        type=contract.exec.runtime,
        entrypoint=entrypoint,
        runner=runner,
        command=contract.exec.command,
        mode=contract.exec.mode or "agent",
        model=contract.model or DEFAULT_WORKER_AGENT_MODEL,
        system_prompt=contract.system_prompt,
        disable_tools=list(contract.exec.disable_tools or []),
        limits=_model_data(contract.limits),
    )

    inputs = [
        WorkerInput(
            name=field.name,
            label=field.label or field.name.replace("_", " ").title(),
            type=_contract_input_type(field),
            required=field.required,
            placeholder=field.placeholder,
            description=field.description,
            options=field.options or ([str(value) for value in field.enum] if field.enum else None),
            default=field.default,
            accept_csv=field.accept_csv,
            accepts=field.accepts or ([field.media_type] if field.kind == "file" and field.media_type else None),
            max_size_mb=field.max_size_mb,
        )
        for field in contract.exec.inputs
    ]
    outputs = [
        WorkerOutput(
            name=field.name,
            label=field.label or field.name.replace("_", " ").title(),
            type=_contract_output_type(field),
            required=field.required,
            kind=field.kind,
            media_type=field.media_type,
            path=field.path,
            columns=field.columns,
            json_required_keys=field.json_required_keys,
        )
        for field in contract.exec.outputs
    ]
    return WorkerConfig(
        id=worker_id,
        name=contract.title,
        description=contract.description,
        model=contract.model,
        trigger=WorkerTrigger(
            type=contract.trigger.type,
            cron=contract.trigger.cron,
            timezone=contract.trigger.timezone,
            webhook=contract.trigger.webhook,
            composio=contract.trigger.composio,
        ),
        runtime=runtime,
        inputs=inputs,
        secrets=contract.exec.secrets,
        connections=[_model_data(connection) for connection in contract.connections],
        contexts=[
            _model_data(context)
            for context in (contract.contexts or contract.exec.contexts or [])
        ],
        outputs=outputs,
        csv_required_columns=contract.csv_required_columns,
        approvals=contract.approvals,
        calls=list(contract.calls),
    )


def _slug_from_worker_id(worker_id: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", worker_id.lower().replace("_", "-"))
    slug = re.sub(r"-+", "-", slug).strip("-")
    if len(slug) < 3:
        slug = f"{slug}-worker".strip("-")
    return slug[:64].strip("-")


def _legacy_input_to_contract_field(field: WorkerInput) -> WorkerContractField:
    if field.type == "file":
        media_type = field.accepts[0] if field.accepts else ("text/csv" if field.accept_csv else "application/octet-stream")
        return WorkerContractField(
            name=field.name,
            kind="file",
            media_type=media_type,
            path=f"inputs/{field.name}",
            required=field.required,
            label=field.label,
            description=field.description,
            placeholder=field.placeholder,
            accept_csv=field.accept_csv,
            accepts=field.accepts or [media_type],
            max_size_mb=field.max_size_mb,
        )
    scalar_type = {
        "text": "string",
        "textarea": "string",
        "number": "number",
        "boolean": "boolean",
        "select": "select",
    }.get(field.type, field.type)
    return WorkerContractField(
        name=field.name,
        kind="scalar",
        type=scalar_type,
        required=field.required,
        default=field.default,
        label=field.label,
        description=field.description,
        placeholder=field.placeholder,
        options=field.options,
        enum=field.options if field.type == "select" else None,
    )


def _legacy_output_to_contract_field(field: WorkerOutput) -> WorkerContractField:
    if field.type in {"markdown", "csv", "json", "file"}:
        media_type = {
            "markdown": "text/markdown",
            "csv": "text/csv",
            "json": "application/json",
            "file": "application/octet-stream",
        }[field.type]
        extension = {
            "markdown": "md",
            "csv": "csv",
            "json": "json",
            "file": "bin",
        }[field.type]
        return WorkerContractField(
            name=field.name,
            kind=field.kind or "file",
            media_type=field.media_type or media_type,
            path=field.path or f"out/{field.name}.{extension}",
            required=field.required,
            label=field.label,
            columns=field.columns,
            json_required_keys=field.json_required_keys,
        )
    scalar_type = "string" if field.type == "text" else field.type
    return WorkerContractField(
        name=field.name,
        kind=field.kind or "scalar",
        type=scalar_type,
        required=field.required,
        label=field.label,
    )


def worker_config_to_worker_contract(config: WorkerConfig, version: str = "0.1.0") -> WorkerContract:
    """Convert a legacy Workeros worker.yml config into WorkerContract shape."""
    return WorkerContract(
        schema_version="0.3",
        name=_slug_from_worker_id(config.id),
        title=config.name,
        description=config.description or config.name,
        version=version,
        entrypoint="SKILL.md",
        targets=["generic"],
        exec=WorkerContractExec(
            command=f"python {config.runtime.entrypoint or 'run.py'}",
            runtime="python311",
            runner=config.runtime.runner,
            mode=config.runtime.mode,
            entry=config.runtime.entrypoint or "run.py",
            inputs=[_legacy_input_to_contract_field(field) for field in config.inputs],
            secrets=list(config.secrets),
            outputs=[_legacy_output_to_contract_field(field) for field in config.outputs],
        ),
        system_prompt=config.runtime.system_prompt,
        model=config.runtime.model or config.model or DEFAULT_WORKER_AGENT_MODEL,
        limits=config.runtime.limits,
        capabilities=WorkerContractCapabilities(
            secrets=list(config.secrets),
            files=[field.name for field in config.inputs if field.type == "file"],
            network=WorkerContractNetworkCapabilities(egress=bool(config.secrets or config.connections)),
        ),
        trigger=WorkerContractTrigger(
            type=config.trigger.type,
            cron=config.trigger.cron,
            webhook=config.trigger.webhook,
            composio=config.trigger.composio,
        ),
        connections=[_model_data(connection) for connection in config.connections],
        contexts=[_model_data(context) for context in config.contexts],
        csv_required_columns=config.csv_required_columns,
    )


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class WorkerUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trigger_type: Optional[Literal["manual", "schedule", "cron", "webhook"]] = None
    cron_expr: Optional[str] = None
    cron_timezone: Optional[str] = None
    webhook_secret_rotate: Optional[bool] = None  # True → rotate secret, return new raw once
    input_values: Optional[Dict[str, Any]] = None
    capabilities: Optional[Dict[str, Any]] = None  # declared-not-enforced per T1c flip
    # #785: edit name/description from the worker detail modal without a full
    # PUT /workers/{id} YAML rewrite.
    name: Optional[str] = None
    description: Optional[str] = None


class RunCreate(BaseModel):
    inputs: Dict[str, Any] = Field(default_factory=dict)
    trigger_source: str = "manual"


class WorkerVisibilityUpdate(BaseModel):
    """Set a worker's visibility. ``specific_people`` is reserved (UI hides it)."""
    visibility: Literal["private", "workspace", "specific_people"]


class PaginationParams(BaseModel):
    limit: int = Field(50, ge=1, le=500)
    offset: int = Field(0, ge=0)


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class RunSummary(BaseModel):
    id: str
    worker_id: str
    worker_name: Optional[str] = None
    status: RunStatus
    trigger_source: str
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    duration_ms: Optional[int] = None
    error: Optional[str] = None  # operator-readable headline (never a raw traceback)
    error_code: Optional[str] = None


class LogEntry(BaseModel):
    level: LogLevel
    message: str
    timestamp: str
    trace_id: Optional[str] = None


class Artifact(BaseModel):
    id: str
    run_id: str
    name: str
    type: Optional[str] = None
    # PATH-1 (2026-05-29): `path` must NOT expose the absolute host path
    # (/root/workeros/data/artifacts/...). It now carries the path RELATIVE to
    # the artifacts root (e.g. "run_x/out/sorted.csv"); the download endpoint
    # resolves the real on-disk path server-side from the artifact id.
    path: str
    relative_path: Optional[str] = None
    size_bytes: Optional[int] = None
    created_at: str


class OutputField(BaseModel):
    name: str
    type: str  # "markdown", "json", "csv", "text", "file"
    label: str
    value: Any = None


class ToolCallEntry(BaseModel):
    id: str
    name: str
    arguments: Dict[str, Any] = Field(default_factory=dict)
    result: Optional[Any] = None
    error: Optional[str] = None


class ApprovalEntry(BaseModel):
    id: str
    status: str
    label: Optional[str] = None
    preview: Optional[str] = None
    created_at: str
    decided_at: Optional[str] = None
    reason: Optional[str] = None
    follow_up_run_id: Optional[str] = None


class RunDetail(BaseModel):
    id: str
    worker_id: str
    worker_name: Optional[str] = None
    status: RunStatus
    trigger_source: str
    runner: str
    input: Dict[str, Any] = Field(default_factory=dict)
    output: Dict[str, Any] = Field(default_factory=dict)
    outputs: Dict[str, Any] = Field(default_factory=dict)
    output_schema: List["OutputField"] = Field(default_factory=list)
    logs: List[LogEntry] = Field(default_factory=list)
    artifacts: List[Artifact] = Field(default_factory=list)
    transcript: List[Dict[str, Any]] = Field(default_factory=list)
    tool_calls: List["ToolCallEntry"] = Field(default_factory=list)
    approval_trail: Optional["ApprovalEntry"] = None
    can_replay: bool = False
    total_tokens: Optional[int] = None
    error: Optional[str] = None  # operator-readable headline (never a raw traceback)
    error_raw: Optional[str] = None  # raw error/traceback for the debug "Raw" tab; redacted of secrets
    error_code: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    duration_ms: Optional[int] = None
    created_at: Optional[str] = None
    queue_position: Optional[int] = None  # 1-based position in queue when status=queued


class RecentStats(BaseModel):
    last_run_at: Optional[str] = None   # ISO timestamp of most recent run
    runs_7d: int = 0                     # total runs in last 7 days
    success_rate_7d: Optional[float] = None  # fraction (0.0-1.0) or None if no runs
    success_rate_change_7d: Optional[float] = None  # current 7d rate minus previous 7d rate


class TimeseriesDay(BaseModel):
    """One day of run telemetry for the sparkline chart."""
    date: str        # "YYYY-MM-DD"
    total: int = 0
    completed: int = 0
    failed: int = 0


class TriggerSpec(BaseModel):
    """Structured representation of a single trigger for API responses."""
    type: str
    cron: Optional[str] = None
    timezone: Optional[str] = None
    webhook: Optional[Dict[str, Any]] = None
    composio: Optional[Dict[str, Any]] = None


class AssetPermissions(BaseModel):
    """Computed access matrix for the requesting user against an asset.

    Returned inline on worker list/detail so the web UI never infers access from
    role names. ``can_share`` gates the visibility (Share) control; ``can_edit``/
    ``can_delete`` gate the edit/delete affordances; ``can_run`` gates Run. On the
    OSS single-owner engine the local user owns their assets, so all are true for
    their own workers and a non-owned private worker is simply not returned.
    """
    is_owner: bool = True
    can_view: bool = True
    can_edit: bool = True
    can_run: bool = True
    can_delete: bool = True
    can_share: bool = True


class WorkerSummaryInput(BaseModel):
    """Lightweight input descriptor for worker list cards."""
    name: str
    type: str


class WorkerSummary(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    long_description: Optional[str] = None
    use_cases: Optional[List[str]] = None
    example_input: Optional[Dict[str, Any]] = None
    example_output: Optional[str] = None
    how_it_works: Optional[str] = None
    is_example: Optional[bool] = None
    # Engine/system worker (manifest system_worker:true, e.g. worker-author).
    # The API already excludes these from the default /workers view, but the
    # flag is carried on the payload so the web UI can defensively classify and
    # filter system/internal workers without hardcoding ids (Federico 2026-06-02).
    system: Optional[bool] = None
    archived: bool = False
    archive_reason: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    folder: Optional[str] = None
    status: WorkerStatus
    trigger_type: str
    runner: str
    last_run: Optional[RunSummary] = None
    triggers: List[str] = Field(default_factory=list)  # all configured trigger labels (display strings)
    triggers_spec: List[TriggerSpec] = Field(default_factory=list)  # structured trigger objects
    recent_stats: Optional[RecentStats] = None
    timeseries: Optional[List[TimeseriesDay]] = None  # 14-day sparkline data; None when not loaded
    connections: List[str] = Field(default_factory=list)  # Composio app slugs declared in worker.yml
    # #556: specific secrets/connections required by the worker that are not yet configured.
    missing_secrets: List[str] = Field(default_factory=list)
    missing_connections: List[str] = Field(default_factory=list)
    inputs: List[Union[WorkerInput, WorkerSummaryInput]] = Field(default_factory=list)  # input descriptors for worker-card icon composition
    runtime: Optional[str] = None  # exec.runtime ("skill", "python311", "node22", …)
    # Owner-only signed share link to the standalone public worker page
    # (/w/<id>?token=<hmac>). Lets the worker card render a Share affordance
    # without a second fetch. Same deterministic HMAC as WorkerDetail.public_link.
    public_link: Optional[str] = None
    # Members STEP 1: ownership + per-asset visibility + computed permissions.
    owner_id: Optional[str] = None
    visibility: str = "private"
    starred: bool = False  # #782: per-user favorite flag
    permissions: AssetPermissions = Field(default_factory=AssetPermissions)


class WorkerFile(BaseModel):
    path: str           # relative path from worker root, e.g. "SKILL.md", "lib/helpers.py"
    language: str       # "markdown", "python", "yaml", "json", "text"
    content: Optional[str] = None   # utf-8 string; None when binary=True
    binary: bool = False
    size: int = 0


class WorkerDetail(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    long_description: Optional[str] = None
    use_cases: Optional[List[str]] = None
    example_input: Optional[Dict[str, Any]] = None
    example_output: Optional[str] = None
    how_it_works: Optional[str] = None
    is_example: Optional[bool] = None
    archived: bool = False
    # P2 (2026-05-29): expose whether the worker is enabled (NOT paused) so the
    # UI can disable the Run affordance on a paused worker instead of letting the
    # operator click into a dead-end 409. Defaults true (a normal active worker).
    enabled: bool = True
    archive_reason: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    folder: Optional[str] = None
    status: WorkerStatus
    trigger_type: str
    runner: str
    config: WorkerConfig
    recent_stats: Optional[RecentStats] = None
    recent_runs: List[RunSummary] = Field(default_factory=list)
    manifest_yaml: Optional[str] = None  # Raw worker.yml content for manifest viewer
    run_py: Optional[str] = None
    skill_md_content: Optional[str] = None  # Raw SKILL.md content
    run_py_content: Optional[str] = None  # Alias for run_py, explicit for Code tab
    new_webhook_secret: Optional[str] = None  # Present only on webhook_secret_rotate=true
    webhook_url: Optional[str] = None  # Full webhook URL (only when trigger includes webhook)
    files: List[WorkerFile] = Field(default_factory=list)  # All files in the worker dir
    triggers_spec: List[TriggerSpec] = Field(default_factory=list)  # structured trigger objects (all triggers)
    # #556: specific secrets/connections required by the worker that are not yet configured.
    missing_secrets: List[str] = Field(default_factory=list)
    missing_connections: List[str] = Field(default_factory=list)
    # Owner-only signed share link to the standalone public worker page
    # (/w/<id>?token=<hmac>). Mirrors the approval `public_link` pattern: the
    # token is a deterministic HMAC the /workers/public/* route verifies, so the
    # owner can copy this URL to share a read-only "skill card" view of the
    # worker with anyone — no secrets, source, or run history are exposed there.
    public_link: Optional[str] = None
    # Set on the response of an edit that transparently forked a read-only stock
    # worker into a user-owned editable copy (clone-on-edit). Carries the source
    # stock worker id so the UI can show "editing created your copy" and redirect
    # the operator to the new worker (whose `id` differs from the URL they were
    # on). None for a normal in-place edit.
    cloned_from: Optional[str] = None
    # Members STEP 1: ownership + per-asset visibility + computed permissions.
    owner_id: Optional[str] = None
    visibility: str = "private"
    starred: bool = False  # #782: per-user favorite flag
    permissions: AssetPermissions = Field(default_factory=AssetPermissions)


class PublicWorkerInput(BaseModel):
    """Input descriptor exposed on the public share page.

    Deliberate allow-list mirror of ``WorkerInput`` that drops fields a public
    viewer has no business seeing (e.g. nothing sensitive lives here today, but
    keeping a dedicated model means a future field added to ``WorkerInput`` is
    NOT silently leaked to the public surface — it must be added here on purpose).
    """
    name: str
    label: str
    type: str
    required: bool = False
    description: Optional[str] = None
    options: Optional[List[str]] = None


class PublicWorkerOutput(BaseModel):
    """Output descriptor exposed on the public share page (allow-list)."""
    name: str
    label: str
    type: str


class PublicWorker(BaseModel):
    """Read-only, owner-scoped projection of a worker for a signed share link.

    This is a STRICT allow-list. The public endpoint NEVER returns the full
    ``WorkerDetail`` object — only the fields enumerated here. Secrets, source
    files, run history, the owner id, the webhook URL, and any config internals
    (bundle paths, MCP urls/env/commands) are intentionally absent. See
    ``_public_worker_response`` for the projection and
    ``tests/test_worker_share_public.py`` for the no-leak guarantees.
    """
    id: str
    name: str
    description: Optional[str] = None
    long_description: Optional[str] = None
    use_cases: Optional[List[str]] = None
    how_it_works: Optional[str] = None
    is_example: Optional[bool] = None
    tags: List[str] = Field(default_factory=list)
    example_input: Optional[Dict[str, Any]] = None
    example_output: Optional[str] = None
    trigger_type: str
    runtime: Optional[str] = None
    # Tool/connection display only: Composio app slugs + MCP server LABELS.
    # No MCP urls, env, commands, or auth values are exposed.
    connections: List[str] = Field(default_factory=list)
    inputs: List[PublicWorkerInput] = Field(default_factory=list)
    outputs: List[PublicWorkerOutput] = Field(default_factory=list)


class SecretItem(BaseModel):
    name: str
    status: SecretStatus
    last_used_at: Optional[str] = None
    last_checked_at: Optional[str] = None
    last_check_status: Optional[str] = None
    used_by: List[str] = Field(default_factory=list)


class ReloadResponse(BaseModel):
    status: str
    workers_loaded: int


class ActionResponse(BaseModel):
    status: str
    run_id: Optional[str] = None


class McpToolItem(BaseModel):
    id: str
    name: str
    description: str
    input_schema: Dict[str, Any] = Field(default_factory=dict)
    worker_id: str
    created_at: str
    updated_at: str


class McpToolCreate(BaseModel):
    name: str
    description: str
    input_schema: Dict[str, Any] = Field(default_factory=dict)
    worker_id: str


class McpToolUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    input_schema: Optional[Dict[str, Any]] = None
    worker_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Domain types for worker execution
# ---------------------------------------------------------------------------

class ConnectionsNamespace:
    """Provides attribute-style access to Composio connections.

    Usage in worker: context.connections.gmail  → composio_connection_id str
    Raises AttributeError with a helpful message for missing/inactive connections.
    """

    def __init__(self, connection_ids: Dict[str, str]):
        # app_name → composio_connection_id
        self._ids = connection_ids

    def __getattr__(self, app_name: str) -> str:
        if app_name.startswith("_"):
            raise AttributeError(app_name)
        conn_id = self._ids.get(app_name)
        if not conn_id:
            raise AttributeError(
                f"Connection '{app_name}' is not active. "
                f"Connect it at /connections first."
            )
        return conn_id

    def get(self, app_name: str) -> Optional[str]:
        return self._ids.get(app_name)

    def __contains__(self, app_name: str) -> bool:
        return app_name in self._ids


class WorkerContext:
    """Typed context passed to worker run() functions.

    Provides:
      - log(msg, level="info")     → structured logging
      - secrets                    → dict of resolved secrets
      - connections.<app>          → Composio connection ID for app
      - run_id, worker_id          → execution identifiers
      - artifact_dir               → writable output directory
      - trace_id                   → observability trace ID

    Backwards compatibility: supports dict-style access so existing
    workers using ``context["log"]`` continue to work.
    """

    def __init__(
        self,
        run_id: str,
        worker_id: str,
        secrets: Dict[str, str],
        artifact_dir: str,
        trace_id: str,
        log_fn,
        connection_ids: Optional[Dict[str, str]] = None,
    ):
        self.run_id = run_id
        self.worker_id = worker_id
        self._secrets = secrets
        self.artifact_dir = artifact_dir
        self.trace_id = trace_id
        self._log_fn = log_fn
        self.connections = ConnectionsNamespace(connection_ids or {})

    def log(self, message: str, level: str = "info"):
        self._log_fn(message, level=level)

    @property
    def secrets(self) -> Dict[str, str]:
        return self._secrets

    def get_secret(self, name: str) -> Optional[str]:
        return self._secrets.get(name)

    # Dict-style access for backwards compatibility
    def __getitem__(self, key: str):
        if key == "log":
            return self._log_fn
        if key == "secrets":
            return self._secrets
        if key == "run_id":
            return self.run_id
        if key == "worker_id":
            return self.worker_id
        if key == "artifact_dir":
            return self.artifact_dir
        if key == "trace_id":
            return self.trace_id
        if key == "connections":
            return self.connections
        raise KeyError(key)

    def __contains__(self, key: str) -> bool:
        return key in {"log", "secrets", "run_id", "worker_id", "artifact_dir", "trace_id", "connections"}


class WorkerResult(BaseModel):
    """Standard result type returned by worker run() functions."""

    status: str  # "success" | "error"
    outputs: Dict[str, Any] = Field(default_factory=dict)
    artifacts: List[Dict[str, Any]] = Field(default_factory=list)
    error: Optional[str] = None
    error_code: Optional[str] = None  # e.g. "validation_error", "timeout"
    retryable: bool = False
    # S47 HITL: present when a worker requests human approval before executing.
    # Contains {label: str, preview: str} as emitted by the worker in result.json.
    decision_required: Optional[Dict[str, Any]] = None


class StructuredLog(BaseModel):
    """Structured log entry for observability."""

    trace_id: str
    run_id: str
    worker_id: str
    level: LogLevel
    message: str
    timestamp: str
    duration_ms: Optional[int] = None
    attributes: Optional[Dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Retry / notify config (added to WorkerConfig as optional fields)
# ---------------------------------------------------------------------------

class RetryConfig(BaseModel):
    """Automatic retry policy when a run fails."""

    max_attempts: int = Field(default=3, ge=1, le=10)
    delay_seconds: int = Field(default=60, ge=0, le=3600)
    # "all" retries every error; list specific error_codes to be selective
    on: List[str] = Field(default_factory=lambda: ["all"])


class NotifyConfig(BaseModel):
    """Notification channels fired on run completion events.

    Supports webhook (url) and/or email (email_to) — at least one required.
    Email delivery uses Resend via server-side RESEND_API_KEY.
    """

    # Webhook channel
    url: Optional[str] = None
    # Email channel — list of recipient addresses
    email_to: Optional[List[str]] = None
    # Events to fire on: "failed", "completed", or both
    on: List[str] = Field(default_factory=lambda: ["failed"])
    # Optional HMAC secret for webhook — sent as X-Workeros-Signature header
    secret: Optional[str] = None
    # Optional custom email subject (supports {worker_name} and {status} placeholders)
    email_subject: Optional[str] = None


# ---------------------------------------------------------------------------
# Alert (webhook) response shapes
# ---------------------------------------------------------------------------

class WorkerAlert(BaseModel):
    """A registered alert for a worker (webhook and/or email)."""

    id: str
    worker_id: str
    url: Optional[str] = None
    email_to: Optional[List[str]] = None
    on: List[str]  # events: ["failed"], ["completed"], ["failed","completed"]
    description: Optional[str] = None
    created_at: str


class WorkerAlertCreate(BaseModel):
    # Webhook channel (optional — provide url for webhook delivery)
    url: Optional[str] = None
    # Email channel (optional — provide email_to for Resend delivery)
    email_to: Optional[List[str]] = None
    on: List[str] = Field(default_factory=lambda: ["failed"])
    description: Optional[str] = None


# ---------------------------------------------------------------------------
# Worker feedback (SPEC §12 — lightweight comment anyone who can SEE can leave)
# ---------------------------------------------------------------------------

class WorkerFeedback(BaseModel):
    """A feedback comment left on a worker, surfaced to the owner (SPEC §12)."""

    id: str
    worker_id: str
    author_id: str
    author_name: Optional[str] = None
    content: str
    created_at: str


class WorkerFeedbackCreate(BaseModel):
    content: str


# ---------------------------------------------------------------------------
# Stats response shapes
# ---------------------------------------------------------------------------

class WorkerStats(BaseModel):
    """Extended health and run statistics for a single worker."""

    worker_id: str
    last_run_at: Optional[str] = None
    runs_7d: int = 0
    success_rate_7d: Optional[float] = None
    success_rate_change_7d: Optional[float] = None
    runs_30d: int = 0
    success_rate_30d: Optional[float] = None
    avg_duration_ms: Optional[float] = None
    p95_duration_ms: Optional[float] = None
    total_failures: int = 0
    last_error: Optional[str] = None
    last_error_at: Optional[str] = None


class WorkspaceStats(BaseModel):
    """Aggregate stats across the entire workspace."""

    total_workers: int = 0
    active_workers: int = 0  # ran at least once in the last 7 days
    total_runs_7d: int = 0
    success_rate_7d: Optional[float] = None
    avg_duration_ms: Optional[float] = None
    most_active_worker_id: Optional[str] = None
    most_active_worker_name: Optional[str] = None
