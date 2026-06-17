from __future__ import annotations

import asyncio
import importlib
import json
import socket
import sys
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def booted(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-chat-phase1")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DRAFT_RATE_HOUR", "100")
    monkeypatch.setenv("WORKEROS_RUN_CREATE_RATE_LIMIT", "100")

    for name in list(sys.modules):
        if name in (
            "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
            "db.dependency", "db.interface", "models", "files", "worker_registry",
            "runner_utils", "run_service", "webhook_service", "composio_client",
            "scheduler", "services.chat_tool_impls", "auth", "auth.context", "auth.dependency", "auth.factory",
            "auth.interface", "auth.local", "contexts", "chat_service",
        ) or name.startswith("routers"):
            sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    chat_service = importlib.import_module("chat_service")
    run_service = importlib.import_module("run_service")

    yield {"db": db, "main": main, "chat_service": chat_service, "run_service": run_service}
    db.get_repositories.cache_clear()


def test_args_preview_redacts_secret_set_value_and_tokens(booted):
    chat_service = booted["chat_service"]
    secret_value = "sk-live-secret-value-1234567890"

    preview = chat_service.build_args_preview(
        "secrets__set",
        {"name": "OPENAI_API_KEY", "value": secret_value, "note": "Bearer abcdefghijklmnop"},
    )
    encoded = json.dumps(preview)

    assert preview["name"] == "OPENAI_API_KEY"
    assert preview["value"]["redacted"] is True
    assert secret_value not in encoded
    assert "abcdefghijklmnop" not in encoded


def test_args_preview_redacts_camel_case_token_fields(booted):
    chat_service = booted["chat_service"]
    opaque_token = "eyJhbGciOiJIUzI1NiJ9.opaque-session-value"

    preview = chat_service.build_args_preview(
        "connections__add_mcp",
        {"accessToken": opaque_token, "bearerToken": opaque_token, "apiKey": opaque_token},
    )
    encoded = json.dumps(preview)

    assert opaque_token not in encoded
    assert preview["accessToken"]["redacted"] is True
    assert preview["bearerToken"]["redacted"] is True
    assert preview["apiKey"]["redacted"] is True


def test_args_preview_redacts_large_yaml_and_file_content(booted):
    chat_service = booted["chat_service"]
    yaml_text = "schema_version: \"0.3\"\nname: \"secret-worker\"\n" + ("description: x\n" * 80)

    preview = chat_service.build_args_preview(
        "workers__create",
        {"yaml_text": yaml_text, "files": [{"path": "run.py", "content": "print('hidden')"}]},
    )
    encoded = json.dumps(preview)

    assert preview["yaml_text"]["redacted"] is True
    assert "secret-worker" not in encoded
    assert "print('hidden')" not in encoded


def test_args_preview_redacts_common_sensitive_fields_for_every_emily_tool(booted):
    chat_service = booted["chat_service"]
    tool_names = [getattr(tool, "name", "") for tool in chat_service._workspace_tools("federico")]
    leaked_values = [
        "sk-live-secret-value-1234567890",
        "Bearer abcdefghijklmnop",
        "print('hidden')",
        "schema_version: \"0.3\"\nname: \"hidden-worker\"",
    ]

    for tool_name in tool_names:
        preview = chat_service.build_args_preview(
            tool_name,
            {
                "name": "OPENAI_API_KEY",
                "value": leaked_values[0],
                "auth_secret": leaked_values[1],
                "content": leaked_values[2],
                "yaml_text": leaked_values[3],
            },
        )
        encoded = json.dumps(preview)
        for leaked in leaked_values:
            assert leaked not in encoded, f"{tool_name} leaked {leaked!r}: {encoded}"


