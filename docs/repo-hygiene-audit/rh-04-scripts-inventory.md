# rh-04 — Scripts inventory

**Audit type:** Repo-hygiene (read-only).
**Source of truth:** `package.json` (root), `apps/*/package.json`,
`packages/*/package.json`, `scripts/`, `apps/server/scripts/`,
`docker/scripts/`, `.github/workflows/*.yml`. No root `Makefile` or
equivalent.
**Repo snapshot:** branch `docs/hygiene-and-docs-audit-2026-04-20`.

## Executive summary

The repo has **six npm scripts at the root**
(`build`, `dev`, `typecheck`, `test`, `test:hub-smoke`, `lint`) and
**about twenty more** spread across workspaces. All are turbo-mediated
except `test:hub-smoke`, which shortcuts directly into the
`@floom/hub-smoke` package. **`lint` is a no-op** (no `.eslintrc*`,
no per-package `lint` script — same finding as **rh-01**).

Standalone scripts break into three categories:

1. **Active tools** — `scripts/build-catalog.ts`,
   `scripts/verify-hub-apps.mjs`, `apps/server/scripts/copy-assets.mjs`,
   `docker/scripts/floom-backup.sh`. Each has a clear purpose and at
   least one doc reference.
2. **Dead one-shot** — `apps/server/scripts/audit-2026-04-18-renderer-test-desc.sh`
   (dated filename, single-row DB patch, no caller). Safe to archive.
3. **CI workflows** — 4 GitHub Actions files, all active; one carries
   a long explanatory comment (`publish-image.yml:37–42`) flagging the
   `floom` vs `floom-monorepo` image repo tension that also shows up
   in rh-03 as tag drift.

The one real hygiene hit here is the **gigantic single-line `test`
script in `apps/server/package.json`** (~4 800 characters across 61
`&&`-chained stress tests, all from `test/stress/*`) — not broken, but
fragile: one test failing aborts the chain, stderr is interleaved, and
there is no way to run a single group. See rh-06 for coverage analysis.

---

## Executive truth table

| # | Expectation (evidence) | Reality (evidence) | Verdict |
|---|------------------------|--------------------|---------|
| 1 | `pnpm build` / `dev` / `typecheck` / `test` cover the whole monorepo via turbo. | Root `package.json "scripts"`: `build: turbo build`, `dev: turbo dev`, `typecheck: turbo typecheck`, `test: turbo test`. | **Met** |
| 2 | `pnpm lint` runs a real linter in CI. | Root `"lint": "turbo lint"` + `turbo.json "lint": {}`; **no** package declares a `lint` script, **no** `.eslintrc*` / `eslint.config.*` file exists. `pnpm lint` exits 0 with zero work. | **Contradicted** |
| 3 | CI (`.github/workflows/ci.yml`) runs typecheck + test on `main` and PRs. | Confirmed at `.github/workflows/ci.yml:9–34`. Lint not referenced. | **Met** (partial — lint not wired) |
| 4 | `apps/server` test script is discoverable / maintainable. | `apps/server/package.json "test"` is a **single line of 61 chained Node commands** (`&&`-separated, no named groups). Any one failure truncates the remainder. | **Partial** |
| 5 | All scripts under `scripts/`, `apps/*/scripts/`, `docker/scripts/` are referenced from docs or CI. | `scripts/build-catalog.ts` → `catalog.yaml:2`; `scripts/verify-hub-apps.mjs` → **not referenced from any doc**; `apps/server/scripts/copy-assets.mjs` → `apps/server/package.json "build"`; `docker/scripts/floom-backup.sh` → `docs/SELF_HOST.md:823`, `docs/extended-audit/ax-11-data-lifecycle.md:64,128,142`; `apps/server/scripts/audit-2026-04-18-renderer-test-desc.sh` → **not referenced from any doc or CI**, single-use. | **Drift** |
| 6 | Playwright hub-smoke CI is wired with a clear skip path for missing secrets. | `.github/workflows/hub-smoke.yml:49,69–72` — full-hub job only runs on schedule/dispatch; secrets `HUB_SMOKE_E2E_EMAIL`/`HUB_SMOKE_E2E_PASSWORD` gate the authenticated test (echoes "Skipping full hub" if absent). | **Met** |
| 7 | Image build workflow publishes to the image repo `docker-compose.yml` pins. | `publish-image.yml:43` → `ghcr.io/floomhq/floom-monorepo`. `docker/docker-compose.yml:15` → `ghcr.io/floomhq/floom:v0.3.0`. **Different image repositories**. See rh-03 R1. | **Contradicted** |
| 8 | `packages/cli build` produces a runnable CLI. | `packages/cli/package.json "build"` is literally `echo 'CLI build requires compiled deps — skipping for monorepo build. Use pnpm publish flow.'`. **No-op build** — intentional, documented in-line. | **Partial (intentional)** |
| 9 | Every package with `"test"` actually runs tests. | `packages/detect "test": "echo '@floom/detect: no tests yet' && exit 0"`; `packages/manifest` identical; `packages/renderer "test": "echo ... && exit 0"` (tests live in `test/stress/`); `packages/runtime` runs real tests via `tsx --test tests/{detect,provider}/*.test.ts`. | **Partial** |
| 10 | Deploy workflow waits on CI green before shipping to preview. | `deploy-preview.yml:24–43` uses `lewagon/wait-on-check-action@v1.3.4` against `Typecheck` and `Test` checks before SSH deploy. Good hygiene. | **Met** |

