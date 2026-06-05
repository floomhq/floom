from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_brain_asset_access_migration_has_scoped_tables_and_share_tokens():
    text = (ROOT / "supabase" / "migrations" / "0029_brain_asset_access.sql").read_text(
        encoding="utf-8"
    ).lower()

    assert "create table if not exists public.brain_packs" in text
    assert "create table if not exists public.assistants" in text
    assert "create table if not exists public.brain_files" in text
    assert "primary key (workspace_id, id)" in text
    assert "primary key (workspace_id, pack_id, path)" in text
    assert "share_token_hash text unique" in text
    assert "raw_token" not in text
    assert "token text" not in text

    for table in ("brain_packs", "assistants", "brain_files"):
        assert f"alter table public.{table} enable row level security" in text
        assert f"alter table public.{table} force row level security" in text
        assert f"to service_role" in text
        assert f"revoke all privileges on table public.{table} from anon" in text
        assert f"revoke all privileges on table public.{table} from public" in text


def test_cloud_registers_supabase_asset_access_repository():
    startup = (ROOT / "apps" / "api" / "startup.py").read_text(encoding="utf-8")
    repos = (ROOT / "apps" / "api" / "db" / "supabase_repos.py").read_text(encoding="utf-8")

    assert "SupabaseAssetAccessRepository" in startup
    assert "asset_access=SupabaseAssetAccessRepository()" in startup
    assert "class SupabaseAssetAccessRepository" in repos
    assert 'on_conflict="workspace_id,id"' in repos
    assert 'update_builder.eq("workspace_id", asset_workspace_id)' in repos


def test_proxy_promotes_workspace_query_to_header_for_downloads():
    for rel in (
        "web/app/api/proxy/[...path]/route.ts",
        "web/overlay/app/api/proxy/[...path]/route.ts",
    ):
        text = (ROOT / rel).read_text(encoding="utf-8")
        assert 'req.nextUrl.searchParams.get("workspace_id")?.trim()' in text
        assert 'forwardHeaders["x-workeros-workspace"] = activeWorkspace' in text


def test_auth_provider_accepts_workspace_query_for_direct_file_urls():
    text = (ROOT / "apps" / "api" / "auth" / "supabase_provider.py").read_text(
        encoding="utf-8"
    )
    assert 'request.query_params.get("workspace_id")' in text
    assert "or (query_workspace_id or \"\").strip()" in text
