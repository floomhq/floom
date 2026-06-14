"""#778 — Emily chat attachments: text files are decoded, binaries return metadata."""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "chat-attach-778"


@pytest.fixture
def client(monkeypatch, tmp_path):
    (tmp_path / "workers").mkdir()
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in list(sys.modules):
        if name in ("db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                    "db.interface", "models", "worker_registry", "run_service", "scheduler",
                    "main") or name.startswith("routers"):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient
    yield TestClient(main.app, headers={"x-floom-secret": _SECRET})
    db.get_repositories.cache_clear()


def test_text_attachment_is_decoded(client):
    resp = client.post(
        "/chat/attachments",
        files=[("files", ("notes.md", b"# Title\nhello world", "text/markdown"))],
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    assert body[0]["name"] == "notes.md"
    assert "hello world" in body[0]["text"]
    assert body[0]["truncated"] is False


def test_binary_attachment_returns_metadata_only(client):
    resp = client.post(
        "/chat/attachments",
        files=[("files", ("logo.png", b"\x89PNG\r\n\x1a\n\x00\x01", "image/png"))],
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body[0]["name"] == "logo.png"
    assert body[0]["text"] is None
    assert body[0]["size"] == 10
