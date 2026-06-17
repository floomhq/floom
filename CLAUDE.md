# workeros-cloud — agent instructions

**This repo is the hosted, multi-tenant Cloud product** at `workeros.floom.dev`
(landing) + `workeros-api.floom.dev` (FastAPI). It is a thin Supabase-backed
**wrapper** around the **WorkerOS engine `floomhq/workeros`** (private repo,
single-tenant), vendored as the `engine/` git submodule.

## CRITICAL: ALWAYS stay in sync with WorkerOS. You are building the WRAPPER ONLY.

> **Federico, standing rule (2026-05-30):** "We ALWAYS want to stay in sync with
> workeros. You are just building the cloud wrapper."

`floomhq/workeros` (`engine/`) is the **single source of truth** for the product —
the worker model, the run engine, AND the entire dashboard UI. The cloud product
is `engine` + a thin cloud overlay (auth, workspaces, hosting). **Nothing else.**

**The dashboard UI is NOT a fork to maintain. It IS the engine's `apps/web`.**
The cloud `web/` must track `engine/apps/web` so closely that bumping the submodule
pulls in every UI change automatically. If `web/` drifts from `engine/apps/web`
(different nav order, missing pages like `/approvals`, stale components), that is a
**bug to eliminate**, not a state to manage. The only differences allowed are the
cloud seams below. (History: `web/` was once a hand-ported fork and silently fell
196 commits behind the engine — never again. De-fork tracked in WORKPLAN-20260530.)

There is a hard ownership boundary. Respect it on every change.

### What lives HERE (cloud-owned — the ONLY things this repo adds)
- Supabase **auth** (JWT/JWKS verify, `/auth/*` routes, cli-auth device flow)
- **Multi-tenancy**: workspaces, `workspace_id` scoping, the workspace switcher,
  per-request workspace context, ownership checks
- **Supabase repositories** (`apps/api/db/supabase_repos.py`) — the cloud impls
  of the engine's repository Protocols
- **Cloud infra glue**: `apps/api/startup.py` (engine overrides, HTTP/1.1
  patches, env-pollution guards), the `/api/proxy` Next route, basePath `/app`
  wiring, `vercel.json` rewrites, RLS migrations, billing
- The **cloud overlay** on the dashboard `web/`: the auth/account footer, the
  `WorkspaceSwitcher`, `/api/me`, `/api/cli-auth`, the proxy route, and the
  `NEXT_PUBLIC_API_PROXY_BASE` / `NEXT_PUBLIC_BASE_PATH` env wiring. **Everything
  else under `web/` should equal `engine/apps/web` byte-for-byte.** If a page or
  component needs a real change, it's almost always an **engine** change (below).
- The **landing** (`app/`, apex project) — the only genuinely cloud-owned UI
  (marketing pages, `/login`, vertical pages). Even here, match the engine's
  design system (warm matte, near-black buttons, Geist) — workers.floom.dev is the
  visual source of truth.

### What lives in WorkerOS (engine — DO NOT diverge here)
- The worker model, run engine, E2B execution, scheduler, contexts feature,
  Composio integration, worker-author LLM, MCP server, the FastAPI app
  (`engine/apps/api/main.py`), models/validators (`engine/apps/api/models.py`)
- **The ENTIRE dashboard UI** (`engine/apps/web`): every page, component, nav
  item, design token, the worker-builder flow, runs/connections/contexts/
  approvals/overview screens. A dashboard UI change = an **engine PR**, then a
  submodule bump here. The cloud `web/` only injects the overlay listed above.
- Anything in `engine/` is a pinned submodule. **Never hand-edit files under
  `engine/`** to fix a bug — that silently diverges from upstream and the next
  submodule bump wipes it.

### The rule (Federico, 2026-05-29)
> Everything that's Supabase / auth / cloud stays on the cloud side. But if you
> find a bug in the **app/engine layer**, you do a **PR to floomhq/workeros** so
> we stay in sync — then bump the submodule here. Do NOT patch `engine/` locally.

**Decision test for any fix:**
1. Is it the cloud overlay — auth, workspaces, Supabase repos, proxy, basePath,
   RLS, billing, or the apex landing/`/login`? → fix in THIS repo.
2. Is it ANYTHING in the dashboard UI (a page, component, nav order, design,
   worker flow) or worker/run/contexts/scheduler/validator/LLM/MCP behavior, or
   anything under `engine/`? → **PR `floomhq/workeros`**, merge it, then bump the
   `engine/` submodule pin here. File an issue first if you can't fix it.
