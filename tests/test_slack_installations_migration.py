from __future__ import annotations

import re
from pathlib import Path


MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "supabase" / "migrations"


def _text() -> str:
    path = MIGRATIONS_DIR / "0034_slack_installations.sql"
    assert path.is_file(), f"migration file missing: {path}"
    return path.read_text(encoding="utf-8").lower()


def test_slack_installations_migration_enables_unclaimed_workspaces():
    text = _text()
    assert "alter column owner_user_id drop not null" in text
    assert "workspace_status text not null default 'claimed'" in text
    assert "created_by_installation_id uuid" in text
    assert "workspace_status in ('unclaimed', 'claimed', 'claim_pending', 'revoked', 'uninstalled')" in text


def test_slack_installations_store_vault_id_not_plaintext_token():
    text = _text()
    assert "create table if not exists public.slack_installations" in text
    assert "team_id                   text primary key" in text
    assert "bot_token_encrypted       uuid" in text
    assert "supabase vault secret uuid" in text
    assert "access_token" not in text
    assert "bot_token text" not in text


def test_slack_install_claims_are_hashed_bound_and_single_use():
    text = _text()
    assert "create table if not exists public.slack_install_claims" in text
    assert "token_hash                 text not null unique" in text
    assert "team_id                    text not null references public.slack_installations(team_id)" in text
    assert "installation_id            uuid not null references public.slack_installations(installation_id)" in text
    assert "installer_slack_user_id    text not null" in text
    assert "verification_slack_user_id text" in text
    assert "add column if not exists verification_slack_user_id text" in text
    assert "used_at                    timestamptz" in text
    assert "verification_code_hash" in text
    assert "raw_token" not in text


def test_slack_team_level_binding_shape_is_supported():
    text = _text()
    assert "add column if not exists scope text not null default 'channel'" in text
    assert "scope in ('channel', 'team')" in text
    assert "alter column external_channel_id drop not null" in text
    assert "workspace_agent_channel_bindings_team_fallback_idx" in text


def test_slack_migration_is_idempotent_and_rls_locked():
    text = _text()
    assert not re.search(r"create\s+table\s+(?!if\s+not\s+exists)", text)
    assert not re.search(r"create\s+(?:unique\s+)?index\s+(?!if\s+not\s+exists)", text)
    assert "if not exists" in text
    assert "alter table public.slack_installations force row level security" in text
    assert "alter table public.slack_install_claims force row level security" in text
    assert "alter table public.slack_sender_bindings force row level security" in text
    assert "auth.role() = 'service_role'" in text
    assert "w.owner_user_id = auth.uid()" in text


def test_slack_installation_upsert_rpc_serializes_workspace_creation():
    text = _text()
    assert "create or replace function public.upsert_slack_installation_cloud" in text
    assert "pg_advisory_xact_lock(hashtextextended(p_team_id, 0))" in text
    assert "for update" in text
    assert "on conflict (team_id) do update" in text
    assert "insert into public.workspaces" in text
