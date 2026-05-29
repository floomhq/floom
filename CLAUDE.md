# workeros-cloud — agent instructions

**This repo is the hosted, multi-tenant Cloud product** at `workeros.floom.dev`
(landing) + `workeros-api.floom.dev` (FastAPI). It is a thin Supabase-backed
wrapper around the open-source engine **`floomhq/workeros`**, vendored as the
`engine/` git submodule.

## CRITICAL: Stay in sync with WorkerOS (floomhq/workeros)

There is a hard ownership boundary. Respect it on every change.

### What lives HERE (cloud-owned — edit freely in this repo)
- Supabase **auth** (JWT/JWKS verify, `/auth/*` routes, cli-auth device flow)
- **Multi-tenancy**: workspaces, `workspace_id` scoping, the workspace switcher,
  per-request workspace context, ownership checks
- **Supabase repositories** (`apps/api/db/supabase_repos.py`) — the cloud impls
  of the engine's repository Protocols
- **Cloud infra glue**: `apps/api/startup.py` (engine overrides, HTTP/1.1
  patches, env-pollution guards), the `/api/proxy` Next route, basePath `/app`
  wiring, `vercel.json` rewrites, RLS migrations, billing
- The cloud **dashboard** (`web/`) and **landing** (`app/`) — these are forks of
  the engine's UI, adapted for cloud auth + basePath. UI-only engine changes are
  ported here manually.

### What lives in WorkerOS (engine — DO NOT diverge here)
- The worker model, run engine, E2B execution, scheduler, contexts feature,
  Composio integration, worker-author LLM, MCP server, the FastAPI app
  (`engine/apps/api/main.py`), models/validators (`engine/apps/api/models.py`)
- Anything in `engine/` is a pinned submodule. **Never hand-edit files under
  `engine/`** to fix a bug — that silently diverges from upstream and the next
  submodule bump wipes it.

### The rule (Federico, 2026-05-29)
> Everything that's Supabase / auth / cloud stays on the cloud side. But if you
> find a bug in the **app/engine layer**, you do a **PR to floomhq/workeros** so
> we stay in sync — then bump the submodule here. Do NOT patch `engine/` locally.

**Decision test for any fix:**
1. Is the bug in auth, workspaces, Supabase repos, proxy, basePath, RLS,
   billing, or the cloud UI fork? → fix in THIS repo.
2. Is the bug in worker/run/contexts/scheduler/validator/LLM/MCP behavior, or
   anything under `engine/`? → **PR `floomhq/workeros`**, merge it, then bump the
   `engine/` submodule pin here. File an issue first if you can't fix it.
3. Unsure? It's probably engine. Default to a WorkerOS PR over a local patch.

**A cloud-side workaround that duplicates engine logic is tech debt.** If you
must add one to unblock prod (e.g. a manifest-lift shim), open the matching
WorkerOS PR in the same session and delete the workaround once it merges.

### Sync workflow
```bash
# After a WorkerOS PR merges:
cd engine && git fetch origin && git checkout <new-sha> && cd ..
git add engine && git commit -m "chore(engine): bump to <sha> (<what>)"
# deploy: pull on /opt/workeros-cloud, git submodule update, restart service
```

## Live deployment (AX41)
- API: systemd `workeros-cloud-api` (port 8030) → Cloudflare tunnel →
  `workeros-api.floom.dev`. Restart: `systemctl restart workeros-cloud-api`.
- Live checkout: `/opt/workeros-cloud` — treat as read-only mainline; do branch
  work in `/tmp/` clones/worktrees and deploy by pulling main on `/opt`.
- Dashboard: `web/` → Vercel project `workeros-cloud-dashboard` (`/app/*`).
  Landing: repo root `app/` → Vercel landing project (apex). Deploy each with
  `vercel deploy --prod --yes` from the respective dir. NOT git-auto-deployed.
- Supabase project `sgizlsyygvlqosgwdimb`. Backend uses the **service_role** key
  (bypasses RLS). **Every public table MUST have RLS enabled** — the backend is
  the only data path; PostgREST/anon must be denied. (Audit 2026-05-29 found
  `workspaces` was the one table with RLS off; fixed in migration 0008.)

## Positioning (do not drift)
Cloud is demand-side: **"Hire AI workers for your company."** Workers = employees,
audience = founders/operators/GTM/agencies. NOT "OS for background workers", NOT
"cockpit", NOT a skills library. Hero = the new-worker prompt flow; dashboard =
outcome tiles, not infra counters.
