-- Migration 0026: lock down accidental public RLS policies.
--
-- The Cloud API uses the Supabase service_role key as the backend data path.
-- Direct anonymous PostgREST access to tenant tables must not expose rows.

begin;

-- Defense in depth for the whole public schema: every current public table is
-- RLS-enabled and forced. service_role keeps BYPASSRLS access.
do $$
declare
    table_row record;
begin
    for table_row in
        select n.nspname as schema_name, c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
    loop
        execute format(
            'alter table %I.%I enable row level security',
            table_row.schema_name,
            table_row.table_name
        );
        execute format(
            'alter table %I.%I force row level security',
            table_row.schema_name,
            table_row.table_name
        );
    end loop;
end $$;

-- asset_versions: previous "service role" policy was implicitly TO public.
drop policy if exists "Users can read their own asset versions"
    on public.asset_versions;
drop policy if exists "Service role full access to asset_versions"
    on public.asset_versions;

create policy "Users can read their own asset versions"
    on public.asset_versions
    for select
    to authenticated
    using (user_id = auth.uid());

create policy "Service role full access to asset_versions"
    on public.asset_versions
    for all
    to service_role
    using (true)
    with check (true);

revoke all privileges on table public.asset_versions from anon;
revoke all privileges on table public.asset_versions from public;
grant select on table public.asset_versions to authenticated;
grant all privileges on table public.asset_versions to service_role;

-- workspace_agent_settings: keep workspace-owner access for authenticated
-- users, but remove the public USING(true) policy and anon table grants.
drop policy if exists "Users can read their own workspace agent settings"
    on public.workspace_agent_settings;
drop policy if exists "Users can write their own workspace agent settings"
    on public.workspace_agent_settings;
drop policy if exists "Service role full access to workspace agent settings"
    on public.workspace_agent_settings;

create policy "Users can read their own workspace agent settings"
    on public.workspace_agent_settings
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.workspaces w
            where w.id = workspace_agent_settings.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

create policy "Users can write their own workspace agent settings"
    on public.workspace_agent_settings
    for all
    to authenticated
    using (
        exists (
            select 1
            from public.workspaces w
            where w.id = workspace_agent_settings.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1
            from public.workspaces w
            where w.id = workspace_agent_settings.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

create policy "Service role full access to workspace agent settings"
    on public.workspace_agent_settings
    for all
    to service_role
    using (true)
    with check (true);

revoke all privileges on table public.workspace_agent_settings from anon;
revoke all privileges on table public.workspace_agent_settings from public;
grant select, insert, update, delete on table public.workspace_agent_settings to authenticated;
grant all privileges on table public.workspace_agent_settings to service_role;

-- workspace_agent_channel_bindings had the same accidental public service-role
-- policy shape as workspace_agent_settings.
drop policy if exists "Users can read their own workspace agent channel bindings"
    on public.workspace_agent_channel_bindings;
drop policy if exists "Users can write their own workspace agent channel bindings"
    on public.workspace_agent_channel_bindings;
drop policy if exists "Service role full access to workspace agent channel bindings"
    on public.workspace_agent_channel_bindings;

create policy "Users can read their own workspace agent channel bindings"
    on public.workspace_agent_channel_bindings
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.workspaces w
            where w.id = workspace_agent_channel_bindings.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

create policy "Users can write their own workspace agent channel bindings"
    on public.workspace_agent_channel_bindings
    for all
    to authenticated
    using (
        exists (
            select 1
            from public.workspaces w
            where w.id = workspace_agent_channel_bindings.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1
            from public.workspaces w
            where w.id = workspace_agent_channel_bindings.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

create policy "Service role full access to workspace agent channel bindings"
    on public.workspace_agent_channel_bindings
    for all
    to service_role
    using (true)
    with check (true);

revoke all privileges on table public.workspace_agent_channel_bindings from anon;
revoke all privileges on table public.workspace_agent_channel_bindings from public;
grant select, insert, update, delete on table public.workspace_agent_channel_bindings to authenticated;
grant all privileges on table public.workspace_agent_channel_bindings to service_role;

commit;
