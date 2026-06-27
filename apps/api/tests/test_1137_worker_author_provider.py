"""#1137 - create-mode worker authoring uses the platform provider path."""
from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import yaml

API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_BEDROCK = "bedrock/us.anthropic.claude-sonnet-4-6"
_GEMINI = "gemini/gemini-3.5-flash"


def _load_worker_author_module():
    path = REPO_ROOT / "workers" / "worker-author" / "run.py"
    spec = importlib.util.spec_from_file_location("worker_author_run_for_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_codegen_model_falls_back_to_chat_model(monkeypatch):
    monkeypatch.delenv("WORKEROS_CODEGEN_MODEL", raising=False)
    monkeypatch.setenv("WORKEROS_CHAT_MODEL", _BEDROCK)
    sys.modules.pop("codegen_model", None)

    codegen_model = importlib.import_module("codegen_model")

    assert codegen_model.codegen_model() == _BEDROCK


def test_worker_author_model_falls_back_to_chat_model(monkeypatch):
    worker_author = _load_worker_author_module()
    monkeypatch.delenv("WORKEROS_CODEGEN_MODEL", raising=False)
    monkeypatch.setenv("WORKEROS_CHAT_MODEL", _BEDROCK)

    assert worker_author._codegen_model() == _BEDROCK


def test_worker_author_reports_missing_bedrock_credentials(monkeypatch):
    worker_author = _load_worker_author_module()
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", _BEDROCK)
    for name in (
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_REGION_NAME",
        "AWS_DEFAULT_REGION",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_PROFILE",
    ):
        monkeypatch.delenv(name, raising=False)

    assert "AWS credentials" in worker_author._provider_credentials_error(_BEDROCK)


def test_worker_author_reports_missing_gemini_credentials(monkeypatch):
    worker_author = _load_worker_author_module()
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", _GEMINI)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    assert "GEMINI_API_KEY" in worker_author._provider_credentials_error(_GEMINI)


def test_worker_author_routes_bedrock_through_litellm(monkeypatch):
    worker_author = _load_worker_author_module()
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", _BEDROCK)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("AWS_REGION_NAME", "us-west-2")
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return "OK"

    with patch("litellm.completion", side_effect=fake_completion):
        out = worker_author._codegen_chat(
            messages=[{"role": "system", "content": "S"}, {"role": "user", "content": "u"}],
            max_output_tokens=12,
            temperature=0.2,
            response_format={"type": "json_object"},
        )

    assert out == "OK"
    assert captured["model"] == _BEDROCK
    assert captured["max_tokens"] == 12
    assert captured["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}


def test_worker_author_routes_gemini_through_litellm(monkeypatch):
    worker_author = _load_worker_author_module()
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", _GEMINI)
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return "OK"

    with patch("litellm.completion", side_effect=fake_completion):
        out = worker_author._codegen_chat(
            messages=[{"role": "system", "content": "S"}, {"role": "user", "content": "u"}],
            max_output_tokens=12,
            temperature=0.2,
            response_format={"type": "json_object"},
        )

    assert out == "OK"
    assert captured["model"] == _GEMINI
    assert captured["max_tokens"] == 12
    assert captured["messages"][0]["content"] == "S"


def test_worker_author_parses_first_json_object_with_trailing_text():
    worker_author = _load_worker_author_module()
    raw = '{"worker_yml": "id: w\\n", "run_code": "print(1)"}\n\nHere is why this works.'

    parsed = worker_author._extract_json_object(raw)

    assert parsed["worker_yml"] == "id: w\n"
    assert parsed["run_code"] == "print(1)"


def test_worker_author_repairs_missing_manifest_name_from_suggested_id():
    worker_author = _load_worker_author_module()
    worker_yml = """
schema_version: "0.3"
title: "Topic Bullets"
description: "Create three bullets for a topic."
version: "0.1.0"
trigger:
  type: manual
exec:
  entry: "run.py"
  runner: e2b
  inputs:
    - name: topic
      type: string
      required: true
  outputs:
    - name: bullets
      type: markdown
      required: true
"""
    parsed = {
        "worker_yml": worker_yml,
        "suggested_id": "topic-bullets",
        "run_code": "outputs = {'bullets': '- one\\n- two\\n- three'}\n",
    }

    assert worker_author._validate_generated_bundle(parsed, "make topic bullets") is None


def test_worker_author_repairs_missing_manifest_title_from_name():
    worker_author = _load_worker_author_module()
    worker_yml = """
schema_version: "0.3"
name: "topic-bullets"
description: "Create three bullets for a topic."
version: "0.1.0"
trigger:
  type: manual
exec:
  entry: "run.py"
  runner: e2b
  inputs:
    - name: topic
      type: string
      required: true
  outputs:
    - name: bullets
      type: markdown
      required: true
"""
    parsed = {
        "worker_yml": worker_yml,
        "run_code": "outputs = {'bullets': '- one\\n- two\\n- three'}\n",
    }

    assert worker_author._validate_generated_bundle(parsed, "make topic bullets") is None


def test_worker_author_repairs_exec_inputs_outputs_mapping_shape():
    worker_author = _load_worker_author_module()
    worker_yml = """
schema_version: "0.3"
name: "topic-summary"
title: "Topic Summary"
description: "Create a concise markdown summary for a topic."
version: "0.1.0"
trigger:
  type: manual
exec:
  entry: "run.py"
  runner: e2b
  inputs:
    topic:
      type: string
      required: true
  outputs:
    summary:
      type: markdown
      required: true
"""
    parsed = {
        "worker_yml": worker_yml,
        "run_code": "outputs = {'summary': '# Summary\\n\\nA concise summary.'}\n",
    }

    assert worker_author._validate_generated_bundle(parsed, "summarize a topic") is None
    manifest = worker_author._repair_generated_worker_manifest(
        worker_author._load_manifest(worker_yml),
        prompt="summarize a topic",
    )
    assert manifest["exec"]["inputs"] == [
        {"name": "topic", "type": "string", "required": True}
    ]
    assert manifest["exec"]["outputs"] == [
        {"name": "summary", "type": "markdown", "required": True}
    ]


def test_worker_author_repairs_single_trigger_list():
    worker_author = _load_worker_author_module()
    manifest = worker_author._repair_generated_worker_manifest(
        {
            "schema_version": "0.3",
            "name": "daily-brief",
            "title": "Daily Brief",
            "description": "Daily Brief",
            "version": "0.1.0",
            "trigger": [{"type": "schedule", "cron": "30 5 * * *"}],
            "exec": {"entry": "run.py", "runner": "e2b"},
        },
        prompt="run every morning",
    )

    assert manifest["trigger"] == {"type": "schedule", "cron": "30 5 * * *"}


def test_worker_author_repairs_linear_prompt_connections():
    worker_author = _load_worker_author_module()
    manifest = worker_author._repair_generated_worker_manifest(
        {
            "schema_version": "0.3",
            "name": "linear-triage",
            "title": "Linear Triage",
            "description": "Prioritises Linear issues for review.",
            "version": "0.1.0",
            "trigger": {"type": "manual"},
            "exec": {"entry": "SKILL.md", "runner": "e2b"},
            "connections": [],
        },
        prompt="Create a Linear triage worker",
    )

    assert manifest["connections"] == ["linear"]


def test_worker_author_infers_latest_email_as_gmail_read_connection():
    worker_author = _load_worker_author_module()
    manifest = worker_author._repair_generated_worker_manifest(
        {
            "schema_version": "0.3",
            "name": "email-opportunity-summary",
            "title": "Email Opportunity Summary",
            "description": "Summarises missed opportunities from email.",
            "version": "0.1.0",
            "trigger": {"type": "schedule"},
            "exec": {"entry": "SKILL.md", "runner": "e2b"},
            "connections": [],
        },
        prompt="Every Monday 9am, pull my latest Email and summarise missed opportunities",
    )

    assert manifest["connections"][0]["app"] == "gmail"
    assert "GMAIL_FETCH_EMAILS" in manifest["connections"][0]["allowed_tools"]


def test_worker_author_repairs_gmail_agent_skill_tool_instructions():
    worker_author = _load_worker_author_module()
    parsed = worker_author._repair_generated_bundle(
        {
            "worker_yml": """
schema_version: "0.3"
name: "gmail-hourly-summarizer"
title: "Gmail Hourly Summarizer"
description: "Summarises recent Gmail messages."
version: "0.1.0"
trigger:
  type: "schedule"
exec:
  entry: "SKILL.md"
  runner: "e2b"
connections: []
""",
            "skill_md": "# Gmail Hourly Summarizer\n\nSummarise the latest messages.\n\nCall `finish_with_outputs({...})` when done.",
            "suggested_id": "gmail-hourly-summarizer",
        },
        "Every hour, pull my latest Gmail and summarize missed opportunities.",
    )

    manifest = yaml.safe_load(parsed["worker_yml"])
    assert manifest["connections"][0]["app"] == "gmail"
    assert "GMAIL_FETCH_EMAILS" in manifest["connections"][0]["allowed_tools"]
    assert "composio__gmail__execute" in parsed["skill_md"]
    assert "GMAIL_FETCH_EMAILS" in parsed["skill_md"]
    assert worker_author._validate_generated_bundle(parsed, "Every hour, pull my latest Gmail.") is None


def test_worker_author_repairs_missing_operator_output():
    worker_author = _load_worker_author_module()
    manifest = worker_author._repair_generated_worker_manifest(
        {
            "schema_version": "0.3",
            "name": "gmail-missed-opportunities",
            "title": "Gmail Missed Opportunities",
            "description": "Summarises missed opportunities from Gmail.",
            "version": "0.1.0",
            "trigger": {"type": "schedule"},
            "exec": {"entry": "SKILL.md", "runner": "e2b"},
            "connections": [],
        },
        prompt="Every Monday 9am, pull my latest Gmail and summarize missed opportunities.",
    )

    outputs = manifest["exec"]["outputs"]
    assert outputs == [
        {
            "name": "summary",
            "kind": "scalar",
            "type": "markdown",
            "required": True,
            "label": "Summary",
        }
    ]


def test_worker_author_repairs_known_integration_tools_generically():
    worker_author = _load_worker_author_module()
    manifest = worker_author._repair_generated_worker_manifest(
        {
            "schema_version": "0.3",
            "name": "calendar-slack-brief",
            "title": "Calendar Slack Brief",
            "description": "Summarises calendar events and Slack messages.",
            "version": "0.1.0",
            "trigger": {"type": "manual"},
            "exec": {"entry": "SKILL.md", "runner": "e2b"},
            "connections": [],
        },
        prompt="Create a Google Calendar and Slack digest worker",
    )

    by_app = {item["app"]: item for item in manifest["connections"]}
    assert "GOOGLECALENDAR_EVENTS_LIST" in by_app["googlecalendar"]["allowed_tools"]
    assert "SLACK_FETCH_CONVERSATION_HISTORY" in by_app["slack"]["allowed_tools"]


def test_worker_author_verifier_flags_missing_generic_tool_instruction():
    worker_author = _load_worker_author_module()
    issues = worker_author._deterministic_verifier_issues(
        {
            "worker_yml": """
schema_version: "0.3"
name: "calendar-brief"
title: "Calendar Brief"
description: "Summarises Google Calendar events."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "SKILL.md"
  runner: "e2b"
  outputs:
    - name: "summary"
      kind: "scalar"
      type: "markdown"
connections:
  - app: "googlecalendar"
    allowed_tools:
      - "GOOGLECALENDAR_EVENTS_LIST"
""",
            "skill_md": "# Calendar Brief\n\nSummarise events without naming tools.",
        },
        "Summarize my Google Calendar",
    )

    assert any("composio__googlecalendar__execute" in issue for issue in issues)


def test_worker_author_model_verifier_returns_structured_issues(monkeypatch):
    worker_author = _load_worker_author_module()

    def fake_codegen_chat(**_kwargs):
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content='{"ok": false, "issues": ["SKILL.md invents a tool"]}'
                    )
                )
            ]
        )

    monkeypatch.setattr(worker_author, "_codegen_chat", fake_codegen_chat)

    issues = worker_author._verify_bundle_with_model(
        {
            "worker_yml": 'schema_version: "0.3"\nname: "x"\n',
            "skill_md": "# X",
        },
        "Create a worker",
        lambda *_args, **_kwargs: None,
    )

    assert issues == ["SKILL.md invents a tool"]


