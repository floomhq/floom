"""Pydantic models for Workeros: request schemas, response schemas, and domain types."""

import ipaddress
import os
import re
import socket
import warnings
from typing import Any, Dict, Iterable, List, Literal, Mapping, Optional, Tuple, Union
from urllib.parse import unquote, urlsplit
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from enum import Enum
from runtime_limits import MAX_RUN_TIMEOUT_SECONDS


# The tool-calling worker default. MUST be resolved lazily (at call time), not
# frozen at import. On the cloud the model env vars arrive via
# `load_dotenv(~/.config/workeros/api.env, override=False)` in main.py — which
# runs AFTER `from models import ...`. A module-level constant read here would
# freeze to the bare "gpt-5.5" fallback (→ OpenAI) before dotenv injects
# WORKEROS_WORKER_AGENT_MODEL=bedrock/..., so worker runs hit the (dead/quota'd)
# OpenAI key while Emily — which reads WORKEROS_CHAT_MODEL lazily — works.
# Resolve at call time so the live env (whatever delivery mechanism set it) wins.
_WORKER_AGENT_MODEL_FALLBACK = "gpt-5.5"


def default_worker_agent_model() -> str:
    """Resolve the default worker-agent model from the live env, lazily.

    Reads WORKEROS_WORKER_AGENT_MODEL every call so config delivered after import
    (cloud dotenv path) is honored. Falls back to the bare OpenAI model only when
    nothing is configured.
    """
    return os.environ.get("WORKEROS_WORKER_AGENT_MODEL") or _WORKER_AGENT_MODEL_FALLBACK


# Backwards-compatible name. Kept as the import-time snapshot ONLY for callers
# that need a literal default; live dispatch paths MUST use
# default_worker_agent_model() instead (see agent_driver / contract builders).
DEFAULT_WORKER_AGENT_MODEL = default_worker_agent_model()


