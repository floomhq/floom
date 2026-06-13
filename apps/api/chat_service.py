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
import re
import time
import uuid
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from db import get_db, now_iso

logger = logging.getLogger("floom.chat")

WORKSPACE_AGENT_ID = "workspace-agent"
DEFAULT_WORKSPACE_AGENT_MODEL = "gpt-5.4-mini"
TOOL_RESULT_MAX_BYTES = 2048
CONVERSATION_WINDOW = 50       # LLM context window; stored rows are permanent
CONVERSATION_KEEP_VERBATIM = 20  # retained for legacy summary compatibility
CHAT_EVENT_PROTOCOL_VERSION = "emily.chat.v1"
CHAT_EVENT_VERSION = 2
ARGS_PREVIEW_MAX_STRING = 240
ARGS_PREVIEW_MAX_ITEMS = 12
ARGS_PREVIEW_MAX_DEPTH = 4
def _workspace_root() -> Path:
    custom = os.environ.get("WORKEROS_WORKSPACE_DIR", "").strip()
    if custom:
        return Path(custom).resolve()
    return Path(__file__).resolve().parents[3]

WORKSPACE_MD_PATH = _workspace_root() / "workspace.md"
WORKSPACE_BASE_PERSONA_PATH = _workspace_root() / "workspace.base.md"
WORKSPACE_MD_TEMPLATE = Path(__file__).resolve().parents[3] / "workspace.md.template"


def _active_non_default_workspace_id() -> Optional[str]:
    """#866: the active NON-default workspace id, or None for the default /
    single-workspace case.

    workspace.md and workspace.base.md were process-global, so a second local
    workspace shared (and could overwrite or leak into) the first's
    instructions. This resolves the active workspace from either the cloud
    per-request resolver or the OSS scoped auth user id (``base__ws_<hex>``),
    returning a validated ``ws_<14hex>`` id that can never contain path
    traversal. Returns None for ``local-default`` so the default workspace
    keeps using the legacy global path (zero behaviour change).
    """
    wsid: Optional[str] = None
    try:
        import git_ops as _git_ops_mod
        wsid = _git_ops_mod.get_active_workspace_id()
    except Exception:
        wsid = None
    if not wsid:
        try:
            from auth.context import current_auth_context
            ctx = current_auth_context()
            match = re.search(r"__(ws_[a-f0-9]{14})$", (ctx.user_id if ctx else "") or "")
            if match:
                wsid = match.group(1)
        except Exception:
            wsid = None
    if not wsid or wsid == "local-default":
        return None
    return wsid if re.fullmatch(r"ws_[a-f0-9]{14}", str(wsid)) else None


def _workspace_md_path() -> Path:
    sub = _active_non_default_workspace_id()
    return (_workspace_root() / "workspaces" / sub / "workspace.md") if sub else WORKSPACE_MD_PATH


def _workspace_base_persona_path() -> Path:
    sub = _active_non_default_workspace_id()
    return (_workspace_root() / "workspaces" / sub / "workspace.base.md") if sub else WORKSPACE_BASE_PERSONA_PATH

EMILY_BASE_PERSONA = """# Emily

I'm Emily, your chief of staff. I get work done for you and your company.

I run a team of always-on AI workers and I have a memory for what matters to you,
so I handle things end to end and only loop you in when I need a decision. I work
around the clock: recurring jobs on a schedule, and the moment something happens
that needs handling. Think morning briefs, chasing down the replies you're waiting
on, keeping your inbox under control, and turning a one-off request into something
that just runs from then on.

## Character

- Direct and warm. Not a corporate chatbot. Not "how can I help you today?"
- Honest about what I know and what I don't. If I'm unsure, I look it up.
- No em dashes. No emoji unless you use them first.
- Concise. Every sentence earns its place.

## What I do on a bare greeting

When you open a conversation without a specific task, I check the workspace
immediately (pending approvals, failing workers, runs that need attention) and
lead with what matters. I don't wait to be asked. The reply stays short: a
greeting line, at most 2-3 bullets with only the items that need you, and one
ask or suggested next step. I never recite the full workspace snapshot, list
healthy workers, or enumerate settings on a greeting.

## How I work

**Tools before text.** On lookup, debug, "find X", or "what's the state of Y" --
call a tool first, then answer. Don't respond from memory when a tool can give facts.

**Act, then report.** I call tools and synthesize results. I don't narrate the
process unless it reveals something you need to act on. No "Let me check...".

**No clarification by default.** If I can figure it out from context or by calling
a tool, I do. I only ask when the action is irreversible and the cost of a wrong
guess is high.

**State assumptions, then act.** If the request is ambiguous but I can make a
reasonable interpretation, I state it in one sentence and act. I don't ask first.

**Report once.** I give one concise final answer with what I found, what is still
missing, and the exact blocker or next action when there is one.

**Finish the job.** On any task that requires multiple steps, I keep going until
the work is done or I hit a genuine blocker. I don't stop after one tool call and
ask "should I continue?" unless the next step is irreversible.

**Investigate fully, reply once.** On "find X" / lookup / research requests I
exhaust my tools BEFORE replying: brain packs, workers, connection metadata,
host paths -- every angle I have access to. I never send partial status
("checked A and B, nothing yet"), never list dead ends as a reply, and never ask
"say keep going" to continue a read-only investigation -- continuing is free, so
I just continue. The reply is the result: what I found, or one message with what
is definitively missing plus the exact unblock (which connection to add, which
setting to flip, which pack to attach). If a host command is blocked (for
example: no pipes or metacharacters on readonly SSH), I retry with allowed
patterns (separate plain `grep` / `find` / `ls` calls) instead of reporting the
limitation as a finding.

**Outbound needs a thumbs-up.** Any worker that sends emails, posts, or messages
to people outside this workspace will ask for your approval first. That's what
the approval queue is for.

**Never claim what I didn't do.** I never say I ran a worker, started a run, sent
a message, or created something unless the tool call actually returned success with
a real id or result. If a run didn't start, or I'm unsure, I say so and give the
reason. I never invent a run id, a status, or worker output, and I never narrate a
result for a run that did not fire.

"""

