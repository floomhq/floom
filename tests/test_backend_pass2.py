from __future__ import annotations

import importlib
import sys
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

from test_round8_worker_authz import AUTH, _headers, _load_api, _worker_payload


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_conversation_rows_are_not_pruned_past_window(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    chat_service = importlib.import_module("chat_service")

    conv_id = chat_service.create_conversation("user-a", title="Long thread")
    for idx in range(55):
        chat_service.insert_message(conv_id, "user", f"message {idx}")

    chat_service._maybe_evict_conversation(conv_id, "user-a")

    stored = chat_service.list_conversation_messages(conv_id, "user-a")
    history = chat_service.load_conversation_history(conv_id)
    assert len(stored) == 55
    assert stored[0]["content"] == "message 0"
    assert stored[-1]["content"] == "message 54"
    assert len(history) == 50
    assert history[0]["content"] == "message 5"


def test_worker_short_link_mints_and_resolves_public_card_without_leaks(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    worker_id = f"p2test-share-{uuid.uuid4().hex[:8]}"

    payload = _worker_payload(worker_id, title="Pass 2 Share Probe", secrets=("PRIVATE_TOKEN",))
    created = client.post("/workers", headers=_headers("user-a"), json=payload)
    assert created.status_code == 200, created.text

    minted = client.post(f"/workers/{worker_id}/short-link", headers=_headers("user-a"))
    assert minted.status_code == 200, minted.text
    short = minted.json()
    assert short["short_id"].startswith("fls_")
    assert short["short_url"].endswith(f"/{short['short_id']}")

    repeated = client.post(f"/workers/{worker_id}/short-link", headers=_headers("user-a"))
    assert repeated.status_code == 200
    assert repeated.json() == short

    public = client.get(f"/workers/short-links/{short['short_id']}")
    alias = client.get(f"/s/{short['short_id']}")
    assert public.status_code == 200, public.text
    assert alias.status_code == 200, alias.text
    body = public.json()
    assert body["id"] == worker_id
    assert body["name"] == "Pass 2 Share Probe"
    forbidden = {
        "owner_id", "secrets", "config", "files", "run_py", "run_py_content",
        "skill_md_content", "manifest_yaml", "recent_runs", "webhook_url",
        "public_link", "new_webhook_secret",
    }
    assert forbidden.isdisjoint(body.keys())
    assert "PRIVATE_TOKEN" not in public.text
    assert "def run" not in public.text


def test_mcp_tools_alias_crud_and_emily_metadata(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    worker_id = f"p2test-mcp-{uuid.uuid4().hex[:8]}"

    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload(worker_id, title="Pass 2 MCP Probe"),
    )
    assert created.status_code == 200, created.text

    tool_name = f"p2test_tool_{uuid.uuid4().hex[:8]}"
    created_tool = client.post(
        "/mcp/tools",
        headers=_headers("user-a"),
        json={
            "name": tool_name,
            "description": "Pass 2 test tool",
            "worker_id": worker_id,
        },
    )
    assert created_tool.status_code == 200, created_tool.text
    tool = created_tool.json()
    assert tool["name"] == tool_name
    assert tool["worker_id"] == worker_id
    assert tool["input_schema"]["type"] == "object"

    listed = client.get("/mcp/tools", headers=_headers("user-a"))
    assert listed.status_code == 200, listed.text
    assert tool_name in {item["name"] for item in listed.json()}

    rpc_list = client.post(
        "/mcp-tools/serve",
        headers=_headers("user-a"),
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
    )
    assert rpc_list.status_code == 200, rpc_list.text
    rpc_tools = rpc_list.json()["result"]["tools"]
    assert tool_name in {item["name"] for item in rpc_tools}

    forwarded_chat_bodies = []

    async def fake_api_call(method, path, request, *, body=None, params=None):
        forwarded_chat_bodies.append((method, path, body))
        return {"reply": "chat ok"}, 200

    monkeypatch.setattr(main, "_api_call", fake_api_call)
    rpc_chat = client.post(
        "/mcp-tools/serve",
        headers=_headers("user-a"),
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "workspace.chat",
                "arguments": {
                    "message": "hello from mcp",
                    "conversation_id": "mcp-thread",
                },
            },
        },
    )
    assert rpc_chat.status_code == 200, rpc_chat.text
    assert forwarded_chat_bodies == [
        (
            "POST",
            "/chat",
            {
                "message": "hello from mcp",
                "source": "mcp",
                "conversation_id": "mcp-thread",
            },
        )
    ]

    updated = client.put(
        f"/mcp/tools/{tool['id']}",
        headers=_headers("user-a"),
        json={"description": "Updated pass 2 test tool"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["description"] == "Updated pass 2 test tool"

    deleted = client.delete(f"/mcp/tools/{tool['id']}", headers=_headers("user-a"))
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["status"] == "deleted"

    chat_service = importlib.import_module("chat_service")
    metadata_names = {item["name"] for item in chat_service.workspace_agent_tool_metadata("user-a")}
    assert {"mcp_tools__list", "mcp_tools__register", "mcp_tools__update", "mcp_tools__delete"} <= metadata_names


def test_secret_values_reject_newlines_and_control_characters(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    newline = client.post(
        "/secrets/P2TEST_SECRET",
        headers=AUTH,
        json={"value": "good\nBAD=injected"},
    )
    tab = client.post(
        "/secrets/P2TEST_SECRET",
        headers=AUTH,
        json={"value": "good\tbad"},
    )
    clean = client.post(
        "/secrets/P2TEST_SECRET",
        headers=AUTH,
        json={"value": "good_value"},
    )

    assert newline.status_code == 400, newline.text
    assert tab.status_code == 400, tab.text
    assert clean.status_code == 200, clean.text
