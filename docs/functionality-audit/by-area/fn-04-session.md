# FN-04 — Session service (`apps/server/src/services/session.ts`)

**Scope:** `resolveUserContext`, device/workspace identifiers, failure behavior, impersonation and trust boundaries.  
**Product anchor:** [`docs/PRODUCT.md`](../../PRODUCT.md) — tenant context is how every surface (`/p/:slug`, `/mcp/app/:slug`, `/api/:slug/run`) scopes memory, runs, and connections for the ICP “paste repo, we host it” model without the user managing infra.

---

## 1. `resolveUserContext`

### Role

Builds a request-scoped `SessionContext` (`workspace_id`, `user_id`, `device_id`, `is_authenticated`, optional Better Auth fields) consumed across API routes, MCP, rate limiting, and workspace services. Keeps OSS and Cloud on the same query shape (`workspace_id = ?`) per the synthetic defaults pattern in `db.ts`.

### Control flow

1. **`device_id`** — Always from `getOrCreateDeviceId(c)` (read `floom_device` cookie or mint UUIDv4 and `Set-Cookie`).
2. **OSS** (`FLOOM_CLOUD_MODE` not truthy) — Returns immediately: `workspace_id` / `user_id` = `local`, `is_authenticated: false`.
3. **Cloud** — If `getAuth()` is null (should not happen when cloud mode is on and auth booted), falls back to the same OSS-shaped object.
4. **Cloud + auth** — `auth.api.getSession({ headers: c.req.raw.headers })`. On success: upsert `users`, resolve/create active workspace (`getActiveWorkspaceId` or `bootstrapPersonalWorkspace`), run `rekeyDevice`, return real ids with `is_authenticated: true`.
5. **Cloud, no session** — Returns the **same literal ids as OSS** (`local` / `local`) with `is_authenticated: false`, not SQL NULLs. Inline comments mention “NULL workspace/user”; the implementation deliberately uses defaults so existing scoped queries keep working; separation from real users is **`is_authenticated`** plus route-level gates (e.g. `requireAuthenticatedInCloud` in `lib/auth.ts`).

### Coupling

- **Better Auth** — Session identity is whatever `getSession` returns; Floom mirrors `id` / `email` / `name` into `users` with `auth_provider = 'better-auth'`.
- **Workspaces** — Active org is `user_active_workspace`; first login may create a personal workspace and membership in one transaction.

---

## 2. Workspace and device IDs

### Workspace

| Mode | Value |
|------|--------|
| OSS | `DEFAULT_WORKSPACE_ID` (`local`) |
| Cloud, authenticated | Active workspace id (`ws_…` from DB) |
| Cloud, anonymous | `local` (synthetic), same as OSS |

Workspace switching is **not** in this file; it lives in workspace routes/services and updates `user_active_workspace`. `resolveUserContext` only reads the active row (via `getActiveWorkspaceId`) after auth.

### User

| Mode | Value |
|------|--------|
| OSS / Cloud anonymous | `DEFAULT_USER_ID` (`local`) |
| Cloud, authenticated | Better Auth `user.id` |

### Device

- Cookie name: `floom_device`.
- **Attributes:** `HttpOnly`, `SameSite=Lax`, long `Max-Age` (~10y), `Path=/`; `Secure` when `NODE_ENV === 'production'` or `PUBLIC_URL` starts with `https://`.
- **Not validated** as UUID on read; any non-empty string from the cookie is accepted. Empty value after `=` is treated as absent (new id minted).
- **Purpose:** Stable anonymous key for pre-login memory/runs/connections; `rekeyDevice` binds rows from `(device_id, synthetic user)` to `(user_id, real workspace)` after login.

### `buildContext`

Constructs a `SessionContext` from explicit ids (tests, workers). **Security is entirely caller-side** — no Hono request, no cookies, no Better Auth.

---

## 3. Failure modes