WORKER_AUTHORING_RULES = """## Worker authoring rules

When I create or update a worker I follow these rules exactly. They are not
suggestions — they are hard constraints the server enforces.

**Approvals** — if the user says anything like "ask me to approve", "needs my OK",
"HITL", "before it sends / posts / does anything": set `approvals: {required: true}`
in the YAML. Never set `required: false` when the user asked for approval.

**Connections** — if the user mentions any external service (Gmail, Google Calendar,
Slack, Notion, etc.): add every named service to the `connections:` list in the YAML.
An empty `connections: []` means the worker cannot reach any external service at all.

**Exec mode and tool choice** — if the worker reads email, writes calendar events,
posts messages, or calls ANY external service via a connection: it needs agent
mode. **Use `workers__create_from_prompt`, NOT `workers__create`** — the former
routes through the worker-author meta-worker which writes the SKILL.md
implementation file. `workers__create` only creates `worker.yml`; it never
creates SKILL.md, so every agent-mode worker created that way fails immediately
with "Agent entrypoint not found: SKILL.md".

Rule: `workers__create_from_prompt` for agent-mode (connections, email, calendar,
any external API). `workers__create` only for pure-script workers where you are
supplying the full run.py code yourself.

**Trigger types** — valid values: `manual`, `schedule`, `webhook`, `event`. For
"every N minutes" use `type: "schedule"` with `cron: "*/N * * * *"`. Never use
`type: "cron"` or `type: "incoming_email"` — they don't exist in WorkerOS.

**Runner** — always `exec.runner: "e2b"`. The local runner was removed.

After creating a worker I re-read what was actually saved (connections, approvals,
trigger) and confirm it matches what the user asked for before I say it's done.

**Links over walls of text.** When something needs the UI (approve a run, connect
a tool, sign in), I give you the exact link. I don't describe where to go.

**Never fabricate.** If I don't have the data, I say so and call a tool or tell
you what's missing. No invented run IDs, no made-up worker outputs, and no
invented implementation code. For a script worker I author only the `worker.yml`
manifest; the platform generates `run.py` from it. So I never paste a `run.py`
(or a `files:`/code block) that I did not actually pass to the tool myself — that
would show you code that isn't what runs. If you want to see the implementation,
I re-read the worker with `workers__get` and show the actual saved
`run_py_content`, not a guess at what it might contain.
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

_SENSITIVE_ARG_KEY_RE = re.compile(
    r"(?:^|_)(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth|bearer|credential|client[_-]?secret|refresh[_-]?token)(?:$|_)",
    re.IGNORECASE,
)
_CONTENT_ARG_KEYS = {
    "content",
    "file_content",
    "body",
    "text",
    "markdown",
    "yaml_text",
    "worker_yml",
    "run_py",
    "skill_md",
    "code",
    "value",
}
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE)
_TOKEN_LIKE_RE = re.compile(r"\b(?:sk|pat|ghp|glpat|xox[baprs])[-_A-Za-z0-9]{12,}\b")
_SECRET_QUERY_RE = re.compile(
    r"([?&](?:token|key|secret|signature|sig|code)=)([^&\s]+)",
    re.IGNORECASE,
)
_SECRET_QUERY_PREFIX_RE = re.compile(
    r"([?&](?:token|key|secret|signature|sig|code)=)$",
    re.IGNORECASE,
)
_SECRET_QUERY_VALUE_DELIMITERS = frozenset('& \t\r\n"\'<>)]}')


def _effective_worker_visibility_user_id(user_id: str) -> str:
    """Resolve the owner id Emily should use for worker visibility checks."""
    raw = str(user_id or "").strip()
    if not raw:
        return raw
    candidates: list[str] = [raw]
    try:
        from db import get_db

        with get_db() as conn:
            row = conn.execute(
                "SELECT id FROM users WHERE username = ? LIMIT 1",
                (raw,),
            ).fetchone()
        if row and row["id"]:
            candidates.append(str(row["id"]))
    except Exception:
        pass
    try:
        from contexts import effective_context_user_id
        effective = effective_context_user_id(raw)
    except Exception:
        effective = None
    if effective:
        candidates.append(str(effective))
    seen: set[str] = set()
    unique_candidates: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.add(candidate)
            unique_candidates.append(candidate)
    try:
        from db import get_db

        with get_db() as conn:
            for candidate in unique_candidates:
                row = conn.execute(
                    "SELECT 1 FROM workers WHERE owner_id = ? LIMIT 1",
                    (candidate,),
                ).fetchone()
                if row is not None:
                    return candidate
    except Exception:
        pass
    return unique_candidates[-1] if unique_candidates else raw


_current_chat_conversation_id: ContextVar[Optional[str]] = ContextVar(
    "workeros_chat_conversation_id",
    default=None,
)


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
    if text.startswith("- "):
        return f"I'm Emily. Workspace state:\n\n{text}"
    return f"I'm Emily. {text}" if text else "I'm Emily."


# ---------------------------------------------------------------------------
# workspace prompt helpers
# ---------------------------------------------------------------------------

def get_workspace_base_persona() -> str:
    """Return the editable base persona override, or the engine default."""
    path = _workspace_base_persona_path()  # #866: per active workspace
    if path.is_file():
        return path.read_text(encoding='utf-8')
    return EMILY_BASE_PERSONA


def set_workspace_base_persona(content: str) -> None:
    """Overwrite the optional base persona override."""
    path = _workspace_base_persona_path()  # #866
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')


def base_persona_is_custom() -> bool:
    """True when a saved override exists (vs the built-in engine default)."""
    return _workspace_base_persona_path().is_file()  # #866


def clear_workspace_base_persona() -> None:
    """Remove the override so the built-in engine default applies again."""
    try:
        _workspace_base_persona_path().unlink(missing_ok=True)  # #866
    except OSError:
        pass


def get_workspace_md() -> str:
    """Return editable workspace custom instructions, or a custom-only default."""
    path = _workspace_md_path()  # #866: per active workspace
    if path.is_file():
        return path.read_text(encoding='utf-8')
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
    path = _workspace_md_path()  # #866
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')


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


def list_conversation_tool_cards(conv_id: str, user_id: str) -> List[Dict[str, Any]]:
    """Return persisted renderable tool cards for conversation replay."""
    with get_db() as conn:
        owned = conn.execute(
            "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
            (conv_id, user_id),
        ).fetchone()
        if not owned:
            return []
        rows = conn.execute(
            """
            SELECT id, call_id, tool_name, status, card_json, resource_json,
                   streams_json, actions_json, args_preview_json,
                   result_preview_json, run_id, worker_id, created_at, updated_at
            FROM conversation_tool_calls
            WHERE conversation_id = ? AND user_id = ?
            ORDER BY created_at ASC
            """,
            (conv_id, user_id),
        ).fetchall()

    def _loads(raw: Any, fallback: Any) -> Any:
        try:
            return json.loads(raw) if raw else fallback
        except Exception:
            return fallback

    cards: List[Dict[str, Any]] = []
    for row in rows:
        card = _loads(row["card_json"], {})
        cards.append({
            "id": row["id"],
            "callId": row["call_id"],
            "toolName": row["tool_name"],
            "status": row["status"],
            "card": card,
            "resource": _loads(row["resource_json"], None),
            "streams": _loads(row["streams_json"], None),
            "actions": _loads(row["actions_json"], []),
            "args_preview": _loads(row["args_preview_json"], {}),
            "result_preview": _loads(row["result_preview_json"], None),
            "run_id": row["run_id"],
            "worker_id": row["worker_id"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        })
    return cards


def _safe_json_dumps(value: Any) -> str:
    return json.dumps(value, default=str, sort_keys=True)


def _redacted_marker(reason: str, value: Any = None) -> Dict[str, Any]:
    marker: Dict[str, Any] = {"redacted": True, "reason": reason}
    try:
        marker["bytes"] = len(str(value).encode("utf-8")) if value is not None else 0
    except Exception:
        pass
    return marker


def _looks_sensitive_string(value: str) -> bool:
    return bool(_BEARER_RE.search(value) or _TOKEN_LIKE_RE.search(value))


def _sanitize_preview_text(value: str) -> str:
    return _SECRET_QUERY_RE.sub(r"\1[redacted]", value)


class _StreamingTextSanitizer:
    """Redact sensitive query values without trusting SSE delta boundaries."""

    _TAIL_LENGTH = 24

    def __init__(self) -> None:
        self._pending = ""
        self._sensitive_prefix = ""
        self._redacting_value = False

    def feed(self, value: str) -> str:
        output: List[str] = []

        for char in str(value or ""):
            if self._redacting_value:
                if char not in _SECRET_QUERY_VALUE_DELIMITERS:
                    continue
                self._redacting_value = False

            if self._sensitive_prefix:
                if char in _SECRET_QUERY_VALUE_DELIMITERS:
                    output.append(self._sensitive_prefix)
                    self._sensitive_prefix = ""
                else:
                    output.append(f"{self._sensitive_prefix}[redacted]")
                    self._sensitive_prefix = ""
                    self._redacting_value = True
                    continue

            self._pending += char
            prefix_match = _SECRET_QUERY_PREFIX_RE.search(self._pending)
            if prefix_match:
                prefix_start = prefix_match.start(1)
                output.append(_sanitize_preview_text(self._pending[:prefix_start]))
                self._sensitive_prefix = prefix_match.group(1)
                self._pending = ""
                continue

            if len(self._pending) > self._TAIL_LENGTH:
                flush_length = len(self._pending) - self._TAIL_LENGTH
                output.append(_sanitize_preview_text(self._pending[:flush_length]))
                self._pending = self._pending[flush_length:]

        return "".join(output)

    def flush(self) -> str:
        output = ""
        if self._sensitive_prefix:
            output = self._sensitive_prefix
        if not self._redacting_value:
            output += _sanitize_preview_text(self._pending)
        self._pending = ""
        self._sensitive_prefix = ""
        self._redacting_value = False
        return output


def _arg_key_tokens(key: str) -> str:
    snake = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key or ""))
    snake = re.sub(r"[^A-Za-z0-9]+", "_", snake)
    return snake.strip("_").lower()


def _is_sensitive_arg_key(key: str) -> bool:
    tokens = _arg_key_tokens(key)
    if _SENSITIVE_ARG_KEY_RE.search(tokens):
        return True
    compact = tokens.replace("_", "")
    return any(
        marker in compact
        for marker in (
            "accesstoken",
            "refreshtoken",
            "bearertoken",
            "sessiontoken",
            "apikey",
            "clientsecret",
            "privatekey",
            "authorization",
            "credential",
            "password",
        )
    )


def _looks_like_large_markup(key: str, value: str) -> bool:
    lower_key = key.lower()
    if lower_key in {"yaml_text", "worker_yml"}:
        return True
    if len(value.encode("utf-8")) > ARGS_PREVIEW_MAX_STRING:
        return True
    stripped = value.lstrip()
    return stripped.startswith(("schema_version:", "name:", "---", "```"))


def _preview_scalar(value: Any, *, key: str = "") -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = str(value)
    if key.lower() in {"content", "file_content", "run_py", "skill_md", "code"}:
        return _redacted_marker("file content", text)
    if _looks_sensitive_string(text):
        return _redacted_marker("secret-like value", text)
    text = _sanitize_preview_text(text)
    if _looks_like_large_markup(key, text):
        return {
            "redacted": True,
            "reason": "large or structured content",
            "bytes": len(text.encode("utf-8", errors="replace")),
            "chars": len(text),
        }
    if len(text) > ARGS_PREVIEW_MAX_STRING:
        return {
            "preview": text[:ARGS_PREVIEW_MAX_STRING] + "...",
            "truncated": True,
            "chars": len(text),
        }
    return text


def build_args_preview(tool_name: str, args: Any) -> Any:
    """Return a renderable, secret-free summary of tool arguments."""
    def _walk(value: Any, key: str = "", depth: int = 0) -> Any:
        key_lower = _arg_key_tokens(key)
        if key_lower == "value" and tool_name == "secrets__set":
            return _redacted_marker("secret value", value)
        if _is_sensitive_arg_key(key):
            return _redacted_marker("sensitive field", value)
        if key_lower in _CONTENT_ARG_KEYS and isinstance(value, str):
            return _preview_scalar(value, key=key_lower)
        if depth >= ARGS_PREVIEW_MAX_DEPTH:
            return _redacted_marker("max depth", value)
        if isinstance(value, dict):
            preview: Dict[str, Any] = {}
            for idx, item_key in enumerate(sorted(value.keys(), key=str)):
                if idx >= ARGS_PREVIEW_MAX_ITEMS:
                    preview["_truncated"] = True
                    preview["_remaining_keys"] = len(value) - idx
                    break
                preview[str(item_key)] = _walk(value[item_key], str(item_key), depth + 1)
            return preview
        if isinstance(value, list):
            items = [_walk(item, key, depth + 1) for item in value[:ARGS_PREVIEW_MAX_ITEMS]]
            if len(value) > ARGS_PREVIEW_MAX_ITEMS:
                items.append({"truncated": True, "remaining_items": len(value) - ARGS_PREVIEW_MAX_ITEMS})
            return items
        return _preview_scalar(value, key=key)

    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            return _preview_scalar(args, key="arguments")
    return _walk(args)


def _preview_result(result: Any) -> Any:
    if isinstance(result, dict):
        return build_args_preview("tool-result", result)
    return _preview_scalar(result, key="result")


def _card_kind_for_tool(tool_name: str) -> str:
    if tool_name == "workers__list_all":
        return "worker-list"
    if tool_name == "workers__run":
        return "run"
    if tool_name.startswith("workers__"):
        return "worker"
    if tool_name.startswith("runs__"):
        return "run"
    if tool_name.startswith("secrets__"):
        return "secret"
    if tool_name.startswith("connections__"):
        return "connection"
    if tool_name.startswith("contexts__") or tool_name.startswith("brain__"):
        return "brain"
    if tool_name.startswith("approvals__"):
        return "approval"
    if tool_name.startswith("slack__"):
        return "slack"
    return "tool"


def _tool_title(tool_name: str, args_preview: Any) -> str:
    if tool_name == "workers__list_all":
        return "List workers"
    if tool_name == "workers__run":
        return "Run worker"
    if tool_name == "workers__create_from_prompt":
        return "Create worker from prompt"
    if tool_name == "workers__create":
        return "Create worker from YAML"
    if tool_name == "secrets__set":
        name = args_preview.get("name") if isinstance(args_preview, dict) else None
        return f"Set secret {name}" if name else "Set secret"
    return tool_name.replace("__", ".").replace("_", " ")


def _tool_resource(tool_name: str, payload: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(payload, dict):
        return None
    nested_run = payload.get("run") if isinstance(payload.get("run"), dict) else {}
    worker_id = (
        payload.get("worker_id")
        or nested_run.get("worker_id")
        or payload.get("id")
    )
    run_id = payload.get("run_id") or nested_run.get("run_id") or nested_run.get("id")
    if tool_name == "workers__create_from_prompt":
        worker_id = payload.get("worker_id") or "worker-author"
    if run_id:
        return {"kind": "run", "worker_id": worker_id, "run_id": run_id}
    if worker_id and tool_name.startswith("workers__"):
        return {"kind": "worker", "worker_id": worker_id}
    return None


def _tool_streams(resource: Optional[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    if not resource or not resource.get("run_id"):
        return None
    run_id = str(resource["run_id"])
    return {"events": f"/runs/{run_id}/events", "parts": f"/runs/{run_id}/stream"}


def _tool_actions(tool_name: str, resource: Optional[Dict[str, Any]], status: str) -> List[Dict[str, Any]]:
    actions: List[Dict[str, Any]] = []
    if resource and resource.get("run_id"):
        run_id = str(resource["run_id"])
        actions.append(
            {
                "id": "open_run",
                "label": "View run",
                "method": "GET",
                "href": f"/runs/{run_id}?tab=logs",
            }
        )
        if status in {"starting", "running", "queued"}:
            actions.append({"id": "cancel_run", "method": "POST", "href": f"/runs/{run_id}/cancel"})
    if resource and resource.get("worker_id") and status == "completed":
        worker_id = str(resource["worker_id"])
        if worker_id != "worker-author":
            actions.append({"id": "open_worker", "method": "GET", "href": f"/workers/{worker_id}"})
            actions.append({"id": "edit_worker", "method": "GET", "href": f"/workers/{worker_id}?edit=1"})
    if resource and resource.get("approval_id"):
        run_id = str(resource.get("run_id") or "")
        if run_id:
            actions.append({"id": "approve", "method": "POST", "href": f"/runs/{run_id}/approve"})
            actions.append({"id": "reject", "method": "POST", "href": f"/runs/{run_id}/reject"})
    if resource and resource.get("kind") == "connection":
        app_name = str(resource.get("app_name") or "")
        body: Dict[str, str] = {"app_name": app_name} if app_name else {}
        actions.append({"id": "connect", "method": "POST", "href": "/connections", "body": body})
    if tool_name == "secrets__set":
        actions.append({"id": "open_secrets", "method": "GET", "href": "/settings/secrets"})
    return actions


def _action_required_reason(tool_name: str, result: Any, resource: Optional[Dict[str, Any]]) -> Optional[str]:
    if isinstance(resource, dict) and resource.get("approval_id") and tool_name != "approvals__list_pending":
        return "approval_required"
    if isinstance(result, dict):
        code = str(result.get("error_code") or result.get("error") or "")
        lowered = code.lower()
        if "missing_connection" in lowered or ("connection" in lowered and not result.get("ok", True)):
            return "missing_connection"
        if "missing_secret" in lowered or ("secret" in lowered and not result.get("ok", True)):
            return "missing_secret"
    return None


def build_tool_event_metadata(
    tool_name: str,
    call_id: str,
    *,
    args: Any = None,
    result: Any = None,
    phase: str,
) -> Dict[str, Any]:
    args_preview = build_args_preview(tool_name, args)
    status = "starting" if phase == "call" else "completed"
    if phase == "result" and isinstance(result, dict) and not result.get("ok", True):
        status = "failed"
    if phase == "result" and isinstance(result, dict) and result.get("ok", True) and result.get("run_id"):
        status = "running"
    payload_for_resource = result if phase == "result" else args
    resource = _tool_resource(tool_name, payload_for_resource)
    if not resource and isinstance(result, dict):
        resource = _tool_resource(tool_name, result)
    if (
        resource
        and resource.get("kind") == "run"
        and not resource.get("worker_id")
        and isinstance(args, dict)
        and args.get("id")
    ):
        resource["worker_id"] = str(args["id"])
    approval_actions: List[Dict[str, Any]] = []
    if tool_name == "approvals__list_pending" and isinstance(result, dict):
        approvals = result.get("approvals") if isinstance(result.get("approvals"), list) else []
        if approvals:
            first = approvals[0]
            if isinstance(first, dict):
                base = _APPROVALS_BASE_URL.rstrip("/")
                for approval in approvals:
                    if not isinstance(approval, dict):
                        continue
                    approval_id = str(approval.get("id") or "").strip()
                    run_id = str(approval.get("run_id") or "").strip()
                    owner_id = str(approval.get("owner_id") or "").strip()
                    if not approval_id or not run_id or not owner_id:
                        continue
                    token = _approval_public_token({"id": approval_id, "run_id": run_id, "owner_id": owner_id})
                    approval_actions.append(
                        {
                            "id": f"open_review_{approval_id}",
                            "label": "Open review",
                            "method": "GET",
                            "href": f"{base}/approvals/review?id={approval_id}&token={token}",
                        }
                    )
                resource = {
                    "kind": "approval",
                    "approval_id": first.get("id"),
                    "run_id": first.get("run_id"),
                    "worker_id": first.get("worker_id"),
                    "count": result.get("count") or len(approvals),
                }
                status = "pending_approval"
    reason = _action_required_reason(tool_name, result, resource)
    if reason:
        status = "action_required"
        if not resource and reason == "missing_connection":
            app_name = ""
            if isinstance(result, dict):
                app_name = str(result.get("app_name") or result.get("connection") or "")
            if isinstance(args, dict) and not app_name:
                app_name = str(args.get("app_name") or args.get("connection") or "")
            resource = {"kind": "connection", "app_name": app_name or None, "status": "missing"}
        if not resource and reason == "missing_secret":
            secret_name = ""
            if isinstance(result, dict):
                secret_name = str(result.get("secret_name") or result.get("name") or "")
            if isinstance(args, dict) and not secret_name:
                secret_name = str(args.get("name") or "")
            resource = {"kind": "secret", "name": secret_name or None, "status": "missing"}
    card_id = f"card_{call_id}" if not str(call_id).startswith("card_") else str(call_id)
    title = _tool_title(tool_name, args_preview)
    if tool_name == "approvals__list_pending" and approval_actions and status == "pending_approval":
        title = "Pending approvals"
    card = {
        "id": card_id,
        "kind": _card_kind_for_tool(tool_name),
        "title": title,
        "status": status,
    }
    streams = _tool_streams(resource)
    actions = approval_actions or _tool_actions(tool_name, resource, status)
    return {
        "protocol": CHAT_EVENT_PROTOCOL_VERSION,
        "version": CHAT_EVENT_VERSION,
        "card": card,
        "resource": resource,
        "streams": streams,
        "actions": actions,
        "args_preview": args_preview,
        "result_preview": _preview_result(result) if phase == "result" else None,
        "reason": reason,
    }


def normalize_tool_args_for_event(tool_name: str, args: Any) -> Any:
    if (
        tool_name == "finish_with_outputs"
        and isinstance(args, dict)
        and isinstance(args.get("reply"), str)
    ):
        return {**args, "reply": _sanitize_preview_text(strip_em_dashes(args["reply"]))}
    return args


def _persist_tool_card(
    conversation_id: str,
    user_id: str,
    call_id: str,
    tool_name: str,
    metadata: Dict[str, Any],
) -> None:
    card = metadata.get("card") or {}
    resource = metadata.get("resource") or {}
    ts = now_iso()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO conversation_tool_calls
                (id, user_id, conversation_id, call_id, tool_name, status,
                 card_json, resource_json, streams_json, actions_json,
                 args_preview_json, result_preview_json, run_id, worker_id,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id, call_id) DO UPDATE SET
                tool_name = excluded.tool_name,
                status = excluded.status,
                card_json = excluded.card_json,
                resource_json = excluded.resource_json,
                streams_json = excluded.streams_json,
                actions_json = excluded.actions_json,
                args_preview_json = COALESCE(excluded.args_preview_json, conversation_tool_calls.args_preview_json),
                result_preview_json = excluded.result_preview_json,
                run_id = COALESCE(excluded.run_id, conversation_tool_calls.run_id),
                worker_id = COALESCE(excluded.worker_id, conversation_tool_calls.worker_id),
                updated_at = excluded.updated_at
            """,
            (
                f"tool_{uuid.uuid4().hex[:16]}",
                user_id,
                conversation_id,
                call_id,
                tool_name,
                str(card.get("status") or "running"),
                _safe_json_dumps(card),
                _safe_json_dumps(metadata.get("resource")) if metadata.get("resource") is not None else None,
                _safe_json_dumps(metadata.get("streams")) if metadata.get("streams") is not None else None,
                _safe_json_dumps(metadata.get("actions") or []),
                _safe_json_dumps(metadata.get("args_preview")) if metadata.get("args_preview") is not None else None,
                _safe_json_dumps(metadata.get("result_preview")) if metadata.get("result_preview") is not None else None,
                resource.get("run_id") if isinstance(resource, dict) else None,
                resource.get("worker_id") if isinstance(resource, dict) else None,
                ts,
                ts,
            ),
        )


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
            "List the user's workers (name, id, trigger, last run status). "
            "System and example workers are hidden unless include_system is true.",
            {
                "type": "object",
                "properties": {
                    "include_system": {
                        "type": "boolean",
                        "description": "Also include system/example workers (hidden by default).",
                    },
                    "include_all_users": {
                        "type": "boolean",
                        "description": "Admin only: include workers owned by every user.",
                    }
                },
                "required": [],
            },
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
            (
                "Create a new worker from a YAML bundle string.\n\n"
                "FIELD RULES — these are non-negotiable and will be validated server-side:\n"
                "- exec.runner: always \"e2b\" (the local runner was removed)\n"
                "- trigger.type: \"manual\" | \"schedule\" | \"webhook\" | \"event\"\n"
                "  Do NOT use \"cron\" or \"incoming_email\" — they are not valid.\n"
                "  For a scheduled worker: type: \"schedule\", cron: \"*/10 * * * *\"\n"
                "- exec.mode: \"agent\" (uses SKILL.md) or \"pure-script\" (uses run.py)\n"
                "  Use \"agent\" whenever the worker calls external services via connections.\n"
                "- approvals.required: true when the user asks for approval before any action\n"
                "- connections: list ALL app slugs the worker needs (e.g. [\"gmail\", \"googlecalendar\"])\n"
                "  Declare every service mentioned. Empty list means the worker cannot call any external app.\n"
                "INTENT MAPPING:\n"
                "- 'ask me to approve' / 'needs approval' / 'HITL' → approvals: {required: true}\n"
                "- 'use gmail / google calendar / slack / etc.' → add to connections list\n"
                "- worker reads email / writes calendar / posts message → exec.mode: \"agent\""
            ),
            {
                "type": "object",
                "properties": {"yaml_text": {"type": "string", "description": "Full worker.yml content"}},
                "required": ["yaml_text"],
            },
            _tool_workers_create,
        ),
        _make_tool(
            "workers__create_from_prompt",
            (
                "Start an async worker-author run from a natural-language prompt. "
                "Returns immediately with run_id; use the run events stream for progress."
            ),
            {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"},
                    "mode": {"type": "string", "enum": ["draft", "create"], "default": "create"},
                    "idempotency_key": {"type": "string"},
                },
                "required": ["prompt", "idempotency_key"],
            },
            _tool_workers_create_from_prompt,
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
            (
                "Trigger a worker run. Returns the run_id. The 'id' accepts an "
                "exact worker id or an exact worker name. If the reference is "
                "ambiguous or doesn't clearly match a worker, this returns "
                "{ok:false, ambiguous:true, candidates:[...]} INSTEAD of running "
                "anything — when that happens, ask the user which worker (by id) "
                "they mean and do NOT call this tool again until they confirm. "
                "Never guess a worker id."
            ),
            {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Exact worker id or exact worker name."},
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
            "approvals__approve",
            (
                "Approve a pending approval the user owns, by approval_id OR run_id. "
                "Use this whenever the user says to approve a run in any phrasing "
                "('yes, approve it', 'approve run X', 'go ahead'). Only approvals the "
                "user owns can be approved. On success returns "
                "{ok:true, status:'approved', run_id}. If run_id has multiple pending "
                "approvals it returns {ambiguous:true, candidates:[...]} — then ask "
                "which approval_id."
            ),
            {
                "type": "object",
                "properties": {
                    "approval_id": {"type": "string", "description": "The approval id to approve."},
                    "run_id": {"type": "string", "description": "The run id whose pending approval to approve (used if approval_id is omitted)."},
                },
                "required": [],
            },
            _tool_approvals_approve,
        ),
        _make_tool(
            "approvals__reject",
            (
                "Reject a pending approval the user owns, by approval_id OR run_id. "
                "Use this whenever the user says to reject/decline/cancel a run in any "
                "phrasing ('no', 'reject it', 'don't run it'). Only approvals the user "
                "owns can be rejected. On success returns "
                "{ok:true, status:'rejected', run_id}."
            ),
            {
                "type": "object",
                "properties": {
                    "approval_id": {"type": "string", "description": "The approval id to reject."},
                    "run_id": {"type": "string", "description": "The run id whose pending approval to reject (used if approval_id is omitted)."},
                },
                "required": [],
            },
            _tool_approvals_reject,
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
    visibility_user_id = _effective_worker_visibility_user_id(user_id)
    include_all_users = bool(args.get("include_all_users"))
    result = []
    with _get_db() as conn:
        # Default to "the user's workers" for Emily's "what workers do I have?"
        # path. Admin-wide listing is explicit so the default never exposes
        # another user's private workers in a personal inventory answer.
        try:
            role_row = conn.execute("SELECT role FROM users WHERE id = ?", (visibility_user_id,)).fetchone()
            is_admin = bool(role_row) and str(role_row["role"]).lower() == "admin"
        except Exception:
            # No users table (single-user OSS without multi-member) -> not admin;
            # the member path below (own + workspace-shared) is the safe default.
            is_admin = False
        base_select = (
            "SELECT w.id, w.name, w.trigger_type, w.enabled, w.owner_id, sv.manifest_json "
            "FROM workers w "
            "LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id "
        )
        if is_admin and include_all_users:
            rows = conn.execute(base_select + "ORDER BY w.name").fetchall()
        else:
            # Mirror _worker_can_view exactly: a member sees their own workers,
            # stock/public workers (always accessible regardless of ownership),
            # plus workspace-visible workers they are an active member of.
            # The workspace_members table may be absent in single-user OSS
            # (no multi-member); check for its existence before using it.
            from main import PUBLIC_STOCK_WORKER_IDS, PROTECTED_STOCK_WORKER_IDS
            all_stock_ids = list(PUBLIC_STOCK_WORKER_IDS | PROTECTED_STOCK_WORKER_IDS)
            try:
                has_members_table = bool(conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_members' LIMIT 1"
                ).fetchone())
            except Exception:
                has_members_table = False

            if has_members_table:
                # Show own workers and workspace-visible workers where the user
                # is an active workspace member — matching _worker_can_view.
                rows = conn.execute(
                    base_select
                    + "LEFT JOIN workspace_members wm "
                    + "  ON wm.workspace_id = COALESCE(w.workspace_id, 'local-default') "
                    + "  AND wm.user_id = ? AND wm.status = 'active' "
                    + "WHERE w.owner_id = ? "
                    + "OR (COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                    + "    AND wm.user_id IS NOT NULL) "
                    + "ORDER BY w.name",
                    (visibility_user_id, visibility_user_id),
                ).fetchall()
                # Also include stock/public workers not already captured above
                # (e.g. stock worker owned by another user in a workspace the
                # member doesn't belong to — stock workers are always runnable
                # by everyone, matching _worker_can_view's stock-first check).
                if all_stock_ids:
                    seen_ids = {r["id"] for r in rows}
                    missing_stock = [sid for sid in all_stock_ids if sid not in seen_ids]
                    if missing_stock:
                        placeholders = ",".join("?" * len(missing_stock))
                        stock_rows = conn.execute(
                            base_select
                            + f"WHERE w.id IN ({placeholders}) ORDER BY w.name",
                            missing_stock,
                        ).fetchall()
                        rows = list(rows) + stock_rows
            else:
                # Single-user OSS: no workspace_members table.
                # In single-user mode everyone is effectively in every workspace,
                # so workspace-visible workers are accessible to all users —
                # matching _worker_can_view's _shared_filesystem_fallback_allowed
                # path. Show own + workspace-visible + stock workers.
                if all_stock_ids:
                    placeholders = ",".join("?" * len(all_stock_ids))
                    rows = conn.execute(
                        base_select
                        + f"WHERE w.owner_id = ? "
                        + "OR COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                        + f"OR w.id IN ({placeholders}) "
                        + "ORDER BY w.name",
                        [visibility_user_id] + all_stock_ids,
                    ).fetchall()
                else:
                    rows = conn.execute(
                        base_select
                        + "WHERE w.owner_id = ? "
                        + "OR COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                        + "ORDER BY w.name",
                        (visibility_user_id,),
                    ).fetchall()
    # #841 RCA: every row was returned, so "what workers do I have?" dumped
    # system and example workers into the chat card with no distinction. The
    # flags were already computed but never used to filter. Hidden rows are
    # surfaced as a count (plus include_system=true to opt back in) so Emily
    # can mention they exist without listing them.
    include_system = bool(args.get("include_system"))
    hidden_system = 0
    for row in rows:
        try:
            manifest = json.loads(row["manifest_json"] or "{}") if row["manifest_json"] else {}
        except Exception:
            manifest = {}
        entry = {
            "id": row["id"],
            "name": row["name"],
            "title": manifest.get("title") or row["name"],
            "trigger": row["trigger_type"] or "manual",
            "enabled": bool(row["enabled"]),
            "system_worker": manifest.get("system_worker", False),
            "is_example": manifest.get("is_example", False),
        }
        if (entry["system_worker"] or entry["is_example"]) and not include_system:
            hidden_system += 1
            continue
        result.append(entry)
    out = {"ok": True, "workers": result, "count": len(result)}
    if hidden_system:
        out["hidden_system_count"] = hidden_system
    return out


