"""GAP 5 (#5) — operators must be able to see the workspace agent's system
instructions and the management tools it can call.

GET /system/workspace-agent returns the resolved system prompt + tool metadata
(names + descriptions). It must never leak secret values.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    # Minimal workspace-agent SKILL.md with the preamble placeholder.
    agent_dir = workers_dir / "workspace-agent"
    agent_dir.mkdir()
    (agent_dir / "SKILL.md").write_text(
        "# Workspace Agent\n\nYou manage the workspace.\n\n{{WORKSPACE_PREAMBLE}}\n",
        encoding="utf-8",
    )
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-wsagent")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "contexts", "chat_service",
    ]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    # Seed a secret to prove its VALUE never appears in the response.
    repos = db.get_repositories()
    repos.secrets.set(user_id="federico", name="OPENAI_API_KEY", value="sk-super-secret-value")

    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-wsagent"}) as client:
        yield client, main
    db.get_repositories.cache_clear()


def test_endpoint_returns_prompt_and_tools(client_and_main):
    client, _main = client_and_main
    resp = client.get("/system/workspace-agent")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["agent_id"] == "workspace-agent"
    # System prompt is the resolved SKILL.md (placeholder expanded).
    assert "You manage the workspace." in body["system_prompt"]
    assert "{{WORKSPACE_PREAMBLE}}" not in body["system_prompt"]
    assert "Workspace snapshot" in body["system_prompt"]
    assert "Secret names: OPENAI_API_KEY" in body["system_prompt"]
    # Tools are present with names + descriptions.
    tools = body["tools"]
    names = {t["name"] for t in tools}
    assert "workers__list_all" in names
    assert "secrets__list_names" in names
    assert "approvals__list_pending" in names
    descriptions = {t["name"]: t["description"] for t in tools}
    assert "status metadata" in descriptions["secrets__list_names"]
    assert "account label" in descriptions["connections__list"]
    assert all(t.get("description") for t in tools)


def test_endpoint_does_not_leak_secret_values(client_and_main):
    client, _main = client_and_main
    body = client.get("/system/workspace-agent").json()
    blob = body["system_prompt"] + str(body["tools"])
    assert "sk-super-secret-value" not in blob


def test_endpoint_requires_auth(client_and_main):
    client, _main = client_and_main
    resp = client.get("/system/workspace-agent", headers={"x-floom-secret": "wrong"})
    assert resp.status_code in (401, 403)
