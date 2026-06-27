from __future__ import annotations

from types import SimpleNamespace

import chat_service
from services import chat_tool_impls
from services.chat_tool_cards import build_tool_event_metadata


class _Connections:
    def __init__(self, rows):
        self._rows = rows

    def list(self, *, user_id: str):
        return list(self._rows)


def _set_repos(monkeypatch, rows):
    repos = SimpleNamespace(connections=_Connections(rows))
    monkeypatch.setattr("db.get_repositories", lambda: repos)


def test_create_from_prompt_requires_gmail_connection_for_email_worker(monkeypatch):
    _set_repos(monkeypatch, [])
    token = chat_service._current_chat_conversation_id.set("conv_1")
    try:
        result = chat_tool_impls._tool_workers_create_from_prompt(
            {
                "prompt": "Every Monday at 9am, pull my latest email and summarize missed opportunities.",
                "idempotency_key": "key_1",
            },
            "user_1",
        )
    finally:
        chat_service._current_chat_conversation_id.reset(token)

    assert result["ok"] is False
    assert result["error_code"] == "missing_connection"
    assert result["app_name"] == "gmail"
    assert "Connect Gmail" in result["message"]


def test_create_from_prompt_allows_email_worker_with_active_gmail(monkeypatch):
    _set_repos(
        monkeypatch,
        [{"app_name": "gmail", "status": "active", "id": "conn_1"}],
    )
    monkeypatch.setattr(
        chat_service,
        "_idempotent_worker_author_run",
        lambda **kwargs: {
            "ok": True,
            "run_id": "run_1",
            "worker_id": "worker-author",
            "status": "running",
        },
    )
    token = chat_service._current_chat_conversation_id.set("conv_1")
    try:
        result = chat_tool_impls._tool_workers_create_from_prompt(
            {
                "prompt": "Every Monday at 9am, pull my latest email and summarize missed opportunities.",
                "idempotency_key": "key_1",
            },
            "user_1",
        )
    finally:
        chat_service._current_chat_conversation_id.reset(token)

    assert result["ok"] is True
    assert result["run_id"] == "run_1"


def test_missing_connection_result_builds_connection_action_metadata():
    metadata = build_tool_event_metadata(
        "workers__create_from_prompt",
        "call_1",
        args={"prompt": "Check my latest email every Monday."},
        result={
            "ok": False,
            "error_code": "missing_connection",
            "app_name": "gmail",
            "message": "Connect Gmail before I create this worker.",
        },
        phase="result",
    )

    assert metadata["reason"] == "missing_connection"
    assert metadata["resource"] == {
        "kind": "connection",
        "app_name": "gmail",
        "status": "missing",
    }
    assert metadata["actions"] == [
        {"id": "connect", "method": "POST", "href": "/connections", "body": {"app_name": "gmail"}}
    ]
