# Workeros: Supabase + auth wiring brief (for the agent dispatched by the operator)

**Audience:** the agent (Codex or other) the operator will dispatch to wire Workeros
to Supabase Auth + Supabase Postgres on the `-cloud` deployment, while keeping
the local v0 (SQLite + `x-floom-secret`) working unchanged.

**Author:** Claude (orchestrating Workeros UI/UX overnight); prep + briefing
only. The agent the operator dispatches owns the actual implementation.

**Constraint the operator stated:** "keep it all super modular so auth and db are
basically interchangeable so that cloud and local don't drift too far from
each other."

---

## TL;DR

Wrap every auth + DB call behind two interfaces. Local = current adapters
(secret-header + SQLite). Cloud = Supabase adapters (JWT verification +
postgres-py / supabase-py). Same business logic runs against either. The
`-cloud` repo merges back into `-mvp` (this repo) via a `WORKEROS_DEPLOY=local`
vs `WORKEROS_DEPLOY=cloud` env switch so we stop drifting two repos.

---

## Current state (as of 2026-05-28 evening, post R7 + S28)

### Repo
- `/root/workeros` — this repo (single-user v0). FastAPI + Next.js 16 + SQLite.
  Production: https://workers.floom.dev (web), https://workers-api.floom.dev (api).
- `-cloud` repo — the operator says outdated. Don't touch as-is; absorb its delta
  into this repo behind the env switch.

### Auth (today)
- Single shared secret: `FLOOM_SECRET` env var.
- Backend: `apps/api/main.py` route decorators use `Depends(require_secret)`
  which reads header `x-floom-secret` and compares against env.
- CLI: caller passes the secret. Browser: same.
- Composio OAuth callbacks: HMAC signature on inbound webhooks via
  `composio-events` route.
- There is no concept of "users". `user_id="federico"` is a hard-coded
  string used in DB rows for future multi-tenant readiness.

### DB (today)
- SQLite file at `apps/api/data/floom.db`.
- Tables (high level): `workers`, `runs`, `connections`, `secrets`, `cli_auth_devices`.
- Connection layer: a thin `apps/api/db.py` with `sqlite3.connect(...)` and
  hand-written SQL. No ORM.
- All queries are `SELECT ... WHERE user_id = ?` where `user_id` is currently
  always `"federico"` in single-user mode.

### Connections (Composio)
- Composio is the OAuth aggregator (Gmail / Google Cal / LinkedIn / etc.).
- Backend stores `composio_connection_id` per row.
- Composio uses Workeros user_id as Composio's `user_id` for scoping. Today
  Workeros sends `"federico"`. In cloud this becomes the Supabase user UUID.

---

## Target architecture

### Auth abstraction

```
apps/api/auth/
  __init__.py
  interface.py        # AuthProvider abstract
  local.py            # SharedSecretAuthProvider (today's logic)
  supabase.py         # SupabaseAuthProvider (JWT verify, JWKS cache)
  factory.py          # selects based on WORKEROS_DEPLOY
```

`AuthProvider` interface:
```python
class AuthProvider(Protocol):
    async def verify(self, request: Request) -> AuthContext: ...
    # AuthContext = { user_id: str, email: Optional[str], scopes: list[str] }
```

- `SharedSecretAuthProvider.verify` reads `x-floom-secret` header, compares
  against env, returns `AuthContext(user_id="federico", email=None, scopes=["admin"])`
  if match, else raises 401.
- `SupabaseAuthProvider.verify` reads `Authorization: Bearer <jwt>` header,
  verifies signature against Supabase JWKS (cached 24h), returns
  `AuthContext(user_id=jwt.sub, email=jwt.email, scopes=jwt.app_metadata.scopes or [])`.

Every route uses `Depends(get_auth)` which returns `AuthContext`. The route
then uses `auth.user_id` for any scoping query — never a hardcoded
`"federico"`.

**Migration path:** existing `require_secret` becomes a thin wrapper around
`SharedSecretAuthProvider`. Codebase-wide replace `user_id="federico"` with
`user_id=auth.user_id`.

### DB abstraction

```
apps/api/db/
  __init__.py
  interface.py        # Repository abstract (workers, runs, connections, ...)
  sqlite.py           # SQLiteRepository (today's logic)
  supabase.py         # SupabaseRepository (uses supabase-py + RLS)
  factory.py          # selects based on WORKEROS_DEPLOY
```

