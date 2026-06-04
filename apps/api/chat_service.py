"""Workspace agent chat service — S37.

Implements POST /chat: a streaming SSE endpoint that routes user messages
through the workspace-agent worker (system_worker: true) and persists
conversation history.

Conversation eviction: after 50 messages, the conversation is summarised
and the oldest messages are pruned, keeping the summary + last 20 verbatim.

Tool truncation: tool results >2048 bytes are truncated before persisting
to conversation_messages.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

from db import get_db, now_iso

logger = logging.getLogger("floom.chat")

WORKSPACE_AGENT_ID = "workspace-agent"
DEFAULT_WORKSPACE_AGENT_MODEL = "gpt-5-mini"
TOOL_RESULT_MAX_BYTES = 2048
CONVERSATION_WINDOW = 50       # summarise after this many messages
CONVERSATION_KEEP_VERBATIM = 20  # keep this many after summarisation
WORKSPACE_MD_PATH = Path(__file__).resolve().parents[3] / "workspace.md"
WORKSPACE_MD_TEMPLATE = Path(__file__).resolve().parents[3] / "workspace.md.template"


# ---------------------------------------------------------------------------
# Em-dash / en-dash filter (deterministic, code-level guarantee)
# ---------------------------------------------------------------------------

def strip_em_dashes(text: str) -> str:
    """Replace em dashes (U+2014) and en dashes (U+2013) with ASCII equivalents.

    Federico requires zero em dashes in Emily's output. A system-prompt
    instruction alone is unreliable because the model occasionally emits them
    anyway. This filter is applied to every text chunk at emission time so the
    guarantee is unconditional.

    Replacement rules (safest readable substitution):
      " — " (spaced em dash)  → ", "
      "—"   (unspaced)        → ", "
      " – " (spaced en dash)  → ", "
      "–"   (unspaced)        → "-"
    """
    # Spaced variants first (more context, cleaner replacement)
    text = text.replace(" — ", ", ")   # spaced em dash → comma-space
    text = text.replace("—", ", ")     # bare em dash → comma-space
    text = text.replace(" – ", ", ")   # spaced en dash → comma-space
    text = text.replace("–", "-")      # bare en dash → hyphen
    return text


# ---------------------------------------------------------------------------
# workspace.md helpers
# ---------------------------------------------------------------------------

def get_workspace_md() -> str:
    """Return the current workspace.md content, or the template if missing."""
    if WORKSPACE_MD_PATH.is_file():
        return WORKSPACE_MD_PATH.read_text()
    if WORKSPACE_MD_TEMPLATE.is_file():
        return WORKSPACE_MD_TEMPLATE.read_text()
    return "# Workspace\n\nNo workspace.md configured yet. PUT /workspace to set one."


def unwrap_workspace_body(body: str) -> str:
    """Normalise a workspace.md write body to raw markdown.

    The OSS ``PUT /workspace`` contract is a RAW ``text/markdown`` body, but the
    Downstream host (and some clients) send a JSON envelope ``{"content": "..."}``
    instead. Without this, the JSON string is stored verbatim as the instructions
    and prepended to every agent's system prompt (N3-1). This makes the write path
    tolerant: if the body parses as a JSON object whose ONLY meaningful key is
    ``content`` (a string), unwrap to that inner content; otherwise return the body
    unchanged.

    Legit markdown that merely starts with ``{`` (e.g. a JSON code block, or text
    that isn't the envelope shape) is NOT mangled — only the exact single-key
    ``{"content": <str>}`` envelope is unwrapped.
    """
    import json as _json

    stripped = body.lstrip()
    if not stripped.startswith("{"):
        return body
    try:
        parsed = _json.loads(body)
    except (ValueError, TypeError):
        return body
    if (
        isinstance(parsed, dict)
        and set(parsed.keys()) == {"content"}
        and isinstance(parsed.get("content"), str)
    ):
        return parsed["content"]
    return body


def set_workspace_md(content: str) -> None:
    """Overwrite workspace.md."""
    WORKSPACE_MD_PATH.parent.mkdir(parents=True, exist_ok=True)
    WORKSPACE_MD_PATH.write_text(content)


# ---------------------------------------------------------------------------
# Conversation persistence
# ---------------------------------------------------------------------------

def create_conversation(user_id: str, title: Optional[str] = None) -> str:
    conv_id = f"conv_{uuid.uuid4().hex[:16]}"
    ts = now_iso()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO conversations (id, user_id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (conv_id, user_id, title, ts, ts),
        )
    return conv_id


def get_conversation(conv_id: str, user_id: str) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ? AND user_id = ?",
            (conv_id, user_id),
        ).fetchone()
        if not row:
            return None
        return dict(row)


def list_conversations(user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.title, c.created_at, c.updated_at,
                   COUNT(m.id) AS message_count
            FROM conversations c
            LEFT JOIN conversation_messages m ON m.conversation_id = c.id
            WHERE c.user_id = ?
            GROUP BY c.id
            ORDER BY c.updated_at DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def list_conversation_messages(conv_id: str, user_id: str) -> List[Dict[str, Any]]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
            (conv_id, user_id),
        ).fetchone()
        if not row:
            return []
        rows = conn.execute(
            """
            SELECT id, role, content, tool_call_id, created_at
            FROM conversation_messages
            WHERE conversation_id = ?
            ORDER BY created_at ASC
            """,
            (conv_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def insert_message(
    conv_id: str,
    role: str,
    content: str,
    tool_call_id: Optional[str] = None,
) -> str:
    msg_id = f"msg_{uuid.uuid4().hex[:16]}"
    ts = now_iso()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO conversation_messages (id, conversation_id, role, content, tool_call_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (msg_id, conv_id, role, _truncate_content(role, content), tool_call_id, ts),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (ts, conv_id),
        )
    return msg_id


def _truncate_content(role: str, content: str) -> str:
    if role == "tool" and len(content.encode()) > TOOL_RESULT_MAX_BYTES:
        truncated = content.encode()[:TOOL_RESULT_MAX_BYTES].decode(errors="replace")
        return truncated + f"\n<truncated: original {len(content.encode())} bytes>"
    return content


def load_conversation_history(conv_id: str, limit: int = CONVERSATION_WINDOW) -> List[Dict[str, Any]]:
    """Load the last `limit` messages as OpenAI-compatible input list."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, role, content, tool_call_id, created_at
            FROM conversation_messages
            WHERE conversation_id = ?
            ORDER BY created_at ASC
            """,
            (conv_id,),
        ).fetchall()

    messages = [dict(r) for r in rows]

    # If we have a summary message (injected during eviction), keep it + last N verbatim
    # Otherwise just take the last N
    if len(messages) <= limit:
        return messages

    # Check if first message is a summary
    first = messages[0]
    if first["role"] == "assistant" and first["content"].startswith("[CONVERSATION SUMMARY]"):
        # Keep summary + last CONVERSATION_KEEP_VERBATIM
        return [first] + messages[-CONVERSATION_KEEP_VERBATIM:]
    return messages[-limit:]


def _maybe_evict_conversation(conv_id: str, user_id: str) -> None:
    """If conversation has >CONVERSATION_WINDOW messages, summarise and prune."""
    with get_db() as conn:
        count_row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM conversation_messages WHERE conversation_id = ?",
            (conv_id,),
        ).fetchone()
        if count_row["cnt"] <= CONVERSATION_WINDOW:
            return
        # Load all messages to summarise
        rows = conn.execute(
            """
            SELECT id, role, content, created_at
            FROM conversation_messages
            WHERE conversation_id = ?
            ORDER BY created_at ASC
            """,
            (conv_id,),
        ).fetchall()

    messages = [dict(r) for r in rows]
    to_summarise = messages[:-CONVERSATION_KEEP_VERBATIM]
    to_keep = messages[-CONVERSATION_KEEP_VERBATIM:]

    summary_lines = ["[CONVERSATION SUMMARY]", ""]
    for m in to_summarise:
        role = m["role"]
        content = m["content"][:200]
        summary_lines.append(f"{role.upper()}: {content}")
    summary = "\n".join(summary_lines)

    summary_id = f"msg_{uuid.uuid4().hex[:16]}"
    ts = now_iso()
    ids_to_delete = [m["id"] for m in to_summarise]

    with get_db() as conn:
        # Delete summarised messages
        conn.executemany(
            "DELETE FROM conversation_messages WHERE id = ?",
            [(mid,) for mid in ids_to_delete],
        )
        # Insert summary before the kept messages using the conversation's created_at
        # which predates all messages.
        conv_row = conn.execute(
            "SELECT created_at FROM conversations WHERE id = ?", (conv_id,)
        ).fetchone()
        summary_ts = conv_row["created_at"] if conv_row else ts
        conn.execute(
            """
            INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
            VALUES (?, ?, 'assistant', ?, ?)
            """,
            (summary_id, conv_id, summary, summary_ts),
        )


# ---------------------------------------------------------------------------
# Synthetic workspace-agent config (brain + connections at runtime)
# ---------------------------------------------------------------------------

def _owner_brain_pack_names(user_id: str) -> List[str]:
    """Owner-scoped list of brain pack names attachable to the workspace agent."""
    from contexts import context_scope_for_user, current_contexts_root, use_context_scope

    names: List[str] = []
    with use_context_scope(context_scope_for_user(user_id)):
        root = current_contexts_root()
        if root.is_dir():
            for child in sorted(root.iterdir()):
                if child.is_dir() and not child.name.startswith("."):
                    names.append(child.name)
    return names


def build_workspace_agent_config(user_id: str) -> Any:
    """Synthesize a WorkerConfig that gives the interactive workspace agent the
    SAME brain + connection capabilities a worker gets — but read-only-gated.

    - ``connections``: every active DB-registered Composio app is declared as a
      read-only connection (``scope: read_only``); every active registered MCP
      server (``kind == "mcp"``) is declared as a ``WorkerMCPConnection`` so the
      shared builder dials it (under ``WORKSPACE_AGENT_POLICY`` →
      ``require_approval="always"``).
    - ``contexts``: every owner brain pack, staged read-only for the agent.

    The synthetic config carries no secret values; MCP bearer secrets are
    resolved separately at dial time via the owner's secret store.
    """
    from models import (
        WorkerComposioConnection,
        WorkerConfig,
        WorkerConnection,
        WorkerContextMount,
        WorkerMCPConnection,
        WorkerOutput,
        WorkerRuntime,
        WorkerTrigger,
    )
    from db import get_repositories

    repos = get_repositories()
    connections: List[Any] = []
    for row in repos.connections.list(user_id=user_id):
        if (row.get("status") or "") != "active":
            continue
        kind = row.get("kind") or "composio"
        if kind == "mcp":
            url = row.get("mcp_url")
            if not url:
                continue
            try:
                allowed = json.loads(row.get("mcp_allowed_tools_json") or "[]")
            except Exception:
                allowed = []
            allowed = [t for t in allowed if isinstance(t, str)] or None
            auth_secret = row.get("mcp_auth_secret")
            try:
                mcp = WorkerMCPConnection(
                    label=row.get("mcp_label") or row.get("app_name") or "mcp",
                    transport=row.get("mcp_transport") or "streamable_http",
                    url=url,
                    auth=(f"bearer:{auth_secret}" if auth_secret else None),
                    allowed_tools=allowed,
                )
            except Exception as exc:
                logger.warning("Skipping invalid registered MCP connection: %s", exc)
                continue
            connections.append(WorkerConnection(mcp=mcp))
        else:
            app = row.get("app_name")
            if not app:
                continue
            try:
                connections.append(
                    WorkerConnection(
                        composio=WorkerComposioConnection(app=str(app), scope="read_only")
                    )
                )
            except Exception as exc:
                logger.warning("Skipping invalid registered Composio connection %s: %s", app, exc)
                continue

    contexts: List[Any] = [
        WorkerContextMount(name=name) for name in _owner_brain_pack_names(user_id)
    ]

    return WorkerConfig(
        id=WORKSPACE_AGENT_ID,
        name=WORKSPACE_AGENT_ID,
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="agent", entrypoint="SKILL.md", runner="e2b", mode="agent"),
        connections=connections,
        contexts=contexts,
        outputs=[WorkerOutput(name="reply", label="Agent reply", type="markdown", required=True)],
    )


# ---------------------------------------------------------------------------
# Brain read tools (owner-scoped to the staged context tree)
# ---------------------------------------------------------------------------

def _brain_read_tools(context_root: Path, staged_packs: List[str]) -> List[Any]:
    """Read-only file tools over the staged brain packs.

    Both tools resolve paths UNDER ``context_root`` only (path-traversal
    guarded). The agent can list/read but never write — staging is read-only.
    """
    from agents import FunctionTool

    def _resolve(rel_path: str) -> Path:
        normalized = Path(rel_path or ".").as_posix().strip("/")
        target = (context_root / normalized).resolve()
        target.relative_to(context_root.resolve())  # raises ValueError on escape
        return target

    async def _list(_ctx: Any, raw_args: str) -> str:
        try:
            args = json.loads(raw_args or "{}")
        except json.JSONDecodeError as exc:
            return json.dumps({"ok": False, "error": f"Invalid JSON: {exc}"})
        try:
            target = _resolve(str(args.get("path") or "."))
        except ValueError:
            return json.dumps({"ok": False, "error": "Path traversal attempt"})
        if not target.is_dir():
            return json.dumps({"ok": False, "error": f"Not a directory: {args.get('path')}"})
        entries = [
            {"name": c.name, "type": "dir" if c.is_dir() else "file"}
            for c in sorted(target.iterdir(), key=lambda i: i.name)
        ]
        return json.dumps({"ok": True, "entries": entries})

    async def _read(_ctx: Any, raw_args: str) -> str:
        try:
            args = json.loads(raw_args or "{}")
        except json.JSONDecodeError as exc:
            return json.dumps({"ok": False, "error": f"Invalid JSON: {exc}"})
        try:
            target = _resolve(str(args.get("path") or ""))
        except ValueError:
            return json.dumps({"ok": False, "error": "Path traversal attempt"})
        if not target.is_file():
            return json.dumps({"ok": False, "error": f"File not found: {args.get('path')}"})
        return json.dumps({"ok": True, "content": target.read_text(errors="replace")})

    return [
        FunctionTool(
            name="brain__list",
            description=(
                "List files in the workspace brain packs (read-only). "
                f"Attached packs: {', '.join(sorted(staged_packs)) or '(none)'}. "
                "Pass {\"path\": \"<pack>/...\"} or {\"path\": \".\"} for the root."
            ),
            params_json_schema={
                "type": "object",
                "properties": {"path": {"type": "string", "default": "."}},
                "required": [],
            },
            on_invoke_tool=_list,
            strict_json_schema=False,
        ),
        FunctionTool(
            name="brain__read",
            description="Read a UTF-8 file from a workspace brain pack (read-only).",
            params_json_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            on_invoke_tool=_read,
            strict_json_schema=False,
        ),
    ]


# ---------------------------------------------------------------------------
# Read-only Composio app tools (shared scope-gated execute path)
# ---------------------------------------------------------------------------

def _composio_read_tools(
    config: Any,
    policy: Any,
    user_id: str,
    log_fn: Callable[[str, str], None],
) -> List[Any]:
    """One ``composio__<app>__execute`` tool per connected app, read-only-gated.

    Tool schemas + execute both flow through
    ``runner_sandbox.agent_capabilities`` under the read-only policy, so
    mutating tools are neither advertised nor executed. Mirrors the worker
    driver's Composio surface exactly.
    """
    from agents import FunctionTool
    from runner_sandbox import agent_capabilities

    tools: List[Any] = []
    for schema in agent_capabilities.composio_tool_schemas(config, policy):
        function = schema.get("function") or {}
        name = function["name"]

        async def _invoke(_ctx: Any, raw_args: str, *, tool_name: str = name) -> str:
            try:
                args = json.loads(raw_args or "{}")
                if not isinstance(args, dict):
                    return json.dumps({"ok": False, "error": "Tool arguments must be an object"})
            except json.JSONDecodeError as exc:
                return json.dumps({"ok": False, "error": f"Invalid JSON arguments: {exc}"})
            result = agent_capabilities.composio_execute(
                name=tool_name,
                args=args,
                config=config,
                policy=policy,
                connection_ids={},
                user_id=user_id,
                log_fn=log_fn,
            )
            return json.dumps(result, default=str)

        tools.append(
            FunctionTool(
                name=name,
                description=function.get("description") or name,
                params_json_schema=function.get("parameters") or {"type": "object", "properties": {}},
                on_invoke_tool=_invoke,
                strict_json_schema=False,
            )
        )
    return tools


# ---------------------------------------------------------------------------
# Workspace-management tools (available only to workspace-agent)
# ---------------------------------------------------------------------------

def _workspace_tools(user_id: str) -> List[Any]:
    """Build FunctionTool list for workspace-management capabilities."""
    from agents import FunctionTool

    def _make_tool(name: str, description: str, schema: Dict[str, Any], handler: Callable) -> Any:
        async def _invoke(_ctx: Any, raw_args: str, *, _handler=handler) -> str:
            try:
                args = json.loads(raw_args or "{}")
            except json.JSONDecodeError as exc:
                return json.dumps({"ok": False, "error": f"Invalid JSON: {exc}"})
            try:
                result = _handler(args, user_id)
                return json.dumps(result, default=str)
            except Exception as exc:
                logger.exception("Workspace tool %s failed", name)
                return json.dumps({"ok": False, "error": str(exc)})

        return FunctionTool(
            name=name,
            description=description,
            params_json_schema=schema,
            on_invoke_tool=_invoke,
            strict_json_schema=False,
        )

    tools = [
        _make_tool(
            "workers__list_all",
            "List all workers in the workspace (name, id, trigger, last run status).",
            {"type": "object", "properties": {}, "required": []},
            _tool_workers_list_all,
        ),
        _make_tool(
            "workers__get",
            "Read a worker's full config by ID.",
            {
                "type": "object",
                "properties": {"id": {"type": "string", "description": "Worker ID"}},
                "required": ["id"],
            },
            _tool_workers_get,
        ),
        _make_tool(
            "workers__create",
            "Create a new worker from a YAML bundle string.",
            {
                "type": "object",
                "properties": {"yaml_text": {"type": "string", "description": "Full worker.yml content"}},
                "required": ["yaml_text"],
            },
            _tool_workers_create,
        ),
        _make_tool(
            "workers__update",
            "Modify an existing worker's YAML configuration.",
            {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "yaml_text": {"type": "string"},
                },
                "required": ["id", "yaml_text"],
            },
            _tool_workers_update,
        ),
        _make_tool(
            "workers__run",
            "Trigger a worker run. Returns the run_id.",
            {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "inputs_json": {"type": "string", "description": "JSON-encoded inputs dict (optional)"},
                },
                "required": ["id"],
            },
            _tool_workers_run,
        ),
        _make_tool(
            "runs__list",
            "List recent runs, optionally filtered by worker_id and/or status.",
            {
                "type": "object",
                "properties": {
                    "worker_id": {"type": "string"},
                    "status": {"type": "string"},
                    "limit": {"type": "integer", "default": 20},
                },
                "required": [],
            },
            _tool_runs_list,
        ),
        _make_tool(
            "runs__get",
            "Get a specific run's details including outputs and error.",
            {
                "type": "object",
                "properties": {"run_id": {"type": "string"}},
                "required": ["run_id"],
            },
            _tool_runs_get,
        ),
        _make_tool(
            "runs__cancel",
            "Cancel an in-progress run.",
            {
                "type": "object",
                "properties": {"run_id": {"type": "string"}},
                "required": ["run_id"],
            },
            _tool_runs_cancel,
        ),
        _make_tool(
            "secrets__list_names",
            "List secret names and status metadata. Never returns secret values.",
            {"type": "object", "properties": {}, "required": []},
            _tool_secrets_list_names,
        ),
        _make_tool(
            "secrets__set",
            "Create or update a secret value.",
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "value": {"type": "string"},
                },
                "required": ["name", "value"],
            },
            _tool_secrets_set,
        ),
        _make_tool(
            "connections__list",
            "List all connections with app, account label, status, scopes, and MCP tool allowlists.",
            {"type": "object", "properties": {}, "required": []},
            _tool_connections_list,
        ),
        _make_tool(
            "connections__add_mcp",
            "Register a new MCP server connection.",
            {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "url": {"type": "string"},
                    "auth_secret": {"type": "string"},
                    "allowed_tools": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["label", "url"],
            },
            _tool_connections_add_mcp,
        ),
        _make_tool(
            "contexts__list",
            "List all brain packs with file counts and top-level file names.",
            {"type": "object", "properties": {}, "required": []},
            _tool_contexts_list,
        ),
        _make_tool(
            "contexts__read",
            "Read a file from a brain pack.",
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "file_path": {"type": "string"},
                },
                "required": ["name", "file_path"],
            },
            _tool_contexts_read,
        ),
        _make_tool(
            "contexts__write",
            "Write content to a file in a brain pack.",
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "file_path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["name", "file_path", "content"],
            },
            _tool_contexts_write,
        ),
        _make_tool(
            "approvals__list_pending",
            (
                "List pending approval requests. Returns [{id, worker_id, worker_name, "
                "run_id, label, preview, created_at, link}] where link is the "
                "direct URL the operator can open to approve/reject."
            ),
            {"type": "object", "properties": {}, "required": []},
            _tool_approvals_list_pending,
        ),
        _make_tool(
            "slack__list_channels",
            (
                "List the Slack channels you have been invited to (and can therefore "
                "read). Use this to resolve a channel name like '#launch' to a channel "
                "id before reading it. You can only read channels you've been added to "
                "with /invite @Emily — that invite is how the operator grants consent. "
                "If channel scopes aren't enabled yet, this returns a clear message "
                "explaining how the workspace owner can enable them; relay it as-is."
            ),
            {"type": "object", "properties": {}, "required": []},
            _tool_slack_list_channels,
        ),
        _make_tool(
            "slack__read_channel",
            (
                "Read the recent messages of a Slack channel ON DEMAND (when the "
                "operator asks, e.g. 'summarize #launch'). Accepts a channel name "
                "(with or without '#') or a channel id. You can only read channels "
                "you've been invited to. Reading a channel ingests everyone's messages "
                "in it, so mention that plainly when relevant. If you're not in the "
                "channel, the result tells the operator to invite you with "
                "/invite @Emily; if scopes aren't granted yet, it tells them how the "
                "owner enables channel access. Relay those messages verbatim instead "
                "of erroring."
            ),
            {
                "type": "object",
                "properties": {
                    "channel": {
                        "type": "string",
                        "description": "Channel name (e.g. 'launch' or '#launch') or channel id (e.g. 'C0123ABC').",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "How many recent messages to read (default 50, max 100).",
                        "default": 50,
                    },
                },
                "required": ["channel"],
            },
            _tool_slack_read_channel,
        ),
    ]
    return tools


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _tool_workers_list_all(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_db as _get_db
    result = []
    with _get_db() as conn:
        rows = conn.execute(
            """
            SELECT w.id, w.name, w.trigger_type, w.enabled, w.owner_id,
                   sv.manifest_json
            FROM workers w
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE w.owner_id = ?
            ORDER BY w.name
            """,
            (user_id,),
        ).fetchall()
    for row in rows:
        try:
            manifest = json.loads(row["manifest_json"] or "{}") if row["manifest_json"] else {}
        except Exception:
            manifest = {}
        result.append({
            "id": row["id"],
            "name": row["name"],
            "title": manifest.get("title") or row["name"],
            "trigger": row["trigger_type"] or "manual",
            "enabled": bool(row["enabled"]),
            "system_worker": manifest.get("system_worker", False),
            "is_example": manifest.get("is_example", False),
        })
    return {"ok": True, "workers": result, "count": len(result)}


def _tool_workers_get(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_db as _get_db
    worker_id = str(args.get("id") or "")
    if not worker_id:
        return {"ok": False, "error": "id is required"}
    with _get_db() as conn:
        row = conn.execute(
            """
            SELECT w.id, w.name, w.trigger_type, w.enabled, w.cron_expr,
                   sv.manifest_json
            FROM workers w
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE w.owner_id = ? AND w.id = ?
            """,
            (user_id, worker_id),
        ).fetchone()
    if not row:
        return {"ok": False, "error": f"Worker not found: {worker_id}"}
    try:
        manifest = json.loads(row["manifest_json"] or "{}") if row["manifest_json"] else {}
    except Exception:
        manifest = {}
    return {
        "ok": True,
        "worker": {
            "id": row["id"],
            "name": row["name"],
            "trigger": row["trigger_type"] or "manual",
            "cron": row["cron_expr"],
            "enabled": bool(row["enabled"]),
            "manifest": manifest,
        },
    }


def _tool_workers_create(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    import yaml as _yaml
    yaml_text = str(args.get("yaml_text") or "")
    if not yaml_text:
        return {"ok": False, "error": "yaml_text is required"}
    try:
        manifest = _yaml.safe_load(yaml_text)
    except Exception as exc:
        return {"ok": False, "error": f"Invalid YAML: {exc}"}
    if not isinstance(manifest, dict):
        return {"ok": False, "error": "YAML must be a mapping"}
    from models import parse_worker_manifest, WorkerContract, worker_contract_to_worker_config
    try:
        parsed = parse_worker_manifest(manifest)
    except Exception as exc:
        return {"ok": False, "error": f"Invalid worker manifest: {exc}"}
    worker_name = manifest.get("name") or ""
    if not worker_name:
        return {"ok": False, "error": "worker name is required in YAML"}
    # Sanitise to a safe ID
    worker_id = worker_name.lower().replace(" ", "-").replace("_", "-")
    import re as _re
    worker_id = _re.sub(r"[^a-z0-9-]", "", worker_id)[:64]
    if not worker_id:
        return {"ok": False, "error": "Could not derive a valid worker_id from name"}

    if isinstance(parsed, WorkerContract):
        config = worker_contract_to_worker_config(parsed, worker_id)
    else:
        config = parsed

    from db import get_repositories
    repos = get_repositories()
    try:
        import uuid as _uuid
        sv_id = f"sv_{worker_id}_{_uuid.uuid4().hex[:8]}"
        from db import get_db as _get_db, now_iso as _now_iso
        ts = _now_iso()
        with _get_db() as conn:
            conn.execute(
                """
                INSERT INTO skill_versions (id, name, version, manifest_json, bundle_path, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    sv_id,
                    worker_id,
                    manifest.get("version") or "0.1.0",
                    json.dumps(manifest),
                    f"workers/{worker_id}",
                    ts,
                ),
            )
            conn.execute(
                """
                INSERT INTO workers
                    (id, skill_version_id, name, trigger_type, grants_json,
                     input_values_json, enabled, created_at, owner_id)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    worker_id, sv_id, worker_id,
                    config.trigger.type if config and config.trigger else "manual",
                    json.dumps({}), json.dumps({}), ts, user_id,
                ),
            )
        return {"ok": True, "worker_id": worker_id, "message": f"Worker '{worker_id}' created."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _tool_workers_update(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    import yaml as _yaml
    worker_id = str(args.get("id") or "")
    yaml_text = str(args.get("yaml_text") or "")
    if not worker_id or not yaml_text:
        return {"ok": False, "error": "id and yaml_text are required"}
    try:
        manifest = _yaml.safe_load(yaml_text)
    except Exception as exc:
        return {"ok": False, "error": f"Invalid YAML: {exc}"}
    if not isinstance(manifest, dict):
        return {"ok": False, "error": "YAML must be a mapping"}
    from db import get_db as _get_db, now_iso as _now_iso
    import uuid as _uuid
    ts = _now_iso()
    sv_id = f"sv_{worker_id}_{_uuid.uuid4().hex[:8]}"
    try:
        with _get_db() as conn:
            row = conn.execute(
                "SELECT id FROM workers WHERE id = ? AND owner_id = ?",
                (worker_id, user_id),
            ).fetchone()
            if not row:
                return {"ok": False, "error": f"Worker not found or not owned by you: {worker_id}"}
            conn.execute(
                """
                INSERT INTO skill_versions (id, name, version, manifest_json, bundle_path, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    sv_id, worker_id,
                    manifest.get("version") or "0.1.0",
                    json.dumps(manifest),
                    f"workers/{worker_id}",
                    ts,
                ),
            )
            conn.execute(
                "UPDATE workers SET skill_version_id = ? WHERE id = ? AND owner_id = ?",
                (sv_id, worker_id, user_id),
            )
        return {"ok": True, "worker_id": worker_id, "message": f"Worker '{worker_id}' updated."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _tool_workers_run(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    worker_id = str(args.get("id") or "")
    if not worker_id:
        return {"ok": False, "error": "id is required"}
    inputs_json = args.get("inputs_json") or "{}"
    try:
        inputs = json.loads(inputs_json) if isinstance(inputs_json, str) else dict(inputs_json or {})
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"Invalid inputs_json: {exc}"}
    from run_service import create_run, execute_run
    import threading
    try:
        run_id = create_run(worker_id, inputs, trigger_source="workspace-agent", user_id=user_id)
        thread = threading.Thread(
            target=execute_run,
            args=(run_id, worker_id, inputs),
            kwargs={"user_id": user_id},
            daemon=True,
        )
        thread.start()
        return {"ok": True, "run_id": run_id, "message": f"Run '{run_id}' started for worker '{worker_id}'."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _tool_runs_list(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_db as _get_db
    worker_id = args.get("worker_id")
    status = args.get("status")
    limit = min(int(args.get("limit") or 20), 100)
    where = ["w.owner_id = ?"]
    params: list = [user_id]
    if worker_id:
        where.append("r.worker_id = ?")
        params.append(worker_id)
    if status:
        where.append("r.status = ?")
        params.append(status)
    where_sql = " AND ".join(where)
    with _get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT r.id, r.worker_id, w.name AS worker_name,
                   r.status, r.created_at, r.completed_at, r.error, r.duration_ms
            FROM runs r
            JOIN workers w ON w.id = r.worker_id
            WHERE {where_sql}
            ORDER BY r.created_at DESC
            LIMIT ?
            """,
            (*params, limit),
        ).fetchall()
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "worker_id": r["worker_id"],
            "worker_name": r["worker_name"],
            "status": r["status"],
            "created_at": r["created_at"],
            "completed_at": r["completed_at"],
            "duration_ms": r["duration_ms"],
            "error": r["error"],
        })
    return {"ok": True, "runs": result, "count": len(result)}


def _tool_runs_get(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_repositories
    run_id = str(args.get("run_id") or "")
    if not run_id:
        return {"ok": False, "error": "run_id is required"}
    repos = get_repositories()
    run = repos.runs.get(user_id=user_id, run_id=run_id)
    if not run:
        return {"ok": False, "error": f"Run not found: {run_id}"}
    r = dict(run)
    # Parse output_json safely
    if r.get("output_json"):
        try:
            r["outputs"] = json.loads(r["output_json"])
        except Exception:
            r["outputs"] = {}
    return {"ok": True, "run": r}


def _tool_runs_cancel(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_db as _get_db
    run_id = str(args.get("run_id") or "")
    if not run_id:
        return {"ok": False, "error": "run_id is required"}
    try:
        with _get_db() as conn:
            conn.execute(
                "UPDATE runs SET cancel_requested = 1 WHERE id = ?",
                (run_id,),
            )
        return {"ok": True, "message": f"Cancel requested for run '{run_id}'."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _tool_secrets_list_names(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_repositories
    repos = get_repositories()
    rows = repos.secrets.list(user_id=user_id)
    secrets = []
    for row in rows:
        item = dict(row)
        secrets.append({
            "name": item.get("name"),
            "status": item.get("status") or ("set" if item.get("value") else "missing"),
            "last_used_at": item.get("last_used_at"),
            "last_checked_at": item.get("last_checked_at"),
            "last_check_status": item.get("last_check_status"),
        })
    return {
        "ok": True,
        "names": sorted(s["name"] for s in secrets if s.get("name")),
        "secrets": sorted(secrets, key=lambda s: str(s.get("name") or "")),
    }


def _tool_secrets_set(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "")
    value = str(args.get("value") or "")
    if not name:
        return {"ok": False, "error": "name is required"}
    import re as _re
    if not _re.fullmatch(r"[A-Z_][A-Z0-9_]*", name.upper()):
        return {"ok": False, "error": "Secret name must be alphanumeric with underscores"}
    env_key = name.upper()
    os.environ[env_key] = value
    # Persist metadata to DB (value is stored only in env, not in DB)
    from db import get_db as _get_db, now_iso as _now_iso
    ts = _now_iso()
    with _get_db() as conn:
        conn.execute(
            """
            INSERT INTO secrets (user_id, name, status, created_at, updated_at)
            VALUES (?, ?, 'set', ?, ?)
            ON CONFLICT(user_id, name) DO UPDATE SET status='set', updated_at=excluded.updated_at
            """,
            (user_id, env_key, ts, ts),
        )
    return {"ok": True, "message": f"Secret '{env_key}' set."}


def _tool_connections_list(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_repositories
    repos = get_repositories()
    connections = repos.connections.list(user_id=user_id)
    result = []
    for c in connections:
        raw_scopes = c.get("scopes_json")
        try:
            scopes = json.loads(raw_scopes or "[]")
        except Exception:
            scopes = []
        if not isinstance(scopes, list):
            scopes = []
        raw_allowed_tools = c.get("mcp_allowed_tools_json")
        try:
            allowed_tools = json.loads(raw_allowed_tools or "[]")
        except Exception:
            allowed_tools = []
        if not isinstance(allowed_tools, list):
            allowed_tools = []
        account_label = c.get("display_name") or c.get("account_label")
        result.append({
            "id": c.get("id"),
            "kind": c.get("kind") or "composio",
            "app_name": c.get("app_name"),
            "status": c.get("status"),
            "account_label": account_label,
            "display_name": account_label,
            "scopes": [scope for scope in scopes if isinstance(scope, str)],
            "last_checked_at": c.get("last_checked_at"),
            "last_check_status": c.get("last_check_status"),
            "mcp_label": c.get("mcp_label"),
            "mcp_url": c.get("mcp_url"),
            "mcp_auth_secret": c.get("mcp_auth_secret"),
            "mcp_allowed_tools": [tool for tool in allowed_tools if isinstance(tool, str)],
        })
    return {"ok": True, "connections": result, "count": len(result)}


def _tool_connections_add_mcp(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    label = str(args.get("label") or "")
    url = str(args.get("url") or "")
    auth_secret = args.get("auth_secret")
    allowed_tools = args.get("allowed_tools")
    if not label or not url:
        return {"ok": False, "error": "label and url are required"}
    from db import get_db as _get_db, now_iso as _now_iso
    import uuid as _uuid
    conn_id = f"mcp_{_uuid.uuid4().hex[:12]}"
    ts = _now_iso()
    try:
        with _get_db() as conn:
            conn.execute(
                """
                INSERT INTO composio_connections
                    (id, app_name, composio_connection_id, kind, status,
                     mcp_label, mcp_url, mcp_auth_secret, mcp_allowed_tools_json,
                     user_id, created_at, updated_at)
                VALUES (?, ?, ?, 'mcp', 'active', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    conn_id, label, conn_id, label, url,
                    auth_secret,
                    json.dumps(allowed_tools) if allowed_tools else None,
                    user_id, ts, ts,
                ),
            )
        return {"ok": True, "connection_id": conn_id, "message": f"MCP connection '{label}' added."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _tool_contexts_list(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from contexts import CONTEXTS_DIR, iter_context_files
    result = []
    if CONTEXTS_DIR.is_dir():
        for ctx_dir in sorted(CONTEXTS_DIR.iterdir()):
            if ctx_dir.is_dir():
                files = list(iter_context_files(ctx_dir))
                result.append({
                    "name": ctx_dir.name,
                    "file_count": len(files),
                    "files": [str(path.relative_to(ctx_dir)) for path in files[:25]],
                    "truncated": len(files) > 25,
                })
    return {"ok": True, "contexts": result}


def _tool_contexts_read(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "")
    file_path = str(args.get("file_path") or "")
    if not name or not file_path:
        return {"ok": False, "error": "name and file_path are required"}
    from contexts import CONTEXTS_DIR, safe_context_file_path
    try:
        full_path = safe_context_file_path(name, file_path)
        if not full_path.is_file():
            return {"ok": False, "error": f"File not found: {file_path}"}
        content = full_path.read_text(errors="replace")
        return {"ok": True, "content": content}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _tool_contexts_write(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "")
    file_path = str(args.get("file_path") or "")
    content = str(args.get("content") or "")
    if not name or not file_path:
        return {"ok": False, "error": "name and file_path are required"}
    from contexts import CONTEXTS_DIR, safe_context_file_path
    try:
        full_path = safe_context_file_path(name, file_path)
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content)
        return {"ok": True, "message": f"Written {len(content)} chars to {name}/{file_path}."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


_APPROVALS_BASE_URL = os.environ.get("WORKEROS_PUBLIC_URL", "https://workers.floom.dev")


def _approval_public_token(row: Any) -> str:
    secret = os.environ.get("FLOOM_SECRET") or "dev-secret-not-set"
    payload = ".".join(str(row[key] or "") for key in ("id", "run_id", "owner_id"))
    return hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def _tool_approvals_list_pending(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Return pending approvals with direct links the operator can open."""
    from db import get_db as _get_db
    try:
        with _get_db() as conn:
            rows = conn.execute(
                """
                SELECT a.id, a.run_id, a.worker_id, a.owner_id, a.label, a.preview, a.created_at,
                       w.name AS worker_name
                FROM approvals a
                LEFT JOIN workers w ON w.id = a.worker_id
                WHERE a.owner_id = ? AND a.status = 'pending'
                ORDER BY a.created_at ASC
                """,
                (user_id,),
            ).fetchall()
        base = _APPROVALS_BASE_URL.rstrip("/")
        result = []
        for row in rows:
            approval_id = row["id"]
            token = _approval_public_token(row)
            result.append({
                "id": approval_id,
                "worker_id": row["worker_id"],
                "worker_name": row["worker_name"] or row["worker_id"],
                "run_id": row["run_id"],
                "label": row["label"],
                "preview": (row["preview"] or "")[:200] or None,
                "created_at": row["created_at"],
                "link": f"{base}/approvals/review?id={approval_id}&token={token}",
            })
        return {"ok": True, "approvals": result, "count": len(result)}
    except Exception as exc:
        logger.exception("approvals__list_pending failed")
        return {"ok": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Slack channel reading (consent = invite)
#
# Slack only lets the bot read a channel it is a MEMBER of, so the operator
# controls access per-channel by inviting Emily (`/invite @Emily`). Reading is
# on-demand only (the operator asks); there is no firehose ingestion. These
# tools degrade gracefully when the channel scopes are not granted yet.
# ---------------------------------------------------------------------------

SLACK_API_BASE = "https://slack.com/api"

# Slack error -> Emily-voice, actionable message. Used so a missing scope or a
# not-invited channel never crashes the tool call; Emily tells the operator
# exactly how to grant access.
_SLACK_SCOPE_DOC = (
    "https://api.slack.com/apps -> your Workeros app -> OAuth & Permissions"
)


def _slack_read_bot_token() -> str:
    """Bot token used for reading channels. Reuses the same token helper as the
    Slack thread-reply path in main.py (multi-team aware), falling back to the
    single-workspace SLACK_BOT_TOKEN env var. Returns '' when not connected."""
    try:
        from main import _slack_bot_token_for_team  # lazy: avoid import cycle

        token = (_slack_bot_token_for_team(None) or "").strip()
        if token:
            return token
    except Exception:
        pass
    return os.environ.get("SLACK_BOT_TOKEN", "").strip()


def _slack_api_get(method: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """Call a Slack Web API GET method with the bot token. Returns the parsed
    payload (which includes Slack's own {ok, error}). Raises only on transport
    failure; Slack-level errors are surfaced via payload['error']."""
    import requests  # lazy import, matches codebase style

    token = _slack_read_bot_token()
    if not token:
        return {"ok": False, "error": "no_bot_token"}
    response = requests.get(
        f"{SLACK_API_BASE}/{method}",
        headers={"Authorization": f"Bearer {token}"},
        params=params,
        timeout=15,
    )
    try:
        return response.json()
    except Exception:
        return {"ok": False, "error": f"http_{response.status_code}"}


def _slack_friendly_error(error: str) -> Dict[str, Any]:
    """Map a Slack API error code to an Emily-voice message the operator can act
    on. Never raises; the caller returns this as the tool result so the model can
    relay it verbatim."""
    if error in ("no_bot_token",):
        return {
            "ok": False,
            "error": error,
            "message": (
                "Slack isn't connected to this workspace yet, so I can't read "
                "channels. Connect Slack from the Assistant ('Add to Slack') first."
            ),
        }
    if error in ("missing_scope", "not_allowed_token_type", "invalid_scope"):
        return {
            "ok": False,
            "error": error,
            "message": (
                "Channel reading isn't enabled yet. The workspace owner needs to add "
                "the channel scopes (channels:read, channels:history, groups:read, "
                "groups:history) to the Workeros Slack app and reinstall it "
                f"({_SLACK_SCOPE_DOC}). Once that's done I can read any channel "
                "you've invited me to."
            ),
        }
    if error in ("not_in_channel", "channel_not_found"):
        return {
            "ok": False,
            "error": error,
            "message": (
                "I'm not in that channel yet. Invite me with /invite @Emily in the "
                "channel and I'll be able to read it. (Inviting me is how you grant "
                "consent: I can only read channels I've been added to.)"
            ),
        }
    return {
        "ok": False,
        "error": error or "unknown_error",
        "message": f"Slack returned an error I couldn't handle: {error or 'unknown'}.",
    }


def _tool_slack_list_channels(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """List the channels Emily (the bot) is a member of, so she can resolve a
    name like '#launch' to a channel id. Uses users.conversations (the bot's own
    memberships) so it only ever returns channels the operator has invited her to."""
    payload = _slack_api_get(
        "users.conversations",
        {
            "types": "public_channel,private_channel",
            "exclude_archived": "true",
            "limit": 200,
        },
    )
    if not payload.get("ok"):
        return _slack_friendly_error(str(payload.get("error") or ""))
    channels = []
    for ch in payload.get("channels", []) or []:
        channels.append({
            "id": ch.get("id"),
            "name": ch.get("name"),
            "is_private": bool(ch.get("is_private")),
            "is_member": bool(ch.get("is_member", True)),
        })
    channels.sort(key=lambda c: (c.get("name") or ""))
    return {
        "ok": True,
        "channels": channels,
        "count": len(channels),
        "note": (
            "These are the channels I've been invited to. To let me read another "
            "channel, invite me there with /invite @Emily."
        ),
    }


def _slack_resolve_channel_id(channel: str) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
    """Resolve a channel name (with or without '#') or id to a channel id the bot
    is a member of. Returns (channel_id, None) on success or (None, error_result)
    where error_result is a friendly tool result the caller should return."""
    channel = (channel or "").strip()
    if not channel:
        return None, {"ok": False, "error": "channel_required", "message": "Which channel? Give me a name like #launch or a channel id."}
    # Slack channel ids start with C (public) or G (legacy private group); a bare
    # id is used directly so the operator can paste one.
    if channel[0] in ("C", "G") and " " not in channel and channel == channel.upper():
        return channel, None
    target = channel.lstrip("#").lower()
    listing = _tool_slack_list_channels({}, "")
    if not listing.get("ok"):
        return None, listing  # propagate friendly missing_scope / no_token message
    for ch in listing.get("channels", []):
        if (ch.get("name") or "").lower() == target:
            return ch.get("id"), None
    return None, {
        "ok": False,
        "error": "not_in_channel",
        "message": (
            f"I'm not in #{target} (or it doesn't exist). If it exists, invite me "
            f"with /invite @Emily in #{target} and I'll read it."
        ),
    }


def _tool_slack_read_channel(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Read recent messages from a Slack channel on demand. Accepts a channel
    name (resolved via the bot's memberships) or a channel id. Returns cleaned
    recent messages (author + text + ts). Reading a channel ingests everyone's
    messages there, so this is invite-gated and pull-only."""
    channel_arg = str(args.get("channel") or args.get("channel_id") or args.get("name") or "")
    try:
        limit = int(args.get("limit") or 50)
    except (TypeError, ValueError):
        limit = 50
    limit = max(1, min(limit, 100))

    channel_id, err = _slack_resolve_channel_id(channel_arg)
    if err is not None:
        return err

    payload = _slack_api_get(
        "conversations.history",
        {"channel": channel_id, "limit": limit},
    )
    if not payload.get("ok"):
        return _slack_friendly_error(str(payload.get("error") or ""))

    messages = []
    for msg in payload.get("messages", []) or []:
        # Skip channel-join / system subtype noise; keep human + bot messages.
        text = (msg.get("text") or "").strip()
        if not text and not msg.get("attachments") and not msg.get("files"):
            continue
        messages.append({
            "author": msg.get("user") or msg.get("bot_id") or msg.get("username") or "unknown",
            "text": text,
            "ts": msg.get("ts"),
            "thread_ts": msg.get("thread_ts"),
            "reply_count": msg.get("reply_count"),
        })
    # Slack returns newest-first; present oldest-first for natural reading order.
    messages.reverse()
    return {
        "ok": True,
        "channel": channel_arg.lstrip("#") or channel_id,
        "channel_id": channel_id,
        "messages": messages,
        "count": len(messages),
        "privacy_note": (
            "Reading this channel includes everyone's messages in it. I only read "
            "channels I've been explicitly invited to, and only when asked."
        ),
    }


# ---------------------------------------------------------------------------
# Workspace preamble builder
# ---------------------------------------------------------------------------

def _build_workspace_preamble(user_id: str) -> str:
    """Build the dynamic preamble injected into SKILL.md."""
    from db import get_repositories
    try:
        repos = get_repositories()
        workers = repos.workers.list(user_id=user_id)
        non_system = [w for w in workers if not (w.get("manifest") or {}).get("system_worker")]
        worker_count = len(non_system)

        # Count recent runs (last 24h)
        with get_db() as conn:
            from datetime import datetime, timezone, timedelta
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
            run_rows = conn.execute(
                """
                SELECT status, COUNT(*) AS cnt
                FROM runs r
                JOIN workers w ON w.id = r.worker_id
                WHERE r.created_at > ? AND w.owner_id = ?
                GROUP BY status
                """,
                (cutoff, user_id),
            ).fetchall()
        run_summary = {r["status"]: r["cnt"] for r in run_rows}
        run_lines = [f"  {st}: {cnt}" for st, cnt in sorted(run_summary.items())]

        # Contexts
        from contexts import CONTEXTS_DIR
        context_names = []
        if CONTEXTS_DIR.is_dir():
            context_names = [d.name for d in sorted(CONTEXTS_DIR.iterdir()) if d.is_dir()]

        # Connections and secrets inventory. Keep this compact; the tools expose
        # full metadata without secret values.
        connection_lines: list[str] = []
        secret_names: list[str] = []
        try:
            from db import get_repositories
            repos = get_repositories()
            for c in repos.connections.list(user_id=user_id):
                app_name = c.get("app_name") or "connection"
                status = c.get("status") or "unknown"
                account = c.get("display_name") or c.get("account_label")
                label = f"{app_name} · {account}" if account else str(app_name)
                connection_lines.append(f"  {label} ({status})")
            secret_names = sorted(repos.secrets.list_names(user_id=user_id))
        except Exception:
            connection_lines = []
            secret_names = []

        # Pending approvals count
        try:
            with get_db() as _conn:
                _arow = _conn.execute(
                    "SELECT COUNT(*) AS cnt FROM approvals WHERE owner_id = ? AND status = 'pending'",
                    (user_id,),
                ).fetchone()
            pending_approvals = int(_arow["cnt"] or 0) if _arow else 0
        except Exception:
            pending_approvals = 0

        base = _APPROVALS_BASE_URL.rstrip("/")
        preamble_lines = [
            "## Workspace snapshot",
            f"- Workers: {worker_count}",
            "- Runs (last 24h):",
        ]
        preamble_lines.extend(run_lines if run_lines else ["  (none)"])
        preamble_lines.append("- Connections:")
        preamble_lines.extend(connection_lines if connection_lines else ["  (none)"])
        preamble_lines.append(
            f"- Secret names: {', '.join(secret_names) if secret_names else '(none)'}"
        )
        preamble_lines.append(f"- Brain packs: {', '.join(context_names) if context_names else '(none)'}")
        if pending_approvals > 0:
            preamble_lines.append(
                f"- Pending approvals: {pending_approvals} — operator can act at {base}/approvals"
            )
        return "\n".join(preamble_lines)
    except Exception as exc:
        logger.warning("Failed to build workspace preamble: %s", exc)
        return "## Workspace snapshot\n(unavailable)"


def _build_system_prompt(user_id: str) -> str:
    """Build the full system prompt: workspace.md + preamble + SKILL.md."""
    workspace_content = get_workspace_md()
    preamble = _build_workspace_preamble(user_id)
    from worker_registry import WORKERS_DIR
    skill_path = WORKERS_DIR / WORKSPACE_AGENT_ID / "SKILL.md"
    skill_md = skill_path.read_text() if skill_path.is_file() else ""
    skill_md = skill_md.replace("{{WORKSPACE_PREAMBLE}}", preamble)
    return "\n\n".join(part for part in [workspace_content, skill_md] if part)


# Per-call environment notes. The personality (workspace.md) is shared and
# identical everywhere; only this short, env-aware context is injected per call
# so the assistant knows HOW it is being reached and adapts shape accordingly.
# Keep these short, a few lines. Do NOT move personality here.
ENVIRONMENT_NOTES: Dict[str, str] = {
    "slack": (
        "## Current environment: Slack\n"
        "You are currently being reached in Slack (a chat). Keep replies short and "
        "chat-shaped. The person is DMing you or mentioned you in a channel. When "
        "something needs the screen, give a workers.floom.dev link they can tap."
    ),
    "mcp": (
        "## Current environment: MCP (another AI agent)\n"
        "You are currently being driven by another AI agent via MCP, not a human. Be "
        "precise and structured, skip the warm small-talk and onboarding pleasantries, "
        "return clean actionable results the calling agent can use."
    ),
    "web": (
        "## Current environment: Workeros web assistant\n"
        "You are in the Workeros web assistant. The person can click links and see the "
        "dashboard alongside this chat."
    ),
}


def _environment_note(source: str) -> str:
    """Return the short env-aware note for a source, defaulting to web."""
    return ENVIRONMENT_NOTES.get(source, ENVIRONMENT_NOTES["web"])


def build_system_prompt_for_source(user_id: str, source: str = "web") -> str:
    """Shared personality (workspace.md) plus a short per-call environment note.

    The persona stays in workspace.md (warmth, proactivity, no em dashes, the
    swarm-of-workers framing) and is identical for every source. Only the
    appended environment note differs, so the assistant is aware of whether it
    is reached via Slack, MCP, or the web assistant.
    """
    base = _build_system_prompt(user_id)
    return f"{base}\n\n{_environment_note(source)}"


def workspace_agent_tool_metadata(user_id: str) -> List[Dict[str, str]]:
    """Return [{name, description}] for the workspace agent's tools.

    Includes the workspace-management tools, the read-only brain tools, and the
    read-only Composio app tools the agent actually gets at runtime, so the
    ``/system/workspace-agent`` endpoint and the /assistant UI honestly reflect
    the brain + read-connection capabilities. No secret values, args, or host
    paths — names + one-line descriptions only.
    """
    meta: List[Dict[str, str]] = []

    def _collect(tools: List[Any]) -> None:
        for tool in tools:
            name = str(getattr(tool, "name", "") or "")
            description = str(getattr(tool, "description", "") or "")
            if name:
                meta.append({"name": name, "description": description})

    _collect(_workspace_tools(user_id))

    # Brain + read-only Composio surface (best-effort; never raise the endpoint).
    try:
        from runner_sandbox.agent_capabilities import WORKSPACE_AGENT_POLICY

        config = build_workspace_agent_config(user_id)
        staged = _owner_brain_pack_names(user_id)
        if staged:
            _collect(_brain_read_tools(Path("/nonexistent"), staged))
        _collect(
            _composio_read_tools(config, WORKSPACE_AGENT_POLICY, user_id, lambda *_a, **_k: None)
        )
    except Exception:
        logger.debug("workspace_agent_tool_metadata: capability surface unavailable", exc_info=True)

    return meta


def workspace_agent_info(user_id: str) -> Dict[str, Any]:
    """Read-only metadata for the workspace agent that powers /chat.

    Returns the resolved system prompt (workspace.md + engine SKILL.md + live
    workspace snapshot) and the agent's available tools (names + descriptions).
    Contains no secret values.
    """
    return {
        "agent_id": WORKSPACE_AGENT_ID,
        "model": os.environ.get("WORKEROS_CHAT_MODEL") or DEFAULT_WORKSPACE_AGENT_MODEL,
        "system_prompt": _build_system_prompt(user_id),
        "tools": workspace_agent_tool_metadata(user_id),
        "channels": {
            "slack": {
                "events_configured": bool((os.environ.get("SLACK_SIGNING_SECRET") or "").strip()),
                "bot_configured": bool((os.environ.get("SLACK_BOT_TOKEN") or "").strip()),
                "allowed_team_ids_configured": bool((os.environ.get("SLACK_ALLOWED_TEAM_IDS") or "").strip()),
            }
        },
    }


# ---------------------------------------------------------------------------
# Chat streaming
# ---------------------------------------------------------------------------

async def stream_chat(
    message: str,
    user_id: str,
    conversation_id: Optional[str],
    part_queue: asyncio.Queue,
    source: str = "web",
) -> None:
    """Run the workspace agent and push SSE parts into part_queue.

    Pushes dicts matching the AI SDK part format. Final part is
    {"type": "finish", "conversation_id": ..., "message_id": ...}.
    """
    from agents import Agent, ModelSettings, RunConfig, Runner
    from worker_registry import WORKERS_DIR

    # Resolve or create conversation
    if conversation_id:
        conv = get_conversation(conversation_id, user_id)
        if not conv:
            conversation_id = None
    if not conversation_id:
        # Auto-title from first message
        title = message[:60] + ("..." if len(message) > 60 else "")
        conversation_id = create_conversation(user_id, title=title)

    # Persist user message
    insert_message(conversation_id, "user", message)

    # Load history (last 50 messages)
    history = load_conversation_history(conversation_id, limit=CONVERSATION_WINDOW)

    # Build input string from history for the Agents SDK.
    # The SDK accepts a list of user/assistant messages or a plain string.
    # We construct the conversation as a thread by passing only user/assistant messages
    # as context, since tool messages use a different format.
    # The SDK also supports passing history via to_input_list() but we persist
    # only text content. Build a simple summary of history as a system addition.
    history_summary_parts: List[str] = []
    for h in history[:-1]:  # Exclude the just-inserted user message
        role = h["role"]
        if role == "tool":
            continue  # Skip raw tool results — too verbose
        content = h["content"][:500] if len(h["content"]) > 500 else h["content"]
        history_summary_parts.append(f"{role.upper()}: {content}")

    input_messages: List[Dict[str, Any]] = []
    if history_summary_parts:
        context = "\n\n".join(history_summary_parts)
        input_messages.append({
            "role": "user",
            "content": f"[CONVERSATION HISTORY]\n{context}\n\n[CURRENT MESSAGE]\n{message}",
        })
    else:
        input_messages.append({"role": "user", "content": message})

    system_prompt = build_system_prompt_for_source(user_id, source)
    workspace_tools = _workspace_tools(user_id)

    # ------------------------------------------------------------------
    # Runtime capabilities: brain + read-only connections + MCP.
    #
    # The interactive assistant gets the SAME capability builder a worker
    # gets (apps/api/runner_sandbox/agent_capabilities.py), under the
    # read-only WORKSPACE_AGENT_POLICY:
    #   - brain packs staged read-only into a per-conversation tree,
    #   - read-only Composio app tools (mutating tools excluded + refused),
    #   - registered MCP servers dialled with require_approval="always".
    # This makes the /assistant claim ("shares your Brain and Connections")
    # true. SSRF/secret/owner-scope guards carry over from the shared module.
    # ------------------------------------------------------------------
    from runner_sandbox import agent_capabilities
    from runner_sandbox.agent_capabilities import WORKSPACE_AGENT_POLICY

    def _cap_log(message: str, level: str = "info") -> None:
        logger.log(
            {"debug": logging.DEBUG, "info": logging.INFO,
             "warning": logging.WARNING, "error": logging.ERROR}.get(level, logging.INFO),
            "[workspace-agent capabilities] %s", message,
        )

    workspace_config = build_workspace_agent_config(user_id)

    # Stage owner brain packs read-only into a per-conversation context tree.
    from runner_utils import ARTIFACTS_DIR
    cap_context_root = (Path(ARTIFACTS_DIR) / f"chat_{conversation_id}" / "context").resolve()
    cap_context_root.mkdir(parents=True, exist_ok=True)
    staged_packs = agent_capabilities.stage_context_packs(
        config=workspace_config,
        context_root=cap_context_root,
        user_id=user_id,
        log_fn=_cap_log,
    )

    # Brain read tools (owner-scoped to the staged tree).
    brain_tools = _brain_read_tools(cap_context_root, staged_packs)

    # Read-only Composio app tools.
    composio_tools = _composio_read_tools(
        workspace_config, WORKSPACE_AGENT_POLICY, user_id, _cap_log
    )

    # Resolve secrets needed for MCP bearer auth (owner-scoped, never logged).
    from db import get_repositories as _get_repos
    mcp_secret_names = {
        getattr(getattr(c, "mcp", None), "auth", "").split(":", 1)[1]
        for c in workspace_config.connections
        if getattr(c, "mcp", None) is not None and getattr(c.mcp, "auth", None)
    }
    mcp_secrets = (
        _get_repos().secrets.resolve(user_id=user_id, names=mcp_secret_names)
        if mcp_secret_names else {}
    )

    if staged_packs:
        system_prompt += (
            "\n\n## Workspace Brain (read-only)\n\n"
            f"These brain packs are attached: {', '.join(sorted(staged_packs))}. "
            "Read them with brain__list and brain__read for reference knowledge."
        )

    # Finish-with-outputs tool
    from agents import FunctionTool

    final_reply_box: Dict[str, str] = {}

    # Placeholder; real handler is wired after assistant_text_parts is defined below
    async def _finish_placeholder(_ctx: Any, raw_args: str) -> str:
        return json.dumps({"ok": True, "finished": True})

    finish_tool = FunctionTool(
        name="finish_with_outputs",
        description="Call this when you have the final reply ready. Pass {\"reply\": \"<markdown>\"}.",
        params_json_schema={
            "type": "object",
            "properties": {"reply": {"type": "string"}},
            "required": ["reply"],
        },
        on_invoke_tool=_finish_placeholder,
        strict_json_schema=False,
    )

    from agents import WebSearchTool
    all_tools = (
        workspace_tools
        + brain_tools
        + composio_tools
        + [WebSearchTool(), finish_tool]
    )

    # Per-run, loop-local OpenAI client. Worker runs execute in their own fresh
    # asyncio loops and would otherwise share the SDK's process-wide httpx
    # client with this chat stream; a closing worker loop poisons the shared
    # client with "Event loop is closed". A dedicated client per chat stream
    # isolates this path from concurrent worker-run loops.
    from runner_sandbox.loop_local_provider import LoopLocalModelProvider

    loop_local_provider = LoopLocalModelProvider()
    run_config = RunConfig(
        workflow_name="workeros:workspace-agent",
        trace_id=f"chat_{uuid.uuid4().hex[:16]}",
        trace_metadata={"conversation_id": conversation_id, "user_id": user_id},
        model_provider=loop_local_provider.provider,
    )

    # Buffer assistant text and tool messages for persistence
    assistant_text_parts: List[str] = []
    pending_tool_calls: Dict[str, Dict[str, Any]] = {}  # call_id -> {name, args}

    # Wire finish tool to emit the reply as a text part
    async def _finish_invoke_inner(_ctx: Any, raw_args: str) -> str:
        try:
            args = json.loads(raw_args or "{}")
        except json.JSONDecodeError:
            args = {}
        reply = strip_em_dashes(str(args.get("reply") or ""))
        final_reply_box["reply"] = reply
        # Emit as text part if the agent didn't stream text deltas
        if reply and not assistant_text_parts:
            assistant_text_parts.append(reply)
            await part_queue.put({"type": "text", "text": reply})
        return json.dumps({"ok": True, "finished": True})

    finish_tool.on_invoke_tool = _finish_invoke_inner

    final_message_id: Optional[str] = None
    emitted_text_delta = False
    mcp_servers: List[Any] = []

    try:
        # Dial registered MCP servers (read-only policy → require_approval=always).
        # SSRF + auth-header injection carry over from the shared module. A failed
        # MCP dial degrades gracefully: the assistant still answers with its other
        # tools rather than 500-ing the whole chat.
        try:
            mcp_servers = await agent_capabilities.connect_mcp_servers(
                workspace_config, mcp_secrets, _cap_log, WORKSPACE_AGENT_POLICY
            )
        except agent_capabilities.MCPConnectionError as exc:
            _cap_log(f"MCP unavailable, continuing without it: {exc}", "warning")
            mcp_servers = []

        agent = Agent(
            name=WORKSPACE_AGENT_ID,
            instructions=system_prompt,
            tools=all_tools,
            mcp_servers=mcp_servers,
            model=os.environ.get("WORKEROS_CHAT_MODEL") or DEFAULT_WORKSPACE_AGENT_MODEL,
            model_settings=ModelSettings(
                max_tokens=4096,
                include_usage=True,
            ),
            tool_use_behavior={"stop_at_tool_names": ["finish_with_outputs"]},
        )

        result = Runner.run_streamed(
            agent,
            input=input_messages,
            max_turns=30,
            run_config=run_config,
        )

        async for event in result.stream_events():
            event_type = getattr(event, "type", None)

            if event_type == "raw_response_event":
                data = getattr(event, "data", None)
                data_type = str(getattr(data, "type", "") or "")
                delta = getattr(data, "delta", None)
                if delta and data_type.endswith("output_text.delta"):
                    text = strip_em_dashes(str(delta))
                    assistant_text_parts.append(text)
                    part = {"type": "text", "text": text}
                    emitted_text_delta = True
                    await part_queue.put(part)
                continue

            if event_type != "run_item_stream_event":
                continue

            name = getattr(event, "name", None)
            item = getattr(event, "item", None)
            raw_item = getattr(item, "raw_item", None)

            def _get(obj: Any, key: str) -> Any:
                if isinstance(obj, dict):
                    return obj.get(key)
                return getattr(obj, key, None)

            if name == "message_output_created" and not emitted_text_delta:
                content_list = _get(raw_item, "content") or []
                texts = []
                for c in content_list:
                    t = _get(c, "text")
                    if t:
                        texts.append(str(t))
                full_text = strip_em_dashes("".join(texts))
                if full_text:
                    assistant_text_parts.append(full_text)
                    await part_queue.put({"type": "text", "text": full_text})

            elif name == "tool_called":
                call_id = str(_get(raw_item, "call_id") or _get(raw_item, "id") or f"call_{uuid.uuid4().hex[:8]}")
                tool_name_raw = str(_get(raw_item, "name") or "tool")
                raw_args = _get(raw_item, "arguments") or _get(raw_item, "input") or {}
                if isinstance(raw_args, str):
                    try:
                        raw_args = json.loads(raw_args)
                    except Exception:
                        pass
                pending_tool_calls[call_id] = {"name": tool_name_raw, "args": raw_args}
                await part_queue.put({
                    "type": "tool-call",
                    "toolName": tool_name_raw,
                    "args": raw_args,
                    "callId": call_id,
                })

            elif name == "tool_output":
                call_id_raw = _get(raw_item, "call_id") or _get(raw_item, "id") or ""
                call_id = str(call_id_raw)
                output = getattr(item, "output", None)
                try:
                    parsed_output = json.loads(output) if isinstance(output, str) else output
                except Exception:
                    parsed_output = output
                await part_queue.put({
                    "type": "tool-result",
                    "callId": call_id,
                    "result": parsed_output,
                    "isError": isinstance(parsed_output, dict) and not parsed_output.get("ok", True),
                })
                # Persist tool message
                content_str = json.dumps(parsed_output, default=str) if not isinstance(parsed_output, str) else parsed_output
                insert_message(conversation_id, "tool", content_str, tool_call_id=call_id)

        # Persist full assistant reply
        full_reply = "".join(assistant_text_parts).strip()
        if not full_reply and "reply" in final_reply_box:
            full_reply = final_reply_box["reply"]
        if full_reply:
            final_message_id = insert_message(conversation_id, "assistant", full_reply)

        # Evict if needed
        _maybe_evict_conversation(conversation_id, user_id)

        await part_queue.put({
            "type": "finish",
            "conversation_id": conversation_id,
            "message_id": final_message_id,
        })

    except Exception as exc:
        logger.exception("stream_chat failed for conversation %s", conversation_id)
        await part_queue.put({
            "type": "error",
            "error": str(exc),
            "conversation_id": conversation_id,
        })
        await part_queue.put({
            "type": "finish",
            "conversation_id": conversation_id,
            "message_id": None,
        })
    finally:
        # Tear down MCP servers (best-effort) before releasing the OpenAI client.
        if mcp_servers:
            await agent_capabilities.cleanup_mcp_servers(mcp_servers, _cap_log)
        # Release the per-stream OpenAI + httpx client on this loop.
        await loop_local_provider.aclose()
