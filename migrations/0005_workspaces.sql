-- Workspaces v1: a single user can own N personal workspaces.
-- Every workers / runs / connections / secrets row belongs to exactly one
-- workspace. user_id stays on the row as the owner identity, but is no
-- longer the scope key for list/get/upsert/delete; workspace_id is.
--
-- v1 scope (brutally simple): no invites, no roles, no member management.
-- All workspaces are personal — one owner_user_id per workspace.
--
-- Idempotency: every statement is `if not exists` / `if exists` so this
-- migration can be re-run cleanly. The backfill is also idempotent:
-- workers/runs/connections/secrets rows that already have workspace_id
-- set are skipped.

begin;

-- 1. workspaces table
create table if not exists public.workspaces (
    id text primary key,
    owner_user_id uuid not null references public.users (id) on delete cascade,
    name text not null,
    created_at timestamptz not null default now()
);

create index if not exists idx_workspaces_owner_user_id
    on public.workspaces (owner_user_id, created_at);

-- 2. Add nullable workspace_id columns to scoped tables. Nullable for now
--    so the backfill can run; we'll ALTER ... NOT NULL after backfill.
alter table public.workers add column if not exists workspace_id text
    references public.workspaces (id) on delete cascade;
alter table public.runs add column if not exists workspace_id text
    references public.workspaces (id) on delete cascade;
alter table public.connections add column if not exists workspace_id text
    references public.workspaces (id) on delete cascade;
alter table public.secrets add column if not exists workspace_id text
    references public.workspaces (id) on delete cascade;

-- 3. Backfill: for every distinct user_id that owns at least one row in
--    workers / runs / connections / secrets, ensure that user has a
--    default workspace (id = 'ws_default_<short_uuid>'). Name comes from
--    the email prefix in auth.users.
--
--    Uses a CTE that unions the distinct user_ids across all four scoped
--    tables, then upserts a workspace per user. Idempotent: a user who
--    already has a workspace gets nothing inserted (we pick the OLDEST
--    existing one as their default).
do $$
declare
    target_user uuid;
    default_ws_id text;
    user_email text;
    workspace_name text;
begin
    for target_user in
        select distinct user_id from (
            select user_id from public.workers
            union select user_id from public.runs
            union select user_id from public.connections
            union select user_id from public.secrets
        ) as scoped_users
        where user_id is not null
    loop
        -- Prefer an existing oldest workspace for this user, else create one.
        select id into default_ws_id
        from public.workspaces
        where owner_user_id = target_user
        order by created_at, id
        limit 1;

        if default_ws_id is null then
            select email into user_email from auth.users where id = target_user;
            workspace_name := coalesce(
                nullif(split_part(coalesce(user_email, ''), '@', 1), ''),
                'workspace'
            );
            default_ws_id := 'ws_' || replace(gen_random_uuid()::text, '-', '');
            -- Keep the id short and readable.
            default_ws_id := left(default_ws_id, 18);
            insert into public.workspaces (id, owner_user_id, name)
            values (default_ws_id, target_user, workspace_name);
        end if;

        -- Backfill workspace_id on all scoped tables for this user. Only
        -- update rows where workspace_id is still null, so re-runs don't
        -- clobber later workspace assignments.
        update public.workers
            set workspace_id = default_ws_id
            where user_id = target_user and workspace_id is null;
        update public.runs
            set workspace_id = default_ws_id
            where user_id = target_user and workspace_id is null;
        update public.connections
            set workspace_id = default_ws_id
            where user_id = target_user and workspace_id is null;
        update public.secrets
            set workspace_id = default_ws_id
            where user_id = target_user and workspace_id is null;
    end loop;
end $$;

-- 4. Verify backfill before promoting to NOT NULL. If any scoped row
--    still has a null workspace_id, the transaction aborts and the
--    DBA can investigate without leaving partial state.
do $$
declare
    orphan_count integer;
begin
    select
        (select count(*) from public.workers where workspace_id is null)
        + (select count(*) from public.runs where workspace_id is null)
        + (select count(*) from public.connections where workspace_id is null)
        + (select count(*) from public.secrets where workspace_id is null)
    into orphan_count;

    if orphan_count > 0 then
        raise exception
            'workspace backfill incomplete: % rows still have null workspace_id',
            orphan_count;
    end if;
end $$;

-- 5. Promote columns to NOT NULL now that backfill is verified. Wrapped
--    in DO blocks so re-runs don't fail when the column is already
--    non-nullable.
do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'workers'
          and column_name = 'workspace_id'
          and is_nullable = 'YES'
    ) then
        alter table public.workers alter column workspace_id set not null;
    end if;
end $$;

do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'runs'
          and column_name = 'workspace_id'
          and is_nullable = 'YES'
    ) then
        alter table public.runs alter column workspace_id set not null;
    end if;
end $$;

do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'connections'
          and column_name = 'workspace_id'
          and is_nullable = 'YES'
    ) then
        alter table public.connections alter column workspace_id set not null;
    end if;
end $$;

do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'secrets'
          and column_name = 'workspace_id'
          and is_nullable = 'YES'
    ) then
        alter table public.secrets alter column workspace_id set not null;
    end if;
end $$;

-- 6. Indexes for workspace-scoped queries (the new hot path).
create index if not exists idx_workers_workspace_created
    on public.workers (workspace_id, created_at desc);
create index if not exists idx_runs_workspace_created
    on public.runs (workspace_id, created_at desc);
create index if not exists idx_connections_workspace_app
    on public.connections (workspace_id, app_name);
create index if not exists idx_secrets_workspace_name
    on public.secrets (workspace_id, name);

-- 7. Re-key secrets: pre-workspace PK was (user_id, name) which would
--    prevent the same user from having the same secret name in two
--    workspaces. Drop the old PK, replace with (workspace_id, name).
--    user_id stays as the owner column.
do $$
declare
    pk_name text;
begin
    select conname into pk_name
    from pg_constraint
    where conrelid = 'public.secrets'::regclass
      and contype = 'p';
    if pk_name is not null and pk_name <> 'secrets_workspace_name_pkey' then
        execute format('alter table public.secrets drop constraint %I', pk_name);
    end if;
end $$;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.secrets'::regclass
          and contype = 'p'
    ) then
        alter table public.secrets
            add constraint secrets_workspace_name_pkey
            primary key (workspace_id, name);
    end if;
end $$;

commit;