Each domain gets a repository: `WorkerRepository`, `RunRepository`,
`ConnectionRepository`, `SecretRepository`, `CliAuthRepository`. Same interface,
two impls.

Example:
```python
class WorkerRepository(Protocol):
    async def list_by_user(self, user_id: str) -> list[Worker]: ...
    async def get(self, user_id: str, worker_id: str) -> Optional[Worker]: ...
    async def create(self, user_id: str, worker: Worker) -> Worker: ...
    async def delete(self, user_id: str, worker_id: str) -> None: ...
```

**SQLite impl:** today's hand-written SQL, parameterized by `user_id`.
**Supabase impl:** `supabase.table("workers").select("*").eq("user_id", user_id).execute()`. RLS in Postgres ALSO enforces scoping (defense in depth).

### Composio integration unchanged (mostly)

- Composio call site already takes `user_id` as a parameter.
- In local, `user_id="federico"`. In cloud, `user_id=auth.user_id` (Supabase UUID).
- Existing Composio webhook HMAC verification stays.
- Connection rows store both `workeros_user_id` AND `composio_user_id` (today
  they are the same string; in cloud they are explicitly the Supabase UUID).

### Env switch

```
WORKEROS_DEPLOY=local           # default: x-floom-secret + SQLite
WORKEROS_DEPLOY=cloud           # Supabase Auth + Supabase Postgres

# Local-mode env (unchanged)
FLOOM_SECRET=<secret>
WORKEROS_DB_PATH=apps/api/data/floom.db

# Cloud-mode env (new)
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<key>
SUPABASE_SERVICE_ROLE_KEY=<key>     # server-only, RLS bypass for system tasks
SUPABASE_JWT_SECRET=<secret>        # JWT verification
```

`factory.py` in auth + db reads `WORKEROS_DEPLOY` and returns the right impl
at startup.

---

## Frontend (Next.js) implications

### Auth wiring

`apps/web/lib/auth.ts` becomes the single source of truth for "how do we
authenticate API calls":

```typescript
// Two modes:
// local: x-floom-secret header (from localStorage or env)
// cloud: Authorization: Bearer <supabase JWT> (from Supabase client session)
export function authHeaders(): Record<string, string> {
  if (process.env.NEXT_PUBLIC_WORKEROS_DEPLOY === "cloud") {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
  }
  return { "x-floom-secret": localStorage.getItem("FLOOM_SECRET") || "" };
}
```

All `api.ts` calls use `authHeaders()` instead of hard-coding the secret header.

### Sign-in flow (cloud only)

New routes (only rendered when `NEXT_PUBLIC_WORKEROS_DEPLOY=cloud`):
- `/auth/login` — Supabase magic-link or password
- `/auth/callback` — handles Supabase OAuth callback
- `/auth/logout` — calls `supabase.auth.signOut()`

Sidebar footer: "Local user" (when local) OR user email + avatar (when cloud,
read from Supabase session). the operator explicitly asked for this in round 9:
> "Floom v0 at bottom left sucks. replace. maybe with user profile? like
> local user for this or so?"

### Middleware

`apps/web/middleware.ts` — when in cloud mode, redirect unauthenticated users
to `/auth/login`. When in local mode, the secret-gate is in-page (not middleware).

---

## Migration plan (for the dispatched agent)

Phased so neither mode breaks at any step.

### Phase 1 — auth abstraction (no behavior change, local stays default)
1. Create `apps/api/auth/{interface,local,supabase,factory}.py`.
2. Move existing `require_secret` logic into `SharedSecretAuthProvider`.
3. Add `Depends(get_auth_context)` to every route in `apps/api/main.py`
   (about 48 endpoints — see openapi.json).
4. Replace any hardcoded `user_id="federico"` with `auth.user_id`.
5. Test: `WORKEROS_DEPLOY=local` everything still passes pytest + R7 probe.

### Phase 2 — DB abstraction (no behavior change)
1. Create `apps/api/db/{interface,sqlite,supabase,factory}.py`.
2. Move existing SQLite hand-written SQL into `SQLiteRepository.*`.
3. Refactor route handlers to inject the repositories via `Depends`.
4. Test: local mode passes pytest + adversarial probe.

