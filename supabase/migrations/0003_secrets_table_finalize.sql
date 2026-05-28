alter table public.secrets
    alter column value set not null;

drop function if exists public.read_secret(uuid, text);
drop function if exists public.upsert_secret(uuid, text, text, text);
drop function if exists public.decrypt_secret(bytea);
drop function if exists public.encrypt_secret(text);

drop table if exists private.secret_encryption_keys;

do $$
begin
    if exists (
        select 1
        from pg_namespace
        where nspname = 'private'
    ) and not exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private'
          and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    ) then
        execute 'drop schema private';
    end if;
end
$$;

drop extension if exists pgsodium;
