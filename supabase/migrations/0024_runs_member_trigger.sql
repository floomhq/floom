-- Allow workspace members to trigger shared workers.
--
-- The composite FK (worker_id, user_id) on runs → workers means a member's
-- user_id must appear in workers, which it never does (worker.user_id is the
-- owner/admin). Replace it with a simple worker_id-only FK so any authenticated
-- user in the workspace can create runs for workers they can see.
--
-- The cloud run_service patch (startup.py:_override_create_run_for_members)
-- substitutes the worker owner's user_id at create_run time as a compatibility
-- shim until this migration is applied to all environments.

begin;

alter table public.runs
    drop constraint if exists runs_worker_fkey;

alter table public.runs
    add constraint runs_worker_id_fkey
    foreign key (worker_id)
    references public.workers (id)
    on delete cascade;

commit;
