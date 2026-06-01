-- Workspace template share links.
--
-- Links are NOT live workspace membership. They let another authenticated user
-- import a sanitized workspace template. Secret values, OAuth tokens, and PATs
-- are never stored in or transferred through this table.

begin;

create table if not exists public.workspace_share_links (
    id text primary key,
    workspace_id text not null references public.workspaces (id) on delete cascade,
    token_hash text not null unique,
    created_by_user_id uuid not null references public.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    revoked_at timestamptz,
    max_uses integer,
    use_count integer not null default 0,
    constraint workspace_share_links_max_uses_positive
        check (max_uses is null or max_uses > 0),
    constraint workspace_share_links_use_count_nonnegative
        check (use_count >= 0)
);

create index if not exists idx_workspace_share_links_workspace
    on public.workspace_share_links (workspace_id, created_at desc);

create index if not exists idx_workspace_share_links_token_hash
    on public.workspace_share_links (token_hash);

alter table public.workspace_share_links enable row level security;
alter table public.workspace_share_links force row level security;

drop policy if exists "Workspace owners manage share links" on public.workspace_share_links;
create policy "Workspace owners manage share links"
    on public.workspace_share_links
    for all
    using (
        exists (
            select 1 from public.workspaces
            where workspaces.id = workspace_share_links.workspace_id
              and workspaces.owner_user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.workspaces
            where workspaces.id = workspace_share_links.workspace_id
              and workspaces.owner_user_id = auth.uid()
        )
    );

commit;
