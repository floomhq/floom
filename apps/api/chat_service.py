"""Workspace agent chat service — S37.

Implements POST /chat: a streaming SSE endpoint that routes user messages
through the workspace-agent worker (system_worker: true) and persists
conversation history.

Conversation context is bounded to the latest 50 messages for the model, but
the persisted raw conversation history is never pruned.

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
CONVERSATION_WINDOW = 50       # LLM context window; stored rows are permanent
CONVERSATION_KEEP_VERBATIM = 20  # retained for legacy summary compatibility
WORKSPACE_MD_PATH = Path(__file__).resolve().parents[3] / "workspace.md"
WORKSPACE_BASE_PERSONA_PATH = Path(__file__).resolve().parents[3] / "workspace.base.md"
WORKSPACE_MD_TEMPLATE = Path(__file__).resolve().parents[3] / "workspace.md.template"

EMILY_BASE_PERSONA = """# Emily

I'm Emily, your chief-of-staff for this Workeros workspace.

You tell me what you want done and I handle it: routing tasks to the right
workers, surfacing what needs your attention, and letting you know when something
breaks before you have to ask.

## Character

- Direct and warm. Not a corporate chatbot. Not "how can I help you today?"
- Honest about what I know and what I don't. If I'm unsure, I look it up.
- No em dashes. No emoji unless you use them first.
- Concise. Every sentence earns its place.

## What I do on a bare greeting

When you open a conversation without a specific task, I check the workspace
immediately (pending approvals, failing workers, runs that need attention) and
lead with what matters. I don't wait to be asked.

## How I work

**Act, then report.** I call tools and synthesize results. I don't narrate the
process unless it reveals something you need to act on. No "Let me check...".

**No clarification by default.** If I can figure it out from context or by calling
a tool, I do. I only ask when the action is irreversible and the cost of a wrong
guess is high.

**Acknowledge fast.** On a non-trivial request I say what I'm doing and start
immediately. I don't hold the reply until every tool has settled.

**Outbound needs a thumbs-up.** Any worker that sends emails, posts, or messages
to people outside this workspace will ask for your approval first. That's what
the approval queue is for.

**Links over walls of text.** When something needs the UI (approve a run, connect
a tool, sign in), I give you the exact link. I don't describe where to go.

**Never fabricate.** If I don't have the data, I say so and call a tool or tell
you what's missing. No invented run IDs, no made-up worker outputs.
"""

DEFAULT_WORKSPACE_CUSTOM_INSTRUCTIONS = (
    "# Workspace Custom Instructions\n\n"
    "Add tenant-specific preferences, standing context, and operating rules here. "
    "Emily's base identity is built into the Workeros engine and does not depend "
    "on this editable file."
)

DEFAULT_WORKSPACE_AGENT_SETTINGS: Dict[str, bool] = {
    "brain_read": True,
    "brain_write": False,
    "connections_read": True,
    "connections_use": False,
    "connections_add": False,
}


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


def _is_bare_greeting(message: str) -> bool:
    text = " ".join(str(message or "").strip().lower().split())
    text = text.rstrip("!.?")
    return text in {
        "hi",
        "hello",
        "hey",
        "hiya",
        "yo",
        "good morning",
        "good afternoon",
        "good evening",
    }


def _ensure_bare_greeting_identity(message: str, reply: str) -> str:
    """Make the bare-greeting contract deterministic without changing persona text."""
    if not _is_bare_greeting(message):
        return reply
    text = str(reply or "").strip()
    if not text or "I'm Emily" in text:
        return text
    for prefix in (
        "Hi. I checked the workspace.\n\n",
        "Hello. I checked the workspace.\n\n",
        "Hi. I checked the workspace.",
        "Hello. I checked the workspace.",
        "Hi.\n\n",
        "Hello.\n\n",
        "Hi. ",
        "Hello. ",
    ):
        if text.startswith(prefix):
            text = text[len(prefix):].lstrip()
            break
    return f"I'm Emily. {text}" if text else "I'm Emily."


# ---------------------------------------------------------------------------
# workspace prompt helpers
# ---------------------------------------------------------------------------

def get_workspace_base_persona() -> str:
    """Return the editable base persona override, or the engine default."""
    if WORKSPACE_BASE_PERSONA_PATH.is_file():
        return WORKSPACE_BASE_PERSONA_PATH.read_text(encoding='utf-8')
    return EMILY_BASE_PERSONA


def set_workspace_base_persona(content: str) -> None:
    """Overwrite the optional base persona override."""
    WORKSPACE_BASE_PERSONA_PATH.parent.mkdir(parents=True, exist_ok=True)
    WORKSPACE_BASE_PERSONA_PATH.write_text(content, encoding='utf-8')


def get_workspace_md() -> str:
    """Return editable workspace custom instructions, or a custom-only default."""
    if WORKSPACE_MD_PATH.is_file():
        return WORKSPACE_MD_PATH.read_text(encoding='utf-8')
    if WORKSPACE_MD_TEMPLATE.is_file():
        return WORKSPACE_MD_TEMPLATE.read_text(encoding='utf-8')
    return DEFAULT_WORKSPACE_CUSTOM_INSTRUCTIONS


def unwrap_workspace_body(body: str) -> str:
    """Normalise a workspace.md write body to raw markdown.

    The OSS ``PUT /workspace`` contract is a RAW ``text/markdown`` body, but the
    Cloud wrapper (and some clients) send a JSON envelope ``{"content": "..."}``
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
    WORKSPACE_MD_PATH.write_text(content, encoding='utf-8')


def _settings_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def get_workspace_agent_settings(user_id: str) -> Dict[str, bool]:
    """Load per-user workspace-agent capability flags with safe defaults.

    Defaults are read-only for brain and connections. Write/use/add powers are
    opt-in per workspace user.
    """
    settings = dict(DEFAULT_WORKSPACE_AGENT_SETTINGS)
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT brain_read, brain_write, connections_read,
                       connections_use, connections_add
                FROM workspace_agent_settings
                WHERE user_id = ?
                """,
                (user_id,),
            ).fetchone()
    except Exception:
        return settings
    if not row:
        return settings
    for key, default in DEFAULT_WORKSPACE_AGENT_SETTINGS.items():
        settings[key] = _settings_bool(row[key], default)
    return settings


def set_workspace_agent_settings(user_id: str, updates: Dict[str, Any]) -> Dict[str, bool]:
    """Persist the provided workspace-agent capability flags."""
    current = get_workspace_agent_settings(user_id)
    for key, default in DEFAULT_WORKSPACE_AGENT_SETTINGS.items():
        if key in updates:
            current[key] = _settings_bool(updates.get(key), default)
    ts = now_iso()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO workspace_agent_settings
                (user_id, brain_read, brain_write, connections_read,
                 connections_use, connections_add, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                brain_read = excluded.brain_read,
                brain_write = excluded.brain_write,
                connections_read = excluded.connections_read,
                connections_use = excluded.connections_use,
                connections_add = excluded.connections_add,
                updated_at = excluded.updated_at
            """,
            (
                user_id,
                1 if current["brain_read"] else 0,
                1 if current["brain_write"] else 0,
                1 if current["connections_read"] else 0,
                1 if current["connections_use"] else 0,
                1 if current["connections_add"] else 0,
                ts,
                ts,
            ),
        )
    return current


