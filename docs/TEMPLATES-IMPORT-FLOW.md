# Templates → import flow (next step, NOT yet built)

The /templates catalog is display-only today: "Hire this worker" -> /login.
To make templates *usable*, wire instantiate-into-workspace. This needs the
engine (absent from a landing-only clone), so it must be done from a clone with
the `engine/` submodule + a deploy.

## Flow
1. Detail "Hire" button -> `/login?next=/templates/hire?worker=<slug>` (or `?workspace=<slug>`).
2. New server page `app/(marketing)/templates/hire/page.tsx`:
   - `readSession()`; if unauthenticated, the `next=` already routes back post-login.
   - Resolve the template from `components/landing-ref/data.ts` (`getTemplate` / `getWorkspace`) — name, job, tools, sample.
3. Provision via the EXISTING engine path (no new worker model):
   - Worker: `POST /api/workers/draft-and-create` (already wrapped in `apps/api/main.py:cloud_draft_and_create`, persists files to Supabase) with a prompt built from the template:
     `"Build a worker named '{name}'. {job} Tools: {tools}. Output: {output}."`
   - Workspace: call draft-and-create once per member worker (`getWorkspaceWorkers`).
   - Confirm `DraftAndCreateRequest` field names against the engine before sending.
4. Redirect to the created worker/run in the dashboard (`/app/...` — confirm the worker route).

## To verify (can't be done from a landing-only clone)
- `DraftAndCreateRequest` contract.
- The dashboard route for a freshly created worker/run.
- End-to-end: signup -> hire -> worker exists in workspace -> first run.

## Optional
- Record hires (the cut `marketplace_hires` table on `feat/worker-marketplace-v1`) if "you've hired this" UI is wanted. Not required for basic import.

The full marketplace backend (reviews/community/moderation + migration 0048 +
apps/api/routes/marketplace.py) is parked on `feat/worker-marketplace-v1`.
