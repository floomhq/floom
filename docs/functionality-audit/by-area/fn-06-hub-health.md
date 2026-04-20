# fn-06 — Hub directory, detail, and health (`hub`, `hub-filter`, `hub-cache`, `health`)

**Scope (workspace root `apps/server/src/`):** `routes/hub.ts`, `lib/hub-filter.ts`, `lib/hub-cache.ts`, `routes/health.ts`.

**Product lens (`docs/PRODUCT.md`):** The ICP discovers runnable apps through the web directory and permalinks (`/p/:slug`); MCP and HTTP surfaces are separate entry points but share the same notion of “what apps exist.” Hub routes implement the HTTP side of discovery and creator maintenance (ingest, patch, delete, renderer). They are not listed in the load-bearing path table, but they are operationally load-bearing for trust (fixture leakage, stale store, private slug existence).

---

## Summary

| Area | Verdict |
|------|---------|
| Mutations vs `GET /api/hub` cache | Strong for routes defined in `hub.ts` plus `runner.ts` `avg_run_ms` refresh and `cleanup.ts`: all call `invalidateHubCache()`. `POST/DELETE …/renderer` intentionally omit invalidation because the cached list body does not include renderer metadata. |
| Visibility (list vs detail vs mine) | List: only `public` or `NULL`. Detail: `private` is owner-only with **404** for others (no existence leak). `auth-required` is **excluded from the public list** but **fully readable** on `GET /api/hub/:slug` for strangers—consistent if “auth-required” means *run* gating only; confusing if product intent was directory hiding. |
| `hub-filter.ts` / fixtures | Aligned with web mirror; applied only to the **directory** `GET /api/hub`, not detail or `/mine`, preserving permalinks and owner visibility. |
| `hub-cache.ts` correctness | Single global `Map`, **full clear** on invalidation—correct but coarse; **TTL 5s** bounds staleness for any writer that forgets to invalidate. **Multi-instance:** cache and invalidation are **per process** only. |
| Health contract | Minimal **liveness + SQLite readability** contract at `GET /api/health` (`/` on `healthRouter`); always reachable without hub auth token; **not** a deep readiness probe (no dependency checks beyond implicit `COUNT` queries). |

---

## Hub mutations vs `GET`

**Cached read**

- `GET /api/hub` (`hubRouter.get('/')`) uses `hubCacheKey(category, sort, includeFixtures)` and returns `getHubCache` hits as JSON without re-querying.

**Invalidated by**

- `POST /api/hub/ingest` — `invalidateHubCache()` after successful ingest.
- `DELETE /api/hub/:slug` — after row delete.
- `PATCH /api/hub/:slug` — after visibility and/or manifest (`primary_action`) update.
- `services/runner.ts` — after successful `avg_run_ms` recompute (documented in `hub-cache.ts` to avoid stale sort order).
- `services/cleanup.ts` — after workspace cleanup transaction (public directory must drop removed apps).

**Not cached (always fresh DB)**

- `GET /api/hub/mine`, `GET /api/hub/:slug`, `GET /api/hub/:slug/runs` — no hub cache involvement.

**Mutations without hub cache bust (by design for list payload)**

- `POST /api/hub/:slug/renderer` and `DELETE /api/hub/:slug/renderer` — update disk bundle and in-memory bundle registry; **directory list** does not expose `renderer`, so cached list rows stay valid. **`GET /api/hub/:slug`** reads `getBundleResult(slug)` per request, so renderer changes show on detail immediately.

**PATCH response shape**

- Returns `visibility: parsed.data.visibility ?? app.visibility` so a `primary_action`-only patch still echoes current visibility—appropriate.

---

## Visibility and authorization

**Public directory (`GET /api/hub`)**

- SQL restricts to `status = 'active'` and `(visibility = 'public' OR visibility IS NULL)`.
- **`private` and `auth-required` do not appear** in the grid feed.
- `FLOOM_STORE_HIDE_SLUGS` removes matching slugs **only** from this list; comments and code explicitly keep **`GET /api/hub/:slug`** unfiltered by that env list so permalinks keep working.

**Detail (`GET /api/hub/:slug`)**

