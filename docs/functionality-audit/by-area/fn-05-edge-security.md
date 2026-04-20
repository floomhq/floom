# Backend audit: edge security (`rate-limit.ts`, `scoped.ts`, `security.ts`)

**Scope:** `apps/server/src/lib/rate-limit.ts`, `apps/server/src/lib/scoped.ts`, `apps/server/src/middleware/security.ts`, plus how they sit in the Hono stack relative to CORS in `apps/server/src/index.ts`.

**Product alignment:** Per `docs/PRODUCT.md`, Floom’s promise is production hosting with auth, rate limits, and three surfaces (web form, MCP, HTTP). In-process rate limiting and browser-facing security headers support that story for single-replica / preview-style deployments; they are not a substitute for edge WAF, Redis-backed limits, or Postgres RLS (the latter is explicitly deferred in code comments).

---

## `lib/rate-limit.ts` — bypass surfaces

| Vector | Behavior |
|--------|----------|
| **Env kill switch** | `FLOOM_RATE_LIMIT_DISABLED === 'true'` skips all middleware checks and `checkMcpIngestLimit`. Documented in-file; intended for local/stress runs, but any host that sets it accidentally removes limits entirely. |
| **Trusted proxy misconfiguration** | Client IP for limits uses `X-Forwarded-For` / `X-Real-IP` / `Cf-Connecting-Ip` **only** when the TCP peer (`incoming.socket.remoteAddress`) matches a `BlockList`: production defaults to **loopback**; non-production adds RFC1918 + ULA; `FLOOM_TRUSTED_PROXY_CIDRS` augments the list. If an operator widens trusted CIDRs too far, a client could spoof forwarded headers and **spray keys across many synthetic IPs** (weaker per-IP caps) or target another bucket depending on hop math. |
| **Hop count** | `FLOOM_TRUSTED_PROXY_HOP_COUNT` (default `1`) picks `entries[length - hops]` from the right of `X-Forwarded-For`. Wrong hop count shifts which client IP is attributed; off-by-one behind multi-hop chains can collapse many users onto one IP or pick an untrusted leftmost hop. |
| **Multi-replica / restart** | Store is a **process-local `Map`**. Limits reset on deploy/restart; multiple replicas do **not** share counters (each instance has its own budget). |
| **Routes not wrapped** | Middleware is mounted only on `POST /api/run`, `POST /api/:slug/run`, `POST /api/:slug/jobs`, and `POST /mcp/app/:slug`. Other expensive or abuse-prone paths (e.g. hub ingest, auth) are **not** covered by this module unless handled elsewhere. |
| **MCP admin ingest** | `ingest_app` uses `checkMcpIngestLimit` inside the MCP tool path (separate from HTTP 429 envelope). Still subject to `FLOOM_RATE_LIMIT_DISABLED`. |

---

## `lib/rate-limit.ts` — keying model

- **Primary bucket:** `user:{user_id}` when `SessionContext.is_authenticated`, else `ip:{extractIp(c)}`. Caps: `FLOOM_RATE_LIMIT_USER_PER_HOUR` (default 300) vs `FLOOM_RATE_LIMIT_IP_PER_HOUR` (default 60). Window: **1 hour** sliding (weighted two half-windows).
- **Secondary bucket (when `slug` route param exists):** `app:{ip}:{slug}` with `FLOOM_RATE_LIMIT_APP_PER_HOUR` (default 500). Applies in **both** auth states so a hot slug cannot monopolize the node relative to other apps for the same egress IP.
- **Headers on success:** `X-RateLimit-Limit`, `Remaining`, `Reset`, `Scope` — either primary or per-app scope depending on which bucket has the **smaller** remaining budget.
- **429 response:** JSON `{ error: 'rate_limit_exceeded', retry_after_seconds, scope }` plus `Retry-After`, same `X-RateLimit-*` set; `recordRateLimitHit(scope)` increments metrics.
- **IP fallback:** If peer IP cannot be normalized, key becomes `ip:unknown` — **all such clients share one bucket** (potential thundering herd / easy collateral block).

---

## `middleware/security.ts` — CSP and HSTS

**Execution model:** Middleware runs `await next()` first, then mutates `c.res.headers`. It **does not overwrite** an existing `Content-Security-Policy` header (routes may set their own first).

**Always applied after handler completes:** `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.

**CSP (`TOP_LEVEL_CSP`):** Applied when the pathname does **not** start with `/renderer/` **and** no CSP was already set. Directives include `default-src 'self'`, `script-src 'self'`, `style-src` with `'unsafe-inline'` + Google Fonts stylesheet host, `img-src` including `https:`, `connect-src 'self' https://api.github.com`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`, etc. Inline comments document known trade-offs (e.g. React inline styles, future browser Sentry).

