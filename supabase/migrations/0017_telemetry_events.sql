-- First-party product telemetry with workspace/user scoping.
-- Stores only sanitized event properties. Raw IPs, raw emails, tokens, and
-- secrets are intentionally not part of the schema.

begin;

create table if not exists public.telemetry_preferences (
    workspace_id text primary key references public.workspaces (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    product_telemetry_enabled boolean not null default true,
    updated_at timestamptz not null default now()
);

create table if not exists public.telemetry_events (
    id uuid primary key default gen_random_uuid(),
    workspace_id text not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    event_name text not null check (event_name ~ '^[a-z][a-z0-9_.:-]{1,96}$'),
    event_version integer not null default 1 check (event_version between 1 and 100),
    source text not null default 'web' check (source in ('web', 'api', 'cli', 'worker', 'system')),
    session_id_hash text,
    properties jsonb not null default '{}'::jsonb,
    occurred_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create index if not exists telemetry_events_workspace_created_idx
    on public.telemetry_events (workspace_id, created_at);

create index if not exists telemetry_events_workspace_name_idx
    on public.telemetry_events (workspace_id, event_name, created_at);

create index if not exists telemetry_events_properties_gin_idx
    on public.telemetry_events using gin (properties);

alter table public.telemetry_preferences enable row level security;
alter table public.telemetry_events enable row level security;

drop policy if exists "Users manage own telemetry preferences" on public.telemetry_preferences;
create policy "Users manage own telemetry preferences"
    on public.telemetry_preferences
    for all
    using (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = telemetry_preferences.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = telemetry_preferences.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

drop policy if exists "Users manage own telemetry events" on public.telemetry_events;
create policy "Users manage own telemetry events"
    on public.telemetry_events
    for all
    using (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = telemetry_events.workspace_id
              and w.owner_user_id = auth.uid()
        )
    )
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.workspaces w
            where w.id = telemetry_events.workspace_id
              and w.owner_user_id = auth.uid()
        )
    );

commit;
