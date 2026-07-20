"""Regression tests for #2266 and #2269 — workspace.chat over MCP.

#2269 (conversation isolation/continuity):
  - A call WITHOUT conversation_id must start a fresh conversation. The old
    behavior funneled every no-id call into one shared "langdock:default"
    thread, silently appending unrelated sessions into the same conversation.
  - A call WITH a real conv_... id (from conversations.list or a previous
    reply) must resume THAT conversation with its history visible to the
    model. The old behavior prefixed+hashed the id and silently forked a
    brand-new empty conversation.
  - An unknown conv_... id must produce a clear tool error, never a silent
    fork.

#2266 (false failure):
  - A chat whose agent run completes must return its reply even when a
    post-run/side-effect step (eviction bookkeeping, provider client close)
    throws; those are logged, not surfaced as MCP -32603.
  - A genuine pre-completion failure must surface an actionable message, not
    a bare "Internal server error".
"""

import asyncio
import importlib
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from fastapi.testclient import TestClient


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "mcp-test-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKSPACE_AGENT_MCP_TOKEN", "test-langdock-token")
    # workspace.chat is outside the lean default tool set; cloud (where #2266/
    # #2269 were hit) serves the full registry.
    monkeypatch.setenv("WORKEROS_MCP_FULL_TOOLS", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-workspace-chat")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)

    sys.path.insert(0, str(api_dir))
    for name in list(sys.modules):
        if any(name == m or name.startswith(m + ".") for m in [
            "main", "db", "models", "worker_registry", "runner_utils",
            "run_service", "chat_service", "auth", "contexts", "git_ops",
        ]):
            sys.modules.pop(name, None)
        for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
            sys.modules.pop(_rn, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _auth_headers(token: str = "test-langdock-token"):
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _rpc(method, request_id=1, params=None):
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        payload["params"] = params
    return payload


def _chat_call(client, message, conversation_id=None, request_id=1):
    arguments = {"message": message}
    if conversation_id is not None:
        arguments["conversation_id"] = conversation_id
    return client.post(
        "/api/mcp",
        data=json.dumps(_rpc(
            "tools/call",
            request_id=request_id,
            params={"name": "workspace.chat", "arguments": arguments},
        )),
        headers=_auth_headers(),
    )


class _FakeAgentRuntime:
    """Patch the Agents SDK boundary so stream_chat runs for real (DB included)
    while the model itself is a canned text reply."""

    def __init__(self, monkeypatch, reply_text="Hello from Emily.", raise_before_text=None):
        self.captured_inputs = []
        self.reply_text = reply_text
        self.raise_before_text = raise_before_text
        chat_service = importlib.import_module("chat_service")
        monkeypatch.setattr(chat_service, "_workspace_tools", lambda *a, **k: [])
        monkeypatch.setattr(chat_service, "_brain_read_tools", lambda *a, **k: [])
        monkeypatch.setattr(chat_service, "_composio_read_tools", lambda *a, **k: [])

        from runner_sandbox import agent_capabilities

        async def _no_mcp(*a, **k):
            return []

        monkeypatch.setattr(agent_capabilities, "connect_mcp_servers", _no_mcp)
        monkeypatch.setattr(agent_capabilities, "cleanup_mcp_servers", _no_mcp)

        import runner_sandbox.stream_adapter as stream_adapter
        monkeypatch.setattr(stream_adapter, "decode_stream_event", lambda event: event)

        outer = self

        class _FakeResult:
            async def stream_events(self):
                if outer.raise_before_text is not None:
                    raise outer.raise_before_text
                yield SimpleNamespace(kind="text_delta", text=outer.reply_text)

        def _fake_run_streamed(agent, *args, **kwargs):
            outer.captured_inputs.append(kwargs.get("input"))
            return _FakeResult()

        import agents
        monkeypatch.setattr(agents.Runner, "run_streamed", staticmethod(_fake_run_streamed))


def _conversations_in_db(main):
    db = importlib.import_module("db")
    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT id, user_id FROM conversations ORDER BY created_at ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def _messages_for(main, conv_id):
    db = importlib.import_module("db")
    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT role, content FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conv_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def _tool_result(response):
    body = response.json()
    assert "error" not in body, f"expected tool result, got JSON-RPC error: {body}"
    return body["result"]


def _workspace_chat_result(main, arguments, user_id="mcp-test-user", timeout=1.0):
    async def _call():
        return await main._mcp_workspace_chat_result(arguments, user_id)

    return asyncio.run(asyncio.wait_for(_call(), timeout=timeout))


# ---------------------------------------------------------------------------
# #2269 — conversation isolation and continuity
# ---------------------------------------------------------------------------

def test_mcp_conversation_id_mapping_unit(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    # No id -> fresh conversation (None), never a shared default thread.
    assert main._workspace_agent_mcp_conversation_id(None) is None
    assert main._workspace_agent_mcp_conversation_id("") is None
    assert main._workspace_agent_mcp_conversation_id("   ") is None
    # Internal ids pass through so the exact conversation is resumed.
    assert main._workspace_agent_mcp_conversation_id("conv_abc123") == "conv_abc123"
    # Client thread ids keep the legacy deterministic mapping.
    assert main._workspace_agent_mcp_conversation_id("chat 123") == "langdock:chat_123"


def test_workspace_chat_no_id_creates_distinct_conversations(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    _FakeAgentRuntime(monkeypatch)

    with TestClient(main.app) as client:
        first = _chat_call(client, "first no-id message", request_id="c1")
        second = _chat_call(client, "second no-id message", request_id="c2")

    result_a = _tool_result(first)
    result_b = _tool_result(second)
    assert result_a["isError"] is False, result_a
    assert result_b["isError"] is False, result_b

    conv_a = result_a["structuredContent"]["conversation_id"]
    conv_b = result_b["structuredContent"]["conversation_id"]
    assert conv_a and conv_b
    assert conv_a != conv_b, "no-id messages must not share a conversation (#2269)"

    conversations = _conversations_in_db(main)
    assert len(conversations) == 2, conversations

    messages_a = _messages_for(main, conv_a)
    assert len(messages_a) == 2  # user + assistant only; no bleed from call two
    assert "first no-id message" in messages_a[0]["content"]
    assert "second no-id message" not in json.dumps(messages_a)


def test_workspace_chat_resumes_existing_conversation_by_id(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    runtime = _FakeAgentRuntime(monkeypatch)
    chat_service = importlib.import_module("chat_service")

    user_id = main._workspace_agent_mcp_auth_context().user_id
    conv_id = chat_service.create_conversation(user_id, title="Seeded thread")
    chat_service.insert_message(conv_id, "user", "The launch codeword is zebra-glacier.")
    chat_service.insert_message(conv_id, "assistant", "Noted the codeword.")

    with TestClient(main.app) as client:
        response = _chat_call(client, "What codeword did I give you?", conversation_id=conv_id)

    result = _tool_result(response)
    assert result["isError"] is False, result
    assert result["structuredContent"]["conversation_id"] == conv_id

    conversations = _conversations_in_db(main)
    assert len(conversations) == 1, f"resume must not fork a new conversation: {conversations}"

    messages = _messages_for(main, conv_id)
    # 2 seeded + 1 new user + 1 assistant reply -> message_count incremented.
    assert len(messages) == 4, messages
    roles = [m["role"] for m in messages]
    assert roles == ["user", "assistant", "user", "assistant"]

    # The model must see the prior history of THAT conversation.
    assert runtime.captured_inputs, "agent was never invoked"
    model_input = json.dumps(runtime.captured_inputs[0])
    assert "zebra-glacier" in model_input, "conversation history was not loaded for the model"


def test_workspace_chat_unknown_conversation_id_errors_without_forking(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    _FakeAgentRuntime(monkeypatch)

    with TestClient(main.app) as client:
        response = _chat_call(client, "resume please", conversation_id="conv_doesnotexist123")

    result = _tool_result(response)
    assert result["isError"] is True, result
    text = result["content"][0]["text"]
    assert "not found" in text.lower(), text
    assert _conversations_in_db(main) == [], "unknown id must not silently create a conversation"


def test_workspace_chat_foreign_conversation_errors_without_forking_or_leaking(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")
    foreign_id = chat_service.create_conversation(
        "other-workspace-user",
        title="Foreign private thread",
    )
    chat_service.insert_message(foreign_id, "user", "secret launch phrase: violet-otter")
    conversations_before = _conversations_in_db(main)
    messages_before = _messages_for(main, foreign_id)

    result = _workspace_chat_result(
        main,
        {"message": "resume that thread", "conversation_id": foreign_id},
    )

    assert result["isError"] is True, result
    text = result["content"][0]["text"]
    assert "not found in this workspace" in text.lower(), text
    assert "violet-otter" not in text, text
    assert _conversations_in_db(main) == conversations_before
    assert _messages_for(main, foreign_id) == messages_before


def test_workspace_chat_serve_endpoint_roundtrip(monkeypatch, tmp_path):
    """Same guarantees on the /mcp-tools/serve dispatcher."""
    main = _load_api(monkeypatch, tmp_path)
    _FakeAgentRuntime(monkeypatch)
    headers = {"x-floom-secret": "test-api-secret", "Content-Type": "application/json"}

    def _serve_chat(client, message, conversation_id=None, request_id=1):
        arguments = {"message": message}
        if conversation_id is not None:
            arguments["conversation_id"] = conversation_id
        return client.post(
            "/mcp-tools/serve",
            data=json.dumps(_rpc(
                "tools/call",
                request_id=request_id,
                params={"name": "workspace.chat", "arguments": arguments},
            )),
            headers=headers,
        )

    with TestClient(main.app) as client:
        first = _serve_chat(client, "serve message one", request_id="s1")
        conv_id = _tool_result(first)["structuredContent"]["conversation_id"]
        assert conv_id
        resumed = _serve_chat(client, "serve message two", conversation_id=conv_id, request_id="s2")
        fresh = _serve_chat(client, "serve message three", request_id="s3")

    resumed_result = _tool_result(resumed)
    assert resumed_result["isError"] is False, resumed_result
    assert resumed_result["structuredContent"]["conversation_id"] == conv_id

    fresh_conv = _tool_result(fresh)["structuredContent"]["conversation_id"]
    assert fresh_conv != conv_id, "a no-id serve call must start its own conversation"

    messages = _messages_for(main, conv_id)
    contents = json.dumps(messages)
    assert "serve message one" in contents
    assert "serve message two" in contents
    assert "serve message three" not in contents


# ---------------------------------------------------------------------------
# #2266 — completed runs must not be reported as failures
# ---------------------------------------------------------------------------

def test_workspace_chat_returns_reply_when_post_run_bookkeeping_fails(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    _FakeAgentRuntime(monkeypatch, reply_text="Run finished fine.")
    chat_service = importlib.import_module("chat_service")

    def _boom(*a, **k):
        raise RuntimeError("post-run bookkeeping exploded")

    monkeypatch.setattr(chat_service, "_maybe_evict_conversation", _boom)

    with TestClient(main.app) as client:
        response = _chat_call(client, "do the thing")

    result = _tool_result(response)
    assert result["isError"] is False, result
    assert "Run finished fine." in result["content"][0]["text"]
    # The reply was persisted despite the post-run failure.
    conv_id = result["structuredContent"]["conversation_id"]
    messages = _messages_for(main, conv_id)
    assert any(m["role"] == "assistant" and "Run finished fine." in m["content"] for m in messages)


def test_workspace_chat_returns_reply_when_post_finish_close_fails(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    _FakeAgentRuntime(monkeypatch, reply_text="Reply before teardown.")

    from runner_sandbox.loop_local_provider import LoopLocalModelProvider

    async def _boom_close(self):
        raise RuntimeError("client close exploded after finish")

    monkeypatch.setattr(LoopLocalModelProvider, "aclose", _boom_close)

    with TestClient(main.app) as client:
        response = _chat_call(client, "hello there")

    result = _tool_result(response)
    assert result["isError"] is False, result
    assert "Reply before teardown." in result["content"][0]["text"]


def test_workspace_chat_genuine_failure_surfaces_actionable_message(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    _FakeAgentRuntime(
        monkeypatch,
        raise_before_text=RuntimeError("Error code: 500 provider melted"),
    )

    with TestClient(main.app) as client:
        response = _chat_call(client, "this will fail")

    body = response.json()
    assert "error" not in body, f"genuine failures must be tool errors, not -32603: {body}"
    result = body["result"]
    assert result["isError"] is True, result
    text = result["content"][0]["text"]
    assert text.strip(), result
    assert "internal server error" not in text.lower(), text
    assert "internal error" not in text.lower(), text


def test_workspace_chat_pre_event_stream_failure_returns_actionable_tool_error(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")

    def _fail_before_any_queue_event(*args, **kwargs):
        raise RuntimeError("pre-event conversation resolution exploded")

    monkeypatch.setattr(chat_service, "resolve_conversation_id", _fail_before_any_queue_event)

    result = _workspace_chat_result(
        main,
        {"message": "this fails before the stream emits"},
    )

    assert result["isError"] is True, result
    text = result["content"][0]["text"]
    assert text.strip(), result
    assert "internal server error" not in text.lower(), text
    assert "internal error" not in text.lower(), text


def test_collect_agent_reply_details_retrieves_done_task_failure_after_error_part(
    monkeypatch, tmp_path, caplog
):
    _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")
    common = importlib.import_module("channels.common")

    async def _queue_error_then_raise(*, part_queue, **kwargs):
        await part_queue.put({"type": "error", "error": "queued workspace failure"})
        raise RuntimeError("distinct stream task failure")

    monkeypatch.setattr(chat_service, "stream_chat", _queue_error_then_raise)

    async def _collect():
        with pytest.raises(common.AgentReplyError, match="queued workspace failure"):
            await common.collect_agent_reply_details(
                message="hello",
                user_id="mcp-test-user",
                conversation_id=None,
                source="mcp",
            )
        await asyncio.sleep(0)

    asyncio.run(asyncio.wait_for(_collect(), timeout=1.0))
    failure_records = [
        record
        for record in caplog.records
        if record.exc_info
        and str(record.exc_info[1]) == "distinct stream task failure"
    ]
    assert len(failure_records) == 1


def test_collect_agent_reply_details_rejects_normal_return_without_finish(monkeypatch, tmp_path):
    _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")
    common = importlib.import_module("channels.common")

    async def _return_without_event(**kwargs):
        return None

    monkeypatch.setattr(chat_service, "stream_chat", _return_without_event)

    async def _collect():
        return await common.collect_agent_reply_details(
            message="hello",
            user_id="mcp-test-user",
            conversation_id=None,
            source="mcp",
        )

    with pytest.raises(common.AgentReplyError, match="before emitting a finish event"):
        asyncio.run(asyncio.wait_for(_collect(), timeout=1.0))


def test_collect_agent_reply_details_keeps_finish_when_task_then_raises(monkeypatch, tmp_path):
    _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")
    common = importlib.import_module("channels.common")

    async def _finish_then_fail(*, part_queue, **kwargs):
        await part_queue.put({"type": "text", "text": "completed reply"})
        await part_queue.put({
            "type": "finish",
            "conversation_id": "conv_finished",
            "message_id": "msg_finished",
        })
        raise RuntimeError("post-finish teardown exploded")

    monkeypatch.setattr(chat_service, "stream_chat", _finish_then_fail)

    async def _collect():
        return await common.collect_agent_reply_details(
            message="hello",
            user_id="mcp-test-user",
            conversation_id=None,
            source="mcp",
        )

    result = asyncio.run(asyncio.wait_for(_collect(), timeout=1.0))
    assert result == {
        "reply": "completed reply",
        "conversation_id": "conv_finished",
        "message_id": "msg_finished",
    }


def test_collect_agent_reply_details_returns_when_post_finish_teardown_hangs(
    monkeypatch, tmp_path, caplog
):
    _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")
    common = importlib.import_module("channels.common")
    teardown_cancelled = asyncio.Event()

    async def _finish_then_hang(*, part_queue, **kwargs):
        try:
            await part_queue.put({"type": "text", "text": "completed before teardown"})
            await part_queue.put({
                "type": "finish",
                "conversation_id": "conv_teardown_hang",
                "message_id": "msg_teardown_hang",
            })
            await asyncio.Event().wait()
        finally:
            teardown_cancelled.set()

    monkeypatch.setattr(chat_service, "stream_chat", _finish_then_hang)

    async def _collect():
        loop = asyncio.get_running_loop()
        started = loop.time()
        result = await asyncio.wait_for(
            common.collect_agent_reply_details(
                message="hello",
                user_id="mcp-test-user",
                conversation_id=None,
                source="mcp",
            ),
            timeout=7.0,
        )
        return result, loop.time() - started

    result, elapsed = asyncio.run(_collect())
    assert result == {
        "reply": "completed before teardown",
        "conversation_id": "conv_teardown_hang",
        "message_id": "msg_teardown_hang",
    }
    assert elapsed < 6.5, f"post-finish grace period did not bound teardown: {elapsed:.2f}s"
    assert teardown_cancelled.is_set(), "hung stream task was not cancelled"
    assert "reply already complete" in caplog.text
    assert "teardown was still pending" in caplog.text


def test_collect_agent_reply_details_logs_failure_raised_during_cancellation(
    monkeypatch, tmp_path, caplog
):
    _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")
    common = importlib.import_module("channels.common")
    monkeypatch.setattr(common, "_POST_FINISH_TEARDOWN_GRACE_SECONDS", 0.01)

    async def _finish_then_fail_when_cancelled(*, part_queue, **kwargs):
        try:
            await part_queue.put({"type": "text", "text": "completed before cancellation"})
            await part_queue.put({
                "type": "finish",
                "conversation_id": "conv_cancel_failure",
                "message_id": "msg_cancel_failure",
            })
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            raise RuntimeError("teardown blew up")

    monkeypatch.setattr(chat_service, "stream_chat", _finish_then_fail_when_cancelled)

    async def _collect():
        result = await asyncio.wait_for(
            common.collect_agent_reply_details(
                message="hello",
                user_id="mcp-test-user",
                conversation_id=None,
                source="mcp",
            ),
            timeout=1.0,
        )
        for _ in range(10):
            if "teardown blew up" in caplog.text:
                break
            await asyncio.sleep(0)
        return result

    result = asyncio.run(_collect())
    assert result == {
        "reply": "completed before cancellation",
        "conversation_id": "conv_cancel_failure",
        "message_id": "msg_cancel_failure",
    }
    assert "stream task failed during cancellation" in caplog.text
    assert "conv_cancel_failure" in caplog.text
    assert "teardown blew up" in caplog.text


def test_collect_agent_reply_details_logs_natural_failure_during_external_cancellation(
    monkeypatch, tmp_path, caplog
):
    _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")
    common = importlib.import_module("channels.common")
    post_finish_wait_entered = asyncio.Event()
    release_stream_failure = asyncio.Event()
    real_shield = asyncio.shield

    def _tracking_shield(awaitable):
        post_finish_wait_entered.set()
        return real_shield(awaitable)

    async def _finish_then_fail_when_released(*, part_queue, **kwargs):
        await part_queue.put({"type": "text", "text": "completed before caller cancellation"})
        await part_queue.put({
            "type": "finish",
            "conversation_id": "conv_external_cancel_failure",
            "message_id": "msg_external_cancel_failure",
        })
        await release_stream_failure.wait()
        raise RuntimeError("natural stream failure during external cancellation")

    monkeypatch.setattr(common.asyncio, "shield", _tracking_shield)
    monkeypatch.setattr(chat_service, "stream_chat", _finish_then_fail_when_released)

    async def _cancel_collector_after_finish():
        collector = asyncio.create_task(
            common.collect_agent_reply_details(
                message="hello",
                user_id="mcp-test-user",
                conversation_id=None,
                source="mcp",
            )
        )
        await post_finish_wait_entered.wait()
        release_stream_failure.set()
        collector.cancel()
        with pytest.raises(asyncio.CancelledError):
            await collector
        await asyncio.sleep(0)

    asyncio.run(asyncio.wait_for(_cancel_collector_after_finish(), timeout=1.0))
    failure_records = [
        record
        for record in caplog.records
        if record.exc_info
        and str(record.exc_info[1])
        == "natural stream failure during external cancellation"
    ]
    assert len(failure_records) == 1


# ---------------------------------------------------------------------------
# Blocker fixes — race-closing resume + fatal durable tool-result persistence
# ---------------------------------------------------------------------------

def test_stream_chat_explicit_missing_conversation_fails_closed_without_forking(
    monkeypatch, tmp_path
):
    """Blocker 1 (race -> silent fork): the authoritative must-exist guard lives
    INSIDE stream_chat, not only in the endpoint preflight. Driving stream_chat
    directly with an explicit conv_ id that is unresolved/unowned at resolve
    time (simulating a conversation deleted between the preflight and here) must
    emit an error and must NOT create a new conversation (thread fork)."""
    main = _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")

    async def _drive():
        queue: asyncio.Queue = asyncio.Queue()
        await chat_service.stream_chat(
            message="resume the vanished thread",
            user_id="mcp-test-user",
            conversation_id="conv_vanished_mid_race",
            part_queue=queue,
            source="mcp",
        )
        parts = []
        while not queue.empty():
            parts.append(queue.get_nowait())
        return parts

    parts = asyncio.run(asyncio.wait_for(_drive(), timeout=2.0))
    kinds = [p.get("type") for p in parts]
    assert "error" in kinds, parts
    error_part = next(p for p in parts if p.get("type") == "error")
    assert "not found" in str(error_part.get("error")).lower(), error_part
    # Never silently forks: no conversation (and no user row) was created.
    assert _conversations_in_db(main) == [], \
        "must-exist resume must not create a conversation"
    # And the finish carries no phantom message id.
    finish = next((p for p in parts if p.get("type") == "finish"), None)
    assert finish is not None, parts
    assert finish.get("message_id") is None, finish


def test_stream_chat_missing_conversation_error_surfaces_via_collector(
    monkeypatch, tmp_path
):
    """Blocker 1: the in-stream fail-closed error is surfaced to MCP callers as
    an actionable AgentReplyError (isError tool result), not a silent fork."""
    _load_api(monkeypatch, tmp_path)
    common = importlib.import_module("channels.common")

    async def _collect():
        return await common.collect_agent_reply_details(
            message="resume please",
            user_id="mcp-test-user",
            conversation_id="conv_gone_forever",
            source="mcp",
        )

    with pytest.raises(common.AgentReplyError, match="not found or is not accessible"):
        asyncio.run(asyncio.wait_for(_collect(), timeout=2.0))


def test_workspace_chat_tool_result_persistence_failure_surfaces_not_phantom_success(
    monkeypatch, tmp_path
):
    """Blocker 2 (#2266 over-correction): a failed durable tool-RESULT insert
    during an ACTIVE run must surface as an error, never a silent success with
    an incomplete transcript (which could make a resumed run REPEAT a side
    effect). It must also never return a msg_pending_ placeholder id."""
    main = _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")
    from runner_sandbox import agent_capabilities

    async def _no_mcp(*a, **k):
        return []

    monkeypatch.setattr(agent_capabilities, "connect_mcp_servers", _no_mcp)
    monkeypatch.setattr(agent_capabilities, "cleanup_mcp_servers", _no_mcp)
    monkeypatch.setattr(chat_service, "_workspace_tools", lambda *a, **k: [])
    monkeypatch.setattr(chat_service, "_brain_read_tools", lambda *a, **k: [])
    monkeypatch.setattr(chat_service, "_composio_read_tools", lambda *a, **k: [])
    import runner_sandbox.stream_adapter as stream_adapter
    monkeypatch.setattr(stream_adapter, "decode_stream_event", lambda event: event)

    class _FakeResult:
        async def stream_events(self):
            yield SimpleNamespace(
                kind="tool_output",
                call_id="call_send_email",
                output={"ok": True, "data": "email sent to ceo@corp.test"},
                is_error=False,
            )
            yield SimpleNamespace(kind="text_delta", text="All done, I sent it.")

    def _fake_run_streamed(agent, *args, **kwargs):
        return _FakeResult()

    import agents
    monkeypatch.setattr(agents.Runner, "run_streamed", staticmethod(_fake_run_streamed))

    # Durable tool-RESULT history write fails; user/assistant writes are fine.
    real_insert = chat_service.insert_message

    def _insert(conversation_id, role, content, *a, **k):
        if role == "tool":
            raise RuntimeError("durable tool transcript write failed")
        return real_insert(conversation_id, role, content, *a, **k)

    monkeypatch.setattr(chat_service, "insert_message", _insert)

    result = _workspace_chat_result(main, {"message": "send the email"})
    assert result["isError"] is True, \
        f"tool-result persistence failure must surface, not phantom success: {result}"
    sc = result.get("structuredContent") or {}
    assert not str(sc.get("message_id") or "").startswith("msg_pending"), sc


def test_workspace_chat_empty_reply_does_not_return_pending_message_id(
    monkeypatch, tmp_path
):
    """Blocker 2: when no assistant row is stored, the result must not surface a
    msg_pending_ placeholder as the stored message id."""
    main = _load_api(monkeypatch, tmp_path)
    _FakeAgentRuntime(monkeypatch, reply_text="")

    result = _workspace_chat_result(main, {"message": "produce nothing"})
    assert result["isError"] is False, result
    sc = result["structuredContent"]
    assert sc["message_id"] is None or not str(sc["message_id"]).startswith("msg_pending"), sc
