"""Shared agent capability builder.

Both the autonomous worker driver (``agent_driver.AgentDriver``) and the
interactive workspace-agent chat path (``chat_service.stream_chat``) expose the
SAME runtime capabilities to an Agents-SDK ``Agent``:

- **Composio app tools** — one ``composio__<app>__execute`` function tool per
  declared/connected app, scope-gated so read-only policies never advertise or
  execute mutating tools.
- **MCP servers** — ``WorkerMCPConnection`` specs dialled through the SDK with
  the SSRF guard, bearer/secret auth header injection, and per-connection
  ``allowed_tool_names`` filter.
- **Brain pack staging** — owner-scoped staging of attached context packs into a
  per-run ``context/<name>/...`` tree.

Previously this logic lived only on ``AgentDriver``. The workspace agent in
``chat_service`` got NONE of it, so the ``/assistant`` UI claim ("shares your
Brain and Connections") was false. This module is the single source of truth so
both paths stay in lock-step (no duplication, same SSRF/secret/owner-scope
guarantees).

The :class:`CapabilityPolicy` parameterises the gating. Autonomous workers run
under :data:`WORKER_POLICY` (full, worker-declared scope governs). The
interactive assistant runs under :data:`WORKSPACE_AGENT_POLICY`
(``composio_scope_override="read_only"`` so mutating live-connection tools are
neither advertised nor executed, and ``mcp_require_approval="always"`` so any
MCP tool routes through the SDK approval/HITL gate before it can mutate a live
connection).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from contexts import (
    context_dir,
    context_scope_for_user,
    iter_context_files,
    normalize_context_mount,
    use_context_scope,
)
from models import (
    UnsafeMCPUrlError,
    WorkerConfig,
    assert_safe_outbound_mcp_url,
    composio_tool_allowed_by_scope,
    declared_composio_connection_scopes,
    declared_composio_connections,
)
from .memory_context import ensure_memory_context_pack

logger = logging.getLogger("floom.runner_sandbox.capabilities")


class MCPConnectionError(RuntimeError):
    """Raised when an MCP server fails to connect or is misconfigured."""


@dataclass(frozen=True)
class CapabilityPolicy:
    """Gates the runtime capabilities exposed to an agent.

    Attributes:
        composio_scope_override: When set (e.g. ``"read_only"``), forces this
            scope on EVERY declared Composio app regardless of what the worker
            config declared. Read-only excludes mutating tools both at
            advertisement time (the execute tool description names the policy)
            and at execute time (``composio_tool_allowed_by_scope``). When
            ``None``, the worker-declared scopes govern (autonomous workers).
        mcp_require_approval: Forces ``require_approval`` on every MCP server
            this agent dials. ``"always"`` routes every MCP tool call through
            the SDK approval/HITL gate so an interactive assistant cannot
            silently mutate a live connection. ``None`` keeps the
            connection-declared value.
        allow_mutating_composio: When ``False`` (read-only assistant), Composio
            execute calls for mutating tools are refused even if a tool somehow
            slips the scope filter. Defensive belt-and-braces with the scope
            override.
    """

    composio_scope_override: Optional[str] = None
    mcp_require_approval: Optional[str] = None
    allow_mutating_composio: bool = True


# Autonomous workers: worker.yml scopes govern; nothing forced.
WORKER_POLICY = CapabilityPolicy(
    composio_scope_override=None,
    mcp_require_approval=None,
    allow_mutating_composio=True,
)

# Interactive workspace assistant: read-only live connections by default, every
# MCP tool call gated behind explicit approval.
WORKSPACE_AGENT_POLICY = CapabilityPolicy(
    composio_scope_override="read_only",
    mcp_require_approval="always",
    allow_mutating_composio=False,
)


def _safe_path(base: Path, *parts: str) -> Path:
    target = base.joinpath(*parts).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        raise ValueError(f"Path traversal attempt: {target}")
    return target


# ---------------------------------------------------------------------------
# Composio tool exposure (scope-gated)
# ---------------------------------------------------------------------------

def composio_connection_names(config: Optional[WorkerConfig]) -> List[str]:
    """Sorted list of distinct Composio app slugs declared on the config."""
    declared = declared_composio_connections(config)
    return sorted(
        app
        for app, allowed_tools in declared.items()
        if allowed_tools is None or len(allowed_tools) > 0
    )


def effective_composio_scopes(
    config: Optional[WorkerConfig],
    policy: CapabilityPolicy,
) -> Dict[str, List[str]]:
    """Per-app effective scopes after applying the policy override.

    Read-only policies clamp every app to ``["read_only"]`` so mutating tools
    are never advertised nor executed for the interactive assistant.
    """
    declared = declared_composio_connection_scopes(config)
    if policy.composio_scope_override:
        return {app: [policy.composio_scope_override] for app in composio_connection_names(config)}
    # Ensure every declared app has an entry (full by default).
    return {app: declared.get(app, ["full"]) for app in composio_connection_names(config)}


def composio_tool_schemas(
    config: Optional[WorkerConfig],
    policy: CapabilityPolicy = WORKER_POLICY,
) -> List[Dict[str, Any]]:
    """Build ``composio__<app>__execute`` function-tool schemas for each app.

    One execute tool per app (mirrors the worker driver). The description names
    the policy so a read-only assistant tells the model it may only call
    read/non-mutating tools for that app.
    """
    schemas: List[Dict[str, Any]] = []
    scopes = effective_composio_scopes(config, policy)
    for app in composio_connection_names(config):
        safe_app = "".join(ch if ch.isalnum() else "_" for ch in app.lower())
        app_scopes = scopes.get(app, ["full"])
        if "full" not in {s.lower() for s in app_scopes}:
            scope_note = (
                f" Read-only access: only non-mutating {app} tools "
                "(GET/LIST/SEARCH/FETCH/READ) are permitted."
            )
        else:
            scope_note = ""
        schemas.append(
            {
                "type": "function",
                "function": {
                    "name": f"composio__{safe_app}__execute",
                    "description": (
                        f"Execute a {app} tool as integration.{app}.<tool>(arguments).{scope_note}"
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "tool": {"type": "string"},
                            "arguments": {"type": "object"},
                        },
                        "required": ["tool", "arguments"],
                    },
                },
            }
        )
    return schemas


def composio_tool_permitted(
    config: Optional[WorkerConfig],
    policy: CapabilityPolicy,
    app: str,
    tool_slug: str,
) -> tuple[bool, Optional[str], Optional[str]]:
    """Whether ``tool_slug`` may run for ``app`` under the config + policy.

    Returns ``(allowed, error_message, error_code)``. Enforces BOTH the
    worker-declared allowed_tools allowlist AND the policy scope gate
    (read-only refuses mutating tools).
    """
    declared = declared_composio_connections(config)
    app_key = app.lower()
    if app_key not in declared:
        return (
            False,
            f"Worker did not declare connection to {app}",
            "tool_outside_declared_connections",
        )
    allowed_tools = declared.get(app_key)
    if allowed_tools is not None and tool_slug.upper() not in allowed_tools:
        return (
            False,
            f"Tool {tool_slug} is not allowed for worker connection {app}",
            "tool_outside_connection_scope",
        )
    scopes = effective_composio_scopes(config, policy).get(app_key, ["full"])
    if not composio_tool_allowed_by_scope(app_key, tool_slug, scopes):
        return (
            False,
            (
                f"Tool {tool_slug} is a mutating/non-read tool and is blocked for {app} "
                "under the current read-only policy"
            ),
            "tool_blocked_by_read_only_policy",
        )
    if not policy.allow_mutating_composio and not composio_tool_allowed_by_scope(
        app_key, tool_slug, ["read_only"]
    ):
        return (
            False,
            (
                f"Tool {tool_slug} would mutate a live {app} connection and requires "
                "explicit approval; it is not available to the interactive assistant"
            ),
            "tool_requires_approval",
        )
    return True, None, None


# ---------------------------------------------------------------------------
# MCP server wiring (SSRF + auth + allowlist + approval)
# ---------------------------------------------------------------------------

def mcp_connections(config: Optional[WorkerConfig]) -> List[Any]:
    """Extract the ``WorkerMCPConnection`` specs declared on the config."""
    connections: List[Any] = []
    for connection in (config.connections if config else []) or []:
        mcp = getattr(connection, "mcp", None) if not isinstance(connection, str) else None
        if mcp is not None:
            connections.append(mcp)
    return connections


def _mcp_auth_headers(connection: Any, secrets: Dict[str, str]) -> Dict[str, str]:
    auth = getattr(connection, "auth", None)
    if not auth:
        return {}
    scheme, secret_name = auth.split(":", 1)
    if scheme != "bearer":
        raise MCPConnectionError(f"Unsupported MCP auth for {connection.label}: {scheme}")
    token = secrets.get(secret_name)
    if not token:
        raise MCPConnectionError(f"MCP connection {connection.label} is missing secret {secret_name}")
    return {"Authorization": f"Bearer {token}"}


def make_mcp_server(
    connection: Any,
    secrets: Dict[str, str],
    policy: CapabilityPolicy = WORKER_POLICY,
) -> Any:
    """Construct (but not connect) an SDK MCP server for ``connection``.

    Carries over the worker driver's guarantees verbatim:
    - dial-time SSRF re-validation of HTTP/SSE URLs (DNS-rebind defence),
    - bearer/secret auth header injection (no secret ever inlined into args),
    - per-connection ``allowed_tool_names`` filter,
    - ``require_approval`` gate (policy may force ``"always"``).
    """
    from agents.mcp import MCPServerSse, MCPServerStdio, MCPServerStreamableHttp

    transport = getattr(connection, "transport", None) or "streamable_http"

    tool_filter = None
    if getattr(connection, "allowed_tools", None):
        tool_filter = {"allowed_tool_names": list(connection.allowed_tools)}

    require_approval = policy.mcp_require_approval or getattr(connection, "require_approval", "never")

    common = {
        "name": connection.label,
        "cache_tools_list": True,
        "tool_filter": tool_filter,
        "require_approval": require_approval,
    }

    if transport == "stdio":
        env: Dict[str, str] = {}
        for key, value in (getattr(connection, "env", None) or {}).items():
            if value.startswith("secret:"):
                secret_name = value.split(":", 1)[1]
                secret_value = secrets.get(secret_name)
                if not secret_value:
                    raise MCPConnectionError(
                        f"MCP connection {connection.label} is missing secret {secret_name}"
                    )
                env[key] = secret_value
            else:
                env[key] = value
        params: Dict[str, Any] = {
            "command": connection.command,
            "args": list(getattr(connection, "args", None) or []),
            "env": env,
        }
        if getattr(connection, "cwd", None):
            cwd = str(connection.cwd).replace("\\", "/")
            if cwd.startswith(("/", "~")) or ".." in cwd.split("/"):
                raise MCPConnectionError(
                    f"MCP connection {connection.label} has unsafe stdio cwd"
                )
            params["cwd"] = cwd
        return MCPServerStdio(params=params, **common)

    # Defense in depth: re-validate the URL at dial time. DNS can rebind between
    # registration and the actual run, so a previously-safe hostname could now
    # resolve to an internal address.
    try:
        assert_safe_outbound_mcp_url(connection.url or "")
    except UnsafeMCPUrlError as exc:
        raise MCPConnectionError(f"MCP connection {connection.label} refused: {exc}") from exc

    params = {"url": connection.url}
    headers = _mcp_auth_headers(connection, secrets)
    if headers:
        params["headers"] = headers
    if transport == "sse":
        return MCPServerSse(params=params, **common)
    return MCPServerStreamableHttp(params=params, **common)


async def connect_mcp_servers(
    config: Optional[WorkerConfig],
    secrets: Dict[str, str],
    log_fn: Callable[[str, str], None],
    policy: CapabilityPolicy = WORKER_POLICY,
) -> List[Any]:
    """Dial every declared MCP server. Raises :class:`MCPConnectionError`."""
    servers: List[Any] = []
    for connection in mcp_connections(config):
        try:
            server = make_mcp_server(connection, secrets, policy)
            await server.connect()
            log_fn(f"Connected MCP server {connection.label}", "debug")
            servers.append(server)
        except MCPConnectionError:
            raise
        except Exception as exc:  # noqa: BLE001 — surfaced as MCPConnectionError
            raise MCPConnectionError(
                f"MCP connection failed for {connection.label}: {exc}"
            ) from exc
    return servers


async def cleanup_mcp_servers(servers: List[Any], log_fn: Callable[[str, str], None]) -> None:
    for server in reversed(servers):
        try:
            await server.cleanup()
        except Exception as exc:  # noqa: BLE001
            log_fn(f"MCP cleanup failed for {getattr(server, 'name', 'unknown')}: {exc}", "warning")


# ---------------------------------------------------------------------------
# Brain pack staging (owner-scoped)
# ---------------------------------------------------------------------------

def stage_context_packs(
    *,
    config: Optional[WorkerConfig],
    context_root: Path,
    user_id: Optional[str],
    log_fn: Callable[[str, str], None],
) -> List[str]:
    """Stage each attached brain pack into ``context_root/<name>/...`` (read).

    Owner-scoped via ``use_context_scope(context_scope_for_user(user_id))`` so a
    run/conversation only ever sees ITS owner's packs, never another tenant's.
    Git contexts are skipped (no sandboxed clone target locally). Returns the
    list of staged pack names.
    """
    if not config or not config.contexts:
        return []

    staged: List[str] = []
    with use_context_scope(context_scope_for_user(user_id)):
        ensure_memory_context_pack(config=config, user_id=user_id, log_fn=log_fn)
        for raw_context in config.contexts:
            try:
                context = normalize_context_mount(raw_context)
            except ValueError as exc:
                log_fn(f"[capabilities] Skipping invalid context: {exc}", "warning")
                continue

            name = context["name"]
            source = context["source"]
            if source.startswith("git+"):
                log_fn(
                    f"[capabilities] Skipping git context {name!r}: git contexts are "
                    "not supported here",
                    "warning",
                )
                continue

            local_dir = context_dir(name)
            if not local_dir.is_dir():
                log_fn(f"[capabilities] Context {name!r} not found locally", "warning")
                continue

            pack_target = _safe_path(context_root, name)
            pack_target.mkdir(parents=True, exist_ok=True)
            for fpath in iter_context_files(local_dir):
                rel = fpath.relative_to(local_dir)
                dest = _safe_path(pack_target, rel.as_posix())
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(fpath.read_bytes())
            staged.append(name)
            log_fn(f"[capabilities] Staged context {name!r}", "debug")
    return staged


# ---------------------------------------------------------------------------
# Composio execute (shared HTTP path, scope-gated)
# ---------------------------------------------------------------------------

_MAX_COMPOSIO_STRING_LEN = 4000
_MAX_COMPOSIO_ARRAY_LEN = 20


def _trim_composio_response(obj: Any, _depth: int = 0) -> Any:
    """Recursively trim a Composio API response to prevent token blowout.

    Gmail messages in particular return full HTML bodies, base64 attachments,
    and raw headers that can exceed 50k tokens. We cap strings at 4000 chars
    and arrays at 20 items so the agent gets enough context without flooding
    its output budget.
    """
    if _depth > 8:
        return obj
    if isinstance(obj, str):
        if len(obj) > _MAX_COMPOSIO_STRING_LEN:
            return obj[:_MAX_COMPOSIO_STRING_LEN] + f"…[trimmed, {len(obj)} chars total]"
        return obj
    if isinstance(obj, dict):
        return {k: _trim_composio_response(v, _depth + 1) for k, v in obj.items()}
    if isinstance(obj, list):
        trimmed = obj[:_MAX_COMPOSIO_ARRAY_LEN]
        result: list[Any] = [_trim_composio_response(item, _depth + 1) for item in trimmed]
        # Do NOT append a string sentinel — the list may contain typed dicts
        # (e.g. Gmail message objects) and any downstream `item["id"]` would
        # raise TypeError: string indices must be integers on the extra element.
        # Truncation is visible implicitly from the shorter list length.
        return result
    return obj


def composio_execute(
    *,
    name: str,
    args: Dict[str, Any],
    config: Optional[WorkerConfig],
    policy: CapabilityPolicy,
    connection_ids: Dict[str, str],
    user_id: Optional[str],
    log_fn: Callable[[str, str], None],
) -> Dict[str, Any]:
    """Execute a Composio tool through the v3 HTTP API, scope-gated by policy.

    ``name`` is the tool name (``composio__<app>__execute`` or
    ``composio.<app>.execute``). Resolves the active connection for the run/
    workspace owner. No secret is ever returned or logged.
    """
    import requests

    from db import get_repositories

    tool = str(args.get("tool") or "")
    arguments = args.get("arguments") or {}
    if not tool:
        return {"ok": False, "error": "tool is required"}
    if not isinstance(arguments, dict):
        return {"ok": False, "error": "arguments must be an object"}

    app_name = ""
    if name.startswith("composio__"):
        parts = name.split("__")
        app_name = parts[1] if len(parts) >= 3 else ""
    elif name.startswith("composio."):
        parts = name.split(".")
        app_name = parts[1] if len(parts) >= 3 else ""

    permitted, error, error_code = composio_tool_permitted(config, policy, app_name, tool)
    if not permitted:
        return {"ok": False, "error": error, "error_code": error_code}

    connection_id = connection_ids.get(app_name.lower())
    if not connection_id and user_id:
        repos = get_repositories()
        active = [
            row
            for row in repos.connections.list(user_id=user_id)
            if row.get("app_name") == app_name.lower() and row.get("status") == "active"
        ]
        if active:
            connection_id = str(active[0].get("composio_connection_id") or "")
    if not connection_id:
        return {"ok": False, "error": f"Missing active Composio connection for {app_name}"}

    api_key = os.environ.get("COMPOSIO_API_KEY")
    if not api_key:
        return {"ok": False, "error": "COMPOSIO_API_KEY is not configured"}

    log_fn(f"Executing Composio tool {tool}", "debug")
    entity_id = user_id or os.environ.get("FLOOM_USER_ID", "federico")
    response = requests.post(
        f"https://backend.composio.dev/api/v3/tools/execute/{tool}",
        headers={"x-api-key": api_key, "Content-Type": "application/json"},
        json={
            "connected_account_id": connection_id,
            "entity_id": entity_id,
            "arguments": arguments,
        },
        timeout=30,
    )
    if response.status_code >= 400:
        return {
            "ok": False,
            "error": f"{response.status_code} {response.reason}: {response.text[:400]}",
        }
    return {"ok": True, "result": _trim_composio_response(response.json())}
