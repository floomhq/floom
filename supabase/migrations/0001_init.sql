create table if not exists public.users (
    id uuid primary key references auth.users (id) on delete cascade,
    email text,
    -- INERT FOR PHASE 3 — atomic counter wiring is Phase 5+.
    plan text not null default 'free',
    quota_runs_per_month integer not null default 100,
    quota_used_runs integer not null default 0,
    quota_reset_at timestamptz not null default (date_trunc('month', now()) + interval '1 month'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.skill_versions (
    id text primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    name text not null,
    version text not null,
    manifest_json jsonb not null,
    bundle_path text,
    created_at timestamptz not null default now(),
    unique (id, user_id),
    unique (user_id, name, version)
);

create table if not exists public.workers (
    id text primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    skill_version_id text not null,
    name text not null,
    trigger_type text not null default 'manual',
    cron_expr text,
    cron_timezone text,
    next_run_at timestamptz,
    last_scheduled_run_at timestamptz,
    webhook_secret_hash text,
    notify_email boolean not null default false,
    notify_webhook_url text,
    grants_json jsonb not null default '{}'::jsonb,
    input_values_json jsonb not null default '{}'::jsonb,
    enabled boolean not null default true,
    created_at timestamptz not null default now(),
    composio_trigger_id text,
    composio_event text,
    triggers_json jsonb not null default '[]'::jsonb,
    unique (id, user_id),
    constraint workers_skill_version_fkey
        foreign key (skill_version_id, user_id)
        references public.skill_versions (id, user_id)
        on delete restrict
);

create table if not exists public.worker_webhook_secrets (
    worker_id text primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    secret_hash text not null,
    created_at timestamptz not null,
    rotated_at timestamptz,
    constraint worker_webhook_secrets_worker_fkey
        foreign key (worker_id, user_id)
        references public.workers (id, user_id)
        on delete cascade
);

create table if not exists public.runs (
    id text primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    worker_id text not null,
    status text not null,
    trigger_source text not null,
    runner text not null,
    input_json jsonb not null default '{}'::jsonb,
    output_json jsonb not null default '{}'::jsonb,
    approval_status text not null default 'not_required',
    error text,
    started_at timestamptz,
    completed_at timestamptz,
    duration_ms integer,
    created_at timestamptz not null default now(),
    cancel_requested boolean not null default false,
    cancelled_at timestamptz,
    bundle_snapshot_path text,
    unique (id, user_id),
    constraint runs_worker_fkey
        foreign key (worker_id, user_id)
        references public.workers (id, user_id)
        on delete cascade
);

create table if not exists public.run_logs (
    id bigint generated always as identity primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    run_id text not null,
    level text not null default 'info',
    message text not null,
    timestamp timestamptz not null,
    trace_id text,
    constraint run_logs_run_fkey
        foreign key (run_id, user_id)
        references public.runs (id, user_id)
        on delete cascade
);

create table if not exists public.artifacts (
    id text primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    run_id text not null,
    name text not null,
    type text,
    path text not null,
    size_bytes bigint,
    created_at timestamptz not null,
    constraint artifacts_run_fkey
        foreign key (run_id, user_id)
        references public.runs (id, user_id)
        on delete cascade
);

create table if not exists public.connections (
    id text primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    app_name text not null,
    composio_connection_id text not null unique,
    composio_user_id text not null,
    status text not null default 'initiated',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    scopes_json jsonb not null default '[]'::jsonb,
    account_label text,
    last_checked_at timestamptz,
    last_check_status text,
    last_check_error text
);

create table if not exists public.secrets (
    user_id uuid not null references public.users (id) on delete cascade,
    name text not null,
    value bytea,
    status text not null,
    last_used_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz,
    last_checked_at timestamptz,
    last_check_status text,
    last_check_error text,
    primary key (user_id, name)
);

create table if not exists public.cli_auth_devices (
    device_code text primary key,
    user_id uuid not null references public.users (id) on delete cascade,
    user_code text not null unique,
    status text not null,
    secret text,
    client_name text not null,
    scopes_json jsonb not null default '[]'::jsonb,
    created_ip text,
    created_at double precision not null,
    expires_at double precision not null,
    approved_at double precision
);

create index if not exists idx_skill_versions_user_id on public.skill_versions (user_id);
create index if not exists idx_skill_versions_name_version on public.skill_versions (user_id, name, version);
create index if not exists idx_workers_user_id on public.workers (user_id);
create index if not exists idx_workers_skill_version_id on public.workers (skill_version_id);
create index if not exists idx_workers_next_run_at on public.workers (next_run_at);
create index if not exists idx_workers_composio_trigger_id on public.workers (composio_trigger_id);
create index if not exists idx_worker_webhook_secrets_user_id on public.worker_webhook_secrets (user_id);
create index if not exists idx_runs_user_created_at on public.runs (user_id, created_at desc);
create index if not exists idx_runs_worker_id on public.runs (worker_id);
create index if not exists idx_runs_status on public.runs (status);
create index if not exists idx_runs_worker_status on public.runs (worker_id, status);
create index if not exists idx_run_logs_user_run on public.run_logs (user_id, run_id);
create index if not exists idx_run_logs_timestamp on public.run_logs (timestamp);
create index if not exists idx_artifacts_user_run on public.artifacts (user_id, run_id);
create index if not exists idx_connections_user_id on public.connections (user_id);
create index if not exists idx_connections_status on public.connections (status);
create index if not exists idx_secrets_user_id on public.secrets (user_id);
create index if not exists idx_cli_auth_devices_user_id on public.cli_auth_devices (user_id);
create index if not exists idx_cli_auth_devices_user_code on public.cli_auth_devices (user_code);
create index if not exists idx_cli_auth_devices_expires_at on public.cli_auth_devices (expires_at);
