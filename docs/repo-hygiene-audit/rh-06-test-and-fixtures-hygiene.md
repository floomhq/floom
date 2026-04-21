# rh-06 — Test and fixtures hygiene

**Audit type:** Repo-hygiene (read-only, no code changes).
**Source of truth:** `test/stress/*.mjs`, `apps/*/test*`,
`packages/*/test*`, every `package.json` `"test"` script,
`.github/workflows/*.yml`, `docs/PRODUCT.md` (surfaces that must be
tested).
**Repo snapshot:** branch `docs/hygiene-and-docs-audit-2026-04-20`,
based on `origin/main d62a4cf` (2026-04-20).

## Executive summary

The test strategy is **stress-test driven**: 62 `.mjs` files under
`test/stress/` totalling **15 859 lines**, invoked via one giant
sequential `apps/server` test script (56 `&&`-chained steps, 2 835
characters, `apps/server/package.json:11`). There are **no unit
tests in `apps/web`** — the entire React surface has zero automated
coverage under `pnpm test`. `packages/cli`, `packages/detect`,
`packages/manifest` have placeholder `echo … && exit 0` test scripts
or none at all; all three are load-bearing per
`docs/PRODUCT.md`.

Good news:

- **No `.only` / `.skip` / `xit` / `xdescribe` usage** anywhere
  (`rg "\.only\(|\.skip\(|xit\(|xdescribe\(" test/ apps/ packages/` = 0).
- `packages/runtime` has real `tsx --test` unit tests for detect +
  provider (7 files).
- `packages/hub-smoke` has a Playwright smoke that runs against
  `preview.floom.dev` / `floom.dev`.

Bad news:

- **7 stress tests exist on disk but are not wired into the
  `apps/server` test script** (so `pnpm test` silently skips them).
  Three of them — `test-security-headers.mjs`, `test-run-auth.mjs`,
  `test-rate-limit-xff.mjs` — guard P0 product surfaces.
- **`apps/web` has no `"test"` script** — nothing runs on UI change
  beyond `tsc --noEmit` and Vite build.
- `packages/runtime/tests/opendraft-e2e.log` is a 16 KB log file
  checked in next to the real tests (also flagged in rh-05 F8).

---

## Executive truth table

| # | Expectation (evidence) | Reality (evidence) | Verdict |
|---|------------------------|--------------------|---------|
| 1 | Every product surface listed in `docs/PRODUCT.md` (web form, MCP, HTTP, the three ingest modes, the run path) has test coverage runnable via `pnpm test`. | Web form — **zero** tests (`apps/web` has no `"test"` script, `apps/web/package.json:6–11`). MCP — covered (`test-mcp-admin.mjs`, `test-mcp-action-secrets.mjs`, `test-mcp-session-context.mjs`). HTTP — covered (run, hub, auth, rate-limit tests). Ingest — covered (`test-ingest-security.mjs`, `test-publish-flow-fixes.mjs`). | **Partial** |
| 2 | Tests on disk under `test/stress/` are all wired into the server test script. | 62 `.mjs` files on disk; only 55 unique files referenced in `apps/server/package.json:11`. **7 tests unreferenced**: `test-hub-fixtures.mjs`, `test-ingest-stress.mjs`, `test-public-permalinks.mjs`, `test-rate-limit-xff.mjs`, `test-run-auth.mjs`, `test-security-headers.mjs`, `test-user-delete-cascade.mjs`. | **Drift** |
| 3 | Load-bearing packages per `docs/PRODUCT.md` (`packages/runtime`, `packages/detect`, `packages/manifest`, `packages/cli`) have at least minimal automated tests. | `packages/runtime` — real tests (`packages/runtime/tests/detect/*.test.ts` × 6, `packages/runtime/tests/provider/ax41-docker.test.ts`). `packages/detect` — `"test": "echo '@floom/detect: no tests yet' && exit 0"` (`packages/detect/package.json:7`). `packages/manifest` — `"test": "echo '@floom/manifest: no tests yet' && exit 0"` (`packages/manifest/package.json:7`). `packages/cli` — **no `"test"` script** (`packages/cli/package.json:6–11`). | **Partial** |
| 4 | No disabled tests (`.only`, `.skip`, `xit`, `xdescribe`) on `main`. | `rg "\.only\(\|\.skip\(\|xit\(\|xdescribe\(" test/ apps/ packages/` returns 0 matches. | **Met** |
| 5 | CI must run the same `pnpm test` as a developer. | `.github/workflows/ci.yml` / equivalent runs `pnpm test` (inferred from `deploy-preview.yml` gating on Test + Typecheck; reviewers should confirm). No workflow bypasses tests on `main`. | **Met** (confirm in CI audit) |
| 6 | The server test script should be parallelizable or split so a single flaky test does not fail the whole matrix. | Sequential single-line 56-step chain (`apps/server/package.json:11`, 2 835 chars). Prior flake on `test-triggers-*` required a full re-run. | **Drift** |
| 7 | Renderer P0 differentiator (per `docs/PRODUCT.md`) should be heavily tested. | 8 renderer tests: `test-renderer-bundler.mjs`, `test-renderer-contract.mjs`, `test-renderer-defaults.mjs`, `test-renderer-e2e.mjs`, `test-renderer-sandbox.mjs`, `test-renderer-cascade.mjs`, `test-renderer-slug-safety.mjs`, `test-renderer-entry-path-safety.mjs` — all wired in. | **Met** |
| 8 | Fixtures should be reusable and centralised. | `packages/hub-smoke/tests/fixtures.ts` (shared Playwright fixtures — good). `test/stress/test-hub-fixtures.mjs` appears to define hub-level fixtures but is **not wired into `pnpm test`** (see row 2). | **Partial** |
| 9 | No stray artifacts in test directories. | `packages/runtime/tests/opendraft-e2e.log` (16 357 bytes, 2026-04-13) is a checked-in log next to real `.test.ts` files. | **Drift** |
| 10 | `test:hub-smoke` path from root is discoverable for CI and operators. | Root `package.json:11` exposes `"test:hub-smoke": "pnpm --filter @floom/hub-smoke test:fast"`. Documented in `docs/SELF_HOST.md` (check da-02). Works. | **Met** |

