# fn-03 — Auth (`lib/auth.ts`, `lib/better-auth.ts`)

**Lens:** `docs/PRODUCT.md` (ICP, three surfaces `/p`, `/mcp`, `/api/:slug/run`, self-host vs cloud).  
**Scope:** `apps/server/src/lib/auth.ts`, `apps/server/src/lib/better-auth.ts`. Session resolution is implemented in `services/session.ts` but is referenced here where it defines the cookie vs bearer contract for cloud mode.

---

## 1. Two parallel auth systems

| Layer | Module | Purpose |
|-------|--------|---------|
| **Global / per-app shared token** | `auth.ts` | Optional `FLOOM_AUTH_TOKEN`: bearer (or `?access_token=` on GET) gates `/api/*`, `/mcp/*`, `/p/*` when set. Same token backs `visibility === 'auth-required'`. |
| **Multi-user identity (cloud)** | `better-auth.ts` | Only when `FLOOM_CLOUD_MODE` is truthy. Cookies + OAuth + email/password + orgs + **API keys as `Authorization: Bearer`**. |

They are **orthogonal**: global middleware checks **only** `FLOOM_AUTH_TOKEN`. Better Auth never replaces that check. If both are configured, callers on gated prefixes must satisfy **both** (global first in `index.ts`, then per-route logic).

**Product fit:** Self-host ICP gets a single shared secret to “stop casual abuse” without OAuth plumbing. Cloud ICP gets real accounts and workspaces; global token remains an operator knob for exposed instances.

---

## 2. Session / cookie vs bearer

### 2.1 Self-host (`FLOOM_AUTH_TOKEN`)

- **Bearer-only** for Floom’s global gate: `Authorization: Bearer <FLOOM_AUTH_TOKEN>` or query `access_token` (GET).
- **Not** session cookies. Health (`/api/health`) and metrics (`/api/metrics`) bypass global auth; metrics uses its own token elsewhere.

### 2.2 Cloud — Better Auth (`better-auth.ts`)

- **Primary:** HttpOnly session cookies (`cookiePrefix: 'floom'`, SameSite=Lax, Secure pinned in options). `resolveUserContext` forwards `c.req.raw.headers` into `auth.api.getSession`, so **cookie-backed browser sessions** resolve to `SessionContext` with `is_authenticated: true`.
- **Programmatic:** `@better-auth/api-key` documents **`Authorization: Bearer <api-key>`**. Better Auth’s `getSession` is responsible for treating that as an authenticated user. That is the intended path for **MCP / headless** against cloud without browser cookies.
- **Trusted origins:** Dev adds `http://localhost:5173`; prod does not — reduces stray CSRF/cross-origin cookie surface vs always-trusting Vite.

### 2.3 Ambiguity / collision

- **One `Authorization` header:** Global auth compares the entire bearer string to `FLOOM_AUTH_TOKEN` **before** route handlers run. A cloud user sending **only** a Better Auth API key (different string) **fails** global middleware if `FLOOM_AUTH_TOKEN` is set. Operators who enable both must either align tokens (not intended) or not use global token on routes that need BA bearer keys — today that is a **configuration footgun**.
- **`isAuthenticated` in `auth.ts`:** Returns `true` when `FLOOM_AUTH_TOKEN` is **unset** (“no global auth = everyone passes”). Name is misleading vs `hasValidAdminBearer`, which returns `false` when no token is configured.

---

## 3. `requireAuthenticatedInCloud`

```169:181:apps/server/src/lib/auth.ts
export function requireAuthenticatedInCloud(
  c: Context,
  ctx: SessionContext,
): Response | null {
  if (!isCloudMode()) return null;
  if (ctx.is_authenticated) return null;
  return c.json(
    {
      error: 'Authentication required. Sign in and retry.',
      code: 'auth_required',
    },
    401,
  );
}
```

- **OSS:** Always no-op (`isCloudMode()` false).
- **Cloud:** Requires `ctx.is_authenticated === true` (set only after a successful Better Auth session / API key resolution in `resolveUserContext`).
- **Usage pattern (elsewhere):** Write/mutation routes on hub, workspaces, memory, secrets, triggers, me_apps, etc. It does **not** replace workspace RBAC; it only blocks **anonymous** cloud traffic from mutating data while still using synthetic `local` ids in the returned context for anonymous browsing.

