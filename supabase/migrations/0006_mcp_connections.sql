-- Mirror engine migration #28+#29 to Supabase: MCP server connections on
-- the connections surface.
--
-- The cloud uses Supabase Postgres, NOT the engine's sqlite, so the
-- engine migration in apps/api/db/_legacy_sqlite.py does not reach us.
-- This file adds the same columns + index to public.connections so the
-- cloud SupabaseConnectionRepository can persist MCP connection rows
-- created via the new POST /connections/mcp endpoint introduced by
-- engine PR #161 (8136efc).
--
-- Idempotent: every statement uses `if not exists`.

begin;

alter table public.connections add column if not exists kind text not null default 'composio';
alter table public.connections add column if not exists mcp_label text;
alter table public.connections add column if not exists mcp_url text;
alter table public.connections add column if not exists mcp_auth_secret text;
alter table public.connections add column if not exists mcp_allowed_tools_json jsonb not null default '[]'::jsonb;

create index if not exists idx_connections_kind on public.connections (kind);

-- The engine treats `kind` as a free-text discriminator with two known
-- values today: 'composio' (default) and 'mcp'. We do NOT constrain it
-- with a check constraint here so future engine additions don't require
-- a migration coordination dance — the API layer validates input.

comment on column public.connections.kind is
    'Connection kind discriminator: "composio" (OAuth via Composio) or "mcp" (user-supplied MCP server). Default "composio" for back-compat with rows created before engine PR #161.';
comment on column public.connections.mcp_label is
    'Human-readable label for MCP-kind connections. Unique per workspace (enforced at API layer).';
comment on column public.connections.mcp_url is
    'HTTP(S) endpoint for the MCP server. Only populated when kind = "mcp".';
comment on column public.connections.mcp_auth_secret is
    'Optional Workeros secret name carrying the bearer token / auth header for the MCP server. References public.secrets.name for the same workspace.';
comment on column public.connections.mcp_allowed_tools_json is
    'JSON array of tool names the MCP connection is allowed to expose. Empty array means "all tools".';

commit;
