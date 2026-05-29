-- 0008: CRIT-2 fix — enable RLS on workspaces (it was the ONLY public table
-- with RLS disabled; every other table already had it on).
--
-- A security audit (2026-05-29) confirmed: with RLS off + Supabase's default
-- anon/authenticated grants, ANY visitor holding the public anon key (shipped
-- in every frontend bundle by design) could read, modify, and DELETE every
-- workspace row via PostgREST (/rest/v1/workspaces). The auditor actually
-- deleted + re-inserted the fede workspace to prove it.
--
-- The cloud backend reaches Supabase exclusively through the service_role key,
-- which BYPASSES RLS — so enabling RLS with no anon/authenticated policy locks
-- out PostgREST/anon entirely while the FastAPI app keeps working unchanged.
-- This matches how workers/runs/connections/secrets are already protected.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already enabled.

BEGIN;

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

-- Defense in depth: an explicit deny-all is implicit when RLS is on with no
-- policies, but we add a FORCE so even a future table-owner query path can't
-- accidentally bypass it. (service_role still bypasses RLS — that's the app.)
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;

COMMIT;

-- Verify: anon/authenticated get zero rows; service_role (app) unaffected.
-- SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
--   WHERE relname='workspaces';
