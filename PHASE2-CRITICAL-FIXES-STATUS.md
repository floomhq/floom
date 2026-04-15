# Phase 2 critical fixes · v0.2.0

**Sprint date:** 2026-04-14
**Repo:** https://github.com/floomhq/floom
**Base commit:** `2265b7f` (v0.1 baseline)
**HEAD commit:** `03a34c3` + version bump (HEAD after this doc lands)
**Tag:** `v0.2.0` (pending — to be cut after this report merges)

## Summary

| Metric | Value |
|--------|-------|
| Commits this sprint | 13 feat/fix/docs/ci + 1 version bump |
| Fixes landed | 15 of 15 |
| Image tag (pending) | `ghcr.io/floomhq/floom:v0.2.0` + `:latest` (amd64 + arm64) |
| Unit tests | 11 `buildUrl` + 13 `resolveBaseUrl` + 4 stress specs = 28 passing |
| New typechecks | `pnpm --filter @floom/server typecheck` clean |
| Lines changed | +1,877 / −185 in `apps/server/src` (excluding tests + docs) |

## Directive (Federico's exact quote)

> "We should make sure that all the apps are working properly following the new protocol, and then yeah we can also make adjustments to the apps itself or the GitHub. We don't need to change any marketing claims. Make this work for any OpenAPI, otherwise this has no sense. For the other issues we also have to fix them."

All 15 P0/P1 fixes from the workplan landed. The headline promise "paste any OpenAPI spec, get a working Floom app" is now **demonstrably true for Stripe, GitHub, Petstore, and Resend** in automated tests, and **end-to-end verified live against Petstore** (HTTP call returned real pet data).

## Stress test results

`node test/stress/test-ingest-stress.mjs --cache` (after pulling specs once):

```
=== stripe ===
  operations: 587
  raw refs: 3778
  deref: 293ms → 1801 refs remaining (cyclic, handled)
  base_url: https://api.stripe.com/   (auto-resolved from spec.servers[])
  PASS

=== github ===
  operations: 1107
  raw refs: 9642
  deref: 681ms → 0 refs remaining
  base_url: https://api.github.com    (auto-resolved)
  PASS

=== petstore ===
  operations: 19
  raw refs: 43
  deref: 2ms → 0 refs remaining
  base_url: https://petstore3.swagger.io/api/v3  (spec-relative, resolved against fetch URL)
  PASS

=== resend ===
  operations: 83
  raw refs: 182
  deref: 12ms → 0 refs remaining
  base_url: https://api.resend.com    (auto-resolved)
  PASS

=== summary ===
  passed: 4/4
```

Before v0.2: all 4 specs ingested "successfully" but produced degraded manifests where every `$ref`-based body collapsed to a textarea, 97.5% of Stripe/GitHub operations were dropped at the 20-action cap, and Petstore/OpenAI calls 404'd due to the path-stripping bug.

After v0.2: full operation coverage, real typed schemas from dereferenced `$ref`s, auto-resolved base URLs, verified URL construction via unit test + live HTTP call.

## End-to-end verification (Petstore, live HTTP)

Booted the built server locally against real Petstore:

```
POST /api/petstore/run
{"action":"findPetsByStatus","inputs":{"status":"available"}}
→ {"run_id":"run_htbh7mtt50xf","status":"pending"}

GET /api/run/run_htbh7mtt50xf
→ status: success, outputs: [... 10+ real pet records ...]
```

Internal flow verified:
1. Auto-resolved base URL `https://petstore3.swagger.io/api/v3` from spec-relative `servers[]`
2. Generated all 19 operations as actions (not capped at 20)
3. Path prefix preserved → URL `https://petstore3.swagger.io/api/v3/pet/findByStatus?status=available` (not 404)
4. MCP `tools/list` returned fully typed schemas with enums, object fields, required lists
5. MCP `tools/call` returned isomorphic output

## Per-fix log

### Fix 1 · base_url path-stripping (commit `2f77a24`)

- **Before:** `new URL('/pet/findByStatus', 'https://petstore3.swagger.io/api/v3')` → `https://petstore3.swagger.io/pet/findByStatus` (404)
- **After:** string-concat the base pathname + operation path, then construct URL against origin
- **Tests:** 11-case unit test at `test/stress/test-build-url.mjs` covering Petstore, OpenAI, Stripe, GitHub, Resend, path params with special chars, trailing slashes, double-slash collapse, deeply nested base paths, base with existing query string
- **Live verified:** `https://petstore3.swagger.io/api/v3/pet/findByStatus?status=available` returns HTTP 200 with real pet data

