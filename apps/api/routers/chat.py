"""Workspace-agent chat + conversation history routes.

The Emily workspace agent surface: streaming ``POST /chat`` (Server-Sent Events of
AI-SDK parts), chat file attachments, and conversation listing/detail/export.
Extracted verbatim from main.py into an APIRouter. Heavy logic lives in
chat_service (imported lazily inside the handlers, per the channels/* convention).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from typing import Literal

from auth import AuthContext, get_auth_context
from core.config import DEFAULT_CHAT_MESSAGE_MAX_CHARS
from core.utils import _positive_int_env
from services.quota import _enforce_chat_quota

logger = logging.getLogger("floom.api")

chat_router = APIRouter()


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str
    conversation_id: Optional[str] = None
    source: Literal["web", "slack", "mcp", "whatsapp", "cli"] = "web"


class ConversationSummary(BaseModel):
    id: str
    title: Optional[str] = None
    created_at: str
    updated_at: str
    message_count: int


class ConversationDetail(BaseModel):
    id: str
    title: Optional[str] = None
    created_at: str
    updated_at: str
    messages: List[Dict[str, Any]]


class _ChatAttachmentOut(BaseModel):
    name: str
    size: int
    type: str
    text: Optional[str] = None
    truncated: bool = False


_CHAT_ATTACHMENT_TEXT_EXTS = (
    ".txt", ".md", ".markdown", ".csv", ".json", ".yml", ".yaml", ".log",
    ".py", ".js", ".ts", ".tsx", ".html", ".xml", ".toml", ".ini", ".sql",
)


def _chat_message_max_chars() -> int:
    return _positive_int_env("WORKEROS_CHAT_MESSAGE_MAX_CHARS", DEFAULT_CHAT_MESSAGE_MAX_CHARS)


@chat_router.post("/chat/attachments", response_model=List[_ChatAttachmentOut])
async def upload_chat_attachments(
    files: List[UploadFile] = File(...),
    auth: AuthContext = Depends(get_auth_context),
) -> List[_ChatAttachmentOut]:
    """#778: accept Emily chat attachments.

    Text-like files are decoded so their content rides along in the next
    message. Images and arbitrary binaries are rejected until Emily has a real
    multimodal LLM path; returning metadata-only made uploads look successful
    while silently dropping the content.
    """
    max_text = 200_000  # chars of extracted text per file
    out: List[_ChatAttachmentOut] = []
    for f in files:
        data = await f.read()
        name = f.filename or "attachment"
        ctype = (f.content_type or "").lower()
        text: Optional[str] = None
        truncated = False
        is_text = ctype.startswith("text/") or name.lower().endswith(_CHAT_ATTACHMENT_TEXT_EXTS)
        if not is_text:
            raise HTTPException(
                status_code=415,
                detail=(
                    "Emily chat attachments currently support text files only; "
                    "image and binary attachments are not sent to the model yet."
                ),
            )
        decoded = data.decode("utf-8", errors="replace")
        if len(decoded) > max_text:
            decoded = decoded[:max_text]
            truncated = True
        text = decoded
        out.append(_ChatAttachmentOut(
            name=name, size=len(data),
            type=ctype or "application/octet-stream",
            text=text, truncated=truncated,
        ))
    return out


@chat_router.post("/chat")
async def post_chat(
    payload: ChatRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> StreamingResponse:
    """Stream a workspace agent response as Server-Sent Events.

    Each SSE event is a JSON-encoded AI SDK part:
      {"type": "text", "text": "..."}
      {"type": "tool-call", "toolName": "...", "args": {...}, "callId": "..."}
      {"type": "tool-result", "callId": "...", "result": {...}}
      {"type": "finish", "conversation_id": "...", "message_id": "..."}
    """
    import asyncio
    from chat_service import stream_chat

    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    max_chars = _chat_message_max_chars()
    if len(message) > max_chars:
        raise HTTPException(
            status_code=413,
            detail=f"message exceeds {max_chars} character limit",
        )
    # /chat calls OpenAI per request; enforce a per-user quota so a single
    # caller cannot run up an unbounded LLM bill (the shared IP limiter is too
    # loose for a paid-LLM path).
    _enforce_chat_quota(auth, message=message)

    part_queue: asyncio.Queue = asyncio.Queue(maxsize=1024)
    loop = asyncio.get_running_loop()

    async def _run_in_thread():
        """Execute the agent in a thread (agent driver is sync-bridged)."""
        try:
            await stream_chat(
                message=message,
                user_id=auth.user_id,
                conversation_id=payload.conversation_id,
                part_queue=part_queue,
                source="web",
            )
        except Exception as exc:
            logger.exception("chat background task failed")
            try:
                from llm import safe_llm_error_message

                await part_queue.put({"type": "error", "error": safe_llm_error_message(exc, action="Chat")})
                await part_queue.put({"type": "finish", "conversation_id": None, "message_id": None})
            except Exception:
                pass

    task = loop.create_task(_run_in_thread())

    async def event_generator():
        while True:
            if await request.is_disconnected():
                task.cancel()
                break
            try:
                part = await asyncio.wait_for(part_queue.get(), timeout=5.0)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(part, default=str)}\n\n"
            if part.get("type") == "finish":
                break

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@chat_router.get("/conversations", response_model=List[ConversationSummary])
async def list_conversations(
    auth: AuthContext = Depends(get_auth_context),
    limit: int = Query(default=50, ge=1, le=200),
) -> List[Dict[str, Any]]:
    """List conversations for the authenticated user."""
    from chat_service import list_conversations as _list
    return _list(auth.user_id, limit=limit)


@chat_router.get("/conversations/{conversation_id}")
async def get_conversation_detail(
    conversation_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    """Get a conversation with its messages."""
    from chat_service import get_conversation, list_conversation_messages, list_conversation_tool_cards
    conv = get_conversation(conversation_id, auth.user_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    messages = list_conversation_messages(conversation_id, auth.user_id)
    tool_cards = list_conversation_tool_cards(conversation_id, auth.user_id)
    return {**conv, "messages": messages, "tool_cards": tool_cards}


@chat_router.get("/conversations/{conversation_id}/export")
async def export_conversation(
    conversation_id: str,
    format: str = "md",
    auth: AuthContext = Depends(get_auth_context),
) -> Response:
    """#776: download a conversation transcript as a markdown attachment.

    The Emily header 'Export chat' button had no backend; GET /conversations/
    {id} returns JSON but is not a download. This renders the message turns as
    markdown with a Content-Disposition attachment header.
    """
    if format != "md":
        raise HTTPException(status_code=422, detail="only format=md is supported")
    from chat_service import get_conversation, list_conversation_messages
    conv = get_conversation(conversation_id, auth.user_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    messages = list_conversation_messages(conversation_id, auth.user_id)

    title = str(conv.get("title") or "Conversation")
    lines = [f"# {title}", ""]
    role_label = {"user": "You", "assistant": "Emily"}
    for msg in messages:
        role = str(msg.get("role") or "")
        if role == "tool":
            continue  # tool results are represented by their cards, not transcript prose
        content = str(msg.get("content") or "").strip()
        if not content:
            continue
        who = role_label.get(role, role.capitalize() or "Unknown")
        ts = str(msg.get("created_at") or "")
        header = f"## {who}" + (f" — {ts}" if ts else "")
        lines.extend([header, "", content, ""])
    body = "\n".join(lines).rstrip() + "\n"

    safe_id = re.sub(r"[^A-Za-z0-9_-]+", "-", conversation_id)[:60] or "conversation"
    return Response(
        content=body,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="chat-{safe_id}.md"'},
    )
