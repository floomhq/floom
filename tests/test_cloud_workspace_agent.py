from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import apps.api.cloud_workspace_agent as cloud_agent
from apps.api.auth.workspace_context import active_workspace


class _Table:
    def __init__(self, rows=None, error: Exception | None = None):
        self.rows = rows or []
        self.error = error
        self.upserts: list[dict] = []

    def select(self, *_args):
        return self

    def eq(self, *_args):
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        if self.error:
            raise self.error
        return SimpleNamespace(data=self.rows)

    def upsert(self, payload, **_kwargs):
        self.upserts.append(payload)
        return self


class _Client:
    def __init__(self, table: _Table):
        self._table = table

    def table(self, name: str):
        assert name == "workspace_agent_settings"
        return self._table


def test_workspace_agent_reads_supabase_instructions(monkeypatch):
    table = _Table(rows=[{"instructions_md": "# Workspace\n\nCloud instructions"}])
    monkeypatch.setattr(cloud_agent, "get_supabase_service_client", lambda: _Client(table))

    with active_workspace("ws_test"):
        assert cloud_agent.get_workspace_md() == "# Workspace\n\nCloud instructions"


def test_workspace_agent_uses_template_when_row_missing(monkeypatch, tmp_path):
    template = tmp_path / "workspace.md.template"
    template.write_text("# Workspace\n\nTemplate", encoding="utf-8")
    monkeypatch.setattr(cloud_agent.chat_service, "WORKSPACE_MD_TEMPLATE", template)
    table = _Table(rows=[])
    monkeypatch.setattr(cloud_agent, "get_supabase_service_client", lambda: _Client(table))

    with active_workspace("ws_empty"):
        assert cloud_agent.get_workspace_md() == "# Workspace\n\nTemplate"


def test_workspace_agent_writes_supabase_instructions(monkeypatch):
    table = _Table()
    monkeypatch.setattr(cloud_agent, "get_supabase_service_client", lambda: _Client(table))

    with active_workspace("ws_test"):
        cloud_agent.set_workspace_md("# Workspace\n\nSaved")

    assert table.upserts == [
        {"workspace_id": "ws_test", "instructions_md": "# Workspace\n\nSaved"}
    ]


def test_workspace_agent_requires_active_workspace_for_save():
    with pytest.raises(RuntimeError, match="active workspace"):
        cloud_agent.set_workspace_md("# Workspace\n\nSaved")


def test_apply_overrides_replaces_engine_functions(monkeypatch):
    monkeypatch.setattr(cloud_agent.chat_service, "get_workspace_md", Mock())
    monkeypatch.setattr(cloud_agent.chat_service, "set_workspace_md", Mock())
    monkeypatch.setattr(cloud_agent.chat_service, "_build_system_prompt", Mock())

    cloud_agent.apply_cloud_workspace_agent_overrides()

    assert cloud_agent.chat_service.get_workspace_md is cloud_agent.get_workspace_md
    assert cloud_agent.chat_service.set_workspace_md is cloud_agent.set_workspace_md
    assert cloud_agent.chat_service._build_system_prompt is cloud_agent.build_system_prompt


def test_build_system_prompt_uses_engine_skill_fallback(monkeypatch, tmp_path):
    missing_workers = tmp_path / "missing-workers"
    fallback_skill = tmp_path / "engine" / "workers" / "workspace-agent" / "SKILL.md"
    fallback_skill.parent.mkdir(parents=True)
    fallback_skill.write_text(
        "Agent contract\n\n{{WORKSPACE_PREAMBLE}}\n\nDo the work.",
        encoding="utf-8",
    )
    monkeypatch.setattr(cloud_agent.worker_registry, "WORKERS_DIR", missing_workers)
    monkeypatch.setattr(cloud_agent, "_engine_workspace_agent_skill_path", lambda: fallback_skill)
    monkeypatch.setattr(cloud_agent, "get_workspace_md", lambda: "# Workspace\n\nCloud")
    monkeypatch.setattr(
        cloud_agent.chat_service,
        "_build_workspace_preamble",
        lambda user_id: f"## Workspace snapshot\nUser: {user_id}",
    )

    prompt = cloud_agent.build_system_prompt("user-1")

    assert "# Workspace\n\nCloud" in prompt
    assert "Agent contract" in prompt
    assert "## Workspace snapshot\nUser: user-1" in prompt
    assert "{{WORKSPACE_PREAMBLE}}" not in prompt


def test_workspace_agent_skill_prefers_workers_dir(monkeypatch, tmp_path):
    workers_skill = tmp_path / "workers" / "workspace-agent" / "SKILL.md"
    fallback_skill = tmp_path / "engine" / "workers" / "workspace-agent" / "SKILL.md"
    workers_skill.parent.mkdir(parents=True)
    fallback_skill.parent.mkdir(parents=True)
    workers_skill.write_text("from workers dir", encoding="utf-8")
    fallback_skill.write_text("from engine fallback", encoding="utf-8")
    monkeypatch.setattr(cloud_agent.worker_registry, "WORKERS_DIR", tmp_path / "workers")
    monkeypatch.setattr(cloud_agent, "_engine_workspace_agent_skill_path", lambda: fallback_skill)

    assert cloud_agent._workspace_agent_skill_md() == "from workers dir"
