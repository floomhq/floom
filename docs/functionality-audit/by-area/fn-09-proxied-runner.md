# fn-09 — `services/proxied-runner.ts`

**Lens:** `docs/PRODUCT.md` — OpenAPI → proxied is the **advanced** deployment path (path 3 of 3); it must still honor the **three surfaces** (web `/p/:slug`, MCP `/mcp/app/:slug`, HTTP `/api/:slug/run`) with the same trust posture as the hosted runner.

**Scope:** `apps/server/src/services/proxied-runner.ts` and its immediate control-plane wiring in `services/runner.ts`, plus how errors surface on web (`OutputPanel.tsx` / `classifyRunError`) and MCP (`routes/mcp.ts`).

---

## Secret injection

**What gets injected**

- `buildAuthHeaders` maps `app.auth_type` (`bearer`, `apikey`, `basic`, `oauth2_client_credentials`) plus optional JSON `app.auth_config` (e.g. API key header name, OAuth2 token URL / scopes).
- **Bearer:** prefers the first secret whose **name** matches `token`, `api_key`, or `bearer` (case-insensitive substring); otherwise the **first non-empty secret value** in the `secrets` object. That heuristic can attach the wrong credential if multiple secrets are present and none match the preferred name pattern — insertion order of `secrets` matters.
- **API key:** first non-empty secret value; header name from `authConfig.apikey_header` or default `X-API-Key`.
- **Basic:** pairs entries by name regex (`user` / `pass`).
- **OAuth2 client credentials:** discovers `client_id` / `client_secret` by name regex, calls token endpoint, sets `Authorization: Bearer …`. Token response is cached in-process (`oauth2TokenCache`) keyed by `tokenUrl::clientId` with a 60s skew before expiry.

**What the runner passes in**

- `dispatchRun` in `runner.ts` builds `secrets` **only** for names listed in `manifest.secrets_needed`. Per-call MCP `_auth` merges in and wins, but still only keys that appear in `manifest.secrets_needed` end up in the object passed to `runProxied`. So “secret injection” is bounded by the manifest allowlist, not the full vault.

**User-controlled transport**

- Inputs prefixed `header_` / `cookie_` (from OpenAPI ingest) become additional headers / `Cookie`. Ingest skips declaring `Authorization`, `Accept`, and `Content-Type` as header inputs to reduce collisions. Merge order is `Accept`, then auth headers, then user `header_*` — in theory a spec that declared another sensitive header could still overlap with auth headers if naming were sloppy; normal Petstore-style specs are fine.

**Logging**

- Errors append `e.message` to logs; OAuth2 token endpoint failures can include response body text in the thrown message (bounded by upstream, not truncated here).

---

## Missing secrets vs upstream 401 / 403

**Design (correct separation)**

- **Before** `fetch`: required names are `actionSpec.secrets_needed` if that array is defined (including empty — meaning no secrets for that action), else `manifest.secrets_needed`. Any required name missing from `secrets` throws `MissingSecretsError`.
- The catch block returns `error_type: 'missing_secret'`, structured `outputs` (`error: 'missing_secrets'`, `required`, `help`), **no** `upstream_status` (comments in code and `types.ts` align).
- **After** `fetch`: HTTP 401 and 403 map to `error_type: 'auth_error'` with `upstream_status` set — distinct from missing_secret.

**Operational nuance**

- If security is mis-modeled (no `secrets_needed` for an operation that still requires auth upstream), the request may go out **without** auth headers; a **401/403** is then classified as `auth_error`, not `missing_secret`. The web copy for `auth_error` (`buildAuthError`) says Floom has “no credentials set”, which can be **literally wrong** when credentials exist but are invalid — still better than conflating with missing_secret, but worth knowing for support.

**MCP vs runner**

- MCP pre-checks DB + `_auth` against `actionSecretsNeeded` and returns JSON `missing_secrets` **before** enqueueing a run when nothing is available. If something is set but wrong, the proxied path still runs and returns `auth_error` like the web path.

---

## OpenAPI operation matching

**Algorithm**

- `findOperation` walks `spec.paths` via `Object.entries` (order not guaranteed by JSON), for each path tries `get`, `post`, `put`, `patch`, `delete`.
- Action name match uses the **same** construction as `openapi-ingest.ts` `operationToAction`: sanitized `operationId`, else `` `${method}_${pathSanitized}` ``.

**Strengths**

- Ingest and runtime stay in sync on naming as long as the cached spec matches the manifest generation pass.

**Gaps / edge cases**