def test_connections_list_redacts_mcp_auth_secret_from_tool_result(booted):
    repos = booted["db"].get_repositories()
    repos.connections.upsert(
        user_id="federico",
        id="mcp-redact",
        app_name="mcp",
        composio_connection_id="mcp-redact",
        kind="mcp",
        status="active",
        mcp_label="ops-mcp",
        mcp_url="https://mcp.example.com",
        mcp_auth_secret="RAW_BEARER_SECRET_NAME",
        mcp_allowed_tools_json=json.dumps(["tickets.search"]),
    )
    chat_tools = importlib.import_module("services.chat_tool_impls")

    result = chat_tools._tool_connections_list({}, "federico")
    encoded = json.dumps(result)
    conn = result["connections"][0]

    assert result["ok"] is True
    assert "RAW_BEARER_SECRET_NAME" not in encoded
    assert "mcp_auth_secret" not in conn
    assert conn["mcp_auth_configured"] is True


def test_connections_add_mcp_tool_reuses_http_label_validation(booted):
    chat_tools = importlib.import_module("services.chat_tool_impls")

    result = chat_tools._tool_connections_add_mcp(
        {"label": "bad label with spaces", "url": "https://mcp.example.com"},
        "federico",
    )

    assert result["ok"] is False
    assert "letters, digits, underscores, or hyphens" in result["error"]


def test_connections_add_mcp_tool_reuses_http_ssrf_validation(booted):
    chat_tools = importlib.import_module("services.chat_tool_impls")

    blocked = chat_tools._tool_connections_add_mcp(
        {"label": "evil", "url": "http://169.254.169.254/latest/meta-data"},
        "federico",
    )
    assert blocked["ok"] is False
    assert "not allowed" in blocked["error"].lower()

    with patch(
        "models.socket.getaddrinfo",
        return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))],
    ):
        allowed = chat_tools._tool_connections_add_mcp(
            {"label": "good_mcp", "url": "https://mcp.example.com", "allowed_tools": ["search"]},
            "federico",
        )
    assert allowed["ok"] is True


def test_tool_event_metadata_keeps_legacy_safe_args_and_card_resource(booted):
    chat_service = booted["chat_service"]
    metadata = chat_service.build_tool_event_metadata(
        "workers__create_from_prompt",
        "call_create",
        args={"prompt": "build a daily summary worker", "idempotency_key": "idem-1"},
        result={"ok": True, "run_id": "run_123", "worker_id": "worker-author"},
        phase="result",
    )

    assert metadata["protocol"] == chat_service.CHAT_EVENT_PROTOCOL_VERSION
    assert metadata["version"] == 2
    assert metadata["card"] == {
        "id": "card_call_create",
        "kind": "worker",
        "title": "Create worker from prompt",
        "status": "running",
    }
    assert metadata["resource"] == {"kind": "run", "worker_id": "worker-author", "run_id": "run_123"}
    assert metadata["streams"]["events"] == "/runs/run_123/events"
    assert metadata["actions"][0] == {
        "id": "open_run",
        "label": "View run",
        "method": "GET",
        "href": "/runs/run_123?tab=logs",
    }


def test_worker_list_tool_metadata_uses_renderable_worker_list_card(booted):
    chat_service = booted["chat_service"]
    metadata = chat_service.build_tool_event_metadata(
        "workers__list_all",
        "call_workers",
        args={},
        result={
            "ok": True,
            "workers": [
                {"id": "research_brief", "title": "Research Brief", "enabled": True},
            ],
            "count": 1,
        },
        phase="result",
    )

    assert metadata["card"]["kind"] == "worker-list"
    assert metadata["card"]["status"] == "completed"
    assert metadata["resource"] is None


def test_worker_list_fallback_summary_uses_successful_tool_result(booted):
    chat_service = booted["chat_service"]

    reply = chat_service._fallback_reply_from_successful_tools([
        (
            "workers__list_all",
            {
                "ok": True,
                "count": 2,
                "workers": [
                    {"id": "research", "title": "Research Brief"},
                    {"id": "digest", "name": "GitHub Digest"},
                ],
            },
        )
    ])

    assert reply == (
        "You have 2 workers in this workspace. "
        "Here are the first 2: Research Brief, GitHub Digest."
    )