# ---------------------------------------------------------------------------
# Conversation persistence
# ---------------------------------------------------------------------------

def _client_conversation_storage_id(raw_id: str, user_id: str) -> str:
    """Map caller-supplied thread ids to owner-scoped internal conversation ids."""
    digest = hashlib.sha256(f"{user_id}\0{raw_id}".encode("utf-8")).hexdigest()[:32]
    return f"conv_client_{digest}"


def resolve_conversation_id(raw_id: Optional[str], user_id: str) -> Optional[str]:
    """Return the internal conversation id for a server or caller supplied id."""
    if not raw_id:
        return None
    value = str(raw_id).strip()
    if not value:
        return None
    if value.startswith("conv_"):
        with get_db() as conn:
            row = conn.execute(
                "SELECT user_id FROM conversations WHERE id = ?",
                (value,),
            ).fetchone()
        if row and row["user_id"] != user_id:
            return _client_conversation_storage_id(value, user_id)
        return value
    return _client_conversation_storage_id(value, user_id)


def create_conversation(
    user_id: str,
    title: Optional[str] = None,
    conversation_id: Optional[str] = None,
) -> str:
    conv_id = conversation_id or f"conv_{uuid.uuid4().hex[:16]}"
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
    """Compatibility hook retained for callers; raw chat rows are permanent."""
    return None


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


