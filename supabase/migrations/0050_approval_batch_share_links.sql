-- Migration 0050: repository-backed public share links.
--
-- Approval-batch no-login links use this portable store through the engine
-- repository contract. Raw tokens are never persisted; only token_hash is
-- stored.

begin;

create table if not exists public.share_links (
    id text primary key,
    entity_type text not null,
    entity_id text not null default '',
    file_path text not null default '',
    workspace_id text references public.workspaces (id) on delete cascade,
    owner_id uuid not null references auth.users(id) on delete cascade,
    token_hash text not null unique,
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    revoked_at timestamptz
);

alter table public.share_links add column if not exists entity_type text;
alter table public.share_links add column if not exists entity_id text default '';
alter table public.share_links add column if not exists file_path text default '';
alter table public.share_links add column if not exists workspace_id text;
alter table public.share_links add column if not exists owner_id uuid;
alter table public.share_links add column if not exists token_hash text;
alter table public.share_links add column if not exists created_at timestamptz default now();
alter table public.share_links add column if not exists expires_at timestamptz;
alter table public.share_links add column if not exists revoked_at timestamptz;

create unique index if not exists share_links_token_hash_idx
    on public.share_links (token_hash);

create index if not exists share_links_approvals_batch_scope_idx
    on public.share_links (entity_type, workspace_id, owner_id, revoked_at);

create unique index if not exists share_links_active_scope_unique_idx
    on public.share_links (entity_type, entity_id, workspace_id, owner_id)
    where revoked_at is null;

alter table public.share_links enable row level security;
alter table public.share_links force row level security;

drop policy if exists "share_links: workspace owners manage links" on public.share_links;
create policy "share_links: workspace owners manage links"
    on public.share_links
    for all
    using (
        exists (
            select 1
              from public.workspaces
             where workspaces.id = share_links.workspace_id
               and workspaces.owner_user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1
              from public.workspaces
             where workspaces.id = share_links.workspace_id
               and workspaces.owner_user_id = auth.uid()
        )
    );

commit;