def _model_data(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return value


def _validate_timezone_name(value: Optional[str]) -> Optional[str]:
    if value is None or not value.strip():
        return value
    stripped = value.strip()
    try:
        from zoneinfo import ZoneInfo

        ZoneInfo(stripped)
    except Exception as exc:
        raise ValueError(f"invalid timezone: {stripped!r}") from exc
    return stripped


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


class WorkerNotRunnableError(ValueError):
    """Raised by a RunsRepo.create when the caller may not run the target worker
    (a genuine cross-tenant ownership denial — the worker is neither owned by the
    caller, workspace-shared, nor a curated catalog/stock worker).

    Subclasses ValueError so the generic ValueError handler still treats it
    safely if uncaught, but the run endpoint catches it explicitly to return a
    clear 403 instead of the opaque 400 'Invalid request'."""


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


def pinned_safe_outbound_httpx_target(
    url: str,
    *,
    label: str = "URL",
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    """Return a DNS-pinned httpx target for an outbound URL.

    The URL is resolved and validated exactly once. Hostname URLs are rewritten
    to dial the vetted IP literal, while the returned Host header and
    ``sni_hostname`` extension preserve the original authority for HTTP and TLS.
    """
    stripped = (url or "").strip()

    _once = unquote(stripped)
    _twice = unquote(_once)
    if any("\r" in s or "\n" in s for s in (stripped, _once, _twice)):
        raise UnsafeOutboundUrlError(
            f"{label} is not allowed: contains control characters (CRLF injection)"
        )

    if _allow_private_mcp_urls():
        return stripped, {}, {}

    parts = urlsplit(stripped)
    scheme = parts.scheme.lower()
    if scheme not in {"http", "https"}:
        raise UnsafeOutboundUrlError(
            f"{label} is not allowed: only http:// and https:// schemes are permitted"
        )

    host = parts.hostname
    if not host:
        raise UnsafeOutboundUrlError(f"{label} is not allowed: missing host")

    try:
        port = parts.port
    except ValueError as exc:
        raise UnsafeOutboundUrlError(f"{label} is not allowed: invalid port") from exc

    try:
        literal_ip = ipaddress.ip_address(host)
    except ValueError:
        literal_ip = None

    if literal_ip is not None:
        if _ip_is_disallowed(literal_ip):
            raise UnsafeOutboundUrlError(
                f"{label} is not allowed: points to an internal/loopback/link-local address"
            )
        return stripped, {}, {}

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

    pinned_ip = resolved[0]
    pinned_host = f"[{pinned_ip}]" if pinned_ip.version == 6 else str(pinned_ip)
    port_suffix = f":{port}" if port is not None else ""
    userinfo = ""
    if "@" in parts.netloc:
        userinfo = parts.netloc.rsplit("@", 1)[0] + "@"
    pinned_url = parts._replace(netloc=f"{userinfo}{pinned_host}{port_suffix}").geturl()

    host_header = f"[{host}]" if ":" in host and not host.startswith("[") else host
    if port is not None:
        host_header = f"{host_header}:{port}"
    extensions = {"sni_hostname": host} if scheme == "https" else {}
    return pinned_url, {"Host": host_header}, extensions


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

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: Optional[str]) -> Optional[str]:
        return _validate_timezone_name(value)


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
    # #1433: optional per-run mount predicate. Example:
    # contexts:
    #   - name: novasearch-data
    #     when: {input: operation, not_in: [profile]}
    # Existing mounts omit this and are always staged.
    when: Optional[Dict[str, Any]] = None

    def model_dump(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        kwargs.setdefault("exclude_none", True)
        return super().model_dump(*args, **kwargs)

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


class WorkerMemoryConfig(BaseModel):
    enabled: bool = True
    context: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def coerce_memory_config(cls, value: Any) -> Any:
        if value is None:
            return {}
        if isinstance(value, bool):
            return {"enabled": value}
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"enabled", "enable", "true", "yes", "on", "1"}:
                return {"enabled": True}
            if normalized in {"disabled", "disable", "false", "no", "off", "0"}:
                return {"enabled": False}
            return {"enabled": True, "context": value}
        if isinstance(value, dict):
            raw = dict(value)
            if "context" not in raw:
                for alias in ("name", "pack", "pack_name", "context_name"):
                    if raw.get(alias):
                        raw["context"] = raw[alias]
                        break
            return raw
        return value

    @field_validator("context")
    @classmethod
    def validate_context(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        stripped = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", stripped):
            raise ValueError(
                "memory.context must be 1-64 letters, digits, dots, underscores, or hyphens"
            )
        return stripped


def default_worker_memory_context_name(worker_id: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", str(worker_id or "worker")).strip(".-_")
    slug = slug or "worker"
    return f"memory-{slug}"[:64].rstrip(".-_") or "memory-worker"


def memory_context_mount_for_worker(worker_id: str, memory: WorkerMemoryConfig) -> Optional[dict[str, Any]]:
    if not memory.enabled:
        return None
    return {
        "name": memory.context or default_worker_memory_context_name(worker_id),
        "writeable": True,
        "source": "local",
    }


def _normalize_memory_contexts(
    worker_id: str,
    memory: WorkerMemoryConfig,
    contexts: List[WorkerContextMountSpec],
) -> List[WorkerContextMountSpec]:
    memory_mount = memory_context_mount_for_worker(worker_id, memory)
    if memory_mount is None:
        return contexts

    normalized_contexts = list(contexts or [])
    memory_name = memory_mount["name"]
    for idx, raw_context in enumerate(normalized_contexts):
        try:
            context = raw_context.model_dump() if hasattr(raw_context, "model_dump") else raw_context
            normalized = WorkerContextMount(**context) if isinstance(context, dict) else WorkerContextMount(name=str(context))
        except Exception:
            continue
        if normalized.name != memory_name:
            continue
        if normalized.source == "local":
            normalized_contexts[idx] = WorkerContextMount(
                name=memory_name,
                writeable=True,
                source="local",
            )
        return normalized_contexts

    normalized_contexts.append(WorkerContextMount(**memory_mount))
    return normalized_contexts


class WorkerResources(BaseModel):
    memory_mb: Optional[int] = Field(default=None, ge=128)
    cpu_count: Optional[int] = Field(default=None, ge=1)

    @field_validator("memory_mb", mode="after")
    @classmethod
    def _clamp_memory_mb(cls, value: Optional[int]) -> Optional[int]:
        if value is None:
            return None
        return min(value, _ceiling_from_env("WORKEROS_MAX_WORKER_MEMORY_MB", 8192))

    @field_validator("cpu_count", mode="after")
    @classmethod
    def _clamp_cpu_count(cls, value: Optional[int]) -> Optional[int]:
        if value is None:
            return None
        return min(value, _ceiling_from_env("WORKEROS_MAX_WORKER_CPU_COUNT", 8))


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
    # #1448: a worker that makes heavy/bursty LLM calls (e.g. a judge fan-out)
    # declares this so the run scheduler can space concurrent heavy runs under a
    # shared provider-quota budget (WORKEROS_MAX_CONCURRENT_LLM_RUNS) instead of
    # letting them stack and 429 the shared provider. Default false = no gating.
    llm_intensive: bool = False
    trigger: WorkerTrigger
    runtime: WorkerRuntime
    inputs: List[WorkerInput] = []
    secrets: List[str] = []
    connections: List[WorkerConnectionSpec] = []  # Strings are deprecated legacy Composio app slugs.
    contexts: List[WorkerContextMountSpec] = []
    memory: WorkerMemoryConfig = Field(default_factory=WorkerMemoryConfig)
    resources: WorkerResources = Field(default_factory=WorkerResources)
    outputs: List[WorkerOutput] = []
    csv_required_columns: Optional[List[str]] = None  # Column names for the CSV mapper wizard
    approvals: WorkerApprovals = Field(default_factory=WorkerApprovals)
    capabilities: Optional["WorkerContractCapabilities"] = None
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
        self.contexts = _normalize_memory_contexts(self.id, self.memory, self.contexts)
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


def _ceiling_from_env(env_key: str, default: int) -> int:
    raw = os.environ.get(env_key)
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return default


class WorkerLimits(BaseModel):
    max_tool_iterations: int = Field(default=12, ge=1)
    max_output_tokens: int = Field(default=1000000, ge=1)
    max_total_tokens: int = Field(default=1000000, ge=1)
    timeout_seconds: int = Field(default=300, ge=1, le=MAX_RUN_TIMEOUT_SECONDS)
    # #793: per-worker monthly spend cap in USD. None = unlimited. Enforced at
    # dispatch: a run is refused (failed, error_code=spend_cap_exceeded) when
    # the worker's month-to-date cost has already reached the cap.
    max_monthly_cost_usd: Optional[float] = Field(default=None, ge=0)

    # #1067/#1114 — author-supplied token budgets remain clamped to operator
    # maxima; run timeout is rejected above MAX_RUN_TIMEOUT_SECONDS by the Field
    # bound so oversized long-running workers fail validation instead of being
    # silently truncated.
    @field_validator("max_output_tokens", mode="after")
    @classmethod
    def _clamp_max_output_tokens(cls, v: int) -> int:
        return min(v, _ceiling_from_env("FLOOM_MAX_OUTPUT_TOKENS", 1_000_000))

    @field_validator("max_total_tokens", mode="after")
    @classmethod
    def _clamp_max_total_tokens(cls, v: int) -> int:
        return min(v, _ceiling_from_env("FLOOM_MAX_TOTAL_TOKENS", 2_000_000))

    @field_validator("max_monthly_cost_usd", mode="after")
    @classmethod
    def _clamp_max_monthly_cost(cls, v: Optional[float]) -> Optional[float]:
        # None stays unlimited (deployment policy may add a global cap); a
        # provided value is clamped to the operator ceiling.
        if v is None:
            return None
        return min(v, float(_ceiling_from_env("FLOOM_MAX_MONTHLY_COST_USD", 100_000)))


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
    resources: WorkerResources = Field(default_factory=WorkerResources)
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
    allow_out: List[str] = Field(default_factory=list)
    deny_out: List[str] = Field(default_factory=list)


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

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: Optional[str]) -> Optional[str]:
        return _validate_timezone_name(value)

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
    model: Optional[str] = Field(default_factory=default_worker_agent_model)
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
    memory: WorkerMemoryConfig = Field(default_factory=WorkerMemoryConfig)
    resources: WorkerResources = Field(default_factory=WorkerResources)
    csv_required_columns: Optional[List[str]] = None
    approvals: WorkerApprovals = Field(default_factory=WorkerApprovals)
    calls: List[str] = Field(default_factory=list)  # worker IDs this worker is allowed to invoke

    @model_validator(mode="before")
    @classmethod
    def fill_missing_description(cls, value: Any) -> Any:
        if isinstance(value, dict) and not str(value.get("description") or "").strip():
            fallback = str(value.get("title") or value.get("name") or "Workeros worker").strip()
            value = {**value, "description": fallback[:500]}
        if isinstance(value, dict) and "resources" not in value:
            exec_block = value.get("exec")
            if isinstance(exec_block, dict) and isinstance(exec_block.get("resources"), dict):
                value = {**value, "resources": exec_block["resources"]}
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
        model=contract.model or default_worker_agent_model(),
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
        memory=contract.memory,
        resources=contract.resources,
        outputs=outputs,
        csv_required_columns=contract.csv_required_columns,
        approvals=contract.approvals,
        capabilities=_model_data(contract.capabilities),
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
        model=config.runtime.model or config.model or default_worker_agent_model(),
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
        memory=config.memory,
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

    @field_validator("cron_timezone")
    @classmethod
    def validate_cron_timezone(cls, value: Optional[str]) -> Optional[str]:
        return _validate_timezone_name(value)


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
    trigger_member_id: Optional[str] = None
    trigger_member_email: Optional[str] = None
    # #1022: the run's actual input (the "mandate"/request that was searched),
    # parsed from input_json. Surfaced so GET /runs is a queryable request log
    # (run_id -> input) without an N+1 of per-run detail fetches. Returned only on
    # authed-owner routes (GET /runs, /connections/{id}/activity); no public/share
    # surface uses RunSummary — those return RunDetail, which redacts separately.
    input: Dict[str, Any] = Field(default_factory=dict)
    inputs: Dict[str, Any] = Field(default_factory=dict)


class DetailArtifactPreview(BaseModel):
    name: str
    size: Optional[int] = None


class DetailLastRun(RunSummary):
    finished_at: Optional[str] = None
    output_preview: Optional[str] = None
    artifacts: List[DetailArtifactPreview] = Field(default_factory=list)


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
    inputs: Dict[str, Any] = Field(default_factory=dict)
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
    # filter system/internal workers without hardcoding ids (the operator 2026-06-02).
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
    last_run: Optional[DetailLastRun] = None
    recent_stats: Optional[RecentStats] = None
    recent_runs: List[RunSummary] = Field(default_factory=list)
    # #815: output-first overview — the most recent completed run's output +
    # its run id, so the detail page can show "latest result" without a second
    # round-trip. None when the worker has never produced output.
    latest_output: Optional[Dict[str, Any]] = None
    latest_output_run_id: Optional[str] = None
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


class VersionSummary(BaseModel):
    id: str           # 7-char git SHA
    sha: str          # same 7-char git SHA
    message: str      # commit message
    author: str       # git author name
    timestamp: str    # ISO 8601 commit date
    asset_type: str   # kept for API compat
    asset_id: str     # kept for API compat
    change_source: Optional[str] = None


class _WorkerSuggestion(BaseModel):
    field: str
    current: str
    suggested: str
    reason: str


class _WorkerSuggestResponse(BaseModel):
    has_conflicts: bool
    suggestions: list[_WorkerSuggestion]


class _WorkerSuggestRequest(BaseModel):
    new_description: str


class _ImportFromShareRequest(BaseModel):
    token: str


class WorkerCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    worker_yml: str
    run_py: str
    skill_md: Optional[str] = None


class SecretWarning(BaseModel):
    """A masked secret-detection finding. NEVER carries the raw value."""

    pattern: str
    line: int
    masked: str


class ContextWorkerRef(BaseModel):
    worker_id: str
    worker_name: str


class ContextSummary(BaseModel):
    name: str
    file_count: int
    total_size_bytes: int
    updated_at: Optional[str] = None
    writeable: bool = False
    worker_count: int = 0
    description: Optional[str] = None
    # Engine/system knowledge packs (e.g. worker-author-style) are surfaced
    # read-only so operators can SEE what shapes worker generation, but cannot
    # edit or delete them. Operator-created packs have system=False.
    system: bool = False
    read_only: bool = False
    category: Optional[str] = None  # #780: content-category tag
    # Sensitive packs are never committed to git or pushed to GitHub.
    # Sensitive is the DEFAULT — set sensitive=False to opt in to git tracking.
    sensitive: bool = True
    # Members STEP 4: ownership + per-asset visibility + computed permissions.
    # Mirrors the worker surface so the same Share control renders on brain packs.
    owner_id: Optional[str] = None
    visibility: str = "private"
    permissions: AssetPermissions = Field(default_factory=AssetPermissions)


class ContextFileItem(BaseModel):
    path: str
    size: int
    mime_type: str
    updated_at: str
    is_binary: bool
    description: Optional[str] = None
    display_type: str = "File"
    tags: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    # Set when the file's content matched a high-confidence secret pattern.
    # The UI badges these so operators can move the credential to Secrets.
    has_secret_warning: bool = False
    # Populated only on the write/upload response (and the audit scan), so the
    # operator sees WHAT was detected (masked) without re-scanning. Never
    # persisted to disk, never contains the raw value.
    secret_warnings: List[SecretWarning] = Field(default_factory=list)
    # Set on a restore response when the restored version was a "deleted"
    # snapshot, so the History UI knows the file was removed (not written).
    deleted: bool = False


class ContextDetail(ContextSummary):
    files: List[ContextFileItem] = Field(default_factory=list)
    used_by: List[ContextWorkerRef] = Field(default_factory=list)


class ContextCategoryRequest(BaseModel):
    category: Optional[str] = None  # #780; empty/null clears it


class ContextCreateRequest(BaseModel):
    writeable: bool = False
    # Sensitive (the default) excludes the context from git versioning — it may
    # hold credentials. Set false to opt the context into git history (versions,
    # rollback). See contexts.is_context_sensitive.
    sensitive: bool = True
    category: Optional[str] = None  # #780: content-category tag


class ContextDeleteResponse(BaseModel):
    status: str
    referenced_by: List[str] = Field(default_factory=list)


class ContextFileMoveRequest(BaseModel):
    new_path: str  # #770: destination path within the same context


class ContextSecretScanFile(BaseModel):
    path: str
    secret_warnings: List[SecretWarning] = Field(default_factory=list)


class ContextSecretScanResponse(BaseModel):
    name: str
    scanned_files: int
    flagged_files: List[ContextSecretScanFile] = Field(default_factory=list)


class ContextSensitiveRequest(BaseModel):
    sensitive: bool


class ContextTextWriteRequest(BaseModel):
    content: str
    tags: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None


class CandidateFeedbackCreateRequest(BaseModel):
    run_id: str = Field(min_length=1, max_length=200)
    candidate_id: str = Field(min_length=1, max_length=200)
    rank: int
    feedback_text: str = Field(min_length=1, max_length=10000)
    outcome: Literal["good", "bad", "miss"]
    scope: Literal["global", "client"] = "global"
    reporter: Optional[str] = Field(default=None, max_length=200)


class CandidateFeedbackRecord(BaseModel):
    uuid: str
    run_id: str
    candidate_id: str
    rank: int
    feedback_text: str
    outcome: Literal["good", "bad", "miss"]
    scope: Literal["global", "client"]
    reporter: str
    ts: str
    path: str


class ContextUploadResponse(BaseModel):
    files: List[ContextFileItem]
    total_size_bytes: int


class ContextVisibilityUpdate(BaseModel):
    """Set a brain pack's visibility. ``specific_people`` reserved (UI hides it)."""
    visibility: Literal["private", "workspace", "specific_people"]


class _SqliteView(BaseModel):
    tables: List[str] = Field(default_factory=list)
    table: Optional[str] = None
    columns: Optional[List[str]] = None
    rows: Optional[List[List[Any]]] = None
    row_count: Optional[int] = None
    truncated: Optional[bool] = None


class WorkspaceMemberOut(BaseModel):
    workspace_id: str
    user_id: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    role: Literal["owner", "admin", "member"]
    status: Literal["active", "invited", "removed"] = "active"
    invited_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class WorkspaceMembersResponse(BaseModel):
    """Members list + the caller's own identity/role so the web UI gates the
    invite / change-role / remove / transfer affordances without re-deriving
    authority from member rows."""

    members: List[WorkspaceMemberOut]
    workspace_id: str
    my_user_id: str
    my_role: Optional[Literal["owner", "admin", "member"]] = None


class WorkspaceMemberInviteRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    # ``owner`` is rejected (use transfer ownership); default to the least
    # privileged role, matching Notion/Linear invite defaults.
    role: Literal["admin", "member"] = "member"


class WorkspaceMemberRoleUpdate(BaseModel):
    role: Literal["admin", "member"]


class WorkspaceTransferOwnerRequest(BaseModel):
    new_owner_id: str = Field(..., min_length=1)


class WorkspaceShareLinkResponse(BaseModel):
    url: str
    token: str


class WorkspaceImportResponse(BaseModel):
    workers_imported: List[str] = []
    contexts_imported: List[str] = []
    skipped: List[Dict[str, str]] = []
    id_remaps: Dict[str, str] = {}
    required_secrets: List[str] = []
    required_connections: List[str] = []
    workspace_md_present: bool = False


class ChangelogEntry(BaseModel):
    asset_type: str  # "worker" | "context" | "workspace_instructions"
    asset_id: str
    asset_name: str
    sha: str
    message: str
    committed_at: str


class _WorkspaceSettingValue(BaseModel):
    value: str = Field(..., max_length=4000)


class _AuthSetupRequest(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None


class _LoginRequest(BaseModel):
    username: str
    password: str


class _UserOut(BaseModel):
    id: str
    username: str
    display_name: Optional[str] = None
    role: str
    disabled: bool
    created_at: str


class _UserCreateRequest(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None
    # #975: role is intentionally NOT accepted here. New users are always
    # created as 'member'; promotion to admin is a separate explicit PATCH
    # /users/{id} action (admin-gated, auditable). Accepting role at create
    # let an admin (or a CSRF #947 forced request) mint a backdoor admin in
    # one call with no audit trail.


class _UserUpdateRequest(BaseModel):
    display_name: Optional[str] = None
    role: Optional[str] = None
    disabled: Optional[bool] = None
    password: Optional[str] = None


class _PATOut(BaseModel):
    id: str
    name: str
    last_used_at: Optional[str] = None
    created_at: str
    expires_at: Optional[str] = None


class _PATCreateRequest(BaseModel):
    name: str
    expires_at: Optional[str] = None


class _PATCreateResponse(BaseModel):
    token: str  # raw value — shown once, never stored
    pat: _PATOut


class DraftFile(BaseModel):
    """A single file in a skill bundle returned by draft-from-prompt."""
    path: str      # e.g. "worker.yml", "run.py", "SKILL.md", "lib/granola_client.py"
    content: str   # UTF-8 text content


class DraftFromPromptRequest(BaseModel):
    prompt: str


class DraftFromPromptInputField(BaseModel):
    name: str
    type: str
    label: str
    required: bool = False
    default: Optional[Any] = None


class DraftFromPromptOutputField(BaseModel):
    name: str
    type: str
    label: str


class RequirementItem(BaseModel):
    """One integration requirement: a single app with exactly one auth method."""
    app: str
    method: str  # "oauth" or "api_key" -- the CURRENT selection (default = LLM suggestion)
    available_methods: List[str] = []  # both "oauth" and "api_key" if both supported; otherwise just the one
    reason: str = ""


class DraftFromPromptResponse(BaseModel):
    worker_yml: str
    skill_md: Optional[str] = None
    suggested_name: str
    suggested_title: str
    # New: one entry per app, method is "oauth" or "api_key"
    requirements: List[RequirementItem] = []
    # Skill-bundle: all files returned by the LLM (worker.yml, run.py, SKILL.md, lib/*.py, etc.)
    # When present, the frontend should use these files directly instead of constructing them.
    files: List[DraftFile] = []
    # Legacy fields kept for backward compatibility
    required_connections: List[str]
    required_secrets: List[str]
    inputs: List[DraftFromPromptInputField]
    outputs: List[DraftFromPromptOutputField]


class NewWorkerFromPromptRequest(BaseModel):
    prompt: str
    mode: str = "draft"  # "draft" | "create"
    parent_worker_id: Optional[str] = None


class NewWorkerFromPromptResponse(BaseModel):
    run_id: str
    worker_id: str = "worker-author"
    status: str = "running"


class DraftAndCreateRequest(BaseModel):
    prompt: str = ""
    # Optional pre-built files to skip the LLM step (used for .md / .py uploads)
    files: List[DraftFile] = []


class DraftAndCreateResponse(BaseModel):
    worker_id: str
    # FIX 4 (2026-05-29): both creation paths run the smoke+repair safety net.
    # smoke_status: "passed" | "failed" | "skipped" | None. When "failed" the
    # worker is created but DISABLED (stays editable) — surface the reason so
    # the caller does not present it as a clean, ready worker.
    smoke_status: Optional[str] = None
    smoke_reason: Optional[str] = None


class WorkerListSummary(WorkerSummary):
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
