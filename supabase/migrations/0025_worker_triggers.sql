-- Migration 0025: worker_triggers table
--
-- Mirrors the engine's normalized multi-trigger rows (engine
-- apps/api/db/_legacy_sqlite.py worker_triggers DDL + apps/api/db/sqlite.py
-- reconcile/scheduler logic) into Supabase Postgres.
--
-- One row per declared trigger. Row id is DETERMINISTIC: trg_<worker_id>_<position>
-- so re-reconciling a worker's triggers updates the same rows instead of churning.
--
-- Column types deliberately match engine semantics:
--   id/worker_id     = text   (engine uses uuid strings stored as text)
--   workspace_id     = text   (denormalized so the multi-tenant scheduler/webhook
--                              path resolves the tenant WITHOUT request context;
--                              matches workers / mcp_tools / connections pattern)
--   config_json      = text   (the engine scheduler calls json.loads(config_json);
--                              jsonb would change parsing/quoting semantics — keep text)
--   next_run_at /    = text   (engine stores + string-compares ISO timestamps;
--   last_fired_at             keep text so scheduler due-comparison is byte-identical)
--
-- Idempotent: every statement uses "if not exists".

begin;

create table if not exists public.worker_triggers (
    id                  text primary key,
    workspace_id        text not null,
    worker_id           text not null references public.workers(id) on delete cascade,
    type                text not null,
    config_json         text,
    enabled             boolean not null default true,
    next_run_at         text,
    external_trigger_id text,
    webhook_path        text,
    last_fired_at       text,
    position            integer not null default 0,
    created_at          text not null,
    updated_at          text
);

create index if not exists idx_worker_triggers_workspace_id
    on public.worker_triggers(workspace_id);
create index if not exists idx_worker_triggers_worker_id
    on public.worker_triggers(worker_id);
create index if not exists idx_worker_triggers_type_enabled
    on public.worker_triggers(type, enabled);
create index if not exists idx_worker_triggers_next_run_at
    on public.worker_triggers(next_run_at);
create index if not exists idx_worker_triggers_external_id
    on public.worker_triggers(external_trigger_id);
create index if not exists idx_worker_triggers_webhook_lookup
    on public.worker_triggers(worker_id, type, enabled);

alter table public.worker_triggers enable row level security;

-- Backend uses the service_role key (bypasses RLS). Deny all direct
-- PostgREST/anon access — the API is the only data path.
create policy "deny anon" on public.worker_triggers for all using (false);

comment on table public.worker_triggers is
    'Normalized per-worker trigger rows (schedule / webhook / composio_event / manual). '
    'One row per declared trigger, id = trg_<worker_id>_<position>. workspace_id is '
    'denormalized from the parent worker so the scheduler/webhook path is tenant-correct.';

comment on column public.worker_triggers.config_json is
    'JSON-encoded per-trigger config (the declared trigger minus its "type" key). '
    'Stored as text because the engine scheduler calls json.loads() on it.';

commit;