def test_worker_author_preserves_existing_connection_objects_when_inferring_prompt_apps():
    worker_author = _load_worker_author_module()
    manifest = worker_author._repair_generated_worker_manifest(
        {
            "schema_version": "0.3",
            "name": "github-slack-digest",
            "title": "GitHub Slack Digest",
            "description": "Sends GitHub activity to Slack.",
            "version": "0.1.0",
            "trigger": {"type": "manual"},
            "exec": {"entry": "SKILL.md", "runner": "e2b"},
            "connections": [{"app": "github", "allowed_tools": ["GITHUB_LIST_PULL_REQUESTS"]}],
        },
        prompt="Create a GitHub PR digest and send it to Slack",
    )

    by_app = {item["app"]: item for item in manifest["connections"]}
    assert "GITHUB_LIST_PULL_REQUESTS" in by_app["github"]["allowed_tools"]
    assert "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS" in by_app["github"]["allowed_tools"]
    assert "SLACK_FETCH_CONVERSATION_HISTORY" in by_app["slack"]["allowed_tools"]


def test_worker_author_moves_api_key_inputs_to_exec_secrets():
    worker_author = _load_worker_author_module()
    manifest = worker_author._repair_generated_worker_manifest(
        {
            "schema_version": "0.3",
            "name": "linear-triage",
            "title": "Linear Triage",
            "description": "Prioritises Linear issues for review.",
            "version": "0.1.0",
            "trigger": {"type": "manual"},
            "exec": {
                "entry": "run.py",
                "runner": "e2b",
                "inputs": [
                    {"name": "team_key", "label": "Team key", "type": "string"},
                    {"name": "linear_api_key", "label": "Linear API key", "type": "string"},
                ],
                "secrets": [],
            },
        },
        prompt="Create a Linear triage worker",
    )

    assert manifest["exec"]["inputs"] == [
        {"name": "team_key", "label": "Team key", "type": "string"}
    ]
    assert manifest["exec"]["secrets"] == ["LINEAR_API_KEY"]