@pytest.mark.asyncio
async def test_stream_chat_uses_tool_result_when_provider_fails_after_workers_tool(booted, monkeypatch):
    chat_service = booted["chat_service"]

    monkeypatch.setattr(chat_service, "_workspace_tools", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(chat_service, "_brain_read_tools", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(chat_service, "_composio_read_tools", lambda *_args, **_kwargs: [])

    async def _no_mcp(*_args, **_kwargs):
        return []

    from runner_sandbox import agent_capabilities
    monkeypatch.setattr(agent_capabilities, "connect_mcp_servers", _no_mcp)
    monkeypatch.setattr(agent_capabilities, "cleanup_mcp_servers", _no_mcp)

    import runner_sandbox.stream_adapter as stream_adapter

    monkeypatch.setattr(stream_adapter, "decode_stream_event", lambda event: event)

    class _FakeResult:
        async def stream_events(self):
            yield SimpleNamespace(
                kind="tool_call",
                call_id="call_workers",
                tool_name="workers__list_all",
                args={},
            )
            yield SimpleNamespace(
                kind="tool_output",
                call_id="call_workers",
                output={
                    "ok": True,
                    "count": 2,
                    "workers": [
                        {"id": "research", "title": "Research Brief"},
                        {"id": "digest", "name": "GitHub Digest"},
                    ],
                },
                is_error=False,
            )
            raise RuntimeError("Error code: 401 invalid_api_key")

    import agents

    monkeypatch.setattr(agents.Runner, "run_streamed", staticmethod(lambda *_args, **_kwargs: _FakeResult()))

    q: asyncio.Queue = asyncio.Queue()
    await chat_service.stream_chat(
        message="What workers do I have?",
        user_id="federico",
        conversation_id=None,
        part_queue=q,
        source="web",
    )

    events = []
    while not q.empty():
        events.append(q.get_nowait())

    assert "error" not in [event.get("type") for event in events]
    text_events = [event for event in events if event.get("type") == "text"]
    assert text_events
    assert "You have 2 workers" in text_events[-1]["text"]
    assert events[-1]["type"] == "finish"


def test_worker_run_tool_metadata_uses_renderable_run_card(booted):
    chat_service = booted["chat_service"]
    metadata = chat_service.build_tool_event_metadata(
        "workers__run",
        "call_run",
        args={"id": "research_brief"},
        result={"ok": True, "run_id": "run_123"},
        phase="result",
    )

    assert metadata["card"]["kind"] == "run"
    assert metadata["card"]["status"] == "running"
    assert metadata["resource"] == {
        "kind": "run",
        "worker_id": "research_brief",
        "run_id": "run_123",
    }
    assert metadata["streams"]["parts"] == "/runs/run_123/stream"


def test_runs_get_metadata_serializes_nested_run_resource_and_view_action(booted):
    chat_service = booted["chat_service"]
    metadata = chat_service.build_tool_event_metadata(
        "runs__get",
        "call_run_details",
        args={"run_id": "run_123"},
        result={
            "ok": True,
            "run": {
                "id": "run_123",
                "worker_id": "research_brief",
                "status": "completed",
            },
        },
        phase="result",
    )

    assert metadata["card"]["kind"] == "run"
    assert metadata["card"]["status"] == "completed"
    assert metadata["resource"] == {
        "kind": "run",
        "worker_id": "research_brief",
        "run_id": "run_123",
    }
    assert metadata["actions"][0] == {
        "id": "open_run",
        "label": "View run",
        "method": "GET",
        "href": "/runs/run_123?tab=logs",
    }


def test_tool_result_preview_does_not_expose_file_content(booted):
    chat_service = booted["chat_service"]
    raw_content = "private file body that must not stream"

    metadata = chat_service.build_tool_event_metadata(
        "contexts__read",
        "call_read",
        args={"name": "ops", "file_path": "secret.md"},
        result={"ok": True, "content": raw_content},
        phase="result",
    )

    encoded = json.dumps(metadata["result_preview"])
    assert raw_content not in encoded
    assert metadata["result_preview"]["ok"] is True


def test_tool_result_preview_redacts_secret_query_params(booted):
    chat_service = booted["chat_service"]
    approval_token = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"

    metadata = chat_service.build_tool_event_metadata(
        "approvals__list_pending",
        "call_approval_link",
        args={},
        result={
            "ok": True,
            "count": 1,
            "approvals": [
                {
                    "id": "apr_1",
                    "run_id": "run_1",
                    "worker_id": "gmail_sender",
                    "link": f"https://workers.floom.dev/approvals/review?id=apr_1&token={approval_token}",
                }
            ],
        },
        phase="result",
    )

    encoded = json.dumps(metadata["result_preview"])
    assert approval_token not in encoded
    assert "token=[redacted]" in encoded


def test_approval_list_result_keeps_token_out_of_model_visible_text(booted):
    chat_service = booted["chat_service"]
    token = chat_service._approval_public_token({
        "id": "apr_1",
        "run_id": "run_1",
        "owner_id": "federico",
    })

    metadata = chat_service.build_tool_event_metadata(
        "approvals__list_pending",
        "call_pending",
        args={},
        result={
            "ok": True,
            "count": 1,
            "approvals": [
                {
                    "id": "apr_1",
                    "owner_id": "federico",
                    "worker_id": "gmail_sender",
                    "worker_name": "Gmail Sender",
                    "run_id": "run_1",
                    "label": "Review before send",
                    "preview": "Please review the draft",
                    "created_at": "2026-06-08T10:00:00Z",
                }
            ],
        },
        phase="result",
    )

    encoded = json.dumps(metadata["result_preview"])
    assert token not in encoded
    assert "link" not in encoded
    assert metadata["card"]["status"] == "pending_approval"
    assert metadata["card"]["title"] == "Pending approvals"
    assert metadata["actions"] and metadata["actions"][0]["href"].endswith(f"token={token}")


def test_finish_tool_args_are_normalized_before_card_metadata(booted):
    chat_service = booted["chat_service"]
    approval_token = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"

    normalized = chat_service.normalize_tool_args_for_event(
        "finish_with_outputs",
        {
            "reply": (
                "Done — with dash. "
                f"https://workers.floom.dev/approvals/review?id=apr_1&token={approval_token}"
            )
        },
    )
    metadata = chat_service.build_tool_event_metadata(
        "finish_with_outputs",
        "call_finish",
        args=normalized,
        phase="call",
    )

    encoded = json.dumps(metadata["args_preview"])
    assert "—" not in encoded
    assert "–" not in encoded
    assert approval_token not in encoded
    assert "token=[redacted]" in encoded


def test_streaming_text_sanitizer_redacts_split_approval_tokens(booted):
    chat_service = booted["chat_service"]
    # Not a real secret — fake hex string used as a query-param value in tests.
    token = "abcdef" + "1234567890" * 5 + "abcdef12"  # noqa: S105
    sanitizer = chat_service._StreamingTextSanitizer()

    chunks = [
        "Review it here: https://workers.floom.dev/approvals/review?id=apr_1&tok",
        "en=" + token[:20],
        token[20:45],
        token[45:] + " now.",
    ]
    rendered = "".join(sanitizer.feed(chunk) for chunk in chunks) + sanitizer.flush()

    assert token not in rendered
    assert "token=[redacted]" in rendered
    assert rendered.endswith(" now.")


def test_async_create_from_prompt_is_idempotent(booted, monkeypatch):
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    conv_id = chat_service.create_conversation("u1", title="Async create")
    created_runs: list[tuple[str, dict]] = []

    # _idempotent_worker_author_run lives in services.chat_throttle and resolves
    # _ensure_worker_author_registered in that namespace, so patch it there.
    chat_throttle = sys.modules["services.chat_throttle"]
    monkeypatch.setattr(chat_throttle, "_ensure_worker_author_registered", lambda user_id: None)

    def fake_create_run(worker_id, inputs, trigger_source="manual", **kwargs):
        run_id = f"run_fake_{len(created_runs) + 1}"
        created_runs.append((run_id, dict(inputs)))
        return run_id

    started: list[str] = []
    monkeypatch.setattr(run_service, "create_run", fake_create_run)
    monkeypatch.setattr(run_service, "start_run", lambda run_id, *args, **kwargs: started.append(run_id))

    first = chat_service._idempotent_worker_author_run(
        user_id="u1",
        conversation_id=conv_id,
        idempotency_key="idem-1",
        prompt="make a worker",
        mode="create",
    )
    second = chat_service._idempotent_worker_author_run(
        user_id="u1",
        conversation_id=conv_id,
        idempotency_key="idem-1",
        prompt="make a worker",
        mode="create",
    )

    assert first["ok"] is True
    assert first["run_id"] == "run_fake_1"
    assert second["ok"] is True
    assert second["run_id"] == "run_fake_1"
    assert second["idempotent"] is True
    assert len(created_runs) == 1
    assert started == ["run_fake_1"]


def test_async_create_from_prompt_pending_reservation_does_not_create_duplicate(booted, monkeypatch):
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]
    db = booted["db"]
    conv_id = chat_service.create_conversation("u1", title="Async create")

    with db.get_db() as conn:
        conn.execute(
            """
            INSERT INTO chat_tool_idempotency
                (user_id, conversation_id, tool_name, idempotency_key,
                 run_id, worker_id, created_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                "u1",
                conv_id,
                "workers__create_from_prompt",
                "idem-pending",
                "worker-author",
                db.now_iso(),
            ),
        )

    monkeypatch.setattr(run_service, "create_run", lambda *a, **k: (_ for _ in ()).throw(AssertionError("duplicate run")))
    monkeypatch.setattr(chat_service.time, "sleep", lambda _seconds: None)
    times = iter([0.0, 3.0])
    monkeypatch.setattr(chat_service.time, "time", lambda: next(times, 3.0))

    result = chat_service._idempotent_worker_author_run(
        user_id="u1",
        conversation_id=conv_id,
        idempotency_key="idem-pending",
        prompt="make a worker",
        mode="create",
    )

    assert result["ok"] is False
    assert result["idempotent"] is True
    assert "already being created" in result["error"]


def test_worker_author_run_quota_releases_claimed_draft_slot(booted, monkeypatch):
    chat_service = booted["chat_service"]
    db = booted["db"]
    monkeypatch.setenv("WORKEROS_DRAFT_RATE_HOUR", "10")
    monkeypatch.setenv("WORKEROS_RUN_CREATE_RATE_LIMIT", "1")
    monkeypatch.setenv("WORKEROS_RUN_CREATE_RATE_WINDOW_SECONDS", "60")

    user_id = "u1"
    workspace_id = chat_service._chat_workspace_id(user_id)
    draft_key = f"user:{user_id}:workspace:{workspace_id}:drafts"
    run_key = f"user:{user_id}:workspace:{workspace_id}:runs"
    assert chat_service._claim_chat_rate_slot(run_key, limit=1, window=60.0) is None

    result = chat_service._enforce_worker_author_chat_throttles(user_id, workspace_id)

    assert result is not None
    assert "Run creation rate limit exceeded" in result["error"]
    with db.get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS count FROM run_create_rate_limits WHERE key = ?",
            (draft_key,),
        ).fetchone()
    assert int(row["count"]) == 0


def test_conversation_get_replays_tool_cards(booted):
    chat_service = booted["chat_service"]
    main = booted["main"]
    conv_id = chat_service.create_conversation("federico", title="Replay")
    metadata = chat_service.build_tool_event_metadata(
        "workers__create_from_prompt",
        "call_replay",
        args={"prompt": "build a worker", "idempotency_key": "idem-replay"},
        result={"ok": True, "run_id": "run_replay", "worker_id": "worker-author"},
        phase="result",
    )
    chat_service._persist_tool_card(conv_id, "federico", "call_replay", "workers__create_from_prompt", metadata)

    from fastapi.testclient import TestClient

    with TestClient(main.app, headers={"x-floom-secret": "test-secret-chat-phase1"}) as client:
        response = client.get(f"/conversations/{conv_id}")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tool_cards"][0]["callId"] == "call_replay"
    assert body["tool_cards"][0]["card"]["id"] == "card_call_replay"
    assert body["tool_cards"][0]["resource"]["run_id"] == "run_replay"
    assert body["tool_cards"][0]["streams"]["events"] == "/runs/run_replay/events"


def test_workers_run_uses_start_run_queue_path(booted, monkeypatch):
    chat_service = booted["chat_service"]
    run_service = booted["run_service"]

    created: list[tuple[str, dict, str]] = []
    started: list[tuple[str, str, dict]] = []

    def fake_create_run(worker_id, inputs, trigger_source="manual", **kwargs):
        created.append((worker_id, dict(inputs), trigger_source))
        return "run_queue_1"

    def fake_start_run(run_id, worker_id, inputs, **kwargs):
        started.append((run_id, worker_id, dict(inputs)))

    # Bypass the #748 ownership guard: the tool checks _worker_can_view which
    # queries the DB; in this unit test there is no persisted worker row.
    monkeypatch.setattr(chat_service, "_worker_can_view", lambda conn, wid, uid: True)
    monkeypatch.setattr(run_service, "create_run", fake_create_run)
    monkeypatch.setattr(run_service, "start_run", fake_start_run)

    result = chat_service._tool_workers_run(
        {"id": "csv_enricher", "inputs_json": {"rows": [1]}},
        "u1",
    )

    assert result["ok"] is True
    assert result["run_id"] == "run_queue_1"
    assert created == [("csv_enricher", {"rows": [1]}, "workspace-agent")]
    assert started == [("run_queue_1", "csv_enricher", {"rows": [1]})]


def test_approval_result_builds_action_required_card(booted):
    chat_service = booted["chat_service"]
    metadata = chat_service.build_tool_event_metadata(
        "approvals__list_pending",
        "call_approval",
        args={},
        result={
            "ok": True,
            "count": 1,
            "approvals": [
                {
                    "id": "apr_1",
                    "run_id": "run_1",
                    "worker_id": "gmail_sender",
                }
            ],
        },
        phase="result",
    )

    assert metadata["card"]["status"] == "pending_approval"
    assert metadata["reason"] is None
    assert metadata["resource"] == {
        "kind": "approval",
        "approval_id": "apr_1",
        "run_id": "run_1",
        "worker_id": "gmail_sender",
        "count": 1,
    }
    assert {"id": "approve", "method": "POST", "href": "/runs/run_1/approve"} in metadata["actions"]
    assert {"id": "reject", "method": "POST", "href": "/runs/run_1/reject"} in metadata["actions"]


def test_conversation_rows_are_not_evicted(booted):
    chat_service = booted["chat_service"]
    conv_id = chat_service.create_conversation("u1", title="No eviction")

    for idx in range(75):
        chat_service.insert_message(conv_id, "user", f"message {idx}")

    chat_service._maybe_evict_conversation(conv_id, "u1")
    stored = chat_service.list_conversation_messages(conv_id, "u1")
    history = chat_service.load_conversation_history(conv_id)

    assert len(stored) == 75
    assert len(history) == chat_service.CONVERSATION_WINDOW
    assert stored[0]["content"] == "message 0"


def test_chat_sse_endpoint_preserves_contract_order(booted, monkeypatch):
    main = booted["main"]

    async def fake_stream_chat(*, message, user_id, conversation_id, part_queue, source):
        conv_id = "conv_contract"
        msg_id = "msg_pending_contract"
        await part_queue.put({
            "type": "chat.meta",
            "version": 2,
            "conversation_id": conv_id,
            "assistant_message_id": msg_id,
            "source": source,
        })
        await part_queue.put({
            "type": "text",
            "version": 2,
            "conversation_id": conv_id,
            "message_id": msg_id,
            "text": "I will check.",
        })
        await part_queue.put({
            "type": "tool-progress",
            "version": 2,
            "conversation_id": conv_id,
            "message_id": msg_id,
            "callId": "call_1",
            "card_id": "card_call_1",
            "resource": {"kind": "run", "run_id": "run_1"},
            "status": "starting",
            "stage": "started",
            "label": "Run worker",
            "percent": None,
        })
        await part_queue.put({
            "type": "tool-resource",
            "version": 2,
            "conversation_id": conv_id,
            "message_id": msg_id,
            "callId": "call_1",
            "card_id": "card_call_1",
            "resource": {"kind": "run", "run_id": "run_1"},
            "actions": [{"id": "open_run", "method": "GET", "href": "/runs/run_1"}],
        })
        await part_queue.put({
            "type": "tool-action-required",
            "version": 2,
            "conversation_id": conv_id,
            "message_id": msg_id,
            "callId": "call_1",
            "card_id": "card_call_1",
            "reason": "approval_required",
            "resource": {"kind": "approval", "approval_id": "apr_1", "run_id": "run_1"},
            "actions": [{"id": "approve", "method": "POST", "href": "/runs/run_1/approve"}],
        })
        await part_queue.put({
            "type": "finish",
            "version": 2,
            "conversation_id": conv_id,
            "message_id": "msg_final",
            "assistant_message_id": msg_id,
            "cards": [{"id": "card_call_1", "callId": "call_1", "kind": "run", "status": "action_required"}],
        })

    monkeypatch.setattr("chat_service.stream_chat", fake_stream_chat)

    from fastapi.testclient import TestClient

    with TestClient(main.app, headers={"x-floom-secret": "test-secret-chat-phase1"}) as client:
        with client.stream("POST", "/chat", json={"message": "run worker"}) as response:
            assert response.status_code == 200
            events = []
            for line in response.iter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line.removeprefix("data: ")))

    assert [event["type"] for event in events] == [
        "chat.meta",
        "text",
        "tool-progress",
        "tool-resource",
        "tool-action-required",
        "finish",
    ]
    assert events[0]["assistant_message_id"] == "msg_pending_contract"
    assert events[2]["card_id"] == "card_call_1"
    assert events[-1]["cards"][0]["id"] == "card_call_1"


def test_public_run_sse_enriches_artifact_and_terminal_events(booted, monkeypatch):
    main = booted["main"]
    # _run_event_metadata moved to services.public_view alongside _public_sse_event,
    # which calls it directly; patch it at its new home so the injection takes effect.
    import services.public_view as _public_view
    monkeypatch.setattr(
        _public_view,
        "_run_event_metadata",
        lambda run_id: {
            "worker_id": "csv_enricher",
            "worker_name": "CSV Enricher",
            "completed_at": "2026-06-05T08:00:00+00:00",
            "duration_ms": 1234,
        },
    )

    artifact = main._public_sse_event({
        "type": "artifact",
        "run_id": "run_abc",
        "artifact": {"id": "art_123", "name": "out/report.csv"},
    })
    terminal = main._public_sse_event({
        "type": "status",
        "run_id": "run_abc",
        "status": "completed",
    })

    assert artifact["worker_id"] == "csv_enricher"
    assert artifact["artifact"]["worker_name"] == "CSV Enricher"
    assert artifact["artifact"]["download_url"] == "/runs/run_abc/artifacts/art_123/download"
    assert terminal["completed_at"] == "2026-06-05T08:00:00+00:00"
    assert terminal["duration_ms"] == 1234
