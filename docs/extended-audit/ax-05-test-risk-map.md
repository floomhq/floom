# ax-05 — P0 roadmap vs test map

**Scope:** [`docs/ROADMAP.md`](../ROADMAP.md) section **P0 — Launch blockers** (snapshot 2026-04-17), mapped to automated tests under `packages/hub-smoke/tests/*`, **`apps/server` test entrypoint** (see note), and `packages/runtime/tests/*`.

**Note on `apps/server`:** There are no colocated `*.test.ts` / `*.spec.ts` files under `apps/server/`. `pnpm test` in `apps/server` runs Node scripts in repo-root [`test/stress/`](../../test/stress/) (see `apps/server/package.json` `test` script). This audit treats those as the **server stress / integration** suite for server-owned risk.

**Coverage legend**

| Level | Meaning |
|-------|---------|
| **none** | No meaningful automated check for this journey. |
| **partial** | Touches adjacent layers (e.g. backend only, or UI happy path without the P0-specific surface), or unit tests without HTTP/stack integration. |
| **full** | Automated checks that would likely catch regressions on the stated P0 outcome end-to-end (or equivalent depth for non-UI items). |

---

## P0 items (source)

From ROADMAP P0:

1. Async job queue UI (re-enable)
2. Custom renderer upload UI (re-enable)
3. Rate-limit all `/api/*/run` endpoints
4. Legal: imprint, privacy policy, terms, cookie consent
5. Landing + public-page polish (wireframes v13)
6. Repo → hosted pipeline (`packages/runtime` + `packages/detect` + manifest; server route `/api/deploy-github` + SSE; `/build` ramp; quotas; `services/docker.ts` defaults)

Product pillars and load-bearing paths: [`docs/PRODUCT.md`](../PRODUCT.md).

---

## Master table: journey → test file → coverage

One row per **(journey, test file)** pair. Files with **none** for a journey are omitted from that journey’s rows (listed instead in gap list).

### 1. Async job queue UI (re-enable)

| Journey | Test file | Coverage |
|---------|-----------|----------|
| Async job queue UI | `packages/hub-smoke/tests/hub-full.spec.ts` | **partial** — `/p/:slug` load + generic run; does not assert async job poll UX or jobs panel. |
| Async job queue UI | `packages/hub-smoke/tests/fast-apps.spec.ts` | **partial** — sync-style run + `[data-renderer]`; fast-apps are not the async-queue UI. |
| Async job queue UI | `test/stress/test-jobs-service.mjs` | **partial** — DB/service: create, claim, complete, cancel, requeue; no HTTP router, no UI. |
| Async job queue UI | `test/stress/test-jobs-e2e.mjs` | **partial** — live server: `POST /api/:slug/jobs`, poll job, webhook collector; touches **API** queue, not web UI. |
| Async job queue UI | `test/stress/test-triggers-webhook.mjs` | **partial** — enqueue via signed webhook; worker mocked. |
| Async job queue UI | `test/stress/test-triggers-schedule.mjs` | **partial** — scheduler → job row; no UI. |
| Async job queue UI | `test/stress/test-triggers-live.mjs` | **partial** — integration with worker; still not UI. |
| Async job queue UI | `packages/runtime/tests/**` | **none** |

### 2. Custom renderer upload UI (re-enable)

| Journey | Test file | Coverage |
|---------|-----------|----------|
| Custom renderer upload UI | `test/stress/test-renderer-contract.mjs` | **partial** — contract/shape of renderer integration. |
| Custom renderer upload UI | `test/stress/test-renderer-defaults.mjs` | **partial** — defaults resolution. |
| Custom renderer upload UI | `test/stress/test-renderer-bundler.mjs` | **partial** — bundler behavior. |
| Custom renderer upload UI | `test/stress/test-renderer-e2e.mjs` | **partial** — ingest path with renderer in apps.yaml; `rendererRouter` fetch; **not** multipart/creator upload UI. |
| Custom renderer upload UI | `test/stress/test-renderer-sandbox.mjs` | **partial** — sandbox constraints. |
| Custom renderer upload UI | `test/stress/test-renderer-cascade.mjs` | **partial** — `rendererCascade` selection (runs via tsx on web source). |
| Custom renderer upload UI | `test/stress/test-run-surface.mjs` | **partial** — `RunSurface` / input helpers; not upload. |
| Custom renderer upload UI | `packages/hub-smoke/tests/fast-apps.spec.ts` | **partial** — output mount signal only. |
| Custom renderer upload UI | `packages/hub-smoke/tests/hub-full.spec.ts` | **partial** — rendered output when run succeeds. |
| Custom renderer upload UI | `packages/runtime/tests/**` | **none** |