def _worker_can_view(conn: Any, worker_id: str, user_id: str) -> bool:
    """Return True if *user_id* may read *worker_id*.

    Mirrors SqliteAssetAccessRepository._compute:
      can_view = is_owner OR (visibility in {workspace, shared} AND user is
      an active workspace member).

    "shared" is accepted as an alias for "workspace" in case a cloud-side
    migration ever writes that value; the canonical OS value is "workspace".

    File-based stock/example workers (PUBLIC_STOCK_WORKER_IDS,
    PROTECTED_STOCK_WORKER_IDS) do NOT have a DB row; they are shared
    read-execute resources accessible to every user.  When no row exists the
    guard therefore falls back to the same logic used by _get_visible_worker in
    main.py: stock workers are always accessible; in single-user / dev mode
    (filesystem-fallback allowed) unowned on-disk workers are accessible; only
    truly unknown IDs are blocked.  This preserves the pre-#750 behaviour for
    owner/stock access while keeping the cross-user private-worker guard intact.

    If the DB schema is not yet initialised (e.g. unit tests that stub the DB
    at a higher level and don't run migrations), the OperationalError is caught
    and the function returns True — the downstream run path will surface any
    real "not found" error using its own resolution logic.
    """
    import sqlite3 as _sqlite3
    # Stock/public workers are always accessible regardless of DB state.
    # Check this first so a DB row with a different owner_id or restrictive
    # visibility on a stock worker never blocks a valid user.
    from main import (
        PUBLIC_STOCK_WORKER_IDS,
        PROTECTED_STOCK_WORKER_IDS,
        _shared_filesystem_fallback_allowed,
    )
    visibility_user_id = _effective_worker_visibility_user_id(user_id)
    if worker_id in PUBLIC_STOCK_WORKER_IDS or worker_id in PROTECTED_STOCK_WORKER_IDS:
        return True
    try:
        row = conn.execute(
            "SELECT owner_id, workspace_id, visibility FROM workers WHERE id = ? LIMIT 1",
            (worker_id,),
        ).fetchone()
    except _sqlite3.OperationalError:
        # DB not initialised or workers table absent — let the run path decide.
        return True
    if row is None:
        # No DB row — worker is either an unregistered filesystem worker or unknown.
        if _shared_filesystem_fallback_allowed():
            # Single-user / dev mode: unowned on-disk workers are always
            # accessible.  The run path itself will return "not found" if the
            # file doesn't actually exist.
            return True
        # Unknown worker ID in a multi-user deployment — block it.
        return False
    if row["owner_id"] == visibility_user_id:
        return True
    # Admins may view every worker, mirroring the role-aware /workers UI and
    # workers__list_all. Without this, an admin who owns no workers could LIST a
    # worker but get "not found" on read/run. Defensive: no users table (single-
    # user OSS) -> not admin.
    try:
        role_row = conn.execute(
            "SELECT role FROM users WHERE id = ? LIMIT 1", (visibility_user_id,)
        ).fetchone()
        if role_row and str(role_row["role"]).lower() == "admin":
            return True
    except Exception:
        pass
    visibility = (row["visibility"] or "private").lower()
    if visibility not in ("workspace", "shared"):
        return False
    # Check active membership in the worker's workspace. Defensive: the
    # workspace_members table is absent in single-user OSS.
    workspace_id = row["workspace_id"] or "local-default"
    try:
        member_row = conn.execute(
            "SELECT 1 FROM workspace_members "
            "WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
            (workspace_id, visibility_user_id),
        ).fetchone()
    except Exception:
        return False
    return member_row is not None


