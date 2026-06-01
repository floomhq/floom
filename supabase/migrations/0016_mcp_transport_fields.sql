-- Store transport-aware MCP server config for engine stdio/SSE/HTTP support.
-- The Workeros engine validates that stdio env values reference secret names
-- with the `secret:SECRET_NAME` convention; raw secret values are not stored.

begin;

alter table public.connections add column if not exists mcp_transport text not null default 'streamable_http';
alter table public.connections add column if not exists mcp_command text;
alter table public.connections add column if not exists mcp_args_json jsonb not null default '[]'::jsonb;
alter table public.connections add column if not exists mcp_env_json jsonb not null default '{}'::jsonb;
alter table public.connections add column if not exists mcp_cwd text;

comment on column public.connections.mcp_transport is
    'MCP transport: streamable_http, sse, or stdio.';
comment on column public.connections.mcp_command is
    'Stdio MCP command, for example npx or uvx. Null for HTTP/SSE transports.';
comment on column public.connections.mcp_args_json is
    'JSON array of stdio command arguments.';
comment on column public.connections.mcp_env_json is
    'JSON object of stdio environment variables. Secret values use secret:SECRET_NAME references.';
comment on column public.connections.mcp_cwd is
    'Optional stdio working directory.';

commit;
