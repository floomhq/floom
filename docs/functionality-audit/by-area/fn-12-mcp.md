# fn-12 — `routes/mcp.ts` (MCP surfaces)

**Lens:** `docs/PRODUCT.md` — three surfaces (web form, MCP, HTTP), agent-native ingest, load-bearing MCP path.

**Scope:** `apps/server/src/routes/mcp.ts` and its direct dependencies (session, rate limits, auth visibility, hub listing filters, embeddings picker, OpenAPI ingest).

---

## 1. Route map

| URL | `McpServer` | Tools / behavior |
|-----|-------------|------------------|
| `ALL /mcp` (including `/` on mounted router) | `floom-admin` v0.4.0 | `ingest_app`, `list_apps`, `search_apps`, `get_app` |
| `ALL /mcp/search` | `floom-chat-search` v0.3.0 | `search_apps` only (duplicate of admin search, looser `inputSchema`) |
| `ALL /mcp/app/:slug` | `floom-chat-:slug` v0.3.0 | One tool per manifest action; default action renames tool to a slug-safe identifier |

Registration order: admin `/` before `/app/:slug` so the root is not captured as a slug (commented in source).

---

## 2. Tool surface vs HTTP parity

### 2.1 Ingest

| Concern | HTTP `POST /api/hub/ingest` | MCP `ingest_app` |
|--------|----------------------------|------------------|
| Spec source | `openapi_url` only (Zod `IngestBody`) | `openapi_url` **or** `openapi_spec` (inline object) — agents can publish without a public URL |
| Auth (cloud) | `requireAuthenticatedInCloud` → 401 `code: auth_required` | `isCloudMode() && !ctx.is_authenticated` → tool error JSON `error: auth_required` (message text differs slightly from HTTP) |
| Visibility | Optional `visibility: public \| private \| auth-required` | **Not exposed**; ingest uses pipeline defaults (parity gap for creator intent) |
| Slug collision | `SlugTakenError` → **409** with `suggestions` | Caught as generic `ingest_failed` with string `message` — **no structured suggestions or HTTP code** |
| Hub list freshness | `invalidateHubCache()` after success | **No** `invalidateHubCache()` in MCP path — new/updated app may be missing from `GET /api/hub` for up to the hub cache window (~5s) after MCP-only ingest |
| Self-host `FLOOM_AUTH_TOKEN` | Same global middleware as MCP | Same |

MCP is **stronger** for headless agents (inline spec) and **weaker** for product parity (visibility, 409 shape, directory cache).

### 2.2 Gallery list

`list_apps` (public `active` + `public`/NULL visibility, `filterTestFixtures`, optional category/keyword/limit) aligns with **`GET /api/hub`** listing rules and fixture stripping.

Differences: HTTP supports `sort`, `include_fixtures`, `HIDDEN_SLUGS`, 5s **response cache**, and returns richer card fields (e.g. `author_display`, `blocked_reason`). MCP returns a slimmer `serializeHubApp` payload (`permalink`, `mcp_url`, etc.).

### 2.3 Semantic / keyword search

All three — **`POST /api/pick`**, admin `search_apps`, `/mcp/search` `search_apps` — call `pickApps()` in `services/embeddings.ts`, which already restricts to `status = 'active'` and `visibility` public/NULL, and strips test fixtures. **Search parity for discovery is sound.**

Gaps: HTTP pick uses body field **`prompt`**, default limit **3**, max **10**; MCP tools use **`query`**, default **5**, max **50** (admin) vs optional unchecked number on `/mcp/search` (only `.describe` — **weaker Zod bounds** on the search-only server). **Naming and limits are not uniform** across surfaces.

### 2.4 Single-app detail

**Material gap:** `GET /api/hub/:slug` enforces **private** visibility: non-owners get **404** and no manifest leak (`hub.ts`).

MCP `get_app` loads by slug and returns the **full manifest** with **no** `checkAppVisibility` and **no** session/owner check. A caller who knows or guesses a private slug can retrieve the full manifest over MCP even when HTTP would hide the app. **`auth-required` apps** are also not checked at the `get_app` tool (contrast: `/mcp/app/:slug` connection **does** run `checkAppVisibility` before exposing tools).

`GET /api/hub/:slug` also returns renderer bundle metadata, `upstream_host`, async flags, etc.; MCP `get_app` returns `serializeHubApp` + `manifest` only.

### 2.5 Per-app run (MCP tool vs `POST /api/{slug}/run`)

Shared concepts: re-load app row, `validateInputs` / `ManifestError`, `secrets_needed` with DB + per-call `_auth` injection, `missing_secrets` structured hint, `is_async` → job enqueue + poll URLs, else `dispatchRun` + `waitForRun` (up to 10 min), `formatRun` JSON in tool text.

**Rate limit:** `runRateLimitMiddleware` applies to `POST /api/:slug/run` and **`/mcp/app/:slug`** (`index.ts`). **Admin** `/mcp` is **not** on that middleware; only `ingest_app` has an internal cap (below).

**CORS / cookies:** Open CORS on `/mcp` without credentials — server-to-server clients rely on **Bearer** (`FLOOM_AUTH_TOKEN` or per-app) rather than session cookies, consistent with `index.ts` comments.

---

## 3. Auth

