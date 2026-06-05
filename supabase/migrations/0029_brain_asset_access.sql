-- Migration 0029: brain asset access mirrors.
--
-- The OSS engine stores Brain pack files on disk and keeps ownership metadata
-- beside those files. Cloud needs Supabase mirror rows for workspace visibility,
-- permissions, and future noindex share-token lookups.

begin;

create table if not exists public.brain_packs (
    workspace_id text not null references public.workspaces(id) on delete cascade,
    id text not null,
    owner_id uuid not null references auth.users(id) on delete cascade,
    visibility text not null default 'private'
        check (visibility in ('private', 'workspace', 'specific_people')),
    name text not null,
    metadata_json jsonb not null default '{}'::jsonb,
    share_token_hash text unique,
    share_token_expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (workspace_id, id)
);

create index if not exists idx_brain_packs_owner_id
    on public.brain_packs(owner_id);

create index if not exists idx_brain_packs_share_token_hash
    on public.brain_packs(share_token_hash)
    where share_token_hash is not null;

create table if not exists public.assistants (
    workspace_id text not null references public.workspaces(id) on delete cascade,
    id text not null,
    owner_id uuid not null references auth.users(id) on delete cascade,
    visibility text not null default 'workspace'
        check (visibility in ('private', 'workspace', 'specific_people')),
    name text not null default 'Workspace assistant',
    config_json jsonb not null default '{}'::jsonb,
    instructions_md text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (workspace_id, id)
);

create index if not exists idx_assistants_owner_id
    on public.assistants(owner_id);

create table if not exists public.brain_files (
    workspace_id text not null,
    pack_id text not null,
    path text not null,
    owner_id uuid not null references auth.users(id) on delete cascade,
    metadata_json jsonb not null default '{}'::jsonb,
    share_token_hash text unique,
    share_token_expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (workspace_id, pack_id, path),
    foreign key (workspace_id, pack_id)
        references public.brain_packs(workspace_id, id)
        on delete cascade
);

create index if not exists idx_brain_files_owner_id
    on public.brain_files(owner_id);

create index if not exists idx_brain_files_share_token_hash
    on public.brain_files(share_token_hash)
    where share_token_hash is not null;

alter table public.brain_packs enable row level security;
alter table public.brain_packs force row level security;
alter table public.assistants enable row level security;
alter table public.assistants force row level security;
alter table public.brain_files enable row level security;
alter table public.brain_files force row level security;

drop policy if exists "Service role full access to brain packs"
    on public.brain_packs;
drop policy if exists "Service role full access to assistants"
    on public.assistants;
drop policy if exists "Service role full access to brain files"
    on public.brain_files;

create policy "Service role full access to brain packs"
    on public.brain_packs
    for all
    to service_role
    using (true)
    with check (true);

create policy "Service role full access to assistants"
    on public.assistants
    for all
    to service_role
    using (true)
    with check (true);

create policy "Service role full access to brain files"
    on public.brain_files
    for all
    to service_role
    using (true)
    with check (true);

revoke all privileges on table public.brain_packs from anon;
revoke all privileges on table public.brain_packs from public;
revoke all privileges on table public.assistants from anon;
revoke all privileges on table public.assistants from public;
revoke all privileges on table public.brain_files from anon;
revoke all privileges on table public.brain_files from public;

grant all privileges on table public.brain_packs to service_role;
grant all privileges on table public.assistants to service_role;
grant all privileges on table public.brain_files to service_role;

commit;