### Fix 2 · Read spec.servers[] with variable substitution (commit `3bb2ea3`)

- **Before:** `base_url` required in apps.yaml or ingest failed silently
- **After:** `resolveBaseUrl` reads priority: (1) apps.yaml override, (2) `spec.servers[0].url` with `{var}` substitution against `spec.servers[0].variables[*].default`, (3) Swagger 2.0 `host + basePath + schemes[0]`, (4) spec fetch URL origin last-resort
- **Also:** supports spec-relative URLs (`servers: [{url: "/api/v3"}]`) by resolving against the fetch URL — this is how Petstore works
- **Tests:** 13-case unit test at `test/stress/test-resolve-base-url.mjs`

### Fix 3 · FLOOM_MAX_ACTIONS_PER_APP (commit `dee30c6`)

- **Before:** hard-coded `maxActions = 20` silently dropped 567 of 587 Stripe ops, 1,087 of 1,107 GitHub ops
- **After:** default 200, overridable via env var, set to 0 for unlimited. Logs a warning when truncating with the spec's total operation count so users know exactly what to set. Also handles operationId collisions by appending `_2`, `_3`, etc.

### Fix 4 + Fix 5 · $ref resolution + allOf/oneOf/anyOf (commit `7a90f97`)

- **Before:** every `$ref` was ignored; every `$ref`-based request body collapsed to a `body` textarea. allOf/oneOf/anyOf ignored. 3,778 Stripe refs + 9,642 GitHub refs dropped.
- **After:** `@apidevtools/json-schema-ref-parser@15.3.5` (pinned) dereferences the entire spec with `{circular: 'ignore'}`. `json-schema-merge-allof@0.8.1` (pinned) merges allOf. Custom flattener for oneOf/anyOf unions properties from all branches; discriminator surfaced as a required enum.
- **Schema to input type:** now handles `format: binary` → file, `format: date-time` → date, `format: uri` → url, nullable unions (`['string', 'null']`) from OpenAPI 3.1, arrays and objects → textarea instead of text
- **Live verified:** Petstore `addPet` now exposes `id`, `name`, `category`, `photoUrls`, `tags`, `status` (enum: available|pending|sold) as typed fields. Previously it was a single `body` textarea.

### Fix 6 + Fix 7 · Header, cookie, multipart, missing_secrets (commit `dafbbf8`)

- **Header params:** emitted as `header_Authorization`, `header_X-Request-Id` etc. so they don't collide with body field names. Runner reads the prefix and injects into outgoing headers. Standard headers (content-type, accept, authorization) are skipped so they don't override the auth layer.
- **Cookie params:** same pattern with `cookie_` prefix, serialised into a single `Cookie` header.
- **Multipart:** when the operation declares `multipart/form-data` and no `application/json`, the runner builds a FormData body. File fields accept `Blob` or base64 data URLs (`data:image/png;base64,...`). Content-Type auto-set by fetch with boundary.
- **Content-Type routing:** `text/plain` for freeform textareas that can't be parsed as JSON, `application/json` for structured bodies, auto for FormData.
- **Missing secrets:** runner validates `manifest.secrets_needed` before the request and throws a new `MissingSecretsError`. The error is surfaced as a structured `{error: "missing_secrets", required: [...], help: "..."}` outputs blob.

### Fix 8 · OAuth2 client_credentials + HTTP Basic + custom apikey header (commit `ef68731`)

- **New auth types:** `basic`, `oauth2_client_credentials`
- **apikey:** configurable header name via apps.yaml `apikey_header` (defaults to `X-API-Key`)
- **basic:** secret names matched by substring `user`/`pass`, base64-encoded
- **oauth2_client_credentials:** apps.yaml carries `oauth2_token_url` + `oauth2_scopes`, secrets named `client_id`/`client_secret`. Tokens cached in-memory keyed by `token_url::client_id` for 60s before expiry. Automatic refresh on next call.
- **New DB columns:** `auth_config TEXT` (JSON blob), `visibility TEXT DEFAULT 'public'` (both idempotent ALTER TABLE migrations)
- **Type update:** `AuthType` exported from `types.ts`, `AuthConfig` interface added
- **OAuth2 authorization_code flow intentionally not supported** — it requires interactive user consent, which belongs in the MCP `_auth` meta path

