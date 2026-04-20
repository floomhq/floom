# ax-14 — Regression / release checklist (post-merge / pre-prod)

**Purpose:** Ordered manual and semi-automated gates after a merge to `main` and before treating a build as production-ready. **No execution is required to complete this audit document**; operators run these steps when cutting a release or validating preview.

**Related:** [`docs/PRODUCT.md`](../PRODUCT.md) (pillars and public surfaces), [`ax-04-ci-workflows.md`](ax-04-ci-workflows.md) (what CI runs vs hub-smoke), [`ax-05-test-risk-map.md`](ax-05-test-risk-map.md) (coverage gaps).

---

## A. `packages/hub-smoke` — what it is

Playwright E2E against a **live** Floom base URL (default **preview**). Two suites:

| Suite | Script | What it does | Auth |
|-------|--------|----------------|------|
| **Fast seven** | `pnpm test:fast` → `playwright test tests/fast-apps.spec.ts` | Seven deterministic **fast-apps** slugs: open `/p/:slug`, fill fixtures where needed, click run, assert `[data-renderer]` (no “Something went wrong”). | Anonymous |
| **Full hub** | `pnpm test:full` → `playwright test tests/hub-full.spec.ts` | Fetches `/api/hub`, iterates **every** public hub app slug with load + run attempt; classifies outcomes; fails on hard failures. | Requires `E2E_EMAIL` + `E2E_PASSWORD` (global setup writes `.auth/user.json`) |
| **All tests** | `pnpm test:all` → `playwright test` | Runs everything in `tests/`. | Mixed |

**Default base URL:** `BASE_URL` env, else `https://preview.floom.dev` (see `packages/hub-smoke/playwright.config.ts`). GitHub Actions can override with repo variable `FLOOM_HUB_SMOKE_URL` (see `.github/workflows/hub-smoke.yml`).

**Fast-app slugs (fixed list):** `uuid`, `password`, `hash`, `base64`, `json-format`, `jwt-decode`, `word-count` — see `packages/hub-smoke/tests/fixtures.ts`.

**Root shortcut:** from repo root, `pnpm test:hub-smoke` runs **fast** only (`@floom/hub-smoke` → `test:fast`).

---

## B. How to run hub-smoke (local or against any URL)

- [ ] **Install deps** (once): from repo root, `pnpm install`.
- [ ] **Install Chromium** (once per machine/CI): `cd packages/hub-smoke && pnpm install:browsers` (or `pnpm exec playwright install --with-deps chromium` in that directory).
- [ ] **Point at the environment under test** (preview, staging, or production — product decision):
  - [ ] `export BASE_URL='https://preview.floom.dev'` (or your target; trailing slash behavior follows Playwright `baseURL`).
- [ ] **Anonymous smoke (recommended minimum):**
  - [ ] `cd packages/hub-smoke && pnpm test:fast`
  - Or from root: `pnpm test:hub-smoke`
- [ ] **Optional authenticated full hub** (higher run volume; uses account quota / rate limits differently than anonymous):
  - [ ] `export E2E_EMAIL='…'` and `export E2E_PASSWORD='…'` (preview or dedicated E2E account).
  - [ ] `cd packages/hub-smoke && pnpm test:full`
- [ ] **All Playwright tests:** `cd packages/hub-smoke && pnpm test:all`
- [ ] **Artifacts:** On failure, config uses `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'` — inspect Playwright report output under `packages/hub-smoke` as configured.

**Caution:** Anonymous fast suite is sized to stay under typical per-IP limits (serial workers, seven apps). Full hub hits **every** hub app; use when secrets exist and product accepts the load.

---

## C. Preview URL smoke (CI parity)

GitHub Actions workflow **Hub smoke (Playwright)** (`.github/workflows/hub-smoke.yml`):

- [ ] **PRs** (path-filtered): runs **fast-apps** against `BASE_URL` defaulting to `https://preview.floom.dev` unless `vars.FLOOM_HUB_SMOKE_URL` is set.
- [ ] **Schedule** (`cron` 07:00 UTC) and **workflow_dispatch**: runs **fast-apps**; also runs **full-hub** if `secrets.HUB_SMOKE_E2E_EMAIL` and `secrets.HUB_SMOKE_E2E_PASSWORD` are both set — otherwise full-hub **exits 0 without failing** (soft skip).
- [ ] **Post-merge check:** If your change did **not** touch `packages/hub-smoke/**`, `apps/web/**`, or the workflow file, the PR may not have run hub-smoke — **manually run** section B against preview (or dispatch the workflow) before prod.

