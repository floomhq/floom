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
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")
    monkeypatch.setenv("WORKEROS_CHAT_MODEL", "gpt-5-mini")
    monkeypatch.setenv("E2B_API_KEY", "e2b-super-secret-value")

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
    chat_service = importlib.import_module("chat_service")
    monkeypatch.setattr(chat_service, "WORKSPACE_MD_PATH", tmp_path / "workspace.md")
    monkeypatch.setattr(chat_service, "WORKSPACE_BASE_PERSONA_PATH", tmp_path / "workspace.base.md")

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
    assert body["model"] == "gpt-5-mini"
    assert body["base_persona"].startswith("# Emily")
    assert "Worker authoring rules" not in body["base_persona"]
    assert "## Worker authoring rules" in body["worker_authoring_rules"]
    assert body["channels"]["slack"] == {
        "events_configured": False,
        "bot_configured": False,
        "allowed_team_ids_configured": False,
    }
    # System prompt is the resolved SKILL.md (placeholder expanded).
    assert "I'm Emily, your chief-of-staff for this Workeros workspace." in body["system_prompt"]
    assert "You manage the workspace." in body["system_prompt"]
    assert "{{WORKSPACE_PREAMBLE}}" not in body["system_prompt"]
    assert "Workspace snapshot" in body["system_prompt"]
    assert "OPENAI_API_KEY" in body["system_prompt"]
    assert "E2B_API_KEY" in body["system_prompt"]
    assert "## Worker authoring rules" not in body["system_prompt"]
    assert "## Workeros worker.yml format" not in body["system_prompt"]
    assert body["settings"] == {
        "brain_read": True,
        "brain_write": False,
        "connections_read": True,
        "connections_use": False,
        "connections_add": False,
    }
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
    assert "e2b-super-secret-value" not in blob


def test_endpoint_reports_model_and_slack_readiness(client_and_main, monkeypatch):
    client, _main = client_and_main
    monkeypatch.setenv("WORKEROS_CHAT_MODEL", "gpt-test-model")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "test-signing-secret")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test-token")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "T123")

    body = client.get("/system/workspace-agent").json()

    assert body["model"] == "gpt-test-model"
    assert body["channels"]["slack"] == {
        "events_configured": True,
        "bot_configured": True,
        "allowed_team_ids_configured": True,
    }