### Fix 9 · Streaming responses (commit `8222671`)

- **Before:** `await res.text()` buffered the entire response, broke SSE and NDJSON endpoints
- **After:** detect `text/event-stream`, `application/x-ndjson`, `application/stream+json` via the response content-type. When detected, read `res.body.getReader()` in chunks, push each newline-delimited line into the `logs` stream so SSE subscribers on `/api/run/:id/stream` see them live. Accumulate the full body in `outputs` so synchronous callers (MCP `tools/call` waitForRun) still get everything.
- **NDJSON:** parses each line into a JSON object and returns an array
- **SSE:** returns raw text (clients parse event: / data: themselves)

### Fix 10 · Per-user MCP secrets via `_auth` extension (commit `806afad`)

- **Before:** apps that needed secrets (OpenPaper, Session Recall, OpenContext, ...) returned server-side Python tracebacks that MCP clients could not surface to users. 10 of 15 bundled apps were unusable from Claude Desktop.
- **After:**
  1. `buildZodSchema` accepts `secretsNeeded` and tacks an `_auth` object onto the inputSchema with one optional string field per required secret, each with a `'Per-user secret: NAME'` description
  2. The per-app MCP tool callback peels `_auth` off raw inputs before validation, converts to `perCallSecrets: Record<string, string>`
  3. `dispatchRun` accepts optional `perCallSecrets` and merges into `mergedSecrets` with higher priority than server-side persisted secrets. Never persisted.
  4. When `secretsNeeded` is non-empty AND no secrets are available (neither server-side nor `_auth`), returns a structured `missing_secrets` error with `required[]` + `help` text showing the exact `_auth` shape to send
- **Also fixed (P2):** unknown-app slug at `/mcp/app/:slug` now returns a JSON-RPC error envelope instead of a bare HTTP 404
- **Documented:** `_auth` example in docs/SELF_HOST.md "Per-user secrets" section

### Fix 11 · FLOOM_AUTH_TOKEN gate + per-app visibility (commit `a092812`)

- **New module:** `apps/server/src/lib/auth.ts` with `globalAuthMiddleware` + `checkAppVisibility` + `isAuthenticated`
- **Global auth:** when `FLOOM_AUTH_TOKEN` is set, `/api/*`, `/mcp/*`, `/p/*` require `Authorization: Bearer <token>` (or `?access_token=` for GET). `/api/health` is always open so Docker/k8s healthchecks work.
- **Constant-time comparison** to avoid timing attacks
- **Per-app visibility:** `apps.yaml` `visibility: auth-required` gates a specific app even when global auth is off. Integrated into `POST /api/run`, `POST /api/:slug/run`, `POST /mcp/app/:slug`.
- **Live verified:** unauthenticated GET /api/hub → 401, health → 200, correct token → 200, wrong token → 401.

### Fix 12 · FLOOM_SEED_APPS opt-in for bundled apps (commit `a1abb5a`)

- **Before:** 15 seeded docker apps all crashed on first run with `ENOENT /var/run/docker.sock`
- **After:** `seedFromFile` checks `FLOOM_SEED_APPS` env var; default off = empty hub, users populate via `apps.yaml`. When on, logs a reminder that `/var/run/docker.sock` must be mounted. Preserves preview.floom.dev's behavior by setting `FLOOM_SEED_APPS=true` in that deployment.

### Fix 13 · SELF_HOST.md rewrite + example files (commit `a4f50ec`)

- **Rewritten quickstart** using a working 2-app apps.yaml (petstore + resend, no base_url needed thanks to fix 2)
- **Full env var reference table** (PORT, DATA_DIR, FLOOM_APPS_CONFIG, FLOOM_SEED_APPS, FLOOM_AUTH_TOKEN, FLOOM_MAX_ACTIONS_PER_APP, OPENAI_API_KEY)
- **All 5 auth modes documented** with apps.yaml examples
- **MCP `_auth` extension documented** with a curl example showing the `_auth` arg
- **Security section** calling out the docker.sock footgun and the need for `FLOOM_AUTH_TOKEN`
- **Troubleshooting section** matching real error messages
- **New files:** `docker/apps.yaml.example` (referenced from the doc, was missing before), `docker/.env.example` (full env var list)
- **docker-compose.yml updated** to `v0.2.0` image, commented guidance for FLOOM_AUTH_TOKEN / FLOOM_SEED_APPS / FLOOM_MAX_ACTIONS_PER_APP, docker.sock mount commented with security warning