**Gap:** Any cloud **read** route that omits this helper but scopes only by `workspace_id` from context may still serve data to anonymous sessions if those rows live in the default workspace — that is a **route-level** concern, not enforced inside these two files.

---

## 4. Gates (what each layer enforces)

| Mechanism | When active | What it checks |
|-----------|-------------|----------------|
| `globalAuthMiddleware` | `FLOOM_AUTH_TOKEN` set | Bearer / query token === env; constant-time compare |
| `checkAppVisibility('public')` | Always | Pass |
| `checkAppVisibility('private')` | Always | `ctx.user_id === author`; missing author → 404; mismatch → 404 (no existence leak). OSS: seeded apps with `author === 'local'` and synthetic user pass. |
| `checkAppVisibility('auth-required')` | Always | Same bearer as `FLOOM_AUTH_TOKEN`; if env unset → **401** with explicit message to set the var |
| `hasValidAdminBearer` | Per-handler (e.g. run fetch bypass) | Token configured **and** matches — `false` if unset (distinct from `isAuthenticated`) |
| `requireAuthenticatedInCloud` | Cloud only | Better Auth-backed session |

**`auth-required` vs cloud login:** Per-app “auth-required” still means **shared Floom token**, not “logged-in Floom user”. A cloud user with a valid session but **without** `FLOOM_AUTH_TOKEN` on an `auth-required` app gets **401** from `checkAppVisibility`, not from Better Auth.

---

## 5. OSS mode (`FLOOM_CLOUD_MODE` unset/false)

- **`getAuth()`** returns `null`; Better Auth not constructed; `runAuthMigrations()` no-op.
- **`requireAuthenticatedInCloud`:** no-op — all writes that only use this gate remain allowed for the synthetic user (aligned with single-tenant self-host).
- **`checkAppVisibility('private')`:** Comment in code: OSS uses `DEFAULT_USER_ID` (`'local'`) matching locally seeded `author`; **404** if someone points `private` at a non-local author without a matching session user.
- **Global token:** Still optional; without it, `globalAuthMiddleware` is a no-op — instance is public on `/api`, `/mcp`, `/p` unless other routes add checks.

---

## 6. Edge cases and footguns

1. **`auth-required` without `FLOOM_AUTH_TOKEN`:** Hard 401 — correct but easy to misconfigure in cloud where product mental model is “user logged in”.
2. **Anonymous cloud session:** `resolveUserContext` returns synthetic `local` workspace/user with `is_authenticated: false`; mutating routes that call `requireAuthenticatedInCloud` reject. Reads depend on other scoping.
3. **`getSession` throws:** Session service treats as anonymous (401 only where gated) — avoids total outage; failed auth degrades to anonymous.
4. **`FLOOM_AUTH_TOKEN` + Better Auth API key:** Single `Authorization: Bearer` cannot satisfy two different secrets; see §2.3.
5. **Query token `access_token`:** Works for GET on global gate; logging/referrer leakage risk if URLs are shared (inherent to query auth).
6. **Email / reset:** `BETTER_AUTH_SECRET` shorter than 16 characters throws at options build — fail-fast on misconfiguration. Resend missing → reset URL logged only; anti-enumeration preserved on client.
7. **SAML / magic link / passkeys:** Explicitly deferred or removed per comments; magic link endpoint intentionally absent.

---

## 7. Security positives

- Constant-time comparison for `FLOOM_AUTH_TOKEN`.
- `private` apps use **404** for non-owners to avoid enumeration.
- `hasValidAdminBearer` design avoids treating “no global token” as admin (run lockdown rationale in `run.ts`).

---

## 8. Summary

`auth.ts` implements **operator-grade shared bearer** gating and **per-app visibility** that is still bearer-centric for `auth-required`. `better-auth.ts` implements **cloud identity** (cookies + plugins) behind `FLOOM_CLOUD_MODE`, with strict boot requirements for secrets and URL. **`requireAuthenticatedInCloud` bridges cloud identity to write routes** while OSS stays single-user synthetic. The main **conceptual seam** for auditors: **Better Auth session/API key ≠ `FLOOM_AUTH_TOKEN` ≠ per-app `auth-required`**, and the **same Authorization header** cannot simultaneously carry two different bearer secrets when global auth is enabled.