3. Unsure? It's the engine. Default to a WorkerOS PR over a local patch — the
   dashboard UI is the engine's, not ours to fork.

**A cloud-side workaround that duplicates engine logic is tech debt.** If you
must add one to unblock prod (e.g. a manifest-lift shim), open the matching
WorkerOS PR in the same session and delete the workaround once it merges.

### Sync workflow
```bash
# After a WorkerOS PR merges:
cd engine && git fetch origin && git checkout <new-sha> && cd ..
git add engine && git commit -m "chore(engine): bump to <sha> (<what>)"
# deploy: railway up --service workeros-cloud-api, then run smoke gate
```

## Live deployment
- API: Railway service `workeros-cloud-api`, public base
  `https://workeros-api.floom.dev`. Deploy from this repo after the engine
  submodule is pinned:

  ```bash
  railway up --service workeros-cloud-api
  bash ops/smoke-routes.sh cloud
  ```

- API engine/runtime env required for performant E2B execution:

  ```bash
  WORKEROS_E2B_WARM_POOL_ENABLED=1
  WORKEROS_E2B_WARM_POOL_SIZE_PER_KEY=1
  WORKEROS_E2B_WARM_POOL_MAX_AGE_SECONDS=900
  ```

  These flags keep successful read-only local-context E2B sandboxes warm for
  repeat runs of the same worker/template/context shape. Workers with writeable
  memory/context mounts or git-backed contexts stay on the cold path so
  writeback and clone semantics remain correct.

- Dashboard: `web/` -> Vercel project `workeros-cloud-dashboard`, served at
  `/app/*` via the apex project's `vercel.json` rewrite to
  `workeros-cloud-dashboard.vercel.app`. Landing: repo root `app/` -> Vercel
  landing project `workeros-cloud-landing` (apex). NOT git-auto-deployed.
- **HARD post-deploy gate:** after every production deploy and before relying on
  any production alias, run `bash ops/smoke-routes.sh` from the repo root. It
  MUST pass. If it fails, the deploy is not promoted, and any changed alias is
  rolled back to the last known-good deployment. This is the no-CI compensating
  control for route loops and server errors.
- **Dashboard is DE-FORKED (2026-05-30, see WORKPLAN-20260530-defork-dashboard).**
  `web/` is NOT a fork of `engine/apps/web` — it IS the engine UI, synced at
  build by `web/scripts/sync-engine-web.mjs` + a 7-file cloud overlay in
  `web/overlay/`. The synced tree (`web/{app,components,lib,public,tests}` + root
  config) is **generated + gitignored**; only `web/overlay/`, `web/scripts/`,
  `web/package.json`, and config are tracked. To deploy the dashboard, run
  `cd web && npm run deploy:prod`; it runs `npm run sync`, deploys with Vercel,
  then runs the hard smoke gate. If using raw Vercel commands, the equivalent is
  `npm run sync && vercel deploy --prod --yes && cd .. && bash ops/smoke-routes.sh`
  (sync MUST run first so the generated tree is on disk and uploaded — the Vercel
  build can't reach the root `engine/` submodule, so its `sync` step skips and
  uses the uploaded tree).
  To pull engine UI changes: bump the submodule, `npm run sync`, deploy. The env
  seams `NEXT_PUBLIC_BASE_PATH=/app` + `NEXT_PUBLIC_API_PROXY_BASE=/app/api/proxy`
  are baked into `web/package.json`'s build script. `npm run check-drift` (CI)
  fails if the synced tree differs from the engine — it can never silently drift.
  Engine seams live upstream (floomhq/workeros#324: env api-base, env basePath,
  exported sidebar parts). Landing deploys with `npm run deploy:prod` from the
  repo root, or `vercel deploy --prod --yes && bash ops/smoke-routes.sh`.
- Supabase project `sgizlsyygvlqosgwdimb`. Backend uses the **service_role** key
  (bypasses RLS). **Every public table MUST have RLS enabled** — the backend is
  the only data path; PostgREST/anon must be denied. (Audit 2026-05-29 found
  `workspaces` was the one table with RLS off; fixed in migration 0008.)

## Positioning (do not drift)
Cloud is demand-side: **"Hire AI workers for your company."** Workers = employees,
audience = founders/operators/GTM/agencies. NOT "OS for background workers", NOT
"cockpit", NOT a skills library. Hero = the new-worker prompt flow; dashboard =
outcome tiles, not infra counters.
