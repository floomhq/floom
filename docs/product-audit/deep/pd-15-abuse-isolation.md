# pd-15 — Abuse, isolation, safety (deep product audit)

**Scope:** Public-run abuse surfaces, tenant / workspace isolation story, cross-surface consistency.  
**Sources:** [`docs/PRODUCT.md`](../../PRODUCT.md), [`docs/ROADMAP.md`](../../ROADMAP.md), [`apps/server/src/lib/rate-limit.ts`](../../../apps/server/src/lib/rate-limit.ts), [`apps/server/src/index.ts`](../../../apps/server/src/index.ts) (rate mount + CORS notes), [`apps/server/src/routes/hub.ts`](../../../apps/server/src/routes/hub.ts) (visibility + ownership), [`apps/server/src/lib/auth.ts`](../../../apps/server/src/lib/auth.ts), [`apps/server/src/routes/run.ts`](../../../apps/server/src/routes/run.ts) (run access), [`apps/server/src/routes/mcp.ts`](../../../apps/server/src/routes/mcp.ts) (admin tools).  
**No code changes** — assessment only.

---

## 1. Product intent (from PRODUCT + ROADMAP)

- **ICP promise** ([`PRODUCT.md`](../../PRODUCT.md)): paste repo → production with **auth layer, rate limits**, three surfaces (web `/p/:slug`, MCP `/mcp/app/:slug`, HTTP `POST /api/:slug/run`). Hosting is the product; abuse controls are part of the headline value.
- **Roadmap P0** ([`ROADMAP.md`](../../ROADMAP.md) L37): *“Rate-limit all `/api/*/run` endpoints”* — framed as a **launch blocker**, i.e. the product story expects run abuse to be bounded before broad exposure.

---

## 2. Truth table — “What we tell users” vs “What the server does”

Legend: **Claim** = reasonable user/operator expectation. **HTTP run** = `POST /api/:slug/run` (and legacy `POST /api/run`). **MCP app** = `/mcp/app/:slug` tool calls.

| # | Claim | HTTP hub list `GET /api/hub` | HTTP hub detail `GET /api/hub/:slug` | HTTP run / jobs | MCP `list_apps` / `search_apps` | MCP `get_app` |
|---|--------|------------------------------|--------------------------------------|-----------------|----------------------------------|----------------|
| T1 | Private apps never appear in the public directory | **True** — SQL filters `visibility = 'public' OR NULL` ([`hub.ts`](../../../apps/server/src/routes/hub.ts) ~L532–538) | **True** — private → **404** for non-owner ([`hub.ts`](../../../apps/server/src/routes/hub.ts) ~L620–626) | **True** — `checkAppVisibility` ([`run.ts`](../../../apps/server/src/routes/run.ts) + [`auth.ts`](../../../apps/server/src/lib/auth.ts)) | **True** — SQL matches public-only ([`mcp.ts`](../../../apps/server/src/routes/mcp.ts) ~L553–557); `pickApps` same ([`embeddings.ts`](../../../apps/server/src/services/embeddings.ts) ~L115–117) | **False** — loads row by slug and returns **full manifest with no visibility / owner check** ([`mcp.ts`](../../../apps/server/src/routes/mcp.ts) ~L637–688) |
| T2 | Strangers cannot learn a private slug “exists” | **True** for hub detail (404) | **True** | **True** (404 `not_found`) | N/A (slug not in list) | **False** — `not_found` only when slug missing from DB; **private rows return manifest** |
| T3 | Run surfaces are rate-limited | N/A | N/A | **Partial** — see §3 | Same middleware stack as HTTP when calling through `/mcp/app/:slug` ([`index.ts`](../../../apps/server/src/index.ts) L160–164) | **Admin** `/mcp` root is **not** covered by `runRateLimitMiddleware`; `ingest_app` has separate daily cap ([`rate-limit.ts`](../../../apps/server/src/lib/rate-limit.ts) `checkMcpIngestLimit`) |
| T4 | “Auth-required” means end-user identity | **Misaligned** — product language suggests app-level gate; implementation is **shared `FLOOM_AUTH_TOKEN` bearer** ([`auth.ts`](../../../apps/server/src/lib/auth.ts) L107–121), not Better Auth user | Same | Same on run/MCP app | N/A | `get_app` still exposes manifest if row exists (visibility not enforced) |
| T5 | Creator A cannot read Creator B’s run payloads | **True** in cloud — `GET /api/hub/:slug/runs` requires auth + owner; run rows scoped by `user_id` / `device_id` ([`hub.ts`](../../../apps/server/src/routes/hub.ts) L233–327; [`run.ts`](../../../apps/server/src/routes/run.ts) `checkRunAccess`) | N/A | **True** — workspace + user/device rules documented in code | N/A | N/A |
| T6 | Per-app cost abuse (one public slug burning CPU) is capped **per tenant globally** | N/A | N/A | **False** — limiter is **per IP × slug**, not global per slug ([`rate-limit.ts`](../../../apps/server/src/lib/rate-limit.ts) L358–363); botnets / many IPs scale cost | Same as HTTP for MCP tool calls on `/mcp/app/:slug` | N/A |

