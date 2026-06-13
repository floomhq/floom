"""#777 — read-only SQLite inspect: list tables + read rows of a brain .db."""
from __future__ import annotations

import importlib
import json
import sqlite3
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def client(monkeypatch, tmp_path):
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    pack = contexts_dir / "alpha"
    pack.mkdir()
    (pack / "notes.txt").write_text("hello\n", encoding="utf-8")
    # A small real SQLite db with one table + two rows.
    db = sqlite3.connect(pack / "data.db")
    db.execute("CREATE TABLE users (id INTEGER, name TEXT)")
    db.executemany("INSERT INTO users VALUES (?, ?)", [(1, "alice"), (2, "bob")])
    db.commit()
    db.close()
    (contexts_dir / ".workeros-contexts.json").write_text(
        json.dumps({"alpha": {"writeable": True, "owner_id": "testuser"}}), encoding="utf-8"
    )
    (tmp_path / "workers").mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "testuser")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in list(sys.modules):
        if any(name == m or name.startswith(m + ".") for m in [
            "main", "db", "models", "files", "worker_registry", "runner_utils",
            "run_service", "webhook_service", "composio_client", "scheduler",
            "auth", "contexts", "chat_service", "git_ops", "github_api",
            "alerting", "mcp_server",
        ]):
            sys.modules.pop(name)
        for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
            sys.modules.pop(_rn, None)
    for stub in ["e2b", "e2b.sandbox", "openai", "anthropic", "composio_openai",
                 "composio_core", "slowapi", "slowapi.util", "slowapi.errors",
                 "resend", "supabase", "gotrue"]:
        sys.modules.setdefault(stub, types.ModuleType(stub))
    git_ops_stub = types.ModuleType("git_ops")
    for fn in ["commit_paths", "push_background", "get_log", "get_file_at_sha",
               "list_files_at_sha", "checkout_path", "ensure_repo", "get_active_workspace_id"]:
        setattr(git_ops_stub, fn, MagicMock(return_value=None))
    git_ops_stub.GitOpsError = Exception
    sys.modules["git_ops"] = git_ops_stub

    main_mod = importlib.import_module("main")
    from fastapi.testclient import TestClient
    with TestClient(main_mod.app) as c:
        yield c
    sys.modules.pop("git_ops", None)


_H = {"x-floom-secret": "test-secret"}


def test_list_tables(client):
    resp = client.get("/contexts/alpha/sqlite/data.db", headers=_H)
    assert resp.status_code == 200, resp.text
    assert resp.json()["tables"] == ["users"]


def test_read_table_rows(client):
    resp = client.get("/contexts/alpha/sqlite/data.db?table=users", headers=_H)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["columns"] == ["id", "name"]
    assert body["rows"] == [[1, "alice"], [2, "bob"]]
    assert body["row_count"] == 2
    assert body["truncated"] is False


def test_unknown_table_404_and_non_db_400(client):
    assert client.get("/contexts/alpha/sqlite/data.db?table=nope", headers=_H).status_code == 404
    assert client.get("/contexts/alpha/sqlite/notes.txt", headers=_H).status_code == 400
