# #691 Investigation Workplan (Phase 1, no production code changes)

## Scope
Investigate why launch AI apps were reported as returning `dry_run: true` and `model: "dry-run"` on preview and prod.

## Evidence Collected

### 1) Seeder flow in `launch-demos.ts`
- `seedLaunchDemoSecretsFromEnv()` inserts **global** secrets (`app_id IS NULL`) from `process.env` when demo manifests declare them and the row does not already exist.
- Boot path calls `seedLaunchDemos()` unconditionally from `apps/server/src/index.ts`.
- In current source this runs before docker image checks, so secret seeding is not blocked by docker reachability.

Code references:
- `apps/server/src/services/launch-demos.ts` lines 405-420 (global secret seeding)
- `apps/server/src/services/launch-demos.ts` lines 498-520 (seed function entry + pre-build call)
- `apps/server/src/index.ts` lines 1529-1536 (boot invokes launch-demos seeder)

### 2) Runtime secret resolution in `run.ts` and `runner.ts`
- `POST /api/run` resolves app by slug, inserts `runs.app_id = row.id`, then calls `dispatchRun(row, ...)`.
- `dispatchRun()` merges:
  1. global `secrets` (`app_id IS NULL`)
  2. per-app `secrets` (`app_id = app.id`)
  3. user/creator overrides
  4. per-call BYOK overrides
- Only keys listed in `manifest.secrets_needed` are forwarded to container runtime.

Code references:
- `apps/server/src/routes/run.ts` lines 204-205, 295-300, 316-324
- `apps/server/src/services/runner.ts` lines 272-283, 351-361
- `apps/server/src/services/docker.ts` line 214 and line 231 (`Env` injection into container)

### 3) Compose and env wiring on host
Read-only inspection of `/opt/floom-mcp-preview/docker-compose.yml` and `/opt/floom-mcp-preview/.env` shows:
- `GEMINI_API_KEY=${GEMINI_API_KEY}` is explicitly passed into `floom-mcp-preview` container env.
- `FLOOM_SEED_LAUNCH_DEMOS` is not set (default path in code is enabled).
- The service uses a **named volume** mounted at `/data`:
  - `floom-mcp-preview-data` -> `/data`
  - volume name: `floom-chat-deploy_floom-chat-data`

Important: `/opt/floom-mcp-preview/data/floom-chat.db` is **not** the mounted runtime DB for this service.

### 4) DB evidence
Requested read-only query target:
- `/opt/floom-mcp-preview/data/floom-chat.db`
- Result: no GEMINI rows; requested `owner_user_id` column does not exist on `apps` in this DB; only 7 apps present.

Actual runtime DB used by service:
- `/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db` (also `/data/floom-chat.db` inside container)
- Result: launch apps exist, and a global `GEMINI_API_KEY` row exists (`app_id = NULL`, length 39).

### 5) Curl verification of app_id path (no BYOK header)
- Executed `POST /api/run` without `x-user-api-key` for `ai-readiness-audit`.
- Run row shows `runs.app_id` equals the `apps.id` for slug `ai-readiness-audit`.
- Output for the created run: `dry_run=false`.

Verified on:
- `http://127.0.0.1:3051/api/run` (`floom-mcp-preview`)
- `https://preview.floom.dev/api/run` (`floom-preview-launch`)

## ROOT CAUSE
**(a) Seeder/secret state was being checked against the wrong DB path, not the live runtime DB.**

`floom-mcp-preview` reads `/data/floom-chat.db` from Docker named volume `floom-chat-deploy_floom-chat-data`, while `/opt/floom-mcp-preview/data/floom-chat.db` is a stale, non-mounted file. That stale DB has no launch GEMINI secret rows and can mislead investigation as "all apps dry-run" even though live runtime DB has seeded global GEMINI and current runs execute with `dry_run=false`.

## Proposed Fix (Phase 2)
No server code hotfix is required for secret injection path based on current runtime evidence.

Recommended operational hardening:
1. Update deploy/runbook checks to always query the mounted DB (`/data/floom-chat.db` in-container or `/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db` on host) instead of `/opt/floom-mcp-preview/data/floom-chat.db`.
2. Add a pre-deploy-complete gate script in deploy workflow that runs one real launch-app invocation and asserts `dry_run=false`.
3. Optional clarity improvement in compose/docs: explicitly document that `/opt/floom-mcp-preview/data` is not authoritative runtime state for `floom-mcp-preview`.

## Risk
- Primary risk is operational false diagnosis and delayed incident response (checking stale DB path).
- Secondary risk is regression slipping through if deploy completes without a real run assertion.

## Test Plan (must run before deploy completion)
1. Trigger a real app run without BYOK:
   - `POST /api/run` with `{"app_slug":"ai-readiness-audit","inputs":{"company_url":"https://floom.dev"}}`
2. Poll run status until terminal (`success` or `error`).
3. Assert output includes `dry_run=false` (or app-specific nested path, e.g. `meta.dry_run=false`).
4. Assert `runs.app_id` maps to expected app slug in live DB.
5. Run this gate on both preview and prod before marking deploy healthy.

Example gate command pattern:
- invoke run -> capture `run_id`
- GET `/api/run/:id` until terminal
- fail rollout if output contains `dry_run: true` or `model: "dry-run"`

## Notes
- Current live preview/prod checks performed during this investigation returned `dry_run=false` for tested runs.
- This document is Phase 1 only (investigation + workplan). No production code paths were modified.
