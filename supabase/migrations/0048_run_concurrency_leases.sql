-- Distributed run-concurrency lease table.
--
-- Backs apps/api/run_limiter_pg.py (the PG-lease limiter installed via the
-- engine's register_run_limiter seam when WORKEROS_RUN_LEASE_ENABLED=1). Each
-- row is one held execution slot for a budget ("runs" = E2B-cap gate, "llm_runs"
-- = provider-quota gate). Admission is serialized per budget with a
-- pg_advisory_xact_lock; stale rows (a task that died without releasing) are
-- reaped on each acquire via a TTL. The lease role connects directly over the
-- session pooler (WORKEROS_CLOUD_DB_*), not via PostgREST.
begin;

create table if not exists public.run_concurrency_leases (
    token       text        primary key,
    budget      text        not null,
    acquired_at timestamptz not null default now()
);

-- count(*) WHERE budget=? and the TTL reap both filter on (budget, acquired_at)
create index if not exists idx_run_concurrency_leases_budget
    on public.run_concurrency_leases (budget, acquired_at);

-- Internal infra table: only the backend touches it. RLS on + service-role-only,
-- and the direct-DB lease role (workeros_scheduler) gets a matching policy +
-- table grants. anon/authenticated have no path here.
alter table public.run_concurrency_leases enable row level security;

drop policy if exists "backend full access run_concurrency_leases"
    on public.run_concurrency_leases;
create policy "backend full access run_concurrency_leases"
    on public.run_concurrency_leases
    for all
    to service_role
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

revoke all on public.run_concurrency_leases from anon, authenticated;

-- The PG-lease limiter connects as the dedicated scheduler role (session pooler).
-- Grant the table privileges + a permissive policy for that role only.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'workeros_scheduler') then
        grant select, insert, delete on public.run_concurrency_leases to workeros_scheduler;
        drop policy if exists "scheduler role run_concurrency_leases"
            on public.run_concurrency_leases;
        create policy "scheduler role run_concurrency_leases"
            on public.run_concurrency_leases
            for all
            to workeros_scheduler
            using (true)
            with check (true);
    end if;
end$$;

commit;
