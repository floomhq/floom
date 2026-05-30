-- 0009_waitlist.sql
-- Public marketing-landing waitlist capture.
--
-- Design constraints (Federico, 2026-05-30):
--   * The landing must POST a waitlist signup using ONLY the public anon key
--     (NEXT_PUBLIC_SUPABASE_ANON_KEY). NO service-role secret on the landing.
--   * Therefore the anon role gets INSERT-ONLY access. It CANNOT select,
--     update, or delete — so the table cannot be enumerated or scraped
--     through the public key, and existing emails cannot be read back.
--   * Duplicate emails are a UNIQUE-constraint violation; the API route
--     treats that conflict as success ("already on the list").

create extension if not exists "pgcrypto";

create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  source      text,
  created_at  timestamptz not null default now()
);

-- Lock the table down: RLS on, no implicit access.
alter table public.waitlist enable row level security;

-- INSERT-ONLY policy for the anon (public) role.
-- with check (true) lets anon insert any row; the absence of any SELECT/
-- UPDATE/DELETE policy means anon has none of those rights. RLS denies by
-- default, so we do NOT need explicit deny policies.
drop policy if exists "waitlist_anon_insert" on public.waitlist;
create policy "waitlist_anon_insert"
  on public.waitlist
  for insert
  to anon
  with check (true);

-- Defensive: ensure anon has only the INSERT table-grant (RLS + grants are
-- both enforced; anon must hold the INSERT privilege for the policy to apply).
grant insert on table public.waitlist to anon;
revoke select, update, delete on table public.waitlist from anon;
