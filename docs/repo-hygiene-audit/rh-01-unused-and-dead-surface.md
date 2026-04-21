# rh-01 — Unused and dead surface

**Audit type:** Repo-hygiene (read-only, no code changes).
**Source of truth:** `docs/PRODUCT.md` (load-bearing paths),
`docs/ROADMAP.md` (shipped vs deferred), `docs/DEFERRED-UI.md`.
**Repo snapshot:** branch `docs/hygiene-and-docs-audit-2026-04-20`,
based on `origin/main d62a4cf` (2026-04-20).

## Executive summary

Most apparently-dead surface is **legacy-by-design**: `BuildPage.tsx`,
`CreatorPage.tsx`, and `CreatorAppPage.tsx` are still shipped behind
underscore-prefixed routes (`/_build-legacy`, `/_creator-legacy`) as
safety valves while `/studio/*` becomes the primary path — deleting them
today would regress tooling reachability. The real dead surface sits in
**small components never re-imported** after wireframe rewrites
(`TrustStrip.tsx`, `PromptBox.tsx`, `AppSuggestionCard.tsx`), in
**web→server client helpers** that back protocol-level routes nothing in
the UI calls (`pickApps`, `parsePrompt`, `createThread`, `saveTurn`),
and in **declarative-only interface files** (`apps/server/src/adapters/types.ts`
— a 460-line DTO file explicitly flagged "DECLARATIONS ONLY" at the top).
A no-op `turbo lint` target with zero ESLint config is the largest
invisible dead surface outside the runtime.

---

## Executive truth table

| # | Expectation (evidence) | Reality (evidence) | Verdict |
|---|------------------------|--------------------|---------|
| 1 | Load-bearing runtime packages kept, per `AGENTS.md`: *"If your proposed deletion touches a path on that list, stop and ask the owner."* (`AGENTS.md:9`) and `docs/PRODUCT.md` load-bearing list incl. `packages/runtime`, `packages/detect`, `packages/manifest`. | All four packages present: `packages/runtime/src/provider/ax41-docker.ts`, `packages/detect/src/index.ts`, `packages/manifest/src/normalize.ts`, `packages/cli/src/index.ts`. | **Met** |
| 2 | Legacy `/build` page rewritten into `/studio/build`, per `apps/web/src/main.tsx:199`: `<Route path="/studio/build" element={<StudioBuildPage />} />`. Expect old `BuildPage.tsx` (2 084 lines) to be removed or clearly sunset. | Still imported (`main.tsx:31`) and mounted behind `/_build-legacy` (`main.tsx:216`). No sunset date, no PRODUCT.md callout. | **Partial** (kept intentionally, undocumented) |
| 3 | `POST /api/pick`, `POST /api/parse`, `POST /api/thread` remain part of the advertised HTTP protocol per `apps/web/src/assets/protocol.md:81–87` and server wiring `apps/server/src/index.ts:172–174`. | Routes mounted and exported, but **no `.tsx` component** imports `pickApps` / `parsePrompt` / `createThread` / `saveTurn` helpers from `apps/web/src/api/client.ts:94,101,424,428`. | **Drift** (server surface alive, web helpers dead) |
| 4 | `docs/DEFERRED-UI.md` lists UI features whose backend is shipped. Expect it to match the current tree. | `docs/DEFERRED-UI.md` still claims no async jobs UI on `main`, yet `apps/web/src/components/runner/JobProgress.tsx` + `RunSurface.tsx` ship it — already flagged in `docs/product-audit/deep/pd-19-roadmap-p0-execution-gap.md:17`. | **Contradicted** |
| 5 | Interface/adapter surfaces referenced by `spec/adapters.md` should be exercised by real code. | `apps/server/src/adapters/types.ts:12` declares itself *"DECLARATIONS ONLY. The existing services don't implement these interfaces explicitly yet"*. Zero imports repo-wide (only the file itself matches `RuntimeAdapter`). | **Partial** (intentional placeholder, unused code weight) |
| 6 | `pnpm lint` should either run a real linter or be removed. `package.json:"lint": "turbo lint"` + `turbo.json:"lint": {}`. | No `lint` script in any `apps/*/package.json` or `packages/*/package.json`; no `.eslintrc*` / `eslint.config.*` at any level. `turbo lint` is a no-op. | **Contradicted** |
| 7 | Trust / prompt UI components are only useful if rendered. | `apps/web/src/components/TrustStrip.tsx` (51 lines), `PromptBox.tsx` (79 lines), `components/runner/AppSuggestionCard.tsx` (80 lines) are defined but never imported (no matching `import .* from '.*(TrustStrip|PromptBox|AppSuggestionCard)'` in `apps/web/src`). | **Missing** (dead UI) |
| 8 | Feature-flag env vars referenced in code should be discoverable in operator docs. | `FLOOM_STORE_HIDE_SLUGS` referenced at `apps/server/src/routes/hub.ts:480,495,547,603` and documented in `docs/SELF_HOST.md:64`, but absent from `docker/.env.example` and `docker/docker-compose.yml`. See rh-03 for full table. | **Drift** |
| 9 | `packages/cli` surface still shipped — load-bearing per PRODUCT.md's "Repo → hosted" pillar. | Package present at `packages/cli/src/index.ts`; no active dependents under `apps/*` or `packages/*` beyond its own exports. **load-bearing per PRODUCT.md — keep**. | **Met (tagged)** |
| 10 | Underscore legacy routes should have either a sunset date or a redirect. | `apps/web/src/main.tsx:214–216` mount `/_creator-legacy`, `/_creator-legacy/:slug`, `/_build-legacy` with no SSR title and no PRODUCT.md entry. Pages they mount total **2 974 lines** (BuildPage 2 084 + CreatorPage 468 + CreatorAppPage 422). | **Partial** (kept for tooling; no owner, no expiry) |

