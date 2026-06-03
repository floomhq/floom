-- Members v1: workspace multi-user support.
--
-- Adds workspace_members (active member roster), workspace_invitations
-- (pending email invites), workers.visibility (private|shared),
-- admin_access_log (silent audit trail for admin access to private member
-- data), and trigger_member_id on runs (tracks which member triggered a
-- shared-worker run).
--
-- Design rules enforced here:
--   - Owner (workspaces.owner_user_id) is always admin; not duplicated in
--     workspace_members.
--   - Members see their own private workers + all shared workers.
--   - Admin can access any member's private data; every such access is
--     silently logged in admin_access_log (no notification to target —
--     industry standard: Slack, Google Workspace work the same way).
--   - Shared-worker runs execute as the worker owner's identity; the
--     triggering member is recorded in runs.trigger_member_id for audit.
--
-- Idempotent: every statement uses IF NOT EXISTS / IF EXISTS.

begin;

-- 1. workspace_members -------------------------------------------------
create table if not exists public.workspace_members (
    id uuid default gen_random_uuid() primary key,
    workspace_id text not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references public.users (id) on delete cascade,
    role text not null default 'member',  -- 'admin' | 'member'
    invited_by uuid references public.users (id),
    invited_at timestamptz not null default now(),
    joined_at timestamptz,
    status text not null default 'active',  -- 'active' | 'removed'
    unique (workspace_id, user_id)
);

create index if not exists idx_workspace_members_workspace
    on public.workspace_members (workspace_id, status);
create index if not exists idx_workspace_members_user
    on public.workspace_members (user_id, status);

-- 2. workspace_invitations -----------------------------------------------
create table if not exists public.workspace_invitations (
    id uuid default gen_random_uuid() primary key,
    workspace_id text not null references public.workspaces (id) on delete cascade,
    email text not null,
    role text not null default 'member',
    invited_by uuid not null references public.users (id),
    token_hash text not null unique,
    status text not null default 'pending',  -- 'pending' | 'accepted' | 'revoked'
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    accepted_at timestamptz,
    accepted_by_user_id uuid references public.users (id),
    -- Only one pending invite per (workspace, email). Revoked/accepted ones
    -- are kept for audit; new invites use a fresh row.
    constraint workspace_invitations_pending_unique
        unique nulls not distinct (workspace_id, email)
        deferrable initially deferred
);

create index if not exists idx_workspace_invitations_workspace
    on public.workspace_invitations (workspace_id, status);
create index if not exists idx_workspace_invitations_token
    on public.workspace_invitations (token_hash);
create index if not exists idx_workspace_invitations_email
    on public.workspace_invitations (email, status);

-- 3. workers.visibility + published_at ------------------------------------
alter table public.workers
    add column if not exists visibility text not null default 'private';
    -- 'private' = owner-only; 'shared' = all workspace members

alter table public.workers
    add column if not exists published_at timestamptz;
    -- Set when visibility first changes to 'shared'. Shared run history
    -- starts from this timestamp; private history is never exposed.

alter table public.workers
    add column if not exists clone_token_hash text;
    -- SHA-256 hash of the one-time wct_* clone token. NULL means no active token.

alter table public.workers
    add column if not exists clone_token_expires_at timestamptz;

create index if not exists idx_workers_workspace_visibility
    on public.workers (workspace_id, visibility);

create index if not exists idx_workers_clone_token
    on public.workers (clone_token_hash)
    where clone_token_hash is not null;

-- 4. admin_access_log ----------------------------------------------------
-- Silent audit trail: every time an admin reads a private member resource
-- (worker, run, secret, connection) a row is appended here. The member is
-- never notified — this mirrors the Slack / Google Workspace admin model.
create table if not exists public.admin_access_log (
    id uuid default gen_random_uuid() primary key,
    workspace_id text not null references public.workspaces (id) on delete cascade,
    admin_user_id uuid not null references public.users (id),
    target_user_id uuid references public.users (id),
    resource_type text not null,  -- 'worker' | 'run' | 'secret' | 'connection'
    resource_id text not null,
    accessed_at timestamptz not null default now()
);

create index if not exists idx_admin_access_log_workspace
    on public.admin_access_log (workspace_id, accessed_at desc);
create index if not exists idx_admin_access_log_admin
    on public.admin_access_log (admin_user_id, accessed_at desc);
create index if not exists idx_admin_access_log_target
    on public.admin_access_log (target_user_id, accessed_at desc);

-- 5. runs.trigger_member_id -----------------------------------------------
-- Records which workspace member triggered a shared-worker run. NULL for
-- owner-triggered runs (pre-members) and for private-worker runs.
alter table public.runs
    add column if not exists trigger_member_id uuid references public.users (id);

create index if not exists idx_runs_trigger_member
    on public.runs (trigger_member_id)
    where trigger_member_id is not null;

-- 6. RLS -----------------------------------------------------------------
-- Backend uses service_role (bypasses RLS). These tables have no direct
-- anon/authenticated client access; block everything via RLS.
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.admin_access_log enable row level security;

-- No policies created — service_role bypasses them. Anon/authenticated
-- roles get no access by default (RLS enabled, zero policies = deny all).

commit;