def test_worker_author_infers_secret_name_for_generic_api_key_input():
    worker_author = _load_worker_author_module()
    manifest = worker_author._repair_generated_worker_manifest(
        {
            "schema_version": "0.3",
            "name": "stripe-alerts",
            "title": "Stripe Alerts",
            "description": "Creates Stripe alerts.",
            "version": "0.1.0",
            "trigger": {"type": "manual"},
            "exec": {
                "entry": "run.py",
                "runner": "e2b",
                "inputs": [
                    {"name": "api_key", "label": "API key", "type": "string"},
                    {"name": "minimum_amount", "label": "Minimum amount", "type": "number"},
                ],
            },
        },
        prompt="Create a Stripe alert worker",
    )

    assert manifest["exec"]["inputs"] == [
        {"name": "minimum_amount", "label": "Minimum amount", "type": "number"}
    ]
    assert manifest["exec"]["secrets"] == ["STRIPE_API_KEY"]


def test_worker_author_env_bridge_uses_resolved_model_and_provider_env(monkeypatch):
    from runner_sandbox.e2b_driver import _worker_author_platform_env

    monkeypatch.delenv("WORKEROS_CODEGEN_MODEL", raising=False)
    monkeypatch.setenv("WORKEROS_CHAT_MODEL", _BEDROCK)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("AWS_REGION_NAME", "us-west-2")

    env = _worker_author_platform_env()

    assert env["WORKEROS_CODEGEN_MODEL"] == _BEDROCK
    assert env["AWS_ACCESS_KEY_ID"] == "AKIAEXAMPLE"
    assert env["AWS_SECRET_ACCESS_KEY"] == "secret"
    assert env["AWS_REGION_NAME"] == "us-west-2"