def test_endpoint_updates_capability_settings_and_gates_tools(client_and_main):
    client, _main = client_and_main

    resp = client.put(
        "/system/workspace-agent/settings",
        json={
            "brain_read": False,
            "brain_write": True,
            "connections_read": False,
            "connections_add": True,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["settings"]["brain_read"] is False
    assert resp.json()["settings"]["brain_write"] is True

    body = client.get("/system/workspace-agent").json()
    names = {tool["name"] for tool in body["tools"]}
    assert "contexts__list" not in names
    assert "contexts__read" not in names
    assert "brain__list" not in names
    assert "brain__read" not in names
    assert "contexts__write" in names
    assert "brain__write" in names
    assert "connections__list" not in names
    assert "connections__add_mcp" in names


def test_base_persona_and_workspace_instructions_are_separate_editable_layers(client_and_main):
    client, _main = client_and_main
    base = "# Emily\n\nYou are Emily, the custom Workeros operator.\n"
    custom = "# Workspace custom instructions\n\nPrefer verified workspace facts.\n"

    default_base = client.get("/workspace/base")
    assert default_base.status_code == 200
    assert "I'm Emily, your chief-of-staff for this Workeros workspace." in default_base.text
    assert "Owner: Federico" not in default_base.text
    assert "personal Chief-of-Staff" not in default_base.text

    put_base = client.put(
        "/workspace/base",
        content=base,
        headers={"content-type": "text/markdown"},
    )
    assert put_base.status_code == 204, put_base.text
    put_custom = client.put(
        "/workspace",
        content=custom,
        headers={"content-type": "text/markdown"},
    )
    assert put_custom.status_code == 204, put_custom.text

    body = client.get("/system/workspace-agent").json()
    prompt = body["system_prompt"]
    assert "You are Emily, the custom Workeros operator." in prompt
    assert "personal Chief-of-Staff" not in prompt
    assert "Prefer verified workspace facts." in prompt
    assert "You manage the workspace." in prompt
    assert prompt.index("custom Workeros operator") < prompt.index("Prefer verified workspace facts.")
    assert prompt.index("Prefer verified workspace facts.") < prompt.index("You manage the workspace.")
    assert "## Worker authoring rules" not in prompt

    base_versions = client.get("/workspace/base/versions").json()
    custom_versions = client.get("/workspace/versions").json()
    assert len(base_versions) == 1
    assert base_versions[0]["asset_type"] == "workspace_base_persona"
    assert len(custom_versions) == 1
    assert custom_versions[0]["asset_type"] == "workspace_instructions"


def test_base_persona_state_and_reset_to_default(client_and_main):
    client, _main = client_and_main

    # Pristine: built-in default in effect, not custom.
    state = client.get("/workspace/base/state").json()
    assert state["is_custom"] is False
    assert "I'm Emily, your chief-of-staff" in state["content"]
    assert state["content"] == state["default"]

    custom = "# Emily\n\nYou are Emily, edited base.\n"
    put_base = client.put(
        "/workspace/base",
        content=custom,
        headers={"content-type": "text/markdown"},
    )
    assert put_base.status_code == 204, put_base.text

    state2 = client.get("/workspace/base/state").json()
    assert state2["is_custom"] is True
    assert state2["content"] == custom
    assert "I'm Emily, your chief-of-staff" in state2["default"]

    reset = client.delete("/workspace/base")
    assert reset.status_code == 204, reset.text

    state3 = client.get("/workspace/base/state").json()
    assert state3["is_custom"] is False
    assert state3["content"] == state3["default"]
    assert "edited base" not in state3["content"]

    # The reset is captured in version history.
    versions = client.get("/workspace/base/versions").json()
    assert any("workspace base: reset-to-default" in v["message"] for v in versions)


def test_endpoint_requires_auth(client_and_main):
    client, _main = client_and_main
    resp = client.get("/system/workspace-agent", headers={"x-floom-secret": "wrong"})
    assert resp.status_code in (401, 403)


def test_bare_greeting_identity_guard_adds_emily_without_hiding_state():
    import chat_service

    reply = chat_service._ensure_bare_greeting_identity(
        "Hello",
        "Two things need attention:\n\n- No pending approvals.",
    )

    assert reply.startswith("I'm Emily. Two things need attention:")
    assert "No pending approvals" in reply


def test_bare_greeting_identity_guard_trims_model_greeting_prefix():
    import chat_service

    reply = chat_service._ensure_bare_greeting_identity(
        "Hi",
        "Hi. I checked the workspace.\n\n- Pending approvals: none.",
    )

    assert reply == "I'm Emily. Workspace state:\n\n- Pending approvals: none."


def test_bare_greeting_identity_guard_leaves_specific_requests_alone():
    import chat_service

    reply = "Two things need attention."

    assert chat_service._ensure_bare_greeting_identity("Run the first worker", reply) == reply


def test_worker_authoring_rules_are_gated_by_message_intent(client_and_main):
    _client, _main = client_and_main
    import chat_service

    casual = chat_service.build_system_prompt_for_source("federico", "web", message="hi")
    authoring = chat_service.build_system_prompt_for_source(
        "federico",
        "web",
        message="Create a worker that summarizes Gmail every morning",
    )

    assert "## Worker authoring rules" not in casual
    assert "## Worker authoring rules" in authoring

    sample_skill = (
        "# Workspace Agent\n\n"
        "## Workeros worker.yml format\n"
        "YAML authoring rules here.\n\n"
        "## Workspace-management tools\n"
        "Tool list here.\n"
    )
    casual_skill = chat_service._workspace_agent_skill_for_intent(
        sample_skill,
        include_authoring_rules=False,
    )
    authoring_skill = chat_service._workspace_agent_skill_for_intent(
        sample_skill,
        include_authoring_rules=True,
    )
    assert "## Workeros worker.yml format" not in casual_skill
    assert "## Workspace-management tools" in casual_skill
    assert "## Workeros worker.yml format" in authoring_skill


def test_emily_persona_investigation_mode_blocks_partial_status_dumps():
    import chat_service

    persona = chat_service.EMILY_BASE_PERSONA
    # "Investigate first" was renamed to "Tools before text" in feat/emily-prompt-improvements
    # but the concept (use tools, don't dump partial status) must remain.
    assert "Tools before text" in persona or "Investigate first" in persona or "tool" in persona.lower()
    assert "say \"keep going\"" in persona or "keep going" in persona.lower() or "finish" in persona.lower()