### 3. Rate-limit all `/api/*/run` endpoints

| Journey | Test file | Coverage |
|---------|-----------|----------|
| Rate-limit `/api/*/run` | `test/stress/test-rate-limit.mjs` | **partial** — exhaustive for `lib/rate-limit.ts` + `runRateLimitMiddleware` with fake Hono-like `ctx` (including `param('slug')`); **not** a live `POST` through `apps/server` to assert 429 on both `POST /api/run` and `POST /api/:slug/run`. |
| Rate-limit `/api/*/run` | `test/stress/test-rate-limit-xff.mjs` | **partial** — optional live probe (default URL mentions `/api/.../run`); manual/ambient dependency. |
| Rate-limit `/api/*/run` | `test/stress/test-public-permalinks.mjs` | **partial** — client helper maps **429** to user-facing copy for run start; not server enforcement. |
| Rate-limit `/api/*/run` | `test/stress/test-fast-apps.mjs` | **partial** — happy-path `POST /api/:slug/run` only (no limit burn). |
| Rate-limit `/api/*/run` | `packages/hub-smoke/**` | **none** — Playwright does not assert rate-limit headers or 429 on API. |
| Rate-limit `/api/*/run` | `packages/runtime/tests/**` | **none** |

*Context:* `apps/server/src/index.ts` mounts the same `runRateLimitMiddleware` on `/api/run` and `/api/:slug/run`; wiring is not covered by a dedicated integration test that forces 429 on both paths.

### 4. Legal: imprint, privacy policy, terms, cookie consent

| Journey | Test file | Coverage |
|---------|-----------|----------|
| Legal + cookie consent | `test/stress/**` | **none** — no tests for `/imprint`, `/privacy`, `/terms`, consent banner, or policy links. |
| Legal + cookie consent | `packages/hub-smoke/**` | **none** |
| Legal + cookie consent | `packages/runtime/tests/**` | **none** |

*Adjacent:* `test/stress/test-security-headers.mjs` exercises security headers middleware (CSP/HSTS etc.), not legal copy or consent UX.

### 5. Landing + public-page polish (wireframes v13)

| Journey | Test file | Coverage |
|---------|-----------|----------|
| Landing + public polish | `packages/hub-smoke/tests/fast-apps.spec.ts` | **partial** — `/p/:slug` for fast-apps only; not marketing `/` or v13 layout. |
| Landing + public polish | `packages/hub-smoke/tests/hub-full.spec.ts` | **partial** — permalinks for hub-listed apps; requires auth env; not landing hero/nav/IA. |
| Landing + public polish | `test/stress/test-public-permalinks.mjs` | **partial** — pure helpers in `apps/web` for permalink paths and error classification; **not** page render. |
| Landing + public polish | `test/stress/test-hub-public-filter.mjs` | **partial** — hub list filtering; not landing design. |
| Landing + public polish | Other `test/stress/**` | **none** for wireframe v13 / homepage polish |

### 6. Repo → hosted pipeline

| Journey | Test file | Coverage |
|---------|-----------|----------|
| Repo → hosted pipeline | `packages/runtime/tests/detect/workdir.test.ts` | **partial** — workdir detection. |
| Repo → hosted pipeline | `packages/runtime/tests/detect/pnpm-detect.test.ts` | **partial** |
| Repo → hosted pipeline | `packages/runtime/tests/detect/php-ext.test.ts` | **partial** |
| Repo → hosted pipeline | `packages/runtime/tests/detect/src-layout.test.ts` | **partial** |
| Repo → hosted pipeline | `packages/runtime/tests/detect/uv-detect.test.ts` | **partial** |
| Repo → hosted pipeline | `packages/runtime/tests/detect/rules.test.ts` | **partial** — composed rules for known repos. |
| Repo → hosted pipeline | `packages/runtime/tests/provider/ax41-docker.test.ts` | **partial** — `parseRepoUrl` + git remote URL scrub; **no** clone/build/run/docker integration (explicitly out of scope in file header). |
| Repo → hosted pipeline | `test/stress/test-run-surface.mjs` | **partial** — `maybePrependHttps('github.com/owner/repo')` style helper only. |
| Repo → hosted pipeline | `test/stress/**` (remainder) | **none** — no `POST /api/deploy-github`, no SSE log stream test, no `/build` flow, no deploy quota tests. |
| Repo → hosted pipeline | `packages/hub-smoke/**` | **none** |

---

## Gap list (prioritized)