**Headline gap for pd-15:** **T1/T2 + MCP `get_app`** breaks the “private app” product story for any client that uses the MCP admin surface: manifest (actions, schemas, declared secrets metadata) is **not** isolated the same way as the HTTP hub detail endpoint.

---

## 3. Public run abuse — controls in place

**Where limits attach** ([`index.ts`](../../../apps/server/src/index.ts) L150–164):

- `POST /api/run` (legacy)
- `POST /api/:slug/run`
- `POST /api/:slug/jobs`
- `POST` (and all methods on prefix) `/mcp/app/:slug` — middleware runs on entire subtree

**Limiter design** ([`rate-limit.ts`](../../../apps/server/src/lib/rate-limit.ts)):

| Bucket | Scope | Default (env override) | Window |
|--------|--------|-------------------------|--------|
| Primary | `ip:*` anon | 60/hr (`FLOOM_RATE_LIMIT_IP_PER_HOUR`) | 1h sliding |
| Primary | `user:*` authed | 300/hr (`FLOOM_RATE_LIMIT_USER_PER_HOUR`) | 1h sliding |
| Secondary | `app:<ip>:<slug>` | 500/hr (`FLOOM_RATE_LIMIT_APP_PER_HOUR`) | 1h sliding |
| MCP ingest | `mcp_ingest:ip/user` | 10/day (`FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY`) | 24h sliding |

**Operational caveats (product-relevant):**

- **Process-local store** — resets on restart; not shared across replicas (file comment: Redis TODO). Multi-instance deploys weaken the story vs single-node.
- **`FLOOM_RATE_LIMIT_DISABLED=true`** — full bypass; OK for dev, dangerous if copied to prod configs.
- **Trusted proxy / XFF** — client IP derived from forwarded headers only when peer matches trusted CIDRs; misconfiguration can collapse many users into one IP (false positives) or trust spoofed headers (false negatives).
- **Legacy `POST /api/run`** — `:slug` route param is absent; **per-(IP, app) bucket may not apply** (middleware only adds `app:` key when `c.req.param('slug')` is set). Heavy use of body `app_slug` could concentrate abuse against one app while only consuming the **anon/user** buckets.
- **GET `/api/run/:id` and SSE** — mounted under `/api/run`, so they **consume the same rate-limit path** as POST; polling-heavy UIs share budget with execution (product tradeoff: anti-abuse vs UX).

**Roadmap alignment:** P0 says rate-limit **all** `/api/*/run` endpoints. Implementation covers the **primary execute** paths above; it does **not** reframe “run” to include every auxiliary read (e.g. some `/api/me/*` run history) — acceptable if PM defines “run” as **execute + enqueue + MCP invoke** only; otherwise wording should narrow.

---

## 4. Tenant cross-leak — risk register

