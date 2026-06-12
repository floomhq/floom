"""#844 — Emily persists conversation memory to a private brain pack.

Acceptance pinned here:
  - after a chat, a `memory` pack exists for the user with index.md + dated file
  - the pack is owner-scoped (private by default) and writeable
  - future system prompts include the memory section
  - memory write failures never raise (best-effort)
  - rate limit: at most one write per conversation per interval
  - secret-bearing lines are redacted before write

Run: cd apps/api && python -m pytest tests/test_844_conversation_memory.py -q
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import conversation_memory


@pytest.fixture
def memory_env(monkeypatch, tmp_path):
    contexts_root = tmp_path / "contexts"
    contexts_root.mkdir()
    import contexts as contexts_module

    monkeypatch.setitem(
        conversation_memory.context_dir.__globals__, "CONTEXTS_DIR", contexts_root
    )
    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root, raising=False)
    monkeypatch.setenv("WORKEROS_MEMORY_ENABLED", "1")
    monkeypatch.setenv("WORKEROS_MEMORY_WRITE_INTERVAL", "1800")
    conversation_memory._last_write_monotonic.clear()
    return contexts_root


def _fake_summary(monkeypatch, entry="- prefers tables over prose", index="## Preferences\n- prefers tables over prose"):
    monkeypatch.setattr(
        conversation_memory, "_summarize", lambda existing, transcript: {"entry": entry, "index": index}
    )


def _fake_transcript(monkeypatch, text="user: remember I prefer tables\nassistant: noted"):
    monkeypatch.setattr(conversation_memory, "_conversation_transcript", lambda cid: text)


def test_persist_creates_private_writeable_pack(memory_env, monkeypatch):
    _fake_transcript(monkeypatch)
    _fake_summary(monkeypatch)
    wrote = asyncio.run(conversation_memory.persist_conversation_memory("conv_1", "federico"))
    assert wrote is True

    pack = memory_env / "memory"
    assert (pack / "index.md").read_text(encoding="utf-8").startswith("## Preferences")
    dated = [p for p in pack.glob("*.md") if p.name != "index.md"]
    assert len(dated) == 1
    assert "- prefers tables over prose" in dated[0].read_text(encoding="utf-8")

    from contexts import load_context_metadata

    meta = load_context_metadata()["memory"]
    assert meta["owner_id"] == "federico"   # owner-scoped == private by default
    assert meta["writeable"] is True


def test_rate_limit_one_write_per_conversation_interval(memory_env, monkeypatch):
    _fake_transcript(monkeypatch)
    _fake_summary(monkeypatch)
    assert asyncio.run(conversation_memory.persist_conversation_memory("conv_rl", "federico")) is True
    assert asyncio.run(conversation_memory.persist_conversation_memory("conv_rl", "federico")) is False
    # a different conversation still writes
    assert asyncio.run(conversation_memory.persist_conversation_memory("conv_rl2", "federico")) is True


def test_nothing_durable_writes_nothing(memory_env, monkeypatch):
    _fake_transcript(monkeypatch)
    monkeypatch.setattr(conversation_memory, "_summarize", lambda e, t: None)
    assert asyncio.run(conversation_memory.persist_conversation_memory("conv_nd", "federico")) is False
    assert not (memory_env / "memory").exists()


def test_summarizer_failure_never_raises(memory_env, monkeypatch):
    _fake_transcript(monkeypatch)

    def _boom(existing, transcript):
        raise RuntimeError("Error code: 429 - insufficient_quota")

    monkeypatch.setattr(conversation_memory, "_summarize", _boom)
    assert asyncio.run(conversation_memory.persist_conversation_memory("conv_f", "federico")) is False


def test_secret_lines_are_redacted(memory_env, monkeypatch):
    _fake_transcript(monkeypatch)
    leaked = "- aws key is AKIAIOSFODNN7EXAMPLE"
    _fake_summary(monkeypatch, entry=leaked, index=f"## Facts\n{leaked}")
    assert asyncio.run(conversation_memory.persist_conversation_memory("conv_s", "federico")) is True
    index = (memory_env / "memory" / "index.md").read_text(encoding="utf-8")
    assert "AKIAIOSFODNN7EXAMPLE" not in index
    assert "[redacted" in index


def test_memory_prompt_section_round_trip(memory_env, monkeypatch):
    _fake_transcript(monkeypatch)
    _fake_summary(monkeypatch)
    asyncio.run(conversation_memory.persist_conversation_memory("conv_p", "federico"))
    section = conversation_memory.memory_prompt_section("federico")
    assert "## User memory" in section
    assert "prefers tables over prose" in section


def test_memory_is_owner_scoped_when_user_scoping_enabled(memory_env, monkeypatch):
    # multi-user isolation: with header scoping on (cloud/multi-user), each
    # owner's memory lives under their scope dir and other users see nothing
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    _fake_transcript(monkeypatch)
    _fake_summary(monkeypatch)
    asyncio.run(conversation_memory.persist_conversation_memory("conv_iso", "user-a"))
    assert "prefers tables over prose" in conversation_memory.memory_prompt_section("user-a")
    assert conversation_memory.memory_prompt_section("user-b") == ""


def test_disabled_via_env(memory_env, monkeypatch):
    monkeypatch.setenv("WORKEROS_MEMORY_ENABLED", "0")
    _fake_transcript(monkeypatch)
    _fake_summary(monkeypatch)
    assert asyncio.run(conversation_memory.persist_conversation_memory("conv_d", "federico")) is False
    assert conversation_memory.memory_prompt_section("federico") == ""


def test_system_prompt_includes_memory_section(memory_env, monkeypatch):
    _fake_transcript(monkeypatch)
    _fake_summary(monkeypatch)
    asyncio.run(conversation_memory.persist_conversation_memory("conv_sp", "federico"))

    import chat_service

    monkeypatch.setattr(chat_service, "get_workspace_md", lambda: "")
    monkeypatch.setattr(chat_service, "_build_workspace_preamble", lambda uid: "## Workspace snapshot\n(stub)")
    monkeypatch.setattr(
        chat_service,
        "_build_capabilities_snapshot",
        lambda uid: "## What you can do here (capabilities snapshot)\n(stub)",
    )
    prompt = chat_service.build_system_prompt_for_source("federico", "web", message="hi")
    assert "## User memory" in prompt
    assert "prefers tables over prose" in prompt


def test_stream_chat_fires_memory_persist_task():
    """Guards the write-hook wiring: reverting the stream_chat hook must fail
    this test even though persist_conversation_memory itself still works."""
    import inspect

    import chat_service

    src = inspect.getsource(chat_service.stream_chat)
    assert "persist_conversation_memory" in src, (
        "stream_chat no longer schedules the memory persist task (#844)"
    )
    assert "memory_enabled" in src, "memory kill switch check missing from stream_chat"
