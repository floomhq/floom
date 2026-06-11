"""#780 — brain file tags persist via PUT and surface on the context detail."""
from __future__ import annotations

import importlib
import json
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
    (contexts_dir / ".workeros-contexts.json").write_text(
        json.dumps({"alpha": {"writeable": True, "owner_id": "testuser"}}),
        encoding="utf-8",
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


def test_tags_persist_and_surface(client):
    resp = client.put(
        "/contexts/alpha/files/notes.txt",
        json={"content": "hello\n", "tags": ["policy", "hr"]},
        headers=_H,
    )
    assert resp.status_code == 200, resp.text

    detail = client.get("/contexts/alpha", headers=_H)
    assert detail.status_code == 200, detail.text
    by_path = {f["path"]: f for f in detail.json()["files"]}
    assert set(by_path["notes.txt"].get("tags") or []) == {"policy", "hr"}
