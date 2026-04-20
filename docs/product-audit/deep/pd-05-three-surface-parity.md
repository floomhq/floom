# pd-05: Three-surface parity

**Track:** `docs/PRODUCT.md` — *"All three paths produce the same three surfaces: web form (`/p/:slug`), MCP server (`/mcp/app/:slug`), HTTP endpoint (`/api/:slug/run`)."*

**Scope:** Compare the **per-app** run paths: **Web** `AppPermalinkPage` + `RunSurface`, **MCP** `apps/server/src/routes/mcp.ts` (per-app server + tool handler), **HTTP** `apps/server/src/routes/run.ts` (`POST /api/run`, `POST /api/:slug/run`) and **related** `POST /api/:slug/jobs` (async). **Error taxonomy** from `apps/server/src/services/proxied-runner.ts` (where applicable). **No code changes** in this pass.

---

## 1. Executive truth table (PRODUCT promise vs code)

| # | Promise (from `docs/PRODUCT.md` or protocol) | Observed | Verdict |
|---|---------------------------------------------|----------|---------|
| 1 | Three surfaces (web, MCP, HTTP) for the same app | All three exist; per-app MCP and HTTP run routes are implemented. | **Met** |
| 2 | Same production layer (auth, secrets, rate limits) on every surface | **Global** `FLOOM_AUTH_TOKEN` and **per-app** `checkAppVisibility` run on Web API, MCP per-app mount, and HTTP run/jobs routes. **User-vault** `SessionContext` is passed into `dispatchRun` from **HTTP** run routes, **not** from MCP tool handler. | **Partial** |
| 3 | HTTP “`POST /api/:slug/run`” as the slug-based contract | Implemented as `slugRunRouter` in `run.ts` (`POST /api/:slug/run`). **First-party web** and **on-page curl** use `POST /api/run` with `app_slug` in the body instead. | **Partial** |
| 4 | One spec / manifest → no drift across surfaces | Actions and inputs come from the same `NormalizedManifest` for validation on all paths. **MCP** tool naming rewrites default `run` to a slug-sanitized name. | **Met** (with naming nuance) |
| 5 | Long-running / async via the same job story | **MCP** and **web** use the job queue for `is_async` apps. **`POST /api/run` and `POST /api/:slug/run` do not** check `is_async` and always call `dispatchRun` synchronously. | **Contradicted** (for async + raw HTTP) |
| 6 | Public copy / “Install” helps users find all three | **Install** tab is **MCP-first** (Claude) with “more clients coming.” **HTTP** is a `curl` example in modals / `ComingSoonModal` (terminal), not a first-class “copy HTTP URL” card on Install. | **Partial** |

---

## 2. Parity matrix (rows = surface, columns = capability)