1. **Legal + consent (P0)** — No automated check that imprint/privacy/terms routes exist, return 200, or that cookie consent gates optional scripts. Highest gap vs explicit P0 bullet.
2. **Landing / v13 polish (P0)** — No Playwright or visual snapshot against `/`, `/apps`, or marketing sections; hub-smoke stays on `/p/:slug` utilities.
3. **Custom renderer upload UI (P0)** — Renderer **pipeline** has strong stress coverage; **upload** and creator-facing upload validation (size, MIME, virus policy, RBAC) have no dedicated tests.
4. **Async job queue UI (P0)** — Backend jobs + triggers are tested; **no** UI test for re-enabled queue states (queued/running/failed), pagination, or cancel from web.
5. **Rate limits on real run routes (P0)** — Middleware is unit-tested; add a short integration test that boots `apps/server`, burns cap, and asserts **429** + `Retry-After` + `X-RateLimit-*` on **`POST /api/run`** and **`POST /api/:slug/run`** (and optionally legacy body-keyed slug).
6. **Repo → hosted pipeline (P0)** — `deployFromGithub` / `Ax41DockerProvider` beyond parse+scrub; server **deploy-github** route + SSE; `/build` ramp; per-user quota; hardened `docker.ts` defaults — all **untested** in listed suites. Runtime detect tests do not replace build/push/smoke HTTP.

---

## Suggested next tests (no code in this audit)

| Gap | Suggested test (location / type) |
|-----|----------------------------------|
| Legal | Playwright or static link crawl: assert 200 + required strings on legal URLs; optional axe pass on those pages only. |
| Cookie consent | One test: first visit sets consent state; analytics or optional script blocked until accept (if product defines behavior). |
| Landing v13 | `hub-smoke` (or web e2e) project: `/` and `/apps` screenshots or DOM assertions against agreed selectors from wireframes. |
| Renderer upload | API: multipart upload happy path + oversize + wrong type; UI: single Playwright path through creator upload if exposed. |
| Async job UI | Playwright: fixture async app → enqueue from UI → visible status transitions → terminal state; cancel if supported. |
| Rate limit integration | `test/stress/`: spawn server with `FLOOM_RATE_LIMIT_*` tuned to 1/hr; alternate `POST /api/run` vs `POST /api/{slug}/run` until 429; assert headers/body match `test-rate-limit.mjs` contract. |
| Deploy pipeline | Tiered: (a) contract test for future `POST /api/deploy-github` handler (auth, quota 402/429); (b) optional CI job with docker-in-docker against canned public repo behind flag. |
| Runtime | Extend `ax41-docker` or new file with **mocked** dockerode/git only where pure; keep real clone/build in labeled optional CI per `ax41-docker.test.ts` comment. |

---

## Inventory reference

### `packages/hub-smoke/tests/*`

| File | Role |
|------|------|
| `fixtures.ts` | Shared fixtures (not a test module). |
| `fast-apps.spec.ts` | Anonymous `/p/:slug` + run + output visibility for fast-apps list. |
| `hub-full.spec.ts` | Authenticated sweep of hub apps: `/p/:slug` + run (skips without `E2E_EMAIL` / `E2E_PASSWORD`). |

### `apps/server` → `test/stress/*.mjs` (excerpt)

Server `pnpm test` runs 50+ scripts including (P0-relevant): `test-jobs-service.mjs`, `test-jobs-e2e.mjs`, `test-triggers-*.mjs`, `test-rate-limit.mjs`, `test-rate-limit-xff.mjs`, `test-renderer-*.mjs`, `test-run-surface.mjs`, `test-run-auth.mjs`, `test-fast-apps.mjs`, `test-public-permalinks.mjs`, `test-security-headers.mjs`. Full list: `apps/server/package.json` `test` script.

### `packages/runtime/tests/*`

| Path | Role |
|------|------|
| `detect/*.test.ts` | Static fixture-based detection rules. |
| `provider/ax41-docker.test.ts` | URL parsing + `.git/config` token scrubbing. |

---

## Summary by journey (short)

| P0 journey | Strongest existing signal | Weakest link |
|------------|---------------------------|--------------|
| Async job queue UI | `test-jobs-e2e.mjs` + jobs service | Web UI |
| Custom renderer upload UI | `test-renderer-e2e.mjs` + bundler suite | Upload UI + auth |
| Rate-limit `/api/*/run` | `test-rate-limit.mjs` | HTTP integration for both POST paths |
| Legal + cookie consent | — | Entire journey |
| Landing + public polish | Permalink / hub smoke fragments | Marketing `/` |
| Repo → hosted pipeline | `packages/runtime/tests/detect/*` + parse/scrub | Server deploy route, docker build, smoke HTTP |

---

*Extended audit ax-05. Markdown only; no product code changes.*