---

## Concrete findings

### Test inventory (`d62a4cf`)

```text
Total test files on disk:
  test/stress/*.mjs                          62  (15 859 lines)
  packages/runtime/tests/detect/*.test.ts     6
  packages/runtime/tests/provider/*.test.ts   1
  packages/hub-smoke/tests/*.spec.ts          2  (+ fixtures.ts)
  apps/web                                    0
  apps/server (separate dir)                  0  (all suites live in test/stress/)
  packages/cli                                0
  packages/detect                             0
  packages/manifest                           0
  packages/renderer                           0
```

Total wired-into-`pnpm test`: **55 of 62 stress tests + 7
`tsx --test` files in `packages/runtime/tests/`**. The 7 unwired
stress tests are F1 below.

### F1. Seven stress tests exist on disk but are not wired

Computed by diffing filenames in `ls test/stress/*.mjs` against
every `test-*.mjs` reference in `apps/server/package.json:11`:

```
test-hub-fixtures.mjs          (fixture generator, may be a helper not a test)
test-ingest-stress.mjs          (stress variant of ingest)
test-public-permalinks.mjs      (public run permalinks)
test-rate-limit-xff.mjs         (X-Forwarded-For handling in rate limits)  ← P0 per docs/ROADMAP.md
test-run-auth.mjs               (auth on /api/:slug/run)                    ← P0
test-security-headers.mjs       (CSP / HSTS / frame-ancestors etc.)         ← P0
test-user-delete-cascade.mjs    (GDPR delete / cascade)                     ← P0/P1
```

All seven files exist (`ls test/stress/test-*.mjs`). They are not
referenced by any `package.json` test script, any
`.github/workflows/*.yml`, or any `README`. Either they were
introduced before being wired, or they were dropped from the script
during a merge conflict and never restored.

**Decision for each:** either add to the `apps/server` test chain,
convert into an explicit opt-in (`test:security`, `test:stress`)
that runs in a separate CI job, or delete.

### F2. `apps/web` has no test script

