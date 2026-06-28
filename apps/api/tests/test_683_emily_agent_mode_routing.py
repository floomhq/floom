"""Emily must not create workers from natural-language prompts.

Natural-language worker authoring is not reliable enough to expose as an Emily
capability. Emily may inspect, run, and help edit existing workers, but the chat
agent should not receive worker-authoring rules or the async worker-author tool.
"""


def test_worker_authoring_intent_does_not_inject_authoring_rules(monkeypatch):
    import chat_service

    monkeypatch.setattr(chat_service, "get_workspace_base_persona", lambda: "BASE")
    monkeypatch.setattr(chat_service, "_workspace_instructions_context", lambda: "")
    monkeypatch.setattr(chat_service, "_build_workspace_preamble", lambda _user_id: "PREAMBLE")
    monkeypatch.setattr(chat_service, "_build_capabilities_snapshot", lambda _user_id: "SNAPSHOT")

    prompt = chat_service.build_system_prompt_for_source(
        "local-user",
        source="web",
        message="Create a worker that summarizes Gmail every morning",
    )

    assert "workers__create_from_prompt" not in prompt
    assert "## Floom worker.yml format" not in prompt
    assert "Natural-language worker authoring is disabled" not in prompt


def test_workspace_agent_tool_metadata_excludes_create_from_prompt(monkeypatch):
    import chat_service

    monkeypatch.setattr(chat_service, "_brain_read_tools", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(chat_service, "_composio_read_tools", lambda *_args, **_kwargs: [])

    tools = chat_service.workspace_agent_tool_metadata("local-user")
    names = {tool["name"] for tool in tools}

    assert "workers__create_from_prompt" not in names
    assert "workers__create" in names
    assert "workers__run" in names


def test_workers_create_metadata_rejects_drafting_from_prose(monkeypatch):
    import chat_service

    monkeypatch.setattr(chat_service, "_brain_read_tools", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(chat_service, "_composio_read_tools", lambda *_args, **_kwargs: [])

    tools = chat_service.workspace_agent_tool_metadata("local-user")
    create_tool = next(tool for tool in tools if tool["name"] == "workers__create")
    description = create_tool["description"].lower()

    assert "complete worker.yml yaml bundle" in description
    assert "only call this tool when the user provides a complete yaml bundle" in description
    assert "never draft" in description
    assert "natural-language request" in description
    assert "dashboard prompt-based worker creation is currently unavailable" in description


def test_workspace_agent_info_reports_no_authoring_rules(monkeypatch):
    import chat_service

    monkeypatch.setattr(chat_service, "get_workspace_base_persona", lambda: "BASE")
    monkeypatch.setattr(chat_service, "_build_workspace_preamble", lambda _user_id: "PREAMBLE")
    monkeypatch.setattr(chat_service, "_build_capabilities_snapshot", lambda _user_id: "SNAPSHOT")
    monkeypatch.setattr(chat_service, "workspace_agent_tool_metadata", lambda _user_id: [])

    info = chat_service.workspace_agent_info("local-user")

    assert info["worker_authoring_rules"] == ""
    assert "workers__create_from_prompt" not in info["system_prompt"]


def test_worker_bundle_missing_skill_md_causes_agent_failure(tmp_path):
    """Validate that agent-mode workers without SKILL.md fail the entrypoint check."""
    bundle = tmp_path / "myworker"
    bundle.mkdir()
    (bundle / "worker.yml").write_text(
        'schema_version: "0.3"\n'
        'name: "myworker"\n'
        'exec:\n'
        '  mode: "agent"\n'
        '  entry: "SKILL.md"\n'
        '  runner: "e2b"\n',
        encoding="utf-8",
    )

    assert not (bundle / "SKILL.md").exists()


def test_worker_bundle_with_skill_md_passes_check(tmp_path):
    """A bundle with SKILL.md present must pass the entrypoint check."""
    bundle = tmp_path / "goodworker"
    bundle.mkdir()
    (bundle / "SKILL.md").write_text("# Good Worker\n\nDoes the thing.\n", encoding="utf-8")

    assert (bundle / "SKILL.md").exists()
