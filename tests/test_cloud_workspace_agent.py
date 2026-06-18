from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import apps.api.cloud_workspace_agent as cloud_agent
from apps.api.routes import workspace_agent as workspace_agent_routes
from apps.api.auth.workspace_context import active_workspace


class _Table:
    def __init__(self, rows=None, error: Exception | None = None):
        self.rows = rows or []
        self.error = error
        self.upserts: list[dict] = []
        self.deleted = False
        self.filters: list[tuple[str, object]] = []

    def select(self, *_args):
        self.filters = []
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        if self.error:
            raise self.error
        rows = self.rows
        for column, value in self.filters:
            rows = [row for row in rows if row.get(column) == value]
        return SimpleNamespace(data=rows)

    def upsert(self, payload, **_kwargs):
        self.upserts.append(payload)
        self.rows = [payload]
        return self

    def delete(self):
        self.deleted = True
        rows = self.rows
        self.rows = []
        self.deleted_rows = rows
        return self


class _Client:
    def __init__(self, table: _Table):
        self._table = table

    def table(self, name: str):
        assert name in {"workspace_agent_settings", "workspace_agent_channel_bindings"}
        return self._table


def test_workspace_agent_reads_supabase_instructions(monkeypatch):
    table = _Table(rows=[{"workspace_id": "ws_test", "instructions_md": "# Workspace\n\nCloud instructions"}])
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


def test_slack_binding_round_trip(monkeypatch):
    table = _Table(
        rows=[
            {
                "id": "wacb_1",
                "workspace_id": "ws_test",
                "channel_type": "slack",
                "external_team_id": "T1",
                "external_channel_id": "C1",
                "external_channel_name": "product",
                "enabled": True,
                "updated_at": "2026-06-01T00:00:00Z",
            }
        ]
    )
    monkeypatch.setattr(cloud_agent, "get_supabase_service_client", lambda: _Client(table))

    binding = cloud_agent.get_slack_binding(workspace_id="ws_test")

    assert binding == {
        "id": "wacb_1",
        "workspace_id": "ws_test",
        "channel_type": "slack",
        "scope": "channel",
        "external_team_id": "T1",
        "external_channel_id": "C1",
        "external_channel_name": "product",
        "enabled": True,
        "updated_at": "2026-06-01T00:00:00Z",
    }


def test_workspace_agent_info_includes_slack_binding(monkeypatch):
    table = _Table(
        rows=[
            {
                "id": "wacb_1",
                "workspace_id": "ws_test",
                "channel_type": "slack",
                "external_team_id": None,
                "external_channel_id": "C1",
                "external_channel_name": None,
                "enabled": True,
                "updated_at": "2026-06-01T00:00:00Z",
            }
        ]
    )
    monkeypatch.setattr(cloud_agent, "get_supabase_service_client", lambda: _Client(table))
    monkeypatch.setattr(
        cloud_agent,
        "_original_workspace_agent_info",
        lambda _user_id: {
            "agent_id": "workspace-agent",
            "model": "gpt-test",
            "system_prompt": "prompt",
            "tools": [],
            "channels": {
                "slack": {
                    "events_configured": True,
                    "bot_configured": True,
                }
            },
        },
    )

    with active_workspace("ws_test"):
        info = cloud_agent.workspace_agent_info("user-1")

    assert info["channels"]["slack"]["binding"]["external_channel_id"] == "C1"
    assert info["channels"]["slack"]["events_configured"] is True


def test_resolve_slack_event_binding_rejects_null_team_channel_rows(monkeypatch):
    table = _Table(
        rows=[
            {
                "id": "wacb_null_team",
                "workspace_id": "ws_wrong",
                "channel_type": "slack",
                "scope": "channel",
                "external_team_id": None,
                "external_channel_id": "C_SHARED",
                "enabled": True,
            }
        ]
    )
    monkeypatch.setattr(cloud_agent, "get_supabase_service_client", lambda: _Client(table))
    monkeypatch.setattr(cloud_agent.workspace_repo, "get", lambda **_kwargs: {"id": "ws_wrong", "owner_user_id": "user_1"})

    assert cloud_agent.resolve_slack_event_binding(team_id="T_ATTACKER", channel_id="C_SHARED") is None


