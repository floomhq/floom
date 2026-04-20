# AX-02 — SSRF / user-controlled URL fetch (server)

**Scope:** `apps/server/src` — grep targets `fetch(`, `axios`, `request(`.

**Findings:** `axios` and `request(` do not appear in this tree. All outbound HTTP uses `globalThis.fetch` (Node undici) except Composio (SDK). No centralized URL allowlist, SSRF guard, or `redirect: 'manual'` on user-influenced fetches.

**Redirect behavior:** Undici’s `fetch` follows redirects by default (including cross-origin). None of the call sites below override `redirect`. A user-controlled initial URL can therefore chain through an attacker-controlled 302 to metadata endpoints, loopback, or RFC1918 hosts *if* the redirect target is reachable from the Floom process network namespace.

---

## Inventory

| ID | Module / route | `fetch` call site | URL provenance | Auth / exposure | Allowlist / validation | Redirects | Risk |
|----|----------------|-------------------|----------------|-----------------|-------------------------|-----------|------|
| F1 | `services/openapi-ingest.ts` — `fetchSpec` | `fetch(url, { headers, signal: 30s })` | **User input:** `openapi_url` from `POST /api/hub/detect`, `POST /api/hub/ingest`, MCP `ingest_app`; **Operator:** `openapi_spec_url` in `apps.yaml` during `ingestOpenApiApps`; **Hub DB:** re-fetch not observed in server (spec fetched at ingest time, stored cached). | `/hub/detect` is **unauthenticated** (no `requireAuthenticatedInCloud`). `/hub/ingest` and MCP `ingest_app` require auth in cloud. `apps.yaml` ingest is operator-controlled. | `ingestAppFromUrl` requires `/^https?:\/\//i` on `openapi_url`. **Gap:** `fetchSpec` itself does **not** enforce scheme. `detectAppFromUrl` calls `fetchSpec` **without** that check — only `z.string().url()` from hub/MCP. Non-HTTP(S) schemes that pass `new URL()` may reach `fetch` (environment-dependent; e.g. `file:`). No private-IP / metadata host blocklist. | Default follow | **High** (arbitrary egress + redirect SSRF; **detect** is public and slightly weaker than ingest on scheme) |
| F2 | `services/openapi-ingest.ts` — `dereferenceSpec` | `$RefParser.dereference(clone, { circular: 'ignore' })` | **User / operator / MCP inline spec:** any HTTP(S) `$ref` inside the OpenAPI document after initial load. Malicious spec can embed remote `$ref` URLs. | Same as F1 for ingest/detect/MCP; inline MCP spec skips `fetchSpec` but still dereferences. | **No** URL filtering in options; library default resolves external refs over HTTP(S). Failures are caught and raw spec is used — partial fetches may still occur before failure. | Library-dependent (typically follows redirects like other HTTP clients) | **High** (second egress channel; can hit URLs never passed to `fetchSpec` if `$ref` points elsewhere) |
| F3 | `services/proxied-runner.ts` — upstream | `fetch(url, fetchInit)` with `AbortSignal.timeout` | **Hub DB:** `app.base_url` (from ingest: `resolveBaseUrl` + `apps.yaml` / spec `servers` / spec URL origin). **Cached spec:** operation `path` + method from `openapi_spec_cached`. **End-user input:** path segments, query values, `header_*` / `cookie_*`, body fields — merged via `buildUrl` / request builder (not a new host; can still change path/query/body). | Anyone who can **run** the app (per app visibility / auth). Creator chooses upstream. | No validation that `base_url` host is public vs private; no blocklist for `10/8`, `172.16/12`, `192.168/16`, `127.0.0.1`, `169.254.169.254`, etc. Intended upstream is “creator’s API” but Floom server performs the fetch (SSRF *from Floom’s network* if creator or compromised account points `servers` / `base_url` at internal targets). | Default follow | **High** (network-position SSRF / internal API abuse; classified as product-trusted creator config rather than anonymous internet SSRF, but impact is similar if a malicious app is published) |
| F4 | `services/proxied-runner.ts` — OAuth2 token | `fetch(tokenUrl, POST form)` | **Hub DB:** `auth_config.oauth2_token_url` from `apps.yaml` ingest (`openapi-ingest` persists `auth_config` JSON). | Same as proxied run — runs when app uses `oauth2_client_credentials`. | URL string only; throws if missing; **no** host allowlist. | Default follow | **Medium–High** (operator/creator-controlled token endpoint; redirect SSRF applies) |
| F5 | `services/webhook.ts` — `deliverWebhook` | `fetchImpl(url, { POST, signal })` | **Per-job user input:** `POST /api/:slug/jobs` body `webhook_url` string (`jobs.ts` → `webhookUrlOverride`). **Hub DB:** else `apps.webhook_url` from `apps.yaml` / ingest (async apps). | Job creation requires passing app visibility checks; still **any caller who may enqueue jobs** can supply `webhook_url`. | **None** (no `z.string().url()`, no scheme check, no length cap in router). | Default follow | **Critical** for **user-supplied** completion webhook: unconstrained outbound POST to attacker-chosen URL (SSRF, exfil to arbitrary receiver, possible interaction with redirects). DB-stored app default webhook is creator-controlled (lower anonymous abuse, same technical class). |
| F6 | `services/fast-apps-sidecar.ts` — `waitForHealthy` | `fetch(url, { timeout: 500ms })` | **Code:** health URL built from `host` + `port` for local sidecar. | Dev / optional fast-apps boot. | Local sidecar only. | Default follow | **Low** |
| F7 | `services/embeddings.ts` | `fetch('https://api.openai.com/...')` | Fixed OpenAI URL. | Internal. | Hardcoded HTTPS. | n/a | **Low** |
| F8 | `services/parser.ts` | `fetch('https://api.openai.com/...')` | Fixed OpenAI URL. | Internal. | Hardcoded HTTPS. | n/a | **Low** |
| C1 | `services/composio.ts` + `@composio/core` | SDK (not `fetch(` in this grep) | Composio API endpoints; `redirectUrl` from SDK for OAuth. | Authenticated product flow; `userId` / connection ids are Floom-controlled. | No user-supplied raw URL fetch in server grep path. | SDK | **Low** (indirect trust in Composio SDK and vendor TLS; not a generic user-URL fetch) |