# Filler tokens stripped before comparing worker references (#892). These are
# words a human adds around a worker name ("run THE node smoke test WORKER")
# that carry no identity, so they must not block an otherwise-exact match nor
# create false token-overlap candidates.
_WORKER_FILLER_TOKENS = {"worker", "workers", "the", "a", "an", "run", "my", "agent", "please"}


def _normalize_worker_token(value: str) -> str:
    """Collapse an arbitrary worker reference to a comparison token.

    Lowercase, replace every run of non-alphanumeric chars (spaces, hyphens,
    underscores, punctuation) with a single hyphen, strip leading/trailing
    hyphens. So "Node Smoke Test", "node_smoke_test", "node-smoke-test" all
    normalize to the same token "node-smoke-test". This is the canonical
    comparison key used by the run resolver (#892) — it does NOT do fuzzy /
    prefix matching, only exact-after-normalization equality.
    """
    return re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")


def _worker_match_key(value: str) -> str:
    """Normalized token of *value* with filler words removed (#892).

    "the node smoke test worker" and "node smoke test" both yield
    "node-smoke-test", so a human's natural phrasing matches the worker id
    without the trailing "worker"/leading "the" blocking the equality.
    """
    tokens = [t for t in _normalize_worker_token(value).split("-") if t and t not in _WORKER_FILLER_TOKENS]
    return "-".join(tokens)


def _list_viewable_workers(conn: Any, user_id: str) -> List[Dict[str, str]]:
    """Return [{id, name}] for every worker *user_id* may run.

    Mirrors _worker_can_view's visibility model (own + workspace-shared +
    stock/public, with admins seeing all) but, unlike _tool_workers_list_all,
    does NOT hide system/example workers — a by-id run of a stock worker must
    still resolve. Used only by the run resolver to build candidate sets, so it
    is intentionally permissive about WHICH workers exist; the run path itself
    re-checks _worker_can_view before firing.
    """
    from main import PUBLIC_STOCK_WORKER_IDS, PROTECTED_STOCK_WORKER_IDS

    visibility_user_id = _effective_worker_visibility_user_id(user_id)
    try:
        role_row = conn.execute("SELECT role FROM users WHERE id = ?", (visibility_user_id,)).fetchone()
        is_admin = bool(role_row) and str(role_row["role"]).lower() == "admin"
    except Exception:
        is_admin = False

    base_select = "SELECT w.id, w.name FROM workers w "
    rows: List[Any] = []
    try:
        if is_admin:
            rows = conn.execute(base_select + "ORDER BY w.name").fetchall()
        else:
            rows = conn.execute(
                base_select
                + "WHERE w.owner_id = ? "
                + "OR COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                + "ORDER BY w.name",
                (visibility_user_id,),
            ).fetchall()
    except Exception:
        rows = []

    seen: set[str] = set()
    out: List[Dict[str, str]] = []
    for r in rows:
        wid = str(r["id"])
        if wid in seen:
            continue
        seen.add(wid)
        out.append({"id": wid, "name": str(r["name"] or wid)})

    # Stock/public workers are runnable by everyone even without a DB row.
    for sid in sorted(PUBLIC_STOCK_WORKER_IDS | PROTECTED_STOCK_WORKER_IDS):
        if sid not in seen:
            seen.add(sid)
            out.append({"id": sid, "name": sid})
    return out


def _resolve_runnable_worker(conn: Any, raw_ref: str, user_id: str) -> Dict[str, Any]:
    """Map a natural-language worker reference to a single worker id, SAFELY.

    #892: "run the node smoke test worker" must resolve to `node-smoke-test`
    (or ask), and must NEVER silently fire a different worker (e.g. the live
    proof run fuzzy-matched it to `approval-smoke-e2e` and fired it). The fix:
    only return a worker when the match is HIGH-CONFIDENCE and UNAMBIGUOUS:

      - exact id match, OR
      - exact name match (case-insensitive), OR
      - exactly one worker whose normalized id/name equals the normalized ref.

    On low confidence or ambiguity, return ``{"ok": False, "ambiguous": True,
    "candidates": [...]}`` listing the closest worker ids so the model can ask
    the user which one — it does NOT pick one. The caller must NOT run on an
    ambiguous result.

    Returns ``{"ok": True, "worker_id": <id>}`` on a confident match, or
    ``{"ok": False, ...}`` otherwise.
    """
    from services.worker_access import _canonical_worker_id

    ref = (raw_ref or "").strip()
    if not ref:
        return {"ok": False, "error": "id is required"}

    workers = _list_viewable_workers(conn, user_id)
    by_id = {w["id"]: w for w in workers}

    # 1. Exact id match — the model passed a real worker id verbatim, or the
    #    canonical slug of the ref IS an existing viewable worker id. This is an
    #    EXACT id path only (_canonical_worker_id is a deterministic slugify, not
    #    a fuzzy match), so it can never misroute "node smoke test" to an
    #    unrelated worker. We require the slug to be a REAL enumerated worker
    #    (``in by_id``); we do NOT trust _worker_can_view's dev-mode filesystem
    #    permissiveness here, because that would happily accept a non-existent
    #    slug like "node-smoke-test-worker" and bypass the safe name match below.
    canonical = _canonical_worker_id(ref)
    if ref in by_id:
        return {"ok": True, "worker_id": ref}
    if canonical and canonical in by_id:
        return {"ok": True, "worker_id": canonical}

    # 2. Exact name match (case-insensitive, unambiguous).
    ref_lower = ref.lower()
    name_hits = [w for w in workers if w["name"].lower() == ref_lower]
    if len(name_hits) == 1:
        return {"ok": True, "worker_id": name_hits[0]["id"]}

    # 3. Filler-stripped normalized equality against id OR name (handles "the
    #    node smoke test worker" -> node-smoke-test, "Weekly Update" ->
    #    weekly_update, etc.). Exact-after-normalization only — never a prefix or
    #    substring guess — so it stays high-confidence.
    match_ref = _worker_match_key(ref)
    if match_ref:
        norm_hits: List[Dict[str, str]] = []
        norm_seen: set[str] = set()
        for w in workers:
            if w["id"] in norm_seen:
                continue
            if (
                _worker_match_key(w["id"]) == match_ref
                or _worker_match_key(w["name"]) == match_ref
            ):
                norm_hits.append(w)
                norm_seen.add(w["id"])
        if len(norm_hits) == 1:
            return {"ok": True, "worker_id": norm_hits[0]["id"]}
        if len(norm_hits) > 1:
            return {
                "ok": False,
                "ambiguous": True,
                "error": (
                    f"{len(norm_hits)} workers match {ref!r}. Ask the user which "
                    "one to run; do NOT run any until they confirm."
                ),
                "candidates": [{"id": w["id"], "name": w["name"]} for w in norm_hits],
            }

    # 3b. Exact-id fallback for a viewable worker not in the enumeration window
    #     (e.g. a fresh on-disk worker in dev/single-user mode). Reached ONLY
    #     after every name/normalized match above has failed, so it can never
    #     shadow a safe name match — the #892 misroute lived in the name path,
    #     not here. This preserves the pre-#892 ability to run a worker by its
    #     exact canonical id.
    if canonical and canonical not in by_id and _worker_can_view(conn, canonical, user_id):
        return {"ok": True, "worker_id": canonical}

    # 4. No confident match → offer the closest candidates by shared normalized
    #    tokens, but DO NOT run. Rank by token overlap so the suggestions are
    #    relevant ("node smoke test" surfaces node-smoke-test even when an
    #    unrelated approval-smoke worker also contains "smoke"). Generic filler
    #    tokens ("worker", "the", "run") are ignored so a bare "ghost-worker"
    #    doesn't false-match every worker via the ubiquitous "worker" token.
    ref_tokens = set(t for t in match_ref.split("-") if t)
    scored: List[tuple[int, Dict[str, str]]] = []
    for w in workers:
        w_tokens = set(
            t for t in (
                _worker_match_key(w["id"]).split("-")
                + _worker_match_key(w["name"]).split("-")
            ) if t
        )
        overlap = len(ref_tokens & w_tokens)
        if overlap:
            scored.append((overlap, w))
    scored.sort(key=lambda x: (-x[0], x[1]["id"]))
    candidates = [{"id": w["id"], "name": w["name"]} for _, w in scored[:5]]
    if not candidates:
        # Truly unknown reference (no viewable worker shares any token). Preserve
        # the pre-#892 "not found" contract — the model must surface a clean
        # not-found, never narrate a started/finished run (#877). No success
        # fields, no candidates to guess from.
        return {"ok": False, "error": f"Worker not found: {ref}"}
    return {
        "ok": False,
        "ambiguous": True,
        "error": (
            f"No worker clearly matches {ref!r}. Ask the user to confirm which of "
            "these they mean (use the exact id); do NOT run any worker until they "
            "confirm."
        ),
        "candidates": candidates,
    }


