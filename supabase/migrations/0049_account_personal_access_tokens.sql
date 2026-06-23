-- Account-scoped engine PAT support for cloud.
--
-- Cloud already has workspace-scoped public.api_tokens that mint floom_* tokens.
-- The vendored engine's /auth/tokens route mints account-scoped wos_* tokens
-- through users + user_sessions + personal_access_tokens repositories. These
-- columns/tables mirror the engine SQLite schema while preserving the existing
-- cloud api_tokens surface.

begin;

alter table public.users
    add column if not exists username text,
    add column if not exists display_name text,
    add column if not exists password_hash text,
    add column if not exists role text,
    add column if not exists disabled boolean;

update public.users
set
    username = coalesce(nullif(username, ''), id::text),
    password_hash = coalesce(password_hash, ''),
    role = coalesce(nullif(role, ''), 'member'),
    disabled = coalesce(disabled, false),
    updated_at = coalesce(updated_at, now())
where username is null
   or username = ''
   or password_hash is null
   or role is null
   or role = ''
   or disabled is null;

alter table public.users
    alter column username set not null,
    alter column password_hash set default '',
    alter column password_hash set not null,
    alter column role set default 'member',
    alter column role set not null,
    alter column disabled set default false,
    alter column disabled set not null;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'users_role_check'
          and conrelid = 'public.users'::regclass
    ) then
        alter table public.users
            add constraint users_role_check check (role in ('admin', 'member'));
    end if;
end $$;

create unique index if not exists users_username_key
    on public.users (username);

create index if not exists users_role_idx
    on public.users (role);

create table if not exists public.user_sessions (
    id text primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null
);

create index if not exists user_sessions_user_id_idx
    on public.user_sessions (user_id);

create index if not exists user_sessions_expires_at_idx
    on public.user_sessions (expires_at);

alter table public.user_sessions enable row level security;
alter table public.user_sessions force row level security;

drop policy if exists "Users manage own sessions" on public.user_sessions;
create policy "Users manage own sessions"
    on public.user_sessions
    for all
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

create table if not exists public.personal_access_tokens (
    id text primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    name text not null,
    token_hash text not null,
    last_used_at timestamptz,
    created_at timestamptz not null,
    expires_at timestamptz
);

create unique index if not exists personal_access_tokens_token_hash_key
    on public.personal_access_tokens (token_hash);

create index if not exists personal_access_tokens_user_id_idx
    on public.personal_access_tokens (user_id);

alter table public.personal_access_tokens enable row level security;
alter table public.personal_access_tokens force row level security;

drop policy if exists "Users manage own personal access tokens" on public.personal_access_tokens;
create policy "Users manage own personal access tokens"
    on public.personal_access_tokens
    for all
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

create or replace function public.create_user_session_if_enabled(
    p_session_id text,
    p_user_id uuid,
    p_expires_at timestamptz,
    p_created_at timestamptz
)
returns table (
    id text,
    user_id uuid,
    expires_at timestamptz,
    created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
    insert into public.user_sessions (id, user_id, expires_at, created_at)
    select p_session_id, u.id, p_expires_at, p_created_at
    from public.users u
    where u.id = p_user_id
      and u.disabled = false
    returning
        public.user_sessions.id,
        public.user_sessions.user_id,
        public.user_sessions.expires_at,
        public.user_sessions.created_at;
$$;

revoke all on function public.create_user_session_if_enabled(text, uuid, timestamptz, timestamptz)
    from public, anon, authenticated;
grant execute on function public.create_user_session_if_enabled(text, uuid, timestamptz, timestamptz)
    to service_role;

commit;