def test_worker_author_env_bridge_forwards_gemini_key(monkeypatch):
    from runner_sandbox.e2b_driver import _worker_author_platform_env

    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", _GEMINI)
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    env = _worker_author_platform_env()

    assert env["WORKEROS_CODEGEN_MODEL"] == _GEMINI
    assert env["GEMINI_API_KEY"] == "test-gemini-key"


def test_worker_author_manifest_does_not_require_byo_ai_key():
    manifest_path = REPO_ROOT / "workers" / "worker-author" / "worker.yml"
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))

    assert (manifest.get("exec") or {}).get("secrets") == []


def test_worker_author_manifest_declares_humane_summary_output():
    manifest_path = REPO_ROOT / "workers" / "worker-author" / "worker.yml"
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    outputs = {field["name"]: field for field in (manifest.get("exec") or {}).get("outputs", [])}

    assert outputs["summary"]["kind"] == "scalar"
    assert outputs["summary"]["type"] == "markdown"
    assert outputs["summary"]["required"] is True
    assert outputs["bundle"]["kind"] == "file"


def test_worker_author_manifest_example_shows_summary_before_bundle():
    manifest_path = REPO_ROOT / "workers" / "worker-author" / "worker.yml"
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    example = manifest["example_output"]

    assert '"summary"' in example
    assert "Worker id:" in example
    assert '"bundle": "out/bundle.json"' in example
    assert '"worker_yml"' not in example


def test_worker_author_bundle_summary_is_operator_readable():
    worker_author = _load_worker_author_module()
    summary = worker_author._bundle_summary(
        {
            "suggested_id": "gmail-intake-brief",
            "worker_yml": 'title: "Gmail Intake Brief"\ndescription: "Summarize unread Gmail each morning."\n',
        },
        "create",
    )

    assert "## Gmail Intake Brief" in summary
    assert "Worker id: `gmail-intake-brief`" in summary
    assert "Summarize unread Gmail each morning." in summary
    assert "out/bundle.json" not in summary


def test_worker_author_prompt_requires_operator_facing_outputs():
    worker_author = _load_worker_author_module()
    prompt = worker_author.SYSTEM_PROMPT_HEADER

    assert "operator-facing output" in prompt
    assert "Gmail/email/CRM/digest/report workers" in prompt
    assert "Never make the only visible output a raw bundle path" in prompt


def test_worker_author_style_uses_scalar_for_readable_outputs():
    style_path = REPO_ROOT / "contexts" / "worker-author-style" / "STYLE.md"
    style = style_path.read_text(encoding="utf-8")

    assert 'kind: "file" for everything' not in style
    assert "operator-facing output" in style
    assert "Gmail/email/CRM/digest workers" in style
    assert 'kind: "scalar"' in style
