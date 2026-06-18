begin;

-- Keep the ownership-transfer RPC complete as new workspace-scoped tables are
-- added. The original migration handled the first ownership columns, but later
-- workspace_members, asset_versions, and mcp_tools can otherwise retain stale
-- authority after a transfer.
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

    if not exists (
        select 1
          from public.workspace_members
         where workspace_id = p_workspace_id
           and user_id = p_new_owner
           and status = 'active'
    ) then
        raise exception 'recipient must be an active workspace member'
            using errcode = '22023';
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

    update public.workspace_members
       set role = 'admin',
           status = 'active',
           joined_at = coalesce(joined_at, now())
     where workspace_id = p_workspace_id
       and user_id = p_current_owner;

    update public.workspace_members
       set status = 'removed'
     where workspace_id = p_workspace_id
       and user_id = p_new_owner;

    update public.skill_versions
       set user_id = p_new_owner
     where user_id = p_current_owner
       and id in (
            select distinct skill_version_id
              from public.workers
             where workspace_id = p_workspace_id
       );

    update public.asset_versions
       set user_id = p_new_owner
     where workspace_id = p_workspace_id
       and user_id = p_current_owner;

    update public.workers
       set user_id = p_new_owner
     where workspace_id = p_workspace_id
       and user_id = p_current_owner;

    update public.mcp_tools
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
            'revoked_share_links', revoked_share_links,
            'member_policy', 'new_owner_promoted_previous_owner_demoted',
            'resource_policy', 'workspace_user_scoped_rows_reassigned'
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