| ID | Risk | Area | Likelihood | Impact | Mitigations today | Residual |
|----|------|------|------------|--------|---------------------|----------|
| R1 | **Private app manifest leak via MCP `get_app`** | MCP admin `/mcp` | High (any caller who can reach MCP) | High — schema, actions, secret *declarations*, integration surface | HTTP hub hides private; run/MCP **app** routes use `checkAppVisibility` | **Unmitigated** for `get_app` tool path |
| R2 | **Distributed cost attack on a single public slug** | HTTP + MCP run | Medium | Medium–High — CPU/upstream spend | Per-IP×slug cap | No **global** per-slug or per-workspace spend ceiling |
| R3 | **`auth-required` conflated with operator bearer token** | Auth model | Medium (confusion) | Medium — all token holders equivalent; not per-creator API keys | Docs + env (`FLOOM_AUTH_TOKEN`) | No per-app or per-user token story in v0.x |
| R4 | **Hub cache staleness vs visibility** | Directory | Low | Low–Medium | PATCH/ingest/delete invalidate cache ([`hub.ts`](../../../apps/server/src/routes/hub.ts)) | 5s window could briefly show stale cards (operational, not cross-tenant) |
| R5 | **`include_fixtures=true` on `GET /api/hub`** | Hub list | Low (abuse) | Low | Unauthenticated query param ([`hub.ts`](../../../apps/server/src/routes/hub.ts) L504–507) | Noisy listings; not a secret leak |
| R6 | **OSS vs cloud semantics** | Self-host | N/A for cloud ICP | High if mis-deployed | Cloud fixes for anon `local` context on owner routes ([`hub.ts`](../../../apps/server/src/routes/hub.ts) issue #124 comments) | Operators must not assume OSS “open box” matches cloud multi-tenant |

---

## 5. PM questions

1. **MCP parity:** Should MCP `get_app` enforce the **same** visibility contract as `GET /api/hub/:slug` (404 for non-owner on private; bearer rules for `auth-required`)? If yes, what is the **session** story for MCP clients (cookie vs bearer vs future OAuth)?
2. **`get_app` vs “fixtures still accessible”** ([`mcp.ts`](../../../apps/server/src/routes/mcp.ts) comment ~L563–566): Is intentional slug-based access for hidden **directory** slugs (`FLOOM_STORE_HIDE_SLUGS`) meant to extend to **private** apps, or only to non-sensitive fixtures?
3. **Rate limit definition of “done”:** Does P0 “rate-limit all `/api/*/run` endpoints” include **legacy** `POST /api/run` with **per-app** fairness, or is slug-first the only supported abuse model?
4. **Global spend:** Do we need a **per-app** (or per-workspace) budget in addition to per-IP×slug, so one viral public app cannot be drained by many IPs (supplier-side protection)?
5. **`auth-required` positioning:** Is this “operator lock” (one shared secret) until v1.1+, or should cloud users expect **sign-in** semantics? The answer drives docs, pricing, and support load.
6. **Redis / multi-replica:** Is multi-instance Floom in scope pre-1.0? If yes, in-memory limits need a product-visible note (“limits are per instance”).
7. **Public run share:** `POST /api/run/:id/share` exposes **outputs-only** view ([`run.ts`](../../../apps/server/src/routes/run.ts) comments). What abuse / DMCA / content policy does the public link inherit?

---

## 6. Summary for pd-15

- **Abuse:** Run **execute** paths are rate-limited with sensible defaults and env escape hatches; gaps include **legacy path per-app bucket**, **no global per-slug cap**, **in-memory / single-replica** semantics, and **roadmap wording** vs actual mount list.
- **Isolation:** **Run data** and **hub HTTP** paths show deliberate workspace/user scoping and recent hardening notes; **MCP admin `get_app`** is the standout **cross-surface leak** relative to the private-app product story.
- **Next step (product, not code):** Decide whether MCP discovery tools are **public read** (then private manifests must be gated) or **trusted operator only** (then MCP root must be clearly positioned and authenticated consistently with that promise).
