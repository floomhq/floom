from __future__ import annotations

import re
from pathlib import Path


MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "supabase" / "migrations"


def test_asset_versions_migration_exists_and_enables_rls():
    text = (MIGRATIONS_DIR / "0013_asset_versions.sql").read_text(encoding="utf-8").lower()

    assert "create table if not exists public.asset_versions" in text
    assert "alter table public.asset_versions enable row level security" in text
    assert "asset_versions_asset_idx" in text


def test_workspace_agent_settings_migration_is_idempotent_and_rls_scoped():
    text = (MIGRATIONS_DIR / "0014_workspace_agent_settings.sql").read_text(
        encoding="utf-8"
    ).lower()

    assert "create table if not exists public.workspace_agent_settings" in text
    assert "workspace_id" in text
    assert "instructions_md" in text
    assert "alter table public.workspace_agent_settings enable row level security" in text
    assert "owner_user_id = auth.uid()" in text
    assert not re.search(r"create\s+table\s+(?!if\s+not\s+exists)", text)


def test_workspace_agent_channel_bindings_migration_is_workspace_scoped():
    text = (MIGRATIONS_DIR / "0022_workspace_agent_channel_bindings.sql").read_text(
        encoding="utf-8"
    ).lower()

    assert "create table if not exists public.workspace_agent_channel_bindings" in text
    assert "external_channel_id" in text
    assert "external_team_id" in text
    assert "channel_type in ('slack')" in text
    assert "workspace_agent_channel_bindings_lookup_idx" in text
    assert "alter table public.workspace_agent_channel_bindings enable row level security" in text
    assert "owner_user_id = auth.uid()" in text
    assert not re.search(r"create\s+table\s+(?!if\s+not\s+exists)", text)
