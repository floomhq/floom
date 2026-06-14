"""Conversation persistence: create/list conversations, messages, and tool cards.

DB-backed CRUD for the chat conversation tables (conversations,
conversation_messages, conversation_tool_cards), plus history windowing and
tool-result truncation. Extracted verbatim from chat_service.py; depends only on
db + the sanitize helper, never on chat_service, so chat_service re-imports these
names for backward compatibility.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any, Dict, List, Optional

from db import get_db, now_iso

from services.chat_sanitize import _safe_json_dumps

TOOL_RESULT_MAX_BYTES = 2048
CONVERSATION_WINDOW = 50       # LLM context window; stored rows are permanent
CONVERSATION_KEEP_VERBATIM = 20  # retained for legacy summary compatibility


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
