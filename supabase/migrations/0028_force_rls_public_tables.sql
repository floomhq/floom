-- Migration 0028: force RLS on every public table.
--
-- The Cloud API uses the Supabase service_role key as the backend data path.
-- Direct PostgREST access must remain governed by RLS for non-service roles.
-- This migration is idempotent and covers existing public base/partitioned
-- tables without hard-coding the table list.

begin;

do $$
declare
    table_row record;
begin
    for table_row in
        select n.nspname as schema_name, c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
    loop
        execute format(
            'alter table %I.%I enable row level security',
            table_row.schema_name,
            table_row.table_name
        );
        execute format(
            'alter table %I.%I force row level security',
            table_row.schema_name,
            table_row.table_name
        );
        execute format(
            'revoke all privileges on table %I.%I from anon',
            table_row.schema_name,
            table_row.table_name
        );
        execute format(
            'revoke all privileges on table %I.%I from public',
            table_row.schema_name,
            table_row.table_name
        );
    end loop;
end $$;

commit;