---

## Concrete findings

### Root scripts

```
"scripts": {
  "build": "turbo build",
  "dev": "turbo dev",
  "typecheck": "turbo typecheck",
  "test": "turbo test",
  "test:hub-smoke": "pnpm --filter @floom/hub-smoke test:fast",
  "lint": "turbo lint"
}
```

- `lint` — **no-op** (rh-01 finding 9).
- `test:hub-smoke` — bypasses turbo to run only `@floom/hub-smoke`'s
  `test:fast` (the fast-apps.spec.ts variant). Deliberate shortcut;
  full Playwright matrix is not wired to any root script, only to
  `hub-smoke.yml` on schedule/dispatch.
- `pnpm overrides` sets `tar-fs` ≥ 2.1.4 — remediation for
  CVE-2024-12905 (transitive dep). Not a script but worth noting in
  hygiene context.

### `apps/server/package.json`

- `dev`: `tsx watch --env-file=../../.env src/index.ts`. Expects
  repo-root `.env` (not in git — see `docker/.env.example` for
  template).
- `build`: `tsc && node scripts/copy-assets.mjs`. Correct two-step.
- `start`: `node dist/index.js`. Standard.
- `typecheck`: `tsc --noEmit`. Standard.
- `test`: **single line, 4 800 characters, 61 `&&`-chained commands**.
  Direct quote (excerpt):

  ```
  "test": "pnpm run build && node ../../test/stress/test-build-url.mjs && \
           node ../../test/stress/test-resolve-base-url.mjs && ... && \
           node ../../test/stress/test-triggers-live.mjs"
  ```

  Each chained step invokes one of 54 `test-*.mjs` stress tests from
  `test/stress/`. The failure mode is "first failure halts all
  subsequent tests" with no grouping/parallelism. See rh-06 for the
  test surface vs execution gap.

### `apps/web/package.json`

- `dev`: `vite`.
- `build`: `tsc --noEmit && vite build`. Type-checks before bundling.
- `preview`: `vite preview`.
- `typecheck`: `tsc --noEmit`.

Clean. No dead scripts.

### `packages/*/package.json`

