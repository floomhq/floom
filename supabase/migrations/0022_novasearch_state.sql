-- NovaSearch state tables, workspace-scoped for Workeros Cloud.
--
-- These tables replace the isolated SQLite state files for mutable NovaSearch
-- behavior. Candidate source data remains in the workspace Brain pack; query
-- history, labels, tracked candidates, outreach status, memory, judge cache,
-- telemetry, and issue reports live here with RLS.

begin;

create table if not exists public.novasearch_match_queries (
    workspace_id text not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    id text not null,
    ts double precision,
    created_at timestamptz not null default now(),
    job_title text,
    required_modules jsonb not null default '[]'::jsonb,
    nice_modules jsonb not null default '[]'::jsonb,
    location text,
    locations jsonb not null default '[]'::jsonb,
    min_years integer,
    salary_min integer,
    salary_max integer,
    include_external boolean not null default false,
    use_ai_curation boolean not null default false,
    custom_requirements text,
    query_json jsonb not null default '{}'::jsonb,
    total_scored integer,
    curated_count integer,
    downloadable_count integer,
    external_count integer,
    elapsed_s double precision,
    top_json jsonb not null default '[]'::jsonb,
    created_from text not null default 'sqlite-backfill',
    updated_at timestamptz not null default now(),
    primary key (workspace_id, id)
);

create table if not exists public.novasearch_match_labels (
    workspace_id text not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    query_id text not null,
    rank integer,
    candidate_key text not null,
    source text,
    worth_contact boolean,
    reason text,
    labeled_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (workspace_id, query_id, candidate_key),
    foreign key (workspace_id, query_id)
        references public.novasearch_match_queries (workspace_id, id)
        on delete cascade
);

create table if not exists public.novasearch_tracked_candidates (
    id uuid primary key default gen_random_uuid(),
    workspace_id text not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    old_id bigint,
    candidate_key text not null,
    name text,
    title text,
    company text,
    location text,
    source text,
    mandate text not null,
    status text not null,
    score double precision,
    notes text,
    first_seen timestamptz not null default now(),
    last_updated timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (workspace_id, candidate_key, mandate)
);

create table if not exists public.novasearch_outreach (
    id uuid primary key default gen_random_uuid(),
    workspace_id text not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    old_id bigint,
    mandate text not null,
    candidate_name text,
    linkedin_url text not null,
    message_redacted text,
    message_hash text,
    status text not null,
    created_at timestamptz not null default now(),
    sent_at timestamptz,
    replied_at timestamptz,
    phantom_container_id text,
    updated_at timestamptz not null default now(),
    unique (workspace_id, mandate, linkedin_url)
);

