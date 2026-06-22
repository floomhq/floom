begin;

-- Marketplace live layer: reviews, community submissions (moderated), and
-- hire→run provisioning records. All access goes through the FastAPI cloud
-- backend using the service role; anon/authenticated are locked out (RLS
-- forced), matching the repo's service-role-only data posture (0047).

-- ── reviews ──────────────────────────────────────────────────────────────
create table if not exists public.marketplace_reviews (
  id           uuid primary key default gen_random_uuid(),
  item_kind    text not null check (item_kind in ('worker','workspace')),
  item_slug    text not null,
  source       text not null check (source in ('first_party','community')),
  user_id      uuid not null references public.users(id) on delete cascade,
  rating       smallint not null check (rating between 1 and 5),
  body         text not null check (char_length(body) between 1 and 2000),
  status       text not null default 'visible' check (status in ('visible','hidden','removed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (item_kind, item_slug, source, user_id)
);
create index if not exists marketplace_reviews_item_idx
  on public.marketplace_reviews (item_kind, item_slug, source, status);

alter table public.marketplace_reviews enable row level security;
alter table public.marketplace_reviews force row level security;
drop policy if exists "service role full access to marketplace_reviews" on public.marketplace_reviews;
create policy "service role full access to marketplace_reviews"
  on public.marketplace_reviews for all to service_role
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
revoke all on table public.marketplace_reviews from anon;
revoke all on table public.marketplace_reviews from authenticated;

-- ── community submissions (moderated) ────────────────────────────────────
create table if not exists public.marketplace_submissions (
  id                     uuid primary key default gen_random_uuid(),
  submitter_user_id      uuid not null references public.users(id) on delete cascade,
  submitter_workspace_id text references public.workspaces(id) on delete set null,
  item_kind              text not null check (item_kind in ('worker','workspace')),
  source_worker_id       text references public.workers(id) on delete set null,
  title                  text not null,
  slug                   text,
  summary                text not null,
  category               text not null,
  tools_json             jsonb not null default '[]'::jsonb,
  display_json           jsonb not null default '{}'::jsonb,
  bundle_json            jsonb not null,
  status                 text not null default 'pending' check (status in ('pending','approved','rejected','archived')),
  reviewed_by            uuid references public.users(id),
  reviewed_at            timestamptz,
  moderator_note         text,
  published_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists marketplace_submissions_status_idx
  on public.marketplace_submissions (status, published_at desc);
create unique index if not exists marketplace_submissions_approved_slug_idx
  on public.marketplace_submissions (lower(slug)) where status = 'approved';

alter table public.marketplace_submissions enable row level security;
alter table public.marketplace_submissions force row level security;
drop policy if exists "service role full access to marketplace_submissions" on public.marketplace_submissions;
create policy "service role full access to marketplace_submissions"
  on public.marketplace_submissions for all to service_role
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
revoke all on table public.marketplace_submissions from anon;
revoke all on table public.marketplace_submissions from authenticated;

-- ── hire → run provisioning records ──────────────────────────────────────
create table if not exists public.marketplace_hires (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  workspace_id  text not null references public.workspaces(id) on delete cascade,
  item_kind     text not null check (item_kind in ('worker','workspace')),
  item_slug     text not null,
  source        text not null check (source in ('first_party','community')),
  worker_ids    text[] not null default '{}',
  first_run_ids text[] not null default '{}',
  status        text not null default 'provisioning' check (status in ('provisioning','ready','failed')),
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, item_kind, item_slug, source)
);
create index if not exists marketplace_hires_workspace_idx
  on public.marketplace_hires (workspace_id);

alter table public.marketplace_hires enable row level security;
alter table public.marketplace_hires force row level security;
drop policy if exists "service role full access to marketplace_hires" on public.marketplace_hires;
create policy "service role full access to marketplace_hires"
  on public.marketplace_hires for all to service_role
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
revoke all on table public.marketplace_hires from anon;
revoke all on table public.marketplace_hires from authenticated;

commit;