### Phase 3 — Supabase implementations (cloud mode now functional)
1. Implement `SupabaseAuthProvider.verify`.
2. Implement `SupabaseRepository` impls per domain.
3. Apply Supabase schema migrations: tables + RLS policies. RLS scoped on
   `auth.uid()` so users only see their own rows even at the DB level.
4. Add Supabase client to apps/web; build `/auth/login`, `/auth/callback`.
5. Build the sidebar user-profile footer (replaces "Floom v0").

### Phase 4 — `-cloud` repo merge
1. Diff `-cloud` repo against this repo.
2. Identify any cloud-only features (multi-tenant org switching? team
   invites? billing hooks?) and absorb them behind feature flags.
3. Archive `-cloud` repo; this repo is now single source.

### Phase 5 — verification
1. Spin up a Supabase project (test env).
2. Set `WORKEROS_DEPLOY=cloud` env + Supabase keys.
3. Run the same R7 security probe + UI test matrix against cloud deploy.
4. Verify RLS scoping: create 2 test users, assert user A cannot read user B's
   workers via any endpoint.

---

## Hard constraints for the dispatched agent

1. **Local mode must keep working at every step.** No "we'll fix local later"
   commits. Every PR is tested with `WORKEROS_DEPLOY=local` first.
2. **No business logic in adapters.** Adapters do only auth verification and
   data CRUD. Business rules (e.g. "max 64-char secret name") stay in route
   handlers + service modules. Same rules apply to both deploy modes.
3. **RLS as belt + suspenders.** Even though the Supabase repository scopes
   by `user_id`, Postgres RLS policies MUST also scope on `auth.uid()`.
   Defense in depth — a bug in the repo layer must not leak data.
4. **No env-var auth secrets in cloud.** Cloud mode uses Supabase Auth
   exclusively. `FLOOM_SECRET` is ignored when `WORKEROS_DEPLOY=cloud`.
5. **Cloud mode requires HTTPS.** Refuse to boot if `SUPABASE_URL` is not
   https and we're not in dev.
6. **Tests must run against BOTH modes** in CI. Add a matrix job:
   `WORKEROS_DEPLOY=local` and `WORKEROS_DEPLOY=cloud` (against a Supabase
   test project or local Supabase stack via `supabase start`).

---

## Open questions (defer to the operator)

1. **Multi-tenant org model?** Or one Supabase user = one workspace? The
   `-cloud` repo may already have an opinion here.
2. **Pricing / tiers?** Cloud adds billing surface; out of scope for this
   brief but the User row should carry `plan` + `quota` columns.
3. **Composio user_id**: in local we send `"federico"`. In cloud, do we send
   the Supabase UUID, or generate a Composio-specific tenant ID and store the
   mapping? UUID is simpler. UUID it is unless the operator says otherwise.
4. **Webhook secrets per-worker.** Today they're stored plaintext in SQLite.
   In cloud they should be Postgres `pgsodium`-encrypted at rest or rely on
   Supabase Vault.
5. **Composio API key**: today stored in env. In cloud, who pays Composio?
   If per-user, billing model needs to surface this. If platform-paid, env
   stays.

---

## Files to read before starting

1. `apps/api/main.py` — every route currently uses `Depends(require_secret)`. Map them.
2. `apps/api/db.py` — current SQLite layer. Inline SQL throughout.
3. `apps/api/connections_service.py` (and adjacent) — Composio integration.
4. `apps/api/run_service.py` — run lifecycle + SSE stream from S22d.
5. `apps/web/lib/api.ts` — frontend API client (header source).
6. `apps/web/components/layout/sidebar.tsx` — the "Floom v0" footer the operator
   wants replaced.
7. `openapi.json` (curl `/openapi.json` against local API) — 48 routes; the
   migration touches each.
8. The `-cloud` repo (the operator to share path) — diff against this one.

---

## Estimated effort

- Phase 1 (auth abstraction): 1 day
- Phase 2 (DB abstraction): 2 days
- Phase 3 (Supabase impls): 2-3 days
- Phase 4 (-cloud merge): 1 day
- Phase 5 (verification): 1 day

Total: 7-8 days of focused work. Can ship as 5 sequential PRs (one per
phase). Each phase must keep local mode green before opening the PR.

---

## Authored by

Claude, 2026-05-28 evening session. Living document — update as the
dispatched agent learns more during implementation.