---

## Route / feature notes

### `openapi-ingest.ts`

- **`fetchSpec`:** Single entry for “download spec text”. No `redirect: 'manual'`, no DNS rebinding mitigation, no IP allow/deny.
- **`ingestAppFromUrl`:** `https?` prefix check before `fetchSpec` — good for **ingest**, not applied in **`detectAppFromUrl`**.
- **`ingestOpenApiApps`:** `openapi_spec_url` from YAML is trusted like any config file on disk; still triggers `fetchSpec` and `dereferenceSpec` (F1/F2).
- **`resolveBaseUrl`:** Can yield `http://host:port` from Swagger `host` + `schemes` or from `servers[0].url` after variable substitution — all later used as F3 `base_url`.

### OG routes (`routes/og.ts`)

- **No outbound `fetch`.** Reads SQLite for `slug` → name/description/author; renders SVG. **Out of scope** for URL-fetch SSRF (XML injection / XSS in SVG is a separate class).

### Webhooks

- **Outbound (F5):** `worker.ts` → `deliverCompletion` → `deliverWebhook(job.webhook_url, ...)`.
- **Inbound:** `routes/webhook.ts` — receives POST; does not add outbound user-controlled fetch from this grep set.

### Composio

- OAuth initiate / poll / delete / execute go through **`getComposioClient()`** and the Composio SDK, not direct `fetch(url)` in `apps/server/src`. Treat as vendor-controlled endpoints unless SDK exposes redirect-to-file.

### `openapi_spec_url` (DB column)

- Persisted at ingest; used for **resolution context** in `resolveBaseUrl` and logging; **runtime upstream** calls use **`base_url`** + cached spec (F3), not a re-fetch of `openapi_spec_url` on each run in the reviewed paths.

---

## Risk summary

| Rating | Items | Concise rationale |
|--------|--------|-------------------|
| **Critical** | F5 (`webhook_url` override on `POST .../jobs`) | Fully attacker-controlled URL string with no validation; server issues POST with job output/error; default redirect following amplifies SSRF. |
| **High** | F1 (especially public `/api/hub/detect`), F2, F3, F4 | Arbitrary or spec-driven egress; redirects; no private-network guards; F3 runs on behalf of Floom infra toward creator-declared `base_url`. |
| **Low** | F6–F8, C1, OG routes | Fixed or local URLs / vendor SDK. |

---

## Recommendations (no code in this audit)

1. **Completion webhooks (F5):** Require `https:` only, optional hostname allowlist or denylist (block RFC1918, loopback, link-local, metadata IPs), max URL length, and consider **`redirect: 'manual'`** with an explicit policy (e.g. disallow redirects or re-validate Location target before following once).
2. **OpenAPI fetch + dereference (F1/F2):** Align **`detectAppFromUrl`** with **`ingestAppFromUrl`** (`https?` only). Optionally run **`fetchSpec`** through the same guard. For `$RefParser`, use library-supported options to **disable or strictly gate external `$ref` resolution** (custom `resolve` handlers / `external: false` style flags per installed `@apidevtools/json-schema-ref-parser` version), or allow only same-origin as the spec URL — product tradeoff vs spec completeness.
3. **Proxied upstream (F3/F4):** Document that Floom egresses from server network. If product requires safety: optional **`FLOOM_UPSTREAM_ALLOWLIST`** / SSRF middleware (DNS resolution + connect to resolved IP with IP range checks), or creator-only mode with signed manifests for self-host.
4. **Redirects (global):** Centralize outbound `fetch` wrapper with **redirect cap**, **manual redirect** + URL re-validation, or **disabled redirects** where response body is not needed from redirected host.
5. **Rate limits / abuse:** `/api/hub/detect` is unauthenticated — pair scheme fixes with **IP- or token-based rate limits** to reduce blind SSRF scanning volume.

---

## Grep reference

Commands equivalent to the audit:

- `rg "\\bfetch\\s*\\(" apps/server/src`
- `rg "axios|\\\\brequest\\s*\\(" apps/server/src` (no hits)

**Files touched by inventory:** `openapi-ingest.ts`, `proxied-runner.ts`, `webhook.ts`, `fast-apps-sidecar.ts`, `embeddings.ts`, `parser.ts`, `routes/hub.ts`, `routes/mcp.ts`, `routes/jobs.ts`, `services/jobs.ts`, `services/worker.ts`, `services/composio.ts`, `routes/og.ts` (negative for fetch).