- Operations using **HEAD** / **OPTIONS** (or other verbs) are **not** scanned — `findOperation` returns null → **fallback** `POST` to `base_url` with `JSON.stringify(inputs)` (surprising and easy to mis-debug).
- Duplicate `operationId` values across operations: first match in the nested iteration wins — could diverge from whichever operation ingest bound if order differs.
- Unparseable `openapi_spec_cached`: logs a warning, `findOperation` sees `{}` → same generic POST fallback.
- Manifest says action exists (`manifest.actions[action]`) but spec has no matching op: still executes fallback POST, not a hard “unknown operation” error.

---

## Timeouts

- Proxied `fetch` uses `AbortSignal.timeout(requestTimeoutMs)` where `requestTimeoutMs = app.timeout_ms > 0 ? max(30_000, app.timeout_ms) : 30_000`. Values **below 30s clamp up** to 30s (see `test/stress/test-proxied-timeout.mjs`).
- **OAuth2** token fetch uses a **fixed 15s** timeout, independent of `app.timeout_ms`.
- Streaming responses read until EOF with the **same** abort signal on the initial fetch; chunk loop has no per-chunk deadline (a stalled stream after headers is still bound by the overall fetch timeout in principle, but slow trickle behavior depends on the runtime).

---

## Body and header handling

**URL**

- `buildUrl` preserves `base_url` pathname (documents the `new URL` pitfall with leading `/` on the operation path) and merges base query string with per-operation query params.

**Headers**

- Default `Accept: application/json`. `Content-Type` set for non-`FormData` bodies when a body content type is known.

**Body**

- With `opInfo`, POST/PUT/PATCH: multipart if spec has `multipart/form-data` and **not** `application/json` in the same content map (if both exist, JSON path wins).
- JSON object from non-path/query/non-prefixed inputs; `body` textarea special-case for single-field JSON parse vs plain text.
- **GET** (and DELETE with opInfo): no body branch — correct for typical REST.
- **Fallback** when no operation: always POST JSON of **all** inputs (including any `header_*` keys unless filtered… actually fallback uses full `inputs` object — prefixed keys would be inside JSON body, not as HTTP headers). Only the OpenAPI-matched path applies header_/cookie_ routing.

**Streaming**

- SSE / NDJSON / stream+json: accumulates full body into memory and mirrors newline chunks into `logs` for live subscribers; NDJSON lines parsed to an array of JSON or raw strings.

---

## Error surfaces — web and MCP

**Persistence (`runProxiedWorker` in `runner.ts`)**

- On returned result: `status`, `outputs`, `error`, `error_type` (errors default to `runtime_error` if absent), `upstream_status`, `logs`, `duration_ms`, `finished`.
- Uncaught exception inside `runProxied`: `error_type: 'floom_internal_error'` (clear “Floom bug” path vs network).

**Web (`classifyRunError`)**

- Trusts persisted `error_type` first (`user_input_error`, `auth_error`, `upstream_outage`, `network_unreachable`, `floom_internal_error`), then legacy heuristics including `missing_secret` and HTTP parsing from `error` string.
- `upstream_status` drives copy where relevant (e.g. 404 as user input).

**MCP (`formatRun` + tool return)**

- Completed runs are JSON with `status`, `error`, `error_type`, `outputs`, `logs`, `duration_ms`, timestamps — **but `formatRun` omits `upstream_status`**. MCP clients must parse `error` (e.g. `HTTP 403: …`) or rely on `error_type` without knowing the exact status unless they poll HTTP `GET /api/run/:id` or the DB view is extended later.

**Pre-run MCP**

- Structured `missing_secrets` JSON text with `isError: true` when required secrets are absent from DB + `_auth` — aligns with proxied-runner’s missing-secret semantics, though the **wording** differs (`_auth` hint vs docker/apps.yaml in runner help text).

---

## Summary verdict

| Area | Verdict |
|------|---------|
| Secret injection | Manifest-scoped secret keys; auth heuristics are convenient but can pick the wrong secret when several exist; OAuth2 caching is in-memory per process. |
| Missing vs 401/403 | Clean taxonomy at source; edge case where no secret is required by manifest but upstream still demands auth surfaces as `auth_error`, not `missing_secret`. |
| OpenAPI matching | Matches ingest naming; unsupported HTTP verbs and spec/manifest drift fall back to generic POST — highest-risk footgun. |
| Timeouts | 30s floor on app timeout; OAuth2 uses separate 15s cap. |
| Body/headers | Generally faithful to OpenAPI shapes; multipart vs JSON decision is spec-sensitive. |
| Web vs MCP | Web gets full taxonomy + `upstream_status`; MCP JSON omits `upstream_status` on completed runs. |