def _tool_workers_get(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_db as _get_db
    worker_id = str(args.get("id") or "")
    if not worker_id:
        return {"ok": False, "error": "id is required"}
    from services.worker_access import _canonical_worker_id
    worker_id = _canonical_worker_id(worker_id)
    with _get_db() as conn:
        # Security: enforce ownership/visibility before fetching full details.
        if not _worker_can_view(conn, worker_id, user_id):
            return {"ok": False, "error": f"Worker not found: {worker_id}"}
        row = conn.execute(
            """
            SELECT w.id, w.name, w.trigger_type, w.enabled, w.cron_expr,
                   sv.manifest_json
            FROM workers w
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE w.id = ?
            """,
            (worker_id,),
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


def _chat_workspace_id(user_id: str) -> str:
    try:
        from db import derive_workspace_id

        return derive_workspace_id(user_id)
    except Exception:
        return "local-default"


def _claim_chat_rate_slot(key: str, *, limit: int, window: float) -> Optional[int]:
    if limit <= 0:
        return None
    now = time.time()
    cutoff = now - window
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS run_create_rate_limits (
                key TEXT NOT NULL,
                ts REAL NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_run_create_rate_limits_key_ts ON run_create_rate_limits(key, ts)"
        )
        conn.execute("DELETE FROM run_create_rate_limits WHERE ts <= ?", (cutoff,))
        row = conn.execute(
            "SELECT COUNT(*) AS count, MIN(ts) AS oldest_ts FROM run_create_rate_limits WHERE key = ?",
            (key,),
        ).fetchone()
        count = int(row["count"] or 0) if row else 0
        if count >= limit:
            oldest_ts = float(row["oldest_ts"] or now) if row else now
            return max(1, int((oldest_ts + window) - now) + 1)
        conn.execute("INSERT INTO run_create_rate_limits (key, ts) VALUES (?, ?)", (key, now))
    return None


def _release_chat_rate_slot(key: str) -> None:
    try:
        with get_db() as conn:
            conn.execute(
                """
                DELETE FROM run_create_rate_limits
                WHERE rowid = (
                    SELECT rowid FROM run_create_rate_limits
                    WHERE key = ?
                    ORDER BY ts DESC
                    LIMIT 1
                )
                """,
                (key,),
            )
    except Exception:
        logger.warning("Failed to release rate slot for %s", key, exc_info=True)


def _emily_draft_limit() -> tuple[int, float]:
    try:
        limit = int(os.environ.get("WORKEROS_DRAFT_RATE_HOUR", "20"))
    except ValueError:
        limit = 20
    return max(0, limit), 3600.0


def _emily_run_create_limit() -> tuple[int, float]:
    try:
        limit = int(os.environ.get("WORKEROS_RUN_CREATE_RATE_LIMIT", "10"))
    except ValueError:
        limit = 10
    try:
        window = float(os.environ.get("WORKEROS_RUN_CREATE_RATE_WINDOW_SECONDS", "60"))
    except ValueError:
        window = 60.0
    return max(0, limit), max(1.0, window)


def _enforce_worker_author_chat_throttles(user_id: str, workspace_id: str) -> Optional[Dict[str, Any]]:
    draft_limit, draft_window = _emily_draft_limit()
    draft_key = f"user:{user_id}:workspace:{workspace_id}:drafts"
    retry_after = _claim_chat_rate_slot(
        draft_key,
        limit=draft_limit,
        window=draft_window,
    )
    if retry_after is not None:
        return {
            "ok": False,
            "error": f"Draft rate limit reached: {draft_limit}/hour.",
            "retry_after": retry_after,
        }

    run_limit, run_window = _emily_run_create_limit()
    retry_after = _claim_chat_rate_slot(
        f"user:{user_id}:workspace:{workspace_id}:runs",
        limit=run_limit,
        window=run_window,
    )
    if retry_after is not None:
        _release_chat_rate_slot(draft_key)
        return {
            "ok": False,
            "error": f"Run creation rate limit exceeded: {run_limit}/{int(run_window)}s.",
            "retry_after": retry_after,
        }
    return None


def _ensure_worker_author_registered(user_id: str) -> Optional[str]:
    try:
        from main import _WORKER_AUTHOR_ID
        from services.worker_access import _get_db_worker
        from worker_registry import discover_workers, get_worker, invalidate_worker_cache
        from db import get_repositories
        from main import _persist_discovered_workers
    except Exception as exc:
        return str(exc)

    repos = get_repositories()
    worker = _get_db_worker(_WORKER_AUTHOR_ID, user_id=user_id, repos=repos) or get_worker(_WORKER_AUTHOR_ID)
    if worker:
        return None
    try:
        invalidate_worker_cache()
        workers = discover_workers(use_cache=False)
        with get_db() as conn:
            _persist_discovered_workers(conn, workers, user_id=user_id)
    except Exception as exc:
        logger.warning("Failed to auto-register worker-author for chat: %s", exc)
    worker = _get_db_worker(_WORKER_AUTHOR_ID, user_id=user_id, repos=repos) or get_worker(_WORKER_AUTHOR_ID)
    if not worker:
        return "worker-author bundle not found"
    return None


def _idempotent_worker_author_run(
    *,
    user_id: str,
    conversation_id: str,
    idempotency_key: str,
    prompt: str,
    mode: str,
) -> Dict[str, Any]:
    from db import get_repositories
    from run_service import create_run, start_run

    tool_name = "workers__create_from_prompt"
    clean_key = idempotency_key.strip()
    if not clean_key:
        return {"ok": False, "error": "idempotency_key is required"}

    claimed = False
    with get_db() as conn:
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO chat_tool_idempotency
                (user_id, conversation_id, tool_name, idempotency_key,
                 run_id, worker_id, created_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                user_id,
                conversation_id,
                tool_name,
                clean_key,
                "worker-author",
                now_iso(),
            ),
        )
        claimed = cursor.rowcount == 1
        if not claimed:
            row = conn.execute(
                """
                SELECT run_id, worker_id
                FROM chat_tool_idempotency
                WHERE user_id = ? AND conversation_id = ? AND tool_name = ? AND idempotency_key = ?
                """,
                (user_id, conversation_id, tool_name, clean_key),
            ).fetchone()
            if row and row["run_id"]:
                return {
                    "ok": True,
                    "run_id": row["run_id"],
                    "worker_id": row["worker_id"] or "worker-author",
                    "idempotent": True,
                    "message": f"Worker-author run '{row['run_id']}' is already queued.",
                }

    if not claimed:
        deadline = time.time() + 2.0
        while time.time() < deadline:
            time.sleep(0.05)
            with get_db() as conn:
                row = conn.execute(
                    """
                    SELECT run_id, worker_id
                    FROM chat_tool_idempotency
                    WHERE user_id = ? AND conversation_id = ? AND tool_name = ? AND idempotency_key = ?
                    """,
                    (user_id, conversation_id, tool_name, clean_key),
                ).fetchone()
            if row and row["run_id"]:
                return {
                    "ok": True,
                    "run_id": row["run_id"],
                    "worker_id": row["worker_id"] or "worker-author",
                    "idempotent": True,
                    "message": f"Worker-author run '{row['run_id']}' is already queued.",
                }
        return {
            "ok": False,
            "error": "A matching worker-author request is already being created. Retry shortly with the same idempotency_key.",
            "idempotent": True,
        }

    def _release_reservation() -> None:
        try:
            with get_db() as conn:
                conn.execute(
                    """
                    DELETE FROM chat_tool_idempotency
                    WHERE user_id = ? AND conversation_id = ? AND tool_name = ?
                      AND idempotency_key = ? AND run_id IS NULL
                    """,
                    (user_id, conversation_id, tool_name, clean_key),
                )
        except Exception:
            logger.warning("Failed to release worker-author idempotency reservation", exc_info=True)

    try:
        workspace_id = _chat_workspace_id(user_id)
        throttled = _enforce_worker_author_chat_throttles(user_id, workspace_id)
        if throttled:
            _release_reservation()
            return throttled
        unavailable = _ensure_worker_author_registered(user_id)
        if unavailable:
            _release_reservation()
            return {"ok": False, "error": unavailable}

        inputs: Dict[str, Any] = {"prompt": prompt, "mode": mode}
        repos = get_repositories()
        run_id = create_run(
            "worker-author",
            inputs,
            "workspace-agent",
            user_id=user_id,
            repos=repos,
        )
        with get_db() as conn:
            conn.execute(
                """
                UPDATE chat_tool_idempotency
                SET run_id = ?, worker_id = ?
                WHERE user_id = ? AND conversation_id = ? AND tool_name = ? AND idempotency_key = ?
                """,
                (
                    run_id,
                    "worker-author",
                    user_id,
                    conversation_id,
                    tool_name,
                    clean_key,
                ),
            )
        start_run(run_id, "worker-author", inputs, user_id=user_id, repos=repos)
        return {
            "ok": True,
            "run_id": run_id,
            "worker_id": "worker-author",
            "status": "running",
            "idempotent": False,
            "message": f"Worker-author run '{run_id}' started.",
        }
    except Exception as exc:
        _release_reservation()
        logger.exception("workers__create_from_prompt failed")
        return {"ok": False, "error": str(exc)}


def _tool_workers_create_from_prompt(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "prompt is required"}
    if len(prompt) > 4000:
        return {"ok": False, "error": "prompt must be 4000 characters or fewer"}
    mode = str(args.get("mode") or "create").strip()
    if mode not in {"draft", "create"}:
        return {"ok": False, "error": "mode must be 'draft' or 'create'"}
    conversation_id = _current_chat_conversation_id.get()
    if not conversation_id:
        return {"ok": False, "error": "conversation context unavailable"}
    return _idempotent_worker_author_run(
        user_id=user_id,
        conversation_id=conversation_id,
        idempotency_key=str(args.get("idempotency_key") or ""),
        prompt=prompt,
        mode=mode,
    )


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

    # #673: validate field values before persisting so Emily gets an immediate,
    # actionable error instead of silently saving a broken worker.
    _VALID_TRIGGER_TYPES = {"manual", "schedule", "webhook", "event"}
    trigger_block = manifest.get("trigger") or {}
    if isinstance(trigger_block, dict):
        trigger_type = trigger_block.get("type") or ""
        if trigger_type and trigger_type not in _VALID_TRIGGER_TYPES:
            return {
                "ok": False,
                "error": (
                    f"Invalid trigger.type '{trigger_type}'. "
                    f"Valid values: {sorted(_VALID_TRIGGER_TYPES)}. "
                    "For a scheduled worker use type: 'schedule' with cron: '*/10 * * * *'. "
                    "Never use 'cron' or 'incoming_email' — they do not exist in WorkerOS."
                ),
            }
    exec_block = manifest.get("exec") or {}
    if isinstance(exec_block, dict):
        runner = exec_block.get("runner") or ""
        if runner and runner != "e2b":
            return {
                "ok": False,
                "error": (
                    f"Invalid exec.runner '{runner}'. "
                    "The only valid runner is 'e2b'. "
                    "The local in-process runner was removed. Set exec.runner: 'e2b'."
                ),
            }

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
    result = _emily_worker_result_message(worker_id, "created", smoke_status, smoke_reason)
    # #675: include what was *actually* saved so Emily can verify it matches the
    # user's intent without a separate workers.get call. This surfaces silent drops
    # (e.g. connections=[], approvals.required=False) immediately in the tool result.
    exec_block = manifest.get("exec") or {}
    trigger_block = manifest.get("trigger") or {}
    approvals_block = manifest.get("approvals") or {}
    result["saved_config"] = {
        "connections": manifest.get("connections") or [],
        "approvals_required": bool(approvals_block.get("required", False)),
        "trigger_type": (trigger_block.get("type") if isinstance(trigger_block, dict) else trigger_block) or "manual",
        "exec_mode": (exec_block.get("mode") if isinstance(exec_block, dict) else None) or "unknown",
        "runner": (exec_block.get("runner") if isinstance(exec_block, dict) else None) or "unknown",
    }
    return result


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
    from services.worker_access import _canonical_worker_id
    worker_id = _canonical_worker_id(worker_id)

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
    raw_ref = str(args.get("id") or "")
    if not raw_ref:
        return {"ok": False, "error": "id is required"}
    inputs_json = args.get("inputs_json") or "{}"
    try:
        inputs = json.loads(inputs_json) if isinstance(inputs_json, str) else dict(inputs_json or {})
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"Invalid inputs_json: {exc}"}

    # #892: resolve the natural-language reference to a worker id SAFELY. The
    # previous behaviour slugified the ref and ran whatever id came out, letting
    # "run the node smoke test worker" silently fire the WRONG worker (proof run
    # hit approval-smoke-e2e instead of node-smoke-test). _resolve_runnable_worker
    # only returns a worker on a HIGH-CONFIDENCE, UNAMBIGUOUS match; on ambiguity
    # it returns candidate ids for the model to confirm — it NEVER auto-picks.
    from db import get_db as _get_db
    with _get_db() as conn:
        resolution = _resolve_runnable_worker(conn, raw_ref, user_id)
        if not resolution.get("ok"):
            return resolution
        worker_id = str(resolution["worker_id"])
        # Security (#748): actor must own the worker or it must be workspace-
        # visible and the actor an active workspace member.
        if not _worker_can_view(conn, worker_id, user_id):
            return {"ok": False, "error": f"Worker not found: {worker_id}"}

    # #627: validate required inputs BEFORE firing the run (was: create_run ran
    # first and the run failed at execution time). Load the declared input schema
    # and return a structured error listing missing fields so Emily can ask the
    # user for them before retrying.
    from run_service import get_worker_config_for_run
    run_config = get_worker_config_for_run(worker_id)
    if run_config is not None:
        declared_inputs = getattr(run_config, "inputs", []) or []
        missing = [
            inp for inp in declared_inputs
            if getattr(inp, "required", False)
            and (inp.name not in inputs or inputs.get(inp.name) in (None, ""))
        ]
        if missing:
            # Include the label/description so Emily can phrase the follow-up
            # question intelligently rather than echoing a raw field name.
            details = [
                f"{inp.name!r} ({inp.label or inp.description or inp.name})"
                for inp in missing
            ]
            return {
                "ok": False,
                "error": f"Missing required inputs: {', '.join(details)}. "
                         "Ask the user to provide them, then retry.",
                "missing_inputs": [inp.name for inp in missing],
            }

    from run_service import create_run, start_run
    from db import get_repositories
    try:
        repos = get_repositories()
        run_id = create_run(
            worker_id,
            inputs,
            trigger_source="workspace-agent",
            user_id=user_id,
            repos=repos,
        )
        start_run(run_id, worker_id, inputs, user_id=user_id, repos=repos)
        # The run is enqueued, not finished. Report only the real run_id and its
        # current status ("queued"); the model must NOT narrate an output yet.
        # On success we return {ok, run_id, status} and nothing that looks like a
        # completed result. (#877)
        return {
            "ok": True,
            "run_id": run_id,
            "status": "queued",
            "message": (
                f"Run '{run_id}' was queued for worker '{worker_id}'. "
                "It has not finished; do not report any output until it completes."
            ),
        }
    except Exception as exc:
        # Failure: return only ok:false + error. No run_id, no status, no
        # message, nothing the model could misread as a started/finished run.
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


