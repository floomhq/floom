"""#844 — Emily's durable conversation memory, persisted as a brain pack.

After a chat turn completes, a background task distills the conversation into
the owner's private ``memory`` context pack:

    contexts/<owner-scope>/memory/
    ├── index.md        # merged, de-duplicated durable facts
    └── YYYY-MM-DD.md   # append-only dated learnings

Future chats read ``index.md`` back into the system prompt ("User memory"
section). The brain is the store (not the DB) because packs are already
versioned, file-oriented, owner-scoped, LLM-readable, and user-inspectable
via the Contexts UI — deleting the pack deletes the memory.

Failure policy: memory is best-effort. Nothing here may ever raise into the
chat stream; every public function catches and logs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from contexts import (
    context_dir,
    context_scope_for_user,
    load_context_metadata,
    set_context_metadata,
    use_context_scope,
)

logger = logging.getLogger("workeros.memory")

MEMORY_PACK_NAME = "memory"
INDEX_FILENAME = "index.md"

# Cap what we re-inject into the system prompt; the index is merged/condensed
# by the summarizer so this is a guard rail, not the primary size control.
MEMORY_PROMPT_MAX_CHARS = 4_000
# Most recent turns considered when distilling (user/assistant only).
TRANSCRIPT_MAX_MESSAGES = 30
TRANSCRIPT_MAX_CHARS = 12_000

_DEFAULT_WRITE_INTERVAL_SECONDS = 1_800
_last_write_monotonic: Dict[str, float] = {}  # conversation_id -> monotonic ts


def memory_enabled() -> bool:
    return (os.environ.get("WORKEROS_MEMORY_ENABLED") or "1").strip().lower() not in {
        "0", "false", "no", "off",
    }


def _write_interval_seconds() -> float:
    try:
        return float(os.environ.get("WORKEROS_MEMORY_WRITE_INTERVAL") or _DEFAULT_WRITE_INTERVAL_SECONDS)
    except ValueError:
        return float(_DEFAULT_WRITE_INTERVAL_SECONDS)


def read_memory_index(user_id: str) -> str:
    """The owner's memory index, or "" when none exists. Never raises."""
    try:
        with use_context_scope(context_scope_for_user(user_id)):
            path = context_dir(MEMORY_PACK_NAME) / INDEX_FILENAME
            if path.is_file():
                return path.read_text(encoding="utf-8", errors="replace").strip()
    except Exception:
        logger.debug("memory index read failed for %s", user_id, exc_info=True)
    return ""


def memory_prompt_section(user_id: str) -> str:
    """System-prompt block with the user's durable memory, or ""."""
    if not memory_enabled():
        return ""
    index = read_memory_index(user_id)
    if not index:
        return ""
    if len(index) > MEMORY_PROMPT_MAX_CHARS:
        index = index[:MEMORY_PROMPT_MAX_CHARS] + "\n…(memory truncated)"
    return (
        "## User memory (durable facts from past conversations)\n"
        "Use this to stay consistent with known preferences and decisions. "
        "It may be stale; live tool results win on conflict.\n\n"
        f"{index}"
    )


def _conversation_transcript(conversation_id: str) -> str:
    from chat_service import load_conversation_history  # lazy: avoids import cycle

    messages = load_conversation_history(conversation_id)
    lines: List[str] = []
    for msg in messages[-TRANSCRIPT_MAX_MESSAGES:]:
        role = str(msg.get("role") or "")
        if role not in {"user", "assistant"}:
            continue
        content = str(msg.get("content") or "").strip()
        if content:
            lines.append(f"{role}: {content}")
    return "\n".join(lines)[-TRANSCRIPT_MAX_CHARS:]


_SUMMARY_SYSTEM_PROMPT = (
    "You maintain a long-term memory file for a personal AI COO. "
    "Given the existing memory index and a conversation transcript, extract only "
    "DURABLE facts worth remembering across future conversations: stable user "
    "preferences, decisions made, recurring topics, ongoing projects, key people "
    "or systems. Never store secrets, credentials, tokens, or one-off chit-chat. "
    "Return JSON: {\"entry\": \"<markdown bullets of NEW learnings from this "
    "conversation, or empty string if nothing durable>\", \"index\": \"<the full "
    "merged index markdown: existing index with new facts folded in, de-duplicated, "
    "condensed, max ~300 words>\"}."
)