| Layer | Behavior |
|-------|----------|
| **Global** | `globalAuthMiddleware`: if `FLOOM_AUTH_TOKEN` is set, all `/mcp` and `/mcp/*` require matching Bearer (or `?access_token=` for GET-style callers; MCP POST typically uses `Authorization`). Health/metrics exempt at middleware level. |
| **Cloud ingest** | `ingest_app` requires authenticated session in cloud mode (mirrors **intent** of `requireAuthenticatedInCloud` on `POST /api/hub/ingest`). |
| **Per-app MCP** | `resolveUserContext` + `checkAppVisibility` for the resolved `AppRecord` — **private** and **auth-required** enforced at **connection** to `/mcp/app/:slug`, not inside each tool. |
| **`get_app` (admin)** | **No** visibility or global token gate beyond whatever `FLOOM_AUTH_TOKEN` already imposed — see §2.4. |

Session resolution is shared with HTTP via `resolveUserContext` (`services/session.js`).

---

## 4. Rate limits on ingest (and related)

| Mechanism | Scope | Config |
|-----------|--------|--------|
| **`checkMcpIngestLimit`** | Only **`ingest_app`**, evaluated **before** auth (comment: avoid timing leaks) | **Per calendar day** sliding window (24h), key `mcp_ingest:user:<id>` or `mcp_ingest:ip:<ip>`, default **10/day**; `FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY`; skipped if `FLOOM_RATE_LIMIT_DISABLED=true` |
| **HTTP `POST /api/hub/ingest`** | No dedicated ingest daily cap in `rate-limit.ts` | Throttled only by same global process limits as other routes *not* mounted with `runRateLimitMiddleware` — i.e. **MCP ingest is *stricter* than HTTP ingest** for volume |

Over-limit `ingest_app` returns a **tool result** (not HTTP 429) with `error: rate_limit_exceeded`, `scope: mcp_ingest`, `retry_after_seconds` (aligned with the design comment in `rate-limit.ts`: JSON-RPC envelope).

---

## 5. Input validation

| Area | Approach |
|------|----------|
| **Admin tools** | Zod schemas passed into `registerTool` (`ingest_app`, `list_apps`, `search_apps`, `get_app`). URL/slug/length bounds on ingest; `ingest_app` also manually requires `openapi_url` **xor** `openapi_spec`. |
| **Per-app tools** | `buildZodSchema` from manifest `InputSpec` + optional `_auth` object for `secrets_needed`; then **`validateInputs`** from `services/manifest.js` on the payload after stripping `_auth` (authoritative, catches manifest-specific rules). |
| **`/mcp/search` server** | `query` / `limit` use minimal Zod (`query` not `.min(1)`); relies on `pickApps` to handle empty/unusual queries. |

Risk: **double validation** (Zod MCP layer + `validateInputs`) is mostly consistent; mismatches would surface as MCP validation vs manifest errors depending on which layer fires first.

---

## 6. Error shapes (agents / MCP clients)

MCP does not standardize on a single top-level JSON schema across tools; most errors are **tool `content` text** carrying **stringified JSON** for machine parsing:

| Pattern | Example payload / notes |
|--------|-------------------------|
| **Structured (JSON in text)** | `rate_limit_exceeded`, `auth_required`, `invalid_input`, `ingest_failed` (`message`), `not_found` (`get_app`), `missing_secrets` (`error`, `required`, `help`) |
| **Plain text** | `Invalid inputs: <ManifestError message>`; app missing / wrong status in per-app tool |
| **Per-run result** | Sync path: `formatRun` JSON; `isError` true when status ≠ success; async: success JSON with `job_id`, `poll_url` |
| **Unknown slug on MCP connect** | **HTTP 200** JSON-RPC body: `error: { code: -32001, message: 'App not found: …' }`, `id: null` — avoids bare 404 for protocol-level clients |

**Parity note:** HTTP ingest errors use `{ error, code, details? }` with Zod `flatten()` for 400; MCP agents must parse **text** `content[0].text` instead. **Slug collision** recovery is easier on HTTP (409 + suggestions) than on MCP (generic `ingest_failed`).

---

## 7. Observability

`recordMcpToolCall` increments per **per-app** tool name only. Admin tools are not metered the same way in this file. Rate-limit metrics include `mcp_ingest` scope (`lib/metrics-counters.js` / `routes/metrics.ts` pattern).

---

## 8. Conclusion (priority gaps)

1. **`get_app` should enforce the same visibility contract as `GET /api/hub/:slug` (at minimum private + auth-required + optional global token), or explicitly document an intentional exception.**
2. **Hub cache invalidation** after successful MCP `ingest_app` should match HTTP behavior so the public directory and agents stay consistent.
3. **Slug collision and validation errors:** consider aligning MCP `ingest_app` with HTTP’s `SlugTakenError` 409 **shape** in the tool text for agent recovery.
4. **Normalize** search field names/limits between `/api/pick` and MCP, and tighten Zod on `/mcp/search` to match admin `search_apps` (min/max `query`, `limit`).

---

*References: `apps/server/src/routes/mcp.ts`, `apps/server/src/routes/hub.ts`, `apps/server/src/routes/pick.ts`, `apps/server/src/lib/rate-limit.ts`, `apps/server/src/lib/auth.ts`, `apps/server/src/index.ts`, `apps/server/src/services/embeddings.ts`.*
