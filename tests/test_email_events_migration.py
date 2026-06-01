from __future__ import annotations

from pathlib import Path


MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "supabase" / "migrations"


def test_email_events_migration_is_deduped_and_rls_scoped():
    text = (MIGRATIONS_DIR / "0018_email_events.sql").read_text(encoding="utf-8").lower()

    assert "create table if not exists public.email_events" in text
    assert "dedupe_key text not null unique" in text
    assert "workspace_id text references public.workspaces" in text
    assert "alter table public.email_events enable row level security" in text
    assert "auth.uid() = user_id" in text
    assert "create index if not exists idx_email_events_user_kind" in text
