"""#776 — GET /conversations/{id}/export?format=md downloads a transcript.

The Emily 'Export chat' button had no backend. This renders message turns as
markdown with a Content-Disposition attachment header.

Run: cd apps/api && python -m pytest tests/test_conversation_export.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-convexport"
OWNER = "federico"  # shared-secret context default user


def _load(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
    for name in list(sys.modules):
        if name in ("main", "chat_service", "db") or name.startswith("db.") or name == "auth" or name.startswith("auth.") or name.startswith("routers"):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    chat_service = importlib.import_module("chat_service")
    return main, chat_service


def _client(main):
    from fastapi.testclient import TestClient
    return TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)


def test_export_markdown_attachment(monkeypatch, tmp_path):
    main, chat_service = _load(monkeypatch, tmp_path)
    conv_id = chat_service.create_conversation(OWNER, title="Invoice questions")
    chat_service.insert_message(conv_id, "user", "How many invoices are overdue?")
    chat_service.insert_message(conv_id, "assistant", "Three invoices are overdue.")
    chat_service.insert_message(conv_id, "tool", '{"raw": "tool result"}')  # excluded from prose

    with _client(main) as c:
        resp = c.get(f"/conversations/{conv_id}/export?format=md")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/markdown")
    assert "attachment" in resp.headers["content-disposition"]
    assert ".md" in resp.headers["content-disposition"]
    text = resp.text
    assert "# Invoice questions" in text
    assert "## You" in text
    assert "How many invoices are overdue?" in text
    assert "## Emily" in text
    assert "Three invoices are overdue." in text
    assert "tool result" not in text  # tool turns are not in the transcript prose


def test_export_unknown_conversation_404(monkeypatch, tmp_path):
    main, _ = _load(monkeypatch, tmp_path)
    with _client(main) as c:
        assert c.get("/conversations/nope/export?format=md").status_code == 404


def test_export_unsupported_format_422(monkeypatch, tmp_path):
    main, chat_service = _load(monkeypatch, tmp_path)
    conv_id = chat_service.create_conversation(OWNER, title="x")
    with _client(main) as c:
        assert c.get(f"/conversations/{conv_id}/export?format=pdf").status_code == 422
