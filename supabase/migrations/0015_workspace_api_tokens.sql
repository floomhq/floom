-- Workspace-scoped Cloud API tokens.
--
-- 0010 created PATs at user scope only, which made the same token usable in
-- every workspace owned by that user. Cloud agents need per-workspace tokens:
-- a token minted while workspace A is active must not authenticate workspace B.

begin;

alter table public.api_tokens
    add column if not exists workspace_id text
    references public.workspaces (id) on delete cascade;

-- Ensure token owners with no workspace row yet get one, then backfill each
-- legacy token to the owner's oldest workspace. Idempotent and non-clobbering.
do $$
declare
    target_user uuid;
    default_ws_id text;
    user_email text;
    workspace_name text;
begin
    for target_user in
        select distinct user_id
        from public.api_tokens
        where user_id is not null
    loop
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
            default_ws_id := left(default_ws_id, 18);
            insert into public.workspaces (id, owner_user_id, name)
            values (default_ws_id, target_user, workspace_name);
        end if;

        update public.api_tokens
            set workspace_id = default_ws_id
            where user_id = target_user and workspace_id is null;
    end loop;
end $$;

do $$
declare
    orphan_count integer;
begin
    select count(*)
    from public.api_tokens
    where workspace_id is null
    into orphan_count;

    if orphan_count > 0 then
        raise exception
            'api token workspace backfill incomplete: % rows still have null workspace_id',
            orphan_count;
    end if;
end $$;

do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'api_tokens'
          and column_name = 'workspace_id'
          and is_nullable = 'YES'
    ) then
        alter table public.api_tokens alter column workspace_id set not null;
    end if;
end $$;

create index if not exists api_tokens_workspace_id_idx
    on public.api_tokens (workspace_id, created_at);

-- Keep dashboard RLS user-bound, with an explicit workspace ownership check.
drop policy if exists "Users manage own tokens" on public.api_tokens;
create policy "Users manage own workspace tokens"
    on public.api_tokens
    for all
    using (
        user_id = auth.uid()
        and exists (
            select 1
            from public.workspaces w
            where w.id = api_tokens.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1
            from public.workspaces w
            where w.id = api_tokens.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

commit;