---

## Concrete findings

Evidence paths are `file:line` (tool-based search). "References" are
counted via `rg "\b<name>\b"` across `apps/` and `packages/`.

### Web: components with zero imports

1. **`apps/web/src/components/TrustStrip.tsx`** (51 lines) — defines and
   exports `TrustStrip`; `rg "TrustStrip" apps/` returns only the file
   itself (one hit). No `import ... TrustStrip ...` anywhere. Likely a
   wireframe experiment that lost its caller when the landing page was
   reshuffled.
2. **`apps/web/src/components/PromptBox.tsx`** (79 lines) — same pattern:
   single self-hit. Overlaps conceptually with `HeroPromptInput` /
   `AppCard` combinations used in `CreatorHeroPage.tsx`, so **no
   functional loss if removed**.
3. **`apps/web/src/components/runner/AppSuggestionCard.tsx`** (80 lines)
   — zero imports; its intended consumer was the old prompt flow backed
   by `/api/pick` (see finding 4).

### Web → server client helpers with no UI caller

4. `apps/web/src/api/client.ts` exports four helpers with **no `.tsx`
   consumer**:
   - `pickApps(...)` (`client.ts:94`) — wraps `POST /api/pick`.
   - `parsePrompt(...)` (`client.ts:101`) — wraps `POST /api/parse`.
   - `createThread()` (`client.ts:424`) — wraps `POST /api/thread`.
   - `saveTurn(...)` (`client.ts:428`) — wraps `POST /api/thread/:id/turn`.

   Server routes are wired (`apps/server/src/index.ts:172–174`,
   `routes/parse.ts`, `routes/pick.ts`, `routes/thread.ts`) and
   explicitly advertised in the protocol doc (`apps/web/src/assets/protocol.md:81–87`).
   Server-side `pickApps` service logic is **also** reused by
   `routes/mcp.ts` (`list_apps` tool), so the **HTTP surface must stay**;
   the dead surface is the **web client layer**.

### Pages behind legacy routes — kept for tooling, not linked

5. `apps/web/src/main.tsx:214` mounts `<Route path="/_creator-legacy" element={<CreatorPage />} />`,
   `main.tsx:215` mounts `<Route path="/_creator-legacy/:slug" element={<CreatorAppPage />} />`,
   `main.tsx:216` mounts `<Route path="/_build-legacy" element={<BuildPage />} />`.
   These legacy routes **are not referenced** in `docs/*`, `README*`, or
   any sitemap / nav component. Intent appears to be "keep old flows
   reachable for QA"; there is no written sunset clause.

### Server: declaration-only adapters

6. `apps/server/src/adapters/types.ts:12` — *"IMPORTANT: these are
   DECLARATIONS ONLY. The existing services don't implement these
   interfaces explicitly yet"*. 460 lines of `RuntimeAdapter`,
   `StorageAdapter`, `AuthAdapter`, `SecretsAdapter`, `ObservabilityAdapter`
   types that no file in `apps/server/src` imports. Deliberate Stage-2
   protocol work (per `spec/adapters.md`), but easy to mistake for
   shipped abstraction.

### Docs contradictions

7. `docs/DEFERRED-UI.md` §1 still reads "no jobs UI on `main`" — the
   tree contradicts this at `apps/web/src/components/runner/JobProgress.tsx`
   and `apps/web/src/components/runner/RunSurface.tsx`
   (see `docs/product-audit/deep/pd-19-roadmap-p0-execution-gap.md:17`).
8. `docs/ROADMAP.md` still marks **Custom renderer upload** as *UI in
   flight* despite `apps/web/src/components/CustomRendererPanel.tsx`
   being wired into `BuildPage.tsx` (post-publish block), `CreatorAppPage.tsx`,
   and `apps/web/src/pages/StudioAppRendererPage.tsx`
   (`docs/product-audit/deep/pd-19-roadmap-p0-execution-gap.md:18`).

### Lint pipeline is nominal-only

9. `package.json` root declares `"lint": "turbo lint"` and
   `turbo.json` declares a `lint` task, but **no workspace package
   defines a `lint` script** and there is **no ESLint configuration
   file** anywhere in the repo (`ls .eslintrc* eslint.config.*` returns
   "no matches"). `pnpm lint` exits 0 with zero work done — the
   "hygiene" surface is a ghost. Relevant to
   `docs/product-audit/deep/pd-20-docs-protocol-product.md` narrative.