**Practical notes**

- **JSON/API responses** still receive the CSP string on responses that lack a prior CSP header. Browsers do not execute JSON as HTML, so this is mostly **belt-and-suspenders** and spec hygiene, not a primary API abuse control.
- **HSTS on plain HTTP** (local dev): In-file comment states browsers ignore HSTS on non-HTTPS; low risk for localhost, but operators should not assume HSTS “forces TLS” until TLS terminates in front of the app.
- **Renderer exception:** `/renderer/...` is exempt so `routes/renderer.ts` can ship **stricter** frame CSP without this middleware clobbering it.

---

## `lib/scoped.ts` — tenant isolation (not HTTP edge)

This module is **SQL scoping helpers** for `workspace_id`, aligned with the product’s multi-tenant direction (`docs/PRODUCT.md` load-bearing DB paths; RLS described as deferred elsewhere).

- **`scopedAll` / `scopedGet`:** Prepend `table.workspace_id = ?` and bind `ctx.workspace_id` first. Throws `MissingContextError` if `workspace_id` is missing — fails closed for reads **when these helpers are used**.
- **`scopedRun`:** Only asserts context exists and runs caller-supplied SQL with caller-supplied params. It does **not** inject `workspace_id` into arbitrary statements. A caller who passes an `INSERT`/`UPDATE` without a workspace predicate could **write cross-tenant data** — convention and review burden, not mechanical enforcement.
- **`workspacePredicate`:** String fragment for hand-built queries; same discipline applies.

**Adoption:** The helper is part of the W2.1 story; usage is concentrated in tests/dist imports rather than being the exclusive DB access layer — **security of tenant boundaries still depends on every query path** (services/routes) applying the same predicate discipline, not only on this file.

---

## Interaction with CORS (`index.ts`)

**Mount order (simplified for a `POST /api/:slug/run` request):** `logger` → path-specific **`cors()`** (`openCors` for run/MCP/hub/renderer/og/health) → **`securityHeaders`** → `globalAuthMiddleware` (on `/api/*`) → **`runRateLimitMiddleware`** → route.

**Implications**

- **CORS and rate limit are independent policies.** `openCors` uses `origin: '*'` without credentials on public run/MCP surfaces; `restrictedCors` uses an allow-list with `credentials: true` on auth/session/workspaces/memory/secrets/stripe/feedback. Rate limiting keys off **IP + auth context**, not off `Origin`.
- **`securityHeaders` wraps downstream work:** Because it runs `await next()` before setting headers, responses short-circuited inside inner middleware (e.g. **429 from rate limit**) still pass through the post-`next()` block — **HSTS, nosniff, Referrer-Policy, and CSP (if absent)** attach to error bodies as well as successes.
- **Comment vs. code on `/api/hub`:** Comments describe open CORS for **GET** hub discovery; the stack applies **`openCors` to all methods under `/api/hub`**, including creator mutations, with `*` and no credentials. That is consistent with **blocking browser cookies** on cross-origin hub calls, but it is **broader** than the comment implies; cross-origin **credentialess** fetches with `Authorization: Bearer ...` remain possible from any origin if the user’s token is exposed to third-party JS.
- **Preflight / OPTIONS:** Any rate-limit consumption on `OPTIONS` for mounted paths depends on Hono’s `cors()` and whether the rate-limit middleware runs before `cors` short-circuits; worth validating under load if OPTIONS traffic is high (not analyzed in depth in this pass).

---

## Summary

| Area | Grade / takeaway |
|------|-------------------|
| **Rate limit bypass** | Clear env escape; proxy trust and hop math are the main **operational** bypass/abuse knobs; multi-replica is an **architectural** bypass of global fairness. |
| **Rate limit keying** | Sensible split (user vs IP, per-app, MCP ingest day cap); `unknown` IP clustering is an edge-case footgun. |
| **CSP / HSTS** | Shippable defaults for HTML; renderer override preserved; API gets headers mostly as defense-in-depth; HSTS requires real HTTPS at the edge to matter. |
| **CORS** | Split restricted vs open matches cookie-bearing vs server-to-server intent; **hub** is entirely under `openCors` in code — align docs or narrow methods if product intent is tighter. |
| **`scoped.ts`** | Good for read helpers; **`scopedRun` is not a security boundary** — tenant safety remains application-wide. |
