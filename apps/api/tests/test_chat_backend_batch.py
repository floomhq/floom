from __future__ import annotations

import importlib
import sys
from pathlib import Path

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
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-chat")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in list(sys.modules):
        if name in (
            "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
            "db.dependency", "db.interface", "models", "files", "worker_registry",
            "runner_utils", "run_service", "webhook_service", "composio_client",
            "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
            "auth.interface", "auth.local", "contexts", "chat_service",
        ) or name.startswith("routers"):
            sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    chat_service = importlib.import_module("chat_service")

    yield {"db": db, "main": main, "chat_service": chat_service}
    db.get_repositories.cache_clear()


def test_caller_supplied_conversation_ids_are_stable_and_owner_scoped(booted):
    chat_service = booted["chat_service"]

    alice_id = chat_service.resolve_conversation_id("my-conv-123", "alice")
    alice_id_again = chat_service.resolve_conversation_id("my-conv-123", "alice")
    bob_id = chat_service.resolve_conversation_id("my-conv-123", "bob")

    assert alice_id == alice_id_again
    assert alice_id != "my-conv-123"
    assert bob_id != alice_id

    created = chat_service.create_conversation(
        "alice",
        title="Alice thread",
        conversation_id=alice_id,
    )
    chat_service.insert_message(created, "user", "remember kiwi")

    assert chat_service.get_conversation(alice_id, "alice") is not None
    assert chat_service.load_conversation_history(alice_id)[0]["content"] == "remember kiwi"
    assert chat_service.get_conversation(alice_id, "bob") is None
    assert chat_service.load_conversation_history(bob_id) == []


def test_guessed_foreign_server_conversation_id_remaps_for_caller(booted):
    chat_service = booted["chat_service"]

    alice_server_id = chat_service.create_conversation("alice", title="Alice private")
    bob_storage_id = chat_service.resolve_conversation_id(alice_server_id, "bob")

    assert bob_storage_id != alice_server_id
    created = chat_service.create_conversation(
        "bob",
        title="Bob remapped thread",
        conversation_id=bob_storage_id,
    )
    chat_service.insert_message(created, "user", "bob message")

    assert chat_service.get_conversation(alice_server_id, "alice") is not None
    assert chat_service.get_conversation(alice_server_id, "bob") is None
    assert chat_service.load_conversation_history(bob_storage_id)[0]["content"] == "bob message"


def test_post_chat_accepts_source_and_defaults_to_web(booted, monkeypatch):
    main = booted["main"]
    chat_service = booted["chat_service"]
    seen_sources: list[str] = []

    async def fake_stream_chat(*, message, user_id, conversation_id, part_queue, source):
        seen_sources.append(source)
        await part_queue.put({"type": "finish", "conversation_id": "conv_test", "message_id": "msg_test"})

    monkeypatch.setattr(chat_service, "stream_chat", fake_stream_chat)

    from fastapi.testclient import TestClient

    with TestClient(main.app, headers={"x-floom-secret": "test-secret-chat"}) as client:
        mcp = client.post("/chat", json={"message": "hello", "source": "mcp"})
        assert mcp.status_code == 200, mcp.text
        default = client.post("/chat", json={"message": "hello"})
        assert default.status_code == 200, default.text
        invalid = client.post("/chat", json={"message": "hello", "source": "email"})
        assert invalid.status_code == 422

    assert seen_sources == ["mcp", "web"]


def test_auth_middleware_rejects_trailing_space_secret(booted):
    main = booted["main"]

    from fastapi.testclient import TestClient

    with TestClient(main.app) as client:
        exact = client.get("/workers", headers={"x-floom-secret": "test-secret-chat"})
        trailing = client.get("/workers", headers={"x-floom-secret": "test-secret-chat "})

    assert exact.status_code == 200, exact.text
    assert trailing.status_code == 401, trailing.text