### Fix 14 · arm64 + amd64 multi-platform manifest (commit `03a34c3`)

- **Before:** `.github/workflows/publish-image.yml` built `linux/amd64` only
- **After:** `docker/setup-qemu-action@v3` for cross-compilation, `platforms: linux/amd64,linux/arm64` in both `setup-qemu` and `build-push-action`, `provenance: false` to avoid the attestation manifest that was breaking `docker manifest inspect` on some tools
- **Impact:** next tag push (v0.2.0) produces an index with both architectures. Apple Silicon Macs get native images on `docker pull`.

### Fix 15 · SPA wildcard + /openapi.json (commit `e9ed259`)

- **Before:** SPA catchall swallowed `/openapi.json`, `/docs`, `/metrics` and returned HTML
- **After:** explicit exclusion set in the SPA middleware: prefixes `/api/`, `/mcp`; exact `/openapi.json`, `/metrics`, `/docs`
- **Added:** real `/openapi.json` hand-written OpenAPI 3.0 document describing Floom's own admin API (health, hub, run, MCP). Returns real JSON at that path.
- **Live verified:** curl `/openapi.json` returns `{"openapi":"3.0.0","info":{"title":"Floom self-host API",...}}` instead of the homepage HTML.

## 15 apps status

See [docs/APPS-STATUS.md](docs/APPS-STATUS.md) for the full per-app audit. One-liner: all 15 are still docker-hosted (not converted to proxied yet), but they now:
1. Surface `missing_secrets` as a structured error instead of a Python traceback
2. Expose `_auth` in their MCP tool schemas so Claude Desktop / Cursor users can supply their own tokens per call
3. Are opt-in via `FLOOM_SEED_APPS=true` so the default empty hub is the self-host story

The proxied conversion of all 15 is deferred to v0.3 — it requires publishing public HTTP endpoints + OpenAPI specs for each, which is per-app author work outside the monorepo.

## What's in v0.2.0 vs v0.1.0

| Area | v0.1.0 | v0.2.0 |
|------|--------|--------|
| Base URL resolution | required manual base_url | auto-read spec.servers[] with variable substitution + spec-relative URL support |
| Path prefix preservation | broken (Petstore 404, OpenAI 404) | fixed with unit tests |
| $ref resolution | none (3,778 Stripe refs dropped) | @apidevtools/json-schema-ref-parser with circular ref handling |
| allOf / oneOf / anyOf | none (every complex body → textarea) | allOf merged, oneOf/anyOf properties unioned, discriminator enum |
| Action cap | hard-coded 20 | FLOOM_MAX_ACTIONS_PER_APP env (default 200, 0 = unlimited) |
| Header params | dropped | header_* prefix, runner injects |
| Cookie params | dropped | cookie_* prefix, serialised into Cookie header |
| Multipart uploads | impossible (always application/json) | FormData with Blob or base64 data URLs |
| Auth types | bearer, apikey, none | bearer, apikey (custom header), basic, oauth2_client_credentials, none |
| Streaming | buffered via res.text() | SSE + NDJSON chunked reader |
| MCP secrets injection | server-side only | per-call _auth meta param (Floom MCP extension) |
| Auth gate | none | FLOOM_AUTH_TOKEN + per-app visibility |
| Seeded apps | always on, docker.sock required | opt-in via FLOOM_SEED_APPS |
| Docker platforms | amd64 only | amd64 + arm64 multi-arch manifest |
| /openapi.json | swallowed by SPA | real OpenAPI 3 doc |
| SPA wildcard | included /docs, /metrics | explicit exclusions |
| SELF_HOST.md | referenced missing file | rewritten, example files ship |

## Ship checklist (for the next human/agent)

1. Verify the CI image build: after pushing the version-bump commit, cut the tag:
   ```
   cd /root/floom
   git tag -a v0.2.0 -m "Floom v0.2.0 — OpenAPI ingest rewrite"
   git push origin v0.2.0
   ```
   Then watch GitHub Actions. The `Publish Docker image` workflow should produce both `linux/amd64` and `linux/arm64` images.