create table if not exists public.novasearch_memory (
    id uuid primary key default gen_random_uuid(),
    workspace_id text not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    old_id bigint,
    scope text not null,
    kind text not null,
    text text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.novasearch_judge_cache (
    workspace_id text not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    cache_key text not null,
    mandate_signature text,
    candidate_key text,
    model text,
    prompt_version text,
    verdict_json jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (workspace_id, cache_key)
);

create table if not exists public.novasearch_session_events (
    id uuid primary key default gen_random_uuid(),
    workspace_id text not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    old_id bigint,
    created_at timestamptz not null default now(),
    session_id_hash text,
    request_id text,
    source text not null,
    event_type text not null,
    tool_name text,
    rpc_method text,
    status text,
    duration_ms double precision,
    error_message text,
    metadata_json jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

create table if not exists public.novasearch_issue_reports (
    id uuid primary key default gen_random_uuid(),
    workspace_id text not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    old_id bigint,
    created_at timestamptz not null default now(),
    title text not null,
    description_redacted text not null,
    description_hash text,
    severity text not null,
    area text,
    session_id_hash text,
    chat_url text,
    reporter text,
    github_issue_url text,
    github_issue_number integer,
    status text not null,
    metadata_json jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

create index if not exists idx_novasearch_match_queries_workspace_created
    on public.novasearch_match_queries (workspace_id, created_at desc);
create index if not exists idx_novasearch_match_labels_workspace_query
    on public.novasearch_match_labels (workspace_id, query_id);
create index if not exists idx_novasearch_tracked_workspace_status
    on public.novasearch_tracked_candidates (workspace_id, status, last_updated desc);
create index if not exists idx_novasearch_outreach_workspace_status
    on public.novasearch_outreach (workspace_id, status, created_at desc);
create index if not exists idx_novasearch_memory_workspace_scope
    on public.novasearch_memory (workspace_id, scope, kind, created_at desc);
create index if not exists idx_novasearch_judge_workspace_candidate
    on public.novasearch_judge_cache (workspace_id, candidate_key);
create index if not exists idx_novasearch_session_events_workspace_created
    on public.novasearch_session_events (workspace_id, created_at desc);
create index if not exists idx_novasearch_session_events_workspace_type
    on public.novasearch_session_events (workspace_id, event_type, created_at desc);
create index if not exists idx_novasearch_issue_reports_workspace_created
    on public.novasearch_issue_reports (workspace_id, created_at desc);

create or replace function public.set_novasearch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists novasearch_match_queries_updated_at on public.novasearch_match_queries;
create trigger novasearch_match_queries_updated_at
    before update on public.novasearch_match_queries
    for each row execute function public.set_novasearch_updated_at();

drop trigger if exists novasearch_match_labels_updated_at on public.novasearch_match_labels;
create trigger novasearch_match_labels_updated_at
    before update on public.novasearch_match_labels
    for each row execute function public.set_novasearch_updated_at();

drop trigger if exists novasearch_tracked_candidates_updated_at on public.novasearch_tracked_candidates;
create trigger novasearch_tracked_candidates_updated_at
    before update on public.novasearch_tracked_candidates
    for each row execute function public.set_novasearch_updated_at();

drop trigger if exists novasearch_outreach_updated_at on public.novasearch_outreach;
create trigger novasearch_outreach_updated_at
    before update on public.novasearch_outreach
    for each row execute function public.set_novasearch_updated_at();

drop trigger if exists novasearch_memory_updated_at on public.novasearch_memory;
create trigger novasearch_memory_updated_at
    before update on public.novasearch_memory
    for each row execute function public.set_novasearch_updated_at();

drop trigger if exists novasearch_judge_cache_updated_at on public.novasearch_judge_cache;
create trigger novasearch_judge_cache_updated_at
    before update on public.novasearch_judge_cache
    for each row execute function public.set_novasearch_updated_at();

drop trigger if exists novasearch_session_events_updated_at on public.novasearch_session_events;
create trigger novasearch_session_events_updated_at
    before update on public.novasearch_session_events
    for each row execute function public.set_novasearch_updated_at();

drop trigger if exists novasearch_issue_reports_updated_at on public.novasearch_issue_reports;
create trigger novasearch_issue_reports_updated_at
    before update on public.novasearch_issue_reports
    for each row execute function public.set_novasearch_updated_at();

alter table public.novasearch_match_queries enable row level security;
alter table public.novasearch_match_labels enable row level security;
alter table public.novasearch_tracked_candidates enable row level security;
alter table public.novasearch_outreach enable row level security;
alter table public.novasearch_memory enable row level security;
alter table public.novasearch_judge_cache enable row level security;
alter table public.novasearch_session_events enable row level security;
alter table public.novasearch_issue_reports enable row level security;

alter table public.novasearch_match_queries force row level security;
alter table public.novasearch_match_labels force row level security;
alter table public.novasearch_tracked_candidates force row level security;
alter table public.novasearch_outreach force row level security;
alter table public.novasearch_memory force row level security;
alter table public.novasearch_judge_cache force row level security;
alter table public.novasearch_session_events force row level security;
alter table public.novasearch_issue_reports force row level security;

drop policy if exists "Users manage own NovaSearch match queries" on public.novasearch_match_queries;
create policy "Users manage own NovaSearch match queries"
    on public.novasearch_match_queries for all
    using (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_match_queries.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_match_queries.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

drop policy if exists "Users manage own NovaSearch match labels" on public.novasearch_match_labels;
create policy "Users manage own NovaSearch match labels"
    on public.novasearch_match_labels for all
    using (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_match_labels.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_match_labels.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

drop policy if exists "Users manage own NovaSearch tracked candidates" on public.novasearch_tracked_candidates;
create policy "Users manage own NovaSearch tracked candidates"
    on public.novasearch_tracked_candidates for all
    using (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_tracked_candidates.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_tracked_candidates.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

drop policy if exists "Users manage own NovaSearch outreach" on public.novasearch_outreach;
create policy "Users manage own NovaSearch outreach"
    on public.novasearch_outreach for all
    using (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_outreach.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_outreach.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

drop policy if exists "Users manage own NovaSearch memory" on public.novasearch_memory;
create policy "Users manage own NovaSearch memory"
    on public.novasearch_memory for all
    using (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_memory.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_memory.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

drop policy if exists "Users manage own NovaSearch judge cache" on public.novasearch_judge_cache;
create policy "Users manage own NovaSearch judge cache"
    on public.novasearch_judge_cache for all
    using (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_judge_cache.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_judge_cache.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

drop policy if exists "Users manage own NovaSearch session events" on public.novasearch_session_events;
create policy "Users manage own NovaSearch session events"
    on public.novasearch_session_events for all
    using (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_session_events.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_session_events.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

drop policy if exists "Users manage own NovaSearch issue reports" on public.novasearch_issue_reports;
create policy "Users manage own NovaSearch issue reports"
    on public.novasearch_issue_reports for all
    using (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_issue_reports.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = novasearch_issue_reports.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

grant select, insert, update, delete on
    public.novasearch_match_queries,
    public.novasearch_match_labels,
    public.novasearch_tracked_candidates,
    public.novasearch_outreach,
    public.novasearch_memory,
    public.novasearch_judge_cache,
    public.novasearch_session_events,
    public.novasearch_issue_reports
to authenticated;

commit;