def build_workspace_agent_config(user_id: str, settings: Optional[Dict[str, bool]] = None) -> Any:
    """Synthesize a WorkerConfig that gives the interactive workspace agent the
    brain + connection capabilities enabled for this workspace user.

    - ``connections``: every active DB-registered Composio app is declared as a
      read-only connection by default, or full-scope when ``connections_use`` is
      enabled; every active registered MCP server (``kind == "mcp"``) is declared
      as a ``WorkerMCPConnection`` so the shared builder dials it with approval.
    - ``contexts``: every owner brain pack, staged when ``brain_read`` is enabled.

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

    settings = {**DEFAULT_WORKSPACE_AGENT_SETTINGS, **(settings or get_workspace_agent_settings(user_id))}
    repos = get_repositories()
    connections: List[Any] = []
    if settings.get("connections_read") or settings.get("connections_use"):
        composio_scope = "full" if settings.get("connections_use") else "read_only"
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
                            composio=WorkerComposioConnection(app=str(app), scope=composio_scope)
                        )
                    )
                except Exception as exc:
                    logger.warning("Skipping invalid registered Composio connection %s: %s", app, exc)
                    continue

    contexts: List[Any] = []
    if settings.get("brain_read"):
        contexts = [
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

def _brain_read_tools(
    context_root: Path,
    staged_packs: List[str],
    *,
    user_id: Optional[str] = None,
    allow_read: bool = True,
    allow_write: bool = False,
) -> List[Any]:
    """File tools over the workspace brain packs, gated by capability flags.

    Read tools resolve paths under the staged ``context_root`` only. Write uses
    the canonical context helpers under the caller's owner scope so edits persist
    to the real brain pack only when ``brain_write`` is enabled.
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

    async def _write(_ctx: Any, raw_args: str) -> str:
        try:
            args = json.loads(raw_args or "{}")
        except json.JSONDecodeError as exc:
            return json.dumps({"ok": False, "error": f"Invalid JSON: {exc}"})
        pack = str(args.get("pack") or args.get("name") or "").strip()
        file_path = str(args.get("path") or args.get("file_path") or "").strip()
        content = str(args.get("content") or "")
        if not pack or not file_path:
            return json.dumps({"ok": False, "error": "pack and path are required"})
        try:
            from contexts import context_scope_for_user, safe_context_file_path, use_context_scope
            from secret_scan import scan_bytes

            findings = scan_bytes(content.encode("utf-8", errors="replace"))
            if findings:
                patterns = ", ".join(sorted({f.pattern for f in findings}))
                return json.dumps({
                    "ok": False,
                    "error": (
                        "Refusing to write likely credential material into a brain pack "
                        f"({patterns}). Store credentials in Secrets instead."
                    ),
                })
            with use_context_scope(context_scope_for_user(user_id or "")):
                full_path = safe_context_file_path(pack, file_path)
                full_path.parent.mkdir(parents=True, exist_ok=True)
                full_path.write_text(content, encoding='utf-8')
            return json.dumps({"ok": True, "message": f"Written {len(content)} chars to {pack}/{file_path}."})
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)})

    tools: List[Any] = []
    if allow_read:
        tools.extend([
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
        ])
    if allow_write:
        tools.append(
            FunctionTool(
                name="brain__write",
                description="Create or update a UTF-8 file in a workspace brain pack.",
                params_json_schema={
                    "type": "object",
                    "properties": {
                        "pack": {"type": "string"},
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["pack", "path", "content"],
                },
                on_invoke_tool=_write,
                strict_json_schema=False,
            )
        )
    return tools


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


def _workspace_agent_policy(settings: Dict[str, bool]) -> Any:
    """Return the runtime connection policy for current workspace-agent flags."""
    from runner_sandbox.agent_capabilities import CapabilityPolicy, WORKSPACE_AGENT_POLICY

    if settings.get("connections_use"):
        return CapabilityPolicy(
            composio_scope_override=None,
            mcp_require_approval="always",
            allow_mutating_composio=True,
        )
    return WORKSPACE_AGENT_POLICY


# ---------------------------------------------------------------------------
# Workspace-management tools (available only to workspace-agent)
# ---------------------------------------------------------------------------

def _workspace_tools(user_id: str, settings: Optional[Dict[str, bool]] = None) -> List[Any]:
    """Build FunctionTool list for workspace-management capabilities."""
    from agents import FunctionTool
    settings = settings or get_workspace_agent_settings(user_id)

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
            "mcp_tools__list",
            "List custom MCP tools registered for this workspace.",
            {"type": "object", "properties": {}, "required": []},
            _tool_mcp_tools_list,
        ),
        _make_tool(
            "mcp_tools__register",
            (
                "Register a custom MCP tool backed by an existing worker. "
                "The tool becomes callable through the Workeros MCP server."
            ),
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "worker_id": {"type": "string"},
                    "input_schema": {"type": "object"},
                },
                "required": ["name", "description", "worker_id"],
            },
            _tool_mcp_tools_register,
        ),
        _make_tool(
            "mcp_tools__update",
            "Update a custom MCP tool by name.",
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "worker_id": {"type": "string"},
                    "input_schema": {"type": "object"},
                },
                "required": ["name"],
            },
            _tool_mcp_tools_update,
        ),
        _make_tool(
            "mcp_tools__delete",
            "Delete a custom MCP tool by name.",
            {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
            _tool_mcp_tools_delete,
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
    blocked: set[str] = set()
    if not settings.get("connections_read"):
        blocked.add("connections__list")
    if not settings.get("connections_add"):
        blocked.add("connections__add_mcp")
    if not settings.get("brain_read"):
        blocked.update({"contexts__list", "contexts__read"})
    if not settings.get("brain_write"):
        blocked.add("contexts__write")
    return [tool for tool in tools if str(getattr(tool, "name", "")) not in blocked]


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


def _generate_run_py_from_manifest(
    worker_id: str,
    manifest: Dict[str, Any],
    user_id: str,
    log_fn,
    *,
    force: bool = False,
) -> bool:
    """Synthesise a real run.py for a manifest-only worker, replacing the no-op stub.

    Emily produces a worker.yml but no code, so the registered bundle carries the
    placeholder run.py (``_DEFAULT_RUN_PY_STUB``). This drives the SAME codegen
    engine the smoke-repair loop uses (``run_service._repair_run_py``) with the
    worker's description as intent and the manifest as context, then persists the
    generated code through the canonical editor path (``main.persist_worker_run_py``)
    so the next run executes it. Returns True if real code was written.

    Best-effort: returns False on any failure (no OPENAI_API_KEY, codegen error,
    no placeholder present) — the caller still runs the smoke gate, which will
    disable the worker and surface the reason if it remains a no-op.
    """
    try:
        from worker_registry import WORKERS_DIR
        from run_service import _repair_run_py, _PLACEHOLDER_RUN_PY_MARKER
        from main import persist_worker_run_py
    except Exception:
        return False

    run_py_path = WORKERS_DIR / worker_id / "run.py"
    try:
        current = run_py_path.read_text(encoding="utf-8")
    except OSError:
        return False
    # Create only generates when the file is the no-op placeholder. Update can
    # force regeneration because Emily edits the manifest, not run.py; preserving
    # stale generated code makes behavior changes silently no-op at runtime.
    if not force and _PLACEHOLDER_RUN_PY_MARKER not in current:
        return False

    import yaml as _yaml
    import json as _json

    intent_parts = [
        str(manifest.get("description") or "").strip(),
        str(manifest.get("long_description") or "").strip(),
    ]
    intent = "\n".join(p for p in intent_parts if p) or str(
        manifest.get("title") or manifest.get("name") or worker_id
    )
    # Give the generator the full manifest so it implements EVERY declared input
    # and output, not just the description prose.
    try:
        manifest_yaml = _yaml.safe_dump(manifest, sort_keys=False)
    except Exception:
        manifest_yaml = _json.dumps(manifest, default=str)
    failure = (
        "The worker has only a placeholder run.py that returns empty outputs, so "
        "it produces none of its declared outputs. Implement the worker from its "
        "manifest below. Read inputs from inputs.json and write result.json "
        "with {\"status\",\"outputs\",\"artifacts\"}, filling EVERY declared "
        f"output.\n\nWorker manifest:\n{manifest_yaml[:4000]}"
    )

    secrets: Dict[str, str] = {}
    try:
        from run_service import get_secrets_for_worker
        secrets = get_secrets_for_worker(worker_id, user_id=user_id) or {}
    except Exception:
        secrets = {}

    fixed = _repair_run_py(
        run_code=current,
        failure=failure,
        secrets=secrets,
        log_fn=log_fn,
        intent=intent,
    )
    if not fixed:
        log_fn("run.py generation produced no code; smoke gate will disable worker", "warning")
        return False
    try:
        persist_worker_run_py(worker_id, fixed, user_id=user_id)
    except Exception as exc:
        log_fn(f"could not persist generated run.py: {exc}", "warning")
        return False
    action = "regenerated" if force else "generated"
    log_fn(f"{action} real run.py from manifest", "info")
    return True


def _canonicalize_emily_exec_command(
    yaml_text: str, existing_files: Optional[set] = None
) -> str:
    """Force a manifest-authored (Emily) worker onto a SINGLE execution path.

    Root cause of "Emily-created workers fail every real run despite the smoke
    gate reporting passed" (ISSUES.md #E1): Emily authors a *manifest*, not code.
    The runnable code is the generated ``run.py``. But ``exec.command`` OVERRIDES
    ``run.py`` in the E2B driver (``e2b_driver.py``: ``command = config.runtime.command``).
    When Emily — trying to self-repair a failing worker via ``workers__update`` —
    writes an inline ``exec.command`` heredoc, that heredoc becomes a SECOND,
    conflicting execution definition that wins over the generated ``run.py``. Her
    heredoc does not know the ``{status, outputs, artifacts}`` result.json contract
    (it lives only in the codegen prompt), so it writes the wrong shape and every
    real run fails validation, while the generated ``run.py`` is silently ignored.

    The discriminator is "does the worker's execution reference a REAL authored
    source file present on disk?":

      * LEGIT authored worker — any command or entry (in ``exec``, ``runtime``, or
        the legacy top-level ``entrypoint``) references a script file that EXISTS in
        ``existing_files`` (e.g. ``command: node run.js`` / ``entry: run.js`` with
        run.js on disk, with or without args, with ``./`` prefixes). The manifest is
        returned UNCHANGED — we never strip or rewrite a worker that has its own
        real code. This is robust to every authored shape (entry-based, command-only,
        runtime.command, args, ``./run.js``, multi-file Python).
      * MANIFEST-ONLY / DIVERGENT worker — no command or entry references an existing
        script file (the create case where Emily supplies only worker.yml, OR an
        Emily ``workers__update`` heredoc whose target file does not exist). Here we
        STRIP every ``command`` (an inline heredoc that would shadow the generated
        run.py) and redirect every ORPHANED non-run.py script entry to ``run.py`` so
        the generated run.py is the single executed script.

    Agent/skill-mode workers (``entry: SKILL.md`` / any ``.md``) carry no script and
    are LEFT UNTOUCHED.

    ``existing_files`` is the worker's actual on-disk file set on update (so real
    code is detected and preserved) and empty on create (the tool supplies no script
    source, so an orphaned heredoc/entry is always neutralised).

    Returns the (possibly rewritten) YAML text. Best-effort: on any parse error
    the original text is returned unchanged (the downstream parser will surface a
    clean validation error).
    """
    import yaml as _yaml

    existing = {str(f).strip() for f in (existing_files or set())}

    try:
        raw = _yaml.safe_load(yaml_text)
    except Exception:
        return yaml_text
    if not isinstance(raw, dict):
        return yaml_text

    import shlex as _shlex

    def _is_script_path(value: Any) -> bool:
        return isinstance(value, str) and value.strip().lower().endswith((".py", ".sh", ".js"))

    def _normalize_ref(value: str) -> str:
        # Strip a leading "./" so "./run.js" matches the on-disk "run.js".
        v = value.strip()
        return v[2:] if v.startswith("./") else v

    def _safe_split(text: str) -> list:
        # shlex handles quoted paths; fall back to plain split on malformed quoting.
        try:
            return _shlex.split(text)
        except Exception:
            return text.split()

    def _token_matches_source(tok: str) -> bool:
        """A single command/entry token references real on-disk source."""
        ref = _normalize_ref(tok)
        if ref in existing:
            return True
        # `python -m pkg.mod` -> a token like "pkg.mod" backs onto pkg/mod.py or
        # pkg/mod/__main__.py. Conservatively recognise both layouts so a legit
        # package-entry worker is preserved (Codex P1: python -m pkgworker).
        if ref and "/" not in ref and "." in ref:
            mod_path = ref.replace(".", "/")
            if f"{mod_path}.py" in existing or f"{mod_path}/__main__.py" in existing:
                return True
        elif ref and "/" not in ref:
            if f"{ref}.py" in existing or f"{ref}/__main__.py" in existing:
                return True
        return False

    def _references_existing_source() -> bool:
        """True iff ANY command/entry/entrypoint references real source present on
        disk — i.e. this is a legit authored worker we must leave entirely alone.
        Handles bare entries, command-only (with args / ./ prefixes / quoting),
        and `python -m <module>` package entries."""
        candidates: list = []
        for block_key in ("exec", "runtime"):
            block = raw.get(block_key)
            if isinstance(block, dict):
                candidates.append(("entry", block.get("entry")))
                candidates.append(("entry", block.get("entrypoint")))
                candidates.append(("command", block.get("command")))
        candidates.append(("entry", raw.get("entrypoint")))
        candidates.append(("command", raw.get("command")))
        for kind, cand in candidates:
            if not isinstance(cand, str) or not cand.strip():
                continue
            if kind == "entry":
                # A bare entry path references its own file directly.
                if _token_matches_source(cand):
                    return True
                continue
            # command: inspect every token (after the interpreter), incl. -m module.
            tokens = _safe_split(cand)
            for i, tok in enumerate(tokens):
                # `-m <module>` form: check the following token as a module.
                if tok == "-m" and i + 1 < len(tokens):
                    if _token_matches_source(tokens[i + 1]):
                        return True
                if _token_matches_source(tok):
                    return True
        return False

    # LEGIT authored worker: its execution references real on-disk source. Do not
    # touch it — stripping/rewriting would break a hand-authored run.js / node /
    # multi-file / package Python worker (Codex P1: command-only, args, ./run.js,
    # runtime.*, python -m pkg).
    if _references_existing_source():
        return yaml_text

    # MANIFEST-ONLY / DIVERGENT: no real source backs the declared execution.
    # Strip every command (heredoc shadow) and redirect orphaned script entries to
    # the generated run.py.
    changed = False
    for block_key in ("exec", "runtime"):
        block = raw.get(block_key)
        if isinstance(block, dict) and "command" in block:
            block.pop("command", None)
            changed = True
    if "command" in raw and isinstance(raw.get("command"), str):
        raw.pop("command", None)
        changed = True

    def _orphaned_script_entry(value: Any) -> bool:
        if not _is_script_path(value):
            return False
        ref = _normalize_ref(value)
        return ref != "run.py" and ref not in existing

    for block_key in ("exec", "runtime"):
        block = raw.get(block_key)
        if isinstance(block, dict):
            if _orphaned_script_entry(block.get("entry")):
                block["entry"] = "run.py"
                changed = True
            if _orphaned_script_entry(block.get("entrypoint")):
                block["entrypoint"] = "run.py"
                changed = True
    if _orphaned_script_entry(raw.get("entrypoint")):
        raw["entrypoint"] = "run.py"
        changed = True

    if not changed:
        return yaml_text
    try:
        return _yaml.safe_dump(raw, sort_keys=False, default_flow_style=False)
    except Exception:
        return yaml_text


def _manifest_executes_run_py(manifest: Dict[str, Any]) -> bool:
    """True iff the worker's EXECUTED entry is ``run.py`` (and nothing else signals
    a different executable).

    The run.py-specific machinery (stub backfill, codegen-from-manifest, the
    placeholder-marker smoke preflight) only makes sense for a manifest-only
    Python worker whose executed script IS ``run.py``. A worker whose entry is
    ``run.js`` / ``run.sh`` / a multi-file Python entry / ``SKILL.md`` — declared in
    ``exec``, ``runtime`` (incl. legacy ``runtime.entrypoint`` / ``runtime.command``),
    or the top-level ``entrypoint`` / ``command`` — must NOT get a run.py stub
    backfilled or be codegen'd/placeholder-gated on run.py; that would disable a
    perfectly good worker (Codex P1). We treat the worker as a run.py worker only
    when NO command/entry signals a non-run.py script.
    """
    def _norm(v: Any) -> Optional[str]:
        if not isinstance(v, str) or not v.strip():
            return None
        ref = v.strip()
        return ref[2:] if ref.startswith("./") else ref

    def _is_script_path(v: Optional[str]) -> bool:
        return isinstance(v, str) and v.lower().endswith((".py", ".sh", ".js"))

    # Resolve the EFFECTIVE entry exactly like the schema's precedence: an explicit
    # entry (exec/runtime/top-level) wins; else a command's script token; else the
    # canonical script default run.py. The worker is a run.py worker ONLY when that
    # resolved entry is literally run.py. An agent worker (entry: SKILL.md / any
    # non-script entry) is NOT a run.py worker (a missing extension / .md must never
    # fall through to "run.py" — Codex P1).
    # Precedence: exec.entry (canonical schema signal, S11) -> top-level entrypoint
    # -> runtime.entry/entrypoint.
    exec_block = manifest.get("exec") if isinstance(manifest.get("exec"), dict) else {}
    runtime_block = manifest.get("runtime") if isinstance(manifest.get("runtime"), dict) else {}
    explicit_entries = [
        _norm(exec_block.get("entry")),
        _norm(manifest.get("entrypoint")),
        _norm(exec_block.get("entrypoint")),
        _norm(runtime_block.get("entry")),
        _norm(runtime_block.get("entrypoint")),
    ]
    for e in explicit_entries:
        if e is not None:
            # First explicit entry signal decides (any non-run.py entry, incl.
            # SKILL.md/*.md, means NOT a run.py worker).
            return e == "run.py"

    # No explicit entry: the COMMAND defines the executable. A run.py worker's
    # canonical command is exactly "python run.py". Any other command — a script
    # token that is not run.py (node run.js), OR a non-script invocation
    # (python -m pkgworker, ./bin/start) — means this is NOT a run.py worker, so the
    # run.py machinery must not touch it (Codex P1: python -m package gate==runtime).
    for src in (manifest.get("exec"), manifest.get("runtime"), manifest):
        cmd = src.get("command") if isinstance(src, dict) else None
        if not isinstance(cmd, str) or not cmd.strip():
            continue
        toks = cmd.strip().split()
        # A script token decides directly.
        script_tok = next((_norm(t) for t in toks if _is_script_path(_norm(t))), None)
        if script_tok is not None:
            return script_tok == "run.py"
        # No script token (e.g. python -m module): a run.py worker would never
        # author this, so treat it as a non-run.py executable.
        return False

    # Nothing specified at all: the schema default for a script worker is run.py.
    return True


def _smoke_gate_emily_worker(
    worker_id: str,
    manifest: Dict[str, Any],
    user_id: str,
) -> tuple[Optional[str], Optional[str]]:
    """Synthesise run.py from the manifest, then smoke-gate against the REAL run path.

    Shared by ``workers__create`` and ``workers__update`` so a worker can never be
    persisted by EITHER tool while it silently fails every real run. The gate uses
    the SAME ``driver.run`` + ``_validate_run_outputs`` path a real run uses
    (``run_service.smoke_and_gate_generated_worker``), so a ``passed`` verdict
    means the next real run passes too (gate == runtime). A ``failed`` verdict
    DISABLES the worker (kept editable) and is surfaced to the operator.

    Returns ``(smoke_status, smoke_reason)``. ``smoke_status`` is one of
    ``"passed" | "failed" | "skipped" | "errored"`` — never ``None``, so the
    caller can NEVER report "verified runnable" for a worker whose runtime
    validation did not actually run (``errored`` = the smoke infra raised;
    ``skipped`` = the gate could not prove the worker, e.g. missing
    secret/connection). Both are reported honestly, not as verified. Never raises.
    """
    smoke_status: str = "errored"
    smoke_reason: Optional[str] = None
    try:
        from run_service import smoke_and_gate_generated_worker
        from main import get_worker_config_for_run
        from db import get_repositories

        repos = get_repositories()

        sample_input = None
        try:
            cfg = get_worker_config_for_run(worker_id)
            sample_input = getattr(cfg, "example_input", None)
        except Exception:
            sample_input = None
        bundle: Dict[str, Any] = {}
        if isinstance(sample_input, dict):
            bundle["example_input"] = sample_input
        try:
            import yaml as _yaml

            bundle["worker_yml"] = _yaml.safe_dump(manifest, sort_keys=False)
        except Exception:
            bundle["worker_yml"] = json.dumps(manifest, default=str)

        def _smoke_log(msg: str, level: str = "info") -> None:
            logger.info("emily worker smoke %s: %s", worker_id, msg)

        # Emily authors a MANIFEST, not code, so a manifest-only PYTHON worker
        # (entry: run.py) ships the no-op placeholder run.py. Synthesise real
        # run.py FROM THE MANIFEST first (codegen, the same engine the smoke-repair
        # uses), persist it through the canonical editor path, and only THEN smoke.
        # The placeholder check inside _generate_run_py_from_manifest no-ops when
        # real code already exists. Skip this for non-run.py workers (run.js /
        # run.sh / multi-file Python / SKILL.md): they have their OWN entry source
        # and must NOT be codegen'd into a run.py they do not execute (Codex P1).
        if _manifest_executes_run_py(manifest):
            _generate_run_py_from_manifest(worker_id, manifest, user_id, _smoke_log)

        smoke = smoke_and_gate_generated_worker(
            worker_id,
            bundle,
            user_id=user_id,
            repos=repos,
            log_fn=_smoke_log,
            allow_code_repair=True,
        )
        if isinstance(smoke, dict):
            smoke_status = smoke.get("status") or "errored"
            smoke_reason = smoke.get("reason")
    except Exception:
        logger.exception("emily worker smoke+gate failed for %s", worker_id)
        smoke_status = "errored"
        smoke_reason = "could not run the verification test for this worker"
    return smoke_status, smoke_reason


def _emily_worker_result_message(
    worker_id: str, verb: str, smoke_status: Optional[str], smoke_reason: Optional[str]
) -> Dict[str, Any]:
    """Build the tool result for a create/update, HONEST about whether the worker
    was actually proven runnable.

    Only a ``"passed"`` smoke means "verified runnable". A ``"failed"`` worker is
    DISABLED. A ``"skipped"`` / ``"errored"`` worker was NOT validated at runtime,
    so we must NOT claim it is verified — that is exactly the passing-gate-that-
    lies failure mode. We surface the honest state so Emily tells the operator the
    truth (e.g. "created, but I could not test it yet because it needs a secret").
    """
    base = {"ok": True, "worker_id": worker_id, "smoke_status": smoke_status}
    if smoke_status == "failed":
        return {
            **base,
            "message": (
                f"Worker '{worker_id}' was {verb} but its test run failed "
                f"({smoke_reason or 'unknown'}); it is disabled until it runs clean. "
                "Adjust the worker, then re-run."
            ),
        }
    if smoke_status == "passed":
        return {**base, "message": f"Worker '{worker_id}' {verb} and verified runnable."}
    if smoke_status == "skipped":
        # A skip can mean "intentionally off" (paused/disabled) or "can't prove
        # yet" (needs a secret/connection). In both cases runtime validation did
        # NOT run, so never claim verified. Don't assert "enabled" — a disabled
        # worker's skip reason already explains it is off.
        return {
            **base,
            "message": (
                f"Worker '{worker_id}' was {verb}, but I could NOT verify it runs yet "
                f"({smoke_reason or 'verification was skipped'}). It is untested — "
                "run it once to confirm it works."
            ),
        }
    # errored / unknown: the verification machinery itself failed; do not claim runnable.
    return {
        **base,
        "message": (
            f"Worker '{worker_id}' was {verb}, but the verification test could not be run "
            f"({smoke_reason or 'verification error'}). It is enabled but UNVERIFIED — "
            "run it once and check the result before relying on it."
        ),
    }


def _tool_workers_create(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Create a RUNNABLE worker from a worker.yml manifest — same path as the API.

    Two things must happen for an Emily-created worker to actually RUN to
    completion, and the old implementation did neither:

    1. MATERIALIZE THE BUNDLE ON DISK. The old code only wrote the workers +
       skill_versions DB rows. A worker that exists only in the DB has no bundle
       on disk, so at run time the E2B runner failed with "worker directory not
       found" (run_service._snapshot_worker_bundle / e2b_driver). This now routes
       through the SAME shared helper the HTTP/MCP create paths use
       (``main._register_worker_from_files``), which writes worker.yml, backfills
       run.py + requirements.txt, invalidates the cache, re-discovers, and
       persists the worker.

    2. GENERATE REAL run.py CODE. Emily authors a *manifest* (yaml only, no code),
       so the backfilled run.py is a no-op placeholder. A worker whose manifest
       declares an output but whose run.py produces nothing fails at run time with
       "Output schema violation". So, exactly like ``/workers/draft-and-create``
       Path B, this runs ``smoke_and_gate_generated_worker`` with
       ``allow_code_repair=True``: it detects the placeholder stub, synthesises a
       real run.py from the manifest via the codegen model, smokes it in E2B, and
       gates the worker (a smoke-failed worker is DISABLED, never deleted, and the
       verdict is surfaced to Emily). This is the proven create path — Emily's
       tool is no longer a weaker parallel implementation of it.
    """
    import yaml as _yaml
    yaml_text = str(args.get("yaml_text") or "")
    if not yaml_text:
        return {"ok": False, "error": "yaml_text is required"}
    # Single execution path: Emily authors a manifest, not code. Strip any
    # caller-supplied exec.command so the generated run.py is the ONLY executed
    # script (a divergent exec.command silently shadows run.py — ISSUES.md #E1).
    yaml_text = _canonicalize_emily_exec_command(yaml_text)
    try:
        manifest = _yaml.safe_load(yaml_text)
    except Exception as exc:
        return {"ok": False, "error": f"Invalid YAML: {exc}"}
    if not isinstance(manifest, dict):
        return {"ok": False, "error": "YAML must be a mapping"}
    if not (manifest.get("name") or manifest.get("id")):
        return {"ok": False, "error": "worker name is required in YAML"}

    # Step 1: converge onto the proven materialization path. ``dedupe_id`` rewrites
    # a colliding id to a free one (matches the worker-author hook) so a create
    # never dead-ends on a taken slug.
    from db import get_repositories
    from main import _register_worker_from_files, DraftFile
    from fastapi import HTTPException as _HTTPException

    repos = get_repositories()
    try:
        worker_id = _register_worker_from_files(
            [DraftFile(path="worker.yml", content=yaml_text)],
            user_id=user_id,
            repos=repos,
            dedupe_id=True,
        )
    except _HTTPException as exc:
        return {"ok": False, "error": str(exc.detail)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    # Step 2: generate real run.py + smoke-gate — same as draft-and-create Path B,
    # shared verbatim with workers__update so create and update gate identically.
    # Best-effort: a generation/smoke failure must not undo a successful create
    # (the worker stays editable), but it IS surfaced so Emily can tell the user
    # the worker is not yet runnable instead of presenting a dead worker as ready.
    smoke_status, smoke_reason = _smoke_gate_emily_worker(worker_id, manifest, user_id)
    return _emily_worker_result_message(worker_id, "created", smoke_status, smoke_reason)


def _tool_workers_update(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Update a worker's manifest — writes worker.yml to disk, same path as the editor.

    The previous implementation only inserted a new ``skill_versions`` row and
    re-pointed the FK; it never wrote the new worker.yml to the worker's directory.
    The runner reads ``worker.yml``/``run.py`` from ``WORKERS_DIR/<id>/`` on every
    run (run_service), so a DB-only update was silently ignored at run time — the
    same parallel-implementation gap as create. This converges onto the proven
    editor path (``main.update_worker_files``): it writes the new worker.yml to disk,
    preserves the existing run.py and other bundle files, then re-discovers and
    re-persists the worker so the manifest, disk, and DB stay in sync.
    """
    import yaml as _yaml
    worker_id = str(args.get("id") or "")
    yaml_text = str(args.get("yaml_text") or "")
    if not worker_id or not yaml_text:
        return {"ok": False, "error": "id and yaml_text are required"}

    from db import get_db as _get_db
    with _get_db() as conn:
        row = conn.execute(
            "SELECT id FROM workers WHERE id = ? AND owner_id = ?",
            (worker_id, user_id),
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"Worker not found or not owned by you: {worker_id}"}

    # Build the full new bundle: replace worker.yml, carry over every existing file
    # (run.py, SKILL.md, lib/*, ...) so the editor path does not delete them. The
    # editor endpoint removes any on-disk file absent from the payload, so we must
    # resend the rest verbatim.
    from main import (
        update_worker_files,
        WorkerFilesUpdateRequest,
        WorkerFilePatch,
        AuthContext,
        _read_worker_files,
        _DEFAULT_RUN_PY_STUB,
        get_repositories,
    )
    from fastapi import HTTPException as _HTTPException
    from worker_registry import WORKERS_DIR

    worker_dir = WORKERS_DIR / worker_id
    # Read the EXISTING on-disk file set FIRST so the entry-normalisation can
    # preserve a legitimate hand-authored run.js / multi-file Python worker (its
    # source is present) and only redirect an orphaned script entry to run.py.
    existing_files: set = set()
    carried: list = []
    if worker_dir.is_dir():
        for wf in _read_worker_files(worker_dir):
            if wf.path == "worker.yml" or wf.binary or wf.content is None:
                continue
            carried.append(wf)
            existing_files.add(wf.path)

    # Single execution path (ISSUES.md #E1): strip a divergent exec.command and
    # redirect an ORPHANED non-run.py script entry (run.sh/run.js with no source)
    # to the generated run.py — but never clobber a real authored entry file.
    yaml_text = _canonicalize_emily_exec_command(yaml_text, existing_files=existing_files)
    try:
        manifest = _yaml.safe_load(yaml_text)
    except Exception as exc:
        return {"ok": False, "error": f"Invalid YAML: {exc}"}
    if not isinstance(manifest, dict):
        return {"ok": False, "error": "YAML must be a mapping"}

    files: list = [WorkerFilePatch(path="worker.yml", content=yaml_text)]
    seen = {"worker.yml"}
    for wf in carried:
        if wf.path in seen:
            continue
        files.append(WorkerFilePatch(path=wf.path, content=wf.content))
        seen.add(wf.path)
    if "run.py" not in seen and _manifest_executes_run_py(manifest):
        # Legacy run.py worker materialized without a run.py: backfill the runnable
        # stub so the update yields a runnable bundle. Only for workers that
        # EXECUTE run.py — a run.js / SKILL.md worker must not get an unused run.py
        # stub (the placeholder-marker smoke preflight would then disable a good
        # worker — Codex P1).
        files.append(WorkerFilePatch(path="run.py", content=_DEFAULT_RUN_PY_STUB))

    auth = AuthContext(user_id=user_id)
    try:
        update_worker_files(
            worker_id,
            WorkerFilesUpdateRequest(files=files),
            auth=auth,
            repos=get_repositories(),
        )
    except _HTTPException as exc:
        return {"ok": False, "error": str(exc.detail)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    if _manifest_executes_run_py(manifest):
        def _update_codegen_log(msg: str, level: str = "info") -> None:
            logger.info("emily worker update codegen %s: %s", worker_id, msg)

        _generate_run_py_from_manifest(
            worker_id,
            manifest,
            user_id,
            _update_codegen_log,
            force=True,
        )

    # Gate == runtime (ISSUES.md #E1): an update that would break every real run
    # must NOT be persisted as a silent success. Run the SAME smoke gate create
    # uses — it validates via the real driver.run + _validate_run_outputs path,
    # so a `passed` verdict means real runs pass and a `failed` verdict DISABLES
    # the worker (kept editable) and is surfaced. This closes the gap where the
    # update path wrote a manifest with zero validation.
    smoke_status, smoke_reason = _smoke_gate_emily_worker(worker_id, manifest, user_id)
    return _emily_worker_result_message(worker_id, "updated", smoke_status, smoke_reason)


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
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return {"ok": False, "error": "Secret value must not contain newline or control characters"}
    env_key = name.upper()
    from db import get_repositories
    repos = get_repositories()
    repos.secrets.set(user_id=user_id, name=env_key, value=value, status="set")
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


def _mcp_tool_input_schema_from_worker(worker: Dict[str, Any]) -> Dict[str, Any]:
    config = worker.get("config") or {}
    inputs = config.get("inputs") if isinstance(config, dict) else []
    if not isinstance(inputs, list):
        return {"type": "object", "properties": {}}
    properties: Dict[str, Any] = {}
    required: List[str] = []
    type_map = {
        "string": "string",
        "text": "string",
        "markdown": "string",
        "number": "number",
        "integer": "integer",
        "boolean": "boolean",
        "bool": "boolean",
        "object": "object",
        "json": "object",
        "array": "array",
    }
    for item in inputs:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        raw_type = str(item.get("type") or item.get("kind") or "string").lower()
        schema_type = type_map.get(raw_type, "string")
        prop: Dict[str, Any] = {"type": schema_type}
        if item.get("description"):
            prop["description"] = str(item["description"])
        if isinstance(item.get("options"), list):
            prop["enum"] = [str(option) for option in item["options"]]
        properties[name] = prop
        if item.get("required"):
            required.append(name)
    schema: Dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


def _resolve_mcp_tool_worker(worker_ref: str, user_id: str) -> Dict[str, Any] | None:
    from db import get_repositories
    repos = get_repositories()
    worker = repos.workers.get(user_id=user_id, worker_id=worker_ref)
    if worker:
        return worker
    for candidate in repos.workers.list(user_id=user_id):
        if candidate.get("name") == worker_ref:
            return candidate
    return None


def _tool_mcp_tools_list(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_repositories
    repos = get_repositories()
    return {"ok": True, "tools": repos.mcp_tools.list(user_id=user_id)}


def _tool_mcp_tools_register(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "").strip()
    description = str(args.get("description") or "").strip()
    worker_ref = str(args.get("worker_id") or "").strip()
    input_schema = args.get("input_schema") or {}
    if not name or not description or not worker_ref:
        return {"ok": False, "error": "name, description, and worker_id are required"}
    from db import get_repositories
    repos = get_repositories()
    if repos.mcp_tools.get_by_name(user_id=user_id, name=name):
        return {"ok": False, "error": f"Tool {name!r} already exists"}
    worker = _resolve_mcp_tool_worker(worker_ref, user_id)
    if not worker:
        return {"ok": False, "error": f"Worker {worker_ref!r} not found"}
    if not isinstance(input_schema, dict) or not input_schema:
        input_schema = _mcp_tool_input_schema_from_worker(worker)
    tool = repos.mcp_tools.create(
        user_id=user_id,
        name=name,
        description=description,
        input_schema=input_schema,
        worker_id=str(worker["id"]),
    )
    return {"ok": True, "tool": tool}


def _tool_mcp_tools_update(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "name is required"}
    from db import get_repositories
    repos = get_repositories()
    tool = repos.mcp_tools.get_by_name(user_id=user_id, name=name)
    if not tool:
        return {"ok": False, "error": f"Tool {name!r} not found"}
    updates: Dict[str, Any] = {}
    if args.get("description"):
        updates["description"] = str(args["description"])
    if isinstance(args.get("input_schema"), dict):
        updates["input_schema"] = args["input_schema"]
    if args.get("worker_id"):
        worker_ref = str(args["worker_id"])
        worker = _resolve_mcp_tool_worker(worker_ref, user_id)
        if not worker:
            return {"ok": False, "error": f"Worker {worker_ref!r} not found"}
        updates["worker_id"] = str(worker["id"])
    updated = repos.mcp_tools.update(user_id=user_id, tool_id=str(tool["id"]), **updates)
    return {"ok": True, "tool": updated}


def _tool_mcp_tools_delete(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "name is required"}
    from db import get_repositories
    repos = get_repositories()
    tool = repos.mcp_tools.get_by_name(user_id=user_id, name=name)
    if not tool:
        return {"ok": False, "error": f"Tool {name!r} not found"}
    repos.mcp_tools.delete(user_id=user_id, tool_id=str(tool["id"]))
    return {"ok": True, "message": f"Tool {name!r} deleted"}


def _tool_contexts_list(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from contexts import context_scope_for_user, current_contexts_root, iter_context_files, use_context_scope
    result = []
    with use_context_scope(context_scope_for_user(user_id)):
        root = current_contexts_root()
        if root.is_dir():
            for ctx_dir in sorted(root.iterdir()):
                if ctx_dir.is_dir() and not ctx_dir.name.startswith("."):
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
    from contexts import context_scope_for_user, safe_context_file_path, use_context_scope
    try:
        with use_context_scope(context_scope_for_user(user_id)):
            full_path = safe_context_file_path(name, file_path)
            if not full_path.is_file():
                return {"ok": False, "error": f"File not found: {file_path}"}
            content = full_path.read_text(errors="replace")
        if not full_path.is_file():
            return {"ok": False, "error": f"File not found: {file_path}"}
        return {"ok": True, "content": content}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _tool_contexts_write(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "")
    file_path = str(args.get("file_path") or "")
    content = str(args.get("content") or "")
    if not name or not file_path:
        return {"ok": False, "error": "name and file_path are required"}
    from contexts import context_scope_for_user, safe_context_file_path, use_context_scope
    try:
        from secret_scan import scan_bytes

        findings = scan_bytes(content.encode("utf-8", errors="replace"))
        if findings:
            patterns = ", ".join(sorted({f.pattern for f in findings}))
            return {
                "ok": False,
                "error": (
                    "Refusing to write likely credential material into a brain pack "
                    f"({patterns}). Store credentials in Secrets instead."
                ),
            }
        with use_context_scope(context_scope_for_user(user_id)):
            full_path = safe_context_file_path(name, file_path)
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(content, encoding='utf-8')
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
        from contexts import context_scope_for_user, current_contexts_root, use_context_scope
        context_names = []
        with use_context_scope(context_scope_for_user(user_id)):
            context_root = current_contexts_root()
            if context_root.is_dir():
                context_names = [
                    d.name
                    for d in sorted(context_root.iterdir())
                    if d.is_dir() and not d.name.startswith(".")
                ]

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
    """Build the full system prompt: editable base + workspace custom + SKILL.md."""
    base_persona = get_workspace_base_persona()
    workspace_content = get_workspace_md()
    preamble = _build_workspace_preamble(user_id)
    from worker_registry import WORKERS_DIR
    skill_path = WORKERS_DIR / WORKSPACE_AGENT_ID / "SKILL.md"
    skill_md = skill_path.read_text(encoding='utf-8') if skill_path.is_file() else ""
    skill_md = skill_md.replace("{{WORKSPACE_PREAMBLE}}", preamble)
    custom = (
        "## Workspace custom instructions\n\n"
        f"{workspace_content.strip()}"
        if workspace_content.strip()
        else ""
    )
    return "\n\n".join(part for part in [base_persona, custom, skill_md] if part)


# Per-call environment notes. The engine persona is shared and
# identical everywhere; only this short, env-aware context is injected per call
# so the assistant knows HOW it is being reached and adapts shape accordingly.
# Keep these short, a few lines. Do NOT move personality here.
ENVIRONMENT_NOTES: Dict[str, str] = {
    "slack": (
        "## Current environment: Slack\n"
        "You are currently being reached in Slack (a chat). Keep replies short and "
        "chat-shaped. The person is DMing you or mentioned you in a channel. When "
        "something needs the screen, give a workers.floom.dev link they can tap.\n"
        "Use Slack mrkdwn: *bold* for emphasis, and triple-backtick YAML, JSON, "
        "and code blocks."
    ),
    "whatsapp": (
        "## Current environment: WhatsApp\n"
        "You are reached on WhatsApp, a personal text chat. Keep it short and "
        "conversational. When something needs the screen, give a workers.floom.dev "
        "link they can tap."
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
    """Shared workspace-agent prompt plus a short per-call environment note.

    The editable base persona and workspace.md custom instructions are identical
    for every source. The appended environment note differs by Slack, WhatsApp,
    MCP, or web.
    """
    base = _build_system_prompt(user_id)
    return f"{base}\n\n{_environment_note(source)}"


def workspace_agent_tool_metadata(user_id: str) -> List[Dict[str, str]]:
    """Return [{name, description}] for the workspace agent's tools.

    Includes the workspace-management tools, settings-gated brain tools, and the
    settings-gated Composio app tools the agent actually gets at runtime, so the
    ``/system/workspace-agent`` endpoint and the /assistant UI honestly reflect
    the brain + read-connection capabilities. No secret values, args, or host
    paths — names + one-line descriptions only.
    """
    meta: List[Dict[str, str]] = []
    settings = get_workspace_agent_settings(user_id)

    def _collect(tools: List[Any]) -> None:
        for tool in tools:
            name = str(getattr(tool, "name", "") or "")
            description = str(getattr(tool, "description", "") or "")
            if name:
                meta.append({"name": name, "description": description})

    _collect(_workspace_tools(user_id, settings))

    # Brain + Composio surface (best-effort; never raise the endpoint).
    try:
        config = build_workspace_agent_config(user_id, settings)
        staged = _owner_brain_pack_names(user_id)
        if settings.get("brain_read") or settings.get("brain_write"):
            _collect(_brain_read_tools(
                Path("/nonexistent"),
                staged if settings.get("brain_read") else [],
                user_id=user_id,
                allow_read=settings.get("brain_read", False),
                allow_write=settings.get("brain_write", False),
            ))
        if settings.get("connections_read") or settings.get("connections_use"):
            _collect(
                _composio_read_tools(
                    config,
                    _workspace_agent_policy(settings),
                    user_id,
                    lambda *_a, **_k: None,
                )
            )
    except Exception:
        logger.debug("workspace_agent_tool_metadata: capability surface unavailable", exc_info=True)

    return meta


def workspace_agent_info(user_id: str) -> Dict[str, Any]:
    """Read-only metadata for the workspace agent that powers /chat.

    Returns the resolved system prompt (editable base persona + editable
    workspace.md custom instructions + engine SKILL.md + live workspace snapshot)
    and the agent's available tools (names + descriptions). Contains no secret
    values.
    """
    settings = get_workspace_agent_settings(user_id)
    return {
        "agent_id": WORKSPACE_AGENT_ID,
        "model": os.environ.get("WORKEROS_CHAT_MODEL") or DEFAULT_WORKSPACE_AGENT_MODEL,
        "system_prompt": _build_system_prompt(user_id),
        "tools": workspace_agent_tool_metadata(user_id),
        "settings": settings,
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

    # Resolve or create conversation. Caller-supplied thread ids (Slack, MCP,
    # Langdock, custom clients) are mapped to deterministic owner-scoped internal
    # ids so the same caller id continues the same thread without becoming
    # guessable across users.
    conversation_id = resolve_conversation_id(conversation_id, user_id)
    if conversation_id:
        conv = get_conversation(conversation_id, user_id)
        if not conv:
            conv_title = message[:60] + ("..." if len(message) > 60 else "")
            conversation_id = create_conversation(
                user_id,
                title=conv_title,
                conversation_id=conversation_id,
            )
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
    settings = get_workspace_agent_settings(user_id)
    workspace_tools = _workspace_tools(user_id, settings)

    # ------------------------------------------------------------------
    # Runtime capabilities: brain + settings-gated connections + MCP.
    #
    # The interactive assistant gets the SAME capability builder a worker
    # gets (apps/api/runner_sandbox/agent_capabilities.py), under the current
    # workspace-agent settings:
    #   - brain packs staged read-only into a per-conversation tree when enabled,
    #   - Composio tools read-only by default, mutating only when enabled,
    #   - registered MCP servers dialled with require_approval="always".
    # This makes the /assistant claim ("shares your Brain and Connections")
    # true. SSRF/secret/owner-scope guards carry over from the shared module.
    # ------------------------------------------------------------------
    from runner_sandbox import agent_capabilities

    def _cap_log(message: str, level: str = "info") -> None:
        logger.log(
            {"debug": logging.DEBUG, "info": logging.INFO,
             "warning": logging.WARNING, "error": logging.ERROR}.get(level, logging.INFO),
            "[workspace-agent capabilities] %s", message,
        )

    workspace_config = build_workspace_agent_config(user_id, settings)

    # Stage owner brain packs read-only into a per-conversation context tree.
    from runner_utils import ARTIFACTS_DIR
    cap_context_root = (Path(ARTIFACTS_DIR) / f"chat_{conversation_id}" / "context").resolve()
    cap_context_root.mkdir(parents=True, exist_ok=True)
    staged_packs = []
    if settings.get("brain_read"):
        staged_packs = agent_capabilities.stage_context_packs(
            config=workspace_config,
            context_root=cap_context_root,
            user_id=user_id,
            log_fn=_cap_log,
        )

    # Brain tools (owner-scoped; write persists only when the flag is enabled).
    brain_tools = _brain_read_tools(
        cap_context_root,
        staged_packs,
        user_id=user_id,
        allow_read=settings.get("brain_read", False),
        allow_write=settings.get("brain_write", False),
    )

    connection_policy = _workspace_agent_policy(settings)
    composio_tools = []
    if settings.get("connections_read") or settings.get("connections_use"):
        composio_tools = _composio_read_tools(
            workspace_config, connection_policy, user_id, _cap_log
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
        reply = _ensure_bare_greeting_identity(
            message,
            strip_em_dashes(str(args.get("reply") or "")),
        )
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
        # Dial registered MCP servers (workspace-agent policy → require_approval=always).
        # SSRF + auth-header injection carry over from the shared module. A failed
        # MCP dial degrades gracefully: the assistant still answers with its other
        # tools rather than 500-ing the whole chat.
        try:
            mcp_servers = await agent_capabilities.connect_mcp_servers(
                workspace_config, mcp_secrets, _cap_log, connection_policy
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
                full_text = _ensure_bare_greeting_identity(
                    message,
                    strip_em_dashes("".join(texts)),
                )
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
                if (
                    tool_name_raw == "finish_with_outputs"
                    and isinstance(raw_args, dict)
                    and isinstance(raw_args.get("reply"), str)
                ):
                    raw_args = {
                        **raw_args,
                        "reply": _ensure_bare_greeting_identity(
                            message,
                            strip_em_dashes(raw_args["reply"]),
                        ),
                    }
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
        full_reply = _ensure_bare_greeting_identity(message, full_reply)
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