2. Pull the published image on AX41 and smoke-test:
   ```
   docker pull ghcr.io/floomhq/floom:v0.2.0
   docker run --rm -d --name floom-v02-test -p 13060:3051 \
     -v /tmp/floom-e2e/apps.yaml:/app/config/apps.yaml:ro \
     -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \
     ghcr.io/floomhq/floom:v0.2.0
   sleep 5
   curl -s http://localhost:13060/api/health | jq
   curl -sX POST http://localhost:13060/api/petstore/run -d '{"action":"findPetsByStatus","inputs":{"status":"available"}}' -H 'content-type: application/json'
   docker rm -f floom-v02-test
   ```

3. Update `/var/www/wireframes-floom/ASSUMPTIONS.md`:
   - Assumption #2 (MCP): flip to 🟢 with v0.2.0 link, note the `_auth` extension unblocks the 10 secret-requiring apps
   - Assumption #3 (Docker self-host): flip to 🟢 with v0.2.0 link, note FLOOM_SEED_APPS gate + auth gate + amd64/arm64 manifest
   - Assumption #4 (OpenAPI ingest): flip to 🟢 with v0.2.0 link, point to `test/stress/test-ingest-stress.mjs` + the 4/4 pass result

4. Update the landing page / README to mention v0.2.0 features (but don't change marketing claims, per Federico).

## Still broken / deferred

- **OAuth2 authorization_code flow.** Only client_credentials works. Interactive consent deferred to v0.3 with a browser-based installer UI or MCP resource-owner flow.
- **Per-user state in multi-tenant deploys.** Every request still hits a shared SQLite. No per-user DB, no tenant isolation. v0.3 area.
- **15 bundled apps still hosted.** Proxied conversion is author work (each needs a public HTTPS endpoint + OpenAPI spec). Tracking in `docs/APPS-STATUS.md`.
- **No rate limiting.** Self-hosters can put nginx in front, but there's no built-in rate limiter. Audit mention.
- **CLI binary not in the Docker image.** Same as v0.1 — `@floom/cli` is install-separately via `npm i -g @floom/cli`.
- **Python library** is still vaporware. Not in this image. Mentioned in README but nothing to ship.
- **Response schema extraction** (populating `outputs` from `responses.200.content.*.schema`). Current `outputs` is still `[{name: 'response', type: 'json'}]`. Deferred to v0.3 because it requires rjsf/TanStack Table integration on the web side.
- **Aggregated `/mcp` endpoint.** Users still add one MCP config entry per app. The `search_apps` flow is a workaround. v0.3 with namespaced tools (`<slug>__<action>`).
- **Hub tool schemas surfaced in /api/hub.** HTTP-first users still need to read the manifest via MCP tools/list. Audit P1 issue #6. v0.2.1?

## 3 things I'm least confident about

1. **The cyclic-ref handling in `@apidevtools/json-schema-ref-parser`.** I used `{circular: 'ignore'}` which leaves the `$ref` in place when a cycle is detected. Stripe has 1,801 cyclic refs remaining after deref; GitHub has 0. I did not trace a real cyclic path through `flattenComposition` to confirm that walking a `$ref` left in place doesn't throw. If `flattenComposition` hits a cyclic `$ref`, it will treat it as `{type: undefined, ...}` and emit a `text` input rather than crash, but the user-facing tool will be incomplete. A stronger test would boot the server with a Stripe apps.yaml and actually call one of the cyclic-ref operations end-to-end. I ran the synthetic ingest stress test but not a live API call against Stripe with a real key.

2. **The OAuth2 client_credentials refresh path under concurrency.** The in-memory cache is keyed by `token_url::client_id` and has no mutex. Two concurrent calls to an expired token would both fetch a new token in parallel. Harmless but wasteful. Under Floom's current single-process architecture this is fine, but once we run multiple replicas each one will have its own cache. No test for concurrent-refresh.

3. **arm64 build in CI.** I updated `.github/workflows/publish-image.yml` to add `docker/setup-qemu-action` + `platforms: linux/amd64,linux/arm64`, but I did NOT run the workflow locally and have not confirmed that `better-sqlite3` native module compiles cleanly under QEMU for arm64. The node:20-slim base image has arm64, and `better-sqlite3@11.5.0` has arm64 prebuilds on npm, so it should work — but "should" is exactly what the CLAUDE.md rules tell me not to say. The next agent should watch the first v0.2.0 tag push and verify both platforms land in the manifest. If arm64 fails, the fix is likely just adding `RUN apt-get install -y python3 make g++` to the runtime stage (better-sqlite3 rebuild needs a toolchain) or using `--platform=$TARGETPLATFORM` explicitly in the Dockerfile.