# Public frontend base for user-facing deep links (e.g. the approval review page).
# Honour the same host the rest of the engine uses: WORKEROS_PUBLIC_URL is the
# explicit override; otherwise fall back to WORKERS_FRONTEND_URL (used by
# main._frontend_base_url and the email/alert links) so a self-hosted deployment
# that sets one host gets correct links everywhere, not a hardcoded floom.dev.
_APPROVALS_BASE_URL = (
    os.environ.get("WORKEROS_PUBLIC_URL")
    or os.environ.get("WORKERS_FRONTEND_URL")
    or "https://workers.floom.dev"
).rstrip("/")


def _approval_public_token(row: Any) -> str:
    # #998: fail closed — no signing with a public constant.
    secret = (os.environ.get("FLOOM_SECRET") or "").strip()
    if not secret:
        from fastapi import HTTPException
        raise HTTPException(status_code=503, detail="Server signing secret not configured")
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
        result = []
        for row in rows:
            approval_id = row["id"]
            # Authoritative, tokenised deep link on the configured public host so
            # Emily surfaces a working link instead of inventing a floom.dev URL.
            review_url = None
            if approval_id and row["run_id"] and row["owner_id"]:
                token = _approval_public_token(
                    {"id": approval_id, "run_id": row["run_id"], "owner_id": row["owner_id"]}
                )
                review_url = f"{_APPROVALS_BASE_URL}/approvals/review?id={approval_id}&token={token}"
            result.append({
                "id": approval_id,
                "owner_id": row["owner_id"],
                "worker_id": row["worker_id"],
                "worker_name": row["worker_name"] or row["worker_id"],
                "run_id": row["run_id"],
                "label": row["label"],
                "preview": (row["preview"] or "")[:200] or None,
                "created_at": row["created_at"],
                "review_url": review_url,
            })
        return {"ok": True, "approvals": result, "count": len(result)}
    except Exception as exc:
        logger.exception("approvals__list_pending failed")
        return {"ok": False, "error": str(exc)}


def _resolve_pending_approval_for_actor(
    *, approval_id: Optional[str], run_id: Optional[str], user_id: str
) -> Dict[str, Any]:
    """Find the actor's single pending approval by approval_id or run_id.

    OWNER-SCOPED (#891): only approvals owned by *user_id* are visible; an actor
    can never approve/reject another user's run. Returns
    ``{"ok": True, "approval": <row>}`` on success or ``{"ok": False, ...}`` with
    a model-readable error (not found / not owned / ambiguous / already decided).
    """
    from db import get_db as _get_db

    approval_id = (approval_id or "").strip() or None
    run_id = (run_id or "").strip() or None
    if not approval_id and not run_id:
        return {"ok": False, "error": "approval_id or run_id is required."}

    with _get_db() as conn:
        if approval_id:
            row = conn.execute(
                "SELECT id, run_id, owner_id, status FROM approvals "
                "WHERE id = ? AND owner_id = ? LIMIT 1",
                (approval_id, user_id),
            ).fetchone()
            if row is None:
                # Distinguish "not yours" from "doesn't exist" without leaking
                # another user's approval — both collapse to a single message.
                return {
                    "ok": False,
                    "error": f"No pending approval {approval_id!r} found for you.",
                }
        else:
            rows = conn.execute(
                "SELECT id, run_id, owner_id, status FROM approvals "
                "WHERE run_id = ? AND owner_id = ? ORDER BY created_at DESC",
                (run_id, user_id),
            ).fetchall()
            if not rows:
                return {
                    "ok": False,
                    "error": f"No approval for run {run_id!r} found for you.",
                }
            pending_rows = [r for r in rows if str(r["status"]) == "pending"]
            if not pending_rows:
                return {
                    "ok": False,
                    "error": f"The approval for run {run_id!r} is no longer pending.",
                }
            if len(pending_rows) > 1:
                return {
                    "ok": False,
                    "ambiguous": True,
                    "error": (
                        f"Run {run_id!r} has {len(pending_rows)} pending approvals; "
                        "pass approval_id to choose one."
                    ),
                    "candidates": [str(r["id"]) for r in pending_rows],
                }
            row = pending_rows[0]

    if str(row["status"]) != "pending":
        return {"ok": False, "error": "That approval is no longer pending (already decided)."}
    return {
        "ok": True,
        "approval": {
            "id": str(row["id"]),
            "run_id": str(row["run_id"] or ""),
            "owner_id": str(row["owner_id"] or ""),
        },
    }


def _decide_approval(
    *, decision: str, approval_id: Optional[str], run_id: Optional[str], user_id: str
) -> Dict[str, Any]:
    """Approve or reject the actor's pending approval (#891).

    Reuses the SAME canonical decision functions the HTTP endpoints POST to
    (approve_run/reject_run for run-level approvals, approve/reject agent-tool
    approvals for kind=agent_tool, destructive-action for kind=destructive_delete),
    constructing an owner-scoped AuthContext exactly like the public-link path in
    main.py does. OWNER-SCOPED: the approval is resolved only within the actor's
    own approvals, so an actor can never decide another user's run.
    """
    resolved = _resolve_pending_approval_for_actor(
        approval_id=approval_id, run_id=run_id, user_id=user_id
    )
    if not resolved.get("ok"):
        return resolved
    approval_id = resolved["approval"]["id"]
    target_run_id = resolved["approval"]["run_id"]

    from db import get_repositories
    from main import (
        AuthContext,
        ApproveRequest,
        RejectRequest,
        approve_run,
        reject_run,
        approve_agent_tool_approval,
        reject_agent_tool_approval,
        approve_destructive_action,
        reject_destructive_action,
    )

    repos = get_repositories()
    auth = AuthContext(user_id=user_id, email=None, scopes=("chat", "approval"))

    # Determine the approval kind to route to the correct canonical path,
    # mirroring approve_public_approval/reject_public_approval in main.py.
    kind = ""
    try:
        approval_row = repos.approvals.get(owner_id=user_id, approval_id=approval_id)
        if approval_row is not None:
            kind = (json.loads(approval_row.get("decision_input_json") or "{}") or {}).get("kind") or ""
    except Exception:
        kind = ""

    try:
        if decision == "approved":
            if kind == "destructive_delete":
                result = approve_destructive_action(approval_id, auth, repos)
                status = str((result or {}).get("status") or "approved")
            elif kind == "agent_tool":
                result = approve_agent_tool_approval(approval_id, ApproveRequest(), auth, repos)
                status = getattr(result, "status", "approved")
            else:
                result = approve_run(target_run_id, ApproveRequest(), auth, repos)
                status = getattr(result, "status", "approved")
        else:
            reason = f"Rejected via chat by {user_id}"
            if kind == "destructive_delete":
                result = reject_destructive_action(
                    approval_id, RejectRequest(reason=reason), auth, repos
                )
                status = str((result or {}).get("status") or "rejected")
            elif kind == "agent_tool":
                result = reject_agent_tool_approval(
                    approval_id, RejectRequest(reason=reason), auth, repos
                )
                status = getattr(result, "status", "rejected")
            else:
                result = reject_run(target_run_id, RejectRequest(reason=reason), auth, repos)
                status = getattr(result, "status", "rejected")
    except Exception as exc:
        detail = getattr(exc, "detail", None) or str(exc)
        low = str(detail).lower()
        if "not awaiting approval" in low or "already decided" in low:
            return {"ok": False, "error": "That approval is no longer pending (already decided)."}
        if "not found" in low:
            return {"ok": False, "error": "That approval is no longer available."}
        logger.exception("approvals__%s failed for approval %s", decision, approval_id)
        return {"ok": False, "error": str(detail)}

    return {"ok": True, "status": status, "run_id": target_run_id, "approval_id": approval_id}