def _summarize(existing_index: str, transcript: str) -> Optional[Dict[str, str]]:
    import llm

    model = os.environ.get("WORKEROS_CHAT_MODEL") or "gpt-5.4-mini"
    response = llm.completion(
        model=model,
        messages=[
            {"role": "system", "content": _SUMMARY_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"# Existing memory index\n{existing_index or '(empty)'}\n\n"
                    f"# Conversation transcript\n{transcript}"
                ),
            },
        ],
        max_tokens=1_200,
        response_format={"type": "json_object"},
    )
    raw = (response.choices[0].message.content or "").strip()
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        return None
    entry = str(parsed.get("entry") or "").strip()
    index = str(parsed.get("index") or "").strip()
    if not entry:
        return None
    return {"entry": entry, "index": index or existing_index}


def _redact_secrets(text: str) -> str:
    """Replace any line carrying a detected credential (defense in depth)."""
    try:
        from secret_scan import scan_text

        findings = scan_text(text)
    except Exception:
        return text
    if not findings:
        return text
    flagged = {f.line for f in findings}
    lines = text.splitlines()
    return "\n".join(
        "[redacted: possible credential]" if (i + 1) in flagged else line
        for i, line in enumerate(lines)
    )


def _write_memory_files(user_id: str, entry: str, index: str) -> None:
    with use_context_scope(context_scope_for_user(user_id)):
        pack_dir = context_dir(MEMORY_PACK_NAME)
        is_new = not pack_dir.is_dir()
        pack_dir.mkdir(parents=True, exist_ok=True)
        if is_new or not _pack_has_owner(user_id):
            # private by default: owner-scoped pack, never shared unless the
            # user explicitly changes visibility in the Contexts UI
            set_context_metadata(
                MEMORY_PACK_NAME,
                writeable=True,
                owner_id=user_id,
                sensitive=False,
                category="memory",
            )
        day_file = pack_dir / f"{datetime.now(timezone.utc).date().isoformat()}.md"
        stamp = datetime.now(timezone.utc).strftime("%H:%M UTC")
        with day_file.open("a", encoding="utf-8") as fh:
            fh.write(f"\n## {stamp}\n\n{entry}\n")
        (pack_dir / INDEX_FILENAME).write_text(index.rstrip() + "\n", encoding="utf-8")


def _pack_has_owner(user_id: str) -> bool:
    try:
        meta = load_context_metadata().get(MEMORY_PACK_NAME) or {}
        return bool(str(meta.get("owner_id") or "").strip())
    except Exception:
        return False


async def persist_conversation_memory(conversation_id: str, user_id: str) -> bool:
    """Distill + persist the conversation's durable facts. Fire-and-forget safe.

    Returns True when memory was written. Rate-limited per conversation
    (default one write per 30 min; WORKEROS_MEMORY_WRITE_INTERVAL overrides)
    so multi-turn chats don't write on every message.
    """
    if not memory_enabled():
        return False
    try:
        now = time.monotonic()
        last = _last_write_monotonic.get(conversation_id)
        if last is not None and (now - last) < _write_interval_seconds():
            return False
        _last_write_monotonic[conversation_id] = now

        transcript = await asyncio.to_thread(_conversation_transcript, conversation_id)
        if not transcript.strip():
            return False
        existing_index = await asyncio.to_thread(read_memory_index, user_id)
        summary = await asyncio.to_thread(_summarize, existing_index, transcript)
        if not summary:
            return False
        entry = _redact_secrets(summary["entry"])
        index = _redact_secrets(summary["index"])
        await asyncio.to_thread(_write_memory_files, user_id, entry, index)
        logger.info("memory: wrote conversation learnings for %s (%s)", user_id, conversation_id)
        return True
    except Exception:
        # memory must never surface an error into chat — log and move on
        logger.warning(
            "memory write failed for conversation %s (non-fatal)", conversation_id, exc_info=True
        )
        return False