- **`private`:** non-owners receive **404** `"App not found"` even when the row exists—good anti-enumeration.
- **`auth-required`:** no extra gate on this handler; manifest and `upstream_host` (host only) are returned to any caller. Execution-time enforcement lives in run routes (`routes/run.ts` visibility checks)—document this split clearly for client authors.
- Response comment mentions “public \| unlisted \| private” while the schema supports **`auth-required`**—comment drift only, not runtime behavior.

**Creator rail**

- `GET /api/hub/mine` returns apps for `(workspace_id AND author)` or `author` match; includes **`visibility`** and **`is_async`** for UI pills—does not apply `filterTestFixtures` (owners must see fixtures they created).

**Mutating routes (`ingest`, `PATCH`, `DELETE`, renderer)**

- Cloud mode uses `requireAuthenticatedInCloud`; OSS keeps documented **`local` workspace** escape hatches for single-user self-host, with **narrowing fixes** for `/:slug/runs` (strict author in cloud) so anonymous synthetic `local` context cannot read other users’ runs.

---

## `lib/hub-filter.ts`

- **`isTestFixture` / `filterTestFixtures`:** slug regex prefixes plus description preambles for well-known sample specs; false positives possible if a real app copies those exact opening lines (documented tradeoff).
- **Call contract:** intended for any **public gallery** surface; `hub.ts` applies it to `GET /api/hub` when `include_fixtures` is not `true`. Single-app and `/mine` endpoints **must not** use it—already respected in `hub.ts`.

---

## `lib/hub-cache.ts`

- **Keying:** `category|sort|includeFixtures` — matches the query parameters that change the list body; missing discriminators would be a bug—currently complete for this handler.
- **TTL:** `HUB_CACHE_TTL_MS = 5000`; lazy expiry on read.
- **Invalidation:** `hubCache.clear()` — simple and race-free for single-node; **all** variants cleared on any bust.
- **Operational caveats**
  - **Horizontal scale:** each replica holds its own `Map`; one instance’s ingest does not bust another’s cache until TTL or local write.
  - **Other `UPDATE apps` writers** outside this audit’s file list (e.g. jobs that flip `featured`) can leave the directory stale for up to TTL unless they also call `invalidateHubCache()`—worth grep when adding new writers.

---

## `routes/health.ts` — contract

- **Mount:** `app.route('/api/health', healthRouter)` — effective **`GET /api/health`** for the index route.
- **Auth:** `lib/auth.ts` exempts `/api/health` so probes work without `FLOOM_AUTH_TOKEN`.
- **JSON body (success path):**
  - `status`: literal `'ok'` when handler returns 200.
  - `service`: literal `'floom-chat'` (stable identifier for operators; name may predate marketing rename).
  - `version`: `SERVER_VERSION` from `package.json` (shared with OpenAPI per `server-version.ts` comment).
  - `apps`: `SELECT COUNT(*) FROM apps`.
  - `threads`: `SELECT COUNT(*) FROM run_threads`.
  - `timestamp`: ISO-8601 string from `new Date().toISOString()`.
- **Semantics:** proves process up and SQLite reachable enough for simple aggregates; **does not** validate Docker, git, MCP, or outbound network. Suitable for load balancers; not a substitute for synthetic checks of the three surfaces.

---

## Cross-cutting notes

- **PRODUCT alignment:** Hub supports discovery for hosted/proxied apps without requiring infra fluency; keeping fixtures off public lists and private slugs non-enumerable supports ICP trust. Cache invalidation on ingest/patch/delete supports the “paste URL → see it in the directory” story.
- **Documentation drift:** `GET /api/hub/:slug` JSON comment on visibility vs actual enum (`auth-required`).

---

## Suggested follow-ups (optional)

1. Decide whether `auth-required` apps should be discoverable on **`GET /api/hub/:slug`** without session, or gated similarly to `private` with a softer policy (e.g. redacted manifest).
2. If multiple server replicas are deployed, replace or supplement in-memory hub cache with a shared store or shorten TTL and accept higher DB load.
3. Audit any non-hub writers to `apps` for missing `invalidateHubCache()` when they affect fields present in the directory response (`featured`, `status`, `manifest` keys used in list cards).