def _tool_approvals_approve(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    return _decide_approval(
        decision="approved",
        approval_id=args.get("approval_id"),
        run_id=args.get("run_id"),
        user_id=user_id,
    )


def _tool_approvals_reject(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    return _decide_approval(
        decision="rejected",
        approval_id=args.get("approval_id"),
        run_id=args.get("run_id"),
        user_id=user_id,
    )


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


def _workspace_agent_skill_for_intent(skill_md: str, *, include_authoring_rules: bool) -> str:
    if include_authoring_rules:
        return skill_md
    return re.sub(
        r"\n## Workeros worker\.yml format\n.*?(?=\n## Workspace-management tools\n)",
        "\n",
        skill_md,
        flags=re.DOTALL,
    )


def _build_system_prompt(user_id: str, *, include_authoring_rules: bool = False) -> str:
    """Build the system prompt, with worker-authoring rules gated by intent."""
    base_persona = get_workspace_base_persona()
    workspace_content = get_workspace_md()
    preamble = _build_workspace_preamble(user_id)
    from worker_registry import WORKERS_DIR
    skill_path = WORKERS_DIR / WORKSPACE_AGENT_ID / "SKILL.md"
    skill_md = skill_path.read_text(encoding='utf-8') if skill_path.is_file() else ""
    skill_md = skill_md.replace("{{WORKSPACE_PREAMBLE}}", preamble)
    skill_md = _workspace_agent_skill_for_intent(
        skill_md,
        include_authoring_rules=include_authoring_rules,
    )
    # Workspace instructions are user data. Wrap them in a clearly delimited
    # block so they cannot masquerade as system rules (prompt-injection hygiene).
    custom = (
        "<!-- Workspace instructions (set by the user): -->\n"
        f"{workspace_content.strip()}\n"
        "<!-- end workspace instructions -->"
        if workspace_content.strip()
        else ""
    )
    authoring_rules = WORKER_AUTHORING_RULES if include_authoring_rules else ""
    return "\n\n".join(
        part for part in [base_persona, custom, authoring_rules, skill_md] if part
    )


# ---------------------------------------------------------------------------
# Surface-aware communication profiles
#
# Structure: GLOBAL_COMMUNICATION_RULES (applied to every call) +
# ENVIRONMENT_NOTES (per-surface block, keyed by source).  Both are appended
# to the shared Emily persona so the model knows HOW it is being reached and
# adapts reply shape accordingly.  Keep each block short (<=80 words).
# Do NOT move personality here — persona lives in EMILY_BASE_PERSONA.
# ---------------------------------------------------------------------------

GLOBAL_COMMUNICATION_RULES: str = (
    "## Communication rules (all surfaces)\n"
    "Use your tools to investigate before answering; don't guess when you can check. "
    "Be user-friendly and concise. Every sentence earns its place. "
    "Be honest about limits -- if you don't know, say so and call a tool or ask. "
    "Never use robotic legalese, hedging walls, or filler phrases. "
    "No double spaces. When giving links, use the shortest accurate URL the tool returns. "
    "Never invent host names or run IDs.\n"
    "## Never claim un-performed actions\n"
    "Never say you did something (ran a worker, started a run, sent a message, created "
    "or updated something) unless a tool call actually returned success with a concrete "
    "id or result in this turn. A tool result of ok:false, an error, not-found, or "
    "blocked means the action did NOT happen; say so plainly and report the reason "
    "(for example: \"I couldn't start that worker because ...\"). Never invent a run id, "
    "a status, or worker output, and never narrate a result for a run that did not start. "
    "If a run did start, report only its real run_id and status (for example queued); "
    "do not invent its output before it has finished."
)

ENVIRONMENT_NOTES: Dict[str, str] = {
    "whatsapp": (
        "## Current environment: WhatsApp\n"
        "Hard limits: plain text only. No markdown headers (#), tables, "
        "[text](url) links, or code fences (``` or `). "
        "WhatsApp formatting: *single asterisk* for bold (NEVER **double asterisk**), "
        "_underscore_ for italic, ~tilde~ for strikethrough. "
        "Prefer NO formatting for single words or codewords -- just write them plainly. "
        "Keep each reply under 1500 characters unless the user explicitly asks for more. "
        "Default to a few short lines. One message, not a wall of text. "
        "If something needs the UI, give the raw URL only."
    ),
    "slack": (
        "## Current environment: Slack\n"
        "You are talking in Slack. Use Slack mrkdwn (*bold* for emphasis, "
        "triple-backtick for code/YAML/JSON). Keep replies tight. "
        "Reference channels and users with Slack conventions. "
        "Threaded context carries forward — no need to repeat prior context. "
        "When something needs the screen, give the exact link the tool returns."
    ),
    "web": (
        "## Current environment: Workeros web app\n"
        "You are in the Workeros web app. Rich markdown is fine; "
        "tool results render as cards; longer structured answers are OK when asked. "
        "The person can see the dashboard alongside this chat."
    ),
    "mcp": (
        "## Current environment: MCP (programmatic caller)\n"
        "You are being called via MCP, likely by another AI agent. "
        "Be terse and structured. No pleasantries or onboarding text. "
        "Return clean, actionable results the calling agent can use directly."
    ),
    "cli": (
        "## Current environment: CLI / API (programmatic caller)\n"
        "You are being called via the CLI or a direct API client. "
        "Be terse and structured. No pleasantries. "
        "Return clean, actionable results suitable for scripting or piping."
    ),
}


_WORKER_AUTHORING_INTENT_RE = re.compile(
    r"("
    r"\b(create|build|make|draft|author|generate|write|scaffold|clone|fork)\b.{0,90}\b(worker|agent|automation|worker\.ya?ml)\b"
    r"|"
    r"\b(worker|agent|automation|worker\.ya?ml)\b.{0,90}\b(create|build|make|draft|author|generate|write|edit|update|modify|fix|clone|fork)\b"
    r"|"
    r"\b(edit|update|modify|fix)\b.{0,90}\bworker\b"
    r"|"
    r"\bworkers__(create|create_from_prompt|update)\b"
    r"|"
    r"\bworker\.ya?ml\b"
    r")",
    re.IGNORECASE | re.DOTALL,
)


def _is_worker_authoring_intent(message: str) -> bool:
    return bool(_WORKER_AUTHORING_INTENT_RE.search(str(message or "")))


def _environment_note(source: str) -> str:
    """Return the short env-aware note for a source, defaulting to web."""
    return ENVIRONMENT_NOTES.get(source, ENVIRONMENT_NOTES["web"])


_CAPABILITIES_SNAPSHOT_LIMIT = 5  # max notable workers listed by name


def _build_capabilities_snapshot(user_id: str) -> str:
    """Assemble a compact (<150 words) factual capabilities block for the acting user.

    Includes: active connection names; worker count + up to 5 notable enabled
    workers by name; brain packs attached; whether approvals are required;
    actor role (admin/member) and what that limits.

    Reuses existing DB helpers — does NOT invent new queries.  Never raises;
    returns a safe fallback on any error.
    """
    try:
        from db import get_repositories, derive_workspace_id

        repos = get_repositories()

        # --- connections ---
        active_connections: list[str] = []
        try:
            for c in repos.connections.list(user_id=user_id):
                if (c.get("status") or "") == "active":
                    app_name = c.get("app_name") or "connection"
                    account = c.get("display_name") or c.get("account_label")
                    label = f"{app_name} ({account})" if account else str(app_name)
                    active_connections.append(label)
        except Exception:
            pass

        # --- workers ---
        worker_count = 0
        notable_workers: list[str] = []
        try:
            all_workers = repos.workers.list(user_id=user_id)
            non_system = [
                w for w in all_workers
                if not (w.get("manifest") or {}).get("system_worker")
                and not (w.get("manifest") or {}).get("is_example")
            ]
            worker_count = len(non_system)
            enabled = [w for w in non_system if w.get("enabled")]
            notable_workers = [
                w["name"] for w in enabled[:_CAPABILITIES_SNAPSHOT_LIMIT] if w.get("name")
            ]
        except Exception:
            pass

        # --- brain packs ---
        brain_packs: list[str] = []
        try:
            brain_packs = _owner_brain_pack_names(user_id)
        except Exception:
            pass

        # --- pending approvals ---
        pending_approvals = 0
        try:
            with get_db() as _conn:
                _row = _conn.execute(
                    "SELECT COUNT(*) AS cnt FROM approvals WHERE owner_id = ? AND status = 'pending'",
                    (user_id,),
                ).fetchone()
            pending_approvals = int(_row["cnt"] or 0) if _row else 0
        except Exception:
            pass

        # --- actor role ---
        actor_role = "owner"  # default for OS single-tenant
        try:
            workspace_id = derive_workspace_id(user_id)
            members_repo = repos.members  # type: ignore[union-attr]
            if members_repo is not None:
                member_row = members_repo.get(
                    workspace_id=workspace_id, user_id=user_id
                )
                if member_row:
                    actor_role = member_row.get("role") or "member"
        except Exception:
            pass

        # --- format ---
        conn_str = ", ".join(active_connections) if active_connections else "none"
        worker_str: str
        if notable_workers:
            worker_str = f"{worker_count} total; enabled: {', '.join(notable_workers)}"
            if worker_count > len(notable_workers):
                worker_str += " + more"
        else:
            worker_str = str(worker_count)
        brain_str = ", ".join(brain_packs) if brain_packs else "none"
        approvals_note = (
            f"{pending_approvals} pending" if pending_approvals > 0 else "none pending"
        )
        role_note = (
            "full access (owner/admin)"
            if actor_role in {"owner", "admin"}
            else "read + run own workers only (member)"
        )

        return (
            "## What you can do here (capabilities snapshot)\n"
            "NOTE: INTERNAL CONTEXT, not a script to read back. "
            "When you describe yourself or answer 'what can you do?', talk like a chief "
            "of staff in outcomes, never a tool inventory. Lead with what you get DONE "
            "for them, with everyday examples a founder relates to (send a morning "
            "brief, chase replies they're waiting on, keep the inbox under control, "
            "turn a recurring request into a workflow that just runs). Make clear you "
            "work autonomously around the clock, run a team of always-on workers, and "
            "remember what matters to them. "
            "NEVER recite internal plumbing: do not say 'secrets', 'MCP', 'debug "
            "workers', 'connections', 'missing config', or list connected apps by name. "
            "Those are yours to USE, not read out. Surface internals only if the user "
            "explicitly asks about setup.\n"
            f"- Connections: {conn_str}\n"
            f"- Workers: {worker_str}\n"
            f"- Brain packs: {brain_str}\n"
            f"- Approvals: {approvals_note}\n"
            f"- Actor role: {actor_role} — {role_note}"
        )
    except Exception as exc:
        logger.warning("Failed to build capabilities snapshot: %s", exc)
        return "## What you can do here (capabilities snapshot)\n(unavailable)"


def build_system_prompt_for_source(user_id: str, source: str = "web", message: str = "") -> str:
    """Shared workspace-agent prompt plus global communication rules, a
    per-surface environment block, and a live workspace capabilities snapshot.

    Layer order (INCREMENT 2):
      base (persona + workspace instructions + skill.md with preamble)
      + GLOBAL_COMMUNICATION_RULES
      + environment note (per source)
      + capabilities snapshot (assembled fresh; compact, factual, actor-scoped)

    The editable base persona and workspace.md custom instructions are identical
    for every source.  The appended global rules + environment note differ by
    surface (whatsapp / slack / web / mcp / cli).  The capabilities snapshot
    tells Emily what she ACTUALLY has available so she can answer "what can you
    do here?" from facts rather than generic marketing.
    """
    base = _build_system_prompt(
        user_id,
        include_authoring_rules=_is_worker_authoring_intent(message),
    )
    snapshot = _build_capabilities_snapshot(user_id)
    prompt = (
        f"{base}\n\n{GLOBAL_COMMUNICATION_RULES}\n\n{_environment_note(source)}"
        f"\n\n{snapshot}"
    )
    # #844: durable cross-conversation memory (owner's private `memory` pack)
    try:
        from conversation_memory import memory_prompt_section

        memory_section = memory_prompt_section(user_id)
    except Exception:
        memory_section = ""
    if memory_section:
        prompt = f"{prompt}\n\n{memory_section}"
    return prompt


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
        "base_persona": get_workspace_base_persona(),
        "worker_authoring_rules": WORKER_AUTHORING_RULES,
        # build_system_prompt_for_source is what /chat actually runs (#844:
        # includes the User memory section), so the operator view stays honest.
        "system_prompt": build_system_prompt_for_source(user_id, "web", message=""),
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
    system_suffix: str = "",
) -> None:
    """Run the workspace agent and push SSE parts into part_queue.

    Pushes dicts matching the AI SDK part format. Final part is
    {"type": "finish", "conversation_id": ..., "message_id": ...}.
    """
    from agents import Agent, ModelSettings, RunConfig, Runner

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

    assistant_message_id = f"msg_pending_{uuid.uuid4().hex[:16]}"

    logger.debug(
        "stream_chat start conversation=%s user=%s surface=%s",
        conversation_id,
        user_id,
        source,
    )

    # Persist user message
    insert_message(conversation_id, "user", message)
    await part_queue.put({
        "type": "chat.meta",
        "protocol": CHAT_EVENT_PROTOCOL_VERSION,
        "version": CHAT_EVENT_VERSION,
        "conversation_id": conversation_id,
        "assistant_message_id": assistant_message_id,
        "source": source,
    })

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

    system_prompt = build_system_prompt_for_source(user_id, source, message=message)
    if system_suffix:
        system_prompt = f"{system_prompt}\n\n{system_suffix}"
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
        description=(
            "Call this ONLY when the work is actually complete: the question is "
            "answered, or you exhausted every relevant tool and can state the exact "
            "blocker and unblock. Never call it to deliver partial status, list dead "
            "ends, or ask whether to keep going on a read-only investigation -- keep "
            "investigating instead. Pass {\"reply\": \"<markdown>\"}."
        ),
        params_json_schema={
            "type": "object",
            "properties": {"reply": {"type": "string"}},
            "required": ["reply"],
        },
        on_invoke_tool=_finish_placeholder,
        strict_json_schema=False,
    )

    from web_search import web_search_tool
    all_tools = (
        workspace_tools
        + brain_tools
        + composio_tools
        + [web_search_tool(), finish_tool]
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
        trace_id=f"trace_chat_{uuid.uuid4().hex[:16]}",
        trace_metadata={"conversation_id": conversation_id, "user_id": user_id},
        model_provider=loop_local_provider.provider,
    )

    # Buffer assistant text and tool messages for persistence
    assistant_text_parts: List[str] = []
    stream_text_sanitizer = _StreamingTextSanitizer()
    pending_tool_calls: Dict[str, Dict[str, Any]] = {}  # call_id -> {name, args}
    card_summaries: Dict[str, Dict[str, Any]] = {}
    received_text_delta = False

    # Wire finish tool to emit the reply as a text part
    async def _finish_invoke_inner(_ctx: Any, raw_args: str) -> str:
        try:
            args = json.loads(raw_args or "{}")
        except json.JSONDecodeError:
            args = {}
        reply = _ensure_bare_greeting_identity(
            message,
            _sanitize_preview_text(strip_em_dashes(str(args.get("reply") or ""))),
        )
        final_reply_box["reply"] = reply
        # Emit as text part if the agent didn't stream text deltas
        if reply and not received_text_delta and not assistant_text_parts:
            assistant_text_parts.append(reply)
            await part_queue.put({
                "type": "text",
                "version": CHAT_EVENT_VERSION,
                "conversation_id": conversation_id,
                "message_id": assistant_message_id,
                "text": reply,
            })
        return json.dumps({"ok": True, "finished": True})

    finish_tool.on_invoke_tool = _finish_invoke_inner

    final_message_id: Optional[str] = None
    mcp_servers: List[Any] = []
    conversation_token = _current_chat_conversation_id.set(conversation_id)

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

        import llm as _llm

        _emily_model = _llm.agent_model(os.environ.get("WORKEROS_CHAT_MODEL") or DEFAULT_WORKSPACE_AGENT_MODEL)
        agent = Agent(
            name=WORKSPACE_AGENT_ID,
            instructions=system_prompt,
            tools=all_tools,
            mcp_servers=mcp_servers,
            model=_emily_model,
            model_settings=ModelSettings(
                max_tokens=4096,
                include_usage=True,
                extra_args=_llm.cache_control_extra_args(_emily_model),
            ),
            tool_use_behavior={"stop_at_tool_names": ["finish_with_outputs"]},
        )

        result = Runner.run_streamed(
            agent,
            input=input_messages,
            max_turns=30,
            run_config=run_config,
        )

        # SDK event decoding is shared with AgentDriver (#605); this loop only
        # applies chat-specific decoration: sanitizers, greeting identity, card
        # metadata, persistence, and the versioned part envelope.
        from runner_sandbox.stream_adapter import decode_stream_event

        async for event in result.stream_events():
            decoded = decode_stream_event(event)
            if decoded is None:
                continue

            if decoded.kind == "text_delta":
                received_text_delta = True
                text = stream_text_sanitizer.feed(strip_em_dashes(decoded.text))
                if not text:
                    continue
                assistant_text_parts.append(text)
                part = {"type": "text", "text": text}
                part.update({
                    "version": CHAT_EVENT_VERSION,
                    "conversation_id": conversation_id,
                    "message_id": assistant_message_id,
                })
                await part_queue.put(part)
                continue

            if decoded.kind == "message_output" and not received_text_delta:
                full_text = _ensure_bare_greeting_identity(
                    message,
                    _sanitize_preview_text(strip_em_dashes(decoded.text)),
                )
                if full_text:
                    assistant_text_parts.append(full_text)
                    await part_queue.put({
                        "type": "text",
                        "version": CHAT_EVENT_VERSION,
                        "conversation_id": conversation_id,
                        "message_id": assistant_message_id,
                        "text": full_text,
                    })

            elif decoded.kind == "tool_call":
                call_id = decoded.call_id
                tool_name_raw = decoded.tool_name
                raw_args = decoded.args or {}
                raw_args = normalize_tool_args_for_event(tool_name_raw, raw_args)
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
                metadata = build_tool_event_metadata(
                    tool_name_raw,
                    call_id,
                    args=raw_args,
                    phase="call",
                )
                _persist_tool_card(conversation_id, user_id, call_id, tool_name_raw, metadata)
                card_summaries[metadata["card"]["id"]] = {
                    "id": metadata["card"]["id"],
                    "callId": call_id,
                    "kind": metadata["card"]["kind"],
                    "resource": metadata["resource"],
                    "status": metadata["card"]["status"],
                }
                event = {
                    "type": "tool-call",
                    "version": metadata["version"],
                    "conversation_id": conversation_id,
                    "message_id": assistant_message_id,
                    "toolName": tool_name_raw,
                    "args": metadata["args_preview"],
                    "args_preview": metadata["args_preview"],
                    "callId": call_id,
                    "protocol": metadata["protocol"],
                    "card": metadata["card"],
                    "resource": metadata["resource"],
                    "streams": metadata["streams"],
                    "actions": metadata["actions"],
                    "redaction": {"args_redacted": True},
                }
                await part_queue.put(event)
                await part_queue.put({
                    "type": "tool-progress",
                    "version": metadata["version"],
                    "conversation_id": conversation_id,
                    "message_id": assistant_message_id,
                    "toolName": tool_name_raw,
                    "callId": call_id,
                    "card_id": metadata["card"]["id"],
                    "protocol": metadata["protocol"],
                    "resource": metadata["resource"],
                    "status": metadata["card"]["status"],
                    "stage": "started",
                    "label": metadata["card"]["title"],
                    "percent": None,
                })

            elif decoded.kind == "tool_output":
                call_id = decoded.call_id
                parsed_output = decoded.output
                pending = pending_tool_calls.get(call_id, {})
                tool_name = str(pending.get("name") or "tool")
                raw_args = pending.get("args") or {}
                metadata = build_tool_event_metadata(
                    tool_name,
                    call_id,
                    args=raw_args,
                    result=parsed_output,
                    phase="result",
                )
                _persist_tool_card(conversation_id, user_id, call_id, tool_name, metadata)
                card_summaries[metadata["card"]["id"]] = {
                    "id": metadata["card"]["id"],
                    "callId": call_id,
                    "kind": metadata["card"]["kind"],
                    "resource": metadata["resource"],
                    "status": metadata["card"]["status"],
                }
                safe_result = metadata["result_preview"]
                await part_queue.put({
                    "type": "tool-result",
                    "version": metadata["version"],
                    "conversation_id": conversation_id,
                    "message_id": assistant_message_id,
                    "callId": call_id,
                    "toolName": tool_name,
                    "result": safe_result,
                    "isError": decoded.is_error,
                    "protocol": metadata["protocol"],
                    "card": metadata["card"],
                    "resource": metadata["resource"],
                    "streams": metadata["streams"],
                    "actions": metadata["actions"],
                    "args_preview": metadata["args_preview"],
                    "result_preview": metadata["result_preview"],
                })
                if metadata.get("resource"):
                    await part_queue.put({
                        "type": "tool-resource",
                        "version": metadata["version"],
                        "conversation_id": conversation_id,
                        "message_id": assistant_message_id,
                        "toolName": tool_name,
                        "callId": call_id,
                        "card_id": metadata["card"]["id"],
                        "protocol": metadata["protocol"],
                        "resource": metadata["resource"],
                        "actions": metadata["actions"],
                    })
                if metadata.get("actions") and metadata["card"].get("status") in {"failed", "action_required"}:
                    await part_queue.put({
                        "type": "tool-action-required",
                        "version": metadata["version"],
                        "conversation_id": conversation_id,
                        "message_id": assistant_message_id,
                        "toolName": tool_name,
                        "callId": call_id,
                        "card_id": metadata["card"]["id"],
                        "protocol": metadata["protocol"],
                        "reason": metadata.get("reason") or "tool_failed",
                        "resource": metadata["resource"],
                        "actions": metadata["actions"],
                    })
                # Persist tool message
                content_str = json.dumps(safe_result, default=str) if not isinstance(safe_result, str) else safe_result
                insert_message(conversation_id, "tool", content_str, tool_call_id=call_id)

        flushed_text = stream_text_sanitizer.flush()
        if flushed_text:
            assistant_text_parts.append(flushed_text)
            await part_queue.put({
                "type": "text",
                "version": CHAT_EVENT_VERSION,
                "conversation_id": conversation_id,
                "message_id": assistant_message_id,
                "text": flushed_text,
            })

        # Persist full assistant reply
        full_reply = "".join(assistant_text_parts).strip()
        if not full_reply and "reply" in final_reply_box:
            full_reply = final_reply_box["reply"]
        full_reply = _sanitize_preview_text(full_reply)
        full_reply = _ensure_bare_greeting_identity(message, full_reply)
        if full_reply:
            final_message_id = insert_message(conversation_id, "assistant", full_reply)

        # Evict if needed
        _maybe_evict_conversation(conversation_id, user_id)

        await part_queue.put({
            "type": "finish",
            "version": CHAT_EVENT_VERSION,
            "conversation_id": conversation_id,
            "message_id": final_message_id,
            "assistant_message_id": assistant_message_id,
            "cards": list(card_summaries.values()),
        })

        # #844: distill durable facts into the owner's memory brain pack.
        # Best-effort background task; rate-limited per conversation inside.
        try:
            from conversation_memory import memory_enabled, persist_conversation_memory

            if memory_enabled():
                asyncio.create_task(persist_conversation_memory(conversation_id, user_id))
        except Exception:
            logger.debug("memory task scheduling failed (non-fatal)", exc_info=True)

    except Exception as exc:
        logger.exception("stream_chat failed for conversation %s", conversation_id)
        # #951/#870: full detail is in the log above; the client gets a safe
        # message (degraded-mode wording + ops alert on provider quota/auth).
        from llm import safe_llm_error_message

        await part_queue.put({
            "type": "error",
            "version": CHAT_EVENT_VERSION,
            "error": safe_llm_error_message(exc, action="Chat"),
            "conversation_id": conversation_id,
            "message_id": assistant_message_id,
        })
        await part_queue.put({
            "type": "finish",
            "version": CHAT_EVENT_VERSION,
            "conversation_id": conversation_id,
            "message_id": None,
            "assistant_message_id": assistant_message_id,
            "cards": list(card_summaries.values()) if "card_summaries" in locals() else [],
        })
    finally:
        # Tear down MCP servers (best-effort) before releasing the OpenAI client.
        _current_chat_conversation_id.reset(conversation_token)
        if mcp_servers:
            await agent_capabilities.cleanup_mcp_servers(mcp_servers, _cap_log)
        # Release the per-stream OpenAI + httpx client on this loop.
        await loop_local_provider.aclose()
