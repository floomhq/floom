from __future__ import annotations

import asyncio
import importlib
import sys
import types
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import chat_service


TOKEN = "e281b976e2b6ff521b00fc5202a099374b6f33cf464800ed8f33e790d6412c5a"
APPROVAL_URL = (
    "https://workers.floom.dev/approvals/review"
    f"?id=apr_6c46bcaffa6a&token={TOKEN}"
)
EXPECTED_URL = (
    "https://workers.floom.dev/approvals/review"
    "?id=apr_6c46bcaffa6a&token=[redacted]"
)


def _sanitize_chunks(chunks: list[str]) -> tuple[str, list[str]]:
    sanitizer = chat_service._StreamingTextSanitizer()
    emitted = [sanitizer.feed(chunk) for chunk in chunks]
    emitted.append(sanitizer.flush())
    return "".join(emitted), emitted


@pytest.mark.parametrize("split_at", range(len(APPROVAL_URL) + 1))
def test_redacts_approval_token_at_every_single_split_boundary(split_at):
    rendered, emitted = _sanitize_chunks(
        [APPROVAL_URL[:split_at], APPROVAL_URL[split_at:]]
    )

    assert rendered == EXPECTED_URL
    assert TOKEN not in rendered
    assert all(TOKEN not in chunk for chunk in emitted)


def test_redacts_approval_token_when_every_character_is_a_delta():
    rendered, emitted = _sanitize_chunks(list(f"Review {APPROVAL_URL} now."))

    assert rendered == f"Review {EXPECTED_URL} now."
    assert TOKEN not in rendered
    assert all(TOKEN not in chunk for chunk in emitted)


def test_redacts_token_value_that_ends_at_stream_eof():
    rendered, _emitted = _sanitize_chunks(
        [
            "Review https://workers.floom.dev/approvals/review?id=apr_1&tok",
            "en=",
            TOKEN[:17],
            TOKEN[17:],
        ]
    )

    assert rendered.endswith("&token=[redacted]")
    assert TOKEN not in rendered


def test_preserves_delimiters_and_sanitizes_later_query_params():
    rendered, _emitted = _sanitize_chunks(
        [
            f"First: {APPROVAL_URL}&view=compact.\n",
            "Second: /approvals/review?token=",
            TOKEN,
            "&code=private-code",
            " next",
        ]
    )

    assert rendered == (
        f"First: {EXPECTED_URL}&view=compact.\n"
        "Second: /approvals/review?token=[redacted]&code=[redacted] next"
    )
    assert TOKEN not in rendered
    assert "private-code" not in rendered


def test_preserves_normal_text_and_benign_query_params_across_chunks():
    text = (
        "Normal text with https://workers.floom.dev/approvals"
        "?status=pending&worker=gmail_sender stays intact."
    )
    chunks = [text[:1], text[1:19], text[19:48], text[48:73], text[73:]]

    rendered, _emitted = _sanitize_chunks(chunks)

    assert rendered == text


def test_stream_chat_emits_and_persists_only_sanitized_text(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    artifacts_dir = tmp_path / "artifacts"
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-stream-sanitizer")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "chat_service",
    ]:
        sys.modules.pop(name, None)
        for _rn in [n for n in list(sys.modules) if n.startswith("routers")]:
            sys.modules.pop(_rn, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    service = importlib.import_module("chat_service")

    class FakeFunctionTool:
        def __init__(self, **kwargs):
            self.on_invoke_tool = kwargs["on_invoke_tool"]

    class FakeStreamResult:
        async def stream_events(self):
            for delta in [
                "Review ",
                APPROVAL_URL[:57],
                APPROVAL_URL[57:72],
                APPROVAL_URL[72:],
                " now.",
            ]:
                yield types.SimpleNamespace(
                    type="raw_response_event",
                    data=types.SimpleNamespace(
                        type="response.output_text.delta",
                        delta=delta,
                    ),
                )

    fake_agents = types.SimpleNamespace(
        Agent=lambda **_kwargs: object(),
        FunctionTool=FakeFunctionTool,
        ModelSettings=lambda **_kwargs: object(),
        RunConfig=lambda **_kwargs: object(),
        Runner=types.SimpleNamespace(
            run_streamed=lambda *_args, **_kwargs: FakeStreamResult()
        ),
        WebSearchTool=lambda: object(),
    )
    monkeypatch.setitem(sys.modules, "agents", fake_agents)

    async def _connect(*_args, **_kwargs):
        return []

    async def _cleanup(*_args, **_kwargs):
        return None

    import runner_sandbox.agent_capabilities as agent_capabilities

    monkeypatch.setattr(agent_capabilities, "stage_context_packs", lambda **_kwargs: [])
    monkeypatch.setattr(agent_capabilities, "connect_mcp_servers", _connect)
    monkeypatch.setattr(agent_capabilities, "cleanup_mcp_servers", _cleanup)
    monkeypatch.setattr(service, "_workspace_tools", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(service, "_brain_read_tools", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(service, "_composio_read_tools", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(
        service,
        "build_workspace_agent_config",
        lambda *_args, **_kwargs: types.SimpleNamespace(connections=[]),
    )

    class FakeLoopLocalModelProvider:
        provider = object()

        async def aclose(self):
            return None

    monkeypatch.setitem(
        sys.modules,
        "runner_sandbox.loop_local_provider",
        types.SimpleNamespace(LoopLocalModelProvider=FakeLoopLocalModelProvider),
    )

    async def _run():
        queue = asyncio.Queue()
        await service.stream_chat(
            message="show the pending approval",
            user_id="federico",
            conversation_id=None,
            part_queue=queue,
        )
        return list(queue._queue)

    events = asyncio.run(_run())
    text = "".join(event["text"] for event in events if event["type"] == "text")
    finish = next(event for event in events if event["type"] == "finish")
    stored = service.load_conversation_history(finish["conversation_id"])

    assert text == f"Review {EXPECTED_URL} now."
    assert TOKEN not in text
    assert stored[-1]["role"] == "assistant"
    assert stored[-1]["content"] == text
    assert TOKEN not in stored[-1]["content"]

    db.get_repositories.cache_clear()
