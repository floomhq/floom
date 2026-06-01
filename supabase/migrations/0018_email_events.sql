create table if not exists public.email_events (
    id uuid primary key default gen_random_uuid(),
    dedupe_key text not null unique,
    user_id uuid not null references auth.users (id) on delete cascade,
    workspace_id text references public.workspaces (id) on delete cascade,
    kind text not null,
    recipient_email text not null,
    provider text not null default 'resend',
    provider_message_id text,
    status text not null,
    reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    sent_at timestamptz
);

create index if not exists idx_email_events_user_kind
    on public.email_events (user_id, kind, created_at desc);
create index if not exists idx_email_events_workspace
    on public.email_events (workspace_id, created_at desc)
    where workspace_id is not null;

alter table public.email_events enable row level security;

drop policy if exists email_events_select_own on public.email_events;
create policy email_events_select_own on public.email_events
    for select to authenticated
    using (auth.uid() = user_id);

drop policy if exists email_events_insert_own on public.email_events;
create policy email_events_insert_own on public.email_events
    for insert to authenticated
    with check (auth.uid() = user_id);

drop policy if exists email_events_update_own on public.email_events;
create policy email_events_update_own on public.email_events
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

drop policy if exists email_events_delete_own on public.email_events;
create policy email_events_delete_own on public.email_events
    for delete to authenticated
    using (auth.uid() = user_id);
