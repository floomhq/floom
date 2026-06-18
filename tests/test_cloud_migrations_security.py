from __future__ import annotations

from pathlib import Path


MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"


def _migration(name: str) -> str:
    return (MIGRATIONS / name).read_text(encoding="utf-8").lower()


def test_asset_versions_workspace_scope_migration():
    text = _migration("0039_asset_versions_workspace_scope.sql")
    assert "add column if not exists workspace_id" in text
    assert "asset_versions_workspace_asset_idx" in text
    assert "asset_versions_workspace_id_idx" in text


def test_skill_versions_workspace_scope_migration():
    text = _migration("0040_skill_versions_workspace_scope.sql")
    assert "add column if not exists workspace_id" in text
    assert "from public.workers w" in text
    assert "sv.id = w.skill_version_id" in text
    assert "skill_versions_workspace_id_pk_lookup_idx" in text


def test_missing_fk_indexes_migration_covers_known_tables():
    text = _migration("0041_missing_fk_indexes.sql")
    for index_name in [
        "approvals_workspace_id_idx",
        "asset_versions_user_id_idx",
        "telemetry_preferences_user_id_idx",
        "telemetry_events_user_id_idx",
        "workspace_share_links_created_by_user_id_idx",
        "workspace_transfer_events_previous_owner_user_id_idx",
        "workspace_transfer_events_new_owner_user_id_idx",
        "mcp_tools_user_id_idx",
        "mcp_tools_worker_id_idx",
        "novasearch_match_queries_user_id_idx",
        "novasearch_issue_reports_user_id_idx",
    ]:
        assert index_name in text


def test_git_workspace_config_rls_filters_active_members_only():
    text = _migration("0042_git_workspace_config_active_member_rls.sql")
    assert "drop policy if exists \"workspace members can read git config\"" in text
    assert "drop policy if exists \"workspace admins can manage git config\"" in text
    assert "status = 'active'" in text
    assert "role = 'admin'" in text


def test_vault_secret_delete_triggers_cover_workspace_cascades():
    text = _migration("0043_vault_secret_delete_triggers.sql")
    assert "before delete on public.secrets" in text
    assert "old.vault_secret_id" in text
    assert "public.workeros_vault_delete_secret(old.vault_secret_id)" in text
    assert "before delete on public.slack_installations" in text
    assert "old.bot_token_encrypted" in text
    assert "public.workeros_vault_delete_secret(old.bot_token_encrypted)" in text