---

## D. Optional visual regression — capture diff vs `scripts/ux-audit/floom-launch-screens.json`

**Baseline manifest (canonical path):** `scripts/ux-audit/floom-launch-screens.json` — **named screens** with `route`, `name`, and **desktop** / **mobile** entries (e.g. home, store, protocol, about, studio routes, legal pages, a 404 probe route). Use it as the **canonical route list** for launch-relevant pages. If that file is not yet in your tree, keep an equivalent JSON (same shape) next to your capture script so diffs stay comparable across releases.

**Workflow (conceptual — tooling may live in UX audit scripts or external skills):**

- [ ] **Establish a baseline folder** from a known-good preview (or prior release): capture full-page screenshots for each entry in the manifest at the **same viewports** the manifest implies (typically desktop + mobile).
- [ ] **Capture candidate:** Run the same capture pipeline against the **current** `BASE_URL` (preview or pre-prod).
- [ ] **Diff:** Compare new images to baseline (pixel diff tools, or manual review in a side-by-side viewer). Pay attention to layout shifts, hero copy, legal footers, and auth gates (`/login`, `/signup`, `/studio` may require session or test accounts for meaningful shots).
- [ ] **Scope:** Treat this as **supplemental** — hub-smoke proves run-surface behavior on fast-apps; screen diff catches marketing/studio/legal regressions hub-smoke does not cover.

If the repo does not yet ship `scripts/capture_screens.py`, use any Playwright or scripted capture that reads the same JSON shape (route + name per viewport) so outputs stay comparable across releases.

---

## E. Ordered checklist — post-merge / pre-prod

Use this order unless your release process dictates otherwise.

### 1. Merge and CI truth

- [ ] Change is merged to the release branch (typically `main`).
- [ ] **`ci.yml`** completed successfully for the merge commit: `pnpm typecheck` and `pnpm test` (see [`ax-04-ci-workflows.md`](ax-04-ci-workflows.md)).

### 2. Hub smoke on the target URL

- [ ] Set `BASE_URL` to the environment you are about to promote (almost always **preview** first; production only if policy allows live probing).
- [ ] Run **`pnpm test:hub-smoke`** from repo root (or `pnpm test:fast` in `packages/hub-smoke`).
- [ ] If releasing renderer/hub-wide behavior, consider **`pnpm test:full`** with `E2E_EMAIL` / `E2E_PASSWORD` when available.

### 3. GitHub Actions cross-check (optional but recommended)

- [ ] Open **Actions → Hub smoke (Playwright)** and confirm a recent run for the relevant commit or dispatch a **workflow_dispatch** run.
- [ ] Confirm **`vars.FLOOM_HUB_SMOKE_URL`** and E2E secrets match your intent if you rely on the **full-hub** job.

### 4. Optional visual / launch-route regression

- [ ] Regenerate captures using `scripts/ux-audit/floom-launch-screens.json` and diff against the prior baseline (section D).

### 5. Pre-prod product gates (manual)

- [ ] Spot-check **three surfaces** alignment with [`docs/PRODUCT.md`](../PRODUCT.md): web flows, MCP, HTTP API — as appropriate for the change.
- [ ] Legal / marketing pages if copy or routing changed (hub-smoke does not replace human review).
- [ ] Deploy pipeline / Docker / secrets: follow your hosting runbook (not duplicated here).

### 6. Go / no-go

- [ ] Document who ran hub-smoke, which `BASE_URL`, and whether full-hub / capture-diff were used.
- [ ] Proceed to production promotion only when the required boxes above are checked for your risk level.

---

## F. Quick reference (commands)

```bash
# From repo root — fast anonymous smoke against default preview
pnpm test:hub-smoke

# Explicit URL
cd packages/hub-smoke && BASE_URL='https://preview.floom.dev' pnpm test:fast

# Full hub (auth)
cd packages/hub-smoke && BASE_URL='https://preview.floom.dev' E2E_EMAIL='…' E2E_PASSWORD='…' pnpm test:full
```

---

**Audit artifact:** this checklist; operators fill checkboxes per release. **No code changes** were required to produce this document.