| Capability | Web `/p/:slug` | MCP `/mcp/app/:slug` | HTTP `POST /api/:slug/run` + `POST /api/run` | Notes |
|------------|----------------|----------------------|-----------------------------------------------|--------|
| **App load / discover** | `getApp(slug)` (after load, user sees app) | Connect to streamable HTTP transport; `initialize` + tools | N/A (stateless per request) | — |
| **Per-app access control** | Indirect: app data from hub API assumes visibility server-side | `resolveUserContext` + `checkAppVisibility` before server creation (`mcp.ts`) | Same (`run.ts`, `jobs.ts`) | Aligns when routes run. |
| **Start sync run** | `RunSurface` → `POST /api/run` | Tool call → `dispatchRun` after validation | `POST /api/run` or `POST /api/:slug/run` | Different URL shapes, same runner. |
| **`thread_id`** | Supported on `POST /api/run` via `startRun(..., threadId)` | Not in MCP tool schema | **`POST /api/:slug/run`**: `thread_id` forced `NULL` in SQL | **Gap**: slug route drops threads. |
| **User vault secrets (`user_secrets`)** | Session cookies → `resolveUserContext` → `dispatchRun(..., ctx)` | **`dispatchRun` called without `ctx`** → falls back to `defaultContext()` in `runner.ts` | **`dispatchRun(..., ctx)`** on both HTTP run handlers | **Critical parity gap** for authenticated MCP in Cloud. |
| **Creator / admin secrets & `_auth`** | Form + vault UI; runner merges per policy | **`_auth`** optional object on tool inputs; merged in runner; **missing** → JSON `missing_secrets` before dispatch | **`POST /api/:slug/jobs`** accepts **`_auth`** in JSON body (`jobs.ts`) | HTTP slug **run** route has **no** `_auth` — only jobs path mirrors MCP. |
| **Per-call secrets without persisted vault** | User may rely on Studio secrets or per-run story | Full support via `_auth` | **Jobs**: yes. **Run**: no `_auth` on `slugRunRouter` / `POST /api/run` | Programmatic callers need different endpoints for “pass secrets this call only.” |
| **Async (`is_async`)** | **`startJob`** → `POST /api/:slug/jobs` | Branch: **`createJob`** + poll URLs; no blocking wait | **`POST /api/run` / `POST /api/:slug/run`**: **no** `is_async` branch — **sync `dispatchRun`** | Web/MCP vs raw HTTP diverge strongly. |
| **Logs / streaming** | SSE `/api/run/:id/stream` + polling fallback | Sync tools **block up to 10 min** (`waitForRun`); async returns job payload | Same run record + SSE as web when using sync HTTP | MCP sync blocks the HTTP request; different UX vs SSE. |
| **Run row tenancy** | Inserts include `workspace_id`, `user_id`, `device_id` | MCP sync insert: **`INSERT` without workspace/user/device** (`mcp.ts`) | HTTP inserts full tenancy columns | **Gap**: MCP runs may not join `/api/me/runs` / ownership model correctly. |
| **Error shape (proxied)** | JSON from `GET /api/run/:id` → UI taxonomy (`error_type`, `upstream_status`) | Tool returns **text** JSON string of `formatRun(row)` including `error_type` | JSON body on HTTP errors; run snapshot same columns | Same DB fields; **transport** differs (MCP text vs REST JSON). |
| **Input validation errors** | `400` + `{ error, field? }` from API | Tool error: plain text `Invalid inputs: …` | Same as HTTP `400` | MCP less machine-parseable. |

---

## 3. Trace summary (high level)

### Web — `apps/web/src/pages/AppPermalinkPage.tsx`

- Loads app via **`getApp(slug)`**; classifies load failures (`classifyPermalinkLoadError`).
- **Tabs:** Run (default), About, Install, Source. **Install** exposes **MCP URL** (`origin + /mcp/app/${slug}`) for Claude; other clients “coming soon.”
- **HTTP examples** use **`POST ${origin}/api/run`** with JSON **`app_slug`**, not **`POST /api/:slug/run`** (`curlExample` near top of successful render).
- **Run tab** mounts **`RunSurface`**: sync path uses **`startRun`** → **`POST /api/run`**; async path uses **`startJob`** → **`POST /api/${slug}/jobs`**.

### MCP — `apps/server/src/routes/mcp.ts`

- **`/mcp/app/:slug`**: loads app; **`resolveUserContext` + `checkAppVisibility`**; builds **`createPerAppMcpServer(app)`**.
- **Tools:** one tool per manifest action; **Zod** `inputSchema` includes optional **`_auth`** when `secrets_needed` is non-empty.
- **Dispatch:** strips **`_auth`**, **`validateInputs`**, checks **missing secrets** (DB + `_auth`), then either **`createJob`** + JSON response (async) or **`INSERT` run + `dispatchRun(..., perCallSecrets)`** without **`ctx`** + **`waitForRun`** up to 10 minutes (sync).
- **Admin `/mcp`:** `ingest_app`, `list_apps`, `search_apps`, `get_app` — Cloud auth for ingest mirrors hub rules (documented in file header).

### HTTP — `apps/server/src/routes/run.ts`

