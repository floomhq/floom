-- Fresh Cloud deployments must lock the workspace registry behind RLS.
-- The FastAPI backend uses the service_role key and is unaffected; browser
-- clients must go through the API so workspace ownership can be checked.

begin;

alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;

commit;
