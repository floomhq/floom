# Cloud Sync Merge Report - 2026-06-05

Status: verified locally; PR #86 selected for merge/deploy.

No secret values are recorded in this document.

## PR Decision

Reviewed:

- #85 `cloud-engine-sync-20260605`
- #86 `codex/cloud-launch-fixes-20260605`

#85 is unsafe/redundant:

- It reintroduces `web/vercel.json`.
- That violates the 508-loop fix requirement.
- It only contains the narrower engine sync and misses the Cloud API dependency
  fix.

#86 is the complete PR:

- `web/vercel.json` is absent on disk and absent from the git index.
- It contains the Cloud API dependency fix for the Supabase/OpenAI Agents
  resolver conflict.
- It contains the synced dashboard fixes from WorkerOS.
- It pins `engine/` to current WorkerOS `main`:
  `099864073486e544e95e88190d9dac6a11ac3c89`.

## Changes Added During Review

- Updated #86 from engine `e45032e62a32ecc33f403bbe446f14e1f0b221dd` to
  `099864073486e544e95e88190d9dac6a11ac3c89`.
- Added `email-validator==2.3.0`; importing `apps.api.main` requires it via
  `pydantic.EmailStr` in the members route.
- Kept the Docker install simple: no `uv --override` workaround.
- Made `/connections/callback` public in Cloud middleware so OAuth provider
  redirects reach the callback page.
- Added `supabase/migrations/0028_force_rls_public_tables.sql`.
- Updated welcome-email tests to match the current Floom email subject/logo.

## Verification

Dashboard:

- `npm ci` passed.
- `npm run sync` passed.
- `npm run check-drift` passed with zero drift.
- `npx vitest run tests/middleware.test.ts -t "keeps the OAuth callback page"`
  passed.
- `npm run build` passed with Next.js 16.2.6.

Cloud API:

- Installed `apps/api/requirements.txt` in an isolated Python 3.12 venv.
- `python -m pip check` passed.
- Import checks passed for:
  - `apps.api.main`
  - `apps.api.routes.members`
  - `apps.api.startup`
  - `apps.api.db.supabase_repos`
- `pytest -q tests` passed: 126 passed.
- `pip-audit --local` passed: no known vulnerabilities found.

Resolved dependency set:

- `supabase==2.31.0`
- `openai-agents==0.17.4`
- `websockets==15.0.1`
- `cryptography==48.0.0`
- `fastapi==0.136.3`
- `starlette==1.2.1`
- `email-validator==2.3.0`

GitHub Actions note:

- PR checks were unable to start on GitHub because the account billing/spending
  limit blocked hosted runners. Local verification above was run from a clean
  isolated worktree instead.

## RLS Migration

Migration:

- `supabase/migrations/0028_force_rls_public_tables.sql`

Behavior:

- Enables RLS on every current public base/partitioned table.
- Forces RLS on every current public base/partitioned table.
- Revokes direct `anon` and `public` table privileges across `public`.
- Idempotent.

Production apply:

- Credential path used: Supabase Management API PAT.
- Rescue and verification artifacts:
  `/root/fede-vault/workeros-cloud/rls-force-0028-2026-06-05/`
- `supabase_migrations.schema_migrations` contains
  `0028_force_rls_public_tables`.

Post-apply catalog verification:

- public tables: 34
- RLS disabled: 0
- not forced: 0
- direct `anon`/`public` table grants: 0

Anonymous PostgREST verification returned HTTP 401 for representative tenant
tables:

- `asset_versions`
- `workspace_agent_settings`
- `workers`
- `runs`

## Live Pre-Deploy Checks

- `https://workeros-api.floom.dev/health` returned `status: ok`.
- `https://workeros.floom.dev/app` returned a redirect response, not a 508 page.

## Deployment Plan

After #86 merges:

1. Deploy dashboard from `web/` with `npm run sync` first.
2. Restart `workeros-cloud-api` because `engine/` moves from
   `b30c53f591027c6ecc1772884d8b96f9338e022e` to
   `099864073486e544e95e88190d9dac6a11ac3c89`.
3. Verify:
   - `https://workeros-api.floom.dev/health`
   - `https://workeros.floom.dev/app`
   - live dashboard is not 508
   - synced dashboard contains the current WorkerOS OAuth callback fix