- **`POST /api/run`**: JSON body **`app_slug`**, optional **`action`**, **`inputs`**, **`thread_id`**; **`dispatchRun(..., undefined, ctx)`**.
- **`POST /api/:slug/run`**: slug in path; **`thread_id` omitted** (SQL `NULL`); same **`dispatchRun`** with **`ctx`**.
- **No `is_async` handling** on either — always synchronous **`dispatchRun`**.

### Jobs — `apps/server/src/routes/jobs.ts` (async parity)

- **`POST /api/:slug/jobs`**: only if **`row.is_async`**; validates inputs; supports **`_auth`** for per-call secrets; **`createJob`** (returns poll/cancel URLs). Aligns with **MCP async** branch and **web `RunSurface`**.

### Error taxonomy — `apps/server/src/services/proxied-runner.ts`

- **`ProxiedErrorType`**: `user_input_error`, `auth_error`, `upstream_outage`, `network_unreachable`, `timeout`, **`missing_secret`**, `floom_internal_error`, `runtime_error`, **`app_unavailable`**.
- Persisted on **`runs.error_type`** and surfaced on **`GET /api/run/:id`** (`upstream_status` when HTTP response exists). **Web `OutputPanel`** consumes this taxonomy for proxied failures.
- **MCP** returns **`formatRun(done)`** as JSON text — includes **`error_type`** when set, so **classification can align** if clients parse JSON.

---

## 4. Gaps (prioritized)

1. **`SessionContext` not passed from MCP → `dispatchRun`**  
   Authenticated users hitting MCP tools may not load **`user_secrets`** the same way as web/HTTP (`runner.ts` documents **`ctx`** defaulting to synthetic local when omitted).

2. **MCP run rows omit `workspace_id` / `user_id` / `device_id`**  
   Sync MCP inserts a minimal **`runs`** row vs HTTP’s full tenancy insert — impacts **run history**, **ownership**, and any feature keyed off those columns.

3. **Async apps + raw HTTP `POST /api/run` or `POST /api/:slug/run`**  
   No enqueue path; caller gets **sync** semantics (potentially long-lived connection / timeout), while **PRODUCT**-grade behavior for async is **`POST /api/:slug/jobs`** (web and MCP already follow this split).

4. **`_auth` parity**  
   **`jobs.ts`** accepts per-call **`_auth`**; **slug run** and **`POST /api/run`** do **not** — only MCP + async HTTP share that escape hatch.

5. **`thread_id` only on `POST /api/run`**  
   **`POST /api/:slug/run`** hard-codes **`NULL`** for **`thread_id`** — breaks parity for slug-only integrations.

6. **Discoverability / copy**  
   - **`apps/web/src/assets/protocol.md`** documents **`POST /api/:slug/run`** and **`/mcp/app/{slug}`**.  
   - **Permalink Install** emphasizes **MCP URL**; **HTTP** is secondary (**curl** in modal / developer-adjacent copy).  
   - **`POST /api/:slug/run`** not shown as the primary “copy me” endpoint on the consumer page.

7. **MCP transport vs REST for errors**  
   Validation and missing-secret paths return **`isError: true`** + **text** payloads; structured **`400`** JSON is easier for scripts than parsing MCP tool text.

8. **Unknown MCP app**  
   **`/mcp/app/:slug`** returns **HTTP 200** with JSON-RPC **`error`** envelope for unknown slug — different from REST **`404`** (intentional per comment; still a **client** parity concern).

---

## 5. Risk register