| Package | `build` | `test` | Notes |
|---------|---------|--------|-------|
| `packages/cli` | `echo '… skipping for monorepo build. Use pnpm publish flow.'` | (none) | **No-op build on purpose**, documented inline |
| `packages/detect` | (none) | `echo '@floom/detect: no tests yet' && exit 0` | no-test |
| `packages/manifest` | (none) | same echo | no-test |
| `packages/renderer` | (none) | `echo '@floom/renderer: driven by test/stress/test-renderer-defaults.mjs + test-renderer-contract.mjs + test-renderer-bundler.mjs' && exit 0` | Tests moved to `test/stress/` but package still lists an echo — this is the right pointer, just confusing to new contributors |
| `packages/runtime` | (none) | `tsx --test tests/detect/*.test.ts tests/provider/*.test.ts` | Real tests |
| `packages/hub-smoke` | (none) | `test:all`, `test:fast`, `test:full`, `install:browsers` | Playwright scripts; not invoked by `pnpm test` (turbo) |

### `scripts/` (monorepo root)

- **`scripts/build-catalog.ts`** (507 lines). Purpose per doc header:
  *"Build a Floom app catalog from the APIs-guru OpenAPI directory …
  verifies each candidate end-to-end by calling `POST /api/hub/detect`
  on a live Floom instance"*. Usage examples included
  (`build-catalog.ts:11–16`). Output written to `catalog.yaml`. The
  existing `catalog.yaml:2` confirms *"Generated by
  scripts/build-catalog.ts"*. **Active, discoverable.**
- **`scripts/verify-hub-apps.mjs`** (334 lines). Purpose per doc
  header: *"Rescue Fix #1 (2026-04-21): probe every live hub app
  end-to-end"*. Writes `/tmp/hub-verify-report.json`. Usage: envs
  `BASE`, `COOKIE`, `CONCURRENCY`, `PROBE_TIMEOUT_MS`,
  `POLL_TIMEOUT_MS`, `REPORT_PATH`. **No doc references**; clearly an
  ops-only utility script. Worth a README or a line in `docs/SELF_HOST.md`
  to make it discoverable.
- **`scripts/package.json`** — declares `@floom/scripts`, `"private":
  true`, `"type": "module"`. No scripts defined; exists purely so
  pnpm workspace resolves `scripts/` without including its
  dependencies twice.

### `apps/server/scripts/`

- **`copy-assets.mjs`** (29 lines). Called by `apps/server/package.json
  "build"`. Active.
- **`audit-2026-04-18-renderer-test-desc.sh`** (42 lines). One-shot
  SQLite UPDATE on row `slug = 'my-renderer-test'`. Idempotent
  (filters `description LIKE '%Pet Store Server%'`). **No CI or doc
  reference**. Dated filename; clearly meant to run once, in prod, on
  2026-04-18. Past that window it is **dead code**.

### `docker/scripts/`

- **`floom-backup.sh`** (42 lines). Referenced in `docs/SELF_HOST.md:823–828`
  (install path + cron example) and `docs/extended-audit/ax-11-data-lifecycle.md:64,128,142`.
  **Active, documented.**

### `.github/workflows/`

| File | Triggers | Jobs | Evidence |
|------|----------|------|----------|
| `ci.yml` | push `main`, PR → `main` | `Typecheck`, `Test` | `ci.yml:3–34` — uses pnpm + Node 20 |
| `deploy-preview.yml` | push `main`, `workflow_dispatch` | `wait-for-ci` → `deploy` (SSH to AX41) | `deploy-preview.yml:11–61` — serializes via `concurrency: deploy-preview`, cancel-in-progress false |
| `hub-smoke.yml` | `workflow_dispatch`, `schedule '0 7 * * *'`, PR on `packages/hub-smoke`/`apps/web` paths | `fast-apps` (anon), `full-hub` (auth, schedule-only) | `hub-smoke.yml:5–13,49,69–72` — documented skip when secrets absent |
| `publish-image.yml` | tag `v*`, `workflow_dispatch` | `build-and-push` (buildx, amd64+arm64, ghcr) | `publish-image.yml:3–59` — explicit comment (`:37–42`) that image stays on `floom-monorepo` repo name until packages are migrated |

