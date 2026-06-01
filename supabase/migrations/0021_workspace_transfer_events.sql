-- Workspace transfer audit events.
--
-- Ownership transfer is owner-only through the API. Browser clients can read
-- transfer events only for workspaces they currently own; service_role writes
-- audit rows during the transfer flow.

begin;

create table if not exists public.workspace_transfer_events (
    id text primary key,
    workspace_id text not null references public.workspaces (id) on delete cascade,
    previous_owner_user_id uuid not null references public.users (id) on delete restrict,
    new_owner_user_id uuid not null references public.users (id) on delete restrict,
    actor_user_id uuid not null references public.users (id) on delete restrict,
    revoked_api_tokens integer not null default 0 check (revoked_api_tokens >= 0),
    retained_authority text[] not null default '{}'::text[],
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_workspace_transfer_events_workspace_created
    on public.workspace_transfer_events (workspace_id, created_at desc);

create index if not exists idx_workspace_transfer_events_actor_created
    on public.workspace_transfer_events (actor_user_id, created_at desc);

alter table public.workspace_transfer_events enable row level security;
alter table public.workspace_transfer_events force row level security;

drop policy if exists "Workspace owners can read transfer events"
    on public.workspace_transfer_events;

create policy "Workspace owners can read transfer events"
    on public.workspace_transfer_events
    for select
    using (
        exists (
            select 1
            from public.workspaces
            where workspaces.id = workspace_transfer_events.workspace_id
              and workspaces.owner_user_id = auth.uid()
        )
    );

-- Composite owner foreign keys are already part of the schema. Ownership
-- transfer needs those checks deferred while all related rows move together.
alter table public.workers
    alter constraint workers_skill_version_fkey deferrable initially immediate;
alter table public.worker_webhook_secrets
    alter constraint worker_webhook_secrets_worker_fkey deferrable initially immediate;
alter table public.runs
    alter constraint runs_worker_fkey deferrable initially immediate;
alter table public.run_logs
    alter constraint run_logs_run_fkey deferrable initially immediate;
alter table public.artifacts
    alter constraint artifacts_run_fkey deferrable initially immediate;

create or replace function public.transfer_workspace_ownership(
    p_workspace_id text,
    p_current_owner uuid,
    p_new_owner uuid,
    p_actor_user_id uuid,
    p_event_id text,
    p_retained_authority text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    workspace_row public.workspaces%rowtype;
    worker_ids text[] := array[]::text[];
    run_ids text[] := array[]::text[];
    revoked_api_tokens integer := 0;
    revoked_share_links integer := 0;
begin
    if p_current_owner = p_new_owner then
        raise exception 'recipient already owns workspace'
            using errcode = '22023';
    end if;

    select *
      into workspace_row
      from public.workspaces
     where id = p_workspace_id
       and owner_user_id = p_current_owner
     for update;

    if not found then
        raise exception 'workspace not found'
            using errcode = 'P0002';
    end if;

    if not exists (select 1 from public.users where id = p_new_owner) then
        raise exception 'recipient not found'
            using errcode = 'P0002';
    end if;

    set constraints workers_skill_version_fkey deferred;
    set constraints worker_webhook_secrets_worker_fkey deferred;
    set constraints runs_worker_fkey deferred;
    set constraints run_logs_run_fkey deferred;
    set constraints artifacts_run_fkey deferred;

    select coalesce(array_agg(id), array[]::text[])
      into worker_ids
      from public.workers
     where workspace_id = p_workspace_id;

    select coalesce(array_agg(id), array[]::text[])
      into run_ids
      from public.runs
     where workspace_id = p_workspace_id;

    delete from public.api_tokens
     where workspace_id = p_workspace_id;
    get diagnostics revoked_api_tokens = row_count;

    update public.workspace_share_links
       set revoked_at = coalesce(revoked_at, now())
     where workspace_id = p_workspace_id
       and revoked_at is null;
    get diagnostics revoked_share_links = row_count;

    update public.skill_versions
       set user_id = p_new_owner
     where user_id = p_current_owner
       and id in (
            select distinct skill_version_id
              from public.workers
             where workspace_id = p_workspace_id
       );

    update public.workers
       set user_id = p_new_owner
     where workspace_id = p_workspace_id
       and user_id = p_current_owner;

    update public.worker_webhook_secrets
       set user_id = p_new_owner
     where user_id = p_current_owner
       and worker_id = any(worker_ids);

    update public.runs
       set user_id = p_new_owner
     where workspace_id = p_workspace_id
       and user_id = p_current_owner;

    update public.run_logs
       set user_id = p_new_owner
     where user_id = p_current_owner
       and run_id = any(run_ids);

    update public.artifacts
       set user_id = p_new_owner
     where user_id = p_current_owner
       and run_id = any(run_ids);

    update public.connections
       set user_id = p_new_owner
     where workspace_id = p_workspace_id
       and user_id = p_current_owner;

    update public.secrets
       set user_id = p_new_owner
     where workspace_id = p_workspace_id
       and user_id = p_current_owner;

    update public.approvals
       set owner_id = p_new_owner
     where owner_id = p_current_owner
       and (
            workspace_id = p_workspace_id
            or run_id = any(run_ids)
       );

    update public.workspaces
       set owner_user_id = p_new_owner
     where id = p_workspace_id
       and owner_user_id = p_current_owner
     returning * into workspace_row;

    insert into public.workspace_transfer_events (
        id,
        workspace_id,
        previous_owner_user_id,
        new_owner_user_id,
        actor_user_id,
        revoked_api_tokens,
        retained_authority,
        details
    )
    values (
        p_event_id,
        p_workspace_id,
        p_current_owner,
        p_new_owner,
        p_actor_user_id,
        revoked_api_tokens,
        p_retained_authority,
        jsonb_build_object(
            'retained_authority', p_retained_authority,
            'pat_policy', 'workspace_api_tokens_deleted',
            'share_link_policy', 'workspace_share_links_revoked',
            'revoked_share_links', revoked_share_links
        )
    );

    return jsonb_build_object(
        'workspace', to_jsonb(workspace_row),
        'previous_owner_user_id', p_current_owner,
        'new_owner_user_id', p_new_owner,
        'revoked_api_tokens', revoked_api_tokens,
        'revoked_share_links', revoked_share_links,
        'retained_authority', p_retained_authority,
        'audit_event_id', p_event_id
    );
end;
$$;

commit;