def test_resolve_slack_event_binding_accepts_matching_team_channel_row(monkeypatch):
    table = _Table(
        rows=[
            {
                "id": "wacb_team",
                "workspace_id": "ws_right",
                "channel_type": "slack",
                "scope": "channel",
                "external_team_id": "T_RIGHT",
                "external_channel_id": "C_SHARED",
                "enabled": True,
            }
        ]
    )
    monkeypatch.setattr(cloud_agent, "get_supabase_service_client", lambda: _Client(table))
    monkeypatch.setattr(cloud_agent.workspace_repo, "get", lambda **_kwargs: {"id": "ws_right", "owner_user_id": "user_1"})

    assert cloud_agent.resolve_slack_event_binding(team_id="T_RIGHT", channel_id="C_SHARED") == {
        "workspace_id": "ws_right",
        "owner_user_id": "user_1",
        "workspace_status": "",
        "binding_id": "wacb_team",
        "scope": "channel",
    }


def test_workspace_agent_requires_active_workspace_for_save():
    with pytest.raises(RuntimeError, match="active workspace"):
        cloud_agent.set_workspace_md("# Workspace\n\nSaved")


@pytest.mark.asyncio
async def test_slack_binding_route_denies_workspace_member(monkeypatch):
    upsert = Mock()
    monkeypatch.setattr(workspace_agent_routes, "upsert_slack_binding", upsert)

    payload = workspace_agent_routes.SlackBindingPayload(external_channel_id="C1")
    with active_workspace("ws_test", "member"):
        with pytest.raises(Exception) as exc:
            await workspace_agent_routes.save_slack_binding(payload)

    assert getattr(exc.value, "status_code", None) == 403
    upsert.assert_not_called()


@pytest.mark.asyncio
async def test_slack_binding_route_allows_workspace_admin(monkeypatch):
    upsert = Mock(return_value={"workspace_id": "ws_test", "external_channel_id": "C1"})
    monkeypatch.setattr(workspace_agent_routes, "upsert_slack_binding", upsert)

    payload = workspace_agent_routes.SlackBindingPayload(external_channel_id="C1")
    with active_workspace("ws_test", "admin"):
        result = await workspace_agent_routes.save_slack_binding(payload)

    assert result["binding"]["external_channel_id"] == "C1"
    upsert.assert_called_once()


def test_apply_overrides_replaces_engine_functions(monkeypatch):
    monkeypatch.setattr(cloud_agent.chat_service, "get_workspace_md", Mock())
    monkeypatch.setattr(cloud_agent.chat_service, "set_workspace_md", Mock())
    monkeypatch.setattr(cloud_agent.chat_service, "workspace_agent_info", Mock())
    engine_build = cloud_agent.chat_service._build_system_prompt

    cloud_agent.apply_cloud_workspace_agent_overrides()

    assert cloud_agent.chat_service.get_workspace_md is cloud_agent.get_workspace_md
    assert cloud_agent.chat_service.set_workspace_md is cloud_agent.set_workspace_md
    assert cloud_agent.chat_service.workspace_agent_info is cloud_agent.workspace_agent_info
    # Cloud must NOT override _build_system_prompt. The engine's own builder
    # (signature: user_id, *, include_authoring_rules=False) stays — the prior
    # cloud override took only (user_id) and raised TypeError when the engine
    # called it with include_authoring_rules. Cloud only swaps get_workspace_md
    # so the engine builder reads the Supabase-backed workspace.md.
    assert cloud_agent.chat_service._build_system_prompt is engine_build