All four workflows are active. None invoke the no-op `pnpm lint`.

### Dead / one-shot

Only one source-tree script qualifies as **dead**:

- `apps/server/scripts/audit-2026-04-18-renderer-test-desc.sh` — dated
  filename, single-row DB patch, idempotent, 0 callers. Safest move is
  to relocate under `docs/internal/stash-archive-*/` (the existing
  archive folder for one-shot artifacts) or delete outright.

### Undocumented but live

- `scripts/verify-hub-apps.mjs` — 334 lines, actively useful, zero
  doc discoverability.
- `apps/server/scripts/copy-assets.mjs` — referenced only from
  `apps/server/package.json`; fine for build-only helpers.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| R1 | P1 | **Mega-`test` chain in `apps/server/package.json`** — one failure kills all subsequent tests; stderr is interleaved; no grouping; no ability to run a subgroup in CI. | `apps/server/package.json "test"` (61 chained commands) |
| R2 | P1 | **`scripts/verify-hub-apps.mjs` is a live ops tool with no doc entry** — new on-calls won't find it. | `scripts/verify-hub-apps.mjs`; no refs in `docs/` |
| R3 | P2 | **`apps/server/scripts/audit-2026-04-18-renderer-test-desc.sh` is a dated one-shot** still sitting in the server scripts folder. | file header |
| R4 | P2 | **Image-repo drift** — `publish-image.yml:43` pushes to `floom-monorepo`, `docker-compose.yml:15` pulls from `floom`. Same drift surfaces in rh-03 R1. | `publish-image.yml:43`; `docker-compose.yml:15` |
| R5 | P2 | **`pnpm lint` is a ghost** — `package.json "lint": "turbo lint"` + `turbo.json "lint": {}` + zero ESLint config anywhere. New contributors think lint is green when no lint ran. | `package.json`, `turbo.json`, no `.eslintrc*` |
| R6 | P2 | **`packages/renderer "test"`** is an echo-only pointer; new contributors will think the package has no tests and miss that coverage lives in `test/stress/`. | `packages/renderer/package.json "test"` |
| R7 | P2 | **`packages/cli "build"` is an echo-skip** — intentional, but makes `pnpm build` silently useless for the CLI at the workspace root. | `packages/cli/package.json "build"` |

---

## Open PM questions

1. **`apps/server` test script**: do we split into logical groups
   (`test:core`, `test:renderer`, `test:w21`, `test:w23`, …) and
   update `.github/workflows/ci.yml` to run them in parallel jobs, or
   accept the monolithic chain as a known cost? (`apps/server/package.json "test"`)
2. **`verify-hub-apps.mjs`**: is this a runbook tool (document it in
   `docs/SELF_HOST.md`) or an internal rescue artifact (move under
   `docs/internal/stash-archive-*/` alongside other one-shots)?
   (`scripts/verify-hub-apps.mjs`)
3. **`audit-2026-04-18-renderer-test-desc.sh`**: delete, or
   archive with a README explaining the pattern (dated one-shot DB
   migrations) for future incidents?
4. **Image repository**: rename `floom-monorepo` → `floom` and migrate
   packages, or collapse all docs + compose onto `floom-monorepo`
   until the migration happens? (`publish-image.yml:37–42`,
   `docker-compose.yml:15`)
5. **`pnpm lint`**: wire a real ESLint pass in `ci.yml` or delete the
   `"lint"` hooks from `package.json` and `turbo.json`?
   (`package.json`, `turbo.json`)
6. **`packages/{cli,detect,manifest,renderer}` no-op scripts**:
   replace the echo placeholders with actual build / test entries
   (even if they delegate to `test/stress/` for the renderer case),
   or rename to `test:none` so CI doesn't count them as "tests
   passed"?