### Env flags referenced but undocumented

10. **`FLOOM_STORE_HIDE_SLUGS`** — read in `apps/server/src/routes/hub.ts:495`
    and documented in `docs/SELF_HOST.md:64`, but missing from
    `docker/.env.example` and `docker/docker-compose.yml`. An operator
    cannot discover it from the self-host quickstart alone. Full table
    in **rh-03**.
11. **`FLOOM_TRIGGERS_POLL_MS`, `FLOOM_BASIC_USER`, `FLOOM_BASIC_PASSWORD`,
    `COMPOSIO_FAKE`, `PUBLIC_ORIGIN`** — same shape (code reads them,
    operator docs do not list them). See rh-03.

### Dead one-shot migration script

12. `apps/server/scripts/audit-2026-04-18-renderer-test-desc.sh` (42
    lines) is a **single-use** migration (hard-coded date in filename)
    that updates a `renderer-test` description once. No caller, no CI
    wiring; one-shot scripts of this shape are typically candidates to
    move under `docs/internal/stash-archive-*/` or delete once run.
    Covered further in **rh-04**.

### No "commented-out source file" anti-pattern

13. `rg -n "^// @deprecated|^// TODO: remove|^// XXX remove"
    apps/{server,web}/src` returns zero hits. The repo does **not** have
    the common *commented-out-big-block* problem; dead surface is
    instead in small unused files and unused exports.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| R1 | P2 | **Dead UI components drift vs live ones** (`TrustStrip`, `PromptBox`, `AppSuggestionCard`) — cause contributor confusion when rebuilding landing flows. | `apps/web/src/components/TrustStrip.tsx`, `PromptBox.tsx`, `runner/AppSuggestionCard.tsx` (zero external imports) |
| R2 | P1 | **Client helpers `pickApps` / `parsePrompt` / `createThread` / `saveTurn` diverge silently** from server routes they wrap — any schema change will land without a compiler signal. | `apps/web/src/api/client.ts:94,101,424,428` |
| R3 | P1 | **Legacy routes `/_creator-legacy`, `/_build-legacy` carry 2 974 lines of tsx** behind an undocumented safety valve — high maintenance weight with no sunset. | `apps/web/src/main.tsx:214–216`, `BuildPage.tsx` (2 084 LOC) |
| R4 | P1 | **`DEFERRED-UI.md` and `ROADMAP.md` contradict the tree** (async jobs UI; custom renderer UI) — external comms will misreport shipped state. | `docs/DEFERRED-UI.md`; `docs/ROADMAP.md` Current-state table; `pd-19-roadmap-p0-execution-gap.md:17,18` |
| R5 | P2 | **`turbo lint` is a no-op** — contributors running `pnpm lint` green never see real issues. Hygiene theater. | `package.json` + `turbo.json`; no `.eslintrc*` / `eslint.config.*` |
| R6 | P2 | **`apps/server/src/adapters/types.ts` (460 LOC)** drifts from `services/*` because it is declarative-only — if a service signature changes, the "contract" won't notice. | `apps/server/src/adapters/types.ts:12` |
| R7 | P0 | **Env vars read in production without docs/example** (`FLOOM_STORE_HIDE_SLUGS`, `FLOOM_TRIGGERS_POLL_MS`, `PUBLIC_ORIGIN`, …) — self-hosters silently miss operator controls. | See rh-03 table |

---

## Open PM questions

1. **Sunset policy for `/_creator-legacy` and `/_build-legacy`**: is
   there a date, or a criterion (`/studio/*` feature parity), after
   which the legacy pages can be deleted? Right now they carry ~3 000
   LOC with no owner. (`apps/web/src/main.tsx:214–216`)
2. **Dead web helpers**: should `pickApps` / `parsePrompt` / `createThread`
   / `saveTurn` be **kept** (to signal the HTTP surface is first-class)
   or **deleted from the web client** so the compiler enforces
   MCP/HTTP-only usage? (`apps/web/src/api/client.ts`)
3. **`apps/server/src/adapters/types.ts`**: keep as the public contract
   for `spec/adapters.md` (status quo) or move to a `@floom/adapters`
   package so it reads as an SDK, not dead server code?
4. **`pnpm lint`**: wire a real ESLint pass (and fail CI on it) or
   delete the `"lint"` targets from `package.json` and `turbo.json` to
   stop misleading new contributors?
5. **Small unused components** (`TrustStrip`, `PromptBox`,
   `AppSuggestionCard`): delete now, or salvage into a
   `components/archive/` folder with a README so the next wireframe
   iteration can reuse them?
6. **`DEFERRED-UI.md` and `ROADMAP.md` drift**: treat as documentation
   debt handled in one PR (re-write both against reality) or roll into
   the larger "roadmap execution" pass in
   `docs/product-audit/deep/pd-19-roadmap-p0-execution-gap.md`?