| ID | Severity | Risk | Evidence |
|----|----------|------|----------|
| R1 | **P0** | Cloud users run MCP tools expecting **user vault** secrets to apply (same as web); **`dispatchRun` without `ctx`** may resolve wrong tenant / miss vault. | `mcp.ts` → `dispatchRun(...)` (no seventh arg); `runner.ts` `dispatchRun` + `defaultContext()` |
| R2 | **P1** | **Automations** using **`POST /api/run`** against **`is_async`** apps hit **sync** execution — timeouts, proxy drops, operator confusion vs documented job flow. | `run.ts` `POST /api/run` / `slugRunRouter`; no `is_async` branch; compare `jobs.ts` + `RunSurface` |
| R3 | **P1** | **Run history / analytics** keyed off **`runs.user_id` / `workspace_id`** skew for **MCP-originated** rows. | `mcp.ts` minimal `INSERT INTO runs` |
| R4 | **P2** | **ICP** reads **`protocol.md`** / marketing (“three surfaces”) but **Install** tab does not-equally teach **HTTP** + **jobs** — leads to wrong integration path for long jobs. | `AppPermalinkPage.tsx` Install tab; `protocol.md`; `jobs.ts` |
| R5 | **P2** | **Slug-based HTTP** integrations cannot pass **`thread_id`** or body **`_auth`** on the simple run endpoint — pushes creators to document multiple endpoints for one app. | `run.ts` `slugRunRouter`; `jobs.ts` `_auth` |

---

## 6. Open PM questions

1. **Should MCP tool dispatch pass the same `SessionContext` as HTTP** (so **`user_secrets`** and tenancy match web), or is MCP intentionally **anonymous / operator-secret-only** except for **`_auth`**?

2. **Should `POST /api/run` and `POST /api/:slug/run` refuse or redirect `is_async` apps** to **`POST /api/:slug/jobs`** with a **400** and explicit message (breaking change vs silent long sync)?

3. **Canonical HTTP URL for docs and UI**: **`POST /api/run` + `app_slug`** vs **`POST /api/:slug/run`** — which is the **primary** self-serve contract for the ICP vs operators?

4. **Should per-call **`_auth`** exist on synchronous HTTP run routes** for parity with MCP and **`jobs`**, or is **`jobs` + MCP** the only supported “secrets in body” surface?

5. **Install tab**: Should it ship **three copy boxes** (Web permalink, MCP URL, HTTP curl) **before** ChatGPT/Notion connectors, to match **`PRODUCT`** three-surface parity in the UX?

6. **MCP blocking sync tools** (up to 10 minutes): acceptable for all MCP clients, or should sync MCP mirror **job + poll** for heavy apps to reduce gateway timeouts?

---

## 7. ICP journey (three surfaces) — success vs failure branches

**Goal:** Run one app’s action from **browser**, **MCP client**, and **curl**.

| Step | Web | MCP | HTTP |
|------|-----|-----|------|
| Find app | Store / permalink | `list_apps` / `search_apps` / hub | Slug known from creator |
| Auth | Session cookie; private app needs owner session | Same cookies/headers on **`/mcp/app/:slug`** per `resolveUserContext` | Bearer / cookie; **`FLOOM_AUTH_TOKEN`** if set globally |
| Start work | **`startRun`** or **`startJob`** | Tool call | **`POST /api/run`** or **`/api/:slug/run`** or **`/api/:slug/jobs`** |
| **Failure: async app + wrong HTTP path** | OK if UI uses jobs | OK (MCP queues) | **Risk:** sync POST blocks or times out |
| **Failure: private app, wrong user** | 404 / no data | **`checkAppVisibility`** blocks | Same |
| **Failure: missing secrets** | UI prompts / vault | Structured **`missing_secrets`** in tool text | Runner / proxied error on **`runs`** row; **`400`** only at validation |

---

## 8. Cross-references

- **`docs/PRODUCT.md`** — ICP, three surfaces, load-bearing **`mcp.ts`**.
- **`apps/web/src/assets/protocol.md`** — intended public contract for HTTP + MCP URLs.
- Related deep tracks: **`pd-10-async-jobs-differentiator.md`**, **`pd-06-secrets-trust-contract.md`**, **`pd-18-mcp-agent-native.md`**, **`pd-11-selfhost-cloud-split.md`**.

---

*Generated as part of deep product audit pd-05; sources reviewed include `docs/PRODUCT.md`, `AppPermalinkPage.tsx`, `mcp.ts`, `run.ts`, `jobs.ts`, `proxied-runner.ts`, `runner.ts`, `protocol.md`, `client.ts`.*
