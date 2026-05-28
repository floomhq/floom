-- Allow cli_auth_devices rows to be minted BEFORE the Supabase user is known.
--
-- The engine's POST /cli-auth/devices handler runs unauthenticated (a fresh
-- CLI client that hasn't logged in yet calls it to get a device code +
-- verification URL). In the OSS deployment that handler stores
-- user_id=_bootstrap_user_id()="federico" because there's only one user.
-- In the cloud, that placeholder string is not a UUID, fails the FK to
-- auth.users, and the request 500s — every cloud `floom login` attempt
-- hits this and dies before the user ever sees the verification URL.
--
-- Two minimal schema relaxations:
--   1. user_id becomes NULLable so a pending row can exist before the
--      dashboard user clicks Approve.
--   2. The FK to public.users stays but only fires when user_id is set
--      (already the default behavior for nullable FKs in Postgres).
--
-- The cloud cli-approve handler (apps/api/routes/auth.py) writes the
-- real Supabase user_id into the row when the user clicks Approve.
-- Pending devices with NULL user_id are visible to no one (the cloud
-- SupabaseCliAuthRepository.list() filters by user_id).
--
-- Idempotent.

begin;

-- Drop NOT NULL on user_id. The FK still references auth.users via
-- public.users; nullable FKs simply skip the constraint check when the
-- column is NULL.
alter table public.cli_auth_devices
    alter column user_id drop not null;

comment on column public.cli_auth_devices.user_id is
    'Owner Supabase user_id. NULL while the device is pending; populated by /auth/cli-approve when the dashboard user claims it.';

commit;