`apps/web/package.json:6–11`:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview",
  "typecheck": "tsc --noEmit"
}
```

No `"test"` key. `turbo test` (root `package.json:10`) therefore
skips `apps/web` entirely. Zero UI unit tests, zero UI integration
tests inside `apps/web/`. The only coverage the web surface gets is:

- `packages/hub-smoke/tests/hub-full.spec.ts` — end-to-end
  Playwright, runs against a deployed instance, not a unit test.
- `tsc --noEmit` as part of `build` — typecheck only, not runtime
  behaviour.

Given `apps/web` now contains the primary ICP flow (hub, `/me`,
studio, run surface), the gap is significant.

### F3. `packages/cli`, `packages/detect`, `packages/manifest` are test-less

Placeholder scripts:

- `packages/detect/package.json:12` — `"test": "echo '@floom/detect: no tests yet' && exit 0"`
- `packages/manifest/package.json:12` — `"test": "echo '@floom/manifest: no tests yet' && exit 0"`
- `packages/cli/package.json:8–12` — **no `"test"` script at all**
  (scripts block contains only `build` (which is itself a skip-echo),
  `dev`, `typecheck`).

All three are on `docs/PRODUCT.md`'s load-bearing list ("repo →
hosted" pillar). The only package in that pillar with real tests is
`packages/runtime`, and even there the tests exercise detection +
the Docker provider — not the deploy orchestration.

### F4. `apps/server` test script is a single 2 835-char chain

`apps/server/package.json:11` is one `&&`-chained line:

```
pnpm run build && node ../../test/stress/test-build-url.mjs && ... (55 more)
```

Consequences:

- Any flake in step N fails steps N+1..56, losing their signal.
- No partition by theme (auth / renderer / mcp / stripe) — operators
  and CI see one giant pass/fail.
- Estimated wall time is high (most stress tests do their own HTTP
  setup/teardown).
- The 56-step chain has to be updated by hand every time a new test
  lands, which is why rebase conflicts in this file have been common
  (see merge history: PRs #221, #226, #213, #214 all touched it).

Mitigation idea (audit only, not a fix): introduce
`test:server:auth`, `test:server:renderer`, `test:server:mcp`, etc.,
driven by glob or by a small runner, so CI can shard and so adding
a test stays a 1-line list append instead of a 1-line chain append.

### F5. Long tails in `test/stress/`

Top 10 by size (`wc -l test/stress/*.mjs | sort -nr`):

| Lines | File |
|---|---|
| 649 | `test-mcp-admin.mjs` |
| 527 | `test-w33-stripe-service.mjs` |
| 444 | `test-w31-auth-boundary.mjs` |
| 443 | `test-w33-stripe-routes.mjs` |
| 443 | `test-ingest-security.mjs` |
| 414 | `test-renderer-cascade.mjs` |
| 407 | `test-w31-workspaces-service.mjs` |
| 407 | `test-renderer-contract.mjs` |
| 388 | `test-app-creator-secrets.mjs` |
| 373 | `test-hub-runs-auth.mjs` |

The size itself is not a problem — stress tests correctly bundle
setup, many assertions, and teardown. Worth flagging for
maintenance: the top five are >400 lines each and do not share a
common test harness beyond `node:test`. Extracting a shared
`test/stress/_harness.mjs` (DB init, server boot, auth setup) would
cut repeated setup code across suites.

### F6. `node_modules/.bin/tsc` vs `tsx` usage is inconsistent

The server test script mixes `node` and `tsx` invocations:

- `node ../../test/stress/test-build-url.mjs` — pure JS/mjs.
- `tsx ../../test/stress/test-manifest-validate-inputs.mjs` — uses
  TypeScript.
- `node --experimental-test-module-mocks --test ../../test/stress/test-mcp-session-context.mjs`
  — uses Node's test runner with module mocks flag.

This is not a bug (each invocation is intentional for that test's
needs), but it means a new contributor adding a test has to guess
which flavour. A short comment block above the test script or a
`README` in `test/stress/` listing the three conventions would
help — nothing exists today (`ls test/stress/README*` returns
none).

### F7. `packages/runtime/tests/` — real unit tests present

`packages/runtime/package.json:15`:
`"test": "tsx --test tests/detect/*.test.ts tests/provider/*.test.ts"`.

Files (`ls packages/runtime/tests/`):

```
tests/detect/php-ext.test.ts        (1 809 bytes)
tests/detect/pnpm-detect.test.ts    (2 173 bytes)
tests/detect/rules.test.ts          (4 332 bytes)
tests/detect/src-layout.test.ts     (1 438 bytes)
tests/detect/uv-detect.test.ts      (1 401 bytes)
tests/detect/workdir.test.ts        (2 115 bytes)
tests/provider/ax41-docker.test.ts  (4 359 bytes)
```

All use `tsx --test` (Node's built-in test runner via tsx shim).
Average ~2 KB each. Good discipline. Covers detection rules and one
provider; does not cover `packages/runtime/src/deploy.ts` (the
orchestration entry point used by "repo → hosted").

### F8. Stray artifact: `packages/runtime/tests/opendraft-e2e.log`

File: `packages/runtime/tests/opendraft-e2e.log`, 16 357 bytes,
dated 2026-04-13.

First lines:
```
=== OpenDraft e2e via new runtime ===
timestamp: 2026-04-13T13:53:21.575Z

[phase1] deployFromGithub federicodeponte/opendraft
Collecting anthropic<1.0.0,>=0.20.0 (from -r requirements.txt (line 6))
```

A log dump from a manual e2e run against the `opendraft` repo,
committed into `tests/` by accident. Not a test. `.gitignore`
additions recommended:
`packages/runtime/tests/*.log`, `packages/runtime/tests/**/*.log`.

### F9. Hub-smoke separation is deliberate

`packages/hub-smoke/package.json:6–11` defines `test:all`,
`test:fast`, `test:full` (Playwright) but no `"test"` key, so
`turbo test` skips it. Root aliases it as `test:hub-smoke`. This is
intentional — Playwright needs a running hub URL — but because
`turbo test` reports green without running it, CI or operators could
mistake "tests passed" for "hub-smoke passed". Calling it out here
so the distinction stays explicit in any dashboarding.

### F10. Route coverage presence check (grep, not real coverage)

Rough `rg -l <route> test/stress/` per route under
`apps/server/src/routes/`:

```
connections       10 test files mention it
deploy-waitlist    0                                   ← no test mentions
feedback           3
og                62                                   (string overlap with 'og' inside many files)
parse             25
pick               5
reviews            4
thread             7
workspaces        16
memory            12
```

`deploy-waitlist` (`apps/server/src/routes/deploy-waitlist.ts`) has
no test file that references it. It is a low-traffic route (waitlist
for hosted deploys), but the absence is notable given the route is
on the "repo → hosted" path.

`og` (the 62 count) is noise — the literal substring `og` appears
inside many test fixtures. Ignore.

This is a presence check, not a coverage check. A real coverage
tool (`c8`, `v8-coverage`) would give better numbers; none is wired
in today.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| T1 | P0 | Seven stress tests on disk are not wired, three of which cover launch-blocking concerns (security headers, run-path auth, X-Forwarded-For rate-limit bypass). A regression lands silently. | `apps/server/package.json:11` vs `ls test/stress/*.mjs`; see F1 list |
| T2 | P1 | `apps/web` has zero automated test coverage. Any UI-level regression only surfaces via Playwright smoke (which runs against a deployed preview, after merge). | `apps/web/package.json:6–11` |
| T3 | P1 | `packages/cli` has no tests; it is the operator-facing entry for the "repo → hosted" pillar per `docs/PRODUCT.md`. | `packages/cli/package.json` + load-bearing list |
| T4 | P1 | `packages/detect` + `packages/manifest` use placeholder `echo … exit 0` as their test script, giving green CI signal for untested load-bearing code. | `packages/detect/package.json:12`, `packages/manifest/package.json:12` |
| T5 | P2 | Sequential `&&`-chain test script: first flake blocks the rest, contributors must manually append to a 2 835-char line, common source of merge conflicts. | `apps/server/package.json:11` (see git history: PRs #221, #226, #213, #214 conflict in this field) |
| T6 | P2 | `deploy-waitlist` route has no test presence. Low traffic, but on the "repo → hosted" pillar. | rg of `test/stress/` for `deploy-waitlist` |
| T7 | P2 | Stray `opendraft-e2e.log` in `packages/runtime/tests/`; future `pnpm publish` for `@floom/runtime` would ship it. | `packages/runtime/tests/opendraft-e2e.log` |
| T8 | P2 | No shared test harness across 62 stress tests; setup code duplicated, maintenance tax rises with every new suite. | F5 table |

---

## Open PM questions

1. **The seven unwired tests — wire, move to an opt-in job, or
   delete?** Default stance: wire the three security-related
   (`test-security-headers`, `test-run-auth`, `test-rate-limit-xff`)
   and `test-user-delete-cascade` immediately; move
   `test-ingest-stress` + `test-public-permalinks` to a nightly job;
   keep `test-hub-fixtures` as a helper if confirmed not-a-test.
2. **`apps/web` tests — Vitest / RTL per-component, or rely on
   Playwright smoke + typecheck?** The product has non-trivial
   state (sessions, secrets flow, run UI) that typecheck alone
   cannot catch.
3. **`packages/cli` / `detect` / `manifest` tests — accept the gap
   because they are thin wrappers, or ship minimum smoke tests
   before hosting is in GA?**
4. **Keep the monolithic `apps/server` test chain, or partition it?**
   Partition wins long-term, but has a one-time migration cost.
5. **Ship an actual coverage tool (`c8`) or stay with presence
   checks?** A single number lets you track drift over time.
6. **`.gitignore` `**/tests/*.log`** so logs stop riding to `main`?