| Scenario | Behavior |
|----------|----------|
| `getSession` throws | Caught; `session = null` → anonymous branch (OSS-shaped ctx, `is_authenticated: false`). Sensitive writes must use `requireAuthenticatedInCloud` or equivalent. |
| `getAuth()` null in cloud | OSS-shaped fallback (same as OSS anonymous). Misconfiguration risk if cloud flag and auth singleton disagree. |
| `rekeyDevice` throws | Caught and swallowed; request still returns **authenticated** ctx if session was valid. Risk: anonymous rows may remain under `user_id = local` while the user is already “logged in” for gating purposes — inconsistent until a later successful rekey. |
| Malformed / attacker-chosen `device_id` string | No format check. `rekeyDevice` requires non-empty ids; SQL uses parameterized values. Main risk is **logic/UX** (unexpected grouping), not injection from this path alone. |
| `bootstrapPersonalWorkspace` / SQLite | WAL + `busy_timeout` mitigate contention; concurrent first-login races could theoretically stress slug uniqueness / membership inserts (mitigated by transactions and slug retry loop). |
| Cloud boot / `getAuth()` first call | `buildAuthOptions()` throws if secrets invalid when auth is built — typically surfaces at process startup when auth is initialized, not silently per request (depends on call order). |

---

## 4. Impersonation and trust risks

### What this module does **not** do

- No admin “act as user X” switch, no user id from client headers or body. **Effective user id** in normal HTTP flow = Better Auth session (or `local`).

### Trust boundaries

1. **Better Auth session cookie / API key** — Whoever holds a valid session (or key resolved by Better Auth into `getSession`) is treated as that user. Standard session hijacking and token theft apply; mitigations are cookie flags (Better Auth’s own cookies + `floom_device` policy above), TLS, and org product hardening outside this file.
2. **`floom_device` on shared browser** — Pre-login data is keyed by device cookie. The first user to **log in** on that profile triggers `rekeyDevice` for **that** `device_id` → **their** `user_id`. Another person using the same browser profile later inherits the same device cookie; their subsequent login rekeys the same anonymous rows to the new account. That is intentional “browse then sign up” behavior, not cross-session impersonation of an already-logged-in user.
3. **Anonymous cloud ctx uses `local`** — If a route forgets `requireAuthenticatedInCloud` or `is_authenticated` checks, anonymous cloud users could theoretically hit code paths written only for OSS “single tenant local”. Defense in depth: cloud write routes should gate on `is_authenticated`; `checkAppVisibility(..., 'private')` compares `ctx.user_id` to app `author`, so real private apps do not match `local`.
4. **`buildContext` misuse** — Any internal code that fabricates a context with another user’s ids is equivalent to impersonation; not reachable from external HTTP without a bug elsewhere.

### `rekeyDevice` (related security notes)

- Updates only rows still tied to anonymous / default user (`DEFAULT_USER_ID` or NULL as documented in SQL). Idempotent for already-claimed rows.
- **Connections:** `owner_kind` / `owner_id` flip from device to user; `NOT EXISTS` avoids clobbering an existing user-scoped connection for the same provider in the target workspace (can leave parallel device-orphaned rows — documented in source comments).
- **Composio:** `composio_user_id` may be backfilled with `device:<device_id>` when connections moved; no rename of external Composio ids.

---

## 5. Product fit (from `docs/PRODUCT.md`)

Session context is the glue between **three surfaces** and **multi-tenant cloud**: same scoping primitives for self-hosted solo mode (`local`) and hosted Floom (real workspace + user). It supports the “anonymous try → sign in → migrate my runs/memory” story without the ICP configuring OAuth plumbing themselves. Deleting or bypassing this layer would break tenant isolation for memory, runs, jobs, and connections; it is not listed as a separate row in the load-bearing table but underpins routes that are (`mcp.ts`, `jobs.ts`, hub/run paths).

---

## 6. Suggested follow-ups (audit only; not implemented here)

- Align stale comments (“NULL workspace/user”) with the actual `local` / `local` anonymous-cloud behavior to avoid maintainer confusion.
- Consider structured logging when `rekeyDevice` fails in production so operators can detect stuck anonymous rows.
- Optional: validate `floom_device` format (UUID) on read and rotate if invalid, if product wants stricter device semantics.
