alter table public.workers
    alter column webhook_secret_hash type bytea
    using (
        case
            when webhook_secret_hash is null or webhook_secret_hash = '' then null
            else decode(webhook_secret_hash, 'hex')
        end
    );

drop table if exists public.worker_webhook_secrets cascade;

comment on column public.users.quota_used_runs is 'INERT FOR PHASE 3 — atomic counter wiring is Phase 5+.';
