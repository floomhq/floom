-- Migration 0023: mcp_tools table
--
-- Mirrors engine migration #46 to Supabase Postgres.
-- Column types match the existing schema conventions:
--   id/worker_id = TEXT (engine uses uuid strings stored as text)
--   user_id      = UUID (references auth.users)
--   workspace_id = TEXT (matches connections, workers pattern)
--
-- Idempotent: every statement uses "if not exists".

begin;

create table if not exists public.mcp_tools (
    id           text primary key,
    user_id      uuid not null references auth.users(id) on delete cascade,
    workspace_id text not null,
    name         text not null,
    description  text not null,
    input_schema jsonb not null default '{}'::jsonb,
    worker_id    text not null references public.workers(id) on delete cascade,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique(workspace_id, name)
);

create index if not exists idx_mcp_tools_workspace_id on public.mcp_tools(workspace_id);

alter table public.mcp_tools enable row level security;

-- Backend uses service_role key (bypasses RLS). Deny all direct PostgREST/anon access.
create policy "deny anon" on public.mcp_tools for all using (false);

comment on table public.mcp_tools is
    'Custom MCP tools per workspace. Each row maps a tool name + JSON Schema to a worker that handles calls to that tool.';

comment on column public.mcp_tools.input_schema is
    'JSON Schema object describing the tool inputs. Empty object means the tool accepts any inputs.';

comment on column public.mcp_tools.worker_id is
    'Worker invoked when this MCP tool is called. The worker output becomes the tool call result.';

commit;
